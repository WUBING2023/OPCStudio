import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Skill, EngineAvailability } from "@opc/shared";
import { buildSection3, buildCapabilityReport, type CapabilityReportDeps } from "./capabilityReport.js";
import { createSkill, deleteSkill } from "../storage/skillStore.js";

// ── 能力闸门吃订阅平替(用户实测阻断修复):provider 无 key 时按"本机有无对应订阅"三态裁决 ──
// 全 hermetic:注入 probeEngine(不 spawn CLI)+ hasProviderKey(不碰全局 registry / 本机 key 文件)。
function fakeProbe(avail: Record<string, Partial<EngineAvailability>>): CapabilityReportDeps["probeEngine"] {
  return async (framework: string): Promise<EngineAvailability> => ({
    framework: framework as EngineAvailability["framework"],
    installed: false, loggedIn: false, version: "", detail: "",
    ...(avail[framework] ?? {}),
  });
}
function writeCompanyWithAgent(root: string, agent: Record<string, unknown>) {
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
    { id: "c1", name: "队", description: "", createdAt: "2026-01-01" },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    { id: "a1", name: "工程师", role: "dev", companyId: "c1", model: "m", childrenIds: [], ...agent },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
}

describe("能力闸门 · provider 无 key → 订阅平替三态", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("① 有 key:canRun=true,provider 进 ready,无 substituted", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-key-"));
    writeCompanyWithAgent(root, { framework: "hermes", provider: "deepseek" });
    const r = await buildCapabilityReport(root, "c1", {
      probeEngine: fakeProbe({ hermes: { installed: true, loggedIn: true } }),
      hasProviderKey: (p) => p === "deepseek",
    });
    expect(r.canRun).toBe(true);
    expect(r.ready.some(i => i.kind === "provider" && i.name === "deepseek")).toBe(true);
    expect(r.substituted).toEqual([]);
    expect(r.suggestedTeam[0].readyToRun).toBe(true);
  });

  it("② 无 key 但全局订阅已安装并登录:canRun=true,记入 substituted(标注 anthropic→claude-code),不 blockedBy", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-sub-"));
    writeCompanyWithAgent(root, { framework: "hermes", provider: "anthropic" });
    const r = await buildCapabilityReport(root, "c1", {
      probeEngine: fakeProbe({ hermes: { installed: true, loggedIn: true }, "claude-code": { installed: true, loggedIn: true } }),
      hasProviderKey: () => false,
    });
    expect(r.canRun).toBe(true);
    expect(r.substituted).toHaveLength(1);
    expect(r.substituted[0].via).toBe("claude-code");
    expect(r.substituted[0].item.name).toBe("anthropic");
    expect(r.substituted[0].note).toContain("anthropic");
    expect(r.substituted[0].note).toContain("claude-code");
    expect(r.blockedBy.some(b => b.includes("anthropic"))).toBe(false);
    expect(r.needsAuth.some(n => n.item.kind === "provider" && n.item.name === "anthropic")).toBe(false);
    expect(r.suggestedTeam[0].readyToRun).toBe(true);
  });

  it("③ 无 key 也无订阅:canRun=false,blockedBy 含该 provider(且提到订阅),无 substituted", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-none-"));
    writeCompanyWithAgent(root, { framework: "hermes", provider: "anthropic" });
    const r = await buildCapabilityReport(root, "c1", {
      probeEngine: fakeProbe({ hermes: { installed: true, loggedIn: true }, "claude-code": { installed: false } }),
      hasProviderKey: () => false,
    });
    expect(r.canRun).toBe(false);
    expect(r.substituted).toEqual([]);
    expect(r.blockedBy.some(b => b.includes("anthropic"))).toBe(true);
    expect(r.blockedBy.some(b => b.includes("claude-code"))).toBe(true);
    expect(r.needsAuth.some(n => n.required && n.item.kind === "provider" && n.item.name === "anthropic")).toBe(true);
    expect(r.suggestedTeam[0].readyToRun).toBe(false);
    expect(r.suggestedTeam[0].blockedReason).toContain("anthropic");
  });

  it("引擎(订阅框架)未登录:canRun=false + 人话可操作 blockedBy(去订阅板块登录 / 改 API 模式)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-eng-"));
    writeCompanyWithAgent(root, { framework: "claude-code", provider: "anthropic" });
    const r = await buildCapabilityReport(root, "c1", {
      probeEngine: fakeProbe({ "claude-code": { installed: true, loggedIn: false, detail: "claude 未登录" } }),
      hasProviderKey: () => false, // claude-code 是订阅框架,provider 维度被跳过,不影响
    });
    expect(r.canRun).toBe(false);
    expect(r.substituted).toEqual([]);
    const engBlock = r.blockedBy.find(b => b.includes("claude-code"));
    expect(engBlock).toBeTruthy();
    expect(engBlock).toContain("未登录");
    expect(engBlock).toContain("API 模式");
  });
});

// Stage 5 核心反陷阱:第③段「本团队不适用」只来自 manifest 作者标注,空则 authorAnnotated=false,绝无计算回退。
describe("Stage 5 · buildSection3(纯函数,只读 manifest)", () => {
  it("riskNotes → notApplicable(source=manifest-riskNote)", () => {
    const r = buildSection3(["不适合实时数据", "不做代码生成"], undefined);
    expect(r.authorAnnotated).toBe(true);
    expect(r.notApplicable).toEqual([
      { note: "不适合实时数据", source: "manifest-riskNote" },
      { note: "不做代码生成", source: "manifest-riskNote" },
    ]);
  });

  it("useCases → 以正例反衬(source=manifest-useCase)", () => {
    const r = buildSection3(undefined, ["学术调研"]);
    expect(r.authorAnnotated).toBe(true);
    expect(r.notApplicable[0].source).toBe("manifest-useCase");
    expect(r.notApplicable[0].note).toContain("学术调研");
  });

  it("undefined / 空数组 / 全空白 → authorAnnotated=false,无任何条目(不计算回退)", () => {
    expect(buildSection3(undefined, undefined)).toEqual({ notApplicable: [], authorAnnotated: false });
    expect(buildSection3([], [])).toEqual({ notApplicable: [], authorAnnotated: false });
    expect(buildSection3(["  ", ""], undefined)).toEqual({ notApplicable: [], authorAnnotated: false });
  });
});

describe("Stage 5 · buildCapabilityReport 错误处理 + canRun 硬拦", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("公司不存在 → 抛错(交路由转 404)", async () => {
    await expect(buildCapabilityReport(process.cwd(), "no-such-company")).rejects.toThrow(/company not found/);
  });

  it("agent 用未注册 provider → canRun=false + blockedBy 含该 provider + manifestRiskNotes 进第③段", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "测试队", description: "", createdAt: "2026-01-01", manifestRiskNotes: ["不适合实时数据"] },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "a1", name: "工程师", role: "dev", companyId: "c1", framework: "hermes", provider: "ghost-xyz-provider", model: "m", childrenIds: [] },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    const r = await buildCapabilityReport(root, "c1");
    expect(r.canRun).toBe(false); // ghost provider 未注册 → required needsAuth → 硬拦
    expect(r.blockedBy.some(b => b.includes("ghost-xyz-provider"))).toBe(true);
    expect(r.suggestedTeam[0].readyToRun).toBe(false);
    // 第③段只读 manifest 作者标注
    expect(r.authorAnnotated).toBe(true);
    expect(r.notApplicable[0]).toEqual({ note: "不适合实时数据", source: "manifest-riskNote" });
  });
});

// 展示层防线:origin:"memory" 的技能不是用户资产,不该出现在能力报告里。
// C 层(skillEvolution.ts,曾经把成功任务沉淀成 workflow-<role>-<goal> 技能)已经整条砍掉,不再
// 产生新的 origin:memory 技能——这条测试现在是纯防御性的(用户手动创建/导入一个 origin:memory 的
// 技能,或未来又有别的路径写出这个 origin,展示层依然要正确过滤),不再是"过滤自动生成噪音"的核心防线。
describe("Stage 5 · buildCapabilityReport 过滤 origin:memory 技能(防御性:展示层不泄漏非用户资产)", () => {
  let root: string;
  const role = `caprep-skill-filter-test-role-${randomUUID().slice(0, 8)}`;
  const memorySkillId = randomUUID();
  const userSkillId = randomUUID();
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    try { deleteSkill(undefined, memorySkillId); } catch { /* */ }
    try { deleteSkill(undefined, userSkillId); } catch { /* */ }
  });

  it("origin:memory 的技能不进 ready 列表;origin:user 的正常展示", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-skill-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "测试队", description: "", createdAt: "2026-01-01" },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "a1", name: "工程师", role, companyId: "c1", framework: "hermes", provider: "ghost-xyz-provider", model: "m", childrenIds: [] },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));

    const memorySkill: Skill = {
      id: memorySkillId, title: `workflow-${role}-写一个-python-函数`, role, enabled: true,
      lastModified: new Date().toISOString(), content: "适用场景：写一个 python 函数\n\n推荐步骤：...", origin: "memory",
    };
    const userSkill: Skill = {
      id: userSkillId, title: "我精心整理的排序技巧", role, enabled: true,
      lastModified: new Date().toISOString(), content: "手写的排序技巧笔记", origin: "user",
    };
    createSkill(undefined, memorySkill);
    createSkill(undefined, userSkill);

    const r = await buildCapabilityReport(root, "c1");
    const skillNames = r.ready.filter(item => item.kind === "skill").map(item => item.name);
    expect(skillNames).not.toContain(memorySkill.title);
    expect(skillNames).toContain(userSkill.title);
  });
});

describe("P0 · capability report 按 teamMode 生效引擎判可用性(与执行同口径)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("teamMode 缺省(旧行为):dev(api/anthropic)+ anthropic 有 key → canRun=true", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tm-none-"));
    writeCompanyWithAgent(root, { framework: "api", provider: "anthropic" });
    const r = await buildCapabilityReport(root, "c1", { hasProviderKey: (p) => p === "anthropic" });
    expect(r.canRun).toBe(true);
  });

  it("teamMode=economy → dev 生效引擎覆盖为 deepseek(api),deepseek 无 key → canRun=false + blockedBy 缺 deepseek key(收口 no_account 假报可运行)", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cap-tm-eco-"));
    writeCompanyWithAgent(root, { framework: "api", provider: "anthropic" }); // 静态是 anthropic,但 economy 会 override 成 deepseek
    const r = await buildCapabilityReport(root, "c1", { hasProviderKey: (p) => p === "anthropic" }, { teamMode: "economy" });
    expect(r.canRun).toBe(false);
    expect(r.blockedBy.some((b) => /deepseek/.test(b))).toBe(true);
    expect(r.suggestedTeam[0].provider).toBe("deepseek"); // 报告如实反映生效 provider
    expect(r.suggestedTeam[0].readyToRun).toBe(false);
  });
});
