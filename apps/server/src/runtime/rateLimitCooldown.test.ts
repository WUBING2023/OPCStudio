import { describe, it, expect, beforeEach } from "vitest";
import {
  makeCooldownKey, parseResetTime, recordRateLimit, getCooldownEntry,
  isRateLimited, clearCooldown, listCooldowns, _resetCooldownsForTest,
} from "./rateLimitCooldown.js";

const NOW = 1_700_000_000_000; // 固定基准,避开真实时钟

describe("限流冷却表 · makeCooldownKey", () => {
  it("framework/provider/model 拼 key,缺省补默认;历史值 hermes 归一 api(同一 key 空间)", () => {
    expect(makeCooldownKey("claude-code", "anthropic", "sonnet")).toBe("claude-code/anthropic/sonnet");
    expect(makeCooldownKey(undefined, "deepseek", undefined)).toBe("api/deepseek/*");
    expect(makeCooldownKey("hermes", "deepseek", "deepseek-chat")).toBe("api/deepseek/deepseek-chat");
  });
});

describe("限流冷却表 · parseResetTime", () => {
  it("retry-after 秒", () => {
    const r = parseResetTime("HTTP 429 Retry-After: 120", NOW);
    expect(r.source).toBe("retry-after-seconds");
    expect(r.epochMs).toBe(NOW + 120_000);
  });
  it("时长短语 try again in N minutes/hours", () => {
    expect(parseResetTime("Rate limit exceeded. Please try again in 5 minutes.", NOW)).toEqual({ epochMs: NOW + 300_000, source: "duration-phrase" });
    expect(parseResetTime("reset in 2 hours", NOW)).toEqual({ epochMs: NOW + 7_200_000, source: "duration-phrase" });
    expect(parseResetTime("retry in 30s", NOW)).toEqual({ epochMs: NOW + 30_000, source: "duration-phrase" });
  });
  it("ISO 时间戳(必须晚于 now)", () => {
    const future = new Date(NOW + 600_000).toISOString();
    const r = parseResetTime(`limit resets ${future}`, NOW);
    expect(r.source).toBe("iso-datetime");
    expect(r.epochMs).toBe(NOW + 600_000);
  });
  it("时钟点 resets at HH(:MM)(am/pm),已过取明天", () => {
    const r = parseResetTime("Your quota resets at 18:00", NOW);
    expect(r.source).toBe("clock-hhmm");
    const d = new Date(r.epochMs);
    expect(d.getHours()).toBe(18); expect(d.getMinutes()).toBe(0);
    expect(r.epochMs).toBeGreaterThan(NOW);
  });
  it("解析不到 → 默认 30 分钟", () => {
    expect(parseResetTime("some unrelated error", NOW)).toEqual({ epochMs: NOW + 1_800_000, source: "default-cooldown" });
  });
  it("离谱的超长 retry-after 落到默认(被 MAX 夹住)", () => {
    // 30 天秒数 > 7 天上限 → 不采纳 → 落默认
    expect(parseResetTime("Retry-After: 2592000", NOW).source).toBe("default-cooldown");
  });
});

describe("限流冷却表 · 记录/查询/过期", () => {
  beforeEach(() => _resetCooldownsForTest());

  it("record 后在冷却期内 isRateLimited=true,过点惰性过期", () => {
    const key = makeCooldownKey("claude-code", "anthropic", "sonnet");
    recordRateLimit(key, "Retry-After: 60", NOW);
    expect(isRateLimited(key, NOW)).toBe(true);
    expect(isRateLimited(key, NOW + 59_000)).toBe(true);
    // 过点:惰性删除 + 返回 false(自动恢复)
    expect(isRateLimited(key, NOW + 61_000)).toBe(false);
    expect(getCooldownEntry(key, NOW + 61_000)).toBeUndefined();
  });

  it("getCooldownEntry 返回结构 + clearCooldown 立即解除", () => {
    const key = makeCooldownKey("api", "deepseek", "deepseek-chat");
    recordRateLimit(key, "try again in 10 minutes", NOW);
    const e = getCooldownEntry(key, NOW)!;
    expect(e.modelKey).toBe(key);
    expect(e.rateLimitedUntil).toBe(NOW + 600_000);
    expect(e.resetSource).toBe("duration-phrase");
    clearCooldown(key);
    expect(isRateLimited(key, NOW)).toBe(false);
  });

  it("listCooldowns 只列未过期", () => {
    recordRateLimit(makeCooldownKey("a", "p1", "m"), "Retry-After: 60", NOW);
    recordRateLimit(makeCooldownKey("b", "p2", "m"), "Retry-After: 600", NOW);
    expect(listCooldowns(NOW).length).toBe(2);
    expect(listCooldowns(NOW + 120_000).length).toBe(1); // p1 已过期
  });
});
