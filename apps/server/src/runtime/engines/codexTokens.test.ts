import { describe, it, expect } from "vitest";
import { parseCodexJson } from "./CodexEngine.js";

// P2#14：codex 的 turn.completed 按每轮报告用量(非累计总量)，多轮任务(工具调用往返多次)会
// 出现多条 usage 事件，之前用 `=` 覆盖导致只保留最后一轮、前面的 token 消耗全部丢失。
describe("parseCodexJson — 多轮 usage 累加", () => {
  it("多个 turn.completed 事件的 token 应累加，而非被最后一轮覆盖", () => {
    const lines = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, output_tokens: 20 } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "working..." } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 50, output_tokens: 10 } }),
    ].join("\n");
    const p = parseCodexJson(lines);
    expect(p.inputTokens).toBe(150);
    expect(p.outputTokens).toBe(30);
  });

  it("单轮任务行为不变", () => {
    const lines = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 42, output_tokens: 7 } });
    const p = parseCodexJson(lines);
    expect(p.inputTokens).toBe(42);
    expect(p.outputTokens).toBe(7);
  });
});
