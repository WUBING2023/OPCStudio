// MUP B5 · /api/events SSE 行为契约(首字节及时性/心跳/close 清理)
// + MUP B7 · eventRoutes run-scoped GET 404 收口(判据与 runRoutes.runExists 同源)。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as http from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// eventRoutes 经 runRoutes(runExists 同源判据)传递依赖 orchestrator/benchmark/contextBuilder——
// 全部 mock 成纯内存实现,与 runRoutes.test.ts 同一做法,避免模块级副作用/重依赖。
vi.mock("../runtime/orchestrator.js", () => ({
  startRun: vi.fn(async () => ({ runId: "mock-run" })),
  getRunChannels: () => ({}),
  getRunMessages: () => [],
  requestRunChannel: () => ({ error: "not implemented" }),
  decideRunChannel: () => ({ error: "not implemented" }),
  openRunChannel: () => ({ error: "not implemented" }),
  requestStopRun: () => false,
  getAgents: () => [],
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

// eventBus 包一层 vi.fn 但保留真实行为(listeners Set 照常增删):
// 用调用配对断言"连接关闭后每个 subscribe 都被 unsubscribe(listener 归零)"。
vi.mock("../runtime/eventBus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime/eventBus.js")>();
  return { ...actual, subscribe: vi.fn(actual.subscribe), unsubscribe: vi.fn(actual.unsubscribe) };
});

import { register } from "./eventRoutes.js";
import { subscribe, unsubscribe, emit } from "../runtime/eventBus.js";

let root: string;
let server: Server | undefined;
let baseUrl = "";
const openReqs: http.ClientRequest[] = [];

async function startServer(opts?: { heartbeatMs?: number }) {
  const app = express();
  register(app, root, opts);
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const addr = server!.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}

// 原生 http 客户端连 SSE:首个 chunk 到达即 resolve(不等任何业务事件)。
function openSse(): Promise<{ req: http.ClientRequest; res: http.IncomingMessage; first: string; elapsedMs: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(`${baseUrl}/api/events`, (res) => {
      res.setEncoding("utf-8");
      res.once("data", (chunk: string) => resolve({ req, res, first: chunk, elapsedMs: Date.now() - t0 }));
    });
    openReqs.push(req);
    req.on("error", () => { /* destroy 后的 ECONNRESET 属预期 */ });
  });
}

function writeTask(runId: string) {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: runId, goal: "t", status: "done", startedAt: "2026-07-12T00:00:00.000Z" }), "utf-8");
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sse-routes-"));
  fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
});

afterEach(async () => {
  for (const req of openReqs) req.destroy();
  openReqs.length = 0;
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("MUP B5 · GET /api/events SSE", () => {
  it("空闲服务器(零业务事件)首字节 <500ms 到达:200 + text/event-stream + connected 注释", async () => {
    await startServer();
    const { res, first, elapsedMs } = await openSse();
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(first).toContain(": connected");
    expect(elapsedMs).toBeLessThan(500);
  });

  it("心跳以 SSE 注释行周期发出(注入短心跳),绝不伪装成 data: 业务事件", async () => {
    await startServer({ heartbeatMs: 20 });
    const { res, first } = await openSse();
    let buf = first;
    await new Promise<void>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`2s 内未观测到 2 次心跳,已收: ${JSON.stringify(buf)}`)), 2000);
      res.on("data", (c: string) => {
        buf += c;
        if ((buf.match(/: hb/g) ?? []).length >= 2) { clearTimeout(to); resolve(); }
      });
    });
    expect(buf).not.toContain("data:");
  });

  it("emit 的业务事件以 data: 行广播到已连接客户端", async () => {
    await startServer();
    const { res } = await openSse();
    const line = await new Promise<string>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("2s 内未收到 data: 行")), 2000);
      let buf = "";
      res.on("data", (c: string) => {
        buf += c;
        const m = buf.match(/^data: (.*)$/m);
        if (m) { clearTimeout(to); resolve(m[1]); }
      });
      emit("info", "agent-1", { kind: "sse_test_probe" });
    });
    const ev = JSON.parse(line) as { type: string; agentId?: string; payload: { kind?: string } };
    expect(ev.type).toBe("info");
    expect(ev.agentId).toBe("agent-1");
    expect(ev.payload.kind).toBe("sse_test_probe");
  });

  it("客户端断开后 listener 归零:每个 subscribe 的 fn 都被 unsubscribe", async () => {
    await startServer();
    const { req } = await openSse();
    expect(subscribe).toHaveBeenCalledTimes(1);
    const fn = vi.mocked(subscribe).mock.calls[0][0];
    req.destroy();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledWith(fn));
    // 每个 subscribe 过的 fn 都被 unsubscribe(close 事件可能触发多次,unsubscribe 是幂等 Set.delete)。
    for (const [subscribed] of vi.mocked(subscribe).mock.calls) {
      expect(vi.mocked(unsubscribe).mock.calls.some(([g]) => g === subscribed)).toBe(true);
    }
  });
});

describe("MUP B7 · eventRoutes run-scoped GET 404 收口", () => {
  const MISSING_RUN = "run-does-not-exist-404";
  const RUN_ID = "run-sse-b7-test";

  it.each(["events", "trace"])("GET /api/runs/<missing>/%s → 404 {error:'run not found'}", async (suffix) => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/runs/${MISSING_RUN}/${suffix}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "run not found" });
  });

  it.each(["events", "trace"])("GET /api/runs/<非法id>/%s → 400(先于 404)", async (suffix) => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/runs/bad/${suffix}`);
    expect(res.status).toBe(400);
  });

  it("run 存在但 events.jsonl 缺失 → /events 200 空数组(loadHistory 依赖,不许扩大 404)", async () => {
    await startServer();
    writeTask(RUN_ID);
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/events`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: RUN_ID, events: [] });
  });

  it("run 存在但零事件 → /trace 200 空摘要(存在性与 runExists 同源,不再以'有无事件'判存在)", async () => {
    await startServer();
    writeTask(RUN_ID);
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/trace`);
    expect(res.status).toBe(200);
    const body = await res.json() as { runId: string; totalEvents: number };
    expect(body.runId).toBe(RUN_ID);
    expect(body.totalEvents).toBe(0);
  });

  it("id=latest 且磁盘无任何 run → /events 200 {runId:null}(既有语义保留)", async () => {
    await startServer();
    const res = await fetch(`${baseUrl}/api/runs/latest/events`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ runId: null, events: [] });
  });
});
