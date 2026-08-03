import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TraceEvent } from "@opc/shared";
import {
  deriveRunFinalStates, deriveRunMergeConflicts, finalStateBadgeFor,
  FINAL_STATE_BADGE, ACCEPTANCE_STATUS_I18N, KIND_I18N, KIND_COLOR,
} from "./traceTypes.js";

// MUP 波3 · 徽章接线(波1/2 遗留 handoff):finalState / simulated / 未决冲突在任务卡流的诚实呈现。
// 纯派生函数单测 + 源码契约(web 无 DOM 测试基建)+ i18n 11 语言覆盖。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;
const LANGS = ["en", "zh-CN", "zh-TW", "es", "hi", "ar", "pt", "ru", "ja", "fr", "de"];

function ev(runId: string, type: TraceEvent["type"], payload: Record<string, unknown>): TraceEvent {
  return { id: `${runId}-${Math.random()}`, runId, timestamp: new Date().toISOString(), type, payload };
}

describe("deriveRunFinalStates(run_finished payload.finalState)", () => {
  it("从 run_finished 派生 runId → finalState;非法值/缺字段忽略(老 run 不虚构)", () => {
    const map = deriveRunFinalStates([
      ev("r1", "run_finished", { finalState: "verified" }),
      ev("r2", "run_finished", { finalState: "requires_review" }),
      ev("r3", "run_finished", {}),                       // 老 run 无字段
      ev("r4", "run_finished", { finalState: "bogus" }),  // 非法值
      ev("r5", "info", { finalState: "verified" }),       // 非 run_finished
    ]);
    expect(map).toEqual({ r1: "verified", r2: "requires_review" });
  });

  it("同 run 多条 run_finished(崩溃路径补发)以最后一条为准", () => {
    const map = deriveRunFinalStates([
      ev("r1", "run_finished", { finalState: "degraded" }),
      ev("r1", "run_finished", { finalState: "failed" }),
    ]);
    expect(map.r1).toBe("failed");
  });
});

describe("deriveRunMergeConflicts(run_requires_review payload.conflicts)", () => {
  it("从 run_requires_review 事件取未决冲突清单;坏形状条目剔除", () => {
    const conflicts = [
      { taskId: "t1", agentId: "dev-1", files: ["a.ts", "b.ts"] },
      { taskId: "__finalize", agentId: "orchestrator", files: ["c.ts"] },
      { bogus: true }, // 坏形状
    ];
    const map = deriveRunMergeConflicts([ev("r1", "info", { kind: "run_requires_review", conflicts })]);
    expect(map.r1).toHaveLength(2);
    expect(map.r1[0].files).toEqual(["a.ts", "b.ts"]);
  });

  it("其他 kind / 非 info / 无 conflicts 一律忽略", () => {
    const map = deriveRunMergeConflicts([
      ev("r1", "info", { kind: "simulated_run" }),
      ev("r2", "info", { kind: "run_requires_review" }),
      ev("r3", "run_finished", { kind: "run_requires_review", conflicts: [] }),
    ]);
    expect(map).toEqual({});
  });
});

describe("finalStateBadgeFor · 与状态徽章去重(同一张卡不出两个降级/失败)", () => {
  it("failed 恒略过(状态徽章已是红失败);degraded 与状态徽章重复时略过", () => {
    expect(finalStateBadgeFor("failed", "failed")).toBeUndefined();
    expect(finalStateBadgeFor("failed", "done")).toBeUndefined();
    expect(finalStateBadgeFor("degraded", "degraded")).toBeUndefined();
  });

  it("verified / tests_passed / requires_review 恒显示;status=done 但 finalState=degraded 补真相", () => {
    expect(finalStateBadgeFor("verified", "done")).toBe("verified");
    expect(finalStateBadgeFor("tests_passed", "done")).toBe("tests_passed"); // 选1:独立测试通过终态恒显
    expect(finalStateBadgeFor("requires_review", "done")).toBe("requires_review");
    expect(finalStateBadgeFor("degraded", "done")).toBe("degraded");
    expect(finalStateBadgeFor(undefined, "done")).toBeUndefined(); // 老 run 无字段=无徽章
  });
});

describe("徽章/事件样式元数据", () => {
  it("FINAL_STATE_BADGE 五态齐全且文案键正确(选1:新增 tests_passed=独立测试通过)", () => {
    expect(FINAL_STATE_BADGE.tests_passed.labelKey).toBe("trace.status.testsPassed");
    expect(FINAL_STATE_BADGE.verified.labelKey).toBe("trace.status.verified");
    expect(FINAL_STATE_BADGE.requires_review.labelKey).toBe("trace.status.requiresReview");
    expect(FINAL_STATE_BADGE.degraded.labelKey).toBe("trace.status.degraded");
    expect(FINAL_STATE_BADGE.failed.labelKey).toBe("trace.status.failed");
  });

  it("KIND_I18N/KIND_COLOR 覆盖 MUP 波1 新事件 kinds;merge_theirs 样式保留供存量 run", () => {
    for (const kind of ["merge_conflict_requires_review", "dirty_workspace_at_start", "simulated_run", "run_requires_review", "merge_theirs"]) {
      expect(KIND_I18N[kind], `KIND_I18N 缺 ${kind}`).toBeTruthy();
      expect(KIND_COLOR[kind], `KIND_COLOR 缺 ${kind}`).toBeTruthy();
    }
  });

  it("DeliveryAcceptance 展示键:simulated_run 复用 simulated 徽标键,tests_ran_unbound 有专属键", () => {
    expect(ACCEPTANCE_STATUS_I18N.simulated_run).toBe("trace.status.simulated");
    expect(ACCEPTANCE_STATUS_I18N.tests_ran_unbound).toBe("trace.acceptance.testsRanUnbound");
  });
});

describe("源码契约 · 徽章真接线(不是只建库不消费)", () => {
  const TASK_CARD = read("TaskCard.tsx");
  const TASK_LIST = read("TaskListView.tsx");

  it("TaskCard 消费 lib/executorBadge 的 SIMULATED_BADGE + FINAL_STATE_BADGE + 冲突清单", () => {
    expect(TASK_CARD).toContain("SIMULATED_BADGE");
    expect(TASK_CARD).toMatch(/from "\.\.\/\.\.\/lib\/executorBadge\.js"/);
    expect(TASK_CARD).toContain("FINAL_STATE_BADGE");
    expect(TASK_CARD).toContain("finalStateBadgeFor");
    expect(TASK_CARD).toContain("mergeConflicts");
    expect(TASK_CARD).toContain("trace.mergeConflicts.badge");
  });

  it("TaskListView 双数据源接线:task.json meta 优先,实时事件流兜底(deriveRunSimulated/isSimulatedRun)", () => {
    expect(TASK_LIST).toContain("deriveRunSimulated");
    expect(TASK_LIST).toContain("isSimulatedRun");
    expect(TASK_LIST).toContain("deriveRunFinalStates");
    expect(TASK_LIST).toContain("deriveRunMergeConflicts");
    expect(TASK_LIST).toMatch(/c\.meta\?\.finalState \?\? finalStateMap\[c\.id\]/);
    expect(TASK_LIST).toMatch(/c\.meta\?\.mergeConflicts \?\? conflictsMap\[c\.id\]/);
  });
});

describe("i18n · 徽章/事件新键 11 语言全覆盖", () => {
  const KEYS = [
    "trace.status.verified", "trace.status.requiresReview", "trace.acceptance.testsRanUnbound",
    "trace.mergeConflicts.badge",
    "trace.domain.mergeConflictRequiresReview", "trace.domain.dirtyWorkspaceAtStart",
    "trace.domain.simulatedRun", "trace.domain.runRequiresReview",
  ];

  it("全部键各语言非空;trace.mergeConflicts.badge 保留 {n}", () => {
    for (const lang of LANGS) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
      expect(DICTS[lang]["trace.mergeConflicts.badge"], `${lang} 缺 {n}`).toContain("{n}");
      // 既有键回归:trace.status.simulated 仍在(SIMULATED_BADGE 的文案键)
      expect(DICTS[lang]["trace.status.simulated"], `${lang} 缺 trace.status.simulated`).toBeTruthy();
    }
  });
});
