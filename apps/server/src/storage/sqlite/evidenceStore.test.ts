import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { upsertEvidenceManifest, loadEvidenceManifestFromDb } from "./evidenceStore.js";
import { closeDb, openDb } from "./db.js";
import type { EvidenceManifest } from "../../runtime/evidenceManifest.js";

// B4 · evidence_manifest 表写侧单测:临时 projectRoot 建库,upsert→load 往返 + 幂等。

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-evidence-store-"));
});

afterEach(() => {
  closeDb(root); // 释放 SQLite 句柄(Windows 下不关无法 rm)
  fs.rmSync(root, { recursive: true, force: true });
});

function manifest(runId: string, nFiles = 2): EvidenceManifest {
  return {
    schemaVersion: 1,
    runId,
    generatedAt: "2026-07-11T00:00:00.000Z",
    files: Array.from({ length: nFiles }, (_, i) => ({
      path: `file-${i}.json`,
      sha256: "a".repeat(64),
      size: 10 + i,
      kind: "task" as const,
      createdAt: "2026-07-11T00:00:00.000Z",
    })),
    workspaceChanges: [{ path: "src/x.ts", changeType: "modify" }],
    artifactDownloads: null,
    tests: [{ at: "2026-07-11T00:00:00.000Z", command: "npm test", passed: true, exitCode: 0, source: "quality_gate" }],
  };
}

describe("upsertEvidenceManifest / loadEvidenceManifestFromDb", () => {
  it("写入后读回整份 manifest 逐字段一致(经 meta 行 doc 还原)", () => {
    const m = manifest("run-a");
    upsertEvidenceManifest(root, m);
    expect(loadEvidenceManifestFromDb(root, "run-a")).toEqual(m);
  });

  it("每个证据文件落一行 + 一条 __manifest__ meta 行", () => {
    upsertEvidenceManifest(root, manifest("run-b", 3));
    const db = openDb(root);
    const rows = db.prepare("SELECT path FROM evidence_manifest WHERE runId = ? ORDER BY path").all("run-b") as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).toEqual(["__manifest__", "file-0.json", "file-1.json", "file-2.json"]);
  });

  it("幂等:同 runId 重 upsert 先删后插,不翻倍", () => {
    upsertEvidenceManifest(root, manifest("run-c", 3));
    upsertEvidenceManifest(root, manifest("run-c", 2)); // 文件数变少
    const back = loadEvidenceManifestFromDb(root, "run-c");
    expect(back?.files).toHaveLength(2);
    const db = openDb(root);
    const cnt = db.prepare("SELECT COUNT(*) AS c FROM evidence_manifest WHERE runId = ?").get("run-c") as { c: number };
    expect(cnt.c).toBe(3); // 2 文件行 + 1 meta 行,无残留旧行
  });

  it("未知 runId → null", () => {
    upsertEvidenceManifest(root, manifest("run-d"));
    expect(loadEvidenceManifestFromDb(root, "nope")).toBeNull();
  });
});
