import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask, ProviderAccount } from "@opc/shared";
import { validateAgentWorkingDirectory } from "@opc/shared";
import {
  resolveCanonicalWorkerDirectory,
  runWorkersParallel,
  type WorkerSpec,
  type ParallelDeps,
} from "./parallelExecutor.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import { Semaphore } from "./pool/semaphore.js";
import { initProviderHealth } from "./providerHealth.js";
import { ensureGitRepo } from "./workspace.js";
import { diffFileChanges } from "./fileChanges.js";
import type { GateBaseline } from "./qualityGate.js";

// MUP Gate A#4 · agent.workingDirectory 真接线验收:
//   ① 两个不同 workingDirectory 的 worker 同 run —— 各自 ctx.workdir(= runShell/工具 cwd 的来源)
//     互不相同且都是 worktree 内的子目录(不存在则 mkdir);产物落点(fileChanges 路径)带子目录前缀、
//     口径仍相对 worktree 根,merge-back 后落进 workRoot 对应子目录。
//   ② 五.3(收口作战令语义变更):非法值(.. 逃逸/绝对路径)→ 该 worker【干净失败】(deferred
//     invalid_working_directory + emit error 事件),【绝不静默退回工作根执行】(此前的退回根行为已按新令推翻)。
//   ③ verifier 不生效:必须以 worktree 根为视野验证合同(testedFile/合同路径口径)。

const acct: ProviderAccount = { id: "deepseek#0", providerId: "deepseek", label: "a", apiKey: "sk-x", enabled: true, maxConcurrent: 4 };

function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "worker-1", name: "Worker", role: "dev", childrenIds: [],
    model: "deepseek-chat", provider: "deepseek",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

let projectRoot: string;
const events: Array<{ type: string; agentId?: string; payload: any }> = [];

function deps(execFn: ParallelDeps["execFn"], over: Partial<ParallelDeps> = {}): ParallelDeps {
  const baseline: GateBaseline = { typeErrors: 0, testsRan: false, testsPassed: true };
  const pool = new AccountPool([acct]);
  return {
    projectRoot,
    scheduler: new DefaultScheduler(pool, { acquireTimeoutMs: 5000 }),
    semaphore: new Semaphore(4),
    baseline,
    maxAttempts: 1,
    taskTimeoutMs: 60_000,
    taskTimeoutExplicit: true,
    maxTokensPerTask: 4096,
    runId: "run-wd-test",
    accountUsage: {},
    emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); },
    execFn,
    ...over,
  };
}

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-wd-"));
  expect(ensureGitRepo(projectRoot)).toBe(true); // worktree 需要 git 根 + 首 commit
  initProviderHealth(projectRoot);
  events.length = 0;
});

afterEach(() => {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* Windows 句柄残留,忽略 */ }
});

describe("workingDirectory 接线 — 集成(真实 git worktree)", () => {
  it("两个不同 workingDirectory 的 worker 同 run:cwd 互异、产物带子目录前缀、merge 落进对应子目录", async () => {
    const seenWorkdirs = new Map<string, string>();
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenWorkdirs.set(a.id, ctx.workdir);
      // 引擎视角:产物直接落在自己的 ctx.workdir(= worktree/<workingDirectory>,已由执行器 mkdir)
      fs.writeFileSync(path.join(ctx.workdir, "out.txt"), `hello from ${a.id}`, "utf-8");
      return { content: "done", fileChanges: diffFileChanges(ctx.workdir), tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "a-alpha", workingDirectory: "svc/alpha" }), systemPrompt: "s", userMessage: "u", taskId: "t-alpha" },
      { agent: agent({ id: "a-beta", workingDirectory: "svc/beta" }), systemPrompt: "s", userMessage: "u", taskId: "t-beta" },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);

    // cwd:各自 worktree 内的子目录,互不相同
    const wdAlpha = seenWorkdirs.get("a-alpha")!;
    const wdBeta = seenWorkdirs.get("a-beta")!;
    expect(wdAlpha).not.toBe(wdBeta);
    expect(wdAlpha.endsWith(path.join("svc", "alpha"))).toBe(true);
    expect(wdBeta.endsWith(path.join("svc", "beta"))).toBe(true);
    expect(wdAlpha).toContain(path.join(".opc", "wt"));

    // fileChanges 口径:相对 worktree 根(带子目录前缀),不是相对子目录的裸 out.txt
    const changesByTask = new Map(results.map((r) => [r.taskId, (r.fileChanges ?? []).map((f) => f.path.replace(/\\/g, "/"))]));
    expect(changesByTask.get("t-alpha")).toEqual(["svc/alpha/out.txt"]);
    expect(changesByTask.get("t-beta")).toEqual(["svc/beta/out.txt"]);

    // merge-back:产物落点在 workRoot 的对应子目录
    expect(fs.readFileSync(path.join(projectRoot, "svc", "alpha", "out.txt"), "utf-8")).toBe("hello from a-alpha");
    expect(fs.readFileSync(path.join(projectRoot, "svc", "beta", "out.txt"), "utf-8")).toBe("hello from a-beta");
  });

  it("五.3:非法 workingDirectory(.. 逃逸)→ worker 干净失败(deferred invalid_working_directory)+ emit error,绝不退回工作根执行", async () => {
    let ran = false;
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      ran = true; // execFn 不应被调用:非法 workdir 在执行前就干净失败
      fs.writeFileSync(path.join(ctx.workdir, "root.txt"), "at root", "utf-8");
      return { content: "done", fileChanges: diffFileChanges(ctx.workdir), tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const spec: WorkerSpec = { agent: agent({ id: "a-bad", workingDirectory: "../escape" }), systemPrompt: "s", userMessage: "u", taskId: "t-bad" };
    const results = await runWorkersParallel([spec], deps(execFn));

    expect(ran).toBe(false); // 绝不静默在工作根执行
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("invalid_working_directory");

    const err = events.find((e) => e.type === "error" && (e.payload as any)?.kind === "invalid_working_directory");
    expect(err).toBeDefined();
    expect((err!.payload as any).workingDirectory).toBe("../escape");

    // 工作根/worktree 里没有任何产物落盘(未回退根执行)
    expect(fs.existsSync(path.join(projectRoot, "root.txt"))).toBe(false);
  });

  it("五.3:绝对路径/盘符 workingDirectory 同样干净失败(不回退根)", async () => {
    let ran = false;
    const execFn = async (): Promise<ExecResult> => {
      ran = true;
      return { content: "done", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const spec: WorkerSpec = { agent: agent({ id: "a-abs", workingDirectory: "C:\\abs\\evil" }), systemPrompt: "s", userMessage: "u", taskId: "t-abs" };
    const results = await runWorkersParallel([spec], deps(execFn));
    expect(ran).toBe(false);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("invalid_working_directory");
  });

  it("rejects a canonical escape before invoking the worker", async () => {
    const nonGitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-wd-nongit-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pe-wd-outside-"));
    let ran = false;
    try {
      fs.symlinkSync(
        outside,
        path.join(nonGitRoot, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const execFn = async (): Promise<ExecResult> => {
        ran = true;
        return { content: "done", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
      };
      const spec: WorkerSpec = {
        agent: agent({ id: "a-link", workingDirectory: "linked" }),
        systemPrompt: "s",
        userMessage: "u",
        taskId: "t-link",
      };
      const results = await runWorkersParallel([spec], deps(execFn, { projectRoot: nonGitRoot }));
      expect(ran).toBe(false);
      expect(results[0].ok).toBe(false);
      expect(results[0].deferred?.reason).toBe("invalid_working_directory");
    } finally {
      fs.rmSync(nonGitRoot, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("verifier 不应用 workingDirectory:以 worktree 根为视野(合同/testedFile 口径不漂移)", async () => {
    const seenByRole = new Map<string, string>();
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenByRole.set(a.id, ctx.workdir);
      if (a.id === "a-dev") fs.writeFileSync(path.join(ctx.workdir, "impl.txt"), "impl", "utf-8");
      return { content: "done", fileChanges: a.id === "a-dev" ? diffFileChanges(ctx.workdir) : [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "a-dev", workingDirectory: "svc/alpha" }), systemPrompt: "s", userMessage: "u", taskId: "t-dev" },
      { agent: agent({ id: "a-check", role: "tester", workingDirectory: "svc/alpha" }), systemPrompt: "s", userMessage: "u", taskId: "t-check", isVerifier: true },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // producer 进子目录,verifier 钉在 worktree 根
    expect(seenByRole.get("a-dev")!.endsWith(path.join("svc", "alpha"))).toBe(true);
    expect(seenByRole.get("a-check")!.endsWith(path.join("svc", "alpha"))).toBe(false);
    expect(seenByRole.get("a-check")).toContain(path.join(".opc", "wt"));
  });
});

describe("worker workingDirectory canonical path guard", () => {
  it("creates and returns an ordinary internal directory", () => {
    const resolved = resolveCanonicalWorkerDirectory(projectRoot, "services/api");
    expect(resolved).toBe(fs.realpathSync(path.join(projectRoot, "services", "api")));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it("rejects a path that resolves to a file", () => {
    fs.mkdirSync(path.join(projectRoot, "services"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "services", "api"), "not a directory", "utf-8");
    expect(() => resolveCanonicalWorkerDirectory(projectRoot, "services/api")).toThrow(/not a directory/i);
  });

  it("rejects an external Unix symlink", () => {
    if (process.platform === "win32") return;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pe-wd-outside-"));
    try {
      fs.symlinkSync(outside, path.join(projectRoot, "linked"), "dir");
      expect(() => resolveCanonicalWorkerDirectory(projectRoot, "linked")).toThrow(/outside project root/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a dangling Unix symlink", () => {
    if (process.platform === "win32") return;
    fs.symlinkSync(path.join(projectRoot, "missing-target"), path.join(projectRoot, "broken"), "dir");
    expect(() => resolveCanonicalWorkerDirectory(projectRoot, "broken")).toThrow(/does not exist/i);
  });

  it("rejects an external Windows junction", () => {
    if (process.platform !== "win32") return;
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "pe-wd-junction-"));
    try {
      fs.symlinkSync(outside, path.join(projectRoot, "junction"), "junction");
      expect(() => resolveCanonicalWorkerDirectory(projectRoot, "junction")).toThrow(/outside project root/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("rejects a dangling Windows junction", () => {
    if (process.platform !== "win32") return;
    fs.symlinkSync(
      path.join(projectRoot, "missing-junction-target"),
      path.join(projectRoot, "broken-junction"),
      "junction",
    );
    expect(() => resolveCanonicalWorkerDirectory(projectRoot, "broken-junction")).toThrow(/does not exist/i);
  });
});

describe("validateAgentWorkingDirectory — 口径单测(shared)", () => {
  it("合法相对路径:normalize 消 ./ 与反斜杠,返回 POSIX", () => {
    expect(validateAgentWorkingDirectory("svc/alpha")).toEqual({ ok: true, normalized: "svc/alpha" });
    expect(validateAgentWorkingDirectory("./svc//alpha/")).toEqual({ ok: true, normalized: "svc/alpha" });
    expect(validateAgentWorkingDirectory("svc\\alpha\\deep")).toEqual({ ok: true, normalized: "svc/alpha/deep" });
    expect(validateAgentWorkingDirectory("a/b/../c")).toEqual({ ok: true, normalized: "a/c" });
  });

  it("拒绝:绝对路径/盘符/UNC、.. 逃逸、空值、等价于根", () => {
    expect(validateAgentWorkingDirectory("/abs/path")).toMatchObject({ ok: false, code: "absolute" });
    expect(validateAgentWorkingDirectory("C:\\abs")).toMatchObject({ ok: false, code: "absolute" });
    expect(validateAgentWorkingDirectory("\\\\server\\share")).toMatchObject({ ok: false, code: "absolute" });
    expect(validateAgentWorkingDirectory("../up")).toMatchObject({ ok: false, code: "escape" });
    expect(validateAgentWorkingDirectory("a/../../up")).toMatchObject({ ok: false, code: "escape" });
    expect(validateAgentWorkingDirectory("")).toMatchObject({ ok: false, code: "empty" });
    expect(validateAgentWorkingDirectory("  ")).toMatchObject({ ok: false, code: "empty" });
    expect(validateAgentWorkingDirectory(".")).toMatchObject({ ok: false, code: "root" });
    expect(validateAgentWorkingDirectory("a/..")).toMatchObject({ ok: false, code: "root" });
  });
});
