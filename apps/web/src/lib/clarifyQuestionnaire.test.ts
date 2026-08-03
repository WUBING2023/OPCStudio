import { describe, it, expect } from "vitest";
import {
  type ClarifyQuestionInput, type ClarifyAnswers,
  questionCount, clampIndex, isAnswered, answeredCount, unansweredIndices,
  allAnswered, canSubmit, canGoNext, canGoPrev, formatAnswersSummary,
} from "./clarifyQuestionnaire.js";

const QS: ClarifyQuestionInput[] = [
  { question: "用什么框架?", options: ["React", "Vue"] },
  { question: "要不要 SSR?", options: ["要", "不要"] },
  { question: "部署到哪?", options: ["Vercel", "自建"], allowFree: true },
];

describe("clarifyQuestionnaire · 纯状态机", () => {
  it("questionCount / clampIndex 边界", () => {
    expect(questionCount(QS)).toBe(3);
    expect(clampIndex(-5, 3)).toBe(0);
    expect(clampIndex(0, 3)).toBe(0);
    expect(clampIndex(2, 3)).toBe(2);
    expect(clampIndex(9, 3)).toBe(2);
    expect(clampIndex(0, 0)).toBe(0); // 无题不炸
  });

  it("isAnswered:非空白才算已答", () => {
    expect(isAnswered({}, 0)).toBe(false);
    expect(isAnswered({ 0: "" }, 0)).toBe(false);
    expect(isAnswered({ 0: "   " }, 0)).toBe(false); // 自由输入清空
    expect(isAnswered({ 0: "React" }, 0)).toBe(true);
    expect(isAnswered({ 1: "要" }, 0)).toBe(false); // 别的题答了不算这题
  });

  it("answeredCount / unansweredIndices", () => {
    const a: ClarifyAnswers = { 0: "React" };
    expect(answeredCount(QS, a)).toBe(1);
    expect(unansweredIndices(QS, a)).toEqual([1, 2]);
    expect(unansweredIndices(QS, {})).toEqual([0, 1, 2]);
    expect(unansweredIndices(QS, { 0: "React", 1: "要", 2: "Vercel" })).toEqual([]);
  });

  it("allAnswered / canSubmit:全部必答", () => {
    expect(allAnswered(QS, {})).toBe(false);
    expect(allAnswered(QS, { 0: "React", 1: "要" })).toBe(false); // 差一题
    expect(allAnswered(QS, { 0: "React", 1: "要", 2: "自建方案" })).toBe(true);
    expect(canSubmit(QS, { 0: "React", 1: "要", 2: "自建方案" })).toBe(true);
    expect(canSubmit(QS, { 0: "React", 1: "要" })).toBe(false);
    expect(allAnswered([], {})).toBe(false); // 无题不可提交
  });

  it("canGoNext / canGoPrev:分页边界", () => {
    expect(canGoPrev(0)).toBe(false);
    expect(canGoPrev(1)).toBe(true);
    expect(canGoNext(0, 3)).toBe(true);
    expect(canGoNext(1, 3)).toBe(true);
    expect(canGoNext(2, 3)).toBe(false); // 最后一题没有下一题
    expect(canGoNext(0, 1)).toBe(false); // 只有一题
  });

  it("formatAnswersSummary:一次性汇总成一条消息", () => {
    const a: ClarifyAnswers = { 0: "React", 1: "不要", 2: "  自建  " };
    expect(formatAnswersSummary(QS, a)).toBe(
      "1. 用什么框架? → React\n" +
      "2. 要不要 SSR? → 不要\n" +
      "3. 部署到哪? → 自建", // 首尾空白被 trim
    );
  });

  it("formatAnswersSummary:未答题留空占位(不崩)", () => {
    expect(formatAnswersSummary([{ question: "Q", options: ["a"] }], {})).toBe("1. Q → ");
  });
});
