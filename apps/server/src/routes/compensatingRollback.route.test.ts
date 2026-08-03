import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";

// 令四.5 · 部分安装失败补偿回滚(活体路由)。注入 addAgents 抛错(new-company 落地中途失败):
// installCompanyTemplate 已 addCompany(公司半落地),路由必须补偿删掉半成品,响应带 rolledBack/
// requires_rollback,绝不返回成功形状,且 companies.json 里不残留半装公司。

let agentStore: AgentNodeConfig[] = [];
let addAgentsShouldThrow = false;
let removeAgentsByIdsShouldThrow = false;
let updateAgentShouldThrow = false;
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => agentStore),
  addAgents: vi.fn((nodes: AgentNodeConfig[]) => {
    if (addAgentsShouldThrow) throw new Error("模拟 addAgents 落地中途崩溃");
    let n = 0; for (const a of nodes) if (!agentStore.some((x) => x.id === a.id)) { agentStore.push(a); n++; } return n;
  }),
  updateAgent: vi.fn((id: string, patch: Partial<AgentNodeConfig>) => {
    if (updateAgentShouldThrow) throw new Error("forced merge update failure");
    const index = agentStore.findIndex((agent) => agent.id === id);
    if (index < 0) return undefined;
    agentStore[index] = { ...agentStore[index], ...patch, id };
    return agentStore[index];
  }),
  removeAgentsByCompany: vi.fn((cid: string) => { const b = agentStore.length; agentStore = agentStore.filter((a) => (a.companyId ?? "default") !== cid); return b - agentStore.length; }),
  removeAgentsByIds: vi.fn((ids: string[]) => {
    if (removeAgentsByIdsShouldThrow) throw new Error("模拟补偿删除 agent 失败");
    const s = new Set(ids); const b = agentStore.length; agentStore = agentStore.filter((a) => !s.has(a.id)); return b - agentStore.length;
  }),
  restoreAgentsInPlace: vi.fn((snapshots: AgentNodeConfig[]) => {
    let restored = 0;
    for (const snapshot of snapshots) {
      const index = agentStore.findIndex((agent) => agent.id === snapshot.id);
      if (index < 0) continue;
      agentStore[index] = structuredClone(snapshot);
      restored += 1;
    }
    return restored;
  }),
}));
vi.mock("../runtime/providerRegistry.js", () => ({ syncProvidersFromStore: vi.fn() }));
vi.mock("../runtime/modelGateway.js", () => ({ callModel: vi.fn(), createAnthropicProvider: vi.fn() }));
vi.mock("../runtime/engines/probes.js", () => ({ probeClaudeCodeAsync: vi.fn(), probeCodexAsync: vi.fn() }));
vi.mock("../runtime/engines/apiKeyAccount.js", () => ({ resolveApiKeyOverride: vi.fn() }));
vi.mock("../storage/providerStore.js", () => ({ loadAccounts: vi.fn(() => []) }));

import { compensateInstallTransaction, register } from "./companyRoutes.js";
import { addCompany, loadCompanies } from "../storage/companyStore.js";
import { getInstallTransaction, loadInstallTransactions } from "../storage/installTransactionStore.js";

let skillsTmp: string;
beforeAll(() => { skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-comp-rb-")); vi.stubEnv("OPC_SKILLS_DIR", skillsTmp); });
afterAll(() => { vi.unstubAllEnvs(); try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ } });

function tpl(): CompanyTemplate {
  return { id: "t-rb", title: "回滚模板", description: "d", author: "a", createdAt: "2026-07-01T00:00:00Z",
    tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [
      { id: "ceo-0", name: "CEO", role: "ceo", childrenIds: ["dev-0"], model: "m", provider: "deepseek", framework: "api", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as AgentNodeConfig,
      { id: "dev-0", name: "Dev", role: "dev", parentId: "ceo-0", childrenIds: [], model: "m", provider: "deepseek", framework: "api", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true } as AgentNodeConfig,
    ] };
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express(); app.use(express.json({ limit: "10mb" })); register(app, root);
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address(); const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let root: string, server: Server, baseUrl: string;
beforeEach(async () => {
  agentStore = []; addAgentsShouldThrow = false; removeAgentsByIdsShouldThrow = false; updateAgentShouldThrow = false;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "comp-rb-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));
  ({ server, baseUrl } = await startServer(root));
});
afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("令四.5 · /api/companies/import 部分失败补偿回滚", () => {
  it("addAgents 中途抛错 → 补偿删掉半装公司,响应 rolledBack,不残留公司", async () => {
    addAgentsShouldThrow = true;
    const r = await fetch(`${baseUrl}/api/companies/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tpl()),
    });
    expect(r.status).toBeGreaterThanOrEqual(400); // 绝不返回 2xx 成功
    const body = await r.json() as any;
    expect(body.companyId).toBeUndefined(); // 非成功形状
    expect(body.rolledBack).toBe(true);
    expect(body.txId).toBeTruthy();
    // 半装公司被补偿删除,不残留
    expect(loadCompanies(root).length).toBe(0);
    expect(agentStore.length).toBe(0);
    // 补偿原语和状态复验都成功后才允许标 rolled_back。
    const txs = loadInstallTransactions(root);
    expect(txs.length).toBe(1);
    expect(txs[0].status).toBe("rolled_back");
  });

  it("补偿原语抛错 → 即使其余清理完成也必须 failed + requires_rollback,不能假称 rolled_back", async () => {
    addAgentsShouldThrow = true;
    removeAgentsByIdsShouldThrow = true;
    const r = await fetch(`${baseUrl}/api/companies/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tpl()),
    });
    expect(r.status).toBe(500);
    const body = await r.json() as any;
    expect(body.rolledBack).toBeUndefined();
    expect(body.requires_rollback).toBe(true);
    expect(body.rollbackError).toContain("remove created agents");
    expect(body.rollbackError).toContain("模拟补偿删除 agent 失败");
    expect(loadCompanies(root)).toEqual([]);

    const [tx] = loadInstallTransactions(root);
    expect(tx.status).toBe("failed");
    expect(tx.rolledBack).not.toBe(true);
  });
  it("正常安装(无注入)→ 成功落地,tx completed", async () => {
    const r = await fetch(`${baseUrl}/api/companies/import`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tpl()),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.companyId).toBeTruthy();
    expect(loadCompanies(root).length).toBe(1);
  });
});

describe("Wave 5 release gate: merge and rollback fault injection", () => {
  it("rolls back all merge writes when overwrite fails after new agents land", async () => {
    addCompany(root, { id: "target", name: "Target", ceoId: "ceo-0" });
    const original = {
      ...tpl().agents[0],
      companyId: "target",
      name: "Existing CEO",
      model: "old-model",
      childrenIds: [],
    } as AgentNodeConfig;
    agentStore = [structuredClone(original)];
    updateAgentShouldThrow = true;

    const response = await fetch(`${baseUrl}/api/companies/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...tpl(),
        mode: "merge",
        targetCompanyId: "target",
        mergeStrategies: { agentId: "overwrite" },
        confirmOverwrite: true,
      }),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(500);
    expect(body.rolledBack).toBe(true);
    expect(loadCompanies(root).map((company) => company.id)).toEqual(["target"]);
    expect(agentStore).toEqual([original]);
    expect(getInstallTransaction(root, body.txId)?.status).toBe("rolled_back");
  });

  it("keeps a failed rollback explicit and allows the same transaction to resume", async () => {
    addAgentsShouldThrow = true;
    removeAgentsByIdsShouldThrow = true;
    const response = await fetch(`${baseUrl}/api/companies/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tpl()),
    });
    const body = await response.json() as any;
    expect(response.status).toBe(500);
    expect(body.requires_rollback).toBe(true);
    const failed = getInstallTransaction(root, body.txId);
    expect(failed?.status).toBe("failed");

    removeAgentsByIdsShouldThrow = false;
    const retried = compensateInstallTransaction(root, failed!);
    expect(retried.ok).toBe(true);
    expect(getInstallTransaction(root, body.txId)?.status).toBe("rolled_back");
    expect(loadCompanies(root)).toEqual([]);
    expect(agentStore).toEqual([]);
  });
});
