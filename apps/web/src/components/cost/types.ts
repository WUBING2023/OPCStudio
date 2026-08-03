// Cost page · shared response shapes (mirrors apps/server/src/runtime/costSummary.ts — read-only
// mirror, server is not touched from this app).
export interface Bucket { costUsd: number; tokens: number; calls: number }
export interface CostSummary {
  totalCostUsd: number; totalTokens: number; runCount: number;
  byProvider: Array<Bucket & { provider: string }>;
  byModel: Array<Bucket & { model: string }>;
  byAgent: Array<Bucket & { agentId: string }>;
  byCompany: Array<{ companyId: string; costUsd: number; tokens: number; runs: number }>;
  recentRuns: Array<{ runId: string; startedAt?: string; goal: string; costUsd: number; tokens: number; agentCount: number; degraded: boolean }>;
}
export interface BudgetStatus {
  maxTokensTotal: number; usedTokens: number; pctTokens: number;
  maxTokensPerRun: number; edition: string; overTokensTotal: boolean;
  companyBudgets: Array<{ companyId: string; companyName: string; maxTokensTotal: number; usedTokens: number; pctTokens: number; overTokensTotal: boolean }>;
}
export interface Timeseries {
  period: string; metric: string; providers: string[];
  days: Array<{ date: string; byProvider: Record<string, number>; total: number }>;
  monthTotal: number;
}
export interface LedgerRow { runId: string; startedAt?: string; goal: string; costUsd: number; tokens: number; agentCount: number; degraded: boolean; status?: string }
export interface RunLedger { rows: LedgerRow[]; total: number; offset: number; limit: number }
export interface ProviderBalance {
  provider: string;
  available: boolean | null;
  balances?: Array<{ currency: string; total: string; granted?: string; toppedUp?: string }>;
  note?: string;   // 无公开余额 API 的诚实说明
  error?: string;
}
export interface Usage {
  providers?: Array<{ provider: string; totalTokens: number; windowTokens?: number; windowHours?: number; oldestAt?: string; oldestFreesAt?: string; calls?: number }>;
  /** 多供应商余额(deepseek/openrouter/siliconflow/moonshot 有公开 API;其余 note 说明) */
  balances?: ProviderBalance[];
  deepseekBalance?: { available: boolean; balances: Array<{ currency: string; total: string; granted: string; toppedUp: string }> };
  subscriptionNote?: string;
}
// companyId 可选:维度栏·角色过滤纯客户端做只需 name/role;公司过滤走服务端(见 CostPage 的
// company query 参数),companyId 目前保留给将来客户端场景,当前未强依赖。
export type Roster = Map<string, { name: string; role: string; companyId?: string }>;
