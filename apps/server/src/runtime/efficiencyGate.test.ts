// P0 Part A · 效率闸(用户"高 token 发现":sum 任务 105k / dev 83k·11 调用;V0 默认必须有上限)。
// 覆盖三道闸:①run 级 Token 限额默认生效(config.budget.maxTokensPerRun)②编码 worker 连续零
// 文件变更 N 轮 → 提前停判 no_file_changes(不空耗预算)③记忆注入全局上限(总条数/总字符),超限按
// 优先级截断。run 级"超限→停+deferred+degraded"的最终链路(deferred→run.degraded→failed)在
// orchestrator:2286/2308-2314 已接线,由真实活体验收端到端覆盖(run 主循环含模块状态,不做隔离单测)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";
import { buildSystemPrompt, type InjectionContext } from "./contextBuilder.js";
import { loadConfig } from "../storage/projectStore.js";
import { addMemory } from "../storage/memoryStore.js";

// ─────────────────────────────── ① run 级 Token 限额默认生效 ───────────────────────────────
describe("效率闸① · run 级 Token 限额默认生效", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "eff-budget-")); fs.mkdirSync(path.join(root, ".opc"), { recursive: true }); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("空项目 loadConfig:maxTokensPerRun 默认 60k、货币限额保持禁用", () => {
    const cfg = loadConfig(root);
    expect(cfg.budget.maxTokensPerRun).toBe(60_000);
    expect(cfg.budget.maxCostPerRun).toBe(0);
  });

  it("高级模式:Token 限额可放宽;旧货币字段只做配置兼容", () => {
    fs.writeFileSync(
      path.join(root, ".opc", "config.json"),
      JSON.stringify({ version: "0.1.0", projectName: "x", apiKeys: {}, defaultModel: "deepseek-v4-pro",
        budget: { totalUsd: 10, maxTokensPerTask: 200_000, maxTokensPerRun: 5_000_000, maxCostPerRun: 50 },
        permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false } }),
      "utf-8",
    );
    const cfg = loadConfig(root);
    expect(cfg.budget.maxTokensPerRun).toBe(5_000_000);
    expect(cfg.budget.maxCostPerRun).toBe(50);
  });
});

// ─────────────────────────────── ② 编码无进展停 ───────────────────────────────
function codingSpec(id: string): WorkerSpec {
  return {
    agent: { id, role: "dev", provider: "deepseek", model: "m", framework: "hermes", name: id } as unknown as AgentNodeConfig,
    systemPrompt: "sys", userMessage: "实现一个函数并写代码落盘", taskId: `t-${id}`, noCode: false,
  };
}

function zeroChangeExec(counter: { n: number }) {
  return async (_a: AgentNodeConfig, _t: ExecTask, _ctx: ExecContext): Promise<ExecResult> => {
    counter.n++;
    // 编码 worker 声称完成,但零文件变更(未落盘——scratch 假交付的典型形态)。
    return { content: "我已经完成了(其实没落盘)", fileChanges: [], tokens: { prompt: 10, completion: 10, total: 20 }, cost: 0, latencyMs: 1, status: "done" };
  };
}

describe("效率闸② · 编码 worker 连续零变更 → 提前停判 no_file_changes", () => {
  it("maxAttempts=5 但 maxNoProgressAttempts=3:第 3 轮零变更即停,不空耗剩余 2 轮预算", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eff-git-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q"); git('config user.email "e@t"'); git('config user.name "e"');
      fs.writeFileSync(path.join(root, "seed.md"), "seed");
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      git("add -A"); git('commit -q -m seed');

      const counter = { n: 0 };
      const events: Array<{ t: string; a?: string; p: any }> = [];
      const deps: ParallelDeps = {
        projectRoot: root,
        scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
        semaphore: new Semaphore(4),
        baseline: {} as any,
        maxAttempts: 5,
        maxNoProgressAttempts: 3,
        taskTimeoutMs: 60_000,
        maxTokensPerTask: 1000,
        runId: "eff-run",
        accountUsage: {},
        emit: (t, a, p) => events.push({ t, a, p: p as any }),
        execFn: zeroChangeExec(counter),
      };

      const results = await runWorkersParallel([codingSpec("w-stuck")], deps);

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].deferred?.reason).toBe("no_file_changes");
      // 关键:连续 3 轮就停,execFn 只被调用 3 次(而非 maxAttempts=5),预算未被空耗。
      expect(counter.n).toBe(3);
      const stop = events.filter((e) => e.p?.kind === "no_progress_stop");
      expect(stop).toHaveLength(1);
      expect(stop[0].p.streak).toBe(3);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });

  it("一旦某轮真有文件变更(哪怕后续质量门失败),无进展计数清零 → 不被无进展闸误停", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eff-git2-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q"); git('config user.email "e@t"'); git('config user.name "e"');
      fs.writeFileSync(path.join(root, "seed.md"), "seed");
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      git("add -A"); git('commit -q -m seed');

      let attempt = 0;
      const events: Array<{ t: string; a?: string; p: any }> = [];
      const execFn = async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext): Promise<ExecResult> => {
        attempt++;
        if (attempt === 2) {
          // 第 2 轮真的落盘一个文档文件(有进展)→ 该轮被接受(.md 走读回路径,不跑代码质量门)。
          fs.writeFileSync(path.join(ctx.workdir, "out.md"), "REAL_DELIVERY_MARKER 交付内容".repeat(5));
          return { content: "第二轮交付", fileChanges: [{ path: "out.md", changeType: "create" }], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
        }
        return { content: "空转", fileChanges: [], tokens: { prompt: 1, completion: 1, total: 2 }, cost: 0, latencyMs: 1, status: "done" };
      };
      const deps: ParallelDeps = {
        projectRoot: root,
        scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
        semaphore: new Semaphore(4), baseline: {} as any,
        maxAttempts: 5, maxNoProgressAttempts: 3, taskTimeoutMs: 60_000, maxTokensPerTask: 1000,
        runId: "eff-run2", accountUsage: {}, emit: (t, a, p) => events.push({ t, a, p: p as any }), execFn,
      };
      // 第 1 轮零变更(streak=1),第 2 轮有变更 → 被接受返回。无进展闸(阈值 3)不触发。
      const results = await runWorkersParallel([codingSpec("w-progress")], deps);
      expect(results[0].ok).toBe(true);
      expect(results[0].fileChanges?.map((f) => f.path)).toEqual(["out.md"]);
      expect(events.filter((e) => e.p?.kind === "no_progress_stop")).toHaveLength(0);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

// ─────────────────────────────── ③ 记忆注入全局上限 ───────────────────────────────
function devAgent(): AgentNodeConfig {
  return {
    id: "a1", name: "Dev", role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    framework: "hermes", companyId: "co1", parentId: "lead1", status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
  } as AgentNodeConfig;
}
function freshCtx(root: string): InjectionContext {
  return { projectRoot: root, runId: "run-cur", injectedSkillIds: [], injectedMemoryIds: [] };
}
function writeKnowledge(root: string, rel: string, body: string) {
  const f = path.join(root, ".opc", "knowledge", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body, "utf-8");
}

describe("效率闸③ · 记忆注入全局上限(总条数/总字符),超限按优先级截断", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "eff-mem-")); fs.mkdirSync(path.join(root, ".opc"), { recursive: true }); });
  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    delete process.env.OPC_MAX_MEM_ITEMS;
    delete process.env.OPC_MAX_MEM_CHARS;
  });

  it("总条数上限:4 份 md 记忆可注入,但 OPC_MAX_MEM_ITEMS=2 时只注入最靠前的 2 条(company/team)", () => {
    addMemory(root, { id: "md-company", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "company A", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-team-lead1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "team B", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-project-lead1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "project C", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-agent-a1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "agent D", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    process.env.OPC_MAX_MEM_ITEMS = "2";

    const out = freshCtx(root);
    buildSystemPrompt(devAgent(), "BASE", "memory budget", root, out);

    expect(out.injectedMemoryIds).toContain("md-company");
    expect(out.injectedMemoryIds).toContain("md-team-lead1");
    expect(out.injectedMemoryIds).not.toContain("md-project-lead1"); // 超条数上限被截断
    expect(out.injectedMemoryIds).not.toContain("md-agent-a1");
    expect(out.injectedMemoryIds).toHaveLength(2);
  });

  it("总字符上限:OPC_MAX_MEM_CHARS=5 时,装不下的靠后记忆被截断(只保留小体量的 company)", () => {
    addMemory(root, { id: "md-company", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "AB", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-team-lead1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "X".repeat(80), tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    process.env.OPC_MAX_MEM_CHARS = "5";

    const out = freshCtx(root);
    buildSystemPrompt(devAgent(), "BASE", "memory budget", root, out);

    expect(out.injectedMemoryIds).toContain("md-company");
    expect(out.injectedMemoryIds).not.toContain("md-team-lead1"); // 超字符上限被截断
  });

  it("默认上限(12/6000)下小体量 fixture 不受影响:4 份 md 全部照常注入(无回归)", () => {
    addMemory(root, { id: "md-company", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "company", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-team-lead1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "team", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-project-lead1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "project", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });
    addMemory(root, { id: "md-agent-a1", agentRole: "dev", companyId: "co1", goalSlug: "memory-budget", text: "agent", tags: [], source: { type: "manual", runId: "", agentId: "a1" } });

    const out = freshCtx(root);
    buildSystemPrompt(devAgent(), "BASE", "memory budget", root, out);

    for (const id of ["md-company", "md-team-lead1", "md-project-lead1", "md-agent-a1"]) {
      expect(out.injectedMemoryIds).toContain(id);
    }
  });
});
