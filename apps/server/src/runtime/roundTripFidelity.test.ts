import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate, CompanyBundle } from "@opc/shared";

// ── 导出再导入行为一致性(保真率量化,常驻回归)──────────────────────────────────
// 演练"同一公司 → GET /api/companies/:id/export?profile=full 的真实导出逻辑 → 文件 JSON 往返 →
// POST /api/companies/import 的真实导入逻辑(new-company)→ 再次真实导出",对两次导出物做全字段
// deep-diff,产出保真率数字,把"必然不一致"(身份/时间戳类)分类锁死;记忆归属 bug 已修,内容保真。
// 源公司刻意铺满多样性:订阅员工(claude-code)+ API 员工(hermes)+ generic-cli 员工 + workflow
// 验证边 + 两条预置 A2A 通道 + 双角色扇出的 bundledSkills + 员工个人记忆 + 公司级结论记忆。

const hoisted = vi.hoisted(() => ({
  agentsRoot: { current: "" },
  skills: { map: new Map<string, Record<string, unknown>>() },
}));

// 理由同 bundleMigrationDrill.test.ts:orchestrator 是模块级单例(写真实项目 agents.json),
// 替换成写"当前 mkdtemp 根"的实现,让导入落盘发生在临时根,再导出才有真数据可读。
vi.mock("./orchestrator.js", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const file = () => pathm.join(hoisted.agentsRoot.current, ".opc", "agents.json");
  const readAll = (): any[] => {
    try { return JSON.parse(fsm.readFileSync(file(), "utf-8")); } catch { return []; }
  };
  const writeAll = (all: any[]) => {
    fsm.mkdirSync(pathm.dirname(file()), { recursive: true });
    fsm.writeFileSync(file(), JSON.stringify(all, null, 2), "utf-8");
  };
  return {
    getAgents: vi.fn(() => readAll()),
    addAgents: vi.fn((nodes: any[]) => { writeAll([...readAll(), ...nodes]); return nodes.length; }),
    updateAgent: vi.fn((id: string, patch: any) => {
      const all = readAll();
      const i = all.findIndex((a) => a.id === id);
      if (i >= 0) { all[i] = { ...all[i], ...patch }; writeAll(all); }
    }),
    removeAgentsByCompany: vi.fn(() => 0),
    removeAgentsByIds: vi.fn(() => 0),
  };
});

// skillStore 写全局用户目录(~/.opcstudio/skills),测试不碰真实用户数据 → 同语义内存实现。
vi.mock("../storage/skillStore.js", () => {
  const infer = (id: string, title: string) =>
    title.startsWith("workflow-") ? "memory"
      : id.startsWith("bundled-") ? "bundled"
        : id.startsWith("sk-") || id.startsWith("wk-") ? "persona" : "user";
  return {
    listSkills: (_root?: string, opts?: { origin?: string }) => {
      const metas = [...hoisted.skills.map.values()].map(({ content: _c, ...meta }) => meta);
      return opts?.origin ? metas.filter((s: any) => (s.origin ?? "user") === opts.origin) : metas;
    },
    getSkill: (_root: string | undefined, id: string) => hoisted.skills.map.get(id) ?? null,
    createSkill: (_root: string | undefined, skill: any) => {
      if (hoisted.skills.map.has(skill.id)) throw new Error(`Skill "${skill.id}" already exists`);
      const tagged = { ...skill, origin: skill.origin ?? infer(skill.id, skill.title) };
      hoisted.skills.map.set(skill.id, tagged);
      return tagged;
    },
    updateSkill: (_root: string | undefined, id: string, patch: any) => {
      const existing = hoisted.skills.map.get(id);
      if (!existing) throw new Error(`Skill "${id}" not found`);
      const merged = { ...existing, ...patch, id };
      hoisted.skills.map.set(id, merged);
      return merged;
    },
    deleteSkill: (_root: string | undefined, id: string) => hoisted.skills.map.delete(id),
  };
});

vi.mock("./providerRegistry.js", () => ({
  syncProvidersFromStore: vi.fn(),
  collectApiKeys: vi.fn(() => ({})),
}));
vi.mock("./modelGateway.js", () => ({ callModel: vi.fn(), createAnthropicProvider: vi.fn() }));
vi.mock("./engines/probes.js", () => ({ probeClaudeCodeAsync: vi.fn(), probeCodexAsync: vi.fn() }));
vi.mock("./engines/apiKeyAccount.js", () => ({ resolveApiKeyOverride: vi.fn() }));
vi.mock("../storage/providerStore.js", () => ({ loadAccounts: vi.fn(() => []) }));

import {
  parseCompanyBundle, bundleToTemplateShape, CompanyTemplateSchema, sanitizeExportProfile, deriveOrgTeamsAndEdges,
} from "@opc/shared";
import { installCompanyTemplate } from "../routes/companyRoutes.js";
import { companyToBundleTracked } from "./companyTemplate.js";
import { sanitizeBundleForExport, sanitizeMemoryImportMode, applyMemoryImportModeTracked, exportMemoryRecordsForCompany } from "./memoryBundle.js";
import { runTemplateDoctor } from "./templateDoctor.js";
import { verifyAndAssignTrust } from "./templateTrust.js";
import { applySafeInstall } from "./install.js";
import { loadCompanies } from "../storage/companyStore.js";
import { loadAgents } from "../storage/projectStore.js";
import { agentMemoryPath } from "../storage/mdMemory.js";
import { addConclusionSummary, approveConclusionSummary } from "../storage/registryStore.js";
import { approveLesson } from "../storage/reflectionStore.js";
import { decideGovernedMemoryProposal } from "./memoryGovernance.js";
import { listLayeredMemories } from "../storage/layeredMemory.js";

// ── 真实导出端点逻辑(GET /api/companies/:id/export 的逐行镜像,routes 层无法直接调用 handler)──
function exportCompanyViaEndpointLogic(projectRoot: string, companyId: string, profileRaw: string): CompanyBundle {
  const profile = sanitizeExportProfile(profileRaw);
  // P0-B⑥ · 端点单次构建:companyToBundleTracked 已携带全部可移植结构字段,不再 companyToTemplate 二扫补挂。
  const { bundle } = companyToBundleTracked(projectRoot, companyId, { exportProfile: profile });
  const { bundle: sanitized } = sanitizeBundleForExport(bundle, { profile });
  // C2 · 端点同款:org 投影从脱敏后载荷重派生(见 companyRoutes 导出端点注释)。
  const outBundle = {
    ...sanitized,
    org: { ...sanitized.org, agents: sanitized.agents, ...deriveOrgTeamsAndEdges(sanitized.agents, sanitized.a2aChannels, sanitized.workflow) },
  };
  // res.json(...) 的文件下载/再上传往返(剥掉 undefined 键,与真实线上行为一致)。
  return JSON.parse(JSON.stringify(outBundle));
}

// ── deep-diff:统计叶子字段总数/一致数,收集不一致路径(保真率 = equal/total)──────────
interface DiffEntry { path: string; a: unknown; b: unknown }
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function deepDiff(a: unknown, b: unknown, prefix: string, out: DiffEntry[], counter: { total: number; equal: number }): void {
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      deepDiff(a[key], b[key], prefix ? `${prefix}.${key}` : key, out, counter);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) deepDiff(a[i], b[i], `${prefix}[${i}]`, out, counter);
    return;
  }
  counter.total++;
  if (JSON.stringify(a) === JSON.stringify(b)) counter.equal++;
  else out.push({ path: prefix, a, b });
}

// 必然不一致(身份/时间戳类,导入即新公司,合理且可预期)。
const IDENTITY_DIFFS: RegExp[] = [
  /^bundle_id$/,
  /^title$/,                    // 导入路由固定加「(导入)」后缀
  /^company\.company_id$/,
  /^company\.name$/,
  /^metadata\.created_at$/,     // 导出时刻的时间戳
  /^metadata\.updated_at$/,
  // 记忆记录导入即在新公司生成新记录:memory_id/时间戳新生成,scope/owner_id 归属新公司(全非源值)——
  // 这些身份/时间戳字段必然不同;记忆**内容**(content/points/tags 等)则逐字段保真(下方 CORE 不含
  // memory,且「记忆归属已修复」测试显式断言 content 一致)。
  /^memory\.records\[\d+\]\.(memory_id|scope|owner_id|created_at|updated_at|last_used_at)$/,
  // source.type 是记录来源溯源(run/manual/import):导入即被如实标为 "import"(源侧为 manual/run),
  // 与 scope/owner_id 同属"导入重归属"的身份/溯源类必然差异,非内容丢失(内容仍逐字段保真)。
  /^memory\.records\[\d+\]\.source\.type$/,
];
// memory.records 归属 bug 已修(memoryBundle.ts:导入记忆恒归属目标公司 opts.companyId,不再钉在 bundle
// 携带的源公司 owner_id 上)→ 记忆内容随包迁移、新公司导出可见,不再整条丢失,白名单删空。
const KNOWN_LOSS_DIFFS: RegExp[] = [];

const SOURCE_COMPANY_ID = "rt-src";
const SKILL_CONTENT = "发布前先跑冒烟测试,再灰度放量。";
const AGENT_MEMORY = "偏好:先写测试再写实现。";
const CONCLUSION_POINT = "经验:上线前先冒烟再放量";

function seedSourceCompany(rootA: string): void {
  fs.mkdirSync(path.join(rootA, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(rootA, ".opc", "companies.json"), JSON.stringify([{
    id: SOURCE_COMPANY_ID,
    name: "往返保真源公司",
    description: "多样性齐备的源公司",
    folder: "M:\\work\\site-co",
    visibilityPolicy: "isolated",
    ceoId: "a-ceo",
    createdAt: "2026-07-01T00:00:00.000Z",
    manifestTemplateId: "rt-fixture-tpl",
    manifestUseCases: ["网站交付"],
    manifestRiskNotes: ["不适合法务审查"],
    workflow: { verificationEdges: [{ producer: "dev", verifier: "qa", method: "code-review", onReject: "redo", maxRounds: 2 }] },
    manifestMcpRequirements: [{ name: "filesystem", purpose: "工作区读写", optional: true }],
    presetChannels: [
      { from: "a-ceo", to: "a-dev", purpose: "任务下发" },
      { from: "a-dev", to: "a-qa", purpose: "交付验证" },
    ],
    // P0-B③:作者手填示例任务(公司持久字段);无成功 run 时纯靠它,验证"导入后再导出仍在"。
    defaultTasks: [{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }],
  }]), "utf-8");

  const agents: AgentNodeConfig[] = [
    {
      id: "a-ceo", name: "统筹官", role: "ceo", childrenIds: ["a-dev", "a-qa"],
      model: "deepseek-v4-pro", provider: "deepseek", framework: "hermes", companyId: SOURCE_COMPANY_ID,
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0.42,
      editable: true, deletable: false, enabled: true,
      uiPosition: { x: 0, y: 0 }, visibilityPolicy: "default",
      card: {
        summary: "统筹全局、拆解目标、分派任务的一号位。",
        skills: [{ id: "strategy", name: "战略拆解", description: "把模糊目标拆成可执行任务", inputModes: ["text"], outputModes: ["text"] }],
        produces: ["plan"], consumes: ["goal"], acceptsQuery: true, tools: [],
      },
      growth: { level: 2, xp: 120, successRate: 0.9, specialties: ["planning"], weaknesses: [], recentLessons: [] },
    },
    {
      id: "a-dev", name: "订阅工程师", role: "dev", parentId: "a-ceo", childrenIds: [],
      model: "sonnet", provider: "anthropic", framework: "claude-code", claudeCodeUseApiKey: false,
      cliConfigDir: "C:\\Users\\author\\.claude", workspaceDir: "M:\\work\\site",
      companyId: SOURCE_COMPANY_ID, status: "working", currentTask: "运行时残留任务",
      tokenUsage: { prompt: 100, completion: 50, total: 150 }, costUsd: 1.2,
      editable: true, deletable: true, enabled: true,
    },
    {
      id: "a-qa", name: "命令行质检", role: "qa", parentId: "a-ceo", childrenIds: [],
      model: "generic", provider: "custom", framework: "generic-cli",
      genericCli: { command: "mycli", args: ["--check"], authEnvVar: "MYCLI_ENV" },
      companyId: SOURCE_COMPANY_ID, status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    },
  ];
  fs.writeFileSync(path.join(rootA, ".opc", "agents.json"), JSON.stringify(agents), "utf-8");

  // 员工个人记忆(agent-memory.md,full 档应随包迁移)。
  const memPath = agentMemoryPath(rootA, "a-dev");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, AGENT_MEMORY + "\n", "utf-8");

  // 公司级结论记忆(registryStore → memory.records)。
  addConclusionSummary(rootA, {
    runId: "r-rt-1", companyId: SOURCE_COMPANY_ID, points: [CONCLUSION_POINT],
    createdAt: "2026-07-02T00:00:00.000Z",
  });

  // 当初装模板时扇出的打包技能(同一技能按 dev/qa 两角色扇出,导出侧应去重合并回一条 spec)。
  for (const role of ["dev", "qa"]) {
    hoisted.skills.map.set(`bundled-rt-fixture-tpl-release-checklist--${role}`, {
      id: `bundled-rt-fixture-tpl-release-checklist--${role}`,
      title: "release-checklist", role, enabled: true,
      description: "发布前检查单", content: SKILL_CONTENT, origin: "bundled",
      lastModified: "2026-07-01T00:00:00.000Z", license: "OPC-Original",
    });
  }
}

describe("导出再导入行为一致性 · full 档(自己备份/迁移)全链路保真率", () => {
  let rootA: string;
  let rootB: string;
  let wire1: CompanyBundle;
  let wire2: CompanyBundle;
  let importedCompanyId: string;
  let importedAgents: AgentNodeConfig[];

  beforeAll(() => {
    rootA = fs.mkdtempSync(path.join(os.tmpdir(), "rt-src-"));
    rootB = fs.mkdtempSync(path.join(os.tmpdir(), "rt-dst-"));
    fs.mkdirSync(path.join(rootB, ".opc"), { recursive: true });
    hoisted.skills.map.clear();
    seedSourceCompany(rootA);

    // ① 真实导出(GET /api/companies/:id/export?profile=full 逻辑)+ 文件 JSON 往返。
    hoisted.agentsRoot.current = rootA;
    wire1 = exportCompanyViaEndpointLogic(rootA, SOURCE_COMPANY_ID, "full");

    // ② 真实导入(POST /api/companies/import new-company 逻辑,逐步镜像路由实现)。
    const asBundle = parseCompanyBundle(wire1);
    expect(asBundle.ok).toBe(true);
    const candidate = bundleToTemplateShape(asBundle.bundle!);
    const parsed = CompanyTemplateSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
    const tplRaw = parsed.data as unknown as CompanyTemplate;
    const doctor = runTemplateDoctor(tplRaw, { projectRoot: rootB });
    expect(doctor.install_allowed).toBe(true);
    const isFullImport = asBundle.bundle!.export_profile === "full";
    expect(isFullImport).toBe(true);
    const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
    const safeInstall = applySafeInstall(trusted, { unsafeAcknowledged: isFullImport });
    expect(safeInstall.applied).toBe(false); // full 档 = 等价 unsafeAcknowledged,不降权、不剥 a2aChannels

    hoisted.agentsRoot.current = rootB;
    const result = installCompanyTemplate(rootB, safeInstall.template, {
      nameSuffix: "(导入)",
      agentMemories: asBundle.bundle!.agentMemories,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("install failed");
    importedCompanyId = result.companyId;
    importedAgents = result.agents;
    // 路由同款:seedMemories 按 memoryImportMode 写回(这里取 full,排除等级过滤因素,专测归属)。
    const memImport = applyMemoryImportModeTracked(rootB, safeInstall.template.seedMemories, sanitizeMemoryImportMode("full"), {
      companyId: importedCompanyId, bundleId: safeInstall.template.id,
    });
    // 收口作战令一.1:导入默认 proposed/pending——保真链口径 = 导入→【明确批准】→再导出。
    // 未批准的提案本就不该出现在公司导出物里(proposed lesson 不导出/pending conclusion 只以 draft 级导出),
    // 批准动作是链路的一部分,不是掩盖:它同时活体验证了 approve 接口本身。
    for (const id of memImport.recordIds.conclusionIds) approveConclusionSummary(rootB, id);
    for (const id of [...memImport.recordIds.lessonCreatedIds, ...memImport.recordIds.lessonMergedIds]) {
      approveLesson(rootB, id, "roundtrip-test", new Date().toISOString());
    }
    for (const id of memImport.recordIds.governedProposalIds) {
      expect(decideGovernedMemoryProposal(rootB, id, "approved", "roundtrip-test")?.status).toBe("approved");
    }

    // ③ 对导入产物公司再次真实导出。
    wire2 = exportCompanyViaEndpointLogic(rootB, importedCompanyId, "full");
  });

  afterAll(() => {
    for (const r of [rootA, rootB]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
  });

  it("release gate: 保真率全字段 deep-diff,不一致项只允许落在「身份/时间戳」白名单里(记忆归属已修,内容保真)", () => {
    const diffs: DiffEntry[] = [];
    const counter = { total: 0, equal: 0 };
    deepDiff(wire1, wire2, "", diffs, counter);

    const unexpected = diffs.filter(
      (d) => !IDENTITY_DIFFS.some((re) => re.test(d.path)) && !KNOWN_LOSS_DIFFS.some((re) => re.test(d.path)),
    );
    const fidelity = counter.total ? counter.equal / counter.total : 1;
    // 保真率数字进测试输出,供报告引用(字段口径:导出物 JSON 全叶子字段)。
    console.log(
      `[roundTripFidelity] 导出物全字段=${counter.total} 一致=${counter.equal} 保真率=${(fidelity * 100).toFixed(1)}% ` +
      `不一致路径=${JSON.stringify(diffs.map((d) => d.path))}`,
    );
    expect(unexpected).toEqual([]);

    // 执行配置核心域(agents 拓扑/workflow/a2aChannels/bundledSkills/mcp/工具需求/个人记忆)必须零不一致。
    const CORE = /^(agents|org|workflow|a2aChannels|bundledSkills|mcpRequirements|toolRequirements|recommendedConfig|visibilityPolicy|agentMemories|privacy|readme|useCases|riskNotes|description|export_profile|defaultTasks)\b/;
    expect(diffs.filter((d) => CORE.test(d.path))).toEqual([]);
  });

  it("agents 执行配置逐字段一致:framework/provider/model/role/parent/children 拓扑 + genericCli/claudeCodeUseApiKey/card/growth/uiPosition", () => {
    expect(wire2.agents).toHaveLength(3);
    // 两次导出都经 rerootAgents 归一成稳定合成 id(`${role}-${i}`),agents 数组可直接整体比对。
    expect(wire2.agents).toEqual(wire1.agents);
    const byRole = new Map(wire1.agents.map((a) => [a.role, a]));
    expect(byRole.get("dev")!.framework).toBe("claude-code");
    expect(byRole.get("dev")!.claudeCodeUseApiKey).toBe(false);
    expect(byRole.get("qa")!.genericCli).toEqual({ command: "mycli", args: ["--check"], authEnvVar: "MYCLI_ENV" });
    expect(byRole.get("ceo")!.card?.summary).toContain("统筹全局");
    expect(byRole.get("ceo")!.growth?.level).toBe(2);
    expect(byRole.get("dev")!.parentId).toBe(byRole.get("ceo")!.id);
    expect(new Set(byRole.get("ceo")!.childrenIds)).toEqual(new Set([byRole.get("dev")!.id, byRole.get("qa")!.id]));
  });

  it("workflow.verificationEdges / a2aChannels / bundledSkills / agentMemories 逐字段一致", () => {
    expect(wire1.workflow?.verificationEdges).toEqual([
      { producer: "dev", verifier: "qa", method: "code-review", onReject: "redo", maxRounds: 2 },
    ]);
    expect(wire2.workflow).toEqual(wire1.workflow);
    expect(wire1.a2aChannels).toEqual([
      { from: "ceo", to: "dev", purpose: "任务下发" },
      { from: "dev", to: "qa", purpose: "交付验证" },
    ]);
    expect(wire2.a2aChannels).toEqual(wire1.a2aChannels);
    // 双角色扇出的同内容技能,导出侧去重合并回一条 spec,roles 收拢两个角色。
    expect(wire1.bundledSkills).toHaveLength(1);
    expect(wire1.bundledSkills![0].content).toBe(SKILL_CONTENT);
    expect(new Set(wire1.bundledSkills![0].roles)).toEqual(new Set(["dev", "qa"]));
    expect(wire2.bundledSkills).toEqual(wire1.bundledSkills);
    // full 档:员工个人记忆随包迁移并在新机落地,再导出内容一致。
    expect(wire1.agentMemories).toEqual([{ agent_id: "dev-1", role: "dev", content: AGENT_MEMORY }]);
    expect(wire2.agentMemories).toEqual(wire1.agentMemories);
  });

  it("必然不一致字段(本机路径/运行时状态):导入产物按设计清空/重置,不外泄源机器路径", () => {
    const byRole = new Map(importedAgents.map((a) => [a.role, a]));
    const dev = byRole.get("dev")!;
    expect(dev.workspaceDir).toBeUndefined();   // 源值 M:\work\site,reroot 关口清空(导入侧重映射)
    expect(dev.cliConfigDir).toBeUndefined();   // 源值 C:\Users\author\.claude,同上
    expect(dev.status).toBe("idle");            // 源值 working,重置
    expect(dev.currentTask).toBeUndefined();    // 运行时残留清空
    expect(dev.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
    expect(dev.costUsd).toBe(0);
    // 导出物本身也不含这些本机路径(在 wire1 里已被 reroot 清空)。
    expect(JSON.stringify(wire1)).not.toContain("M:\\\\work\\\\site");
    expect(JSON.stringify(wire1)).not.toContain(".claude");
  });

  it("记忆归属已修复:导入写回归属目标公司,新公司的导出/检索域可见(memoryBundle.ts owner_id 修复)", () => {
    // 内容写进 canonical layered memory 且归属新公司,不再回写旧 registry 形成双重事实源。
    const memories = listLayeredMemories(rootB, [{ scope: "company", scopeId: importedCompanyId }]);
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toBe(CONCLUSION_POINT);
    expect(memories[0].scopeId).toBe(importedCompanyId);
    expect(memories[0].scopeId).not.toBe(SOURCE_COMPANY_ID);
    // 新公司的记忆导出域可见这条:wire1 与 wire2 各 1 条,内容一致(身份/时间戳差异属 IDENTITY 白名单)。
    expect(wire1.memory?.records).toHaveLength(1);
    expect(wire1.memory?.records[0].content).toBe(CONCLUSION_POINT);
    const roles = importedAgents.map((a) => a.role);
    expect(exportMemoryRecordsForCompany(rootB, importedCompanyId, roles)).toHaveLength(1);
    expect(wire2.memory?.records).toHaveLength(1);
    expect(wire2.memory?.records![0].content).toBe(CONCLUSION_POINT);
  });

  it("P0-B① · 公司级 visibilityPolicy 现在保真:导出携带、导入落回 Company(不再真丢)", () => {
    const companyB = loadCompanies(rootB).find((c) => c.id === importedCompanyId)!;
    // 源公司 visibilityPolicy:"isolated" —— 现在 CompanyTemplate/CompanyBundle 有对应字段,导入产物保真。
    expect(companyB.visibilityPolicy).toBe("isolated");
    // 导出物两次都带上该字段,逐档一致。
    expect(wire1.visibilityPolicy).toBe("isolated");
    expect(wire2.visibilityPolicy).toBe("isolated");
    // folder 是本机路径类,合理不迁移(reroot/导出关口不外泄源机器路径)。
    expect(companyB.folder).toBeUndefined();
  });

  it("P0-B③ · defaultTasks 持久落点:作者手填示例任务落进公司,导入后再导出仍在(往返一致)", () => {
    const companyB = loadCompanies(rootB).find((c) => c.id === importedCompanyId)!;
    // 导入把 defaultTasks 落成公司持久字段(不再只从成功 run 临时采集)。
    expect(companyB.defaultTasks).toEqual([{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }]);
    // 两次导出都带该示例任务,内容一致。
    expect(wire1.defaultTasks).toEqual([{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }]);
    expect(wire2.defaultTasks).toEqual(wire1.defaultTasks);
  });

  it("P0-B② · toolRequirements 读原始 manifest(含作者手写不可推导项),往返一致", () => {
    // 源公司无 manifestToolRequirements → 首次导出纯派生;导入落库后二次导出经 resolveToolRequirements 合并,
    // engines/providers 与 agents 派生取并集、其余原样,两次导出逐字段一致(CORE 域已锁零不一致)。
    expect(wire2.toolRequirements).toEqual(wire1.toolRequirements);
    expect(wire1.toolRequirements?.requiredEngines).toEqual(expect.arrayContaining(["api", "claude-code", "generic-cli"]));
    expect(new Set(wire1.toolRequirements?.requiredProviders)).toEqual(new Set(["deepseek", "anthropic", "custom"]));
  });

  it("对照组 · share 档默认导入(未勾选保留)会按 Safe Install 剥离预置 A2A 通道——full 档正是为保真而生", () => {
    const asBundle = parseCompanyBundle(wire1);
    const candidate = bundleToTemplateShape(asBundle.bundle!);
    const tplRaw = CompanyTemplateSchema.parse(candidate) as unknown as CompanyTemplate;
    const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
    const stripped = applySafeInstall(trusted, { unsafeAcknowledged: false });
    expect(stripped.applied).toBe(true);
    expect(stripped.template.a2aChannels).toBeUndefined();
    expect(stripped.stripped.some((s) => s.id === "preset-a2a-channels")).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C9-P1 · 同 role 多员工时 a2aChannels 往返不串线/不丢失(导出侧对重复 role 用稳定合成 id)。
//   源公司刻意有两个 dev(dev-1「Dev A」/ dev-2「Dev B」);通道:ceo→dev1、ceo→dev2、dev1→dev2。
//   修复前:三条按 role 换算成 {ceo,dev}×2 + {dev,dev}(自环)→ 坍缩成 1 条 + 1 条自环被过滤 = 丢 2 条。
//   修复后:重复 role 用 `${role}-${i}` 稳定合成 id,三条各自独立,导入侧 resolveTemplateAgentRef 先查
//   idMap 精确命中该合成 id → 三条通道逐一落地,零丢失。唯一 role(ceo)仍输出 role 名。
// ════════════════════════════════════════════════════════════════════════════
describe("C9-P1 · 重复 role 的 a2aChannels 往返零丢失(稳定合成 id 防串线/坍缩)", () => {
  let rootDup: string;
  let wire: CompanyBundle;

  beforeAll(() => {
    rootDup = fs.mkdtempSync(path.join(os.tmpdir(), "rt-dup-role-"));
    fs.mkdirSync(path.join(rootDup, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(rootDup, ".opc", "companies.json"), JSON.stringify([{
      id: "dup-src", name: "重复 role 公司", description: "两个 dev", ceoId: "d-ceo",
      createdAt: "2026-07-01T00:00:00.000Z",
      presetChannels: [
        { from: "d-ceo", to: "d-dev1", purpose: "下发给 Dev A" },
        { from: "d-ceo", to: "d-dev2", purpose: "下发给 Dev B" },
        { from: "d-dev1", to: "d-dev2", purpose: "两 dev 协作" },
      ],
    }]), "utf-8");
    const agents: AgentNodeConfig[] = [
      { id: "d-ceo", name: "统筹官", role: "ceo", childrenIds: ["d-dev1", "d-dev2"], model: "m", provider: "deepseek", framework: "api", companyId: "dup-src", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: false, enabled: true },
      { id: "d-dev1", name: "Dev A", role: "dev", parentId: "d-ceo", childrenIds: [], model: "m", provider: "deepseek", framework: "api", companyId: "dup-src", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true },
      { id: "d-dev2", name: "Dev B", role: "dev", parentId: "d-ceo", childrenIds: [], model: "m", provider: "deepseek", framework: "api", companyId: "dup-src", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true },
    ];
    fs.writeFileSync(path.join(rootDup, ".opc", "agents.json"), JSON.stringify(agents), "utf-8");

    hoisted.skills.map.clear();
    hoisted.agentsRoot.current = rootDup;
    wire = exportCompanyViaEndpointLogic(rootDup, "dup-src", "full");
  });

  afterAll(() => { try { fs.rmSync(rootDup, { recursive: true, force: true }); } catch { /* */ } });

  it("导出:三条通道全部保留,重复 role 用合成 id(dev-1/dev-2),ceo 仍是 role 名", () => {
    expect(wire.a2aChannels).toHaveLength(3); // 修复前会坍缩/丢到 ≤1 条
    const chans = wire.a2aChannels!;
    // reroot idFor 为 `${role}-${i}`:ceo=索引0→ceo(唯一 role 输出 role 名),dev1=索引1→dev-1,dev2=索引2→dev-2。
    expect(chans).toContainEqual({ from: "ceo", to: "dev-1", purpose: "下发给 Dev A" });
    expect(chans).toContainEqual({ from: "ceo", to: "dev-2", purpose: "下发给 Dev B" });
    expect(chans).toContainEqual({ from: "dev-1", to: "dev-2", purpose: "两 dev 协作" });
    // 无自环(修复前 {dev,dev} 会成自环被过滤)。
    expect(chans.every((c) => c.from !== c.to)).toBe(true);
  });

  it("重导入:三条通道逐一落地到正确的真实 agent id(dev1→dev2 不被解析成自环)", () => {
    const rootDst = fs.mkdtempSync(path.join(os.tmpdir(), "rt-dup-dst-"));
    fs.mkdirSync(path.join(rootDst, ".opc"), { recursive: true });
    try {
      const asBundle = parseCompanyBundle(wire);
      const candidate = bundleToTemplateShape(asBundle.bundle!);
      const tplRaw = CompanyTemplateSchema.parse(candidate) as unknown as CompanyTemplate;
      const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
      const safeInstall = applySafeInstall(trusted, { unsafeAcknowledged: true });
      hoisted.agentsRoot.current = rootDst;
      const result = installCompanyTemplate(rootDst, safeInstall.template, { nameSuffix: "(导入)" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const company = loadCompanies(rootDst).find((c) => c.id === result.companyId)!;
      const devs = result.agents.filter((a) => a.role === "dev");
      expect(devs).toHaveLength(2); // 两个 dev 都装上
      const channels = company.presetChannels ?? [];
      expect(channels).toHaveLength(3); // 三条通道全部落地
      // dev1→dev2 是两个不同真实 id 之间的边,非自环。
      const devIds = new Set(devs.map((d) => d.id));
      const devToDevChannel = channels.find((c) => devIds.has(c.from) && devIds.has(c.to));
      expect(devToDevChannel).toBeTruthy();
      expect(devToDevChannel!.from).not.toBe(devToDevChannel!.to);
    } finally {
      try { fs.rmSync(rootDst, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});
