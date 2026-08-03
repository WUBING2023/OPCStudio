import { describe, it, expect } from "vitest";
import { tokenize, tokenOverlap, matchingTagCount } from "./textTokenize.js";

describe("tokenize — CJK 2-gram + 原词,ASCII 整词(P1#7)", () => {
  it("纯中文句子(无空格)产出多个重叠 2-gram,而不是整句一个 token", () => {
    const tokens = tokenize("写爬虫抓数据");
    expect(tokens).toContain("爬虫");
    expect(tokens).toContain("抓数"); // 相邻字的滑窗 2-gram
    expect(tokens.length).toBeGreaterThan(1); // 不是退化成一整句一个 token
  });

  it("英文/数字词按原样整词保留(长度 >=2),忽略长度 1 的碎片", () => {
    const tokens = tokenize("Run the sort test v2");
    expect(tokens).toContain("run");
    expect(tokens).toContain("sort");
    expect(tokens).toContain("test");
    expect(tokens).toContain("v2");
  });

  it("中英混排都能各自产出 token", () => {
    const tokens = tokenize("写个 python 爬虫脚本");
    expect(tokens).toContain("python");
    expect(tokens).toContain("爬虫");
  });

  it("空/undefined/null → 空数组,不抛错", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize(undefined)).toEqual([]);
    expect(tokenize(null)).toEqual([]);
  });
});

describe("tokenOverlap / matchingTagCount", () => {
  it("tokenOverlap:两段中文文本靠 token 重叠而非整句子串判定相关", () => {
    const goalTokens = new Set(tokenize("帮我写一个爬虫程序抓取新闻数据"));
    expect(tokenOverlap("写爬虫抓取数据要小心限速", goalTokens)).toBeGreaterThan(0);
    expect(tokenOverlap("画一张公司季度收入柱状图", goalTokens)).toBe(0);
  });

  it("matchingTagCount:按命中的 tag 个数计数(保留原有按 tag 求和的打分语义)", () => {
    const goalTokens = new Set(tokenize("写爬虫抓取数据"));
    expect(matchingTagCount(["爬虫相关经验", "不相关标签"], goalTokens)).toBe(1);
    expect(matchingTagCount(["爬虫", "抓取数据"], goalTokens)).toBe(2);
    expect(matchingTagCount(undefined, goalTokens)).toBe(0);
  });
});
