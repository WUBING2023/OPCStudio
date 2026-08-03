import type { AgentFramework } from "@opc/shared";
import type { AccountLease, AccountRuntimeState, AcquireRequest, Scheduler } from "./accountTypes.js";
import { AccountPool } from "./accountPool.js";

export interface SchedulerOpts {
  isHealthy?: (providerId: string) => boolean;
  suggestBackup?: (providerId: string) => string | null;
  acquireTimeoutMs?: number; // give up + reject after this long (caller → deferred no_account)
  cliBackoffMs?: number;     // base delay before re-leasing CLI capacity (default 1500); jittered ±50%
}

// Spacing consecutive subscription CLI runs lowers account risk; API engines drain immediately.
const CLI_FRAMEWORKS: AgentFramework[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];

interface Waiter {
  framework: AgentFramework;
  pinnedConfigDir?: string; // 钉定账号的等待者:drain 重试时同样只等该账号
  resolve: (lease: AccountLease) => void;
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

// Schedules account leases: health-filters the provider (with optional failover), leases the
// least-busy account via AccountPool, or queues the request per-provider (FIFO) until a release
// frees capacity. acquire rejects after acquireTimeoutMs so a stuck task defers instead of hanging.
export class DefaultScheduler implements Scheduler {
  private queues = new Map<string, Waiter[]>();

  constructor(private pool: AccountPool, private opts: SchedulerOpts = {}) {}

  async acquire(req: AcquireRequest): Promise<AccountLease> {
    const providerId = this.resolveProvider(req);
    // Fail fast when NO account can ever satisfy this provider+framework (e.g. a claude-code node
    // with no matching CLI account) — otherwise the request queues for the full acquireTimeoutMs
    // (~3min) before deferring no_account, wasting a semaphore slot the whole time.
    if (!this.pool.hasCapacity(providerId, req.framework, req.pinnedConfigDir)) {
      throw new Error(`no account for provider "${providerId}" / framework "${req.framework}"`);
    }
    const immediate = this.pool.tryLease(providerId, req.framework, Date.now(), req.pinnedConfigDir);
    if (immediate) return this.wrap(providerId, req.framework, immediate);

    return new Promise<AccountLease>((resolve, reject) => {
      const w: Waiter = {
        framework: req.framework,
        pinnedConfigDir: req.pinnedConfigDir,
        settled: false,
        timer: null,
        resolve: (lease) => {
          if (w.settled) return;
          w.settled = true;
          if (w.timer) clearTimeout(w.timer);
          resolve(lease);
        },
      };
      const timeout = this.opts.acquireTimeoutMs;
      if (timeout && timeout > 0) {
        w.timer = setTimeout(() => {
          if (w.settled) return;
          w.settled = true;
          const q = this.queues.get(providerId);
          if (q) { const i = q.indexOf(w); if (i >= 0) q.splice(i, 1); }
          reject(new Error(`no account available for ${providerId} within ${timeout}ms`));
        }, timeout);
      }
      const q = this.queues.get(providerId) ?? [];
      q.push(w);
      this.queues.set(providerId, q);
    });
  }

  private resolveProvider(req: AcquireRequest): string {
    if (this.opts.isHealthy && !this.opts.isHealthy(req.providerId) && req.allowFailover && this.opts.suggestBackup) {
      const backup = this.opts.suggestBackup(req.providerId);
      if (backup) return backup;
    }
    return req.providerId;
  }

  private wrap(providerId: string, framework: AgentFramework, lease: AccountLease): AccountLease {
    return {
      account: lease.account,
      release: () => {
        lease.release();
        if (CLI_FRAMEWORKS.includes(framework)) {
          const base = this.opts.cliBackoffMs ?? 1500;
          const delay = Math.round(base * (0.5 + Math.random())); // jitter base*[0.5,1.5)
          setTimeout(() => this.drain(providerId), delay);
        } else {
          this.drain(providerId);
        }
      },
    };
  }

  private drain(providerId: string): void {
    const q = this.queues.get(providerId);
    if (!q) return;
    // 逐个尝试而非"队头失败即停":钉定等待者只等它钉的那个账号——队头钉的号还忙时,不能堵住后面
    // 等其它账号(或普通池)的请求;反之普通请求拿不到容量也不该堵住钉定号刚空出来的等待者。
    // 仍按 FIFO 顺序给先来者优先试租,公平性不变。
    for (let i = 0; i < q.length; ) {
      const w = q[i];
      if (w.settled) { q.splice(i, 1); continue; }
      const lease = this.pool.tryLease(providerId, w.framework, Date.now(), w.pinnedConfigDir);
      if (!lease) { i++; continue; } // 该等待者暂无容量 → 留队,继续看下一个
      q.splice(i, 1);
      w.resolve(this.wrap(providerId, w.framework, lease));
    }
  }

  snapshot(): AccountRuntimeState[] {
    return this.pool.snapshot();
  }

  reportOutcome(
    accountId: string,
    framework: AgentFramework,
    outcome: "success" | "failure",
    opts?: { error?: string; forceCooldownUntil?: number },
  ): void {
    this.pool.reportOutcome(accountId, framework, outcome, opts);
  }
}
