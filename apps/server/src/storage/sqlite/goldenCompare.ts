import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "./db.js";
import { openDb } from "./db.js";
import { ensureSchema } from "./schema.js";
import { readDocsByPk, readRunTaskDocs, readUnknownLines } from "./sqliteToJson.js";

// 战役B·Phase B1:金样本比对器。**独立**重读 canonical 源(不复用 migrate 的抽取路径),
// 与 SQLite 里 JSON.parse(doc) 的还原做逐条 deep-equal → 证明迁移无损、无篡改、无漏无重。
// 独立性是关键:比对器自己解析源文件,能抓出迁移器 doc 写入/序列化/upsert 覆盖的真实 bug,
// 而不是自证式的"用同一段代码比自己"。
//
// 三向差异:
//   mismatched —— pk 两侧都有但 doc 不等(真·数据被改坏)
//   missing    —— 源里有(且有合法 pk)但 SQLite 表里没有,且该行**未被隔离进 unknown_lines**(真·漏迁)
//   extra      —— SQLite 表里有但源里没有(真·凭空多出)
// JSONL 里"认不得的行"(如未知 kind)有合法 id 却被有意隔离进 unknown_lines —— 这类 missing 是预期的,不计差异。

export interface SourceDiff {
  source: string;
  table: string;
  present: boolean;
  expected: number;   // 源里有合法 pk 的记录数
  actual: number;     // SQLite 表里的记录数
  mismatched: string[]; // pk 列表
  missing: string[];    // pk 列表(已剔除被隔离进 unknown_lines 的)
  extra: string[];      // pk 列表
}
export interface GoldenReport {
  ok: boolean;
  sources: SourceDiff[];
}

// ── JSON 值的稳定序列化(对象键递归排序;数组保序)→ 字符串相等即 deep-equal ──
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k])).join(",") + "}";
}
function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function opcPath(root: string, ...parts: string[]): string {
  return path.join(root, ".opc", ...parts);
}
function readTextOrNull(abs: string): string | null {
  try { return fs.readFileSync(abs, "utf-8"); } catch { return null; }
}
function isDirtyName(name: string): boolean {
  return /\.(bak|exp\d+|pre-restore|backup)$/i.test(name) || name.includes(".tmp-") || name.includes(".corrupt-") || name.includes(".pre-restore");
}

// 独立读取:返回 { present, expected: Map<pk,doc> }。
type IndependentRead = { present: boolean; expected: Map<string, unknown> };

function readJsonArray(root: string, rel: string, pkField: string): IndependentRead {
  const raw = readTextOrNull(opcPath(root, rel));
  if (raw === null) return { present: false, expected: new Map() };
  const expected = new Map<string, unknown>();
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { present: true, expected }; }
  if (!Array.isArray(data)) return { present: true, expected };
  for (const item of data) {
    const pk = (item as Record<string, unknown> | null)?.[pkField];
    if (item && typeof item === "object" && typeof pk === "string" && pk) expected.set(pk, item);
  }
  return { present: true, expected };
}

function readJsonl(root: string, rel: string, pkField: string): IndependentRead {
  const raw = readTextOrNull(opcPath(root, rel));
  if (raw === null) return { present: false, expected: new Map() };
  const expected = new Map<string, unknown>();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; } // parse 不了的行不算"有合法 pk 的期望记录"
    const pk = (o as Record<string, unknown> | null)?.[pkField];
    if (o && typeof o === "object" && typeof pk === "string" && pk) expected.set(pk, o);
  }
  return { present: true, expected };
}

function readJsonSingle(root: string, rel: string, fixedPk: string): IndependentRead {
  const raw = readTextOrNull(opcPath(root, rel));
  if (raw === null) return { present: false, expected: new Map() };
  const expected = new Map<string, unknown>();
  try { expected.set(fixedPk, JSON.parse(raw)); } catch { /* 损坏单对象 → 无期望记录 */ }
  return { present: true, expected };
}

function readDispatchQueue(root: string, rel: string): IndependentRead {
  const raw = readTextOrNull(opcPath(root, rel));
  if (raw === null) return { present: false, expected: new Map() };
  const expected = new Map<string, unknown>();
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return { present: true, expected }; }
  const items = (obj as { items?: unknown })?.items;
  if (Array.isArray(items)) {
    for (const it of items) {
      const pk = (it as Record<string, unknown> | null)?.id;
      if (it && typeof it === "object" && typeof pk === "string" && pk) expected.set(pk, it);
    }
  }
  return { present: true, expected };
}

function readChatThreads(root: string): IndependentRead {
  const dir = opcPath(root, "chat-threads");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return { present: false, expected: new Map() }; }
  const expected = new Map<string, unknown>();
  for (const name of names) {
    if (!name.endsWith(".json") || isDirtyName(name)) continue;
    const raw = readTextOrNull(path.join(dir, name));
    if (raw === null) continue;
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { continue; }
    const o = obj as Record<string, unknown>;
    const companyId = typeof o.companyId === "string" ? o.companyId : "";
    const agentId = typeof o.agentId === "string" ? o.agentId : "";
    if (companyId || agentId) expected.set(`${companyId}::${agentId}`, obj);
  }
  return { present: true, expected };
}

function readRunsTasks(root: string): IndependentRead {
  const runsDir = opcPath(root, "runs");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return { present: false, expected: new Map() }; }
  const expected = new Map<string, unknown>();
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith("_") || isDirtyName(e.name)) continue;
    const raw = readTextOrNull(path.join(runsDir, e.name, "task.json"));
    if (raw === null) continue;
    let run: unknown;
    try { run = JSON.parse(raw); } catch { continue; }
    const o = run as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : e.name;
    expected.set(id, run);
  }
  return { present: true, expected };
}

// 从 unknown_lines 里解析出被隔离行的 pk(best-effort;解析不了的行没有 pk,不影响判定)。
function quarantinedPks(db: DatabaseSync, source: string, pkField: string): Set<string> {
  const out = new Set<string>();
  for (const raw of readUnknownLines(db, source)) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      const pk = o?.[pkField];
      if (typeof pk === "string" && pk) out.add(pk);
    } catch { /* 无法解析的行没有 pk */ }
  }
  return out;
}

interface SourceSpec {
  source: string;
  table: string;
  pkField: string;
  read: (root: string) => IndependentRead;
  actual: (db: DatabaseSync) => Map<string, unknown>;
}

const SPECS: SourceSpec[] = [
  { source: "companies.json", table: "companies", pkField: "id", read: (r) => readJsonArray(r, "companies.json", "id"), actual: (db) => readDocsByPk(db, "companies") },
  { source: "agents.json", table: "agents", pkField: "id", read: (r) => readJsonArray(r, "agents.json", "id"), actual: (db) => readDocsByPk(db, "agents") },
  { source: "runs/", table: "runs", pkField: "id", read: readRunsTasks, actual: readRunTaskDocs },
  { source: "memory/registry.jsonl", table: "memory_records", pkField: "id", read: (r) => readJsonl(r, "memory/registry.jsonl", "id"), actual: (db) => readDocsByPk(db, "memory_records") },
  { source: "memory/lessons.jsonl", table: "lessons", pkField: "id", read: (r) => readJsonl(r, "memory/lessons.jsonl", "id"), actual: (db) => readDocsByPk(db, "lessons") },
  { source: "memory/project.jsonl", table: "memory_entries", pkField: "id", read: (r) => readJsonl(r, "memory/project.jsonl", "id"), actual: (db) => readDocsByPk(db, "memory_entries") },
  { source: "install-transactions.json", table: "install_transactions", pkField: "txId", read: (r) => readJsonArray(r, "install-transactions.json", "txId"), actual: (db) => readDocsByPk(db, "install_transactions") },
  { source: "governance-records.json", table: "governance_records", pkField: "runId", read: (r) => readJsonArray(r, "governance-records.json", "runId"), actual: (db) => readDocsByPk(db, "governance_records") },
  { source: "task-graphs.json", table: "task_graphs", pkField: "id", read: (r) => readJsonArray(r, "task-graphs.json", "id"), actual: (db) => readDocsByPk(db, "task_graphs") },
  { source: "dispatch-queue.json", table: "dispatch_queue", pkField: "id", read: (r) => readDispatchQueue(r, "dispatch-queue.json"), actual: (db) => readDocsByPk(db, "dispatch_queue") },
  { source: "memory-jobs.json", table: "memory_jobs", pkField: "jobId", read: (r) => readJsonArray(r, "memory-jobs.json", "jobId"), actual: (db) => readDocsByPk(db, "memory_jobs") },
  { source: "chat-threads/", table: "chat_threads", pkField: "__none__", read: readChatThreads, actual: (db) => readDocsByPk(db, "chat_threads") },
  { source: "architect/company-edit-proposals.jsonl", table: "edit_proposals", pkField: "proposal_id", read: (r) => readJsonl(r, "architect/company-edit-proposals.jsonl", "proposal_id"), actual: (db) => readDocsByPk(db, "edit_proposals") },
  { source: "memory/growth-snapshot.json", table: "growth_snapshots", pkField: "__none__", read: (r) => readJsonSingle(r, "memory/growth-snapshot.json", "growth-snapshot"), actual: (db) => readDocsByPk(db, "growth_snapshots") },
  { source: "goals.json", table: "goals", pkField: "id", read: (r) => readJsonArray(r, "goals.json", "id"), actual: (db) => readDocsByPk(db, "goals") },
  { source: "missions.json", table: "missions", pkField: "id", read: (r) => readJsonArray(r, "missions.json", "id"), actual: (db) => readDocsByPk(db, "missions") },
];

function compareOne(projectRoot: string, db: DatabaseSync, spec: SourceSpec): SourceDiff {
  const { present, expected } = spec.read(projectRoot);
  const actual = spec.actual(db);
  const quarantined = spec.pkField === "__none__" ? new Set<string>() : quarantinedPks(db, spec.source, spec.pkField);

  const mismatched: string[] = [];
  const missing: string[] = [];
  const extra: string[] = [];

  for (const [pk, doc] of expected) {
    if (actual.has(pk)) {
      if (!deepEqual(doc, actual.get(pk))) mismatched.push(pk);
    } else if (!quarantined.has(pk)) {
      missing.push(pk);
    }
  }
  for (const pk of actual.keys()) {
    if (!expected.has(pk)) extra.push(pk);
  }
  return { source: spec.source, table: spec.table, present, expected: expected.size, actual: actual.size, mismatched, missing, extra };
}

// 主入口:对 projectRoot 的 .opc 源与 db 里的迁移结果逐源比对。db 缺省 = openDb(projectRoot)
// (与迁移器同一连接/同一库);测试比对副本库时可显式传入。ensureSchema 幂等前置,
// 保证在从未迁移过的库上比对也不会 "no such table"(此时全表空,差异如实报 missing)。
export function goldenCompare(projectRoot: string, db: DatabaseSync = openDb(projectRoot)): GoldenReport {
  ensureSchema(db);
  const sources = SPECS.map((s) => compareOne(projectRoot, db, s));
  const ok = sources.every((s) => s.mismatched.length === 0 && s.missing.length === 0 && s.extra.length === 0);
  return { ok, sources };
}
