import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "./db.js";
import { openDb } from "./db.js";
import { ensureSchema, BUSINESS_TABLES, type TableMeta } from "./schema.js";
import { bindScalar, columnsFor, type SqlScalar } from "./docTableBackend.js";

// 战役B·Phase B1:JSON/JSONL → SQLite 一次性无损迁移器。
// ─ 铁律 ─────────────────────────────────────────────────────────────────────
// 1. 只读 **canonical 文件名**:忽略 .bak / .tmp-* / .corrupt-* / .pre-restore* / .exp35 / .backup 等脏副本。
// 2. **幂等**:_migrations 记 (源, 内容 sha256, 时间);重跑源 hash 未变即整源跳过。即便强制重跑(force),
//    也按主键 upsert(ON CONFLICT DO UPDATE),绝不 append 重复;unknown_lines 按源先删后插,零重复。
// 3. JSONL 认不得的行(JSON.parse 失败 / kind 判别不了)→ unknown_lines 原样保留,对齐 registry/reflection
//    现有"不丢未知行"纪律。JSON 数组里缺主键的元素同样进 unknown_lines(不静默丢)。
// 4. JSON **源文件原样保留不动**:本迁移器只读源、只写 SQLite,绝不改写/删除任何 .opc 下的 JSON/JSONL。
// 5. 含密钥/用户手编的源**不迁**:config/providers/accounts/github_oauth/mcp_*/pricing/provider_health(见 plan §0.1)。
//    这些文件不在下方 SOURCES 列表里 = 迁移器根本不碰。
//
// doc 列 = JSON.stringify(源里已解析的原始记录),逐字节可还原(JSON.parse→stringify→parse 对 JSON 值恒等)。
// 派生列只是索引投影(缺失/异形 → NULL),doc 才是权威。

interface RecordRow {
  pk: string;
  cols: Record<string, unknown>; // 允许 undefined/boolean,bindScalar 统一归一
  doc: unknown;
}
interface UnknownLine {
  lineNo: number | null;
  raw: string;
}
interface Extracted {
  present: boolean;      // 源文件/目录是否存在
  rows: RecordRow[];
  unknown: UnknownLine[];
  hashInput: string;     // 用于 sha256 幂等判定(源内容;多文件源则拼接)
}
interface SourceDef {
  key: string;   // _migrations.source 主键 & unknown_lines.source(相对 .opc 的稳定标识)
  table: string;
  extract: (projectRoot: string) => Extracted;
}

export interface SourceMigrationResult {
  source: string;
  table: string;
  present: boolean;
  skipped: boolean;   // hash 未变跳过
  rows: number;       // 本次 upsert 的记录数
  unknown: number;    // 本次落 unknown_lines 的行数
}
export interface MigrationReport {
  backend: "sqlite";
  sources: SourceMigrationResult[];
  totalRows: number;
  totalUnknown: number;
}

export interface MigrateOptions {
  force?: boolean; // true = 忽略 hash 跳过,强制重跑(用于证明 upsert 本身幂等)
}

const EMPTY: Extracted = { present: false, rows: [], unknown: [], hashInput: "" };

function opcPath(projectRoot: string, ...parts: string[]): string {
  return path.join(projectRoot, ".opc", ...parts);
}

// bindScalar / columnsFor(建行/列投影)从 docTableBackend.ts 引入 —— 迁移建行与运行时双写建行单一事实源。

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf-8").digest("hex");
}

// ── 通用抽取器 ────────────────────────────────────────────────────────────────

function readTextOrNull(abs: string): string | null {
  try { return fs.readFileSync(abs, "utf-8"); } catch { return null; }
}

// JSON 数组源:每元素一行记录,pkField 缺失/非串 → 进 unknown_lines(不丢)。
function extractJsonArray(
  projectRoot: string,
  rel: string,
  pkField: string,
  colFn: (item: Record<string, unknown>) => Record<string, unknown>,
): Extracted {
  const raw = readTextOrNull(opcPath(projectRoot, rel));
  if (raw === null) return EMPTY;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { present: true, rows: [], unknown: [{ lineNo: null, raw }], hashInput: raw }; }
  if (!Array.isArray(data)) return { present: true, rows: [], unknown: [{ lineNo: null, raw }], hashInput: raw };
  const rows: RecordRow[] = [];
  const unknown: UnknownLine[] = [];
  for (const item of data) {
    const pk = (item as Record<string, unknown> | null)?.[pkField];
    if (item && typeof item === "object" && typeof pk === "string" && pk) {
      rows.push({ pk, cols: colFn(item as Record<string, unknown>), doc: item });
    } else {
      unknown.push({ lineNo: null, raw: JSON.stringify(item) });
    }
  }
  return { present: true, rows, unknown, hashInput: raw };
}

// JSONL 源:classify 返回 {pk, cols} 表示"认得",null 表示未知(进 unknown_lines 原样保留)。
function extractJsonl(
  projectRoot: string,
  rel: string,
  classify: (o: Record<string, unknown>) => { pk: string; cols: Record<string, unknown> } | null,
): Extracted {
  const raw = readTextOrNull(opcPath(projectRoot, rel));
  if (raw === null) return EMPTY;
  const rows: RecordRow[] = [];
  const unknown: UnknownLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try { parsed = JSON.parse(t); } catch { unknown.push({ lineNo, raw: t }); continue; }
    const c = parsed && typeof parsed === "object" ? classify(parsed as Record<string, unknown>) : null;
    if (!c || typeof c.pk !== "string" || !c.pk) { unknown.push({ lineNo, raw: t }); continue; }
    rows.push({ pk: c.pk, cols: c.cols, doc: parsed });
  }
  return { present: true, rows, unknown, hashInput: raw };
}

// 单对象源(growth-snapshot.json):整个对象一行,pk 固定。
function extractJsonSingle(projectRoot: string, rel: string, fixedPk: string): Extracted {
  const raw = readTextOrNull(opcPath(projectRoot, rel));
  if (raw === null) return EMPTY;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return { present: true, rows: [], unknown: [{ lineNo: null, raw }], hashInput: raw }; }
  return { present: true, rows: [{ pk: fixedPk, cols: {}, doc: obj }], unknown: [], hashInput: raw };
}

// dispatch-queue.json = { v, items:[...] };拆 items 为行(顶层 v 是常量,回退时由 store 兜默认)。
function extractDispatchQueue(projectRoot: string, rel: string): Extracted {
  const raw = readTextOrNull(opcPath(projectRoot, rel));
  if (raw === null) return EMPTY;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return { present: true, rows: [], unknown: [{ lineNo: null, raw }], hashInput: raw }; }
  const items = (obj as { items?: unknown })?.items;
  if (!Array.isArray(items)) return { present: true, rows: [], unknown: [], hashInput: raw };
  const rows: RecordRow[] = [];
  const unknown: UnknownLine[] = [];
  for (const it of items) {
    const pk = (it as Record<string, unknown> | null)?.id;
    if (it && typeof it === "object" && typeof pk === "string" && pk) {
      const o = it as Record<string, unknown>;
      rows.push({ pk, cols: columnsFor("dispatch_queue", o), doc: it });
    } else {
      unknown.push({ lineNo: null, raw: JSON.stringify(it) });
    }
  }
  return { present: true, rows, unknown, hashInput: raw };
}

const DIRTY_SUFFIX_RE = /\.(bak|exp\d+|corrupt-\d+|pre-restore|backup)$|\.tmp-|\.pre-restore\./i;
function isDirtyName(name: string): boolean {
  return DIRTY_SUFFIX_RE.test(name) || name.includes(".tmp-") || name.includes(".corrupt-") || name.includes(".pre-restore");
}

// chat-threads/<co>__<agent>.json:每文件一条线程,threadKey = companyId::agentId。
function extractChatThreads(projectRoot: string): Extracted {
  const dir = opcPath(projectRoot, "chat-threads");
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return EMPTY; }
  const rows: RecordRow[] = [];
  const unknown: UnknownLine[] = [];
  const hashParts: string[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json") || isDirtyName(name)) continue;
    const raw = readTextOrNull(path.join(dir, name));
    if (raw === null) continue;
    hashParts.push(`${name}\n${raw}`);
    let obj: unknown;
    try { obj = JSON.parse(raw); } catch { unknown.push({ lineNo: null, raw }); continue; }
    const o = obj as Record<string, unknown>;
    const companyId = typeof o.companyId === "string" ? o.companyId : "";
    const agentId = typeof o.agentId === "string" ? o.agentId : "";
    if (!companyId && !agentId) { unknown.push({ lineNo: null, raw }); continue; }
    rows.push({ pk: `${companyId}::${agentId}`, cols: columnsFor("chat_threads", { companyId, agentId }), doc: obj });
  }
  return { present: true, rows, unknown, hashInput: hashParts.join("\n \n") };
}

// runs:runs/<id>/task.json(权威 doc)+ runs/_index.json(summary/partial 派生列)。
// _index 有、task.json 无的孤儿条目 → indexOnly=1 行(doc = 该 index 条目,不丢)。
function extractRuns(projectRoot: string): Extracted {
  const runsDir = opcPath(projectRoot, "runs");
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(runsDir, { withFileTypes: true }); } catch { return EMPTY; }

  const byId = new Map<string, RecordRow>();
  const hashParts: string[] = [];

  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith("_") || isDirtyName(e.name)) continue;
    const raw = readTextOrNull(path.join(runsDir, e.name, "task.json"));
    if (raw === null) continue;
    hashParts.push(`${e.name}/task.json\n${raw}`);
    let run: unknown;
    try { run = JSON.parse(raw); } catch { continue; }
    const o = run as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id : e.name;
    byId.set(id, {
      pk: id,
      cols: {
        companyId: o.companyId, status: o.status, startedAt: o.startedAt, endedAt: o.endedAt,
        totalTokens: o.totalTokens, totalCostUsd: o.totalCostUsd, degraded: o.degraded,
        summary: null, partial: null, indexOnly: 0,
      },
      doc: run,
    });
  }

  // _index.json:map runId → 摘要行。仅取 summary/partial 补列;孤儿条目落 indexOnly 行。
  const indexRaw = readTextOrNull(path.join(runsDir, "_index.json"));
  if (indexRaw !== null) {
    hashParts.push(`_index.json\n${indexRaw}`);
    let idx: unknown;
    try { idx = JSON.parse(indexRaw); } catch { idx = null; }
    if (idx && typeof idx === "object" && !Array.isArray(idx)) {
      for (const [runId, entryU] of Object.entries(idx as Record<string, unknown>)) {
        const entry = (entryU ?? {}) as Record<string, unknown>;
        const existing = byId.get(runId);
        if (existing) {
          existing.cols.summary = typeof entry.summary === "string" ? entry.summary : null;
          existing.cols.partial = entry.partial === undefined ? null : entry.partial;
        } else {
          byId.set(runId, {
            pk: runId,
            cols: {
              companyId: entry.companyId, status: entry.status, startedAt: entry.startedAt, endedAt: entry.endedAt,
              totalTokens: entry.totalTokens, totalCostUsd: entry.totalCostUsd, degraded: entry.degraded,
              summary: typeof entry.summary === "string" ? entry.summary : null,
              partial: entry.partial === undefined ? null : entry.partial,
              indexOnly: 1,
            },
            doc: entry,
          });
        }
      }
    }
  }

  return { present: true, rows: [...byId.values()], unknown: [], hashInput: hashParts.join("\n \n") };
}

// ── 源清单(只列可迁的 canonical 源;密钥/手编源不在此 = 不迁)────────────────────

const SOURCES: SourceDef[] = [
  {
    key: "companies.json", table: "companies",
    extract: (r) => extractJsonArray(r, "companies.json", "id", (c) => columnsFor("companies", c)),
  },
  {
    key: "agents.json", table: "agents",
    extract: (r) => extractJsonArray(r, "agents.json", "id", (a) => columnsFor("agents", a)),
  },
  { key: "runs/", table: "runs", extract: extractRuns },
  {
    key: "memory/registry.jsonl", table: "memory_records",
    extract: (r) => extractJsonl(r, "memory/registry.jsonl", (o) => {
      const kind = o.kind;
      if (kind !== "conclusion_summary" && kind !== "procedural_skill" && kind !== "plan_template") return null;
      if (typeof o.id !== "string" || !o.id) return null;
      return { pk: o.id, cols: columnsFor("memory_records", o) };
    }),
  },
  {
    key: "memory/lessons.jsonl", table: "lessons",
    extract: (r) => extractJsonl(r, "memory/lessons.jsonl", (o) => {
      const kind = o.kind;
      if (kind !== "failure_lesson" && kind !== "risk_warning" && kind !== "policy_candidate") return null;
      if (typeof o.id !== "string" || !o.id) return null;
      return { pk: o.id, cols: columnsFor("lessons", o) };
    }),
  },
  {
    key: "memory/project.jsonl", table: "memory_entries",
    extract: (r) => extractJsonl(r, "memory/project.jsonl", (o) => {
      if (typeof o.id !== "string" || !o.id) return null;
      return { pk: o.id, cols: columnsFor("memory_entries", o) };
    }),
  },
  {
    key: "install-transactions.json", table: "install_transactions",
    extract: (r) => extractJsonArray(r, "install-transactions.json", "txId", (t) => columnsFor("install_transactions", t)),
  },
  {
    key: "governance-records.json", table: "governance_records",
    extract: (r) => extractJsonArray(r, "governance-records.json", "runId", (g) => columnsFor("governance_records", g)),
  },
  {
    key: "task-graphs.json", table: "task_graphs",
    extract: (r) => extractJsonArray(r, "task-graphs.json", "id", (g) => columnsFor("task_graphs", g)),
  },
  { key: "dispatch-queue.json", table: "dispatch_queue", extract: (r) => extractDispatchQueue(r, "dispatch-queue.json") },
  {
    key: "memory-jobs.json", table: "memory_jobs",
    extract: (r) => extractJsonArray(r, "memory-jobs.json", "jobId", (j) => columnsFor("memory_jobs", j)),
  },
  { key: "chat-threads/", table: "chat_threads", extract: extractChatThreads },
  {
    key: "architect/company-edit-proposals.jsonl", table: "edit_proposals",
    extract: (r) => extractJsonl(r, "architect/company-edit-proposals.jsonl", (o) => {
      if (typeof o.proposal_id !== "string" || !o.proposal_id) return null;
      return { pk: o.proposal_id, cols: columnsFor("edit_proposals", o) };
    }),
  },
  { key: "memory/growth-snapshot.json", table: "growth_snapshots", extract: (r) => extractJsonSingle(r, "memory/growth-snapshot.json", "growth-snapshot") },
  {
    key: "goals.json", table: "goals",
    extract: (r) => extractJsonArray(r, "goals.json", "id", (g) => columnsFor("goals", g)),
  },
  {
    key: "missions.json", table: "missions",
    extract: (r) => extractJsonArray(r, "missions.json", "id", (m) => columnsFor("missions", m)),
  },
];

const TABLE_META: Map<string, TableMeta> = new Map(BUSINESS_TABLES.map((m) => [m.table, m]));

// 为一个源构建并执行 upsert:INSERT ... ON CONFLICT(pk) DO UPDATE(按主键更新,绝不 append 重复)。
function upsertRows(db: DatabaseSync, meta: TableMeta, rows: RecordRow[]): void {
  if (rows.length === 0) return;
  const cols = meta.columns;
  const allCols = [meta.pk, ...cols, "doc"];
  const placeholders = allCols.map(() => "?").join(", ");
  const updates = [...cols, "doc"].map((c) => `${c}=excluded.${c}`).join(", ");
  const sql = `INSERT INTO ${meta.table} (${allCols.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${meta.pk}) DO UPDATE SET ${updates}`;
  const stmt = db.prepare(sql);
  for (const row of rows) {
    const params: SqlScalar[] = [row.pk, ...cols.map((c) => bindScalar(row.cols[c])), JSON.stringify(row.doc)];
    stmt.run(...params);
  }
}

// unknown_lines 按源先删后插 → 强制重跑/源变动都零重复。
function refreshUnknownLines(db: DatabaseSync, source: string, unknown: UnknownLine[], nowIso: string): void {
  db.prepare("DELETE FROM unknown_lines WHERE source = ?").run(source);
  if (unknown.length === 0) return;
  const stmt = db.prepare("INSERT INTO unknown_lines (source, lineNo, raw, importedAt) VALUES (?, ?, ?, ?)");
  for (const u of unknown) stmt.run(source, u.lineNo, u.raw, nowIso);
}

function getMigrationHash(db: DatabaseSync, source: string): string | null {
  const row = db.prepare("SELECT sha256 FROM _migrations WHERE source = ?").get(source) as { sha256: string } | undefined;
  return row?.sha256 ?? null;
}
function recordMigration(db: DatabaseSync, source: string, hash: string, nowIso: string): void {
  db.prepare(
    "INSERT INTO _migrations (source, sha256, migratedAt) VALUES (?, ?, ?) " +
    "ON CONFLICT(source) DO UPDATE SET sha256=excluded.sha256, migratedAt=excluded.migratedAt",
  ).run(source, hash, nowIso);
}

// 主入口:只读 canonical 源、幂等 upsert 进 SQLite;源文件原样不动。返回逐源结果 + 汇总。
export function migrateJsonToSqlite(projectRoot: string, opts: MigrateOptions = {}): MigrationReport {
  const db = openDb(projectRoot);
  ensureSchema(db);
  const nowIso = new Date().toISOString();
  const results: SourceMigrationResult[] = [];

  db.exec("BEGIN");
  try {
    for (const def of SOURCES) {
      const meta = TABLE_META.get(def.table);
      if (!meta) throw new Error(`migrateJsonToSqlite: 未知目标表 ${def.table}(schema.BUSINESS_TABLES 缺元数据)`);
      const extracted = def.extract(projectRoot);
      if (!extracted.present) {
        results.push({ source: def.key, table: def.table, present: false, skipped: false, rows: 0, unknown: 0 });
        continue;
      }
      const hash = sha256(extracted.hashInput);
      if (!opts.force && getMigrationHash(db, def.key) === hash) {
        results.push({ source: def.key, table: def.table, present: true, skipped: true, rows: 0, unknown: 0 });
        continue;
      }
      upsertRows(db, meta, extracted.rows);
      refreshUnknownLines(db, def.key, extracted.unknown, nowIso);
      recordMigration(db, def.key, hash, nowIso);
      results.push({ source: def.key, table: def.table, present: true, skipped: false, rows: extracted.rows.length, unknown: extracted.unknown.length });
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw err;
  }

  return {
    backend: "sqlite",
    sources: results,
    totalRows: results.reduce((s, r) => s + r.rows, 0),
    totalUnknown: results.reduce((s, r) => s + r.unknown, 0),
  };
}

// 供 goldenCompare / 测试内省:源清单(key + table)。
export function listMigrationSources(): Array<{ key: string; table: string }> {
  return SOURCES.map((s) => ({ key: s.key, table: s.table }));
}
