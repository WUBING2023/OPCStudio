import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeCompanyId } from "@opc/shared";
import { isSqliteBackend } from "../storage/backend.js";
import {
  discoverLayeredScopes,
  listLayeredMemories,
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import { listMemory } from "../storage/memoryStore.js";
import { loadRunTask } from "../storage/projectStore.js";
import { readBoundedUtf8File } from "../storage/rawFile.js";
import { loadRegistry, MemoryRecordSchema, type MemoryRecord } from "../storage/registryStore.js";
import { loadLessons, ReflectionLessonSchema, type ReflectionLesson } from "../storage/reflectionStore.js";
import {
  listGovernedMemoryProposals,
  proposeMemory,
  type GovernedMemoryProposal,
  type MemoryObjectType,
} from "./memoryGovernance.js";

const MAX_RUN_DIRECTORIES = 2_000;
const MAX_LEGACY_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MIGRATION_PROPOSALS_JSON = 500;
const SAFE_SCOPE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SENSITIVE_CONTENT = /(api[_ -]?key|secret|password|passwd|bearer\s+[a-z0-9._-]+|sk-[a-z0-9_-]{12,}|\u5bc6\u94a5|\u5bc6\u7801)/i;

export type LegacyMemorySourceId =
  | "project_memory"
  | "reflection_lessons"
  | "memory_registry"
  | "run_committed_memory"
  | "run_memory_proposals"
  | "legacy_markdown";

export type LegacyMigrationDisposition = "pending" | "duplicate" | "conflict" | "failed";

export interface LegacyMemorySourceReport {
  source: LegacyMemorySourceId;
  writer: string;
  format: "json" | "jsonl" | "markdown" | "sqlite";
  pathPattern: string;
  fileCount: number;
  recordCount: number;
  pendingCount: number;
  duplicateCount: number;
  conflictCount: number;
  failedCount: number;
  failures: Array<{ relativePath: string; reason: string }>;
}

export interface LegacyMemoryCandidateReport {
  legacyId: string;
  source: LegacyMemorySourceId;
  relativePath: string;
  scope: LayeredMemoryScope;
  scopeId: string;
  title: string;
  objectType: MemoryObjectType;
  contentHash: string;
  disposition: LegacyMigrationDisposition;
  reason?: string;
}

export interface LegacyMemoryMigrationAudit {
  mode: "legacy_read_only";
  state: "clean" | "legacy_read_only" | "migration_pending" | "conflict" | "failed";
  generatedAt: string;
  storageBackend: "json" | "sqlite";
  legacyRecordCount: number;
  pendingMigrationCount: number;
  duplicateCount: number;
  conflictCount: number;
  failureCount: number;
  sources: LegacyMemorySourceReport[];
  candidates: LegacyMemoryCandidateReport[];
}

export interface LegacyMemoryMigrationResult {
  status: "completed" | "partial" | "no_op";
  proposedCount: number;
  skippedDuplicateCount: number;
  conflictCount: number;
  failedCount: number;
  proposalIds: string[];
  failures: Array<{ legacyId: string; reason: string }>;
  auditBefore: LegacyMemoryMigrationAudit;
  auditAfter: LegacyMemoryMigrationAudit;
}

interface LegacyCandidate extends Omit<LegacyMemoryCandidateReport, "disposition"> {
  content: string;
  summary: string;
  sourceRunId?: string;
  disposition?: LegacyMigrationDisposition;
  reason?: string;
}

interface SourceAccumulator {
  source: LegacyMemorySourceId;
  writer: string;
  format: LegacyMemorySourceReport["format"];
  pathPattern: string;
  fileCount: number;
  failures: Array<{ relativePath: string; reason: string }>;
}

interface ScanResult {
  candidates: LegacyCandidate[];
  sources: Map<LegacyMemorySourceId, SourceAccumulator>;
}

interface HashLocation {
  scope: LayeredMemoryScope;
  scopeId: string;
  kind: "layered" | "proposal";
  id: string;
}

const SOURCE_DEFINITIONS: Array<Omit<SourceAccumulator, "fileCount" | "failures">> = [
  {
    source: "project_memory",
    writer: "storage/memoryStore.addMemory",
    format: "jsonl",
    pathPattern: ".opc/memory/project.jsonl",
  },
  {
    source: "reflection_lessons",
    writer: "storage/reflectionStore.addOrUpdateLesson/addManualLesson",
    format: "jsonl",
    pathPattern: ".opc/memory/lessons.jsonl",
  },
  {
    source: "memory_registry",
    writer: "storage/registryStore.addConclusionSummary/addProceduralSkill/addPlanTemplate",
    format: "jsonl",
    pathPattern: ".opc/memory/registry.jsonl",
  },
  {
    source: "run_committed_memory",
    writer: "storage/projectStore.appendCommittedMemory",
    format: "json",
    pathPattern: ".opc/runs/*/committed-memories.json",
  },
  {
    source: "run_memory_proposals",
    writer: "storage/projectStore.upsertMemoryProposals",
    format: "json",
    pathPattern: ".opc/runs/*/memory_proposals.json",
  },
  {
    source: "legacy_markdown",
    writer: "storage/mdMemory.write*/append*",
    format: "markdown",
    pathPattern: ".opc/knowledge/**/*.md | .opc/memory/users/*/preferences.md",
  },
];

function contentHash(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return `sha256:${createHash("sha256").update(normalized, "utf-8").digest("hex")}`;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).replace(/\\/g, "/");
}

function titleFrom(value: string, fallback: string): string {
  const first = value.split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").trim())
    .find(Boolean);
  return (first || fallback).replace(/\s+/g, " ").slice(0, 80);
}

function summaryFrom(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function makeLegacyId(source: LegacyMemorySourceId, relativePath: string, recordId: string): string {
  return `legacy-${createHash("sha256")
    .update(`${source}\n${relativePath}\n${recordId}`)
    .digest("hex")
    .slice(0, 20)}`;
}

function createSources(root: string): Map<LegacyMemorySourceId, SourceAccumulator> {
  const sqlite = isSqliteBackend(root);
  return new Map(SOURCE_DEFINITIONS.map((item) => [item.source, {
    ...item,
    format: sqlite && ["project_memory", "reflection_lessons", "memory_registry"].includes(item.source)
      ? "sqlite"
      : item.format,
    fileCount: 0,
    failures: [],
  }]));
}

function recordFailure(
  sources: Map<LegacyMemorySourceId, SourceAccumulator>,
  source: LegacyMemorySourceId,
  relativePath: string,
  reason: string,
): void {
  sources.get(source)?.failures.push({ relativePath, reason });
}

function addCandidate(
  result: ScanResult,
  input: Omit<LegacyCandidate, "legacyId" | "contentHash" | "summary">
    & { recordId: string; summary?: string },
): void {
  const content = input.content.replace(/\s+/g, " ").trim();
  const base: LegacyCandidate = {
    legacyId: makeLegacyId(input.source, input.relativePath, input.recordId),
    source: input.source,
    relativePath: input.relativePath,
    scope: input.scope,
    scopeId: input.scopeId.trim(),
    title: input.title.trim().slice(0, 80),
    objectType: input.objectType,
    content,
    summary: input.summary?.trim().slice(0, 180) || summaryFrom(content),
    contentHash: contentHash(content),
    sourceRunId: input.sourceRunId,
  };
  if (content.length < 8) {
    base.disposition = "failed";
    base.reason = "content_too_short";
  } else if (content.length > 8_000) {
    base.disposition = "failed";
    base.reason = "content_too_long";
  } else if (!SAFE_SCOPE_ID.test(base.scopeId)) {
    base.disposition = "failed";
    base.reason = "invalid_scope_identity";
  } else if (SENSITIVE_CONTENT.test(content)) {
    base.disposition = "failed";
    base.reason = "sensitive_content";
  }
  result.candidates.push(base);
}

function inspectJsonlFile(
  root: string,
  file: string,
  source: LegacyMemorySourceId,
  result: ScanResult,
  validate?: (value: unknown) => boolean,
): void {
  if (!fs.existsSync(file)) return;
  const accumulator = result.sources.get(source);
  if (accumulator) accumulator.fileCount++;
  const rel = relative(root, file);
  try {
    const loaded = readBoundedUtf8File(file, MAX_LEGACY_FILE_BYTES);
    if (!loaded.ok) {
      recordFailure(result.sources, source, rel, loaded.error ?? loaded.reason);
      return;
    }
    const lines = loaded.text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          recordFailure(result.sources, source, rel, `line_${index + 1}:record_not_object`);
        } else if (validate && !validate(parsed)) {
          recordFailure(result.sources, source, rel, `line_${index + 1}:schema_invalid`);
        }
      } catch {
        recordFailure(result.sources, source, rel, `line_${index + 1}:invalid_json`);
      }
    }
  } catch (error) {
    recordFailure(
      result.sources,
      source,
      rel,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function isLegacyProjectMemoryRecord(value: unknown): value is {
  id: string;
  agentRole: string;
  companyId?: string;
  text: string;
  source?: { runId?: string };
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const source = record.source as Record<string, unknown> | undefined;
  return typeof record.id === "string"
    && typeof record.text === "string"
    && typeof record.agentRole === "string"
    && !!source
    && typeof source.type === "string";
}

function scanProjectMemory(root: string, result: ScanResult): void {
  const rel = ".opc/memory/project.jsonl";
  inspectJsonlFile(root, path.join(root, rel), "project_memory", result, isLegacyProjectMemoryRecord);
  try {
    for (const raw of listMemory(root) as unknown[]) {
      if (!isLegacyProjectMemoryRecord(raw)) continue;
      const entry = raw;
      addCandidate(result, {
        source: "project_memory",
        relativePath: rel,
        recordId: entry.id,
        scope: "company",
        scopeId: entry.companyId?.trim() || "default",
        title: `Legacy project memory: ${entry.agentRole || "shared"}`,
        content: entry.text,
        objectType: "fact",
        sourceRunId: entry.source?.runId,
      });
    }
  } catch (error) {
    recordFailure(
      result.sources,
      "project_memory",
      rel,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function registryContent(record: MemoryRecord): {
  title: string;
  content: string;
  objectType: MemoryObjectType;
  sourceRunId?: string;
} {
  if (record.kind === "conclusion_summary") {
    return {
      title: "Legacy run conclusion",
      content: record.points.join("\n"),
      objectType: "fact",
      sourceRunId: record.sourceRunId || record.runId,
    };
  }
  if (record.kind === "procedural_skill") {
    const content = [
      record.taskType ? `Task type: ${record.taskType}` : "",
      ...record.preconditions.map((item) => `Precondition: ${item}`),
      ...record.successfulSequence.map((item) => `Step: ${item}`),
      ...record.producedArtifacts.map((item) => `Artifact: ${item}`),
      ...record.antiPatterns.map((item) => `Avoid: ${item}`),
    ].filter(Boolean).join("\n");
    return {
      title: `Legacy reusable procedure: ${record.role}`,
      content,
      objectType: "success_experience",
      sourceRunId: record.sourceRuns[0],
    };
  }
  return {
    title: `Legacy plan template: ${record.taskType}`,
    content: record.split.map((item) => `Step: ${item}`).join("\n"),
    objectType: "success_experience",
    sourceRunId: record.sourceRun,
  };
}

function scanRegistry(root: string, result: ScanResult): void {
  const rel = ".opc/memory/registry.jsonl";
  inspectJsonlFile(
    root,
    path.join(root, rel),
    "memory_registry",
    result,
    (value) => MemoryRecordSchema.safeParse(value).success,
  );
  try {
    for (const record of loadRegistry(root)) {
      const mapped = registryContent(record);
      const teamId = record.kind === "conclusion_summary" ? record.teamId : undefined;
      addCandidate(result, {
        source: "memory_registry",
        relativePath: rel,
        recordId: record.id,
        scope: teamId ? "team" : "company",
        scopeId: teamId || record.companyId?.trim() || "default",
        title: mapped.title,
        content: mapped.content,
        objectType: mapped.objectType,
        sourceRunId: mapped.sourceRunId,
      });
    }
  } catch (error) {
    recordFailure(
      result.sources,
      "memory_registry",
      rel,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function lessonContent(lesson: ReflectionLesson): string {
  return [
    lesson.diagnosis && `Diagnosis: ${lesson.diagnosis}`,
    lesson.lesson && `Lesson: ${lesson.lesson}`,
    lesson.recommendedChange && `Recommended change: ${lesson.recommendedChange}`,
    lesson.antiPattern && `Avoid: ${lesson.antiPattern}`,
  ].filter(Boolean).join("\n");
}

function scanLessons(root: string, result: ScanResult): void {
  const rel = ".opc/memory/lessons.jsonl";
  inspectJsonlFile(
    root,
    path.join(root, rel),
    "reflection_lessons",
    result,
    (value) => ReflectionLessonSchema.safeParse(value).success,
  );
  try {
    for (const lesson of loadLessons(root)) {
      const scope: LayeredMemoryScope = lesson.scope.agentId
        ? "agent"
        : lesson.scope.teamId ? "team" : "company";
      const scopeId = lesson.scope.agentId
        || lesson.scope.teamId
        || lesson.scope.companyId
        || "default";
      addCandidate(result, {
        source: "reflection_lessons",
        relativePath: rel,
        recordId: lesson.id,
        scope,
        scopeId,
        title: `Legacy failure lesson: ${lesson.trigger.failureMode}`,
        content: lessonContent(lesson),
        objectType: "failure_lesson",
        sourceRunId: lesson.evidence.runId,
      });
    }
  } catch (error) {
    recordFailure(
      result.sources,
      "reflection_lessons",
      rel,
      error instanceof Error ? error.message : String(error),
    );
  }
}

function parseJsonArray(
  root: string,
  file: string,
  source: LegacyMemorySourceId,
  result: ScanResult,
): unknown[] {
  const accumulator = result.sources.get(source);
  if (accumulator) accumulator.fileCount++;
  const rel = relative(root, file);
  try {
    const loaded = readBoundedUtf8File(file, MAX_LEGACY_FILE_BYTES);
    if (!loaded.ok) {
      recordFailure(result.sources, source, rel, loaded.error ?? loaded.reason);
      return [];
    }
    const parsed = JSON.parse(loaded.text);
    if (!Array.isArray(parsed)) {
      recordFailure(result.sources, source, rel, "root_not_array");
      return [];
    }
    return parsed;
  } catch (error) {
    recordFailure(
      result.sources,
      source,
      rel,
      error instanceof Error ? error.message : String(error),
    );
    return [];
  }
}

function scopeForRunRecord(
  root: string,
  runId: string,
  record: Record<string, unknown>,
): { scope: LayeredMemoryScope; scopeId: string } {
  const rawScope = typeof record.scope === "string" ? record.scope : "";
  const agentId = typeof record.agentId === "string" ? record.agentId : "";
  const task = loadRunTask(root, runId);
  if (rawScope === "agent" && agentId) return { scope: "agent", scopeId: agentId };
  if (rawScope === "team" && typeof record.teamId === "string") {
    return { scope: "team", scopeId: record.teamId };
  }
  const companyId = typeof record.companyId === "string"
    ? record.companyId
    : task?.companyId;
  return { scope: "company", scopeId: normalizeCompanyId(companyId) };
}

function scanRunFiles(root: string, result: ScanResult): void {
  const runsDir = path.join(root, ".opc", "runs");
  if (!fs.existsSync(runsDir)) return;
  let runDirs: fs.Dirent[] = [];
  try {
    runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .slice(0, MAX_RUN_DIRECTORIES);
  } catch (error) {
    recordFailure(
      result.sources,
      "run_committed_memory",
      ".opc/runs",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  for (const dir of runDirs) {
    const runId = dir.name;
    const committedFile = path.join(runsDir, runId, "committed-memories.json");
    if (fs.existsSync(committedFile)) {
      const rel = relative(root, committedFile);
      const records = parseJsonArray(root, committedFile, "run_committed_memory", result);
      records.forEach((raw, index) => {
        if (!raw || typeof raw !== "object"
          || typeof (raw as Record<string, unknown>).content !== "string") {
          recordFailure(
            result.sources,
            "run_committed_memory",
            rel,
            `record_${index + 1}:invalid_shape`,
          );
          return;
        }
        const record = raw as Record<string, unknown>;
        const scoped = scopeForRunRecord(root, runId, record);
        const type = typeof record.type === "string" ? record.type : "memory";
        addCandidate(result, {
          source: "run_committed_memory",
          relativePath: rel,
          recordId: typeof record.memoryId === "string" ? record.memoryId : String(index),
          ...scoped,
          title: `Legacy committed memory: ${type}`,
          content: record.content as string,
          objectType: /failure|lesson|risk/i.test(type) ? "failure_lesson" : "fact",
          sourceRunId: runId,
        });
      });
    }

    const proposalsFile = path.join(runsDir, runId, "memory_proposals.json");
    if (fs.existsSync(proposalsFile)) {
      const rel = relative(root, proposalsFile);
      const records = parseJsonArray(root, proposalsFile, "run_memory_proposals", result);
      records.forEach((raw, index) => {
        if (!raw || typeof raw !== "object"
          || typeof (raw as Record<string, unknown>).content !== "string") {
          recordFailure(
            result.sources,
            "run_memory_proposals",
            rel,
            `record_${index + 1}:invalid_shape`,
          );
          return;
        }
        const record = raw as Record<string, unknown>;
        const scoped = scopeForRunRecord(root, runId, record);
        const kind = typeof record.kind === "string" ? record.kind : "proposal";
        addCandidate(result, {
          source: "run_memory_proposals",
          relativePath: rel,
          recordId: typeof record.proposalId === "string" ? record.proposalId : String(index),
          ...scoped,
          title: `Legacy memory proposal: ${kind}`,
          content: record.content as string,
          objectType: /failure|lesson|risk|policy/i.test(kind) ? "failure_lesson" : "fact",
          sourceRunId: runId,
        });
      });
    }
  }
}

function legacyMarkdownFiles(root: string): Array<{
  file: string;
  scope: LayeredMemoryScope;
  scopeId: string;
}> {
  const out: Array<{ file: string; scope: LayeredMemoryScope; scopeId: string }> = [];
  const addDirectory = (
    dir: string,
    scope: LayeredMemoryScope,
    idFromName: (name: string) => string,
  ) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
      out.push({
        file: path.join(dir, entry.name),
        scope,
        scopeId: idFromName(entry.name),
      });
    }
  };
  const knowledge = path.join(root, ".opc", "knowledge");
  const companyFile = path.join(knowledge, "company.md");
  if (fs.existsSync(companyFile)) {
    out.push({ file: companyFile, scope: "company", scopeId: "default" });
  }
  const companiesDir = path.join(knowledge, "companies");
  if (fs.existsSync(companiesDir)) {
    for (const entry of fs.readdirSync(companiesDir, { withFileTypes: true })) {
      const file = path.join(companiesDir, entry.name, "company.md");
      if (entry.isDirectory() && fs.existsSync(file)) {
        out.push({ file, scope: "company", scopeId: entry.name });
      }
    }
  }
  addDirectory(
    path.join(knowledge, "teams"),
    "team",
    (name) => path.basename(name, ".md"),
  );
  addDirectory(
    path.join(knowledge, "projects"),
    "project",
    (name) => path.basename(name, ".md"),
  );
  addDirectory(
    path.join(knowledge, "agents"),
    "agent",
    (name) => path.basename(name, ".md").replace(/-memory$/, ""),
  );

  const usersDir = path.join(root, ".opc", "memory", "users");
  if (fs.existsSync(usersDir)) {
    for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      const file = path.join(usersDir, entry.name, "preferences.md");
      if (entry.isDirectory() && fs.existsSync(file)) {
        out.push({ file, scope: "user", scopeId: entry.name });
      }
    }
  }
  return out;
}

function scanLegacyMarkdown(root: string, result: ScanResult): void {
  let files: Array<{ file: string; scope: LayeredMemoryScope; scopeId: string }> = [];
  try {
    files = legacyMarkdownFiles(root);
  } catch (error) {
    recordFailure(
      result.sources,
      "legacy_markdown",
      ".opc/knowledge",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const accumulator = result.sources.get("legacy_markdown");
  if (accumulator) accumulator.fileCount += files.length;
  for (const item of files) {
    const rel = relative(root, item.file);
    try {
      const loaded = readBoundedUtf8File(item.file, MAX_LEGACY_FILE_BYTES);
      if (!loaded.ok) {
        recordFailure(result.sources, "legacy_markdown", rel, loaded.error ?? loaded.reason);
        continue;
      }
      const content = loaded.text.trim();
      if (!content) continue;
      if (/^---\r?\n[\s\S]*?^memory_id:/m.test(content)) continue;
      addCandidate(result, {
        source: "legacy_markdown",
        relativePath: rel,
        recordId: rel,
        scope: item.scope,
        scopeId: item.scopeId,
        title: titleFrom(content, path.basename(item.file, ".md")),
        content,
        objectType: item.scope === "user" ? "user_preference" : "fact",
      });
    } catch (error) {
      recordFailure(
        result.sources,
        "legacy_markdown",
        rel,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function scanLegacy(root: string): ScanResult {
  const result: ScanResult = { candidates: [], sources: createSources(root) };
  scanProjectMemory(root, result);
  scanLessons(root, result);
  scanRegistry(root, result);
  scanRunFiles(root, result);
  scanLegacyMarkdown(root, result);
  return result;
}

function existingHashLocations(root: string): Map<string, HashLocation[]> {
  const out = new Map<string, HashLocation[]>();
  const add = (hashValue: string, location: HashLocation) => {
    const list = out.get(hashValue) ?? [];
    list.push(location);
    out.set(hashValue, list);
  };
  for (const scope of discoverLayeredScopes(root)) {
    for (const record of listLayeredMemories(root, [scope], 10_000)) {
      add(contentHash(record.content), {
        scope: record.scope,
        scopeId: record.scopeId,
        kind: "layered",
        id: record.memoryId,
      });
    }
  }
  for (const proposal of listGovernedMemoryProposals(root)) {
    add(contentHash(proposal.content), {
      scope: proposal.scope,
      scopeId: proposal.scopeId,
      kind: "proposal",
      id: proposal.proposalId,
    });
  }
  return out;
}

function classifyCandidates(root: string, candidates: LegacyCandidate[]): void {
  const existing = existingHashLocations(root);
  const legacyScopes = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    if (candidate.disposition === "failed") continue;
    const scopes = legacyScopes.get(candidate.contentHash) ?? new Set<string>();
    scopes.add(`${candidate.scope}:${candidate.scopeId}`);
    legacyScopes.set(candidate.contentHash, scopes);
  }
  const accepted = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.disposition === "failed") continue;
    const scopeKey = `${candidate.scope}:${candidate.scopeId}`;
    if ((legacyScopes.get(candidate.contentHash)?.size ?? 0) > 1) {
      candidate.disposition = "conflict";
      candidate.reason = "same_content_hash_has_multiple_legacy_scopes";
      continue;
    }
    const locations = existing.get(candidate.contentHash) ?? [];
    if (locations.some((item) => `${item.scope}:${item.scopeId}` !== scopeKey)) {
      candidate.disposition = "conflict";
      candidate.reason = "same_content_hash_exists_in_different_scope";
      continue;
    }
    const acceptedKey = `${candidate.contentHash}:${scopeKey}`;
    if (locations.length > 0 || accepted.has(acceptedKey)) {
      candidate.disposition = "duplicate";
      candidate.reason = locations.length > 0
        ? "content_hash_already_migrated"
        : "duplicate_legacy_record";
      continue;
    }
    candidate.disposition = "pending";
    accepted.add(acceptedKey);
  }
}

function buildAudit(root: string, scan: ScanResult): LegacyMemoryMigrationAudit {
  classifyCandidates(root, scan.candidates);
  const candidates: LegacyMemoryCandidateReport[] = scan.candidates.map(({
    content: _content,
    summary: _summary,
    sourceRunId: _sourceRunId,
    ...item
  }) => ({
    ...item,
    disposition: item.disposition ?? "failed",
  }));
  const sources = Array.from(scan.sources.values()).map((source): LegacyMemorySourceReport => {
    const own = candidates.filter((item) => item.source === source.source);
    return {
      ...source,
      recordCount: own.length,
      pendingCount: own.filter((item) => item.disposition === "pending").length,
      duplicateCount: own.filter((item) => item.disposition === "duplicate").length,
      conflictCount: own.filter((item) => item.disposition === "conflict").length,
      failedCount: own.filter((item) => item.disposition === "failed").length
        + source.failures.length,
    };
  });
  const pendingMigrationCount = candidates
    .filter((item) => item.disposition === "pending").length;
  const duplicateCount = candidates
    .filter((item) => item.disposition === "duplicate").length;
  const conflictCount = candidates
    .filter((item) => item.disposition === "conflict").length;
  const failureCount = candidates
    .filter((item) => item.disposition === "failed").length
    + sources.reduce((sum, source) => sum + source.failures.length, 0);
  const legacyRecordCount = candidates.length;
  const state: LegacyMemoryMigrationAudit["state"] = failureCount > 0
    ? "failed"
    : conflictCount > 0 ? "conflict"
      : pendingMigrationCount > 0 ? "migration_pending"
        : legacyRecordCount > 0 ? "legacy_read_only" : "clean";
  return {
    mode: "legacy_read_only",
    state,
    generatedAt: new Date().toISOString(),
    storageBackend: isSqliteBackend(root) ? "sqlite" : "json",
    legacyRecordCount,
    pendingMigrationCount,
    duplicateCount,
    conflictCount,
    failureCount,
    sources,
    candidates,
  };
}

/** Read-only audit. It never creates directories, proposals, indexes or migration markers. */
export function auditLegacyMemoryMigration(root: string): LegacyMemoryMigrationAudit {
  return buildAudit(root, scanLegacy(root));
}

function proposalInput(candidate: LegacyCandidate): Parameters<typeof proposeMemory>[1] {
  return {
    text: candidate.content,
    title: candidate.title,
    summary: candidate.summary,
    objectType: candidate.objectType,
    scope: candidate.scope,
    scopeId: candidate.scopeId,
    sourceType: "import",
    sourceRunId: candidate.sourceRunId,
    autoApprove: false,
    rootCauseConfirmed: false,
    evidenceIds: candidate.sourceRunId ? [candidate.sourceRunId] : [],
    counterexamples: [],
  };
}

/**
 * Converts eligible legacy records into governed Layered Memory proposals.
 * Legacy files remain untouched and every new record stays proposed for review.
 */
export function migrateLegacyMemoryToLayeredProposals(
  root: string,
): LegacyMemoryMigrationResult {
  const scan = scanLegacy(root);
  const auditBefore = buildAudit(root, scan);
  const pendingById = new Map(scan.candidates
    .filter((item) => item.disposition === "pending")
    .map((item) => [item.legacyId, item]));
  const proposalIds: string[] = [];
  const failures: Array<{ legacyId: string; reason: string }> = [];
  let capacity = Number.POSITIVE_INFINITY;
  if (!isSqliteBackend(root)) {
    capacity = Math.max(
      0,
      MAX_MIGRATION_PROPOSALS_JSON - listGovernedMemoryProposals(root).length,
    );
  }

  for (const candidateReport of auditBefore.candidates) {
    if (candidateReport.disposition !== "pending") continue;
    const candidate = pendingById.get(candidateReport.legacyId);
    if (!candidate) continue;
    if (proposalIds.length >= capacity) {
      failures.push({
        legacyId: candidate.legacyId,
        reason: "proposal_store_capacity_exceeded",
      });
      continue;
    }
    try {
      const proposal: GovernedMemoryProposal = proposeMemory(root, proposalInput(candidate));
      if (proposal.status !== "proposed" || proposal.memoryId) {
        failures.push({
          legacyId: candidate.legacyId,
          reason: `migration_must_remain_proposed:${proposal.status}`,
        });
        continue;
      }
      proposalIds.push(proposal.proposalId);
    } catch (error) {
      failures.push({
        legacyId: candidate.legacyId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const auditAfter = auditLegacyMemoryMigration(root);
  const failedCount = auditBefore.failureCount + failures.length;
  const conflictCount = auditBefore.conflictCount;
  return {
    status: failedCount > 0 || conflictCount > 0
      ? "partial"
      : proposalIds.length > 0 ? "completed" : "no_op",
    proposedCount: proposalIds.length,
    skippedDuplicateCount: auditBefore.duplicateCount,
    conflictCount,
    failedCount,
    proposalIds,
    failures,
    auditBefore,
    auditAfter,
  };
}
