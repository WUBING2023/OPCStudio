import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanyTemplate } from "@opc/shared";

// ── 迁移演练(《数据兼容宪法》常驻回归)────────────────────────────────────────────
// 承诺:任何流通过的 Bundle 永远可导入。金样本测试(companyBundle.schema.test.ts)只静态冻结了
// canonical 当前版本;这里补上"历史形态 → canonical → 真实安装链路落地成公司"的端到端演练:
//   · 历史形态① legacy flat 模板(无 schema_version,社区仓库已发布的全部旧模板都是这种);
//   · 历史形态② "0.3.0-legacy" 标签 bundle(早期 migrateLegacyTemplate 的产物标签,schema 严格化后
//     必须经注册表归一)。
// 两份 fixture 冻结在 packages/shared/src/__fixtures__(与金样本同处),永不删除。任何 bump
// CURRENT_BUNDLE_SCHEMA_VERSION 的改动都会跑到这份测试:若 legacy/旧标签无法一路升格到新 canonical
// 并完成安装,这里 CI 红——这正是"每次 bump schema 都会跑"的守卫本体。

// installCompanyTemplate(companyRoutes.ts)在模块顶层 import runtime/orchestrator.js 的 addAgents 等
// ——那是操作模块级单例(真实项目 .opc/agents.json)的函数,不吃调用方的 projectRoot 参数。这里替换成
// "写进当前测试 mkdtemp 根的 agents.json"的实现,让安装链路的员工落盘也发生在临时根里(与
// companyRoutes.test.ts 的既有 mock 同一手法,只是补了真实落盘,便于断言/再导出)。
const hoisted = vi.hoisted(() => ({
  agentsRoot: { current: "" },
  skills: { map: new Map<string, Record<string, unknown>>() },
}));

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

// skillStore 落盘目标是全局用户目录(~/.opcstudio/skills,见 storage/userDataStore.ts),不吃
// projectRoot——测试绝不能写真实用户数据,这里用同语义的内存实现替换(createSkill 已存在即抛 /
// origin 兜底推断 / listSkills 按 origin 过滤,与真实现逐条对齐)。
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
  parseCompanyBundle, migrateBundleViaRegistry, bundleToTemplateShape,
  CompanyTemplateSchema,
  CURRENT_BUNDLE_SCHEMA_VERSION, LEGACY_BUNDLE_VERSION, LEGACY_BUNDLE_SCHEMA_TAG,
} from "@opc/shared";
import { installCompanyTemplate } from "../routes/companyRoutes.js";
import { runTemplateDoctor } from "./templateDoctor.js";
import { bundledSkillId } from "./install.js";
import { applyMemoryImportMode, sanitizeMemoryImportMode } from "./memoryBundle.js";
import { loadCompanies } from "../storage/companyStore.js";
import { loadAgents } from "../storage/projectStore.js";
import { getSkill } from "../storage/skillStore.js";
import { listGovernedMemoryProposals } from "./memoryGovernance.js";

const FIXTURES = "../../../../packages/shared/src/__fixtures__";
const legacyFlat = JSON.parse(
  fs.readFileSync(new URL(`${FIXTURES}/company-template-legacy-flat-v0.json`, import.meta.url), "utf8"),
);
const legacyTagged = JSON.parse(
  fs.readFileSync(new URL(`${FIXTURES}/company-bundle-legacy-tagged-v1.json`, import.meta.url), "utf8"),
);

// 两份 fixture 的员工/结构预期(共用同一套组织)。
function assertInstalledCompanyRestored(
  root: string,
  tplId: string,
  expected: { title: string; useCases: string[]; riskNotes: string[] },
): void {
  const companies = loadCompanies(root);
  expect(companies).toHaveLength(1);
  const company = companies[0];
  expect(company.name).toBe(expected.title);

  // workflow 验证边原样落到公司(role 字符串,reroot 不改 role)。
  expect(company.workflow?.verificationEdges).toEqual([
    { producer: "dev", verifier: "qa", method: "code-review", onReject: "redo", maxRounds: 2 },
  ]);
  // mcpRequirements / 作者标注元数据保留。
  expect(company.manifestMcpRequirements).toEqual([{ name: "filesystem", purpose: "读写工作区", optional: true }]);
  expect(company.manifestUseCases).toEqual(expected.useCases);
  expect(company.manifestRiskNotes).toEqual(expected.riskNotes);

  // 员工全部还原:角色/引擎/provider/model + 汇报拓扑(parent/children 按新 id 重连,不悬空)。
  const agents = loadAgents(root, []).filter((a) => a.companyId === company.id);
  expect(agents).toHaveLength(3);
  const byRole = new Map(agents.map((a) => [a.role, a]));
  const ceo = byRole.get("ceo")!;
  const dev = byRole.get("dev")!;
  const qa = byRole.get("qa")!;
  expect(ceo.framework).toBe("api"); // 旧 bundle 的 "hermes" 读侧 alias 归一
  expect(ceo.model).toBe("deepseek-v4-pro");
  expect(ceo.provider).toBe("deepseek");
  expect(dev.framework).toBe("claude-code");
  expect(dev.provider).toBe("anthropic");
  expect(dev.model).toBe("sonnet");
  expect(qa.framework).toBe("api");
  expect(qa.model).toBe("deepseek-v4-flash");
  expect(dev.parentId).toBe(ceo.id);
  expect(qa.parentId).toBe(ceo.id);
  expect(new Set(ceo.childrenIds)).toEqual(new Set([dev.id, qa.id]));
  expect(company.ceoId).toBe(ceo.id);

  // a2aChannels(role 引用)换算成真实新 id 落进 presetChannels。
  expect(company.presetChannels).toHaveLength(1);
  expect(company.presetChannels![0]).toEqual({ from: ceo.id, to: dev.id, purpose: "任务下发" });

  // bundledSkills 按角色扇出落进技能库,正文一致(C1:id 掺安装后新公司 id)。
  const skillId = bundledSkillId(tplId, "release-checklist", "dev", company.id);
  const skill = getSkill(root, skillId);
  expect(skill).toBeTruthy();
  expect(skill!.content).toBe("发布前先跑冒烟测试,再灰度放量。");
}

describe("迁移演练① · legacy flat 模板(无 schema_version)→ canonical + 真实安装链路", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-flat-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    hoisted.agentsRoot.current = root;
    hoisted.skills.map.clear();
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("historical fixture 直接喂 CompanyBundleSchema 必然被拒(这正是迁移注册表存在的理由)", () => {
    expect(parseCompanyBundle(legacyFlat).ok).toBe(false);
  });

  it("migrateBundleViaRegistry 升格:产物 schema_version===CURRENT canonical,migration_notes 留痕,可被 parseCompanyBundle 接受", () => {
    const r = migrateBundleViaRegistry(legacyFlat);
    expect(r.ok).toBe(true);
    expect(r.appliedMigrations).toEqual([LEGACY_BUNDLE_VERSION]);
    expect(r.bundle!.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(r.bundle!.compatibility.migration_notes.some((n) => n.includes("legacy"))).toBe(true);
    expect(r.bundle!.agents).toHaveLength(3);
    expect(r.bundle!.bundle_id).toBe("legacy-flat-drill-v0");
    // 升格产物本身是 canonical bundle,可直接再过 parseCompanyBundle(宪法:迁移产物永远可导入)。
    const reparsed = parseCompanyBundle(r.bundle);
    expect(reparsed.ok).toBe(true);
  });

  it("真实安装链路(生产口径:legacy flat 的 candidate 用原始对象,不经 bundleToTemplateShape 降级)→ 公司/员工/workflow/a2aChannels/bundledSkills 全部还原", () => {
    // 与 communityRoutes templates/import、companyRoutes /api/companies/import 同一口径:
    // parseCompanyBundle 失败 → candidate 取原始 legacy 对象(它本就是扁平 CompanyTemplate 形状;
    // migrateLegacyTemplate 产出的 canonical bundle 只是审计视图,最小字段映射会丢 workflow/
    // a2aChannels/recommendedConfig,不能拿来装)。
    const asBundle = parseCompanyBundle(legacyFlat);
    expect(asBundle.ok).toBe(false);
    const parsed = CompanyTemplateSchema.safeParse(legacyFlat);
    expect(parsed.success).toBe(true);
    const doctor = runTemplateDoctor(legacyFlat, { projectRoot: root });
    expect(doctor.install_allowed).toBe(true);

    const result = installCompanyTemplate(root, parsed.data as unknown as CompanyTemplate);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentCount).toBe(3);
    expect(result.bundledSkillsInstalled).toBe(1);
    expect(result.presetChannelsInstalled).toBe(1);
    assertInstalledCompanyRestored(root, "legacy-flat-drill-v0", {
      title: legacyFlat.title, useCases: legacyFlat.useCases, riskNotes: legacyFlat.riskNotes,
    });
  });
});

describe("迁移演练② · 历史 0.3.0-legacy 标签 bundle → canonical → bundleToTemplateShape → 真实安装链路", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "drill-tagged-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    hoisted.agentsRoot.current = root;
    hoisted.skills.map.clear();
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("旧标签直接喂 CompanyBundleSchema 必然被拒(schema 严格化后标签不再是合法产物版本)", () => {
    expect(parseCompanyBundle(legacyTagged).ok).toBe(false);
  });

  it("端到端:migrateBundleViaRegistry 归一 → parseCompanyBundle 通过 → bundleToTemplateShape → 安装落地,结构字段零丢失", () => {
    // ① 升格:标签归一到 canonical,结构字段原样保留,migration_notes 留痕且不重复追加。
    const migrated = migrateBundleViaRegistry(legacyTagged);
    expect(migrated.ok).toBe(true);
    expect(migrated.appliedMigrations).toEqual([LEGACY_BUNDLE_SCHEMA_TAG]);
    const bundle = migrated.bundle!;
    expect(bundle.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
    expect(bundle.schema_version).not.toBe(LEGACY_BUNDLE_SCHEMA_TAG);
    expect(bundle.compatibility.migration_notes).toEqual(["自动迁移自 legacy template(无 schema_version)"]);
    expect(bundle.workflow?.verificationEdges).toHaveLength(1);
    expect(bundle.a2aChannels).toHaveLength(1);
    expect(bundle.bundledSkills).toHaveLength(1);
    expect(bundle.mcpRequirements).toHaveLength(1);
    expect(bundle.memory?.records).toHaveLength(1);

    // ② canonical 产物可被 parseCompanyBundle 接受(宪法承诺)。
    const reparsed = parseCompanyBundle(bundle);
    expect(reparsed.ok).toBe(true);

    // ③ 桥接回扁平模板形状,结构字段随行(含 memory.records → seedMemories)。
    const shape = bundleToTemplateShape(reparsed.bundle!) as Record<string, any>;
    expect(shape.workflow?.verificationEdges).toHaveLength(1);
    expect(shape.a2aChannels).toHaveLength(1);
    expect(shape.bundledSkills).toHaveLength(1);
    expect(shape.mcpRequirements).toHaveLength(1);
    expect(shape.seedMemories).toHaveLength(1);
    const parsed = CompanyTemplateSchema.safeParse(shape);
    expect(parsed.success).toBe(true);
    const tpl = parsed.data as unknown as CompanyTemplate;

    // ④ 体检 + 真实安装链路(mkdtemp 临时根)。
    const doctor = runTemplateDoctor(shape, { projectRoot: root });
    expect(doctor.install_allowed).toBe(true);
    const result = installCompanyTemplate(root, tpl);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agentCount).toBe(3);
    expect(result.bundledSkillsInstalled).toBe(1);
    expect(result.presetChannelsInstalled).toBe(1);
    assertInstalledCompanyRestored(root, tpl.id, {
      title: legacyTagged.title, useCases: legacyTagged.useCases, riskNotes: legacyTagged.riskNotes,
    });

    // ⑤ 记忆随行:seedMemories 按缺省导入档进入待审治理提案。
    const memoryImport = applyMemoryImportMode(root, tpl.seedMemories, sanitizeMemoryImportMode(undefined), {
      companyId: result.companyId,
    });
    expect(memoryImport.imported).toBe(1);
    const proposals = listGovernedMemoryProposals(root);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      status: "proposed",
      scope: "company",
      scopeId: result.companyId,
      content: "上线前务必先冒烟再放量。",
      portableBundleRecord: { memory_id: "mem-cs-drill-1" },
    });
  });
});

describe("迁移演练 · bump 守卫(常驻回归,不是一次性脚本)", () => {
  it("两份历史 fixture 在任何 CURRENT_BUNDLE_SCHEMA_VERSION 下都必须能经注册表收敛到当前 canonical(bump 后忘配迁移链 → 这里红)", () => {
    for (const fixture of [legacyFlat, legacyTagged]) {
      const r = migrateBundleViaRegistry(fixture);
      expect(r.ok).toBe(true);
      expect(r.bundle!.schema_version).toBe(CURRENT_BUNDLE_SCHEMA_VERSION);
      expect(r.bundle!.compatibility.migration_notes.length).toBeGreaterThan(0);
    }
  });
});
