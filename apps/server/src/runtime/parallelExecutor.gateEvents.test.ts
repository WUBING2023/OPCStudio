// #21(质量复检):代码质量门(tsc/test)失败不再只把 gateSummary 文本塞进 deferred.lastError——
// 终局失败(耗尽尝试)时补发结构化 quality_gate_result 事件(A5 计划点名的路径);
// 中途失败但重试通过则不发(避免下游按次记账的消费方重复计罚)。
// 用真实 git worktree + 真实 runQualityGate(npm test 由种子 package.json 的 exit 1/0 脚本决定成败)。
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";

interface Emitted { t: string; a?: string; p: any }

function seedGitRepo(testScript: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pe-gate-ev-"));
  const git = (cmd: string) => execSync(`git ${cmd}`, { cwd: root, encoding: "utf-8", stdio: "pipe" });
  git("init -q");
  git('config user.email "gate@test"');
  git('config user.name "gate"');
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "gate-fixture", version: "1.0.0", scripts: { test: testScript } }, null, 2));
  fs.writeFileSync(path.join(root, ".gitignore"), ".opc/\n");
  git("add -A");
  git('commit -q -m "seed"');
  return root;
}

function makeDeps(root: string, events: Emitted[], over: Partial<ParallelDeps>): ParallelDeps {
  return {
    projectRoot: root,
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }), reportOutcome: () => {} } as any,
    semaphore: new Semaphore(2),
    baseline: { typeErrors: 0, testsRan: true, testsPassed: true }, // 基线绿 → 测试挂了就是 worker 引入的回归
    maxAttempts: 1,
    taskTimeoutMs: 120_000,
    maxTokensPerTask: 1000,
    runId: "gate-ev-run",
    accountUsage: {},
    emit: (t, a, p) => events.push({ t, a, p: p as any }),
    execFn: undefined as any,
    ...over,
  };
}

const okResult = (content: string, fileChanges: ExecResult["fileChanges"]): ExecResult =>
  ({ content, fileChanges, tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "done" });

const devSpec = (): WorkerSpec => ({
  agent: { id: "w-code", role: "dev", provider: "deepseek", model: "m", framework: "hermes", name: "w-code" } as unknown as AgentNodeConfig,
  systemPrompt: "sys",
  userMessage: "task",
  taskId: "t-code",
  noCode: false,
});

describe("#21 · 代码质量门失败 → 结构化 quality_gate_result 事件", () => {
  it("终局失败(耗尽尝试):defer 之外 emit 一条 quality_gate_result(stage=admission,机械层带完整 gate 细节)", async () => {
    const root = seedGitRepo("exit 1");
    try {
      const events: Emitted[] = [];
      const deps = makeDeps(root, events, {
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          fs.writeFileSync(path.join(ctx.workdir, "bad.ts"), "export const x = 1;\n");
          return okResult("改了代码", [{ path: "bad.ts", changeType: "create" }]);
        },
      });

      const results = await runWorkersParallel([devSpec()], deps);

      expect(results).toHaveLength(1);
      expect(results[0].ok).toBe(false);
      expect(results[0].deferred?.reason).toBe("quality_gate_failed");

      const gateEvents = events.filter((e) => e.t === "quality_gate_result");
      expect(gateEvents).toHaveLength(1);
      expect(gateEvents[0].a).toBe("w-code");
      const p = gateEvents[0].p;
      expect(p.passed).toBe(false);
      expect(p.stage).toBe("admission");
      expect(p.producer).toBe("w-code");
      expect(p.failedLayer).toBe(1);
      expect(p.layerResults).toHaveLength(3);
      expect(p.layerResults[0]).toMatchObject({ layer: 1, name: "mechanical", passed: false });
      expect(p.layerResults[0].details?.tests).toMatchObject({ ran: true, passed: false }); // 结构化细节,不再只有一句文本
      expect(p.overallReason).toContain("测试");
      expect(p.overallReason).toBe(results[0].deferred?.lastError); // 事件与 deferred 记录同源
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  }, 180_000);

  it("中途失败但重试通过:不发 quality_gate_result(不给按次记账的消费方重复计罚的机会)", async () => {
    const root = seedGitRepo("exit 1");
    try {
      const events: Emitted[] = [];
      let attempt = 0;
      const deps = makeDeps(root, events, {
        maxAttempts: 2,
        execFn: async (_a: AgentNodeConfig, _t: ExecTask, ctx: ExecContext) => {
          attempt++;
          fs.writeFileSync(path.join(ctx.workdir, "bad.ts"), "export const x = 1;\n");
          if (attempt === 1) {
            return okResult("第一次:测试仍挂", [{ path: "bad.ts", changeType: "create" }]);
          }
          const pkgPath = path.join(ctx.workdir, "package.json");
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
          pkg.scripts.test = "exit 0";
          fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
          return okResult("第二次:修好了测试", [
            { path: "bad.ts", changeType: "create" },
            { path: "package.json", changeType: "modify" },
          ]);
        },
      });

      const results = await runWorkersParallel([devSpec()], deps);

      expect(attempt).toBe(2);
      expect(results[0].ok).toBe(true);
      expect(events.filter((e) => e.t === "quality_gate_result")).toHaveLength(0);
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 文件锁,尽力而为 */ }
    }
  }, 180_000);
});
