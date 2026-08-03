import { describe, it, expect } from "vitest";
import {
  buildContractMessage,
  isContractMessage,
  isAllowedTransition,
  ALLOWED_TRANSITIONS,
} from "./contractMessage.js";
import type { ContractMessage, ContractMessageType } from "./contractMessage.js";

// 辅助：最小合法消息
const base = (): Omit<ContractMessage, "id"> => ({
  runId: "run-abc123",
  from: "researcher",
  to: "fact_checker",
  type: "review_request",
  summary: "请评审我的研究结果",
});

describe("buildContractMessage — 工厂", () => {
  it("生成含自增 id 的消息", () => {
    const msg = buildContractMessage(base());
    expect(msg.id).toMatch(/^cm-run-ab-\d+$/);
    expect(msg.runId).toBe("run-abc123");
    expect(msg.type).toBe("review_request");
    expect(msg.summary).toBe("请评审我的研究结果");
  });

  it("显式传入 id 时保留原 id", () => {
    const msg = buildContractMessage({ ...base(), id: "my-id-1" });
    expect(msg.id).toBe("my-id-1");
  });

  it("连续调用 id 递增（唯一性）", () => {
    const a = buildContractMessage(base());
    const b = buildContractMessage(base());
    expect(a.id).not.toBe(b.id);
  });

  it("可选字段存在时被保留", () => {
    const msg = buildContractMessage({
      ...base(),
      artifactRefs: ["art-001", "art-002"],
      unresolvedQuestions: ["数据来源是否可信?"],
      deadlineHintMs: 30_000,
    });
    expect(msg.artifactRefs).toEqual(["art-001", "art-002"]);
    expect(msg.unresolvedQuestions).toEqual(["数据来源是否可信?"]);
    expect(msg.deadlineHintMs).toBe(30_000);
  });

  it("可选字段缺省时不出现在对象上", () => {
    const msg = buildContractMessage(base());
    expect("artifactRefs" in msg).toBe(false);
    expect("unresolvedQuestions" in msg).toBe(false);
    expect("deadlineHintMs" in msg).toBe(false);
  });

  it("所有七种 type 都可构造", () => {
    const types: ContractMessageType[] = [
      "review_request", "review_result", "artifact_request",
      "artifact_response", "handoff", "blocker", "revision_request",
    ];
    for (const type of types) {
      const msg = buildContractMessage({ ...base(), type });
      expect(msg.type).toBe(type);
    }
  });
});

describe("isContractMessage — 类型守卫", () => {
  it("合法消息返回 true", () => {
    const msg = buildContractMessage(base());
    expect(isContractMessage(msg)).toBe(true);
  });

  it("null/undefined/原始值返回 false", () => {
    expect(isContractMessage(null)).toBe(false);
    expect(isContractMessage(undefined)).toBe(false);
    expect(isContractMessage("string")).toBe(false);
    expect(isContractMessage(42)).toBe(false);
  });

  it("缺少必填字段返回 false", () => {
    const { summary: _s, ...noSummary } = buildContractMessage(base());
    expect(isContractMessage(noSummary)).toBe(false);

    const { type: _t, ...noType } = buildContractMessage(base());
    expect(isContractMessage(noType)).toBe(false);
  });

  it("非法 type 值返回 false", () => {
    const msg = { ...buildContractMessage(base()), type: "unknown_type" };
    expect(isContractMessage(msg)).toBe(false);
  });

  it("artifactRefs 含非字符串元素返回 false", () => {
    const msg = { ...buildContractMessage(base()), artifactRefs: [1, 2] };
    expect(isContractMessage(msg)).toBe(false);
  });

  it("deadlineHintMs 为字符串时返回 false", () => {
    const msg = { ...buildContractMessage(base()), deadlineHintMs: "fast" };
    expect(isContractMessage(msg)).toBe(false);
  });

  it("带合法可选字段的消息返回 true", () => {
    const msg = buildContractMessage({
      ...base(),
      artifactRefs: ["art-x"],
      unresolvedQuestions: ["待确认"],
      deadlineHintMs: 5000,
    });
    expect(isContractMessage(msg)).toBe(true);
  });
});

describe("ALLOWED_TRANSITIONS — 转换表完整性", () => {
  it("七种类型都有对应条目", () => {
    const types: ContractMessageType[] = [
      "review_request", "review_result", "artifact_request",
      "artifact_response", "handoff", "blocker", "revision_request",
    ];
    for (const t of types) {
      expect(Array.isArray(ALLOWED_TRANSITIONS[t])).toBe(true);
      expect(ALLOWED_TRANSITIONS[t].length).toBeGreaterThan(0);
    }
  });

  it("所有目标类型本身也是合法类型", () => {
    const valid = new Set<string>([
      "review_request", "review_result", "artifact_request",
      "artifact_response", "handoff", "blocker", "revision_request",
    ]);
    for (const targets of Object.values(ALLOWED_TRANSITIONS)) {
      for (const t of targets) {
        expect(valid.has(t)).toBe(true);
      }
    }
  });
});

describe("isAllowedTransition — 转换合法性检查", () => {
  it("review_request 后合法接 review_result 或 blocker", () => {
    expect(isAllowedTransition("review_request", "review_result")).toBe(true);
    expect(isAllowedTransition("review_request", "blocker")).toBe(true);
  });

  it("review_request 后不合法接 handoff", () => {
    expect(isAllowedTransition("review_request", "handoff")).toBe(false);
  });

  it("review_result 后合法接 handoff 或 revision_request", () => {
    expect(isAllowedTransition("review_result", "handoff")).toBe(true);
    expect(isAllowedTransition("review_result", "revision_request")).toBe(true);
  });

  it("review_result 后不合法接 review_request", () => {
    expect(isAllowedTransition("review_result", "review_request")).toBe(false);
  });

  it("artifact_request → artifact_response | blocker", () => {
    expect(isAllowedTransition("artifact_request", "artifact_response")).toBe(true);
    expect(isAllowedTransition("artifact_request", "blocker")).toBe(true);
    expect(isAllowedTransition("artifact_request", "revision_request")).toBe(false);
  });

  it("artifact_response → review_request | handoff", () => {
    expect(isAllowedTransition("artifact_response", "review_request")).toBe(true);
    expect(isAllowedTransition("artifact_response", "handoff")).toBe(true);
    expect(isAllowedTransition("artifact_response", "blocker")).toBe(false);
  });

  it("handoff → review_request | artifact_request（下一阶段）", () => {
    expect(isAllowedTransition("handoff", "review_request")).toBe(true);
    expect(isAllowedTransition("handoff", "artifact_request")).toBe(true);
    expect(isAllowedTransition("handoff", "blocker")).toBe(false);
  });

  it("blocker → 只能接 revision_request", () => {
    expect(isAllowedTransition("blocker", "revision_request")).toBe(true);
    expect(isAllowedTransition("blocker", "review_result")).toBe(false);
    expect(isAllowedTransition("blocker", "handoff")).toBe(false);
  });

  it("revision_request → review_request | artifact_request（修订完重提交）", () => {
    expect(isAllowedTransition("revision_request", "review_request")).toBe(true);
    expect(isAllowedTransition("revision_request", "artifact_request")).toBe(true);
    expect(isAllowedTransition("revision_request", "handoff")).toBe(false);
  });

  it("典型研究链路：researcher→fact_checker→integrator 全路径合法", () => {
    // researcher 完成 → 请求 fact_checker 评审
    expect(isAllowedTransition("review_request", "review_result")).toBe(true);
    // fact_checker 要求修订
    expect(isAllowedTransition("review_result", "revision_request")).toBe(true);
    // researcher 修订后再次发起评审
    expect(isAllowedTransition("revision_request", "review_request")).toBe(true);
    // fact_checker 通过 → handoff 给 integrator
    expect(isAllowedTransition("review_result", "handoff")).toBe(true);
  });
});
