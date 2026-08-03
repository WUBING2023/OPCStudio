import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, Company } from "@opc/shared";

// taskRoutes.ts 只读 getAgents(不落盘)——mock 成纯内存实现,不碰真实项目数据
// (与 architectRoutes.test.ts 顶部同一处说明一致)。
const { mockAgents } = vi.hoisted(() => ({ mockAgents: [] as AgentNodeConfig[] }));
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: () => mockAgents,
}));

// task-decompose 调用 callModel 真实发请求出去——mock 掉,只验证 wiring(system/messages 是否带上了
// 该公司真实 Leader/CEO 自己配置的 provider/model,而不是一个和他们无关的「系统模型」、以及返回内容
// 如何被解析),不产生真实外呼。
const { mockCallModel } = vi.hoisted(() => ({ mockCallModel: vi.fn() }));
vi.mock("../runtime/modelGateway.js", () => ({ callModel: mockCallModel }));
vi.mock("../runtime/systemModel.js", () => ({
  resolveSystemModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  inferSystemFramework: () => "hermes",
  resolveAutoSubscription: async (choice: unknown) => ({ kind: "keep", choice, reason: "has-key" }),
}));

import { register } from "./taskRoutes.js";

function agent(overrides: Partial<AgentNodeConfig> & { id: string; name: string; role: string }): AgentNodeConfig {
  return {
    parentId: undefined, childrenIds: [], model: "deepseek-chat", provider: "deepseek",
    framework: "hermes", companyId: "co1", status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function setupRoot(company: Partial<Company> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "task-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  const co: Company = {
    id: "co1", name: "测试公司", description: "", createdAt: "2026-01-01",
    workflow: { verificationEdges: [] }, presetChannels: [],
    ...company,
  };
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([co]));
  return root;
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("POST /api/companies/:id/task-decompose(日常任务对话·执行模式 stage①②)", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(() => {
    mockAgents.length = 0;
    mockAgents.push(
      agent({ id: "ceo-1", name: "CEO", role: "ceo", childrenIds: ["dev-1"] }),
      agent({ id: "dev-1", name: "Dev A", role: "dev", parentId: "ceo-1" }),
    );
    mockCallModel.mockReset();
  });
  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("公司不存在 → 404", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/companies/no-such-co/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "帮我写一份市场调研报告" }),
    });
    expect(res.status).toBe(404);
  });

  it("message 缺失 → 400", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("公司没有 Leader 也没有 CEO → 400,不调用模型", async () => {
    mockAgents.length = 0;
    mockAgents.push(agent({ id: "dev-1", name: "Dev A", role: "dev" })); // 只有普通员工
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "帮我写一份市场调研报告" }),
    });
    expect(res.status).toBe(400);
    expect(mockCallModel).not.toHaveBeenCalled();
  });

  it("没有 Leader、只有 CEO → CEO 兜底,响应里如实说明 fallbackToCeo:true,调用用 CEO 自己配置的 provider/model", async () => {
    mockAgents.length = 0;
    mockAgents.push(agent({ id: "ceo-1", name: "老板", role: "ceo", provider: "anthropic", model: "sonnet" }));
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `{"summary":"整理一份竞品调研","needsChoice":false,"questions":[],"finalTask":"调研三家主要竞品的定价策略,产出一份对比表格"}`,
      totalTokens: 40,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "帮我做个竞品调研" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decomposer).toEqual({ agentId: "ceo-1", name: "老板", role: "ceo", fallbackToCeo: true });
    expect(body.finalTask).toBe("调研三家主要竞品的定价策略,产出一份对比表格");

    const callArg = mockCallModel.mock.calls[0][0];
    expect(callArg.system).toContain("老板");
    expect(callArg.system).toContain("没有配置 Leader");
    // 关键断言:即便这里退回 CEO 兜底,调用也确实用这个 CEO 自己配置的 provider/model
    // (不是一个和他无关的系统模型),agentId 也是这个真实 CEO 自己的 id。
    expect(callArg.agentId).toBe("ceo-1");
    expect(callArg.provider).toBe("anthropic");
    expect(callArg.model).toBe("sonnet");
    expect(callArg.agentRole).toBe("ceo");
  });

  it("有 Leader → 用 Leader 拆解,响应 fallbackToCeo:false;调用就用 Leader 自己配置的 provider/model(不是系统模型)", async () => {
    mockAgents.length = 0;
    mockAgents.push(
      agent({ id: "ceo-1", name: "CEO", role: "ceo", childrenIds: ["lead-1"] }),
      agent({ id: "lead-1", name: "Lead B", role: "lead", parentId: "ceo-1", provider: "anthropic", model: "opus" }),
    );
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `{"summary":"需要确认范围","needsChoice":true,"questions":[{"question":"报告只覆盖国内市场,还是也要海外?","options":["A. 只做国内","B. 国内+海外"]}],"finalTask":""}`,
      totalTokens: 40,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "帮我写一份市场调研报告" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decomposer).toEqual({ agentId: "lead-1", name: "Lead B", role: "lead", fallbackToCeo: false });
    expect(body.needsChoice).toBe(true);
    expect(body.questions).toEqual([{ question: "报告只覆盖国内市场,还是也要海外?", options: ["A. 只做国内", "B. 国内+海外"] }]);
    expect(body.finalTask).toBe("");

    const callArg = mockCallModel.mock.calls[0][0];
    // 关键断言:就是 Lead B 自己的 anthropic/opus(不是系统模型的 deepseek/deepseek-chat),
    // agentId 也是这个真实 Leader 自己的 id,token/成本记账落在这个真实员工节点上。
    expect(callArg.agentId).toBe("lead-1");
    expect(callArg.provider).toBe("anthropic");
    expect(callArg.model).toBe("opus");
    expect(callArg.agentRole).toBe("lead");
    expect(callArg.system).toContain("Lead B");
  });

  it("需求明确,直接给出 finalTask(needsChoice:false)", async () => {
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `{"summary":"整理会议纪要","needsChoice":false,"questions":[],"finalTask":"把昨天的会议录音转成文字并整理成结构化纪要"}`,
      totalTokens: 40,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "把昨天的会议整理成纪要" }),
    });
    const body = await res.json();
    expect(body.needsChoice).toBe(false);
    expect(body.finalTask).toBe("把昨天的会议录音转成文字并整理成结构化纪要");
  });

  it("MUP B7:模型在 DIRECT_ANSWER: 前带前言 → 全文首标记提取,仍正常解析且标记不进回传字段", async () => {
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `好的,我来拆解。DIRECT_ANSWER: {"summary":"整理纪要","needsChoice":false,"questions":[],"finalTask":"整理会议纪要并归档"}`,
      totalTokens: 20,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "整理会议纪要" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.needsChoice).toBe(false);
    expect(body.finalTask).toBe("整理会议纪要并归档");
    expect(JSON.stringify(body)).not.toContain("DIRECT_ANSWER");
  });

  it("needsChoice:false 但 finalTask 为空 → 400(和架构场景不同,任务拆解没有'什么都不用做'这种合法结果)", async () => {
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `{"summary":"处理需求","needsChoice":false,"questions":[],"finalTask":""}`,
      totalTokens: 10,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "随便弄一下" }),
    });
    expect(res.status).toBe(400);
  });

  it("模型输出无法解析为 JSON → 400,带原文截断,不派发任何东西", async () => {
    root = setupRoot();
    mockCallModel.mockResolvedValue({ content: "抱歉,我没能理解这个需求。", totalTokens: 10 });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "随便弄一下" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.raw).toContain("抱歉");
  });

  it("history 里的 assistant 角色正确映射给模型;未知 role 兜底按 user 处理", async () => {
    root = setupRoot();
    mockCallModel.mockResolvedValue({
      content: `{"summary":"好的","needsChoice":false,"questions":[],"finalTask":"继续之前说的那个任务"}`,
      totalTokens: 5,
    });
    ({ server, baseUrl } = await startServer(root));

    await fetch(`${baseUrl}/api/companies/co1/task-decompose`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "就选 A 吧",
        history: [
          { role: "user", content: "帮我写一份市场调研报告" },
          { role: "assistant", content: "报告只覆盖国内市场,还是也要海外?" },
        ],
      }),
    });
    const callArg = mockCallModel.mock.calls[0][0];
    expect(callArg.messages).toEqual([
      { role: "user", content: "帮我写一份市场调研报告" },
      { role: "assistant", content: "报告只覆盖国内市场,还是也要海外?" },
      { role: "user", content: "就选 A 吧" },
    ]);
  });
  it("需求已明确时支持原始任务哨兵,不让模型复制长任务导致截断", async () => {
    root = setupRoot();
    const original = "创建 package.json、src/app.js 和 test/app.test.js；只用 Node 内置模块；至少 12 个测试。";
    mockCallModel.mockResolvedValue({
      content: "{\"summary\":\"需求已明确\",\"needsChoice\":false,\"questions\":[],\"finalTask\":\"__USE_ORIGINAL_USER_MESSAGE__\"}",
      totalTokens: 20,
    });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(baseUrl + "/api/companies/co1/task-decompose", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: original }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalTask).toBe(original);
    expect(mockCallModel.mock.calls[0][0].maxTokens).toBe(3200);
    expect(mockCallModel.mock.calls[0][0].system).toContain("__USE_ORIGINAL_USER_MESSAGE__");
  });

  it("首次结构化输出被截断时紧凑重试一次,并无损复用原始任务", async () => {
    root = setupRoot();
    const original = "完成一个复杂但要求已经明确的 CommonJS 库和独立测试。";
    mockCallModel
      .mockResolvedValueOnce({
        content: "{\"summary\":\"准备执行\",\"needsChoice\":false,\"questions\":[],\"finalTask\":\"被截断",
        totalTokens: 3200,
      })
      .mockResolvedValueOnce({
        content: "{\"summary\":\"需求已明确\",\"needsChoice\":false,\"questions\":[],\"finalTask\":\"__USE_ORIGINAL_USER_MESSAGE__\"}",
        totalTokens: 30,
      });
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(baseUrl + "/api/companies/co1/task-decompose", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: original }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.finalTask).toBe(original);
    expect(mockCallModel).toHaveBeenCalledTimes(2);
    expect(mockCallModel.mock.calls[1][0].maxTokens).toBe(1200);
    expect(mockCallModel.mock.calls[1][0].system).toContain("不要复述原始任务");
  });
});
