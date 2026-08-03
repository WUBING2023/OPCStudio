import type { TraceEvent } from "@opc/shared";

// MUP Gate A#2 / 矩阵8 · simulated 徽标:mock provider 的 run 永远显示 simulated,绝不冒充真实成功。
// 数据源两路(都是加性字段,老 run 缺省 = 非 simulated,不虚构):
//   ① run 级字段:task.json/result.json 的 simulated===true(RunResultContract.simulated,泳道1 聚合落盘);
//   ② 实时事件流:model_call_finished payload.simulated===true(ApiEngine mock 短路发出),
//      兜底 payload.provider==="mock"(标记接线前的存量事件,provider 本身就是结构化事实)。
// 徽章文案走 i18n 键 trace.status.simulated(词典铺开由 i18n 属主完成),labelFallback 兜底裸串。

export const SIMULATED_BADGE = {
  labelKey: "trace.status.simulated",
  labelFallback: "SIMULATED",
  color: "#8b6ec4",
} as const;

export function isSimulatedRun(run: { simulated?: boolean } | null | undefined): boolean {
  return run?.simulated === true;
}

export function deriveRunSimulated(events: TraceEvent[]): Record<string, true> {
  const map: Record<string, true> = {};
  for (const e of events) {
    if (e.type !== "model_call_finished" || !e.runId) continue;
    const p = e.payload as Record<string, unknown> | null | undefined;
    if (!p) continue;
    if (p.simulated === true || p.provider === "mock") map[e.runId] = true;
  }
  return map;
}
