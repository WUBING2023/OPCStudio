import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

// 波6 · 合并冲突人类决裁流程 —— 冲突落盘(经 store 层,不由 routes/runtime 裸拼 .opc 路径,过 seam-guard)。
// 每个未决合并冲突一条记录:.opc/conflicts/<id>.json。id 由 worker 分支派生(分支在一个 run 内唯一:
// opc-wt-<runId 前缀-taskId>,__finalize 冲突用 opc-run-*),因此天然按分支去重。
// 生命周期:pending(worktree/分支保留待人工)→ resolved(人工采纳分支/放弃/标记已手工处理后)。
// 决裁后才允许 removeWorktree;createWorktree 遇到同目录 pending 记录会拒绝销毁(防丢决裁现场)。

export type ConflictStatus = "pending" | "resolved";
// 采纳 worker 分支 / 放弃该分支 / 人工已在工作副本手动合并
export type ConflictResolution = "take_branch" | "discard" | "mark_manual";

export interface ConflictRecord {
  id: string;               // 稳定 id(sanitized 分支名),即 .opc/conflicts/<id>.json 的 <id>
  runId: string;
  taskId?: string;
  agentId?: string;
  branch: string;           // 保留的 worker 分支(opc-wt-* / opc-run-*)
  dir: string;              // 该分支对应 worktree 目录(绝对路径);决裁后据此 removeWorktree
  conflictFiles: string[];
  createdAt: string;
  status: ConflictStatus;
  resolvedAt?: string;
  resolution?: ConflictResolution;
  resolvedBy?: string;
}

function conflictsDir(root: string): string {
  return path.join(root, ".opc", "conflicts");
}

// 分支名 → 文件安全 id。分支已是 [a-zA-Z0-9_-] + 少量分隔符,统一压成安全字符;截断防超长文件名。
export function conflictIdForBranch(branch: string): string {
  return (branch || "conflict").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "conflict";
}

function recordPath(root: string, id: string): string {
  // id 已是 conflictIdForBranch 的输出;再过一次归一防止调用方误传原始分支名/含分隔符的字符串越权拼路径。
  return path.join(conflictsDir(root), `${conflictIdForBranch(id)}.json`);
}

export interface RecordConflictInput {
  runId: string;
  taskId?: string;
  agentId?: string;
  branch: string;
  dir: string;
  conflictFiles: string[];
}

// 冲突落盘(幂等 upsert)。已存在且已 resolved 的记录不被"复活"成 pending(避免重复派发同一分支时
// 覆盖决裁结果);已存在 pending 的记录刷新冲突文件清单。新记录以 pending 落库。
export function recordConflict(root: string, input: RecordConflictInput): ConflictRecord {
  const id = conflictIdForBranch(input.branch);
  const existing = getConflict(root, id);
  if (existing && existing.status === "resolved") return existing;
  const rec: ConflictRecord = {
    id,
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    branch: input.branch,
    dir: input.dir,
    conflictFiles: [...new Set(input.conflictFiles ?? [])],
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    status: "pending",
  };
  writeJSON(recordPath(root, id), rec);
  return rec;
}

export function getConflict(root: string, id: string): ConflictRecord | undefined {
  const rec = readJSON<ConflictRecord | null>(recordPath(root, id), null);
  return rec ?? undefined;
}

export function listConflicts(root: string, opts?: { status?: ConflictStatus; runId?: string }): ConflictRecord[] {
  let names: string[];
  try {
    names = fs.readdirSync(conflictsDir(root)).filter((n) => n.endsWith(".json") && !n.includes(".tmp-"));
  } catch {
    return [];
  }
  const out: ConflictRecord[] = [];
  for (const n of names) {
    const rec = readJSON<ConflictRecord | null>(path.join(conflictsDir(root), n), null);
    if (!rec) continue;
    if (opts?.status && rec.status !== opts.status) continue;
    if (opts?.runId && rec.runId !== opts.runId) continue;
    out.push(rec);
  }
  // 新的在前(pending 先于 resolved,同状态按 createdAt 倒序)。
  out.sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return (b.createdAt || "").localeCompare(a.createdAt || "");
  });
  return out;
}

export function listPendingConflictsForRun(root: string, runId: string): ConflictRecord[] {
  return listConflicts(root, { status: "pending", runId });
}

// createWorktree 保护:该 worktree 目录是否仍挂着未决冲突记录(dir 完全相等,大小写按平台原样比对)。
export function hasPendingConflictForDir(root: string, dir: string): boolean {
  const norm = (p: string) => path.resolve(p);
  const target = norm(dir);
  return listConflicts(root, { status: "pending" }).some((c) => {
    try { return norm(c.dir) === target; } catch { return c.dir === dir; }
  });
}

export function hasPendingConflictForBranch(root: string, branch: string): boolean {
  const rec = getConflict(root, conflictIdForBranch(branch));
  return !!rec && rec.status === "pending";
}

// 人工决裁:置 resolved + 记录采纳方式与决裁人。已 resolved 返回原记录(调用方据此判 409/幂等)。
export function resolveConflict(
  root: string,
  id: string,
  input: { resolution: ConflictResolution; resolvedBy?: string },
): { record?: ConflictRecord; alreadyResolved?: boolean } {
  const rec = getConflict(root, id);
  if (!rec) return {};
  if (rec.status === "resolved") return { record: rec, alreadyResolved: true };
  const updated: ConflictRecord = {
    ...rec,
    status: "resolved",
    resolvedAt: new Date().toISOString(),
    resolution: input.resolution,
    resolvedBy: input.resolvedBy?.trim()?.slice(0, 80) || "human",
  };
  writeJSON(recordPath(root, id), updated);
  return { record: updated };
}
