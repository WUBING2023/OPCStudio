import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { register } from "./archiveRoutes.js";
// 刻意用**真实** orchestrator(不 mock):本测试的核心就是验证"归档后 orchestrator 内存里的 agents
// 不会经 mergeSaveAgents 把归档员工写回 agents.json(复活)"。initOrchestrator 指向 mkdtemp 临时根,
// 全程不触碰真实 .opc(orchestrator 单例 projectRoot 即该临时根)。
import { initOrchestrator, getAgents, updateAgent } from "../runtime/orchestrator.js";
import { configureDispatchCoordinator, resetDispatchCoordinator } from "../runtime/runMutex.js";
import { loadAgents } from "../storage/projectStore.js";
import { loadCompanies } from "../storage/companyStore.js";

let root: string;
let server: Server | undefined;
let baseUrl = "";

function writeRun(runId: string, status: string, companyId?: string): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
    id: runId, userGoal: `goal ${runId}`, status,
    startedAt: "2026-07-01T00:00:00.000Z", participatingAgents: [],
    ...(companyId ? { companyId } : {}),
  }), "utf-8");
}

async function startTestServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  register(app, root);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-routes-"));
  fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
    { id: "default", name: "默认公司", createdAt: "2026-01-01" },
    { id: "c1", name: "归档目标公司", createdAt: "2026-01-02", ceoId: "c1-ceo" },
  ]), "utf-8");
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    { id: "ceo-1", name: "老板", role: "ceo", companyId: "default", provider: "deepseek", model: "x", framework: "hermes", childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
    { id: "c1-ceo", name: "甲CEO", role: "ceo", companyId: "c1", provider: "deepseek", model: "x", framework: "hermes", childrenIds: ["c1-dev"], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
    { id: "c1-dev", name: "甲开发", role: "dev", companyId: "c1", parentId: "c1-ceo", provider: "deepseek", model: "x", framework: "hermes", childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
  ]), "utf-8");
  initOrchestrator(root); // 单例指向临时根:后续 mergeSaveAgents/removeAgentsByCompany 全部落在这里
  resetDispatchCoordinator();
  await startTestServer();
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  resetDispatchCoordinator();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /api/archive/company/:id", () => {
  it("归档成功:文件移动 + 状态同步,响应带 archiveId/计数", async () => {
    writeRun("run-c1-000000000001", "done", "c1");
    const res = await fetch(`${baseUrl}/api/archive/company/c1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.archived).toBe(true);
    expect(body.agentCount).toBe(2);
    expect(body.runCount).toBe(1);
    expect(loadCompanies(root).map((c) => c.id)).toEqual(["default"]);
    expect(fs.existsSync(path.join(root, ".opc", "archive", body.archiveId, "company-c1", "runs", "run-c1-000000000001"))).toBe(true);
    expect(fs.existsSync(path.join(root, ".opc", "runs", "run-c1-000000000001"))).toBe(false);
  });

  it("【复活回归】归档后触发一次 agent 保存(updateAgent→mergeSaveAgents),归档员工绝不回到 agents.json", async () => {
    const res = await fetch(`${baseUrl}/api/archive/company/c1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);

    // orchestrator 内存也已同步剔除
    expect(getAgents().map((a) => a.id)).toEqual(["ceo-1"]);

    // 触发一次真实的 agent 保存路径:updateAgent 会 Object.assign + mergeSaveAgents(全量内存数组)
    updateAgent("ceo-1", { lastAction: "归档后的一次普通存盘" });

    const onDisk = loadAgents(root, []).map((a) => a.id);
    expect(onDisk).toEqual(["ceo-1"]); // c1-ceo / c1-dev 没有复活
  });

  it("有在飞派发(isDispatchInFlight)时 409 人话拒绝,什么都不动", async () => {
    configureDispatchCoordinator({ start: () => {}, isInFlight: () => true });
    const res = await fetch(`${baseUrl}/api/archive/company/c1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("任务正在进行");
    expect(loadCompanies(root).map((c) => c.id)).toContain("c1");
    expect(loadAgents(root, []).map((a) => a.id)).toContain("c1-dev");
  });

  it("公司自身有 running run 时 409(store 层状态闸)", async () => {
    writeRun("run-c1-000000000009", "running", "c1");
    const res = await fetch(`${baseUrl}/api/archive/company/c1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(409);
  });

  it("不存在的公司 404;默认公司 409", async () => {
    const notFound = await fetch(`${baseUrl}/api/archive/company/nope`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(notFound.status).toBe(404);
    const def = await fetch(`${baseUrl}/api/archive/company/default`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(def.status).toBe(409);
  });
});

describe("POST /api/archive/runs", () => {
  it("按 runIds 归档,索引同步;缺 runIds → 400;含 running run → 409", async () => {
    writeRun("run-a-000000000001", "done", "default");
    writeRun("run-b-000000000002", "running", "default");

    const ok = await fetch(`${baseUrl}/api/archive/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds: ["run-a-000000000001"] }),
    });
    const okBody = await ok.json();
    expect(ok.status).toBe(200);
    expect(okBody.runCount).toBe(1);
    expect(fs.existsSync(path.join(root, ".opc", "runs", "run-a-000000000001"))).toBe(false);

    const bad = await fetch(`${baseUrl}/api/archive/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    const live = await fetch(`${baseUrl}/api/archive/runs`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runIds: ["run-b-000000000002"] }),
    });
    expect(live.status).toBe(409);
    expect(fs.existsSync(path.join(root, ".opc", "runs", "run-b-000000000002"))).toBe(true);
  });
});

describe("POST /api/archive/:archiveId/restore 与 GET /api/archive", () => {
  it("公司归档→列表→恢复:磁盘与 orchestrator 内存都回来,重复恢复 409", async () => {
    writeRun("run-c1-000000000001", "done", "c1");
    const arch = await fetch(`${baseUrl}/api/archive/company/c1`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const { archiveId } = await arch.json();
    expect(getAgents().some((a) => a.id === "c1-dev")).toBe(false);

    const list = await fetch(`${baseUrl}/api/archive`);
    const items = await list.json();
    expect(list.status).toBe(200);
    expect(items.some((i: { archiveId: string; kind: string }) => i.archiveId === archiveId && i.kind === "company")).toBe(true);

    const restore = await fetch(`${baseUrl}/api/archive/${encodeURIComponent(archiveId)}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const restoreBody = await restore.json();
    expect(restore.status).toBe(200);
    expect(restoreBody.restored).toBe(true);
    expect(loadCompanies(root).map((c) => c.id).sort()).toEqual(["c1", "default"]);
    expect(loadAgents(root, []).map((a) => a.id).sort()).toEqual(["c1-ceo", "c1-dev", "ceo-1"]);
    expect(getAgents().some((a) => a.id === "c1-dev")).toBe(true); // 内存对称恢复
    expect(fs.existsSync(path.join(root, ".opc", "runs", "run-c1-000000000001"))).toBe(true);

    const again = await fetch(`${baseUrl}/api/archive/${encodeURIComponent(archiveId)}/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(again.status).toBe(409);
  });

  it("不存在的归档 restore → 404", async () => {
    const res = await fetch(`${baseUrl}/api/archive/no-such/restore`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });
});
