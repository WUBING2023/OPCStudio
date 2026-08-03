// WS5 E5 · RunHistory 磁盘读取 + run 摘要派生 (只读助手)
// 不依赖 eventBus / orchestrator 运行时；全部 best-effort，绝不抛。
import * as fs from "node:fs";
import * as path from "node:path";
import { RunHistory } from "../runtime/runHistory.js";

/** replay 重建的 run 摘要状态。所有字段均从事件流派生，不手写结论。 */
export interface RunSummaryState {
  runId: string;
  /** run_started 事件时间戳 */
  startedAt: string | null;
  /** run_finished 事件时间戳 */
  finishedAt: string | null;
  /** 所有事件中出现过的 agentId（去重） */
  participatingAgents: string[];
  /** 总事件数 */
  totalEvents: number;
  /** 各类型事件计数 */
  eventTypeCounts: Record<string, number>;
  /** 是否降级（含 deliverable_degraded 事件） */
  degraded: boolean;
  /** 被 defer 的 agentId 列表（去重） */
  deferred: string[];
  /** 被拒绝的产物标识列表 */
  rejectedArtifacts: string[];
  /** 卡住的模块/agent 列表（去重） */
  stuckModules: string[];
  /** 关键领域事件时间线（有序） */
  timeline: Array<{
    seq: number;
    type: string;
    at: string;
    agentId?: string;
    summary?: string;
  }>;
}

function loadCanonicalEventLog(file: string, runId: string): RunHistory {
  if (!fs.existsSync(file)) return new RunHistory();
  const projected: string[] = [];
  let lastSeq = 0;
  for (const line of fs.readFileSync(file, "utf-8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw.runId === "string" && raw.runId !== runId) continue;
      const type = typeof raw.type === "string" ? raw.type : "";
      const at = typeof raw.timestamp === "string"
        ? raw.timestamp
        : typeof raw.at === "string"
          ? raw.at
          : "";
      if (!type || !at) continue;
      const persistedSeq = typeof raw.seq === "number" && Number.isSafeInteger(raw.seq) && raw.seq > lastSeq
        ? raw.seq
        : lastSeq + 1;
      lastSeq = persistedSeq;
      projected.push(JSON.stringify({
        seq: persistedSeq,
        type,
        at,
        ...(typeof raw.agentId === "string" ? { agentId: raw.agentId } : {}),
        ...(raw.payload !== null && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? { payload: raw.payload }
          : {}),
      }));
    } catch { /* skip damaged telemetry lines */ }
  }
  return RunHistory.fromJSONL(projected.join("\n"));
}

/**
 * 从磁盘加载 RunHistory。
 *
 * 优先级：
 *   1. `run-history.jsonl`（RunEvent 格式，由 orchestrator 收尾写入，含领域事件）
 *   2. `events.jsonl`（TraceEvent 格式，eventBus 实时写入，做字段转换）
 *
 * 两种格式均 best-effort 解析：损坏行跳过，读取失败返回空 RunHistory。
 * 绝不抛出。
 */
export function loadRunHistory(projectRoot: string, runId: string): RunHistory {
  const dir = path.join(projectRoot, ".opc", "runs", runId);

  // events.jsonl is the only canonical fact log. run-history.jsonl is a
  // compatibility projection for historical runs and must never override it.
  try {
    const canonical = loadCanonicalEventLog(path.join(dir, "events.jsonl"), runId);
    if (canonical.length > 0) return canonical;
  } catch { /* fall through to the legacy projection */ }

  // 1. 优先读 run-history.jsonl（RunEvent 格式，最完整）
  try {
    const p = path.join(dir, "run-history.jsonl");
    if (fs.existsSync(p)) {
      const content = fs.readFileSync(p, "utf-8");
      const hist = RunHistory.fromJSONL(content);
      if (hist.length > 0) return hist;
    }
  } catch { /* fallthrough */ }

  // 2. 回退：从 events.jsonl（TraceEvent 格式）转换
  //    TraceEvent: { id, runId, timestamp, type, agentId?, payload }
  //    RunEvent:   { seq(自动), type, at(←timestamp), agentId?, payload? }
  try {
    const p = path.join(dir, "events.jsonl");
    if (!fs.existsSync(p)) return new RunHistory();
    const lines = fs.readFileSync(p, "utf-8").split("\n");
    const hist = new RunHistory();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;
        const type = typeof raw.type === "string" ? raw.type : "";
        // 兼容两种字段名：at（RunEvent）/ timestamp（TraceEvent）
        const at = typeof raw.at === "string" ? raw.at
                 : typeof raw.timestamp === "string" ? raw.timestamp
                 : "";
        if (!type || !at) continue;
        const agentId = typeof raw.agentId === "string" ? raw.agentId : undefined;
        const payload = (raw.payload !== null && typeof raw.payload === "object"
                         && !Array.isArray(raw.payload))
          ? (raw.payload as Record<string, unknown>) : undefined;
        hist.appendEvent(type, at, agentId, payload);
      } catch { /* best-effort：跳过损坏行 */ }
    }
    return hist;
  } catch { /* best-effort */ }
  return new RunHistory();
}

// 进入时间线的关键领域事件类型
const TIMELINE_TYPES = new Set([
  "run_started", "run_finished",
  "agent_deferred", "worker_timeout", "workspace_quota_exceeded",
  "artifact_rejected", "deliverable_degraded", "module_stuck",
  "memory_committed", "memory_proposal_rejected",
  "lesson_committed", "lesson_repeated", "lesson_revoked", // Layer E 反思生命周期
]);

// type:"info" 但带这些 payload.kind 的领域事件也进时间线——超时抢救/theirs 强并/错配警告/拆分复用等
// 都以 info+kind 发出,之前历史快照完全看不见(只有直播能看到,冷加载历史 run 丢失这些关键事实)。
const TIMELINE_INFO_KINDS = new Set([
  "timeout_salvage", "merge_theirs", "team_mismatch",
  "plan_template_injected", "plan_template_saved", "synth_fair_share", "conclusion_summary",
  // MUP 波1 · Gate A 状态诚实:冲突待决裁/脏树警示/模拟 run/run 级待人工——历史时间线必须可见这些关键事实。
  "merge_conflict_requires_review", "dirty_workspace_at_start", "simulated_run", "run_requires_review",
]);

/**
 * 从 RunHistory 实例重建 run 摘要状态。
 * 完全从事件流推导，不读外部文件，不手写结论。
 * 可对内存中的 RunHistory 调用，也可对 loadRunHistory 返回的历史调用。
 * 绝不抛出。
 */
export function deriveRunSummary(hist: RunHistory, runId = ""): RunSummaryState {
  let startedAt: string | null = null;
  let finishedAt: string | null = null;
  const agentSet = new Set<string>();
  const typeCounts: Record<string, number> = {};
  const timeline: RunSummaryState["timeline"] = [];

  let degraded = false;
  const deferredSet = new Set<string>();
  const rejectedArtifacts: string[] = [];
  const stuckSet = new Set<string>();

  try {
    for (const ev of hist.getEvents()) {
      const type = typeof ev.type === "string" ? ev.type : "";
      const at = typeof ev.at === "string" ? ev.at : "";
      if (!type) continue;

      typeCounts[type] = (typeCounts[type] ?? 0) + 1;
      if (ev.agentId) agentSet.add(ev.agentId);

      if (type === "run_started" && at && startedAt === null) startedAt = at;
      if (type === "run_finished" && at) finishedAt = at;

      switch (type) {
        case "deliverable_degraded":
          degraded = true;
          break;
        case "agent_deferred":
          if (ev.agentId) deferredSet.add(ev.agentId);
          if (typeof ev.payload?.agentId === "string") deferredSet.add(ev.payload.agentId);
          break;
        case "worker_timeout":
        case "workspace_quota_exceeded":
          if (ev.agentId) { deferredSet.add(ev.agentId); stuckSet.add(ev.agentId); }
          break;
        case "artifact_rejected": {
          const ref = typeof ev.payload?.artifactId === "string"
            ? ev.payload.artifactId
            : typeof ev.payload?.artifactRef === "string"
              ? ev.payload.artifactRef
              : undefined;
          if (ref !== undefined) rejectedArtifacts.push(ref);
          break;
        }
        case "module_stuck":
          if (ev.agentId) stuckSet.add(ev.agentId);
          if (typeof ev.payload?.moduleId === "string") stuckSet.add(ev.payload.moduleId);
          break;
        default:
          break;
      }

      const infoKind = type === "info" && typeof ev.payload?.kind === "string" && TIMELINE_INFO_KINDS.has(ev.payload.kind) ? ev.payload.kind : undefined;
      if (TIMELINE_TYPES.has(type) || infoKind) {
        const summary = typeof ev.payload?.reason === "string"
          ? ev.payload.reason
          : typeof ev.payload?.message === "string"
            ? ev.payload.message
            : undefined;
        timeline.push({
          seq: typeof ev.seq === "number" ? ev.seq : timeline.length + 1,
          type: infoKind ?? type, // 领域 info 事件用 kind 作时间线类型(前端 KIND_I18N 可直接映射人话)
          at,
          ...(ev.agentId !== undefined && { agentId: ev.agentId }),
          ...(summary !== undefined && { summary }),
        });
      }
    }
  } catch { /* best-effort：派生失败返回已积累的部分状态 */ }

  return {
    runId,
    startedAt,
    finishedAt,
    participatingAgents: [...agentSet],
    totalEvents: hist.length,
    eventTypeCounts: typeCounts,
    degraded,
    deferred: [...deferredSet],
    rejectedArtifacts,
    stuckModules: [...stuckSet],
    timeline,
  };
}

/**
 * 便捷组合：直接从磁盘加载并派生 run 摘要。绝不抛出。
 */
export function loadRunSummary(projectRoot: string, runId: string): RunSummaryState {
  const hist = loadRunHistory(projectRoot, runId);
  return deriveRunSummary(hist, runId);
}
