import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { closeAllDbs } from "./db.js";
import { migrateJsonToSqlite } from "./migrateJsonToSqlite.js";
import { goldenCompare } from "./goldenCompare.js";
import { sqliteToJson } from "./sqliteToJson.js";

// Phase B1 逆向导出器用例:构造假 .opc → 迁移 → sqliteToJson 导出 → 与原文件 deep-equal(往返无损)。
// JSONL 断言到**逐字节**(unknown 行按 source+lineNo 回位原行位);整文件损坏的源 verbatim 还原;
// 再迁移闭环(导出目录当新 root 再迁一遍 → goldenCompare 0 差异)证明导出物是合法的 .opc 形状。
// 真实 .opc 只做【副本】往返(绝不原地),真库不在(CI)则跳过。

const roots: string[] = [];
function mkRoot(prefix = "opc-s2j-"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}
afterEach(() => {
  closeAllDbs();
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* Windows 句柄残留 */ } }
});

function w(root: string, rel: string, content: string): void {
  const abs = path.join(root, ".opc", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}
function wj(root: string, rel: string, data: unknown): void {
  w(root, rel, JSON.stringify(data, null, 2));
}
function readOrig(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ".opc", rel), "utf-8");
}
function readOut(outDir: string, rel: string): string {
  return fs.readFileSync(path.join(outDir, rel), "utf-8");
}
function parsedEqual(outDir: string, root: string, rel: string): void {
  expect(JSON.parse(readOut(outDir, rel)), `${rel} 往返后 deep-equal 失败`).toEqual(JSON.parse(readOrig(root, rel)));
}

// _index.json 的 r1 条目按 projectStore.runToIndexEntry 的派生口径构造(与导出器的重建口径一致);
// orphan1 只存在于 _index(无 task.json),走 doc 原样往返。
function buildOpc(root: string): void {
  wj(root, "companies.json", [
    { id: "c1", name: "Co1", ceoId: "a1", createdAt: "2026-07-01T00:00:00.000Z", extra: { nested: [1, 2, 3] } },
    { id: "c2", name: "Co2", ceoId: "a3", createdAt: "2026-07-02T00:00:00.000Z" },
  ]);
  wj(root, "agents.json", [
    { id: "a1", companyId: "c1", role: "ceo", name: "CEO", childrenIds: ["a2"], model: "m" },
    { id: "a2", companyId: "c1", role: "dev", name: "Dev", parentId: "a1", childrenIds: [] },
  ]);
  wj(root, "runs/r1/task.json", { id: "r1", userGoal: "目标一", companyId: "c1", status: "done", startedAt: "2026-07-03T01:00:00.000Z", endedAt: "2026-07-03T01:05:00.000Z", totalTokens: 100, totalCostUsd: 0.5, participatingAgents: ["a1", "a2"], degraded: false });
  wj(root, "runs/_index.json", {
    r1: { id: "r1", goal: "目标一", status: "done", degraded: false, startedAt: "2026-07-03T01:00:00.000Z", endedAt: "2026-07-03T01:05:00.000Z", totalTokens: 100, totalCostUsd: 0.5, agents: 2, agentIds: ["a1", "a2"], companyId: "c1", summary: "完成目标一", partial: false },
    orphan1: { id: "orphan1", goal: "孤儿", status: "failed", startedAt: "2026-06-01T00:00:00.000Z", summary: "孤儿", partial: false },
  });
  // registry:unknown 行落在第 1、3 行(头部 + 中部),验证 lineNo 精确回位
  w(root, "memory/registry.jsonl", [
    JSON.stringify({ id: "future-1", kind: "future_kind", payload: "keep raw" }),
    JSON.stringify({ id: "concl-1", kind: "conclusion_summary", runId: "r1", companyId: "c1", goalSlug: "g", points: ["p1"], tags: [], createdAt: "2026-07-01T00:00:00.000Z" }),
    '{"id":"broken-1",BROKEN',
    JSON.stringify({ id: "plan-1", kind: "plan_template", companyId: "c1", taskType: "general", goalSlug: "g", split: ["s1"], workerCount: 1, sourceRun: "r1", support: 1, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "skill-1", kind: "procedural_skill", role: "dev", successfulSequence: ["Bash"], support: 3, status: "verified", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }),
  ].join("\n") + "\n");
  w(root, "memory/lessons.jsonl", [
    JSON.stringify({ id: "lesson-1", kind: "failure_lesson", scope: { companyId: "c1", role: "dev" }, lesson: "教训内容", status: "committed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "lesson-future", kind: "brand_new_kind", note: "keep raw" }),
  ].join("\n") + "\n");
  w(root, "memory/project.jsonl", [
    JSON.stringify({ id: "mem-1", createdAt: "2026-07-01T00:00:00.000Z", hits: 5, agentRole: "dev", goalSlug: "g", text: "经验一", tags: ["a"] }),
    JSON.stringify({ id: "mem-2", createdAt: "2026-07-02T00:00:00.000Z", hits: 0, agentRole: "*", goalSlug: "g2", text: "经验二", tags: [] }),
  ].join("\n") + "\n");
  w(root, "architect/company-edit-proposals.jsonl", [
    JSON.stringify({ proposal_id: "edit_prop_1", targetId: "tgt1", operations: [], status: "pending", createdAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ summary: "缺 proposal_id 的行", operations: [] }),
  ].join("\n") + "\n");
  wj(root, "memory/growth-snapshot.json", { registry: { "skill-1": { support: 3, status: "verified" } } });
  wj(root, "install-transactions.json", [{ txId: "t1", at: "2026-07-01T00:00:00.000Z", mode: "merge", companyId: "c1", status: "completed" }]);
  wj(root, "governance-records.json", [{ runId: "r1", level: "L2", decidedAt: "2026-07-03T01:00:00.000Z", events: [] }]);
  wj(root, "task-graphs.json", [{ id: "tg1", missionId: "m1", companyId: "c1", nodes: [], status: "committed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "dispatch-queue.json", { v: 1, items: [{ id: "q1", runId: "r9", companyId: "c1", enqueuedAt: "2026-07-04T00:00:00.000Z" }] });
  wj(root, "memory-jobs.json", [{ jobId: "j1", kind: "export", companyId: "c1", status: "completed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "chat-threads/c1__a1.json", { v: 1, companyId: "c1", agentId: "a1", turns: [{ role: "user", content: "hi", at: "2026-07-01T00:00:00.000Z" }] });
  // companyId 带非法文件名字符 → 原文件名由 store 的 safe() 净化产生,导出器须用同款规则还原出同名文件
  wj(root, "chat-threads/c_1__a2.json", { v: 1, companyId: "c/1", agentId: "a2", turns: [] });
  // 整文件损坏的源:必须 verbatim 逐字节还原
  w(root, "goals.json", "{ definitely not json");
  wj(root, "missions.json", [{ id: "m1", companyId: "c1", createdAt: "2026-07-01T00:00:00.000Z", approvalStatus: "approved" }]);
}

describe("sqliteToJson · 构造假 .opc 往返", () => {
  it("导出与原 .opc 逐文件等价:数组/单对象/队列/线程/runs deep-equal,JSONL 逐字节,损坏源 verbatim", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    const out = mkRoot("opc-s2j-out-");
    const result = sqliteToJson(root, out);

    // JSON 数组源 deep-equal
    for (const rel of ["companies.json", "agents.json", "install-transactions.json", "governance-records.json", "task-graphs.json", "memory-jobs.json", "missions.json"]) {
      parsedEqual(out, root, rel);
    }
    // 整文件损坏的 goals.json:verbatim 逐字节
    expect(readOut(out, "goals.json")).toBe("{ definitely not json");
    // 单对象 + 队列包装
    parsedEqual(out, root, "memory/growth-snapshot.json");
    parsedEqual(out, root, "dispatch-queue.json");
    // JSONL 逐字节一致(unknown 行按 lineNo 回到第 1、3 行原位)
    for (const rel of ["memory/registry.jsonl", "memory/lessons.jsonl", "memory/project.jsonl", "architect/company-edit-proposals.jsonl"]) {
      expect(readOut(out, rel), `${rel} 往返后字节不一致`).toBe(readOrig(root, rel));
    }
    // chat-threads:原文件名(含 safe() 净化名)还原 + 内容 deep-equal
    parsedEqual(out, root, "chat-threads/c1__a1.json");
    parsedEqual(out, root, "chat-threads/c_1__a2.json");
    // runs:task.json + _index.json(r1 派生条目与原 index 逐字段一致;orphan1 doc 原样)
    parsedEqual(out, root, "runs/r1/task.json");
    parsedEqual(out, root, "runs/_index.json");

    expect(result.unrecovered).toEqual([]);
    expect(result.skippedAbsent).toEqual([]);
    // 8 数组 + 4 JSONL + snapshot + queue + 2 线程 + r1/task.json + _index.json
    expect(result.files.length).toBe(18);
  });

  it("再迁移闭环:导出目录作为新 root 的 .opc 再迁一遍 → goldenCompare 0 差异", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    const root2 = mkRoot();
    sqliteToJson(root, path.join(root2, ".opc"));

    migrateJsonToSqlite(root2);
    const report = goldenCompare(root2);
    const bad = report.sources.filter((s) => s.mismatched.length || s.missing.length || s.extra.length);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("未迁移过的库:导出 0 文件,全部源 skippedAbsent", () => {
    const root = mkRoot();
    const out = mkRoot("opc-s2j-out-");
    const result = sqliteToJson(root, out);
    expect(result.files).toEqual([]);
    expect(result.unrecovered).toEqual([]);
    expect(result.skippedAbsent.length).toBe(16); // 8 数组 + 4 JSONL + snapshot + queue + chat-threads/ + runs/
  });

  it("守卫:outDir 指向运行中的 .opc → 拒绝导出", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    expect(() => sqliteToJson(root, path.join(root, ".opc"))).toThrow(/不能是运行中的 \.opc/);
    expect(() => sqliteToJson(root, path.join(root, ".opc") + path.sep)).toThrow(/不能是运行中的 \.opc/);
  });
});

// ── 真实 .opc 的【副本】往返(绝不原地)。真库不存在则跳过(CI 便携)。──────────────
describe("sqliteToJson · 真实 .opc 副本往返", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const realOpc = path.join(repoRoot, ".opc");

  function copyCanonicalInputs(srcOpc: string, dstRoot: string): boolean {
    if (!fs.existsSync(srcOpc)) return false;
    const dstOpc = path.join(dstRoot, ".opc");
    const cp = (rel: string) => {
      const s = path.join(srcOpc, rel);
      if (!fs.existsSync(s)) return;
      const d = path.join(dstOpc, rel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
    };
    for (const f of ["companies.json", "agents.json", "governance-records.json", "task-graphs.json", "dispatch-queue.json", "memory-jobs.json", "goals.json", "missions.json", "install-transactions.json"]) cp(f);
    for (const f of ["registry.jsonl", "lessons.jsonl", "project.jsonl", "growth-snapshot.json"]) cp(path.join("memory", f));
    cp(path.join("architect", "company-edit-proposals.jsonl"));
    const ct = path.join(srcOpc, "chat-threads");
    if (fs.existsSync(ct)) for (const n of fs.readdirSync(ct)) if (n.endsWith(".json")) cp(path.join("chat-threads", n));
    const runsSrc = path.join(srcOpc, "runs");
    if (fs.existsSync(runsSrc)) {
      cp(path.join("runs", "_index.json"));
      for (const e of fs.readdirSync(runsSrc, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith("_")) cp(path.join("runs", e.name, "task.json"));
      }
    }
    return true;
  }

  // JSONL 语义比较:逐行 parse 后按序 deep-equal(parse 不了的行退回原文比较)。
  function jsonlValues(text: string): unknown[] {
    return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      try { return JSON.parse(l) as unknown; } catch { return { __rawLine: l }; }
    });
  }

  it("副本迁移 → 导出 → 与副本源语义等价(数组/JSONL/runs);_index 键集 = 原 index ∪ task ids", () => {
    const root = mkRoot("opc-s2j-real-");
    if (!copyCanonicalInputs(realOpc, root)) { expect(true).toBe(true); return; }
    migrateJsonToSqlite(root);
    const out = mkRoot("opc-s2j-realout-");
    const result = sqliteToJson(root, out);
    expect(result.unrecovered, JSON.stringify(result.unrecovered, null, 2)).toEqual([]);

    const has = (rel: string) => fs.existsSync(path.join(root, ".opc", rel));

    for (const rel of ["companies.json", "agents.json", "install-transactions.json", "governance-records.json", "task-graphs.json", "memory-jobs.json", "goals.json", "missions.json"]) {
      if (!has(rel)) { expect(result.skippedAbsent).toContain(rel); continue; }
      parsedEqual(out, root, rel);
    }
    for (const rel of ["memory/registry.jsonl", "memory/lessons.jsonl", "memory/project.jsonl", "architect/company-edit-proposals.jsonl"]) {
      if (!has(rel)) { expect(result.skippedAbsent).toContain(rel); continue; }
      expect(jsonlValues(readOut(out, rel)), `${rel} 往返后语义不等价`).toEqual(jsonlValues(readOrig(root, rel)));
    }
    if (has("memory/growth-snapshot.json")) parsedEqual(out, root, "memory/growth-snapshot.json");
    if (has("dispatch-queue.json")) parsedEqual(out, root, "dispatch-queue.json");

    // runs:每个副本 task.json 都被还原且 deep-equal
    const runsDir = path.join(root, ".opc", "runs");
    const taskIds: string[] = [];
    if (fs.existsSync(runsDir)) {
      for (const e of fs.readdirSync(runsDir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name.startsWith("_")) continue;
        const rel = path.join("runs", e.name, "task.json").split(path.sep).join("/");
        if (!has(rel)) continue;
        const orig = JSON.parse(readOrig(root, rel)) as { id?: string };
        taskIds.push(typeof orig.id === "string" && orig.id ? orig.id : e.name);
        parsedEqual(out, root, rel);
      }
      if (has("runs/_index.json")) {
        const origKeys = Object.keys(JSON.parse(readOrig(root, "runs/_index.json")) as Record<string, unknown>);
        const outKeys = Object.keys(JSON.parse(readOut(out, "runs/_index.json")) as Record<string, unknown>);
        // 导出的 _index = 孤儿条目(原 index 独有)∪ 全部 task 行 → 键集恰为并集
        expect(new Set(outKeys)).toEqual(new Set([...origKeys, ...taskIds]));
      }
    }
  });
});
