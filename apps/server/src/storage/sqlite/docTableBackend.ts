import type { DatabaseSync } from "./db.js";
import { openDb } from "./db.js";
import { ensureSchema, BUSINESS_TABLES, type TableMeta } from "./schema.js";

// 战役B·Phase B2a:通用 doc 表后端 helper —— 所有"中立 store"在 SQLite 后端下共用的读写原语。
// ─ 设计 ─────────────────────────────────────────────────────────────────────
// 1. 单一事实源:每表"提升列如何从一条 canonical 记录投影出来"(= toRow)只在本文件的 COLUMN_PROJECTORS
//    定义一份;migrateJsonToSqlite.ts 的迁移建行与运行时 store 的双写建行都引这同一份,杜绝双份漂移。
//    doc 列永远是权威(整条记录逐字节 JSON),提升列只是索引投影(缺失/异形 → NULL,由 bindScalar 归一)。
// 2. 主键:pk 列名取自 schema.BUSINESS_TABLES(= 建表权威);pk 值如何从记录取(有的字段名与列名不一致,
//    如 edit_proposals 列名 proposalId、doc 字段 proposal_id)由 PK_OF 定义,同样单一事实源。
// 3. 全部同步 API,与 node:sqlite(DatabaseSync)+ 各 store 的同步接口天然匹配。
// 4. 本文件在 storage/ 下,不受 repositorySeam.guard 扫描(只扫 routes/runtime);SQLite 写入天然原子(WAL)。

export type SqlScalar = string | number | null;

// 归一为 node:sqlite 可绑定的标量:undefined/null→null、boolean→0/1、有限 number/string 原样、其余→null
//(doc 里有真相,提升列只做索引)。与 migrateJsonToSqlite 迁移期的绑定口径完全一致(迁移器 import 本函数)。
export function bindScalar(v: unknown): SqlScalar {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return v;
  return null;
}

// ── 单一事实源:每表的列投影(toRow)与主键取值 ──────────────────────────────────
// 键 = schema 表名。值域必须与 schema.ts 的 CREATE TABLE 派生列 / BUSINESS_TABLES.columns 对齐
//(schema.test.ts 用 PRAGMA 交叉核对列;此处若漏列,该列迁移/双写恒为默认——doc 仍无损)。
export type ColumnProjector = (rec: Record<string, unknown>) => Record<string, unknown>;
export type PkExtractor = (rec: Record<string, unknown>) => unknown;

export const COLUMN_PROJECTORS: Record<string, ColumnProjector> = {
  companies: (c) => ({ name: c.name, ceoId: c.ceoId, createdAt: c.createdAt }),
  agents: (a) => ({ companyId: a.companyId, role: a.role, name: a.name, parentId: a.parentId }),
  // runs 的 summary/partial/indexOnly 不由 task doc 派生(来自 _index.json)——迁移器 extractRuns 另行覆盖;
  // 这里只投影 task.json 可派生的基础列,供未来运行时 runs 写(B2b)复用。
  runs: (o) => ({
    companyId: o.companyId, status: o.status, startedAt: o.startedAt, endedAt: o.endedAt,
    totalTokens: o.totalTokens, totalCostUsd: o.totalCostUsd, degraded: o.degraded,
  }),
  memory_records: (o) => ({ kind: o.kind, companyId: o.companyId, createdAt: o.createdAt }),
  lessons: (o) => {
    const scope = (o.scope ?? {}) as Record<string, unknown>;
    return { kind: o.kind, status: o.status, companyId: scope.companyId, role: scope.role, createdAt: o.createdAt, updatedAt: o.updatedAt };
  },
  memory_entries: (o) => ({ agentRole: o.agentRole, goalSlug: o.goalSlug, hits: o.hits, createdAt: o.createdAt }),
  install_transactions: (t) => ({ companyId: t.companyId, mode: t.mode, at: t.at, status: t.status }),
  governance_records: (g) => ({ level: g.level, decidedAt: g.decidedAt }),
  task_graphs: (g) => ({ missionId: g.missionId, companyId: g.companyId, status: g.status, createdAt: g.createdAt, updatedAt: g.updatedAt }),
  dispatch_queue: (o) => ({ runId: o.runId, companyId: o.companyId, enqueuedAt: o.enqueuedAt }),
  memory_jobs: (j) => ({ kind: j.kind, companyId: j.companyId, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt }),
  chat_threads: (o) => ({ companyId: o.companyId, agentId: o.agentId }),
  edit_proposals: (o) => ({ targetId: o.targetId, status: o.status, createdAt: o.createdAt }),
  growth_snapshots: () => ({}),
  goals: (g) => ({ companyId: g.companyId, status: g.status, createdAt: g.createdAt, endedAt: g.endedAt }),
  missions: (m) => ({ companyId: m.companyId, approvalStatus: m.approvalStatus, createdAt: m.createdAt }),
};

// pk 值从记录里怎么取(doc 字段名可能异于 schema pk 列名)。全量重写型 store(replaceAllDocs)靠它逐条取 pk。
export const PK_OF: Record<string, PkExtractor> = {
  companies: (r) => r.id,
  agents: (r) => r.id,
  runs: (r) => r.id,
  memory_records: (r) => r.id,
  lessons: (r) => r.id,
  memory_entries: (r) => r.id,
  install_transactions: (r) => r.txId,
  governance_records: (r) => r.runId,
  task_graphs: (r) => r.id,
  dispatch_queue: (r) => r.id,
  memory_jobs: (r) => r.jobId,
  chat_threads: (r) => `${r.companyId}::${r.agentId}`,
  edit_proposals: (r) => r.proposal_id, // 注意:doc 字段 proposal_id ≠ schema 列名 proposalId
  growth_snapshots: () => "growth-snapshot",
  goals: (r) => r.id,
  missions: (r) => r.id,
};

const TABLE_META: Map<string, TableMeta> = new Map(BUSINESS_TABLES.map((m) => [m.table, m]));

function metaOf(table: string): TableMeta {
  const m = TABLE_META.get(table);
  if (!m) throw new Error(`docTableBackend: 未知表 ${table}(schema.BUSINESS_TABLES 缺元数据)`);
  return m;
}

/** 一条记录的提升列投影(供迁移器与运行时双写共用;未注册的表回退空投影,doc 仍无损)。 */
export function columnsFor(table: string, rec: Record<string, unknown>): Record<string, unknown> {
  const proj = COLUMN_PROJECTORS[table];
  return proj ? proj(rec) : {};
}

/** 从记录取 pk 值(全量重写型 store 用)。 */
export function pkValueOf(table: string, rec: Record<string, unknown>): unknown {
  const fn = PK_OF[table];
  return fn ? fn(rec) : undefined;
}

// ── 连接:openDb + ensureSchema(幂等,per-连接只跑一次业务表建表)──────────────────
const schemaReady = new WeakSet<DatabaseSync>();

/** 拿到已建好业务表 schema 的连接(所有中立 store 的 SQLite 分支入口)。 */
export function openBusinessDb(projectRoot: string): DatabaseSync {
  const db = openDb(projectRoot);
  if (!schemaReady.has(db)) {
    ensureSchema(db);
    schemaReady.add(db);
  }
  return db;
}

// ── 读原语 ─────────────────────────────────────────────────────────────────────

/** 全表 doc 数组,按 rowid(= 插入序;全量重写型 store 即上次写入的数组序)。 */
export function readAllDocs(db: DatabaseSync, table: string): unknown[] {
  metaOf(table);
  const rows = db.prepare(`SELECT doc FROM ${table} ORDER BY rowid`).all() as Array<{ doc: string }>;
  return rows.map((r) => JSON.parse(r.doc));
}

/** 单行 doc(按 pk 值)——每对/单例型 store(chat_threads / growth_snapshots)用;无则 undefined。 */
export function readDocByPk(db: DatabaseSync, table: string, pk: unknown): unknown | undefined {
  const meta = metaOf(table);
  const row = db.prepare(`SELECT doc FROM ${table} WHERE ${meta.pk} = ?`).get(pk as SqlScalar) as { doc: string } | undefined;
  return row ? JSON.parse(row.doc) : undefined;
}

// ── 写原语(全部同步;调用方在 SQLite 后端时于 JSON 写之后调用 = 双写)──────────────

/**
 * 按 pk upsert 一条记录(INSERT ... ON CONFLICT(pk) DO UPDATE)。columns 缺省 = columnsFor(table, record)。
 * record 整体存 doc 列(权威);columns 只填提升列。与 migrateJsonToSqlite.upsertRows 同一建行口径。
 */
export function upsertDoc(
  db: DatabaseSync,
  table: string,
  pk: unknown,
  record: unknown,
  columns?: Record<string, unknown>,
): void {
  const meta = metaOf(table);
  const cols = meta.columns;
  const projected = columns ?? columnsFor(table, (record ?? {}) as Record<string, unknown>);
  const allCols = [meta.pk, ...cols, "doc"];
  const placeholders = allCols.map(() => "?").join(", ");
  const updates = [...cols, "doc"].map((c) => `${c}=excluded.${c}`).join(", ");
  const sql =
    `INSERT INTO ${table} (${allCols.join(", ")}) VALUES (${placeholders}) ` +
    `ON CONFLICT(${meta.pk}) DO UPDATE SET ${updates}`;
  const params: SqlScalar[] = [
    bindScalar(pk),
    ...cols.map((c) => bindScalar(projected[c])),
    JSON.stringify(record),
  ];
  db.prepare(sql).run(...params);
}

/** 按 pk 删除一行;不存在则 no-op。 */
export function deleteDoc(db: DatabaseSync, table: string, id: unknown): void {
  const meta = metaOf(table);
  db.prepare(`DELETE FROM ${table} WHERE ${meta.pk} = ?`).run(bindScalar(id));
}

/**
 * 全量重写:清空该表并按 records 顺序重插(pk 由 PK_OF 取,列由 COLUMN_PROJECTORS 投影)。
 * 用于"整文件读写"型 store(task_graphs / dispatch_queue / memory_jobs / governance_records / edit_proposals)——
 * 其 JSON 侧本就是整数组覆盖写,SQLite 侧全量重写语义等价,且 rowid 递增保证 readAllDocs 返回同一数组序。
 * 事务包裹:并发读者要么看到旧全量、要么看到新全量,绝不看到清空中途的空表。
 */
export function replaceAllDocs(db: DatabaseSync, table: string, records: unknown[]): void {
  metaOf(table);
  db.exec("BEGIN");
  try {
    db.prepare(`DELETE FROM ${table}`).run();
    for (const rec of records) {
      const r = (rec ?? {}) as Record<string, unknown>;
      upsertDoc(db, table, pkValueOf(table, r), rec);
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* 回滚失败不掩盖原始错误 */ }
    throw err;
  }
}
