import type { TraceEvent } from "@opc/shared";
import { cleanText } from "./text.js";

const MAX_LEN = 40;

function truncate(s: string, max = MAX_LEN): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + "…" : clean;
}

// Rule-based (no LLM) "what is this agent doing right now" one-liner for the org canvas' worker
// bubble. Priority: a fresh tool_call for this agent (a specific, nameable action) > the tail of its
// raw streaming output (agent_output_chunk text — NOT stored in `events`, see useAgentStore.addEvent;
// callers pass the accumulated outputChunks[agentId] buffer separately) > null (caller falls back to
// a generic "thinking" label). Stops scanning at the nearest model_call_started/agent_status_changed
// for this agent so a stale tool_call from a *previous* task never bleeds into the current one.
export function deriveActivityLabel(
  agentId: string,
  events: TraceEvent[],
  outputChunkTail: string | undefined,
  toolLabel: (name: string) => string,
): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.agentId !== agentId) continue;
    if (e.type === "tool_call") {
      const name = (e.payload as { name?: string } | undefined)?.name;
      if (name) return truncate(toolLabel(name));
      break;
    }
    if (e.type === "model_call_started" || e.type === "agent_status_changed") break;
  }
  const tail = cleanText(outputChunkTail).trim();
  if (tail) {
    // 深度体验 QA 抓出:CLI 引擎的流式输出常是 JSON 行({"type":"user","message":…}),直接当
    // "正在做什么"泄漏给用户完全不可读——跳过 JSON/代码痕迹行,取最后一行像人话的。
    const lines = tail.split(/\n+/).map(l => l.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (/^[{\["`]|^\}|^\]|"type"\s*:|"role"\s*:|^data:/.test(l)) continue;
      return truncate(l);
    }
  }
  return null;
}
