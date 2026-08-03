import * as path from "node:path";
import type { ProviderAccount, AgentFramework } from "@opc/shared";
import type { AccountRuntimeState, AccountLease } from "./accountTypes.js";
import { isHealthy, recordFailure, recordSuccess } from "../providerHealth.js";

// 目录等价比较(钉定账号匹配用):path.resolve 归一 + Windows 大小写不敏感。
function sameDir(a: string, b: string): boolean {
  const ra = path.resolve(a), rb = path.resolve(b);
  return process.platform === "win32" ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

// 订阅 CLI 账号在并发下有封号风险,按账号钳并发上限。默认 5(实测:单账号 10 并发真实调用未触发任何
// 限流/鉴权/封号信号、账号存活,取安全余量定 5);账号显式开 acceptBanRisk("我愿意冒险")→ 放宽到 10。
const CLI_FRAMEWORKS: AgentFramework[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];
const CLI_MAX_CONCURRENT = 5;       // 默认安全钳
const CLI_MAX_CONCURRENT_RISK = 10; // acceptBanRisk 开启后的上限(= 已实测未封的最高并发)
// API Key 模式的 claude-code/codex 账号(apiKey 非空)不是"多个会话共享同一个订阅登录态"——它是按量计费
// 的官方 API 调用,没有那种"并发撞见风控被封号"的风险,不该被这条为订阅账号设计的钳拖累(否则用户特意配
// API Key 换取的并发能力,反被硬压回订阅账号同款的低并发,违背这个模式存在的意义)。
export function effectiveCap(account: ProviderAccount, framework: AgentFramework): number {
  if (!CLI_FRAMEWORKS.includes(framework)) return account.maxConcurrent;
  if (account.apiKey && account.cliBackend !== "glm-coding-plan") return account.maxConcurrent;
  const ceiling = account.acceptBanRisk ? CLI_MAX_CONCURRENT_RISK : CLI_MAX_CONCURRENT;
  return Math.min(account.maxConcurrent, ceiling);
}

// Holds the enabled accounts + their runtime state. tryLease picks the least-busy account
// (fewest activeSessions, then oldest lastLeasedAt) among healthy, under-cap candidates for a
// given provider + framework. Returns null when none is currently free (scheduler then queues).
export class AccountPool {
  private accounts: ProviderAccount[];
  private state = new Map<string, AccountRuntimeState>();

  constructor(accounts: ProviderAccount[]) {
    this.accounts = accounts.filter((a) => a.enabled);
    for (const a of this.accounts) {
      this.state.set(a.id, { accountId: a.id, activeSessions: 0, totalLeases: 0, lastLeasedAt: null, cooldownUntil: 0 });
    }
  }

  // 钉定目录 → 注册账号解析:agent.cliConfigDir 与某账号的 configDir 同目录时返回该账号;否则 null
  // (自由文本目录=legacy 用法,不参与钉定记账)。
  findByConfigDir(configDir: string | undefined): ProviderAccount | null {
    if (!configDir) return null;
    return this.accounts.find((a) => a.configDir && sameDir(a.configDir, configDir)) ?? null;
  }

  // Does any account (busy or not) exist for this provider+framework? Used to decide whether to
  // queue (capacity exists, wait) vs. fail fast (no account will ever satisfy this).
  // 钉定命中注册账号时,容量=该账号存在(true)——排队等它,绝不因"别的号有空"而误判。
  hasCapacity(providerId: string, framework: AgentFramework, pinnedConfigDir?: string): boolean {
    if (this.findByConfigDir(pinnedConfigDir)) return true;
    return this.accounts.some(
      (a) => a.providerId === providerId && (!a.frameworks || a.frameworks.includes(framework)),
    );
  }

  tryLease(providerId: string, framework: AgentFramework, now: number, pinnedConfigDir?: string): AccountLease | null {
    // 钉定账号:记账必须落在真实执行的账号上(engineRegistry 会把该目录注进 CLAUDE_CONFIG_DIR/CODEX_HOME,
    // 执行侧一定用它)——钉定命中时只考虑该账号:它忙/冷却/熔断 → 返回 null 排队等它,绝不把并发槽记到
    // 别的账号名下(否则两个钉同号的节点可各租别的号的槽并发跑同一订阅号,击穿 per-account=1 防封号线)。
    const pinned = this.findByConfigDir(pinnedConfigDir);
    const candidates = this.accounts.filter((a) => {
      if (pinned) { if (a.id !== pinned.id) return false; }
      else if (a.providerId !== providerId) return false;
      if (!pinned && a.frameworks && !a.frameworks.includes(framework)) return false;
      const st = this.state.get(a.id)!;
      if (st.cooldownUntil >= now) return false;
      if (st.activeSessions >= effectiveCap(a, framework)) return false;
      // 多账号自动切换(所有框架统一):跨 run 持久化的熔断器判该账号不健康(额度耗尽/连续失败,见
      // reportOutcome)时,不选它——同 providerId 下的另一个健康账号会被选中(tryLease 只在这个
      // provider+framework 的候选池里挑,天然覆盖"两个 codex 订阅账号"/"两个 deepseek API 账号"这类场景)。
      // 曾经只对 CLI_FRAMEWORKS 生效(hermes/API 账号被认为"已有 provider 级熔断,不用重复接线")——
      // 那条假设建立在"leased 账号的 apiKey 反正不会被真正用于执行"之上;现在 parallelExecutor 把租到的
      // 账号 apiKey 真正透传进了 ExecContext(见 leasedAccount),不再区分框架,一视同仁按 account id 熔断。
      if (!isHealthy(a.id)) return false;
      return true;
    });
    if (candidates.length === 0) return null;

    candidates.sort((x, y) => {
      const sx = this.state.get(x.id)!, sy = this.state.get(y.id)!;
      if (!!x.preferred !== !!y.preferred) return x.preferred ? -1 : 1;
      if (sx.activeSessions !== sy.activeSessions) return sx.activeSessions - sy.activeSessions;
      return (sx.lastLeasedAt ?? "") < (sy.lastLeasedAt ?? "") ? -1 : 1;
    });

    const acc = candidates[0];
    const st = this.state.get(acc.id)!;
    st.activeSessions++;
    st.totalLeases++;
    st.lastLeasedAt = new Date(now).toISOString();

    let released = false;
    return {
      account: acc,
      release: () => {
        if (released) return;
        released = true;
        st.activeSessions = Math.max(0, st.activeSessions - 1);
      },
    };
  }

  setCooldown(accountId: string, until: number): void {
    const st = this.state.get(accountId);
    if (st) st.cooldownUntil = until;
  }

  // 多账号自动切换的落地点。原先只对 CLI 订阅框架(claude-code/codex)生效——hermes/API 账号被认为
  // "已有 provider 级熔断(providerHealth.ts 直接键 provider,见 modelGateway.ts),不用重复接线"。
  // 这个假设现在不成立了:parallelExecutor 已把 accountPool 租到的具体账号 apiKey 真正透传进执行链路
  // (ExecContext.leasedAccount,见 HermesEngine.ts),意味着"选中了另一个账号"这件事会真正改变用哪把
  // key 发起调用——所以 hermes/API 框架也必须有账号级(而非仅 provider 级)的失败熔断,否则同一个坏
  // 账号会被反复选中,直到 provider 级熔断整体判死,拖累同 provider 下本还健康的另一个账号。
  //
  // 复用 providerHealth.ts 现成的熔断器(3 次连续失败判不健康 + 60s 半恢复窗 + 落盘跨 run 存活),键用
  // "account id"而非"provider 名"——细粒度到具体某个账号,这样才能让同 provider 下的另一个账号继续
  // 被选中,而不是整个 provider 一起被拖下水。与 modelGateway.ts 里按 provider 名记的那一份熔断器是
  // 两个独立的 Map key 空间(account id 与 provider 名不会撞),两者并存不冲突:provider 级那份服务于
  // 不经过 accountPool 租约的系统级调用(chat/mission/skill 等直接走 callModel 注册表的路径),这里这份
  // 服务于经过 accountPool 租约的执行(worker/CEO/Lead 的引擎调用)。
  //
  // 局限性(诚实说明,不是 bug):① 60s 半恢复窗是为瞬时 infra 抖动调的,对"额度要等 5 小时才重置"这种
  // 场景明显过短——超过 60s 后调度可能再探一次已耗尽的账号,大概率仍失败,只是浪费一次尝试,不是正确性
  // 问题(见 opts.forceCooldownUntil 的补充:能从错误文案解析出精确恢复时间时,用它加一层更长的显式冷却,
  // 缓解这个问题)。② "连续失败"是尽力而为的兜底——没有稳定可解析的错误文案时,靠这个阈值猜"这个
  // 账号可能出问题了",不是 100% 精确的额度/鉴权检测。
  reportOutcome(
    accountId: string,
    _framework: AgentFramework,
    outcome: "success" | "failure",
    opts?: { error?: string; forceCooldownUntil?: number },
  ): void {
    if (outcome === "success") { recordSuccess(accountId, 0); return; }
    recordFailure(accountId, opts?.error ?? "account call failed");
    if (opts?.forceCooldownUntil) this.setCooldown(accountId, opts.forceCooldownUntil);
  }

  snapshot(): AccountRuntimeState[] {
    return [...this.state.values()].map((s) => ({ ...s }));
  }
}
