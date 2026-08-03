import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

// A4 · /api/a2a/ack 与 /api/a2a/resolve 端点 + GET inbox 带 lifecycle。
// 姿势同 ceoRoutes.test.ts:orchestrator 内存态 mock 掉(生命周期状态机语义由
// a2aLifecycle.test.ts 在 bus 层覆盖,这里验证 HTTP 层:参数校验/guardRun/成败映射)。
const { state } = vi.hoisted(() => ({
  state: {
    activeRunId: "run-1" as string | null,
    ackResult: { ok: true, lifecycle: "acknowledged", message: "已确认收到(acknowledged)" } as { ok: boolean; message: string; lifecycle?: string },
    resolveResult: { ok: true, lifecycle: "resolved", message: "已闭环(resolved)" } as { ok: boolean; message: string; lifecycle?: string },
    inbox: [] as unknown[],
    ackCalls: [] as Array<[string, string]>,
    resolveCalls: [] as Array<[string, string]>,
    instructionResult: { ok: true, message: "要求已进入任务收件箱", messageId: "m-user-1" } as { ok: boolean; message: string; messageId?: string },
    instructionCalls: [] as Array<[string, string]>,
  },
}));

vi.mock("../runtime/orchestrator.js", () => ({
  a2aActiveRunId: () => state.activeRunId,
  a2aActiveCompanyId: () => "co-1",
  a2aDiscover: () => [],
  a2aRequestChannel: () => ({ ok: true, message: "" }),
  a2aSend: () => ({ ok: true, message: "" }),
  a2aAsk: () => ({ ok: true, message: "" }),
  a2aInbox: () => state.inbox,
  a2aAcknowledge: (messageId: string, by: string) => { state.ackCalls.push([messageId, by]); return state.ackResult; },
  a2aResolve: (messageId: string, by: string) => { state.resolveCalls.push([messageId, by]); return state.resolveResult; },
  a2aInjectUserInstruction: (agentId: string, text: string) => { state.instructionCalls.push([agentId, text]); return state.instructionResult; },
}));
vi.mock("../runtime/harness.js", () => ({ enqueueAutomation: vi.fn() }));
vi.mock("../storage/skillStore.js", () => ({ listSkills: () => [], getSkill: () => null }));

import { register } from "./a2aRoutes.js";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  register(app, "/tmp/unused-a2a-routes");
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  state.activeRunId = "run-1";
  state.ackResult = { ok: true, lifecycle: "acknowledged", message: "已确认收到(acknowledged)" };
  state.resolveResult = { ok: true, lifecycle: "resolved", message: "已闭环(resolved)" };
  state.inbox = [];
  state.ackCalls.length = 0;
  state.resolveCalls.length = 0;
  state.instructionResult = { ok: true, message: "要求已进入任务收件箱", messageId: "m-user-1" };
  state.instructionCalls.length = 0;
});

async function post(p: string, body: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${baseUrl}${p}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}


describe("POST /api/runs/:id/agents/:agentId/instruction", () => {
  it("delivers a user requirement to the selected employee in the active run", async () => {
    const { status, json } = await post("/api/runs/run-1/agents/dev-1/instruction", { text: "先补边界测试" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, messageId: "m-user-1" });
    expect(state.instructionCalls).toEqual([["dev-1", "先补边界测试"]]);
  });

  it("fails closed for an ended/stale run and never calls the A2A injector", async () => {
    const { status } = await post("/api/runs/ended-run/agents/dev-1/instruction", { text: "继续" });
    expect(status).toBe(409);
    expect(state.instructionCalls).toHaveLength(0);
  });

  it("rejects blank and oversized instructions", async () => {
    expect((await post("/api/runs/run-1/agents/dev-1/instruction", { text: "   " })).status).toBe(400);
    expect((await post("/api/runs/run-1/agents/dev-1/instruction", { text: "x".repeat(4001) })).status).toBe(413);
    expect(state.instructionCalls).toHaveLength(0);
  });

  it("maps an A2A delivery refusal to 409 instead of reporting success", async () => {
    state.instructionResult = { ok: false, message: "目标员工不属于当前公司" };
    const { status, json } = await post("/api/runs/run-1/agents/foreign/instruction", { text: "继续" });
    expect(status).toBe(409);
    expect(json.error).toContain("不属于");
  });
});

describe("POST /api/a2a/ack", () => {
  it("happy path:200 + lifecycle=acknowledged,参数按 (messageId, from) 传给 orchestrator", async () => {
    const { status, json } = await post("/api/a2a/ack", { runId: "run-1", from: "worker-1", messageId: "m-1" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, lifecycle: "acknowledged" });
    expect(state.ackCalls).toEqual([["m-1", "worker-1"]]);
  });

  it("缺 from / 缺 messageId → 400,不触达 orchestrator", async () => {
    expect((await post("/api/a2a/ack", { runId: "run-1", messageId: "m-1" })).status).toBe(400);
    expect((await post("/api/a2a/ack", { runId: "run-1", from: "worker-1" })).status).toBe(400);
    expect(state.ackCalls).toHaveLength(0);
  });

  it("runId 不匹配当前活动 run → 409", async () => {
    const { status, json } = await post("/api/a2a/ack", { runId: "stale-run", from: "worker-1", messageId: "m-1" });
    expect(status).toBe(409);
    expect(json.error).toContain("不匹配");
    expect(state.ackCalls).toHaveLength(0);
  });

  it("没有活动 run → 409", async () => {
    state.activeRunId = null;
    const { status } = await post("/api/a2a/ack", { runId: "run-1", from: "worker-1", messageId: "m-1" });
    expect(status).toBe(409);
  });

  it("非法状态转移(orchestrator 拒绝)→ 409 带原因与当前 lifecycle", async () => {
    state.ackResult = { ok: false, lifecycle: "committed", message: "非法状态转移:当前 committed 不能推进为 acknowledged" };
    const { status, json } = await post("/api/a2a/ack", { runId: "run-1", from: "worker-1", messageId: "m-1" });
    expect(status).toBe(409);
    expect(json.error).toContain("非法状态转移");
    expect(json.lifecycle).toBe("committed");
  });
});

describe("POST /api/a2a/resolve", () => {
  it("happy path:200 + lifecycle=resolved", async () => {
    const { status, json } = await post("/api/a2a/resolve", { runId: "run-1", from: "lead-1", messageId: "m-2" });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, lifecycle: "resolved" });
    expect(state.resolveCalls).toEqual([["m-2", "lead-1"]]);
  });

  it("缺参 → 400;runId 不匹配 → 409;orchestrator 拒绝 → 409", async () => {
    expect((await post("/api/a2a/resolve", { runId: "run-1" })).status).toBe(400);
    expect((await post("/api/a2a/resolve", { runId: "nope", from: "a", messageId: "m" })).status).toBe(409);
    state.resolveResult = { ok: false, lifecycle: "resolved", message: "非法状态转移:当前 resolved 不能推进为 resolved" };
    const { status, json } = await post("/api/a2a/resolve", { runId: "run-1", from: "a", messageId: "m" });
    expect(status).toBe(409);
    expect(json.lifecycle).toBe("resolved");
  });
});

describe("GET /api/a2a/inbox 带 lifecycle", () => {
  it("响应消息透传 id/messageType/lifecycle(旧消息无这些字段也照常返回)", async () => {
    state.inbox = [
      { id: "m-new", from: "lead-1", performative: "request", text: "派活", messageType: "delegate_task", lifecycle: "delivered" },
      { id: "m-old", from: "lead-1", performative: "inform", text: "旧消息" },
    ];
    const r = await fetch(`${baseUrl}/api/a2a/inbox?runId=run-1&agentId=worker-1`);
    expect(r.status).toBe(200);
    const { messages } = await r.json();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: "m-new", messageType: "delegate_task", lifecycle: "delivered" });
    expect(messages[1].lifecycle).toBeUndefined();
  });

  it("runId 不匹配 → 409;缺 agentId → 400", async () => {
    expect((await fetch(`${baseUrl}/api/a2a/inbox?runId=zzz&agentId=w`)).status).toBe(409);
    expect((await fetch(`${baseUrl}/api/a2a/inbox?runId=run-1`)).status).toBe(400);
  });
});
