import * as fs from "node:fs";
import * as path from "node:path";
import { queryModelCallUsage } from "./sqlite/ledgerStore.js";

// 成本/额度:按 provider 累计 token 用量。
// 所有引擎(claude-code/codex/api)的模型调用都经 eventBus 的 model_call_finished 汇入(见 index 订阅者)。
// 诚实边界:订阅制(claude/codex)无余额 API,只能记已用 token + 5h 滚动窗口已用,不假装能精确查"剩余额度"。
//
// B3 起:getUsage **优先从 ledger 的 model_call 行派生**(权威计费流水,见 storage/sqlite/ledgerStore.ts);
// usage.json **停写**(flush 已 no-op),但 setUsageRoot 仍**读**旧 usage.json 作留读兼容 + 账本为空/
// 不可用时的回退来源(getUsage 接口不变,上层零改)。

export interface ProviderUsage {
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
  firstAt: string;
  lastAt: string;
  /** 近 5 小时的调用(用于"订阅窗口已用"估算);超窗自动剪除 */
  window: Array<{ at: number; total: number }>;
  // MUP Gate A#2 · simulated(mock)调用分列:伪 tokens **不计入**上面的真实用量口径
  // (promptTokens/completionTokens/totalTokens/calls/window),单独记在这里。加性字段,
  // 旧 usage.json/旧账本行无标注 = 全算真实(向后兼容)。
  simulatedTokens?: number;
  simulatedCalls?: number;
}

const WINDOW_MS = 5 * 60 * 60 * 1000;

let usageRoot: string | null = null;
let usage: Record<string, ProviderUsage> = {};

function file(root: string) { return path.join(root, ".opc", "usage.json"); }

/** 启动时调用:设根 + 把磁盘已有用量载入内存(合并)。 */
export function setUsageRoot(root: string) {
  usageRoot = root;
  try {
    const disk = JSON.parse(fs.readFileSync(file(root), "utf-8")) as Record<string, ProviderUsage>;
    usage = (disk && typeof disk === "object") ? disk : {};
  } catch { usage = {}; /* 无文件/损坏 → 反映该根的空持久态 */ }
}

// B3:usage.json 停写(账本 = 权威计费流水)。保留函数以最小化 recordUsage 改动;不再落盘。
function flush() { /* no-op:B3 起 usage.json 停写,详见文件头注 */ }

function prune(u: ProviderUsage, now: number) {
  const cut = now - WINDOW_MS;
  if (u.window.length > 0 && u.window[0].at < cut) {
    u.window = u.window.filter((w) => w.at >= cut);
  }
}

/** 记一次模型调用的 token 用量。provider 空则忽略。绝不抛。
 *  opts.simulated=true(mock 调用)→ 只进 simulated 分列,不进真实用量/5h 窗口。 */
export function recordUsage(provider: string | undefined, promptTokens: number, completionTokens: number, opts?: { simulated?: boolean }): void {
  if (!provider) return;
  try {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const p = Math.max(0, promptTokens | 0);
    const c = Math.max(0, completionTokens | 0);
    const total = p + c;
    let u = usage[provider];
    if (!u) {
      u = { provider, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, firstAt: nowIso, lastAt: nowIso, window: [] };
      usage[provider] = u;
    }
    if (opts?.simulated === true) {
      u.simulatedTokens = (u.simulatedTokens ?? 0) + total;
      u.simulatedCalls = (u.simulatedCalls ?? 0) + 1;
      u.lastAt = nowIso;
      return; // 伪 tokens 不落真实口径,也不占订阅窗口
    }
    u.promptTokens += p;
    u.completionTokens += c;
    u.totalTokens += total;
    u.calls += 1;
    u.lastAt = nowIso;
    u.window.push({ at: now, total });
    prune(u, now);
    flush();
  } catch { /* best-effort:用量统计绝不影响 run */ }
}

type UsageOut = ProviderUsage & { windowTokens: number; windowHours: number; oldestAt?: string; oldestFreesAt?: string };

function finalize(list: ProviderUsage[], now: number): UsageOut[] {
  return list.map((u) => {
    prune(u, now);
    const windowTokens = u.window.reduce((a, w) => a + w.total, 0);
    const oldest = u.window[0]?.at;
    return {
      ...u, windowTokens,
      windowHours: WINDOW_MS / 3_600_000,
      oldestAt: oldest ? new Date(oldest).toISOString() : undefined,
      oldestFreesAt: oldest ? new Date(oldest + WINDOW_MS).toISOString() : undefined,
    };
  });
}

// B3:从 ledger 的 model_call 行派生用量(权威)。无账本行 → 返回 null,交给内存回退。
function deriveFromLedger(now: number): UsageOut[] | null {
  if (!usageRoot) return null;
  const rows = queryModelCallUsage(usageRoot);
  if (rows.length === 0) return null;
  const cut = now - WINDOW_MS;
  const map: Record<string, ProviderUsage> = {};
  for (const r of rows) { // 行按追加序(= 时间序)遍历
    const total = r.promptTokens + r.completionTokens;
    const atMs = Date.parse(r.at);
    const valid = !Number.isNaN(atMs);
    const atIso = valid ? new Date(atMs).toISOString() : r.at;
    let u = map[r.provider];
    if (!u) { u = { provider: r.provider, promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, firstAt: atIso, lastAt: atIso, window: [] }; map[r.provider] = u; }
    if (r.simulated) { // mock 伪 tokens 分列,不混真实用量/窗口(旧行无标注 = 真实,兼容)
      u.simulatedTokens = (u.simulatedTokens ?? 0) + total;
      u.simulatedCalls = (u.simulatedCalls ?? 0) + 1;
      u.lastAt = atIso;
      continue;
    }
    u.promptTokens += r.promptTokens;
    u.completionTokens += r.completionTokens;
    u.totalTokens += total;
    u.calls += 1;
    u.lastAt = atIso;
    if (valid && atMs >= cut) u.window.push({ at: atMs, total });
  }
  return finalize(Object.values(map), now);
}

/** 返回各 provider 累计用量 + 近 5h 窗口已用 token + 窗口最早一笔的释放时间(恢复参考)。
 *  windowHours=5h 是 OPC 自己的滚动窗口口径(非厂商真实窗口);最早一笔到 oldestFreesAt 就从窗口释放。
 *  B3:优先从 ledger 派生;账本为空/不可用时回退到内存态(usage.json 载入 + recordUsage 累计)。 */
export function getUsage(): UsageOut[] {
  const now = Date.now();
  const fromLedger = deriveFromLedger(now);
  if (fromLedger) return fromLedger;
  return finalize(Object.values(usage), now);
}

export interface BalanceInfo {
  provider: string;
  /** 能精确查到的真实余额(目前仅 deepseek);查不到为 null */
  available: boolean | null;
  balances?: Array<{ currency: string; total: string; granted?: string; toppedUp?: string }>;
  /** 订阅制等无余额 API 的诚实说明 */
  note?: string;
  error?: string;
}

/** 查 deepseek 真余额(GET /user/balance)。绝不打印/返回 key。失败返回 error,不抛。 */
export async function fetchDeepseekBalance(key: string): Promise<BalanceInfo> {
  try {
    const resp = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { provider: "deepseek", available: null, error: `balance API ${resp.status}` };
    const data = (await resp.json()) as { is_available?: boolean; balance_infos?: Array<Record<string, string>> };
    return {
      provider: "deepseek",
      available: data.is_available ?? null,
      balances: (data.balance_infos ?? []).map((b) => ({
        currency: b.currency, total: b.total_balance, granted: b.granted_balance, toppedUp: b.topped_up_balance,
      })),
    };
  } catch (e: any) {
    return { provider: "deepseek", available: null, error: e?.message?.slice(0, 120) || "balance query failed" };
  }
}

// ── 多供应商余额(用户反馈"填了很多 API 只能查 DeepSeek")────────────────────────────
// 注册表:有公开余额 API 的挨个实现;没有的(minimax/doubao/智谱等)诚实标注,不装能查。
// 统一契约:绝不回显 key;失败返回 error 字段,不抛。

async function fetchOpenRouterBalance(key: string): Promise<BalanceInfo> {
  try {
    const resp = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { provider: "openrouter", available: null, error: `credits API ${resp.status}` };
    const j = (await resp.json()) as { data?: { total_credits?: number; total_usage?: number } };
    const total = j.data?.total_credits ?? 0;
    const used = j.data?.total_usage ?? 0;
    return {
      provider: "openrouter", available: total - used > 0,
      balances: [{ currency: "USD", total: (total - used).toFixed(4), granted: String(total), toppedUp: undefined }],
    };
  } catch (e: any) {
    return { provider: "openrouter", available: null, error: e?.message?.slice(0, 120) || "balance query failed" };
  }
}

async function fetchSiliconFlowBalance(key: string): Promise<BalanceInfo> {
  try {
    const resp = await fetch("https://api.siliconflow.cn/v1/user/info", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { provider: "siliconflow", available: null, error: `user API ${resp.status}` };
    const j = (await resp.json()) as { data?: { balance?: string; totalBalance?: string; chargeBalance?: string } };
    const total = j.data?.totalBalance ?? j.data?.balance ?? "0";
    return {
      provider: "siliconflow", available: parseFloat(total) > 0,
      balances: [{ currency: "CNY", total: String(total), toppedUp: j.data?.chargeBalance }],
    };
  } catch (e: any) {
    return { provider: "siliconflow", available: null, error: e?.message?.slice(0, 120) || "balance query failed" };
  }
}

async function fetchMoonshotBalance(key: string): Promise<BalanceInfo> {
  try {
    const resp = await fetch("https://api.moonshot.cn/v1/users/me/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return { provider: "moonshot", available: null, error: `balance API ${resp.status}` };
    const j = (await resp.json()) as { data?: { available_balance?: number; voucher_balance?: number; cash_balance?: number } };
    const avail = j.data?.available_balance ?? 0;
    return {
      provider: "moonshot", available: avail > 0,
      balances: [{ currency: "CNY", total: String(avail), granted: j.data?.voucher_balance != null ? String(j.data.voucher_balance) : undefined, toppedUp: j.data?.cash_balance != null ? String(j.data.cash_balance) : undefined }],
    };
  } catch (e: any) {
    return { provider: "moonshot", available: null, error: e?.message?.slice(0, 120) || "balance query failed" };
  }
}

export const BALANCE_FETCHERS: Record<string, (key: string) => Promise<BalanceInfo>> = {
  deepseek: fetchDeepseekBalance,
  openrouter: fetchOpenRouterBalance,
  siliconflow: fetchSiliconFlowBalance,
  moonshot: fetchMoonshotBalance,
};

/** 无公开余额 API 的计量制供应商——诚实标注,别让用户以为是我们没做。 */
export const NO_BALANCE_API_NOTE: Record<string, string> = {
  minimax: "MiniMax 未提供公开余额查询 API(仅控制台可见)",
  doubao: "豆包/火山方舟未提供简单余额查询 API(需控制台查看)",
  zhipu: "智谱未提供公开余额查询 API(仅控制台可见)",
};
