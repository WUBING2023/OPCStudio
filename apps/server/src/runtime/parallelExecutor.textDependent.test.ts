import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask, ProviderAccount } from "@opc/shared";
import { runWorkersParallel, type WorkerSpec, type ParallelDeps } from "./parallelExecutor.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import { Semaphore } from "./pool/semaphore.js";
import { initProviderHealth } from "./providerHealth.js";
import { ensureGitRepo } from "./workspace.js";
import type { GateBaseline } from "./qualityGate.js";

// #1 · 文本依赖型 worker(综合/事实核查):runWorkersParallel 把 dependsOnText 的 worker 排到 producer 批
// 之后单独一批,并把 producer 的文本产出注入其 prompt。无 dependsOnText 时行为与改造前逐字节等价。

const acct: ProviderAccount = { id: "deepseek#0", providerId: "deepseek", label: "a", apiKey: "sk-x", enabled: true, maxConcurrent: 4 };
function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return { id: "w", name: "W", role: "researcher", childrenIds: [], model: "deepseek-chat", provider: "deepseek", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true, ...over };
}
let projectRoot: string;
const events: Array<{ type: string; agentId?: string; payload: any }> = [];
function deps(execFn: ParallelDeps["execFn"], over: Partial<ParallelDeps> = {}): ParallelDeps {
  const baseline: GateBaseline = { typeErrors: 0, testsRan: false, testsPassed: true };
  const pool = new AccountPool([acct]);
  return { projectRoot, scheduler: new DefaultScheduler(pool, { acquireTimeoutMs: 5000 }), semaphore: new Semaphore(4), baseline, maxAttempts: 1, taskTimeoutMs: 60_000, taskTimeoutExplicit: true, maxTokensPerTask: 4096, runId: "run-td", accountUsage: {}, emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); }, execFn, ...over };
}
beforeEach(() => { projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pe-td-")); expect(ensureGitRepo(projectRoot)).toBe(true); initProviderHealth(projectRoot); events.length = 0; });
afterEach(() => { try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ } });

describe("#1 文本依赖型 worker 批调度 + 上游文本注入", () => {
  it("综合者(dependsOnText)排在 producer 之后跑,且 prompt 注入了各 producer 的文本产出", async () => {
    const order: string[] = [];
    const promptSeen = new Map<string, string>();
    const execFn = async (a: AgentNodeConfig, t: ExecTask, _ctx: ExecContext): Promise<ExecResult> => {
      order.push(a.id);
      promptSeen.set(a.id, t.goal);
      const content = a.id === "r1" ? "研究员甲发现:量子退火对特定问题有 X 加速" :
        a.id === "r2" ? "研究员乙发现:密码学侧 Shor 威胁时间线为 Y" :
        "综合报告:整合甲乙两方向";
      return { content, fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "r1", role: "researcher" }), systemPrompt: "s", userMessage: "研究量子退火", taskId: "L/r1", noCode: true },
      { agent: agent({ id: "r2", role: "researcher" }), systemPrompt: "s", userMessage: "研究密码学威胁", taskId: "L/r2", noCode: true },
      { agent: agent({ id: "syn", role: "synthesizer" }), systemPrompt: "s", userMessage: "综合各研究员的产出", taskId: "L/syn", noCode: true, dependsOnText: true },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));

    // 三个都返回、都 ok
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);

    // 综合者排在两个 producer 之后
    const synIdx = order.indexOf("syn");
    expect(synIdx).toBe(2);
    expect(order.slice(0, 2).sort()).toEqual(["r1", "r2"]);

    // 综合者的 prompt 注入了上游两位 producer 的文本产出 + 明确的上游区块标头
    const synPrompt = promptSeen.get("syn")!;
    expect(synPrompt).toContain("上游 worker 的产出");
    expect(synPrompt).toContain("研究员甲发现:量子退火对特定问题有 X 加速");
    expect(synPrompt).toContain("研究员乙发现:密码学侧 Shor 威胁时间线为 Y");

    // producer 的 prompt 不含注入块(它们没有上游)
    expect(promptSeen.get("r1")!).not.toContain("上游 worker 的产出");
  });

  it("向后兼容:无 dependsOnText 时,行为与改造前一致(单批、无注入、全部并发)", async () => {
    const order: string[] = [];
    const promptSeen = new Map<string, string>();
    const execFn = async (a: AgentNodeConfig, t: ExecTask, _ctx: ExecContext): Promise<ExecResult> => {
      order.push(a.id); promptSeen.set(a.id, t.goal);
      return { content: `${a.id} done`, fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const specs: WorkerSpec[] = [
      { agent: agent({ id: "r1" }), systemPrompt: "s", userMessage: "任务1", taskId: "L/r1", noCode: true },
      { agent: agent({ id: "r2" }), systemPrompt: "s", userMessage: "任务2", taskId: "L/r2", noCode: true },
    ];
    const results = await runWorkersParallel(specs, deps(execFn));
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok)).toBe(true);
    // 没有任何"上游产出"注入
    expect(promptSeen.get("r1")!).not.toContain("上游 worker 的产出");
    expect(promptSeen.get("r2")!).not.toContain("上游 worker 的产出");
  });
});
