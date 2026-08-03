import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 对话历史持久化与注入(chatRoutes 的 /api/chat、/api/agents/:id/chat、GET /api/chat/thread)。
// 只 mock 模型调用与 agent 目录/记忆,chatThreadStore 用真实实现(落到 temp root 的 .opc/chat-threads),
// 从而端到端验证:请求落用户消息 → 历史注入 messages → 回复落线程 → GET 拉回。

const state = vi.hoisted(() => ({
  agents: [] as any[],
  memory: "" as string,
  invokeCalls: [] as { agentId: string; framework?: string; system?: string; messages: { role: string; content: string }[] }[],
  reply: "REPLY",
}));

vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: () => state.agents,
  startRun: vi.fn(),
}));

vi.mock("../runtime/systemModelInvoke.js", () => ({
  invokeAgentModel: vi.fn(async (_root: string, agent: any, input: any) => {
    state.invokeCalls.push({ agentId: agent.id, framework: agent.framework, system: input.system, messages: input.messages });
    return { content: state.reply, totalTokens: 42, promptTokens: 1, completionTokens: 1, estimatedCostUsd: 0 };
  }),
  invokeSystemModel: vi.fn(async () => ({ content: "{}", totalTokens: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 })),
}));

vi.mock("../runtime/capabilityReport.js", () => ({
  buildCapabilityReport: vi.fn(async () => ({ canRun: true, blockedBy: [] })),
}));

vi.mock("../storage/mdMemory.js", () => ({
  readAgentMemory: () => state.memory,
}));

vi.mock("../storage/companyStore.js", () => ({
  loadCompanies: () => [],
}));

import { register as registerChatRoutes } from "./chatRoutes.js";

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-thread-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  return root;
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, root);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("对话历史持久化与注入", () => {
  let root: string;
  let server: Server;
  let baseUrl = "";

  beforeEach(async () => {
    state.agents = [
      { id: "ceo-1", name: "Ada", role: "ceo", companyId: "default", provider: "deepseek", model: "deepseek-chat", framework: "hermes" },
      { id: "eng-1", name: "Bob", role: "engineer", companyId: "default", provider: "deepseek", model: "deepseek-chat", framework: "hermes" },
    ];
    state.memory = "";
    state.reply = "REPLY";
    state.invokeCalls = [];
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
  });

  afterEach(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
    baseUrl = "";
  });

  const chat = (message: string, companyId?: string) =>
    fetch(`${baseUrl}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, companyId }),
    }).then((r) => r.json() as Promise<{ reply: string; threadId: string; history: { role: string; content: string }[] }>);

  const chatAgent = (id: string, message: string) =>
    fetch(`${baseUrl}/api/agents/${id}/chat`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => r.json() as Promise<{ reply: string; threadId: string; history: { role: string; content: string }[] }>);

  it("CEO 对话:两侧都落线程,响应附 threadId + 最近历史", async () => {
    const body = await chat("你好");
    expect(body.reply).toBe("REPLY");
    expect(body.threadId).toBe("default::ceo-1");
    expect(body.history).toEqual([
      { role: "user", content: "你好", at: expect.any(String) },
      { role: "assistant", content: "REPLY", at: expect.any(String) },
    ]);
    // 落盘验证
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opc", "chat-threads", "default__ceo-1.json"), "utf-8"));
    expect(onDisk.turns.map((t: any) => t.content)).toEqual(["你好", "REPLY"]);
  });

  it("第一次调用只注入当前一句;第二次把历史折进 messages", async () => {
    await chat("我叫小明");
    await chat("我叫什么");
    expect(state.invokeCalls).toHaveLength(2);
    // 首次:线程里只有刚落的这一句
    expect(state.invokeCalls[0].messages).toEqual([{ role: "user", content: "我叫小明" }]);
    // 第二次:历史(user 我叫小明 + assistant REPLY)+ 当前(user 我叫什么)
    expect(state.invokeCalls[1].messages).toEqual([
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "REPLY" },
      { role: "user", content: "我叫什么" },
    ]);
  });

  it("同线程换 framework(引擎无关性):切换 framework 后历史照常注入", async () => {
    // 首轮走 hermes 引擎。
    await chat("我叫小明");
    // 同一 CEO、同一线程,把 framework 从 hermes 换成 codex——thread 键是 (companyId, agentId) 不含
    // framework(chatRoutes.ts:87/96-98),故换引擎不改线程,历史应照常折进第二次调用的 messages。
    state.agents[0].framework = "codex";
    await chat("我叫什么");
    expect(state.invokeCalls).toHaveLength(2);
    // 两次调用的 framework 确实不同——证明这是真"换 framework",而非空跑。
    expect(state.invokeCalls[0].framework).toBe("hermes");
    expect(state.invokeCalls[1].framework).toBe("codex");
    // 换 framework 后,第二次仍把首轮历史(user 我叫小明 + assistant REPLY)+ 当前一句注入。
    expect(state.invokeCalls[1].messages).toEqual([
      { role: "user", content: "我叫小明" },
      { role: "assistant", content: "REPLY" },
      { role: "user", content: "我叫什么" },
    ]);
  });

  it("CEO system 注入其持久记忆(## 你的持久记忆)", async () => {
    state.memory = "用户偏好中文;项目代号 OPC";
    await chat("hi");
    expect(state.invokeCalls[0].system).toContain("## 你的持久记忆");
    expect(state.invokeCalls[0].system).toContain("用户偏好中文;项目代号 OPC");
  });

  it("GET /api/chat/thread 按 companyId 解析 CEO 线程", async () => {
    await chat("第一句");
    const r = await fetch(`${baseUrl}/api/chat/thread?companyId=default`).then((x) => x.json() as Promise<{ threadId: string; agentId: string; turns: any[] }>);
    expect(r.threadId).toBe("default::ceo-1");
    expect(r.agentId).toBe("ceo-1");
    expect(r.turns.map((t) => t.content)).toEqual(["第一句", "REPLY"]);
  });

  it("员工单聊:落线程 + 历史注入 + GET 按 agentId 拉回", async () => {
    await chatAgent("eng-1", "任务A");
    const second = await chatAgent("eng-1", "任务B");
    expect(second.threadId).toBe("default::eng-1");
    expect(state.invokeCalls[1].messages).toEqual([
      { role: "user", content: "任务A" },
      { role: "assistant", content: "REPLY" },
      { role: "user", content: "任务B" },
    ]);
    const r = await fetch(`${baseUrl}/api/chat/thread?agentId=eng-1`).then((x) => x.json() as Promise<{ threadId: string; turns: any[] }>);
    expect(r.threadId).toBe("default::eng-1");
    expect(r.turns.map((t) => t.content)).toEqual(["任务A", "REPLY", "任务B", "REPLY"]);
  });

  it("CEO 与员工线程互不串(按 companyId+agentId 隔离)", async () => {
    await chat("给 CEO 的");
    await chatAgent("eng-1", "给员工的");
    const ceoThread = await fetch(`${baseUrl}/api/chat/thread?companyId=default`).then((x) => x.json() as Promise<{ turns: any[] }>);
    const engThread = await fetch(`${baseUrl}/api/chat/thread?agentId=eng-1`).then((x) => x.json() as Promise<{ turns: any[] }>);
    expect(ceoThread.turns.map((t) => t.content)).toEqual(["给 CEO 的", "REPLY"]);
    expect(engThread.turns.map((t) => t.content)).toEqual(["给员工的", "REPLY"]);
  });

  it("GET 线程:无 CEO 时优雅返回空(threadId=null)", async () => {
    state.agents = [{ id: "eng-1", name: "Bob", role: "engineer", companyId: "default" }];
    const r = await fetch(`${baseUrl}/api/chat/thread?companyId=default`).then((x) => x.json() as Promise<{ threadId: string | null; turns: any[] }>);
    expect(r.threadId).toBeNull();
    expect(r.turns).toEqual([]);
  });
});
