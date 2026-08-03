import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeCostSummary, computeBudgetStatus, computeCostTimeseries, computeRunLedger, enforceCompanyTokenLimit } from "./costSummary.js";

function setup(runs: Array<{ id: string; task?: any; calls?: any[] }>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cost-"));
  for (const r of runs) {
    const dir = path.join(root, ".opc", "runs", r.id);
    fs.mkdirSync(dir, { recursive: true });
    if (r.task) fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(r.task));
    if (r.calls) fs.writeFileSync(path.join(dir, "cost.json"), JSON.stringify(r.calls));
  }
  return root;
}

describe("Stage 10 · computeCostSummary 聚合", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("按 provider/model/agent/run 聚合 + 总计 + recentRuns 倒序", () => {
    root = setup([
      { id: "r1", task: { id: "r1", userGoal: "任务A", startedAt: "2026-06-30T01:00:00Z", totalCostUsd: 0.5, totalTokens: 1000, participatingAgents: ["ceo", "lead"] },
        calls: [{ agentId: "ceo", provider: "deepseek", model: "deepseek-v4-pro", totalTokens: 600, estimatedCostUsd: 0.3 }, { agentId: "lead", provider: "anthropic", model: "sonnet", totalTokens: 400, estimatedCostUsd: 0.2 }] },
      { id: "r2", task: { id: "r2", userGoal: "任务B", startedAt: "2026-06-30T02:00:00Z", totalCostUsd: 0.1, totalTokens: 200, participatingAgents: ["ceo"], degraded: true },
        calls: [{ agentId: "ceo", provider: "deepseek", model: "deepseek-v4-pro", totalTokens: 200, estimatedCostUsd: 0.1 }] },
    ]);
    const s = computeCostSummary(root);
    expect(s.runCount).toBe(2);
    expect(s.totalCostUsd).toBeCloseTo(0.6);
    expect(s.totalTokens).toBe(1200);
    const ds = s.byProvider.find(p => p.provider === "deepseek");
    expect(ds?.costUsd).toBeCloseTo(0.4); expect(ds?.calls).toBe(2);
    expect(s.byModel.find(m => m.model === "sonnet")?.tokens).toBe(400);
    expect(s.byAgent.find(a => a.agentId === "ceo")?.calls).toBe(2);
    // recentRuns 倒序(r2 先)
    expect(s.recentRuns[0].runId).toBe("r2");
    expect(s.recentRuns[0].degraded).toBe(true);
  });

  it("aggregates company usage and honors an inclusive end boundary", () => {
    root = setup([
      { id: "c1-run", task: { id: "c1-run", companyId: "c1", startedAt: "2026-07-10T10:00:00.000Z", totalTokens: 700, totalCostUsd: 0 } },
      { id: "c2-run", task: { id: "c2-run", companyId: "c2", startedAt: "2026-07-11T10:00:00.000Z", totalTokens: 900, totalCostUsd: 0 } },
    ]);
    const summary = computeCostSummary(root, { until: "2026-07-10T23:59:59.999Z" });
    expect(summary.runCount).toBe(1);
    expect(summary.byCompany).toEqual([{ companyId: "c1", costUsd: 0, tokens: 700, runs: 1 }]);
  });

  it("since 过滤 + 空目录不抛错", () => {
    root = setup([{ id: "old", task: { id: "old", startedAt: "2026-01-01T00:00:00Z", totalCostUsd: 9 } }]);
    expect(computeCostSummary(root, { since: "2026-06-01T00:00:00Z" }).runCount).toBe(0);
    expect(computeCostSummary(fs.mkdtempSync(path.join(os.tmpdir(), "empty-"))).runCount).toBe(0);
  });
});

describe("Stage F · computeCostTimeseries(月度按天×provider)", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("当月每天都有桶,按 provider 堆叠,只算目标月", () => {
    root = setup([
      { id: "r1", calls: [
        { agentId: "a", provider: "deepseek", model: "m", totalTokens: 1000, estimatedCostUsd: 0.5, startedAt: "2026-06-03T01:00:00Z" },
        { agentId: "b", provider: "anthropic", model: "s", totalTokens: 2000, estimatedCostUsd: 0, startedAt: "2026-06-03T02:00:00Z" },
      ] },
      { id: "r2", calls: [{ agentId: "a", provider: "deepseek", model: "m", totalTokens: 500, estimatedCostUsd: 0.2, startedAt: "2026-06-10T01:00:00Z" }] },
      { id: "old", calls: [{ agentId: "a", provider: "deepseek", model: "m", totalTokens: 9999, estimatedCostUsd: 9, startedAt: "2026-05-01T01:00:00Z" }] },
    ]);
    const ts = computeCostTimeseries(root, { month: "2026-06", metric: "tokens" });
    expect(ts.period).toBe("2026-06");
    expect(ts.days.length).toBe(30); // 6 月 30 天,空天也在
    expect(ts.providers).toEqual(["anthropic", "deepseek"]);
    expect(ts.monthTotal).toBe(3500); // 不含 5 月的 9999
    const d3 = ts.days.find(d => d.date === "2026-06-03")!;
    expect(d3.byProvider.deepseek).toBe(1000);
    expect(d3.byProvider.anthropic).toBe(2000);
    expect(d3.total).toBe(3000);
    expect(ts.days.find(d => d.date === "2026-06-10")!.byProvider.deepseek).toBe(500);
    // metric=cost
    expect(computeCostTimeseries(root, { month: "2026-06", metric: "cost" }).monthTotal).toBeCloseTo(0.7);
  });
});

describe("Stage F · computeRunLedger 分页台账", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("按 startedAt 倒序 + 分页 + total", () => {
    root = setup(Array.from({ length: 7 }, (_, i) => ({
      id: `r${i}`, task: { id: `r${i}`, userGoal: `任务${i}`, startedAt: `2026-06-${String(10 + i).padStart(2, "0")}T01:00:00Z`, totalCostUsd: i * 0.1, totalTokens: i * 100, participatingAgents: ["ceo"] },
    })));
    const p0 = computeRunLedger(root, { offset: 0, limit: 3 });
    expect(p0.total).toBe(7);
    expect(p0.rows.length).toBe(3);
    expect(p0.rows[0].runId).toBe("r6"); // 最新在前
    const p1 = computeRunLedger(root, { offset: 3, limit: 3 });
    expect(p1.rows[0].runId).toBe("r3");
    expect(computeRunLedger(root, { offset: 6, limit: 3 }).rows.length).toBe(1); // 末页
  });
});

describe("computeBudgetStatus · token-only", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("returns token usage and ignores legacy monetary limits", () => {
    root = setup([{ id: "r1", task: { id: "r1", startedAt: "2026-06-30T01:00:00Z", totalCostUsd: 8, totalTokens: 5000 } }]);
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({
      budget: { totalUsd: 10, maxTokensPerTask: 200000, maxTokensTotal: 4000, maxCostPerRun: 2, maxTokensPerRun: 3000 },
    }));
    const st = computeBudgetStatus(root);
    expect(st).toEqual({
      maxTokensTotal: 4000,
      usedTokens: 5000,
      pctTokens: 1,
      maxTokensPerRun: 3000,
      edition: "personal",
      overTokensTotal: true,
      companyBudgets: [],
    });
    expect(st).not.toHaveProperty("usedUsd");
    expect(st).not.toHaveProperty("maxCostPerRun");
  });

  it("reports company-scoped limits from persisted company configuration", () => {
    root = setup([{ id: "r1", task: { id: "r1", companyId: "c1", startedAt: "2026-07-10T00:00:00Z", totalTokens: 1250 } }]);
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([{ id: "c1", name: "Alpha", description: "", createdAt: "2026-07-01T00:00:00Z", maxTokensTotal: 1000 }]));
    expect(computeBudgetStatus(root).companyBudgets).toEqual([{ companyId: "c1", companyName: "Alpha", maxTokensTotal: 1000, usedTokens: 1250, pctTokens: 1, overTokensTotal: true }]);
  });

  it("blocks a new run once its company reaches the configured token limit", () => {
    root = setup([{ id: "r1", task: { id: "r1", companyId: "c1", startedAt: "2026-07-10T00:00:00Z", totalTokens: 1250 } }]);
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([{ id: "c1", name: "Alpha", description: "", createdAt: "2026-07-01T00:00:00Z", maxTokensTotal: 1000 }]));
    expect(() => enforceCompanyTokenLimit(root, "c1")).toThrow("Company token limit exceeded");
    expect(enforceCompanyTokenLimit(root, "unknown")).toEqual({ usedTokens: 0, maxTokensTotal: 0 });
  });
});
