import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";
import { templateToBundle } from "@opc/shared";

// companyRoutes.ts 在模块顶层 import 了 runtime/orchestrator.js 的 addAgents 等——那几个函数操作的是
// orchestrator 模块级、跨全项目共享的单例状态(initOrchestrator 设的 projectRoot),不吃调用方传的
// projectRoot 参数。真去调用会写到本机真实项目的 .opc/agents.json(orchestrator.test.ts 正因为这个
// "真盘/进程级初始化"的副作用被显式排除出 vitest 套件,只留作手动 smoke)。这里 mock 掉,让
// restoreCompanyFromBackup 单测只触碰它自己接收的 tmp projectRoot,不碰真实项目数据。
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => []),
  updateAgent: vi.fn(),
  removeAgentsByCompany: vi.fn(() => 0),
  removeAgentsByIds: vi.fn((ids: string[]) => ids.length),
  addAgents: vi.fn((nodes: unknown[]) => nodes.length),
}));

vi.mock("../runtime/providerRegistry.js", () => ({
  syncProvidersFromStore: vi.fn(),
}));
vi.mock("../runtime/modelGateway.js", () => ({
  callModel: vi.fn(),
  createAnthropicProvider: vi.fn(),
}));
vi.mock("../runtime/engines/probes.js", () => ({
  probeClaudeCodeAsync: vi.fn(),
  probeCodexAsync: vi.fn(),
}));
vi.mock("../runtime/engines/apiKeyAccount.js", () => ({
  resolveApiKeyOverride: vi.fn(),
}));
vi.mock("../storage/providerStore.js", () => ({
  loadAccounts: vi.fn(() => []),
}));

import { backupCompanyBeforeDelete, listCompanyBackups, restoreCompanyFromBackup, installCompanyTemplate, runConnectivityTest, findCompanyOwnedSkillIds, register } from "./companyRoutes.js";
import { agentMemoryPath } from "../storage/mdMemory.js";
import { loadCompanies } from "../storage/companyStore.js";
import { loadInstallTransactions, getInstallTransaction } from "../storage/installTransactionStore.js";
import { loadRegistry, addConclusionSummary } from "../storage/registryStore.js";
import { bundledSkillId } from "../runtime/install.js";
import { signTemplate } from "../runtime/templateTrust.js";
import { getSkill, createSkill, deleteSkill } from "../storage/skillStore.js";
import { getAgents, addAgents } from "../runtime/orchestrator.js";
import { callModel, createAnthropicProvider } from "../runtime/modelGateway.js";
import { probeClaudeCodeAsync, probeCodexAsync } from "../runtime/engines/probes.js";
import { resolveApiKeyOverride } from "../runtime/engines/apiKeyAccount.js";
import { loadSemanticFidelityReports } from "../storage/semanticFidelityStore.js";
import { listGovernedMemoryProposals } from "../runtime/memoryGovernance.js";

// 技能库重定向到临时区,避免安装测试往真实用户目录 ~/.opcstudio/skills 写 bundled-* 残留(污染+flaky 土壤)。
let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-comp-"));
  vi.stubEnv("OPC_SKILLS_DIR", skillsTmp);
});
afterAll(() => {
  vi.unstubAllEnvs();
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-backup-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
    { id: "c1", name: "备份测试公司", description: "", ceoId: "b-ceo", createdAt: "2026-01-01" },
    { id: "c-empty", name: "空壳公司(无 agent)", description: "", createdAt: "2026-01-01" },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    { id: "b-ceo", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "x", childrenIds: ["b-dev"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
    { id: "b-dev", role: "dev", companyId: "c1", parentId: "b-ceo", framework: "hermes", provider: "deepseek", model: "x", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle" },
  ]));
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
  return root;
}

describe("companyRoutes - company-owned Skill cleanup", () => {
  let root: string;
  const createdSkillIds = ["owned-explicit", "other-explicit", "legacy-unique", "legacy-shared", "user-playbook"];

  beforeEach(() => {
    root = setupRoot();
    vi.mocked(getAgents).mockReturnValue([
      { id: "c1-unique", name: "Unique", role: "unique-role", companyId: "c1" },
      { id: "c1-shared", name: "Shared A", role: "shared-role", companyId: "c1" },
      { id: "c2-shared", name: "Shared B", role: "shared-role", companyId: "c2" },
    ] as AgentNodeConfig[]);
    createSkill(root, { id: "owned-explicit", title: "Owned", role: "dev", enabled: true, lastModified: "2026-01-01T00:00:00.000Z", content: "owned", origin: "bundled", companyId: "c1" });
    createSkill(root, { id: "other-explicit", title: "Other", role: "dev", enabled: true, lastModified: "2026-01-01T00:00:00.000Z", content: "other", origin: "bundled", companyId: "c2" });
    createSkill(root, { id: "legacy-unique", title: "Unique persona", role: "unique-role", enabled: true, lastModified: "2026-01-01T00:00:00.000Z", content: "persona", origin: "persona" });
    createSkill(root, { id: "legacy-shared", title: "Shared persona", role: "shared-role", enabled: true, lastModified: "2026-01-01T00:00:00.000Z", content: "persona", origin: "persona" });
    createSkill(root, { id: "user-playbook", title: "User", role: "unique-role", enabled: true, lastModified: "2026-01-01T00:00:00.000Z", content: "user", origin: "user" });
  });

  afterEach(() => {
    for (const id of createdSkillIds) deleteSkill(root, id);
    vi.mocked(getAgents).mockReturnValue([]);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("selects explicit company assets and unambiguous legacy personas only", () => {
    expect(findCompanyOwnedSkillIds(root, "c1").sort()).toEqual(["legacy-unique", "owned-explicit"]);
  });

  it("does not select assets when the company does not exist", () => {
    expect(findCompanyOwnedSkillIds(root, "missing")).toEqual([]);
  });
});
describe("companyRoutes · 删除自动备份", () => {
  let root: string;
  beforeEach(() => { root = setupRoot(); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("正常公司:备份文件写入 .opc/company-backups,内容是完整 CompanyTemplate 快照", () => {
    const filename = backupCompanyBeforeDelete(root, "c1");
    expect(filename).toBeTruthy();
    expect(filename).toMatch(/^c1-.*\.json$/);
    const filepath = path.join(root, ".opc", "company-backups", filename!);
    expect(fs.existsSync(filepath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(filepath, "utf-8"));
    expect(saved.title).toBe("备份测试公司");
    expect(saved.agents.length).toBe(2);
  });

  it("timestamp 用 ISO 去掉冒号,文件名不含非法字符", () => {
    const filename = backupCompanyBeforeDelete(root, "c1")!;
    expect(filename).not.toContain(":");
  });

  it("公司没有 agent 导致 companyToTemplate 抛错 → 备份失败但不抛出,返回 undefined", () => {
    expect(() => backupCompanyBeforeDelete(root, "c-empty")).not.toThrow();
    const filename = backupCompanyBeforeDelete(root, "c-empty");
    expect(filename).toBeUndefined();
    // 且没有留下任何备份文件
    const dir = path.join(root, ".opc", "company-backups");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    expect(files.length).toBe(0);
  });

  it("不存在的公司同样只是静默失败,不抛出", () => {
    expect(() => backupCompanyBeforeDelete(root, "nope")).not.toThrow();
    expect(backupCompanyBeforeDelete(root, "nope")).toBeUndefined();
  });
});

describe("companyRoutes · 列出备份", () => {
  let root: string;
  beforeEach(() => { root = setupRoot(); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("没有备份目录时返回空数组", () => {
    expect(listCompanyBackups(root)).toEqual([]);
  });

  it("列出摘要:文件名/公司名/agent 数量/原公司 id/备份时间", () => {
    backupCompanyBeforeDelete(root, "c1");
    const list = listCompanyBackups(root);
    expect(list.length).toBe(1);
    expect(list[0].companyTitle).toBe("备份测试公司");
    expect(list[0].agentCount).toBe(2);
    expect(list[0].originalCompanyId).toBe("c1");
    expect(typeof list[0].backedUpAt).toBe("string");
  });

  it("损坏的备份文件仍被列出(标注解析失败),不影响其余条目", () => {
    const dir = path.join(root, ".opc", "company-backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "broken.json"), "{ not valid json");
    backupCompanyBeforeDelete(root, "c1");
    const list = listCompanyBackups(root);
    expect(list.length).toBe(2);
    const broken = list.find((b) => b.filename === "broken.json")!;
    expect(broken.companyTitle).toBe("(解析失败)");
    expect(broken.agentCount).toBe(0);
  });

  it("按备份时间倒序排列(最新的在前)", () => {
    const dir = path.join(root, ".opc", "company-backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "old.json"), JSON.stringify({ title: "旧的", agents: [] }));
    fs.utimesSync(path.join(dir, "old.json"), new Date("2020-01-01"), new Date("2020-01-01"));
    fs.writeFileSync(path.join(dir, "new.json"), JSON.stringify({ title: "新的", agents: [] }));
    fs.utimesSync(path.join(dir, "new.json"), new Date("2030-01-01"), new Date("2030-01-01"));
    const list = listCompanyBackups(root);
    expect(list[0].filename).toBe("new.json");
    expect(list[1].filename).toBe("old.json");
  });
});

describe("companyRoutes · 从备份恢复", () => {
  let root: string;
  const TPL_ID = "xz-cr-restore-test-tpl";
  // C1:bundled skill id 掺 companyId(每次恢复/安装是随机新公司 id),按 r.companyId 现算。
  const skillIdFor = (companyId: string) => bundledSkillId(TPL_ID, "onboarding-guide", "dev", companyId);

  const validTemplate: CompanyTemplate = {
    id: TPL_ID,
    title: "还原测试公司",
    description: "单测用",
    author: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    downloads: 0,
    stars: 0,
    readme: "",
    agents: [
      {
        id: "ceo-1", name: "CEO", role: "ceo", childrenIds: ["dev-1"], model: "x", provider: "deepseek",
        status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
      },
      {
        id: "dev-1", name: "Dev", role: "dev", parentId: "ceo-1", childrenIds: [], model: "x", provider: "deepseek",
        status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
      },
    ],
    bundledSkills: [{ name: "onboarding-guide", content: "打包技能正文", roles: ["dev"] }],
    a2aChannels: [{ from: "ceo", to: "dev", purpose: "日常同步" }],
  };

  function writeBackup(root: string, filename: string, content: unknown): void {
    const dir = path.join(root, ".opc", "company-backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), typeof content === "string" ? content : JSON.stringify(content), "utf-8");
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-restore-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => {
    // 动态 companyId → 不逐一清理具名 skill;skillsTmp(OPC_SKILLS_DIR)整目录在 afterAll 清除。
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("非法文件名(路径穿越/非 .json)→ 400", () => {
    expect(restoreCompanyFromBackup(root, "../evil.json")).toEqual({ ok: false, status: 400, error: "非法文件名" });
    expect(restoreCompanyFromBackup(root, "notjson.txt")).toEqual({ ok: false, status: 400, error: "非法文件名" });
  });

  it("备份文件不存在 → 404", () => {
    const r = restoreCompanyFromBackup(root, "missing.json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(404);
  });

  it("备份不是合法 JSON → 400", () => {
    writeBackup(root, "bad.json", "{ not valid");
    const r = restoreCompanyFromBackup(root, "bad.json");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.error).toContain("JSON"); }
  });

  it("JSON 合法但不符合 CompanyTemplateSchema → 400", () => {
    writeBackup(root, "invalid-schema.json", { foo: "bar" });
    const r = restoreCompanyFromBackup(root, "invalid-schema.json");
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(400); expect(r.error).toContain("schema"); }
  });

  it("合法备份 → 恢复成一个新公司(不覆盖原公司),reroot agent 树、bundledSkills 落盘、a2aChannels 换算成 presetChannels", () => {
    writeBackup(root, "good.json", validTemplate);
    const r = restoreCompanyFromBackup(root, "good.json");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.agentCount).toBe(2);
    expect(r.ceoId).toBeTruthy();
    expect(r.bundledSkillsInstalled).toBe(1);
    expect(r.presetChannelsInstalled).toBe(1);
    expect(r.semanticFidelity).toMatchObject({ operation: "restore", lostCount: 0, ok: true });
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(r.semanticFidelity?.reportHash);

    // 是"新建"语义:companies.json 里多了一条新公司,新 id ≠ 备份里的模板 id。
    const companies = loadCompanies(root);
    expect(companies.length).toBe(1);
    expect(companies[0].id).not.toBe(TPL_ID);
    expect(companies[0].name).toBe("还原测试公司(恢复)");
    expect(companies[0].presetChannels?.length).toBe(1);
    expect(companies[0].ceoId).toBe(r.ceoId);

    // bundledSkills 真落进了技能库,内容一致。
    const skill = getSkill(undefined, skillIdFor(r.companyId));
    expect(skill).toBeTruthy();
    expect(skill!.content.trim()).toBe("打包技能正文");
  });

  it("restore:员工记忆映射丢失时持久化报告并回滚新公司", () => {
    writeBackup(root, "semantic-loss.json", {
      ...validTemplate,
      agentMemories: [{ agent_id: "missing-agent", role: "dev", content: "portable lesson" }],
    });
    const r = restoreCompanyFromBackup(root, "semantic-loss.json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(500);
    expect(r.semanticFidelity).toMatchObject({ operation: "restore", ok: false, lostCount: 1 });
    expect(r.semanticFidelity?.lost).toEqual(["agentMemories.importFailure[0]"]);
    expect(loadCompanies(root)).toEqual([]);
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(r.semanticFidelity?.reportHash);
  });

  it("同一份备份可以恢复出多个独立的新公司(每次都是新建,互不影响)", () => {
    writeBackup(root, "good.json", validTemplate);
    const r1 = restoreCompanyFromBackup(root, "good.json");
    const r2 = restoreCompanyFromBackup(root, "good.json");
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.companyId).not.toBe(r2.companyId);
    expect(loadCompanies(root).length).toBe(2);
  });

  it("installCompanyTemplate(不传 nameSuffix)——直接导入 JSON 文件用的裸落地,公司名不带「(恢复)」后缀", () => {
    const r = installCompanyTemplate(root, validTemplate);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const companies = loadCompanies(root);
    expect(companies[0].name).toBe("还原测试公司"); // 无后缀,区别于 restoreCompanyFromBackup 的「(恢复)」
  });
});

describe("companyRoutes · 能力报告「测试连接」(runConnectivityTest)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-conntest-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    vi.mocked(getAgents).mockReset();
    vi.mocked(callModel).mockReset();
    vi.mocked(probeClaudeCodeAsync).mockReset();
    vi.mocked(probeCodexAsync).mockReset();
    vi.mocked(resolveApiKeyOverride).mockReset();
    vi.mocked(createAnthropicProvider).mockReset();
  });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  const hermesAgent = {
    id: "a1", name: "小明", role: "dev", companyId: "co1", framework: "hermes",
    provider: "deepseek", model: "deepseek-chat", childrenIds: [], enabled: true,
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true,
  } as any;
  const cliAgent = {
    id: "a2", name: "小红", role: "ceo", companyId: "co1", framework: "claude-code",
    provider: "anthropic", model: "sonnet", childrenIds: [], enabled: true,
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true,
  } as any;
  const codexAgent = {
    id: "a5", name: "小刚", role: "dev", companyId: "co1", framework: "codex",
    provider: "openai", model: "gpt-5-codex", childrenIds: [], enabled: true,
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true,
  } as any;

  it("没有 agent 的公司 → 空数组", async () => {
    vi.mocked(getAgents).mockReturnValue([]);
    const results = await runConnectivityTest(root, "co1");
    expect(results).toEqual([]);
  });

  it("只统计目标公司里 enabled 的 agent(过滤别的公司/软删除的)", async () => {
    vi.mocked(getAgents).mockReturnValue([
      hermesAgent,
      { ...hermesAgent, id: "a3", companyId: "other-co" },
      { ...hermesAgent, id: "a4", enabled: false },
    ]);
    vi.mocked(callModel).mockResolvedValue({ content: "ok" } as any);
    const results = await runConnectivityTest(root, "co1");
    expect(results.map(r => r.agentId)).toEqual(["a1"]);
  });

  it("hermes/API agent:真调 callModel,成功 → ok:true + 精简回包", async () => {
    vi.mocked(getAgents).mockReturnValue([hermesAgent]);
    vi.mocked(callModel).mockResolvedValue({ content: "ok  " } as any);
    const [r] = await runConnectivityTest(root, "co1");
    expect(r).toMatchObject({ agentId: "a1", name: "小明", role: "dev", provider: "deepseek", model: "deepseek-chat", ok: true, message: "ok" });
    expect(typeof r.latencyMs).toBe("number");
  });

  it("hermes/API agent:callModel 抛错 → ok:false + 错误信息透传", async () => {
    vi.mocked(getAgents).mockReturnValue([hermesAgent]);
    vi.mocked(callModel).mockRejectedValue(new Error("no handler registered"));
    const [r] = await runConnectivityTest(root, "co1");
    expect(r).toMatchObject({ agentId: "a1", ok: false, message: "no handler registered" });
  });

  it("claude-code/codex 订阅制 CLI:测的是登录态(installed && loggedIn),不调 callModel", async () => {
    vi.mocked(getAgents).mockReturnValue([cliAgent]);
    vi.mocked(probeClaudeCodeAsync).mockResolvedValue({ framework: "claude-code", installed: true, loggedIn: true, version: "1.0" } as any);
    const [r] = await runConnectivityTest(root, "co1");
    expect(r).toMatchObject({ agentId: "a2", ok: true });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("claude-code 未登录 → ok:false,报「未登录」类原因而非「没有 apiKey」误报", async () => {
    vi.mocked(getAgents).mockReturnValue([cliAgent]);
    vi.mocked(probeClaudeCodeAsync).mockResolvedValue({ framework: "claude-code", installed: true, loggedIn: false, version: "1.0", detail: "claude 未登录（在终端运行 claude 完成登录）" } as any);
    const [r] = await runConnectivityTest(root, "co1");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("未登录");
  });

  it("codex 订阅制 CLI:测的是登录态(installed && loggedIn),不调 callModel", async () => {
    vi.mocked(getAgents).mockReturnValue([codexAgent]);
    vi.mocked(probeCodexAsync).mockResolvedValue({ framework: "codex", installed: true, loggedIn: true, version: "1.0" } as any);
    const [r] = await runConnectivityTest(root, "co1");
    expect(r).toMatchObject({ agentId: "a5", ok: true });
    expect(callModel).not.toHaveBeenCalled();
  });

  it("codex 未登录 → ok:false,报「未登录」类原因", async () => {
    vi.mocked(getAgents).mockReturnValue([codexAgent]);
    vi.mocked(probeCodexAsync).mockResolvedValue({ framework: "codex", installed: true, loggedIn: false, version: "1.0", detail: "codex 未登录" } as any);
    const [r] = await runConnectivityTest(root, "co1");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("未登录");
  });

  it("hermes/API agent:无 key → callModel 抛 ProviderUnavailableError 类错误,报明确的「缺 API key」原因", async () => {
    vi.mocked(getAgents).mockReturnValue([hermesAgent]);
    vi.mocked(callModel).mockRejectedValue(new Error("Provider unavailable: deepseek — no handler registered — missing API key or unknown provider"));
    const [r] = await runConnectivityTest(root, "co1");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/API key|apikey|missing/i);
  });

  // 根因修复(claude-code 的 API Key 模式与订阅登录是两套互斥的认证门,见 ClaudeCodeEngine.ts):
  // claudeCodeUseApiKey=true 且解析出可用账号时,真实执行走"每次 spawn 注入 ANTHROPIC_API_KEY",
  // 完全不看订阅登录态——连通性测试必须镜像同一条件分支,而不是无脑测 CLI 登录态。
  describe("claude-code · claudeCodeUseApiKey(API Key 模式,不等同于订阅登录判定)", () => {
    const apiKeyAgent = { ...cliAgent, id: "a6", claudeCodeUseApiKey: true };

    it("解析出可用的 Anthropic apiKey 账号 → 真发 prompt 测 Anthropic 连通性,不查 CLI 登录态", async () => {
      vi.mocked(getAgents).mockReturnValue([apiKeyAgent]);
      vi.mocked(resolveApiKeyOverride).mockReturnValue("sk-ant-real-key");
      const handler = vi.fn().mockResolvedValue({ content: "ok" } as any);
      vi.mocked(createAnthropicProvider).mockReturnValue(handler);

      const [r] = await runConnectivityTest(root, "co1");

      expect(createAnthropicProvider).toHaveBeenCalledWith("sk-ant-real-key");
      expect(handler).toHaveBeenCalled();
      expect(probeClaudeCodeAsync).not.toHaveBeenCalled();
      expect(r).toMatchObject({ agentId: "a6", ok: true, message: "ok" });
    });

    it("Anthropic 调用失败 → ok:false + 错误信息透传(不是「未登录」这种不相干的话术)", async () => {
      vi.mocked(getAgents).mockReturnValue([apiKeyAgent]);
      vi.mocked(resolveApiKeyOverride).mockReturnValue("sk-ant-bad-key");
      const handler = vi.fn().mockRejectedValue(new Error("Anthropic 401: invalid x-api-key"));
      vi.mocked(createAnthropicProvider).mockReturnValue(handler);

      const [r] = await runConnectivityTest(root, "co1");
      expect(r.ok).toBe(false);
      expect(r.message).toContain("401");
    });

    it("开了 claudeCodeUseApiKey 但没有可用账号(resolveApiKeyOverride 返回 undefined)→ 退回订阅登录态判定", async () => {
      vi.mocked(getAgents).mockReturnValue([apiKeyAgent]);
      vi.mocked(resolveApiKeyOverride).mockReturnValue(undefined);
      vi.mocked(probeClaudeCodeAsync).mockResolvedValue({ framework: "claude-code", installed: true, loggedIn: true, version: "1.0" } as any);

      const [r] = await runConnectivityTest(root, "co1");
      expect(probeClaudeCodeAsync).toHaveBeenCalled();
      expect(createAnthropicProvider).not.toHaveBeenCalled();
      expect(r.ok).toBe(true);
    });
  });
});

// D1 闭环(对抗验收缺口):/api/companies/import(公司架构表单「导入本地 JSON」)和备份恢复
// 此前只跑 CompanyTemplateSchema.safeParse——组织成环/篡改 hash 的陌生 JSON 从这两个口可以完整
// 落地成活公司,绕过 communityRoutes 已有的 Doctor + Safe Install 安全线。以下按同构口径补齐。
describe("D1 闭环 · companyRoutes 导入/备份恢复统一过 Template Doctor + Safe Install", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  const mkAgent = (over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig => ({
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  } as AgentNodeConfig);

  const mkTpl = (over: Partial<CompanyTemplate> = {}): CompanyTemplate => ({
    id: "tpl-d1-import", title: "导入体检模板", description: "d", author: "test",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "",
    agents: [
      mkAgent({ id: "ceo-1", role: "ceo", childrenIds: ["dev-1"] }),
      mkAgent({ id: "dev-1", parentId: "ceo-1" }),
    ],
    ...over,
  });

  // 组织汇报链成环:ceo-1 → dev-1 → ceo-1(schema 完全合法,只有 Doctor 的 no_cycle_in_org 抓得住)。
  const cyclicTpl = (id: string): CompanyTemplate => mkTpl({
    id,
    agents: [
      mkAgent({ id: "ceo-1", role: "ceo", parentId: "dev-1", childrenIds: ["dev-1"] }),
      mkAgent({ id: "dev-1", parentId: "ceo-1", childrenIds: ["ceo-1"] }),
    ],
  });

  // 高危模板:声明 shell 授权 + 预置 A2A 通道;trustLevel 自封 "official" 但没有 hash 背书——
  // 服务端必须按 verifyAndAssignTrust 重新赋 trust,不吃 JSON 的自我声明(否则自封 official 即可绕过剥离)。
  const dangerTpl = (id: string): CompanyTemplate => mkTpl({
    id,
    trustLevel: "official",
    recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } },
    a2aChannels: [{ from: "ceo", to: "dev", purpose: "sync" }],
  });

  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  function writeBackupFile(filename: string, content: unknown): void {
    const dir = path.join(root, ".opc", "company-backups");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(content), "utf-8");
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-d1-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    vi.mocked(addAgents).mockClear();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("import:组织成环 → 422 + no_cycle_in_org error,不落库、不加 agent", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, cyclicTpl("tpl-cycle"));
    expect(status).toBe(422);
    expect(body.doctor.install_allowed).toBe(false);
    expect(body.doctor.checks.find((c: any) => c.id === "no_cycle_in_org")?.status).toBe("error");
    expect(loadCompanies(root)).toEqual([]);
    expect(addAgents).not.toHaveBeenCalled();
  });

  it("import:签名后被篡改(hash 不符)→ 422 + hash_valid error,不落库", async () => {
    const tampered = { ...signTemplate(mkTpl({ id: "tpl-tampered" })), title: "签名后被改" };
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, tampered);
    expect(status).toBe(422);
    expect(body.doctor.checks.find((c: any) => c.id === "hash_valid")?.status).toBe("error");
    expect(loadCompanies(root)).toEqual([]);
    expect(addAgents).not.toHaveBeenCalled();
  });

  it("import:干净模板 → 200,响应带 doctor + safeInstall,公司名带「(导入)」后缀", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, mkTpl());
    expect(status).toBe(200);
    expect(body.companyId).toBeTruthy();
    expect(body.agentCount).toBe(2);
    expect(body.doctor.install_allowed).toBe(true);
    expect(body.safeInstall).toEqual({ applied: false, stripped: [] });
    expect(body.semanticFidelity).toMatchObject({
      schemaVersion: "2", operation: "import", lostCount: 0, ok: true,
    });
    expect(body.semanticFidelity.reportHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
    const companies = loadCompanies(root);
    expect(companies.length).toBe(1);
    expect(companies[0].name).toBe("导入体检模板(导入)");
  });

  it("import:语义字段丢失时持久化报告、409 fail-closed 并回滚新公司", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, mkTpl({
      id: "tpl-semantic-loss",
      agentMemories: [{ agent_id: "missing-agent", role: "dev", content: "portable lesson" }],
    }));
    expect(status).toBe(409);
    expect(body.rolledBack).toBe(true);
    expect(body.semanticFidelity).toMatchObject({ operation: "import", ok: false, lostCount: 1 });
    expect(body.semanticFidelity.lost).toEqual(["agentMemories.importFailure[0]"]);
    expect(loadCompanies(root)).toEqual([]);
    expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
  });

  it("import:非 official 默认 Safe Install——自封 official 的未签名模板照样剥离 shell 授权与预置 A2A 通道", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, dangerTpl("tpl-danger"));
    expect(status).toBe(200);
    expect(body.safeInstall.applied).toBe(true);
    const ids = body.safeInstall.stripped.map((s: any) => s.id);
    expect(ids).toContain("shell-access");
    expect(ids).toContain("preset-a2a-channels");
    expect(body.presetChannelsInstalled).toBe(0); // A2A 自动授权真的没落地
    expect(loadCompanies(root)[0]?.presetChannels ?? []).toEqual([]);
  });

  // 令四.1:客户端布尔 unsafeAcknowledged 已废,显式保留改由「preview 签发的一次性 installConfirmationToken
  // → 真装带回」两步流承载(不带 token 恒走 Safe Install 剥离)。本端点 body 即模板本体,控制字段(mode/
  // installConfirmationToken 等)与模板同层;路由在解析扁平模板前已从候选对象剥离这些控制字段
  // (stripImportControlFields),故 canonical Company Bundle 信封与旧 flat 模板两种形状都能走两步流——
  // 下面一条用 bundle 形状,紧随的一条用 flat 形状做回归(修复前 flat 形状会踩两处缺陷:token 的 UUID 被
  // Template Doctor 密钥正则误判 → 422;preview 的 mode 与真装的 token 进 templateHash → hash 不符 → 409)。
  it("import:两步流带一次性 installConfirmationToken(bundle 形状)→ 显式保留全部授权,不剥离,A2A 通道照常落地", async () => {
    const bundle = templateToBundle(dangerTpl("tpl-danger-ack"), { exportProfile: "full" });
    const pv = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, mode: "preview" });
    expect(pv.status).toBe(200);
    expect(pv.body.installConfirmationToken).toBeTruthy();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, installConfirmationToken: pv.body.installConfirmationToken });
    expect(status).toBe(200);
    expect(body.safeInstall).toEqual({ applied: false, stripped: [] });
    expect(body.presetChannelsInstalled).toBe(1);
  });

  // 回归(令四.1 潜伏缺陷):扁平 CompanyTemplate(无 schema_version、body 即模板本体)直接打 API 走两步流。
  // 修复前会踩两处组合缺陷:① 真装带回的 installConfirmationToken 与模板同层,.passthrough() 收进 parsed.data
  // 后被 Template Doctor 的密钥正则(…|token["']?[:=]["']?[A-Za-z0-9._-]{8,})把 UUID 误判为泄露密钥 → 422;
  // ② preview 请求带的 mode:"preview" 与真装请求带的 token 字段都会进 computeTemplateHash(EXCLUDED 只排除
  // hash/signature/trustLevel)→ 预览签发的危险面 hash 与真装重算的 hash 永不相符 → 409。修复:路由解析前
  // 剥离控制字段。此用例只在两处都修好时才通过(doctor 放行 + 两步流 hash 相符 → 200 且 unsafe 保留)。
  it("import:两步流带一次性 installConfirmationToken(扁平模板形状)→ doctor 不误判 token 为密钥、两步流 hash 相符,授权照常保留", async () => {
    const flatTpl = dangerTpl("tpl-flat-token"); // 扁平 CompanyTemplate,无 schema_version → 走兜底扁平分支
    const pv = await postJson(`${baseUrl}/api/companies/import`, { ...flatTpl, mode: "preview" });
    expect(pv.status).toBe(200);
    expect(pv.body.installConfirmationToken).toBeTruthy();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...flatTpl, installConfirmationToken: pv.body.installConfirmationToken });
    expect(status).toBe(200); // 修复前此处为 422(token 被误判密钥);即便绕过 doctor 也会 409(hash 不符)
    expect(body.safeInstall).toEqual({ applied: false, stripped: [] });
    expect(body.presetChannelsInstalled).toBe(1);
  });

  // 安全回归(P0):本地导入不再凭文件自带 export_profile:"full" 自动免降权——本地导入无法区分"用户
  // 自己的备份"与"陌生人发来的 JSON",文件自封 full 即可绕过 Safe Install 还原任意命令+危险权限。
  // full 免降权只认用户当场知情勾选(unsafeAcknowledged);containsFullProfile 仅作提示信号回给前端。
  it("import:自封 export_profile:full 的 bundle 不带 unsafeAcknowledged → 仍走 Safe Install 剥离(文件字段不再自动豁免)", async () => {
    const fullBundle = templateToBundle(dangerTpl("tpl-full-noack"), { exportProfile: "full" });
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, fullBundle);
    expect(status).toBe(200);
    expect(body.safeInstall.applied).toBe(true);
    const ids = body.safeInstall.stripped.map((s: any) => s.id);
    expect(ids).toContain("shell-access");
    expect(ids).toContain("preset-a2a-channels");
  });

  it("import:full bundle + 带一次性 installConfirmationToken → 完整还原(用户当场知情确认才免降权)", async () => {
    const fullBundle = templateToBundle(dangerTpl("tpl-full-ack"), { exportProfile: "full" });
    const pv = await postJson(`${baseUrl}/api/companies/import`, { ...fullBundle, mode: "preview" });
    expect(pv.body.installConfirmationToken).toBeTruthy();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...fullBundle, installConfirmationToken: pv.body.installConfirmationToken });
    expect(status).toBe(200);
    expect(body.safeInstall).toEqual({ applied: false, stripped: [] });
  });

  it("import preview:full bundle → containsFullProfile=true 提示前端(默认仍降权预演,未 ack)", async () => {
    const fullBundle = templateToBundle(dangerTpl("tpl-full-preview"), { exportProfile: "full" });
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...fullBundle, mode: "preview" });
    expect(status).toBe(200);
    expect(body.containsFullProfile).toBe(true);
    expect(body.safeInstallPreview.length).toBeGreaterThan(0);
  });

  // D8 补丁·验收缺口②:/api/companies/import 是"直接导入本地 JSON 文件"的真实入口(见文件顶部
  // installCompanyTemplate 注释 + CompanyStructureForms.tsx handleImportFile),无 hash 时该判
  // local_import 而不是笼统 untrusted;有 hash 但被篡改仍是 untrusted(localImport 不放宽完整性校验)。
  // preview 模式的响应直接带 trustLevel/hashVerified,借它验证而不重新发明校验路径。
  describe("D8 补丁 · /api/companies/import 本地导入 → trustLevel local_import", () => {
    it("无 hash 的本地导入 → trustLevel=local_import,hashVerified=false", async () => {
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-local-import" }), mode: "preview" });
      expect(status).toBe(200);
      expect(body.trustLevel).toBe("local_import");
      expect(body.hashVerified).toBe(false);
    });

    it("hash 被篡改的本地导入 → 仍是 untrusted,不因是本地导入而放宽完整性校验", async () => {
      const tampered = { ...signTemplate(mkTpl({ id: "tpl-local-tampered" })), title: "签名后被改" };
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...tampered, mode: "preview" });
      expect(status).toBe(200);
      expect(body.trustLevel).toBe("untrusted");
      expect(body.hashVerified).toBe(false);
    });
  });

  it("restore:备份被篡改(hash 不符)→ 默认 422 拒 + doctor,不落库", async () => {
    writeBackupFile("tampered.json", { ...signTemplate(mkTpl({ id: "tpl-bk-tampered" })), title: "被改" });
    const { status, body } = await postJson(`${baseUrl}/api/companies/backups/tampered.json/restore`, {});
    expect(status).toBe(422);
    expect(body.doctor.checks.find((c: any) => c.id === "hash_valid")?.status).toBe("error");
    expect(loadCompanies(root)).toEqual([]);
  });

  it("restore:force:true 灾备逃生门 → 跳过体检强行恢复,响应如实标 forced:true", async () => {
    writeBackupFile("tampered.json", { ...signTemplate(mkTpl({ id: "tpl-bk-tampered" })), title: "被改" });
    const { status, body } = await postJson(`${baseUrl}/api/companies/backups/tampered.json/restore`, { force: true });
    expect(status).toBe(200);
    expect(body.forced).toBe(true);
    expect(body.agentCount).toBe(2);
    expect(loadCompanies(root).length).toBe(1);
  });

  it("restore:体检本来就通过时,即便传了 force 也不标 forced(没有越线就不撒谎)", async () => {
    writeBackupFile("clean.json", mkTpl({ id: "tpl-bk-clean" }));
    const { status, body } = await postJson(`${baseUrl}/api/companies/backups/clean.json/restore`, { force: true });
    expect(status).toBe(200);
    expect(body.forced).toBeUndefined();
    expect(body.doctor.install_allowed).toBe(true);
  });

  it("restore(纯函数):成环备份默认 422 + doctor;force 放行且 forced:true", () => {
    writeBackupFile("cyclic.json", cyclicTpl("tpl-bk-cycle"));
    const denied = restoreCompanyFromBackup(root, "cyclic.json");
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(422);
      expect(denied.doctor?.checks.find((c) => c.id === "no_cycle_in_org")?.status).toBe("error");
    }
    expect(loadCompanies(root)).toEqual([]);

    const forcedR = restoreCompanyFromBackup(root, "cyclic.json", { force: true });
    expect(forcedR.ok).toBe(true);
    if (forcedR.ok) expect(forcedR.forced).toBe(true);
    expect(loadCompanies(root).length).toBe(1);
  });

  // D3(V0 必需)· mode:"new-company"(缺省)|"merge"|"preview" —— 与 communityRoutes.ts install/company
  // 同构,同一份 installMerge.ts 纯函数,这里只覆盖路由接线(mode 分支/参数校验/落盘),细分的五类冲突
  // 策略单测在 installMerge.test.ts 里。
  describe("D3 · /api/companies/import 安装三模式", () => {
    function seedTargetCompany(over: Record<string, unknown> = {}) {
      fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
        { id: "target", name: "目标公司", description: "", ceoId: "ceo-x", createdAt: "2026-01-01T00:00:00Z", ...over },
      ]));
    }
    beforeEach(() => { vi.mocked(getAgents).mockReturnValue([]); });

    it("mode 缺省 = 'new-company':与显式传 mode:'new-company' 行为一致(回归锁)", async () => {
      const r1 = await postJson(`${baseUrl}/api/companies/import`, mkTpl({ id: "tpl-mode-default" }));
      expect(r1.status).toBe(200);
      expect(r1.body.agentCount).toBe(2);
      expect(r1.body.preview).toBeUndefined();
      const r2 = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-mode-explicit" }), mode: "new-company" });
      expect(r2.status).toBe(200);
      expect(r2.body.agentCount).toBe(2);
    });

    it("preview:doctor + 安装预览摘要,不落库(companies.json 前后快照相等)", async () => {
      const before = fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8");
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-preview" }), mode: "preview" });
      expect(status).toBe(200);
      expect(body.preview).toBe(true);
      expect(body.summary.newAgents).toBe(2);
      expect(body.doctor.install_allowed).toBe(true);
      const after = fs.readFileSync(path.join(root, ".opc", "companies.json"), "utf-8");
      expect(after).toBe(before);
      expect(addAgents).not.toHaveBeenCalled();
    });

    it("preview:传 targetCompanyId → 附带合并冲突报告", async () => {
      seedTargetCompany();
      vi.mocked(getAgents).mockReturnValue([mkAgent({ id: "dev-1", companyId: "target" })]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-preview-conflict" }), mode: "preview", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      expect(body.conflicts.agentId).toHaveLength(1);
      expect(body.conflicts.agentId[0].agentId).toBe("dev-1");
    });

    it("merge:缺 targetCompanyId → 400;目标公司不存在 → 404", async () => {
      const missing = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-merge-400" }), mode: "merge" });
      expect(missing.status).toBe(400);
      const notFound = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-merge-404" }), mode: "merge", targetCompanyId: "nope" });
      expect(notFound.status).toBe(404);
    });

    it("merge:成功合并——冲突员工 copy-as-new,presetChannels/mcpRequirements 落进目标公司,响应带 decisions", async () => {
      seedTargetCompany({ presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }] });
      vi.mocked(getAgents).mockReturnValue([
        mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" }),
        mkAgent({ id: "dev-x", companyId: "target", parentId: "ceo-x" }),
        mkAgent({ id: "dev-1", companyId: "target", parentId: "ceo-x" }), // 与模板 dev-1 冲突
      ]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-merge-ok", mcpRequirements: [{ name: "filesystem", optional: false }] }),
        mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      expect(body.companyId).toBe("target");
      expect(body.mergedIntoCompanyId).toBe("target");
      expect(body.semanticFidelity).toMatchObject({ operation: "merge", lostCount: 0, ok: true });
      expect(loadSemanticFidelityReports(root)[0]?.report.reportHash).toBe(body.semanticFidelity.reportHash);
      expect(body.decisions.find((d: any) => d.category === "agent_id").conflictCount).toBe(1);
      const companies = loadCompanies(root);
      expect(companies[0].manifestMcpRequirements).toEqual([{ name: "filesystem", optional: false }]);
      expect(companies[0].presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }]);
    });

    it("merge:doctor 拒绝(组织成环)→ 422,不落地", async () => {
      seedTargetCompany();
      const { status } = await postJson(`${baseUrl}/api/companies/import`, {
        ...cyclicTpl("tpl-merge-doctor-reject"), mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(422);
      expect(addAgents).not.toHaveBeenCalled();
    });

    // ══ 收口② · 公司级四字段保守合并合同(与 communityRoutes install/company merge 同口径)══
    it("merge·收口②:defaultTasks 目标优先 union、toolRequirements 只声明 union、visibilityPolicy 目标优先、workflow 冲突 requires_review;preMerge.companyFields 整值快照", async () => {
      const targetWorkflow = { verificationEdges: [{ producer: "dev", verifier: "ceo", method: "llm-review", onReject: "flag" }] };
      const targetToolReq = { requiredEngines: ["claude-code"], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] };
      seedTargetCompany({
        visibilityPolicy: "isolated",
        defaultTasks: [{ title: "已有", goal: "做 A" }],
        manifestToolRequirements: targetToolReq,
        workflow: targetWorkflow,
      });
      vi.mocked(getAgents).mockReturnValue([mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" })]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({
          id: "tpl-merge-fields",
          visibilityPolicy: "default",
          defaultTasks: [{ title: "重复", goal: " 做 A " }, { title: "新增", goal: "做 B" }],
          toolRequirements: { requiredEngines: ["claude-code", "codex"], requiredProviders: [], requiredMcpServers: ["web-search"], requiredSkills: ["research"], optionalTools: [] },
          workflow: { verificationEdges: [{ producer: "researcher", verifier: "lead", method: "fact-check", onReject: "redo" }] },
        }),
        mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      const target = loadCompanies(root).find((c) => c.id === "target")!;
      expect(target.visibilityPolicy).toBe("isolated"); // 目标策略永远优先,导入不放宽既有隔离
      expect(target.defaultTasks).toEqual([{ title: "已有", goal: "做 A" }, { title: "新增", goal: "做 B" }]); // goal 去重 union,目标在前
      // requiredMcpServers:未 ack 的本地导入走 Safe Install,模板的 MCP 依赖授权声明先被剥离
      // (stripped 如实报告),union 见到的是剥离后的模板 → 仍为空;其余数组稳定 union、目标在前。
      expect(target.manifestToolRequirements).toEqual({
        requiredEngines: ["claude-code", "codex"], requiredProviders: [], requiredMcpServers: [], requiredSkills: ["research"], optionalTools: [],
      });
      expect(body.safeInstall.stripped.some((s: any) => s.id === "mcp-dependency")).toBe(true);
      expect(target.workflow).toEqual(targetWorkflow); // 不静默合并/覆盖,保留目标
      // 四类清单:未采纳的来源字段全部进报告,不静默消失
      expect(body.report.requires_review.some((i: any) => i.field === "workflow")).toBe(true);
      expect(body.report.preserved.some((i: any) => i.field === "visibilityPolicy")).toBe(true);
      expect(body.report.added.some((i: any) => i.field === "defaultTasks")).toBe(true);
      expect(body.report.added.some((i: any) => i.field === "manifestToolRequirements")).toBe(true);
      expect(body.report.requires_local_setup.some((i: any) => i.field === "manifestToolRequirements.requiredEngines")).toBe(true);
      expect(body.report.requires_local_setup.some((i: any) => i.field === "manifestToolRequirements.requiredSkills")).toBe(true);
      // toolRequirements union 只声明:不因导入自动配置/启用任何 MCP(mcp_servers.json 不因 merge 出现)
      expect(fs.existsSync(path.join(root, ".opc", "mcp_servers.json"))).toBe(false);
      // preMerge.companyFields:合并前四字段整值快照(回滚整值恢复的依据)
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.preMerge?.companyFields).toEqual({
        visibilityPolicy: "isolated",
        defaultTasks: [{ title: "已有", goal: "做 A" }],
        manifestToolRequirements: targetToolReq,
        workflow: targetWorkflow,
      });
    });

    it("merge·收口②:agentMemories 只导新建员工;overwrite 覆盖既有员工时保留目标记忆 + requires_review(不静默覆盖)", async () => {
      seedTargetCompany();
      vi.mocked(getAgents).mockReturnValue([
        mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" }),
        mkAgent({ id: "dev-1", companyId: "target", parentId: "ceo-x", name: "旧版 dev" }), // 与模板 dev-1 冲突 → overwrite
      ]);
      // 目标既有员工 dev-1 已有个人记忆——合同禁止被来源静默覆盖
      const devMemPath = agentMemoryPath(root, "dev-1");
      fs.mkdirSync(path.dirname(devMemPath), { recursive: true });
      fs.writeFileSync(devMemPath, "目标员工的既有记忆\n", "utf-8");

      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({
          id: "tpl-merge-agent-mem",
          agentMemories: [
            { agent_id: "ceo-1", role: "ceo", content: "新建员工的记忆" },
            { agent_id: "dev-1", role: "dev", content: "来源想覆盖的记忆" },
          ],
        }),
        mode: "merge", targetCompanyId: "target",
        mergeStrategies: { agentId: "overwrite" }, confirmOverwrite: true,
      });
      expect(status).toBe(200);
      expect(body.agentMemoriesImported).toBe(1); // 只有新建员工 ceo-1 的记忆落盘
      expect(fs.readFileSync(agentMemoryPath(root, "ceo-1"), "utf-8")).toContain("新建员工的记忆");
      expect(fs.readFileSync(devMemPath, "utf-8")).toBe("目标员工的既有记忆\n"); // 目标记忆原样保留
      // 令四.4 后 requires_review 里被覆盖的既有员工 dev-1 可有多条:①合并计划的"overwrite 覆盖:保留目标
      // 员工记忆"复核条目,②importAgentMemories 的"idMap 无映射未写回"逐条失败条目(同一事实双侧记账,均不
      // 静默)。关键语义:全部条目都指向 dev-1(被保留记忆的既有员工),没有任何条目误报新建员工 ceo-1。
      const reviews = body.report.requires_review.filter((i: any) => i.field === "agentMemories");
      expect(reviews.length).toBeGreaterThanOrEqual(1);
      expect(reviews.every((i: any) => i.detail.includes("dev-1"))).toBe(true);
      expect(reviews.some((i: any) => i.detail.includes("ceo-1"))).toBe(false);
      expect(body.report.added.some((i: any) => i.field === "agentMemories")).toBe(true); // 新建员工那份如实计入 added
    });
  });

  // D6(V0 必需)· install transaction——/api/companies/import 与 communityRoutes.ts install/company
  // 落进同一份 .opc/install-transactions.json;深度逻辑(回滚/前置检查/滚动上限)已在
  // installTransactionStore.test.ts + communityRoutes.test.ts 覆盖,这里只验证这条路由确实接上了线。
  describe("D6 · /api/companies/import 落 install transaction", () => {
    function seedTargetCompany(over: Record<string, unknown> = {}) {
      fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
        { id: "target", name: "目标公司", description: "", ceoId: "ceo-x", createdAt: "2026-01-01T00:00:00Z", ...over },
      ]));
    }
    beforeEach(() => { vi.mocked(getAgents).mockReturnValue([]); });

    it("new-company:响应带 txId,transaction 落盘形状正确", async () => {
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, mkTpl({ id: "tpl-tx-new" }));
      expect(status).toBe(200);
      expect(typeof body.txId).toBe("string");
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.mode).toBe("new-company");
      expect(tx?.source).toBe("tpl-tx-new");
      expect(tx?.companyId).toBe(body.companyId);
      expect(tx?.created.agentIds).toHaveLength(2);
      expect(tx?.created.companyIds).toEqual([body.companyId]);
      expect(tx?.conflictDecisions).toEqual([]);
    });

    it("merge:transaction 只记这次新增的 agent,不含目标公司原有员工", async () => {
      seedTargetCompany();
      vi.mocked(getAgents).mockReturnValue([
        mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" }),
        mkAgent({ id: "dev-x", companyId: "target", parentId: "ceo-x" }),
      ]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-tx-merge" }), mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.mode).toBe("merge");
      expect(tx?.companyId).toBe("target");
      expect([...tx!.created.agentIds].sort()).toEqual(["ceo-1", "dev-1"]); // mkTpl 的两个 agent,无冲突原样保留
      expect(tx?.created.companyIds).toEqual([]);
      expect(tx?.conflictDecisions).toEqual(body.decisions);
    });

    // 对抗验收缺口①②:merge 分支现在还要落一份 preMerge 快照(合并前 manifestMcpRequirements 整份值 +
    // 覆盖前的完整员工 + 改写前的边),供 communityRoutes.ts 共用的 rollback 端点真正恢复目标公司原有资产。
    it("merge:transaction 带 preMerge 快照——合并前 manifestMcpRequirements 整份值;无覆盖/无改写时 overwrittenAgents/modifiedChannels 缺省", async () => {
      seedTargetCompany({ manifestMcpRequirements: [{ name: "filesystem", optional: true }] });
      vi.mocked(getAgents).mockReturnValue([
        mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" }),
        mkAgent({ id: "dev-x", companyId: "target", parentId: "ceo-x" }),
      ]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-tx-merge-premerge", mcpRequirements: [{ name: "web-search", optional: false }] }),
        mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.preMerge?.manifestMcpRequirements).toEqual([{ name: "filesystem", optional: true }]); // 合并前的值,不是并集后的
      expect(loadCompanies(root)[0]?.manifestMcpRequirements?.map((m) => m.name).sort()).toEqual(["filesystem", "web-search"]); // 落地的确实是并集
      expect(tx?.preMerge?.overwrittenAgents).toBeUndefined(); // 默认 copy-as-new,没有发生覆盖
      expect(tx?.preMerge?.modifiedChannels).toBeUndefined(); // 没有既有 a2a 边被改写
    });

    it("merge+overwrite:transaction 的 preMerge.overwrittenAgents 携带被覆盖前的完整既有员工对象", async () => {
      seedTargetCompany();
      const existingDev = mkAgent({ id: "dev-1", companyId: "target", parentId: "ceo-x", name: "旧版 dev", model: "old-model" });
      vi.mocked(getAgents).mockReturnValue([mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" }), existingDev]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-tx-merge-overwrite" }), // agents: ceo-1(无冲突), dev-1(与既有 dev-1 冲突)
        mode: "merge", targetCompanyId: "target", mergeStrategies: { agentId: "overwrite" }, confirmOverwrite: true,
      });
      expect(status).toBe(200);
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.preMerge?.overwrittenAgents).toEqual([existingDev]); // 覆盖前的完整对象,不是新值
    });

    it("preview:不产生 transaction", async () => {
      await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-tx-preview" }), mode: "preview" });
      expect(loadInstallTransactions(root)).toEqual([]);
    });

    // #22:计划文档硬规则「transaction 先落、状态后写」——用第一笔可 mock 的状态写(addAgents)做
    // 观测点:它被调用时 transaction 必须已在盘上,崩溃窗口内不会留下无回滚依据的半成品。
    it("#22:merge——addAgents(第一笔状态写)被调用时 transaction 已落盘", async () => {
      seedTargetCompany();
      vi.mocked(getAgents).mockReturnValue([mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" })]);
      let txsAtFirstWrite = -1;
      vi.mocked(addAgents).mockImplementationOnce((nodes: AgentNodeConfig[]) => {
        txsAtFirstWrite = loadInstallTransactions(root).length;
        return nodes.length;
      });
      const { status } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-tx-first-merge" }), mode: "merge", targetCompanyId: "target",
      });
      expect(status).toBe(200);
      expect(txsAtFirstWrite).toBe(1);
    });

    it("#22:new-company——经 onPlanned 在第一笔状态写之前落 transaction(addAgents 时已在盘上)", async () => {
      let txsAtFirstWrite = -1;
      vi.mocked(addAgents).mockImplementationOnce((nodes: AgentNodeConfig[]) => {
        txsAtFirstWrite = loadInstallTransactions(root).length;
        return nodes.length;
      });
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, mkTpl({ id: "tpl-tx-first-new" }));
      expect(status).toBe(200);
      expect(txsAtFirstWrite).toBe(1);
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.companyId).toBe(body.companyId); // 预生成的公司 id 与真实落地一致
      expect(loadCompanies(root).some((c) => c.id === body.companyId)).toBe(true);
    });
  });

  // #26 · D5:本路由注释自称与 install/company「同构」,此前却把 seedMemories 整个丢弃——同一份文件
  // 走两条导入口记忆结局不同且无提示。补齐同一套 memoryImportMode 语义(preview/merge/new-company)。
  describe("#26 · /api/companies/import 导入 seedMemories", () => {
    const NOW = "2026-07-08T00:00:00.000Z";
    const memBase = {
      scope: "s", source: { type: "run", run_id: "r1", task_id: "" }, score: 50, status: "active", tags: [],
      metrics: { cited_count: 1, cited_success_count: 1, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: NOW, updated_at: NOW, last_used_at: NOW,
    };
    const seedMemories = [
      { ...memBase, memory_id: "mem-ps-1", owner_type: "agent", owner_id: "dev", content: "sop 级步骤", level: "sop" },
      { ...memBase, memory_id: "mem-cs-1", owner_type: "company", owner_id: "c1", content: "draft 级要点", level: "draft" },
    ];
    beforeEach(() => { vi.mocked(getAgents).mockReturnValue([]); });

    it("new-company:默认 structure-sop 只导 sop/doctrine 级;响应带 memoryImport;记录 id 挂进 transaction", async () => {
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...mkTpl({ id: "tpl-mem-new" }), seedMemories });
      expect(status).toBe(200);
      expect(body.memoryImport).toMatchObject({ mode: "structure-sop", totalRecords: 2, filteredRecords: 1, imported: 1 });
      expect(listGovernedMemoryProposals(root)).toHaveLength(1);
      expect(listGovernedMemoryProposals(root)[0]?.portableBundleRecord?.memory_id).toBe("mem-ps-1");
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.memory?.governedProposalIds).toHaveLength(1);
    });

    it("merge:同样按 memoryImportMode 导入,响应带 memoryImport", async () => {
      fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
        { id: "target", name: "目标公司", description: "", ceoId: "ceo-x", createdAt: "2026-01-01T00:00:00Z" },
      ]));
      vi.mocked(getAgents).mockReturnValue([mkAgent({ id: "ceo-x", role: "ceo", companyId: "target" })]);
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-mem-merge" }), seedMemories, mode: "merge", targetCompanyId: "target", memoryImportMode: "full",
      });
      expect(status).toBe(200);
      expect(body.memoryImport).toMatchObject({ mode: "full", totalRecords: 2, filteredRecords: 2, imported: 2 });
      expect(listGovernedMemoryProposals(root)).toHaveLength(2);
      const tx = getInstallTransaction(root, body.txId);
      expect(tx?.memory?.governedProposalIds).toHaveLength(2);
    });

    it("preview:带 memoryPreview(mode/totalRecords/filteredRecords),不写任何状态", async () => {
      const { status, body } = await postJson(`${baseUrl}/api/companies/import`, {
        ...mkTpl({ id: "tpl-mem-preview" }), seedMemories, mode: "preview", memoryImportMode: "full",
      });
      expect(status).toBe(200);
      expect(body.memoryPreview).toEqual({ mode: "full", totalRecords: 2, filteredRecords: 2 });
      expect(listGovernedMemoryProposals(root)).toEqual([]); // preview 零副作用
    });
  });
});

// P0-3(canonical)· 活公司导出走 Company Bundle 路径:带 schema_version、按 memoryExportEnabled 开关
// 真实带/不带记忆、结构字段保真、导出物可直接重新导入(canonical round-trip)。
describe("P0-3 · GET /api/companies/:id/export → canonical Company Bundle", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  function seedCompany(memoryExportEnabled?: boolean): void {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      {
        id: "c1", name: "导出公司", description: "desc", ceoId: "ceo-1", createdAt: "2026-01-01T00:00:00Z",
        ...(memoryExportEnabled === undefined ? {} : { memoryExportEnabled }),
        workflow: { verificationEdges: [{ producer: "ceo", verifier: "dev", method: "llm-review", onReject: "redo" }] },
        presetChannels: [{ from: "ceo-1", to: "dev-1", purpose: "同步" }],
      },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-1", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: ["dev-1"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
      { id: "dev-1", name: "Dev", role: "dev", companyId: "c1", parentId: "ceo-1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
    ]));
  }

  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-export-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    vi.mocked(addAgents).mockClear();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("导出物带 schema_version + bundle_type=company;结构字段(workflow/预置通道→a2aChannels)保真", async () => {
    seedCompany();
    const r = await fetch(`${baseUrl}/api/companies/c1/export`);
    expect(r.status).toBe(200);
    const bundle = await r.json();
    expect(typeof bundle.schema_version).toBe("string");
    expect(bundle.schema_version.length).toBeGreaterThan(0);
    expect(bundle.bundle_type).toBe("company");
    expect(bundle.agents).toHaveLength(2);
    expect(bundle.workflow?.verificationEdges).toHaveLength(1);
    expect(bundle.a2aChannels).toHaveLength(1); // presetChannels 换算成 role 级 a2aChannels
    expect(bundle.a2aChannels[0]).toMatchObject({ from: "ceo", to: "dev" });
    expect(bundle.privacy).toBeTruthy();
  });

  // C2 · 导出物带 org 派生投影(teams/edges 真填)+ recommendedConfig(运行配置快照)。
  it("C2:导出物 org.teams/edges 真填且与 agents/a2aChannels/workflow 一致;recommendedConfig 快照运行配置", async () => {
    seedCompany();
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export`)).json();
    expect(bundle.org.teams).toEqual([]); // ceo+dev 无 lead → 无队(字段真填,空数组≠缺省)
    expect(bundle.org.edges).toEqual([
      { from: "ceo-0", to: "dev-1", type: "org" },                       // reroot 后合成 id 的汇报边
      { from: "ceo", to: "dev", type: "a2a", purpose: "同步" },           // presetChannels → role 级 a2a
      { from: "ceo", to: "dev", type: "verification", purpose: "llm-review" },
    ]);
    // config.json 只有 apiKeys → 快照 loadConfig 合并出的 budget 与默认全开 permissions；未显式存在的 defaultModel 不导出。
    expect(bundle.recommendedConfig).toEqual({
      budget: { totalUsd: 0, maxTokensPerTask: 200_000 },
      permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true },
    });
  });

  it("memoryExportEnabled 默认(未设)→ 带上公司记忆(memory.records 非空)", async () => {
    seedCompany();
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["c1 的经验"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export`)).json();
    expect(bundle.memory.records).toHaveLength(1);
    expect(bundle.memory.records[0].content).toBe("c1 的经验");
  });

  it("memoryExportEnabled:false → memory.records 恒空(开关对实际导出路径真实生效)", async () => {
    seedCompany(false);
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["不该导出"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export`)).json();
    expect(bundle.memory.records).toEqual([]);
  });

  it("P0-4 · 导出物全文脱敏:genericCli/workspaceDir/cliConfigDir 剥离,记忆正文密钥与本机路径占位化", async () => {
    seedCompany();
    const agents = JSON.parse(fs.readFileSync(path.join(root, ".opc", "agents.json"), "utf-8"));
    agents[1].workspaceDir = "M:\\privatedir\\ws";
    agents[1].cliConfigDir = "C:\\Users\\me\\.config";
    agents[1].genericCli = { command: "C:\\tools\\mycli.exe" };
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["密钥 sk-test1234567890 存于 M:\\privatedir\\ws"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export`)).json();
    const text = JSON.stringify(bundle);
    expect(text).not.toContain("privatedir");
    expect(text).not.toContain("sk-test");
    expect(text).not.toContain("mycli");
    const dev = bundle.agents.find((a: any) => a.name === "Dev");
    expect(dev?.genericCli).toBeUndefined();
    expect(dev?.workspaceDir).toBeUndefined();
    expect(dev?.cliConfigDir).toBeUndefined();
    expect(bundle.privacy?.redacted).toBe(true);
  });

  it("canonical round-trip:导出的 bundle 直接 POST /api/companies/import 成功落地成新公司", async () => {
    seedCompany();
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["经验一"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export`)).json();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, memoryImportMode: "full" });
    expect(status).toBe(200);
    expect(body.companyId).toBeTruthy();
    expect(loadCompanies(root).some((c) => c.id === body.companyId)).toBe(true);
    // bundle.memory.records 桥接成 seedMemories → full 模式导入为待审治理提案。
    expect(listGovernedMemoryProposals(root).length).toBeGreaterThanOrEqual(1);
  });
});

// P0 Part B · full 导出/导入保真:公司级 visibilityPolicy(①)、原始 manifestToolRequirements 不重推(②)、
// defaultTasks 持久落点(③)三条端到端往返(export?profile=full → import unsafeAcknowledged → re-export)。
describe("P0-B · full 往返保真(visibilityPolicy/toolRequirements/defaultTasks)", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  function seedRichCompany(): void {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      {
        id: "c1", name: "富公司", description: "desc", ceoId: "ceo-1", createdAt: "2026-01-01T00:00:00Z",
        // ① 公司级调度语义
        visibilityPolicy: "isolated",
        // ② 作者手写工具需求(requiredSkills/optionalTools/requiredMcpServers 无法从 agents 反推)
        manifestToolRequirements: { requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: ["filesystem"], requiredSkills: ["research"], optionalTools: ["browser"] },
        // ③ 作者手填示例任务
        defaultTasks: [{ title: "调研任务", goal: "写一份市场调研报告", suggestedRole: "dev" }],
        presetChannels: [{ from: "ceo-1", to: "dev-1", purpose: "同步" }],
      },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-1", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: ["dev-1"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
      { id: "dev-1", name: "Dev", role: "dev", companyId: "c1", parentId: "ceo-1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
    ]));
  }

  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-p0b-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    vi.mocked(addAgents).mockClear();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("导出物携带 visibilityPolicy + 原始 toolRequirements(作者手写项) + defaultTasks", async () => {
    seedRichCompany();
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export?profile=full`)).json();
    expect(bundle.visibilityPolicy).toBe("isolated"); // ①
    expect(bundle.toolRequirements.requiredSkills).toEqual(["research"]); // ② 不被从 agents 重推覆盖
    expect(bundle.toolRequirements.optionalTools).toEqual(["browser"]);
    expect(bundle.toolRequirements.requiredMcpServers).toEqual(["filesystem"]);
    expect(bundle.defaultTasks).toEqual([{ title: "调研任务", goal: "写一份市场调研报告", suggestedRole: "dev" }]); // ③
  });

  it("full 往返:import(两步流带一次性 installConfirmationToken)把 visibilityPolicy/manifestToolRequirements/defaultTasks 落回新公司(持久)", async () => {
    // 注:本套件 mock 掉 addAgents(不真持久化 agent),故"再导出"由 roundTripFidelity.test.ts(真持久化
    // mock)覆盖完整 export→import→re-export;这里只验证 HTTP 导入端点把三项落成公司持久字段。
    // 令四.1:完整还原(不剥离 requiredMcpServers 等授权声明)需先 preview 拿后端签发的一次性 token 再带回真装。
    seedRichCompany();
    const bundle = await (await fetch(`${baseUrl}/api/companies/c1/export?profile=full`)).json();

    const pv = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, mode: "preview" });
    expect(pv.body.installConfirmationToken).toBeTruthy();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, installConfirmationToken: pv.body.installConfirmationToken });
    expect(status).toBe(200);
    const newId = body.companyId;

    // ① + ② + ③ 落回新公司(持久)——导入后再导出仍在的持久前提
    const companyB = loadCompanies(root).find((c) => c.id === newId)!;
    expect(companyB.visibilityPolicy).toBe("isolated"); // ①
    expect(companyB.manifestToolRequirements?.requiredSkills).toEqual(["research"]); // ② 作者手写不丢
    expect(companyB.manifestToolRequirements?.optionalTools).toEqual(["browser"]);
    expect(companyB.manifestToolRequirements?.requiredMcpServers).toEqual(["filesystem"]);
    expect(companyB.defaultTasks).toEqual([{ title: "调研任务", goal: "写一份市场调研报告", suggestedRole: "dev" }]); // ③
  });
});

// 分场景收口 · 导出档位(?profile=full 自己备份保真 / share 社区分享全脱敏,缺省 share)+ 导入侧
// full/share 行为分道(full=等价 unsafeAcknowledged 不降权;share=Safe Install;记忆两档都带走)。
describe("分场景 · /api/companies/:id/export?profile= 与导入侧 full/share 行为", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  const AGENT_MEMORY = "偏好:先写测试再写实现,笔记在 M:\\privatedir\\notes";

  function seedCompany(memoryExportEnabled?: boolean): void {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      {
        id: "c1", name: "分场景公司", description: "desc", ceoId: "ceo-1", createdAt: "2026-01-01T00:00:00Z",
        ...(memoryExportEnabled === undefined ? {} : { memoryExportEnabled }),
        presetChannels: [{ from: "ceo-1", to: "qa-1", purpose: "同步" }],
      },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-1", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: ["qa-1"], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true, growth: { level: 2, xp: 120 } },
      { id: "qa-1", name: "QA", role: "qa", companyId: "c1", parentId: "ceo-1", framework: "generic-cli", provider: "custom", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true, genericCli: { command: "C:\\tools\\mycli.exe", args: ["--check"], authEnvVar: "MYCLI_ENV" }, workspaceDir: "M:\\privatedir\\ws", cliConfigDir: "C:\\Users\\me\\.config" },
    ]));
    // 员工个人记忆(agent-memory.md):导出侧按 reroot 合成 id(qa 是第 2 个 agent → "qa-1")采集。
    const memFile = agentMemoryPath(root, "qa-1");
    fs.mkdirSync(path.dirname(memFile), { recursive: true });
    fs.writeFileSync(memFile, AGENT_MEMORY + "\n", "utf-8");
  }

  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }
  async function exportBundle(profile?: string): Promise<any> {
    const q = profile ? `?profile=${profile}` : "";
    const r = await fetch(`${baseUrl}/api/companies/c1/export${q}`);
    expect(r.status).toBe(200);
    return r.json();
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-profile-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    vi.mocked(addAgents).mockClear();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("?profile=full:声明 export_profile=full;genericCli 原样保留;个人记忆随包(正文本机路径不占位、密钥仍剥)", async () => {
    seedCompany();
    addConclusionSummary(root, { runId: "r1", companyId: "c1", points: ["密钥 sk-test1234567890 存于 M:\\privatedir\\log"], createdAt: "2026-01-02T00:00:00Z" });
    const bundle = await exportBundle("full");
    expect(bundle.export_profile).toBe("full");
    const qa = bundle.agents.find((a: any) => a.name === "QA");
    expect(qa.genericCli).toEqual({ command: "C:\\tools\\mycli.exe", args: ["--check"], authEnvVar: "MYCLI_ENV" });
    // workspaceDir/cliConfigDir 在 reroot 关口清空(导入侧按新机默认重新解析=重映射),不外泄源路径
    expect(qa.workspaceDir).toBeUndefined();
    expect(qa.cliConfigDir).toBeUndefined();
    expect(JSON.stringify(bundle)).not.toContain("privatedir\\\\ws");
    // 个人记忆:full 保真——本机路径保留、密钥形态仍不放行
    expect(bundle.agentMemories).toEqual([{ agent_id: "qa-1", role: "qa", content: AGENT_MEMORY }]);
    expect(bundle.memory.records[0].content).toContain("[REDACTED_SECRET]");
    expect(bundle.memory.records[0].content).toContain("M:\\privatedir\\log");
    // 成长(growth)本就是 agents 的字段,两档都随包
    expect(bundle.agents.find((a: any) => a.name === "CEO").growth).toEqual({ level: 2, xp: 120 });
  });

  it("缺省与非法 profile 都按 share:genericCli 剥离;记忆仍带走但正文全脱敏(拍板:权限降权≠记忆不带)", async () => {
    seedCompany();
    for (const q of [undefined, "hax0r"] as const) {
      const bundle = await exportBundle(q);
      expect(bundle.export_profile).toBe("share");
      const qa = bundle.agents.find((a: any) => a.name === "QA");
      expect(qa.genericCli).toBeUndefined();
      expect(bundle.agentMemories).toHaveLength(1); // share 也带个人记忆
      expect(bundle.agentMemories[0].content).toContain("[REDACTED_PATH]");
      expect(bundle.agentMemories[0].content).not.toContain("privatedir");
      expect(JSON.stringify(bundle)).not.toContain("mycli");
      expect(bundle.agents.find((a: any) => a.name === "CEO").growth).toEqual({ level: 2, xp: 120 }); // 成长两档都带
    }
  });

  it("memoryExportEnabled:false → 两档都不带 agentMemories(公司开关最高优先)", async () => {
    seedCompany(false);
    expect((await exportBundle("full")).agentMemories).toBeUndefined();
    expect((await exportBundle()).agentMemories).toBeUndefined();
  });

  it("full 包导入 + 用户确认(两步流带一次性 installConfirmationToken):完整还原——不降权、a2a 保留、genericCli 原样、个人记忆写回", async () => {
    seedCompany();
    const bundle = await exportBundle("full");
    // full 档完整还原需用户当场知情确认(安全修复后不再凭文件 export_profile 自动免降权);令四.1 后
    // 确认凭据 = preview 签发的一次性 installConfirmationToken(客户端布尔 unsafeAcknowledged 已废)。
    const pv = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, mode: "preview" });
    expect(pv.body.installConfirmationToken).toBeTruthy();
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, installConfirmationToken: pv.body.installConfirmationToken });
    expect(status).toBe(200);
    expect(body.safeInstall).toEqual({ applied: false, stripped: [] }); // 用户确认的完整还原不降权
    expect(body.presetChannelsInstalled).toBe(1);
    const installed = vi.mocked(addAgents).mock.calls.at(-1)![0] as AgentNodeConfig[];
    const newQa = installed.find((a) => a.role === "qa")!;
    expect(newQa.genericCli).toEqual({ command: "C:\\tools\\mycli.exe", args: ["--check"], authEnvVar: "MYCLI_ENV" });
    expect(newQa.workspaceDir).toBeUndefined(); // 占位/清空后按新机默认重映射
    const memFile = agentMemoryPath(root, newQa.id);
    expect(fs.existsSync(memFile)).toBe(true);
    expect(fs.readFileSync(memFile, "utf-8")).toContain("先写测试再写实现");
  });

  // 令四.1 后语义:preview 恒展示 Safe Install 默认(剥离)视图并签发一次性 token;"确认后的完整还原"
  // 不再有 ack 版预览,而是带 token 真装时授权真实保留——预览承诺(默认剥离/确认后可保留)与落地结果一致,
  // 不出现「预览说剥、真装没剥」的反向不一致。
  it("full 包 preview:恒展示 Safe Install 剥离视图 + 签发一次性 token;带 token 真装才完整还原(预览承诺与落地一致)", async () => {
    seedCompany();
    const bundle = await exportBundle("full");
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, mode: "preview" });
    expect(status).toBe(200);
    expect(body.safeInstallPreview.map((s: any) => s.id)).toContain("preset-a2a-channels"); // 默认剥离项如实展示
    expect(body.containsFullProfile).toBe(true); // full 提示信号照常回给前端(供 UI 决定是否弹确认)
    expect(body.installConfirmationToken).toBeTruthy(); // 确认保留的凭据随预览签发
    // 带 token 真装:预览预告的"确认后可保留"真实兑现(不剥离,A2A 落地)。
    const inst = await postJson(`${baseUrl}/api/companies/import`, { ...bundle, installConfirmationToken: body.installConfirmationToken });
    expect(inst.status).toBe(200);
    expect(inst.body.safeInstall).toEqual({ applied: false, stripped: [] });
    expect(inst.body.presetChannelsInstalled).toBe(1);
  });

  it("share 包导入:维持 Safe Install(a2a 预置通道默认剥离),但个人记忆仍写回(记忆两档都带走)", async () => {
    seedCompany();
    const bundle = await exportBundle(); // share 档
    const { status, body } = await postJson(`${baseUrl}/api/companies/import`, bundle);
    expect(status).toBe(200);
    expect(body.safeInstall.applied).toBe(true);
    expect(body.safeInstall.stripped.map((s: any) => s.id)).toContain("preset-a2a-channels");
    expect(body.presetChannelsInstalled).toBe(0);
    const installed = vi.mocked(addAgents).mock.calls.at(-1)![0] as AgentNodeConfig[];
    const newQa = installed.find((a) => a.role === "qa")!;
    expect(newQa.genericCli).toBeUndefined(); // share 档导出时已剥,导入自然没有
    const memFile = agentMemoryPath(root, newQa.id);
    expect(fs.existsSync(memFile)).toBe(true);
    expect(fs.readFileSync(memFile, "utf-8")).toContain("先写测试再写实现"); // 正文已脱敏(路径占位)但记忆本体带到
  });
});

// 收口③ · 工作目录设置 V0:主工作目录端点(POST /:id/folder)全套安全检查 + 非 Git 零隐式初始化 +
// folder 旁路封堵(通用 PATCH/创建入口)+ 导出绝不泄露本机绝对路径。
describe("收口③ · 主工作目录(POST /api/companies/:id/folder)", () => {
  let root: string;
  let ws: string; // 待绑定的用户目录(独立 tmp,便于断言"零改动")
  let server: Server;
  let baseUrl: string;

  async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  }

  function gitInitWithCommit(dir: string): void {
    execSync("git init -q", { cwd: dir, stdio: "pipe" });
    try { execSync("git config user.email t@t && git config user.name t", { cwd: dir, stdio: "pipe" }); } catch { /* global */ }
    fs.writeFileSync(path.join(dir, "app.txt"), "code");
    execSync("git add -A && git commit -q -m init", { cwd: dir, stdio: "pipe" });
  }

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cr-folder-"));
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "cr-folder-ws-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "目录公司", description: "", ceoId: "ceo-1", createdAt: "2026-01-01T00:00:00Z" },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "ceo-1", name: "CEO", role: "ceo", companyId: "c1", framework: "hermes", provider: "deepseek", model: "m", childrenIds: [], tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle", editable: true, deletable: true, enabled: true },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
    vi.mocked(addAgents).mockClear();
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    register(app, root);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* */ }
  });

  it("非法路径逐类 400:相对路径 / 含 .. 段 / 不存在的目录", async () => {
    let r = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: "relative/dir" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("not_absolute");
    r = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: `${ws}${path.sep}..${path.sep}x` });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("traversal");
    r = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: path.join(ws, "no-such-dir") });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("not_found");
    // 全部被拒 → folder 未落库
    expect(loadCompanies(root).find((c) => c.id === "c1")?.folder).toBeUndefined();
  });

  it("非 Git 目录未确认 → 409 needs_init_confirmation,且目录零隐式初始化(无 .git/.gitignore/README)", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: ws });
    expect(status).toBe(409);
    expect(body.code).toBe("needs_init_confirmation");
    expect(body.needsInit).toBe(true);
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".gitignore"))).toBe(false);
    expect(fs.existsSync(path.join(ws, "README.md"))).toBe(false);
    expect(loadCompanies(root).find((c) => c.id === "c1")?.folder).toBeUndefined(); // 未确认不落库
  });

  it("非 Git 目录 + initAsManagedWorkspace=true → 托管初始化并绑定 canonical realPath", async () => {
    const { status, body } = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: ws, initAsManagedWorkspace: true });
    expect(status).toBe(200);
    expect(body.initialized).toBe(true);
    expect(body.company.folder).toBe(fs.realpathSync(ws));
    expect(fs.existsSync(path.join(ws, ".git"))).toBe(true);
    expect(() => execSync("git rev-parse HEAD", { cwd: ws, stdio: "pipe" })).not.toThrow(); // 首 commit 已建
    expect(loadCompanies(root).find((c) => c.id === "c1")?.folder).toBe(fs.realpathSync(ws));
  });

  it("既有 Git 项目直接绑定:200,不写 .gitignore、不产生新 commit(绑定只落库不动目录)", async () => {
    gitInitWithCommit(ws);
    const headBefore = execSync("git rev-parse HEAD", { cwd: ws }).toString().trim();
    const { status, body } = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: ws });
    expect(status).toBe(200);
    expect(body.initialized).toBe(false);
    expect(body.company.folder).toBe(fs.realpathSync(ws));
    expect(fs.existsSync(path.join(ws, ".gitignore"))).toBe(false);
    expect(execSync("git rev-parse HEAD", { cwd: ws }).toString().trim()).toBe(headBefore);
  });

  it("清除绑定:folder 空串 → cleared,公司 folder 移除", async () => {
    gitInitWithCommit(ws);
    await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: ws });
    const { status, body } = await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: "" });
    expect(status).toBe(200);
    expect(body.cleared).toBe(true);
    expect(loadCompanies(root).find((c) => c.id === "c1")?.folder).toBeUndefined();
  });

  it("旁路封堵:通用 PATCH 与创建入口的 folder 一律被忽略(安全检查不可绕过)", async () => {
    const pr = await fetch(`${baseUrl}/api/companies/c1`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: ws, description: "改描述" }),
    });
    expect(pr.status).toBe(200);
    const patched = await pr.json();
    expect(patched.description).toBe("改描述");   // 其余字段照常生效
    expect(patched.folder).toBeUndefined();       // folder 被剥离
    const { status, body } = await postJson(`${baseUrl}/api/companies`, { name: "旁路公司", folder: ws });
    expect(status).toBe(200);
    expect(body.folder).toBeUndefined();
  });

  it("导出绝不泄露本机绝对路径:绑定后 share/full 导出全文都不含工作目录路径,公司段无 folder", async () => {
    gitInitWithCommit(ws);
    await postJson(`${baseUrl}/api/companies/c1/folder`, { folder: ws });
    for (const profile of ["share", "full"]) {
      const r = await fetch(`${baseUrl}/api/companies/c1/export?profile=${profile}`);
      expect(r.status).toBe(200);
      const text = JSON.stringify(await r.json());
      expect(text).not.toContain("cr-folder-ws");            // 目录名唯一 token
      expect(text).not.toContain(JSON.stringify(ws).slice(1, -1)); // 完整转义路径
      expect(text).not.toContain('"folder"');                // 公司段不带 folder 字段
    }
  });
});
