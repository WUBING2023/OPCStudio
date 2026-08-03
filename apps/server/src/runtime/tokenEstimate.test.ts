import { describe, it, expect, vi, afterEach } from "vitest";
import { estimateTokensFromText } from "./tokenEstimate.js";
import { createOpenAICompatProvider } from "./modelGateway.js";

describe("estimateTokensFromText", () => {
  it("≈ 字符数/4，空值安全", () => {
    expect(estimateTokensFromText("")).toBe(0);
    expect(estimateTokensFromText(undefined)).toBe(0);
    expect(estimateTokensFromText(null)).toBe(0);
    expect(estimateTokensFromText("a".repeat(40))).toBe(10);
  });
});

// v10 P1-7：provider 不返回 usage 时，token 不能静默归 0，须按文本估算。
describe("OpenAI-compat 无 usage → 文本估算兜底", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("无 usage 字段 → prompt/completion 估算为非零", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ choices: [{ message: { content: "hello world output text" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const handler = createOpenAICompatProvider("https://example/v1", "k", { allowLocalNetwork: true });
    const out = await handler({ agentId: "a", provider: "p", model: "m", messages: [{ role: "user", content: "a sufficiently long prompt text for estimation" }], maxTokens: 16 });
    expect(out.promptTokens).toBeGreaterThan(0);
    expect(out.completionTokens).toBeGreaterThan(0);
    expect(out.totalTokens).toBe(out.promptTokens + out.completionTokens);
  });
  it("有 usage → 用真实值，不估算", async () => {
    vi.stubGlobal("fetch", async () => new Response(
      JSON.stringify({ usage: { prompt_tokens: 123, completion_tokens: 45 }, choices: [{ message: { content: "x" } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const handler = createOpenAICompatProvider("https://example/v1", "k", { allowLocalNetwork: true });
    const out = await handler({ agentId: "a", provider: "p", model: "m", messages: [{ role: "user", content: "y" }], maxTokens: 16 });
    expect(out.promptTokens).toBe(123);
    expect(out.completionTokens).toBe(45);
  });
});
