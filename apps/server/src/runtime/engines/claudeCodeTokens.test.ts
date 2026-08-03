import { describe, it, expect } from "vitest";
import { parseStreamJson } from "./ClaudeCodeEngine.js";

// v10 P0-3：claude stream-json 的 input_tokens 不含缓存命中，须并入 cache_read/cache_creation，
// 否则大 prompt 被严重低估（实测 4142 vs 真实 26193）。
describe("parseStreamJson — 缓存 token 计入 prompt", () => {
  it("result 事件三段求和(input+cache_read+cache_creation)，覆盖而非叠加 assistant", () => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } } }),
      JSON.stringify({ type: "result", result: "done", usage: { input_tokens: 4142, cache_read_input_tokens: 19662, cache_creation_input_tokens: 2389, output_tokens: 5 }, total_cost_usd: 0.05 }),
    ].join("\n");
    const p = parseStreamJson(lines);
    expect(p.inputTokens).toBe(4142 + 19662 + 2389); // 26193 — result 覆盖且含缓存
    expect(p.outputTokens).toBe(5);
    expect(p.content).toBe("done");
  });

  it("无 result 事件 → assistant 累加(含缓存)", () => {
    const lines = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x" }], usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 3 } } });
    const p = parseStreamJson(lines);
    expect(p.inputTokens).toBe(115); // 10+100+5
    expect(p.outputTokens).toBe(3);
  });

  it("无缓存字段时退化为 input_tokens（向后兼容）", () => {
    const lines = JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 50, output_tokens: 7 } });
    const p = parseStreamJson(lines);
    expect(p.inputTokens).toBe(50);
    expect(p.outputTokens).toBe(7);
  });
});
