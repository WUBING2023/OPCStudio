import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryEntry } from "@opc/shared";
import { queryMemory, queryMemoryScored, bumpHitsByIds } from "./memoryStore.js";

// D 层清理后 memoryStore 只有 project 一层(写到 <root>/.opc/memory/project.jsonl),每个测试用
// 独立 mkdtemp 目录隔离,不会碰到真实用户数据。
function projectFile(root: string): string {
  return path.join(root, ".opc", "memory", "project.jsonl");
}

function writeEntries(root: string, entries: MemoryEntry[]): void {
  const f = projectFile(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

function mkEntry(over: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: over.id ?? "id1", agentRole: "dev", goalSlug: "",
    text: "text", tags: [], source: { runId: "r1", agentId: "a1", type: "manual" },
    createdAt: "2026-01-01T00:00:00.000Z", hits: 0, ...over,
  };
}

describe("queryMemory — CJK tag 相关性打分(P1#7)", () => {
  it("中文 tag 与中文 goal 有实质重叠的条目排在无关条目前面(修复前 tag/goal 整句子串匹配对中文几乎恒不命中)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    // 故意先写不相关的,后写相关的 —— 若打分对 tag 不敏感,平局时会保留先写入的那条,掩盖 bug。
    writeEntries(root, [
      mkEntry({ id: "irrelevant", tags: ["无关内容与主题不相符"] }),
      mkEntry({ id: "relevant", tags: ["写爬虫抓取数据"] }),
    ]);

    const results = queryMemory(root, { agentRole: "dev", goal: "帮我写一个爬虫程序抓取数据", limit: 1 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe("relevant");
  });

  it("role 不匹配 → 排除(不受 tag 打分影响)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [mkEntry({ id: "e1", agentRole: "pm", tags: ["写代码"] })]);
    const results = queryMemory(root, { agentRole: "dev", goal: "写代码" });
    expect(results).toEqual([]);
  });
});

describe("queryMemory — 任务语义相关门(P1 审计:仅同角色不足以注入)", () => {
  it("同角色但与目标零语义重叠 → 不注入(修复前:role=+2 → s>0,求和任务被灌 HTTP 记忆)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [mkEntry({ id: "http-mem", agentRole: "dev", tags: ["HTTP", "协议", "连接复用"], goalSlug: "" })]);
    const results = queryMemory(root, { agentRole: "dev", goal: "实现一个求和模块 sum(a,b) 返回两数之和" });
    expect(results).toEqual([]);
  });

  it("同角色 + tag 与目标重叠 → 注入(相关分 > 0)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [
      mkEntry({ id: "http-mem", agentRole: "dev", tags: ["HTTP", "协议"] }),          // 无关 → 排除
      mkEntry({ id: "sum-mem", agentRole: "dev", tags: ["求和", "模块设计"] }),        // 相关 → 注入
    ]);
    const results = queryMemory(root, { agentRole: "dev", goal: "实现一个求和模块 sum(a,b)" });
    expect(results.map((r) => r.id)).toEqual(["sum-mem"]);
  });

  it("queryMemoryScored 带出 score/relevance/reason(可观测:为什么被注入)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [mkEntry({ id: "rel", agentRole: "dev", tags: ["爬虫抓取"] })]);
    const scored = queryMemoryScored(root, { agentRole: "dev", goal: "写一个爬虫抓取数据" });
    expect(scored.length).toBe(1);
    expect(scored[0].score.relevance).toBeGreaterThan(0);
    expect(scored[0].score.reason).toMatch(/tag-overlap/);
  });
});

describe("queryMemory — 检索不 bump hits(D3 自增强治理,复刻 codex 问题6)", () => {
  it("查询命中 → 不写盘、hits 不变(旧行为:每次检索 winner hits+1 → 注入越多越容易再被注入)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [mkEntry({ id: "e1", agentRole: "dev", tags: ["写代码"], hits: 0 })]);
    const f = projectFile(root);
    const past = new Date("2000-01-01T00:00:00.000Z");
    fs.utimesSync(f, past, past);

    const results = queryMemory(root, { agentRole: "dev", goal: "写代码" });
    expect(results.length).toBe(1);
    expect(results[0].hits).toBe(0); // 纯检索不增长
    expect(fs.statSync(f).mtimeMs).toBe(past.getTime()); // 不写盘

    const onDisk = fs.readFileSync(f, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(onDisk[0].hits).toBe(0);
  });
});

describe("bumpHitsByIds — 验证后 bump(run 干净收尾才回写;只在计数真变时写盘 P2#6)", () => {
  it("命中的 id hits+1 并持久化;未命中的不动;返回 bump 条数", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [
      mkEntry({ id: "e1", hits: 0 }),
      mkEntry({ id: "e2", hits: 3 }),
    ]);
    expect(bumpHitsByIds(root, ["e1", "no-such"])).toBe(1);
    const onDisk = fs.readFileSync(projectFile(root), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(onDisk.find((e: MemoryEntry) => e.id === "e1")!.hits).toBe(1);
    expect(onDisk.find((e: MemoryEntry) => e.id === "e2")!.hits).toBe(3);
  });

  it("零命中 → 不写盘(mtime 不变);空 ids/无 root → 0 且不抛", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ms-"));
    writeEntries(root, [mkEntry({ id: "e1" })]);
    const f = projectFile(root);
    const past = new Date("2000-01-01T00:00:00.000Z");
    fs.utimesSync(f, past, past);
    expect(bumpHitsByIds(root, ["missing"])).toBe(0);
    expect(fs.statSync(f).mtimeMs).toBe(past.getTime());
    expect(bumpHitsByIds(root, [])).toBe(0);
    expect(bumpHitsByIds(undefined, ["e1"])).toBe(0);
    expect(() => bumpHitsByIds("\0bad?*", ["e1"])).not.toThrow();
  });
});
