import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  discoverLayeredScopes,
  listLayeredMemories,
  writeLayeredMemory,
  type LayeredMemoryRecord,
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import { isSqliteBackend } from "../storage/backend.js";
import { openDb } from "../storage/sqlite/db.js";
import { ensureSchema } from "../storage/sqlite/schema.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { invokeSystemModel } from "./systemModelInvoke.js";
import {
  decideGovernedMemoryProposal,
  loadMemoryPolicy,
  proposeMemory,
} from "./memoryGovernance.js";

export interface CuratorAction {
  kind:
    | "archive_duplicate"
    | "mark_stale"
    | "propose_merge"
    | "review_conflict"
    | "review_low_novelty"
    | "review_derivable"
    | "review_invalid";
  memoryIds: string[];
  reason: string;
  applied: boolean;
  createdMemoryId?: string;
  proposalId?: string;
}

export interface MemoryCuratorRun {
  id: string;
  scope?: LayeredMemoryScope;
  scopeId?: string;
  status: "dry_run" | "completed" | "completed_with_model_error" | "rolled_back";
  createdAt: string;
  completedAt: string;
  dryRun: boolean;
  modelMergeRequested: boolean;
  modelMergeUsed: boolean;
  scanned: number;
  actions: CuratorAction[];
  before: LayeredMemoryRecord[];
  createdMemoryIds: string[];
  createdProposalIds: string[];
  report: string;
  modelError?: string;
}

const lastActivity = new Map<string, number>();
const curatorFile = (root: string) => path.join(root, ".opc", "memory", "curator-runs.json");
const normalize = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

export function markMemoryActivity(root: string): void {
  lastActivity.set(path.resolve(root), Date.now());
}

function persistCuratorRun(root: string, run: MemoryCuratorRun): void {
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    db.prepare(
      "INSERT INTO memory_curator_runs(id,scope,scopeId,status,createdAt,doc) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status,doc=excluded.doc",
    ).run(run.id, run.scope ?? null, run.scopeId ?? null, run.status, run.createdAt, JSON.stringify(run));
    return;
  }
  const all = readJSON<MemoryCuratorRun[]>(curatorFile(root), []).filter((item) => item.id !== run.id);
  all.unshift(run);
  writeJSON(curatorFile(root), all.slice(0, 100));
}

export function listMemoryCuratorRuns(root: string): MemoryCuratorRun[] {
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    return (db.prepare("SELECT doc FROM memory_curator_runs ORDER BY createdAt DESC").all() as Array<{ doc: string }>)
      .flatMap((row) => {
        try { return [JSON.parse(row.doc) as MemoryCuratorRun]; } catch { return []; }
      });
  }
  return readJSON<MemoryCuratorRun[]>(curatorFile(root), []);
}

function collectRecords(root: string, scope?: LayeredMemoryScope, scopeId?: string): LayeredMemoryRecord[] {
  const scopes = discoverLayeredScopes(root).filter((item) =>
    (!scope || item.scope === scope) && (!scopeId || item.scopeId === scopeId));
  return listLayeredMemories(root, scopes, 100 * Math.max(scopes.length, 1));
}

function archiveRecord(root: string, record: LayeredMemoryRecord): void {
  writeLayeredMemory(root, {
    ...record,
    status: "archived",
    freshness: record.freshness,
    memoryId: record.memoryId,
    created: record.created,
    modified: new Date().toISOString(),
  });
}

function markStale(root: string, record: LayeredMemoryRecord): void {
  writeLayeredMemory(root, {
    ...record,
    freshness: { ...record.freshness, status: "stale" },
    memoryId: record.memoryId,
    created: record.created,
    modified: new Date().toISOString(),
  });
}

function parseModelMerges(content: string): Array<{ sourceIds: string[]; title: string; summary: string; content: string }> {
  const match = content.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try {
    const raw = JSON.parse(match[0]) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const value = item as Record<string, unknown>;
      const sourceIds = Array.isArray(value.sourceIds)
        ? value.sourceIds.filter((id): id is string => typeof id === "string").slice(0, 8)
        : [];
      if (sourceIds.length < 2 || typeof value.content !== "string" || typeof value.title !== "string") return [];
      return [{
        sourceIds,
        title: value.title.slice(0, 100),
        summary: typeof value.summary === "string" ? value.summary.slice(0, 180) : value.title.slice(0, 180),
        content: value.content.slice(0, 8_000),
      }];
    });
  } catch { return []; }
}

async function runMemoryCuratorUnlocked(root: string, options?: {
  scope?: LayeredMemoryScope;
  scopeId?: string;
  dryRun?: boolean;
  modelMerge?: boolean;
}): Promise<MemoryCuratorRun> {
  const createdAt = new Date().toISOString();
  const dryRun = options?.dryRun !== false;
  const policy = loadMemoryPolicy(root);
  const modelMergeRequested = options?.modelMerge ?? policy.autoModelMerge;
  const records = collectRecords(root, options?.scope, options?.scopeId);
  const before = new Map<string, LayeredMemoryRecord>();
  const actions: CuratorAction[] = [];
  const createdMemoryIds: string[] = [];
  const createdProposalIds: string[] = [];

  const exactGroups = new Map<string, LayeredMemoryRecord[]>();
  for (const record of records) {
    const key = `${record.scope}:${record.scopeId}:${normalize(record.content)}`;
    const group = exactGroups.get(key) ?? [];
    group.push(record);
    exactGroups.set(key, group);
  }
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => b.confidence - a.confidence || b.modified.localeCompare(a.modified));
    for (const duplicate of group.slice(1)) {
      before.set(duplicate.memoryId, duplicate);
      actions.push({
        kind: "archive_duplicate",
        memoryIds: [duplicate.memoryId],
        reason: `exact duplicate of ${group[0].memoryId}`,
        applied: !dryRun,
      });
      if (!dryRun) archiveRecord(root, duplicate);
    }
  }

  const now = Date.now();
  for (const record of records) {
    if (!record.freshness?.expiresAt || record.freshness.status === "stale") continue;
    const expires = Date.parse(record.freshness.expiresAt);
    if (!Number.isFinite(expires) || expires > now) continue;
    before.set(record.memoryId, record);
    actions.push({
      kind: "mark_stale",
      memoryIds: [record.memoryId],
      reason: `expired at ${record.freshness.expiresAt}`,
      applied: !dryRun,
    });
    if (!dryRun) markStale(root, record);
  }

  const reviewKeys = new Set<string>();
  const addReview = (action: CuratorAction): void => {
    const key = action.kind + ':' + [...action.memoryIds].sort().join(',');
    if (reviewKeys.has(key)) return;
    reviewKeys.add(key);
    actions.push(action);
  };
  const active = records.filter((record) => record.status === 'approved');
  for (const record of active) {
    if (record.title.trim().length < 3 || record.content.trim().length < 8 || !record.scopeId.trim()) {
      addReview({
        kind: 'review_invalid',
        memoryIds: [record.memoryId],
        reason: 'missing identity, title or reusable content',
        applied: false,
      });
    }
    if (/(node_modules|git status|git log|current modified files|当前已修改文件|临时目录|stack trace|raw output)/i.test(record.content)) {
      addReview({
        kind: 'review_derivable',
        memoryIds: [record.memoryId],
        reason: 'content appears derivable from code, Git or transient runtime state',
        applied: false,
      });
    }
  }
  for (let left = 0; left < active.length; left++) {
    for (let right = left + 1; right < active.length; right++) {
      const a = active[left];
      const b = active[right];
      if (a.scope !== b.scope || a.scopeId !== b.scopeId) continue;
      const na = normalize(a.content);
      const nb = normalize(b.content);
      if (na === nb) continue;
      const shorter = na.length <= nb.length ? na : nb;
      const longer = na.length > nb.length ? na : nb;
      if (shorter.length >= 20 && longer.includes(shorter) && shorter.length / longer.length >= 0.7) {
        addReview({
          kind: 'review_low_novelty',
          memoryIds: [a.memoryId, b.memoryId],
          reason: 'one approved memory substantially subsumes the other',
          applied: false,
        });
      }
      const sameTopic = a.topic === b.topic || normalize(a.title) === normalize(b.title);
      const polarityConflict = /\b(always|required|must|never|禁止|必须)\b/i.test(a.content + ' ' + b.content)
        && /\b(not|never|avoid|不要|不得|禁止)\b/i.test(a.content + ' ' + b.content);
      if (sameTopic && polarityConflict) {
        addReview({
          kind: 'review_conflict',
          memoryIds: [a.memoryId, b.memoryId],
          reason: 'same-topic memories contain incompatible obligation or prohibition signals',
          applied: false,
        });
      }
    }
  }

  let modelMergeUsed = false;
  let modelError: string | undefined;
  if (modelMergeRequested && !dryRun && records.length >= 2) {
    try {
      const candidates = records
        .filter((record) => record.status === "approved")
        .slice(0, 40)
        .map((record) => ({
          id: record.memoryId,
          scope: record.scope,
          scopeId: record.scopeId,
          title: record.title,
          summary: record.summary,
          content: record.content.slice(0, 800),
        }));
      const response = await invokeSystemModel(root, "judge", {
        agentId: "memory-curator",
        agentRole: "memory_curator",
        maxTokens: 1_200,
        system: [
          "You are OPC Memory Curator. Return a JSON array only.",
          "Merge only genuinely redundant approved memories with the same scope and scopeId.",
          "Each item: {sourceIds,title,summary,content}. Do not invent facts or merge contradictions.",
          "An empty array is preferred when evidence is insufficient.",
        ].join("\n"),
        messages: [{ role: "user", content: JSON.stringify(candidates) }],
      });
      const byId = new Map(records.map((record) => [record.memoryId, record]));
      for (const merge of parseModelMerges(response.content)) {
        const sources = merge.sourceIds.map((id) => byId.get(id)).filter((item): item is LayeredMemoryRecord => !!item);
        if (sources.length < 2) continue;
        if (!sources.every((item) => item.scope === sources[0].scope && item.scopeId === sources[0].scopeId)) continue;
        const proposal = proposeMemory(root, {
          text: merge.content,
          title: merge.title,
          summary: merge.summary,
          objectType: 'fact',
          scope: sources[0].scope,
          scopeId: sources[0].scopeId,
          sourceType: "curator",
          evidenceIds: sources.map((item) => item.memoryId),
          autoApprove: false,
        });
        createdProposalIds.push(proposal.proposalId);
        actions.push({
          kind: "propose_merge",
          memoryIds: sources.map((item) => item.memoryId),
          reason: "model merge passed same-scope guard and was stored as a review proposal only",
          applied: false,
          proposalId: proposal.proposalId,
        });
        modelMergeUsed = true;
      }
    } catch (error) {
      modelError = error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
    }
  }

  const completedAt = new Date().toISOString();
  const status: MemoryCuratorRun["status"] = dryRun
    ? "dry_run"
    : modelError ? "completed_with_model_error" : "completed";
  const report = [
    `Scanned ${records.length} active memories.`,
    `${actions.filter((item) => item.kind === "archive_duplicate").length} exact duplicates queued or archived.`,
    `${actions.filter((item) => item.kind === "mark_stale").length} expired resources or facts marked stale.`,
    `${actions.filter((item) => item.kind === "propose_merge").length} model merge candidates proposed for review.`,
    `${actions.filter((item) => item.kind.startsWith("review_")).length} conflict, novelty or validity reviews suggested.`,
    dryRun ? "Dry-run only: no memory was changed." : "Changes are reversible with this curator run id.",
    modelError ? `Model merge degraded safely: ${modelError}` : "",
  ].filter(Boolean).join("\n");
  const run: MemoryCuratorRun = {
    id: `curator-${randomUUID()}`,
    scope: options?.scope,
    scopeId: options?.scopeId,
    status,
    createdAt,
    completedAt,
    dryRun,
    modelMergeRequested,
    modelMergeUsed,
    scanned: records.length,
    actions,
    before: [...before.values()],
    createdMemoryIds,
    createdProposalIds,
    report,
    modelError,
  };
  persistCuratorRun(root, run);
  return run;
}

const curatorLocks = new Map<string, Promise<MemoryCuratorRun>>();

export function runMemoryCurator(
  root: string,
  options?: Parameters<typeof runMemoryCuratorUnlocked>[1],
): Promise<MemoryCuratorRun> {
  const key = [path.resolve(root), options?.scope ?? "*", options?.scopeId ?? "*"].join("|");
  const inFlight = curatorLocks.get(key);
  if (inFlight) return inFlight;
  const task = runMemoryCuratorUnlocked(root, options).finally(() => {
    if (curatorLocks.get(key) === task) curatorLocks.delete(key);
  });
  curatorLocks.set(key, task);
  return task;
}

export function rollbackMemoryCuratorRun(root: string, runId: string): MemoryCuratorRun | null {
  const run = listMemoryCuratorRuns(root).find((item) => item.id === runId);
  if (!run || run.status === "rolled_back" || run.dryRun) return null;
  for (const record of run.before) {
    writeLayeredMemory(root, {
      ...record,
      memoryId: record.memoryId,
      created: record.created,
      modified: new Date().toISOString(),
    });
  }
  for (const memoryId of run.createdMemoryIds ?? []) {
    const created = collectRecords(root).find((item) => item.memoryId === memoryId);
    if (created) archiveRecord(root, created);
  }
  for (const proposalId of run.createdProposalIds ?? []) {
    decideGovernedMemoryProposal(root, proposalId, 'rejected', 'curator-rollback');
  }
  run.status = "rolled_back";
  run.completedAt = new Date().toISOString();
  run.report += "\nRollback completed; original records were restored and curator-created records archived.";
  persistCuratorRun(root, run);
  return run;
}

export function scheduleMemoryCurator(root: string): () => void {
  const normalized = path.resolve(root);
  markMemoryActivity(normalized);
  const tick = async () => {
    const policy = loadMemoryPolicy(normalized);
    if (!policy.autoCurate) return;
    const idleMs = Date.now() - (lastActivity.get(normalized) ?? 0);
    if (idleMs < 2 * 60 * 60 * 1000) return;
    const latest = listMemoryCuratorRuns(normalized)[0];
    if (latest && Date.now() - Date.parse(latest.completedAt) < 24 * 60 * 60 * 1000) return;
    await runMemoryCurator(normalized, { dryRun: false, modelMerge: policy.autoModelMerge });
  };
  const first = setTimeout(() => { void tick(); }, 2 * 60 * 60 * 1000);
  first.unref?.();
  const interval = setInterval(() => { void tick(); }, 60 * 60 * 1000);
  interval.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(interval);
  };
}
