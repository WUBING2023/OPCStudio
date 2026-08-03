import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderUnavailableError } from "@opc/shared";

// framework 三态路由的单测:mock 引擎层(getEngine)、API 面(callModel)、事件总线(emit),
// 断言 hermes→callModel、订阅/CLI→engine.run、openai 无 handler + codex 订阅设置不再抛
// ProviderUnavailable、失败文案为人话、tokens 经引擎事件单次入账(不双记)。

const { callModelMock, getEngineMock, emitMock, resolveSystemModelMock, resolveAutoSubscriptionMock, chatPoolEnabledMock, chatPoolInvokeMock } = vi.hoisted(() => ({
  callModelMock: vi.fn(),
  getEngineMock: vi.fn(),
  emitMock: vi.fn(),
  resolveSystemModelMock: vi.fn(),
  resolveAutoSubscriptionMock: vi.fn(),
  chatPoolEnabledMock: vi.fn(),
  chatPoolInvokeMock: vi.fn(),
}));

vi.mock("./modelGateway.js", () => ({ callModel: callModelMock }));
vi.mock("./engineRouter.js", () => ({ getEngine: getEngineMock }));
vi.mock("./eventBus.js", () => ({ emit: emitMock, getRunId: () => "" }));
vi.mock("./systemModel.js", () => ({ resolveSystemModel: resolveSystemModelMock, resolveAutoSubscription: resolveAutoSubscriptionMock }));
// 订阅会话池:默认关(chatPoolEnabled→false)让既有分流用例走一次性引擎链不变;池专项用例各自开。
vi.mock("./subscriptionChatPool.js", () => ({
  chatPoolEnabled: chatPoolEnabledMock,
  getSubscriptionChatPool: () => ({ invoke: chatPoolInvokeMock }),
}));

import { invokeSystemModel, invokeSystemModelWithChoice, invokeAgentModel, isSubscriptionFramework } from "./systemModelInvoke.js";

function fakeEngine(framework: string, result: Record<string, unknown>, opts: { emitFinished?: boolean; throwErr?: Error } = {}) {
  return {
    framework,
    probe: vi.fn(),
    run: vi.fn(async (node: any, _task: any, ctx: any) => {
      if (opts.throwErr) throw opts.throwErr;
      if (opts.emitFinished !== false) {
        ctx.emit("model_call_finished", node.id, {
          provider: node.provider, model: node.model,
          tokens: 8, cost: 0, promptTokens: 5, completionTokens: 3,
        });
      }
      return {
        content: "OK", toolCalls: undefined, fileChanges: [],
        tokens: { prompt: 5, completion: 3, total: 8 }, cost: 0, latencyMs: 1,
        status: "done", ...result,
      };
    }),
  };
}

const baseInput = { agentId: "sys-x", messages: [{ role: "user", content: "只回答OK" }], maxTokens: 100, agentRole: "advisor" };

beforeEach(() => {
  callModelMock.mockReset();
  getEngineMock.mockReset();
  emitMock.mockReset();
  resolveSystemModelMock.mockReset();
  resolveAutoSubscriptionMock.mockReset();
  chatPoolEnabledMock.mockReset();
  chatPoolEnabledMock.mockReturnValue(false); // 默认关池:既有用例照旧走引擎链;池专项用例再各自开
  chatPoolInvokeMock.mockReset();
  // 默认:不做自动订阅替换(原样保留),让既有分流用例不受影响。具体三态用例各自 mockResolvedValueOnce。
  resolveAutoSubscriptionMock.mockImplementation(async (choice: any) => ({ kind: "keep", choice, reason: "has-key" }));
});

describe("isSubscriptionFramework — api(含历史 alias hermes)是 API 面", () => {
  it("api/hermes → false;claude-code/codex/gemini-cli → true", () => {
    expect(isSubscriptionFramework("api")).toBe(false);
    expect(isSubscriptionFramework("hermes")).toBe(false);
    expect(isSubscriptionFramework("claude-code")).toBe(true);
    expect(isSubscriptionFramework("codex")).toBe(true);
    expect(isSubscriptionFramework("gemini-cli")).toBe(true);
  });
  it("缺省/空 framework(旧配置/测试桩)→ false,保守走 API 面", () => {
    expect(isSubscriptionFramework(undefined)).toBe(false);
    expect(isSubscriptionFramework("")).toBe(false);
  });

  it("resolveSystemModel 返回无 framework(旧桩)时 → callModel,不误入引擎", async () => {
    resolveSystemModelMock.mockReturnValueOnce({ provider: "deepseek", model: "deepseek-chat" } as any);
    callModelMock.mockResolvedValue({ content: "x", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 });
    const out = await invokeSystemModel("/root", "creative", baseInput);
    expect(getEngineMock).not.toHaveBeenCalled();
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(out.content).toBe("x");
  });
});

describe("invokeSystemModelWithChoice — framework 三态路由", () => {
  it("hermes(API 面)→ 走 callModel,不碰引擎层", async () => {
    callModelMock.mockResolvedValue({
      content: "hi", toolCalls: undefined, promptTokens: 2, completionTokens: 1, totalTokens: 3, estimatedCostUsd: 0.001,
    });
    const out = await invokeSystemModelWithChoice("/root", { framework: "hermes", provider: "deepseek", model: "deepseek-chat" }, baseInput);
    expect(getEngineMock).not.toHaveBeenCalled();
    expect(callModelMock).toHaveBeenCalledTimes(1);
    expect(callModelMock.mock.calls[0][0]).toMatchObject({ provider: "deepseek", model: "deepseek-chat", agentId: "sys-x" });
    expect(out).toMatchObject({ content: "hi", totalTokens: 3, estimatedCostUsd: 0.001 });
  });

  it("claude-code(订阅)→ 走 getEngine('claude-code').run,不走 callModel", async () => {
    const eng = fakeEngine("claude-code", {});
    getEngineMock.mockReturnValue(eng);
    const out = await invokeSystemModelWithChoice("/root", { framework: "claude-code", provider: "anthropic", model: "sonnet" }, baseInput);
    expect(getEngineMock).toHaveBeenCalledWith("claude-code");
    expect(callModelMock).not.toHaveBeenCalled();
    expect(out.content).toBe("OK");
    expect(out.totalTokens).toBe(8);
    // 引擎构造的节点带上了订阅 CLI 的别名(sonnet 原样,未被 canonical 化)
    expect(eng.run.mock.calls[0][0]).toMatchObject({ framework: "claude-code", provider: "anthropic", model: "sonnet" });
  });

  it("codex 订阅设置 + openai 无 handler:路由到引擎,绝不抛 ProviderUnavailable / 'no handler registered'", async () => {
    // 若错误地回落到 API 面,callModel 会抛这个错(还原用户实测场景)。
    callModelMock.mockRejectedValue(new ProviderUnavailableError("openai", "no handler registered — missing API key or unknown provider"));
    getEngineMock.mockReturnValue(fakeEngine("codex", {}));
    const out = await invokeSystemModelWithChoice("/root", { framework: "codex", provider: "openai", model: "gpt-5.5" }, baseInput);
    expect(callModelMock).not.toHaveBeenCalled();
    expect(getEngineMock).toHaveBeenCalledWith("codex");
    expect(out.content).toBe("OK");
  });

  it("订阅 tokens 经引擎 model_call_finished 恰好一次入账(不双记)", async () => {
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}));
    await invokeSystemModelWithChoice("/root", { framework: "claude-code", provider: "anthropic", model: "sonnet" }, baseInput);
    const finished = emitMock.mock.calls.filter((c) => c[0] === "model_call_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0][2]).toMatchObject({ provider: "anthropic", promptTokens: 5, completionTokens: 3 });
  });
});

describe("invokeSystemModelWithChoice — 订阅对话会话池(池优先 + 失败回退)", () => {
  it("池开启 + 命中 → 走池,不碰 getEngine/callModel,tokens 唯一入账恰一条 model_call_finished", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    chatPoolInvokeMock.mockResolvedValue({ content: "池答", tokens: 12, promptTokens: 7, completionTokens: 5, estimated: true });
    const out = await invokeSystemModelWithChoice("/root", { framework: "claude-code", provider: "anthropic", model: "sonnet" }, baseInput);
    expect(chatPoolInvokeMock).toHaveBeenCalledTimes(1);
    expect(chatPoolInvokeMock.mock.calls[0][0]).toBe("claude-code");
    // 请求体:system 透传、messages 压平进 prompt
    expect(chatPoolInvokeMock.mock.calls[0][1]).toMatchObject({ prompt: "只回答OK", maxTokens: 100 });
    expect(getEngineMock).not.toHaveBeenCalled();
    expect(callModelMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ content: "池答", totalTokens: 12, promptTokens: 7, completionTokens: 5, estimatedCostUsd: 0 });
    const finished = emitMock.mock.calls.filter((c) => c[0] === "model_call_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0][2]).toMatchObject({ provider: "anthropic", model: "sonnet", promptTokens: 7, completionTokens: 5, tokens: 12, estimated: true });
  });

  it("池开启但失败 → 回退既有一次性引擎链(emit chat_pool_fallback),记账仍恰一次(引擎侧发,不双记)", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    chatPoolInvokeMock.mockRejectedValue(new Error("worker 未就绪即退出"));
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}));
    const out = await invokeSystemModelWithChoice("/root", { framework: "claude-code", provider: "anthropic", model: "sonnet" }, baseInput);
    expect(getEngineMock).toHaveBeenCalledWith("claude-code");
    expect(out.content).toBe("OK");
    const fallbackInfo = emitMock.mock.calls.find((c) => c[0] === "info" && (c[2] as any)?.kind === "chat_pool_fallback");
    expect(fallbackInfo, "应 emit 一条 chat_pool_fallback info").toBeDefined();
    const finished = emitMock.mock.calls.filter((c) => c[0] === "model_call_finished");
    expect(finished).toHaveLength(1); // 池没发,回退引擎发一条 → 不双记
  });

  it("带 tools 的调用不入池(ACP text-only 无函数调用)→ 直接走引擎链", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}));
    await invokeSystemModelWithChoice(
      "/root",
      { framework: "claude-code", provider: "anthropic", model: "sonnet" },
      { ...baseInput, tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] as any },
    );
    expect(chatPoolInvokeMock).not.toHaveBeenCalled();
    expect(getEngineMock).toHaveBeenCalledWith("claude-code");
  });

  it("input.reasoningEffort 透传给池 invoke 的第三参(codex 推理档位)", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    chatPoolInvokeMock.mockResolvedValue({ content: "池答", tokens: 5, promptTokens: 3, completionTokens: 2, estimated: false });
    await invokeSystemModelWithChoice(
      "/root",
      { framework: "codex", provider: "openai", model: "gpt-5.5" },
      { ...baseInput, reasoningEffort: "xhigh" },
    );
    expect(chatPoolInvokeMock).toHaveBeenCalledTimes(1);
    expect(chatPoolInvokeMock.mock.calls[0][0]).toBe("codex");
    expect(chatPoolInvokeMock.mock.calls[0][2]).toBe("xhigh"); // 第三参 = 推理档位
  });

  it("未设 reasoningEffort → 池 invoke 第三参为 undefined(保留引擎/对话默认)", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    chatPoolInvokeMock.mockResolvedValue({ content: "池答", tokens: 5, promptTokens: 3, completionTokens: 2, estimated: false });
    await invokeSystemModelWithChoice("/root", { framework: "codex", provider: "openai", model: "gpt-5.5" }, baseInput);
    expect(chatPoolInvokeMock.mock.calls[0][2]).toBeUndefined();
  });

  it("hermes(API 面)永不入池 → 走 callModel", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    callModelMock.mockResolvedValue({ content: "hi", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 });
    await invokeSystemModelWithChoice("/root", { framework: "hermes", provider: "deepseek", model: "deepseek-chat" }, baseInput);
    expect(chatPoolInvokeMock).not.toHaveBeenCalled();
    expect(callModelMock).toHaveBeenCalledTimes(1);
  });
});

describe("invokeSystemModelWithChoice — 订阅路径失败给人话", () => {
  it("引擎返回 status!=done → 抛人话错误,含 '订阅引擎'+framework,不含 'no handler registered'", async () => {
    getEngineMock.mockReturnValue(fakeEngine("codex", { status: "restricted", error: "codex 未登录", content: "" }, { emitFinished: false }));
    await expect(
      invokeSystemModelWithChoice("/root", { framework: "codex", provider: "openai", model: "gpt-5.5" }, baseInput),
    ).rejects.toThrow(/订阅引擎 codex 执行失败.*codex 未登录/);
    await expect(
      invokeSystemModelWithChoice("/root", { framework: "codex", provider: "openai", model: "gpt-5.5" }, baseInput),
    ).rejects.not.toThrow(/no handler registered/);
  });

  it("引擎 run 抛异常 → 包成人话错误", async () => {
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}, { throwErr: new Error("spawn ENOENT") }));
    await expect(
      invokeSystemModelWithChoice("/root", { framework: "claude-code", provider: "anthropic", model: "sonnet" }, baseInput),
    ).rejects.toThrow(/订阅引擎 claude-code 执行失败.*spawn ENOENT.*API 模式/);
  });
});

describe("invokeAgentModel — 员工推理档位透传订阅路径", () => {
  it("codex 员工 agent.reasoningEffort=high → 池 invoke 第三参为 high", async () => {
    chatPoolEnabledMock.mockReturnValue(true);
    chatPoolInvokeMock.mockResolvedValue({ content: "答", tokens: 4, promptTokens: 2, completionTokens: 2, estimated: false });
    resolveAutoSubscriptionMock.mockResolvedValueOnce({
      kind: "keep",
      choice: { framework: "codex", provider: "openai", model: "gpt-5.5" },
      reason: "already-subscription",
    });
    await invokeAgentModel(
      "/root",
      { id: "emp-1", framework: "codex", provider: "openai", model: "gpt-5.5", reasoningEffort: "high" },
      baseInput,
    );
    expect(chatPoolInvokeMock).toHaveBeenCalledTimes(1);
    expect(chatPoolInvokeMock.mock.calls[0][2]).toBe("high");
  });
});

describe("invokeSystemModel — 经 resolveSystemModel 解析后分流", () => {
  it("kind 解析出 hermes → callModel;解析出订阅 → engine", async () => {
    resolveSystemModelMock.mockReturnValueOnce({ framework: "hermes", provider: "deepseek", model: "deepseek-chat" });
    callModelMock.mockResolvedValue({ content: "h", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 });
    const a = await invokeSystemModel("/root", "creative", baseInput);
    expect(a.content).toBe("h");
    expect(getEngineMock).not.toHaveBeenCalled();

    resolveSystemModelMock.mockReturnValueOnce({ framework: "claude-code", provider: "anthropic", model: "sonnet" });
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}));
    const b = await invokeSystemModel("/root", "judge", baseInput);
    expect(b.content).toBe("OK");
    expect(getEngineMock).toHaveBeenCalledWith("claude-code");
  });
});

describe("invokeSystemModel — 无 key 自动订阅替换(三态)", () => {
  it("有 key(keep)→ 照旧 callModel,不 emit 自动订阅事件", async () => {
    resolveSystemModelMock.mockReturnValueOnce({ framework: "hermes", provider: "deepseek", model: "deepseek-chat" });
    resolveAutoSubscriptionMock.mockResolvedValueOnce({ kind: "keep", choice: { framework: "hermes", provider: "deepseek", model: "deepseek-chat" }, reason: "has-key" });
    callModelMock.mockResolvedValue({ content: "x", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0 });
    await invokeSystemModel("/root", "creative", baseInput);
    expect(callModelMock).toHaveBeenCalledTimes(1);
    const autoEv = emitMock.mock.calls.find((c) => c[0] === "info" && (c[2] as any)?.kind === "system_model_auto_subscription");
    expect(autoEv).toBeUndefined();
  });

  it("无 key 有订阅(substituted)→ 走订阅引擎 + emit info 事件(role/from/to 如实可见)", async () => {
    resolveSystemModelMock.mockReturnValueOnce({ framework: "hermes", provider: "anthropic", model: "claude-sonnet-5" });
    resolveAutoSubscriptionMock.mockResolvedValueOnce({
      kind: "substituted",
      choice: { framework: "claude-code", provider: "anthropic", model: "claude-sonnet-5" },
      from: "anthropic", to: "claude-code",
    });
    getEngineMock.mockReturnValue(fakeEngine("claude-code", {}));
    const out = await invokeSystemModel("/root", "creative", baseInput);
    expect(getEngineMock).toHaveBeenCalledWith("claude-code");
    expect(callModelMock).not.toHaveBeenCalled();
    expect(out.content).toBe("OK");
    const autoEv = emitMock.mock.calls.find((c) => c[0] === "info" && (c[2] as any)?.kind === "system_model_auto_subscription");
    expect(autoEv, "应 emit 一条 system_model_auto_subscription info 事件").toBeDefined();
    expect(autoEv![2]).toMatchObject({ kind: "system_model_auto_subscription", role: "creative", from: "anthropic", to: "claude-code" });
  });

  it("无 key 无订阅(unavailable)→ 抛人话错误(点名 provider + 订阅),不碰 callModel/引擎", async () => {
    resolveSystemModelMock.mockReturnValueOnce({ framework: "hermes", provider: "anthropic", model: "claude-sonnet-5" });
    resolveAutoSubscriptionMock.mockResolvedValueOnce({ kind: "unavailable", provider: "anthropic", subscription: "claude-code" });
    await expect(invokeSystemModel("/root", "creative", baseInput)).rejects.toThrow(/anthropic.*API key.*claude-code 订阅/);
    expect(callModelMock).not.toHaveBeenCalled();
    expect(getEngineMock).not.toHaveBeenCalled();
  });
});
