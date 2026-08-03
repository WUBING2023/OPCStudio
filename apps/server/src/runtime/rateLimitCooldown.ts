// 限流冷却表(纯内存,自过期)。对抗审查铁律:① 只在引擎打了 [overloaded] 标记(spawnCliWithRetry 三次
// 退避全耗尽后)才记录,单次自愈的 429 不进来;② 纯内存、不写持久健康文件、自过期(不跨 run 污染路由)。
// 用途:撞限流的模型进冷却 → 路由在冷却期内自动换备用模型,过点自动用回(getCooldownEntry 惰性过期)。

export type ResetSource = "retry-after-seconds" | "duration-phrase" | "iso-datetime" | "clock-hhmm" | "default-cooldown";

export interface CooldownEntry {
  modelKey: string;
  rateLimitedUntil: number;   // epoch ms
  detectedAt: string;         // ISO
  resetSource: ResetSource;
}

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;   // 解析不到 reset 时的保守默认
const MAX_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // 防解析出离谱的超长冷却
const cooldowns = new Map<string, CooldownEntry>();

export function makeCooldownKey(framework: string | undefined, provider: string, model: string | undefined): string {
  // 缺省与历史值 "hermes" 归一为 "api":存量 agents.json 节点(framework:"hermes",不改写)与
  // FALLBACK_CHAIN(engineRouter,framework:"api")必须落进同一个冷却 key 空间,否则同一模型会被
  // 当成两个 key,pickFallbackEngine 的"跳过自己"判定失效。
  const fw = !framework || framework === "hermes" ? "api" : framework;
  return `${fw}/${provider}/${model || "*"}`;
}

// best-effort 从限流文本解析"几点恢复"。优先级:retry-after 秒 → 时长短语 → ISO → 时钟点 → 默认 30min。
export function parseResetTime(rawText: string, now = Date.now()): { epochMs: number; source: ResetSource } {
  const t = rawText || "";
  const clamp = (ms: number) => ms > 0 && ms < MAX_COOLDOWN_MS;

  let m = t.match(/retry[-\s]?after[:\s"']*?(\d{1,7})/i);
  if (m) { const ms = Number(m[1]) * 1000; if (clamp(ms)) return { epochMs: now + ms, source: "retry-after-seconds" }; }

  m = t.match(/(?:try again|reset|retry|available|come back)\s+in\s+(\d{1,5})\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/i);
  if (m) {
    const n = Number(m[1]); const u = m[2].toLowerCase();
    const mult = /^h/.test(u) ? 3_600_000 : /^m/.test(u) ? 60_000 : 1000;
    const ms = n * mult; if (clamp(ms)) return { epochMs: now + ms, source: "duration-phrase" };
  }

  m = t.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (m) { const d = Date.parse(m[1]); if (!isNaN(d) && d > now && clamp(d - now)) return { epochMs: d, source: "iso-datetime" }; }

  m = t.match(/reset[s]?\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let hr = Number(m[1]); const min = m[2] ? Number(m[2]) : 0; const ap = m[3]?.toLowerCase();
    if (ap === "pm" && hr < 12) hr += 12; if (ap === "am" && hr === 12) hr = 0;
    if (hr >= 0 && hr <= 23 && min >= 0 && min <= 59) {
      const d = new Date(now); d.setHours(hr, min, 0, 0);
      let target = d.getTime();
      if (target <= now) target += 24 * 3600_000; // 已过 → 取明天那个点
      if (clamp(target - now)) return { epochMs: target, source: "clock-hhmm" };
    }
  }

  return { epochMs: now + DEFAULT_COOLDOWN_MS, source: "default-cooldown" };
}

// 记录一次限流(只该在引擎打了 [overloaded] 标记后调用)。
export function recordRateLimit(key: string, rawText: string, now = Date.now()): CooldownEntry {
  const { epochMs, source } = parseResetTime(rawText, now);
  const entry: CooldownEntry = { modelKey: key, rateLimitedUntil: epochMs, detectedAt: new Date(now).toISOString(), resetSource: source };
  cooldowns.set(key, entry);
  return entry;
}

// 取冷却条目;已过期则惰性删除并返回 undefined(过点自动恢复)。
export function getCooldownEntry(key: string, now = Date.now()): CooldownEntry | undefined {
  const e = cooldowns.get(key);
  if (!e) return undefined;
  if (e.rateLimitedUntil <= now) { cooldowns.delete(key); return undefined; }
  return e;
}

export function isRateLimited(key: string, now = Date.now()): boolean {
  return getCooldownEntry(key, now) !== undefined;
}

export function clearCooldown(key: string): void { cooldowns.delete(key); }

// 供 UI/调试:列出当前仍在冷却的条目。
export function listCooldowns(now = Date.now()): CooldownEntry[] {
  const out: CooldownEntry[] = [];
  for (const [k, e] of cooldowns) { if (e.rateLimitedUntil > now) out.push(e); else cooldowns.delete(k); }
  return out;
}

// 测试用:清空(避免跨测试污染)。
export function _resetCooldownsForTest(): void { cooldowns.clear(); }
