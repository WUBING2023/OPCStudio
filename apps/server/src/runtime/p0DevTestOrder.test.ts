import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";
import { ensureGitRepo } from "./workspace.js";
import { runTool, runWithAgent } from "./tools.js";
import { deriveTestEvidence, type ContractSourceEvent } from "./runtimeContract.js";

// P0-3 · Dev/Test 真实依赖序(结构性)端到端:一个 lead 的 producer(dev,编码)与 verifier(tester,
// 跑测试)不再全员并行在各自隔离 worktree —— producer 先跑 + commit + merge 回真实 workRoot,verifier 后跑
// 且其 worktree 从【已 merge 的 workRoot 的新 HEAD】新建,因此能看到 dev 的 sum.js/sum.test.js 并真正
// `node sum.test.js`。P0-4:verifier(tester)经 runShell 受限测试通道跑测试(全局 allowShell 默认关闭仍放行),
// 命令/cwd/exitCode/输出进 TestEvidence。verifier 零文件变更合法,不判 no_file_changes。

interface Emitted { t: string; a?: string; p: any }

function agentOf(id: string, role: string): AgentNodeConfig {
  return {
    id, name: id, role, provider: "deepseek", model: "m", framework: "hermes", childrenIds: [],
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
  } as unknown as AgentNodeConfig;
}

function makeDeps(root: string, execFn: ParallelDeps["execFn"], events: Emitted[]): ParallelDeps {
  return {
    projectRoot: root,
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
    semaphore: new Semaphore(4),
    baseline: { typeErrors: 0, testsRan: false, testsPassed: true } as any,
    maxAttempts: 1,
    taskTimeoutMs: 60_000,
    maxTokensPerTask: 1000,
    runId: "p0order-run",
    accountUsage: {},
    emit: (t, a, p) => events.push({ t, a, p }),
    execFn,
  };
}

const ok = (content: string, fileChanges: ExecResult["fileChanges"]): ExecResult =>
  ({ content, fileChanges, tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "done" });

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "p0order-")); ensureGitRepo(root); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁 */ } });

describe("P0-3/P0-4 · producer 先 merge、verifier 后跑真实测试", () => {
  it("producer→merge→verifier 依赖序:tester 在 merged workRoot 能读到 dev 文件并跑 node sum.test.js,证据带 exitCode", async () => {
    const events: Emitted[] = [];
    const order: string[] = [];
    const saw = { sumJs: false, testJs: false, workdir: "" };

    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      if (a.role === "dev") {
        order.push("producer");
        fs.writeFileSync(path.join(ctx.workdir, "sum.js"), "module.exports = (a, b) => a + b;\n");
        fs.writeFileSync(
          path.join(ctx.workdir, "sum.test.js"),
          "const sum = require('./sum.js');\nif (sum(2, 3) !== 5) { console.error('FAIL'); process.exit(1); }\nconsole.log('SUM_OK');\n",
        );
        return ok("wrote sum.js + sum.test.js", [
          { path: "sum.js", changeType: "create" },
          { path: "sum.test.js", changeType: "create" },
        ]);
      }
      // verifier(tester):worktree 应已含 producer 合并回来的文件
      order.push("verifier");
      saw.workdir = ctx.workdir;
      saw.sumJs = fs.existsSync(path.join(ctx.workdir, "sum.js"));
      saw.testJs = fs.existsSync(path.join(ctx.workdir, "sum.test.js"));
      // P0-4:经 runShell 受限测试通道真跑(全局 allowShell 默认关闭),并把 tool_call/tool_result 事件
      // 按真实引擎的形状 emit → deriveTestEvidence 据此采证。
      const out = await runWithAgent(a.id, () => runTool("runShell", { command: "node sum.test.js" }, ctx.workdir), a.role);
      ctx.emit("tool_call", a.id, { name: "runShell", args: { command: "node sum.test.js" } });
      ctx.emit("tool_result", a.id, { name: "runShell", result: out });
      return ok(out, []); // verifier 只跑测试 → 零文件变更(合法)
    };

    const specs: WorkerSpec[] = [
      { agent: agentOf("dev-1", "dev"), systemPrompt: "s", userMessage: "写 sum.js", taskId: "lead/dev-1", noCode: false, isVerifier: false },
      { agent: agentOf("tester-1", "tester"), systemPrompt: "s", userMessage: "跑测试", taskId: "lead/tester-1", noCode: false, isVerifier: true },
    ];

    const results = await runWorkersParallel(specs, makeDeps(root, execFn, events));

    // ① 依赖序:producer 批整体先于 verifier 批(两批串行,不再全员并行)
    expect(order).toEqual(["producer", "verifier"]);
    // ② verifier 的 worktree 从 merged workRoot 新建 → 看得到 dev 的产物
    expect(saw.sumJs).toBe(true);
    expect(saw.testJs).toBe(true);
    // ③ producer 的文件真的 merge 回了真实 workRoot(projectRoot)
    expect(fs.existsSync(path.join(root, "sum.js"))).toBe(true);
    expect(fs.existsSync(path.join(root, "sum.test.js"))).toBe(true);
    // ④ verifier 零文件变更但被接受(不误判 no_file_changes)
    const vres = results.find((r) => r.agentId === "tester-1")!;
    expect(vres.ok).toBe(true);
    expect(vres.fileChanges ?? []).toEqual([]);
    // ⑤ 受限通道产出 [test-evidence] 头(退出码 0),证明测试真跑通
    expect(vres.content).toContain("[test-evidence]");
    expect(vres.content).toContain("exit=0");
    expect(vres.content).toContain("SUM_OK");
    // ⑥ deriveTestEvidence 从事件派生真实证据:命令 + cwd(=verifier worktree)+ exitCode
    const te = deriveTestEvidence(
      events.map((e, i) => ({ type: e.t, at: new Date(1_700_000_000_000 + i).toISOString(), agentId: e.a, payload: e.p })) as ContractSourceEvent[],
    );
    expect(te).toHaveLength(1);
    expect(te[0].command).toBe("node sum.test.js");
    expect(te[0].exitCode).toBe(0);
    expect(te[0].passed).toBe(true);
    expect(te[0].cwd).toBe(saw.workdir);
  });

  it("无 verifier → 单批执行,producer 照常 merge(与改造前等价,不回退)", async () => {
    const events: Emitted[] = [];
    const execFn = async (a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
      fs.writeFileSync(path.join(ctx.workdir, "app.js"), "console.log('x');\n");
      return ok("done", [{ path: "app.js", changeType: "create" }]);
    };
    const specs: WorkerSpec[] = [
      { agent: agentOf("dev-1", "dev"), systemPrompt: "s", userMessage: "写 app.js", taskId: "lead/dev-1", noCode: false, isVerifier: false },
    ];
    const results = await runWorkersParallel(specs, makeDeps(root, execFn, events));
    expect(results[0].ok).toBe(true);
    expect(results[0].fileChanges?.map((f) => f.path)).toEqual(["app.js"]);
    expect(fs.existsSync(path.join(root, "app.js"))).toBe(true);
  });

  // Fix2 回归:研究/写作(producer 全 noCode)无文件产物时,verifier 跳过是**预期良性**行为,绝不当作
  // 降级性 deferred(否则带核查/审查边的研究 run 必然被判降级)。实测 DRACO 研究题评分被稀释的根因之一。
  it("Fix2 · noCode 研究 producer 无文件产物 → verifier 良性跳过,不产生 no_producer_output 降级 deferred", async () => {
    const events: Emitted[] = [];
    let verifierRan = false;
    const execFn = async (a: AgentNodeConfig): Promise<ExecResult> => {
      if (a.role === "fact_checker") { verifierRan = true; return ok("(不该被调用)", []); }
      return ok("这是一份研究报告文本,覆盖三个方向的进展与瓶颈,无任何代码文件。", []); // 研究 producer:文本、零文件
    };
    const specs: WorkerSpec[] = [
      { agent: agentOf("r-1", "researcher"), systemPrompt: "s", userMessage: "研究并撰写报告", taskId: "lead/r-1", noCode: true, isVerifier: false },
      { agent: agentOf("fc-1", "fact_checker"), systemPrompt: "s", userMessage: "核查", taskId: "lead/fc-1", noCode: true, isVerifier: true },
    ];
    const results = await runWorkersParallel(specs, makeDeps(root, execFn, events));
    // ① verifier 跳过事件标 benign=true(研究任务无文件是正常,不空跑烧 token)
    const skip = events.find((e) => e.t === "info" && e.p?.kind === "verifier_skipped_no_producer");
    expect(skip?.p?.benign).toBe(true);
    expect(verifierRan).toBe(false); // verifier 未真正执行
    // ② 结果里【没有】任何 no_producer_output 的降级 deferred(研究 run 不因无文件被拖降级)
    expect(results.some((r) => !r.ok && r.deferred?.reason === "no_producer_output")).toBe(false);
    // ③ producer 的研究文本被保留为有效结果(ok:true + content 非空)
    expect(results.some((r) => r.ok && (r.content || "").includes("研究报告"))).toBe(true);
  });

  it("Fix2 · 对照:编码 producer(!noCode)无文件产物 → verifier 仍如实 deferred no_producer_output(诚实性不变)", async () => {
    const events: Emitted[] = [];
    const execFn = async (a: AgentNodeConfig): Promise<ExecResult> => {
      if (a.role === "tester") return ok("(不该被调用)", []);
      return ok("我讨论了代码但没落盘任何文件", []); // 编码 producer 零文件变更 = 假交付
    };
    const specs: WorkerSpec[] = [
      { agent: agentOf("dev-1", "dev"), systemPrompt: "s", userMessage: "实现 sum 函数", taskId: "lead/dev-1", noCode: false, isVerifier: false },
      { agent: agentOf("tester-1", "tester"), systemPrompt: "s", userMessage: "跑测试", taskId: "lead/tester-1", noCode: false, isVerifier: true },
    ];
    const results = await runWorkersParallel(specs, makeDeps(root, execFn, events));
    const skip = events.find((e) => e.t === "info" && e.p?.kind === "verifier_skipped_no_producer");
    expect(skip?.p?.benign).toBe(false); // 编码任务无产物 = 真问题,不良性
    expect(results.some((r) => !r.ok && r.deferred?.reason === "no_producer_output")).toBe(true);
  });
});
