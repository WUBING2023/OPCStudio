// D2 · 结构化 run 结论抽取 + 「降级 run 不沉淀干净经验」门控谓词。
import { describe, it, expect } from "vitest";
import {
  extractStructuredConclusion,
  buildAuthoritativeCodingConclusionSource,
  extractRunConclusion,
  shouldPersistCleanExperience,
  shouldAutoCommitRunConclusion,
  decideRunConclusionDisposition,
} from "./extractRunConclusion.js";

describe("buildAuthoritativeCodingConclusionSource", () => {
  it("uses Core delivery and test evidence instead of contradictory model prose", () => {
    const source = buildAuthoritativeCodingConclusionSource({
      requiresCode: true,
      deliveryStatus: "independent_tests_passed",
      runStatus: "done",
      files: ["sum.js", "sum.test.js", "sum.js"],
      tests: [{ testedFile: "sum.test.js", command: "node sum.test.js", exitCode: 0, passed: true }],
    });
    expect(source).toContain("Delivery acceptance: independent_tests_passed");
    expect(source).toContain("Delivered files: sum.js, sum.test.js");
    expect(source).toContain("exit=0; passed=true");
  });

  it("does not replace research conclusions", () => {
    expect(buildAuthoritativeCodingConclusionSource({ requiresCode: false })).toBe("");
  });
});

describe("extractStructuredConclusion — 结构化三节", () => {
  const md = [
    "# 排序算法对比报告",
    "## 结论",
    "- 快排平均 O(n log n),最坏 O(n^2),不稳定",
    "- 归并排序稳定但需 O(n) 辅助空间",
    "- 小数组建议切换插入排序优化常数",
    "",
    "> ⚠️ 这行是降级 banner,不应成为要点",
    "<div>HTML 也不应成为要点</div>",
  ].join("\n");

  it("从 md 列表行提炼要点,渲染要点/复用条件两节;banner/HTML 被跳过", () => {
    const c = extractStructuredConclusion("写个排序算法对比", [], md, { taskType: "research", companyId: "c1" });
    expect(c.points.length).toBe(3);
    expect(c.points[0]).toContain("快排");
    expect(c.points.some((p) => p.includes("banner"))).toBe(false);
    expect(c.points.some((p) => p.includes("HTML"))).toBe(false);
    expect(c.text).toContain("[目标: 写个排序算法对比]");
    expect(c.text).toContain("## 要点");
    expect(c.text).toContain("## 复用条件");
    expect(c.reuseConditions.some((r) => r.includes("research"))).toBe(true);
    expect(c.reuseConditions.some((r) => r.includes("c1"))).toBe(true);
    expect(c.reuseConditions.some((r) => r.includes("非降级"))).toBe(true);
  });

  it("要点封顶 6 条,各 ≤160 字(替代旧 1200 前缀截断)", () => {
    const many = Array.from({ length: 10 }, (_, i) => `- 要点${i} ${"字".repeat(200)}`).join("\n");
    const c = extractStructuredConclusion("g", [], many);
    expect(c.points.length).toBe(6);
    for (const p of c.points) expect(p.length).toBeLessThanOrEqual(160);
  });

  it("latin 长要点在词边界裁剪 —— 词中断绝迹(末尾是完整单词)", () => {
    const longLatin = "- " + "alpha beta gamma delta ".repeat(20);
    const c = extractStructuredConclusion("g", [], longLatin);
    const p = c.points[0];
    expect(p.length).toBeLessThanOrEqual(160);
    expect(p.endsWith(" ")).toBe(false);
    const words = p.split(" ");
    expect(["alpha", "beta", "gamma", "delta"]).toContain(words[words.length - 1]); // 末词未被切断
  });

  it("教训节由 deferred / degradedReason 派生", () => {
    const c = extractStructuredConclusion("g", [], "- 有效要点内容一二三四", {
      degradedReason: "worker 全失败,web 兜底也失败",
      deferred: [{ agentId: "w1", goal: "抓取行情数据", reason: "timeout" }],
    });
    expect(c.text).toContain("## 教训");
    expect(c.lessons.some((l) => l.includes("降级") && l.includes("worker 全失败"))).toBe(true);
    expect(c.lessons.some((l) => l.includes("未完成") && l.includes("w1"))).toBe(true);
  });

  it("无实质要点 → 空结论(text=\"\",callers 仍按 length>0 门控)", () => {
    expect(extractStructuredConclusion("g", [], "").text).toBe("");
    expect(extractStructuredConclusion("g", [""], "   ").points).toHaveLength(0);
    // 纯 banner/HTML,无真要点 → 空
    expect(extractStructuredConclusion("g", [], "> banner\n<div>x</div>").text).toBe("");
  });

  it("句子兜底:无 markdown 结构时按句读切要点", () => {
    const prose = "第一句结论很重要。第二句也不错。第三句作为补充说明。";
    const c = extractStructuredConclusion("g", [prose.repeat(5)], "");
    expect(c.points.length).toBeGreaterThanOrEqual(1);
    expect(c.points[0]).toContain("第一句");
  });

  it("backward-compat 包装:extractRunConclusion 返回渲染文本字符串", () => {
    const s = extractRunConclusion("g", [], "- 有效要点内容一二三四");
    expect(typeof s).toBe("string");
    expect(s).toContain("## 要点");
    expect(extractRunConclusion("g", [], "")).toBe("");
  });
});

describe("门控谓词 — 降级 run 不沉淀干净经验", () => {
  it("shouldPersistCleanExperience:仅 run 未降级 && 无 executor 降级信号 → true", () => {
    expect(shouldPersistCleanExperience({ degraded: false }, false)).toBe(true);
    expect(shouldPersistCleanExperience({ degraded: true }, false)).toBe(false);
    expect(shouldPersistCleanExperience({ degraded: false }, true)).toBe(false); // executor 降级 → 不沉淀
    expect(shouldPersistCleanExperience({}, false)).toBe(true);                    // 未定义 degraded 视为未降级
  });

  it("shouldAutoCommitRunConclusion:高风险/降级/executor降级/开关关 任一 → 不自动 commit", () => {
    const base = { highRisk: false, degraded: false, executorDegraded: false, autoCommitEnabled: true };
    expect(shouldAutoCommitRunConclusion(base)).toBe(true); // clean run 现状:自动 commit
    expect(shouldAutoCommitRunConclusion({ ...base, executorDegraded: true })).toBe(false);
    expect(shouldAutoCommitRunConclusion({ ...base, degraded: true })).toBe(false);
    expect(shouldAutoCommitRunConclusion({ ...base, highRisk: true })).toBe(false);
    expect(shouldAutoCommitRunConclusion({ ...base, autoCommitEnabled: false })).toBe(false);
  });

  it("triages only trustworthy conclusions into auto-commit or human review", () => {
    const base = {
      deliveryVerified: true, partial: false, subsetOk: true,
      highRisk: false, degraded: false, executorDegraded: false, autoCommitEnabled: true,
    };
    expect(decideRunConclusionDisposition(base)).toBe("auto_commit");
    expect(decideRunConclusionDisposition({ ...base, highRisk: true })).toBe("review");
    expect(decideRunConclusionDisposition({ ...base, autoCommitEnabled: false })).toBe("review");
    expect(decideRunConclusionDisposition({ ...base, deliveryVerified: false })).toBe("archive");
    expect(decideRunConclusionDisposition({ ...base, partial: true })).toBe("archive");
    expect(decideRunConclusionDisposition({ ...base, subsetOk: false })).toBe("archive");
    expect(decideRunConclusionDisposition({ ...base, degraded: true })).toBe("archive");
  });});
