import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeAllDbs } from "./db.js";
import { ensureSchema, BUSINESS_TABLES } from "./schema.js";

// Phase B1 schema 用例:建表齐全 / 幂等 / BUSINESS_TABLES 元数据与真实列一致(防列漂移)/ 主键正确。
// 全部在临时目录建库,绝不碰真实 .opc。

const ALL_TABLES = [
  ...BUSINESS_TABLES.map((m) => m.table),
  "ledger",
  "evidence_manifest",
];

describe("storage/sqlite/schema.ts · ensureSchema", () => {
  const roots: string[] = [];
  const mkRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-schema-"));
    roots.push(root);
    return root;
  };
  afterEach(() => {
    closeAllDbs();
    for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
  });

  it("建齐 18 业务表 + ledger + evidence_manifest,且保留 B0 地基表", () => {
    const db = openDb(mkRoot());
    ensureSchema(db);
    const tables = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name),
    );
    for (const t of ALL_TABLES) expect(tables, `缺表 ${t}`).toContain(t);
    // B0 地基表仍在
    expect(tables).toContain("_migrations");
    expect(tables).toContain("unknown_lines");
  });

  it("幂等:重复 ensureSchema 不抛错、表不重复", () => {
    const db = openDb(mkRoot());
    ensureSchema(db);
    ensureSchema(db);
    ensureSchema(db);
    const count = (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='companies'").get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("BUSINESS_TABLES 元数据与真实列一致:pk 是主键、每个 column 真实存在、doc 列存在", () => {
    const db = openDb(mkRoot());
    ensureSchema(db);
    for (const meta of BUSINESS_TABLES) {
      const info = db.prepare(`PRAGMA table_info(${meta.table})`).all() as Array<{ name: string; pk: number }>;
      const colNames = new Set(info.map((c) => c.name));
      // pk 列存在且被标为主键
      expect(colNames, `${meta.table} 缺 pk 列 ${meta.pk}`).toContain(meta.pk);
      const pkCol = info.find((c) => c.name === meta.pk);
      expect(pkCol?.pk, `${meta.table}.${meta.pk} 不是主键`).toBeGreaterThan(0);
      // 每个派生列都真实存在
      for (const col of meta.columns) expect(colNames, `${meta.table} 缺列 ${col}`).toContain(col);
      // doc 列存在且 NOT NULL
      expect(colNames, `${meta.table} 缺 doc 列`).toContain("doc");
      const docCol = info.find((c) => c.name === "doc") as { notnull: number } | undefined;
      expect(docCol?.notnull, `${meta.table}.doc 应 NOT NULL`).toBe(1);
    }
  });

  it("ledger 哈希链列齐 + evidence_manifest 复合主键 (runId, path)", () => {
    const db = openDb(mkRoot());
    ensureSchema(db);
    const ledgerCols = new Set((db.prepare("PRAGMA table_info(ledger)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const c of ["at", "kind", "runId", "costUsd", "costSource", "payload", "prevHash", "rowHash"]) {
      expect(ledgerCols, `ledger 缺列 ${c}`).toContain(c);
    }
    const evPk = (db.prepare("PRAGMA table_info(evidence_manifest)").all() as Array<{ name: string; pk: number }>)
      .filter((c) => c.pk > 0).map((c) => c.name).sort();
    expect(evPk).toEqual(["path", "runId"]);
  });
});
