// D3 · memoryReuseStore 单测:append-only reuse-log.jsonl 读写、run 粒度去重聚合、NEVER throws。
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendReuseOutcomes, loadReuseStats, type MemoryReuseEntry } from "./memoryReuseStore.js";

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reuse-"));
}

function entry(over: Partial<MemoryReuseEntry> = {}): MemoryReuseEntry {
  return {
    runId: "run-1", agentId: "lead-1", role: "lead", memoryId: "mem-a", kind: "committed",
    taskType: "coding", runStatus: "done", degraded: false, at: "2026-07-11T00:00:00.000Z",
    ...over,
  };
}

describe("appendReuseOutcomes — append-only jsonl", () => {
  it("追加写入(不覆盖既有行),目录不存在时自动建", () => {
    const root = mkRoot();
    appendReuseOutcomes(root, [entry()]);
    appendReuseOutcomes(root, [entry({ runId: "run-2", memoryId: "mem-b" })]);
    const file = path.join(root, ".opc", "memory", "reuse-log.jsonl");
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n");
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]).memoryId).toBe("mem-a");
    expect(JSON.parse(lines[1]).runId).toBe("run-2");
  });

  it("空数组 → 不落盘不建目录", () => {
    const root = mkRoot();
    appendReuseOutcomes(root, []);
    expect(fs.existsSync(path.join(root, ".opc", "memory", "reuse-log.jsonl"))).toBe(false);
  });

  it("NEVER throws:根路径为不可写位置也静默放弃", () => {
    // Windows 上的非法路径字符(?)让 mkdirSync 必然抛 —— 契约是吞掉,不外抛。
    expect(() => appendReuseOutcomes("\0invalid\0root?*", [entry()])).not.toThrow();
    expect(() => appendReuseOutcomes("", [entry()])).not.toThrow();
  });
});

describe("loadReuseStats — run 粒度去重聚合", () => {
  it("文件不存在 → 空 Map;坏行跳过不拖垮整读", () => {
    const root = mkRoot();
    expect(loadReuseStats(root).size).toBe(0);
    const file = path.join(root, ".opc", "memory", "reuse-log.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json}\n" + JSON.stringify(entry()) + "\n" + JSON.stringify({ noMemoryId: true }) + "\n", "utf-8");
    const stats = loadReuseStats(root);
    expect(stats.size).toBe(1);
    expect(stats.get("mem-a")).toEqual({ injected: 1, cleanRuns: 1, failedRuns: 0 });
  });

  it("同一 run 多个 agent 注入同一条记忆只计一次(injected/cleanRuns 单位一致)", () => {
    const root = mkRoot();
    appendReuseOutcomes(root, [
      entry({ agentId: "lead-1" }),
      entry({ agentId: "dev-1", role: "dev" }),
    ]);
    expect(loadReuseStats(root).get("mem-a")).toEqual({ injected: 1, cleanRuns: 1, failedRuns: 0 });
  });

  it("failed / degraded run 计入 failedRuns;干净 done 计入 cleanRuns", () => {
    const root = mkRoot();
    appendReuseOutcomes(root, [
      entry({ runId: "r1", runStatus: "done", degraded: false }),
      entry({ runId: "r2", runStatus: "failed", degraded: false }),
      entry({ runId: "r3", runStatus: "done", degraded: true }), // 降级的 done 不算干净
      entry({ runId: "r4", runStatus: "done", degraded: false }),
    ]);
    expect(loadReuseStats(root).get("mem-a")).toEqual({ injected: 4, cleanRuns: 2, failedRuns: 2 });
  });

  it("同一 run 冲突快照(既有干净又有失败)→ 失败优先,不虚标干净", () => {
    const root = mkRoot();
    appendReuseOutcomes(root, [
      entry({ runId: "r1", runStatus: "done", degraded: false }),
      entry({ runId: "r1", runStatus: "failed", degraded: false }),
    ]);
    expect(loadReuseStats(root).get("mem-a")).toEqual({ injected: 1, cleanRuns: 0, failedRuns: 1 });
  });

  it("NEVER throws:非法根路径 → 空 Map", () => {
    expect(loadReuseStats("\0bad\0?*").size).toBe(0);
    expect(loadReuseStats("").size).toBe(0);
  });
});
