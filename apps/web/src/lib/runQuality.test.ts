import { describe, it, expect } from "vitest";
import type { TraceEvent } from "@opc/shared";
import { computeRunQuality } from "./runQuality.js";

let seq = 0;
function ev(type: TraceEvent["type"], payload: unknown, agentId?: string): TraceEvent {
  return { id: `q${++seq}`, runId: "r1", timestamp: "2026-01-01T00:00:00Z", type, agentId, payload } as TraceEvent;
}

// 从 ResultSection 抽出的共享口径(工作台群成果卡与任务档案同用)——锁住语义不被静默改动。
describe("computeRunQuality", () => {
  it("无信号:hasAnySignal=false 且 allClear=true(空集不报警也不夸好)", () => {
    const q = computeRunQuality([]);
    expect(q.hasAnySignal).toBe(false);
    expect(q.allClear).toBe(true);
  });

  it("全通过验证边 → allClear;有拒绝 → 非 allClear 且计数正确", () => {
    const pass = computeRunQuality([ev("verifier_result", { accept: true }), ev("verifier_result", { accept: true })]);
    expect(pass).toMatchObject({ verifyTotal: 2, verifyPassed: 2, allClear: true, hasAnySignal: true });
    const mixed = computeRunQuality([ev("verifier_result", { accept: true }), ev("verifier_result", { accept: false })]);
    expect(mixed).toMatchObject({ verifyTotal: 2, verifyPassed: 1, allClear: false });
  });

  it("merge_theirs:结构化文件入 mergeFiles(keptWorkerId 缺省回退 agentId),非结构化置 hasUnstructuredMergeConflict", () => {
    const q = computeRunQuality([
      ev("info", { kind: "merge_theirs", mergeConflictFile: { path: "a.ts", discardedWorkerId: "w1" } }, "keeper"),
      ev("info", { kind: "merge_theirs" }),
    ]);
    expect(q.mergeFiles).toEqual([{ path: "a.ts", discardedWorkerId: "w1", keptWorkerId: "keeper" }]);
    expect(q.hasUnstructuredMergeConflict).toBe(true);
    expect(q.allClear).toBe(false);
  });

  it("same_model_review / timeout_salvage 计数并破坏 allClear", () => {
    const q = computeRunQuality([
      ev("info", { kind: "same_model_review" }),
      ev("info", { kind: "timeout_salvage" }),
      ev("info", { kind: "timeout_salvage" }),
    ]);
    expect(q.sameModelCount).toBe(1);
    expect(q.salvageCount).toBe(2);
    expect(q.allClear).toBe(false);
    expect(q.hasAnySignal).toBe(true);
  });
});
