import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../storage/projectStore.js";
import { loadCompanies } from "../storage/companyStore.js";

// Stage 10 · 成本可见(产品契约第 7 动作)+ 预算状态。纯派生:扫 .opc/runs/*/{cost.json,task.json}。
// 复用已有计账(CallRecord/Run),零新写路径、NEVER throws。

interface CallRecord {
  agentId?: string; provider?: string; model?: string;
  totalTokens?: number; estimatedCostUsd?: number;
}
interface RunMeta {
  id?: string; userGoal?: string; startedAt?: string; endedAt?: string;
  totalTokens?: number; totalCostUsd?: number; participatingAgents?: string[]; degraded?: boolean;
  companyId?: string; // v2:该 run 归属的公司(维度栏·公司过滤用;旧 run 无此字段=只在"全部"里可见)
}

export interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  runCount: number;
  byProvider: Array<{ provider: string; costUsd: number; tokens: number; calls: number }>;
  byModel: Array<{ model: string; costUsd: number; tokens: number; calls: number }>;
  byAgent: Array<{ agentId: string; costUsd: number; tokens: number; calls: number }>;
  byCompany: Array<{ companyId: string; costUsd: number; tokens: number; runs: number }>;
  recentRuns: Array<{ runId: string; startedAt?: string; goal: string; costUsd: number; tokens: number; agentCount: number; degraded: boolean }>;
  computedAt: string;
}

function readJSON<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return null; }
}

export function computeCostSummary(projectRoot: string, opts?: { since?: string; until?: string; month?: string; company?: string; limit?: number; now?: string }): CostSummary {
  const limit = opts?.limit ?? 50;
  const month = opts?.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : undefined; // 维度栏·时间(本月/上月);"全部"不传 → undefined
  const empty: CostSummary = { totalCostUsd: 0, totalTokens: 0, runCount: 0, byProvider: [], byModel: [], byAgent: [], byCompany: [], recentRuns: [], computedAt: opts?.now ?? "" };
  try {
    const runsDir = path.join(projectRoot, ".opc", "runs");
    if (!fs.existsSync(runsDir)) return empty;
    const prov = new Map<string, { costUsd: number; tokens: number; calls: number }>();
    const model = new Map<string, { costUsd: number; tokens: number; calls: number }>();
    const agent = new Map<string, { costUsd: number; tokens: number; calls: number }>();
    const company = new Map<string, { costUsd: number; tokens: number; runs: number }>();
    const runs: CostSummary["recentRuns"] = [];
    let totalCostUsd = 0, totalTokens = 0, runCount = 0;

    for (const d of fs.readdirSync(runsDir)) {
      const runDir = path.join(runsDir, d);
      const task = readJSON<RunMeta>(path.join(runDir, "task.json"));
      // since 过滤对称:有 since 时,无 task.json/无 startedAt 或早于 since 的 run 一律排除(避免缺 task 的 run 绕过过滤只进明细)。
      if (opts?.since && (!task?.startedAt || task.startedAt < opts.since)) continue;
      if (opts?.until && (!task?.startedAt || task.startedAt > opts.until)) continue;
      // 维度栏·时间:按月精确匹配(同 computeRunLedger 的 month 语义),同一 run 的 calls 一并跳过。
      if (month && (!task?.startedAt || task.startedAt.slice(0, 7) !== month)) continue;
      // 维度栏·公司:按 run 归属公司(旧 run 无 companyId 时,选定具体公司会被排除,只在"全部"里可见——与 /api/runs?company= 同一约定)。
      if (opts?.company && task?.companyId !== opts.company) continue;
      if (task) {
        runCount++;
        totalCostUsd += task.totalCostUsd ?? 0;
        totalTokens += task.totalTokens ?? 0;
        const companyKey = task.companyId || "unassigned";
        const companyBucket = company.get(companyKey) ?? { costUsd: 0, tokens: 0, runs: 0 };
        companyBucket.costUsd += task.totalCostUsd ?? 0; companyBucket.tokens += task.totalTokens ?? 0; companyBucket.runs += 1; company.set(companyKey, companyBucket);
        runs.push({ runId: task.id ?? d, startedAt: task.startedAt, goal: (task.userGoal ?? "").slice(0, 80), costUsd: task.totalCostUsd ?? 0, tokens: task.totalTokens ?? 0, agentCount: task.participatingAgents?.length ?? 0, degraded: !!task.degraded });
      }
      const calls = readJSON<CallRecord[]>(path.join(runDir, "cost.json"));
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const cost = c.estimatedCostUsd ?? 0, tok = c.totalTokens ?? 0;
          const bump = (m: Map<string, any>, k: string) => { const e = m.get(k) ?? { costUsd: 0, tokens: 0, calls: 0 }; e.costUsd += cost; e.tokens += tok; e.calls += 1; m.set(k, e); };
          // 缺字段归 "unknown",让明细加总更贴近表头(审查②:减少对账缺口)。
          bump(prov, c.provider || "unknown");
          bump(model, c.model || "unknown");
          bump(agent, c.agentId || "unknown");
        }
      }
    }
    runs.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
    const toArr = <K extends string>(m: Map<string, any>, key: K) =>
      [...m.entries()].map(([k, v]) => ({ [key]: k, ...v })).sort((a: any, b: any) => b.tokens - a.tokens) as any;
    return {
      totalCostUsd, totalTokens, runCount,
      byProvider: toArr(prov, "provider"),
      byModel: toArr(model, "model"),
      byAgent: toArr(agent, "agentId"),
      byCompany: toArr(company, "companyId"),
      recentRuns: runs.slice(0, limit),
      computedAt: opts?.now ?? "",
    };
  } catch { return empty; }
}

// Stage F · 月度时间序列:当月每天 × provider 的 token / 估算 $,供堆叠柱状图。纯派生扫 cost.json。
// Stage F · 账单式运行台账(分页)。从 task.json 派生,按 startedAt 倒序,带总数供翻页。
export interface RunLedgerRow {
  runId: string; startedAt?: string; endedAt?: string; goal: string;
  costUsd: number; tokens: number; agentCount: number; degraded: boolean; status?: string;
}
export interface RunLedger { rows: RunLedgerRow[]; total: number; offset: number; limit: number; computedAt: string }

export function computeRunLedger(projectRoot: string, opts?: { offset?: number; limit?: number; since?: string; until?: string; month?: string; company?: string; now?: string }): RunLedger {
  const offset = Math.max(0, opts?.offset ?? 0);
  const limit = Math.max(1, Math.min(200, opts?.limit ?? 25));
  const month = opts?.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : undefined; // YYYY-MM 过滤(账单按月)
  const all: RunLedgerRow[] = [];
  try {
    const runsDir = path.join(projectRoot, ".opc", "runs");
    if (fs.existsSync(runsDir)) {
      for (const d of fs.readdirSync(runsDir)) {
        const t = readJSON<RunMeta & { status?: string }>(path.join(runsDir, d, "task.json"));
        if (!t) continue;
        if (opts?.since && (!t.startedAt || t.startedAt < opts.since)) continue;
        if (opts?.until && (!t.startedAt || t.startedAt > opts.until)) continue;
        if (month && (t.startedAt ?? "").slice(0, 7) !== month) continue; // 按月过滤(无 startedAt 的 run 也排除)
        // 维度栏·公司:旧 run 无 companyId 时,选定具体公司会被排除,只在"全部"里可见(与 /api/runs?company= 同一约定)。
        if (opts?.company && t.companyId !== opts.company) continue;
        all.push({ runId: t.id ?? d, startedAt: t.startedAt, endedAt: t.endedAt, goal: (t.userGoal ?? "").slice(0, 120), costUsd: t.totalCostUsd ?? 0, tokens: t.totalTokens ?? 0, agentCount: t.participatingAgents?.length ?? 0, degraded: !!t.degraded, status: (t as any).status });
      }
    }
  } catch { /* best-effort */ }
  all.sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""));
  return { rows: all.slice(offset, offset + limit), total: all.length, offset, limit, computedAt: opts?.now ?? "" };
}

export interface CostTimeseries {
  period: string;            // "2026-06"
  metric: "tokens" | "cost";
  providers: string[];       // 出现过的 provider(图例/配色)
  days: Array<{ date: string; byProvider: Record<string, number>; total: number }>;
  monthTotal: number;
  computedAt: string;
}

function ym(d: Date): string { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; }
function daysInMonth(year: number, month1: number): number { return new Date(year, month1, 0).getDate(); }

export function computeCostTimeseries(projectRoot: string, opts?: { month?: string; since?: string; until?: string; all?: boolean; metric?: "tokens" | "cost"; company?: string; now?: Date }): CostTimeseries {
  const metric: "tokens" | "cost" = opts?.metric === "cost" ? "cost" : "tokens";
  const now = opts?.now ?? new Date();
  const month = opts?.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : undefined;
  const since = opts?.since;
  const until = opts?.until;
  const period = month ?? (since || until ? `${(since ?? "start").slice(0, 10)} - ${(until ?? "now").slice(0, 10)}` : opts?.all ? "all" : ym(now));
  const dayMap = new Map<string, Record<string, number>>();
  if (month) {
    const [py, pm] = month.split("-").map(Number);
    for (let d = 1; d <= daysInMonth(py, pm); d++) dayMap.set(`${month}-${String(d).padStart(2, "0")}`, {});
  } else if (since && until) {
    const cursor = new Date(`${since.slice(0, 10)}T00:00:00`);
    const end = new Date(`${until.slice(0, 10)}T00:00:00`);
    for (let guard = 0; cursor <= end && guard < 3660; guard++) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}-${String(cursor.getDate()).padStart(2, "0")}`;
      dayMap.set(key, {});
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  const providerSet = new Set<string>();
  let monthTotal = 0;
  try {
    const runsDir = path.join(projectRoot, ".opc", "runs");
    if (fs.existsSync(runsDir)) {
      for (const dir of fs.readdirSync(runsDir)) {
        if (opts?.company) {
          const task = readJSON<RunMeta>(path.join(runsDir, dir, "task.json"));
          if (task?.companyId !== opts.company) continue;
        }
        const calls = readJSON<Array<CallRecord & { startedAt?: string }>>(path.join(runsDir, dir, "cost.json"));
        if (!Array.isArray(calls)) continue;
        for (const c of calls) {
          const at = c.startedAt;
          if (!at) continue;
          if (month && at.slice(0, 7) !== month) continue;
          if (since && at < since) continue;
          if (until && at > until) continue;
          const dayKey = at.slice(0, 10);
          if (!dayMap.has(dayKey) && (opts?.all || (!month && !since && !until))) dayMap.set(dayKey, {});
          const bucket = dayMap.get(dayKey);
          if (!bucket) continue;
          const provider = c.provider || "unknown";
          const value = metric === "cost" ? (c.estimatedCostUsd ?? 0) : (c.totalTokens ?? 0);
          bucket[provider] = (bucket[provider] ?? 0) + value;
          providerSet.add(provider);
          monthTotal += value;
        }
      }
    }
  } catch { /* best-effort */ }
  const days = [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, byProvider]) => ({
    date, byProvider, total: Object.values(byProvider).reduce((sum, value) => sum + value, 0),
  }));
  return { period, metric, providers: [...providerSet].sort(), days, monthTotal, computedAt: opts?.now ? "" : new Date().toISOString() };
}

export interface BudgetStatus {
  maxTokensTotal: number;
  usedTokens: number;
  pctTokens: number;
  maxTokensPerRun: number;
  edition: "personal" | "pro" | "enterprise";
  overTokensTotal: boolean;
  companyBudgets: Array<{ companyId: string; companyName: string; maxTokensTotal: number; usedTokens: number; pctTokens: number; overTokensTotal: boolean }>;
}

export function enforceCompanyTokenLimit(projectRoot: string, companyId: string): { usedTokens: number; maxTokensTotal: number } {
  const maxTokensTotal = loadCompanies(projectRoot).find(company => company.id === companyId)?.maxTokensTotal ?? 0;
  const usedTokens = maxTokensTotal > 0 ? computeCostSummary(projectRoot, { company: companyId }).totalTokens : 0;
  if (maxTokensTotal > 0 && usedTokens >= maxTokensTotal) {
    throw new Error(`Company token limit exceeded: ${usedTokens} of ${maxTokensTotal} for ${companyId}.`);
  }
  return { usedTokens, maxTokensTotal };
}

export function computeBudgetStatus(projectRoot: string): BudgetStatus {
  const cfg = loadConfig(projectRoot);
  const b = cfg.budget;
  const usedTokens = computeCostSummary(projectRoot).totalTokens;
  const maxTokensTotal = b.maxTokensTotal ?? 0;
  const companyBudgets = loadCompanies(projectRoot).map(company => {
    const companyUsed = computeCostSummary(projectRoot, { company: company.id }).totalTokens;
    const companyLimit = company.maxTokensTotal ?? 0;
    return { companyId: company.id, companyName: company.name, maxTokensTotal: companyLimit, usedTokens: companyUsed, pctTokens: companyLimit > 0 ? Math.min(1, companyUsed / companyLimit) : 0, overTokensTotal: companyLimit > 0 && companyUsed >= companyLimit };
  });
  return {
    maxTokensTotal,
    usedTokens,
    pctTokens: maxTokensTotal > 0 ? Math.min(1, usedTokens / maxTokensTotal) : 0,
    maxTokensPerRun: b.maxTokensPerRun ?? 0,
    edition: (cfg as any).edition ?? "personal",
    overTokensTotal: maxTokensTotal > 0 && usedTokens >= maxTokensTotal,
    companyBudgets,
  };
}
