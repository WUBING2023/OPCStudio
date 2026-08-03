import type { ProviderAccount, AgentFramework } from "@opc/shared";

// Runtime (in-process, not persisted) state of an account.
export interface AccountRuntimeState {
  accountId: string;
  activeSessions: number;   // currently-executing sessions — the "least-busy" metric
  totalLeases: number;      // cumulative leases (trace/observability)
  lastLeasedAt: string | null;
  cooldownUntil: number;    // epoch ms; set when health-degraded
}

// A lease handed to one execution; release() MUST be called when the execution finishes.
export interface AccountLease {
  account: ProviderAccount;
  release: () => void;
}

export interface AcquireRequest {
  providerId: string;
  framework: AgentFramework;
  allowFailover?: boolean; // if providerId unhealthy, allow degrading to a backup provider
  /** 节点显式钉定的订阅账号隔离登录目录(agent.cliConfigDir)。命中某注册账号的 configDir 时,租约必须
   *  落在该账号上(记账=真实执行账号,per-account 并发防封号才数得准);不命中任何账号(自由文本目录,
   *  legacy 用法)时按普通池行为选号——执行侧照旧用该目录,只是记账退化为池选号(与修复前一致)。 */
  pinnedConfigDir?: string;
}

export interface Scheduler {
  acquire(req: AcquireRequest): Promise<AccountLease>;
  snapshot(): AccountRuntimeState[];
  // Multi-account auto-switch(所有框架统一):调用方报告一次执行的结果,供账号级健康判断——"failure"
  // 记入跨 run 持久化的熔断器(键为 account id,复用 providerHealth.ts,见 accountPool.reportOutcome)、
  // 并可选地强制冷却到某个时间点(从过载/限流错误文案解析出的"几点恢复");"success" 清零。CLI 订阅
  // 框架(claude-code/codex)与 hermes/API 框架一视同仁——后者租到的账号 apiKey 会真正透传进执行链路
  // (ExecContext.leasedAccount),所以也需要账号级熔断,不再是 no-op。
  reportOutcome(
    accountId: string,
    framework: AgentFramework,
    outcome: "success" | "failure",
    opts?: { error?: string; forceCooldownUntil?: number },
  ): void;
}
