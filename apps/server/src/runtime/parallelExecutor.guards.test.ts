// A1-V3 权限护栏测试:roleProfile.allowedExtensions / blockedGlobs 在 worker 文件写入路径上
// **真实拦截**(违规文件不进产出 + 结构化 permission_block 事件),而非事后警告。
// 覆盖:scratch 读回路径(允许/拦截)、git worktree 的 commit/merge 路径(拦截)、超时抢救读回路径(拦截)。
// 缺省=全放行 的判定语义在 roleProfile.test.ts(checkFileAllowed)与 redact.test.ts(envAllowlist)单测。
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";

interface Emitted { t: string; a?: string; p: any }

function makeDeps(overrides: Partial<ParallelDeps>, events: Emitted[]): ParallelDeps {
  return {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "pe-guard-root-")),
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
    semaphore: new Semaphore(4),
    baseline: {} as any,
    maxAttempts: 1,
    taskTimeoutMs: 60_000,
    maxTokensPerTask: 1000,
    runId: "guard-test-run",
    accountUsage: {},
    emit: (t, a, p) => events.push({ t, a, p: p as any }),
    execFn: undefined as any,
    ...overrides,
  };
}

const spec = (id: string, role: string, noCode: boolean): WorkerSpec => ({
  agent: { id, role, provider: "deepseek", model: "m", framework: "hermes", name: id } as unknown as AgentNodeConfig,
  systemPrompt: "sys",
  userMessage: "task",
  taskId: `t-${id}`,
  noCode,
});

const okResult = (content: string, fileChanges: ExecResult["fileChanges"]): ExecResult =>
  ({ content, fileChanges, tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "done" });

const blockEvents = (events: Emitted[]) => events.filter((e) => e.p?.kind === "permission_block");

describe("A1-V3 · scratch 读回路径的权限护栏", () => {
  it("[拦截] 研究 worker 写 .py/.env → 物理删除、不进读回产出,emit 结构化 permission_block", async () => {
    const events: Emitted[] = [];
    const deps = makeDeps({
      execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
        fs.mkdirSync(path.join(ctx.workdir, "output"), { recursive: true });
        fs.writeFileSync(path.join(ctx.workdir, "output", "report.md"), "RESEARCH_OK_MARKER 研究结论,来源与分析。".repeat(20));
        fs.writeFileSync(path.join(ctx.workdir, "exploit.py"), "print('PY_PAYLOAD_MARKER')".repeat(20));
        fs.writeFileSync(path.join(ctx.workdir, ".env"), "SECRET=leak");
        return okResult("正文结论", [
          { path: "output/report.md", changeType: "create" },
          { path: "exploit.py", changeType: "create" },
          { path: ".env", changeType: "create" },
        ]);
      },
    }, events);

    const results = await runWorkersParallel([spec("w-block", "researcher", true)], deps);

    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].content).toContain("RESEARCH_OK_MARKER");     // 合法文件照常读回
    expect(results[0].content).not.toContain("PY_PAYLOAD_MARKER");  // 违规文件被物理删除,绝不进产出
    expect(results[0].content).not.toContain("SECRET=leak");

    const blocks = blockEvents(events);
    expect(blocks).toHaveLength(1);
    const p = blocks[0].p;
    expect(p.profileId).toBe("research_profile_v1");
    expect(p.taskId).toBe("t-w-block");
    const blockedPaths = p.blockedFiles.map((b: any) => b.path).sort();
    expect(blockedPaths).toEqual([".env", "exploit.py"]);
    expect(p.blockedFiles.every((b: any) => b.rule === "blocked_glob")).toBe(true);
  });

  it("[允许] 研究 worker 只写 .md → 全部读回,不产生 permission_block", async () => {
    const events: Emitted[] = [];
    const deps = makeDeps({
      execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
        fs.writeFileSync(path.join(ctx.workdir, "report.md"), "ALLOWED_MD_MARKER 一切正常。".repeat(20));
        return okResult("正文", [{ path: "report.md", changeType: "create" }]);
      },
    }, events);

    const results = await runWorkersParallel([spec("w-allow", "researcher", true)], deps);

    expect(results[0].ok).toBe(true);
    expect(results[0].content).toContain("ALLOWED_MD_MARKER");
    expect(blockEvents(events)).toHaveLength(0);
  });
});

describe("A1-V3 · git worktree 的 commit/merge 路径护栏", () => {
  it("[拦截] dev worker 写 secrets/creds.json → 不被 commit/merge 回主检出;ok.md 正常落地", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-guard-git-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email "guard@test"');
      git('config user.name "guard"');
      fs.writeFileSync(path.join(root, "seed.md"), "seed");
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n"); // 与真实项目一致:worktree 挂载点不入库
      git("add -A");
      git('commit -q -m "seed"');

      const events: Emitted[] = [];
      const deps = makeDeps({
        projectRoot: root,
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          fs.writeFileSync(path.join(ctx.workdir, "ok.md"), "OK_DOC");
          fs.mkdirSync(path.join(ctx.workdir, "secrets"), { recursive: true });
          fs.writeFileSync(path.join(ctx.workdir, "secrets", "creds.json"), '{"apiKey":"sk-should-never-land"}');
          return okResult("done", [
            { path: "ok.md", changeType: "create" },
            { path: "secrets/creds.json", changeType: "create" },
          ]);
        },
      }, events);

      const results = await runWorkersParallel([spec("w-git", "dev", false)], deps);

      expect(results[0].ok).toBe(true);
      expect(results[0].fileChanges?.map((f) => f.path)).toEqual(["ok.md"]); // 违规项从 fileChanges 里剔除
      expect(fs.existsSync(path.join(root, "ok.md"))).toBe(true);            // 合法文件 merge 落地
      expect(fs.existsSync(path.join(root, "secrets", "creds.json"))).toBe(false); // 违规文件绝不落地

      const blocks = blockEvents(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].p.profileId).toBe("code_profile_v1");
      expect(blocks[0].p.blockedFiles[0]).toMatchObject({ path: "secrets/creds.json", rule: "blocked_glob" });
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });

  it("P0-4(防自证)· verifier 改被验证的源码 → 变更被丢弃、绝不 merge 回交付,发 verifier_changes_discarded", async () => {
    // test/reviewer 角色是 code_profile_v1(放行 .js),enforceFileGuards 不会拦它写码 → 若无执行器级守卫,
    // tester 改 impl.js 让"自己的测试通过"会 merge 进交付 = 自证。断言:root 里 impl.js 内容不变,变更被丢弃。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-guard-verif-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email "guard@test"');
      git('config user.name "guard"');
      fs.writeFileSync(path.join(root, "impl.js"), "module.exports = () => 'REAL';\n"); // 被验证的交付
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      git("add -A");
      git('commit -q -m "seed"');

      const events: Emitted[] = [];
      const deps = makeDeps({
        projectRoot: root,
        priorContractFiles: ["impl.js"], // producer 已交付 impl.js(合同非空)→ verifier 会真正运行,守卫才被检验
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          // verifier 篡改被验证的源码(把实现改成能让它的"测试"通过的作弊版本)
          fs.writeFileSync(path.join(ctx.workdir, "impl.js"), "module.exports = () => 'CHEATED';\n");
          return okResult("[test-evidence] node impl.test.js exit=0", [{ path: "impl.js", changeType: "modify" }]);
        },
      }, events);

      const verifierSpec: WorkerSpec = {
        agent: { id: "tester-1", role: "test", provider: "deepseek", model: "m", framework: "hermes", name: "tester-1" } as unknown as AgentNodeConfig,
        systemPrompt: "sys", userMessage: "运行测试验证上游产出,不要写新代码", taskId: "t-verif", noCode: false, isVerifier: true,
      };
      const results = await runWorkersParallel([verifierSpec], deps);

      expect(results[0].ok).toBe(true);                       // verifier 仍被接受(零变更合法,产出=TestEvidence 文本)
      expect(results[0].fileChanges).toEqual([]);             // 其文件变更被清空
      expect(fs.readFileSync(path.join(root, "impl.js"), "utf-8")).toContain("REAL");   // 交付源码未被篡改
      expect(fs.readFileSync(path.join(root, "impl.js"), "utf-8")).not.toContain("CHEATED");
      const discarded = events.filter((e) => e.p?.kind === "verifier_changes_discarded");
      expect(discarded).toHaveLength(1);
      expect(discarded[0].p.files).toContain("impl.js(modify)");
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });

  it("P0-4(自证防线)· producer 已交付时 verifier 额外【新建源码】impl.js(非测试路径)→ 判违规整体丢弃,源码绝不落地", async () => {
    // 用户审计抓出的自证路径:verifier 自己新建 impl.js + impl.test.js 再跑通。impl.js 是非测试路径的 create =
    // 创造被验证的源码 → 违规,连同同批 impl.test.js 一并丢弃,交付里不留 verifier 自造的源码。
    // 注:producer 完全零产物的场景现由「无产物不启 verifier」的更早一层防线拦下(见 correctiveRetry 测试),
    // 此处覆盖的是【producer 已交付、verifier 仍越界自造源码】这一仍可达的路径,守卫必须照常丢弃。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-guard-verif-src-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email "guard@test"');
      git('config user.name "guard"');
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      fs.writeFileSync(path.join(root, "delivered.js"), "module.exports = () => 'from-producer';\n"); // producer 已交付
      git("add -A"); git('commit -q -m "seed producer"');

      const events: Emitted[] = [];
      const deps = makeDeps({
        projectRoot: root,
        priorContractFiles: ["delivered.js"], // producer 已交付 → verifier 会运行,越界自造源码才被守卫检验
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          fs.writeFileSync(path.join(ctx.workdir, "impl.js"), "module.exports = () => 42;\n");       // 自造源码(非测试路径)
          fs.writeFileSync(path.join(ctx.workdir, "impl.test.js"), "require('./impl');\n");           // 顺带自造测试
          return okResult("[test-evidence] node impl.test.js exit=0", [
            { path: "impl.js", changeType: "create" },
            { path: "impl.test.js", changeType: "create" },
          ]);
        },
      }, events);

      const verifierSpec: WorkerSpec = {
        agent: { id: "tester-3", role: "test", provider: "deepseek", model: "m", framework: "hermes", name: "tester-3" } as unknown as AgentNodeConfig,
        systemPrompt: "sys", userMessage: "验证", taskId: "t-verif-src", noCode: false, isVerifier: true,
      };
      const results = await runWorkersParallel([verifierSpec], deps);

      expect(results[0].fileChanges).toEqual([]);                              // 变更全清空
      expect(fs.existsSync(path.join(root, "impl.js"))).toBe(false);           // 自造源码绝不落地
      expect(fs.existsSync(path.join(root, "impl.test.js"))).toBe(false);      // 同批测试一并丢弃
      const discarded = events.filter((e) => e.p?.kind === "verifier_changes_discarded");
      expect(discarded).toHaveLength(1);
      expect(discarded[0].p.files).toContain("impl.js(create)");
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });

  it("P0-4(收窄)· verifier 纯【新建】测试文件(被指派的交付)→ 放行 merge,不误当自证丢弃", async () => {
    // 活体 060950d3 实证:lead 常把"写 X.test.js"派给 tester。它 create 新测试文件是合法交付,绝不能一并丢——
    // 否则测试文件进不了合同,DeliveryAcceptance 反判 missing_independent。断言:新建文件正常落地,无 discarded 事件。
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-guard-verif-create-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email "guard@test"');
      git('config user.name "guard"');
      fs.writeFileSync(path.join(root, "factorial.js"), "module.exports = (n) => n <= 1 ? 1 : n * module.exports(n - 1);\n"); // producer 已交付
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      git("add -A");
      git('commit -q -m "seed producer"');

      const events: Emitted[] = [];
      const deps = makeDeps({
        projectRoot: root,
        priorContractFiles: ["factorial.js"], // producer 已交付 factorial.js(合同非空)→ verifier 照常运行
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          // tester 只【新建】被指派的测试文件,不碰 producer 的 factorial.js
          fs.writeFileSync(path.join(ctx.workdir, "factorial.test.js"), "const f=require('./factorial');const a=require('assert');a.strictEqual(f(5),120);\n");
          return okResult("[test-evidence] node factorial.test.js exit=0", [{ path: "factorial.test.js", changeType: "create" }]);
        },
      }, events);

      const verifierSpec: WorkerSpec = {
        agent: { id: "tester-2", role: "test", provider: "deepseek", model: "m", framework: "hermes", name: "tester-2" } as unknown as AgentNodeConfig,
        systemPrompt: "sys", userMessage: "写 factorial.test.js 并运行验证", taskId: "t-verif-create", noCode: false, isVerifier: true,
      };
      const results = await runWorkersParallel([verifierSpec], deps);

      expect(results[0].ok).toBe(true);
      expect(results[0].fileChanges?.map((f) => f.path)).toEqual(["factorial.test.js"]); // 新建文件保留在交付里
      expect(fs.existsSync(path.join(root, "factorial.test.js"))).toBe(true);            // 真 merge 落地
      expect(fs.readFileSync(path.join(root, "factorial.js"), "utf-8")).toContain("n * module.exports"); // producer 文件原样
      expect(events.filter((e) => e.p?.kind === "verifier_changes_discarded")).toHaveLength(0); // 纯新建不触发丢弃
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  });
});

describe("A1-V3 · 超时抢救读回路径护栏(不留后门)", () => {
  it("[拦截] 超时 worker 的 scratch 抢救:.md 救回、.py 被拦,同样 emit permission_block", async () => {
    const events: Emitted[] = [];
    const deps = makeDeps({
      taskTimeoutMs: 300,
      taskTimeoutExplicit: true,
      execFn: (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
        fs.writeFileSync(path.join(ctx.workdir, "salvage.md"), "SALVAGE_OK_MARKER 抢救回的研究内容。".repeat(25));
        fs.writeFileSync(path.join(ctx.workdir, "evil.py"), "print('EVIL_PY_MARKER')".repeat(20));
        // 迟到完成但内容太薄(<300 字)→ 抢救走"工作区已写文件"读回路径
        return new Promise<ExecResult>((res) => setTimeout(() => res(okResult("late", [])), 700));
      },
    }, events);

    const results = await runWorkersParallel([spec("w-salvage", "researcher", true)], deps);

    expect(results[0].ok).toBe(true);
    expect(results[0].partial).toBe(true);
    expect(results[0].content).toContain("SALVAGE_OK_MARKER");
    expect(results[0].content).not.toContain("EVIL_PY_MARKER");

    const blocks = blockEvents(events);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].p.blockedFiles.map((b: any) => b.path)).toEqual(["evil.py"]);
  });
});
describe("project file-write permission", () => {
  it("rolls back external worker changes before merge when file writes are disabled", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-file-write-off-"));
    const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    try {
      git("init -q");
      git('config user.email "guard@test"');
      git('config user.name "guard"');
      fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
      fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
      fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({
        version: "0.1.0",
        projectName: "permission-test",
        apiKeys: {},
        defaultModel: "test-model",
        budget: { totalUsd: 0, maxTokensPerTask: 1000 },
        permissions: { allowShell: true, allowFileWrite: false, allowWebAccess: true },
      }));
      fs.writeFileSync(path.join(root, "seed.md"), "seed");
      git("add -A");
      git('commit -q -m "seed"');

      const events: Emitted[] = [];
      const deps = makeDeps({
        projectRoot: root,
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          fs.writeFileSync(path.join(ctx.workdir, "blocked.js"), "module.exports = 1;\n");
          return okResult("done", [{ path: "blocked.js", changeType: "create" }]);
        },
      }, events);

      const results = await runWorkersParallel([spec("w-write-off", "dev", false)], deps);

      expect(results[0].fileChanges ?? []).toEqual([]);
      expect(fs.existsSync(path.join(root, "blocked.js"))).toBe(false);
      const blocks = blockEvents(events);
      expect(blocks).toHaveLength(1);
      expect(blocks[0].p.blockedFiles).toEqual([
        { path: "blocked.js", rule: "file_write_disabled", detail: "permissions.allowFileWrite=false" },
      ]);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });
});
describe("verifier test-file ownership across review rounds", () => {
  async function runRevision(owned: boolean): Promise<{ root: string; results: Awaited<ReturnType<typeof runWorkersParallel>>; events: Emitted[] }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-verifier-owner-"));
    const git = (cmd: string) => execSync("git " + cmd, { cwd: root, encoding: "utf-8", stdio: "pipe" });
    git("init -q");
    git('config user.email "guard@test"');
    git('config user.name "guard"');
    fs.writeFileSync(path.join(root, "producer.js"), "module.exports = 1;" + String.fromCharCode(10));
    fs.writeFileSync(path.join(root, "producer.test.js"), "const value = require('./producer');" + String.fromCharCode(10) + "if (value !== 2) throw new Error('old assertion');" + String.fromCharCode(10));
    fs.writeFileSync(path.join(root, ".gitignore"), ".opc/" + String.fromCharCode(10));
    git("add -A");
    git('commit -q -m "seed"');

    const events: Emitted[] = [];
    const deps = makeDeps({
      projectRoot: root,
      priorContractFiles: ["producer.js", "producer.test.js"],
      verifierOwnedTestPathsByAgent: owned ? { "tester-owner": ["producer.test.js"] } : {},
      execFn: async (_agent: AgentNodeConfig, _task: ExecTask, ctx: ExecContext) => {
        fs.writeFileSync(path.join(ctx.workdir, "producer.test.js"), "const value = require('./producer');" + String.fromCharCode(10) + "if (value !== 1) throw new Error('bad');" + String.fromCharCode(10));
        return okResult("[test-evidence] node producer.test.js exit=0", [
          { path: "producer.test.js", changeType: "modify" },
        ]);
      },
    }, events);
    const verifier: WorkerSpec = {
      agent: { id: "tester-owner", role: "test", provider: "deepseek", model: "m", framework: "hermes", name: "tester-owner" } as AgentNodeConfig,
      systemPrompt: "sys",
      userMessage: "revise the failed assertion",
      taskId: "test/revision",
      noCode: false,
      isVerifier: true,
    };
    return { root, results: await runWorkersParallel([verifier], deps), events };
  }

  it("verifier may revise only its own previously accepted test", async () => {
    const { root, results, events } = await runRevision(true);
    try {
      expect(results[0].ok).toBe(true);
      expect(results[0].fileChanges).toEqual([{ path: "producer.test.js", changeType: "modify" }]);
      expect(fs.readFileSync(path.join(root, "producer.test.js"), "utf-8")).toContain("value !== 1");
      expect(events.filter((event) => event.p?.kind === "verifier_changes_discarded")).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("verifier cannot revise a producer-owned test", async () => {
    const { root, results, events } = await runRevision(false);
    try {
      expect(results[0].ok).toBe(true);
      expect(results[0].fileChanges).toEqual([]);
      expect(fs.readFileSync(path.join(root, "producer.test.js"), "utf-8")).toContain("value !== 2");
      expect(events.filter((event) => event.p?.kind === "verifier_changes_discarded")).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
