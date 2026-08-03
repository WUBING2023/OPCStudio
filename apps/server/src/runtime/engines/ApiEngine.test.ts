import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { ApiEngine } from "./ApiEngine.js";
import { parseTextToolCalls, toFunctionTools, supportsNativeFunctionCalling } from "./apiToolLoop.js";
import { registerProvider, getHandler, createOpenAICompatProvider, setModelGatewayRoot, type ModelInput, type ModelOutput } from "../modelGateway.js";
import { initProviderHealth } from "../providerHealth.js";

// ApiEngine(in-process API tool-loop,替代 Hermes)必存活契约,移植自 HermesEngine.test.ts:
// ① 多账号租约 key 真进 HTTP header(per-call 覆写,不再是 Hermes env var + credential_pool 赌运气)
// ② mock provider 零外呼走 callModel ③ 反假成功:零输出判 failed ④ 超时抢救 timedOutPartial 语义
// (≥200 字 → done+partial;太薄 → failed 且 error 含 "timed out")。全部 mock 掉模型调用,零真实外呼。

const okOut = (over: Partial<ModelOutput> = {}): ModelOutput => ({
  content: "ok", promptTokens: 10, completionTokens: 5, totalTokens: 15,
  estimatedCostUsd: 0, latencyMs: 1, ...over,
});

function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
    model: "deepseek-chat", provider: "deepseek",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

let workdir: string;
let emitted: Array<{ type: string; payload: any }>;

function ctx(over: Partial<ExecContext> = {}): ExecContext {
  return {
    runId: "run-1", projectRoot: workdir, workdir,
    emit: (type, _id, payload) => { emitted.push({ type, payload }); },
    budget: { maxTokensPerTask: 4096 },
    ...over,
  };
}

const task: ExecTask = { taskId: "t1", goal: "do the thing", systemPrompt: "sys", maxTokens: 100 };

const realFetch = globalThis.fetch;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "apiengine-"));
  workdir = tmp;
  emitted = [];
  setModelGatewayRoot(tmp);
  initProviderHealth(tmp); // 重定向 provider_health.json 持久化,不污染仓库 .opc
});

afterEach(() => {
  globalThis.fetch = realFetch;
  fs.rmSync(workdir, { recursive: true, force: true });
});

describe("ApiEngine — 多账号自动切换:leasedAccount key 原生直进 HTTP header", () => {
  let capturedAuth: string | undefined;

  beforeEach(() => {
    capturedAuth = undefined;
    registerProvider("deepseek", createOpenAICompatProvider("https://api.test/v1", "sk-pool-default", { allowLocalNetwork: true }));
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedAuth = init?.headers?.Authorization;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "最终答复内容" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }), { status: 200 });
    }) as typeof fetch;
  });

  it("providerId 匹配 → 这次请求的 Authorization 用租到的账号 key(覆写注册时绑定的 key)", async () => {
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx({ leasedAccount: { providerId: "deepseek", apiKey: "sk-lease-a" } }));
    expect(capturedAuth).toBe("Bearer sk-lease-a");
    expect(result.status).toBe("done");
    expect(result.content).toBe("最终答复内容");
  });

  it("providerId 不匹配(冷却路由已换供应商)→ 不套用,退回该 provider 注册时的 key", async () => {
    const engine = new ApiEngine();
    await engine.run(agent(), task, ctx({ leasedAccount: { providerId: "openai", apiKey: "sk-lease-a" } }));
    expect(capturedAuth).toBe("Bearer sk-pool-default");
  });

  it("两个账号,不同 apiKey → 各自调用注入各自的 key(随租约切换,不是恒定值)", async () => {
    const engine = new ApiEngine();
    await engine.run(agent(), task, ctx({ leasedAccount: { providerId: "deepseek", apiKey: "sk-account-a" } }));
    expect(capturedAuth).toBe("Bearer sk-account-a");
    await engine.run(agent(), task, ctx({ leasedAccount: { providerId: "deepseek", apiKey: "sk-account-b" } }));
    expect(capturedAuth).toBe("Bearer sk-account-b");
  });

  it("没有 leasedAccount 但有 apiKeyOverride → 用 override;两者都没有 → 注册时的 key", async () => {
    const engine = new ApiEngine();
    await engine.run(agent(), task, ctx({ apiKeyOverride: "sk-override" }));
    expect(capturedAuth).toBe("Bearer sk-override");
    await engine.run(agent(), task, ctx());
    expect(capturedAuth).toBe("Bearer sk-pool-default");
  });
});

describe("ApiEngine — mock 短路:零外呼走 callModel 的 mock handler", () => {
  it("provider=mock → 不发任何 HTTP 请求,status done,emit model_call_finished", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("测试内禁止外呼"); }) as typeof fetch;
    const engine = new ApiEngine();
    const result = await engine.run(agent({ provider: "mock" }), task, ctx());
    expect(fetchCalled).toBe(false);
    expect(result.status).toBe("done");
    expect(result.content).toContain("[MOCK");
    expect(emitted.some((e) => e.type === "model_call_finished" && e.payload?.provider === "mock")).toBe(true);
  });

  // MUP Gate A#2/矩阵8 · mock run 必须 simulated:引擎结果 + model_call_finished payload 双路结构化标记,
  // 永不冒充真实成功/成本(status 仍 done 保 E2E,新语义全走加性字段)。
  it("simulated 加性透传:result.simulated=true 且 model_call_finished payload.simulated=true", async () => {
    const engine = new ApiEngine();
    const result = await engine.run(agent({ provider: "mock" }), task, ctx());
    expect(result.status).toBe("done");
    expect((result as { simulated?: true }).simulated).toBe(true);
    const mcf = emitted.find((e) => e.type === "model_call_finished");
    expect(mcf?.payload?.simulated).toBe(true);
    expect(mcf?.payload?.provider).toBe("mock");
  });

  it("真实 provider 的结果不带 simulated 字段(缺省 = 真实,与老 run 同语义)", async () => {
    registerProvider("deepseek", async () => okOut({ content: "真实答复内容够长" }));
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx());
    expect(result.status).toBe("done");
    expect((result as { simulated?: true }).simulated).toBeUndefined();
    expect(emitted.filter((e) => e.type === "model_call_finished").every((e) => e.payload?.simulated !== true)).toBe(true);
  });

  it("mock 路径异常兜底也标 simulated(模拟失败不形成真实失败经验)", async () => {
    const original = getHandler("mock")!;
    try {
      registerProvider("mock", async () => { throw new Error("mock handler 炸了"); });
      const engine = new ApiEngine();
      const result = await engine.run(agent({ provider: "mock" }), task, ctx());
      expect(result.status).toBe("failed");
      expect((result as { simulated?: true }).simulated).toBe(true);
    } finally {
      registerProvider("mock", original); // 还原内建 mock handler,不污染后续用例
    }
  });
});

describe("ApiEngine — 反假成功:零输出判 failed", () => {
  it("模型正常返回但 content 为空 → status failed、error 含零输出、emit error", async () => {
    registerProvider("deepseek", async () => okOut({ content: "" }));
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx());
    expect(result.status).toBe("failed");
    expect(result.content).toBe("");
    expect(result.error).toMatch(/零输出/);
    expect(emitted.some((e) => e.type === "error")).toBe(true);
  });
});

describe("ApiEngine — restricted 分类:无 handler(缺 key)判 restricted 而非假成功", () => {
  it("provider 未注册 → ProviderUnavailableError → status restricted,emit error(restricted:true)", async () => {
    const engine = new ApiEngine();
    const result = await engine.run(agent({ provider: "no-such-provider" }), task, ctx());
    expect(result.status).toBe("restricted");
    expect(result.error).toMatch(/unavailable/i);
    expect(emitted.some((e) => e.type === "error" && e.payload?.restricted === true)).toBe(true);
  });

  it("引擎级超时不算 restricted:error 含 timed out → failed(deferred 归因 timeout 的机器约定)", async () => {
    let call = 0;
    registerProvider("deepseek", async () => {
      call++;
      if (call === 1) {
        return okOut({
          content: "起步", // <200 字 → 超时后太薄不救
          toolCalls: [{ id: "c1", type: "function", function: { name: "listFiles", arguments: '{"path":"."}' } }],
        });
      }
      return new Promise<never>(() => { /* 第二轮永不返回 → 触发引擎级 deadline */ });
    });
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx({ taskTimeoutMs: 21_000 })); // → 引擎 deadline 1s
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/timed out/i);
    const err = emitted.find((e) => e.type === "error");
    expect(err?.payload?.restricted).toBe(false);
  }, 15000);
});

describe("ApiEngine — timeout after file writes preserves real partial artifacts", () => {
  it("returns done+partial with fileChanges so downstream quality and verification gates can judge them", async () => {
    let call = 0;
    registerProvider("deepseek", async () => {
      call++;
      if (call === 1) {
        return okOut({
          content: "",
          toolCalls: [{
            id: "write-before-timeout",
            type: "function",
            function: { name: "writeFile", arguments: JSON.stringify({ path: "partial.js", content: "module.exports = 1;\n" }) },
          }],
        });
      }
      return new Promise<never>(() => { /* second request exceeds the tool-loop deadline */ });
    });

    const result = await new ApiEngine().run(agent(), task, ctx({ taskTimeoutMs: 21_000 }));
    expect(result.status).toBe("done");
    expect(result.partial).toBe(true);
    expect(result.error).toMatch(/timed out/i);
    expect(result.fileChanges.some((change) => change.path === "partial.js")).toBe(true);
    expect(fs.readFileSync(path.join(workdir, "partial.js"), "utf-8")).toContain("module.exports");
  }, 15_000);
});

describe("ApiEngine — budget stop preserves artifacts and usage", () => {
  it("returns done+partial after a real write and keeps tokens from the completed model call", async () => {
    registerProvider("deepseek", async () => okOut({
      content: "",
      toolCalls: [{
        id: "write-before-budget-stop",
        type: "function",
        function: { name: "writeFile", arguments: JSON.stringify({ path: "budget-partial.js", content: "module.exports = 2;\n" }) },
      }],
    }));

    const result = await new ApiEngine().run(agent(), task, ctx({ budget: { maxTokensPerTask: 25 } }));
    expect(result.status).toBe("done");
    expect(result.partial).toBe(true);
    expect(result.error).toMatch(/token budget exhausted/i);
    expect(result.fileChanges.some((change) => change.path === "budget-partial.js")).toBe(true);
    expect(result.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(fs.readFileSync(path.join(workdir, "budget-partial.js"), "utf-8")).toContain("module.exports");
  });

  it("fails without files but still accounts for tokens already consumed", async () => {
    registerProvider("deepseek", async () => okOut({
      content: "",
      toolCalls: [{ id: "list-before-budget-stop", type: "function", function: { name: "listFiles", arguments: '{"path":"."}' } }],
    }));

    const result = await new ApiEngine().run(agent(), task, ctx({ budget: { maxTokensPerTask: 25 } }));
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/token budget exhausted/i);
    expect(result.fileChanges).toEqual([]);
    expect(result.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
  });
});
describe("ApiEngine — 超时抢救:已有实质产出 → done+partial(timedOutPartial 语义)", () => {
  it("deadline 命中但已累计 ≥200 字 → status done、partial true、emit timeout_salvage", async () => {
    const meaty = "研究阶段结论:已核实三条来源并给出初步分析与建议。".repeat(10); // ≥200 字
    let call = 0;
    registerProvider("deepseek", async () => {
      call++;
      if (call === 1) {
        return okOut({
          content: meaty,
          toolCalls: [{ id: "c1", type: "function", function: { name: "listFiles", arguments: '{"path":"."}' } }],
        });
      }
      return new Promise<never>(() => { /* 第二轮挂起 → deadline 抢救第一轮产出 */ });
    });
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx({ taskTimeoutMs: 21_000 }));
    expect(result.status).toBe("done");
    expect(result.partial).toBe(true);
    expect(result.content.length).toBeGreaterThanOrEqual(200);
    expect(emitted.some((e) => e.type === "info" && e.payload?.kind === "timeout_salvage")).toBe(true);
  }, 15000);
});

describe("ApiEngine — 原生 function calling 工具循环:执行工具、回灌结果、捕获文件变更", () => {
  it("round1 writeFile tool_call → 真写文件 + emit tool_call/tool_result;round2 收 tool 消息后收尾", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      if (handlerCalls.length === 1) {
        return okOut({
          content: "",
          toolCalls: [{ id: "call_1", type: "function", function: { name: "writeFile", arguments: JSON.stringify({ path: "hello.txt", content: "hello world" }) } }],
          finishReason: "tool_calls",
        });
      }
      return okOut({ content: "文件已写入,任务完成。" });
    });
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx());

    expect(result.status).toBe("done");
    expect(result.content).toBe("文件已写入,任务完成。");
    expect(fs.readFileSync(path.join(workdir, "hello.txt"), "utf-8")).toBe("hello world");
    expect(result.fileChanges.some((f) => f.path.includes("hello.txt"))).toBe(true);
    expect(result.toolCalls?.length).toBe(1);
    expect(emitted.some((e) => e.type === "tool_call" && e.payload?.name === "writeFile")).toBe(true);
    expect(emitted.some((e) => e.type === "tool_result" && e.payload?.name === "writeFile")).toBe(true);
    // 工具结果按 OpenAI 协议回灌:第二轮请求带 assistant(tool_calls) + tool 消息
    expect(handlerCalls[1].messages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true);
    // 工具定义真的进了请求(带 name/description/参数 schema)
    expect(handlerCalls[0].tools?.some((t) => t.function.name === "writeFile")).toBe(true);
    // 每轮一条 model_call_finished(两轮 = 两条,per-call 真实计账)
    expect(emitted.filter((e) => e.type === "model_call_finished").length).toBe(2);
  });
});

describe("ApiEngine — 文本工具协议回退(deepseek-reasoner 等无 function calling 模型)", () => {
  it("不传 tools、prompt 注入文本协议;从回复解析 tool_call 块执行,结果以 <tool_result> 回灌", async () => {
    const handlerCalls: ModelInput[] = [];
    registerProvider("deepseek", async (input) => {
      handlerCalls.push(input);
      if (handlerCalls.length === 1) {
        return okOut({
          content: '先写文件。\n```tool_call\n{"name": "writeFile", "arguments": {"path": "note.md", "content": "备注内容"}}\n```',
        });
      }
      return okOut({ content: "已完成,文件已写入。" });
    });
    const engine = new ApiEngine();
    const result = await engine.run(agent({ model: "deepseek-reasoner" }), task, ctx());

    expect(result.status).toBe("done");
    expect(fs.readFileSync(path.join(workdir, "note.md"), "utf-8")).toBe("备注内容");
    expect(handlerCalls[0].tools).toBeUndefined();
    expect(handlerCalls[0].system).toContain("文本协议");
    expect(handlerCalls[1].messages.some((m) => m.role === "user" && m.content.includes("<tool_result"))).toBe(true);
    expect(emitted.some((e) => e.type === "tool_call" && e.payload?.name === "writeFile")).toBe(true);
  });
});

describe("ApiEngine — A6a executor 三值标注:返回 stamp executor:api + emit executor_selected", () => {
  it("正常收尾 → result.executor=api;emit info executor_selected{executor:api,engine:provider},不带 degradedReason", async () => {
    registerProvider("deepseek", async () => okOut({ content: "最终答复内容够长" }));
    const engine = new ApiEngine();
    const result = await engine.run(agent(), task, ctx());
    expect(result.status).toBe("done");
    expect(result.executor).toBe("api");
    const sel = emitted.find((e) => e.type === "info" && e.payload?.kind === "executor_selected");
    expect(sel).toBeDefined();
    expect(sel!.payload.executor).toBe("api");
    expect(sel!.payload.engine).toBe("deepseek");
    expect(sel!.payload.degradedReason).toBeUndefined(); // 非降级,不得进 executorFallbacks
  });

  it("零输出 failed / restricted / mock 短路 → 同样 stamp executor:api(失败也如实标注执行通道)", async () => {
    registerProvider("deepseek", async () => okOut({ content: "" }));
    const engine = new ApiEngine();
    const failed = await engine.run(agent(), task, ctx());
    expect(failed.status).toBe("failed");
    expect(failed.executor).toBe("api");
    const restricted = await engine.run(agent({ provider: "no-such-provider" }), task, ctx());
    expect(restricted.status).toBe("restricted");
    expect(restricted.executor).toBe("api");
    const mock = await engine.run(agent({ provider: "mock" }), task, ctx());
    expect(mock.status).toBe("done");
    expect(mock.executor).toBe("api");
  });
});

describe("apiToolLoop — 纯函数单元", () => {
  it("parseTextToolCalls:fenced 块 + <tool_call> 标签都解析;坏 JSON 跳过不炸", () => {
    const content = [
      '```tool_call\n{"name": "readFile", "arguments": {"path": "a.ts"}}\n```',
      "<tool_call>{\"name\": \"listFiles\", \"arguments\": {}}</tool_call>",
      "```tool_call\n{not json}\n```",
    ].join("\n");
    const calls = parseTextToolCalls(content);
    expect(calls.map((c) => c.function.name)).toEqual(["readFile", "listFiles"]);
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ path: "a.ts" });
  });

  it("toFunctionTools:自带 paramSchema 原样用;缺省时按描述 'Args: …' 约定推断(default 视为可选)", () => {
    const defs = toFunctionTools([
      { name: "withSchema", description: "d", execute: async () => "", paramSchema: { properties: { target: { type: "string" } }, required: ["target"] } },
      { name: "writeFile", description: "Write file. Args: path, content", execute: async () => "" },
      { name: "listFiles", description: "List directory. Args: path (default '.')", execute: async () => "" },
      { name: "gitStatus", description: "Show git working tree status. No args.", execute: async () => "" },
    ]);
    expect(defs[0].function.parameters.required).toEqual(["target"]);
    expect(Object.keys(defs[1].function.parameters.properties)).toEqual(["path", "content"]);
    expect(defs[1].function.parameters.required).toEqual(["path", "content"]);
    expect(defs[2].function.parameters.required).toEqual([]);
    expect(defs[3].function.parameters.properties).toEqual({});
  });

  it("supportsNativeFunctionCalling:reasoner/r1/anthropic 走文本协议,其余原生", () => {
    expect(supportsNativeFunctionCalling("deepseek", "deepseek-chat")).toBe(true);
    expect(supportsNativeFunctionCalling("deepseek", "deepseek-reasoner")).toBe(false);
    expect(supportsNativeFunctionCalling("openrouter", "deepseek-r1")).toBe(false);
    expect(supportsNativeFunctionCalling("anthropic", "claude-sonnet-5")).toBe(false);
  });
});
