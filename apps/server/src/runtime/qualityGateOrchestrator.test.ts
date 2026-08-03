import { describe, it, expect, beforeEach } from "vitest";
import {
  runQualityGateLayers,
  formatGateFailure,
  type QualityGateResultEventPayload,
} from "./qualityGateOrchestrator.js";
import { decideReview } from "./reviewCommit.js";
import type { ArtifactContract } from "./artifactContract.js";
import { emit, setRunId, getRunHistory } from "./eventBus.js";
import type { TraceEvent } from "@opc/shared";

// A5:三层(机械/结构/语义)统一聚合的单测。铁律:短路策略选定为"上层失败即不跑下层"，
// 各分支的 skipped/failedLayer 语义要精确可断言；L3 与 reviewCommit 四态的衔接必须逐态验证。

const okContract: ArtifactContract = {
  artifactType: "test",
  filePattern: "*.md",
  requiredSections: ["## Summary"],
  acceptanceCriteria: [],
  onFailure: "revise",
};

describe("A5 · runQualityGateLayers — L1 机械层", () => {
  it("空产出 → failedLayer=1,L2/L3 跳过且不计入失败", () => {
    const r = runQualityGateLayers({ content: "   " });
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(1);
    expect(r.layerResults).toHaveLength(3);
    expect(r.layerResults[0]).toMatchObject({ layer: 1, name: "mechanical", passed: false });
    expect(r.layerResults[1]).toMatchObject({ layer: 2, name: "structural", passed: true, skipped: true });
    expect(r.layerResults[2]).toMatchObject({ layer: 3, name: "semantic", passed: true, skipped: true });
    expect(r.overallReason).toBe(r.layerResults[0].reason);
  });

  it("result.json 非法 JSON → L1 失败,原因含 result.json 字样", () => {
    const r = runQualityGateLayers({ content: "# 正常报告正文", resultJson: "{not json" });
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(1);
    expect(r.overallReason).toMatch(/result\.json/);
  });

  it("result.json 合法 JSON → 不拖累 L1(继续往下层走)", () => {
    const r = runQualityGateLayers({ content: "# 正常报告正文", resultJson: '{"ok":true}' });
    expect(r.layerResults[0]).toMatchObject({ layer: 1, passed: true });
  });
});

describe("A5 · runQualityGateLayers — L2 结构层", () => {
  it("未提供 artifactContract → L2 视为未配置,跳过但不失败", () => {
    const r = runQualityGateLayers({ content: "# 正文,无契约" });
    expect(r.passed).toBe(true);
    expect(r.layerResults[1]).toMatchObject({ layer: 2, passed: true, skipped: true });
  });

  it("提供的契约未通过 → failedLayer=2,L3 跳过", () => {
    const r = runQualityGateLayers({ content: "正文缺少必要段落", artifactContract: okContract });
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(2);
    expect(r.layerResults[1]).toMatchObject({ layer: 2, passed: false });
    expect(r.layerResults[2]).toMatchObject({ layer: 3, passed: true, skipped: true, reason: "跳过:L2 未通过" });
  });

  it("契约通过 → 继续往 L3 走(不因契约通过就整体判定 passed,还要看 L3)", () => {
    const r = runQualityGateLayers({
      content: "## Summary\n达标正文",
      artifactContract: okContract,
      reviewDecision: decideReview({ accept: false }),
    });
    expect(r.layerResults[1]).toMatchObject({ layer: 2, passed: true });
    expect(r.passed).toBe(false); // L3 拒绝拖垮整体
    expect(r.failedLayer).toBe(3);
  });
});

describe("A5 · runQualityGateLayers — L3 语义层与 reviewCommit 四态衔接", () => {
  it("未提供 reviewDecision → L3 视为未接语义审查,跳过但不失败", () => {
    const r = runQualityGateLayers({ content: "## Summary\n正文", artifactContract: okContract });
    expect(r.passed).toBe(true);
    expect(r.layerResults[2]).toMatchObject({ layer: 3, passed: true, skipped: true });
  });

  it("accepted(effect=pass) → L3 通过,整体通过", () => {
    const decision = decideReview({ accept: true, reason: "核查通过" });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(r.layerResults[2]).toMatchObject({ layer: 3, passed: true, details: decision });
    expect(r.passed).toBe(true);
    expect(r.overallReason).toBe("三层质量门全部通过");
  });

  it("needs_revision(effect=defer) → L3 失败,failedLayer=3", () => {
    const decision = decideReview({ accept: false, reason: "数据不实" });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(decision.status).toBe("needs_revision");
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(3);
    expect(r.overallReason).toBe("数据不实");
  });

  it("failed(attemptsExhausted,effect=defer) → L3 失败", () => {
    const decision = decideReview({ accept: false, attemptsExhausted: true, reason: "返工耗尽" });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(decision.status).toBe("failed");
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(3);
  });

  it("requires_human_review 但 effect=pass(verifier 解析失败+现状保守放行) → L3 仍判通过", () => {
    const decision = decideReview({ accept: true, parsed: false });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(decision.status).toBe("requires_human_review");
    expect(decision.effect).toBe("pass");
    expect(r.layerResults[2]).toMatchObject({ layer: 3, passed: true });
    expect(r.passed).toBe(true);
  });

  it("requires_human_review 且 effect=defer(verifier 执行异常) → L3 判失败", () => {
    const decision = decideReview({ accept: false, verifierErrored: true, reason: "verifier 执行失败" });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(decision.status).toBe("requires_human_review");
    expect(decision.effect).toBe("defer");
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(3);
  });
});

describe("A5 · runQualityGateLayers — 全通过", () => {
  it("三层都通过(含跳过)→ overallReason 固定文案,failedLayer 不设", () => {
    const r = runQualityGateLayers({
      content: "## Summary\n完整正文",
      artifactContract: okContract,
      reviewDecision: decideReview({ accept: true }),
    });
    expect(r.passed).toBe(true);
    expect(r.failedLayer).toBeUndefined();
    expect(r.overallReason).toBe("三层质量门全部通过");
    expect(r.layerResults.every(l => l.passed)).toBe(true);
  });
});

// 结构化事件:quality_gate_result 经真实 eventBus 落 RunHistory(同 reviewCommit.test.ts 的 e2e 模式)。
// 顺带验证 packages/shared 的 TraceEvent.type 联合类型确已收纳 "quality_gate_result"(编译期保证)。
describe("A5 · quality_gate_result 结构化事件(端到端,真实 eventBus)", () => {
  beforeEach(() => setRunId("test-run-quality-gate-result"));

  it("payload 形状:三层聚合结果 + 调用方上下文(producer/stage/method/verifierId)", () => {
    const before = getRunHistory().length;
    const layers = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decideReview({ accept: true }) });
    const payload: QualityGateResultEventPayload = {
      ...layers,
      producer: "worker-1",
      stage: "cross_verify",
      method: "llm-review",
      verifierId: "reviewer-1",
    };
    const eventType: TraceEvent["type"] = "quality_gate_result"; // 编译期证明该 type 合法
    emit(eventType, "reviewer-1", payload);

    const events = getRunHistory().getEvents();
    expect(events.length).toBe(before + 1);
    const last = events.at(-1)!;
    expect(last.type).toBe("quality_gate_result");
    expect(last.agentId).toBe("reviewer-1");
    expect(last.payload).toMatchObject({
      passed: true,
      producer: "worker-1",
      stage: "cross_verify",
      method: "llm-review",
      verifierId: "reviewer-1",
    });
    expect((last.payload as unknown as QualityGateResultEventPayload).layerResults).toHaveLength(3);
  });

  it("失败场景的 payload 含 failedLayer 与逐层 layerResults", () => {
    const layers = runQualityGateLayers({ content: "" });
    emit("quality_gate_result", "worker-2", { ...layers, producer: "worker-2", stage: "admission" });
    const last = getRunHistory().getEvents().at(-1)!;
    expect(last.payload).toMatchObject({ passed: false, failedLayer: 1, stage: "admission" });
  });
});

// E3→A5 合流点:governance level 决定 gate 强度。undefined/L0/L1 与旧行为逐字节一致;
// L2/L3 在机械层追加"最低实质长度"确定性强化(高监督 run 不允许 "ok"/"done" 式空转产出)。
describe("E3→A5 · runQualityGateLayers — governanceLevel 强度", () => {
  const shortContent = "# 短产出"; // 非空但去空白后 <20 字

  it("未传 governanceLevel(旧调用点)→ 行为不变,短产出照常通过", () => {
    const r = runQualityGateLayers({ content: shortContent });
    expect(r.passed).toBe(true);
    expect(r.governanceLevel).toBeUndefined();
  });

  it("L0/L1 → 与旧行为一致,只回显 level", () => {
    for (const level of ["L0", "L1"] as const) {
      const r = runQualityGateLayers({ content: shortContent, governanceLevel: level });
      expect(r.passed).toBe(true);
      expect(r.governanceLevel).toBe(level);
    }
  });

  it("L2 → 实质内容过短的产出被机械层强化门拦下", () => {
    const r = runQualityGateLayers({ content: shortContent, governanceLevel: "L2" });
    expect(r.passed).toBe(false);
    expect(r.failedLayer).toBe(1);
    expect(r.overallReason).toContain("governance L2 强化门");
    expect(r.governanceLevel).toBe("L2");
  });

  it("L3 → 同强化门;足量正文照常通过并回显 level", () => {
    expect(runQualityGateLayers({ content: shortContent, governanceLevel: "L3" }).passed).toBe(false);
    const ok = runQualityGateLayers({ content: "## Summary\n这是一份长度足够的正常交付正文,包含实质内容。", governanceLevel: "L3" });
    expect(ok.passed).toBe(true);
    expect(ok.governanceLevel).toBe("L3");
  });

  it("空产出在任何 level 下都仍先命中原有『产出为空』判定(强化门不改旧失败面)", () => {
    const r = runQualityGateLayers({ content: "  ", governanceLevel: "L3" });
    expect(r.passed).toBe(false);
    expect(r.overallReason).toBe("产出为空");
  });

  it("P0:验证者(isVerifier)在 L2/L3 下豁免 min-chars——短测试摘要照常通过(有效性由 TestEvidence 判)", () => {
    const rVerifier = runQualityGateLayers({ content: "ALL_TESTS_PASSED", governanceLevel: "L3", isVerifier: true });
    expect(rVerifier.passed).toBe(true); // 验证者短输出不被 min-chars 拦(否则测试进不了执行,run 假失败)
    const rProducer = runQualityGateLayers({ content: "ALL_TESTS_PASSED", governanceLevel: "L3", isVerifier: false });
    expect(rProducer.passed).toBe(false); // 生产者同样短输出仍受 min-chars 约束(高监督不允许空转)
    expect(rProducer.overallReason).toContain("强化门");
  });
});

// 复检修正(d):占位文案/deferred.lastError/agent_deferred 事件引用结构化 layerResults 的失败层,
// 不再只截一句 overallReason——formatGateFailure 是这条口径的唯一格式化入口。
describe("formatGateFailure — 从 layerResults 定位失败层", () => {
  it("L1 失败 → 'L1 机械层未通过: <该层 reason>'", () => {
    const r = runQualityGateLayers({ content: "   " });
    expect(formatGateFailure(r)).toBe(`L1 机械层未通过: ${r.layerResults[0].reason}`);
  });

  it("L2 失败 → 'L2 结构层未通过: <该层 reason>'(不误报被短路跳过的层)", () => {
    const r = runQualityGateLayers({ content: "正文缺少必要段落", artifactContract: okContract });
    expect(formatGateFailure(r)).toBe(`L2 结构层未通过: ${r.layerResults[1].reason}`);
    expect(formatGateFailure(r)).not.toContain("跳过");
  });

  it("L3 失败 → 'L3 语义层未通过: <该层 reason>'", () => {
    const decision = decideReview({ accept: false, reason: "断言与来源矛盾" });
    const r = runQualityGateLayers({ content: "## Summary\n正文", reviewDecision: decision });
    expect(r.failedLayer).toBe(3);
    expect(formatGateFailure(r)).toBe(`L3 语义层未通过: ${r.layerResults[2].reason}`);
  });

  it("全部通过 → 原样返回 overallReason", () => {
    const r = runQualityGateLayers({ content: "## Summary\n正文", artifactContract: okContract });
    expect(r.passed).toBe(true);
    expect(formatGateFailure(r)).toBe(r.overallReason);
  });
});
