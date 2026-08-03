import type { TraceEvent } from "@opc/shared";
import { v4 as uuid } from "uuid";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, type Hash } from "node:crypto";
import { RunHistory, type ConvergedRunEventType } from "./runHistory.js";
import { redactSecrets } from "../security/redact.js";

// Stage 9 安全:事件 payload 里这些字段常承载引擎 stderr / API 错误体(含 key 片段)。
// 落 events.jsonl + SSE 广播 + 经 Stage 8 分享 → 落盘前统一脱敏。
const SECRET_KEY_RE = /(?:api[_-]?key|apikey|x-api-key|authorization|secret|token|password|credential)/i;

function redactPayload(value: unknown, seen = new WeakSet<object>(), key?: string): unknown {
  if (typeof value === "string") {
    const redacted = redactSecrets(value);
    return key && SECRET_KEY_RE.test(key) && redacted === value ? "[REDACTED]" : redacted;
  }
  if (value === null || typeof value !== "object") return value;
  if (key && SECRET_KEY_RE.test(key)) return "[REDACTED]";
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactPayload(v, seen, k);
  }
  return out;
}
type Listener = (event: TraceEvent) => void;

const listeners = new Set<Listener>();
let currentRunId = "";
let durableSeq = 0;
let terminalCommitted = false;
interface ChunkDigestState {
  agentId?: string;
  thinking: boolean;
  chunks: number;
  bytes: number;
  firstAt: string;
  lastAt: string;
  hash: Hash;
}
let chunkDigests = new Map<string, ChunkDigestState>();
let flushingChunkDigests = false;
let currentRunHistory = new RunHistory(); // WS5: run 级事件历史(每次 setRunId 重置)

// Phase 0(工作台):事件持久化。除内存广播外,把每条事件 append 到
// <projectRoot>/.opc/runs/<runId>/events.jsonl,使刷新/重连后可回放、可按 agent 回看历史。
// best-effort:写失败绝不影响 run。
// 用量事件版本戳:落盘的每行在 TraceEvent 之外多带一个 v 字段,只影响这个 JSONL 封套,
// 不改内存 event 对象(SSE/listeners 广播、RunHistory 都拿不加 v 的原始 event)。
// reader(runHistoryStore.loadRunHistory)按字段读取,天然容忍没有 v 的历史行。
const EVENT_JSONL_VERSION = 1;
let persistRoot: string | null = null;
const ensuredDirs = new Set<string>();
export function setEventPersistRoot(root: string) { persistRoot = root; }
/** run 证据的 canonical 根(events.jsonl 落盘处)。engineLogCapture 用它对齐日志与其它证据的落盘位置——
 *  引擎拿到的 ctx.projectRoot 在 HTTP 团队/公司路径上是工作区根(activeWorkRoot),不是项目根。 */
export function getEventPersistRoot(): string | null { return persistRoot; }

function restoreDurableCursor(root: string | null, runId: string): { seq: number; terminal: boolean } {
  if (!root || !runId) return { seq: 0, terminal: false };
  try {
    const file = path.join(root, ".opc", "runs", runId, "events.jsonl");
    if (!fs.existsSync(file)) return { seq: 0, terminal: false };
    let seq = 0;
    let terminal = false;
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { seq?: unknown; type?: unknown };
        if (typeof event.seq === "number" && Number.isSafeInteger(event.seq)) seq = Math.max(seq, event.seq);
        if (event.type === "run_finished") terminal = true;
      } catch { /* a damaged telemetry line cannot reset committed state */ }
    }
    return { seq, terminal };
  } catch {
    return { seq: 0, terminal: false };
  }
}

export function setRunId(id: string) {
  currentRunId = id;
  currentRunHistory = new RunHistory();
  chunkDigests = new Map();
  flushingChunkDigests = false;
  const restored = restoreDurableCursor(persistRoot, id);
  durableSeq = restored.seq;
  terminalCommitted = restored.terminal;
}

/** 当前 run id(供后台 fire-and-forget 判断"是否仍在本 run",避免把迟到的 emit 记到下一个 run)。 */
export function getRunId(): string { return currentRunId; }

/** WS5: 获取当前 run 的 RunHistory 实例(供 orchestrator 末尾派生 failure report)。 */
export function getRunHistory(): RunHistory { return currentRunHistory; }

// 高频流式事件(每个 stdout chunk 一条,由各引擎在流式输出时 emit):只用于实时 UI tail 广播,
// 不落盘、不进 RunHistory。否则 emit() 会在最热路径上做同步 fs.appendFileSync + RunHistory 无界增长,
// 随输出量线性阻塞事件循环、对所有并行 worker 形成背压。listeners 广播照常,UI 实时性不受影响。
// 导出:orchestrator 的 traceSub 用同一集合过滤 trace.json(否则 chunk 经 listener 旁路重新落盘)。
export const EPHEMERAL_TYPES = new Set<string>(["agent_output_chunk"]);

// B5 · 收敛接线:model_call_started / tool_call 量大(每次模型/工具调用一条),进 canonical
// RunHistory 时走 appendConvergedEvent——payload 收敛为摘要级(model/provider 或 name/argsSummary)
// 且每 run 每类型上限 CONVERGED_EVENT_CAP 条,超出只累计条数(run 结束由 orchestrator 经
// appendConvergenceOverflowSummary 落汇总)。全量原始事件不受影响:events.jsonl 落盘与
// listeners 广播照旧,这里只改 run-history.jsonl 的物料来源。
const CONVERGED_TYPES = new Set<string>(["model_call_started", "tool_call"]);

const CRITICAL_EVENT_TYPES = new Set<string>(["run_finished", "quality_gate_result", "review_committed"]);
const CRITICAL_INFO_KINDS = new Set<string>([
  "effective_capability_manifest",
  "worker_launch_receipt",
  "test_evidence",
  "producer_artifact_manifest",
  "completion_receipt",
  "artifact_committed",
  "agent_output_digest",
]);

export class CriticalEventPersistenceError extends Error {
  constructor(public readonly eventType: string, cause: unknown) {
    super(`critical event persistence failed (${eventType}): ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CriticalEventPersistenceError";
  }
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : undefined;
}

function isCriticalEvent(type: string, payload: unknown): boolean {
  if (CRITICAL_EVENT_TYPES.has(type)) return true;
  const kind = payloadRecord(payload)?.kind;
  return typeof kind === "string" && CRITICAL_INFO_KINDS.has(kind);
}

function recordChunkDigest(agentId: string | undefined, payload: unknown, at: string): void {
  const record = payloadRecord(payload);
  const raw = typeof record?.chunk === "string" ? record.chunk : "";
  const chunk = redactSecrets(raw);
  const thinking = record?.thinking === true;
  const key = `${agentId ?? ""}:${thinking ? "thinking" : "output"}`;
  let state = chunkDigests.get(key);
  if (!state) {
    state = { agentId, thinking, chunks: 0, bytes: 0, firstAt: at, lastAt: at, hash: createHash("sha256") };
    chunkDigests.set(key, state);
  }
  state.chunks += 1;
  state.bytes += Buffer.byteLength(chunk, "utf8");
  state.lastAt = at;
  state.hash.update(chunk, "utf8");
}

function flushChunkDigestEvents(): void {
  if (flushingChunkDigests || chunkDigests.size === 0) return;
  flushingChunkDigests = true;
  const pending = [...chunkDigests.values()];
  chunkDigests.clear();
  try {
    for (const state of pending) {
      emit("info", state.agentId, {
        kind: "agent_output_digest",
        stream: state.thinking ? "thinking" : "output",
        chunks: state.chunks,
        bytes: state.bytes,
        firstAt: state.firstAt,
        lastAt: state.lastAt,
        sha256: state.hash.digest("hex"),
      });
    }
  } finally {
    flushingChunkDigests = false;
  }
}

export function emit(type: TraceEvent["type"], agentId?: string, payload: unknown = {}) {
  const ephemeral = EPHEMERAL_TYPES.has(type);
  const now = new Date().toISOString();
  if (ephemeral && type === "agent_output_chunk") recordChunkDigest(agentId, payload, now);
  if (!ephemeral && type === "run_finished") flushChunkDigestEvents();
  const critical = isCriticalEvent(type, payload);
  if (!ephemeral && terminalCommitted) {
    if (critical) throw new CriticalEventPersistenceError(type, "run already reached terminal state");
    return;
  }
  const record = payloadRecord(payload);
  const event: TraceEvent = {
    id: uuid(), runId: currentRunId,
    timestamp: now,
    ...(!ephemeral ? { seq: ++durableSeq, schemaVersion: "1" as const } : {}),
    ...(typeof record?.attempt === "number" ? { attempt: record.attempt } : {}),
    ...(typeof record?.visit === "number" ? { visit: record.visit } : {}),
    ...(typeof record?.causalParentId === "string" ? { causalParentId: record.causalParentId } : {}),
    type, agentId, payload: redactPayload(payload), // Stage 9:落盘/广播前脱敏密钥
  };
  if (!ephemeral && persistRoot && currentRunId) {
    try {
      const dir = path.join(persistRoot, ".opc", "runs", currentRunId);
      if (!ensuredDirs.has(dir)) { fs.mkdirSync(dir, { recursive: true }); ensuredDirs.add(dir); }
      const file = path.join(dir, "events.jsonl");
      fs.appendFileSync(file, JSON.stringify({ ...event, v: EVENT_JSONL_VERSION }) + "\n");
      if (critical) {
        const fd = fs.openSync(file, "r+");
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    } catch (error) {
      if (critical) throw new CriticalEventPersistenceError(type, error);
    }
  }
  if (!ephemeral && type === "run_finished") terminalCommitted = true;
  for (const l of listeners) {
    try { l(event); } catch { /* listeners cannot invalidate an already-persisted event */ }
  }
  // WS5: 每条 emit 同时 appendEvent 到 run 级 RunHistory — best-effort, 绝不阻断 run(高频 chunk 除外)
  if (!ephemeral) {
    try {
      const p = (payload !== null && typeof payload === "object" && !Array.isArray(payload))
        ? (event.payload as Record<string, unknown>)
        : undefined;
      if (CONVERGED_TYPES.has(type)) {
        currentRunHistory.appendConvergedEvent(type as ConvergedRunEventType, event.timestamp, agentId, p);
      } else {
        currentRunHistory.appendEvent(type, event.timestamp, agentId, p);
      }
    } catch { /* best-effort */ }
  }
}

export function subscribe(fn: Listener) { listeners.add(fn); }
export function unsubscribe(fn: Listener) { listeners.delete(fn); }
