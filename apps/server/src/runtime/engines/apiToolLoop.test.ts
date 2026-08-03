import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runApiToolLoop, type ApiToolLoopInput } from "./apiToolLoop.js";
import { ApiEngine } from "./ApiEngine.js";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { registerProvider, setModelGatewayRoot, type ModelInput, type ModelOutput } from "../modelGateway.js";
import type { ToolDef } from "../tools.js";
import { initProviderHealth } from "../providerHealth.js";

// A7 · ApiEngine tool-loop 预算控制(等价旧 hermes 三闸):token 预算 / workspace 磁盘配额 / 空转守卫。
// 全部 mock 掉模型调用(registerProvider),零真实外呼;工具执行走真实 runTool(写 tmp workdir)。
// 回归门:maxBudgetTokens / workspaceQuotaBytes 缺省时行为必须与改动前逐字节一致(测试④)。

const okOut = (over: Partial<ModelOutput> = {}): ModelOutput => ({
  content: "ok", promptTokens: 10, completionTokens: 5, totalTokens: 15,
  estimatedCostUsd: 0, latencyMs: 1, ...over,
});

const listFilesCall = (id = "c1") => ({
  id, type: "function" as const,
  function: { name: "listFiles", arguments: '{"path":"."}' },
});

const ADVERTISED_TOOLS: ToolDef[] = [
  { name: "listFiles", description: "List directory. Args: path (default '.')", execute: async () => "" },
  { name: "writeFile", description: "Write file. Args: path, content", execute: async () => "" },
];

let workdir: string;
let emitted: Array<{ type: string; agentId?: string; payload: any }>;

function loopInput(over: Partial<ApiToolLoopInput> = {}): ApiToolLoopInput {
  return {
    agentId: "worker-1", provider: "deepseek", model: "deepseek-chat",
    system: "sys", goal: "do the thing", maxTokens: 100,
    tools: ADVERTISED_TOOLS, workdir, timeoutMs: 60_000,
    emit: (type, agentId, payload) => { emitted.push({ type, agentId, payload }); },
    ...over,
  };
}

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "apiloop-"));
  emitted = [];
  setModelGatewayRoot(workdir);
  initProviderHealth(workdir); // 重定向 provider_health.json 持久化,不污染仓库 .opc
});

afterEach(() => {
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("apiToolLoop — truncated function arguments recover without executing empty args", () => {
  it("feeds a repair result back, retries a smaller write, and carries the remaining deadline", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      if (handlerCalls.length === 1) {
        return okOut({
          content: "",
          finishReason: "length",
          toolCalls: [{
            id: "bad-write",
            type: "function",
            function: { name: "writeFile", arguments: '{"path":"broken.txt","content":"unterminated' },
          }],
        });
      }
      if (handlerCalls.length === 2) {
        return okOut({
          content: "",
          toolCalls: [{
            id: "good-write",
            type: "function",
            function: { name: "writeFile", arguments: JSON.stringify({ path: "recovered.txt", content: "ok" }) },
          }],
        });
      }
      return okOut({ content: "recovered" });
    });

    const res = await runApiToolLoop(loopInput());
    expect(res.content).toBe("recovered");
    expect(fs.existsSync(path.join(workdir, "broken.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(workdir, "recovered.txt"), "utf-8")).toBe("ok");
    const firstResult = emitted.find((e) => e.type === "tool_result" && e.payload?.name === "writeFile");
    expect(firstResult?.payload?.result).toMatch(/truncated or invalid JSON/);
    expect(handlerCalls[1].messages.some((m) => m.role === "tool" && /truncated or invalid JSON/.test(m.content))).toBe(true);
    expect(handlerCalls[0].requestTimeoutMs).toBeGreaterThan(0);
    expect(handlerCalls[0].requestTimeoutMs).toBeLessThanOrEqual(60_000);
  });
});

describe("apiToolLoop — A7 token 预算:硬停止,不追加昂贵的总结调用", () => {
  it("下一轮 prompt 已超过剩余额度时直接失败,只调用一次模型", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      return okOut({ content: "", toolCalls: [listFilesCall("c1")] });
    });

    await expect(runApiToolLoop(loopInput({ maxBudgetTokens: 25 }))).rejects.toThrow(/token budget exhausted/i);
    expect(handlerCalls).toHaveLength(1);
    expect(emitted.filter((e) => e.type === "tool_result")).toHaveLength(1);
    expect(emitted.some((e) => e.type === "info" && e.payload?.kind === "budget_limit")).toBe(true);
  });
});

describe("apiToolLoop — active run cancellation", () => {
  it("取消后不再执行工具或发起第二次模型调用", async () => {
    const controller = new AbortController();
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      controller.abort(new Error("user requested stop"));
      return okOut({ content: "", toolCalls: [listFilesCall("cancelled")] });
    });

    await expect(runApiToolLoop(loopInput({ abortSignal: controller.signal }))).rejects.toThrow(/user requested stop/i);
    expect(handlerCalls).toHaveLength(1);
    expect(handlerCalls[0].abortSignal).toBe(controller.signal);
    expect(emitted.some((e) => e.type === "tool_call")).toBe(false);
  });
});
describe("apiToolLoop — A7 workspace 磁盘配额:超限 emit + throw(不静默继续)", () => {
  it("工具写盘超过 workspaceQuotaBytes → emit workspace_quota_exceeded 并 throw 'quota exceeded'", async () => {
    registerProvider("deepseek", async (input) => {
      if (input.tools?.length) {
        return okOut({
          content: "",
          toolCalls: [{ id: "w1", type: "function", function: { name: "writeFile", arguments: JSON.stringify({ path: "big.txt", content: "x".repeat(200) }) } }],
        });
      }
      return okOut({ content: "不应到达收尾" });
    });
    await expect(runApiToolLoop(loopInput({ workspaceQuotaBytes: 50 }))).rejects.toThrow(/quota exceeded/i);
    const ev = emitted.find((e) => e.type === "workspace_quota_exceeded");
    expect(ev).toBeDefined();
    expect(ev!.agentId).toBe("worker-1");
    expect(ev!.payload.quotaBytes).toBe(50);
  });

  it("ApiEngine 层:quota throw → status failed(restricted 正则刻意不吃 quota 文案)", async () => {
    registerProvider("deepseek", async (input) => {
      if (input.tools?.length) {
        return okOut({
          content: "",
          toolCalls: [{ id: "w1", type: "function", function: { name: "writeFile", arguments: JSON.stringify({ path: "big.txt", content: "x".repeat(200) }) } }],
        });
      }
      return okOut({ content: "不应到达收尾" });
    });
    const agent: AgentNodeConfig = {
      id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
      model: "deepseek-chat", provider: "deepseek",
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    };
    const task: ExecTask = { taskId: "t1", goal: "do", systemPrompt: "sys", maxTokens: 100 };
    const ctx: ExecContext = {
      runId: "run-1", projectRoot: workdir, workdir,
      emit: (type, agentId, payload) => { emitted.push({ type, agentId, payload }); },
      budget: { maxTokensPerTask: 4096 },
      workspaceQuotaBytes: 50,
    };
    const res = await new ApiEngine().run(agent, task, ctx);
    expect(res.status).toBe("failed"); // 不是 restricted:配额超限是任务级失败,defer 归因 workspace_quota_exceeded
    expect(res.error).toMatch(/quota exceeded/i);
  });
});

describe("apiToolLoop — A7 无进展守卫", () => {
  it("无文件变化时同一工具结果出现 3 次即失败,不再追加总结调用", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      return okOut({ content: "", toolCalls: [listFilesCall("c" + handlerCalls.length)] });
    });

    await expect(runApiToolLoop(loopInput())).rejects.toThrow(/tool loop made no progress/i);
    expect(handlerCalls).toHaveLength(3);
    const events = emitted.filter((e) => e.type === "info" && e.payload?.kind === "tool_loop_no_progress");
    expect(events).toHaveLength(1);
    expect(events[0].payload.message).toContain("3 times");
  });
});
describe("apiToolLoop — 回归门:预算/配额缺省时行为与现状逐字节一致", () => {
  it("缺省输入 + 达轮数上限 → 收尾消息逐字节不变,无任何 A7 新事件", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      if (input.tools?.length) {
        // 每轮不同 arguments(不触发空转守卫),模拟改动前的"烧到轮数上限"路径
        return okOut({
          content: "",
          toolCalls: [{ id: `c${handlerCalls.length}`, type: "function", function: { name: "writeFile", arguments: JSON.stringify({ path: `f${handlerCalls.length}.txt`, content: "hi" }) } }],
        });
      }
      return okOut({ content: "轮数上限收尾答复" });
    });
    const res = await runApiToolLoop(loopInput({ maxRounds: 2 }));

    expect(res.content).toBe("轮数上限收尾答复");
    expect(res.rounds).toBe(3);
    expect(res.toolCalls).toHaveLength(2);
    expect(fs.readFileSync(path.join(workdir, "f1.txt"), "utf-8")).toBe("hi");
    // 收尾消息与改动前逐字节一致
    const final = handlerCalls[handlerCalls.length - 1];
    expect(final.tools).toBeUndefined();
    expect(final.messages[final.messages.length - 1]).toEqual({
      role: "user",
      content: "已达到工具调用轮数上限。请基于以上工具结果直接给出最终答复,不要再调用任何工具。",
    });
    // 缺省时 A7 三闸全部静默:零新增事件
    expect(emitted.some((e) => e.type === "workspace_quota_exceeded")).toBe(false);
    expect(emitted.some((e) => e.type === "info" && (e.payload?.kind === "budget_limit" || e.payload?.kind === "tool_loop_stall"))).toBe(false);
  });
});

describe("apiToolLoop — MUP B7 <think> 剥离(每轮收口)", () => {
  it("正文内嵌 <think> → content 干净;思考走 thinking:true chunk;正文 chunk 不含思考", async () => {
    registerProvider("deepseek", async () => okOut({ content: "<think>推理过程,含密钥 sk-46d6d77debaa4153ba9055e9</think>最终答复正文" }));
    const res = await runApiToolLoop(loopInput());

    expect(res.content).toBe("最终答复正文");
    const chunks = emitted.filter((e) => e.type === "agent_output_chunk");
    expect(chunks.some((c) => c.payload.thinking === true && String(c.payload.chunk).includes("推理过程"))).toBe(true);
    const visible = chunks.filter((c) => c.payload.thinking !== true);
    expect(visible).toHaveLength(1);
    expect(visible[0].payload.chunk).toContain("最终答复正文");
    expect(visible[0].payload.chunk).not.toContain("<think>");
  });

  it("无 <think> 标记 → 输出与 chunk 行为零改动", async () => {
    registerProvider("deepseek", async () => okOut({ content: "普通答复" }));
    const res = await runApiToolLoop(loopInput());

    expect(res.content).toBe("普通答复");
    const chunks = emitted.filter((e) => e.type === "agent_output_chunk");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].payload).toEqual({ chunk: "普通答复" });
  });
});
