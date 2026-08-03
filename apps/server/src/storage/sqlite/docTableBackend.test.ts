import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeAllDbs } from "./db.js";
import {
  openBusinessDb, readAllDocs, readDocByPk, upsertDoc, deleteDoc, replaceAllDocs,
  columnsFor, pkValueOf, bindScalar,
} from "./docTableBackend.js";

// 战役B·Phase B2a:通用 doc 表后端 helper 单测。覆盖 upsert/readAll/readByPk/delete/replaceAll + 幂等,
// 并验证提升列真的按 COLUMN_PROJECTORS 落进物理列、doc 逐字节无损、pk 字段名≠列名的表(edit_proposals)正确。
// 全部在临时目录构造库,绝不碰真实 .opc。

const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "doc-table-"));
  roots.push(r);
  return r;
}
afterEach(() => {
  closeAllDbs();
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }
});

function col(db: ReturnType<typeof openBusinessDb>, table: string, pkCol: string, pk: string, colName: string): unknown {
  const row = db.prepare(`SELECT ${colName} AS v FROM ${table} WHERE ${pkCol} = ?`).get(pk) as { v: unknown } | undefined;
  return row?.v;
}
function count(db: ReturnType<typeof openBusinessDb>, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

describe("bindScalar / columnsFor / pkValueOf", () => {
  it("bindScalar 归一:undefined/null→null、bool→0/1、有限数/串原样、NaN/对象→null", () => {
    expect(bindScalar(undefined)).toBe(null);
    expect(bindScalar(null)).toBe(null);
    expect(bindScalar(true)).toBe(1);
    expect(bindScalar(false)).toBe(0);
    expect(bindScalar(42)).toBe(42);
    expect(bindScalar("x")).toBe("x");
    expect(bindScalar(NaN)).toBe(null);
    expect(bindScalar({ a: 1 })).toBe(null);
  });

  it("columnsFor 按表投影提升列;未注册表→空投影", () => {
    expect(columnsFor("task_graphs", { id: "t1", missionId: "m1", companyId: "c1", status: "committed", createdAt: "A", updatedAt: "B", extra: 9 }))
      .toEqual({ missionId: "m1", companyId: "c1", status: "committed", createdAt: "A", updatedAt: "B" });
    expect(columnsFor("growth_snapshots", { registry: {} })).toEqual({});
    expect(columnsFor("__nope__", { a: 1 })).toEqual({});
  });

  it("pkValueOf 处理 doc 字段名≠schema 列名(edit_proposals:proposal_id ↔ proposalId)", () => {
    expect(pkValueOf("task_graphs", { id: "t1" })).toBe("t1");
    expect(pkValueOf("edit_proposals", { proposal_id: "p1" })).toBe("p1");
    expect(pkValueOf("memory_jobs", { jobId: "j1" })).toBe("j1");
    expect(pkValueOf("chat_threads", { companyId: "c", agentId: "a" })).toBe("c::a");
    expect(pkValueOf("growth_snapshots", {})).toBe("growth-snapshot");
  });
});

describe("upsertDoc / readAllDocs / readDocByPk", () => {
  it("upsert 落 doc(无损)+ 提升列,readByPk 取回;同 pk 再 upsert 是更新不是追加(幂等)", () => {
    const db = openBusinessDb(mkRoot());
    const g1 = { id: "t1", missionId: "m1", companyId: "c1", status: "committed", createdAt: "A", updatedAt: "B", nested: { a: [1, 2] } };
    upsertDoc(db, "task_graphs", "t1", g1);

    expect(readDocByPk(db, "task_graphs", "t1")).toEqual(g1);
    expect(col(db, "task_graphs", "id", "t1", "missionId")).toBe("m1");
    expect(col(db, "task_graphs", "id", "t1", "status")).toBe("committed");
    expect(count(db, "task_graphs")).toBe(1);

    // 更新同 pk:doc 与提升列都刷新,行数不变
    const g1b = { ...g1, status: "running", updatedAt: "C" };
    upsertDoc(db, "task_graphs", "t1", g1b);
    expect(count(db, "task_graphs")).toBe(1);
    expect((readDocByPk(db, "task_graphs", "t1") as { status: string }).status).toBe("running");
    expect(col(db, "task_graphs", "id", "t1", "status")).toBe("running");
    expect(col(db, "task_graphs", "id", "t1", "updatedAt")).toBe("C");
  });

  it("readAllDocs 按 rowid(插入序)返回;readByPk 不存在→undefined", () => {
    const db = openBusinessDb(mkRoot());
    upsertDoc(db, "memory_jobs", "j1", { jobId: "j1", kind: "export", status: "queued" });
    upsertDoc(db, "memory_jobs", "j2", { jobId: "j2", kind: "import", status: "completed" });
    expect((readAllDocs(db, "memory_jobs") as Array<{ jobId: string }>).map((r) => r.jobId)).toEqual(["j1", "j2"]);
    expect(readDocByPk(db, "memory_jobs", "nope")).toBeUndefined();
  });

  it("edit_proposals:pk 值来自 doc.proposal_id,写进物理列 proposalId", () => {
    const db = openBusinessDb(mkRoot());
    const rec = { proposal_id: "p1", targetId: "tgt", status: "pending", createdAt: "A" };
    upsertDoc(db, "edit_proposals", pkValueOf("edit_proposals", rec), rec);
    expect(col(db, "edit_proposals", "proposalId", "p1", "targetId")).toBe("tgt");
    expect(readDocByPk(db, "edit_proposals", "p1")).toEqual(rec);
  });
});

describe("deleteDoc", () => {
  it("按 pk 删一行;不存在→no-op", () => {
    const db = openBusinessDb(mkRoot());
    upsertDoc(db, "task_graphs", "t1", { id: "t1" });
    upsertDoc(db, "task_graphs", "t2", { id: "t2" });
    deleteDoc(db, "task_graphs", "t1");
    expect((readAllDocs(db, "task_graphs") as Array<{ id: string }>).map((r) => r.id)).toEqual(["t2"]);
    deleteDoc(db, "task_graphs", "nope"); // no-op,不报错
    expect(count(db, "task_graphs")).toBe(1);
  });
});

describe("replaceAllDocs(全量重写)", () => {
  it("清空旧全量 + 按数组序重插(pk/列由 registry 推导);readAll 返回同序", () => {
    const db = openBusinessDb(mkRoot());
    replaceAllDocs(db, "governance_records", [
      { runId: "r1", level: "L1", decidedAt: "A" },
      { runId: "r2", level: "L3", decidedAt: "B" },
    ]);
    expect((readAllDocs(db, "governance_records") as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(col(db, "governance_records", "runId", "r2", "level")).toBe("L3");

    // 再次全量重写:旧行(r1)消失,新序生效
    replaceAllDocs(db, "governance_records", [
      { runId: "r3", level: "L2", decidedAt: "C" },
      { runId: "r2", level: "L2", decidedAt: "D" },
    ]);
    expect((readAllDocs(db, "governance_records") as Array<{ runId: string }>).map((r) => r.runId)).toEqual(["r3", "r2"]);
    expect(count(db, "governance_records")).toBe(2);
    expect(readDocByPk(db, "governance_records", "r1")).toBeUndefined();
  });

  it("空数组 → 清空表", () => {
    const db = openBusinessDb(mkRoot());
    replaceAllDocs(db, "task_graphs", [{ id: "t1" }]);
    replaceAllDocs(db, "task_graphs", []);
    expect(count(db, "task_graphs")).toBe(0);
  });
});
