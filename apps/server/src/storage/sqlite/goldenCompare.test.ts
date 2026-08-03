import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeAllDbs } from "./db.js";
import { migrateJsonToSqlite } from "./migrateJsonToSqlite.js";
import { goldenCompare } from "./goldenCompare.js";

// Phase B1 金样本比对器用例:全部在临时目录构造假 .opc,绝不碰真库。
// 除"迁移后 0 差异"的通过路径外,重点证明比对器**抓得住问题**(篡改/漏行/多行/源漂移都能逐 pk 报出),
// 以及隔离进 unknown_lines 的行不被误报 missing —— 否则 0 差异只是自证式的空话。

const roots: string[] = [];
function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-golden-"));
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

function buildOpc(root: string): void {
  wj(root, "companies.json", [
    { id: "c1", name: "Co1", ceoId: "a1", createdAt: "2026-07-01T00:00:00.000Z", extra: { nested: [1, 2] } },
    { id: "c2", name: "Co2", ceoId: "a2", createdAt: "2026-07-02T00:00:00.000Z" },
  ]);
  wj(root, "agents.json", [
    { id: "a1", companyId: "c1", role: "ceo", name: "CEO", childrenIds: ["a2"] },
    { id: "a2", companyId: "c1", role: "dev", name: "Dev", parentId: "a1", childrenIds: [] },
  ]);
  wj(root, "runs/r1/task.json", { id: "r1", userGoal: "目标一", companyId: "c1", status: "done", startedAt: "2026-07-03T01:00:00.000Z", endedAt: "2026-07-03T01:05:00.000Z", totalTokens: 100, totalCostUsd: 0.5, participatingAgents: ["a1"], degraded: false });
  wj(root, "runs/_index.json", {
    r1: { id: "r1", goal: "目标一", status: "done", startedAt: "2026-07-03T01:00:00.000Z", summary: "完成", partial: false, companyId: "c1" },
    orphan1: { id: "orphan1", goal: "孤儿", status: "failed", startedAt: "2026-06-01T00:00:00.000Z", summary: "孤儿", partial: false },
  });
  // registry:1 已知 kind + 1 未知 kind(有合法 id → 会被隔离)+ 1 损坏行
  w(root, "memory/registry.jsonl", [
    JSON.stringify({ id: "concl-1", kind: "conclusion_summary", runId: "r1", companyId: "c1", goalSlug: "g", points: ["p1"], tags: [], createdAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "future-1", kind: "future_kind_unknown", payload: "keep raw" }),
    '{"id":"broken-1",BROKEN',
  ].join("\n") + "\n");
  w(root, "memory/lessons.jsonl", JSON.stringify({ id: "lesson-1", kind: "failure_lesson", scope: { companyId: "c1", role: "dev" }, lesson: "教训", status: "committed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }) + "\n");
  w(root, "memory/project.jsonl", JSON.stringify({ id: "mem-1", createdAt: "2026-07-01T00:00:00.000Z", hits: 5, agentRole: "dev", goalSlug: "g", text: "经验一", tags: [] }) + "\n");
  wj(root, "memory/growth-snapshot.json", { registry: { "skill-1": { support: 3 } } });
  wj(root, "install-transactions.json", [{ txId: "t1", at: "2026-07-01T00:00:00.000Z", mode: "merge", companyId: "c1", status: "completed" }]);
  wj(root, "governance-records.json", [{ runId: "r1", level: "L2", decidedAt: "2026-07-03T01:00:00.000Z", events: [] }]);
  wj(root, "task-graphs.json", [{ id: "tg1", missionId: "m1", companyId: "c1", nodes: [], status: "committed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "dispatch-queue.json", { v: 1, items: [{ id: "q1", runId: "r9", companyId: "c1", enqueuedAt: "2026-07-04T00:00:00.000Z" }] });
  wj(root, "memory-jobs.json", [{ jobId: "j1", kind: "export", companyId: "c1", status: "completed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "chat-threads/c1__a1.json", { v: 1, companyId: "c1", agentId: "a1", turns: [{ role: "user", content: "hi", at: "2026-07-01T00:00:00.000Z" }] });
  w(root, "architect/company-edit-proposals.jsonl", JSON.stringify({ proposal_id: "edit_prop_1", targetId: "tgt1", operations: [], status: "pending", createdAt: "2026-07-01T00:00:00.000Z" }) + "\n");
  wj(root, "goals.json", [{ id: "g1", goal: "长目标", companyId: "c1", status: "running", rounds: [], createdAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "missions.json", [{ id: "m1", companyId: "c1", createdAt: "2026-07-01T00:00:00.000Z", approvalStatus: "approved" }]);
}

function srcOf(report: ReturnType<typeof goldenCompare>, source: string) {
  const s = report.sources.find((x) => x.source === source);
  if (!s) throw new Error(`报告缺源 ${source}`);
  return s;
}

describe("goldenCompare · 构造假 .opc", () => {
  it("迁移后 0 差异(单参形态,默认打开 projectRoot 的库)", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);

    const report = goldenCompare(root);
    const bad = report.sources.filter((s) => s.mismatched.length || s.missing.length || s.extra.length);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);

    // 隔离语义:registry 源里 future-1 有合法 id(expected 计入)但被隔离进 unknown_lines,
    // 不入 memory_records(actual 少 1),且**不算 missing** —— 这是预期缺席,非漏迁。
    const reg = srcOf(report, "memory/registry.jsonl");
    expect(reg.expected).toBe(2); // concl-1 + future-1(broken 行 parse 不了,不计 expected)
    expect(reg.actual).toBe(1);   // 只有 concl-1 入表
    expect(reg.missing).toEqual([]);
  });

  it("篡改 SQLite 里的 doc → mismatched 逐 pk 报出", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    db.prepare("UPDATE companies SET doc = ? WHERE id = 'c1'").run(JSON.stringify({ id: "c1", name: "TAMPERED", ceoId: "a1", createdAt: "2026-07-01T00:00:00.000Z", extra: { nested: [1, 2] } }));

    const report = goldenCompare(root);
    expect(report.ok).toBe(false);
    expect(srcOf(report, "companies.json").mismatched).toEqual(["c1"]);
    // 其余源不受牵连
    expect(srcOf(report, "agents.json").mismatched).toEqual([]);
  });

  it("SQLite 漏行 → missing;凭空多行 → extra", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    db.prepare("DELETE FROM agents WHERE id = 'a2'").run();
    db.prepare("INSERT INTO goals (id, companyId, status, createdAt, endedAt, doc) VALUES ('ghost-goal', 'c1', 'running', NULL, NULL, ?)").run(JSON.stringify({ id: "ghost-goal" }));

    const report = goldenCompare(root);
    expect(report.ok).toBe(false);
    expect(srcOf(report, "agents.json").missing).toEqual(["a2"]);
    expect(srcOf(report, "goals.json").extra).toEqual(["ghost-goal"]);
  });

  it("迁移后源侧新增记录 → 如实报 missing(比对器独立重读源,不吃迁移器缓存)", () => {
    const root = mkRoot();
    buildOpc(root);
    migrateJsonToSqlite(root);
    const abs = path.join(root, ".opc", "companies.json");
    const arr = JSON.parse(fs.readFileSync(abs, "utf-8")) as unknown[];
    arr.push({ id: "c3", name: "迁移后新增", createdAt: "2026-07-05T00:00:00.000Z" });
    fs.writeFileSync(abs, JSON.stringify(arr, null, 2), "utf-8");

    const report = goldenCompare(root);
    expect(report.ok).toBe(false);
    expect(srcOf(report, "companies.json").missing).toEqual(["c3"]);
  });

  it("空 root:全部源 present=false,0 差异(未迁移库上比对不崩)", () => {
    const root = mkRoot();
    const report = goldenCompare(root);
    expect(report.ok).toBe(true);
    expect(report.sources.every((s) => !s.present && s.expected === 0 && s.actual === 0)).toBe(true);
  });
});
