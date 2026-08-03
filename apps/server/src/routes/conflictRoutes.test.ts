import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Run } from "@opc/shared";
import { register as registerConflictRoutes } from "./conflictRoutes.js";
import { ensureGitRepo } from "../runtime/workspace.js";
import { createWorktree, commitWorktree, mergeWorktree, PendingConflictWorktreeError } from "../runtime/worktree.js";
import { recordConflict, listConflicts, hasPendingConflictForDir, conflictIdForBranch, resolveConflict } from "../storage/conflictStore.js";
import { saveRunTask } from "../storage/projectStore.js";
import { reverifyAfterConflictResolve } from "../runtime/runLifecycle.js";

// 波6 · 合并冲突人类决裁流程 —— 真实 git 仓库端到端(禁 mock):
//   制造真 merge 冲突 → 落盘记录 → GET 列出 → GET 真实 diff → POST resolve → run 状态迁移(绝不自动 verified)
//   + worktree 决裁现场保护(pending 时同 id createWorktree 拒绝销毁)。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-conflict-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

// 造一个真实的 merge 冲突:root(HEAD)与 worker 分支从同一 base 各改同一文件同一行。
function makeConflict(name: string): { root: string; branch: string; dir: string; conflictFiles: string[] } {
  const root = path.join(tmp, name);
  ensureGitRepo(root);
  fs.writeFileSync(path.join(root, "data.txt"), "BASE\n");
  execSync("git add -A && git commit -q -m base", { cwd: root });
  const wt = createWorktree(root, `run1-${name}`);
  fs.writeFileSync(path.join(wt.dir, "data.txt"), "WORKER\n");
  commitWorktree(wt, `dev-1 ${name}`);
  // HEAD 侧改同一文件同一行 → 与 worker 分支必冲突
  fs.writeFileSync(path.join(root, "data.txt"), "HEAD\n");
  execSync("git add -A && git commit -q -m head", { cwd: root });
  const verdict = mergeWorktree(root, wt);
  expect(verdict.outcome).toBe("conflict");
  expect(verdict.conflictFiles).toContain("data.txt");
  return { root, branch: wt.branch, dir: wt.dir, conflictFiles: verdict.conflictFiles };
}

function seedRun(root: string, runId: string, run: Partial<Run>): void {
  const full: Run = {
    id: runId, userGoal: "conflict run", status: "done", startedAt: new Date().toISOString(),
    totalTokens: 0, totalCostUsd: 0, participatingAgents: [], ...run,
  };
  saveRunTask(root, full);
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerConflictRoutes(app, root);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("conflictStore + worktree 决裁现场保护(真实 git)", () => {
  it("冲突落盘 pending;同 id createWorktree 被 PendingConflictWorktreeError 拒绝(防丢现场)", () => {
    const { root, branch, dir, conflictFiles } = makeConflict("protect");
    recordConflict(root, { runId: "run1", taskId: "protect", agentId: "dev-1", branch, dir, conflictFiles });
    expect(hasPendingConflictForDir(root, dir)).toBe(true);
    const pending = listConflicts(root, { status: "pending" });
    expect(pending.map((c) => c.id)).toContain(conflictIdForBranch(branch));
    // 决裁现场仍在:分支与 worktree 目录保留
    expect(execSync(`git branch --list ${branch}`, { cwd: root }).toString()).toContain(branch);
    expect(fs.existsSync(dir)).toBe(true);
    // 关键保护:同 id(=同 dir/branch)再 createWorktree → 拒绝销毁
    expect(() => createWorktree(root, `run1-protect`)).toThrow(PendingConflictWorktreeError);
    // 分支未被 -D
    expect(execSync(`git branch --list ${branch}`, { cwd: root }).toString()).toContain(branch);
  });
});

describe("冲突决裁 API(真实 git)", () => {
  it("GET 列出 / GET 真实 diff / take_branch resolve → 采纳分支并清理 worktree", async () => {
    const { root, branch, dir, conflictFiles } = makeConflict("api");
    recordConflict(root, { runId: "runA", taskId: "api", agentId: "dev-1", branch, dir, conflictFiles });
    const id = conflictIdForBranch(branch);
    const { server, baseUrl } = await startServer(root);
    try {
      // GET 列表
      const list = await (await fetch(`${baseUrl}/api/conflicts?status=pending`)).json() as any;
      expect(list.conflicts.some((c: any) => c.id === id && c.branch === branch)).toBe(true);
      // GET 真实 diff(git diff <branch> HEAD):分支侧 WORKER 与 HEAD 侧 HEAD 都出现在真实 diff 里
      const diffRes = await (await fetch(`${baseUrl}/api/conflicts/${id}/diff`)).json() as any;
      const blob = diffRes.diffs.map((d: any) => d.diff).join("\n");
      expect(blob).toMatch(/^-WORKER/m);  // 分支侧内容
      expect(blob).toMatch(/^\+HEAD/m);   // HEAD 侧内容
      expect(blob).toContain("diff --git a/data.txt b/data.txt");
      // resolve: take_branch → 采纳分支
      const resolveRes = await fetch(`${baseUrl}/api/conflicts/${id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "take_branch", resolvedBy: "tester" }),
      });
      const rbody = await resolveRes.json() as any;
      expect(resolveRes.status).toBe(200);
      expect(rbody.resolved).toBe(true);
      expect(rbody.record.status).toBe("resolved");
      // HEAD 现在应含 WORKER 内容(采纳分支 -X theirs)
      expect(fs.readFileSync(path.join(root, "data.txt"), "utf-8")).toContain("WORKER");
      // 决裁成功才清理:worktree 目录 + 分支已删
      expect(fs.existsSync(dir)).toBe(false);
      expect(execSync(`git branch --list ${branch}`, { cwd: root }).toString().trim()).toBe("");
      // 记录转 resolved;pending 列表清空
      expect(listConflicts(root, { status: "pending" }).length).toBe(0);
      // 重复 resolve → 409
      const again = await fetch(`${baseUrl}/api/conflicts/${id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "discard" }),
      });
      expect(again.status).toBe(409);
    } finally {
      server.close();
    }
  });

  it("非法 resolution → 400;未知 id → 404", async () => {
    const { root, branch, dir, conflictFiles } = makeConflict("bad");
    recordConflict(root, { runId: "runB", taskId: "bad", branch, dir, conflictFiles });
    const id = conflictIdForBranch(branch);
    const { server, baseUrl } = await startServer(root);
    try {
      const bad = await fetch(`${baseUrl}/api/conflicts/${id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "nonsense" }),
      });
      expect(bad.status).toBe(400);
      const missing = await fetch(`${baseUrl}/api/conflicts/does-not-exist/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "discard" }),
      });
      expect(missing.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

describe("重新验收状态机:人工决裁后绝不自动 verified", () => {
  it("otherwise-verified 的冲突 run,全部决裁后 finalState 迁出 requires_review 且强制降级(非 verified)", async () => {
    const { root, branch, dir, conflictFiles } = makeConflict("reverify");
    // run 本身其余信号本可 verified(done + deliveryAcceptance.verified + 无降级/simulated)
    seedRun(root, "runV", {
      status: "done",
      finalState: "requires_review",
      deliveryAcceptance: { status: "verified", requiresCode: true, requiresTests: true, reasons: [] },
      evidenceIntegrity: "ok",
      mergeConflicts: [{ taskId: "reverify", agentId: "dev-1", files: conflictFiles }],
    });
    recordConflict(root, { runId: "runV", taskId: "reverify", agentId: "dev-1", branch, dir, conflictFiles });

    // 还有 pending → 不迁移
    const partial = reverifyAfterConflictResolve(root, "runV");
    expect(partial.changed).toBe(false);
    expect(partial.pendingRemaining).toBe(1);

    const { server, baseUrl } = await startServer(root);
    try {
      const id = conflictIdForBranch(branch);
      const res = await fetch(`${baseUrl}/api/conflicts/${id}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ resolution: "mark_manual", resolvedBy: "human" }),
      });
      const body = await res.json() as any;
      expect(res.status).toBe(200);
      // 铁律:绝不自动 verified;迁出 requires_review;触发强制降级
      expect(body.reverify.changed).toBe(true);
      expect(body.reverify.forcedDowngrade).toBe(true);
      expect(body.reverify.finalState).toBe("degraded");
      expect(body.reverify.finalState).not.toBe("verified");
      // 落盘 task.json 也同步:非 verified,requires_review 已迁出
      const task = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", "runV", "task.json"), "utf-8"));
      expect(task.finalState).toBe("degraded");
      expect(task.finalState).not.toBe("verified");
      expect(task.degraded).toBe(true);
      expect(String(task.degradedReason || "")).toContain("重新验收");
    } finally {
      server.close();
    }
  });

  it("失败态的冲突 run 决裁后回落 failed(不因决裁而虚构成功)", () => {
    const { root, branch, dir, conflictFiles } = makeConflict("failed");
    seedRun(root, "runF", {
      status: "failed",
      finalState: "requires_review",
      mergeConflicts: [{ taskId: "failed", agentId: "dev-1", files: conflictFiles }],
    });
    recordConflict(root, { runId: "runF", taskId: "failed", agentId: "dev-1", branch, dir, conflictFiles });
    // 决裁(经 store 的 resolveConflict)后再调 reverify:全部冲突已 resolved,状态机应据 run 真实信号回落。
    resolveConflict(root, conflictIdForBranch(branch), { resolution: "discard" });
    const r = reverifyAfterConflictResolve(root, "runF");
    expect(r.changed).toBe(true);
    expect(r.finalState).toBe("failed");
    expect(r.forcedDowngrade).toBeFalsy();
  });
});
