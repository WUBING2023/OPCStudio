import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setUsageRoot, recordUsage, getUsage } from "./usageStore.js";
import { appendLedger } from "./sqlite/ledgerStore.js";
import { closeDb } from "./sqlite/db.js";

describe("usageStore — B3 派生化(ledger 权威 + 内存回退)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"));
    setUsageRoot(root); // 新空目录 → 重置为空,测试间隔离
  });
  afterEach(() => { closeDb(root); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("getUsage 优先从 ledger 的 model_call 行派生(累计 + 5h 窗口)", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 100, completionTokens: 50, costUsd: 0.01 });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 200, completionTokens: 80, costUsd: 0.02 });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "claude-code", promptTokens: 10, completionTokens: 5 });
    appendLedger(root, { kind: "run_end", runId: "r1" }); // 汇总行不计入用量
    const list = getUsage();
    expect(list.length).toBe(2);
    const ds = list.find((x) => x.provider === "deepseek")!;
    expect(ds.promptTokens).toBe(300);
    expect(ds.completionTokens).toBe(130);
    expect(ds.totalTokens).toBe(430);
    expect(ds.calls).toBe(2);
    expect(ds.windowTokens).toBe(430); // 刚追加 → 都在 5h 窗口内
  });

  it("账本为空 → 回退内存态(recordUsage 累计),接口零变", () => {
    recordUsage("deepseek", 100, 50);
    recordUsage("deepseek", 200, 80);
    const u = getUsage().find((x) => x.provider === "deepseek")!;
    expect(u.promptTokens).toBe(300);
    expect(u.completionTokens).toBe(130);
    expect(u.totalTokens).toBe(430);
    expect(u.calls).toBe(2);
    expect(u.windowTokens).toBe(430);
  });

  it("ledger 有数据时压过内存回退(账本为权威)", () => {
    recordUsage("deepseek", 1, 1);                         // 内存里放个小数
    appendLedger(root, { kind: "model_call", provider: "deepseek", promptTokens: 500, completionTokens: 500 });
    const u = getUsage().find((x) => x.provider === "deepseek")!;
    expect(u.totalTokens).toBe(1000);                       // 取账本 1000,不是内存的 2
  });

  it("留读兼容:setUsageRoot 载入旧 usage.json,账本为空时经回退可见", () => {
    const nowIso = new Date().toISOString();
    const legacy = { anthropic: { provider: "anthropic", promptTokens: 7, completionTokens: 3, totalTokens: 10, calls: 1, firstAt: nowIso, lastAt: nowIso, window: [] } };
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "usage.json"), JSON.stringify(legacy));
    setUsageRoot(root); // 重新载入旧账
    expect(getUsage().find((x) => x.provider === "anthropic")?.totalTokens).toBe(10);
  });

  it("usage.json 停写:recordUsage 后磁盘不再生成 usage.json", () => {
    recordUsage("deepseek", 10, 5);
    expect(fs.existsSync(path.join(root, ".opc", "usage.json"))).toBe(false);
  });

  it("recordUsage 绝不抛(provider 空/根未设也安全)", () => {
    expect(() => recordUsage("", 1, 1)).not.toThrow();
    expect(() => recordUsage(undefined, 1, 1)).not.toThrow();
  });
});

// MUP Gate A#2 · simulated 分列:mock 伪 tokens(80/120)不混入真实用量/订阅窗口口径。
describe("usageStore — simulated(mock)用量分列(MUP Gate A#2/矩阵8)", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sim-"));
    setUsageRoot(root);
  });
  afterEach(() => { closeDb(root); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("ledger 派生:simulated 行不进真实 totals/窗口,单列 simulatedTokens/simulatedCalls", () => {
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "mock", promptTokens: 50, completionTokens: 30, costUsd: 0, simulated: true });
    appendLedger(root, { kind: "model_call", runId: "r1", provider: "deepseek", promptTokens: 100, completionTokens: 40, costUsd: 0.01 });
    const list = getUsage();
    const mock = list.find((x) => x.provider === "mock")!;
    expect(mock.totalTokens).toBe(0);        // 伪 tokens 不进真实口径
    expect(mock.calls).toBe(0);
    expect(mock.windowTokens).toBe(0);       // 也不占 5h 订阅窗口
    expect(mock.simulatedTokens).toBe(80);   // 分列可见,不隐瞒
    expect(mock.simulatedCalls).toBe(1);
    const ds = list.find((x) => x.provider === "deepseek")!;
    expect(ds.totalTokens).toBe(140);        // 真实用量不受影响
    expect(ds.simulatedTokens).toBeUndefined();
  });

  it("旧账本行无标注 = 真实用量(向后兼容,不重写历史)", () => {
    appendLedger(root, { kind: "model_call", runId: "r0", provider: "mock", promptTokens: 50, completionTokens: 30 }); // 标记接线前的存量 mock 行
    const mock = getUsage().find((x) => x.provider === "mock")!;
    expect(mock.totalTokens).toBe(80);
    expect(mock.simulatedTokens).toBeUndefined();
  });

  it("内存回退:recordUsage(..., {simulated:true}) 同样分列,不进真实口径/窗口", () => {
    recordUsage("mock", 50, 30, { simulated: true });
    recordUsage("deepseek", 100, 40);
    const list = getUsage();
    const mock = list.find((x) => x.provider === "mock")!;
    expect(mock.totalTokens).toBe(0);
    expect(mock.windowTokens).toBe(0);
    expect(mock.simulatedTokens).toBe(80);
    expect(mock.simulatedCalls).toBe(1);
    expect(list.find((x) => x.provider === "deepseek")!.totalTokens).toBe(140);
  });
});
