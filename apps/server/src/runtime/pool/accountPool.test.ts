import { describe, it, expect, beforeEach } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderAccount } from "@opc/shared";
import { AccountPool } from "./accountPool.js";
import { initProviderHealth, isHealthy } from "../providerHealth.js";

// 多账号自动切换(所有框架统一,含 hermes/API):额度耗尽/连续失败 → 账号级熔断(复用 providerHealth.ts,
// 键换成 account id)→ tryLease 跳过它 → 同 provider 下的另一个健康账号被选中。每个 it() 用不同的
// account id,避免和 providerHealth 的模块级 Map 互相污染(同 providerHealth.test.ts 的既有写法)。

function acct(id: string, over: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, providerId: "openai", label: id, apiKey: "", frameworks: ["codex"], enabled: true, maxConcurrent: 3, ...over };
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-health-"));
  initProviderHealth(dir); // 把持久化重定向到临时目录，不污染仓库的 .opc/provider_health.json
});

describe("AccountPool.reportOutcome — 多账号自动切换", () => {
  const NOW = 1_700_000_000_000;

  // 2026-07:曾经 hermes/API 框架的 reportOutcome 是 no-op(理由:"provider 级熔断已经够用")——
  // 这个假设建立在"leased 账号的 apiKey 反正不会被真正用到执行里"之上。现在 parallelExecutor 把租到的
  // 账号 apiKey 真正透传进了 HermesEngine 的执行链路(ExecContext.leasedAccount),"选中了另一个账号"
  // 会真正改变用哪把 key——所以 hermes 框架也必须有账号级熔断,不再是 no-op。这条测试对齐验收标准:
  // 两个 deepseek 账号,一个连续失败 3 次进入冷却后,tryLease 自动切到另一个健康账号。
  it("hermes 框架:账号连续失败达阈值(3 次)→ 判不健康 → tryLease 跳过它,换同 provider 下的另一个账号", () => {
    const a = "deepseek#acct-a-1", b = "deepseek#acct-b-1";
    const pool = new AccountPool([
      acct(a, { providerId: "deepseek", frameworks: undefined, apiKey: "sk-bad-key" }),
      acct(b, { providerId: "deepseek", frameworks: undefined, apiKey: "sk-good-key" }),
    ]);
    pool.reportOutcome(a, "hermes", "failure", { error: "401 unauthorized" });
    pool.reportOutcome(a, "hermes", "failure", { error: "401 unauthorized" });
    expect(isHealthy(a)).toBe(true); // 还没到阈值
    pool.reportOutcome(a, "hermes", "failure", { error: "401 unauthorized" }); // 第 3 次触发熔断
    expect(isHealthy(a)).toBe(false);

    // tryLease 反复调用应该只吐出健康的账号 b(它的 sk-good-key),从不吐出被熔断的 a。
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const lease = pool.tryLease("deepseek", "hermes", NOW);
      expect(lease).not.toBeNull();
      seen.add(lease!.account.id);
      expect(lease!.account.apiKey).toBe("sk-good-key"); // 每次都拿到健康账号自己的 key,不是坏账号那把
      lease!.release();
    }
    expect(seen.has(b)).toBe(true);
    expect(seen.has(a)).toBe(false);
  });

  it("hermes 框架:success 清零连续失败计数——之前的失败不会累加到下次熔断", () => {
    const id = "deepseek#acct-recover-1";
    const pool = new AccountPool([acct(id, { providerId: "deepseek", frameworks: undefined })]);
    pool.reportOutcome(id, "hermes", "failure", { error: "boom" });
    pool.reportOutcome(id, "hermes", "failure", { error: "boom" });
    pool.reportOutcome(id, "hermes", "success");
    expect(isHealthy(id)).toBe(true);
    pool.reportOutcome(id, "hermes", "failure", { error: "boom" });
    expect(isHealthy(id)).toBe(true); // 只 1 次失败(清零后重新计),未到阈值
  });

  it("CLI 框架连续失败达阈值(3 次)→ 判不健康 → tryLease 跳过它，换同 provider 下的另一个账号", () => {
    const a = "codex#acct-a-1", b = "codex#acct-b-1";
    const pool = new AccountPool([acct(a), acct(b)]);
    pool.reportOutcome(a, "codex", "failure", { error: "boom" });
    pool.reportOutcome(a, "codex", "failure", { error: "boom" });
    pool.reportOutcome(a, "codex", "failure", { error: "boom" }); // 第 3 次触发熔断
    expect(isHealthy(a)).toBe(false);

    // tryLease 反复调用应该只吐出健康的账号 b，从不吐出被熔断的 a。
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) {
      const lease = pool.tryLease("openai", "codex", NOW);
      expect(lease).not.toBeNull();
      seen.add(lease!.account.id);
      lease!.release();
    }
    expect(seen.has(b)).toBe(true);
    expect(seen.has(a)).toBe(false);
  });

  it("success 清零连续失败计数——之前的失败不会累加到下次熔断", () => {
    const id = "codex#acct-recover-1";
    const pool = new AccountPool([acct(id)]);
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    pool.reportOutcome(id, "codex", "success");
    expect(isHealthy(id)).toBe(true);
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    expect(isHealthy(id)).toBe(true); // 只 1 次失败(清零后重新计),未到阈值
  });

  it("forceCooldownUntil(从过载文案解析出的恢复时间)：即使还没到 3 次连续失败，也能立刻让 tryLease 跳过该账号", () => {
    const a = "codex#acct-force-a", b = "codex#acct-force-b";
    const pool = new AccountPool([acct(a), acct(b)]);
    pool.reportOutcome(a, "codex", "failure", { error: "[overloaded] usage limit reached", forceCooldownUntil: NOW + 60_000 });
    // 还没到熔断阈值(只失败 1 次),但显式冷却窗生效——tryLease 仍应跳过 a。
    const lease = pool.tryLease("openai", "codex", NOW);
    expect(lease).not.toBeNull();
    expect(lease!.account.id).toBe(b);
    // 冷却窗过后(NOW+60_000 之后)，a 恢复可选（假设它没被判熔断——这里只 1 次失败，未到阈值）。
    lease!.release();
    const lease2 = pool.tryLease("openai", "codex", NOW + 60_001);
    expect(lease2).not.toBeNull();
  });

  it("单账号被熔断且无其他账号可用 → tryLease 返回 null（调度层按现有 queue/timeout 语义处理，不是这里的职责）", () => {
    const id = "codex#acct-solo-1";
    const pool = new AccountPool([acct(id)]);
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    pool.reportOutcome(id, "codex", "failure", { error: "boom" });
    expect(pool.tryLease("openai", "codex", NOW)).toBeNull();
    // hasCapacity 仍应诚实报告"这个 provider+framework 结构上有账号"(即便当下都不健康)——
    // 区分"结构性没有账号"(该 throw)和"暂时都不健康"(该排队重试)。
    expect(pool.hasCapacity("openai", "codex")).toBe(true);
  });
});

describe("AccountPool · 钉定账号租约(pinnedConfigDir → 记账=真实执行账号)", () => {
  const NOW = 1_700_000_000_000;
  const DIR_A = path.join(os.tmpdir(), "opc-pin", "acct-a");
  const DIR_B = path.join(os.tmpdir(), "opc-pin", "acct-b");

  it("钉定命中注册账号 → 即便它更忙也只租它(绝不把槽记到别的账号)", () => {
    const a = "cc#pin-a-1", b = "cc#pin-b-1";
    const pool = new AccountPool([
      acct(a, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_A, maxConcurrent: 3, apiKey: "k" }),
      acct(b, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_B, maxConcurrent: 3, apiKey: "k" }),
    ]);
    // 先把 a 租一次(a 比 b 忙)——无钉定时 least-busy 会选 b;钉定 DIR_A 必须仍选 a。
    const l0 = pool.tryLease("anthropic", "claude-code", NOW);
    expect(l0!.account.id).toBe(a); // 首租 least-busy 平手取 a(排序稳定)
    const pinned = pool.tryLease("anthropic", "claude-code", NOW, DIR_A);
    expect(pinned).not.toBeNull();
    expect(pinned!.account.id).toBe(a);
  });

  it("钉定账号已满(账号 maxConcurrent:1)→ 返回 null 排队等它,即便另一账号完全空闲", () => {
    const a = "cc#pin-a-2", b = "cc#pin-b-2";
    const pool = new AccountPool([
      acct(a, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_A, maxConcurrent: 1 }),
      acct(b, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_B, maxConcurrent: 1 }),
    ]);
    const first = pool.tryLease("anthropic", "claude-code", NOW, DIR_A);
    expect(first!.account.id).toBe(a);
    // a 满员;b 空闲——钉定 a 必须 null(等 a),不许落到 b。
    expect(pool.tryLease("anthropic", "claude-code", NOW, DIR_A)).toBeNull();
    first!.release();
    const after = pool.tryLease("anthropic", "claude-code", NOW, DIR_A);
    expect(after!.account.id).toBe(a);
  });

  it("钉定目录不匹配任何注册账号(自由文本 legacy)→ 退化为普通池行为", () => {
    const a = "cc#pin-a-3";
    const pool = new AccountPool([acct(a, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_A })]);
    const lease = pool.tryLease("anthropic", "claude-code", NOW, path.join(os.tmpdir(), "opc-pin", "not-an-account"));
    expect(lease).not.toBeNull();
    expect(lease!.account.id).toBe(a);
  });

  it("hasCapacity:钉定命中 → true;findByConfigDir 归一路径比较(win32 大小写不敏感)", () => {
    const a = "cc#pin-a-4";
    const pool = new AccountPool([acct(a, { providerId: "anthropic", frameworks: ["claude-code"], configDir: DIR_A })]);
    expect(pool.hasCapacity("anthropic", "claude-code", DIR_A)).toBe(true);
    const variant = process.platform === "win32" ? DIR_A.toUpperCase() : DIR_A;
    expect(pool.findByConfigDir(variant)?.id).toBe(a);
    expect(pool.findByConfigDir(undefined)).toBeNull();
  });
});


describe("AccountPool preferred account", () => {
  it("uses the preferred healthy account first and falls back when it reaches capacity", () => {
    const preferred = acct("codex#preferred", { preferred: true, maxConcurrent: 1 });
    const fallback = acct("codex#fallback", { maxConcurrent: 1 });
    const pool = new AccountPool([fallback, preferred]);
    const first = pool.tryLease("openai", "codex", 1_700_000_100_000);
    expect(first?.account.id).toBe("codex#preferred");
    const second = pool.tryLease("openai", "codex", 1_700_000_100_001);
    expect(second?.account.id).toBe("codex#fallback");
    first?.release();
    second?.release();
  });
});
