import type { DatabaseSync } from "./db.js";

// 战役B·Phase B1:业务表 schema(反推 + 无损)。
// ─ 设计原则 ─────────────────────────────────────────────────────────────────
// 1. 反推:每表把**真实被查询/过滤的字段**(id/status/companyId/时间戳等)提升为列,供索引/WHERE。
// 2. 无损:整条原始记录逐字节存进 `doc` TEXT 列(= JSON.stringify(原始已解析记录))。任何 schema 演进
//    都不丢字段;金样本可对 doc 做 deep-equal 还原(见 goldenCompare.ts)。派生列只是索引投影,doc 才是权威。
// 3. runs 表并入 _index.json 的 summary/partial 两个**不可从 task.json 派生**的列(它们来自 report.md);
//    其余 index 字段(goal/agents/agentIds)可由 doc 派生,不落列。task.json 无对应行的孤儿 index 条目
//    以 indexOnly=1 落行(doc = 该 index 条目),保证零丢失。
// 4. **刻意不加业务外键**(companies↔agents↔runs 之间):真实 .opc 存在 agent.companyId 指向已删公司、
//    run 无 companyId 等脏关联,加 FK 会让无损迁移在合法脏数据上失败。连接级 foreign_keys=ON(db.ts)
//    只对显式声明 REFERENCES 的表(evidence 不声明跨表 FK)生效;这里全表零 REFERENCES = 不受影响。
// 5. ledger / evidence_manifest 本相只**建表**;写入(哈希链 append/verify、证据清单)分别归 B3/B4。
//
// 单一事实源:下方 CREATE TABLE 是建表权威;BUSINESS_TABLES 元数据供 migrateJsonToSqlite 拼 upsert 语句,
// schema.test.ts 用 PRAGMA table_info 交叉核对两者一致(防列漂移)。

// 迁移驱动用的表元数据:pk = 主键列;columns = 提升的派生列(不含 pk、不含 doc,按建表顺序)。
export interface TableMeta {
  table: string;
  pk: string;
  columns: string[];
}

export const BUSINESS_TABLES: TableMeta[] = [
  { table: "companies", pk: "id", columns: ["name", "ceoId", "createdAt"] },
  { table: "agents", pk: "id", columns: ["companyId", "role", "name", "parentId"] },
  { table: "runs", pk: "id", columns: ["companyId", "status", "startedAt", "endedAt", "totalTokens", "totalCostUsd", "degraded", "summary", "partial", "indexOnly"] },
  { table: "memory_records", pk: "id", columns: ["kind", "companyId", "createdAt"] },
  { table: "lessons", pk: "id", columns: ["kind", "status", "companyId", "role", "createdAt", "updatedAt"] },
  { table: "memory_entries", pk: "id", columns: ["agentRole", "goalSlug", "hits", "createdAt"] },
  { table: "install_transactions", pk: "txId", columns: ["companyId", "mode", "at", "status"] },
  { table: "governance_records", pk: "runId", columns: ["level", "decidedAt"] },
  { table: "task_graphs", pk: "id", columns: ["missionId", "companyId", "status", "createdAt", "updatedAt"] },
  { table: "dispatch_queue", pk: "id", columns: ["runId", "companyId", "enqueuedAt"] },
  { table: "memory_jobs", pk: "jobId", columns: ["kind", "companyId", "status", "createdAt", "updatedAt"] },
  { table: "chat_threads", pk: "threadKey", columns: ["companyId", "agentId"] },
  { table: "edit_proposals", pk: "proposalId", columns: ["targetId", "status", "createdAt"] },
  { table: "growth_snapshots", pk: "id", columns: [] },
  { table: "goals", pk: "id", columns: ["companyId", "status", "createdAt", "endedAt"] },
  { table: "missions", pk: "id", columns: ["companyId", "approvalStatus", "createdAt"] },
];

const SCHEMA_SQL = `
-- companies.json(数组)→ companyStore
CREATE TABLE IF NOT EXISTS companies (
  id        TEXT PRIMARY KEY,
  name      TEXT,
  ceoId     TEXT,
  createdAt TEXT,
  doc       TEXT NOT NULL
);

-- agents.json(数组,多公司混存)→ projectStore(mergeSaveAgents = 按 id upsert 天然对齐)
CREATE TABLE IF NOT EXISTS agents (
  id        TEXT PRIMARY KEY,
  companyId TEXT,
  role      TEXT,
  name      TEXT,
  parentId  TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_companyId ON agents(companyId);

-- runs/<id>/task.json(权威 doc)+ runs/_index.json(summary/partial 派生列)→ projectStore
-- indexOnly=1:_index 有、task.json 无的孤儿条目(doc = 该 index 条目,不丢)。
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  companyId    TEXT,
  status       TEXT,
  startedAt    TEXT,
  endedAt      TEXT,
  totalTokens  INTEGER,
  totalCostUsd REAL,
  degraded     INTEGER,
  summary      TEXT,
  partial      INTEGER,
  indexOnly    INTEGER DEFAULT 0,
  doc          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_companyId ON runs(companyId);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_startedAt ON runs(startedAt);

-- memory/registry.jsonl(3 kind 判别联合)→ registryStore
CREATE TABLE IF NOT EXISTS memory_records (
  id        TEXT PRIMARY KEY,
  kind      TEXT,
  companyId TEXT,
  createdAt TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_records_kind ON memory_records(kind);

-- memory/lessons.jsonl(六态生命周期)→ reflectionStore
CREATE TABLE IF NOT EXISTS lessons (
  id        TEXT PRIMARY KEY,
  kind      TEXT,
  status    TEXT,
  companyId TEXT,
  role      TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
CREATE INDEX IF NOT EXISTS idx_lessons_role ON lessons(role);

-- memory/project.jsonl(hits 自增)→ memoryStore
CREATE TABLE IF NOT EXISTS memory_entries (
  id        TEXT PRIMARY KEY,
  agentRole TEXT,
  goalSlug  TEXT,
  hits      INTEGER,
  createdAt TEXT,
  doc       TEXT NOT NULL
);

-- install-transactions.json(数组,上限50)→ installTransactionStore
CREATE TABLE IF NOT EXISTS install_transactions (
  txId      TEXT PRIMARY KEY,
  companyId TEXT,
  mode      TEXT,
  at        TEXT,
  status    TEXT,
  doc       TEXT NOT NULL
);

-- governance-records.json(数组)→ governanceStore(每 run 一条,runId 主键)
CREATE TABLE IF NOT EXISTS governance_records (
  runId     TEXT PRIMARY KEY,
  level     TEXT,
  decidedAt TEXT,
  doc       TEXT NOT NULL
);

-- task-graphs.json(数组)→ taskGraphStore
CREATE TABLE IF NOT EXISTS task_graphs (
  id        TEXT PRIMARY KEY,
  missionId TEXT,
  companyId TEXT,
  status    TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  doc       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_graphs_missionId ON task_graphs(missionId);

-- dispatch-queue.json({v, items})→ dispatchQueueStore(items 拆行,队列项 id 主键)
CREATE TABLE IF NOT EXISTS dispatch_queue (
  id         TEXT PRIMARY KEY,
  runId      TEXT,
  companyId  TEXT,
  enqueuedAt TEXT,
  doc        TEXT NOT NULL
);

-- memory-jobs.json(数组,上限50)→ memoryJobStore
CREATE TABLE IF NOT EXISTS memory_jobs (
  jobId     TEXT PRIMARY KEY,
  kind      TEXT,
  companyId TEXT,
  status    TEXT,
  createdAt TEXT,
  updatedAt TEXT,
  doc       TEXT NOT NULL
);

-- chat-threads/<co>__<agent>.json(每对一文件)→ chatThreadStore(threadKey = companyId::agentId)
CREATE TABLE IF NOT EXISTS chat_threads (
  threadKey TEXT PRIMARY KEY,
  companyId TEXT,
  agentId   TEXT,
  doc       TEXT NOT NULL
);

-- architect/company-edit-proposals.jsonl → companyEditProposalStore
CREATE TABLE IF NOT EXISTS edit_proposals (
  proposalId TEXT PRIMARY KEY,
  targetId   TEXT,
  status     TEXT,
  createdAt  TEXT,
  doc        TEXT NOT NULL
);

-- memory/growth-snapshot.json(单对象)→ agentGrowthStore(单行,id 固定 = 'growth-snapshot')
CREATE TABLE IF NOT EXISTS growth_snapshots (
  id  TEXT PRIMARY KEY,
  doc TEXT NOT NULL
);

-- goals.json(数组)→ goalRunner(routes 侧 store)
CREATE TABLE IF NOT EXISTS goals (
  id        TEXT PRIMARY KEY,
  companyId TEXT,
  status    TEXT,
  createdAt TEXT,
  endedAt   TEXT,
  doc       TEXT NOT NULL
);

-- missions.json(数组)→ missionBrief(routes 侧 store)
CREATE TABLE IF NOT EXISTS missions (
  id            TEXT PRIMARY KEY,
  companyId     TEXT,
  approvalStatus TEXT,
  createdAt     TEXT,
  doc           TEXT NOT NULL
);

-- ledger:append-only 计费流水,rowHash = sha256(prevHash + 行内容)哈希链。本相只建表,
-- append/verifyChain 归 B3(storage/sqlite/ledgerStore.ts)。id 自增 = 追加序即物理序。
-- Human-readable layered memory metadata. Markdown is the content authority;
-- this table and FTS5 index are fully rebuildable from Markdown.
CREATE TABLE IF NOT EXISTS layered_memories (
  memoryId   TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scopeId    TEXT NOT NULL,
  status     TEXT NOT NULL,
  modified   TEXT NOT NULL,
  contentHash TEXT NOT NULL,
  topicPath  TEXT NOT NULL,
  doc        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_layered_memory_scope ON layered_memories(scope, scopeId, status);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  memoryId UNINDEXED,
  scope UNINDEXED,
  scopeId UNINDEXED,
  title,
  summary,
  content,
  tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS memory_proposals_v2 (
  proposalId TEXT PRIMARY KEY,
  scope      TEXT NOT NULL,
  scopeId    TEXT NOT NULL,
  objectType TEXT NOT NULL,
  status     TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  doc        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_proposals_v2_status ON memory_proposals_v2(status);

CREATE TABLE IF NOT EXISTS resource_pointers (
  id          TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,
  scopeId     TEXT NOT NULL,
  status      TEXT NOT NULL,
  validatedAt TEXT,
  expiresAt   TEXT,
  doc         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_curator_runs (
  id        TEXT PRIMARY KEY,
  scope     TEXT,
  scopeId   TEXT,
  status    TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  doc       TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS ledger (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  at               TEXT NOT NULL,
  kind             TEXT NOT NULL,   -- model_call | run_start | run_end | artifact | reconcile_mismatch ...
  runId            TEXT,
  agentId          TEXT,
  provider         TEXT,
  model            TEXT,
  promptTokens     INTEGER,
  completionTokens INTEGER,
  costUsd          REAL,
  costSource       TEXT,            -- api_reported | estimated_len4 | pricing_table
  engine           TEXT,
  executor         TEXT,
  payload          TEXT,            -- 整条明细 doc JSON
  prevHash         TEXT,
  rowHash          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_runId ON ledger(runId);

-- evidence_manifest:单一证据清单(run 目录 22 类证据文件的 {path,sha256,size,kind,createdAt} 索引)。
-- 本相只建表;扫描/构建归 B4(runtime/evidenceManifest.ts + storage/sqlite/evidenceStore.ts)。
CREATE TABLE IF NOT EXISTS evidence_manifest (
  runId     TEXT NOT NULL,
  path      TEXT NOT NULL,
  sha256    TEXT,
  size      INTEGER,
  kind      TEXT,
  createdAt TEXT,
  doc       TEXT,
  PRIMARY KEY (runId, path)
);
CREATE INDEX IF NOT EXISTS idx_evidence_manifest_runId ON evidence_manifest(runId);
`;

// 建全部业务表(幂等,全部 IF NOT EXISTS)。openDb 已建 _migrations/unknown_lines 地基表(见 db.ts),
// 本函数补齐业务表 + ledger + evidence_manifest。调用方:migrateJsonToSqlite 迁移前先 ensureSchema(db)。
export function ensureSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_SQL);
}
