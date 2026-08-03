import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const fileFault = vi.hoisted(() => ({ failIndexPublish: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (oldPath: fs.PathLike, newPath: fs.PathLike) => {
      const source = String(oldPath).replace(/\\/g, "/");
      const target = String(newPath).replace(/\\/g, "/");
      if (fileFault.failIndexPublish && source.includes(".tmp-") && target.endsWith("/MEMORY.md")) {
        fileFault.failIndexPublish = false;
        throw new Error("forced MEMORY.md publish failure");
      }
      return actual.renameSync(oldPath, newPath);
    },
  };
});

import { closeAllDbs, openDb } from "./sqlite/db.js";
import { ensureSchema } from "./sqlite/schema.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import {
  layerIndexPath,
  readLayeredMemory,
  topicMemoryPath,
  writeLayeredMemory,
} from "./layeredMemory.js";

const roots: string[] = [];
const priorBackend = process.env.OPC_STORAGE_BACKEND;

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "wave5-persistence-"));
  roots.push(value);
  return value;
}

function memoryInput(content: string) {
  return {
    memoryId: "mem-wave5",
    scope: "project" as const,
    scopeId: "project-1",
    title: content === "old value" ? "Stable title" : "Changed title",
    summary: content,
    content,
    topic: "facts",
    sourceType: "manual" as const,
    status: "approved" as const,
    confidence: 0.9,
  };
}

beforeEach(() => {
  process.env.OPC_STORAGE_BACKEND = "sqlite";
  fileFault.failIndexPublish = false;
});

afterEach(() => {
  closeAllDbs();
  fileFault.failIndexPublish = false;
  if (priorBackend === undefined) delete process.env.OPC_STORAGE_BACKEND;
  else process.env.OPC_STORAGE_BACKEND = priorBackend;
  for (const value of roots.splice(0)) {
    try { fs.rmSync(value, { recursive: true, force: true }); } catch { /* Windows handle cleanup */ }
  }
});

describe("Wave 5 release gate: SQLite and Markdown fault injection", () => {
  it("rolls back a replaceAll transaction when the second row fails", () => {
    const projectRoot = root();
    const db = openBusinessDb(projectRoot);
    replaceAllDocs(db, "governance_records", [
      { runId: "old-1", level: "L1", decidedAt: "A" },
      { runId: "old-2", level: "L2", decidedAt: "B" },
    ]);
    db.exec(
      "CREATE TRIGGER wave5_reject_second BEFORE INSERT ON governance_records " +
      "WHEN NEW.runId = 'bad' BEGIN SELECT RAISE(ABORT, 'forced sqlite mid-transaction failure'); END",
    );

    expect(() => replaceAllDocs(db, "governance_records", [
      { runId: "good", level: "L1", decidedAt: "C" },
      { runId: "bad", level: "L3", decidedAt: "D" },
    ])).toThrow(/forced sqlite mid-transaction failure/);

    expect(readAllDocs(db, "governance_records")).toEqual([
      { runId: "old-1", level: "L1", decidedAt: "A" },
      { runId: "old-2", level: "L2", decidedAt: "B" },
    ]);
  });

  it("restores Markdown when a deferred SQLite constraint fails at COMMIT", () => {
    const projectRoot = root();
    writeLayeredMemory(projectRoot, memoryInput("old value"));
    const detail = topicMemoryPath(projectRoot, "project", "project-1", "facts-mem-wave5");
    const index = layerIndexPath(projectRoot, "project", "project-1");
    const beforeDetail = fs.readFileSync(detail, "utf-8");
    const beforeIndex = fs.readFileSync(index, "utf-8");

    const db = openDb(projectRoot);
    ensureSchema(db);
    db.exec("CREATE TABLE wave5_parent(id TEXT PRIMARY KEY)");
    db.exec(
      "CREATE TABLE wave5_deferred_child(parent_id TEXT, " +
      "FOREIGN KEY(parent_id) REFERENCES wave5_parent(id) DEFERRABLE INITIALLY DEFERRED)",
    );
    db.exec(
      "CREATE TRIGGER wave5_fail_commit AFTER UPDATE ON layered_memories " +
      "BEGIN INSERT INTO wave5_deferred_child(parent_id) VALUES('missing-parent'); END",
    );

    expect(() => writeLayeredMemory(projectRoot, memoryInput("new value")))
      .toThrow(/FOREIGN KEY constraint failed/i);
    expect(fs.readFileSync(detail, "utf-8")).toBe(beforeDetail);
    expect(fs.readFileSync(index, "utf-8")).toBe(beforeIndex);
    expect(readLayeredMemory(projectRoot, "project", "project-1", "mem-wave5")?.content).toBe("old value");
    const row = db.prepare("SELECT doc FROM layered_memories WHERE memoryId=?").get("mem-wave5") as { doc: string };
    expect(JSON.parse(row.doc).content).toBe("old value");
  });

  it("rolls back SQLite statements and the detail file when MEMORY.md publish fails", () => {
    const projectRoot = root();
    writeLayeredMemory(projectRoot, memoryInput("old value"));
    const detail = topicMemoryPath(projectRoot, "project", "project-1", "facts-mem-wave5");
    const index = layerIndexPath(projectRoot, "project", "project-1");
    const beforeDetail = fs.readFileSync(detail, "utf-8");
    const beforeIndex = fs.readFileSync(index, "utf-8");
    fileFault.failIndexPublish = true;

    expect(() => writeLayeredMemory(projectRoot, memoryInput("new value")))
      .toThrow(/forced MEMORY\.md publish failure/);
    expect(fs.readFileSync(detail, "utf-8")).toBe(beforeDetail);
    expect(fs.readFileSync(index, "utf-8")).toBe(beforeIndex);
    const db = openDb(projectRoot);
    const row = db.prepare("SELECT doc FROM layered_memories WHERE memoryId=?").get("mem-wave5") as { doc: string };
    expect(JSON.parse(row.doc).content).toBe("old value");
  });
});
