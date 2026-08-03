import { openDb } from "./db.js";
import { ensureSchema } from "./schema.js";
import type { EvidenceManifest } from "../../runtime/evidenceManifest.js";

// 战役B·B4 · evidence_manifest 表写侧(schema.ts 已建表)。
// 布局:每个证据文件一行(runId,path 复合主键,提升 sha256/size/kind/createdAt 为列 + doc=整条 entry),
// 另加一条 path="__manifest__" 的 meta 行,doc 承载整份 manifest(含 generatedAt/workspaceChanges/
// artifactDownloads/tests 等文件级之外的字段)→ loadEvidenceManifestFromDb 读 meta 行即完整还原。
// 默认 json 后端下由 orchestrator best-effort 调用(写失败不阻断 run);cutover 到 SQLite 后成主查询源。
// 注:本文件在 storage/ 下,不受 repositorySeam 守卫扫描(守卫只扫 routes/runtime);写的是 SQLite 非裸 .opc 文件。

const META_PATH = "__manifest__";

// 幂等 upsert:先删该 run 旧行再整批插(单事务)。NEVER 静默吞——抛给调用方的 best-effort try/catch。
export function upsertEvidenceManifest(projectRoot: string, manifest: EvidenceManifest): void {
  const db = openDb(projectRoot);
  ensureSchema(db);
  const del = db.prepare("DELETE FROM evidence_manifest WHERE runId = ?");
  const ins = db.prepare(
    "INSERT INTO evidence_manifest (runId, path, sha256, size, kind, createdAt, doc) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  db.exec("BEGIN");
  try {
    del.run(manifest.runId);
    for (const f of manifest.files) {
      ins.run(manifest.runId, f.path, f.sha256, f.size, f.kind, f.createdAt, JSON.stringify(f));
    }
    ins.run(manifest.runId, META_PATH, null, null, null, manifest.generatedAt, JSON.stringify(manifest));
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* rollback 失败不掩盖原始错误 */ }
    throw e;
  }
}

// 从表读回整份 manifest(meta 行的 doc);无该 run / 损坏 → null。
export function loadEvidenceManifestFromDb(projectRoot: string, runId: string): EvidenceManifest | null {
  const db = openDb(projectRoot);
  ensureSchema(db);
  const row = db
    .prepare("SELECT doc FROM evidence_manifest WHERE runId = ? AND path = ?")
    .get(runId, META_PATH) as { doc?: string } | undefined;
  if (!row?.doc) return null;
  try {
    return JSON.parse(row.doc) as EvidenceManifest;
  } catch {
    return null;
  }
}
