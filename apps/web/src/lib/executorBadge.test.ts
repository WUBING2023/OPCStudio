// MUP Gate A#2 / 矩阵8 · simulated 徽标派生单测:mock provider 的 run 永远显示 simulated。
import { describe, it, expect } from "vitest";
import type { TraceEvent } from "@opc/shared";
import { deriveRunSimulated, isSimulatedRun, SIMULATED_BADGE } from "./executorBadge.js";

function ev(runId: string, type: TraceEvent["type"], payload: Record<string, unknown> | null): TraceEvent {
  return { id: `${runId}-${Math.random()}`, runId, timestamp: new Date().toISOString(), type, agentId: "a1", payload };
}

describe("deriveRunSimulated", () => {
  it("model_call_finished 带 payload.simulated=true → 该 run 标 simulated", () => {
    const map = deriveRunSimulated([ev("r1", "model_call_finished", { provider: "mock", simulated: true })]);
    expect(map).toEqual({ r1: true });
  });

  it("兜底:payload.provider==='mock' 即便无 simulated 字段(存量事件)也标 simulated", () => {
    const map = deriveRunSimulated([ev("r1", "model_call_finished", { provider: "mock", tokens: 80 })]);
    expect(map).toEqual({ r1: true });
  });

  it("真实 provider 的调用绝不标 simulated", () => {
    const map = deriveRunSimulated([
      ev("r1", "model_call_finished", { provider: "deepseek", tokens: 100 }),
      ev("r2", "model_call_finished", { provider: "anthropic", simulated: false }),
    ]);
    expect(map).toEqual({});
  });

  it("忽略其他事件类型 / 无 runId / 空 payload", () => {
    const map = deriveRunSimulated([
      ev("r1", "info", { kind: "executor_selected", simulated: true }),
      ev("", "model_call_finished", { provider: "mock" }),
      ev("r2", "model_call_finished", null),
    ]);
    expect(map).toEqual({});
  });

  it("混合 run:同 run 一次 mock 调用即粘滞 simulated(不被后续真实调用洗白)", () => {
    const map = deriveRunSimulated([
      ev("r1", "model_call_finished", { provider: "mock", simulated: true }),
      ev("r1", "model_call_finished", { provider: "deepseek" }),
    ]);
    expect(map.r1).toBe(true);
  });
});

describe("isSimulatedRun(run 级字段,RunResultContract.simulated 加性透传)", () => {
  it("simulated===true → true;缺省/false/null run → false(老 run 安全降级)", () => {
    expect(isSimulatedRun({ simulated: true })).toBe(true);
    expect(isSimulatedRun({})).toBe(false);
    expect(isSimulatedRun({ simulated: false })).toBe(false);
    expect(isSimulatedRun(null)).toBe(false);
    expect(isSimulatedRun(undefined)).toBe(false);
  });
});

describe("SIMULATED_BADGE 元数据", () => {
  it("文案走 i18n 键 trace.status.simulated,带裸串兜底", () => {
    expect(SIMULATED_BADGE.labelKey).toBe("trace.status.simulated");
    expect(SIMULATED_BADGE.labelFallback).toBe("SIMULATED");
    expect(SIMULATED_BADGE.color).toMatch(/^#/);
  });
});
