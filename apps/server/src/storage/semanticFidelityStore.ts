import * as path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./jsonFile.js";
import type { SemanticFidelityReport } from "../runtime/semanticFidelity.js";

const STORE_SCHEMA_VERSION = "2" as const;
const MAX_REPORTS = 500;

export interface PersistedSemanticFidelityReport {
  recordedAt: string;
  report: SemanticFidelityReport;
}

interface SemanticFidelityStoreFile {
  schemaVersion: string;
  reports: Array<{ recordedAt: string; report: Record<string, unknown> }>;
}

const storePath = (projectRoot: string): string =>
  path.join(projectRoot, ".opc", "semantic-fidelity-reports.json");

function canonicalize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function hashReport(body: Record<string, unknown>): string {
  return `sha256:${createHash("sha256").update(canonicalize(body), "utf-8").digest("hex")}`;
}

function normalizeStoredReport(raw: Record<string, unknown>): SemanticFidelityReport {
  if (raw.schemaVersion === "2" && raw.fieldFidelity && raw.runtimeSemantics) {
    return raw as unknown as SemanticFidelityReport;
  }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const preserved = strings(raw.preserved);
  const transformed = strings(raw.transformed);
  const redacted = strings(raw.redacted);
  const requiresLocalSetup = strings(raw.requiresLocalSetup);
  const operation: SemanticFidelityReport["operation"] =
    raw.operation === "merge" || raw.operation === "restore" ? raw.operation : "import";
  const lost = strings(raw.lost);
  const ok = raw.ok === true && lost.length === 0;
  const body = {
    schemaVersion: "2" as const,
    operation,
    sourceSchemaVersion: typeof raw.sourceSchemaVersion === "string" ? raw.sourceSchemaVersion : "unknown",
    targetSchemaVersion: typeof raw.targetSchemaVersion === "string" ? raw.targetSchemaVersion : "unknown",
    preserved,
    transformed,
    redacted,
    requiresLocalSetup,
    lost,
    lostCount: lost.length,
    ok,
    fieldFidelity: {
      status: ok ? "ok" as const : "failed" as const,
      ok,
      preserved,
      transformed,
      redacted,
      requiresLocalSetup,
      lost,
      lostCount: lost.length,
    },
    runtimeSemantics: {
      status: "not-collected" as const,
      proofLevel: "not-collected" as const,
      equivalent: false,
      checks: [{
        dimension: "runtime-readiness" as const,
        status: "not-collected" as const,
        proofLevel: "not-collected" as const,
        details: ["legacy field-only report; runtime semantic evidence was not collected"],
      }],
      transformedNotProven: [],
      degraded: [],
      notCollected: ["runtime-readiness" as const],
    },
    runtimeEquivalent: false,
  };
  return { ...body, reportHash: hashReport(body) };
}

export function loadSemanticFidelityReports(projectRoot: string): PersistedSemanticFidelityReport[] {
  const stored = readJSON<SemanticFidelityStoreFile>(storePath(projectRoot), {
    schemaVersion: STORE_SCHEMA_VERSION,
    reports: [],
  });
  if (!stored || !["1", STORE_SCHEMA_VERSION].includes(stored.schemaVersion) || !Array.isArray(stored.reports)) return [];
  return stored.reports
    .filter((entry) => !!entry && typeof entry.recordedAt === "string" && !!entry.report)
    .map((entry) => ({ recordedAt: entry.recordedAt, report: normalizeStoredReport(entry.report) }));
}

export function persistSemanticFidelityReport(
  projectRoot: string,
  report: SemanticFidelityReport,
): PersistedSemanticFidelityReport {
  const entry = { recordedAt: new Date().toISOString(), report };
  const reports = [entry, ...loadSemanticFidelityReports(projectRoot)].slice(0, MAX_REPORTS);
  writeJSON(storePath(projectRoot), { schemaVersion: STORE_SCHEMA_VERSION, reports });
  return entry;
}
