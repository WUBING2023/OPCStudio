import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";

// 不能写静态 import { DatabaseSync } from "node:sqlite":vitest 所用 vite@5.4 不认 node:sqlite
// 为内建模块(剥掉 node: 前缀后去解析名为 "sqlite" 的 npm 包 → 全部引用本文件的测试直接挂)。
// process.getBuiltinModule 是运行时调用,转换器不插手,tsx 与 vitest 双运行时均验证可用;
// 类型走 type-only import(编译期擦除,vite 看不见)。
const sqlite = process.getBuiltinModule("node:sqlite");

export type { DatabaseSync } from "node:sqlite";

// 战役B·Phase B0 地基:.opc/opc.sqlite 的连接管理(唯一 openDb 入口)。
// - 驱动选型:node:sqlite(Node v24 内建,同步 API 与全部 store 的同步接口天然匹配,零 native 依赖)。
//   2026-07-11 冒烟已验证 tsx 运行时可用(建表/插入/upsert/WAL/双连接/重开全通过);
//   进程会打一条 ExperimentalWarning,属预期噪音。若未来 Node 升级出坑,退 better-sqlite3 只改本文件。
// - 连接按 projectRoot 缓存(所有 store 均以 projectRoot 为参数、无全局单例,与现状对齐):
//   同一 root 全进程复用一条连接;SQLite 同库多连接靠 WAL+busy_timeout 协调,但进程内没必要多开。
// - PRAGMA:journal_mode=WAL(读写不互斥+天然替代 jsonFile 的 tmp+rename 原子写)、
//   busy_timeout=5000(并发写等锁 5s 而非立刻 SQLITE_BUSY)、foreign_keys=ON(SQLite 默认关,必须逐连接开)。
// - 本相只建地基表:_migrations(迁移幂等账本)与 unknown_lines(JSONL 认不得的行原样保留,
//   对齐 registryStore/reflectionStore 现有"unknown 行不丢"纪律);业务表由 B1 的 schema.ts 负责。

export const SQLITE_FILENAME = "opc.sqlite";

export function sqlitePath(projectRoot: string): string {
  return path.join(projectRoot, ".opc", SQLITE_FILENAME);
}

const connections = new Map<string, DatabaseSync>();

function cacheKey(projectRoot: string): string {
  return path.resolve(projectRoot);
}

const BOOTSTRAP_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  source     TEXT PRIMARY KEY,  -- 源文件路径(相对 .opc 的 canonical 文件名,如 "companies.json")
  sha256     TEXT NOT NULL,     -- 迁移当时源文件内容的 sha256(重跑时 hash 未变即跳过 → 幂等)
  migratedAt TEXT NOT NULL      -- ISO 时间戳
);
CREATE TABLE IF NOT EXISTS unknown_lines (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,     -- 来源 JSONL 文件(相对 .opc)
  lineNo     INTEGER,           -- 源文件内行号(1-based;不可考时为 NULL)
  raw        TEXT NOT NULL,     -- 原始行逐字节保留,绝不丢弃/改写
  importedAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unknown_lines_source ON unknown_lines(source);
`;

export function openDb(projectRoot: string): DatabaseSync {
  const key = cacheKey(projectRoot);
  const cached = connections.get(key);
  if (cached) return cached;

  const file = sqlitePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(BOOTSTRAP_SQL);
  } catch (err) {
    try { db.close(); } catch { /* 初始化失败时尽力关闭,不掩盖原始错误 */ }
    throw err;
  }
  connections.set(key, db);
  return db;
}

// 显式关闭并移出缓存(测试清理/未来 doctor 探针用)。root 未打开过则为 no-op。
export function closeDb(projectRoot: string): void {
  const key = cacheKey(projectRoot);
  const db = connections.get(key);
  if (!db) return;
  connections.delete(key);
  db.close();
}

// 关闭全部缓存连接(进程退出/测试收尾用)。单个 close 失败不阻断其余连接的关闭。
export function closeAllDbs(): void {
  const errors: unknown[] = [];
  for (const [key, db] of connections) {
    connections.delete(key);
    try { db.close(); } catch (err) { errors.push(err); }
  }
  if (errors.length > 0) throw errors[0];
}
