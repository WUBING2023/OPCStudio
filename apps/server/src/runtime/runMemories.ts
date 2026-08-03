import type { TraceEvent } from "@opc/shared";
import { listAllCommittedMemories } from "./committedMemoryRetriever.js";
import { listMemory } from "../storage/memoryStore.js";
import { loadRunEventsRaw } from "../storage/projectStore.js";

// Stage 4 · "本次 run 用了哪些记忆":纯派生(同 deriveRunStory/collectRunArtifacts 模式)。
// 扫 events.jsonl 的 memory_injected(新)或 info+injectedMemory(旧,向后兼容),把每个注入的
// memoryId 解析为带内容/类型/来源的条目(查 committed 记忆 + 4 层 memoryStore)。NEVER throws。

export interface ResolvedMemory {
  id: string;
  source: "committed" | "memoryStore" | "unknown";
  content?: string;
  type?: string;
  scope?: string;
  confidence?: number;
  role?: string;
}
export interface AgentMemoryInjection {
  agentId?: string;
  timestamp?: string;
  memoryIds: string[];
  resolved: ResolvedMemory[];
}
export interface RunMemoryUsage {
  runId: string;
  injections: AgentMemoryInjection[];
}

export function deriveRunMemories(projectRoot: string, runId: string): RunMemoryUsage {
  const injections: AgentMemoryInjection[] = [];
  try {
    const rawFile = loadRunEventsRaw(projectRoot, runId);
    if (rawFile === null) return { runId, injections };

    // 解析查找表(一次构建)。committed:跨 run 真记忆;memoryStore:4 层经验记忆。
    // 注:此处不做 role 过滤——本函数只解析"本 run 实际注入过的 memoryId"(下方 ids 来自事件),
    // 而注入时已在 retrieveCommittedMemories 按 agent.role 隔离,故输出只含该 agent 有权看到的记忆,非泄露。
    const committedMap = new Map<string, ResolvedMemory>();
    try {
      for (const m of listAllCommittedMemories(projectRoot)) {
        committedMap.set(m.memoryId, { id: m.memoryId, source: "committed", content: m.content, type: m.type, scope: m.scope, confidence: m.confidence, role: m.role });
      }
    } catch { /* best-effort */ }
    const memMap = new Map<string, ResolvedMemory>();
    try {
      for (const e of listMemory(projectRoot)) {
        memMap.set(e.id, { id: e.id, source: "memoryStore", content: e.text, type: "project", role: e.agentRole });
      }
    } catch { /* best-effort */ }
    const resolve = (id: string): ResolvedMemory => committedMap.get(id) ?? memMap.get(id) ?? { id, source: "unknown" };

    const lines = rawFile.split("\n").filter(Boolean);
    const events: TraceEvent[] = [];
    for (const l of lines) { try { events.push(JSON.parse(l) as TraceEvent); } catch { /* skip */ } }

    // 优先用专门的 memory_injected 事件;若该 run 无(旧 run),回退到 info + payload.injectedMemory。
    // 互斥门(非 per-event)是刻意的:本版 orchestrator 对每次注入**同时**发 info 和 memory_injected
    // (双发,向后兼容);若 per-event 两类都收会重复计数。单二进制本地工具不存在新旧 agent 混跑。
    const hasNew = events.some(e => e.type === "memory_injected");
    for (const ev of events) {
      let ids: string[] | undefined;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (hasNew) {
        if (ev.type === "memory_injected" && Array.isArray(p.memoryIds)) ids = p.memoryIds as string[];
      } else if (ev.type === "info" && Array.isArray(p.injectedMemory)) {
        ids = p.injectedMemory as string[];
      }
      if (!ids || ids.length === 0) continue;
      injections.push({
        agentId: ev.agentId,
        timestamp: (ev as any).timestamp,
        memoryIds: ids,
        resolved: ids.map(resolve),
      });
    }
  } catch { /* best-effort → 已收集的 injections */ }
  return { runId, injections };
}
