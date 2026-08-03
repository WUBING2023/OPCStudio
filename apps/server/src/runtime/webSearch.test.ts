import { describe, it, expect } from "vitest";
import { extractQuery } from "./webSearch.js";

// W2 修复:buildWebBrief 的 query 不能拿整段"深度研究任务请联网检索…"元指令去搜(会搜到 SKILL.md 之类垃圾),
// 要剥掉元指令前缀、用真问题。下面锁住这个行为。
describe("extractQuery(W2)", () => {
  it("剥掉元指令前缀,取真问题段", () => {
    const raw = "深度研究任务(请联网多源检索,综合成一份准确、全面、有引用的研究报告;务必把任务派给研究团队检索分析,不要凭记忆直接作答):\n\nThere's been a lot of talk about how quantum computing will impact drug discovery, cryptography, and optimization.";
    const q = extractQuery(raw);
    expect(q).toContain("quantum computing");
    expect(q).not.toContain("深度研究任务");
    expect(q).not.toContain("请联网");
  });

  it("无元指令的普通问题原样返回(去多余空白)", () => {
    const q = extractQuery("Quick Sort 对比 Merge Sort 的时间复杂度");
    expect(q).toBe("Quick Sort 对比 Merge Sort 的时间复杂度");
  });

  it("多段时取最长的实质段", () => {
    const raw = "请联网检索:\n\n短\n\n这是一段明显更长的真实问题,应当被选为检索 query 用于搜索";
    const q = extractQuery(raw);
    expect(q).toContain("更长的真实问题");
  });

  it("截断到 240 字以内", () => {
    const q = extractQuery("x".repeat(500));
    expect(q.length).toBeLessThanOrEqual(240);
  });

  it("空输入返回空串", () => {
    expect(extractQuery("")).toBe("");
  });
});
