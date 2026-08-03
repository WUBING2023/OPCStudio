import { describe, it, expect } from "vitest";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "./inputIntegrity.js";

describe("inputIntegrity · checkTextIntegrity", () => {
  it("正常中文文本 → 放行", () => {
    const r = checkTextIntegrity("帮我写一份临时公司的季度财务简报,重点关注现金流。");
    expect(r.corrupted).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("正常英文文本 → 放行", () => {
    expect(checkTextIntegrity("Please draft a Q3 financial summary for the team.").corrupted).toBe(false);
  });

  it("连续大量 U+FFFD(真实事故复现:公司名/goal 在到达服务器前已被替换) → 拒绝", () => {
    const r = checkTextIntegrity("opc���������临时公司-0704b");
    expect(r.corrupted).toBe(true);
    expect(r.reason).toContain("连续");
  });

  it("偶发单个 U+FFFD(正常文本中恰好出现一个)→ 不误杀", () => {
    const r = checkTextIntegrity("这段文本里恰好有一个特殊符号 �,但其余内容都是正常的中文描述。");
    expect(r.corrupted).toBe(false);
  });

  it("偶发两个但不连续、且占比很低 → 不误杀", () => {
    const longText = "帮我写一份很长很长的报告".repeat(10) + "�" + "继续写完这份长报告的其余部分内容".repeat(5) + "�";
    const r = checkTextIntegrity(longText);
    expect(r.corrupted).toBe(false);
  });

  it("非连续但次数达到 3 且占比超过阈值 → 拒绝", () => {
    const r = checkTextIntegrity("短�文�本�损坏");
    expect(r.corrupted).toBe(true);
    expect(r.reason).toContain("占比");
  });

  it("恰好 2 个连续(未达到连续阈值 3)且总占比不高 → 不误杀", () => {
    const r = checkTextIntegrity("正常内容中间有两个连续符号��后面还有很多正常的中文文字内容");
    expect(r.corrupted).toBe(false);
  });

  it("恰好 3 个连续 → 命中连续阈值,拒绝", () => {
    const r = checkTextIntegrity("abc���def");
    expect(r.corrupted).toBe(true);
  });

  it("空字符串 → 不判定为损坏(交给上层 required 校验处理)", () => {
    expect(checkTextIntegrity("").corrupted).toBe(false);
  });

  it("非字符串输入 → 不抛错,视为未损坏", () => {
    expect(() => checkTextIntegrity(undefined as unknown as string)).not.toThrow();
    expect(checkTextIntegrity(undefined as unknown as string).corrupted).toBe(false);
    expect(checkTextIntegrity(null as unknown as string).corrupted).toBe(false);
  });

  it("整段全是替换字符(极端全损坏)→ 拒绝", () => {
    const r = checkTextIntegrity("�".repeat(20));
    expect(r.corrupted).toBe(true);
  });

  it("CORRUPTED_INPUT_ERROR 是给用户看的固定人话文案", () => {
    expect(CORRUPTED_INPUT_ERROR).toContain("乱码");
  });
});
