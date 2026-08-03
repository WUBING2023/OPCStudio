import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";

// 令四.6 · clone(reroot 新 id)vs restore(保留原 id + 保真断言)。
// 用一个**有状态**的 orchestrator mock,让 getAgents 真反映 addAgents/remove 的效果,才能验保真。

let agentStore: AgentNodeConfig[] = [];
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => agentStore),
  addAgents: vi.fn((nodes: AgentNodeConfig[]) => {
    let added = 0;
    for (const n of nodes) { if (!agentStore.some((a) => a.id === n.id)) { agentStore.push(n); added++; } }
    return added;
  }),
  removeAgentsByCompany: vi.fn((companyId: string) => {
    const before = agentStore.length;
    agentStore = agentStore.filter((a) => (a.companyId ?? "default") !== companyId);
    return before - agentStore.length;
  }),
  removeAgentsByIds: vi.fn((ids: string[]) => {
    const set = new Set(ids); const before = agentStore.length;
    agentStore = agentStore.filter((a) => !set.has(a.id));
    return before - agentStore.length;
  }),
  updateAgent: vi.fn((id: string, patch: Partial<AgentNodeConfig>) => {
    const a = agentStore.find((x) => x.id === id); if (a) Object.assign(a, patch);
  }),
  restoreAgentsInPlace: vi.fn((snaps: AgentNodeConfig[]) => {
    for (const s of snaps) { const i = agentStore.findIndex((a) => a.id === s.id); if (i >= 0) agentStore[i] = s; }
    return snaps.length;
  }),
}));
vi.mock("../runtime/providerRegistry.js", () => ({ syncProvidersFromStore: vi.fn() }));
vi.mock("../runtime/modelGateway.js", () => ({ callModel: vi.fn(), createAnthropicProvider: vi.fn() }));
vi.mock("../runtime/engines/probes.js", () => ({ probeClaudeCodeAsync: vi.fn(), probeCodexAsync: vi.fn() }));
vi.mock("../runtime/engines/apiKeyAccount.js", () => ({ resolveApiKeyOverride: vi.fn() }));
vi.mock("../storage/providerStore.js", () => ({ loadAccounts: vi.fn(() => []) }));

import { restoreCompanyFromBackup } from "./companyRoutes.js";
import { loadCompanies } from "../storage/companyStore.js";
import { getAgents } from "../runtime/orchestrator.js";

let skillsTmp: string;
beforeAll(() => { skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-cvr-")); vi.stubEnv("OPC_SKILLS_DIR", skillsTmp); });
afterAll(() => { vi.unstubAllEnvs(); try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ } });

const TPL_ID = "local-origco1";
const backupTemplate: CompanyTemplate = {
  id: TPL_ID, title: "灾备公司", description: "restore 测试", author: "local",
  createdAt: "2026-01-01T00:00:00.000Z", tags: [], downloads: 0, stars: 0, readme: "",
  agents: [
    { id: "ceo-0", name: "CEO", role: "ceo", childrenIds: ["dev-1"], model: "x", provider: "deepseek",
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as AgentNodeConfig,
    { id: "dev-1", name: "Dev", role: "dev", parentId: "ceo-0", childrenIds: [], model: "x", provider: "deepseek",
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as AgentNodeConfig,
  ],
  a2aChannels: [{ from: "ceo", to: "dev", purpose: "同步" }],
};

function writeBackup(root: string, filename: string, content: unknown): void {
  const dir = path.join(root, ".opc", "company-backups");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(content), "utf-8");
}

let root: string;
beforeEach(() => {
  agentStore = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cvr-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("令四.6 · restore 保留原 id + 保真", () => {
  it("restore 模式:保留原公司 id 与 agent id/引用,fidelity.ok=true", () => {
    writeBackup(root, "b.json", backupTemplate);
    const r = restoreCompanyFromBackup(root, "b.json", { mode: "restore" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("restore");
    expect(r.companyId).toBe("origco1"); // local- 前缀剥离后的原公司 id
    expect(r.fidelity?.ok).toBe(true);
    // agent id 逐字保留(非 reroot 后缀)
    const ids = getAgents().map((a) => a.id).sort();
    expect(ids).toEqual(["ceo-0", "dev-1"]);
    // 引用保真:dev 的 parentId 仍指向 ceo-0
    expect(getAgents().find((a) => a.id === "dev-1")!.parentId).toBe("ceo-0");
    // 预置通道保真(1 条)
    expect(loadCompanies(root)[0].presetChannels?.length).toBe(1);
  });

  it("restore 冲突:原公司 id 已存在活公司 → 拒绝(不覆盖)", () => {
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([{ id: "origco1", name: "现存", description: "", createdAt: "2026-01-01" }]));
    writeBackup(root, "b.json", backupTemplate);
    const r = restoreCompanyFromBackup(root, "b.json", { mode: "restore" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toContain("已存在活公司");
  });

  it("restore 冲突:agent id 与现存活 agent 撞车 → 拒绝", () => {
    agentStore.push({ id: "ceo-0", name: "别处的", role: "ceo", companyId: "other", childrenIds: [], model: "x", provider: "deepseek", framework: "api", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 } } as unknown as AgentNodeConfig);
    writeBackup(root, "b.json", backupTemplate);
    const r = restoreCompanyFromBackup(root, "b.json", { mode: "restore" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(409);
    expect(r.error).toContain("agent id");
  });

  it("clone 模式(缺省):reroot 新公司 id 与新 agent id,mode=clone", () => {
    writeBackup(root, "b.json", backupTemplate);
    const r = restoreCompanyFromBackup(root, "b.json"); // 缺省 clone
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.mode).toBe("clone");
    expect(r.companyId).not.toBe("origco1"); // 新随机 id
    // agent id 是 reroot 后缀,不是原始 ceo-0/dev-1
    const ids = getAgents().map((a) => a.id);
    expect(ids.some((id) => id === "ceo-0")).toBe(false);
    expect(ids.every((id) => id.includes("-"))).toBe(true);
  });
});
