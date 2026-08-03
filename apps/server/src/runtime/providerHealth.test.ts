import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { initProviderHealth, recordFailure, recordSuccess, isHealthy, getHealthStats, suggestBackupProvider } from "./providerHealth.js";
import { registerProvider, callModel, setModelGatewayRoot } from "./modelGateway.js";

// no_account 根因修复的确定性回归测试：
//  ① 熔断后超过恢复窗 → isHealthy 半恢复（否则单账号被永久判死）
//  ② 瞬时错误(429/timeout/5xx)不计入连续失败（否则限流抖动误判 provider 死亡）
describe("providerHealth 时间半恢复", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph-"));
    initProviderHealth(dir); // 把持久化重定向到临时目录，不污染仓库
  });
  afterEach(() => vi.useRealTimers());

  it("连续失败≥3 判不健康，但超过恢复窗后允许重试，成功后清零", () => {
    const base = new Date("2026-06-20T00:00:00.000Z").getTime();
    vi.useFakeTimers();
    vi.setSystemTime(base);

    const prov = "p-recover";
    recordFailure(prov, "boom"); recordFailure(prov, "boom"); recordFailure(prov, "boom");
    expect(isHealthy(prov)).toBe(false); // 刚熔断

    vi.setSystemTime(base + 30_000);
    expect(isHealthy(prov)).toBe(false); // 30s < 恢复窗

    vi.setSystemTime(base + 61_000);
    expect(isHealthy(prov)).toBe(true);  // 超过 60s 恢复窗 → 半恢复

    recordSuccess(prov, 10);
    expect(getHealthStats(prov)?.consecutiveFailures).toBe(0);
    expect(isHealthy(prov)).toBe(true);
  });
});

describe("熔断计数：瞬时错误不计入", () => {
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ph2-"));
    initProviderHealth(dir);
    setModelGatewayRoot(dir);
  });

  it("provider 抛 429/timeout 不累计 consecutiveFailures（不会误判不健康）", async () => {
    registerProvider("tp-transient", async () => { throw new Error("API 429: rate limited"); });
    for (let i = 0; i < 5; i++) {
      await callModel({ agentId: "a", provider: "tp-transient", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 16 }).catch(() => {});
    }
    expect(getHealthStats("tp-transient")?.consecutiveFailures ?? 0).toBe(0);
    expect(isHealthy("tp-transient")).toBe(true);
  });

  it("真故障(非瞬时)仍累计 consecutiveFailures", async () => {
    registerProvider("tp-real", async () => { throw new Error("malformed response: not JSON"); });
    for (let i = 0; i < 3; i++) {
      await callModel({ agentId: "a", provider: "tp-real", model: "m", messages: [{ role: "user", content: "x" }], maxTokens: 16 }).catch(() => {});
    }
    expect(getHealthStats("tp-real")?.consecutiveFailures).toBe(3);
    expect(isHealthy("tp-real")).toBe(false);
  });
});

// G4 · 自动切换 provider 只用真 provider,绝不回退 mock(缺 key/环境坏时宁可诚实无 backup)。
describe("suggestBackupProvider — 绝不回退 mock", () => {
  it("原 provider 熔断:只有 mock 可选 → undefined(不回退 mock);有真 provider → 选真的跳过 mock", () => {
    const prov = "bkg-deepseek";
    recordFailure(prov, "boom"); recordFailure(prov, "boom"); recordFailure(prov, "boom");
    expect(isHealthy(prov)).toBe(false);
    expect(suggestBackupProvider(prov, ["mock"])).toBeUndefined();          // 绝不回退 mock
    expect(suggestBackupProvider(prov, ["mock", "bkg-openai"])).toBe("bkg-openai"); // 跳过 mock 选真 provider
  });
  it("原 provider 健康 → 不切换", () => {
    expect(suggestBackupProvider("bkg-healthy", ["bkg-other"])).toBeUndefined();
  });
});
