import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "./db.js";
import { openDb } from "./db.js";
import { ensureSchema, BUSINESS_TABLES, type TableMeta } from "./schema.js";

// 战役B·Phase B1:SQLite → JSON 逆向导出器(观察期后的回退保障 + 金样本比对的读侧)。
// doc 列存的就是源里的原始记录,JSON.parse(doc) 即无损还原;派生列一律不用于还原(只是索引投影)。
// 表名全部来自 schema.BUSINESS_TABLES 的静态常量,非外部输入 → 直接拼接 SQL 安全。
//
// 两层 API:
//   - 读侧原语(readTableDocs / readDocsByPk / readRunTaskDocs / readUnknownLine*):goldenCompare 与测试用。
//   - sqliteToJson(projectRoot, outDir):落盘导出器,把各表 doc 还原成原 JSON/JSONL 文件形状写进 outDir;
//     unknown_lines 按 source+lineNo 回位(JSONL 的未知行插回原行位;整文件损坏的源逐字节 verbatim 还原)。
//     outDir 必须是独立目录(拒绝直接写运行中的 .opc)——回退流程 = 导出 → 人工核验 → 再回切。

const META: Map<string, TableMeta> = new Map(BUSINESS_TABLES.map((m) => [m.table, m]));

function metaOf(table: string): TableMeta {
  const m = META.get(table);
  if (!m) throw new Error(`sqliteToJson: 未知表 ${table}`);
  return m;
}

// 取一张表的全部 doc(按 rowid = 迁移插入序;首次迁移即源数组原序)。
export function readTableDocs(db: DatabaseSync, table: string): unknown[] {
  metaOf(table);
  const rows = db.prepare(`SELECT doc FROM ${table} ORDER BY rowid`).all() as Array<{ doc: string }>;
  return rows.map((r) => JSON.parse(r.doc));
}

// 取一张表的 pk → doc 映射(金样本按 pk 做集合比对用)。
export function readDocsByPk(db: DatabaseSync, table: string): Map<string, unknown> {
  const meta = metaOf(table);
  const rows = db.prepare(`SELECT ${meta.pk} AS pk, doc FROM ${table} ORDER BY rowid`).all() as Array<{ pk: string; doc: string }>;
  const out = new Map<string, unknown>();
  for (const r of rows) out.set(String(r.pk), JSON.parse(r.doc));
  return out;
}

// runs 专用:只取 task.json 权威行(indexOnly=0)的 run doc 映射(孤儿 index 行不在 task.json 语义内)。
export function readRunTaskDocs(db: DatabaseSync): Map<string, unknown> {
  const rows = db.prepare("SELECT id AS pk, doc FROM runs WHERE indexOnly = 0 ORDER BY rowid").all() as Array<{ pk: string; doc: string }>;
  const out = new Map<string, unknown>();
  for (const r of rows) out.set(String(r.pk), JSON.parse(r.doc));
  return out;
}

// 取一个源(source key)对应 unknown_lines 的原始行 + 行号(逆向还原时按 lineNo 回位)。
export interface UnknownLineRow {
  lineNo: number | null;
  raw: string;
}
export function readUnknownLineRows(db: DatabaseSync, source: string): UnknownLineRow[] {
  return db.prepare("SELECT lineNo, raw FROM unknown_lines WHERE source = ? ORDER BY id").all(source) as unknown as UnknownLineRow[];
}
export function readUnknownLines(db: DatabaseSync, source: string): string[] {
  return readUnknownLineRows(db, source).map((r) => r.raw);
}

// 回退用:把各表 doc 还原成"接近原始文件"的 JS 结构(调用方负责落盘)。
// 说明:数组类源还原为 doc 数组;JSONL 类源还原为 doc 数组(+ unknown 原始行);
// growth-snapshot 还原为单对象;dispatch-queue 还原为 { v:1, items };runs 还原为 { [id]: run }(task 权威行)。
export interface ReconstructedFiles {
  "companies.json": unknown[];
  "agents.json": unknown[];
  "install-transactions.json": unknown[];
  "governance-records.json": unknown[];
  "task-graphs.json": unknown[];
  "memory-jobs.json": unknown[];
  "goals.json": unknown[];
  "missions.json": unknown[];
  "memory/registry.jsonl": unknown[];
  "memory/lessons.jsonl": unknown[];
  "memory/project.jsonl": unknown[];
  "architect/company-edit-proposals.jsonl": unknown[];
  "memory/growth-snapshot.json": unknown;
  "dispatch-queue.json": { v: number; items: unknown[] };
  "chat-threads": Record<string, unknown>;
  "runs": Record<string, unknown>;
}

export function reconstructFiles(db: DatabaseSync): ReconstructedFiles {
  const chatThreads: Record<string, unknown> = {};
  for (const [k, v] of readDocsByPk(db, "chat_threads")) chatThreads[k] = v;
  const runs: Record<string, unknown> = {};
  for (const [k, v] of readRunTaskDocs(db)) runs[k] = v;
  const snapRows = readTableDocs(db, "growth_snapshots");

  return {
    "companies.json": readTableDocs(db, "companies"),
    "agents.json": readTableDocs(db, "agents"),
    "install-transactions.json": readTableDocs(db, "install_transactions"),
    "governance-records.json": readTableDocs(db, "governance_records"),
    "task-graphs.json": readTableDocs(db, "task_graphs"),
    "memory-jobs.json": readTableDocs(db, "memory_jobs"),
    "goals.json": readTableDocs(db, "goals"),
    "missions.json": readTableDocs(db, "missions"),
    "memory/registry.jsonl": readTableDocs(db, "memory_records"),
    "memory/lessons.jsonl": readTableDocs(db, "lessons"),
    "memory/project.jsonl": readTableDocs(db, "memory_entries"),
    "architect/company-edit-proposals.jsonl": readTableDocs(db, "edit_proposals"),
    "memory/growth-snapshot.json": snapRows.length ? snapRows[0] : null,
    "dispatch-queue.json": { v: 1, items: readTableDocs(db, "dispatch_queue") },
    "chat-threads": chatThreads,
    runs,
  };
}

// ═════════════════════════ 落盘导出器 sqliteToJson(projectRoot, outDir) ═════════════════════════

export interface UnrecoveredItem {
  source: string;
  file: string;   // 落盘位置(相对 outDir;内容零丢失,只是无法还原到原位/原名)
  reason: string;
}
export interface SqliteToJsonResult {
  outDir: string;
  files: string[];          // 写出的文件(相对 outDir,正斜杠)
  skippedAbsent: string[];  // _migrations 无记录(迁移时源就不存在)→ 不导出,不造空文件
  unrecovered: UnrecoveredItem[];
}

function pretty(v: unknown): string {
  return JSON.stringify(v, null, 2); // 对齐 jsonFile.writeJSON 的落盘格式
}
function tryParse(raw: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false }; }
}
// 整文件损坏的源:迁移时 rows=0 且整个原文进了一条 lineNo=NULL 的 unknown 行 → 逐字节 verbatim 还原。
function wholeFileCorrupt(docs: unknown[], unknowns: UnknownLineRow[]): string | null {
  if (docs.length === 0 && unknowns.length === 1 && unknowns[0].lineNo === null && !tryParse(unknowns[0].raw).ok) {
    return unknowns[0].raw;
  }
  return null;
}

// JSONL 还原:known 行(rowid 序 = 首迁时的源内序)与 unknown 行(lineNo 序)归并,
// unknown 行插回其原始行位(lineNo 1-based;源里若有空行会整体前移,内容不受影响)。
function renderJsonl(docs: unknown[], unknowns: UnknownLineRow[]): string {
  const placed = unknowns.filter((u) => typeof u.lineNo === "number").sort((a, b) => (a.lineNo as number) - (b.lineNo as number));
  const tail = unknowns.filter((u) => typeof u.lineNo !== "number");
  const out: string[] = [];
  let d = 0;
  let u = 0;
  const total = docs.length + placed.length;
  for (let i = 0; i < total; i++) {
    if (u < placed.length && (d >= docs.length || (placed[u].lineNo as number) - 1 <= i)) {
      out.push(placed[u].raw);
      u++;
    } else {
      out.push(JSON.stringify(docs[d]));
      d++;
    }
  }
  for (const t of tail) out.push(t.raw);
  return out.length ? out.join("\n") + "\n" : "";
}

// 复刻 chatThreadStore.ts:36 的文件名净化规则(store 未导出;B1 不改 store)。
const safeFileName = (s: string) => ((s || "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "_");

// 复刻 projectStore.ts:368 runToIndexEntry(未导出;B1 不改 store)+ _index 独有的 summary/partial 列。
// indexOnly=0 行的 _index 条目按当前 task doc 重新派生(与 store 增量写口径一致);undefined 字段
// 经 JSON.stringify 自动剔除,与原 writeJSON 行为相同。
function deriveIndexEntry(run: Record<string, unknown>, summary: string | null, partial: number | null): Record<string, unknown> {
  const userGoal = typeof run.userGoal === "string" ? run.userGoal : "";
  const participating = Array.isArray(run.participatingAgents) ? (run.participatingAgents as unknown[]) : [];
  const entry: Record<string, unknown> = {
    id: run.id,
    goal: userGoal.slice(0, 200),
    status: run.status,
    degraded: run.degraded,
    degradedReason: typeof run.degradedReason === "string" ? run.degradedReason.slice(0, 160) : undefined,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    totalTokens: run.totalTokens,
    totalCostUsd: run.totalCostUsd,
    agents: participating.length,
    agentIds: [...new Set(participating)].slice(0, 6),
    companyId: run.companyId,
  };
  if (summary !== null) entry.summary = summary;
  if (partial !== null) entry.partial = partial !== 0;
  return entry;
}

const ARRAY_EXPORTS: Array<{ key: string; table: string }> = [
  { key: "companies.json", table: "companies" },
  { key: "agents.json", table: "agents" },
  { key: "install-transactions.json", table: "install_transactions" },
  { key: "governance-records.json", table: "governance_records" },
  { key: "task-graphs.json", table: "task_graphs" },
  { key: "memory-jobs.json", table: "memory_jobs" },
  { key: "goals.json", table: "goals" },
  { key: "missions.json", table: "missions" },
];
const JSONL_EXPORTS: Array<{ key: string; table: string }> = [
  { key: "memory/registry.jsonl", table: "memory_records" },
  { key: "memory/lessons.jsonl", table: "lessons" },
  { key: "memory/project.jsonl", table: "memory_entries" },
  { key: "architect/company-edit-proposals.jsonl", table: "edit_proposals" },
];

// 主入口:openDb(projectRoot) 读迁移库,把 doc 还原成原文件形状写进 outDir(布局与 .opc 内部一致)。
// 只导出 _migrations 里有记录的源(迁移时不存在的源不造空文件);内容零丢失:能回原位的回原位,
// 回不了原位的(如损坏聊天线程原文件名不可考)落 unrecovered 文件并在结果里如实列出。
export function sqliteToJson(projectRoot: string, outDir: string): SqliteToJsonResult {
  const liveOpc = path.resolve(projectRoot, ".opc");
  const out = path.resolve(outDir);
  const same = process.platform === "win32" ? out.toLowerCase() === liveOpc.toLowerCase() : out === liveOpc;
  if (same) {
    throw new Error("sqliteToJson: outDir 不能是运行中的 .opc —— 回退流程是导出到独立目录、人工核验后再回切");
  }

  const db = openDb(projectRoot);
  ensureSchema(db); // 幂等;从未迁移过的库也能安全导出(结果为全 skippedAbsent)

  const migrated = new Set<string>(
    (db.prepare("SELECT source FROM _migrations").all() as Array<{ source: string }>).map((r) => r.source),
  );

  const files: string[] = [];
  const skippedAbsent: string[] = [];
  const unrecovered: UnrecoveredItem[] = [];

  const write = (rel: string, content: string): void => {
    const abs = path.join(out, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
    files.push(rel);
  };

  // ① JSON 数组源:doc 原序还原;缺主键而被隔离的元素(lineNo=NULL、raw 可 parse)追加回数组尾
  //   (原数组内位置未记录,追加是无损但不保序的 best-effort);整文件损坏 → verbatim。
  for (const spec of ARRAY_EXPORTS) {
    if (!migrated.has(spec.key)) { skippedAbsent.push(spec.key); continue; }
    const docs = readTableDocs(db, spec.table);
    const unknowns = readUnknownLineRows(db, spec.key);
    const corrupt = wholeFileCorrupt(docs, unknowns);
    if (corrupt !== null) { write(spec.key, corrupt); continue; }
    const items = [...docs];
    let n = 0;
    for (const u of unknowns) {
      const p = tryParse(u.raw);
      if (p.ok) { items.push(p.value); continue; }
      n++;
      const rel = `${spec.key}.unrecovered-${n}`;
      write(rel, u.raw);
      unrecovered.push({ source: spec.key, file: rel, reason: "unknown 行不是合法 JSON,无法放回数组" });
    }
    write(spec.key, pretty(items));
  }

  // ② JSONL 源:unknown 行按 lineNo 插回原行位 → 首迁后的导出可逐字节还原原文件。
  for (const spec of JSONL_EXPORTS) {
    if (!migrated.has(spec.key)) { skippedAbsent.push(spec.key); continue; }
    write(spec.key, renderJsonl(readTableDocs(db, spec.table), readUnknownLineRows(db, spec.key)));
  }

  // ③ 单对象源 growth-snapshot。
  {
    const key = "memory/growth-snapshot.json";
    if (!migrated.has(key)) { skippedAbsent.push(key); }
    else {
      const docs = readTableDocs(db, "growth_snapshots");
      const unknowns = readUnknownLineRows(db, key);
      const corrupt = wholeFileCorrupt(docs, unknowns);
      if (corrupt !== null) write(key, corrupt);
      else if (docs.length > 0) write(key, pretty(docs[0]));
    }
  }

  // ④ dispatch-queue:{ v, items } 包装还原。顶层 v 迁移时未单列存储,按 store 当前版本常量 1 回填。
  {
    const key = "dispatch-queue.json";
    if (!migrated.has(key)) { skippedAbsent.push(key); }
    else {
      const docs = readTableDocs(db, "dispatch_queue");
      const unknowns = readUnknownLineRows(db, key);
      const corrupt = wholeFileCorrupt(docs, unknowns);
      if (corrupt !== null) write(key, corrupt);
      else {
        const items = [...docs];
        for (const u of unknowns) { const p = tryParse(u.raw); if (p.ok) items.push(p.value); }
        write(key, pretty({ v: 1, items }));
      }
    }
  }

  // ⑤ chat-threads:按 doc 的 companyId/agentId 用 store 同款净化规则重建原文件名;
  //   损坏线程文件(原文件名不可考)落 _unrecovered-<n>.json,内容原样保留。
  {
    const key = "chat-threads/";
    if (!migrated.has(key)) { skippedAbsent.push(key); }
    else {
      const used = new Set<string>();
      for (const doc of readTableDocs(db, "chat_threads")) {
        const o = (doc ?? {}) as Record<string, unknown>;
        const companyId = typeof o.companyId === "string" ? o.companyId : "";
        const agentId = typeof o.agentId === "string" ? o.agentId : "";
        let rel = `chat-threads/${safeFileName(companyId)}__${safeFileName(agentId)}.json`;
        if (used.has(rel)) {
          const base = rel.slice(0, -".json".length);
          let i = 2;
          while (used.has(`${base}.dup-${i}.json`)) i++;
          rel = `${base}.dup-${i}.json`;
          unrecovered.push({ source: key, file: rel, reason: "净化后的文件名与另一线程撞名,追加 .dup 后缀" });
        }
        used.add(rel);
        write(rel, pretty(doc));
      }
      let n = 0;
      for (const u of readUnknownLineRows(db, key)) {
        n++;
        const rel = `chat-threads/_unrecovered-${n}.json`;
        write(rel, u.raw);
        unrecovered.push({ source: key, file: rel, reason: "损坏线程文件,原文件名不可考" });
      }
    }
  }

  // ⑥ runs:indexOnly=0 行还原 runs/<id>/task.json(doc 即 task.json);_index.json 重建 =
  //   孤儿行(indexOnly=1)doc 原样 + task 行按 runToIndexEntry 口径从 doc 派生并带回 summary/partial 列。
  {
    const key = "runs/";
    if (!migrated.has(key)) { skippedAbsent.push(key); }
    else {
      const rows = db.prepare("SELECT id, indexOnly, summary, partial, doc FROM runs ORDER BY rowid").all() as Array<{
        id: string; indexOnly: number; summary: string | null; partial: number | null; doc: string;
      }>;
      const index: Record<string, unknown> = {};
      let bad = 0;
      for (const r of rows) {
        const doc = JSON.parse(r.doc) as Record<string, unknown>;
        if (r.indexOnly) { index[r.id] = doc; continue; }
        index[r.id] = deriveIndexEntry(doc, r.summary, r.partial);
        if (/[\\/]|\.\./.test(r.id)) {
          bad++;
          const rel = `runs/_unrecovered-${bad}.task.json`;
          write(rel, pretty(doc));
          unrecovered.push({ source: key, file: rel, reason: `run id 含路径字符,拒绝按 id 建目录:${JSON.stringify(r.id)}` });
          continue;
        }
        write(`runs/${r.id}/task.json`, pretty(doc));
      }
      write("runs/_index.json", pretty(index));
    }
  }

  return { outDir: out, files, skippedAbsent, unrecovered };
}
