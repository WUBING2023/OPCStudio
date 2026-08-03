// WS5 · 可 replay 的 canonical history — RunHistory 模块。
// 对应 PLAN §8 Phase 5（"严格投影 + replay/rollback"），同时支撑 WS0 的最小事件日志起步。
// 本模块是 dormant 模块，未 wire 进 orchestrator；落盘与集成由后续批次完成。
//
// 设计约束：
//   - 时间戳由调用方传入，模块内部绝不调用 Date.now()。
//   - 不依赖真实 fs；落盘接口只提供 toJSONL/fromJSONL 字符串，文件 I/O 由上层决定。
//   - deriveFailureReport 完全从事件流派生结构化报告，不手写硬编码结论。

// ── 事件类型 ──────────────────────────────────────────────────────────────────

/**
 * 已知的关键事件类型——deriveFailureReport 识别失败模式时使用。
 * 调用方可传任意 string；此处仅列出会被 FailureReport 解读的类型。
 */
export type KnownRunEventType =
  | "run_started"
  | "run_finished"
  | "agent_deferred"           // worker/agent 被 defer（超时/预算耗尽等）
  | "artifact_rejected"        // 产物未通过 ArtifactContract 验收
  | "deliverable_degraded"     // 最终交付物降级（非满分产出）
  | "workspace_quota_exceeded" // 工作区超额（路径/大小/深度/文件数）
  | "worker_timeout"           // worker 硬超时
  | "module_stuck"             // 某模块卡住（多次重试仍无进展）
  | "memory_proposal_rejected" // 记忆提案被拒
  | "memory_committed"         // 记忆提案被批准并提交
  | "model_call_started"       // B5:模型调用开始(收敛为摘要级,appendConvergedEvent 专用)
  | "tool_call"                // B5:工具调用(收敛为摘要级,appendConvergedEvent 专用)
  | "converged_events_overflow"; // B5:收敛事件超上限的汇总(appendConvergenceOverflowSummary 写入)

// ── B5 · 收敛领域事件(model_call_started / tool_call)────────────────────────────
// 这两类事件量大(每次模型/工具调用一条),只以**摘要级 payload** 进入 canonical history,
// 且每 run 每类型上限 CONVERGED_EVENT_CAP 条;超出部分只累计条数(getConvergenceCounts /
// appendConvergenceOverflowSummary),绝不把全量 payload 塞进 run-history.jsonl。

export type ConvergedRunEventType = "model_call_started" | "tool_call";

export const CONVERGED_EVENT_CAP = 200;

const MODEL_FIELD_MAX = 120;
const ARGS_SUMMARY_MAX = 300;

export interface ConvergedTypeCount {
  /** 该类型实际发生的总条数(含超上限未入 history 的) */
  total: number;
  /** 实际写入 history 的条数(<= CONVERGED_EVENT_CAP) */
  recorded: number;
}

export type ConvergenceCounts = Record<ConvergedRunEventType, ConvergedTypeCount>;

function truncStr(v: unknown, max: number): string | undefined {
  if (typeof v !== "string" || !v) return undefined;
  return v.length > max ? v.slice(0, max) : v;
}

// 摘要级 payload:只保留身份字段,丢掉全量参数/响应体。
function summarizeConvergedPayload(
  type: ConvergedRunEventType,
  payload?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  const out: Record<string, unknown> = {};
  if (type === "model_call_started") {
    const model = truncStr(payload.model, MODEL_FIELD_MAX);
    const provider = truncStr(payload.provider, MODEL_FIELD_MAX);
    if (model !== undefined) out.model = model;
    if (provider !== undefined) out.provider = provider;
  } else {
    const name = truncStr(payload.name ?? payload.tool, MODEL_FIELD_MAX);
    if (name !== undefined) out.name = name;
    if (payload.args !== undefined) {
      let argsSummary: string;
      try { argsSummary = String(JSON.stringify(payload.args)).slice(0, ARGS_SUMMARY_MAX); } catch { argsSummary = "[unserializable]"; }
      out.argsSummary = argsSummary;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ── 核心数据类型 ───────────────────────────────────────────────────────────────

/**
 * canonical history 事件单元。
 * seq 由 RunHistory 分配（从 1 开始单调递增）；
 * at / agentId / payload 全部由调用方提供——模块不生成时间戳。
 */
export interface RunEvent {
  /** 在本次 run 内单调递增的序列号（从 1 开始） */
  seq: number;
  /** 事件类型；建议使用 KnownRunEventType，但允许自定义字符串扩展 */
  type: string;
  /** ISO 8601 时间戳，由调用方传入，模块不调用 Date.now() */
  at: string;
  /** 产生此事件的 agent ID（可选） */
  agentId?: string;
  /** 事件附加数据（可选）；具体字段语义由各事件类型定义 */
  payload?: Record<string, unknown>;
}

/**
 * deriveFailureReport 返回的结构化故障报告。
 * 所有字段均从事件流派生，不手写硬编码结论。
 */
export interface FailureReport {
  /** 是否存在降级交付物（存在至少一条 deliverable_degraded 事件） */
  degraded: boolean;
  /**
   * 被 defer 的 agentId 列表（去重）。
   * 来源：agent_deferred / workspace_quota_exceeded / worker_timeout 事件中的 agentId。
   */
  deferred: string[];
  /**
   * 被拒绝的产物标识列表（按顺序，不去重）。
   * 来源：artifact_rejected 事件的 payload.artifactId 或 payload.artifactRef。
   */
  rejectedArtifacts: string[];
  /**
   * 判定为卡住的模块/agentId 列表（去重）。
   * 来源：module_stuck / workspace_quota_exceeded / worker_timeout 事件的 agentId
   * 以及 module_stuck 事件的 payload.moduleId。
   */
  stuckModules: string[];
}

// ── RunHistory 类 ─────────────────────────────────────────────────────────────

/**
 * append-only 事件历史容器。
 *
 * 用法示例：
 * ```ts
 * const hist = new RunHistory();
 * hist.appendEvent("run_started",  "2026-01-01T00:00:00Z");
 * hist.appendEvent("agent_deferred", "2026-01-01T00:01:00Z", "worker-1", { reason: "timeout" });
 * const report = hist.deriveFailureReport();
 * const jsonl  = hist.toJSONL();
 * const hist2  = RunHistory.fromJSONL(jsonl);
 * ```
 */
export class RunHistory {
  private events: RunEvent[] = [];
  private seq = 0;
  // B5:收敛事件计数器(仅本实例生命周期内有效;fromJSONL 重建不恢复——replay 场景不需要限流)。
  private converged: ConvergenceCounts = {
    model_call_started: { total: 0, recorded: 0 },
    tool_call: { total: 0, recorded: 0 },
  };

  /**
   * B5:追加一条收敛领域事件(model_call_started / tool_call)。
   * - payload 收敛为摘要级(model/provider 或 name/argsSummary),绝不写全量 payload;
   * - 每类型每 run 上限 CONVERGED_EVENT_CAP 条,超出只累计条数并返回 null;
   * - 超出的条数可经 getConvergenceCounts() / appendConvergenceOverflowSummary() 取回。
   */
  appendConvergedEvent(
    type: ConvergedRunEventType,
    at: string,
    agentId?: string,
    payload?: Record<string, unknown>,
  ): RunEvent | null {
    const c = this.converged[type];
    c.total += 1;
    if (c.recorded >= CONVERGED_EVENT_CAP) return null;
    c.recorded += 1;
    return this.appendEvent(type, at, agentId, summarizeConvergedPayload(type, payload));
  }

  /** B5:当前收敛事件计数(深拷贝快照)。 */
  getConvergenceCounts(): ConvergenceCounts {
    return {
      model_call_started: { ...this.converged.model_call_started },
      tool_call: { ...this.converged.tool_call },
    };
  }

  /**
   * B5:若任一收敛类型超出上限,追加一条 "converged_events_overflow" 汇总事件
   * (payload=各类型 total/recorded 条数),把"超出记条数"落进 history;无超出返回 null、不追加。
   */
  appendConvergenceOverflowSummary(at: string): RunEvent | null {
    const counts = this.getConvergenceCounts();
    const overflowed = (Object.keys(counts) as ConvergedRunEventType[])
      .some((t) => counts[t].total > counts[t].recorded);
    if (!overflowed) return null;
    return this.appendEvent("converged_events_overflow", at, undefined, { ...counts });
  }

  /**
   * 追加一条事件；seq 自动递增，at / agentId / payload 由调用方传入。
   * 返回已写入的事件对象（便于测试和日志）。
   */
  appendEvent(
    type: string,
    at: string,
    agentId?: string,
    payload?: Record<string, unknown>,
  ): RunEvent {
    const event: RunEvent = {
      seq: ++this.seq,
      type,
      at,
      ...(agentId !== undefined && { agentId }),
      ...(payload !== undefined && { payload }),
    };
    this.events.push(event);
    return event;
  }

  /** 返回当前事件列表的浅拷贝快照（调用方不应直接修改内部数组）。 */
  getEvents(): RunEvent[] {
    return [...this.events];
  }

  /** 当前已追加的事件数量。 */
  get length(): number {
    return this.events.length;
  }

  /**
   * 序列化为 JSONL 字符串（每行一个 JSON 事件，行尾 \n 不含）。
   * 落盘由上层决定；本方法不触碰 fs。
   */
  toJSONL(): string {
    return this.events.map(e => JSON.stringify(e)).join("\n");
  }

  /**
   * 从 JSONL 字符串反序列化，返回新的 RunHistory 实例。
   * 策略：跳过空行与无法解析的行（best-effort），保留损坏日志中的有效部分。
   * seq 以已解析事件中最大值为基准（后续追加从 max+1 开始）。
   */
  static fromJSONL(jsonl: string): RunHistory {
    const hist = new RunHistory();
    const lines = jsonl.split("\n");
    let maxSeq = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as RunEvent;
        hist.events.push(event);
        if (typeof event.seq === "number" && event.seq > maxSeq) {
          maxSeq = event.seq;
        }
      } catch {
        // best-effort：跳过损坏行，不抛出异常
      }
    }
    hist.seq = maxSeq;
    return hist;
  }

  /**
   * 从事件流派生结构化故障报告。
   *
   * 派生规则（全从事件类型 + payload 读取，不手写结论）：
   * - degraded        ← 存在任意 "deliverable_degraded" 事件
   * - deferred        ← "agent_deferred" / "workspace_quota_exceeded" / "worker_timeout"
   *                     事件的 event.agentId 或 payload.agentId（去重）
   * - rejectedArtifacts ← "artifact_rejected" 事件 payload.artifactId 或 payload.artifactRef
   * - stuckModules    ← "module_stuck" / "workspace_quota_exceeded" / "worker_timeout"
   *                     事件的 agentId 以及 "module_stuck" payload.moduleId（去重）
   *
   * @param events 可选覆盖事件源；默认使用内部已积累事件。
   */
  deriveFailureReport(events?: RunEvent[]): FailureReport {
    const src = events ?? this.events;

    let degraded = false;
    const deferredSet = new Set<string>();
    const rejectedArtifacts: string[] = [];
    const stuckSet = new Set<string>();

    for (const event of src) {
      switch (event.type) {
        case "deliverable_degraded":
          degraded = true;
          break;

        case "agent_deferred": {
          if (event.agentId) deferredSet.add(event.agentId);
          if (typeof event.payload?.agentId === "string") {
            deferredSet.add(event.payload.agentId);
          }
          break;
        }

        case "artifact_rejected": {
          const ref =
            typeof event.payload?.artifactId === "string"
              ? event.payload.artifactId
              : typeof event.payload?.artifactRef === "string"
                ? event.payload.artifactRef
                : undefined;
          if (ref !== undefined) rejectedArtifacts.push(ref);
          break;
        }

        case "workspace_quota_exceeded": {
          if (event.agentId) {
            stuckSet.add(event.agentId);
            deferredSet.add(event.agentId);
          }
          break;
        }

        case "worker_timeout": {
          if (event.agentId) {
            stuckSet.add(event.agentId);
            deferredSet.add(event.agentId);
          }
          break;
        }

        case "module_stuck": {
          if (event.agentId) stuckSet.add(event.agentId);
          if (typeof event.payload?.moduleId === "string") {
            stuckSet.add(event.payload.moduleId);
          }
          break;
        }

        default:
          // 其他事件类型不影响 failure report
          break;
      }
    }

    return {
      degraded,
      deferred: [...deferredSet],
      rejectedArtifacts,
      stuckModules: [...stuckSet],
    };
  }
}
