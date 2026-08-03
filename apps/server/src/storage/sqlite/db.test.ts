import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb, closeAllDbs, sqlitePath } from "./db.js";
import { resolveStorageBackend, STORAGE_BACKEND_ENV, DEFAULT_STORAGE_BACKEND } from "../backend.js";

// Phase B0 地基用例:建库/PRAGMA/地基表/连接缓存/关闭重开持久化/并发写锁。
// 并发写用例刻意用 busy_timeout=0 的裸第二连接反证:配了 5000 的 openDb 连接持锁时,
// 不等锁的连接立刻 SQLITE_BUSY——真等 5 秒的正向验证太慢,不进单测。
// DatabaseSync 经 process.getBuiltinModule 取(理由见 db.ts 头注:vite@5.4 不认 node:sqlite 静态 import)。
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

describe("storage/sqlite/db.ts", () => {
  const roots: string[] = [];
  const mkRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-sqlite-db-"));
    roots.push(root);
    return root;
  };

  afterEach(() => {
    closeAllDbs();
    for (const root of roots.splice(0)) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄残留不阻断后续用例 */ }
    }
  });

  it("openDb 建库:.opc/opc.sqlite 落盘,WAL/busy_timeout/foreign_keys 生效,地基表存在", () => {
    const root = mkRoot();
    const db = openDb(root);

    expect(fs.existsSync(sqlitePath(root))).toBe(true);
    expect((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    expect((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout).toBe(5000);
    expect((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys).toBe(1);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(tables).toContain("_migrations");
    expect(tables).toContain("unknown_lines");
  });

  it("foreign_keys=ON 真实生效:悬空外键插入被拒", () => {
    const root = mkRoot();
    const db = openDb(root);
    db.exec("CREATE TABLE p (id TEXT PRIMARY KEY)");
    db.exec("CREATE TABLE c (id TEXT PRIMARY KEY, pid TEXT NOT NULL REFERENCES p(id))");
    expect(() => db.prepare("INSERT INTO c (id, pid) VALUES ('c1', 'nope')").run()).toThrow(/FOREIGN KEY/i);
  });

  it("连接按 root 缓存:同 root(含路径写法差异)同实例,异 root 异实例", () => {
    const rootA = mkRoot();
    const rootB = mkRoot();
    const db1 = openDb(rootA);
    const db2 = openDb(rootA);
    const db3 = openDb(rootA + path.sep);
    const other = openDb(rootB);
    // 刻意用 Object.is 布尔断言:expect(x).not.toBe(y) 在不相等时会先跑深比较(为了提示 toEqual),
    // 深比较会走 DatabaseSync 原生 getter,对已关闭句柄直接抛 "database is not open"。
    expect(Object.is(db2, db1)).toBe(true);
    expect(Object.is(db3, db1)).toBe(true);
    expect(Object.is(other, db1)).toBe(false);
  });

  it("closeDb 后重开:新实例,数据持久化(unknown_lines 行原样读回)", () => {
    const root = mkRoot();
    const db = openDb(root);
    db.prepare("INSERT INTO unknown_lines (source, lineNo, raw, importedAt) VALUES (?, ?, ?, ?)")
      .run("memory/registry.jsonl", 3, '{"kind":"future-thing",broken', "2026-07-11T00:00:00.000Z");
    closeDb(root);

    const reopened = openDb(root);
    expect(Object.is(reopened, db)).toBe(false); // 布尔断言,理由同上(db 已关闭,深比较会炸)
    const row = reopened.prepare("SELECT source, lineNo, raw FROM unknown_lines").get() as {
      source: string; lineNo: number; raw: string;
    };
    expect(row.source).toBe("memory/registry.jsonl");
    expect(row.lineNo).toBe(3);
    expect(row.raw).toBe('{"kind":"future-thing",broken');
  });

  it("并发写:持锁事务期间,不等锁的第二连接立刻 SQLITE_BUSY;提交后写入成功", () => {
    const root = mkRoot();
    const a = openDb(root);
    a.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    a.exec("BEGIN IMMEDIATE");

    const b = new DatabaseSync(sqlitePath(root)); // 裸连接,busy_timeout 默认 0
    try {
      expect(() => b.exec("INSERT INTO t (v) VALUES ('x')")).toThrow(/locked|busy/i);
      a.exec("COMMIT");
      b.exec("INSERT INTO t (v) VALUES ('y')");
      expect((b.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number }).c).toBe(1);
    } finally {
      b.close();
    }
  });
});

describe("storage/backend.ts · resolveStorageBackend", () => {
  const envBackup = process.env[STORAGE_BACKEND_ENV];
  const roots: string[] = [];
  const mkRootWithConfig = (config?: unknown): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-backend-"));
    roots.push(root);
    if (config !== undefined) {
      fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
      fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify(config));
    }
    return root;
  };

  afterEach(() => {
    if (envBackup === undefined) delete process.env[STORAGE_BACKEND_ENV];
    else process.env[STORAGE_BACKEND_ENV] = envBackup;
    for (const root of roots.splice(0)) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  it("无 env 无 config → 默认 sqlite", () => {
    delete process.env[STORAGE_BACKEND_ENV];
    const root = mkRootWithConfig();
    expect(resolveStorageBackend(root)).toBe(DEFAULT_STORAGE_BACKEND);
    expect(DEFAULT_STORAGE_BACKEND).toBe("sqlite");
  });

  it("config.json 的 storageBackend=sqlite → sqlite(大小写/空白宽容)", () => {
    delete process.env[STORAGE_BACKEND_ENV];
    expect(resolveStorageBackend(mkRootWithConfig({ storageBackend: "sqlite" }))).toBe("sqlite");
    expect(resolveStorageBackend(mkRootWithConfig({ storageBackend: " SQLite " }))).toBe("sqlite");
  });

  it("env 优先于 config;非法值不抛错,按下一优先级/默认处理", () => {
    const root = mkRootWithConfig({ storageBackend: "sqlite" });
    process.env[STORAGE_BACKEND_ENV] = "json";
    expect(resolveStorageBackend(root)).toBe("json");
    process.env[STORAGE_BACKEND_ENV] = "postgres"; // 非法 env → 落到 config 的 sqlite
    expect(resolveStorageBackend(root)).toBe("sqlite");
    delete process.env[STORAGE_BACKEND_ENV];
    expect(resolveStorageBackend(mkRootWithConfig({ storageBackend: 42 }))).toBe("sqlite");
  });
});
