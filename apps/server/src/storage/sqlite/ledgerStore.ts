import { createHash } from "node:crypto";
import { openDb, type DatabaseSync } from "./db.js";
import { ensureSchema } from "./schema.js";

// 战役B·Phase B3:Ledger 真实计费流水(append-only 哈希链)。写 B1 已建的 ledger 表(schema.ts:214)。
//
// ── 诚实边界(务必读)────────────────────────────────────────────────────────────
// rowHash = sha256(prevHash + 规范化行内容),prevHash = 该库最后一行的 rowHash。这条哈希链
// **只保证追加序完整**:任何对已落行的原地改写 / 删除 / 插入,都会让 verifyLedgerChain 从该点起
// 重算不上,精确报出首个断点(tamper-EVIDENT)。它**不防带库重写**:有 opc.sqlite 写权限的人可以
// 从伪造的历史出发,对每一行重算 prevHash+rowHash,得到一条自洽的假链,verify 会通过。没有密钥、
// 没有外部锚点(如公证/区块链),就没有密码学意义的防篡改(NOT tamper-PROOF)。别宣称做不到的事。
//
// ── costSource 三态口径(诚实区分 token 来源)──────────────────────────────────────
//   api_reported   —— 供应商 API 真回报了 usage(prompt/completion tokens),最可信。
//   estimated_len4 —— API 未回报 usage,tokens 由 text.length/4 估算(modelGateway 的 usageEstimated=true)。
//   pricing_table  —— 只拿到聚合 tokens/cost、无 prompt/completion 分解的执行器路径(mock 等):
//                     成本由本地定价表派生,不冒充逐 token 的 API 回报。
//
// 全部函数 best-effort:NEVER throws(账本写入/校验绝不影响 run 与事件流)。

export type LedgerKind = "model_call" | "run_start" | "run_end" | "artifact" | "reconcile_mismatch";
export type CostSource = "api_reported" | "estimated_len4" | "pricing_table";

export interface LedgerEntry {
  kind: LedgerKind;
  at?: string;                 // 缺省 = now ISO
  runId?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  costSource?: CostSource;
  engine?: string;
  executor?: string;
  payload?: unknown;           // 整条明细,落 payload 列(JSON)
  // MUP Gate A#2 · mock provider 调用的记账行标注。表结构/canonical 序列化冻结不动(改列会让
  // 存量链 verify 断),标注折进 payload JSON({...payload, simulated:true},payload 本就入链)。
  // 向后兼容:旧行 payload 无 simulated 字段 = 非 simulated。
  simulated?: boolean;
}

// 规范化行(undefined→null,payload→JSON 串)。canonical/rowHash 只吃它,verify 从存储列重建同一形状。
interface NormalizedRow {
  at: string;
  kind: string;
  runId: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number | null;
  costSource: string | null;
  engine: string | null;
  executor: string | null;
  payload: string | null;      // 已 JSON.stringify 的字符串,或 null
}

function safeJson(v: unknown): string | null {
  if (v === undefined) return null;
  try { return JSON.stringify(v); } catch { return null; /* 循环引用等 → 不入 payload,不阻断落账 */ }
}

// 位置数组序列化 = 无键序歧义的规范化行内容。append 与 verify 必须走同一函数,逐字节一致。
function canonical(r: NormalizedRow): string {
  return JSON.stringify([
    r.at, r.kind, r.runId, r.agentId, r.provider, r.model,
    r.promptTokens, r.completionTokens, r.costUsd, r.costSource,
    r.engine, r.executor, r.payload,
  ]);
}

function rowHashOf(prevHash: string, r: NormalizedRow): string {
  return createHash("sha256").update(prevHash + canonical(r)).digest("hex");
}

// entry.simulated === true 时把标注折进 payload 对象(非对象 payload 包进 value 保原值);其余原样。
function foldSimulated(payload: unknown, simulated: boolean | undefined): unknown {
  if (simulated !== true) return payload;
  if (payload === undefined || payload === null) return { simulated: true };
  if (typeof payload === "object" && !Array.isArray(payload)) return { ...(payload as Record<string, unknown>), simulated: true };
  return { value: payload, simulated: true };
}

// 行级判定:payload JSON 含 simulated:true → 该行是模拟调用。旧行/无 payload = false。
export function payloadSimulated(payload: string | null | undefined): boolean {
  if (!payload) return false;
  try { return (JSON.parse(payload) as { simulated?: unknown })?.simulated === true; } catch { return false; }
}

function normalize(entry: LedgerEntry): NormalizedRow {
  return {
    at: entry.at ?? new Date().toISOString(),
    kind: entry.kind,
    runId: entry.runId ?? null,
    agentId: entry.agentId ?? null,
    provider: entry.provider ?? null,
    model: entry.model ?? null,
    promptTokens: entry.promptTokens ?? null,
    completionTokens: entry.completionTokens ?? null,
    costUsd: entry.costUsd ?? null,
    costSource: entry.costSource ?? null,
    engine: entry.engine ?? null,
    executor: entry.executor ?? null,
    payload: safeJson(foldSimulated(entry.payload, entry.simulated)),
  };
}

const INSERT_SQL = `INSERT INTO ledger
  (at, kind, runId, agentId, provider, model, promptTokens, completionTokens, costUsd, costSource, engine, executor, payload, prevHash, rowHash)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

/** 追加一行计费流水,自动接哈希链(prevHash=库内最后一行 rowHash)。best-effort,NEVER throws。 */
export function appendLedger(projectRoot: string, entry: LedgerEntry): void {
  try {
    const db = openDb(projectRoot);
    ensureSchema(db);
    const norm = normalize(entry);
    const prev = db.prepare("SELECT rowHash FROM ledger ORDER BY id DESC LIMIT 1").get() as { rowHash?: string } | undefined;
    const prevHash = prev?.rowHash ?? "";
    const rowHash = rowHashOf(prevHash, norm);
    db.prepare(INSERT_SQL).run(
      norm.at, norm.kind, norm.runId, norm.agentId, norm.provider, norm.model,
      norm.promptTokens, norm.completionTokens, norm.costUsd, norm.costSource,
      norm.engine, norm.executor, norm.payload, prevHash, rowHash,
    );
  } catch { /* best-effort:账本绝不影响 run/事件流 */ }
}

export interface LedgerVerifyResult {
  ok: boolean;
  checked: number;        // 已校验行数
  brokenAt?: number;      // 首个断点的 ledger.id
  reason?: string;
}

/** 逐行重算校验哈希链,返回首个断点(id)。断链 = 有行被原地改写/删除/插入。best-effort,NEVER throws。 */
export function verifyLedgerChain(projectRoot: string): LedgerVerifyResult {
  try {
    const db = openDb(projectRoot);
    ensureSchema(db);
    const rows = db.prepare("SELECT * FROM ledger ORDER BY id ASC").all() as any[];
    let prevHash = "";
    let checked = 0;
    for (const r of rows) {
      checked++;
      // 1) prevHash 必须链到上一行的 rowHash(空串 = 第一行)
      if ((r.prevHash ?? "") !== prevHash) {
        return { ok: false, checked, brokenAt: Number(r.id), reason: `prevHash 断链 @id=${r.id}` };
      }
      // 2) rowHash 必须等于按存储列重算的值
      const norm: NormalizedRow = {
        at: r.at, kind: r.kind,
        runId: r.runId ?? null, agentId: r.agentId ?? null,
        provider: r.provider ?? null, model: r.model ?? null,
        promptTokens: r.promptTokens ?? null, completionTokens: r.completionTokens ?? null,
        costUsd: r.costUsd ?? null, costSource: r.costSource ?? null,
        engine: r.engine ?? null, executor: r.executor ?? null,
        payload: r.payload ?? null,
      };
      if (rowHashOf(prevHash, norm) !== r.rowHash) {
        return { ok: false, checked, brokenAt: Number(r.id), reason: `rowHash 断链 @id=${r.id}` };
      }
      prevHash = r.rowHash;
    }
    return { ok: true, checked };
  } catch (e) {
    return { ok: false, checked: 0, reason: `verify 异常:${(e as Error)?.message ?? String(e)}` };
  }
}

// ── costSource 判定:只据 model_call_finished 事件 payload,诚实区分三态 ─────────────────
export function deriveCostSource(payload: {
  usageEstimated?: boolean;
  promptTokens?: number | null;
  completionTokens?: number | null;
} | null | undefined): CostSource {
  if (payload?.usageEstimated === true) return "estimated_len4";
  if (payload?.promptTokens != null && payload?.completionTokens != null) return "api_reported";
  return "pricing_table";
}

export interface RunModelCallSum {
  tokens: number;             // prompt + completion(含 simulated 行:对账口径 = 全部落账行)
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  calls: number;
  // MUP Gate A#2 · 分列:其中来自 simulated(mock)行的部分。totals 仍含 simulated(run_end 对账
  // 比的是"上报 == 落账",不是财务口径);财务/用量口径请用 totals - simulated 或 usageStore 分列。
  simulatedTokens: number;
  simulatedCostUsd: number;
  simulatedCalls: number;
}

/** 汇总某 run 的全部 model_call 行(对账/run_end 用),simulated 行分列。best-effort,失败返回全 0。 */
export function sumRunModelCalls(projectRoot: string, runId: string | undefined): RunModelCallSum {
  const empty: RunModelCallSum = { tokens: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, calls: 0, simulatedTokens: 0, simulatedCostUsd: 0, simulatedCalls: 0 };
  if (!runId) return empty;
  try {
    const db = openDb(projectRoot);
    ensureSchema(db);
    const rows = db.prepare(
      `SELECT promptTokens, completionTokens, costUsd, payload
       FROM ledger WHERE kind='model_call' AND runId=? ORDER BY id ASC`,
    ).all(runId) as Array<{ promptTokens?: number; completionTokens?: number; costUsd?: number; payload?: string | null }>;
    const sum = { ...empty };
    for (const r of rows) {
      const pt = Number(r.promptTokens ?? 0);
      const ct = Number(r.completionTokens ?? 0);
      const cost = Number(r.costUsd ?? 0);
      sum.promptTokens += pt;
      sum.completionTokens += ct;
      sum.costUsd += cost;
      sum.calls += 1;
      if (payloadSimulated(r.payload)) {
        sum.simulatedTokens += pt + ct;
        sum.simulatedCostUsd += cost;
        sum.simulatedCalls += 1;
      }
    }
    sum.tokens = sum.promptTokens + sum.completionTokens;
    return sum;
  } catch { return empty; }
}

export interface ReconcileResult {
  sum: RunModelCallSum;
  mismatch: boolean;
  tokenMismatch: boolean;
  costMismatch: boolean;
}

const COST_EPSILON = 1e-9; // 浮点求和重结合的容差(避免同值不同序相加的 ~1e-15 抖动误报)

/**
 * run 收尾:落 run_end 汇总行 + 对账。run_end 报告的 totals **必须** == 该 run model_call 行求和;
 * 不一致如实落一条 reconcile_mismatch 行(绝不造假抹平)。best-effort,NEVER throws。
 */
export function appendRunEndWithReconcile(
  projectRoot: string,
  runId: string | undefined,
  reportedTokens: number | undefined,
  reportedCost: number | undefined,
): ReconcileResult {
  const sum = sumRunModelCalls(projectRoot, runId);
  const rTok = reportedTokens ?? 0;
  const rCost = reportedCost ?? 0;
  const tokenMismatch = rTok !== sum.tokens;
  const costMismatch = Math.abs(rCost - sum.costUsd) > COST_EPSILON;
  const mismatch = tokenMismatch || costMismatch;

  appendLedger(projectRoot, {
    kind: "run_end",
    runId,
    promptTokens: sum.promptTokens,
    completionTokens: sum.completionTokens,
    costUsd: reportedCost,          // 头条 = run 上报的权威总成本
    // run_end 是聚合行,不是单次测量 → costSource 留空(不冒充某一种 token 来源)
    payload: {
      reportedTotalTokens: reportedTokens ?? null,
      reportedTotalCost: reportedCost ?? null,
      ledgerModelCallSum: sum,
    },
  });

  if (mismatch) {
    appendLedger(projectRoot, {
      kind: "reconcile_mismatch",
      runId,
      promptTokens: sum.promptTokens,
      completionTokens: sum.completionTokens,
      costUsd: sum.costUsd,
      payload: {
        reportedTokens: rTok, ledgerTokens: sum.tokens,
        reportedCost: rCost, ledgerCost: sum.costUsd,
        calls: sum.calls, tokenMismatch, costMismatch,
      },
    });
  }
  return { sum, mismatch, tokenMismatch, costMismatch };
}

export interface LedgerUsageRow {
  provider: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  at: string;
  // MUP Gate A#2 · 该行是 simulated(mock)调用:usageStore 据此把伪 tokens 分列,不混真实用量口径。
  simulated: boolean;
}

/** 供 usageStore 派生用量:按追加序返回全部 model_call 行(provider 非空),带 simulated 标注。best-effort,失败返回 []。 */
export function queryModelCallUsage(projectRoot: string): LedgerUsageRow[] {
  try {
    const db = openDb(projectRoot);
    ensureSchema(db);
    const rows = db.prepare(
      `SELECT provider, promptTokens, completionTokens, costUsd, at, payload
       FROM ledger WHERE kind='model_call' AND provider IS NOT NULL ORDER BY id ASC`,
    ).all() as any[];
    return rows.map((r) => ({
      provider: String(r.provider),
      promptTokens: Number(r.promptTokens ?? 0),
      completionTokens: Number(r.completionTokens ?? 0),
      costUsd: Number(r.costUsd ?? 0),
      at: String(r.at),
      simulated: payloadSimulated(r.payload),
    }));
  } catch { return []; }
}

// 测试/未来 doctor 探针用:读全部行(含链字段)。best-effort,失败返回 []。
export function readLedgerRows(projectRoot: string): any[] {
  try {
    const db = openDb(projectRoot);
    ensureSchema(db);
    return db.prepare("SELECT * FROM ledger ORDER BY id ASC").all() as any[];
  } catch { return []; }
}

export type { DatabaseSync };
