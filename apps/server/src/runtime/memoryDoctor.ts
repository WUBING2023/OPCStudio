import * as fs from "node:fs";
import * as path from "node:path";
import {
  LAYER_INDEX_MAX_BYTES,
  LAYER_INDEX_MAX_ENTRIES,
  LAYER_INDEX_MAX_LINES,
  discoverLayeredScopes,
  isLayeredMemoryInjectable,
  layerIndexPath,
  parseLayerIndex,
  readLayerIndex,
  readLayeredMemory,
  searchLayeredMemories,
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import { isSqliteBackend } from "../storage/backend.js";
import { openDb } from "../storage/sqlite/db.js";
import { ensureSchema } from "../storage/sqlite/schema.js";
import {
  PROJECT_CONVENTION_FILE_MAX_CHARS,
  PROJECT_CONVENTION_TOTAL_MAX_CHARS,
  auditProjectConventions,
} from "./contextBroker.js";
import {
  auditLegacyMemoryMigration,
  type LegacyMemoryMigrationAudit,
} from "./memoryMigration.js";

export interface MemoryDoctorIssue {
  severity: "warning" | "error";
  code: string;
  message: string;
  scope?: LayeredMemoryScope;
  scopeId?: string;
  memoryId?: string;
}

export interface MemoryDoctorOptions {
  goal?: string;
  scopes?: Array<{ scope: LayeredMemoryScope; scopeId: string }>;
  workRoot?: string;
}

export interface MemoryDoctorReport {
  status: "ok" | "warning" | "error";
  generatedAt: string;
  storage: "json" | "sqlite";
  scopeCount: number;
  topicFileCount: number;
  indexedRecordCount: number;
  eligibleRecordCount: number;
  staleRecordCount: number;
  pendingRecordCount: number;
  rejectedRecordCount: number;
  selectedMemoryIds: string[];
  outsideRequestedScopeCount: number;
  sqlite?: { records: number; ftsRecords: number; consistent: boolean };
  migration: Pick<
    LegacyMemoryMigrationAudit,
    | "mode"
    | "state"
    | "legacyRecordCount"
    | "pendingMigrationCount"
    | "duplicateCount"
    | "conflictCount"
    | "failureCount"
    | "sources"
  >;
  promptPolicy: {
    maxCandidates: number;
    maxInjectedItems: number;
    maxInjectedChars: number;
    indexMaxEntries: number;
    indexMaxLines: number;
    indexMaxBytes: number;
  };
  projectConventions: Array<{
    relativePath: string;
    status: "loaded" | "skipped";
    reason: string;
    chars: number;
    truncated: boolean;
  }>;
  issues: MemoryDoctorIssue[];
}

function frontmatterValue(raw: string, key: string): string | undefined {
  return raw.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

export function runMemoryDoctor(root: string, options: MemoryDoctorOptions = {}): MemoryDoctorReport {
  const issues: MemoryDoctorIssue[] = [];
  const migrationAudit = auditLegacyMemoryMigration(root);
  const discovered = discoverLayeredScopes(root);
  const requested = options.scopes?.length ? options.scopes : discovered;
  const requestedKeys = new Set(requested.map((item) => `${item.scope}:${item.scopeId}`));
  let topicFileCount = 0;
  let indexedRecordCount = 0;
  let eligibleRecordCount = 0;
  let staleRecordCount = 0;
  let pendingRecordCount = 0;
  let rejectedRecordCount = 0;
  let outsideRequestedScopeCount = 0;

  for (const item of discovered) {
    let rawIndex = "";
    try { rawIndex = fs.readFileSync(layerIndexPath(root, item.scope, item.scopeId), "utf-8"); }
    catch { /* missing indexes are represented by an empty scope */ }
    const index = readLayerIndex(root, item.scope, item.scopeId);
    const indexLines = rawIndex ? rawIndex.split(/\r?\n/).length : 0;
    const indexBytes = Buffer.byteLength(rawIndex, "utf-8");
    if (indexLines > LAYER_INDEX_MAX_LINES || indexBytes > LAYER_INDEX_MAX_BYTES) {
      issues.push({
        severity: "error",
        code: "index_budget_exceeded",
        message: `MEMORY.md exceeds bounded index budget (${indexLines} lines, ${indexBytes} bytes)`,
        ...item,
      });
    }
    const entries = parseLayerIndex(root, item.scope, item.scopeId);
    indexedRecordCount += entries.length;
    if (!requestedKeys.has(`${item.scope}:${item.scopeId}`)) outsideRequestedScopeCount += entries.length;
    for (const entry of entries) {
      const record = readLayeredMemory(root, item.scope, item.scopeId, entry.memoryId);
      if (!record) {
        issues.push({
          severity: "error",
          code: "indexed_detail_missing",
          message: "MEMORY.md points to a missing, malformed or out-of-scope detail file",
          ...item,
          memoryId: entry.memoryId,
        });
        continue;
      }
      if (isLayeredMemoryInjectable(record)) eligibleRecordCount++;
      else if (record.status === "approved") staleRecordCount++;
      else if (record.status === "proposed") pendingRecordCount++;
    }

    const dir = path.dirname(layerIndexPath(root, item.scope, item.scopeId));
    let files: fs.Dirent[] = [];
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* reported through empty scope */ }
    for (const file of files) {
      if (!file.isFile()) continue;
      if (/\.(?:tmp|bak)-/.test(file.name)) {
        issues.push({
          severity: "warning",
          code: "recovery_file_present",
          message: `unfinished recovery file: ${file.name}`,
          ...item,
        });
      }
      if (!file.name.toLowerCase().endsWith(".md") || file.name === "MEMORY.md") continue;
      topicFileCount++;
      try {
        const raw = fs.readFileSync(path.join(dir, file.name), "utf-8");
        const status = frontmatterValue(raw, "status");
        const memoryId = frontmatterValue(raw, "memory_id");
        if (!memoryId) {
          issues.push({
            severity: "warning",
            code: "unmanaged_markdown",
            message: `${file.name} has no memory_id and is not part of the canonical layered store`,
            ...item,
          });
        }
        if (status === "rejected" || status === "revoked" || status === "archived") rejectedRecordCount++;
      } catch (error) {
        issues.push({
          severity: "error",
          code: "detail_unreadable",
          message: error instanceof Error ? error.message : String(error),
          ...item,
        });
      }
    }
  }

  let sqlite: MemoryDoctorReport["sqlite"];
  if (isSqliteBackend(root)) {
    try {
      const db = openDb(root);
      ensureSchema(db);
      const records = (db.prepare("SELECT COUNT(*) AS n FROM layered_memories").get() as { n: number }).n;
      const ftsRecords = (db.prepare("SELECT COUNT(*) AS n FROM memory_fts").get() as { n: number }).n;
      sqlite = { records, ftsRecords, consistent: records === ftsRecords };
      if (!sqlite.consistent) {
        issues.push({
          severity: "error",
          code: "sqlite_fts_mismatch",
          message: `layered_memories=${records}, memory_fts=${ftsRecords}; run explicit index rebuild`,
        });
      }
    } catch (error) {
      issues.push({
        severity: "error",
        code: "sqlite_unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (migrationAudit.legacyRecordCount > 0) {
    issues.push({
      severity: "warning",
      code: "legacy_read_only",
      message: migrationAudit.legacyRecordCount
        + " legacy memory record(s) remain read-only; Layered Memory is the only migration target",
    });
  }
  if (migrationAudit.pendingMigrationCount > 0) {
    issues.push({
      severity: "warning",
      code: "legacy_migration_pending",
      message: migrationAudit.pendingMigrationCount
        + " legacy record(s) are eligible for proposal migration",
    });
  }
  if (migrationAudit.conflictCount > 0) {
    issues.push({
      severity: "error",
      code: "legacy_migration_conflict",
      message: migrationAudit.conflictCount
        + " legacy record(s) have content-hash scope conflicts",
    });
  }
  if (migrationAudit.failureCount > 0) {
    issues.push({
      severity: "error",
      code: "legacy_migration_failed",
      message: migrationAudit.failureCount
        + " legacy record(s) or source file(s) could not be audited safely",
    });
  }

  const selectedMemoryIds = options.goal?.trim() && requested.length
    ? searchLayeredMemories(root, { goal: options.goal.trim(), scopes: requested, limit: 100 })
      .map((item) => item.memoryId)
    : [];
  const conventions = auditProjectConventions(options.workRoot || root);
  const status = issues.some((item) => item.severity === "error")
    ? "error"
    : issues.length ? "warning" : "ok";
  return {
    status,
    generatedAt: new Date().toISOString(),
    storage: isSqliteBackend(root) ? "sqlite" : "json",
    scopeCount: discovered.length,
    topicFileCount,
    indexedRecordCount,
    eligibleRecordCount,
    staleRecordCount,
    pendingRecordCount,
    rejectedRecordCount,
    selectedMemoryIds,
    outsideRequestedScopeCount,
    sqlite,
    migration: {
      mode: migrationAudit.mode,
      state: migrationAudit.state,
      legacyRecordCount: migrationAudit.legacyRecordCount,
      pendingMigrationCount: migrationAudit.pendingMigrationCount,
      duplicateCount: migrationAudit.duplicateCount,
      conflictCount: migrationAudit.conflictCount,
      failureCount: migrationAudit.failureCount,
      sources: migrationAudit.sources,
    },
    promptPolicy: {
      maxCandidates: 100,
      maxInjectedItems: 20,
      maxInjectedChars: 8_000,
      indexMaxEntries: LAYER_INDEX_MAX_ENTRIES,
      indexMaxLines: LAYER_INDEX_MAX_LINES,
      indexMaxBytes: LAYER_INDEX_MAX_BYTES,
    },
    projectConventions: conventions.map((item) => ({
      relativePath: item.relativePath,
      status: item.status,
      reason: item.reason,
      chars: item.content.length,
      truncated: item.truncated,
    })),
    issues,
  };
}

export const PROJECT_CONVENTION_BUDGET = {
  perFileChars: PROJECT_CONVENTION_FILE_MAX_CHARS,
  totalChars: PROJECT_CONVENTION_TOTAL_MAX_CHARS,
};
