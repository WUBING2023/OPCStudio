import { describe, it, expect, vi } from "vitest";
import type { ProviderAccount } from "@opc/shared";
import { AccountPool, effectiveCap } from "./accountPool.js";
import { DefaultScheduler } from "./scheduler.js";

function acct(over: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id: "a#0", providerId: "anthropic", label: "x", apiKey: "", enabled: true, maxConcurrent: 4, ...over };
}

describe("effectiveCap", () => {
  it("默认把订阅 CLI 钳到 5(不管配置的 maxConcurrent 多大);非 CLI 不钳", () => {
    const a = acct({ maxConcurrent: 8 });
    expect(effectiveCap(a, "claude-code")).toBe(5);
    expect(effectiveCap(a, "codex")).toBe(5);
    expect(effectiveCap(a, "hermes")).toBe(8);
  });

  it("maxConcurrent 低于钳时取 maxConcurrent(min 语义)", () => {
    expect(effectiveCap(acct({ maxConcurrent: 3 }), "claude-code")).toBe(3);
  });

  it("acceptBanRisk(我愿意冒险)→ 订阅 CLI 钳放宽到 10", () => {
    expect(effectiveCap(acct({ maxConcurrent: 20, acceptBanRisk: true }), "claude-code")).toBe(10);
    expect(effectiveCap(acct({ maxConcurrent: 7, acceptBanRisk: true }), "codex")).toBe(7); // 仍取 min
  });

  it("API Key 模式(apiKey 非空)的 CLI 账号不钳——按量计费的官方 API,没有共享登录态的封号风险", () => {
    const a = acct({ maxConcurrent: 8, apiKey: "sk-ant-fake-testkey" });
    expect(effectiveCap(a, "claude-code")).toBe(8);
    expect(effectiveCap(a, "codex")).toBe(8);
  });
});

describe("AccountPool CLI cap", () => {
  const NOW = 1_700_000_000_000;
  it("订阅 CLI 默认钳 5:配置更大也只租到 5 个并发会话,释放后可续租", () => {
    const pool = new AccountPool([acct({ maxConcurrent: 20 })]);
    const leases = [];
    for (let i = 0; i < 5; i++) { const l = pool.tryLease("anthropic", "claude-code", NOW); expect(l).not.toBeNull(); leases.push(l); }
    expect(pool.tryLease("anthropic", "claude-code", NOW)).toBeNull(); // 第 6 个被钳
    leases[0]!.release();
    expect(pool.tryLease("anthropic", "claude-code", NOW)).not.toBeNull(); // 释放后又可租
  });

  it("acceptBanRisk 开启 → 钳放宽到 10", () => {
    const pool = new AccountPool([acct({ maxConcurrent: 20, acceptBanRisk: true })]);
    for (let i = 0; i < 10; i++) expect(pool.tryLease("anthropic", "claude-code", NOW)).not.toBeNull();
    expect(pool.tryLease("anthropic", "claude-code", NOW)).toBeNull(); // 第 11 个被钳
  });

  it("still allows API concurrency up to maxConcurrent", () => {
    const pool = new AccountPool([acct({ maxConcurrent: 3 })]);
    expect(pool.tryLease("anthropic", "hermes", NOW)).not.toBeNull();
    expect(pool.tryLease("anthropic", "hermes", NOW)).not.toBeNull();
    expect(pool.tryLease("anthropic", "hermes", NOW)).not.toBeNull();
    expect(pool.tryLease("anthropic", "hermes", NOW)).toBeNull();
  });
});

describe("DefaultScheduler CLI backoff", () => {
  it("delays re-leasing CLI capacity by a jittered backoff before serving the queue", async () => {
    vi.useFakeTimers();
    try {
      const pool = new AccountPool([acct({ maxConcurrent: 1 })]);
      const sched = new DefaultScheduler(pool, { cliBackoffMs: 1000 });
      const first = await sched.acquire({ providerId: "anthropic", framework: "claude-code" });
      let secondGranted = false;
      const p = sched.acquire({ providerId: "anthropic", framework: "claude-code" }).then((l) => { secondGranted = true; return l; });
      first.release();
      // backoff window: not yet granted right after release
      await Promise.resolve();
      expect(secondGranted).toBe(false);
      // after the max jitter window (base*1.5 = 1500ms) the queued waiter is served
      await vi.advanceTimersByTimeAsync(1600);
      await p;
      expect(secondGranted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drains non-CLI capacity immediately (no backoff)", async () => {
    const pool = new AccountPool([acct({ maxConcurrent: 1 })]);
    const sched = new DefaultScheduler(pool, { cliBackoffMs: 1000 });
    const first = await sched.acquire({ providerId: "anthropic", framework: "hermes" });
    let granted = false;
    const p = sched.acquire({ providerId: "anthropic", framework: "hermes" }).then((l) => { granted = true; return l; });
    first.release();
    await p;
    expect(granted).toBe(true);
  });
});
