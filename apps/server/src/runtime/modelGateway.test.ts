import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { estimateCostForTokens, setModelGatewayRoot, callModel, registerProvider, getHandler, createOpenAICompatProvider, type FunctionToolDef } from "./modelGateway.js";
import { initProviderHealth } from "./providerHealth.js";

// P0-10 回归:引擎路径(apiToolLoop.ts:199)在 estimatedCostUsd 为空时用 estimateCostForTokens 按
// 定价表估价,避免预算刹车恒看到 $0。这里保证该公共定价函数本身对已知单价模型给出真实非零成本、
// 对未知模型诚实返回 undefined(不是悄悄 0)。
describe("estimateCostForTokens (P0-10 引擎成本记账)", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-cost-"));
    setModelGatewayRoot(dir);
  });

  it("已知单价模型:按真实单价(非 chars/4 裸估算)算出非零成本", () => {
    const cost = estimateCostForTokens("deepseek", "deepseek-v4-pro", 1_000_000, 1_000_000);
    expect(cost).toBeCloseTo(0.435 + 0.87, 6); // input $0.435/1M + output $0.87/1M
  });

  it("token 数越大成本越大(不是恒定值)", () => {
    const small = estimateCostForTokens("deepseek", "deepseek-v4-pro", 1000, 500)!;
    const large = estimateCostForTokens("deepseek", "deepseek-v4-pro", 100_000, 50_000)!;
    expect(small).toBeGreaterThan(0);
    expect(large).toBeGreaterThan(small);
  });

  it("未知模型:诚实返回 undefined,不是悄悄记 0", () => {
    const cost = estimateCostForTokens("some-provider", "totally-unknown-model-xyz", 1000, 1000);
    expect(cost).toBeUndefined();
  });

  it("零 token 输入:已知模型仍返回 0(而非 undefined)", () => {
    const cost = estimateCostForTokens("deepseek", "deepseek-v4-pro", 0, 0);
    expect(cost).toBe(0);
  });
});

// MUP Gate A#2 · mock provider 响应必须带**结构化** simulated 标记(不只 [MOCK] 文本前缀),
// 且零外呼:mock run 的"成功/成本/经验/交付"全链靠这个标记与真实 run 区分。
describe("mock provider — 结构化 simulated 标记(MUP Gate A#2/矩阵8)", () => {
  const realFetch = globalThis.fetch;
  let fetchCalled: boolean;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mg-sim-"));
    setModelGatewayRoot(dir);
    initProviderHealth(dir);
    fetchCalled = false;
    globalThis.fetch = (async () => { fetchCalled = true; throw new Error("测试内禁止外呼"); }) as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it("文本分支:CallRecord.simulated===true,伪 tokens(50/30)与 $0 成本原样,零外呼", async () => {
    const out = await callModel({ agentId: "a1", provider: "mock", model: "m", messages: [{ role: "user", content: "分析一下现状" }], maxTokens: 100 });
    expect(out.simulated).toBe(true);
    expect(out.content).toContain("[MOCK");
    expect(out.totalTokens).toBe(80);
    expect(out.estimatedCostUsd).toBe(0);
    expect(fetchCalled).toBe(false);
  });

  it("writeFile toolCalls 分支:同样 simulated===true", async () => {
    const tools: FunctionToolDef[] = [{ type: "function", function: { name: "writeFile", description: "w", parameters: { type: "object", properties: {} } } }];
    const out = await callModel({ agentId: "a1", provider: "mock", model: "m", messages: [{ role: "user", content: "please write file hello" }], maxTokens: 100, tools });
    expect(out.simulated).toBe(true);
    expect(out.toolCalls?.[0]?.function.name).toBe("writeFile");
    expect(fetchCalled).toBe(false);
  });

  it("callModel 对 provider===mock 强制补戳:即便 handler 被覆写且不带标记,CallRecord 仍 simulated", async () => {
    const original = getHandler("mock")!;
    try {
      registerProvider("mock", async () => ({ content: "覆写的 mock", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0, latencyMs: 1 }));
      const out = await callModel({ agentId: "a1", provider: "mock", model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
      expect(out.simulated).toBe(true);
    } finally {
      registerProvider("mock", original); // 还原内建 mock handler,不污染后续用例
    }
  });

  it("真实 provider 的响应绝不带 simulated(handler 未设即缺省)", async () => {
    registerProvider("real-p", async () => ({ content: "真实答复", promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCostUsd: 0.001, latencyMs: 1 }));
    const out = await callModel({ agentId: "a1", provider: "real-p", model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 100 });
    expect(out.simulated).toBeUndefined();
  });
});

describe("OpenAI-compatible provider SSRF guard", () => {
  const realFetch = globalThis.fetch;
  const input = {
    agentId: "ssrf-test",
    provider: "custom",
    model: "model",
    messages: [{ role: "user", content: "ok" }],
    maxTokens: 8,
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("rejects loopback endpoints before fetch by default", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error("fetch must not run");
    }) as typeof fetch;
    const handler = createOpenAICompatProvider("http://127.0.0.1:11434/v1", "key");
    await expect(handler(input)).rejects.toThrow(/private|local/i);
    expect(fetched).toBe(false);
  });

  it("allows an explicitly authorized local endpoint", async () => {
    let seenUrl = "";
    globalThis.fetch = (async (url) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const handler = createOpenAICompatProvider("http://127.0.0.1:11434/v1/", "key", { allowLocalNetwork: true });
    const result = await handler(input);
    expect(result.content).toBe("ok");
    expect(seenUrl).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});
