import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { companyToTemplate, deriveToolRequirements, checkTemplateRequirements, collectDefaultTasks, importAgentMemories, importAgentMemoriesDetailed } from "./companyTemplate.js";
import { rerootAgents } from "./install.js";
import { createSkill, deleteSkill } from "../storage/skillStore.js";

// 技能库重定向到临时区,避免导出测试往真实用户目录 ~/.opcstudio/skills 读写 bundled-*/sk-* 残留
// (污染 + flaky 土壤;skillStore 存储目录全局、不按 projectRoot 隔离,见 userDataStore.getSkillsDir)。
let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-ct-"));
  process.env.OPC_SKILLS_DIR = skillsTmp;
});
afterAll(() => {
  delete process.env.OPC_SKILLS_DIR;
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
    { id: "c1", name: "研究队", description: "测试公司", ceoId: "rp-ceo", createdAt: "2026-01-01" },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    { id: "rp-ceo", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "deepseek-v4-pro", childrenIds: ["rp-lead", "rp-data"], tokenUsage: { prompt: 100, completion: 50, total: 150 }, costUsd: 0.5, status: "idle", currentTask: "旧任务", lastAction: "旧动作" },
    { id: "rp-lead", role: "lead", companyId: "c1", parentId: "rp-ceo", framework: "claude-code", provider: "anthropic", model: "sonnet", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, status: "idle" },
    { id: "rp-data", role: "dev", companyId: "c1", parentId: "rp-ceo", framework: "hermes", provider: "minimax", model: "abab", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, status: "idle" },
    { id: "other", role: "dev", companyId: "c2", framework: "hermes", provider: "deepseek", model: "x", childrenIds: [] },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { deepseek: "sk-xxx" } }));
  return root;
}

describe("Stage 1 · companyToTemplate 导出 / roundtrip / requirements", () => {
  let root: string;
  beforeEach(() => { root = setupRoot(); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("只含本公司 agent,清零用量,内部 id 自洽", () => {
    const tpl = companyToTemplate(root, "c1");
    expect(tpl.title).toBe("研究队");
    expect(tpl.agents.length).toBe(3); // 不含 c2 的 other
    for (const a of tpl.agents) {
      expect(a.companyId).toBe("");
      expect(a.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
      expect(a.costUsd).toBe(0);
      expect(a.currentTask).toBeUndefined();
    }
    const ceo = tpl.agents.find((a) => a.role === "ceo")!;
    const lead = tpl.agents.find((a) => a.role === "lead")!;
    expect(lead.parentId).toBe(ceo.id);
    expect(ceo.childrenIds).toContain(lead.id);
  });

  it("toolRequirements 从 agents 派生", () => {
    const tpl = companyToTemplate(root, "c1");
    expect(tpl.toolRequirements!.requiredEngines.sort()).toEqual(["api", "claude-code"]); // 导出写侧只出 "api"(存量 hermes 节点归一)
    expect(tpl.toolRequirements!.requiredProviders.sort()).toEqual(["anthropic", "deepseek", "minimax"]);
  });

  it("roundtrip:导出 → 重新 reroot 安装,结构一致、归属新公司", () => {
    const tpl = companyToTemplate(root, "c1");
    const { agents } = rerootAgents(tpl.agents, "newco", (old) => `${old}-x`);
    expect(agents.length).toBe(3);
    const ceo = agents.find((a) => a.role === "ceo")!;
    const lead = agents.find((a) => a.role === "lead")!;
    expect(lead.parentId).toBe(ceo.id);
    expect(agents.every((a) => a.companyId === "newco")).toBe(true);
  });

  it("requirements check:deepseek(有key)ready;minimax(无key)missing;anthropic(订阅CLI)不误报", () => {
    const tpl = companyToTemplate(root, "c1");
    const chk = checkTemplateRequirements(root, tpl);
    expect(chk.ready.providers).toContain("deepseek");
    expect(chk.missing.some((m) => m.name === "minimax")).toBe(true);
    expect(chk.missing.some((m) => m.name === "anthropic")).toBe(false); // 订阅 CLI 不当缺 key
    expect(chk.ok).toBe(false);
  });

  it("不存在的公司 → 抛错", () => {
    expect(() => companyToTemplate(root, "nope")).toThrow();
    expect(deriveToolRequirements([]).requiredEngines).toEqual([]);
  });

  // C2 · recommendedConfig 数据源 = loadConfig 的真实运行配置(当前项目运行配置快照,非公司级)。
  it("C2:config.json 带完整配置 → recommendedConfig 逐字段快照(defaultModel/budget/permissions)", () => {
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({
      apiKeys: {}, defaultModel: "kimi-k3",
      budget: { totalUsd: 42, maxTokensPerTask: 123_000 },
      permissions: { allowShell: true, allowFileWrite: false, allowWebAccess: true },
    }));
    const tpl = companyToTemplate(root, "c1");
    expect(tpl.recommendedConfig).toEqual({
      defaultModel: "kimi-k3",
      budget: { totalUsd: 42, maxTokensPerTask: 123_000 },
      permissions: { allowShell: true, allowFileWrite: false, allowWebAccess: true },
    });
  });

  it("C2:config 只有部分字段 → 只快照真实存在的字段,不虚构(budget 由 loadConfig 合并默认值)", () => {
    // setupRoot 的 config.json 只有 apiKeys:defaultModel/permissions 缺失 → 不产出;budget 被
    // loadConfig 透明合并默认值(存量 config 的既有行为)→ 如实快照合并后的运行值。
    const tpl = companyToTemplate(root, "c1");
    expect(tpl.recommendedConfig).toEqual({
      budget: { totalUsd: 0, maxTokensPerTask: 200_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true },
    });
  });
});

describe("Stage 8+ · companyToTemplate 的 bundledSkills 导出", () => {
  // 命名带唯一前缀(xz-ct-bundle-),避免碰到用户 ~/.opcstudio/skills 里的真实技能(skillStore 的存储
  // 目录是全局的,不按 projectRoot 隔离——见 userDataStore.getSkillsDir)。
  const TPL_ID = "xz-ct-bundle-test-tpl";
  const OTHER_TPL_ID = "xz-ct-bundle-other-tpl";
  const BUNDLED_DEV_ID = `bundled-${TPL_ID}-onboarding-guide--dev`;
  const BUNDLED_LEAD_ID = `bundled-${TPL_ID}-onboarding-guide--lead`;
  const DECOY_ID = `bundled-${OTHER_TPL_ID}-onboarding-guide--dev`;
  const RESEARCHER_ROLE = "xz-ct-bundle-researcher";
  const PERSONA_ID = `sk-${RESEARCHER_ROLE}`;

  let root: string;

  function setupBundleRoot(manifestTemplateId: string | undefined): string {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), "ct-bs-"));
    fs.mkdirSync(path.join(r, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(r, ".opc", "companies.json"), JSON.stringify([
      { id: "bc1", name: "打包技能测试公司", description: "", ceoId: "bs-ceo", createdAt: "2026-01-01", manifestTemplateId },
    ]));
    fs.writeFileSync(path.join(r, ".opc", "agents.json"), JSON.stringify([
      { id: "bs-ceo", role: "ceo", companyId: "bc1", framework: "hermes", provider: "deepseek", model: "x", childrenIds: ["bs-dev", "bs-lead", "bs-researcher"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
      { id: "bs-dev", role: "dev", companyId: "bc1", parentId: "bs-ceo", framework: "hermes", provider: "deepseek", model: "x", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
      { id: "bs-lead", role: "lead", companyId: "bc1", parentId: "bs-ceo", framework: "hermes", provider: "deepseek", model: "x", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
      { id: "bs-researcher", role: RESEARCHER_ROLE, companyId: "bc1", parentId: "bs-ceo", framework: "hermes", provider: "deepseek", model: "x", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
    ]));
    fs.writeFileSync(path.join(r, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    return r;
  }

  beforeEach(() => {
    createSkill(undefined, { id: BUNDLED_DEV_ID, title: "入职指南", role: "dev", enabled: true, content: "入职指南正文", description: "给 dev 的入职资料", lastModified: new Date().toISOString(), origin: "bundled" });
    createSkill(undefined, { id: BUNDLED_LEAD_ID, title: "入职指南", role: "lead", enabled: true, content: "入职指南正文", description: "给 dev 的入职资料", lastModified: new Date().toISOString(), origin: "bundled" });
    createSkill(undefined, { id: DECOY_ID, title: "别的模板的入职指南", role: "dev", enabled: true, content: "不该被拉进来", lastModified: new Date().toISOString(), origin: "bundled" });
    createSkill(undefined, { id: PERSONA_ID, title: "研究员人设", role: RESEARCHER_ROLE, enabled: true, content: "研究员的人设正文", lastModified: new Date().toISOString(), origin: "persona" });
  });

  afterEach(() => {
    for (const id of [BUNDLED_DEV_ID, BUNDLED_LEAD_ID, DECOY_ID, PERSONA_ID]) {
      try { deleteSkill(undefined, id); } catch { /* 已删或不存在,忽略 */ }
    }
    if (root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } }
  });

  it("按模板前缀 + 角色后缀精确匹配 bundled 技能;同名多角色的副本合并成一条,roles 收拢全部角色", () => {
    root = setupBundleRoot(TPL_ID);
    const tpl = companyToTemplate(root, "bc1");
    const bundled = tpl.bundledSkills ?? [];
    const onboarding = bundled.filter((b) => b.name === "入职指南");
    expect(onboarding.length).toBe(1); // dev/lead 两份同内容的副本 → 合并成一条
    expect([...(onboarding[0].roles ?? [])].sort()).toEqual(["dev", "lead"]);
    expect(onboarding[0].content).toBe("入职指南正文");
    expect(onboarding[0].description).toBe("给 dev 的入职资料");
    // 不应包含别的模板同角色的打包技能(前缀不匹配)
    expect(bundled.some((b) => b.name === "别的模板的入职指南")).toBe(false);
  });

  it("persona(sk-{role})精确匹配:角色人设技能被收进 bundledSkills", () => {
    root = setupBundleRoot(TPL_ID);
    const tpl = companyToTemplate(root, "bc1");
    const persona = (tpl.bundledSkills ?? []).find((b) => b.name === "研究员人设");
    expect(persona).toBeTruthy();
    expect(persona!.content).toBe("研究员的人设正文");
    expect(persona!.roles).toEqual([RESEARCHER_ROLE]);
  });

  it("公司没有 manifestTemplateId 时跳过 bundled 匹配(防止用纯角色后缀误拉别的模板/公司的打包技能);persona 不受影响照常匹配", () => {
    root = setupBundleRoot(undefined);
    const tpl = companyToTemplate(root, "bc1");
    const bundled = tpl.bundledSkills ?? [];
    expect(bundled.some((b) => b.name === "入职指南")).toBe(false);
    expect(bundled.some((b) => b.name === "别的模板的入职指南")).toBe(false);
    expect(bundled.some((b) => b.name === "研究员人设")).toBe(true);
  });

  it("team 孵化模式:ceo/lead 等通用 role 的人设按 sk-{role}-{manifestTemplateId} 命名(裸 sk-{role} 查不到),仍需能导出;且不误拉同 role 下别的模板安装的人设", () => {
    root = setupBundleRoot(TPL_ID);
    const teamPersonaId = `sk-ceo-${TPL_ID}`;
    const decoyPersonaId = `sk-ceo-${OTHER_TPL_ID}`;
    createSkill(undefined, { id: teamPersonaId, title: "CEO人设(team孵化)", role: "ceo", enabled: true, content: "team 孵化产出的 CEO 人设正文", lastModified: new Date().toISOString(), origin: "persona" });
    createSkill(undefined, { id: decoyPersonaId, title: "别的公司的CEO人设", role: "ceo", enabled: true, content: "不该被拉进来", lastModified: new Date().toISOString(), origin: "persona" });
    try {
      const tpl = companyToTemplate(root, "bc1");
      const bundled = tpl.bundledSkills ?? [];
      const ceoPersona = bundled.find((b) => b.name === "CEO人设(team孵化)");
      expect(ceoPersona).toBeTruthy();
      expect(ceoPersona!.content).toBe("team 孵化产出的 CEO 人设正文");
      expect(ceoPersona!.roles).toEqual(["ceo"]);
      expect(bundled.some((b) => b.name === "别的公司的CEO人设")).toBe(false);
    } finally {
      deleteSkill(undefined, teamPersonaId);
      deleteSkill(undefined, decoyPersonaId);
    }
  });
});

describe("C3 · collectDefaultTasks / companyToTemplate.defaultTasks(真数据源:runs 索引里成功完结的 run)", () => {
  let root: string;
  beforeEach(() => { root = setupRoot(); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  function seedRunIndex(entries: Record<string, unknown>) {
    fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "runs", "_index.json"), JSON.stringify(entries));
  }

  it("只取本公司成功(done/accepted)且未降级的 run,goal 去重,按 startedAt 最近取 ≤3 条", () => {
    seedRunIndex({
      r1: { id: "r1", goal: "写一份 A 报告", status: "done", startedAt: "2026-07-05T00:00:00Z", companyId: "c1" },
      r2: { id: "r2", goal: "写一份 B 报告", status: "accepted", startedAt: "2026-07-04T00:00:00Z", companyId: "c1" },
      r3: { id: "r3", goal: "失败的任务", status: "failed", startedAt: "2026-07-03T12:00:00Z", companyId: "c1" },
      r4: { id: "r4", goal: "降级的任务", status: "done", degraded: true, startedAt: "2026-07-03T00:00:00Z", companyId: "c1" },
      r5: { id: "r5", goal: "别家公司的任务", status: "done", startedAt: "2026-07-02T12:00:00Z", companyId: "c2" },
      r6: { id: "r6", goal: "写一份 A 报告", status: "done", startedAt: "2026-07-02T00:00:00Z", companyId: "c1" }, // 重复 goal,去重
      r7: { id: "r7", goal: "写一份 C 报告", status: "done", startedAt: "2026-07-01T00:00:00Z", companyId: "c1" },
      r8: { id: "r8", goal: "写一份 D 报告", status: "done", startedAt: "2026-06-30T00:00:00Z", companyId: "c1" }, // 第 4 条,被截断
    });
    const tasks = collectDefaultTasks(root, "c1");
    expect(tasks.map(t => t.goal)).toEqual(["写一份 A 报告", "写一份 B 报告", "写一份 C 报告"]);
    expect(tasks.every(t => t.title.length > 0 && t.title.length <= 60)).toBe(true);
    // 导出侧:字段真出现在模板上
    const tpl = companyToTemplate(root, "c1");
    expect(tpl.defaultTasks?.length).toBe(3);
  });

  it("无 run 历史 / 无成功 run → 不产出该字段(best-effort,不阻断导出、不虚构)", () => {
    expect(collectDefaultTasks(root, "c1")).toEqual([]);
    expect(companyToTemplate(root, "c1").defaultTasks).toBeUndefined();
    seedRunIndex({ r1: { id: "r1", goal: "还在跑", status: "running", startedAt: "2026-07-05T00:00:00Z", companyId: "c1" } });
    expect(companyToTemplate(root, "c1").defaultTasks).toBeUndefined();
  });
});
describe("agent memory import atomicity", () => {
  it("does not write any file when batch preflight has an unmapped agent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-atomic-"));
    const result = importAgentMemoriesDetailed(root, { "agent-a": "local-a" }, [
      { agent_id: "agent-a", role: "dev", content: "valid memory" },
      { agent_id: "agent-missing", role: "test", content: "missing mapping" },
    ]);

    expect(result.written).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(fs.existsSync(path.join(root, ".opc", "knowledge", "agents", "local-a-memory.md"))).toBe(false);
    expect(() => importAgentMemories(root, { "agent-a": "local-a" }, [
      { agent_id: "agent-a", role: "dev", content: "valid memory" },
      { agent_id: "agent-missing", role: "test", content: "missing mapping" },
    ])).toThrow(/agent memory import failed/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
