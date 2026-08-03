import { describe, it, expect } from "vitest";
import { goalToSlug, extractReportTitle } from "./projectStore.js";

// v8 P4：报告标题/slug 文本清洗（front-matter 跳过 / 空 goal 回退 / 段边界截断）。
describe("extractReportTitle — 跳过 YAML front-matter", () => {
  it("front-matter 后取首个有效行，不把 '---' 当标题", () => {
    expect(extractReportTitle("---\ntitle: x\ndate: 2026\n---\n# 真正的标题\n正文")).toBe("真正的标题");
  });
  it("无 front-matter 时取首行并去 # 前缀", () => {
    expect(extractReportTitle("## 报告标题\n内容")).toBe("报告标题");
  });
  it("空内容 → 空串", () => {
    expect(extractReportTitle("\n\n   \n")).toBe("");
  });
});

describe("goalToSlug — 空值回退与截断", () => {
  it("正常 goal 生成短横线 slug", () => {
    expect(goalToSlug("Build a login page")).toBe("build-a-login-page");
  });
  it("全部被过滤的 goal → 'report'（不产生 date_.md）", () => {
    expect(goalToSlug("!!! @@@ ###")).toBe("report");
  });
  it("不以连字符开头/结尾", () => {
    const s = goalToSlug("  hello   world  ");
    expect(s.startsWith("-")).toBe(false);
    expect(s.endsWith("-")).toBe(false);
  });
});
