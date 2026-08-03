import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { BundleMemoryRecordSchema, type BundleMemoryRecord } from "@opc/shared";
import { isSqliteBackend } from "./backend.js";
import { openDb } from "./sqlite/db.js";
import { ensureSchema } from "./sqlite/schema.js";

export type LayeredMemoryScope = "user" | "company" | "project" | "team" | "agent";
export type LayeredMemoryStatus = "proposed" | "approved" | "rejected" | "revoked" | "archived";

export interface LayeredMemoryRecord {
  memoryId: string;
  scope: LayeredMemoryScope;
  scopeId: string;
  title: string;
  summary: string;
  content: string;
  topic: string;
  sourceType: "manual" | "run" | "import" | "curator";
  sourceRunId?: string;
  status: LayeredMemoryStatus;
  confidence: number;
  created: string;
  modified: string;
  freshness?: { validatedAt?: string; expiresAt?: string; status: "fresh" | "stale" | "unknown" };
  /** Exact portable source retained for lossless Company Bundle round-trips. */
  portableBundleRecord?: BundleMemoryRecord;
  contentHash: string;
}

export interface LayerIndexEntry {
  memoryId: string;
  title: string;
  summary: string;
  topicPath: string;
  modified: string;
  status: LayeredMemoryStatus;
}

export const LAYER_INDEX_MAX_ENTRIES = 100;
export const LAYER_INDEX_MAX_LINES = 200;
export const LAYER_INDEX_MAX_BYTES = 25 * 1024;

const safe = (value: string) => (value || "default").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
const plural = (scope: LayeredMemoryScope) => scope === "company" ? "companies" : `${scope}s`;
const scopeDir = (root: string, scope: LayeredMemoryScope, scopeId: string) =>
  path.join(root, ".opc", "memory", plural(scope), safe(scopeId));
export const layerIndexPath = (root: string, scope: LayeredMemoryScope, scopeId: string) =>
  path.join(scopeDir(root, scope, scopeId), "MEMORY.md");

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf-8");
  try { fs.renameSync(tmp, file); }
  catch {
    fs.copyFileSync(tmp, file);
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

interface StagedFileWrite {
  file: string;
  tmp: string;
  backup: string;
  hadOriginal: boolean;
  applied: boolean;
}

function stageFileWrite(file: string, content: string): StagedFileWrite {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${randomUUID()}`;
  const staged: StagedFileWrite = {
    file,
    tmp: `${file}.tmp-${nonce}`,
    backup: `${file}.bak-${nonce}`,
    hadOriginal: false,
    applied: false,
  };
  fs.writeFileSync(staged.tmp, content, "utf-8");
  return staged;
}

function applyStagedFile(staged: StagedFileWrite): void {
  if (fs.existsSync(staged.file)) {
    fs.renameSync(staged.file, staged.backup);
    staged.hadOriginal = true;
  }
  try {
    fs.renameSync(staged.tmp, staged.file);
    staged.applied = true;
  } catch (error) {
    if (staged.hadOriginal && fs.existsSync(staged.backup) && !fs.existsSync(staged.file)) {
      try { fs.renameSync(staged.backup, staged.file); } catch { /* outer rollback reports original error */ }
    }
    throw error;
  }
}

function rollbackStagedFile(staged: StagedFileWrite): void {
  try {
    if (staged.applied && fs.existsSync(staged.file)) fs.unlinkSync(staged.file);
  } catch { /* continue restoring the previous truth source */ }
  try {
    if (staged.hadOriginal && fs.existsSync(staged.backup) && !fs.existsSync(staged.file)) {
      fs.renameSync(staged.backup, staged.file);
    }
  } catch { /* best effort; backup remains available for recovery */ }
  try { if (fs.existsSync(staged.tmp)) fs.unlinkSync(staged.tmp); } catch { /* best effort */ }
}

function finalizeStagedFile(staged: StagedFileWrite): void {
  try { if (fs.existsSync(staged.backup)) fs.unlinkSync(staged.backup); } catch { /* best effort */ }
  try { if (fs.existsSync(staged.tmp)) fs.unlinkSync(staged.tmp); } catch { /* best effort */ }
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const input = raw.replace(/^\uFEFF/, "");
  const opening = input.match(/^---\r?\n/);
  if (!opening) return { meta: {}, body: input.trim() };
  const closing = /\r?\n---\r?\n/g;
  closing.lastIndex = opening[0].length;
  const end = closing.exec(input);
  if (!end) return { meta: {}, body: input.trim() };
  const meta: Record<string, string> = {};
  for (const line of input.slice(opening[0].length, end.index).split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: input.slice(end.index + end[0].length).trim() };
}

function frontmatter(meta: Record<string, string | number | undefined>): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(meta)) if (value !== undefined) lines.push(`${key}: ${value}`);
  lines.push("---", "");
  return lines.join("\n");
}

function parsePortableBundleRecord(encoded: string | undefined): BundleMemoryRecord | undefined {
  if (!encoded) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
    const parsed = BundleMemoryRecordSchema.safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function readText(file: string): string {
  try { return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : ""; } catch { return ""; }
}

export function readLayerIndex(root: string, scope: LayeredMemoryScope, scopeId: string): string {
  const raw = readText(layerIndexPath(root, scope, scopeId));
  if (!raw) return "";
  const lines: string[] = [];
  let bytes = 0;
  for (const line of raw.split(/\r?\n/).slice(0, LAYER_INDEX_MAX_LINES)) {
    const next = Buffer.byteLength(`${line}\n`, "utf-8");
    if (bytes + next > LAYER_INDEX_MAX_BYTES) break;
    bytes += next;
    lines.push(line);
  }
  return lines.join("\n").trim();
}

export function parseLayerIndex(root: string, scope: LayeredMemoryScope, scopeId: string): LayerIndexEntry[] {
  const raw = readLayerIndex(root, scope, scopeId);
  const out: LayerIndexEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^- \[([^\]]+)\]\s+\(([^)]+)\)\s+(.+?)\s+(?:::|\?)\s+(.+?)\s+->\s+(.+)$/);
    if (!m) continue;
    out.push({
      memoryId: m[1],
      status: m[2] as LayeredMemoryStatus,
      title: m[3],
      summary: m[4],
      topicPath: m[5],
      modified: raw.match(/^modified:\s*(.+)$/m)?.[1] ?? "",
    });
    if (out.length >= LAYER_INDEX_MAX_ENTRIES) break;
  }
  return out;
}

function renderIndex(scope: LayeredMemoryScope, scopeId: string, entries: LayerIndexEntry[], modified: string): string {
  const active = entries.filter((entry) => entry.status !== "archived" && entry.status !== "rejected").slice(0, LAYER_INDEX_MAX_ENTRIES);
  return frontmatter({ schema_version: 1, scope, scope_id: safe(scopeId), modified, entries: active.length })
    + `# ${scope} memory index\n\n`
    + active.map((entry) => `- [${entry.memoryId}] (${entry.status}) ${entry.title} :: ${entry.summary} -> ${entry.topicPath}`).join("\n")
    + "\n";
}

function summaries(body: string): string[] {
  const seen = new Set<string>(), out: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const text = raw.trim().replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\[\d{4}-\d{2}-\d{2}\]\s*/, "");
    if (text.length < 4 || text.startsWith("<!--")) continue;
    const item = text.replace(/\s+/g, " ").slice(0, 180), key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= LAYER_INDEX_MAX_ENTRIES) break;
  }
  return out;
}

/** Build an index for an existing Markdown truth source without moving that source. */
export function ensureLegacyLayerIndex(
  root: string,
  scope: LayeredMemoryScope,
  scopeId: string,
  detailFile: string,
  body: string,
  now = new Date().toISOString(),
): LayerIndexEntry[] {
  if (!body.trim()) return [];
  const base = path.dirname(layerIndexPath(root, scope, scopeId));
  const topicPath = path.relative(base, detailFile).replace(/\\/g, "/");
  const entries = summaries(body).map((summary) => ({
    memoryId: `${scope}-${createHash("sha256").update(`${scopeId}\n${summary}`).digest("hex").slice(0, 12)}`,
    title: summary.slice(0, 60),
    summary,
    topicPath,
    modified: now,
    status: "approved" as const,
  }));
  atomicWrite(layerIndexPath(root, scope, scopeId), renderIndex(scope, scopeId, entries, now));
  return entries;
}

export function topicMemoryPath(root: string, scope: LayeredMemoryScope, scopeId: string, topic: string): string {
  return path.join(scopeDir(root, scope, scopeId), `${safe(topic || "general")}.md`);
}

export function writeLayeredMemory(
  root: string,
  input: Omit<LayeredMemoryRecord, "memoryId" | "created" | "modified" | "contentHash"> & {
    memoryId?: string;
    created?: string;
    modified?: string;
  },
): LayeredMemoryRecord {
  const now = input.modified || new Date().toISOString();
  const content = input.content.trim();
  const record: LayeredMemoryRecord = {
    ...input,
    memoryId: input.memoryId || `mem-${randomUUID()}`,
    created: input.created || now,
    modified: now,
    contentHash: sha256(content),
    content,
  };
  const file = topicMemoryPath(root, record.scope, record.scopeId, `${record.topic}-${record.memoryId}`);
  const body = frontmatter({
    schema_version: 1,
    memory_id: record.memoryId,
    scope: record.scope,
    scope_id: safe(record.scopeId),
    status: record.status,
    topic: record.topic,
    freshness_status: record.freshness?.status,
    validated_at: record.freshness?.validatedAt,
    expires_at: record.freshness?.expiresAt,
    source_type: record.sourceType,
    source_run_id: record.sourceRunId,
    confidence: record.confidence,
    created: record.created,
    modified: record.modified,
    content_hash: record.contentHash,
    portable_bundle_record_b64: record.portableBundleRecord
      ? Buffer.from(JSON.stringify(record.portableBundleRecord), "utf-8").toString("base64url")
      : undefined,
  }) + `# ${record.title}\n\n${record.content}\n`;

  const indexFile = layerIndexPath(root, record.scope, record.scopeId);
  const existing = parseLayerIndex(root, record.scope, record.scopeId).filter((entry) => entry.memoryId !== record.memoryId);
  const rel = path.relative(path.dirname(indexFile), file).replace(/\\/g, "/");
  existing.unshift({
    memoryId: record.memoryId,
    title: record.title.slice(0, 80),
    summary: record.summary.replace(/\s+/g, " ").slice(0, 180),
    topicPath: rel,
    modified: now,
    status: record.status,
  });
  const staged = [
    stageFileWrite(file, body),
    stageFileWrite(indexFile, renderIndex(record.scope, record.scopeId, existing, now)),
  ];
  const db = isSqliteBackend(root) ? openDb(root) : null;
  let transactionOpen = false;
  try {
    if (db) {
      ensureSchema(db);
      db.exec("BEGIN");
      transactionOpen = true;
      db.prepare(
        "INSERT INTO layered_memories(memoryId,scope,scopeId,status,modified,contentHash,topicPath,doc) VALUES(?,?,?,?,?,?,?,?) " +
        "ON CONFLICT(memoryId) DO UPDATE SET scope=excluded.scope,scopeId=excluded.scopeId,status=excluded.status," +
        "modified=excluded.modified,contentHash=excluded.contentHash,topicPath=excluded.topicPath,doc=excluded.doc",
      ).run(record.memoryId, record.scope, record.scopeId, record.status, record.modified, record.contentHash, rel, JSON.stringify(record));
      db.prepare("DELETE FROM memory_fts WHERE memoryId=?").run(record.memoryId);
      db.prepare("INSERT INTO memory_fts(memoryId,scope,scopeId,title,summary,content) VALUES(?,?,?,?,?,?)")
        .run(record.memoryId, record.scope, record.scopeId, record.title, record.summary, record.content);
    }
    for (const item of staged) applyStagedFile(item);
    if (db) {
      db.exec("COMMIT");
      transactionOpen = false;
    }
    for (const item of staged) finalizeStagedFile(item);
  } catch (error) {
    if (db && transactionOpen) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    }
    for (const item of [...staged].reverse()) rollbackStagedFile(item);
    throw error;
  }

  return record;
}

export function readLayeredMemory(root: string, scope: LayeredMemoryScope, scopeId: string, memoryId: string): LayeredMemoryRecord | null {
  const entry = parseLayerIndex(root, scope, scopeId).find((item) => item.memoryId === memoryId);
  if (!entry) return null;
  const file = path.resolve(path.dirname(layerIndexPath(root, scope, scopeId)), entry.topicPath);
  const allowed = path.resolve(scopeDir(root, scope, scopeId));
  if (file !== allowed && !file.startsWith(allowed + path.sep)) return null;
  const parsed = parseFrontmatter(readText(file));
  if (!parsed.body) return null;
  const title = parsed.body.match(/^#\s+(.+)$/m)?.[1] ?? entry.title;
  const content = parsed.body.replace(/^#\s+.+$/m, "").trim();
  return {
    memoryId,
    scope,
    scopeId,
    title,
    summary: entry.summary,
    content,
    topic: parsed.meta.topic || path.basename(file, ".md").replace(new RegExp(`-${memoryId}$`), ""),
    sourceType: (parsed.meta.source_type as LayeredMemoryRecord["sourceType"]) || "manual",
    sourceRunId: parsed.meta.source_run_id || undefined,
    status: (parsed.meta.status as LayeredMemoryStatus) || entry.status,
    confidence: Number(parsed.meta.confidence) || 0,
    created: parsed.meta.created || entry.modified,
    modified: parsed.meta.modified || entry.modified,
    // The body is the truth source; frontmatter hashes may be stale after a user edit.
    contentHash: sha256(content),
    freshness: {
      status: (parsed.meta.freshness_status as "fresh" | "stale" | "unknown") || "unknown",
      validatedAt: parsed.meta.validated_at || undefined,
      expiresAt: parsed.meta.expires_at || undefined,
    },
    portableBundleRecord: parsePortableBundleRecord(parsed.meta.portable_bundle_record_b64),
  };
}

export function listLayeredMemories(root: string, scopes: Array<{ scope: LayeredMemoryScope; scopeId: string }>, limit = 100): LayeredMemoryRecord[] {
  const out: LayeredMemoryRecord[] = [];
  for (const item of scopes) {
    for (const entry of parseLayerIndex(root, item.scope, item.scopeId)) {
      const record = readLayeredMemory(root, item.scope, item.scopeId, entry.memoryId);
      if (record) out.push(record);
      if (out.length >= Math.min(Math.max(limit, 1), 100)) return out;
    }
  }
  return out;
}


export interface LayeredMemorySearchQuery {
  goal: string;
  scopes: Array<{ scope: LayeredMemoryScope; scopeId: string }>;
  limit?: number;
}

export function isLayeredMemoryInjectable(record: LayeredMemoryRecord, at = Date.now()): boolean {
  if (record.status !== "approved") return false;
  if (record.freshness?.status === "stale") return false;
  if (record.freshness?.expiresAt) {
    const expiresAt = Date.parse(record.freshness.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= at) return false;
  }
  return true;
}

function lexicalTerms(goal: string): string[] {
  const tokens = goal.toLowerCase().match(/[a-z0-9_.:/-]{2,}|[\u3400-\u9fff]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    out.add(token);
    if (/^[\u3400-\u9fff]+$/.test(token)) {
      for (let i = 0; i < token.length - 1; i++) out.add(token.slice(i, i + 2));
    }
  }
  return [...out].slice(0, 24);
}

export interface LayeredMemoryRankSignals {
  terms: string[];
  bm25Order?: number;
  bm25Count?: number;
  now?: number;
}

/**
 * Deterministic non-vector reranker. FTS/BM25 is only one signal: approved scope,
 * evidence, confidence and freshness remain visible in the final ordering.
 */
export function scoreLayeredMemoryCandidate(
  record: LayeredMemoryRecord,
  signals: LayeredMemoryRankSignals,
): number {
  const title = record.title.toLowerCase();
  const summary = record.summary.toLowerCase();
  const content = record.content.toLowerCase();
  const lexical = signals.terms.reduce((score, term) =>
    score + (title.includes(term) ? 3 : 0) + (summary.includes(term) ? 2 : 0) + (content.includes(term) ? 1 : 0), 0);
  const lexicalSignal = signals.terms.length ? Math.min(1, lexical / Math.max(3, signals.terms.length * 3)) : 0.35;
  const bm25Signal = signals.bm25Order === undefined
    ? 0
    : 1 - signals.bm25Order / Math.max(1, signals.bm25Count ?? 1);
  const scopeSignal: Record<LayeredMemoryScope, number> = {
    user: 0.95,
    company: 0.8,
    project: 1,
    team: 0.9,
    agent: 0.95,
  };
  const evidenceSignal = record.sourceRunId ? 1 : record.sourceType === 'manual' ? 0.75 : 0.45;
  const freshnessStatus = record.freshness?.status === 'fresh' ? 1 : 0.65;
  const validationAge = record.freshness?.validatedAt
    ? Math.max(0, (signals.now ?? Date.now()) - Date.parse(record.freshness.validatedAt))
    : Number.POSITIVE_INFINITY;
  const validationSignal = Number.isFinite(validationAge)
    ? Math.max(0.4, 1 - validationAge / (365 * 24 * 60 * 60 * 1000))
    : 0.55;
  const modifiedAge = Math.max(0, (signals.now ?? Date.now()) - Date.parse(record.modified));
  const recencySignal = Number.isFinite(modifiedAge)
    ? Math.max(0.25, 1 - modifiedAge / (730 * 24 * 60 * 60 * 1000))
    : 0.25;
  return lexicalSignal * 0.35
    + bm25Signal * 0.15
    + scopeSignal[record.scope] * 0.12
    + Math.min(1, Math.max(0, record.confidence)) * 0.13
    + evidenceSignal * 0.1
    + freshnessStatus * validationSignal * 0.1
    + recencySignal * 0.05;
}

export function searchLayeredMemories(root: string, query: LayeredMemorySearchQuery): LayeredMemoryRecord[] {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
  const terms = lexicalTerms(query.goal);
  const candidates = new Map<string, { record: LayeredMemoryRecord; bm25Order?: number; bm25Count?: number }>();
  if (isSqliteBackend(root) && terms.length) {
    try {
      const db = openDb(root);
      ensureSchema(db);
      const match = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      const perScopeLimit = Math.max(5, Math.ceil(100 / Math.max(1, query.scopes.length)));
      const statement = db.prepare(
        "SELECT memoryId,scope,scopeId,bm25(memory_fts) AS rank FROM memory_fts " +
        "WHERE memory_fts MATCH ? AND scope=? AND scopeId=? ORDER BY rank LIMIT ?",
      );
      for (const scope of query.scopes) {
        const rows = statement.all(match, scope.scope, scope.scopeId, perScopeLimit) as Array<{
          memoryId: string;
          scope: LayeredMemoryScope;
          scopeId: string;
          rank: number;
        }>;
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          const record = readLayeredMemory(root, row.scope, row.scopeId, row.memoryId);
          if (record && isLayeredMemoryInjectable(record)) {
            candidates.set(record.memoryId, { record, bm25Order: index, bm25Count: rows.length });
          }
        }
      }
    } catch { /* deterministic lexical fallback below */ }
  }

  if (candidates.size === 0) {
    for (const scope of query.scopes) {
      for (const record of listLayeredMemories(root, [scope], 100)) {
        if (isLayeredMemoryInjectable(record)) candidates.set(record.memoryId, { record });
      }
    }
  }

  return [...candidates.values()]
    .map((record) => ({
      record: record.record,
      score: scoreLayeredMemoryCandidate(record.record, {
        terms,
        bm25Order: record.bm25Order,
        bm25Count: record.bm25Count,
      }),
    }))
    .filter((item) => terms.length === 0 || terms.some((term) =>
      `${item.record.title} ${item.record.summary} ${item.record.content}`.toLowerCase().includes(term)))
    .sort((a, b) => b.score - a.score || b.record.modified.localeCompare(a.record.modified))
    .slice(0, limit)
    .map((item) => item.record);
}


export function discoverLayeredScopes(root: string): Array<{ scope: LayeredMemoryScope; scopeId: string }> {
  const base = path.join(root, ".opc", "memory");
  const out: Array<{ scope: LayeredMemoryScope; scopeId: string }> = [];
  const mappings: Array<[LayeredMemoryScope, string]> = [
    ["user", "users"],
    ["company", "companies"],
    ["project", "projects"],
    ["team", "teams"],
    ["agent", "agents"],
  ];
  for (const [scope, dirName] of mappings) {
    const dir = path.join(base, dirName);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const containsMarkdown = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true })
        .some((child) => child.isFile() && child.name.toLowerCase().endsWith(".md"));
      if (!containsMarkdown) continue;
      out.push({ scope, scopeId: entry.name });
    }
  }
  return out;
}
export interface LayeredMemoryRebuildReport {
  scopes: number;
  records: number;
  errors: Array<{ scope: LayeredMemoryScope; scopeId: string; error: string }>;
}

/**
 * Rebuild the bounded Markdown indexes and SQLite FTS cache from topic Markdown.
 * Each scope is parsed completely before either index is replaced, so a malformed
 * manual edit cannot partially corrupt the previous searchable state.
 */
export function rebuildLayeredMemorySearchIndex(root: string): LayeredMemoryRebuildReport {
  const report: LayeredMemoryRebuildReport = { scopes: 0, records: 0, errors: [] };
  const validStatuses = new Set<LayeredMemoryStatus>(["proposed", "approved", "rejected", "revoked", "archived"]);
  const validSources = new Set<LayeredMemoryRecord["sourceType"]>(["manual", "run", "import", "curator"]);

  for (const item of discoverLayeredScopes(root)) {
    try {
      const dir = scopeDir(root, item.scope, item.scopeId);
      const existing = new Map(parseLayerIndex(root, item.scope, item.scopeId).map((entry) => [entry.memoryId, entry]));
      const files = fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md") && entry.name !== "MEMORY.md")
        .map((entry) => path.join(dir, entry.name));
      const records: Array<{ record: LayeredMemoryRecord; topicPath: string }> = [];

      for (const file of files) {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = parseFrontmatter(raw);
        const memoryId = parsed.meta.memory_id;
        if (!memoryId) continue; // Legacy/external detail files remain indexed by ensureLegacyLayerIndex.
        if (parsed.meta.scope && parsed.meta.scope !== item.scope) throw new Error(`${path.basename(file)} scope mismatch`);
        if (!parsed.body) throw new Error(`${path.basename(file)} has no body`);
        const title = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim();
        if (!title) throw new Error(`${path.basename(file)} has no title`);
        const content = parsed.body.replace(/^#\s+.+$/m, "").trim();
        const old = existing.get(memoryId);
        const fileModified = fs.statSync(file).mtime.toISOString();
        const declaredModified = parsed.meta.modified || fileModified;
        const modified = fileModified > declaredModified ? fileModified : declaredModified;
        const status = validStatuses.has(parsed.meta.status as LayeredMemoryStatus)
          ? parsed.meta.status as LayeredMemoryStatus
          : "proposed";
        const sourceType = validSources.has(parsed.meta.source_type as LayeredMemoryRecord["sourceType"])
          ? parsed.meta.source_type as LayeredMemoryRecord["sourceType"]
          : "manual";
        const summary = old?.summary || summaries(content)[0] || title;
        records.push({
          topicPath: path.relative(dir, file).replace(/\\/g, "/"),
          record: {
            memoryId,
            scope: item.scope,
            scopeId: item.scopeId,
            title,
            summary: summary.replace(/\s+/g, " ").slice(0, 180),
            content,
            topic: parsed.meta.topic || path.basename(file, ".md"),
            sourceType,
            sourceRunId: parsed.meta.source_run_id || undefined,
            status,
            confidence: Math.min(1, Math.max(0, Number(parsed.meta.confidence) || 0)),
            created: parsed.meta.created || modified,
            modified,
            contentHash: sha256(content),
            freshness: {
              status: (parsed.meta.freshness_status as "fresh" | "stale" | "unknown") || "unknown",
              validatedAt: parsed.meta.validated_at || undefined,
              expiresAt: parsed.meta.expires_at || undefined,
            },
          },
        });
      }

      if (!records.length) continue;
      records.sort((a, b) => b.record.modified.localeCompare(a.record.modified));
      const entries = records.map(({ record, topicPath }) => ({
        memoryId: record.memoryId,
        title: record.title.slice(0, 80),
        summary: record.summary,
        topicPath,
        modified: record.modified,
        status: record.status,
      }));

      const stagedIndex = stageFileWrite(
        layerIndexPath(root, item.scope, item.scopeId),
        renderIndex(item.scope, item.scopeId, entries, new Date().toISOString()),
      );
      const db = isSqliteBackend(root) ? openDb(root) : null;
      let transactionOpen = false;
      try {
        if (db) {
          ensureSchema(db);
          db.exec("BEGIN");
          transactionOpen = true;
          db.prepare("DELETE FROM memory_fts WHERE scope=? AND scopeId=?").run(item.scope, item.scopeId);
          db.prepare("DELETE FROM layered_memories WHERE scope=? AND scopeId=?").run(item.scope, item.scopeId);
          const insertRecord = db.prepare(
            "INSERT INTO layered_memories(memoryId,scope,scopeId,status,modified,contentHash,topicPath,doc) VALUES(?,?,?,?,?,?,?,?)",
          );
          const insertFts = db.prepare(
            "INSERT INTO memory_fts(memoryId,scope,scopeId,title,summary,content) VALUES(?,?,?,?,?,?)",
          );
          for (const { record, topicPath } of records) {
            insertRecord.run(record.memoryId, record.scope, record.scopeId, record.status, record.modified, record.contentHash, topicPath, JSON.stringify(record));
            insertFts.run(record.memoryId, record.scope, record.scopeId, record.title, record.summary, record.content);
          }
        }
        applyStagedFile(stagedIndex);
        if (db) {
          db.exec("COMMIT");
          transactionOpen = false;
        }
        finalizeStagedFile(stagedIndex);
      } catch (error) {
        if (db && transactionOpen) {
          try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
        }
        rollbackStagedFile(stagedIndex);
        throw error;
      }
      report.scopes += 1;
      report.records += records.length;
    } catch (error) {
      report.errors.push({
        scope: item.scope,
        scopeId: item.scopeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return report;
}
