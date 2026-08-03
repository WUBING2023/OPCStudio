// 定稿 2.2 · server 侧 ACP-worker 执行后端单测。覆盖三径(任务书 5):正常 ACP / 失败降级 / 证据入账。
// mock worker 进程:真 child_process spawn 一个假 worker 脚本(__fixtures__/fakeAcpWorker.mjs,产出契约
// 文件),以及 inline 注入 spawnWorker(确定性构造失败/边界)。绝不真调模型、绝不碰正式 .opc 库。
import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask } from "@opc/shared";
import { runViaAcpWorker, mapFrameworkToAcpEngine, acpWorkerEnabled, acpRequired, sanitizeReplayedPayload, recoverProducerDelta, type AcpWorkerSpawnFn, type AcpWorkerSpawnResult } from "./acpWorkerBackend.js";

// CRITICAL-2 回归(对抗验证 CONFIRMED):worker 子进程的 events.jsonl 是不可信输入,回放的 info/test_evidence
// 绝不能自报 resolvedProducerFiles/independent(否则 worker 绕过 Core 观测器伪造强证据/独立性)。
describe("CRITICAL-2 · 回放 worker test_evidence 剥离强证据/独立性(worker 无权自报)", () => {
  it("info{kind:test_evidence} 回放 → 剥 resolvedProducerFiles/independent/testerAgentId/testedCommit,降 source=worker_selfreport", () => {
    const forged = {
      kind: "test_evidence", passed: true, exitCode: 0, command: "node x.test.js", testedFile: "x.test.js",
      resolvedProducerFiles: [{ path: "solution.js", hash: "a".repeat(64) }], independent: true, testerAgentId: "qa-1", testedCommit: "deadbeef",
    };
    const out = sanitizeReplayedPayload("info", forged);
    expect("resolvedProducerFiles" in out).toBe(false);
    expect(out.independent).toBe(false);
    expect("testerAgentId" in out).toBe(false);
    expect("testedCommit" in out).toBe(false);
    expect(out.source).toBe("worker_selfreport");
    // 弱字段照留(仅作展示,不构成强证据)
    expect(out.passed).toBe(true);
    expect(out.testedFile).toBe("x.test.js");
  });

  it("非 test_evidence 的 info 事件原样回放(不误伤)", () => {
    const p = { kind: "note", text: "hello" };
    expect(sanitizeReplayedPayload("info", p)).toBe(p);
    const tc = { name: "runShell", args: {} };
    expect(sanitizeReplayedPayload("tool_call", tc)).toBe(tc);
  });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "__fixtures__", "fakeAcpWorker.mjs");

const roots: string[] = [];
function tmpRoot(): string { const r = fs.mkdtempSync(path.join(os.tmpdir(), "opc-acp-be-")); roots.push(r); return r; }
afterEach(() => { while (roots.length) { try { fs.rmSync(roots.pop()!, { recursive: true, force: true }); } catch { /* */ } } });

function makeNode(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "dev-1", name: "Dev One", role: "dev", childrenIds: [],
    model: "sonnet", provider: "anthropic", framework: "claude-code",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true, ...over,
  };
}
function makeTask(over: Partial<ExecTask> = {}): ExecTask {
  return { taskId: "t1", goal: "写点东西", systemPrompt: "你是 dev 角色。", maxTokens: 4096, ...over };
}
function makeCtx(over: Partial<ExecContext> = {}): { ctx: ExecContext; events: Array<{ type: string; agentId?: string; payload: any }> } {
  const events: Array<{ type: string; agentId?: string; payload: any }> = [];
  const projectRoot = tmpRoot();
  const ctx: ExecContext = {
    runId: "real-run-1", projectRoot, workdir: projectRoot,
    emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); },
    budget: { maxTokensPerTask: 4096 }, ...over,
  };
  return { ctx, events };
}

// 真进程边界:spawn 假 worker 脚本(它产出契约文件)。
function subprocessSpawn(scenario: "done" | "failed"): AcpWorkerSpawnFn {
  return (input) => new Promise<AcpWorkerSpawnResult>((resolve) => {
    const child = spawn(process.execPath, [FIXTURE, input.isolatedRoot, input.runId, scenario], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("error", (e) => resolve({ code: null, stdout, stderr, spawnError: e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const legacySentinel = (): Promise<ExecResult> => Promise.resolve({
  content: "legacy output", fileChanges: [], tokens: { prompt: 1, completion: 2, total: 3 },
  cost: 0, latencyMs: 5, status: "restricted", error: "claude-code 不可用",
});

describe("mapFrameworkToAcpEngine / acpWorkerEnabled", () => {
  it("映射全部原生 ACP 订阅框架,其余为 null", () => {
    expect(mapFrameworkToAcpEngine("claude-code")).toBe("claude-code");
    expect(mapFrameworkToAcpEngine("codex")).toBe("codex");
    expect(mapFrameworkToAcpEngine("gemini-cli")).toBe("gemini-cli");
    expect(mapFrameworkToAcpEngine("kimi-cli")).toBe("kimi-cli");
    expect(mapFrameworkToAcpEngine("grok-build")).toBe("grok-build");
    expect(mapFrameworkToAcpEngine("hermes")).toBeNull();
    expect(mapFrameworkToAcpEngine(undefined)).toBeNull();
  });
  it("默认开:缺省/1/true/空串走 ACP;逃生门 OPC_ACP_WORKER=0/false 关回 legacy", () => {
    const prev = process.env.OPC_ACP_WORKER;
    delete process.env.OPC_ACP_WORKER; expect(acpWorkerEnabled()).toBe(true); // 未设置=默认开
    process.env.OPC_ACP_WORKER = "1"; expect(acpWorkerEnabled()).toBe(true);
    process.env.OPC_ACP_WORKER = "true"; expect(acpWorkerEnabled()).toBe(true);
    process.env.OPC_ACP_WORKER = ""; expect(acpWorkerEnabled()).toBe(true); // 空串≠关,仍默认开
    process.env.OPC_ACP_WORKER = "0"; expect(acpWorkerEnabled()).toBe(false); // 逃生门
    process.env.OPC_ACP_WORKER = "false"; expect(acpWorkerEnabled()).toBe(false); // 逃生门
    if (prev === undefined) delete process.env.OPC_ACP_WORKER; else process.env.OPC_ACP_WORKER = prev;
  });
});

describe("runViaAcpWorker · 正常 ACP 路径(真进程边界 · 假 worker 产出契约文件)", () => {
  it("isolated worker forces JSON Runtime Contract instead of an empty default SQLite database", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx();
    let backend: string | undefined;
    const spawnWorker: AcpWorkerSpawnFn = (input) => {
      backend = input.env.OPC_STORAGE_BACKEND;
      const seeded = JSON.parse(fs.readFileSync(path.join(input.isolatedRoot, ".opc", "agents.json"), "utf-8"));
      expect(seeded.map((agent: AgentNodeConfig) => agent.id)).toEqual(["dev-1"]);
      const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
        schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t",
        agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 1, costUsd: null }],
        artifacts: [], deferred: [], totalTokens: 1, totalCostUsd: null,
      }), "utf-8");
      return Promise.resolve({ code: 0, stdout: "{}", stderr: "" });
    };

    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker, workerRootOverride: root,
    });
    expect(backend).toBe("json");
    expect(res.executor).toBe("acp");
  });
  it("读回证据入账:executor=acp、tokens/cost 来自 result.json+events、回放 tool/model 事件、不降级", async () => {
    const root = tmpRoot();
    const { ctx, events } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, {
      fallback, spawnWorker: subprocessSpawn("done"), workerRootOverride: root,
    });

    expect(fallback).not.toHaveBeenCalled();
    expect(res.status).toBe("done");
    expect(res.executor).toBe("acp");
    expect(res.tokens).toEqual({ prompt: 12, completion: 30, total: 42 });
    expect(res.cost).toBe(0.001);
    expect(res.content).toContain("Hello from ACP worker"); // report.md 兜底内容

    // 隔离:worker 名册写进隔离 root(不碰 ctx.projectRoot 正式库),task 请求折进 systemPrompt+goal
    const seeded = JSON.parse(fs.readFileSync(path.join(root, ".opc", "agents.json"), "utf-8"));
    expect(seeded[0].id).toBe("dev-1");
    const req = JSON.parse(fs.readFileSync(path.join(root, "task.request.json"), "utf-8"));
    expect(req.agentId).toBe("dev-1");
    expect(req.goal).toContain("你是 dev 角色。");
    expect(req.goal).toContain("写点东西");
    expect(fs.existsSync(path.join(ctx.projectRoot, ".opc", "runs"))).toBe(false); // 正式库未被 worker 写

    // 事件回放:executor_selected(acp) + model_call_finished(带 executor) + tool_call/result
    const kinds = events.filter((e) => e.type === "info").map((e) => e.payload?.kind);
    expect(kinds).toContain("executor_selected");
    const sel = events.find((e) => e.type === "info" && e.payload?.kind === "executor_selected");
    expect(sel!.payload.executor).toBe("acp");
    const mcf = events.find((e) => e.type === "model_call_finished");
    expect(mcf!.payload.executor).toBe("acp");
    expect(mcf!.payload.tokens).toBe(42);
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
    // run 生命周期事件不回放(归 orchestrator)
    expect(events.some((e) => e.type === "run_started" || e.type === "run_finished")).toBe(false);
  }, 30_000);

  it("证据入账:无 model_call_finished 事件时 tokens.total 退回 result.json.totalTokens", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx();
    // inline spawn:只写 result.json(无 events.jsonl)。
    const spawnWorker: AcpWorkerSpawnFn = (input) => {
      const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
        schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t",
        agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 77, costUsd: 0.02 }],
        artifacts: [], deferred: [], totalTokens: 77, totalCostUsd: 0.02,
      }), "utf-8");
      return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: "done", stopReason: "end_turn" }), stderr: "" });
    };
    const res = await runViaAcpWorker("codex", makeNode({ framework: "codex" }), makeTask(), ctx, { fallback: legacySentinel, spawnWorker, workerRootOverride: root });
    expect(res.status).toBe("done");
    expect(res.executor).toBe("acp");
    expect(res.tokens.total).toBe(77);
    expect(res.cost).toBe(0.02);
  });
});

describe("runViaAcpWorker · 失败降级(保底 fallback)", () => {
  it("worker 未产出 result.json → 降级到 legacy(executor=legacy_cli + degradedReason),fallback 恰调一次", async () => {
    const root = tmpRoot();
    const { ctx, events } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const spawnWorker: AcpWorkerSpawnFn = () => Promise.resolve({ code: 1, stdout: "", stderr: "boom: cannot find worker" });
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback, spawnWorker, workerRootOverride: root });

    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.executor).toBe("legacy_cli");
    expect(res.status).toBe("restricted"); // 透传 legacy 的结果
    expect(res.content).toBe("legacy output");
    expect(res.degradedReason).toContain("result.json");
    const sel = events.find((e) => e.type === "info" && e.payload?.kind === "executor_selected");
    expect(sel!.payload.executor).toBe("legacy_cli");
    expect(sel!.payload.degradedReason).toBeTruthy();
  });

  it("result.json status=failed(worker 内 AcpTransportError=握手失败)→ 降级,degradedReason 取 diagnostics", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, {
      fallback, spawnWorker: subprocessSpawn("failed"), workerRootOverride: root,
    });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.executor).toBe("legacy_cli");
    expect(res.degradedReason).toContain("ACP initialize 超时");
  }, 30_000);

  it("spawnError → 降级,degradedReason 带原始错误", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const spawnWorker: AcpWorkerSpawnFn = () => Promise.resolve({ code: null, stdout: "", stderr: "", spawnError: "spawn npx ENOENT" });
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback, spawnWorker, workerRootOverride: root });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.executor).toBe("legacy_cli");
    expect(res.degradedReason).toContain("ENOENT");
  });

  it("超时 → 终止且不启动 legacy 第二次执行", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx({ taskTimeoutMs: 1_234 });
    const fallback = vi.fn(legacySentinel);
    const spawnWorker: AcpWorkerSpawnFn = (input) => {
      expect(input.timeoutMs).toBe(1_234);
      return Promise.resolve({ code: null, stdout: "", stderr: "", timedOut: true });
    };
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback, spawnWorker, workerRootOverride: root });
    expect(fallback).not.toHaveBeenCalled();
    expect(res.status).toBe("failed");
    expect(res.error).toContain("timed out");
  });
});

describe("runViaAcpWorker · P0-3 Verifier Snapshot 权威证据(ctx.isVerifier)", () => {
  // inline spawn:只写 status=done 的 result.json(不打真 ACP);快照测试由 root 里预置的裸测试文件驱动。
  const doneSpawn: AcpWorkerSpawnFn = (input) => {
    const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
      schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t",
      agents: [{ agentId: "qa-1", role: "tester", framework: "claude-code", status: "idle", tokens: 5, costUsd: 0 }],
      artifacts: [], deferred: [], totalTokens: 5, totalCostUsd: 0,
    }), "utf-8");
    return Promise.resolve({ code: 0, stdout: JSON.stringify({ status: "done" }), stderr: "" });
  };

  it("verifier:在快照里跑裸测试 → 同步 emit test_evidence(independent:true/testerAgentId/source=quality_gate)", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "sum.test.js"), "process.exit(0)", "utf-8"); // 快照里的通过测试(override 跳过 seed,直接用预置文件)
    const { ctx, events } = makeCtx({ isVerifier: true });
    const res = await runViaAcpWorker("claude-code", makeNode({ id: "qa-1", role: "tester" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    expect(res.status).toBe("done");
    expect(res.content).toContain("Core independent verification");
    expect(res.fileChanges).toEqual([]); // 快照永不进 changes

    const te = events.find((e) => e.type === "info" && e.payload?.kind === "test_evidence");
    expect(te).toBeTruthy();
    expect(te!.payload.source).toBe("quality_gate");
    expect(te!.payload.independent).toBe(true);
    expect(te!.payload.testerAgentId).toBe("qa-1");
    expect(te!.agentId).toBe("qa-1");
    expect(te!.payload.passed).toBe(true);
    expect(te!.payload.exitCode).toBe(0);
    expect(te!.payload.cwd).toBe(root);
    expect(te!.payload.command).toMatch(/sum\.test\.js/);
    expect("testedCommit" in te!.payload).toBe(false); // ctx.workdir 非 git → testedCommit 缺省
  }, 120_000);

  it("verifier 快照测试失败 → emit test_evidence passed:false / exitCode≠0(供 DeliveryAcceptance 独立门判定)", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "fail.test.js"), "process.exit(3)", "utf-8");
    const { ctx, events } = makeCtx({ isVerifier: true });
    const res = await runViaAcpWorker("claude-code", makeNode({ id: "qa-1", role: "tester" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    const te = events.find((e) => e.type === "info" && e.payload?.kind === "test_evidence");
    expect(te!.payload.passed).toBe(false);
    expect(te!.payload.exitCode).toBe(3);
    expect(res.status).toBe("failed");
    expect(res.content).toContain("Core snapshot failed");
  }, 120_000);

  it("P0 合同绑定:快照里既有本 run 测试又有历次遗留测试 → 只跑绑定合同的,遗留测试绝不产独立证据(带 testedFile+hash)", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "feature.test.js"), "process.exit(0)", "utf-8");   // 本 run 交付(在合同里)
    fs.writeFileSync(path.join(root, "leftover.test.js"), "process.exit(0)", "utf-8");  // 共享工作目录历次遗留(不在合同、且不测合同源文件)
    const { ctx, events } = makeCtx({ isVerifier: true, deliveryContractFiles: ["feature.test.js"] });
    await runViaAcpWorker("claude-code", makeNode({ id: "qa-1", role: "tester" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    const tes = events.filter((e) => e.type === "info" && e.payload?.kind === "test_evidence");
    expect(tes).toHaveLength(1);                                   // 遗留测试被拒 → 只剩一条
    expect(tes[0].payload.command).toMatch(/feature\.test\.js/);
    expect(tes[0].payload.command).not.toMatch(/leftover/);        // 遗留测试绝不跑
    expect(tes[0].payload.testedFile).toBe("feature.test.js");     // 绑定可审计:测了哪个文件
    expect(typeof tes[0].payload.testedFileHash).toBe("string");   // 绑定可审计:测的哪份字节
    expect(tes[0].payload.testedFileHash.length).toBeGreaterThan(0);
  }, 120_000);

  it("P0 合同绑定:合同为空数组(本 run 零变更)→ 快照里的遗留测试一条都不跑(独立门将判 missing_independent)", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "leftover.test.js"), "process.exit(0)", "utf-8");
    const { ctx, events } = makeCtx({ isVerifier: true, deliveryContractFiles: [] });
    await runViaAcpWorker("claude-code", makeNode({ id: "qa-1", role: "tester" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    expect(events.some((e) => e.type === "info" && e.payload?.kind === "test_evidence")).toBe(false);
  }, 120_000);

  it("选1:verifier 快照自建测试(不在合同)按目标 stem 绑合同源文件 → 独立 test_evidence 通过(passed+testedFile;无 resolvedProducerFiles)", async () => {
    const root = tmpRoot();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "sum.js"), "function sum(a, b) { return a + b; }\nmodule.exports = { sum };\n", "utf-8"); // producer 交付(在合同)
    // verifier 自建测试(不在合同):目标 stem "sum" 与合同 src/sum.js 相交 → 绑定。
    fs.writeFileSync(path.join(root, "sum.test.js"), 'const assert = require("node:assert");\nconst { sum } = require("./src/sum.js");\nassert.strictEqual(sum(1, 2), 3);\n', "utf-8");
    const { ctx, events } = makeCtx({ isVerifier: true, deliveryContractFiles: ["src/sum.js"] });
    const res = await runViaAcpWorker("claude-code", makeNode({ id: "qa-1", role: "tester" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    expect(res.fileChanges).toEqual([]); // 既有语义不变:快照产物绝不进 changes

    const tes = events.filter((e) => e.type === "info" && e.payload?.kind === "test_evidence");
    expect(tes).toHaveLength(1);
    expect(tes[0].payload.testedFile).toBe("sum.test.js");   // 自建测试照记 testedFile
    expect(tes[0].payload.passed).toBe(true);
    expect(tes[0].payload.independent).toBe(true);           // Core 快照直 emit → 独立证据(worker 回放会被剥独立性)
    // 选1(降级):resolvedProducerFiles 已退役,快照证据不再携带强证据字段。
    expect("resolvedProducerFiles" in tes[0].payload).toBe(false);
  }, 120_000);

  it("producer(ctx.isVerifier 缺省)路径逐字节不变:即便 root 有测试文件也不 emit 快照证据", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "sum.test.js"), "process.exit(0)", "utf-8");
    const { ctx, events } = makeCtx(); // 无 isVerifier
    await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: doneSpawn, workerRootOverride: root,
    });
    expect(events.some((e) => e.type === "info" && e.payload?.kind === "test_evidence")).toBe(false);
  });
});

describe("runViaAcpWorker · A6b ACP 硬门槛(OPC_ACP_REQUIRED 严格模式)", () => {
  const prev = process.env.OPC_ACP_REQUIRED;
  afterEach(() => { if (prev === undefined) delete process.env.OPC_ACP_REQUIRED; else process.env.OPC_ACP_REQUIRED = prev; });

  it("acpRequired 判定:默认关;仅 1/true 开", () => {
    delete process.env.OPC_ACP_REQUIRED; expect(acpRequired()).toBe(false);
    process.env.OPC_ACP_REQUIRED = "1"; expect(acpRequired()).toBe(true);
    process.env.OPC_ACP_REQUIRED = "true"; expect(acpRequired()).toBe(true);
    process.env.OPC_ACP_REQUIRED = "0"; expect(acpRequired()).toBe(false);
    process.env.OPC_ACP_REQUIRED = ""; expect(acpRequired()).toBe(false);
  });

  it("OPC_ACP_REQUIRED=1 时 spawn 失败 → fallback 不被调用、status=failed、error 含'硬门槛'、executor 缺省、无 legacy_cli 选路事件", async () => {
    process.env.OPC_ACP_REQUIRED = "1";
    const root = tmpRoot();
    const { ctx, events } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const spawnWorker: AcpWorkerSpawnFn = () => Promise.resolve({ code: null, stdout: "", stderr: "", spawnError: "spawn npx ENOENT" });
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback, spawnWorker, workerRootOverride: root });

    expect(fallback).not.toHaveBeenCalled();
    expect(res.status).toBe("failed");
    expect(res.error).toContain("硬门槛");
    expect(res.error).toContain("ENOENT");
    expect(res.executor).toBeUndefined(); // 什么都没执行成 → executor 缺省(不虚标 legacy_cli)
    // 严格模式发 error、不发 executor_selected(legacy_cli)选路事件
    expect(events.some((e) => e.type === "info" && e.payload?.kind === "executor_selected")).toBe(false);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("软模式(默认)下同样 spawn 失败仍保底降级(现网行为不变回归)", async () => {
    delete process.env.OPC_ACP_REQUIRED;
    const root = tmpRoot();
    const { ctx } = makeCtx();
    const fallback = vi.fn(legacySentinel);
    const spawnWorker: AcpWorkerSpawnFn = () => Promise.resolve({ code: null, stdout: "", stderr: "", spawnError: "spawn npx ENOENT" });
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback, spawnWorker, workerRootOverride: root });
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(res.executor).toBe("legacy_cli");
  });
});

// P0 · producer ACP 交付回收:自研 worker 在隔离根写出的交付文件必须拷回 run 的 worktree(ctx.workdir)并作为
// fileChanges 返回——否则 cc-CLI/ACP 生产者恒被误判 no_file_changes(其产出落在隔离根、上层 git-diff 看不到)。
describe("runViaAcpWorker · producer 交付回收(隔离根产物拷回 ctx.workdir)", () => {
  const spawnWithDeliverable: AcpWorkerSpawnFn = async (input) => {
    const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
    fs.mkdirSync(runDir, { recursive: true });
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
      schemaVersion: "1", runId: input.runId, status: "done", startedAt: now, endedAt: now,
      agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 10, costUsd: 0 }],
      artifacts: [], deferred: [], totalTokens: 10, totalCostUsd: 0,
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(runDir, "report.md"), "# done");
    // producer 在【隔离根】写出交付文件(不在 run 的 worktree)——真实 ACP worker 同款位置
    fs.writeFileSync(path.join(input.isolatedRoot, "parseDuration.js"), "module.exports = () => 42;\n");
    return { code: 0, stdout: JSON.stringify({ runId: input.runId, agentId: "dev-1", status: "done", executor: "acp", engine: "claude-code", runDir }) + "\n", stderr: "" };
  };

  it("producer:隔离根的 parseDuration.js 被拷回 ctx.workdir 且作为 fileChanges 返回(不再误判 no_file_changes)", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx();
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: spawnWithDeliverable, workerRootOverride: root,
    });
    expect(res.status).toBe("done");
    expect(res.fileChanges.map((f) => f.path)).toContain("parseDuration.js");
    expect(fs.existsSync(path.join(ctx.workdir, "parseDuration.js"))).toBe(true);
    expect(fs.readFileSync(path.join(ctx.workdir, "parseDuration.js"), "utf-8")).toContain("42");
    // OPC 内部件不外泄到交付
    expect(res.fileChanges.map((f) => f.path).some((p) => p.includes(".opc") || p === "task.request.json")).toBe(false);
  });

  it("verifier:交付回收不触发,fileChanges 恒 [](其产出只作独立测试证据,绝不落交付)", async () => {
    const root = tmpRoot();
    const { ctx } = makeCtx({ isVerifier: true });
    const res = await runViaAcpWorker("claude-code", makeNode({ role: "test" }), makeTask(), ctx, {
      fallback: vi.fn(legacySentinel), spawnWorker: spawnWithDeliverable, workerRootOverride: root,
    });
    expect(res.status).toBe("done");
    expect(res.fileChanges).toEqual([]);
    expect(fs.existsSync(path.join(ctx.workdir, "parseDuration.js"))).toBe(false);
  });
});

// G1 · producer 交付回收硬化:基于隔离前基线的 create/modify/delete delta + fail-closed(越界/敏感/配额/复制失败)。
describe("G1 · producer ACP 交付回收(delta + fail-closed)", () => {
  // 假 worker:写标准 result.json(done)后,对隔离根执行 fn(建/改/删交付文件),模拟 claude-code 原生文件工具产出。
  const spawnDoing = (fn: (root: string) => void): AcpWorkerSpawnFn => async (input) => {
    const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
      schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t",
      agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 1, costUsd: 0 }],
      artifacts: [], deferred: [], totalTokens: 1, totalCostUsd: 0,
    }), "utf-8");
    fs.writeFileSync(path.join(runDir, "report.md"), "# done");
    fn(input.isolatedRoot);
    return { code: 0, stdout: JSON.stringify({ runId: input.runId, agentId: "dev-1", status: "done", executor: "acp", engine: "claude-code", runDir }), stderr: "" };
  };
  const run = (root: string, ctx: ExecContext, fn: (root: string) => void) =>
    runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback: vi.fn(legacySentinel), spawnWorker: spawnDoing(fn), workerRootOverride: root });

  it("create:worker 新建 sum.js → delta create,内容拷回 workdir", async () => {
    const root = tmpRoot(); const { ctx } = makeCtx();
    const res = await run(root, ctx, (r) => fs.writeFileSync(path.join(r, "sum.js"), "module.exports=1;\n"));
    expect(res.fileChanges).toEqual([{ path: "sum.js", changeType: "create", after: "module.exports=1;\n" }]);
    expect(fs.readFileSync(path.join(ctx.workdir, "sum.js"), "utf-8")).toBe("module.exports=1;\n");
  });

  it("modify:基线已有 existing.js,worker 改写 → delta modify(非 create,不误报)", async () => {
    const root = tmpRoot(); fs.writeFileSync(path.join(root, "existing.js"), "OLD\n"); // 基线(隔离前)
    const { ctx } = makeCtx();
    fs.writeFileSync(path.join(ctx.workdir, "existing.js"), "OLD\n"); // workdir 已有该文件 → 应用为 modify
    const res = await run(root, ctx, (r) => fs.writeFileSync(path.join(r, "existing.js"), "NEW\n"));
    expect(res.fileChanges).toEqual([{ path: "existing.js", changeType: "modify", after: "NEW\n" }]);
    expect(fs.readFileSync(path.join(ctx.workdir, "existing.js"), "utf-8")).toBe("NEW\n");
  });

  it("delete:基线已有 old.js,worker 删除 → delta delete,真删 workdir 里的文件", async () => {
    const root = tmpRoot(); fs.writeFileSync(path.join(root, "old.js"), "X\n"); // 基线
    const { ctx } = makeCtx(); fs.writeFileSync(path.join(ctx.workdir, "old.js"), "X\n"); // workdir 已交付该文件
    const res = await run(root, ctx, (r) => fs.rmSync(path.join(r, "old.js")));
    expect(res.fileChanges).toEqual([{ path: "old.js", changeType: "delete" }]);
    expect(fs.existsSync(path.join(ctx.workdir, "old.js"))).toBe(false);
  });

  it(".env 敏感文件在 delta 里 → fail-closed 整体拦截(app.js 也不落)", async () => {
    const root = tmpRoot(); const { ctx } = makeCtx();
    const res = await run(root, ctx, (r) => { fs.writeFileSync(path.join(r, "app.js"), "ok\n"); fs.writeFileSync(path.join(r, ".env"), "SECRET=1\n"); });
    expect(res.fileChanges).toEqual([]);
    expect(fs.existsSync(path.join(ctx.workdir, "app.js"))).toBe(false);
    expect(fs.existsSync(path.join(ctx.workdir, ".env"))).toBe(false);
  });

  it("nested node_modules → 任意层排除,不回收(只回收真交付 lib.js)", async () => {
    const root = tmpRoot(); const { ctx } = makeCtx();
    const res = await run(root, ctx, (r) => {
      fs.writeFileSync(path.join(r, "lib.js"), "ok\n");
      fs.mkdirSync(path.join(r, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(path.join(r, "node_modules", "pkg", "index.js"), "junk\n");
    });
    expect(res.fileChanges.map((f) => f.path)).toEqual(["lib.js"]);
    expect(fs.existsSync(path.join(ctx.workdir, "node_modules"))).toBe(false);
  });

  it("路径越界 delta → fail-closed(守卫挡住越界删除,workdir 外的文件绝不被删)", () => {
    const iso = tmpRoot(); const work = tmpRoot();
    const sentinel = path.join(path.dirname(work), "evil-sentinel.js"); // work 之外(兄弟)的真实文件
    fs.writeFileSync(sentinel, "keep");
    try {
      // 手造越界基线:baseline 含 "../evil-sentinel.js" 而 final(空隔离根)没有 → delete delta 指向 workdir 外。
      const rec = recoverProducerDelta(iso, work, new Map([["../evil-sentinel.js", "deadbeef"]]));
      expect("blocked" in rec).toBe(true);
      expect(("blocked" in rec) && /越界/.test(rec.blocked)).toBe(true);
      expect(fs.existsSync(sentinel)).toBe(true); // 守卫拦截:workdir 外的文件绝不被删
    } finally { try { fs.rmSync(sentinel, { force: true }); } catch { /* */ } }
  });

  it("部分复制失败(父路径是文件)→ fail-closed,已就绪的 a.js 也不写", async () => {
    const root = tmpRoot(); const { ctx } = makeCtx();
    fs.writeFileSync(path.join(ctx.workdir, "b"), "i am a file"); // workdir/b 是文件 → mkdir workdir/b/ 冲突
    const res = await run(root, ctx, (r) => {
      fs.writeFileSync(path.join(r, "a.js"), "ok\n");
      fs.mkdirSync(path.join(r, "b"), { recursive: true });
      fs.writeFileSync(path.join(r, "b", "c.js"), "nested\n");
    });
    expect(res.fileChanges).toEqual([]);
    expect(fs.existsSync(path.join(ctx.workdir, "a.js"))).toBe(false); // fail-closed:先建目录失败 → 一个都没写
  });
});

// 审计修复 · P0/P1:播种不泄密 / 回收真原子 / 大项目 capability_blocked。
describe("acpWorkerBackend 审计修复 · 播种不泄密 + 原子回收 + 大项目", () => {
  const doneResult = (input: { isolatedRoot: string; runId: string }) => {
    const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({
      schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t",
      agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 1, costUsd: 0 }],
      artifacts: [], deferred: [], totalTokens: 1, totalCostUsd: 0,
    }), "utf-8");
    fs.writeFileSync(path.join(runDir, "report.md"), "# done");
  };

  it("[P0] 播种前排除敏感文件:workdir 的 .env/私钥【绝不进 isolatedRoot】(外部 worker 读不到密钥)", async () => {
    const { ctx } = makeCtx(); // ctx.workdir = 非 git 临时目录
    fs.writeFileSync(path.join(ctx.workdir, "app.js"), "ok\n");
    fs.writeFileSync(path.join(ctx.workdir, ".env"), "SECRET=topsecret\n");
    fs.mkdirSync(path.join(ctx.workdir, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(ctx.workdir, ".ssh", "id_rsa"), "PRIVATEKEY\n");
    let seenInRoot: string[] = [];
    const spawnInspect: AcpWorkerSpawnFn = async (input) => {
      // worker 起跑时隔离根的内容 = 被播种进来的(worker 能读到的)文件
      const walk = (d: string, rel: string): string[] => {
        const acc: string[] = [];
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === ".opc") continue;
          const rp = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) acc.push(...walk(path.join(d, e.name), rp)); else acc.push(rp);
        }
        return acc;
      };
      seenInRoot = walk(input.isolatedRoot, "");
      doneResult(input);
      return { code: 0, stdout: JSON.stringify({ status: "done", runId: input.runId }), stderr: "" };
    };
    await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback: vi.fn(legacySentinel), spawnWorker: spawnInspect });
    expect(seenInRoot).toContain("app.js");
    expect(seenInRoot.some(f => /(^|\/)\.env$/.test(f))).toBe(false);      // .env 绝不播种
    expect(seenInRoot.some(f => /id_rsa/.test(f))).toBe(false);           // 私钥绝不播种
  });

  it("[P0] 回收真原子:中途写失败 → 完整回滚,已改的文件还原旧内容(workdir 无残留 NEW)", async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, "existing.js"), "OLD\n"); // 基线(隔离前)
    const { ctx } = makeCtx();
    fs.writeFileSync(path.join(ctx.workdir, "existing.js"), "OLD\n");
    fs.mkdirSync(path.join(ctx.workdir, "blocker.js")); // workdir/blocker.js 是【目录】→ 写文件 blocker.js 必 EISDIR
    const spawn2: AcpWorkerSpawnFn = async (input) => {
      doneResult(input);
      fs.writeFileSync(path.join(input.isolatedRoot, "existing.js"), "NEW\n"); // modify
      fs.writeFileSync(path.join(input.isolatedRoot, "blocker.js"), "boom\n"); // create → 应用时对 workdir 写会失败
      return { code: 0, stdout: JSON.stringify({ status: "done", runId: input.runId }), stderr: "" };
    };
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback: vi.fn(legacySentinel), spawnWorker: spawn2, workerRootOverride: root });
    expect(res.fileChanges).toEqual([]);                                          // fail-closed
    expect(fs.readFileSync(path.join(ctx.workdir, "existing.js"), "utf-8")).toBe("OLD\n"); // 回滚:未残留 NEW
    expect(fs.existsSync(path.join(ctx.workdir, "blocker.js"))).toBe(true);       // 目录未被破坏
  });

  it("[P1] delete 只报确实删掉的:workdir 本就无该文件 → 不报 phantom delete(基线有但 workdir 无)", () => {
    const iso = tmpRoot(); const work = tmpRoot();
    // 基线含 gone.js,final 无 → delta delete;但 workdir 里没有 gone.js → 无删可做,不报 delete
    const rec = recoverProducerDelta(iso, work, new Map([["gone.js", "hash"]]));
    expect("fileChanges" in rec && rec.fileChanges).toEqual([]);
  });

  it("[P1] 大项目(>500 可播种文件)→ capability_blocked(project_too_large),不在空目录假装工作", async () => {
    const { ctx } = makeCtx();
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(ctx.workdir, `f${i}.txt`), "x");
    let spawned = false;
    const spawn3: AcpWorkerSpawnFn = async (input) => { spawned = true; doneResult(input); return { code: 0, stdout: "{}", stderr: "" }; };
    const events: any[] = [];
    const ctx2 = { ...ctx, emit: (t: string, a: string | undefined, p: any) => events.push({ t, a, p }) };
    const res = await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx2 as any, { fallback: vi.fn(legacySentinel), spawnWorker: spawn3 });
    expect(res.status).toBe("restricted");
    expect(res.error).toMatch(/project_too_large/);
    expect(spawned).toBe(false); // 不 spawn worker(不假装工作)
    expect(events.some(e => e.p?.kind === "capability_blocked")).toBe(true);
  });
});

// 审计复核 P1:git 项目播种必须含 tracked + untracked non-ignored 源文件(不能只 tracked),且排除 gitignore/敏感。
describe("acpWorkerBackend 审计复核 · git 播种含 untracked 源文件", () => {
  const walkRoot = (d: string, rel = ""): string[] => {
    const acc: string[] = [];
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === ".opc" || e.name === ".git") continue;
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) acc.push(...walkRoot(path.join(d, e.name), rp)); else acc.push(rp);
    }
    return acc;
  };
  it("[P1] 刚建未提交且未 gitignore 的 untracked.js 被播种;tracked 也在;gitignore/.env 排除", async () => {
    const { ctx } = makeCtx();
    const git = (c: string) => execSync(`git ${c}`, { cwd: ctx.workdir, stdio: "pipe" });
    git("init -q"); git('config user.email "e@t"'); git('config user.name "e"');
    fs.writeFileSync(path.join(ctx.workdir, "tracked.js"), "T\n");
    fs.writeFileSync(path.join(ctx.workdir, ".gitignore"), "ignored.js\n.env\n");
    git("add tracked.js .gitignore"); git('commit -q -m init');
    fs.writeFileSync(path.join(ctx.workdir, "untracked.js"), "U\n"); // 刚建、未提交、未忽略 → 必须播种
    fs.writeFileSync(path.join(ctx.workdir, "ignored.js"), "I\n");   // gitignore → 不播种
    fs.writeFileSync(path.join(ctx.workdir, ".env"), "SECRET\n");    // 敏感(且 gitignore)→ 不播种
    let seen: string[] = [];
    const spawnInspect: AcpWorkerSpawnFn = async (input) => {
      seen = walkRoot(input.isolatedRoot);
      const runDir = path.join(input.isolatedRoot, ".opc", "runs", input.runId);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify({ schemaVersion: "1", runId: input.runId, status: "done", startedAt: "t", endedAt: "t", agents: [{ agentId: "dev-1", role: "dev", framework: "claude-code", status: "idle", tokens: 1, costUsd: 0 }], artifacts: [], deferred: [], totalTokens: 1, totalCostUsd: 0 }), "utf-8");
      fs.writeFileSync(path.join(runDir, "report.md"), "# done");
      return { code: 0, stdout: JSON.stringify({ status: "done", runId: input.runId }), stderr: "" };
    };
    await runViaAcpWorker("claude-code", makeNode(), makeTask(), ctx, { fallback: vi.fn(legacySentinel), spawnWorker: spawnInspect });
    expect(seen).toContain("tracked.js");
    expect(seen).toContain("untracked.js");                       // 关键:untracked non-ignored 被播种(不再漏)
    expect(seen).not.toContain("ignored.js");                     // gitignore 排除
    expect(seen.some(f => /(^|\/)\.env$/.test(f))).toBe(false);   // 敏感排除
  });
});
