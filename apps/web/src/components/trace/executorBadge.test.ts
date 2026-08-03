// 定稿 2.2 · executor 徽章派生单测:从实时事件流(executor_selected info 事件)算出 runId → executor,
// 且"降级(legacy_cli)"粘滞覆盖 acp(只要有一条腿降级,卡片就如实标降级)。
import { describe, it, expect } from "vitest";
import type { TraceEvent } from "@opc/shared";
import { deriveRunExecutors, EXECUTOR_BADGE } from "./traceTypes.js";

function ev(runId: string, kind: string, extra: Record<string, unknown> = {}, type: TraceEvent["type"] = "info"): TraceEvent {
  return { id: `${runId}-${Math.random()}`, runId, timestamp: new Date().toISOString(), type, agentId: "a1", payload: { kind, ...extra } };
}

describe("deriveRunExecutors", () => {
  it("从 executor_selected 事件派生 runId → executor", () => {
    const map = deriveRunExecutors([ev("r1", "executor_selected", { executor: "acp" })]);
    expect(map).toEqual({ r1: "acp" });
  });

  it("降级(legacy_cli)粘滞:即便随后又出现 acp,也保留 legacy_cli", () => {
    const map = deriveRunExecutors([
      ev("r1", "executor_selected", { executor: "legacy_cli", degradedReason: "ACP 握手失败" }),
      ev("r1", "executor_selected", { executor: "acp" }),
    ]);
    expect(map.r1).toBe("legacy_cli");
  });

  it("忽略非 executor_selected / 非 info / 无效 executor / 无 runId 的事件", () => {
    const map = deriveRunExecutors([
      ev("r1", "memory_pack_used", { executor: "acp" }),          // 别的 kind
      ev("r2", "executor_selected", { executor: "bogus" }),        // 无效 executor
      ev("", "executor_selected", { executor: "acp" }),            // 无 runId
      { id: "x", runId: "r3", timestamp: "t", type: "model_call_finished", payload: { kind: "executor_selected", executor: "acp" } }, // 非 info
    ]);
    expect(map).toEqual({});
  });

  it("多 run 各自独立", () => {
    const map = deriveRunExecutors([
      ev("r1", "executor_selected", { executor: "acp" }),
      ev("r2", "executor_selected", { executor: "legacy_cli" }),
    ]);
    expect(map).toEqual({ r1: "acp", r2: "legacy_cli" });
  });

  it("徽章元数据:acp 用字面量 ACP,legacy_cli 复用 trace.status.degraded 文案键", () => {
    expect(EXECUTOR_BADGE.acp.label).toBe("ACP");
    expect(EXECUTOR_BADGE.legacy_cli.labelKey).toBe("trace.status.degraded");
  });
});
