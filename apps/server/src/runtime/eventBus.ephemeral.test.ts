import { describe, it, expect, beforeEach } from "vitest";
import { emit, setRunId, getRunHistory, EPHEMERAL_TYPES, subscribe, unsubscribe } from "./eventBus.js";

// warn 回归:agent_output_chunk 由各引擎对每个 stdout chunk emit 一条,曾在最热路径上做同步
// fs.appendFileSync + RunHistory 无界 append → 阻塞事件循环、涨内存。现约定:高频 chunk 事件
// 只走 listeners 实时广播,不进 RunHistory(也不落盘)。领域事件照常进。
describe("eventBus 高频 chunk 事件不进 RunHistory(warn 回归)", () => {
  beforeEach(() => setRunId("test-run-ephemeral"));

  it("100 条 agent_output_chunk 一条都不进 RunHistory", () => {
    const before = getRunHistory().length;
    for (let i = 0; i < 100; i++) emit("agent_output_chunk", "a1", { chunk: "x" });
    expect(getRunHistory().length).toBe(before);
  });

  it("领域事件(info)正常进 RunHistory", () => {
    const before = getRunHistory().length;
    emit("info", "a1", { note: "domain event" });
    expect(getRunHistory().length).toBe(before + 1);
  });

  it("EPHEMERAL_TYPES 对外导出且含 agent_output_chunk(orchestrator traceSub 与此共用同一集合)", () => {
    expect(EPHEMERAL_TYPES).toBeInstanceOf(Set);
    expect(EPHEMERAL_TYPES.has("agent_output_chunk")).toBe(true);
  });

  it("redacts nested secrets before RunHistory receives payload", () => {
    emit("info", "a1", {
      headers: { Authorization: "Bearer abcdefghijk12345" },
      env: { OPENAI_API_KEY: "sk-secret123456789" },
      account: { apiKey: "sk-account123456789" },
    });
    const last = getRunHistory().getEvents().at(-1)!;
    const serialized = JSON.stringify(last.payload);
    expect(serialized).not.toContain("abcdefghijk12345");
    expect(serialized).not.toContain("sk-secret123456789");
    expect(serialized).not.toContain("sk-account123456789");
    expect(serialized).toContain("[REDACTED]");
  });

  it("commits bounded chunk digests immediately before run_finished", () => {
    const seen: any[] = [];
    const listener = (event: any) => seen.push(event);
    subscribe(listener);
    try {
      emit("agent_output_chunk", "a1", { chunk: "hello" });
      emit("agent_output_chunk", "a1", { chunk: " world" });
      emit("agent_output_chunk", "a1", { chunk: "private thought", thinking: true });
      emit("run_finished", undefined, { runId: "test-run-ephemeral" });
    } finally {
      unsubscribe(listener);
    }

    const digests = seen.filter((event) => event.type === "info" && event.payload?.kind === "agent_output_digest");
    expect(digests).toHaveLength(2);
    expect(digests.find((event) => event.payload.stream === "output")?.payload).toMatchObject({ chunks: 2, bytes: 11 });
    expect(digests.every((event) => /^[0-9a-f]{64}$/.test(event.payload.sha256))).toBe(true);
    expect(seen.at(-1)?.type).toBe("run_finished");
  });
});
