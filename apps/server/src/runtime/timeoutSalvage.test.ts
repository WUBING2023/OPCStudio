// ⏱️ 分层 deadline + 超时抢救(Phase 1)测试:
// ① roleProfile 按角色时限(引擎层超时抢救 timedOutPartial 语义见 engines/ApiEngine.test.ts)
// ③ parallelExecutor 外层兜底抢救(迟到完成 / 工作区文件)与太薄不救 ④ in-band partial 走正常交付链
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { research_profile_v1, fact_check_profile_v1, lead_profile_v1, code_profile_v1, getProfileForRole } from "./roleProfile.js";
import { runWorkersParallel, type ParallelDeps, type WorkerSpec } from "./parallelExecutor.js";
import { Semaphore } from "./pool/semaphore.js";
import { evaluateDeliveryAcceptance, deriveFinalRunState } from "./deliveryAcceptance.js";
import type { ExecResult } from "@opc/shared";

// ── ① 按角色时限 ────────────────────────────────────────────────────────────
describe("roleProfile · 按角色任务时限", () => {
  it("四档 profile 都有正时限,且 核查 < 汇总 < 研究 < 代码", () => {
    for (const p of [research_profile_v1, fact_check_profile_v1, lead_profile_v1, code_profile_v1]) {
      expect(p.taskTimeoutMs).toBeGreaterThan(0);
    }
    expect(fact_check_profile_v1.taskTimeoutMs).toBeLessThan(lead_profile_v1.taskTimeoutMs);
    expect(lead_profile_v1.taskTimeoutMs).toBeLessThan(research_profile_v1.taskTimeoutMs);
    expect(research_profile_v1.taskTimeoutMs).toBeLessThan(code_profile_v1.taskTimeoutMs);
  });
  it("研究角色时限 ≥ 600s(通宵实验:360s 仍 3/5 超时)", () => {
    expect(getProfileForRole("researcher").taskTimeoutMs).toBeGreaterThanOrEqual(600_000);
  });
});

// ── ③/④ parallelExecutor 兜底抢救 ────────────────────────────────────────────
function makeDeps(overrides: Partial<ParallelDeps>, events: unknown[]): ParallelDeps {
  return {
    projectRoot: fs.mkdtempSync(path.join(os.tmpdir(), "salv-root-")),
    scheduler: { acquire: async () => ({ account: { id: "acct-1" }, release: () => {} }) } as any,
    semaphore: new Semaphore(4),
    baseline: {} as any,
    maxAttempts: 1,
    taskTimeoutMs: 100,
    taskTimeoutExplicit: true, // 测试用显式小时限(否则按角色 profile 是分钟级)
    maxTokensPerTask: 1000,
    runId: "salvage-test-run",
    accountUsage: {},
    emit: (t, a, p) => events.push({ t, a, p }),
    execFn: undefined as any,
    ...overrides,
  };
}
const spec = (id: string): WorkerSpec => ({
  agent: { id, role: "researcher", provider: "deepseek", model: "m", framework: "api", name: id } as any,
  systemPrompt: "sys", userMessage: "task", taskId: `t-${id}`, noCode: true,
});
const okResult = (content: string, partial = false): ExecResult =>
  ({ content, fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 1, status: "done", ...(partial ? { partial: true } : {}) });

describe("parallelExecutor · 超时抢救兜底", () => {
  it("[迟到完成] 外层超时但 detached run 稍后完成 → 替换 deferred 为 ok+partial,内容带显式标头", async () => {
    const events: unknown[] = [];
    const content = "深度研究成果段落,包含来源与分析。".repeat(30); // ≥300 字
    const deps = makeDeps({ execFn: () => new Promise((res) => setTimeout(() => res(okResult(content)), 300)) }, events);
    const results = await runWorkersParallel([spec("w1")], deps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].partial).toBe(true);
    expect(results[0].content).toContain("部分产物");
    expect(events.some((e: any) => e.p?.kind === "timeout_salvage")).toBe(true);
  });

  it("[工作区文件] detached run 失败但已写文件 ≥300字 → 从 scratch 文件抢救", async () => {
    const events: unknown[] = [];
    const deps = makeDeps({
      execFn: (_a, _t, ctx) => {
        fs.writeFileSync(path.join(ctx.workdir, "report.md"), "抢救回的文件内容,一节一节写入。".repeat(30));
        return new Promise((_res, rej) => setTimeout(() => rej(new Error("killed")), 250));
      },
    }, events);
    const results = await runWorkersParallel([spec("w2")], deps);
    expect(results[0].ok).toBe(true);
    expect(results[0].partial).toBe(true);
    expect(results[0].content).toContain("report.md");
  });

  it("[太薄不救] 迟到内容 <300字 且无文件 → 维持 deferred(reason=timeout),不假装有产出", async () => {
    const events: unknown[] = [];
    const deps = makeDeps({ execFn: () => new Promise((res) => setTimeout(() => res(okResult("太少")), 250)) }, events);
    const results = await runWorkersParallel([spec("w3")], deps);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("timeout");
  });

  it("[in-band partial] 引擎层已抢救(status=done+partial)→ 走正常交付链,内容带标头、结果保 partial 标志", async () => {
    const events: unknown[] = [];
    const deps = makeDeps({ taskTimeoutMs: 5_000, execFn: async () => okResult("引擎层抢救回的部分研究内容。".repeat(30), true) }, events);
    const results = await runWorkersParallel([spec("w4")], deps);
    expect(results[0].ok).toBe(true);
    expect(results[0].partial).toBe(true);
    expect(results[0].content).toContain("部分产物");
  });

  it("[引擎层超时错误] status=failed 且 error 含 timed out → deferred.reason 如实记 timeout(不再混入 retry_budget_exhausted)", async () => {
    const events: unknown[] = [];
    const deps = makeDeps({ taskTimeoutMs: 5_000, execFn: async () => ({ ...okResult(""), status: "failed" as const, error: "API tool loop timed out after 580000ms" }) }, events);
    const results = await runWorkersParallel([spec("w5")], deps);
    expect(results[0].ok).toBe(false);
    expect(results[0].deferred?.reason).toBe("timeout");
  });
});

// ── D2(已拍板)· run 级契约成对更新 ─────────────────────────────────────────────
// 抢救文本仍保留(上方用例:ok:true + partial)、抢救 worker 仍不进 deferred(它交付了,只是不完整);
// 但 run 级必须留下 partial 痕迹且最终态至少 degraded——含 partial 的 run 绝不纯净 done。
describe("D2 · 超时抢救的 run 级痕迹(partialDelivery + finalState 至少 degraded)", () => {
  it("非编码 run 含 partial → DeliveryAcceptance=not_required 但带 partialDelivery:true(不再纯净通过)", () => {
    const da = evaluateDeliveryAcceptance({
      requiresCode: false, requiresTests: false,
      workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "salv-da-")),
      allChanges: [], testEvidence: [],
      hasPartialSalvage: true, // ← orchestrator 由 partialAgents(抢救/in-band partial worker)派生
    });
    expect(da.status).toBe("not_required"); // 抢救文本仍保留为部分结果(status 语义冻结)
    expect(da.partialDelivery).toBe(true);  // 但 run 级痕迹绝不消失
  });

  it("全员超时抢救的研究型 run:status 可 done,但 finalState 收敛为 degraded(绝不 verified)", () => {
    const da = evaluateDeliveryAcceptance({
      requiresCode: false, requiresTests: false,
      workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "salv-da2-")),
      allChanges: [], testEvidence: [], hasPartialSalvage: true,
    });
    const finalState = deriveFinalRunState({ status: "done", deliveryAcceptance: da, partialDelivery: true });
    expect(finalState).toBe("degraded");
  });

  it("对照:同 run 无 partial → finalState=verified(基线不误伤)", () => {
    const da = evaluateDeliveryAcceptance({
      requiresCode: false, requiresTests: false,
      workRoot: fs.mkdtempSync(path.join(os.tmpdir(), "salv-da3-")),
      allChanges: [], testEvidence: [],
    });
    expect(deriveFinalRunState({ status: "done", deliveryAcceptance: da })).toBe("verified");
  });
});
