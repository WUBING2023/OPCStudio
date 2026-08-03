// P0 · no_file_changes 针对性纠正重试(发布必做:producer 只回文本不写文件的高发失败自愈)。
// 证明:第 1 轮零落盘后,下一轮 prompt 被注入"必须调用写文件工具落盘"的明确纠正反馈 → producer 据此
// 真正落盘 → worker 被接受(不再整队因 no_file_changes 坍塌)。对照右尺寸对照里 ~50-60% no_file_changes。
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";

function codingSpec(id: string): WorkerSpec {
  return {
    agent: { id, role: "dev", provider: "deepseek", model: "m", framework: "hermes", name: id } as unknown as AgentNodeConfig,
    systemPrompt: "sys", userMessage: "实现一个函数并写代码落盘", taskId: `t-${id}`, noCode: false,
  };
}
function makeDeps(root: string, execFn: ParallelDeps["execFn"], events: any[]): ParallelDeps {
  return {
    projectRoot: root,
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
    semaphore: new Semaphore(4), baseline: {} as any,
    maxAttempts: 3, maxNoProgressAttempts: 3, taskTimeoutMs: 60_000, maxTokensPerTask: 1000,
    runId: "corrective-run", accountUsage: {}, emit: (t, a, p) => events.push({ t, a, p }), execFn,
  };
}
function withGitRoot(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "corrective-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q"); git('config user.email "e@t"'); git('config user.name "e"');
      fs.writeFileSync(path.join(root, "seed.md"), "seed"); fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      git("add -A"); git('commit -q -m seed');
      await fn(root);
    } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 锁,尽力 */ } }
  };
}

describe("P0 · no_file_changes 针对性纠正重试", () => {
  it("第1轮零落盘→第2轮prompt带纠正反馈→producer真正落盘→worker被接受", withGitRoot(async (root) => {
    const goals: string[] = [];
    let recovered = false;
    const execFn = async (_a: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      goals.push(task.goal);
      // 只有当收到"必须调用写文件工具落盘"的纠正反馈后才真正落盘(模拟 DeepSeek 被明确纠正后才写文件)。
      if (/必须.*调用.*写文件工具|no_file_changes/.test(task.goal)) {
        recovered = true;
        fs.writeFileSync(path.join(ctx.workdir, "sum.md"), "RECOVERED 交付内容".repeat(5));
        return { content: "纠正后已落盘", fileChanges: [{ path: "sum.md", changeType: "create" }], tokens: { prompt: 5, completion: 5, total: 10 }, cost: 0, latencyMs: 1, status: "done" };
      }
      return { content: "我已完成(其实只贴了代码文本,没落盘)", fileChanges: [], tokens: { prompt: 5, completion: 5, total: 10 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const events: any[] = [];
    const results = await runWorkersParallel([codingSpec("w-recover")], makeDeps(root, execFn, events));

    expect(results[0].ok).toBe(true);                                   // 自愈成功交付
    expect(results[0].fileChanges?.map((f) => f.path)).toEqual(["sum.md"]);
    expect(recovered).toBe(true);
    // 第 1 轮 prompt 干净(无纠正反馈);第 2 轮起带上纠正反馈。
    expect(/必须.*调用.*写文件工具/.test(goals[0])).toBe(false);
    expect(/必须.*调用.*写文件工具/.test(goals[1])).toBe(true);
    // 观测事件:恰好 emit 一次纠正重试(不重复刷屏)。
    expect(events.filter((e) => e.p?.kind === "no_file_changes_corrective_retry")).toHaveLength(1);
  }));

  it("始终不落盘时:纠正反馈注入后仍 no_file_changes → 诚实失败(不虚标成功)", withGitRoot(async (root) => {
    let calls = 0;
    const execFn = async (): Promise<ExecResult> => {
      calls++;
      return { content: "永远只回文本", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const events: any[] = [];
    const results = await runWorkersParallel([codingSpec("w-stuck")], makeDeps(root, execFn, events));
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("no_file_changes");        // 诚实失败终态不变
    expect(calls).toBe(3);                                              // maxNoProgress=3 提前停,不空耗
    expect(events.filter((e) => e.p?.kind === "no_file_changes_corrective_retry")).toHaveLength(1);
  }));
});

// Fix B · producer 无产物 → 不启动 tester/reviewer(不空跑烧 token)
function verifierSpec(id: string): WorkerSpec {
  return {
    agent: { id, role: "test", provider: "deepseek", model: "m", framework: "hermes", name: id } as unknown as AgentNodeConfig,
    systemPrompt: "sys", userMessage: "独立跑测试验证产物", taskId: `t-${id}`, noCode: false, isVerifier: true,
  };
}
describe("P0 · producer 无产物则跳过独立验证", () => {
  it("producer 零落盘(耗尽纠正重试)→ verifier 根本不被调用 → 记 no_producer_output(省 token)", withGitRoot(async (root) => {
    const calls: Record<string, number> = {};
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      calls[a.id] = (calls[a.id] ?? 0) + 1;
      if (a.role === "test") { // verifier 若被调用则落一个测试文件(但本例它绝不该被调用)
        fs.writeFileSync(path.join(ctx.workdir, "x.test.md"), "t");
        return { content: "tested", fileChanges: [{ path: "x.test.md", changeType: "create" }], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
      }
      return { content: "producer 只回文本没落盘", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const events: any[] = [];
    const results = await runWorkersParallel([codingSpec("dev-x"), verifierSpec("tester-x")], makeDeps(root, execFn, events));

    const dev = results.find((r) => r.deferred?.agentId === "dev-x");
    const tester = results.find((r) => r.deferred?.agentId === "tester-x");
    expect(dev?.deferred?.reason).toBe("no_file_changes");
    expect(tester?.deferred?.reason).toBe("no_producer_output");
    expect(calls["tester-x"]).toBeUndefined();                          // verifier 从未被调用 = 省 token
    expect(calls["dev-x"]).toBe(3);                                     // producer 纠正重试到 maxNoProgress
    expect(events.filter((e) => e.p?.kind === "verifier_skipped_no_producer")).toHaveLength(1);
  }));

  it("producer 有产物时 verifier 正常运行(不被误跳过)", withGitRoot(async (root) => {
    const calls: Record<string, number> = {};
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      calls[a.id] = (calls[a.id] ?? 0) + 1;
      if (a.role === "test") {
        return { content: "独立验证通过", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
      }
      fs.writeFileSync(path.join(ctx.workdir, "impl.md"), "REAL 交付".repeat(5));
      return { content: "已落盘", fileChanges: [{ path: "impl.md", changeType: "create" }], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
    };
    const events: any[] = [];
    const results = await runWorkersParallel([codingSpec("dev-ok"), verifierSpec("tester-ok")], makeDeps(root, execFn, events));
    expect(calls["tester-ok"]).toBe(1);                                 // producer 有产物 → verifier 照常运行
    expect(events.filter((e) => e.p?.kind === "verifier_skipped_no_producer")).toHaveLength(0);
    expect(results.find((r) => r.deferred?.agentId === "tester-ok")?.deferred?.reason).not.toBe("no_producer_output");
  }));
});
