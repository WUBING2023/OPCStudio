import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// B6 · GET /api/runs/:id/a2a-messages(前端只读面):a2a_messages.jsonl → last-wins 合并的每消息最终态。
// a2aRoutes 的 agent 面依赖 orchestrator(重型)→ mock 掉;读侧走真实 a2aBus.readA2AMessageRecords/
// latestA2ARecords(a2aLifecycle.test.ts 已锁其坏行跳过与 last-wins 语义,此处只验证路由接线)。
vi.mock("../runtime/orchestrator.js", () => ({
  a2aActiveRunId: () => null,
  a2aActiveCompanyId: () => null,
  a2aDiscover: vi.fn(),
  a2aRequestChannel: vi.fn(),
  a2aSend: vi.fn(),
  a2aAsk: vi.fn(),
  a2aInbox: vi.fn(),
  a2aAcknowledge: vi.fn(),
  a2aResolve: vi.fn(),
  a2aInjectUserInstruction: vi.fn(),
}));
vi.mock("../runtime/harness.js", () => ({ enqueueAutomation: vi.fn() }));

import { register } from "./a2aRoutes.js";

let root: string;
let server: Server;
let baseUrl: string;

function record(over: Record<string, unknown>): string {
  return JSON.stringify({
    id: "m-1", runId: "run-a2a-read-0001", from: "lead-1", to: ["worker-1"],
    messageType: "delegate_task", lifecycle: "committed", statusHistory: [],
    text: "任务派单", timestamp: "2026-07-12T00:00:00Z", ...over,
  });
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-read-api-"));
  const runDir = path.join(root, ".opc", "runs", "run-a2a-read-0001");
  fs.mkdirSync(runDir, { recursive: true });
  // 同一消息三条快照(committed→delivered→resolved)+ 另一条停在 delivered + 一条坏行。
  fs.writeFileSync(path.join(runDir, "a2a_messages.jsonl"), [
    record({ id: "m-1", lifecycle: "committed" }),
    record({ id: "m-1", lifecycle: "delivered" }),
    record({ id: "m-1", lifecycle: "resolved" }),
    record({ id: "m-2", lifecycle: "delivered", messageType: "worker_report" }),
    "{broken json",
  ].join("\n") + "\n", "utf-8");

  const app = express();
  app.use(express.json());
  register(app, root);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/runs/:id/a2a-messages", () => {
  it("多条快照 last-wins 合并出每消息最终态;坏行跳过不拖垮整读", async () => {
    const r = await fetch(`${baseUrl}/api/runs/run-a2a-read-0001/a2a-messages`);
    expect(r.status).toBe(200);
    const body = await r.json() as { runId: string; messages: Array<{ id: string; lifecycle: string }> };
    expect(body.runId).toBe("run-a2a-read-0001");
    expect(body.messages).toHaveLength(2);
    const byId = Object.fromEntries(body.messages.map(m => [m.id, m.lifecycle]));
    expect(byId["m-1"]).toBe("resolved");
    expect(byId["m-2"]).toBe("delivered");
  });

  it("无 a2a_messages.jsonl 的 run → 空数组(如实,不 404 也不虚构)", async () => {
    const r = await fetch(`${baseUrl}/api/runs/run-without-a2a-msgs/a2a-messages`);
    expect(r.status).toBe(200);
    const body = await r.json() as { messages: unknown[] };
    expect(body.messages).toEqual([]);
  });

  it("非法 runId(路径穿越形状)→ 400", async () => {
    const r = await fetch(`${baseUrl}/api/runs/${encodeURIComponent("../keys")}/a2a-messages`);
    expect(r.status).toBe(400);
  });
});
