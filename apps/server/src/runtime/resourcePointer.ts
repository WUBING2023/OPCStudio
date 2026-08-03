import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { LayeredMemoryScope } from "../storage/layeredMemory.js";
import { isSqliteBackend } from "../storage/backend.js";
import { openDb } from "../storage/sqlite/db.js";
import { ensureSchema } from "../storage/sqlite/schema.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { safeFetch } from "../security/localGuards.js";

export type ResourcePointerKind = "file" | "git" | "http" | "mcp";
export type ResourcePointerStatus = "active" | "stale" | "unavailable" | "revoked";

export interface ResourcePointer {
  id: string;
  scope: LayeredMemoryScope;
  scopeId: string;
  title: string;
  uri: string;
  provider?: string;
  kind: ResourcePointerKind;
  contentHash?: string;
  etag?: string;
  authRef?: string;
  createdAt: string;
  validatedAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  freshnessPolicy: "per_run" | "ttl" | "manual";
  status: ResourcePointerStatus;
  sourceRunId?: string;
}

export interface ResourceValidation {
  resourceId: string;
  runId: string;
  ok: boolean;
  status: ResourcePointerStatus;
  checkedAt: string;
  contentHash?: string;
  etag?: string;
  reason?: string;
}

const validationCache = new Map<string, ResourceValidation>();
const safeId = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
const pointerFile = (root: string) => path.join(root, ".opc", "memory", "resource-pointers.json");

function hashBuffer(value: Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function normalizePointer(input: Omit<ResourcePointer, "id" | "createdAt" | "status"> & Partial<Pick<ResourcePointer, "id" | "createdAt" | "status">>): ResourcePointer {
  const uri = input.uri.trim();
  if (!uri) throw new Error("resource uri required");
  if (input.authRef && !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.authRef)) {
    throw new Error("authRef must be an opaque credential identifier");
  }
  if (/(bearer\s+|api[_-]?key=|token=|password=)/i.test(uri)) {
    throw new Error("resource uri must not contain credentials");
  }
  return {
    ...input,
    id: safeId(input.id || `resource-${randomUUID()}`),
    title: input.title.trim().slice(0, 160),
    uri,
    createdAt: input.createdAt || new Date().toISOString(),
    status: input.status || "active",
    ttlMs: input.ttlMs ? Math.min(Math.max(input.ttlMs, 60_000), 31_536_000_000) : undefined,
  };
}

function persist(root: string, pointer: ResourcePointer): void {
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    db.prepare(
      "INSERT INTO resource_pointers(id,scope,scopeId,status,validatedAt,expiresAt,doc) VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,scopeId=excluded.scopeId,status=excluded.status," +
      "validatedAt=excluded.validatedAt,expiresAt=excluded.expiresAt,doc=excluded.doc",
    ).run(pointer.id, pointer.scope, pointer.scopeId, pointer.status, pointer.validatedAt ?? null, pointer.expiresAt ?? null, JSON.stringify(pointer));
    return;
  }
  const all = readJSON<ResourcePointer[]>(pointerFile(root), []).filter((item) => item.id !== pointer.id);
  all.unshift(pointer);
  writeJSON(pointerFile(root), all);
}

export function upsertResourcePointer(
  root: string,
  input: Omit<ResourcePointer, "id" | "createdAt" | "status"> & Partial<Pick<ResourcePointer, "id" | "createdAt" | "status">>,
): ResourcePointer {
  const pointer = normalizePointer(input);
  persist(root, pointer);
  return pointer;
}

export function listResourcePointers(root: string, filter?: { scope?: LayeredMemoryScope; scopeId?: string }): ResourcePointer[] {
  let all: ResourcePointer[];
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    const rows = db.prepare("SELECT doc FROM resource_pointers ORDER BY id").all() as Array<{ doc: string }>;
    all = rows.flatMap((row) => {
      try { return [JSON.parse(row.doc) as ResourcePointer]; } catch { return []; }
    });
  } else {
    all = readJSON<ResourcePointer[]>(pointerFile(root), []);
  }
  return all.filter((item) =>
    (!filter?.scope || item.scope === filter.scope)
    && (!filter?.scopeId || item.scopeId === filter.scopeId));
}

export function getResourcePointer(root: string, id: string): ResourcePointer | null {
  return listResourcePointers(root).find((item) => item.id === id) ?? null;
}

function resolveLocalResource(root: string, uri: string): string {
  const candidate = path.resolve(root, uri.replace(/^file:\/\//i, ""));
  const allowed = path.resolve(root);
  if (candidate !== allowed && !candidate.startsWith(allowed + path.sep)) {
    throw new Error("resource path is outside projectRoot");
  }
  return candidate;
}

function persistRunValidation(root: string, validation: ResourceValidation): void {
  const file = path.join(root, ".opc", "runs", safeId(validation.runId), "resource-validation.json");
  const all = readJSON<ResourceValidation[]>(file, []).filter((item) => item.resourceId !== validation.resourceId);
  all.push(validation);
  writeJSON(file, all);
}

export async function validateResourcePointer(
  root: string,
  runId: string,
  pointerOrId: ResourcePointer | string,
  options?: { allowLocalNetwork?: boolean; mcpValidator?: (pointer: ResourcePointer) => Promise<{ ok: boolean; hash?: string; reason?: string }> },
): Promise<ResourceValidation> {
  const pointer = typeof pointerOrId === "string" ? getResourcePointer(root, pointerOrId) : pointerOrId;
  if (!pointer) throw new Error("resource pointer not found");
  const cacheKey = `${path.resolve(root)}|${runId}|${pointer.id}`;
  const cached = validationCache.get(cacheKey);
  if (cached) return cached;

  const checkedAt = new Date().toISOString();
  let result: ResourceValidation;
  try {
    if (pointer.kind === "file" || pointer.kind === "git") {
      const resourcePath = resolveLocalResource(root, pointer.uri);
      const data = fs.readFileSync(resourcePath);
      const contentHash = hashBuffer(data);
      result = {
        resourceId: pointer.id,
        runId,
        ok: !pointer.contentHash || pointer.contentHash === contentHash,
        status: !pointer.contentHash || pointer.contentHash === contentHash ? "active" : "stale",
        checkedAt,
        contentHash,
        reason: pointer.contentHash && pointer.contentHash !== contentHash ? "content_hash_changed" : undefined,
      };
    } else if (pointer.kind === "http") {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await safeFetch(pointer.uri, { method: "HEAD", signal: controller.signal }, { allowLocalNetwork: options?.allowLocalNetwork === true });
        const etag = response.headers.get("etag") ?? undefined;
        result = {
          resourceId: pointer.id,
          runId,
          ok: response.ok,
          status: response.ok ? (pointer.etag && etag && pointer.etag !== etag ? "stale" : "active") : "unavailable",
          checkedAt,
          etag,
          reason: response.ok ? undefined : `http_${response.status}`,
        };
      } finally {
        clearTimeout(timer);
      }
    } else {
      if (!options?.mcpValidator) throw new Error("mcp validator unavailable");
      const checked = await options.mcpValidator(pointer);
      result = {
        resourceId: pointer.id,
        runId,
        ok: checked.ok,
        status: checked.ok ? "active" : "unavailable",
        checkedAt,
        contentHash: checked.hash,
        reason: checked.reason,
      };
    }
  } catch (error) {
    result = {
      resourceId: pointer.id,
      runId,
      ok: false,
      status: "unavailable",
      checkedAt,
      reason: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
    };
  }

  validationCache.set(cacheKey, result);
  persistRunValidation(root, result);
  const expiresAt = pointer.ttlMs ? new Date(Date.now() + pointer.ttlMs).toISOString() : pointer.expiresAt;
  persist(root, {
    ...pointer,
    validatedAt: checkedAt,
    expiresAt,
    contentHash: result.contentHash ?? pointer.contentHash,
    etag: result.etag ?? pointer.etag,
    status: result.status,
  });
  return result;
}

export function clearRunResourceValidationCache(root: string, runId: string): void {
  const prefix = `${path.resolve(root)}|${runId}|`;
  for (const key of validationCache.keys()) if (key.startsWith(prefix)) validationCache.delete(key);
}
