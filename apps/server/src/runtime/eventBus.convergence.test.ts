// B5 · 收尾接线回归:eventBus 把 model_call_started / tool_call 经 appendConvergedEvent 收敛进
// run 级 RunHistory(摘要级 payload + 200/类上限),orchestrator 收尾再补 converged_events_overflow。
// 这里直接驱动 emit() 断言 canonical history(即 run-history.jsonl 的物料)真的收到了收敛事件。
import { describe, it, expect, beforeEach } from "vitest";
import { emit, setRunId, getRunHistory } from "./eventBus.js";
import { CONVERGED_EVENT_CAP } from "./runHistory.js";

describe("B5 · eventBus 收敛接线(model_call_started / tool_call)", () => {
  beforeEach(() => setRunId("test-run-convergence"));

  it("tool_call 进 RunHistory 且 payload 收敛为 name+argsSummary(全量 args 不落 history)", () => {
    emit("tool_call", "w1", { name: "writeFile", args: { path: "a.ts", content: "x".repeat(1000) } });
    const ev = getRunHistory().getEvents().at(-1)!;
    expect(ev.type).toBe("tool_call");
    expect(ev.agentId).toBe("w1");
    expect(ev.payload?.name).toBe("writeFile");
    expect(typeof ev.payload?.argsSummary).toBe("string");
    expect((ev.payload!.argsSummary as string).length).toBeLessThanOrEqual(300);
    expect(ev.payload).not.toHaveProperty("args");
  });

  it("model_call_started 只留 model/provider 摘要字段", () => {
    emit("model_call_started", "w1", { model: "deepseek-chat", provider: "deepseek", extraJunk: { big: "payload" } });
    const ev = getRunHistory().getEvents().at(-1)!;
    expect(ev.type).toBe("model_call_started");
    expect(ev.payload).toEqual({ model: "deepseek-chat", provider: "deepseek" });
  });

  it("超 200/类上限 → history 只收 200 条;appendConvergenceOverflowSummary 补溢出汇总;JSONL 里真有收敛事件", () => {
    for (let i = 0; i < CONVERGED_EVENT_CAP + 5; i++) {
      emit("tool_call", "w1", { name: `tool-${i}`, args: { i } });
    }
    const hist = getRunHistory();
    expect(hist.getEvents().filter((e) => e.type === "tool_call")).toHaveLength(CONVERGED_EVENT_CAP);
    expect(hist.getConvergenceCounts().tool_call).toEqual({ total: CONVERGED_EVENT_CAP + 5, recorded: CONVERGED_EVENT_CAP });
    // orchestrator 收尾在写 run-history.jsonl 前调用的同一入口
    const overflow = hist.appendConvergenceOverflowSummary("2026-01-01T00:00:09.000Z");
    expect(overflow?.type).toBe("converged_events_overflow");
    expect(overflow?.payload?.tool_call).toEqual({ total: CONVERGED_EVENT_CAP + 5, recorded: CONVERGED_EVENT_CAP });
    // toJSONL 即 run-history.jsonl 的落盘内容:收敛事件 + 溢出汇总都在
    const jsonl = hist.toJSONL();
    expect(jsonl).toContain('"type":"tool_call"');
    expect(jsonl).toContain('"type":"converged_events_overflow"');
  });

  it("未超上限 → 不追加溢出汇总(返回 null)", () => {
    emit("tool_call", "w1", { name: "shell", args: {} });
    emit("model_call_started", "w1", { model: "m", provider: "p" });
    expect(getRunHistory().appendConvergenceOverflowSummary("2026-01-01T00:00:09.000Z")).toBeNull();
    expect(getRunHistory().getEvents().some((e) => e.type === "converged_events_overflow")).toBe(false);
  });

  it("非收敛领域事件(info 等)照旧全量进 history,payload 不被收敛", () => {
    emit("info", "w1", { kind: "memory_pack_used", countsByScope: { project: 1 }, packHash: "sha256:abc" });
    const ev = getRunHistory().getEvents().at(-1)!;
    expect(ev.type).toBe("info");
    expect(ev.payload?.packHash).toBe("sha256:abc");
  });
});
