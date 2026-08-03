import { describe, it, expect } from "vitest";
import { estimateTaskComplexity, detectCodeSignals } from "./taskComplexityEstimator.js";

// E1 Complexity Estimator v1:纯规则、可解释。每个测试断言的 reason 都对应实现里一条真实规则。

describe("detectCodeSignals — 代码信号关键词", () => {
  it("中文代码关键词命中(代码/脚本/爬虫)", () => {
    const hits = detectCodeSignals("帮我写一个爬虫脚本抓数据");
    expect(hits).toContain("脚本");
    expect(hits).toContain("爬虫");
  });

  it("英文关键词按词边界匹配,api 不会误伤 rapid", () => {
    expect(detectCodeSignals("rapid growth of the market")).toEqual([]);
    expect(detectCodeSignals("call the api and store results")).toContain("api");
  });

  it("无信号文本返回空数组", () => {
    expect(detectCodeSignals("写一首关于春天的诗")).toEqual([]);
  });
});

describe("estimateTaskComplexity — 四档复杂度", () => {
  it("S 档:短文本、无任何信号 → S/low/0 级监督/1-2 分钟", () => {
    const est = estimateTaskComplexity({ goalText: "写一首关于春天的诗" });
    expect(est.complexity).toBe("S");
    expect(est.risk_level).toBe("low");
    expect(est.recommended_governance_level).toBe(0);
    expect(est.estimated_duration).toEqual({ min_minutes: 1, max_minutes: 2, confidence: "medium" });
    // reason 只应有"长度"这一条命中的规则,不许出现没命中的空话
    expect(est.reason).toHaveLength(1);
    expect(est.reason[0]).toContain("目标描述较短");
  });

  it("M 档:调研关键词 + 2 个 artifact → M/standard/1 级监督/3-8 分钟", () => {
    const est = estimateTaskComplexity({
      goalText: "调研国内三家新能源车企的近期销量情况",
      expectedArtifactCount: 2,
    });
    expect(est.complexity).toBe("M");
    expect(est.risk_level).toBe("standard");
    expect(est.recommended_governance_level).toBe(1);
    expect(est.estimated_duration.min_minutes).toBe(3);
    expect(est.estimated_duration.max_minutes).toBe(8);
    expect(est.reason.some(r => r.includes("调研/分析类关键词"))).toBe(true);
    expect(est.reason.some(r => r.includes("预计产出 2 个 artifact"))).toBe(true);
  });

  it("L 档:代码信号 + 3 个 artifact → L/elevated/2 级监督/8-20 分钟", () => {
    const est = estimateTaskComplexity({
      goalText: "帮我用 python 写一个爬虫脚本抓取新闻数据",
      expectedArtifactCount: 3,
    });
    expect(est.complexity).toBe("L");
    expect(est.risk_level).toBe("elevated");
    expect(est.recommended_governance_level).toBe(2);
    expect(est.estimated_duration.min_minutes).toBe(8);
    expect(est.estimated_duration.max_minutes).toBe(20);
    expect(est.estimated_duration.confidence).toBe("low");
    expect(est.reason.some(r => r.includes("涉及代码/文件改动") && r.includes("命中关键词"))).toBe(true);
    expect(est.reason.some(r => r.includes("预计产出 3 个 artifact"))).toBe(true);
  });

  it("XL 档:长文本+调研+代码+多 artifact+大公司+MCP+shell → XL/high/3 级/20-60 分钟,并建议拆分", () => {
    const longGoal = "开发一个完整的市场调研与分析平台,包括数据爬虫、后端接口、前端页面。".repeat(25); // >800 字
    const est = estimateTaskComplexity({
      goalText: longGoal,
      agentCount: 8,
      expectedArtifactCount: 5,
      involvesMcp: true,
      involvesShell: true,
    });
    expect(longGoal.trim().length).toBeGreaterThan(800);
    expect(est.complexity).toBe("XL");
    expect(est.risk_level).toBe("high");
    expect(est.recommended_governance_level).toBe(3);
    expect(est.estimated_duration.min_minutes).toBe(20);
    expect(est.estimated_duration.max_minutes).toBe(60);
    expect(est.reason.some(r => r.includes("建议拆分"))).toBe(true);
    expect(est.reason.some(r => r.includes("目标描述很长"))).toBe(true);
    expect(est.reason.some(r => r.includes("协调成本高"))).toBe(true);
  });
});

describe("estimateTaskComplexity — governance 升档规则", () => {
  it("涉及代码时监督等级至少 2(即使复杂度只有 M)", () => {
    const est = estimateTaskComplexity({ goalText: "修一下代码里的函数" });
    expect(est.complexity).toBe("M"); // 代码信号 +2 → M(基础监督 1)
    expect(est.recommended_governance_level).toBe(2);
    expect(est.reason.some(r => r.includes("涉及代码改动,监督等级升至 2"))).toBe(true);
  });

  it("涉及 MCP 时监督等级至少 2(S 档也强制抬)", () => {
    const est = estimateTaskComplexity({ goalText: "查一下今天的天气", involvesMcp: true });
    expect(est.complexity).toBe("S");
    expect(est.recommended_governance_level).toBe(2);
    expect(est.risk_level).toBe("elevated");
    expect(est.reason.some(r => r.includes("涉及 MCP,监督等级升至 2"))).toBe(true);
  });

  it("涉及 shell 时监督等级升至 3,风险 high", () => {
    const est = estimateTaskComplexity({ goalText: "整理一下桌面文件夹", involvesShell: true });
    expect(est.recommended_governance_level).toBe(3);
    expect(est.risk_level).toBe("high");
    expect(est.reason.some(r => r.includes("涉及 shell/文件系统,监督等级升至 3"))).toBe(true);
  });

  it("hasCodeSignals 显式传入 true 时,即使文本无关键词也按代码任务处理", () => {
    const est = estimateTaskComplexity({ goalText: "把那个东西改好", hasCodeSignals: true });
    expect(est.recommended_governance_level).toBe(2);
    expect(est.reason.some(r => r.includes("调用方标记"))).toBe(true);
  });
});

describe("estimateTaskComplexity — reason 与命中规则严格对应", () => {
  it("未命中的规则不产生 reason(无 shell/MCP/代码/调研的输入不出现相关文案)", () => {
    const est = estimateTaskComplexity({ goalText: "写一首关于春天的诗", agentCount: 2 });
    expect(est.reason.some(r => r.includes("shell"))).toBe(false);
    expect(est.reason.some(r => r.includes("MCP"))).toBe(false);
    expect(est.reason.some(r => r.includes("代码"))).toBe(false);
    expect(est.reason.some(r => r.includes("调研"))).toBe(false);
    expect(est.reason.some(r => r.includes("agent"))).toBe(false); // agentCount<4 不触发协作规则
  });

  it("agentCount>=4 触发协作 reason,>=8 触发协调成本 reason", () => {
    const a = estimateTaskComplexity({ goalText: "写一首诗", agentCount: 4 });
    expect(a.reason.some(r => r.includes("多角色协作(4 名 agent)"))).toBe(true);
    const b = estimateTaskComplexity({ goalText: "写一首诗", agentCount: 9 });
    expect(b.reason.some(r => r.includes("公司规模较大(9 名 agent)"))).toBe(true);
  });
});

describe("estimateTaskComplexity — 历史耗时", () => {
  it("historyAvgMinutes 有值 → 时长围绕历史收窄,置信度 high,reason 记录历史依据", () => {
    const est = estimateTaskComplexity({ goalText: "写一首关于春天的诗", historyAvgMinutes: 5 });
    expect(est.estimated_duration.min_minutes).toBe(3);  // round(5*0.5)=3
    expect(est.estimated_duration.max_minutes).toBe(8);  // round(5*1.5)=8
    expect(est.estimated_duration.confidence).toBe("high");
    expect(est.reason.some(r => r.includes("历史同类任务平均 5 分钟完成"))).toBe(true);
  });

  it("historyAvgMinutes 非法值(0/负数)被忽略,不影响档位带宽", () => {
    const est = estimateTaskComplexity({ goalText: "写一首关于春天的诗", historyAvgMinutes: 0 });
    expect(est.estimated_duration).toEqual({ min_minutes: 1, max_minutes: 2, confidence: "medium" });
    expect(est.reason.some(r => r.includes("历史"))).toBe(false);
  });
});
