import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openDb, closeDb } from "./db.js";
import {
  appendLedger, verifyLedgerChain, deriveCostSource, payloadSimulated,
  sumRunModelCalls, appendRunEndWithReconcile, queryModelCallUsage, readLedgerRows,
} from "./ledgerStore.js";

function tmp(prefix: string) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function cleanup(root: string) { closeDb(root); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } }

describe("ledgerStore — append-only 哈希链", () => {
  let root: string;
  beforeEach(() => { root = tmp("ledger-"); });
  afterEach(() => cleanup(root));

  it("appendLedger 落行 + prevHash 接上一行 rowHash", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", model: "x", promptTokens: 100, completionTokens: 50, costUsd: 0.01, costSource: "api_reported" });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", model: "x", promptTokens: 200, completionTokens: 80, costUsd: 0.02, costSource: "api_reported" });
    const rows = readLedgerRows(root);
    expect(rows.length).toBe(2);
    expect(rows[0].prevHash).toBe("");                 // 首行 prevHash 空串
    expect(rows[1].prevHash).toBe(rows[0].rowHash);    // 链
    expect(rows[0].rowHash).toBeTruthy();
    expect(rows[1].rowHash).not.toBe(rows[0].rowHash);
  });

  it("verifyLedgerChain:全绿链通过", () => {
    for (let i = 0; i < 5; i++) appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: i, completionTokens: i, costUsd: i * 0.001, costSource: "estimated_len4" });
    const v = verifyLedgerChain(root);
    expect(v.ok).toBe(true);
    expect(v.checked).toBe(5);
    expect(v.brokenAt).toBeUndefined();
  });

  it("原地改写任一行内容 → 链断,精确报首个断点", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 10, completionTokens: 5, costUsd: 0.01 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 20, completionTokens: 8, costUsd: 0.02 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 30, completionTokens: 9, costUsd: 0.03 });
    const rows = readLedgerRows(root);
    const targetId = rows[1].id;
    openDb(root).prepare("UPDATE ledger SET costUsd=? WHERE id=?").run(999, targetId); // 改内容不重算 rowHash
    const v = verifyLedgerChain(root);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(targetId);
  });

  it("删除中间一行 → 后一行 prevHash 断链", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 10, completionTokens: 5 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 20, completionTokens: 8 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 30, completionTokens: 9 });
    const rows = readLedgerRows(root);
    openDb(root).prepare("DELETE FROM ledger WHERE id=?").run(rows[1].id);
    const v = verifyLedgerChain(root);
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(rows[2].id); // 第3行 prevHash 指向被删的第2行
  });

  it("costSource 三态诚实区分 + 落库读回", () => {
    expect(deriveCostSource({ usageEstimated: true, promptTokens: 5, completionTokens: 5 })).toBe("estimated_len4");
    expect(deriveCostSource({ promptTokens: 100, completionTokens: 50 })).toBe("api_reported");
    expect(deriveCostSource({})).toBe("pricing_table");
    expect(deriveCostSource(undefined)).toBe("pricing_table");
    appendLedger(root, { kind: "model_call", runId: "r", costSource: "estimated_len4" });
    appendLedger(root, { kind: "model_call", runId: "r", costSource: "api_reported" });
    appendLedger(root, { kind: "model_call", runId: "r", costSource: "pricing_table" });
    expect(readLedgerRows(root).map((r) => r.costSource)).toEqual(["estimated_len4", "api_reported", "pricing_table"]);
  });

  it("append NEVER throws(循环 payload 也安全:payload 落 null,行仍落)", () => {
    const circular: any = {}; circular.self = circular;
    expect(() => appendLedger(root, { kind: "model_call", payload: circular })).not.toThrow();
    const rows = readLedgerRows(root);
    expect(rows.length).toBe(1);
    expect(rows[0].payload).toBeNull();
    expect(verifyLedgerChain(root).ok).toBe(true);
  });
});

describe("ledgerStore — 对账(run_end == 该 run model_call 求和)", () => {
  let root: string;
  beforeEach(() => { root = tmp("ledger-rec-"); });
  afterEach(() => cleanup(root));

  it("sumRunModelCalls 只汇总本 run 的 model_call 行", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 100, completionTokens: 50, costUsd: 0.01 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 200, completionTokens: 80, costUsd: 0.02 });
    appendLedger(root, { kind: "model_call", runId: "r2", promptTokens: 999, completionTokens: 999, costUsd: 9 }); // 别的 run 不算
    const sum = sumRunModelCalls(root, "r1");
    expect(sum.tokens).toBe(430);
    expect(sum.promptTokens).toBe(300);
    expect(sum.completionTokens).toBe(130);
    expect(sum.costUsd).toBeCloseTo(0.03, 10);
    expect(sum.calls).toBe(2);
  });

  it("一致:落 run_end 汇总,不落 reconcile_mismatch", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 100, completionTokens: 50, costUsd: 0.01 });
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 200, completionTokens: 80, costUsd: 0.02 });
    const res = appendRunEndWithReconcile(root, "r1", 430, 0.03);
    expect(res.mismatch).toBe(false);
    const rows = readLedgerRows(root);
    expect(rows.some((r) => r.kind === "run_end")).toBe(true);
    expect(rows.some((r) => r.kind === "reconcile_mismatch")).toBe(false);
    expect(verifyLedgerChain(root).ok).toBe(true);
  });

  it("不一致:如实落 reconcile_mismatch 行(不造假抹平)", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", promptTokens: 100, completionTokens: 50, costUsd: 0.01 });
    const res = appendRunEndWithReconcile(root, "r1", 999, 0.01); // run 上报 999 与账本 150 不符
    expect(res.mismatch).toBe(true);
    expect(res.tokenMismatch).toBe(true);
    expect(res.costMismatch).toBe(false);
    const mm = readLedgerRows(root).find((r) => r.kind === "reconcile_mismatch");
    expect(mm).toBeTruthy();
    const payload = JSON.parse(mm.payload);
    expect(payload.reportedTokens).toBe(999);
    expect(payload.ledgerTokens).toBe(150);
    expect(verifyLedgerChain(root).ok).toBe(true); // 对账行本身也在链上,链仍完整
  });

  it("queryModelCallUsage 只取 model_call 且 provider 非空", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 10, completionTokens: 5, costUsd: 0.001 });
    appendLedger(root, { kind: "run_end", runId: "r1" });
    appendLedger(root, { kind: "model_call", runId: "r2", provider: "anthropic", promptTokens: 20, completionTokens: 8, costUsd: 0.002 });
    const rows = queryModelCallUsage(root);
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.provider).sort()).toEqual(["anthropic", "deepseek"]);
  });
});

// MUP Gate A#2 · simulated 标注:mock 伪 tokens 不再混入真实账本口径。
// 表结构/canonical 冻结不动:标注折进 payload JSON(payload 本就入哈希链),旧行无字段 = 非 simulated。
describe("ledgerStore — simulated 标注(MUP Gate A#2/矩阵8)", () => {
  let root: string;
  beforeEach(() => { root = tmp("ledger-sim-"); });
  afterEach(() => cleanup(root));

  it("entry.simulated=true → 折进 payload JSON,链完整;payloadSimulated 判定真", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", promptTokens: 50, completionTokens: 30, costUsd: 0, simulated: true });
    const rows = readLedgerRows(root);
    expect(rows.length).toBe(1);
    expect(JSON.parse(rows[0].payload).simulated).toBe(true);
    expect(payloadSimulated(rows[0].payload)).toBe(true);
    expect(verifyLedgerChain(root).ok).toBe(true);
  });

  it("已有 payload 对象:simulated 合并进去,原字段保留", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", payload: { tokens: 80, model: "m" }, simulated: true });
    const p = JSON.parse(readLedgerRows(root)[0].payload);
    expect(p).toEqual({ tokens: 80, model: "m", simulated: true });
  });

  it("payload 事件流自带 simulated:true(index.ts 原样透传路径)同样被判定", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", payload: { provider: "mock", simulated: true } });
    expect(payloadSimulated(readLedgerRows(root)[0].payload)).toBe(true);
  });

  it("旧行/真实行无标注 → payloadSimulated=false(向后兼容:无字段 = 非 simulated)", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", payload: { tokens: 100 } });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek" }); // payload 为空
    const rows = readLedgerRows(root);
    expect(payloadSimulated(rows[0].payload)).toBe(false);
    expect(payloadSimulated(rows[1].payload)).toBe(false);
    expect(payloadSimulated(null)).toBe(false);
    expect(payloadSimulated(undefined)).toBe(false);
    expect(payloadSimulated("{not json}")).toBe(false);
  });

  it("queryModelCallUsage 行带 simulated 标注(usageStore 据此分列)", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", promptTokens: 50, completionTokens: 30, costUsd: 0, simulated: true });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 100, completionTokens: 40, costUsd: 0.01 });
    const rows = queryModelCallUsage(root);
    expect(rows.find((r) => r.provider === "mock")?.simulated).toBe(true);
    expect(rows.find((r) => r.provider === "deepseek")?.simulated).toBe(false);
  });

  it("sumRunModelCalls 分列:totals 含全部落账行(对账口径),simulated* 单列 mock 部分", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", promptTokens: 50, completionTokens: 30, costUsd: 0, simulated: true });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 100, completionTokens: 40, costUsd: 0.01 });
    const sum = sumRunModelCalls(root, "r1");
    expect(sum.tokens).toBe(220);          // 对账口径 = 全部行(run 上报 totals 今天也含 mock tokens)
    expect(sum.calls).toBe(2);
    expect(sum.simulatedTokens).toBe(80);  // 其中 mock 伪 tokens 分列可辨
    expect(sum.simulatedCalls).toBe(1);
    expect(sum.simulatedCostUsd).toBe(0);
  });

  it("纯 mock run 对账:上报 totals == 落账求和 → 不落 reconcile_mismatch(加性标注不破对账)", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", promptTokens: 50, completionTokens: 30, costUsd: 0, simulated: true });
    const res = appendRunEndWithReconcile(root, "r1", 80, 0);
    expect(res.mismatch).toBe(false);
    expect(res.sum.simulatedTokens).toBe(80);
    expect(readLedgerRows(root).some((r) => r.kind === "reconcile_mismatch")).toBe(false);
    expect(verifyLedgerChain(root).ok).toBe(true);
  });
});
