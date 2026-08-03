import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { mockStartRun, mockRequestStopRun } = vi.hoisted(() => ({
  mockStartRun: vi.fn(),
  mockRequestStopRun: vi.fn(() => false),
}));

vi.mock("../runtime/orchestrator.js", () => ({
  startRun: mockStartRun,
  getAgents: () => [],
  getRunChannels: () => ({}),
  getRunMessages: () => [],
  requestRunChannel: () => ({ error: "not implemented" }),
  decideRunChannel: () => ({ error: "not implemented" }),
  openRunChannel: () => ({ error: "not implemented" }),
  requestStopRun: mockRequestStopRun,
}));

vi.mock("../runtime/benchmark.js", () => ({
  runBenchmark: vi.fn(),
  runBenchmarkComparison: vi.fn(),
  benchmarkComparisonTable: vi.fn(),
}));

vi.mock("../runtime/contextBuilder.js", () => ({
  setInjectionEnabled: vi.fn(),
  isInjectionEnabled: () => false,
}));

vi.mock("../runtime/modelGateway.js", () => ({
  callModel: vi.fn(),
}));

vi.mock("../runtime/systemModel.js", () => ({
  resolveSystemModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  inferSystemFramework: () => "hermes",
  resolveAutoSubscription: async (choice: unknown) => ({ kind: "keep", choice, reason: "has-key" }),
}));

vi.mock("../runtime/capabilityReport.js", () => ({
  buildCapabilityReport: vi.fn(async () => ({ canRun: true, blockedBy: [] })),
}));

import { register as registerChatRoutes } from "./chatRoutes.js";
import { register as registerRunRoutes } from "./runRoutes.js";
import { configureDispatchCoordinator, resetDispatchCoordinator } from "../runtime/runMutex.js";

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  return root;
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, root);
  registerRunRoutes(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("POST /api/chat/task durable run lifecycle", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    mockStartRun.mockReset();
    mockRequestStopRun.mockReset();
    mockRequestStopRun.mockReturnValue(false);
    resetDispatchCoordinator(); // P1-5:清掉派发协调器注入态,避免"撞忙入队"测试污染后续用例的单 run 探针
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  it("precreates task.json before returning runId", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise(() => undefined));
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "create a small widget", runType: "quick" }),
    });
    const body = await res.json() as { runId: string };

    expect(res.status).toBe(200);
    const taskRes = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(body.runId)}`);
    expect(taskRes.status).toBe(200);
    const task = await taskRes.json() as { status: string; id: string; userGoal: string };
    expect(task).toMatchObject({ id: body.runId, status: "running", userGoal: "create a small widget" });
  });

  it("marks the precreated task failed when background startRun rejects early", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error("boom before worker setup")), 0)));
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "create a small widget", runType: "quick" }),
    });
    const body = await res.json() as { runId: string };
    await new Promise(resolve => setTimeout(resolve, 20));

    const taskRes = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(body.runId)}`);
    const task = await taskRes.json() as { status: string; degraded: boolean; degradedReason: string };
    expect(taskRes.status).toBe(200);
    expect(task.status).toBe("failed");
    expect(task.degraded).toBe(true);
    expect(task.degradedReason).toContain("boom before worker setup");
  });

  it("enqueues the chat task instead of burning it when a run is already in flight", async () => {
    root = setupRoot();
    const started: string[] = [];
    // 模拟"已有活 run":协调器探针恒真 → chatRoutes 应入队而非直接起跑(旧行为会撞单 run 闸标 failed)。
    configureDispatchCoordinator({ isInFlight: () => true, start: (i) => started.push(i.runId) });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "queue me while busy", runType: "quick" }),
    });
    const body = await res.json() as { runId: string; queued?: boolean; queuePosition?: number };

    expect(res.status).toBe(200);
    expect(body.queued).toBe(true);
    expect(body.queuePosition).toBe(1);
    expect(started).toHaveLength(0);         // 撞忙:入队,未起跑
    expect(mockStartRun).not.toHaveBeenCalled(); // 不走本地 startRun 直接起跑路径

    // 预建占位落 pending(不是 running),任务列表能看到"排队中"的 run
    const taskRes = await fetch(`${baseUrl}/api/runs/${encodeURIComponent(body.runId)}`);
    const task = await taskRes.json() as { status: string };
    expect(task.status).toBe("pending");
  });

  it("replays the same durable run for a repeated idempotency key", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise(() => undefined));
    ({ server, baseUrl } = await startServer(root));
    const request = () => fetch(`${baseUrl}/api/chat/task`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "cli-task-001" },
      body: JSON.stringify({ message: "create one idempotent widget", runType: "quick" }),
    });

    const first = await request();
    const firstBody = await first.json() as { runId: string };
    const second = await request();
    const secondBody = await second.json() as { runId: string };

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondBody).toEqual(firstBody);
    expect(mockStartRun).toHaveBeenCalledTimes(1);
    const runDirectories = fs.readdirSync(path.join(root, ".opc", "runs"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(runDirectories).toEqual([firstBody.runId]);
  });

  it("rejects reuse of an idempotency key with different task input", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise(() => undefined));
    ({ server, baseUrl } = await startServer(root));
    const headers = { "content-type": "application/json", "idempotency-key": "cli-task-conflict" };
    const first = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST", headers, body: JSON.stringify({ message: "task A", runType: "quick" }),
    });
    const second = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST", headers, body: JSON.stringify({ message: "task B", runType: "quick" }),
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: "idempotency_conflict" });
    expect(mockStartRun).toHaveBeenCalledTimes(1);
  });

  it("persists idempotency replay across a server restart", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise(() => undefined));
    ({ server, baseUrl } = await startServer(root));
    const options = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "cli-task-restart" },
      body: JSON.stringify({ message: "survive server restart", runType: "quick" }),
    };
    const first = await fetch(`${baseUrl}/api/chat/task`, options);
    const firstBody = await first.json() as { runId: string };
    await new Promise(resolve => server?.close(resolve));
    server = undefined;
    ({ server, baseUrl } = await startServer(root));

    const replay = await fetch(`${baseUrl}/api/chat/task`, options);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstBody);
    expect(mockStartRun).toHaveBeenCalledTimes(1);
  });

  it("deduplicates repeated stop requests", async () => {
    root = setupRoot();
    mockRequestStopRun.mockReturnValue(true);
    ({ server, baseUrl } = await startServer(root));
    const request = () => fetch(`${baseUrl}/api/runs/run-stop-0001/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "cli-stop-001" },
      body: JSON.stringify({ reason: "user requested" }),
    });

    const first = await request();
    const firstBody = await first.json();
    const second = await request();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstBody);
    expect(mockRequestStopRun).toHaveBeenCalledTimes(1);
  });
});
