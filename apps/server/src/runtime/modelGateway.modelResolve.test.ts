import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  callModel,
  registerProvider,
  createOpenAICompatProvider,
  createAnthropicProvider,
  setModelGatewayRoot,
  type ModelInput,
} from "./modelGateway.js";
import { ModelNotFoundError } from "./modelResolve.js";

const baseInput = (over: Partial<ModelInput>): ModelInput => ({
  agentId: "a1",
  provider: "anthropic",
  model: "sonnet",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 32,
  ...over,
});

describe("callModel · 执行面别名解析(裸别名不打 API)", () => {
  beforeEach(() => setModelGatewayRoot(fs.mkdtempSync(path.join(os.tmpdir(), "mg-resolve-"))));

  it("裸别名 sonnet 在派发前映射为 claude-sonnet-5(handler 收到 canonical,不是别名)", async () => {
    let seenModel = "";
    registerProvider("anthropic", async (input) => {
      seenModel = input.model;
      return { content: "ok", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0, latencyMs: 1 };
    });
    const rec = await callModel(baseInput({ provider: "anthropic", model: "sonnet" }));
    expect(seenModel).toBe("claude-sonnet-5"); // ← 根治:绝不把裸 "sonnet" 交给 API
    expect(rec.content).toBe("ok");
  });

  it("跨族误配(provider=deepseek + model=sonnet)在派发前拒绝:ModelNotFoundError,handler 从不被调", async () => {
    let called = false;
    registerProvider("deepseek", async () => { called = true; return { content: "", promptTokens: 0, completionTokens: 0, totalTokens: 0, estimatedCostUsd: 0, latencyMs: 1 }; });
    await expect(callModel(baseInput({ provider: "deepseek", model: "sonnet" }))).rejects.toBeInstanceOf(ModelNotFoundError);
    expect(called).toBe(false);
  });

  it("canonical / 未知自定义串照常放行到 handler", async () => {
    let seen = "";
    registerProvider("deepseek", async (input) => { seen = input.model; return { content: "x", promptTokens: 1, completionTokens: 1, totalTokens: 2, estimatedCostUsd: 0, latencyMs: 1 }; });
    await callModel(baseInput({ provider: "deepseek", model: "deepseek-future-9000" }));
    expect(seen).toBe("deepseek-future-9000");
  });
});

describe("provider handler · HTTP 404 model-not-found → 不可重试 ModelNotFoundError", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => setModelGatewayRoot(fs.mkdtempSync(path.join(os.tmpdir(), "mg-404-"))));
  afterEach(() => { globalThis.fetch = realFetch; });

  it("OpenAI 兼容端点 404 → ModelNotFoundError(而非泛 Error)", async () => {
    globalThis.fetch = (async () => new Response(`{"error":{"message":"model: sonnet not found"}}`, { status: 404 })) as typeof fetch;
    const handler = createOpenAICompatProvider("https://example.test/v1", "k", { allowLocalNetwork: true });
    await expect(handler(baseInput({ provider: "deepseek", model: "sonnet" }))).rejects.toBeInstanceOf(ModelNotFoundError);
  });

  it("OpenAI 兼容端点 429 → 普通 Error(留给瞬时重试,不误判模型不存在)", async () => {
    globalThis.fetch = (async () => new Response("rate limit", { status: 429 })) as typeof fetch;
    const handler = createOpenAICompatProvider("https://example.test/v1", "k", { allowLocalNetwork: true });
    // 单次退避重试后仍 429 → 抛普通 Error(非 ModelNotFoundError)
    await expect(handler(baseInput({ provider: "deepseek", model: "deepseek-chat" }))).rejects.not.toBeInstanceOf(ModelNotFoundError);
  }, 10000);

  it("Anthropic 端点 404 → ModelNotFoundError", async () => {
    globalThis.fetch = (async () => new Response(`{"type":"error","error":{"type":"not_found_error"}}`, { status: 404 })) as typeof fetch;
    const handler = createAnthropicProvider("k");
    await expect(handler(baseInput({ provider: "anthropic", model: "claude-nonexistent" }))).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});
