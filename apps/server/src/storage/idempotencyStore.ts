import { createHash } from "node:crypto";
import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

const STORE_VERSION = 1;
const MAX_RECORDS = 2_000;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SECRET_FIELD = /(?:api[-_]?key|authorization|cookie|password|secret|token)$/i;

export interface IdempotencyRecord {
  key: string;
  operation: string;
  requestHash: string;
  state: "in_progress" | "completed";
  targetId?: string;
  statusCode?: number;
  response?: unknown;
  createdAt: string;
  updatedAt: string;
}

interface IdempotencyDocument {
  schemaVersion: typeof STORE_VERSION;
  records: IdempotencyRecord[];
}

export type IdempotencyClaim =
  | { kind: "claimed"; record: IdempotencyRecord }
  | { kind: "in_progress"; record: IdempotencyRecord }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "conflict"; record: IdempotencyRecord };

function storePath(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "idempotency.json");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function sanitizeResponse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeResponse);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        SECRET_FIELD.test(key) ? "[REDACTED]" : sanitizeResponse(entry),
      ]),
    );
  }
  return value;
}

function load(projectRoot: string): IdempotencyDocument {
  const parsed = readJSON<IdempotencyDocument | null>(storePath(projectRoot), null);
  if (!parsed || parsed.schemaVersion !== STORE_VERSION || !Array.isArray(parsed.records)) {
    return { schemaVersion: STORE_VERSION, records: [] };
  }
  return parsed;
}

function save(projectRoot: string, doc: IdempotencyDocument, nowMs = Date.now()): void {
  const cutoff = nowMs - RETENTION_MS;
  doc.records = doc.records
    .filter((record) => Date.parse(record.updatedAt) >= cutoff)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_RECORDS);
  writeJSON(storePath(projectRoot), doc);
}

export function validateIdempotencyKey(key: string): boolean {
  return SAFE_KEY.test(key);
}

export function hashIdempotencyRequest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function claimIdempotency(
  projectRoot: string,
  key: string,
  operation: string,
  requestHash: string,
): IdempotencyClaim {
  const doc = load(projectRoot);
  const existing = doc.records.find((record) => record.key === key);
  if (existing) {
    if (existing.operation !== operation || existing.requestHash !== requestHash) {
      return { kind: "conflict", record: existing };
    }
    return { kind: existing.state === "completed" ? "replay" : "in_progress", record: existing };
  }

  const now = new Date().toISOString();
  const record: IdempotencyRecord = {
    key,
    operation,
    requestHash,
    state: "in_progress",
    createdAt: now,
    updatedAt: now,
  };
  doc.records.push(record);
  save(projectRoot, doc);
  return { kind: "claimed", record };
}

export function bindIdempotencyTarget(projectRoot: string, key: string, targetId: string): void {
  const doc = load(projectRoot);
  const record = doc.records.find((entry) => entry.key === key);
  if (!record || record.state !== "in_progress") throw new Error("idempotency claim not active");
  if (record.targetId && record.targetId !== targetId) throw new Error("idempotency target conflict");
  record.targetId = targetId;
  record.updatedAt = new Date().toISOString();
  save(projectRoot, doc);
}

export function completeIdempotency(
  projectRoot: string,
  key: string,
  statusCode: number,
  response: unknown,
): void {
  const doc = load(projectRoot);
  const record = doc.records.find((entry) => entry.key === key);
  if (!record) throw new Error("idempotency claim missing");
  record.state = "completed";
  record.statusCode = statusCode;
  record.response = sanitizeResponse(response);
  record.updatedAt = new Date().toISOString();
  save(projectRoot, doc);
}

