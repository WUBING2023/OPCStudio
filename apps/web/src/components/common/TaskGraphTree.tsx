import { useCallback, useEffect, useRef, useState } from "react";
import { GitBranch, Package, RotateCcw } from "lucide-react";
import type { TaskGraph, TaskNode, TaskNodeStatus } from "@opc/shared";
import * as api from "../../api/client.js";
import { useAgentStore } from "../../store/useAgentStore.js";

// B6 · 任务拆解树(真实数据,替代「等待任务图上线」占位卡):消费 GET /api/missions/:id/task-graph
// (missionRoutes A2 读 API,一个 mission 多次提案返回最新一份)+ 实时事件流的 task_node_started/
// task_node_finished 增量刷新(节点级事件只带 nodeId/status 摘要,resultSummary/revisionCount 等
// 全量真相在持久图里 → 收到事件就重拉整图,不在前端拼半份状态)。
// 404 / 该 mission 未走图路径 / 取数失败 → 整卡不渲染(绝不渲染空态假装有数据)。
type Tr = (key: string, params?: Record<string, string | number>) => string;

const NODE_STATUS_COLOR: Record<TaskNodeStatus, string> = {
  pending: "var(--color-ink-subtle)",
  planned: "var(--color-ink-subtle)",
  running: "var(--color-info)",
  blocked: "var(--color-warning)",
  waiting_review: "var(--color-info)",
  needs_revision: "var(--color-warning)",
  completed: "var(--color-success)",
  accepted: "var(--color-success)",
  failed: "var(--color-error)",
  cancelled: "var(--color-ink-subtle)",
};

const GRAPH_STATUS_COLOR: Record<TaskGraph["status"], string> = {
  proposed: "var(--color-ink-subtle)",
  committed: "var(--color-ink-subtle)",
  running: "var(--color-info)",
  completed: "var(--color-success)",
  failed: "var(--color-error)",
  cancelled: "var(--color-ink-subtle)",
};

// 徽章淡底色:token 现在是 var(...) 字符串,不能再拼旧写法的 16 进制透明度后缀(如 + "22"),
// 改用 color-mix 在该 token 上混透明得到淡底,视觉效果与旧写法等价。
function tint(color: string): string {
  return `color-mix(in srgb, ${color} 16%, transparent)`;
}

export function useMissionTaskGraph(missionId: string): TaskGraph | null {
  // undefined=加载中,null=无图(404/取数失败)——两者对外都表现为"不渲染",内部区分只为不闪烁。
  const [graph, setGraph] = useState<TaskGraph | null | undefined>(undefined);
  const events = useAgentStore(s => s.events);
  const seen = useRef(0);
  const refresh = useCallback(() => {
    api.getMissionTaskGraph(missionId).then(setGraph).catch(() => setGraph(null));
  }, [missionId]);
  useEffect(() => { setGraph(undefined); refresh(); }, [refresh]);
  useEffect(() => {
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    const relevant = fresh.some(e => {
      if (e.type === "run_finished") return true; // 图收敛(completed/failed)发生在节点事件之后,run 结束兜底重拉
      if (e.type !== "task_node_started" && e.type !== "task_node_finished") return false;
      const p = e.payload as { missionId?: unknown } | null | undefined;
      return p?.missionId === missionId;
    });
    if (relevant) refresh();
  }, [events, refresh, missionId]);
  return graph ?? null;
}

function NodeRow({ node, byId, tr }: { node: TaskNode; byId: Map<string, TaskNode>; tr: Tr }) {
  const color = NODE_STATUS_COLOR[node.status] ?? "var(--color-ink-subtle)";
  const depTitles = node.dependsOn.map(d => byId.get(d)?.title ?? d);
  return (
    <div className="flex flex-col gap-0.5 border-t border-hairline pt-1.5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-[11px] text-ink truncate" title={node.goal}>{node.title}</span>
        {(node.revisionCount ?? 0) > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] shrink-0 text-amber" title={node.revisionFeedback}>
            <RotateCcw size={9} />{tr("taskGraph.node.retries", { n: node.revisionCount! })}
          </span>
        )}
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ background: tint(color), color }}>
          {tr(`taskGraph.node.status.${node.status}`)}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-3 flex-wrap">
        {(node.assignedRole || node.assignedAgentId) && (
          <span className="text-[10px] text-ink-subtle truncate max-w-[45%]">{node.assignedRole || node.assignedAgentId}</span>
        )}
        {depTitles.length > 0 && (
          <span className="text-[10px] text-ink-subtle truncate" title={depTitles.join(", ")}>
            {tr("taskGraph.node.dependsOn", { list: depTitles.join(", ") })}
          </span>
        )}
        {node.expectedArtifacts.length > 0 && (
          <span className="flex items-center gap-0.5 text-[10px] text-ink-subtle truncate" title={node.expectedArtifacts.join(", ")}>
            <Package size={9} className="shrink-0" />{node.expectedArtifacts.join(", ")}
          </span>
        )}
        {node.runId && (
          <button
            onClick={() => window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId: node.runId } }))}
            className="text-[10px] text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 shrink-0"
          >
            {tr("taskGraph.node.viewRun")}
          </button>
        )}
      </div>
      {node.status === "failed" && node.error && (
        <div className="pl-3 text-[10px] leading-snug line-clamp-2 text-red">{node.error}</div>
      )}
      {node.resultSummary && node.status !== "failed" && (
        <div className="pl-3 text-[10px] text-ink-muted leading-snug line-clamp-2">{node.resultSummary}</div>
      )}
    </div>
  );
}

export default function TaskGraphTree({ missionId, tr, showWhenEmpty }: { missionId: string; tr: Tr; showWhenEmpty?: boolean }) {
  const graph = useMissionTaskGraph(missionId);
  // showWhenEmpty(令五.4 · 任务档案详情页):run 有 missionId 但任务图尚未生成/该任务未拆解时,显示诚实
  // 占位而不是整块消失,避免"入口在、点开却空白"的黑箱感。默认(CEO 作战室)仍是下方"无图整卡不渲染"。
  if (showWhenEmpty && (!graph || graph.nodes.length === 0)) {
    return (
      <div className="rounded-lg border border-hairline bg-surface-1 p-2.5 flex items-center gap-1.5">
        <GitBranch size={11} className="text-ink-subtle shrink-0" />
        <span className="text-[11px] text-ink-subtle">{tr("taskGraph.empty")}</span>
      </div>
    );
  }
  if (!graph || graph.nodes.length === 0) return null;
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const gColor = GRAPH_STATUS_COLOR[graph.status] ?? "var(--color-ink-subtle)";
  return (
    <div className="rounded-lg border border-hairline bg-surface-1 p-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <GitBranch size={11} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-ink-subtle">{tr("org.ceo.tree.title")}</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ background: tint(gColor), color: gColor }}>
          {tr(`taskGraph.status.${graph.status}`)}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {graph.nodes.map(n => <NodeRow key={n.id} node={n} byId={byId} tr={tr} />)}
      </div>
    </div>
  );
}
