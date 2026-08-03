import { describe, it, expect } from "vitest";
import { summarizeArm, comparisonMarkdown, opcNetBetter, type ArmRunResult } from "./valueEval.js";

// 阶段2 · 价值评测聚合逻辑单测(纯逻辑,不需真付费 run)。真实派发+抽字段由 scripts 侧 runner 做。
function r(over: Partial<ArmRunResult>): ArmRunResult {
  return {
    arm: "opc-company", taskId: "t1", repeat: 1, runId: "run-1",
    verified: true, cost: 0.01, tokens: 1000, durationMs: 5000, deferred: 0, degraded: false, humanInterventions: 0,
    ...over,
  };
}

describe("valueEval · summarizeArm", () => {
  it("空输入抛错(不静默造 0 成功假象)", () => {
    expect(() => summarizeArm([])).toThrow();
  });

  it("混入不同 arm/taskId 抛错", () => {
    expect(() => summarizeArm([r({}), r({ arm: "single-agent" })])).toThrow();
    expect(() => summarizeArm([r({}), r({ taskId: "t2" })])).toThrow();
  });

  it("成功率=机器可验 verified 计数/N;成本方差反映稳定性", () => {
    const s = summarizeArm([
      r({ repeat: 1, verified: true, cost: 0.02, tokens: 2000, durationMs: 4000 }),
      r({ repeat: 2, verified: false, cost: 0.04, tokens: 3000, durationMs: 6000, degraded: true, deferred: 1, humanInterventions: 2 }),
    ]);
    expect(s.n).toBe(2);
    expect(s.verifiedCount).toBe(1);
    expect(s.successRate).toBe(0.5);
    expect(s.avgCost).toBeCloseTo(0.03, 6);
    expect(s.avgTokens).toBe(2500);
    expect(s.avgDurationMs).toBe(5000);
    expect(s.degradedCount).toBe(1);
    expect(s.deferredTotal).toBe(1);
    expect(s.humanInterventionsTotal).toBe(2);
    expect(s.costVariance).toBeGreaterThan(0);
    expect(s.evidenceNote).toContain("初步证据");
  });

  it("N<3 一律标初步证据(禁宣传普遍优于)", () => {
    const s = summarizeArm([r({}), r({ repeat: 2 })]);
    expect(s.evidenceNote).toContain("初步证据");
  });
});

describe("valueEval · comparisonMarkdown", () => {
  it("生成含两臂的对照表 + 诚实声明", () => {
    const single = summarizeArm([r({ arm: "single-agent", verified: true, cost: 0.05 }), r({ arm: "single-agent", repeat: 2, verified: false, cost: 0.05 })]);
    const opc = summarizeArm([r({ verified: true, cost: 0.02 }), r({ repeat: 2, verified: true, cost: 0.02 })]);
    const md = comparisonMarkdown([single, opc]);
    expect(md).toContain("single-agent");
    expect(md).toContain("opc-company");
    expect(md).toContain("初步证据");
    expect(md).toContain("| t1 |");
  });
});

describe("valueEval · opcNetBetter(诚实口径:更贵更慢无净收益不算优)", () => {
  const single = (over: Partial<ArmRunResult>) => summarizeArm([r({ arm: "single-agent", ...over }), r({ arm: "single-agent", repeat: 2, ...over })]);
  const opc = (over: Partial<ArmRunResult>) => summarizeArm([r({ ...over }), r({ repeat: 2, ...over })]);

  it("OPC 成功率更高 → 净优", () => {
    const s = summarizeArm([r({ arm: "single-agent", verified: false }), r({ arm: "single-agent", repeat: 2, verified: false })]);
    const o = summarizeArm([r({ verified: true }), r({ repeat: 2, verified: true })]);
    expect(opcNetBetter(s, o).better).toBe(true);
  });

  it("成功率持平但 OPC 更贵 → 不算净优(禁美化)", () => {
    const s = single({ verified: true, cost: 0.01 });
    const o = opc({ verified: true, cost: 0.10 });
    const v = opcNetBetter(s, o);
    expect(v.better).toBe(false);
    expect(v.reason).toContain("无净收益");
  });

  it("成功率持平但 OPC 更便宜 → 净优", () => {
    const s = single({ verified: true, cost: 0.10 });
    const o = opc({ verified: true, cost: 0.02 });
    expect(opcNetBetter(s, o).better).toBe(true);
  });

  it("OPC 成功率更低 → 不算净优", () => {
    const s = single({ verified: true });
    const o = summarizeArm([r({ verified: false }), r({ repeat: 2, verified: false })]);
    expect(opcNetBetter(s, o).better).toBe(false);
  });
});
