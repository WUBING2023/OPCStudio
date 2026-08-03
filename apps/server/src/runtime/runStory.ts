import type { TraceEvent } from "@opc/shared";
import { loadRunEventsRaw } from "../storage/projectStore.js";

// Stage 2 · Trace Summary v1:把一次 run 的事件流翻成「人话 run story」——
// 只保留里程碑事件(开工/退回/降级/延后/记忆/收尾),滤掉低层噪声(model_call/info),
// 让用户看懂「每个 agent 做了什么、发生过什么」。纯派生,NEVER throws。

export interface RunStoryLine {
  at: string;
  type: string;
  agentId?: string;
  line: string;
}
export interface RunStory {
  runId: string;
  lines: RunStoryLine[];
}

const ROLE_ZH: Record<string, string> = {
  ceo: "CEO", lead: "主管", dev: "工程师", test: "测试", research: "研究员",
  writer: "撰稿", analyst: "分析师", reviewer: "审查",
};
function who(agentId: string | undefined): string {
  if (!agentId) return "团队";
  const role = agentId.includes("-") ? agentId.split("-").pop()! : agentId;
  return ROLE_ZH[role] ?? agentId;
}
function trunc(s: unknown, n = 80): string {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? t.slice(0, n) + "…" : t;
}
function reasonZh(r: unknown): string {
  const m: Record<string, string> = { timeout: "超时", restricted: "权限受限", error: "执行出错", stuck: "卡住" };
  return (typeof r === "string" && m[r]) || (typeof r === "string" ? r : "未知原因");
}

// 单个事件 → 一行人话(返回 null = 跳过该事件)。
function lineFor(ev: TraceEvent): string | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "run_started": return `🎯 接到目标:「${trunc(p.goal, 100)}」`;
    case "agent_status_changed": return p.status === "working" ? `👤 ${who(ev.agentId)}开始工作` : null;
    case "artifact_rejected": return `↩️ ${who(ev.agentId)}的产物被退回:${trunc(p.reason, 80) || "未通过产物契约"}`;
    case "memory_committed": return `🧠 沉淀了一条记忆(${p.scope ?? "?"}/${p.type ?? "?"})`;
    case "deliverable_degraded": return `⚠️ 交付降级:${trunc(p.reason, 80) || "协调者过载/合成失败"}`;
    case "agent_deferred": return `⏸️ ${who(ev.agentId)}的任务延后(${reasonZh(p.reason)})`;
    case "worker_timeout": return `⏱️ ${who(ev.agentId)}的任务超时延后`;
    case "module_stuck": return `🔁 ${who(ev.agentId)}卡住,已跳过`;
    case "run_finished": return `✅ 运行结束`;
    case "error": return p.degraded ? null : `❗ ${trunc(p.message, 80) || "出错"}`;
    default: return null;
  }
}

export function deriveRunStory(projectRoot: string, runId: string): RunStory {
  const lines: RunStoryLine[] = [];
  try {
    const rawFile = loadRunEventsRaw(projectRoot, runId);
    if (rawFile === null) return { runId, lines };
    const seenWorking = new Set<string>(); // 每个 agent 只报一次"开始工作"
    for (const raw of rawFile.split("\n")) {
      if (!raw.trim()) continue;
      let ev: TraceEvent;
      try { ev = JSON.parse(raw) as TraceEvent; } catch { continue; }
      if (ev.type === "agent_status_changed" && (ev.payload as any)?.status === "working") {
        const key = ev.agentId ?? "?";
        if (seenWorking.has(key)) continue;
        seenWorking.add(key);
      }
      const line = lineFor(ev);
      if (!line) continue;
      // 折叠连续完全相同的行
      if (lines.length && lines[lines.length - 1].line === line) continue;
      lines.push({ at: (ev as any).timestamp ?? "", type: ev.type, agentId: ev.agentId, line });
    }
  } catch { /* best-effort → 已收集的 lines */ }
  return { runId, lines };
}
