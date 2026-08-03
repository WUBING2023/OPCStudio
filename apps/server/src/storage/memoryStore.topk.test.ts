import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryEntry } from "@opc/shared";
import { queryMemory, queryMemoryScored, goalToSlug } from "./memoryStore.js";

// 效率治理 · memoryStore 检索 Top-K 硬顶(只收紧不改语义)。
// 锁:①调用方误传超大 limit 也被 ceiling 截断(防上下文膨胀);②高分/高 hits 优先保留;③env 可调。

function seed(root: string, entries: MemoryEntry[]): void {
  const f = path.join(root, ".opc", "memory", "project.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}
function mk(root: string, n: number, goal: string): void {
  const slug = goalToSlug(goal);
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `m-${String(i).padStart(3, "0")}`, agentRole: "dev", goalSlug: slug,
      text: `entry ${i}`, tags: [], source: { runId: "r", agentId: "a", type: "manual" },
      createdAt: "2026-01-01T00:00:00.000Z", hits: n - i, // 靠前 hits 越高
    });
  }
  seed(root, entries);
}

afterEach(() => { delete process.env.OPC_MEMORY_TOPK_MAX; });

describe("queryMemory · Top-K ceiling", () => {
  it("误传超大 limit → 被 MAX_QUERY_LIMIT(默认10)截断", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-topk-"));
    const goal = "写一个排序函数";
    mk(root, 50, goal);
    const got = queryMemory(root, { agentRole: "dev", goal, limit: 999 });
    expect(got.length).toBeLessThanOrEqual(10);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("高 hits 条目优先保留(截断保留最相关/最常复用的头部)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-topk-"));
    const goal = "写一个排序函数";
    mk(root, 50, goal); // hits 递减,m-000 最高
    const got = queryMemoryScored(root, { agentRole: "dev", goal, limit: 999 });
    expect(got.length).toBeLessThanOrEqual(10);
    // 同分(goalSlug 全命中,relevance 相同)→ tie-break 按 hits;m-000 hits 最高必在结果内且靠前。
    expect(got[0].entry.id).toBe("m-000");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("env OPC_MEMORY_TOPK_MAX 可收紧上限", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-topk-"));
    const goal = "写一个排序函数";
    mk(root, 50, goal);
    process.env.OPC_MEMORY_TOPK_MAX = "3";
    const got = queryMemory(root, { agentRole: "dev", goal, limit: 999 });
    expect(got.length).toBeLessThanOrEqual(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("默认档(未传/传小 limit)行为不变:传 limit=5 仍取 5", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-topk-"));
    const goal = "写一个排序函数";
    mk(root, 50, goal);
    const got = queryMemory(root, { agentRole: "dev", goal, limit: 5 });
    expect(got.length).toBe(5);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
