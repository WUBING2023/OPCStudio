import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask, ProviderAccount } from "@opc/shared";
import { responseTokenLimitForWorker, runWorkersParallel, type WorkerSpec, type ParallelDeps } from "./parallelExecutor.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import { Semaphore } from "./pool/semaphore.js";
import { initProviderHealth } from "./providerHealth.js";
import type { GateBaseline } from "./qualityGate.js";

// 多账号自动切换(hermes/API 框架)——端到端验收:两个 deepseek 账号,一个连续失败 3 次进入冷却后,
// 真实执行链路(runWorkersParallel → scheduler.acquire → ExecContext.leasedAccount)自动改用另一个
// 账号自己的 apiKey,而不仅仅是"账面上租到了另一个账号 id"。覆盖此前的空缺:accountPool 选中的账号
// 从未被下游读取,加第二个账号对真实执行毫无影响的半成品状态。

function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
    model: "deepseek-chat", provider: "deepseek",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

function baseDeps(over: Partial<ParallelDeps> & Pick<ParallelDeps, "scheduler" | "execFn">): ParallelDeps {
  const baseline: GateBaseline = { typeErrors: 0, testsRan: false, testsPassed: true };
  return {
    projectRoot: os.tmpdir(),
    semaphore: new Semaphore(4),
    baseline,
    maxAttempts: 3,
    taskTimeoutMs: 60_000,
    maxTokensPerTask: 4096,
    runId: "run-test",
    accountUsage: {},
    emit: () => {},
    ...over,
  };
}

let tmpProjectRoot: string;
beforeEach(() => {
  tmpProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-health-"));
  initProviderHealth(tmpProjectRoot); // 重定向持久化,不污染仓库的 .opc/provider_health.json,也不跨测试互相污染
});

describe("responseTokenLimitForWorker", () => {
  it("gives code producers 8k, text workers 4k, and always respects the task cap", () => {
    expect(responseTokenLimitForWorker(false, 100_000)).toBe(8192);
    expect(responseTokenLimitForWorker(true, 100_000)).toBe(4096);
    expect(responseTokenLimitForWorker(false, 3000)).toBe(3000);
    expect(responseTokenLimitForWorker(false, 0)).toBe(8192);
  });
});

describe("runWorkersParallel — 多账号自动切换(hermes/API 框架)真实执行链路", () => {
  const acctBad: ProviderAccount = { id: "deepseek#bad", providerId: "deepseek", label: "bad", apiKey: "sk-bad-key", enabled: true, maxConcurrent: 3 };
  const acctGood: ProviderAccount = { id: "deepseek#good", providerId: "deepseek", label: "good", apiKey: "sk-good-key", enabled: true, maxConcurrent: 3 };

  it("租到的具体账号的 apiKey 真正透传进 ExecContext.leasedAccount(不再是从未被读取的账面租约)", async () => {
    const seenKeys: Array<{ providerId: string; apiKey: string } | undefined> = [];
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenKeys.push(ctx.leasedAccount);
      return { content: "ok", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const pool = new AccountPool([acctGood]);
    const scheduler = new DefaultScheduler(pool, { acquireTimeoutMs: 5000 });
    const spec: WorkerSpec = { agent: agent(), systemPrompt: "sys", userMessage: "do it", taskId: "t1", noCode: true };
    const results = await runWorkersParallel([spec], baseDeps({ scheduler, execFn }));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toEqual({ providerId: "deepseek", apiKey: "sk-good-key" });
  });

  it("claude-code/codex 框架不设置 leasedAccount(已有专属的 apiKeyOverride 路径,避免打架)", async () => {
    const seen: Array<{ providerId: string; apiKey: string } | undefined> = [];
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seen.push(ctx.leasedAccount);
      return { content: "ok", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const cliAcct: ProviderAccount = { id: "codex#0", providerId: "openai", label: "codex", apiKey: "sk-codex-key", frameworks: ["codex"], enabled: true, maxConcurrent: 3 };
    const pool = new AccountPool([cliAcct]);
    const scheduler = new DefaultScheduler(pool, { acquireTimeoutMs: 5000 });
    const spec: WorkerSpec = { agent: agent({ provider: "openai", framework: "codex" }), systemPrompt: "sys", userMessage: "do it", taskId: "t1", noCode: true };
    await runWorkersParallel([spec], baseDeps({ scheduler, execFn }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBeUndefined();
  });

  it("team mode override uses the effective framework/provider for account leasing", async () => {
    const seen: Array<{ providerId: string; apiKey: string } | undefined> = [];
    const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seen.push(ctx.leasedAccount);
      return { content: "ok", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const pool = new AccountPool([acctGood]);
    const scheduler = new DefaultScheduler(pool, { acquireTimeoutMs: 5000 });
    const original = agent({ provider: "anthropic", framework: "claude-code", model: "sonnet" });
    const effective = agent({ ...original, provider: "deepseek", framework: "hermes", model: "deepseek-v4-pro" });
    const spec: WorkerSpec = {
      agent: original,
      leaseAgent: effective,
      systemPrompt: "sys",
      userMessage: "do it",
      taskId: "t-team-mode",
      noCode: true,
    };

    await runWorkersParallel([spec], baseDeps({ scheduler, execFn }));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ providerId: "deepseek", apiKey: "sk-good-key" });
  });
  it("端到端验收:账号连续失败 3 次进入冷却后,下一次真实执行自动改用另一个账号的 apiKey", async () => {
    // Phase 1: 池里只有坏账号——execFn 恒失败,3 次尝试用满 maxAttempts,逐次记进账号级熔断。
    const execFnAlwaysFail = async (_a: AgentNodeConfig, _t: ExecTask, _ctx: ExecContext): Promise<ExecResult> =>
      ({ content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "failed", error: "401 unauthorized" });
    const poolPhase1 = new AccountPool([acctBad]);
    const schedulerPhase1 = new DefaultScheduler(poolPhase1, { acquireTimeoutMs: 5000 });
    const specPhase1: WorkerSpec = { agent: agent(), systemPrompt: "sys", userMessage: "do it", taskId: "t-phase1", noCode: true };
    const resultsPhase1 = await runWorkersParallel([specPhase1], baseDeps({ scheduler: schedulerPhase1, execFn: execFnAlwaysFail, maxAttempts: 3 }));
    expect(resultsPhase1[0].ok).toBe(false); // 单账号、耗尽重试预算,诚实 defer(此阶段没有第二个账号可切)

    // Phase 2:现在两个账号都在池子里——坏账号仍处于上一阶段留下的跨 run 熔断态(providerHealth 模块级
    // Map,initProviderHealth 只重定向持久化路径,不清空内存态),好账号从未失败过。真实执行应自动跳过
    // 坏账号,只用好账号的 key,且这次真的成功。
    const seenKeys: Array<{ providerId: string; apiKey: string } | undefined> = [];
    const execFnRecording = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenKeys.push(ctx.leasedAccount);
      return { content: "ok", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const poolPhase2 = new AccountPool([acctBad, acctGood]);
    const schedulerPhase2 = new DefaultScheduler(poolPhase2, { acquireTimeoutMs: 5000 });
    const specPhase2: WorkerSpec = { agent: agent(), systemPrompt: "sys", userMessage: "do it", taskId: "t-phase2", noCode: true };
    const resultsPhase2 = await runWorkersParallel([specPhase2], baseDeps({ scheduler: schedulerPhase2, execFn: execFnRecording }));

    expect(resultsPhase2[0].ok).toBe(true); // 这次成功了——证明真的切到了另一个账号
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toEqual({ providerId: "deepseek", apiKey: "sk-good-key" }); // 且用的是好账号自己的 key,不是坏账号那把
  });
});

describe("runWorkersParallel — A7 defer 归因:workspace 磁盘配额超限如实标注", () => {
  it("引擎 failed 且 error 含 'workspace quota exceeded' → deferred.reason=workspace_quota_exceeded(不混进 retry_budget_exhausted)", async () => {
    const acctQuota: ProviderAccount = { id: "deepseek#quota", providerId: "deepseek", label: "q", apiKey: "sk-q", enabled: true, maxConcurrent: 3 };
    const execFn = async (): Promise<ExecResult> => ({
      content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1,
      status: "failed", error: "workspace quota exceeded: 工作区超过磁盘配额 1048576 字节",
    });
    const pool = new AccountPool([acctQuota]);
    const scheduler = new DefaultScheduler(pool, { acquireTimeoutMs: 5000 });
    const spec: WorkerSpec = { agent: agent(), systemPrompt: "sys", userMessage: "do it", taskId: "t-quota", noCode: true };
    const results = await runWorkersParallel([spec], baseDeps({ scheduler, execFn, maxAttempts: 1 }));

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("workspace_quota_exceeded");
    expect(results[0].deferred?.lastError).toMatch(/quota exceeded/i);
  });
});

describe("runWorkersParallel - cumulative worker token allowance", () => {
  it("carries only the remaining per-agent allowance into retries", async () => {
    const account: ProviderAccount = {
      id: "deepseek#budget",
      providerId: "deepseek",
      label: "budget",
      apiKey: "sk-budget",
      enabled: true,
      maxConcurrent: 1,
    };
    const scheduler = new DefaultScheduler(new AccountPool([account]), { acquireTimeoutMs: 5000 });
    const seenTaskCaps: number[] = [];
    const seenContextCaps: number[] = [];
    let attempt = 0;
    const execFn = async (_agent: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      seenTaskCaps.push(task.maxTokens);
      seenContextCaps.push(ctx.budget.maxTokensPerTask);
      attempt += 1;
      if (attempt === 1) {
        return {
          content: "",
          fileChanges: [],
          tokens: { prompt: 400, completion: 200, total: 600 },
          cost: 0,
          latencyMs: 1,
          status: "failed",
          error: "transient provider failure",
        };
      }
      return {
        content: "done",
        fileChanges: [],
        tokens: { prompt: 250, completion: 150, total: 400 },
        cost: 0,
        latencyMs: 1,
        status: "done",
      };
    };
    const worker = agent({ id: "worker-budget" });
    const results = await runWorkersParallel(
      [{ agent: worker, systemPrompt: "sys", userMessage: "task", taskId: "budget-task", noCode: true }],
      baseDeps({
        scheduler,
        execFn,
        maxAttempts: 2,
        maxTokensPerTask: 5000,
        maxTokensPerAgent: { "worker-budget": 1000 },
      }),
    );

    expect(seenTaskCaps).toEqual([1000, 400]);
    expect(seenContextCaps).toEqual([1000, 400]);
    expect(results[0].ok).toBe(true);
    expect(results[0].tokensUsed).toBe(1000);
  });

  it("does not launch a worker whose cumulative allowance is exhausted", async () => {
    const account: ProviderAccount = {
      id: "deepseek#empty-budget",
      providerId: "deepseek",
      label: "empty",
      apiKey: "sk-empty",
      enabled: true,
      maxConcurrent: 1,
    };
    const scheduler = new DefaultScheduler(new AccountPool([account]), { acquireTimeoutMs: 5000 });
    let calls = 0;
    const worker = agent({ id: "worker-empty-budget" });
    const results = await runWorkersParallel(
      [{ agent: worker, systemPrompt: "sys", userMessage: "task", taskId: "empty-budget-task", noCode: true }],
      baseDeps({
        scheduler,
        execFn: async () => {
          calls += 1;
          throw new Error("must not execute");
        },
        maxTokensPerAgent: { "worker-empty-budget": 0 },
      }),
    );

    expect(calls).toBe(0);
    expect(results[0].deferred?.reason).toBe("run_budget_exhausted");
  });
  it.each([
    ["token budget exhausted before the next model call", "run_budget_exhausted"],
    ["tool loop made no progress after 3 identical results", "no_progress"],
  ] as const)("treats deterministic efficiency stops as terminal without retries: %s", async (error, reason) => {
    const account: ProviderAccount = {
      id: "deepseek#efficiency-stop",
      providerId: "deepseek",
      label: "efficiency-stop",
      apiKey: "sk-efficiency-stop",
      enabled: true,
      maxConcurrent: 1,
    };
    const scheduler = new DefaultScheduler(new AccountPool([account]), { acquireTimeoutMs: 5000 });
    let calls = 0;
    const results = await runWorkersParallel(
      [{ agent: agent({ id: "worker-efficiency-stop" }), systemPrompt: "sys", userMessage: "task", taskId: "efficiency-stop", noCode: true }],
      baseDeps({
        scheduler,
        maxAttempts: 3,
        execFn: async () => {
          calls += 1;
          return {
            content: "",
            fileChanges: [],
            tokens: { prompt: 10, completion: 5, total: 15 },
            cost: 0,
            latencyMs: 1,
            status: "failed",
            error,
          };
        },
      }),
    );

    expect(calls).toBe(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe(reason);
  });
});