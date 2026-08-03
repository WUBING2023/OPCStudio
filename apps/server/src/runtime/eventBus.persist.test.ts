import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CriticalEventPersistenceError,
  emit,
  setRunId,
  setEventPersistRoot,
  subscribe,
  unsubscribe,
} from "./eventBus.js";

// 用量事件版本戳:持久化的 events.jsonl 每行封套要带 v:1;内存 event(SSE/listeners 拿到的对象)不受影响。
describe("eventBus 持久化 writer 段 · v:1 封套", () => {
  let root: string;
  afterEach(() => {
    setEventPersistRoot(null as unknown as string);
    setRunId("");
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("落盘的 events.jsonl 每行带 v:1,内存 event 对象不含 v 字段", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-persist-"));
    setEventPersistRoot(root);
    setRunId("run-persist-v1");

    let seen: Record<string, unknown> | undefined;
    const listener = (ev: Record<string, unknown>) => { seen = ev; };
    subscribe(listener as any);
    emit("info", "a1", { note: "hello" });
    unsubscribe(listener as any);

    expect(seen).toBeDefined();
    expect((seen as Record<string, unknown>).v).toBeUndefined();

    const file = path.join(root, ".opc", "runs", "run-persist-v1", "events.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.v).toBe(1);
    expect(last.type).toBe("info");
    expect(last.payload).toEqual({ note: "hello" });
  });
});

describe("eventBus canonical durability", () => {
  let root: string;

  afterEach(() => {
    setEventPersistRoot(null as unknown as string);
    setRunId("");
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("persists monotonic sequence and causal execution coordinates", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-seq-"));
    setEventPersistRoot(root);
    setRunId("run-seq");
    emit("info", "a1", { attempt: 2, visit: 3, causalParentId: "parent-1" });
    emit("info", "a1", { note: "second" });

    const file = path.join(root, ".opc", "runs", "run-seq", "events.jsonl");
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events[0]).toMatchObject({
      schemaVersion: "1",
      attempt: 2,
      visit: 3,
      causalParentId: "parent-1",
    });
  });

  it("isolates listener failures after persistence", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-listener-"));
    setEventPersistRoot(root);
    setRunId("run-listener");
    const delivered: string[] = [];
    const bad = () => { throw new Error("listener failed"); };
    const good = (event: { type: string }) => { delivered.push(event.type); };
    subscribe(bad);
    subscribe(good as any);
    expect(() => emit("info", undefined, { note: "durable" })).not.toThrow();
    unsubscribe(bad);
    unsubscribe(good as any);
    expect(delivered).toEqual(["info"]);
  });

  it("fails closed when a critical event cannot be persisted", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-critical-"));
    const blocker = path.join(root, "not-a-directory");
    fs.writeFileSync(blocker, "x");
    setEventPersistRoot(blocker);
    setRunId("run-critical");
    expect(() => emit("run_finished", undefined, { status: "done" }))
      .toThrow(CriticalEventPersistenceError);
  });

  it("rejects critical durable events after run_finished", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-terminal-"));
    setEventPersistRoot(root);
    setRunId("run-terminal");
    emit("run_finished", undefined, { status: "done" });
    expect(() => emit("quality_gate_result", undefined, { ok: true }))
      .toThrow(CriticalEventPersistenceError);
    emit("info", undefined, { note: "late telemetry is ignored" });
    const file = path.join(root, ".opc", "runs", "run-terminal", "events.jsonl");
    const events = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(events).toHaveLength(1);
  });

  it("restores the durable cursor and terminal state after restart", () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "eb-resume-"));
    setEventPersistRoot(root);
    setRunId("run-resume");
    emit("info", undefined, { note: "one" });
    setRunId("other-run");
    setRunId("run-resume");
    emit("info", undefined, { note: "two" });
    const file = path.join(root, ".opc", "runs", "run-resume", "events.jsonl");
    const events = fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
  });
});
