import type { Express } from "express";
import {
  listConflicts, getConflict, resolveConflict, type ConflictResolution,
} from "../storage/conflictStore.js";
import { readWorktreeConflictDiff, adoptWorktreeBranch, removeWorktreeByBranch } from "../runtime/worktree.js";
import { reverifyAfterConflictResolve } from "../runtime/runLifecycle.js";

// 波6 · 合并冲突人类决裁 API。
// GET  /api/conflicts?status=&runId=      → 冲突记录列表(pending 先于 resolved)
// GET  /api/conflicts/:id                 → 单条记录
// GET  /api/conflicts/:id/diff?file=      → 真实 git diff(某文件或全部冲突文件);branch HEAD -- file
// POST /api/conflicts/:id/resolve         → 决裁:take_branch(采纳分支)/discard(放弃)/mark_manual(人工已处理)
//                                            决裁成功才 removeWorktree,并触发重新验收(绝不自动 verified)
const VALID_RESOLUTIONS: ConflictResolution[] = ["take_branch", "discard", "mark_manual"];

export function register(app: Express, projectRoot: string) {
  app.get("/api/conflicts", (req, res) => {
    const status = req.query.status === "pending" || req.query.status === "resolved" ? req.query.status : undefined;
    const runId = typeof req.query.runId === "string" && req.query.runId ? req.query.runId : undefined;
    res.json({ conflicts: listConflicts(projectRoot, { status, runId }) });
  });

  app.get("/api/conflicts/:id", (req, res) => {
    const rec = getConflict(projectRoot, req.params.id);
    if (!rec) return res.status(404).json({ error: "conflict not found" });
    res.json(rec);
  });

  app.get("/api/conflicts/:id/diff", (req, res) => {
    const rec = getConflict(projectRoot, req.params.id);
    if (!rec) return res.status(404).json({ error: "conflict not found" });
    const file = typeof req.query.file === "string" && req.query.file ? req.query.file : undefined;
    if (file) {
      if (!rec.conflictFiles.includes(file)) return res.status(400).json({ error: `file 不在冲突清单内: ${file}` });
      return res.json({ id: rec.id, branch: rec.branch, diffs: [{ file, diff: readWorktreeConflictDiff(projectRoot, rec.branch, file) }] });
    }
    const diffs = rec.conflictFiles.map((f) => ({ file: f, diff: readWorktreeConflictDiff(projectRoot, rec.branch, f) }));
    res.json({ id: rec.id, branch: rec.branch, diffs });
  });

  app.post("/api/conflicts/:id/resolve", (req, res) => {
    const rec = getConflict(projectRoot, req.params.id);
    if (!rec) return res.status(404).json({ error: "conflict not found" });
    if (rec.status === "resolved") return res.status(409).json({ error: "冲突已决裁,不能重复处理", record: rec });

    const body = (req.body ?? {}) as { resolution?: string; resolvedBy?: string };
    const resolution = body.resolution as ConflictResolution | undefined;
    if (!resolution || !VALID_RESOLUTIONS.includes(resolution)) {
      return res.status(400).json({ error: `resolution 必须是 ${VALID_RESOLUTIONS.join(" | ")}` });
    }
    const resolvedBy = typeof body.resolvedBy === "string" ? body.resolvedBy : undefined;

    // take_branch = 采纳 worker 分支(人工决裁的显式动作,允许 -X theirs);失败则不落 resolved,返回 500。
    if (resolution === "take_branch") {
      const adopt = adoptWorktreeBranch(projectRoot, rec.branch);
      if (!adopt.ok) {
        return res.status(500).json({ error: `采纳分支失败(未改动 HEAD,冲突仍 pending): ${adopt.error ?? "unknown"}`, record: rec });
      }
    }
    // discard / mark_manual:不改 HEAD(放弃分支;或人工已在工作副本手动合并),仅落决裁记录。

    const { record: resolved } = resolveConflict(projectRoot, rec.id, { resolution, resolvedBy });
    // 决裁成功才允许清理 worktree/分支(契约:resolve 成功才 removeWorktree)。
    removeWorktreeByBranch(projectRoot, rec.branch, rec.dir);
    // 触发该 run 的重新验收状态机(全部冲突决裁完 → 迁出 requires_review;绝不自动 verified)。
    const reverify = reverifyAfterConflictResolve(projectRoot, rec.runId);

    res.json({ resolved: true, record: resolved, reverify });
  });
}
