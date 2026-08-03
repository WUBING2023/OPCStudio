// MUP Gate A#3 / D3 · runBatch 串行 merge-back 新契约(泳道3 WorktreeMergeResult 的调用侧适配):
// ① conflict 的 worker 绝不 ok:true 收录 → requiresReview + conflictFiles,分支/worktree 保留待人工决裁;
// ② emit 结构化 merge_conflict_requires_review 事件(不再有 -X theirs / merge_theirs);
// ③ protectPaths = priorContractFiles(本 run 此前已接受的变更路径)→ 脏的 run 产出被精确保护提交,
//    用户游离文件绝不 add -A。
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";

interface Emitted { t: string; a?: string; p: any }

function initGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-mergeback-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "mup@test");
  git("config", "user.name", "mup");
  fs.writeFileSync(path.join(root, "seed.md"), "seed");
  fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");
  return root;
}

const gitOut = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf-8", stdio: "pipe" }).toString();

function makeDeps(root: string, events: Emitted[], over: Partial<ParallelDeps> = {}): ParallelDeps {
  return {
    projectRoot: root,
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
    semaphore: new Semaphore(4),
    baseline: {} as any,
    maxAttempts: 1,
    taskTimeoutMs: 60_000,
    maxTokensPerTask: 1000,
    runId: "mergeback-run",
    accountUsage: {},
    emit: (t, a, p) => events.push({ t, a, p: p as any }),
    execFn: undefined as any,
    ...over,
  };
}

const spec = (id: string): WorkerSpec => ({
  agent: { id, role: "dev", provider: "deepseek", model: "m", framework: "api", name: id } as unknown as AgentNodeConfig,
  systemPrompt: "sys",
  userMessage: "task",
  taskId: `t-${id}`,
  noCode: false,
});

const okResult = (content: string, fileChanges: ExecResult["fileChanges"]): ExecResult =>
  ({ content, fileChanges, tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "done" });

describe("MUP Gate A#3 · merge 冲突 → requiresReview(绝不 ok:true / 绝不 -X theirs)", () => {
  it("两个 worker 撞同一新建文件:先到者 merged,后到者 requiresReview+conflictFiles,分支与 worktree 保留", async () => {
    const root = initGitRepo();
    try {
      const events: Emitted[] = [];
      const write = (ctx: ExecContext, body: string) => fs.writeFileSync(path.join(ctx.workdir, "shared.md"), body);
      const deps = makeDeps(root, events);
      const specA = spec("wa");
      const specB = spec("wb");
      const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
        if (a.id === "wa") { write(ctx, "VERSION_A"); return okResult("A 的文本产出", [{ path: "shared.md", changeType: "create" }]); }
        await new Promise((r) => setTimeout(r, 80)); // 保证 wa 先 accepted → 先 merge
        write(ctx, "VERSION_B");
        return okResult("B 的文本产出", [{ path: "shared.md", changeType: "create" }]);
      };
      const results = await runWorkersParallel([specA, specB], { ...deps, execFn });

      const winner = results.find((r) => r.agentId === "wa")!;
      const loser = results.find((r) => r.agentId === "wb")!;
      expect(winner.ok).toBe(true);
      expect(winner.fileChanges?.map((f) => f.path)).toEqual(["shared.md"]);
      // 冲突方:绝不 ok:true 收录;文本产出保留为部分结果;冲突清单随身
      expect(loser.ok).toBe(false);
      expect(loser.requiresReview).toBe(true);
      expect(loser.conflictFiles).toContain("shared.md");
      expect(loser.deferred).toBeUndefined(); // 不是失败 defer,是待人工决裁
      expect(loser.content).toContain("B 的文本产出");
      expect(loser.fileChanges).toEqual([]);
      // workRoot 落地的是先到者版本,绝无 -X theirs 覆盖
      expect(fs.readFileSync(path.join(root, "shared.md"), "utf-8")).toBe("VERSION_A");
      // 冲突分支与 worktree 保留供人工决裁(不 removeWorktree)
      expect(fs.existsSync(path.join(root, ".opc", "wt", "mergebac-t-wb"))).toBe(true);
      expect(gitOut(root, "branch", "--list", "opc-wt-mergebac-t-wb").trim()).not.toBe("");
      // 结构化事件(不再是 merge_theirs)
      const ev = events.find((e) => e.p?.kind === "merge_conflict_requires_review");
      expect(ev).toBeTruthy();
      expect(ev!.p.taskId).toBe("t-wb");
      expect(ev!.p.conflictFiles).toContain("shared.md");
      expect(events.some((e) => e.p?.kind === "merge_theirs")).toBe(false);
    } finally {
      try { execFileSync("git", ["worktree", "prune"], { cwd: root, stdio: "pipe" }); } catch { /* best-effort */ }
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });

  it("D3 · protectPaths=priorContractFiles:脏的本 run 已接受产出被精确保护提交;用户游离文件绝不入库", async () => {
    const root = initGitRepo();
    try {
      // 上一轮 run 产出(如 lead 直写的报告)尚未提交 → 本轮 merge 前应被精确 stage 保护
      fs.writeFileSync(path.join(root, "prior-output.md"), "prior run deliverable");
      // 用户自己的游离文件:不在合同内,绝不被打包提交
      fs.writeFileSync(path.join(root, "user-scratch.txt"), "user private note");

      const events: Emitted[] = [];
      const deps = makeDeps(root, events, { priorContractFiles: ["prior-output.md"] });
      const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
        fs.writeFileSync(path.join(ctx.workdir, "new-work.md"), "fresh output");
        return okResult("done", [{ path: "new-work.md", changeType: "create" }]);
      };
      const results = await runWorkersParallel([spec("wp")], { ...deps, execFn });

      expect(results[0].ok).toBe(true);
      expect(fs.existsSync(path.join(root, "new-work.md"))).toBe(true);
      const status = gitOut(root, "status", "--porcelain");
      expect(status).not.toMatch(/prior-output\.md/);          // 已被保护提交(不再脏)
      expect(status).toMatch(/user-scratch\.txt/);             // 用户文件保持未跟踪,绝不被 add -A 卷入
      expect(gitOut(root, "log", "--oneline")).toMatch(/OPC: protect run outputs before merge/);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
