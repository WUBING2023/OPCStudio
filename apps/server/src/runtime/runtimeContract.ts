// B1 · Runtime Contract writer:纯模块——把 run 的标准化证据写进 .opc/runs/<runId>/。
// 与 failure-report 同风格:显式 utf-8、best-effort try/catch,写失败绝不影响 run。
// 不改执行逻辑,只从现有真实数据(Run / callRecords / artifactStore / RunHistory 事件)派生。
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  RunResultContract,
  RunResultAgentSummary,
  RunDiagnostics,
  RunTestEvidence,
  ToolCallRecord,
  WorkerConfigSnapshot,
  RunStatus,
} from "@opc/shared";
import { RUNTIME_CONTRACT_SCHEMA_VERSION } from "@opc/shared";

// A3:Run.status 十态,但 result.json(RunResultContract,B1 外部契约 schema)固定四态。
// 这是**唯一**的收窄点——buildRunResultContract 内部调用,orchestrator / CLI workerRunner 等所有调用方
// 直接传宽 RunStatus 即可,不必各自记得映射(canonical:契约收窄逻辑不散落在调用方)。旧路径读到六个
// 任务图态时按语义就近映射,不抛错、不虚构成功。
export function toContractRunStatus(status: RunStatus): "pending" | "running" | "failed" | "done" {
  switch (status) {
    case "pending": case "running": case "failed": case "done":
      return status;
    case "accepted":
      return "done";
    case "planned": case "waiting_review": case "needs_revision":
      return "running";
    case "blocked": case "cancelled":
      return "failed";
    default:
      return "failed";
  }
}

const ARGS_SUMMARY_MAX = 300;
const MESSAGE_MAX = 300;
const LIST_CAP = 200; // 诊断各清单上限,防事件风暴把文件写爆

function runDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, ".opc", "runs", runId);
}

function writeJsonBestEffort(projectRoot: string, runId: string, filename: string, data: unknown): void {
  try {
    const dir = runDir(projectRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), "utf-8");
  } catch { /* best-effort:contract 写失败不影响 run */ }
}

// ── writers ───────────────────────────────────────────────────────────────────

export function writeRunResult(projectRoot: string, contract: RunResultContract): void {
  writeJsonBestEffort(projectRoot, contract.runId, "result.json", contract);
}

export function writeDiagnostics(projectRoot: string, diagnostics: RunDiagnostics): void {
  writeJsonBestEffort(projectRoot, diagnostics.runId, "diagnostics.json", diagnostics);
}

/** 追加写 tool_calls.jsonl(每条一行)。records 为空时不创建文件(无 tool_call 的 run 不留空壳)。 */
export function appendToolCalls(projectRoot: string, runId: string, records: ToolCallRecord[]): void {
  if (!records.length) return;
  try {
    const dir = runDir(projectRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    fs.appendFileSync(path.join(dir, "tool_calls.jsonl"), lines, "utf-8");
  } catch { /* best-effort */ }
}

export function writeWorkerConfig(projectRoot: string, snapshot: WorkerConfigSnapshot): void {
  writeJsonBestEffort(projectRoot, snapshot.runId, "worker.config.json", snapshot);
}

// ── result.json 构建(纯函数,orchestrator 只传现有数据) ────────────────────────────

export interface ContractRunLike {
  id: string;
  status: RunStatus; // 宽联合入,buildRunResultContract 内经 toContractRunStatus 收窄到契约四态
  startedAt: string;
  endedAt?: string;
  totalTokens: number;
  totalCostUsd?: number | null;
  participatingAgents: string[];
  degraded?: boolean;
  degradedReason?: string;
  executorDegraded?: boolean; // A6b:本 run 有 ACP→legacy CLI 降级执行(orchestrator finalize 从事件流派生后置入 run)
  simulated?: true; // MUP Gate A#2:run 含 mock 调用(orchestrator 从 model_call_finished 事件聚合后置入 run)
  finalState?: "verified" | "tests_passed" | "degraded" | "failed" | "requires_review"; // MUP 波1:deriveFinalRunState 单一收敛(选1 加 tests_passed)
  partialDelivery?: true; // D2:含超时抢救 partial,绝不纯净 done
  // MUP 波2:orchestrator 收尾置入的交付验收结论(Run.deliveryAcceptance 加性字段),result.json 如实透传。
  deliveryAcceptance?: { status: string; reasons?: string[]; partialDelivery?: true };
}

export interface ContractAgentLike {
  id: string;
  role: string;
  framework?: string;
  status: string;
}

export interface ContractCallRecordLike {
  agentId: string;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface ContractArtifactLike {
  id: string;
  producedBy: string;
  kind: string;
  type: string;
  name: string;
  summary?: string;
}

export interface ContractDeferredLike {
  taskId: string;
  agentId: string;
  reason: string;
  attempts: number;
}

export function buildRunResultContract(input: {
  run: ContractRunLike;
  agents: ContractAgentLike[];
  callRecords: ContractCallRecordLike[];
  artifacts: ContractArtifactLike[];
  deferred: ContractDeferredLike[];
  events?: ContractSourceEvent[]; // B5c:提供时派生 retryCount;不提供(如崩溃路径)则该字段缺省,不虚构
}): RunResultContract {
  const { run, agents, callRecords, artifacts, deferred, events } = input;
  const executors = events ? deriveAgentExecutors(events) : undefined;
  const testEvidence = events ? deriveTestEvidence(events) : []; // A8:空 → 字段缺省,不写空数组占位
  const simulatedAgents = events ? deriveSimulatedAgents(events) : undefined;
  const agentSummaries: RunResultAgentSummary[] = [...new Set(run.participatingAgents)].map((id) => {
    const a = agents.find((x) => x.id === id);
    const recs = callRecords.filter((r) => r.agentId === id);
    const exec = executors?.get(id);
    return {
      agentId: id,
      role: a?.role ?? "unknown",
      framework: a?.framework ?? "api",
      status: a?.status ?? "unknown",
      tokens: recs.reduce((s, r) => s + (r.totalTokens ?? 0), 0),
      costUsd: recs.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0),
      ...(exec ? { executor: exec.executor, ...(exec.degraded ? { executorDegraded: true as const } : {}) } : {}),
      ...(simulatedAgents?.has(id) ? { simulated: true as const } : {}),
    };
  });
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runId: run.id,
    status: toContractRunStatus(run.status),
    startedAt: run.startedAt,
    ...(run.endedAt ? { endedAt: run.endedAt } : {}),
    agents: agentSummaries,
    artifacts: artifacts.slice(0, LIST_CAP).map((a) => ({
      id: a.id,
      producedBy: a.producedBy,
      kind: a.kind,
      type: a.type,
      name: a.name,
      ...(a.summary ? { summary: a.summary.slice(0, MESSAGE_MAX) } : {}),
    })),
    deferred: deferred.map((d) => ({ taskId: d.taskId, agentId: d.agentId, reason: d.reason, attempts: d.attempts })),
    totalTokens: run.totalTokens,
    totalCostUsd: run.totalCostUsd ?? 0,
    ...(run.degraded ? { degraded: true, degradedReason: run.degradedReason } : {}),
    ...(run.executorDegraded ? { executorDegraded: true } : {}), // A6b:降级 run 如实带出,不虚标纯净成功
    ...(events ? { retryCount: deriveRetryCount(events) } : {}),
    ...(testEvidence.length ? { testEvidence } : {}),
    // MUP 波1(加性,老 run/未置字段缺省):mock run 永远带 simulated;finalState 单一收敛真相;partial 不纯净。
    ...(run.simulated ? { simulated: true } : {}),
    ...(run.finalState ? { finalState: run.finalState } : {}),
    ...(run.partialDelivery ? { partialDelivery: true } : {}),
    // MUP 波2(加性):交付验收结论透传(status 必带;reasons 有内容才带,契约侧不写空数组占位)。
    ...(run.deliveryAcceptance
      ? {
          deliveryAcceptance: {
            status: run.deliveryAcceptance.status,
            ...(run.deliveryAcceptance.reasons?.length ? { reasons: run.deliveryAcceptance.reasons } : {}),
          },
        }
      : {}),
  };
}

// MUP Gate A#2(矩阵8)· 从事件流派生"该 agent 本 run 至少一次 mock 调用"(与 run 级聚合、web
// executorBadge.deriveRunSimulated 同口径:payload.simulated===true 或 provider==="mock")。
function deriveSimulatedAgents(events: ContractSourceEvent[]): Set<string> {
  const set = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "model_call_finished" || !ev.agentId) continue;
    const p = ev.payload ?? {};
    if (p.simulated === true || p.provider === "mock") set.add(ev.agentId);
  }
  return set;
}

// ── B1 · 崩溃路径最小失败契约 ─────────────────────────────────────────────────────
// startRun 未捕获异常的 catch 兜底用:正常 run-end 的 contract 写入块(try 尾部)走不到,
// 崩溃 run 原本只剩 worker.config.json + task.json。这里如实给出"没跑到汇总阶段"的最小
// result.json / diagnostics.json——空 agents/artifacts/deferred、engineFailures 恰一条,
// 不虚构数据、不新造格式(复用 RunResultContract / RunDiagnostics)。
// errorSummary 由调用方先过 redactSecrets;这里只按 MESSAGE_MAX 截断。

export function buildCrashRunResultContract(input: {
  runId: string;
  startedAt: string;
  endedAt: string;
  errorSummary: string;
  totalTokens?: number;
  totalCostUsd?: number | null;
}): RunResultContract {
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runId: input.runId,
    status: "failed",
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    agents: [],
    artifacts: [],
    deferred: [],
    totalTokens: input.totalTokens ?? 0,
    totalCostUsd: input.totalCostUsd ?? 0,
    degraded: true,
    degradedReason: str(input.errorSummary),
  };
}

export function buildCrashDiagnostics(input: { runId: string; at: string; errorSummary: string }): RunDiagnostics {
  return {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runId: input.runId,
    engineFailures: [{ at: input.at, message: str(input.errorSummary) }],
    providerFallbacks: [],
    rateLimitHits: [],
    permissionBlocks: [],
    notes: [`crash_contract: startRun 未捕获异常兜底写入(run 未跑到正常收尾)- ${str(input.errorSummary)}`],
  };
}

// ── 事件派生(tool_calls / diagnostics) ──────────────────────────────────────────
// 输入形状兼容 RunHistory.getEvents() 的 RunEvent({ type, at, agentId?, payload? })。

export interface ContractSourceEvent {
  type: string;
  at: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}

function str(v: unknown, max = MESSAGE_MAX): string {
  return String(v ?? "").slice(0, max);
}

// MUP 波2 · resolvedProducerFiles 形状清洗:只收 { path:string, hash:string } 的合规条目(截断防爆),
// 非数组/一条不剩 → undefined(字段缺省,不虚构)。hash 规格 = sha256 全量小写 hex(64 位)。
function sanitizeResolvedProducerFiles(v: unknown): Array<{ path: string; hash: string }> | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: Array<{ path: string; hash: string }> = [];
  for (const e of v) {
    if (out.length >= LIST_CAP) break;
    if (!e || typeof e !== "object") continue;
    const p = (e as { path?: unknown }).path;
    const h = (e as { hash?: unknown }).hash;
    if (typeof p !== "string" || !p || typeof h !== "string" || !h) continue;
    out.push({ path: str(p, 300), hash: str(h, 64) });
  }
  return out.length ? out : undefined;
}

/**
 * 从事件流派生 tool_calls.jsonl 记录。
 * 配对规则:每条 tool_call 与**同 agent 的下一条 tool_result**配对(引擎内 tool 调用按 agent 串行);
 * result 文本以 error 开头 → ok=false。没配对到 tool_result(如 CodexEngine 只发 tool_call)→
 * ok=true(调用已发出、无失败信号)、不带 durationMs——诚实反映可得数据,不虚构。
 */
export function deriveToolCallRecords(events: ContractSourceEvent[]): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  const pending = new Map<string, { record: ToolCallRecord; at: string }>(); // agentKey → 未配对的最后一条 tool_call
  const keyOf = (agentId?: string) => agentId ?? "__no_agent__";
  for (const ev of events) {
    if (ev.type === "tool_call") {
      const p = ev.payload ?? {};
      let argsSummary = "";
      // B5 收敛兼容:RunHistory 里的 tool_call 已被 appendConvergedEvent 收敛为 { name, argsSummary }
      // (同为 JSON.stringify(args) 截断 300,值与此处自算一致)——有现成摘要直接用,否则按原逻辑自算。
      if (typeof p.argsSummary === "string") {
        argsSummary = str(p.argsSummary, ARGS_SUMMARY_MAX);
      } else {
        try { argsSummary = str(JSON.stringify(p.args ?? {}), ARGS_SUMMARY_MAX); } catch { argsSummary = "[unserializable]"; }
      }
      const record: ToolCallRecord = {
        ts: ev.at,
        ...(ev.agentId ? { agentId: ev.agentId } : {}),
        tool: str(p.name, 120) || "tool",
        argsSummary,
        ok: true,
      };
      records.push(record);
      pending.set(keyOf(ev.agentId), { record, at: ev.at });
    } else if (ev.type === "tool_result") {
      const open = pending.get(keyOf(ev.agentId));
      if (!open) continue;
      pending.delete(keyOf(ev.agentId));
      const resultText = str((ev.payload ?? {}).result, 500);
      if (/^\s*error\b/i.test(resultText)) open.record.ok = false;
      const started = Date.parse(open.at);
      const ended = Date.parse(ev.at);
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
        open.record.durationMs = ended - started;
      }
    }
  }
  return records;
}

/**
 * 从事件流派生 diagnostics.json。全部来自现有事件:
 * - error(restricted:true → permissionBlocks;其余 → engineFailures)
 * - rate_limited(全部 → rateLimitHits;payload.fallback 存在 → 同时记 providerFallbacks)
 * - deliverable_degraded / module_stuck → notes
 * - info(kind: "memory_pack_used", packHash)→ memoryPackHashes(B5 证据链,去重;无则字段缺省)
 * - info(kind: "executor_selected", degradedReason)→ executorFallbacks(acpWorkerBackend 的
 *   ACP→legacy CLI 降级点;正常 ACP 选路不带 degradedReason,不记;无降级则字段缺省)
 * extras.mcpCapabilityVersions(B5:getMcpCapabilityVersions 的结果)提供时原样带上——
 * 无 MCP 配置时为空对象 {},字段照写不省略(可与"无该字段的老文件"区分)。
 */
export function deriveRunDiagnostics(
  runId: string,
  events: ContractSourceEvent[],
  extras?: { mcpCapabilityVersions?: Record<string, string> },
): RunDiagnostics {
  const diag: RunDiagnostics = {
    schemaVersion: RUNTIME_CONTRACT_SCHEMA_VERSION,
    runId,
    engineFailures: [],
    providerFallbacks: [],
    rateLimitHits: [],
    permissionBlocks: [],
    notes: [],
  };
  const packHashes = new Set<string>();
  const executorFallbacks: NonNullable<RunDiagnostics["executorFallbacks"]> = [];
  const workerStartupFailures: NonNullable<RunDiagnostics['workerStartupFailures']> = [];
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (ev.type === "info") {
      if (p.kind === "memory_pack_used" && typeof p.packHash === "string" && p.packHash && packHashes.size < LIST_CAP) {
        packHashes.add(p.packHash);
      } else if (p.kind === "executor_selected" && typeof p.degradedReason === "string" && p.degradedReason && executorFallbacks.length < LIST_CAP) {
        executorFallbacks.push({
          at: ev.at,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          from: "acp",
          to: str(p.executor, 40) || "legacy_cli",
          reason: str(p.degradedReason),
        });
      }
    } else if (ev.type === "error") {
      if (p.kind === 'worker_startup_diagnostic' && workerStartupFailures.length < LIST_CAP) {
        const classification = p.classification;
        const phase = p.phase;
        if (
          typeof p.runId === 'string'
          && typeof p.agentId === 'string'
          && typeof p.taskId === 'string'
          && typeof p.at === 'string'
          && typeof p.attempt === 'number'
          && typeof p.framework === 'string'
          && typeof classification === 'string'
          && typeof phase === 'string'
        ) {
          workerStartupFailures.push({
            at: str(p.at, 40),
            runId: str(p.runId, 120),
            agentId: str(p.agentId, 120),
            taskId: str(p.taskId, 180),
            attempt: p.attempt,
            framework: str(p.framework, 80),
            phase: phase as NonNullable<RunDiagnostics['workerStartupFailures']>[number]['phase'],
            classification: classification as NonNullable<RunDiagnostics['workerStartupFailures']>[number]['classification'],
            message: str(p.message, 800),
            suggestedAction: str(p.suggestedAction, 300),
            activityObserved: false,
          });
        }
      }
      const entry = { at: ev.at, ...(ev.agentId ? { agentId: ev.agentId } : {}), message: str(p.message) };
      if (p.restricted === true) {
        if (diag.permissionBlocks.length < LIST_CAP) diag.permissionBlocks.push(entry);
      } else {
        if (diag.engineFailures.length < LIST_CAP) diag.engineFailures.push(entry);
      }
    } else if (ev.type === "rate_limited") {
      if (diag.rateLimitHits.length < LIST_CAP) {
        diag.rateLimitHits.push({
          at: ev.at,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          model: str(p.originalModel, 120),
          ...(p.rateLimitedUntil ? { rateLimitedUntil: str(p.rateLimitedUntil, 40) } : {}),
          ...(p.reason ? { reason: str(p.reason, 120) } : {}),
        });
      }
      if (p.fallback && diag.providerFallbacks.length < LIST_CAP) {
        diag.providerFallbacks.push({
          at: ev.at,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          from: str(p.originalModel, 120),
          to: str(p.fallback, 120),
          ...(p.reason ? { reason: str(p.reason, 120) } : {}),
        });
      }
    } else if (ev.type === "deliverable_degraded") {
      if (diag.notes.length < LIST_CAP) diag.notes.push(`deliverable_degraded: ${str(p.reason)}`);
    } else if (ev.type === "module_stuck") {
      if (diag.notes.length < LIST_CAP) diag.notes.push(`module_stuck: ${str(p.message ?? p.reason)}`);
    }
  }
  if (packHashes.size > 0) diag.memoryPackHashes = [...packHashes];
  if (executorFallbacks.length > 0) diag.executorFallbacks = executorFallbacks;
  if (workerStartupFailures.length > 0) diag.workerStartupFailures = workerStartupFailures;
  if (extras?.mcpCapabilityVersions) diag.mcpCapabilityVersions = extras.mcpCapabilityVersions;
  return diag;
}

/**
 * B5c · 从事件流派生 run 级重试计数。来源:目前唯一可用的结构化"重试"信号是 rate_limited 事件——
 * 每条代表一次因限流触发的换用备用引擎(workerRuntime.ts 的 "pre-call cooldown routing" / "post-call
 * overload detected" 两处 emit 点,见 deriveRunDiagnostics 的 rateLimitHits)。parallelExecutor 内部
 * 的同任务多次尝试(attempt 1..maxAttempts)不落独立事件,拿不到就不数——不用消息文本猜、不虚构。
 */
export function deriveRetryCount(events: ContractSourceEvent[]): number {
  let n = 0;
  for (const ev of events) if (ev.type === "rate_limited") n++;
  return n;
}

/**
 * A6a · 从事件流派生 per-agent 执行通道(agentId → executor)。来源:引擎选路点 emit 的
 * info { kind:"executor_selected", executor:"acp"|"legacy_cli"|"api" } 事件。规则:
 * - 同 agent 多条 executor_selected 取 last-wins(重试换通道时以最后一次为准);
 * - 但含 degradedReason 的 legacy_cli(ACP→legacy 真降级)**粘滞**——一旦降过级,不被后续
 *   acp/api 覆盖,agent 摘要如实带 executorDegraded:true(镜像 web traceTypes deriveRunExecutors
 *   的诚实呈现语义;显式关闭 ACP 的逃生门 legacy_cli 无 degradedReason,不粘滞、不算降级);
 * - 无事件 / 非三值 executor → 不记,字段缺省不虚构。
 */
function deriveAgentExecutors(events: ContractSourceEvent[]): Map<string, { executor: string; degraded?: true }> {
  const map = new Map<string, { executor: string; degraded?: true }>();
  for (const ev of events) {
    if (ev.type !== "info" || !ev.agentId) continue;
    const p = ev.payload ?? {};
    if (p.kind !== "executor_selected") continue;
    const ex = p.executor;
    if (ex !== "acp" && ex !== "legacy_cli" && ex !== "api") continue;
    if (map.get(ev.agentId)?.degraded) continue; // 降级粘滞:不被后续选路覆盖
    const degraded = ex === "legacy_cli" && typeof p.degradedReason === "string" && !!p.degradedReason;
    map.set(ev.agentId, degraded ? { executor: ex, degraded: true } : { executor: ex });
  }
  return map;
}

/**
 * A8 · 从事件流派生真实测试执行证据(RunResultContract.testEvidence;战役B EvidenceManifest.tests
 * 的唯一数据源)。语义铁律:只聚合 worker 在其 workdir 真实执行过的命令,零推断——绝不从 OPC Studio
 * 仓库自身推断产品测试;拿不到真实证据就不记(诚实缺省)。两个来源:
 * - 来源 a(权威):info { kind:"test_evidence" }(parallelExecutor 质量门后 emit,含 command/cwd/exitCode);
 * - 来源 b(降级):tool_call name="runTests" 配对**同 agent 的下一条 tool_result**(配对法同
 *   deriveToolCallRecords;后续非 runTests 的 tool_call 顶掉待配对位,防止别的工具结果误配),
 *   解析首行机器头 "[test-evidence] command=… exit=… passed=…"。头缺失(老格式 run)时如实降精度:
 *   只记 { command:"runTests(auto)", passed }(按 "Tests failed" 前缀判);其中"无测试框架"与
 *   "Error:"(工具层失败)两类结果**没有任何真实测试执行**,直接不记,绝不虚构 passed。
 * LIST_CAP 封顶。
 */
export function deriveTestEvidence(events: ContractSourceEvent[]): RunTestEvidence[] {
  const out: RunTestEvidence[] = [];
  // agentKey → 该 agent 最后一条未配对的测试类 tool_call 的工具名。runTests 走原有规则(头/无框架/老格式);
  // runShell(P0-4 受限测试通道)只在结果**带 [test-evidence] 头**时计入 —— 普通 shell 结果不是测试证据。
  const pendingTestTool = new Map<string, "runTests" | "runShell">();
  const keyOf = (agentId?: string) => agentId ?? "__no_agent__";
  const push = (e: RunTestEvidence) => { if (out.length < LIST_CAP) out.push(e); };
  for (const ev of events) {
    const p = ev.payload ?? {};
    if (ev.type === "info" && p.kind === "test_evidence") {
      // MUP 波2 · Node 解析链证据透传(快照运行器采集,acpWorkerBackend emit;runShell 文本头通道无解析链是常态,缺省)。
      const resolvedProducerFiles = sanitizeResolvedProducerFiles(p.resolvedProducerFiles);
      push({
        at: ev.at,
        ...(ev.agentId ? { agentId: ev.agentId } : {}),
        command: str(p.command) || "unknown",
        ...(typeof p.cwd === "string" && p.cwd ? { cwd: str(p.cwd) } : {}),
        ...(typeof p.exitCode === "number" ? { exitCode: p.exitCode } : {}),
        passed: p.passed === true,
        ...(typeof p.output === "string" && p.output ? { output: str(p.output, 500) } : {}),
        source: p.source === "tool" ? "tool" : "quality_gate",
        // P0-3 独立验证:Verifier Snapshot 权威证据的 testerAgentId/independent/testedCommit 透传(有则带、无则缺省)。
        ...(typeof p.testerAgentId === "string" && p.testerAgentId ? { testerAgentId: str(p.testerAgentId, 120) } : {}),
        ...(typeof p.independent === "boolean" ? { independent: p.independent } : {}),
        ...(typeof p.testedCommit === "string" && p.testedCommit ? { testedCommit: str(p.testedCommit, 80) } : {}),
        // P0 交付合同绑定:被测测试文件(相对路径)+ 其快照 hash 透传(有则带、无则缺省),让独立证据可审计到"测了哪个文件的哪份字节"。
        ...(typeof p.testedFile === "string" && p.testedFile ? { testedFile: str(p.testedFile, 300) } : {}),
        ...(typeof p.testedFileHash === "string" && p.testedFileHash ? { testedFileHash: str(p.testedFileHash, 64) } : {}),
        ...(resolvedProducerFiles ? { resolvedProducerFiles } : {}),
      });
    } else if (ev.type === "tool_call") {
      const name = str(p.name, 120);
      if (name === "runTests" || name === "runShell") pendingTestTool.set(keyOf(ev.agentId), name);
      else pendingTestTool.delete(keyOf(ev.agentId));
    } else if (ev.type === "tool_result") {
      const tool = pendingTestTool.get(keyOf(ev.agentId));
      if (!tool) continue;
      pendingTestTool.delete(keyOf(ev.agentId));
      const text = String(p.result ?? "");
      const nl = text.indexOf("\n");
      const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
      // 机器头(runTests 与 P0-4 runShell 受限通道同格式);cwd 可选(runShell 通道带 cwd,老 runTests 头无);
      // P0 · testedFile/testedHash 成对可选尾字段(runShell 受限通道绑定被测测试文件+hash),供 gate 判合同覆盖。
      // 用户选2 定案:runShell 是 agent 调用通道,【绝不携带/派生 resolvedProducerFiles 强证据】(无 nonce/resolvedFiles
      // 尾字段)——此文本头只产弱证据(command/cwd/exit/passed/testedFile+hash),封顶 tests_ran_unbound。verified 强证据
      // 只来自 Core 进程外观测器经 info{kind:test_evidence} 结构化事件透传(见上方 source==="tool" 结构化分支)。
      const m = /^\[test-evidence\] command=(.+?)(?: cwd=(.+?))? exit=(-?\d+) passed=(true|false)(?: testedFile=(.+?)(?: testedHash=([a-f0-9]+))?)?$/.exec(firstLine);
      if (m) {
        const body = nl >= 0 ? text.slice(nl + 1) : "";
        push({
          at: ev.at,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          command: m[1] || (tool === "runShell" ? "test" : "runTests(auto)"),
          ...(m[2] ? { cwd: str(m[2]) } : {}),
          exitCode: parseInt(m[3], 10),
          passed: m[4] === "true",
          ...(body.trim() ? { output: str(body, 500) } : {}),
          source: "tool",
          ...(m[5] ? { testedFile: str(m[5], 300) } : {}),
          ...(m[6] ? { testedFileHash: str(m[6], 64) } : {}),
          // resolvedProducerFiles 绝不从文本头派生(agent 无权自报强证据)→ 无 → 封顶 tests_ran_unbound。
        });
      } else if (tool === "runShell") {
        // runShell 结果无机器头 = 普通 shell 命令,不是测试 → 绝不当测试证据(诚实缺省)。
      } else if (/^no test framework detected/i.test(firstLine) || /^error\b/i.test(firstLine)) {
        // runTests 无框架 / 工具层错误:没有任何真实测试被执行 → 不记(诚实缺省)。
      } else {
        push({
          at: ev.at,
          ...(ev.agentId ? { agentId: ev.agentId } : {}),
          command: "runTests(auto)",
          passed: !/^tests failed/i.test(firstLine),
          ...(text.trim() ? { output: str(text, 500) } : {}),
          source: "tool",
        });
      }
    }
  }
  return out;
}

/**
 * A8 · structured report 的 tests 段聚合(从 orchestrator 抽出的纯函数,压薄 orchestrator diff)。
 * evidence 为空 → null,调用方保留既有诚实 ran:false 文案(orchestrator 三段文案逐字节不变);
 * 非空 → ran:true、passed=每次真实执行都通过(中途 gate 失败重试后修复的,如实呈现 false——
 * "所有执行都过了"与"最终过了"是两回事,这里记前者)、command=去重命令拼接、
 * output=最后一条失败输出(全过时给汇总句)。
 */
export function aggregateTestRes(evidence: RunTestEvidence[]): { ran: true; passed: boolean; command: string; output: string } | null {
  if (!evidence.length) return null;
  const lastFailed = [...evidence].reverse().find((e) => !e.passed);
  return {
    ran: true,
    passed: !lastFailed,
    command: [...new Set(evidence.map((e) => e.command))].join("; "),
    output: lastFailed
      ? (lastFailed.output || `测试失败:${lastFailed.command}(无输出记录)`)
      : `${evidence.length} 次真实测试执行,全部通过`,
  };
}
