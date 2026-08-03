import { describe, it, expect } from "vitest";
import { composeSystemPrompt, getRolePrompt, ROLE_PROMPTS } from "./prompts.js";

describe("C8 · composeSystemPrompt(一等 systemPrompt 基底 + 格式指令段不丢)", () => {
  it("未设自定义 prompt → 逐字返回 getRolePrompt(role)(行为不变)", () => {
    expect(composeSystemPrompt("ceo")).toBe(getRolePrompt("ceo"));
    expect(composeSystemPrompt("dev", "")).toBe(getRolePrompt("dev"));
    expect(composeSystemPrompt("dev", "   ")).toBe(getRolePrompt("dev"));
  });

  it("设了自定义 prompt → 人设在前、role 格式指令段在后(机器解析契约不丢)", () => {
    const out = composeSystemPrompt("ceo", "你是一家精品设计工作室的创始人,风格极简。");
    expect(out.startsWith("你是一家精品设计工作室的创始人")).toBe(true);
    // ceo 的 ## PLAN / ## LEAD / DIRECT_ANSWER 机器解析格式必须仍在
    expect(out).toContain("## PLAN");
    expect(out).toContain("## LEAD:");
    expect(out).toContain("DIRECT_ANSWER:");
    expect(out).toContain(ROLE_PROMPTS.ceo);
  });

  it("lead 的 dispatch 行格式指令在自定义 prompt 下仍保留", () => {
    const out = composeSystemPrompt("lead", "你带一支只有两人的小团队。");
    expect(out).toContain("- <workerId>: <specific task>");
  });
});
