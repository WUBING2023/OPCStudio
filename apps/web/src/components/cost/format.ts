// Cost page · shared formatting helpers. Pure functions only (no i18n/React deps) so callers
// resolve locale-specific strings themselves via useT() — keeps this file trivially testable.

export const fmtTok = (n?: number): string => (n ?? 0).toLocaleString("en-US");

export function fmtTokShort(n: number): string {
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
  return String(Math.round(n));
}

export function truncate(s: string, max = 60): string {
  const t = (s ?? "").trim();
  return t.length > max ? t.slice(0, max).trimEnd() + "…" : t;
}

// 乱码健壮化:含 U+FFFD(�) → 视为坏数据,回退调用方传入的兜底文案(通常是 "Run #<id>")。
const GARBLED = /�/;
export function safeGoal(goal: string | undefined, fallback: string): string {
  return (!goal || GARBLED.test(goal)) ? fallback : goal;
}

export function fmtAbsTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

// Relative-time bucket for a timestamp — returns an i18n key + count for the caller to resolve
// via tr(key, { n }); falls back to null once it's more than 30 days old (caller should render
// an absolute date instead — a "47 days ago" chip stops being useful past that point).
export interface RelTime { key: string; n: number }
export function relativeTimeOf(iso?: string, now: number = Date.now()): RelTime | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 60) return { key: "cost.time.justNow", n: 0 };
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return { key: "cost.time.minutesAgo", n: diffMin };
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return { key: "cost.time.hoursAgo", n: diffHr };
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return { key: "cost.time.daysAgo", n: diffDay };
  return null;
}

// 员工排行的 token 消耗列:1_262_589 → "1.26M",8_400 → "8k"
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2).replace(/.?0+$/, "") + "M";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}
