import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate, CompanyBundle } from "@opc/shared";
import {
  parseCompanyBundle, bundleToTemplateShape, CompanyTemplateSchema, sanitizeExportProfile, deriveOrgTeamsAndEdges,
  buildLedger, formatLedger, diffLeafPaths, PORTABLE_DESIGN_FIELD_KEYS, type FieldSpec,
} from "@opc/shared";

// ─────────────────────────────────────────────────────────────────────────────
// P0 Part B · 全字段富公司 fixture + field-fidelity ledger · 链路 a(full 往返)/ b(share 逐项批准)
//
// 真实 in-process 调导出/导入函数(companyToBundle → sanitizeBundleForExport → parseCompanyBundle →
// bundleToTemplateShape → installCompanyTemplate → 再导出),对【源公司每个可移植设计字段】跑
// field-fidelity ledger(五类判定),硬断言 ledger.lost 为空(零静默丢失)。不是只测 schema/HTTP200。
//
// 富 fixture 刻意铺满 mandate 清单:visibilityPolicy / 非默认 manifestToolRequirements(含作者手写
// requiredSkills/optionalTools/requiredMcpServers)/ defaultTasks / company+team+agent 记忆 +
// agent-memory.md / card / growth / uiPosition / reasoningEffort / claudeCodeUseApiKey / generic CLI /
// workflow + A2A + MCP + bundled skills / 需脱敏的本机路径与密钥。
// ─────────────────────────────────────────────────────────────────────────────

const hoisted = vi.hoisted(() => ({
  agentsRoot: { current: "" },
  skills: { map: new Map<string, Record<string, unknown>>() },
}));

// orchestrator 是模块级单例(写真实项目 agents.json)——替换成写"当前 agentsRoot"的实现,让 install 落盘
// 发生在临时目标根,再导出才有真数据可读(同 roundTripFidelity.test.ts 惯例)。
vi.mock("./orchestrator.js", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  const file = () => pathm.join(hoisted.agentsRoot.current, ".opc", "agents.json");
  const readAll = (): any[] => { try { return JSON.parse(fsm.readFileSync(file(), "utf-8")); } catch { return []; } };
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

// skillStore 写全局用户目录(~/.opcstudio/skills)——同语义内存实现,避免碰真实用户数据。
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

vi.mock("./providerRegistry.js", () => ({ syncProvidersFromStore: vi.fn(), collectApiKeys: vi.fn(() => ({})) }));
vi.mock("./modelGateway.js", () => ({ callModel: vi.fn(), createAnthropicProvider: vi.fn() }));
vi.mock("./engines/probes.js", () => ({ probeClaudeCodeAsync: vi.fn(), probeCodexAsync: vi.fn() }));
vi.mock("./engines/apiKeyAccount.js", () => ({ resolveApiKeyOverride: vi.fn() }));
vi.mock("../storage/providerStore.js", () => ({ loadAccounts: vi.fn(() => []) }));

import { installCompanyTemplate } from "../routes/companyRoutes.js";
import { companyToBundleTracked, importAgentMemoriesDetailed, assertAgentMemoryImportSucceeded } from "./companyTemplate.js";
import {
  sanitizeBundleForExport, sanitizeMemoryImportMode, applyMemoryImportModeTracked, type MemoryImportMode,
} from "./memoryBundle.js";
import { decideGovernedMemoryProposal } from "./memoryGovernance.js";
import { runTemplateDoctor, runShareSafetyGate } from "./templateDoctor.js";
import { verifyAndAssignTrust } from "./templateTrust.js";
import { applySafeInstall, type SafeInstallStrippedItem } from "./install.js";
import {
  resolveMerge, planMergeAgentMemories, mergeCompanyLevelFields,
  rebuildChildrenIds, sanitizeMergeStrategies,
} from "./installMerge.js";
import { loadCompanies, updateCompany } from "../storage/companyStore.js";
import { getAgents, addAgents, updateAgent } from "./orchestrator.js";
import { agentMemoryPath, readAgentMemory } from "../storage/mdMemory.js";
import { addConclusionSummary, upsertProceduralSkill, approveConclusionSummary, approveProceduralSkill } from "../storage/registryStore.js";
import { approveLesson } from "../storage/reflectionStore.js";
import { saveTemplate, getTemplate } from "../storage/communityStore.js";

// 链路 c/d 真实调【工坊】纯函数(draftFromTemplate / buildPayload)——它们只依赖 @opc/shared 与
// lib/framework(无 JSX/DOM)。跨包源码不能被 server tsc(rootDir=src)静态 import,改用【运行时动态
// import】(变量 specifier → tsc 不静态解析,vitest 模块运行器负责 .js→.ts 解析),类型侧手写最小签名。
type WorkshopBuilt = { template: CompanyTemplate; personas: Array<{ role: string; title: string; content: string }>; roleChanges: unknown[] };
// draft 返回 any:工坊草稿是可编辑投影,链路 d 要 { ...draft, description } 局部改一字段(spread 需对象类型)。
let draftFromTemplate: (tpl: unknown, origin: "blank" | "company" | "fork") => any; // eslint-disable-line @typescript-eslint/no-explicit-any
let buildPayload: (draft: unknown) => WorkshopBuilt;
beforeAll(async () => {
  const WORKSHOP_MODULE = "../../../web/src/components/community/workshopTypes.js";
  const m = await import(WORKSHOP_MODULE) as { draftFromTemplate: typeof draftFromTemplate; buildPayload: typeof buildPayload };
  draftFromTemplate = m.draftFromTemplate;
  buildPayload = m.buildPayload;
});

// ── 富 fixture 常量 ──────────────────────────────────────────────────────────
const SOURCE_COMPANY_ID = "rf-src";
const FIXTURE_TPL_ID = "rf-fixture-tpl";
const SECRET = "sk-abcdefgh12345678";
const COMPANY_MEM_MAIN = "上线前先跑冒烟测试,再灰度放量。";
const COMPANY_MEM_SECRET_LINE = `内部备忘:部署密钥 ${SECRET} 切勿写进仓库。`;
const TEAM_MEM = "研发队约定:PR 必须双人评审后再合并。";
const PROC_STEP = "拆解需求 → 写测试 → 实现 → 本地验证";
const DEV_AGENT_MEMORY = "偏好:先写测试再写实现,提交前跑 lint。";
const SKILL_CHECKLIST = "发布前:①跑冒烟 ②灰度 10% ③监控 30 分钟无异常再全量。";
const SKILL_QA_PLAYBOOK = "质检手册:逐条核对验收标准,失败即打回并附最小复现。";
const FOLDER_PATH = "M:\\rich\\co-workspace";
const DEV_WORKSPACE = "M:\\rich\\site";
const DEV_CLI_CONFIG = "C:\\Users\\author\\.claude";

// 源公司的"设计事实"快照(ledger 的 source 侧从这里取,不从导出物反推,保证是真的"源公司")。
const FACTS = {
  visibilityPolicy: "isolated" as const,
  folder: FOLDER_PATH,
  toolRequirements: {
    requiredEngines: ["api"], requiredProviders: ["deepseek"],
    requiredMcpServers: ["filesystem"], requiredSkills: ["release-checklist"], optionalTools: ["browser"],
  },
  useCases: ["多智能体交付一个营销站点"],
  riskNotes: ["不适用:需要法务合规终审的场景"],
  defaultTasks: [{ title: "搭建落地页", goal: "为新产品搭建一个营销落地页", suggestedRole: "dev" }],
  workflow: { verificationEdges: [{ producer: "dev", verifier: "qa", method: "code-review", onReject: "redo", maxRounds: 2 }] },
  // 导出侧把 presetChannels(真实 agent id)换算成 role 名,故 ledger 里 a2a 用 role 形态。
  a2aChannels: [
    { from: "ceo", to: "dev", purpose: "任务下发" },
    { from: "dev", to: "qa", purpose: "交付验证" },
  ],
  mcpRequirements: [{ name: "filesystem", purpose: "工作区读写", optional: true }],
  ceoCard: {
    summary: "统筹全局、拆解目标、分派任务的一号位。",
    skills: [{ id: "strategy", name: "战略拆解", description: "把模糊目标拆成可执行任务", inputModes: ["text"], outputModes: ["text"] }],
    produces: ["plan"], consumes: ["goal"], acceptsQuery: true, tools: [],
  },
  ceoGrowth: { level: 3, xp: 240, successRate: 0.92, specialties: ["planning"], weaknesses: ["估时偏乐观"], recentLessons: ["先对齐验收标准再开工"] },
  ceoUiPosition: { x: 40, y: 12 },
  qaGenericCli: { command: "mycli", args: ["--check", "{{PROMPT}}"], authEnvVar: "MYCLI_TOKEN" },
};

function seedRichCompany(rootA: string): void {
  fs.mkdirSync(path.join(rootA, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(rootA, ".opc", "companies.json"), JSON.stringify([{
    id: SOURCE_COMPANY_ID,
    name: "全字段富公司",
    description: "字段刻意铺满的分享保真源公司(P0-B fixture)",
    folder: FACTS.folder,
    visibilityPolicy: FACTS.visibilityPolicy,
    ceoId: "s-ceo",
    createdAt: "2026-07-01T00:00:00.000Z",
    manifestTemplateId: FIXTURE_TPL_ID,
    manifestUseCases: FACTS.useCases,
    manifestRiskNotes: FACTS.riskNotes,
    // 非默认:作者手写的 requiredSkills/optionalTools/requiredMcpServers(无法从 agents 反推)。
    manifestToolRequirements: FACTS.toolRequirements,
    workflow: FACTS.workflow,
    manifestMcpRequirements: FACTS.mcpRequirements,
    presetChannels: [
      { from: "s-ceo", to: "s-dev", purpose: "任务下发" },
      { from: "s-dev", to: "s-qa", purpose: "交付验证" },
    ],
    memoryExportEnabled: true,
    defaultTasks: FACTS.defaultTasks,
  }]), "utf-8");

  const agents: AgentNodeConfig[] = [
    {
      id: "s-ceo", name: "统筹官", role: "ceo", childrenIds: ["s-dev", "s-qa"],
      model: "deepseek-v4-pro", provider: "deepseek", framework: "api", companyId: SOURCE_COMPANY_ID,
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
      editable: true, deletable: false, enabled: true,
      uiPosition: FACTS.ceoUiPosition, visibilityPolicy: "isolated",
      card: FACTS.ceoCard, growth: FACTS.ceoGrowth,
    },
    {
      id: "s-dev", name: "订阅工程师", role: "dev", parentId: "s-ceo", childrenIds: [],
      model: "sonnet", provider: "anthropic", framework: "claude-code",
      claudeCodeUseApiKey: true, reasoningEffort: "high",
      cliConfigDir: DEV_CLI_CONFIG, workspaceDir: DEV_WORKSPACE,
      companyId: SOURCE_COMPANY_ID, status: "working", currentTask: "运行时残留任务",
      tokenUsage: { prompt: 100, completion: 50, total: 150 }, costUsd: 1.2,
      editable: true, deletable: true, enabled: true,
    },
    {
      id: "s-qa", name: "命令行质检", role: "qa", parentId: "s-ceo", childrenIds: [],
      model: "generic", provider: "custom", framework: "generic-cli",
      genericCli: FACTS.qaGenericCli, reasoningEffort: "medium",
      companyId: SOURCE_COMPANY_ID, status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    },
  ];
  fs.writeFileSync(path.join(rootA, ".opc", "agents.json"), JSON.stringify(agents), "utf-8");

  // 员工个人记忆(agent-memory.md)——无密钥,full/share 两档都应原样迁移。
  const memPath = agentMemoryPath(rootA, "s-dev");
  fs.mkdirSync(path.dirname(memPath), { recursive: true });
  fs.writeFileSync(memPath, DEV_AGENT_MEMORY + "\n", "utf-8");

  // company 级记忆(含密钥,导出必须脱敏);team 级记忆;agent 级(procedural)记忆。
  addConclusionSummary(rootA, {
    runId: "r-company", companyId: SOURCE_COMPANY_ID,
    points: [COMPANY_MEM_MAIN, COMPANY_MEM_SECRET_LINE], createdAt: "2026-07-02T00:00:00.000Z",
  });
  addConclusionSummary(rootA, {
    runId: "r-team", companyId: SOURCE_COMPANY_ID, teamId: "rf-team",
    points: [TEAM_MEM], createdAt: "2026-07-02T01:00:00.000Z",
  });
  upsertProceduralSkill(rootA, {
    companyId: SOURCE_COMPANY_ID, // P0:技能必须显式归属源公司才随其导出(历史无归属数据已隔离,不再按 role 泄漏)
    role: "dev", taskType: "feature",
    preconditions: [], successfulSequence: ["拆解需求", "写测试", "实现", "本地验证"],
    producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1", "r2", "r3"],
    status: "verified",
  } as any, "2026-07-02T02:00:00.000Z");

  // 当初装模板时按角色扇出的 bundled skill(legacy 命名,无 companyId;导出侧按 manifestTemplateId 前缀反匹配)。
  for (const role of ["dev", "qa"]) {
    hoisted.skills.map.set(`bundled-${FIXTURE_TPL_ID}-release-checklist--${role}`, {
      id: `bundled-${FIXTURE_TPL_ID}-release-checklist--${role}`,
      title: "release-checklist", role, enabled: true,
      description: "发布前检查单", content: SKILL_CHECKLIST, origin: "bundled",
      lastModified: "2026-07-01T00:00:00.000Z", license: "OPC-Original",
    });
  }
  hoisted.skills.map.set(`bundled-${FIXTURE_TPL_ID}-qa-playbook--qa`, {
    id: `bundled-${FIXTURE_TPL_ID}-qa-playbook--qa`,
    title: "qa-playbook", role: "qa", enabled: true,
    description: "质检手册", content: SKILL_QA_PLAYBOOK, origin: "bundled",
    lastModified: "2026-07-01T00:00:00.000Z", license: "OPC-Original",
  });
}

// GET /api/companies/:id/export 端点逐行镜像(routes 层无法直接调 handler)。
function exportViaEndpoint(projectRoot: string, companyId: string, profileRaw: string): CompanyBundle {
  const profile = sanitizeExportProfile(profileRaw);
  const { bundle } = companyToBundleTracked(projectRoot, companyId, { exportProfile: profile });
  const { bundle: sanitized } = sanitizeBundleForExport(bundle, { profile });
  const outBundle = {
    ...sanitized,
    org: { ...sanitized.org, agents: sanitized.agents, ...deriveOrgTeamsAndEdges(sanitized.agents, sanitized.a2aChannels, sanitized.workflow) },
  };
  return JSON.parse(JSON.stringify(outBundle)); // 文件下载/再上传往返(剥掉 undefined 键)
}

// POST /api/companies/import(new-company)逐步镜像:parse → bridge → doctor → trust → safeInstall → install。
interface ImportOutcome {
  companyId: string;
  agents: AgentNodeConfig[];
  stripped: SafeInstallStrippedItem[];
  applied: boolean;
}
function importViaEndpoint(destRoot: string, bundle: CompanyBundle, opts: { unsafeAcknowledged: boolean; memoryMode: MemoryImportMode }): ImportOutcome {
  const asBundle = parseCompanyBundle(bundle);
  if (!asBundle.ok) throw new Error("parseCompanyBundle failed: " + (asBundle.errors ?? []).join("; "));
  const candidate = bundleToTemplateShape(asBundle.bundle!);
  const parsed = CompanyTemplateSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("CompanyTemplateSchema failed: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const tplRaw = parsed.data as unknown as CompanyTemplate;
  const doctor = runTemplateDoctor(tplRaw, { projectRoot: destRoot, bundle: asBundle.bundle });
  if (!doctor.install_allowed) throw new Error("doctor blocked install");
  const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
  const safeInstall = applySafeInstall(trusted, { unsafeAcknowledged: opts.unsafeAcknowledged });

  hoisted.agentsRoot.current = destRoot;
  const result = installCompanyTemplate(destRoot, safeInstall.template, {
    nameSuffix: "(导入)",
    agentMemories: asBundle.bundle!.agentMemories,
  });
  if (!result.ok) throw new Error("install failed: " + result.error);
  const memImport = applyMemoryImportModeTracked(destRoot, safeInstall.template.seedMemories, opts.memoryMode, {
    companyId: result.companyId, bundleId: safeInstall.template.id,
  });
  for (const id of memImport.recordIds.governedProposalIds) {
    const decided = decideGovernedMemoryProposal(destRoot, id, "approved", "ledger-test");
    if (!decided || decided.status !== "approved") throw new Error(`memory proposal approval failed: ${id}`);
  }
  // 收口作战令一.1:导入默认 proposed/pending——保真链口径 = 导入→【明确批准】→再导出(详见 roundTripFidelity 同款注释)。
  for (const id of memImport.recordIds.conclusionIds) approveConclusionSummary(destRoot, id);
  for (const id of [...memImport.recordIds.lessonCreatedIds, ...memImport.recordIds.lessonMergedIds]) {
    approveLesson(destRoot, id, "ledger-test", new Date().toISOString());
  }
  // 收口令二.5:导入的 procedural_skill 同样默认 proposed → 链路里显式批准后才可导出(同 conclusion/lesson 口径)。
  for (const id of [...memImport.recordIds.proceduralSkillCreatedIds, ...memImport.recordIds.proceduralSkillMergedIds]) {
    approveProceduralSkill(destRoot, id, new Date().toISOString());
  }
  return { companyId: result.companyId, agents: result.agents, stripped: safeInstall.stripped, applied: safeInstall.applied };
}

// C9-P0-B · 链路 e/f · POST /api/companies/import(mode:"merge")的核心逐步镜像(与 companyRoutes.ts
// merge 分支同口径):resolveMerge → planMergeAgentMemories(map 不覆盖既有员工记忆)→ addAgents/updateAgent
// → adopt-org 改挂 → importAgentMemories(只导新建员工)→ 记忆 pending(asProposal)→ 公司字段保守合并。
// 跳过 install-transaction/bundledSkills(与保真无关),专注字段保真 + 记忆保护活体断言。
interface MergeOutcome {
  ok: boolean;
  status?: number;
  memoryReviewItems?: Array<{ field: string; detail: string }>;
  agentMemoriesImported?: number;
}
function mergeViaEndpoint(
  destRoot: string,
  bundle: CompanyBundle,
  targetCompanyId: string,
  opts: {
    teamDuplicationResolution?: "map" | "overwrite" | "add-department";
    orgParentResolution?: "keep-current-org" | "adopt-template-org" | "reject";
    memoryMode?: MemoryImportMode;
  } = {},
): MergeOutcome {
  hoisted.agentsRoot.current = destRoot;
  const asBundle = parseCompanyBundle(bundle);
  if (!asBundle.ok) throw new Error("parseCompanyBundle failed");
  const candidate = bundleToTemplateShape(asBundle.bundle!);
  const parsed = CompanyTemplateSchema.safeParse(candidate);
  if (!parsed.success) throw new Error("schema failed");
  const tplRaw = parsed.data as unknown as CompanyTemplate;
  const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
  const safeInstall = applySafeInstall(trusted, { unsafeAcknowledged: true }); // full 等价,不降权,专测保真
  const targetCompany = loadCompanies(destRoot).find((c) => c.id === targetCompanyId);
  if (!targetCompany) throw new Error("target company not found");

  const strategies = sanitizeMergeStrategies(undefined);
  const result = resolveMerge(safeInstall.template, targetCompany, getAgents(), strategies, {
    attachParentId: targetCompany.ceoId,
    teamDuplicationResolution: opts.teamDuplicationResolution,
    orgParentResolution: opts.orgParentResolution,
  });
  if (!result.ok) return { ok: false, status: result.status };

  const overwriteSet = new Set(result.overwriteAgentIds);
  const toAdd = result.agents.filter((a) => !overwriteSet.has(a.id));
  const toOverwrite = result.agents.filter((a) => overwriteSet.has(a.id));

  // adopt-org 改挂(镜像 companyRoutes.ts C9-P0 段)。
  let orgRebindApply: AgentNodeConfig[] = [];
  if (result.orgParentRebindings.length) {
    const allAgents = getAgents();
    const affectedIds = new Set<string>();
    for (const rb of result.orgParentRebindings) {
      affectedIds.add(rb.agentId);
      if (rb.oldParentId) affectedIds.add(rb.oldParentId);
      if (rb.newParentId) affectedIds.add(rb.newParentId);
    }
    const rebindTo = new Map(result.orgParentRebindings.map((rb) => [rb.agentId, rb.newParentId]));
    const targetAgents = allAgents
      .filter((a) => (a.companyId ?? "default") === targetCompany.id)
      .map((a) => (rebindTo.has(a.id) ? { ...a, parentId: rebindTo.get(a.id) } : a));
    orgRebindApply = rebuildChildrenIds(targetAgents).filter((a) => affectedIds.has(a.id));
  }

  const fieldMerge = mergeCompanyLevelFields(targetCompany, safeInstall.template);
  const memoryPlan = planMergeAgentMemories(safeInstall.template.agentMemories, result);

  addAgents(toAdd);
  for (const a of toOverwrite) updateAgent(a.id, a);
  for (const a of orgRebindApply) updateAgent(a.id, { parentId: a.parentId, childrenIds: a.childrenIds });
  updateCompany(destRoot, targetCompany.id, { presetChannels: result.presetChannels, manifestMcpRequirements: result.mcpRequirements, ...fieldMerge.patch });
  // 镜像 companyRoutes.ts merge 分支(更新后口径):只写"本次 merge 新建员工"(importIdMap 已过滤掉
  // overwrite/skipped/未映射的既有员工),用非抛出的 Detailed + assert——未映射条目不写盘、走 requires_review,
  // 不再对既有员工整文件覆盖,也不因"有未映射条目"而抛错(map/overwrite 下 importIdMap 恒为 {} 是设计而非错误)。
  const plannedAgentMemories = (safeInstall.template.agentMemories ?? []).filter(
    (memory) => memoryPlan.importIdMap[memory.agent_id] !== undefined,
  );
  const agentMemoriesResult = importAgentMemoriesDetailed(destRoot, memoryPlan.importIdMap, plannedAgentMemories);
  assertAgentMemoryImportSucceeded(agentMemoriesResult);
  const agentMemoriesImported = agentMemoriesResult.written;
  const memImport = applyMemoryImportModeTracked(destRoot, safeInstall.template.seedMemories, opts.memoryMode ?? "full", {
    companyId: targetCompany.id, bundleId: safeInstall.template.id, asProposal: true,
  });
  for (const id of memImport.recordIds.governedProposalIds) {
    const decided = decideGovernedMemoryProposal(destRoot, id, "approved", "ledger-test");
    if (!decided || decided.status !== "approved") throw new Error(`merge memory proposal approval failed: ${id}`);
  }
  return { ok: true, memoryReviewItems: memoryPlan.reviewItems, agentMemoriesImported };
}

// ── round-trip 取值 helpers ──────────────────────────────────────────────────
const agentByRole = (agents: AgentNodeConfig[], role: string) => agents.find((a) => a.role === role);
const skillByName = (bundle: CompanyBundle, name: string) => (bundle.bundledSkills ?? []).find((b) => b.name === name);
const memByContent = (bundle: CompanyBundle, needle: string) => (bundle.memory?.records ?? []).find((r) => r.content.includes(needle));
const memAgentByRole = (bundle: CompanyBundle, role: string) => (bundle.agentMemories ?? []).find((m) => m.role === role);
const sortStr = (a?: string[]) => [...(a ?? [])].sort();

let rootA: string;

beforeAll(() => {
  rootA = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-src-"));
  hoisted.skills.map.clear();
  seedRichCompany(rootA);
});
afterAll(() => { try { fs.rmSync(rootA, { recursive: true, force: true }); } catch { /* */ } });

// 完整性兜底白名单:两份 full 导出物的叶子差异只允许落在"身份/时间戳"与"已在 ledger 正面断言的
// 记录级有意转换"两类里。**这不是 KNOWN_LOSS 逃生门**——下面每一类差异都对应 ledger 里一条"内容保真/
// 脱敏"的正面判定(真丢失会被 ledger 抓到而非被这里放过):
//   · 身份/时间戳:导入即新公司,合理可预期。
//   · memory.records[*].content:记忆内容的往返在 ledger 里逐条判定(team=preserved 精确、company=
//     secret-removed 且显式断言"含正文不含密钥"、procedural=知识正文按包含判定保真)。此路径的差异只
//     源于①一次性密钥脱敏 ②procedural 经统一记忆容器归一(结构字段→正文),均非丢失。
//   · privacy.redacted_fields:密钥在首次导出即被剥离,再导出时已无密钥可扫 → 该列表幂等地收缩;这是
//     一次性脱敏的必然结果,非载荷丢失(密钥本身在 ledger 里断言已移除)。
const EXPLAINED_DIFFS: RegExp[] = [
  /^bundle_id$/, /^title$/, /^company\.company_id$/, /^company\.name$/,
  /^metadata\.created_at$/, /^metadata\.updated_at$/,
  /^memory\.records\[\d+\]\.(memory_id|scope|owner_id|created_at|updated_at|last_used_at|content)$/,
  // source.type 溯源(run/manual/import):导入即如实标为 "import"(源侧为 manual/run),与 scope/owner_id
  // 同属"导入重归属"的身份/溯源类差异,非载荷丢失(记忆内容仍逐条在 ledger 正面判定为保真)。
  /^memory\.records\[\d+\]\.source\.type$/,
  /^privacy\.redacted_fields(\[\d+\])?$/,
];
// 顺序无关字段排序,避免 Set 迭代/收集顺序造成的假差异(这些是集合语义,非有序列表)。
function normalizeForDiff(b: CompanyBundle): CompanyBundle {
  const clone: any = JSON.parse(JSON.stringify(b));
  if (clone.toolRequirements) {
    clone.toolRequirements.requiredEngines = sortStr(clone.toolRequirements.requiredEngines);
    clone.toolRequirements.requiredProviders = sortStr(clone.toolRequirements.requiredProviders);
  }
  if (clone.bundledSkills) {
    clone.bundledSkills.sort((x: any, y: any) => x.name.localeCompare(y.name));
    for (const s of clone.bundledSkills) s.roles = sortStr(s.roles);
  }
  if (clone.privacy?.required_secrets) clone.privacy.required_secrets.sort((x: any, y: any) => x.name.localeCompare(y.name));
  if (clone.privacy?.redacted_fields) clone.privacy.redacted_fields = sortStr(clone.privacy.redacted_fields);
  if (clone.memory?.records) clone.memory.records.sort((x: any, y: any) => x.content.localeCompare(y.content));
  if (clone.agentMemories) clone.agentMemories.sort((x: any, y: any) => x.agent_id.localeCompare(y.agent_id));
  return clone;
}

// ════════════════════════════════════════════════════════════════════════════
describe("P0-B 链路 a · full 档 export→JSON→import→re-export 全字段保真(ledger.lost=0)", () => {
  let wire1: CompanyBundle;   // 源公司 full 导出
  let wire2: CompanyBundle;   // 导入产物再 full 导出
  let imported: ImportOutcome;
  let importedCompany: any;

  beforeAll(() => {
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-full-"));
    fs.mkdirSync(path.join(rootB, ".opc"), { recursive: true });
    try {
      hoisted.agentsRoot.current = rootA;
      wire1 = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "full");
      // full 档 = 等价 unsafeAcknowledged,导入不降权、不剥 a2aChannels。
      imported = importViaEndpoint(rootB, wire1, { unsafeAcknowledged: true, memoryMode: "full" });
      expect(imported.applied).toBe(false);
      importedCompany = loadCompanies(rootB).find((c) => c.id === imported.companyId);
      wire2 = exportViaEndpoint(rootB, imported.companyId, "full");
    } finally {
      // rootB 落盘已读进 wire2/importedCompany,可清理
      try { fs.rmSync(rootB, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("full round-trip 的 field-fidelity ledger:lost=0,且每个可移植设计字段各归其类", () => {
    const dev = agentByRole(wire2.agents, "dev")!;
    const qa = agentByRole(wire2.agents, "qa")!;
    const ceo = agentByRole(wire2.agents, "ceo")!;
    const instDev = agentByRole(imported.agents, "dev")!;

    const specs: FieldSpec[] = [
      // —— preserved(可移植设计原样带回)——
      { field: "company.visibilityPolicy", expect: "preserved", source: FACTS.visibilityPolicy, roundTrip: importedCompany.visibilityPolicy },
      { field: "company.defaultTasks", expect: "preserved", source: FACTS.defaultTasks, roundTrip: importedCompany.defaultTasks },
      { field: "toolRequirements.requiredSkills", expect: "preserved", source: FACTS.toolRequirements.requiredSkills, roundTrip: wire2.toolRequirements?.requiredSkills },
      { field: "toolRequirements.optionalTools", expect: "preserved", source: FACTS.toolRequirements.optionalTools, roundTrip: wire2.toolRequirements?.optionalTools },
      { field: "toolRequirements.requiredMcpServers", expect: "preserved", source: FACTS.toolRequirements.requiredMcpServers, roundTrip: wire2.toolRequirements?.requiredMcpServers },
      { field: "toolRequirements.requiredEngines", expect: "preserved", source: sortStr(["api", "claude-code", "generic-cli"]), roundTrip: sortStr(wire2.toolRequirements?.requiredEngines) },
      { field: "toolRequirements.requiredProviders", expect: "preserved", source: sortStr(["deepseek", "anthropic", "custom"]), roundTrip: sortStr(wire2.toolRequirements?.requiredProviders) },
      { field: "useCases", expect: "preserved", source: FACTS.useCases, roundTrip: wire2.useCases },
      { field: "riskNotes", expect: "preserved", source: FACTS.riskNotes, roundTrip: wire2.riskNotes },
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: wire2.workflow?.verificationEdges },
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: wire2.a2aChannels },
      { field: "agents.ceo.card", expect: "preserved", source: FACTS.ceoCard, roundTrip: ceo.card },
      { field: "agents.ceo.growth", expect: "preserved", source: FACTS.ceoGrowth, roundTrip: ceo.growth },
      { field: "agents.ceo.uiPosition", expect: "preserved", source: FACTS.ceoUiPosition, roundTrip: ceo.uiPosition },
      { field: "agents.ceo.visibilityPolicy", expect: "preserved", source: "isolated", roundTrip: ceo.visibilityPolicy },
      { field: "agents.dev.framework", expect: "preserved", source: "claude-code", roundTrip: dev.framework },
      { field: "agents.dev.claudeCodeUseApiKey", expect: "preserved", source: true, roundTrip: dev.claudeCodeUseApiKey },
      { field: "agents.dev.reasoningEffort", expect: "preserved", source: "high", roundTrip: dev.reasoningEffort },
      { field: "agents.qa.framework", expect: "preserved", source: "generic-cli", roundTrip: qa.framework },
      { field: "agents.qa.genericCli", expect: "preserved", source: FACTS.qaGenericCli, roundTrip: qa.genericCli, note: "full 档保留本机 CLI 命令(自己备份)" },
      { field: "agents.qa.reasoningEffort", expect: "preserved", source: "medium", roundTrip: qa.reasoningEffort },
      { field: "bundledSkills.release-checklist.content", expect: "preserved", source: SKILL_CHECKLIST, roundTrip: skillByName(wire2, "release-checklist")?.content },
      { field: "bundledSkills.release-checklist.roles", expect: "preserved", source: sortStr(["dev", "qa"]), roundTrip: sortStr(skillByName(wire2, "release-checklist")?.roles) },
      { field: "bundledSkills.qa-playbook.content", expect: "preserved", source: SKILL_QA_PLAYBOOK, roundTrip: skillByName(wire2, "qa-playbook")?.content },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(wire2, TEAM_MEM)?.content },
      // 程序性记忆经"统一记忆容器"往返(结构字段归一为正文),知识正文保真 —— 按内容包含判定(不苛求字节级格式)。
      { field: "memory.agent.procedural.knowledge", expect: "preserved", source: true, roundTrip: !!memByContent(wire2, PROC_STEP), note: "procedural 记忆知识正文经容器往返保真" },
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(wire2, "dev")?.content },
      { field: "recommendedConfig", expect: "preserved", source: wire1.recommendedConfig, roundTrip: wire2.recommendedConfig, note: "建议配置(advisory),往返一致" },

      // —— intentionally_transformed(按设计有意改变)——
      { field: "company.folder", expect: "intentionally_transformed", transformKind: "path-remap", source: FACTS.folder, roundTrip: importedCompany.folder, note: "本机工作目录,导出/reroot 关口清空,导入侧本机重解析" },
      { field: "agents.dev.workspaceDir", expect: "intentionally_transformed", transformKind: "path-remap", source: DEV_WORKSPACE, roundTrip: instDev.workspaceDir },
      { field: "agents.dev.cliConfigDir", expect: "intentionally_transformed", transformKind: "path-remap", source: DEV_CLI_CONFIG, roundTrip: instDev.cliConfigDir },
      {
        field: "agents.dev.runtimeState", expect: "intentionally_transformed", transformKind: "runtime-reset",
        source: { status: "working", currentTask: "运行时残留任务", tokenUsage: { prompt: 100, completion: 50, total: 150 }, costUsd: 1.2 },
        roundTrip: { status: instDev.status, currentTask: instDev.currentTask, tokenUsage: instDev.tokenUsage, costUsd: instDev.costUsd },
      },
      {
        field: "memory.company.content", expect: "intentionally_transformed", transformKind: "secret-removed",
        source: `${COMPANY_MEM_MAIN}\n${COMPANY_MEM_SECRET_LINE}`, roundTrip: memByContent(wire2, COMPANY_MEM_MAIN)?.content,
        note: "company 级记忆的密钥形态导出即脱敏(非密钥正文保真)",
      },

      // —— requires_local_setup(需接收方本机配置的声明)——
      { field: "privacy.required_secrets", expect: "requires_local_setup", source: undefined, roundTrip: undefined, declaredIn: wire2.privacy.required_secrets, note: "provider key 声明,接收方需自备" },
      { field: "mcpRequirements", expect: "requires_local_setup", source: FACTS.mcpRequirements, roundTrip: wire2.mcpRequirements, declaredIn: wire2.mcpRequirements, note: "MCP 本机服务声明(full 原样带回),接收方需本机已配" },
    ];

    const ledger = buildLedger(specs);
    console.log("链路a(full) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);          // 硬约束:零静默丢失
    expect(ledger.unmet).toEqual([]);          // 每个字段都兑现了其声明的归属
    expect(ledger.counts.preserved).toBeGreaterThanOrEqual(24);

    // 关键点显式复核(不只信 ledger):脱敏真发生、非密钥正文真保真。
    expect(JSON.stringify(wire2)).not.toContain(SECRET);
    expect(memByContent(wire2, COMPANY_MEM_MAIN)?.content).toContain(COMPANY_MEM_MAIN);
    expect(memByContent(wire2, COMPANY_MEM_MAIN)?.content).not.toContain(SECRET);
    // 本机路径不外泄进导出物。
    expect(JSON.stringify(wire1)).not.toContain("rich\\\\site");
    expect(JSON.stringify(wire1)).not.toContain(".claude");
  });

  it("完整性兜底:两份 full 导出物的所有叶子差异只落在身份/时间戳白名单(无未登记字段静默漂移,无 KNOWN_LOSS 逃生门)", () => {
    const paths = diffLeafPaths(normalizeForDiff(wire1), normalizeForDiff(wire2));
    const unexplained = paths.filter((p) => !EXPLAINED_DIFFS.some((re) => re.test(p)));
    expect(unexplained).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe("P0-B 链路 b · share 档 export→默认安全安装→逐项批准 A2A/权限(ledger.lost=0)", () => {
  let shareWire: CompanyBundle;          // 源公司 share 导出
  let safeImport: ImportOutcome;         // 默认安全安装(降权)
  let safeReexport: CompanyBundle;       // 降权安装后再导出
  let safeCompany: any;                  // 降权安装后的公司对象
  let approvedReexport: CompanyBundle;   // 逐项批准(unsafeAcknowledged)后再导出
  let approvedCompany: any;

  beforeAll(() => {
    const rootSafe = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-share-safe-"));
    const rootApproved = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-share-appr-"));
    fs.mkdirSync(path.join(rootSafe, ".opc"), { recursive: true });
    fs.mkdirSync(path.join(rootApproved, ".opc"), { recursive: true });
    try {
      hoisted.agentsRoot.current = rootA;
      shareWire = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "share");

      // ① 默认安全安装:不勾选保留 → 剥离预置 A2A + MCP 授权(surfaced 进 stripped 队列)。
      safeImport = importViaEndpoint(rootSafe, shareWire, { unsafeAcknowledged: false, memoryMode: "structure-sop-verified" });
      expect(safeImport.applied).toBe(true);
      safeCompany = loadCompanies(rootSafe).find((c) => c.id === safeImport.companyId);
      safeReexport = exportViaEndpoint(rootSafe, safeImport.companyId, "share");

      // ② 逐项批准(等价用户在 UI 勾选恢复 A2A/权限)→ 重新安装,授权恢复。
      const approved = importViaEndpoint(rootApproved, shareWire, { unsafeAcknowledged: true, memoryMode: "structure-sop-verified" });
      expect(approved.applied).toBe(false);
      approvedCompany = loadCompanies(rootApproved).find((c) => c.id === approved.companyId);
      approvedReexport = exportViaEndpoint(rootApproved, approved.companyId, "share");
    } finally {
      for (const r of [rootSafe, rootApproved]) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
    }
  });

  it("默认安全安装的 ledger:降权项进批准队列(approved_after_import),脱敏项留声明(requires_local_setup),lost=0", () => {
    const dev = agentByRole(safeReexport.agents, "dev")!;
    const qa = agentByRole(safeReexport.agents, "qa")!;
    const ceo = agentByRole(safeReexport.agents, "ceo")!;
    const stripped = safeImport.stripped;
    const redactedGenericCli = (shareWire.privacy.redacted_fields ?? []).find((f) => /genericCli\.command/.test(f));

    const specs: FieldSpec[] = [
      // —— 降权入队(默认安全安装剥离,但显式登记进 stripped 供逐项批准)——
      {
        field: "a2aChannels", expect: "approved_after_import", source: FACTS.a2aChannels, roundTrip: safeReexport.a2aChannels,
        approvalQueue: stripped, approvalMatch: (q: any) => q.id === "preset-a2a-channels",
      },
      {
        field: "toolRequirements.requiredMcpServers", expect: "approved_after_import",
        source: FACTS.toolRequirements.requiredMcpServers, roundTrip: safeReexport.toolRequirements?.requiredMcpServers,
        approvalQueue: stripped, approvalMatch: (q: any) => q.id === "mcp-dependency",
      },
      // —— 脱敏/不可移植:share 档剥离本机 CLI 命令,记入 redacted_fields(接收方本机重配)——
      {
        field: "agents.qa.genericCli", expect: "requires_local_setup",
        source: FACTS.qaGenericCli, roundTrip: qa.genericCli, declaredIn: redactedGenericCli,
        note: "share 档剥离本机 CLI 命令并记入 privacy.redacted_fields",
      },
      // —— MCP 需求声明本身仍保留(只是自动授权被剥离)——
      { field: "mcpRequirements", expect: "requires_local_setup", source: FACTS.mcpRequirements, roundTrip: safeReexport.mcpRequirements, declaredIn: safeReexport.mcpRequirements },
      { field: "privacy.required_secrets", expect: "requires_local_setup", source: undefined, roundTrip: undefined, declaredIn: safeReexport.privacy.required_secrets },

      // —— share 档不降权的可移植设计仍需保真(权限降权 ≠ 记忆/结构不带)——
      { field: "company.visibilityPolicy", expect: "preserved", source: FACTS.visibilityPolicy, roundTrip: safeCompany.visibilityPolicy },
      { field: "company.defaultTasks", expect: "preserved", source: FACTS.defaultTasks, roundTrip: safeReexport.defaultTasks },
      { field: "toolRequirements.requiredSkills", expect: "preserved", source: FACTS.toolRequirements.requiredSkills, roundTrip: safeReexport.toolRequirements?.requiredSkills },
      { field: "toolRequirements.optionalTools", expect: "preserved", source: FACTS.toolRequirements.optionalTools, roundTrip: safeReexport.toolRequirements?.optionalTools },
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: safeReexport.workflow?.verificationEdges },
      { field: "agents.dev.framework", expect: "preserved", source: "claude-code", roundTrip: dev.framework },
      { field: "agents.dev.claudeCodeUseApiKey", expect: "preserved", source: true, roundTrip: dev.claudeCodeUseApiKey },
      { field: "agents.dev.reasoningEffort", expect: "preserved", source: "high", roundTrip: dev.reasoningEffort },
      { field: "agents.qa.reasoningEffort", expect: "preserved", source: "medium", roundTrip: qa.reasoningEffort },
      { field: "agents.ceo.card", expect: "preserved", source: FACTS.ceoCard, roundTrip: ceo.card },
      { field: "agents.ceo.growth", expect: "preserved", source: FACTS.ceoGrowth, roundTrip: ceo.growth },
      { field: "bundledSkills.release-checklist.content", expect: "preserved", source: SKILL_CHECKLIST, roundTrip: skillByName(safeReexport, "release-checklist")?.content },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(safeReexport, TEAM_MEM)?.content },
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(safeReexport, "dev")?.content },

      // —— 密钥脱敏(share 也脱敏)——
      {
        field: "memory.company.content", expect: "intentionally_transformed", transformKind: "secret-removed",
        source: `${COMPANY_MEM_MAIN}\n${COMPANY_MEM_SECRET_LINE}`, roundTrip: memByContent(safeReexport, COMPANY_MEM_MAIN)?.content,
      },
    ];

    const ledger = buildLedger(specs);
    console.log("链路b(share·默认安全安装) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.unmet).toEqual([]);
    // 降权项确实进了 stripped 队列(逐项批准的数据来源),不是静默消失。
    expect(stripped.map((s) => s.id).sort()).toEqual(["mcp-dependency", "preset-a2a-channels", "shell-access"]);
    // 默认安装后 A2A 通道确实为空(降权生效),但源包 share 导出仍携带 a2aChannels(供 UI 展示待批准)。
    expect(safeReexport.a2aChannels).toBeUndefined();
    expect(shareWire.a2aChannels).toHaveLength(2);
    expect(SECRET).not.toEqual("");
    expect(JSON.stringify(safeReexport)).not.toContain(SECRET);
  });

  it("逐项批准 A2A/权限后:降权项全部恢复(approved 再导出 = 与源等值)", () => {
    // 批准(unsafeAcknowledged=true)后 A2A 通道与 MCP 授权恢复,证明"待批准"是可恢复的降权而非丢失。
    expect(approvedReexport.a2aChannels).toEqual(FACTS.a2aChannels);
    expect(approvedReexport.toolRequirements?.requiredMcpServers).toEqual(FACTS.toolRequirements.requiredMcpServers);
    expect(approvedCompany.visibilityPolicy).toBe(FACTS.visibilityPolicy);

    // 批准态的 ledger:此前的 approved_after_import 项现在回到 preserved,lost 仍为 0。
    const specs: FieldSpec[] = [
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: approvedReexport.a2aChannels },
      { field: "toolRequirements.requiredMcpServers", expect: "preserved", source: FACTS.toolRequirements.requiredMcpServers, roundTrip: approvedReexport.toolRequirements?.requiredMcpServers },
    ];
    const ledger = buildLedger(specs);
    console.log("链路b(share·逐项批准后) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.counts.preserved).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// P0-B 链路 c/d · 公司 → 工坊(真实调 draftFromTemplate/buildPayload)→ 社区库存 → 安装 → 再导出
//
// 走真实工坊转换,不是重写一份:pickCompany 的 GET /companies/:id/export(缺省 share)→ bundleToTemplateShape
// → draftFromTemplate("company") → buildPayload。保存 = 真实 saveTemplate + runShareSafetyGate(镜像 POST
// /community/templates 核心);安装 = 真实 runTemplateDoctor + applySafeInstall + installCompanyTemplate
// (落 visibilityPolicy/defaultTasks/agentMemories)+ applyMemoryImportModeTracked。每条 ledger.lost=0。
// 链路 c:不编辑直接保存;链路 d:只编辑一个字段(描述),验证其余字段一字不丢。
// ════════════════════════════════════════════════════════════════════════════

interface WorkshopInstallOutcome {
  companyId: string;
  template: CompanyTemplate;
  wire: CompanyBundle;
  company: any;
}

// 镜像 POST /community/templates(保存)+ /community/install/company·new-company(安装)的核心——
// 每一步都调真实函数(schema/安全闸/doctor/safeInstall/installCompanyTemplate/记忆写回),不是只测 schema。
function workshopSaveAndInstall(
  destRoot: string,
  built: { template: CompanyTemplate; personas: Array<{ role: string; title: string; content: string }> },
  memoryMode: MemoryImportMode,
): WorkshopInstallOutcome {
  // ① 保存到社区库:补身份字段 → CompanyTemplateSchema 校验 → share 安全闸(密钥/本机路径硬拦)→ 落库。
  const draftTemplate = { ...built.template, author: "local-creator", downloads: 0, stars: 0, createdAt: built.template.createdAt || new Date().toISOString() };
  const parsed = CompanyTemplateSchema.safeParse(draftTemplate);
  if (!parsed.success) throw new Error("workshop template schema 失败: " + parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  const template = parsed.data as unknown as CompanyTemplate;
  const gate = runShareSafetyGate(template, { projectRoot: destRoot, extraContent: built.personas });
  if (!gate.ok) throw new Error("share 安全闸拦截: " + gate.findings.map((f) => f.message).join("; "));
  saveTemplate(destRoot, template);

  // ② 安装为新公司:社区库存读回 → doctor → applySafeInstall(本人模板 → 完整恢复,不降权)→ 真实落地。
  const tplRaw = getTemplate(destRoot, template.id);
  if (!tplRaw) throw new Error("社区库存读取失败");
  const doctor = runTemplateDoctor(tplRaw, { projectRoot: destRoot });
  if (!doctor.install_allowed) throw new Error("doctor 拦截社区安装");
  const safeInstall = applySafeInstall(tplRaw, { unsafeAcknowledged: true });
  hoisted.agentsRoot.current = destRoot;
  const result = installCompanyTemplate(destRoot, safeInstall.template, {
    nameSuffix: "(社区安装)",
    agentMemories: safeInstall.template.agentMemories,
  });
  if (!result.ok) throw new Error("社区安装失败: " + result.error);
  const wsImport = applyMemoryImportModeTracked(destRoot, safeInstall.template.seedMemories, memoryMode, { companyId: result.companyId, bundleId: safeInstall.template.id });
  for (const id of wsImport.recordIds.governedProposalIds) {
    const decided = decideGovernedMemoryProposal(destRoot, id, "approved", "ledger-test");
    if (!decided || decided.status !== "approved") throw new Error(`workshop memory proposal approval failed: ${id}`);
  }
  // 收口作战令一.1/二.5:导入默认 proposed/pending——链路口径 = 导入→【明确批准】→再导出(同链路 a)。
  for (const id of wsImport.recordIds.conclusionIds) approveConclusionSummary(destRoot, id);
  for (const id of [...wsImport.recordIds.lessonCreatedIds, ...wsImport.recordIds.lessonMergedIds]) {
    approveLesson(destRoot, id, "ledger-test", new Date().toISOString());
  }
  for (const id of [...wsImport.recordIds.proceduralSkillCreatedIds, ...wsImport.recordIds.proceduralSkillMergedIds]) {
    approveProceduralSkill(destRoot, id, new Date().toISOString());
  }
  const wire = exportViaEndpoint(destRoot, result.companyId, "share");
  const company = loadCompanies(destRoot).find((c) => c.id === result.companyId);
  return { companyId: result.companyId, template, wire, company };
}

describe("P0-B 链路 c · 公司→工坊(不编辑)→社区库存→安装→再导出(ledger.lost=0)", () => {
  let shareBundle: CompanyBundle;
  let built: ReturnType<typeof buildPayload>;
  let outcome: WorkshopInstallOutcome;

  beforeAll(() => {
    const rootC = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-workshop-c-"));
    fs.mkdirSync(path.join(rootC, ".opc", "community", "templates"), { recursive: true }); // 预建 → ensureSeeded 跳过种子写盘
    try {
      hoisted.agentsRoot.current = rootA;
      shareBundle = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "share");         // 工坊 pickCompany:缺省 share 档
      const companyTpl = bundleToTemplateShape(shareBundle) as unknown as CompanyTemplate; // pickCompany 桥接
      const draft = draftFromTemplate(companyTpl, "company");                     // 真实工坊反推
      built = buildPayload(draft);                                                // 真实工坊落盘 payload(不编辑)
      outcome = workshopSaveAndInstall(rootC, built, "full");
    } finally {
      try { fs.rmSync(rootC, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("普通员工不被自动人设化(P0-B②):buildPayload 无 persona 产出,dev/qa 仍是语义 role(未被改成 wk-*)", () => {
    expect(built.personas).toEqual([]);
    expect(built.roleChanges).toEqual([]);
    expect(built.template.agents.map((a) => a.role).sort()).toEqual(["ceo", "dev", "qa"]);
  });

  it("工坊链路 field-fidelity ledger:lost=0,可移植设计字段各归其类(含 visibilityPolicy/defaultTasks/员工记忆真落地)", () => {
    const wire = outcome.wire;
    const dev = agentByRole(wire.agents, "dev")!;
    const qa = agentByRole(wire.agents, "qa")!;
    const ceo = agentByRole(wire.agents, "ceo")!;
    const shareRedactedGenericCli = (shareBundle.privacy.redacted_fields ?? []).find((f) => /genericCli/.test(f));

    const specs: FieldSpec[] = [
      // —— preserved(工坊不编辑,未编辑字段原样带回)——
      { field: "company.visibilityPolicy", expect: "preserved", source: FACTS.visibilityPolicy, roundTrip: outcome.company.visibilityPolicy },
      { field: "company.defaultTasks", expect: "preserved", source: FACTS.defaultTasks, roundTrip: outcome.company.defaultTasks },
      { field: "toolRequirements.requiredSkills", expect: "preserved", source: FACTS.toolRequirements.requiredSkills, roundTrip: wire.toolRequirements?.requiredSkills },
      { field: "toolRequirements.optionalTools", expect: "preserved", source: FACTS.toolRequirements.optionalTools, roundTrip: wire.toolRequirements?.optionalTools },
      { field: "toolRequirements.requiredMcpServers", expect: "preserved", source: FACTS.toolRequirements.requiredMcpServers, roundTrip: wire.toolRequirements?.requiredMcpServers },
      { field: "useCases", expect: "preserved", source: FACTS.useCases, roundTrip: wire.useCases },
      { field: "riskNotes", expect: "preserved", source: FACTS.riskNotes, roundTrip: wire.riskNotes },
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: wire.workflow?.verificationEdges },
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: wire.a2aChannels, note: "本人模板完整恢复(unsafeAck),预置通道原样带回" },
      { field: "agents.ceo.card", expect: "preserved", source: FACTS.ceoCard, roundTrip: ceo.card },
      { field: "agents.ceo.growth", expect: "preserved", source: FACTS.ceoGrowth, roundTrip: ceo.growth },
      { field: "agents.ceo.uiPosition", expect: "preserved", source: FACTS.ceoUiPosition, roundTrip: ceo.uiPosition },
      { field: "agents.dev.framework", expect: "preserved", source: "claude-code", roundTrip: dev.framework },
      { field: "agents.dev.claudeCodeUseApiKey", expect: "preserved", source: true, roundTrip: dev.claudeCodeUseApiKey },
      { field: "agents.dev.reasoningEffort", expect: "preserved", source: "high", roundTrip: dev.reasoningEffort },
      { field: "agents.qa.framework", expect: "preserved", source: "generic-cli", roundTrip: qa.framework },
      { field: "agents.qa.reasoningEffort", expect: "preserved", source: "medium", roundTrip: qa.reasoningEffort },
      { field: "bundledSkills.release-checklist.content", expect: "preserved", source: SKILL_CHECKLIST, roundTrip: skillByName(wire, "release-checklist")?.content },
      { field: "bundledSkills.release-checklist.roles", expect: "preserved", source: sortStr(["dev", "qa"]), roundTrip: sortStr(skillByName(wire, "release-checklist")?.roles) },
      { field: "bundledSkills.qa-playbook.content", expect: "preserved", source: SKILL_QA_PLAYBOOK, roundTrip: skillByName(wire, "qa-playbook")?.content },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(wire, TEAM_MEM)?.content },
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(wire, "dev")?.content, note: "工坊重排 agent id 后 agent_id 同步改写,员工记忆随链路落地(修复前会丢)" },
      { field: "memory.agent.procedural.knowledge", expect: "preserved", source: true, roundTrip: !!memByContent(wire, PROC_STEP) },

      // —— intentionally_transformed / requires_local_setup ——
      { field: "memory.company.content", expect: "intentionally_transformed", transformKind: "secret-removed", source: `${COMPANY_MEM_MAIN}\n${COMPANY_MEM_SECRET_LINE}`, roundTrip: memByContent(wire, COMPANY_MEM_MAIN)?.content, note: "工坊上游是 share 档,company 记忆密钥早已脱敏(正文保真)" },
      { field: "agents.qa.genericCli", expect: "requires_local_setup", source: FACTS.qaGenericCli, roundTrip: qa.genericCli, declaredIn: shareRedactedGenericCli, note: "share 档在工坊上游即剥离本机 CLI 命令并记入 redacted_fields" },
      { field: "mcpRequirements", expect: "requires_local_setup", source: FACTS.mcpRequirements, roundTrip: wire.mcpRequirements, declaredIn: wire.mcpRequirements },
      { field: "privacy.required_secrets", expect: "requires_local_setup", source: undefined, roundTrip: undefined, declaredIn: wire.privacy.required_secrets },
    ];

    const ledger = buildLedger(specs);
    console.log("链路c(工坊·不编辑) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.unmet).toEqual([]);
    expect(ledger.counts.preserved).toBeGreaterThanOrEqual(20);
    // 关键复核:员工个人记忆真随工坊链路落地(agent_id 重排修复的直接见证);无密钥外泄。
    expect(memAgentByRole(wire, "dev")?.content).toContain(DEV_AGENT_MEMORY);
    expect(JSON.stringify(wire)).not.toContain(SECRET);
  });
});

describe("P0-B 链路 d · 公司→工坊→只编辑一个字段→保存→其余字段不丢(ledger.lost=0)", () => {
  const EDITED_DESC = "【工坊编辑】只改这一句描述,其余可移植字段必须一字不丢。";
  let baseline: ReturnType<typeof buildPayload>;  // 不编辑基线
  let edited: ReturnType<typeof buildPayload>;     // 只编辑 description
  let outcome: WorkshopInstallOutcome;

  beforeAll(() => {
    const rootD = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-workshop-d-"));
    fs.mkdirSync(path.join(rootD, ".opc", "community", "templates"), { recursive: true });
    try {
      hoisted.agentsRoot.current = rootA;
      const sb = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "share");
      const companyTpl = bundleToTemplateShape(sb) as unknown as CompanyTemplate;
      const draft = draftFromTemplate(companyTpl, "company");
      baseline = buildPayload(draft);                                   // 不编辑
      edited = buildPayload({ ...draft, description: EDITED_DESC });    // 只改描述
      outcome = workshopSaveAndInstall(rootD, edited, "full");
    } finally {
      try { fs.rmSync(rootD, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("只改了描述:编辑生效,其余每个可移植字段与不编辑基线逐一相等(编辑不误伤其余字段)", () => {
    expect(edited.template.description).toBe(EDITED_DESC);
    expect(edited.template.description).not.toBe(baseline.template.description);
    // readme 由 description 派生(允许一并变);其余可移植字段必须与基线完全相等。
    // 收口④:投影字段清单收敛到登记表(companyFieldRegistry.PORTABLE_DESIGN_FIELD_KEYS =
    // portable 且非身份/元数据/安全信号的全部顶层设计字段),不再本地硬编码 13 键——登记表新增
    // 可移植设计字段时本投影自动跟进,漏保真会在这里现形。
    const portable = (t: CompanyTemplate) =>
      Object.fromEntries(PORTABLE_DESIGN_FIELD_KEYS.map((k) => [k, (t as unknown as Record<string, unknown>)[k]]));
    expect(portable(edited.template)).toEqual(portable(baseline.template));
  });

  it("编辑一个字段后保存+社区安装:再导出 ledger.lost=0,被编辑字段生效、其余全回收", () => {
    const wire = outcome.wire;
    const dev = agentByRole(wire.agents, "dev")!;
    const ceo = agentByRole(wire.agents, "ceo")!;
    const specs: FieldSpec[] = [
      { field: "company.visibilityPolicy", expect: "preserved", source: FACTS.visibilityPolicy, roundTrip: outcome.company.visibilityPolicy },
      { field: "company.defaultTasks", expect: "preserved", source: FACTS.defaultTasks, roundTrip: outcome.company.defaultTasks },
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: wire.workflow?.verificationEdges },
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: wire.a2aChannels },
      { field: "agents.ceo.card", expect: "preserved", source: FACTS.ceoCard, roundTrip: ceo.card },
      { field: "agents.dev.reasoningEffort", expect: "preserved", source: "high", roundTrip: dev.reasoningEffort },
      { field: "agents.dev.claudeCodeUseApiKey", expect: "preserved", source: true, roundTrip: dev.claudeCodeUseApiKey },
      { field: "bundledSkills.release-checklist.content", expect: "preserved", source: SKILL_CHECKLIST, roundTrip: skillByName(wire, "release-checklist")?.content },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(wire, TEAM_MEM)?.content },
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(wire, "dev")?.content },
    ];
    const ledger = buildLedger(specs);
    console.log("链路d(工坊·编辑一字段) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.unmet).toEqual([]);
    // 被编辑字段确实改了(编辑生效),其余不丢。
    expect(outcome.company.description).toBe(EDITED_DESC);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C9-P0-B 链路 e · export A → import(new-company clone)→ merge(map)回克隆 → re-export
//   契约第9条:map 不得静默导入外部员工记忆(默认保留现有);export→import→map→re-export 零丢失。
//   活体断言(不是 mock/schema):真实 in-process 调导出/导入/合并函数,合并前后读既有员工
//   agent-memory.md 的**磁盘字节**必须逐字节不变(修复前会被模板记忆整文件覆盖)。
// ════════════════════════════════════════════════════════════════════════════
describe("C9-P0-B 链路 e · merge(map)回克隆:既有员工记忆字节不变 + 再导出 ledger.lost=0", () => {
  const TAMPERED_DEV_MEMORY = "【被污染的外部记忆】如果 map 静默导入,这段会覆盖既有 dev 的记忆——绝不允许。";
  let wireA: CompanyBundle;      // 源公司 full 导出
  let cloneId: string;           // 导入的克隆公司 id
  let existingDevId: string;     // 克隆里 dev 员工 id(既有员工)
  let devMemoryBefore: string;   // merge 前 dev 记忆字节
  let devMemoryAfter: string;    // merge 后 dev 记忆字节
  let mergeResult: MergeOutcome;
  let reexport: CompanyBundle;   // merge 后再导出
  let rootE: string;

  beforeAll(() => {
    rootE = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-merge-e-"));
    fs.mkdirSync(path.join(rootE, ".opc"), { recursive: true });
    hoisted.agentsRoot.current = rootA;
    wireA = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "full");

    // ① 导入为克隆公司(new-company)。
    const imported = importViaEndpoint(rootE, wireA, { unsafeAcknowledged: true, memoryMode: "full" });
    cloneId = imported.companyId;
    existingDevId = agentByRole(imported.agents, "dev")!.id;
    devMemoryBefore = readAgentMemory(rootE, existingDevId);
    expect(devMemoryBefore).toContain(DEV_AGENT_MEMORY); // 克隆里 dev 有源公司记忆

    // ② 把同一 bundle 的 dev agentMemory 篡改为不同内容,再 map 回克隆——若 map 静默导入,既有字节会被它覆盖。
    const tamperedBundle: CompanyBundle = JSON.parse(JSON.stringify(wireA));
    tamperedBundle.agentMemories = (tamperedBundle.agentMemories ?? []).map((m) =>
      m.role === "dev" ? { ...m, content: TAMPERED_DEV_MEMORY } : m);
    // 同 role+name 的 CEO/dev/qa 全部 team_duplication → map;无 orgParent 差异(同结构克隆,父子一致)。
    mergeResult = mergeViaEndpoint(rootE, tamperedBundle, cloneId, { teamDuplicationResolution: "map", memoryMode: "full" });
    expect(mergeResult.ok).toBe(true);

    devMemoryAfter = readAgentMemory(rootE, existingDevId);
    reexport = exportViaEndpoint(rootE, cloneId, "full");
  });

  afterAll(() => { try { fs.rmSync(rootE, { recursive: true, force: true }); } catch { /* */ } });

  it("既有员工记忆字节不变(map 不静默覆盖;篡改的外部记忆进 requires_review 而非落盘)", () => {
    // 核心活体断言:磁盘字节逐字节相等。
    expect(devMemoryAfter).toBe(devMemoryBefore);
    expect(devMemoryAfter).toContain(DEV_AGENT_MEMORY);
    expect(devMemoryAfter).not.toContain(TAMPERED_DEV_MEMORY); // 篡改内容绝不落盘
    // 篡改的来源记忆如实进 requires_review(不静默消失也不静默覆盖)。
    const devReview = (mergeResult.memoryReviewItems ?? []).find((r) => r.detail.includes("dev"));
    expect(devReview).toBeTruthy();
    expect(devReview!.detail).toContain("保留目标员工记忆");
    // map 全员映射到既有 → 无新建员工记忆写盘。
    expect(mergeResult.agentMemoriesImported).toBe(0);
  });

  it("merge(map)不新增第二套团队:克隆仍是单套 ceo/dev/qa(map 映射到既有,非 copy-as-new 翻倍)", () => {
    const cloneAgents = getAgents().filter((a) => (a.companyId ?? "default") === cloneId);
    const roleCounts = cloneAgents.reduce<Record<string, number>>((acc, a) => { acc[a.role!] = (acc[a.role!] ?? 0) + 1; return acc; }, {});
    expect(roleCounts).toEqual({ ceo: 1, dev: 1, qa: 1 });
  });

  it("merge→re-export 的 field-fidelity ledger:lost=0(map 回灌不丢结构字段)", () => {
    const dev = agentByRole(reexport.agents, "dev")!;
    const qa = agentByRole(reexport.agents, "qa")!;
    const ceo = agentByRole(reexport.agents, "ceo")!;
    const cloneCompany = loadCompanies(rootE).find((c) => c.id === cloneId);
    const specs: FieldSpec[] = [
      { field: "company.visibilityPolicy", expect: "preserved", source: FACTS.visibilityPolicy, roundTrip: cloneCompany!.visibilityPolicy },
      { field: "company.defaultTasks", expect: "preserved", source: FACTS.defaultTasks, roundTrip: cloneCompany!.defaultTasks },
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: reexport.workflow?.verificationEdges },
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: reexport.a2aChannels },
      { field: "agents.ceo.card", expect: "preserved", source: FACTS.ceoCard, roundTrip: ceo.card },
      { field: "agents.dev.framework", expect: "preserved", source: "claude-code", roundTrip: dev.framework },
      { field: "agents.dev.reasoningEffort", expect: "preserved", source: "high", roundTrip: dev.reasoningEffort },
      { field: "agents.qa.framework", expect: "preserved", source: "generic-cli", roundTrip: qa.framework },
      { field: "bundledSkills.release-checklist.content", expect: "preserved", source: SKILL_CHECKLIST, roundTrip: skillByName(reexport, "release-checklist")?.content },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(reexport, TEAM_MEM)?.content },
      // 既有员工记忆保真(map 保留既有,不被外部覆盖)。
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(reexport, "dev")?.content },
    ];
    const ledger = buildLedger(specs);
    console.log("链路e(merge·map回克隆) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.unmet).toEqual([]);
    // 再导出的 dev 记忆仍是既有内容,不含篡改内容。
    expect(memAgentByRole(reexport, "dev")?.content).toContain(DEV_AGENT_MEMORY);
    expect(JSON.stringify(reexport)).not.toContain(TAMPERED_DEV_MEMORY);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C9-P0-B 链路 f · merge(overwrite)回克隆:overwrite 覆盖既有员工身份字段,但记忆仍保留既有
//   (planMergeAgentMemories 对 overwrite 也不导入来源记忆),再导出 lost=0。
// ════════════════════════════════════════════════════════════════════════════
describe("C9-P0-B 链路 f · merge(overwrite)回克隆:既有员工记忆保留 + 再导出 ledger.lost=0", () => {
  const TAMPERED_DEV_MEMORY_F = "【overwrite 也不得导入外部记忆】既有 dev 记忆必须保留。";
  let wireA: CompanyBundle;
  let cloneId: string;
  let existingDevId: string;
  let devMemoryBefore: string;
  let devMemoryAfter: string;
  let mergeResult: MergeOutcome;
  let reexport: CompanyBundle;
  let rootF: string;

  beforeAll(() => {
    rootF = fs.mkdtempSync(path.join(os.tmpdir(), "ffl-merge-f-"));
    fs.mkdirSync(path.join(rootF, ".opc"), { recursive: true });
    hoisted.agentsRoot.current = rootA;
    wireA = exportViaEndpoint(rootA, SOURCE_COMPANY_ID, "full");

    const imported = importViaEndpoint(rootF, wireA, { unsafeAcknowledged: true, memoryMode: "full" });
    cloneId = imported.companyId;
    existingDevId = agentByRole(imported.agents, "dev")!.id;
    devMemoryBefore = readAgentMemory(rootF, existingDevId);

    const tamperedBundle: CompanyBundle = JSON.parse(JSON.stringify(wireA));
    tamperedBundle.agentMemories = (tamperedBundle.agentMemories ?? []).map((m) =>
      m.role === "dev" ? { ...m, content: TAMPERED_DEV_MEMORY_F } : m);
    // overwrite:incoming 落到既有 id 上(覆盖身份字段),但记忆保留既有。
    mergeResult = mergeViaEndpoint(rootF, tamperedBundle, cloneId, { teamDuplicationResolution: "overwrite", memoryMode: "full" });
    expect(mergeResult.ok).toBe(true);

    devMemoryAfter = readAgentMemory(rootF, existingDevId);
    reexport = exportViaEndpoint(rootF, cloneId, "full");
  });

  afterAll(() => { try { fs.rmSync(rootF, { recursive: true, force: true }); } catch { /* */ } });

  it("overwrite 覆盖身份字段但既有员工记忆字节不变(来源记忆进 requires_review)", () => {
    expect(devMemoryAfter).toBe(devMemoryBefore);
    expect(devMemoryAfter).not.toContain(TAMPERED_DEV_MEMORY_F);
    expect(mergeResult.agentMemoriesImported).toBe(0);
    const devReview = (mergeResult.memoryReviewItems ?? []).find((r) => r.detail.includes("dev"));
    expect(devReview).toBeTruthy();
  });

  it("merge(overwrite)→re-export 的 ledger.lost=0", () => {
    const dev = agentByRole(reexport.agents, "dev")!;
    const specs: FieldSpec[] = [
      { field: "workflow.verificationEdges", expect: "preserved", source: FACTS.workflow.verificationEdges, roundTrip: reexport.workflow?.verificationEdges },
      { field: "a2aChannels", expect: "preserved", source: FACTS.a2aChannels, roundTrip: reexport.a2aChannels },
      { field: "agents.dev.framework", expect: "preserved", source: "claude-code", roundTrip: dev.framework },
      { field: "memory.team.content", expect: "preserved", source: TEAM_MEM, roundTrip: memByContent(reexport, TEAM_MEM)?.content },
      { field: "agentMemories.dev.content", expect: "preserved", source: DEV_AGENT_MEMORY, roundTrip: memAgentByRole(reexport, "dev")?.content },
    ];
    const ledger = buildLedger(specs);
    console.log("链路f(merge·overwrite回克隆) " + formatLedger(ledger));
    expect(ledger.lost).toEqual([]);
    expect(ledger.unmet).toEqual([]);
    expect(JSON.stringify(reexport)).not.toContain(TAMPERED_DEV_MEMORY_F);
  });
});
