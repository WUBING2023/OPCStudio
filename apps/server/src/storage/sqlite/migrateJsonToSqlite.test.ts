import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, closeAllDbs, closeDb } from "./db.js";
import { migrateJsonToSqlite } from "./migrateJsonToSqlite.js";
import { goldenCompare } from "./goldenCompare.js";
import { readDocsByPk, reconstructFiles } from "./sqliteToJson.js";

// Phase B1 迁移器用例:全部在临时目录建【构造的假 .opc】或【真实 .opc 的副本】,绝不原地碰真库。
// 覆盖:建表迁移 / 幂等(连跑两遍 + force 都不重复)/ unknown 行保全 / doc JSON 无损还原 / 源文件原样不动。

const roots: string[] = [];
function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-migrate-"));
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
function tableCount(db: ReturnType<typeof openDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}
function unknownCount(db: ReturnType<typeof openDb>, source: string): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM unknown_lines WHERE source = ?").get(source) as { c: number }).c;
}

// 构造一份覆盖全部源 + 脏文件 + unknown 行的假 .opc。
function buildFakeOpc(root: string): void {
  // companies:带额外字段 extra 证明 doc 无损
  wj(root, "companies.json", [
    { id: "c1", name: "Co1", description: "d", ceoId: "a1", createdAt: "2026-07-01T00:00:00.000Z", extra: { nested: [1, 2, 3] } },
    { id: "c2", name: "Co2", description: "", ceoId: "a3", createdAt: "2026-07-02T00:00:00.000Z" },
  ]);
  // agents:多公司混存
  wj(root, "agents.json", [
    { id: "a1", companyId: "c1", role: "ceo", name: "CEO", parentId: undefined, childrenIds: ["a2"], model: "m", provider: "p" },
    { id: "a2", companyId: "c1", role: "dev", name: "Dev", parentId: "a1", childrenIds: [], model: "m", provider: "p" },
    { id: "a3", companyId: "c2", role: "ceo", name: "CEO2", childrenIds: [], model: "m", provider: "p" },
  ]);
  // 脏文件:绝不能泄漏进结果
  wj(root, "agents.json.bak", [{ id: "GHOST", companyId: "x", role: "ghost", name: "G", childrenIds: [], model: "m", provider: "p" }]);
  w(root, "agents.json.tmp-999-888", "{ broken tmp");
  wj(root, "companies.pre-restore.json", [{ id: "GHOSTCO", name: "ghost", description: "", createdAt: "x" }]);

  // runs:r1/r2 有 task.json;_index 含 r1/r2 摘要 + orphan1 孤儿条目;脏 run 目录须忽略
  wj(root, "runs/r1/task.json", { id: "r1", userGoal: "目标一", companyId: "c1", status: "done", startedAt: "2026-07-03T01:00:00.000Z", endedAt: "2026-07-03T01:05:00.000Z", totalTokens: 100, totalCostUsd: 0.5, participatingAgents: ["a1", "a2"], degraded: false });
  wj(root, "runs/r2/task.json", { id: "r2", userGoal: "目标二", companyId: "c1", status: "failed", startedAt: "2026-07-03T02:00:00.000Z", totalTokens: 50, totalCostUsd: 0.1, participatingAgents: ["a1"] });
  wj(root, "runs/_index.json", {
    r1: { id: "r1", goal: "目标一", status: "done", startedAt: "2026-07-03T01:00:00.000Z", endedAt: "2026-07-03T01:05:00.000Z", totalTokens: 100, totalCostUsd: 0.5, agents: 2, agentIds: ["a1", "a2"], summary: "完成目标一", partial: false, companyId: "c1" },
    r2: { id: "r2", goal: "目标二", status: "failed", startedAt: "2026-07-03T02:00:00.000Z", totalTokens: 50, agents: 1, summary: "目标二失败", partial: true, companyId: "c1" },
    orphan1: { id: "orphan1", goal: "无 task.json 的孤儿", status: "failed", startedAt: "2026-06-01T00:00:00.000Z", summary: "孤儿", partial: false },
  });
  wj(root, "runs/r1.tmp-99999-1/task.json", { id: "SHOULD_IGNORE", userGoal: "脏 run", status: "done", startedAt: "x", totalTokens: 0, participatingAgents: [] });
  wj(root, "runs/_archive/task.json", { id: "UNDERSCORE_IGNORE", userGoal: "下划线目录", status: "done", startedAt: "x", totalTokens: 0, participatingAgents: [] });

  // registry.jsonl:3 合法 kind + 1 未知 kind(有 id)+ 1 损坏 JSON → 后两者进 unknown_lines
  w(root, "memory/registry.jsonl", [
    JSON.stringify({ id: "concl-1", kind: "conclusion_summary", runId: "r1", companyId: "c1", goalSlug: "g", points: ["p1", "p2"], tags: ["t"], createdAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "skill-1", kind: "procedural_skill", role: "dev", preconditions: [], successfulSequence: ["Bash"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1"], status: "verified", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "plan-1", kind: "plan_template", companyId: "c1", taskType: "general", goalSlug: "g", split: ["s1", "s2"], workerCount: 2, sourceRun: "r1", support: 1, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ id: "future-1", kind: "future_kind_unknown", payload: "keep me raw" }),
    '{"id":"broken-1","kind":"conclusion_summary",BROKEN',
  ].join("\n") + "\n");

  // lessons.jsonl:1 合法 + 1 未知 kind(有 id)
  w(root, "memory/lessons.jsonl", [
    JSON.stringify({ id: "lesson-1", schemaVersion: "reflection_lesson.v1", kind: "failure_lesson", scope: { companyId: "c1", role: "test", teamId: "tm" }, trigger: { eventTypes: [], failureMode: "timeout", conditionText: "c" }, diagnosis: "d", lesson: "教训内容够长", recommendedChange: "改法够长", injection: { strength: "warning", promptText: "注入文本够长" }, evidence: { runId: "r1" }, confidence: 0.8, status: "committed", version: 1, createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", hits: 3, ineffective: 0, support: 1 }),
    JSON.stringify({ id: "lesson-future", kind: "brand_new_kind", note: "keep raw" }),
  ].join("\n") + "\n");

  // project.jsonl:2 合法(含 schema 外的 layer 字段,证明无损)+ 1 损坏行
  w(root, "memory/project.jsonl", [
    JSON.stringify({ id: "mem-1", createdAt: "2026-07-01T00:00:00.000Z", hits: 5, layer: "project", agentRole: "dev", goalSlug: "g", text: "经验一", tags: ["a"], source: { runId: "r1", agentId: "a2" } }),
    JSON.stringify({ id: "mem-2", createdAt: "2026-07-02T00:00:00.000Z", hits: 0, agentRole: "*", goalSlug: "g2", text: "经验二", tags: [], source: { runId: "r2", agentId: "a1" } }),
    "{not json at all",
  ].join("\n") + "\n");

  // growth-snapshot:单对象
  wj(root, "memory/growth-snapshot.json", { registry: { "skill-1": { support: 3, status: "verified" } } });

  wj(root, "install-transactions.json", [{ txId: "t1", at: "2026-07-01T00:00:00.000Z", mode: "merge", source: "tmpl", companyId: "c1", created: { agentIds: [], companyIds: [], presetChannelKeys: [], skillIds: [] }, agentSnapshots: [], conflictDecisions: [], safeInstallStripped: [], status: "completed" }]);
  wj(root, "governance-records.json", [{ runId: "r1", level: "L2", reason: ["writesFiles"], decidedAt: "2026-07-03T01:00:00.000Z", inputs: { goalPreview: "g", frameworks: [], writesFiles: true, involvesMcp: false, involvesAcp: false, involvesShell: false }, events: [] }]);
  wj(root, "task-graphs.json", [{ id: "tg1", missionId: "m1", companyId: "c1", goal: "mg", nodes: [], status: "committed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", schemaVersion: "1" }]);
  wj(root, "dispatch-queue.json", { v: 1, items: [{ id: "q1", runId: "r9", goal: "排队目标", companyId: "c1", enqueuedAt: "2026-07-04T00:00:00.000Z" }] });
  wj(root, "memory-jobs.json", [{ jobId: "j1", kind: "export", companyId: "c1", status: "completed", createdAt: "2026-07-01T00:00:00.000Z", updatedAt: "2026-07-01T00:00:00.000Z", result: { recordCount: 3 } }]);
  wj(root, "goals.json", [{ id: "g1", goal: "长目标", companyId: "c1", status: "running", maxRounds: 5, rounds: [], createdAt: "2026-07-01T00:00:00.000Z" }]);
  wj(root, "missions.json", [{ id: "m1", companyId: "c1", createdAt: "2026-07-01T00:00:00.000Z", originalIdea: "idea", interpretedGoal: "goal", successCriteria: [], nonGoals: [], assumptions: [], risks: [], requiredDepartments: [], expectedArtifacts: [], suggestedRunType: "team", permissionNeeds: "write_code", approvalStatus: "approved" }]);

  // chat-threads:1 合法文件 + 1 脏文件(.bak)须忽略
  wj(root, "chat-threads/c1__a1.json", { v: 1, companyId: "c1", agentId: "a1", turns: [{ role: "user", content: "hi", at: "2026-07-01T00:00:00.000Z" }, { role: "assistant", content: "hello", at: "2026-07-01T00:00:01.000Z" }] });
  wj(root, "chat-threads/c1__a1.json.bak", { v: 1, companyId: "GHOST", agentId: "GHOST", turns: [] });

  // edit-proposals.jsonl:1 合法 + 1 缺 proposal_id(→ unknown)
  w(root, "architect/company-edit-proposals.jsonl", [
    JSON.stringify({ proposal_id: "edit_prop_1", targetId: "tgt1", summary: "s", operations: [], risks: [], requires_user_confirmation: true, status: "pending", createdAt: "2026-07-01T00:00:00.000Z" }),
    JSON.stringify({ summary: "no id proposal", operations: [] }),
  ].join("\n") + "\n");

  // 含密钥文件:必须不迁(迁移器根本不读它们,这里放一份确保不误触)
  wj(root, "config.json", { version: "0.1.0", apiKeys: { anthropic: "sk-SECRET" } });
  wj(root, "providers.json", { anthropic: { apiKey: "sk-SECRET2" } });
}

describe("migrateJsonToSqlite · 构造假 .opc", () => {
  it("首迁:各表行数 + unknown 行数符合预期,脏文件/密钥文件零泄漏", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    const report = migrateJsonToSqlite(root);
    const db = openDb(root);

    expect(tableCount(db, "companies")).toBe(2);
    expect(tableCount(db, "agents")).toBe(3);
    expect(tableCount(db, "runs")).toBe(3); // r1, r2 (task) + orphan1 (indexOnly)
    expect(tableCount(db, "memory_records")).toBe(3);
    expect(tableCount(db, "lessons")).toBe(1);
    expect(tableCount(db, "memory_entries")).toBe(2);
    expect(tableCount(db, "install_transactions")).toBe(1);
    expect(tableCount(db, "governance_records")).toBe(1);
    expect(tableCount(db, "task_graphs")).toBe(1);
    expect(tableCount(db, "dispatch_queue")).toBe(1);
    expect(tableCount(db, "memory_jobs")).toBe(1);
    expect(tableCount(db, "chat_threads")).toBe(1);
    expect(tableCount(db, "edit_proposals")).toBe(1);
    expect(tableCount(db, "growth_snapshots")).toBe(1);
    expect(tableCount(db, "goals")).toBe(1);
    expect(tableCount(db, "missions")).toBe(1);

    // unknown 行:registry 2(未知kind + 损坏)、lessons 1、project 1、edit 1
    expect(unknownCount(db, "memory/registry.jsonl")).toBe(2);
    expect(unknownCount(db, "memory/lessons.jsonl")).toBe(1);
    expect(unknownCount(db, "memory/project.jsonl")).toBe(1);
    expect(unknownCount(db, "architect/company-edit-proposals.jsonl")).toBe(1);

    // 脏文件零泄漏
    expect(db.prepare("SELECT COUNT(*) AS c FROM agents WHERE id='GHOST'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM companies WHERE id='GHOSTCO'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM runs WHERE id IN ('SHOULD_IGNORE','UNDERSCORE_IGNORE')").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM chat_threads WHERE companyId='GHOST'").get()).toEqual({ c: 0 });

    // runs 派生列:summary/partial 来自 _index;orphan1 标 indexOnly=1
    const r1 = db.prepare("SELECT summary, partial, indexOnly FROM runs WHERE id='r1'").get() as { summary: string; partial: number; indexOnly: number };
    expect(r1).toEqual({ summary: "完成目标一", partial: 0, indexOnly: 0 });
    const orphan = db.prepare("SELECT indexOnly FROM runs WHERE id='orphan1'").get() as { indexOnly: number };
    expect(orphan.indexOnly).toBe(1);

    // report 汇总
    expect(report.totalUnknown).toBe(5);
    expect(report.backend).toBe("sqlite");
  });

  it("金样本:goldenCompare 0 差异(doc JSON 无损还原,含 schema 外字段 layer/extra)", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    const report = goldenCompare(root, db);
    const bad = report.sources.filter((s) => s.mismatched.length || s.missing.length || s.extra.length);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);
    expect(report.ok).toBe(true);

    // 直接抽验 doc 无损:companies 的嵌套 extra、project 的 layer 字段逐字段还原
    const co = readDocsByPk(db, "companies").get("c1") as Record<string, unknown>;
    expect(co.extra).toEqual({ nested: [1, 2, 3] });
    const mem = readDocsByPk(db, "memory_entries").get("mem-1") as Record<string, unknown>;
    expect(mem.layer).toBe("project"); // MemoryEntry 类型无此字段,但 doc 逐字节保留
  });

  it("幂等①:连跑两遍,行数与 unknown 数完全不变(第二遍 hash 未变整源跳过)", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    const first = migrateJsonToSqlite(root);
    const db = openDb(root);
    const before = snapshotCounts(db);

    const second = migrateJsonToSqlite(root);
    const after = snapshotCounts(db);
    expect(after).toEqual(before);
    // 第二遍所有存在的源都被 skip
    expect(second.sources.filter((s) => s.present).every((s) => s.skipped)).toBe(true);
    // 第一遍没有 skip(全新库)
    expect(first.sources.filter((s) => s.present).some((s) => s.skipped)).toBe(false);
  });

  it("幂等②:force 强制重跑(绕过 hash 跳过),按主键 upsert 仍不重复、unknown 不翻倍", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    const before = snapshotCounts(db);

    const forced = migrateJsonToSqlite(root, { force: true });
    const after = snapshotCounts(db);
    expect(after).toEqual(before);
    // force 下没有 skip,真的重跑了 upsert
    expect(forced.sources.filter((s) => s.present).some((s) => s.skipped)).toBe(false);
  });

  it("JSON 源文件原样保留不动(迁移只写 SQLite)", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    const before = new Map<string, string>();
    for (const rel of ["companies.json", "agents.json", "memory/registry.jsonl", "runs/_index.json", "goals.json"]) {
      before.set(rel, fs.readFileSync(path.join(root, ".opc", rel), "utf-8"));
    }
    migrateJsonToSqlite(root);
    for (const [rel, content] of before) {
      expect(fs.readFileSync(path.join(root, ".opc", rel), "utf-8"), `${rel} 被改动了`).toBe(content);
    }
  });

  it("unknown 行原样逐字节保留(损坏 JSON 文本不改写)", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    const raws = (db.prepare("SELECT raw FROM unknown_lines WHERE source='memory/registry.jsonl' ORDER BY id").all() as Array<{ raw: string }>).map((r) => r.raw);
    expect(raws).toContain('{"id":"broken-1","kind":"conclusion_summary",BROKEN');
    // 未知 kind 的合法 JSON 行也原样保留
    expect(raws.some((r) => r.includes("future_kind_unknown") && r.includes("keep me raw"))).toBe(true);
  });

  it("reconstructFiles 逆向还原:数组/单对象/队列/线程/runs 结构正确", () => {
    const root = mkRoot();
    buildFakeOpc(root);
    migrateJsonToSqlite(root);
    const db = openDb(root);
    const files = reconstructFiles(db);
    expect((files["companies.json"] as unknown[]).length).toBe(2);
    expect((files["dispatch-queue.json"]).items.length).toBe(1);
    expect((files["dispatch-queue.json"]).v).toBe(1);
    expect(Object.keys(files["runs"])).toEqual(expect.arrayContaining(["r1", "r2"]));
    expect(Object.keys(files["runs"])).not.toContain("orphan1"); // 孤儿 index 行不算 task 权威
    expect((files["memory/growth-snapshot.json"] as { registry: unknown }).registry).toEqual({ "skill-1": { support: 3, status: "verified" } });
  });
});

interface Counts { [k: string]: number; }
function snapshotCounts(db: ReturnType<typeof openDb>): Counts {
  const tables = ["companies", "agents", "runs", "memory_records", "lessons", "memory_entries", "install_transactions", "governance_records", "task_graphs", "dispatch_queue", "memory_jobs", "chat_threads", "edit_proposals", "growth_snapshots", "goals", "missions"];
  const c: Counts = {};
  for (const t of tables) c[t] = tableCount(db, t);
  c["__unknown__"] = (db.prepare("SELECT COUNT(*) AS c FROM unknown_lines").get() as { c: number }).c;
  return c;
}

// ── 真实 .opc 的【副本】上跑金样本(绝不原地)。真库不存在则跳过(CI 便携)。────────
describe("migrateJsonToSqlite · 真实 .opc 副本金样本", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
  const realOpc = path.join(repoRoot, ".opc");

  // 只复制迁移器会读的 canonical 输入(避开 65MB 证据 blob),放进临时副本根。
  function copyCanonicalInputs(srcOpc: string, dstRoot: string): boolean {
    if (!fs.existsSync(srcOpc)) return false;
    const dstOpc = path.join(dstRoot, ".opc");
    let copied = 0;
    const cp = (rel: string) => {
      const s = path.join(srcOpc, rel);
      if (!fs.existsSync(s)) return;
      const d = path.join(dstOpc, rel);
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      copied++;
    };
    for (const f of ["companies.json", "agents.json", "governance-records.json", "task-graphs.json", "dispatch-queue.json", "memory-jobs.json", "goals.json", "missions.json", "install-transactions.json"]) cp(f);
    for (const f of ["registry.jsonl", "lessons.jsonl", "project.jsonl", "growth-snapshot.json"]) cp(path.join("memory", f));
    cp(path.join("architect", "company-edit-proposals.jsonl"));
    // chat-threads:整目录 *.json
    const ct = path.join(srcOpc, "chat-threads");
    if (fs.existsSync(ct)) for (const n of fs.readdirSync(ct)) if (n.endsWith(".json")) cp(path.join("chat-threads", n));
    // runs:_index.json + 每个 run 的 task.json only
    const runsSrc = path.join(srcOpc, "runs");
    if (fs.existsSync(runsSrc)) {
      cp(path.join("runs", "_index.json"));
      for (const e of fs.readdirSync(runsSrc, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith("_")) cp(path.join("runs", e.name, "task.json"));
      }
    }
    return copied > 0;
  }

  it("真实 .opc 副本迁移 → goldenCompare 0 差异 + 幂等重跑行数不变", () => {
    const root = mkRoot();
    const copied = copyCanonicalInputs(realOpc, root);
    if (!copied) { expect(true).toBe(true); return; } // 真库不在(CI)→ 跳过

    const report = migrateJsonToSqlite(root);
    expect(report.totalRows).toBeGreaterThan(0);
    const db = openDb(root);

    const golden = goldenCompare(root, db);
    const bad = golden.sources.filter((s) => s.mismatched.length || s.missing.length || s.extra.length);
    expect(bad, JSON.stringify(bad, null, 2)).toEqual([]);

    const before = snapshotCounts(db);
    // 重开连接后再迁一遍(模拟进程重启),行数必须不变
    closeDb(root);
    migrateJsonToSqlite(root);
    const db2 = openDb(root);
    expect(snapshotCounts(db2)).toEqual(before);
  });
});
