import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadRunHistory } from "./runHistoryStore.js";

// 用量事件版本戳:eventBus writer 给持久化行加了 v:1,但历史 run 落盘的行没有这个字段。
// loadRunHistory 必须对两种行(带 v / 不带 v)一视同仁地解析。
describe("runHistoryStore.loadRunHistory 容忍 events.jsonl 行带/不带 v 字段", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("混合有 v:1 与无 v 字段的行,两者都被正常解析进 RunHistory", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rhs-"));
    const runId = "run-mixed-v";
    const dir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ id: "1", runId, timestamp: "2024-01-01T00:00:00.000Z", type: "run_started", payload: {} }),
      JSON.stringify({ id: "2", runId, timestamp: "2024-01-01T00:00:01.000Z", type: "info", agentId: "a1", payload: { note: "x" }, v: 1 }),
      JSON.stringify({ id: "3", runId, timestamp: "2024-01-01T00:00:02.000Z", type: "run_finished", payload: {}, v: 1 }),
    ];
    fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n");

    const hist = loadRunHistory(root, runId);
    expect(hist.length).toBe(3);
    const types = hist.getEvents().map((e) => e.type);
    expect(types).toEqual(["run_started", "info", "run_finished"]);
  });
});

describe("runHistoryStore canonical source", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("treats events.jsonl as canonical when a stale run-history projection exists", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rhs-canonical-"));
    const runId = "run-canonical";
    const dir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "events.jsonl"), [
      JSON.stringify({ seq: 7, id: "a", runId, timestamp: "2026-01-01T00:00:00.000Z", type: "run_started", payload: {} }),
      JSON.stringify({ seq: 8, id: "b", runId, timestamp: "2026-01-01T00:00:01.000Z", type: "run_finished", payload: { status: "done" } }),
    ].join("\n"));
    fs.writeFileSync(path.join(dir, "run-history.jsonl"), [
      JSON.stringify({ seq: 1, type: "run_started", at: "2025-01-01T00:00:00.000Z" }),
      JSON.stringify({ seq: 2, type: "deliverable_degraded", at: "2025-01-01T00:00:01.000Z" }),
    ].join("\n"));

    const events = loadRunHistory(root, runId).getEvents();
    expect(events.map((event) => event.type)).toEqual(["run_started", "run_finished"]);
    expect(events.map((event) => event.seq)).toEqual([7, 8]);
  });
});
