import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask, ProviderAccount } from "@opc/shared";
import { runWorkersParallel, NonGitMultiWriterError, type WorkerSpec, type ParallelDeps } from "./parallelExecutor.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import { Semaphore } from "./pool/semaphore.js";
import { initProviderHealth } from "./providerHealth.js";
import { isGitRepo } from "./worktree.js";
import { diffFileChanges } from "./fileChanges.js";
import type { GateBaseline } from "./qualityGate.js";

// 五.1(收口作战令)· 非 Git 多写者阻断 活体验收(真实临时目录,禁 mock):
//   ① 工作根非 git + 该批 >1 个写(编码)worker → runWorkersParallel 整体抛 NonGitMultiWriterError
//      (与 CapabilityBlockedError 同型的干净失败,由 orchestrator 转成 run 失败 + governance 留痕);
//   ② 单写编码 worker 允许:走 isolation:"none" 直写工作根,并 emit non_git_isolation_none 如实标注;
//   ③ verifier/研究(noCode)worker 不计入写者数(verifier 只跑测试、研究走 scratch,不直写工作根)。

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
    runId: "run-nongit-test",
    accountUsage: {},
    emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); },
    execFn,
    ...over,
  };
}

beforeEach(() => {
  // 刻意不建 git 仓库(不调 ensureGitRepo)——这就是"非 git 工作根"的被测前提。
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-nongit-"));
  initProviderHealth(projectRoot);
  events.length = 0;
});

afterEach(() => {
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* Windows 句柄残留,忽略 */ }
});

describe("非 Git 多写者阻断", () => {
  it("前提自检:临时工作根确实不是 git 仓库", () => {
    expect(isGitRepo(projectRoot)).toBe(false);
  });

  it("非 git + 2 个编码 worker → 整批抛 NonGitMultiWriterError(execFn 一次都不跑)", async () => {
    let ran = 0;
    const execFn = async (): Promise<ExecResult> => {
      ran++;
      return { content: "x", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "dev-1" }), systemPrompt: "s", userMessage: "写代码实现 sum 函数并落盘", taskId: "t1" },
      { agent: agent({ id: "dev-2" }), systemPrompt: "s", userMessage: "写代码实现 mul 函数并落盘", taskId: "t2" },
    ];
    await expect(runWorkersParallel(specs, deps(execFn))).rejects.toBeInstanceOf(NonGitMultiWriterError);
    await runWorkersParallel(specs, deps(execFn)).catch((e: NonGitMultiWriterError) => {
      expect(e.code).toBe("non_git_multi_writer");
      expect(e.writerCount).toBe(2);
      expect(e.message).toContain("初始化为 OPC 管理的 Git 工作区");
    });
    expect(ran).toBe(0); // 干净失败:一分钱不花
  });

  it("非 git + 1 个编码 worker → 允许运行,isolation:none 直写工作根 + emit non_git_isolation_none", async () => {
    let seenWorkdir = "";
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenWorkdir = ctx.workdir;
      fs.writeFileSync(path.join(ctx.workdir, "sum.js"), "module.exports=(a,b)=>a+b;", "utf-8");
      return { content: "done", fileChanges: diffFileChanges(ctx.workdir), tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "solo-dev" }), systemPrompt: "s", userMessage: "写代码实现 sum 并落盘", taskId: "t-solo" },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    // 单写者直写工作根(非 worktree 子目录)
    expect(path.resolve(seenWorkdir)).toBe(path.resolve(projectRoot));
    const marker = events.find((e) => (e.payload as any)?.kind === "non_git_isolation_none");
    expect(marker).toBeDefined();
    expect((marker!.payload as any).workRoot).toBeTruthy();
    // 产物真的落在工作根
    expect(fs.existsSync(path.join(projectRoot, "sum.js"))).toBe(true);
  });

  it("非 git + 1 编码 + 1 verifier(不计写者)→ 不触发多写者阻断,正常执行", async () => {
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      if (a.id === "dev-x") fs.writeFileSync(path.join(ctx.workdir, "impl.js"), "1;", "utf-8");
      return { content: "done", fileChanges: a.id === "dev-x" ? diffFileChanges(ctx.workdir) : [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "dev-x" }), systemPrompt: "s", userMessage: "写代码实现并落盘", taskId: "t-dev" },
      { agent: agent({ id: "qa-x", role: "tester" }), systemPrompt: "s", userMessage: "跑测试验证", taskId: "t-qa", isVerifier: true },
    ];
    // 不抛错(1 个写者)
    const results = await runWorkersParallel(specs, deps(execFn));
    expect(results.some((r) => r.taskId === "t-dev" && r.ok)).toBe(true);
  });

  it("非 git + 2 个研究(noCode)worker → 不算多写者(走 scratch,不直写工作根),不抛错", async () => {
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      fs.writeFileSync(path.join(ctx.workdir, "report.md"), "# 研究结论\n内容", "utf-8");
      return { content: "研究完成", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "r-1", role: "researcher" }), systemPrompt: "s", userMessage: "研究 A", taskId: "t-r1", noCode: true },
      { agent: agent({ id: "r-2", role: "researcher" }), systemPrompt: "s", userMessage: "研究 B", taskId: "t-r2", noCode: true },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
