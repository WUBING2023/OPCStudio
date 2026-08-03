import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  writeRunResult,
  writeDiagnostics,
  appendToolCalls,
  writeWorkerConfig,
  buildRunResultContract,
  buildCrashRunResultContract,
  buildCrashDiagnostics,
  deriveToolCallRecords,
  deriveRunDiagnostics,
  deriveRetryCount,
  deriveTestEvidence,
  aggregateTestRes,
  type ContractSourceEvent,
} from "./runtimeContract.js";
import type { RunResultContract, RunDiagnostics, ToolCallRecord, WorkerConfigSnapshot } from "@opc/shared";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.500Z";
const T2 = "2026-01-01T00:00:03.000Z";
const T3 = "2026-01-01T00:00:05.000Z";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "opc-rc-"));
}

function readRunFile(root: string, runId: string, name: string): string {
  return fs.readFileSync(path.join(root, ".opc", "runs", runId, name), "utf-8");
}

const baseContract: RunResultContract = {
  schemaVersion: "1",
  runId: "run-1",
  status: "done",
  startedAt: T0,
  endedAt: T3,
  agents: [{ agentId: "w1", role: "worker", framework: "hermes", status: "idle", tokens: 120, costUsd: 0.002 }],
  artifacts: [{ id: "art-1", producedBy: "w1", kind: "report", type: "design-doc", name: "方案文档" }],
  deferred: [],
  totalTokens: 120,
  totalCostUsd: 0.002,
};

// ── writers:字段完整性 / utf-8 / 失败不抛 ────────────────────────────────────────

describe("writeRunResult", () => {
  it("写出 result.json,字段完整且可 round-trip", () => {
    const root = tmpRoot();
    writeRunResult(root, baseContract);
    const parsed = JSON.parse(readRunFile(root, "run-1", "result.json"));
    expect(parsed).toEqual(baseContract);
    expect(parsed.schemaVersion).toBe("1");
  });

  it("中文内容以 utf-8 落盘(读回逐字相等)", () => {
    const root = tmpRoot();
    const c: RunResultContract = { ...baseContract, degraded: true, degradedReason: "协调者过载:合成失败" };
    writeRunResult(root, c);
    const raw = readRunFile(root, "run-1", "result.json");
    expect(raw).toContain("协调者过载:合成失败");
    expect(raw).toContain("方案文档");
  });

  it("写失败不抛(.opc 位置被文件占用 → mkdir 失败被吞)", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".opc"), "not a dir", "utf-8");
    expect(() => writeRunResult(root, baseContract)).not.toThrow();
  });
});

describe("writeDiagnostics", () => {
  const diag: RunDiagnostics = {
    schemaVersion: "1",
    runId: "run-2",
    engineFailures: [{ at: T1, agentId: "w1", message: "engine crashed" }],
    providerFallbacks: [],
    rateLimitHits: [],
    permissionBlocks: [],
    notes: ["deliverable_degraded: 合成失败"],
  };

  it("写出 diagnostics.json,五个诊断字段齐全", () => {
    const root = tmpRoot();
    writeDiagnostics(root, diag);
    const parsed = JSON.parse(readRunFile(root, "run-2", "diagnostics.json"));
    expect(parsed).toEqual(diag);
    for (const k of ["engineFailures", "providerFallbacks", "rateLimitHits", "permissionBlocks", "notes"]) {
      expect(Array.isArray(parsed[k])).toBe(true);
    }
  });

  it("写失败不抛", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".opc"), "not a dir", "utf-8");
    expect(() => writeDiagnostics(root, diag)).not.toThrow();
  });
});

describe("appendToolCalls", () => {
  const rec = (tool: string): ToolCallRecord => ({ ts: T0, agentId: "w1", tool, argsSummary: "{}", ok: true });

  it("追加写 jsonl:两批共 3 行,每行独立可解析", () => {
    const root = tmpRoot();
    appendToolCalls(root, "run-3", [rec("read_file"), rec("shell")]);
    appendToolCalls(root, "run-3", [rec("write_file")]);
    const lines = readRunFile(root, "run-3", "tool_calls.jsonl").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => JSON.parse(l).tool)).toEqual(["read_file", "shell", "write_file"]);
  });

  it("records 为空 → 不创建文件", () => {
    const root = tmpRoot();
    appendToolCalls(root, "run-3", []);
    expect(fs.existsSync(path.join(root, ".opc", "runs", "run-3", "tool_calls.jsonl"))).toBe(false);
  });

  it("写失败不抛", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".opc"), "not a dir", "utf-8");
    expect(() => appendToolCalls(root, "run-3", [rec("shell")])).not.toThrow();
  });
});

describe("writeWorkerConfig", () => {
  const snap: WorkerConfigSnapshot = {
    schemaVersion: "1",
    runId: "run-4",
    companyId: "default",
    teamMode: "balanced",
    runType: "team",
    agents: [{ agentId: "ceo-1", name: "CEO", role: "ceo", framework: "hermes", provider: "deepseek", model: "deepseek-chat" }],
    createdAt: T0,
  };

  it("写出 worker.config.json,字段完整", () => {
    const root = tmpRoot();
    writeWorkerConfig(root, snap);
    expect(JSON.parse(readRunFile(root, "run-4", "worker.config.json"))).toEqual(snap);
  });

  it("写失败不抛", () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, ".opc"), "not a dir", "utf-8");
    expect(() => writeWorkerConfig(root, snap)).not.toThrow();
  });
});

// ── buildRunResultContract:聚合与边界 ───────────────────────────────────────────

describe("buildRunResultContract", () => {
  const run = {
    id: "run-5",
    status: "done" as const,
    startedAt: T0,
    endedAt: T3,
    totalTokens: 300,
    totalCostUsd: 0.01,
    participatingAgents: ["ceo-1", "w1", "w1"], // 重复 id → 去重
  };
  const agents = [
    { id: "ceo-1", role: "ceo", framework: "hermes", status: "idle" },
    { id: "w1", role: "worker", framework: "claude-code", status: "failed" },
  ];
  const callRecords = [
    { agentId: "ceo-1", totalTokens: 100, estimatedCostUsd: 0.004 },
    { agentId: "w1", totalTokens: 150, estimatedCostUsd: 0.005 },
    { agentId: "w1", totalTokens: 50, estimatedCostUsd: undefined },
  ];

  it("按 agent 汇总 tokens/costUsd,participatingAgents 去重", () => {
    const c = buildRunResultContract({ run, agents, callRecords, artifacts: [], deferred: [] });
    expect(c.agents).toHaveLength(2);
    const w1 = c.agents.find((a) => a.agentId === "w1")!;
    expect(w1).toEqual({ agentId: "w1", role: "worker", framework: "claude-code", status: "failed", tokens: 200, costUsd: 0.005 });
    expect(c.schemaVersion).toBe("1");
    expect(c.runId).toBe("run-5");
    expect(c.status).toBe("done");
    expect(c.startedAt).toBe(T0);
    expect(c.endedAt).toBe(T3);
  });

  it("deferred 非空 → 摘要完整进 contract", () => {
    const c = buildRunResultContract({
      run, agents, callRecords, artifacts: [],
      deferred: [{ taskId: "t1", agentId: "w1", reason: "timeout", attempts: 3 }],
    });
    expect(c.deferred).toEqual([{ taskId: "t1", agentId: "w1", reason: "timeout", attempts: 3 }]);
  });

  it("找不到 agent 配置 → role/framework/status 用诚实占位而非抛错", () => {
    const c = buildRunResultContract({
      run: { ...run, participatingAgents: ["ghost"] },
      agents, callRecords: [], artifacts: [], deferred: [],
    });
    expect(c.agents[0]).toEqual({ agentId: "ghost", role: "unknown", framework: "api", status: "unknown", tokens: 0, costUsd: 0 });
  });

  it("artifact summary 截断到 300 字符;degraded run 带 degradedReason", () => {
    const c = buildRunResultContract({
      run: { ...run, degraded: true, degradedReason: "合成失败" },
      agents, callRecords,
      artifacts: [{ id: "a1", producedBy: "w1", kind: "text", type: "file", name: "x", summary: "长".repeat(400) }],
      deferred: [],
    });
    expect(c.artifacts[0].summary).toHaveLength(300);
    expect(c.degraded).toBe(true);
    expect(c.degradedReason).toBe("合成失败");
  });

  it("非 degraded run 不带 degraded/degradedReason 键", () => {
    const c = buildRunResultContract({ run, agents, callRecords, artifacts: [], deferred: [] });
    expect("degraded" in c).toBe(false);
    expect("degradedReason" in c).toBe(false);
  });

  it("A6b:run.executorDegraded 透传进 result.json;缺省时不带该键", () => {
    const on = buildRunResultContract({
      run: { ...run, executorDegraded: true }, agents, callRecords, artifacts: [], deferred: [],
    });
    expect(on.executorDegraded).toBe(true);
    // 降级 run 仍是 done(合法保底,不误杀):status 独立于 executorDegraded
    expect(on.status).toBe("done");
    const off = buildRunResultContract({ run, agents, callRecords, artifacts: [], deferred: [] });
    expect("executorDegraded" in off).toBe(false);
  });

  it("MUP 波2(加性):run.deliveryAcceptance 透传 status/reasons;空 reasons 不写占位;缺省时不带该键", () => {
    const on = buildRunResultContract({
      run: { ...run, deliveryAcceptance: { status: "tests_ran_unbound", reasons: ["独立测试证据未强绑定本 run 交付合同"] } },
      agents, callRecords, artifacts: [], deferred: [],
    });
    expect(on.deliveryAcceptance).toEqual({ status: "tests_ran_unbound", reasons: ["独立测试证据未强绑定本 run 交付合同"] });

    const noReasons = buildRunResultContract({
      run: { ...run, deliveryAcceptance: { status: "verified", reasons: [] } },
      agents, callRecords, artifacts: [], deferred: [],
    });
    expect(noReasons.deliveryAcceptance).toEqual({ status: "verified" });
    expect("reasons" in noReasons.deliveryAcceptance!).toBe(false);

    const off = buildRunResultContract({ run, agents, callRecords, artifacts: [], deferred: [] });
    expect("deliveryAcceptance" in off).toBe(false); // 老 run/未走验收门 → 键缺省,加性不破冻结形状
  });
});

// ── B1 · 崩溃路径最小失败契约(startRun catch 兜底) ─────────────────────────────────

describe("buildCrashRunResultContract / buildCrashDiagnostics", () => {
  it("result:status=failed、空 agents/artifacts/deferred、degradedReason=错误摘要;写盘 round-trip", () => {
    const root = tmpRoot();
    const c = buildCrashRunResultContract({
      runId: "run-crash", startedAt: T0, endedAt: T1,
      errorSummary: "未捕获异常: boom", totalTokens: 12, totalCostUsd: 0.001,
    });
    expect(c).toEqual({
      schemaVersion: "1", runId: "run-crash", status: "failed",
      startedAt: T0, endedAt: T1, agents: [], artifacts: [], deferred: [],
      totalTokens: 12, totalCostUsd: 0.001, degraded: true, degradedReason: "未捕获异常: boom",
    });
    writeRunResult(root, c);
    expect(JSON.parse(readRunFile(root, "run-crash", "result.json"))).toEqual(c);
  });

  it("diagnostics:engineFailures 恰一条、其余为空;错误摘要截断到 300;写盘 round-trip", () => {
    const d = buildCrashDiagnostics({ runId: "run-crash", at: T1, errorSummary: "长".repeat(500) });
    expect(d.engineFailures).toHaveLength(1);
    expect(d.engineFailures[0]).toEqual({ at: T1, message: "长".repeat(300) });
    expect(d.providerFallbacks).toEqual([]);
    expect(d.rateLimitHits).toEqual([]);
    expect(d.permissionBlocks).toEqual([]);
    expect(d.notes).toHaveLength(1);
    expect(d.notes[0]).toContain("crash_contract");
    const root = tmpRoot();
    writeDiagnostics(root, d);
    expect(JSON.parse(readRunFile(root, "run-crash", "diagnostics.json"))).toEqual(d);
  });

  it("tokens/cost 缺省 → 0(最小契约不虚构);超长错误摘要截断到 300", () => {
    const c = buildCrashRunResultContract({ runId: "r-min", startedAt: T0, endedAt: T1, errorSummary: "x".repeat(500) });
    expect(c.totalTokens).toBe(0);
    expect(c.totalCostUsd).toBe(0);
    expect(c.degradedReason).toHaveLength(300);
  });
});

// ── deriveToolCallRecords:配对与边界 ────────────────────────────────────────────

describe("deriveToolCallRecords", () => {
  it("无 tool_call 事件 → 空数组", () => {
    const events: ContractSourceEvent[] = [
      { type: "run_started", at: T0 },
      { type: "run_finished", at: T3 },
    ];
    expect(deriveToolCallRecords(events)).toEqual([]);
  });

  it("tool_call 无配对 tool_result(Codex 风格)→ ok=true 且无 durationMs", () => {
    const [r] = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "shell", args: { command: "ls" } } },
    ]);
    expect(r.tool).toBe("shell");
    expect(r.ok).toBe(true);
    expect("durationMs" in r).toBe(false);
    expect(r.argsSummary).toContain("ls");
  });

  it("tool_call + 同 agent tool_result → 算 durationMs;error 结果 → ok=false", () => {
    const recs = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "shell", args: {} } },
      { type: "tool_result", at: T1, agentId: "w1", payload: { name: "shell", result: "Error: shell blocked by role profile" } },
      { type: "tool_call", at: T2, agentId: "w1", payload: { name: "read_file", args: { path: "a.md" } } },
      { type: "tool_result", at: T3, agentId: "w1", payload: { name: "read_file", result: "file content ok" } },
    ]);
    expect(recs).toHaveLength(2);
    expect(recs[0].ok).toBe(false);
    expect(recs[0].durationMs).toBe(1500);
    expect(recs[1].ok).toBe(true);
    expect(recs[1].durationMs).toBe(2000);
  });

  it("两个 agent 交错 → 按 agent 各自配对,互不串扰", () => {
    const recs = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "a", args: {} } },
      { type: "tool_call", at: T1, agentId: "w2", payload: { name: "b", args: {} } },
      { type: "tool_result", at: T2, agentId: "w2", payload: { result: "Error: boom" } },
      { type: "tool_result", at: T3, agentId: "w1", payload: { result: "ok" } },
    ]);
    const w1 = recs.find((r) => r.agentId === "w1")!;
    const w2 = recs.find((r) => r.agentId === "w2")!;
    expect(w1.ok).toBe(true);
    expect(w2.ok).toBe(false);
    expect(w1.durationMs).toBe(5000);
    expect(w2.durationMs).toBe(1500);
  });

  it("孤儿 tool_result(无未配对 tool_call)被忽略;超长 args 截断到 300", () => {
    const recs = deriveToolCallRecords([
      { type: "tool_result", at: T0, agentId: "w1", payload: { result: "orphan" } },
      { type: "tool_call", at: T1, agentId: "w1", payload: { name: "write_file", args: { content: "x".repeat(500) } } },
    ]);
    expect(recs).toHaveLength(1);
    expect(recs[0].argsSummary).toHaveLength(300);
  });
});

// ── deriveRunDiagnostics:分流与边界 ─────────────────────────────────────────────

describe("deriveRunDiagnostics", () => {
  it("空事件流 → 全空数组但结构完整", () => {
    const d = deriveRunDiagnostics("run-6", []);
    expect(d).toEqual({
      schemaVersion: "1", runId: "run-6",
      engineFailures: [], providerFallbacks: [], rateLimitHits: [], permissionBlocks: [], notes: [],
    });
  });

  it("error 事件按 restricted 分流:permissionBlocks vs engineFailures", () => {
    const d = deriveRunDiagnostics("run-6", [
      { type: "error", at: T0, agentId: "w1", payload: { message: "engine timeout", restricted: false } },
      { type: "error", at: T1, agentId: "w2", payload: { message: "worker 不允许使用 claude-code", restricted: true } },
    ]);
    expect(d.engineFailures).toEqual([{ at: T0, agentId: "w1", message: "engine timeout" }]);
    expect(d.permissionBlocks).toEqual([{ at: T1, agentId: "w2", message: "worker 不允许使用 claude-code" }]);
  });

  it("rate_limited 全记 rateLimitHits;带 fallback 的同时记 providerFallbacks", () => {
    const d = deriveRunDiagnostics("run-6", [
      { type: "rate_limited", at: T0, agentId: "w1", payload: { originalModel: "hermes/anthropic/claude", rateLimitedUntil: T3, reason: "post-call overload detected" } },
      { type: "rate_limited", at: T1, agentId: "w1", payload: { originalModel: "hermes/anthropic/claude", fallback: "hermes/deepseek/deepseek-chat", reason: "pre-call cooldown routing" } },
    ]);
    expect(d.rateLimitHits).toHaveLength(2);
    expect(d.rateLimitHits[0].model).toBe("hermes/anthropic/claude");
    expect(d.rateLimitHits[0].rateLimitedUntil).toBe(T3);
    expect(d.providerFallbacks).toEqual([
      { at: T1, agentId: "w1", from: "hermes/anthropic/claude", to: "hermes/deepseek/deepseek-chat", reason: "pre-call cooldown routing" },
    ]);
  });

  it("deliverable_degraded / module_stuck → notes;无关事件被忽略", () => {
    const d = deriveRunDiagnostics("run-6", [
      { type: "deliverable_degraded", at: T0, payload: { reason: "协调者过载" } },
      { type: "module_stuck", at: T1, agentId: "w1", payload: { message: "worker 卡死" } },
      { type: "info", at: T2, payload: { message: "noise" } },
      { type: "tool_call", at: T2, agentId: "w1", payload: { name: "shell" } },
    ]);
    expect(d.notes).toEqual(["deliverable_degraded: 协调者过载", "module_stuck: worker 卡死"]);
    expect(d.engineFailures).toEqual([]);
  });
});

describe('P1 worker startup diagnostics', () => {
  it('keeps structured startup failures separate and auditable', () => {
    const d = deriveRunDiagnostics('run-startup', [{
      type: 'error',
      at: T3,
      agentId: 'agent-1',
      payload: {
        kind: 'worker_startup_diagnostic',
        at: T3,
        runId: 'run-startup',
        agentId: 'agent-1',
        taskId: 'task-1',
        attempt: 2,
        framework: 'codex',
        phase: 'handshake',
        classification: 'transport',
        message: 'WebSocket handshake failed',
        suggestedAction: 'rebuild session',
      },
    }]);
    expect(d.workerStartupFailures).toHaveLength(1);
    expect(d.workerStartupFailures?.[0]).toMatchObject({
      classification: 'transport',
      activityObserved: false,
      attempt: 2,
    });
  });
});

// ── B5 · 收尾接线:memoryPackHashes / mcpCapabilityVersions / 收敛 payload 兼容 ────

describe("B5 · deriveRunDiagnostics 证据链接线", () => {
  it("memory_pack_used info 事件的 packHash 聚合进 memoryPackHashes(去重;非 string/空串忽略)", () => {
    const d = deriveRunDiagnostics("run-7", [
      { type: "info", at: T0, agentId: "ceo-1", payload: { kind: "memory_pack_used", countsByScope: { project: 1 }, packHash: "sha256:aaa" } },
      { type: "info", at: T1, agentId: "w1", payload: { kind: "memory_pack_used", countsByScope: { department: 2 }, packHash: "sha256:bbb" } },
      { type: "info", at: T2, agentId: "w2", payload: { kind: "memory_pack_used", packHash: "sha256:aaa" } }, // 重复 → 去重
      { type: "info", at: T2, agentId: "w3", payload: { kind: "memory_pack_used" } },                        // 老事件无 packHash → 忽略
      { type: "info", at: T2, agentId: "w4", payload: { kind: "memory_pack_used", packHash: 42 } },          // 非 string → 忽略
      { type: "info", at: T3, payload: { kind: "engine_mismatch", message: "noise" } },                      // 无关 info → 忽略
    ]);
    expect(d.memoryPackHashes).toEqual(["sha256:aaa", "sha256:bbb"]);
  });

  it("无 memory_pack_used 事件 → 不带 memoryPackHashes 键(可选字段缺省)", () => {
    const d = deriveRunDiagnostics("run-7", [{ type: "run_finished", at: T3 }]);
    expect("memoryPackHashes" in d).toBe(false);
  });

  // 诚实性(不造假宪法):worker ACP 握手失败降级 legacy CLI,该降级必须如实落 diagnostics,否则离线
  // 审计/契约消费方看 diagnostics 会误以为 ACP 正常执行。回归 bug:executorFallbacks 局部变量填了却
  // 忘赋回 diag(真实案例 run 2431f69a 的 4 次降级全部丢失)。
  it("executor_selected 带 degradedReason 的降级 → 如实落 executorFallbacks(离线审计可见 ACP→legacy)", () => {
    const d = deriveRunDiagnostics("run-7", [
      { type: "info", at: T0, agentId: "lead-1", payload: { kind: "executor_selected", executor: "acp" } }, // 正常 ACP 选路(无 degradedReason)→ 不记
      { type: "info", at: T1, agentId: "w1", payload: { kind: "executor_selected", executor: "legacy_cli", degradedReason: "ACP 会话失败: requires git-bash" } },
    ]);
    expect(d.executorFallbacks).toEqual([
      { at: T1, agentId: "w1", from: "acp", to: "legacy_cli", reason: "ACP 会话失败: requires git-bash" },
    ]);
  });

  it("无降级(全正常 ACP 选路) → 不带 executorFallbacks 键(可选字段缺省,审计据此知 ACP 正常)", () => {
    const d = deriveRunDiagnostics("run-7", [
      { type: "info", at: T0, agentId: "lead-1", payload: { kind: "executor_selected", executor: "acp" } },
    ]);
    expect("executorFallbacks" in d).toBe(false);
  });

  it("extras.mcpCapabilityVersions 原样带上;空对象(无 MCP 配置)也照写不炸", () => {
    const withServers = deriveRunDiagnostics("run-7", [], { mcpCapabilityVersions: { s1: "1.2.3+ab12cd34" } });
    expect(withServers.mcpCapabilityVersions).toEqual({ s1: "1.2.3+ab12cd34" });
    const empty = deriveRunDiagnostics("run-7", [], { mcpCapabilityVersions: {} });
    expect(empty.mcpCapabilityVersions).toEqual({});
    const root = tmpRoot();
    writeDiagnostics(root, empty);
    const parsed = JSON.parse(readRunFile(root, "run-7", "diagnostics.json"));
    expect(parsed.mcpCapabilityVersions).toEqual({});
  });

  it("不传 extras → 不带 mcpCapabilityVersions 键(既有调用零变化)", () => {
    const d = deriveRunDiagnostics("run-7", []);
    expect("mcpCapabilityVersions" in d).toBe(false);
  });
});

describe("B5 · deriveToolCallRecords 收敛 payload 兼容", () => {
  it("RunHistory 收敛后的 tool_call({ name, argsSummary })→ argsSummary 直用,值与自算一致", () => {
    const args = { command: "ls -la" };
    const converged = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "shell", argsSummary: JSON.stringify(args) } },
    ]);
    const raw = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "shell", args } },
    ]);
    expect(converged[0].argsSummary).toBe(raw[0].argsSummary);
    expect(converged[0].tool).toBe("shell");
    // 收敛 payload 同样能与 tool_result 配对
    const paired = deriveToolCallRecords([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "shell", argsSummary: "{}" } },
      { type: "tool_result", at: T1, agentId: "w1", payload: { result: "Error: blocked" } },
    ]);
    expect(paired[0].ok).toBe(false);
    expect(paired[0].durationMs).toBe(1500);
  });
});

// ── B5c · run 级重试计数(deriveRetryCount,来源:rate_limited 事件) ────────────────

describe("deriveRetryCount", () => {
  it("空事件流 → 0", () => {
    expect(deriveRetryCount([])).toBe(0);
  });

  it("按 rate_limited 事件条数计数,不区分 pre-call/post-call 原因", () => {
    const n = deriveRetryCount([
      { type: "rate_limited", at: T0, agentId: "w1", payload: { originalModel: "hermes/anthropic/claude", reason: "post-call overload detected" } },
      { type: "rate_limited", at: T1, agentId: "w2", payload: { originalModel: "hermes/anthropic/claude", fallback: "hermes/deepseek/deepseek-chat", reason: "pre-call cooldown routing" } },
      { type: "error", at: T2, agentId: "w1", payload: { message: "engine timeout" } },
      { type: "tool_call", at: T2, agentId: "w1", payload: { name: "shell" } },
    ]);
    expect(n).toBe(2);
  });
});

describe("buildRunResultContract:events → retryCount(可选)", () => {
  const run = {
    id: "run-9",
    status: "done" as const,
    startedAt: T0,
    totalTokens: 0,
    participatingAgents: [],
  };

  it("不传 events → 不带 retryCount 键(既有调用零变化)", () => {
    const c = buildRunResultContract({ run, agents: [], callRecords: [], artifacts: [], deferred: [] });
    expect("retryCount" in c).toBe(false);
  });

  it("传 events → retryCount = rate_limited 事件条数(含 0)", () => {
    const zero = buildRunResultContract({
      run, agents: [], callRecords: [], artifacts: [], deferred: [],
      events: [{ type: "run_started", at: T0 }],
    });
    expect(zero.retryCount).toBe(0);

    const two = buildRunResultContract({
      run, agents: [], callRecords: [], artifacts: [], deferred: [],
      events: [
        { type: "rate_limited", at: T0, agentId: "w1", payload: { originalModel: "m1", reason: "post-call overload detected" } },
        { type: "rate_limited", at: T1, agentId: "w2", payload: { originalModel: "m2", reason: "pre-call cooldown routing" } },
      ],
    });
    expect(two.retryCount).toBe(2);
  });
});

// ── A6a · events → agents[].executor(per-agent 执行通道派生) ─────────────────────

describe("buildRunResultContract:events → agents[].executor(A6a 三值派生)", () => {
  const run = {
    id: "run-10",
    status: "done" as const,
    startedAt: T0,
    totalTokens: 0,
    participatingAgents: ["w1", "w2"],
  };
  const agents = [
    { id: "w1", role: "worker", framework: "claude-code", status: "idle" },
    { id: "w2", role: "worker", framework: "api", status: "idle" },
  ];
  const build = (events: ContractSourceEvent[]) =>
    buildRunResultContract({ run, agents, callRecords: [], artifacts: [], deferred: [], events });

  it("纯 acp → executor=acp、无 executorDegraded;无 executor_selected 事件的 agent 字段缺省不虚构", () => {
    const c = build([
      { type: "info", at: T0, agentId: "w1", payload: { kind: "executor_selected", executor: "acp", engine: "claude-code" } },
    ]);
    const w1 = c.agents.find((a) => a.agentId === "w1")!;
    expect(w1.executor).toBe("acp");
    expect("executorDegraded" in w1).toBe(false);
    const w2 = c.agents.find((a) => a.agentId === "w2")!;
    expect("executor" in w2).toBe(false);
  });

  it("纯 api(ApiEngine in-process)→ executor=api;不传 events → 不带 executor 键(既有调用零变化)", () => {
    const c = build([
      { type: "info", at: T0, agentId: "w2", payload: { kind: "executor_selected", executor: "api", engine: "deepseek" } },
    ]);
    expect(c.agents.find((a) => a.agentId === "w2")!.executor).toBe("api");
    const noEvents = buildRunResultContract({ run, agents, callRecords: [], artifacts: [], deferred: [] });
    for (const a of noEvents.agents) expect("executor" in a).toBe(false);
  });

  it("降级粘滞:legacy_cli+degradedReason 不被后续 acp 覆盖且 executorDegraded=true;逃生门 legacy(无 reason)不粘滞,last-wins", () => {
    const c = build([
      // w1:真降级(ACP 握手失败)→ 之后 acp 也不覆盖(诚实呈现,镜像 web deriveRunExecutors 粘滞语义)
      { type: "info", at: T0, agentId: "w1", payload: { kind: "executor_selected", executor: "legacy_cli", degradedReason: "ACP 会话失败: requires git-bash" } },
      { type: "info", at: T1, agentId: "w1", payload: { kind: "executor_selected", executor: "acp" } },
      // w2:显式关闭 ACP 的逃生门(无 degradedReason)→ 非降级不粘滞,后续 api 按 last-wins 覆盖
      { type: "info", at: T0, agentId: "w2", payload: { kind: "executor_selected", executor: "legacy_cli" } },
      { type: "info", at: T1, agentId: "w2", payload: { kind: "executor_selected", executor: "api" } },
    ]);
    const w1 = c.agents.find((a) => a.agentId === "w1")!;
    expect(w1.executor).toBe("legacy_cli");
    expect(w1.executorDegraded).toBe(true);
    const w2 = c.agents.find((a) => a.agentId === "w2")!;
    expect(w2.executor).toBe("api");
    expect("executorDegraded" in w2).toBe(false);
  });
});

// ── A8 · events → testEvidence(真实测试执行证据派生) ─────────────────────────────

describe("deriveTestEvidence", () => {
  it("来源 a:质量门 test_evidence 事件(权威)→ 全字段如实带出,pass/fail 都记", () => {
    const ev = deriveTestEvidence([
      { type: "info", at: T0, agentId: "w1", payload: { kind: "test_evidence", taskId: "t1", source: "quality_gate", command: "npx vitest run", cwd: "C:/wt/w1", exitCode: 1, passed: false, output: "FAIL foo.test.ts" } },
      { type: "info", at: T1, agentId: "w1", payload: { kind: "test_evidence", taskId: "t1", source: "quality_gate", command: "npx vitest run", cwd: "C:/wt/w1", exitCode: 0, passed: true, output: "12 passed" } },
      { type: "info", at: T2, agentId: "w2", payload: { kind: "memory_pack_used", packHash: "h1" } }, // 无关 info 不误吃
    ]);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toEqual({ at: T0, agentId: "w1", command: "npx vitest run", cwd: "C:/wt/w1", exitCode: 1, passed: false, output: "FAIL foo.test.ts", source: "quality_gate" });
    expect(ev[1].passed).toBe(true);
    expect(ev[1].exitCode).toBe(0);
  });

  it("P0-3 来源 a:Verifier Snapshot 权威证据的 testerAgentId/independent/testedCommit 透传;缺省字段不虚构", () => {
    const ev = deriveTestEvidence([
      // 快照证据:三新字段齐全 → 全透传
      { type: "info", at: T0, agentId: "qa-1", payload: { kind: "test_evidence", source: "quality_gate", command: "node sum.test.js", cwd: "/snap", exitCode: 0, passed: true, testerAgentId: "qa-1", independent: true, testedCommit: "abc123" } },
      // 老证据:无三新字段 → 输出里也不带这三个键(诚实缺省)
      { type: "info", at: T1, agentId: "dev-1", payload: { kind: "test_evidence", source: "quality_gate", command: "npm test", exitCode: 0, passed: true } },
    ]);
    expect(ev).toHaveLength(2);
    expect(ev[0].testerAgentId).toBe("qa-1");
    expect(ev[0].independent).toBe(true);
    expect(ev[0].testedCommit).toBe("abc123");
    expect("testerAgentId" in ev[1]).toBe(false);
    expect("independent" in ev[1]).toBe(false);
    expect("testedCommit" in ev[1]).toBe(false);
  });

  it("来源 b:runTests tool_call 配对 tool_result 首行机器头 → command/exit/passed 解析;插入其它工具调用不误配", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "runTests", argsSummary: "{}" } },
      { type: "tool_result", at: T1, agentId: "w1", payload: { name: "runTests", result: "[test-evidence] command=python -m pytest -q exit=0 passed=true\n3 passed in 0.5s" } },
      // 别的工具的 call/result 对不产生测试证据(runTests 待配对位被顶掉)
      { type: "tool_call", at: T2, agentId: "w1", payload: { name: "readFile", argsSummary: "{}" } },
      { type: "tool_result", at: T3, agentId: "w1", payload: { name: "readFile", result: "file content" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ at: T1, agentId: "w1", command: "python -m pytest -q", exitCode: 0, passed: true, output: "3 passed in 0.5s", source: "tool" });
  });

  it("头缺失(老格式)→ 降精度 command=runTests(auto);'Tests failed' 前缀 → passed=false;无框架/Error → 不记", () => {
    const ev = deriveTestEvidence([
      // 老格式失败输出:没有机器头,按前缀如实判失败
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "runTests" } },
      { type: "tool_result", at: T1, agentId: "w1", payload: { result: "Tests failed:\nAssertionError: 1 != 2" } },
      // 无测试框架:没有任何真实执行 → 不虚构证据
      { type: "tool_call", at: T1, agentId: "w2", payload: { name: "runTests" } },
      { type: "tool_result", at: T2, agentId: "w2", payload: { result: "No test framework detected in project root." } },
      // 工具层失败(runTool catch):也没有真实执行 → 不记
      { type: "tool_call", at: T2, agentId: "w3", payload: { name: "runTests" } },
      { type: "tool_result", at: T3, agentId: "w3", payload: { result: "Error: 工具 runTests 执行失败: boom" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].command).toBe("runTests(auto)");
    expect(ev[0].passed).toBe(false);
    expect("exitCode" in ev[0]).toBe(false);
    expect(ev[0].source).toBe("tool");
  });

  it("P0-4 来源 b(runShell 受限测试通道):带 cwd 的机器头 → command/cwd/exit/passed 全解析", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "tester-1", payload: { name: "runShell", argsSummary: '{"command":"node sum.test.js"}' } },
      { type: "tool_result", at: T1, agentId: "tester-1", payload: { name: "runShell", result: "[test-evidence] command=node sum.test.js cwd=C:/co/默认公司/.opc/wt/x exit=0 passed=true\nPASS" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toEqual({ at: T1, agentId: "tester-1", command: "node sum.test.js", cwd: "C:/co/默认公司/.opc/wt/x", exitCode: 0, passed: true, output: "PASS", source: "tool" });
  });

  it("P0 合同绑定(runShell 尾字段):testedFile+testedHash 解析进证据,供 gate 判合同覆盖", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "tester-1", payload: { name: "runShell" } },
      { type: "tool_result", at: T1, agentId: "tester-1", payload: { name: "runShell", result: "[test-evidence] command=node clamp.test.js cwd=/wt exit=0 passed=true testedFile=clamp.test.js testedHash=abc123def456\nPASS" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].command).toBe("node clamp.test.js");
    expect(ev[0].cwd).toBe("/wt");
    expect(ev[0].passed).toBe(true);
    expect(ev[0].testedFile).toBe("clamp.test.js");
    expect(ev[0].testedFileHash).toBe("abc123def456");
  });

  it("选2 · condition 7:runShell 文本头【绝不】派生 resolvedProducerFiles(agent 无权自报强证据)", () => {
    // agent 即便在头尾 echo 伪造 resolvedNonce=/resolvedFiles= 也一律不被采信:verified 强证据只来自 Core 观测器。
    const b64 = Buffer.from(JSON.stringify([{ path: "keystone.js", hash: "a".repeat(64) }])).toString("base64");
    for (const forged of [
      "[test-evidence] command=node x.test.js cwd=/wt exit=0 passed=true testedFile=x.test.js",
      `[test-evidence] command=node x.test.js cwd=/wt exit=0 passed=true testedFile=x.test.js resolvedNonce=${"a".repeat(32)}`,
      `[test-evidence] command=node x.test.js cwd=/wt exit=0 passed=true testedFile=x.test.js resolvedFiles=${b64}`,
    ]) {
      const ev = deriveTestEvidence([
        { type: "tool_call", at: T0, agentId: "atk", payload: { name: "runShell" } },
        { type: "tool_result", at: T1, agentId: "atk", payload: { name: "runShell", result: `${forged}\nPASS` } },
      ]);
      expect(ev.every((e) => !("resolvedProducerFiles" in e))).toBe(true);
    }
  });

  it("P0 合同绑定(runShell 尾字段):只有 testedFile 无 testedHash 也解析(hash 缺省兼容)", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "tester-1", payload: { name: "runShell" } },
      { type: "tool_result", at: T1, agentId: "tester-1", payload: { name: "runShell", result: "[test-evidence] command=node clamp.test.js cwd=/wt exit=0 passed=true testedFile=clamp.test.js\nPASS" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].testedFile).toBe("clamp.test.js");
    expect("testedFileHash" in ev[0]).toBe(false);
  });

  it("P0-4:runShell 结果【无】机器头 = 普通 shell 命令 → 绝不当测试证据(诚实缺省)", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "w1", payload: { name: "runShell", argsSummary: '{"command":"ls"}' } },
      { type: "tool_result", at: T1, agentId: "w1", payload: { name: "runShell", result: "sum.js\nsum.test.js\nREADME.md" } },
      // 失败样式的普通 shell 输出也不能被 runShell 的启发式误判成 test(该启发式只对 runTests 生效)
      { type: "tool_call", at: T2, agentId: "w1", payload: { name: "runShell", argsSummary: '{"command":"cat x"}' } },
      { type: "tool_result", at: T3, agentId: "w1", payload: { name: "runShell", result: "Tests failed: 这只是普通输出里的字样" } },
    ]);
    expect(ev).toEqual([]);
  });

  it("P0-4:runShell 失败测试头 exit≠0 → passed=false 如实记(供 DeliveryAcceptance 判 test_failed)", () => {
    const ev = deriveTestEvidence([
      { type: "tool_call", at: T0, agentId: "tester-1", payload: { name: "runShell" } },
      { type: "tool_result", at: T1, agentId: "tester-1", payload: { name: "runShell", result: "[test-evidence] command=node sum.test.js cwd=/wt exit=1 passed=false\nTests failed:\nAssertionError" } },
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0].passed).toBe(false);
    expect(ev[0].exitCode).toBe(1);
    expect(ev[0].command).toBe("node sum.test.js");
    expect(ev[0].cwd).toBe("/wt");
  });

  it("MUP 波2 · resolvedProducerFiles 透传:合规条目原样带出;非法形状清洗;无该字段的证据不带键", () => {
    const good = [{ path: "src/sum.js", hash: "a".repeat(64) }];
    const ev = deriveTestEvidence([
      { type: "info", at: T0, agentId: "qa-1", payload: { kind: "test_evidence", source: "quality_gate", command: "node sum.test.js", exitCode: 0, passed: true, independent: true, resolvedProducerFiles: good } },
      // 混入非法条目:非对象 / path 缺失 / hash 非 string → 清洗后只剩合规条目
      { type: "info", at: T1, agentId: "qa-1", payload: { kind: "test_evidence", source: "quality_gate", command: "node a.test.js", exitCode: 0, passed: true, resolvedProducerFiles: [null, { hash: "x" }, { path: "b.js", hash: 42 }, { path: "ok.js", hash: "f".repeat(64) }] } },
      // 空数组 → 键缺省(不写空数组占位)
      { type: "info", at: T2, agentId: "qa-1", payload: { kind: "test_evidence", source: "quality_gate", command: "node c.test.js", exitCode: 0, passed: true, resolvedProducerFiles: [] } },
      // 老证据无该字段 → 键缺省
      { type: "info", at: T3, agentId: "dev-1", payload: { kind: "test_evidence", source: "quality_gate", command: "npm test", exitCode: 0, passed: true } },
    ]);
    expect(ev).toHaveLength(4);
    expect(ev[0].resolvedProducerFiles).toEqual(good);
    expect(ev[1].resolvedProducerFiles).toEqual([{ path: "ok.js", hash: "f".repeat(64) }]);
    expect("resolvedProducerFiles" in ev[2]).toBe(false);
    expect("resolvedProducerFiles" in ev[3]).toBe(false);
  });

  it("空事件流 / 无任何测试信号 → [];buildRunResultContract 不带 testEvidence 键(诚实缺省)", () => {
    expect(deriveTestEvidence([])).toEqual([]);
    const run = { id: "run-te", status: "done" as const, startedAt: T0, totalTokens: 0, participatingAgents: [] };
    const none = buildRunResultContract({
      run, agents: [], callRecords: [], artifacts: [], deferred: [],
      events: [{ type: "run_started", at: T0 }],
    });
    expect("testEvidence" in none).toBe(false);
    const withEv = buildRunResultContract({
      run, agents: [], callRecords: [], artifacts: [], deferred: [],
      events: [{ type: "info", at: T0, agentId: "w1", payload: { kind: "test_evidence", source: "quality_gate", command: "npm test --silent", cwd: "C:/wt", exitCode: 0, passed: true, output: "ok" } }],
    });
    expect(withEv.testEvidence).toHaveLength(1);
    expect(withEv.testEvidence![0].command).toBe("npm test --silent");
  });
});

describe("aggregateTestRes", () => {
  it("空 evidence → null(orchestrator 保留既有诚实 ran:false 文案)", () => {
    expect(aggregateTestRes([])).toBeNull();
  });

  it("全部通过 → ran:true + passed:true + 去重命令拼接 + 汇总句", () => {
    const r = aggregateTestRes([
      { at: T0, agentId: "w1", command: "npx vitest run", exitCode: 0, passed: true, output: "5 passed", source: "quality_gate" },
      { at: T1, agentId: "w2", command: "npx vitest run", exitCode: 0, passed: true, output: "3 passed", source: "quality_gate" },
      { at: T2, agentId: "w3", command: "python -m pytest -q", exitCode: 0, passed: true, source: "tool" },
    ])!;
    expect(r.ran).toBe(true);
    expect(r.passed).toBe(true);
    expect(r.command).toBe("npx vitest run; python -m pytest -q");
    expect(r.output).toBe("3 次真实测试执行,全部通过");
  });

  it("有失败 → passed:false,output=最后一条失败输出(缺输出时给可读兜底)", () => {
    const r = aggregateTestRes([
      { at: T0, command: "npx vitest run", exitCode: 1, passed: false, output: "FAIL a.test.ts", source: "quality_gate" },
      { at: T1, command: "npx vitest run", exitCode: 0, passed: true, output: "ok", source: "quality_gate" },
      { at: T2, command: "runTests(auto)", passed: false, output: "FAIL b.test.ts", source: "tool" },
    ])!;
    expect(r.passed).toBe(false);
    expect(r.output).toBe("FAIL b.test.ts");
    const noOut = aggregateTestRes([{ at: T0, command: "cargo test", exitCode: 101, passed: false, source: "quality_gate" }])!;
    expect(noOut.output).toContain("cargo test");
  });
});
