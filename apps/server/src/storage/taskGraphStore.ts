import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskGraph, TaskNode, TaskNodeStartedReceipt } from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";

const MAX_GRAPHS = 100;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

const graphsPath = (root: string) => path.join(root, ".opc", "task-graphs.json");
const lockPath = (root: string) => path.join(root, ".opc", "task-graphs.lock");
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

export class TaskGraphRevisionConflictError extends Error {
  constructor(
    public readonly graphId: string,
    public readonly expectedRevision: number,
    public readonly actualRevision: number,
  ) {
    super(`TaskGraph ${graphId} revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "TaskGraphRevisionConflictError";
  }
}

function cloneGraph(graph: TaskGraph): TaskGraph {
  return structuredClone(graph);
}

/** Upgrade legacy v1 documents in memory without requiring a migration pass. */
export function normalizeTaskGraph(graph: TaskGraph): TaskGraph {
  const normalized = cloneGraph(graph);
  normalized.schemaVersion = "2";
  normalized.revision = Number.isInteger(normalized.revision) && (normalized.revision ?? 0) >= 0
    ? normalized.revision
    : 0;
  normalized.nodes = (normalized.nodes ?? []).map((node) => ({
    ...node,
    schemaVersion: "2",
    attempt: Number.isInteger(node.attempt) && (node.attempt ?? 0) >= 0 ? node.attempt : 0,
    visit: Number.isInteger(node.visit) && (node.visit ?? 0) >= 0 ? node.visit : 0,
    artifactRefs: Array.isArray(node.artifactRefs) ? [...node.artifactRefs] : [],
    evidenceRefs: Array.isArray(node.evidenceRefs) ? [...node.evidenceRefs] : [],
    uncertain: node.uncertain === true,
  }));
  return normalized;
}

function loadUnlocked(root: string): TaskGraph[] {
  const raw = isSqliteBackend(root)
    ? readAllDocs(openBusinessDb(root), "task_graphs")
    : readJSON<TaskGraph[]>(graphsPath(root), []);
  return Array.isArray(raw) ? (raw as TaskGraph[]).map(normalizeTaskGraph) : [];
}

function writeUnlocked(root: string, graphs: TaskGraph[]): void {
  const capped = graphs.slice(0, MAX_GRAPHS).map(normalizeTaskGraph);
  writeJSON(graphsPath(root), capped);
  if (isSqliteBackend(root)) {
    replaceAllDocs(openBusinessDb(root), "task_graphs", capped);
  }
}

function withStoreLock<T>(root: string, work: () => T): T {
  const file = lockPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf-8");
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > STALE_LOCK_MS) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch { /* another writer released it */ }
      if (Date.now() >= deadline) throw new Error("TaskGraph store lock timeout");
      Atomics.wait(sleepCell, 0, 0, 5);
    }
  }
  try {
    return work();
  } finally {
    try { fs.closeSync(fd); } catch { /* best effort */ }
    try { fs.rmSync(file, { force: true }); } catch { /* stale lock cleanup handles a crash */ }
  }
}

export function loadTaskGraphs(root: string): TaskGraph[] {
  return loadUnlocked(root);
}

/** Legacy whole-list API. New concurrent writers should use upsert/update CAS APIs below. */
export function saveTaskGraphs(root: string, graphs: TaskGraph[]): void {
  withStoreLock(root, () => writeUnlocked(root, graphs));
}

export function getTaskGraph(root: string, id: string): TaskGraph | undefined {
  return loadTaskGraphs(root).find(g => g.id === id);
}

export function getTaskGraphByMission(root: string, missionId: string): TaskGraph | undefined {
  return loadTaskGraphs(root).find(g => g.missionId === missionId);
}

/**
 * Merge one graph into the latest store snapshot. Different graph ids therefore
 * cannot overwrite each other. Existing v2 graphs use revision CAS.
 */
export function upsertTaskGraph(root: string, graph: TaskGraph): TaskGraph {
  return withStoreLock(root, () => {
    const all = loadUnlocked(root);
    const index = all.findIndex(g => g.id === graph.id);
    const incoming = normalizeTaskGraph(graph);
    if (index >= 0) {
      const actual = all[index].revision ?? 0;
      if (graph.revision !== undefined && graph.revision !== actual) {
        throw new TaskGraphRevisionConflictError(graph.id, graph.revision, actual);
      }
      incoming.revision = actual + 1;
      all[index] = incoming;
    } else {
      incoming.revision = 1;
      all.unshift(incoming);
    }
    writeUnlocked(root, all);
    // Keep the caller's node object identities stable: the completion-driven
    // scheduler has in-flight closures keyed to those objects.
    graph.schemaVersion = "2";
    graph.revision = incoming.revision;
    return cloneGraph(incoming);
  });
}

/** Atomic single-graph compare-and-swap mutation. */
export function updateTaskGraphCAS(
  root: string,
  graphId: string,
  expectedRevision: number | undefined,
  mutate: (graph: TaskGraph) => void,
): TaskGraph {
  return withStoreLock(root, () => {
    const all = loadUnlocked(root);
    const index = all.findIndex(g => g.id === graphId);
    if (index < 0) throw new Error(`TaskGraph not found: ${graphId}`);
    const current = all[index];
    const actual = current.revision ?? 0;
    if (expectedRevision !== undefined && expectedRevision !== actual) {
      throw new TaskGraphRevisionConflictError(graphId, expectedRevision, actual);
    }
    const next = cloneGraph(current);
    mutate(next);
    const normalized = normalizeTaskGraph(next);
    normalized.revision = actual + 1;
    all[index] = normalized;
    writeUnlocked(root, all);
    return cloneGraph(normalized);
  });
}

export interface TaskNodeLeaseOptions {
  owner: string;
  leaseMs?: number;
  now?: string;
  inputHash: string;
  sideEffectRisk?: boolean;
}

export interface TaskNodeLeaseResult {
  claimed: boolean;
  graph: TaskGraph;
  node?: TaskNode;
}

export interface TaskNodeLeaseRenewalResult {
  renewed: boolean;
  graph: TaskGraph;
  node?: TaskNode;
}

/** Atomically acquire a node lease and persist its started receipt before dispatch. */
export function claimTaskNodeLease(
  root: string,
  graphId: string,
  nodeId: string,
  options: TaskNodeLeaseOptions,
): TaskNodeLeaseResult {
  return withStoreLock(root, () => {
    const all = loadUnlocked(root);
    const index = all.findIndex(g => g.id === graphId);
    if (index < 0) throw new Error(`TaskGraph not found: ${graphId}`);
    const graph = all[index];
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`TaskNode not found: ${graphId}/${nodeId}`);
    const now = options.now ?? new Date().toISOString();
    const activeLease = !!node.leaseOwner && !!node.leaseExpiry && Date.parse(node.leaseExpiry) > Date.parse(now);
    const runnable = node.status === "planned" || node.status === "pending";
    if (!runnable || activeLease || !!node.completionReceipt) {
      return { claimed: false, graph: cloneGraph(graph), node: structuredClone(node) };
    }
    const attempt = (node.attempt ?? 0) + 1;
    const visit = (node.visit ?? 0) + 1;
    const idempotencyKey = `${graphId}:${nodeId}:${attempt}:${options.inputHash}`;
    const expiry = new Date(Date.parse(now) + Math.max(1_000, options.leaseMs ?? 5 * 60_000)).toISOString();
    const receipt: TaskNodeStartedReceipt = {
      receiptId: randomUUID(),
      at: now,
      attempt,
      visit,
      inputHash: options.inputHash,
      idempotencyKey,
      leaseOwner: options.owner,
      sideEffectRisk: options.sideEffectRisk !== false,
    };
    Object.assign(node, {
      schemaVersion: "2" as const,
      attempt,
      visit,
      inputHash: options.inputHash,
      idempotencyKey,
      leaseOwner: options.owner,
      leaseExpiry: expiry,
      startedReceipt: receipt,
      completionReceipt: undefined,
      uncertain: false,
      status: "running" as const,
    });
    node.statusHistory.push({ status: "running", at: now, by: "core" });
    graph.status = "running";
    graph.updatedAt = now;
    graph.schemaVersion = "2";
    graph.revision = (graph.revision ?? 0) + 1;
    all[index] = graph;
    writeUnlocked(root, all);
    return { claimed: true, graph: cloneGraph(graph), node: structuredClone(node) };
  });
}

/** Extend only the lease owned by the exact started attempt. */
export function renewTaskNodeLease(
  root: string,
  graphId: string,
  nodeId: string,
  options: { owner: string; idempotencyKey: string; leaseMs?: number; now?: string },
): TaskNodeLeaseRenewalResult {
  return withStoreLock(root, () => {
    const all = loadUnlocked(root);
    const index = all.findIndex(g => g.id === graphId);
    if (index < 0) throw new Error(`TaskGraph not found: ${graphId}`);
    const graph = all[index];
    const node = graph.nodes.find(n => n.id === nodeId);
    if (!node) throw new Error(`TaskNode not found: ${graphId}/${nodeId}`);
    const ownsAttempt = node.status === "running"
      && !node.completionReceipt
      && node.leaseOwner === options.owner
      && node.idempotencyKey === options.idempotencyKey;
    if (!ownsAttempt) {
      return { renewed: false, graph: cloneGraph(graph), node: structuredClone(node) };
    }
    const now = options.now ?? new Date().toISOString();
    node.leaseExpiry = new Date(Date.parse(now) + Math.max(1_000, options.leaseMs ?? 5 * 60_000)).toISOString();
    graph.updatedAt = now;
    graph.revision = (graph.revision ?? 0) + 1;
    all[index] = graph;
    writeUnlocked(root, all);
    return { renewed: true, graph: cloneGraph(graph), node: structuredClone(node) };
  });
}
