import { useMemo, useRef, useEffect, useState, type MouseEvent } from "react";
import type { TraceEvent, RunArtifact } from "@opc/shared";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useCockpitStore, type LocalMsg } from "../../store/useCockpitStore.js";
import { ROLE_LABELS } from "../../lib/agentMeta.js";
import { useT } from "../../i18n.js";
import * as api from "../../api/client.js";
import MessageBubble from "../common/MessageBubble.js";
import {
  DEFAULT_COMPANY, groupAgentsByTeam, mergeGroupTimeline, scopeMemberIds, readCitedMemories,
  type GroupSelection, type GroupTimelineItem, type CitedMemory,
} from "../../lib/cockpitGroups.js";
import { BookMarked } from "lucide-react";
import { RunResultCard, RunFailureCard, ReviewCard } from "./GroupCards.js";
import CopyButton from "../common/CopyButton.js";
import MemberAvatarMenu, { type MemberMenu } from "./MemberAvatarMenu.js";
import TaskContextNavigator, { taskShortLabel, type CockpitRunRow, type TaskContextPanel } from "./TaskContextNavigator.js";

// 聊天区:把"该 agent 的对话类 TraceEvent(agent_message/info/error)"与"本地消息(用户输入/CEO 直答/终端镜像)"
// 合并按时间渲染成气泡。纯只读轨迹 + 顶部输入由 CockpitPage 提供。工具/模型等底层活动在右侧监视台看。
// C3 群维度:group 非空时切换为"项目群"聚合流(群成员消息 + run 事件内联卡),1:1 私聊路径原样保留。

type Item =
  | { kind: "trace"; ts: string; e: TraceEvent }
  | { kind: "local"; ts: string; m: LocalMsg };

const CHAT_TYPES = new Set(["agent_message", "info", "error"]);
const EMPLOYEE_TASK_TYPES = new Set([
  "agent_message", "info", "error", "tool_call", "tool_result",
  "model_call_started", "model_call_finished", "agent_status_changed",
]);

// /api/runs 索引行的最小子集(群卡片需要 goal/status/degraded/companyId;与 BriefingPanel 的
// RunRow 同样本地声明,traceTypes 的 RunListItem 缺 companyId)。
interface RunRow extends CockpitRunRow { degraded?: boolean }

export default function ChatThread({ group = null }: { group?: GroupSelection | null }) {
  const tr = useT();
  const events = useAgentStore((s) => s.events);
  const agents = useAgentStore((s) => s.agents);
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const localMessages = useCockpitStore((s) => s.localMessages);
  const hydrateThread = useCockpitStore((s) => s.hydrateThread);
  const setActiveRunContext = useCockpitStore((s) => s.setActiveRunContext);
  const agent = agents.find((a) => a.id === activeAgentId);
  const endRef = useRef<HTMLDivElement | null>(null);
  // C · 群聊成员头像菜单(仅群模式启用):左键/右键任一成员头像弹出「进入配置 / 进入对话」。
  const [memberMenu, setMemberMenu] = useState<MemberMenu | null>(null);
  // 返回该 agentId 的头像激活回调;非真实成员(系统卡/未知 id/CEO 伪 id 无对应真人)返回 undefined,
  // 头像即保持纯展示不可点。左键与右键共用此回调,右键的默认菜单在此 preventDefault。
  const menuFor = (id: string | undefined) => {
    if (!id) return undefined;
    const a = agents.find((x) => x.id === id);
    if (!a) return undefined;
    return (e: MouseEvent<HTMLElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setMemberMenu({ x: e.clientX, y: e.clientY, agentId: a.id, companyId: a.companyId || DEFAULT_COMPANY });
    };
  };

  // 打开某人会话时拉取服务端持久线程注水本地(刷新/换设备都能看回历史)。按 agentId 定位:传真实
  // agent(含真实 CEO)服务端就返回其线程;hydrateThread 幂等(每 agent 一次 + 去重),不与在途消息打架。
  useEffect(() => {
    if (group || !activeAgentId) return;
    let gone = false;
    api.getChatThread({ agentId: activeAgentId })
      .then((r) => { if (!gone && Array.isArray(r.turns) && r.turns.length) hydrateThread(activeAgentId, r.turns); })
      .catch(() => { /* 拉不到线程 → 退回纯本地渲染,不阻断 */ });
    return () => { gone = true; };
  }, [activeAgentId, group, hydrateThread]);

  // 当前会话的真实任务索引。群组按公司/部门参与者过滤,员工按 participatingAgents 读取;
  // 不再只依赖最新 run 的内存事件,因此刷新后仍能回看每个历史任务。
  const teams = useMemo(() => groupAgentsByTeam(agents), [agents]);
  const [scopeRuns, setScopeRuns] = useState<RunRow[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<TraceEvent[]>([]);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  const [contextPanel, setContextPanel] = useState<TaskContextPanel>(null);
  const scopeKey = group
    ? group.kind + ":" + group.companyId + ":" + (group.kind === "team" ? group.leadId : "")
    : (activeAgentId ? "agent:" + activeAgentId : "empty");

  useEffect(() => {
    let gone = false;
    setContextPanel(null);
    setSelectedEvents([]);
    setArtifacts([]);
    if (!group && !activeAgentId) {
      setScopeRuns([]);
      setSelectedRunId(null);
      return () => { gone = true; };
    }
    let url: string;
    if (group) {
      url = "/runs?company=" + encodeURIComponent(group.companyId);
      if (group.kind === "team") {
        const team = teams.find((entry) => entry.leadId === group.leadId);
        const ids = team?.memberIds ?? [group.leadId];
        url += "&agents=" + encodeURIComponent(ids.join(","));
      }
    } else {
      url = "/agents/" + encodeURIComponent(activeAgentId as string) + "/runs?limit=50";
    }
    api.get<RunRow[]>(url)
      .then((rows) => {
        if (gone) return;
        const next = Array.isArray(rows) ? rows : [];
        setScopeRuns(next);
        setSelectedRunId((current) => {
          if (current && next.some((run) => run.id === current)) return current;
          return next.find((run) => run.status === "running")?.id ?? next[0]?.id ?? null;
        });
      })
      .catch(() => {
        if (!gone) { setScopeRuns([]); setSelectedRunId(null); }
      });
    return () => { gone = true; };
  }, [scopeKey, teams, group, activeAgentId]);

  const runsIndex = useMemo<Record<string, RunRow>>(
    () => Object.fromEntries(scopeRuns.map((run) => [run.id, run])),
    [scopeRuns],
  );
  const selectedRun = useMemo(() => scopeRuns.find((run) => run.id === selectedRunId), [scopeRuns, selectedRunId]);

  useEffect(() => {
    setActiveRunContext(selectedRun ? { runId: selectedRun.id, goal: selectedRun.goal, status: selectedRun.status } : null);
  }, [selectedRun, setActiveRunContext]);

  useEffect(() => {
    let gone = false;
    if (!selectedRunId) {
      setSelectedEvents([]);
      setArtifacts([]);
      setArtifactsLoading(false);
      return () => { gone = true; };
    }
    const eventUrl = "/runs/" + encodeURIComponent(selectedRunId) + "/events" + (!group && activeAgentId ? "?agentId=" + encodeURIComponent(activeAgentId) : "");
    api.get<{ runId: string; events: TraceEvent[] }>(eventUrl)
      .then((result) => { if (!gone) setSelectedEvents(Array.isArray(result.events) ? result.events : []); })
      .catch(() => { if (!gone) setSelectedEvents([]); });
    setArtifactsLoading(true);
    api.get<{ artifacts: RunArtifact[] }>("/runs/" + encodeURIComponent(selectedRunId) + "/artifacts")
      .then((result) => { if (!gone) setArtifacts(Array.isArray(result.artifacts) ? result.artifacts : []); })
      .catch(() => { if (!gone) setArtifacts([]); })
      .finally(() => { if (!gone) setArtifactsLoading(false); });
    return () => { gone = true; };
  }, [selectedRunId, group, activeAgentId]);

  const visibleArtifacts = useMemo(
    () => (!group && activeAgentId ? artifacts.filter((artifact) => artifact.producer === activeAgentId) : artifacts),
    [artifacts, group, activeAgentId],
  );

  const items = useMemo<Item[]>(() => {
    if (group || !activeAgentId) return [];
    const out: Item[] = [];
    if (selectedRunId) {
      for (const event of selectedEvents) {
        if (!EMPLOYEE_TASK_TYPES.has(event.type)) continue;
        const payload = event.payload as { message?: unknown } | undefined;
        if (event.type === "info" && !payload?.message) continue;
        out.push({ kind: "trace", ts: event.timestamp, e: event });
      }
      for (const message of localMessages) {
        if (message.agentId === activeAgentId && message.runId === selectedRunId) out.push({ kind: "local", ts: message.ts, m: message });
      }
    } else {
      for (const message of localMessages) {
        if (message.agentId === activeAgentId && !message.runId) out.push({ kind: "local", ts: message.ts, m: message });
      }
    }
    return out.sort((a, b) => a.ts.localeCompare(b.ts));
  }, [group, activeAgentId, selectedRunId, selectedEvents, localMessages]);

  const groupItems = useMemo<GroupTimelineItem<LocalMsg>[]>(() => {
    if (!group || !selectedRunId) return [];
    const scope = scopeMemberIds(group, agents, teams);
    const taskMessages = localMessages.filter((message) => message.runId === selectedRunId);
    return mergeGroupTimeline(selectedEvents, taskMessages, {
      scope,
      scopeCompanyId: group.companyId,
      runCompanyOf: (runId) => runsIndex[runId]?.companyId || group.companyId,
    });
  }, [group, selectedRunId, agents, teams, selectedEvents, localMessages, runsIndex]);

  const count = group ? groupItems.length : items.length;
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [count]);

  const nameOf = (id: string | undefined): string => {
    if (!id) return "?";
    const a = agents.find((x) => x.id === id);
    return a?.name ?? id;
  };
  const roleOf = (id: string | undefined): string | undefined => agents.find((x) => x.id === id)?.role;

  if (group) {
    const memberCount = group.kind === "company"
      ? agents.filter((a) => (a.companyId || DEFAULT_COMPANY) === group.companyId).length
      : scopeMemberIds(group, agents, teams).size;
    return (
      <div className="h-full flex flex-col bg-surface-0 min-w-0">
        <div className="px-4 h-10 flex items-center gap-2 border-b border-hairline shrink-0 pr-48">
          <span className="text-[13px] font-semibold text-ink truncate">{group.label}</span>
          <span className="text-[11px] text-ink-subtle truncate">{tr("cockpit.groupMembers", { n: memberCount })}</span>
        </div>
        <TaskContextNavigator runs={scopeRuns} selectedRunId={selectedRunId} onSelect={setSelectedRunId}
          panel={contextPanel} onPanelChange={setContextPanel} artifacts={visibleArtifacts} artifactsLoading={artifactsLoading}>
          <div className="h-full overflow-y-auto px-4 pr-14 py-3 flex flex-col gap-2">
            {selectedRun && (
              <div className="mb-1 rounded-lg border border-hairline bg-surface-1 px-3 py-2">
                <div className="text-[10px] text-ink-subtle">{tr("cockpit.taskContext.currentTask")} · {selectedRun.status}</div>
                <div className="mt-0.5 text-[12px] font-medium text-ink">{selectedRun.goal}</div>
              </div>
            )}
            {groupItems.length === 0
              ? <div className="text-ink-subtle text-[12px] mt-3">{selectedRunId ? tr("cockpit.taskContext.noReplay") : tr("cockpit.groupNoActivity")}</div>
              : groupItems.map((it) => <GroupItemRow key={itemKey(it)} it={it} nameOf={nameOf} roleOf={roleOf} runsIndex={runsIndex} events={selectedEvents} tr={tr} menuFor={menuFor} />)}
            <div ref={endRef} />
          </div>
        </TaskContextNavigator>
        {memberMenu && <MemberAvatarMenu menu={memberMenu} onClose={() => setMemberMenu(null)} />}
      </div>
    );
  }

  if (!activeAgentId) {
    return <div className="h-full flex items-center justify-center bg-surface-0 text-ink-subtle text-[13px]">{tr("cockpit.selectStaffToChat")}</div>;
  }

  const taskLabel = selectedRun ? taskShortLabel(selectedRun) : undefined;
  return (
    <div className="h-full flex flex-col bg-surface-0 min-w-0">
      <div className="px-4 h-10 flex items-center gap-2 border-b border-hairline shrink-0 pr-48">
        <span className="text-[13px] font-semibold text-ink truncate">{agent?.name || activeAgentId}</span>
        {agent && <span className="text-[11px] text-ink-subtle truncate">{ROLE_LABELS[agent.role] || agent.role} · {agent.provider}/{agent.model}</span>}
      </div>
      <TaskContextNavigator runs={scopeRuns} selectedRunId={selectedRunId} onSelect={setSelectedRunId}
        panel={contextPanel} onPanelChange={setContextPanel} artifacts={visibleArtifacts} artifactsLoading={artifactsLoading} allowConversation>
        <div className="h-full overflow-y-auto px-4 pr-14 py-3 flex flex-col gap-2">
          {selectedRun && (
            <div className="mb-1 rounded-lg border border-hairline bg-surface-1 px-3 py-2">
              <div className="flex items-center gap-2 text-[10px] text-ink-subtle"><span>{tr("cockpit.taskContext.currentTask")}</span><span>{selectedRun.status}</span><span>{selectedRun.id.slice(0, 8)}</span></div>
              <div className="mt-0.5 text-[12px] font-medium text-ink">{selectedRun.goal}</div>
            </div>
          )}
          {items.length === 0
            ? <div className="text-ink-subtle text-[12px] mt-3">{selectedRunId ? tr("cockpit.taskContext.noEmployeeReplay") : tr("cockpit.noActivityYet")}</div>
            : items.map((it) => it.kind === "local"
              ? <LocalBubble key={it.m.id} m={it.m} agentName={agent?.name || "agent"} agentRole={agent?.role} contextBadge={taskLabel} />
              : <TraceBubble key={it.e.id} e={it.e} name={agent?.name || "agent"} role={agent?.role} contextBadge={taskLabel} />)}
          <div ref={endRef} />
        </div>
      </TaskContextNavigator>
    </div>
  );
}

function itemKey(it: GroupTimelineItem<LocalMsg>): string {
  return it.kind === "local" ? `l-${it.m.id}` : `e-${it.kind}-${it.e.id}`;
}

// 群流单条渲染:聊天 → 既有气泡;run_finished → 成果卡/失败卡;review_committed → 审查卡;
// run_started → 居中系统行。卡片包进 MessageBubble(card 插槽)复用现有气泡外观。
function GroupItemRow({ it, nameOf, roleOf, runsIndex, events, tr, menuFor }: {
  it: GroupTimelineItem<LocalMsg>;
  nameOf: (id: string | undefined) => string;
  roleOf: (id: string | undefined) => string | undefined;
  runsIndex: Record<string, RunRow>;
  events: TraceEvent[];
  tr: (key: string, params?: Record<string, string | number>) => string;
  menuFor: (id: string | undefined) => ((e: MouseEvent<HTMLElement>) => void) | undefined;
}) {
  if (it.kind === "local") {
    const name = it.m.agentId === "ceo" ? "CEO" : nameOf(it.m.agentId);
    return <LocalBubble m={it.m} agentName={name} agentRole={it.m.agentId === "ceo" ? "ceo" : roleOf(it.m.agentId)} onAvatarActivate={menuFor(it.m.agentId)} />;
  }
  if (it.kind === "chat") {
    return <TraceBubble e={it.e} name={nameOf(it.e.agentId)} role={roleOf(it.e.agentId)} onAvatarActivate={menuFor(it.e.agentId)} />;
  }
  if (it.kind === "review") {
    return (
      <MessageBubble
        variant="agent"
        name={nameOf(it.e.agentId)}
        role={roleOf(it.e.agentId)}
        timestamp={it.e.timestamp}
        content={tr("cockpit.card.reviewTitle")}
        card={<ReviewCard e={it.e} nameOf={nameOf} />}
        onAvatarActivate={menuFor(it.e.agentId)}
      />
    );
  }
  const runId = it.e.runId;
  const row = runsIndex[runId];
  if (it.kind === "run_started") {
    return (
      <div className="text-center text-[11px] text-ink-subtle py-0.5">
        ▶ {tr("cockpit.card.runStarted")}{row?.goal ? ` · ${row.goal.slice(0, 60)}` : ""}
      </div>
    );
  }
  // run_finished:失败/降级 → 失败卡;其余 → 成果卡。真实信号来源:事件 payload(failed/allClean/
  // deferredCount)+ /runs 索引终态(status/degraded)。
  const p = (it.e.payload ?? {}) as { failed?: boolean; allClean?: boolean; deferredCount?: number };
  const isFailed = p.failed === true || row?.status === "failed";
  const isDegraded = row?.degraded === true;
  const card = (isFailed || isDegraded)
    ? <RunFailureCard runId={runId} goal={row?.goal} degraded={!isFailed && isDegraded} />
    : <RunResultCard runId={runId} goal={row?.goal} deferredCount={p.deferredCount} runEvents={events.filter((e) => e.runId === runId)} />;
  return (
    <MessageBubble
      variant="system"
      name={tr("cockpit.groupFeed.system")}
      timestamp={it.e.timestamp}
      content={row?.goal || runId}
      card={card}
    />
  );
}

// 阶段 2 · 消息可读化:长输出统一走 MessageBubble(头像+折叠+markdown 渲染),普通用户不再面对原始长文。
// 用户消息保留右对齐紫气泡(简短,无需折叠);system/info 保留居中细字(低权重信息)。
function LocalBubble({ m, agentName, agentRole, onAvatarActivate, contextBadge }: { m: LocalMsg; agentName: string; agentRole?: string; onAvatarActivate?: (e: MouseEvent<HTMLElement>) => void; contextBadge?: string }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="group relative max-w-[78%] rounded-lg px-3 py-2 bg-accent/10 text-accent text-[13px] whitespace-pre-wrap break-words">
          {m.source === "terminal" && <span className="opacity-70 mr-1">⌨</span>}{m.text}
          <CopyButton text={m.text} className="absolute bottom-1 right-1 text-accent/70 hover:text-accent bg-black/5 hover:bg-black/10" />
        </div>
      </div>
    );
  }
  if (m.role === "assistant") {
    return <MessageBubble variant="agent" name={agentName} role={agentRole} content={m.text} timestamp={m.ts} onAvatarActivate={onAvatarActivate} contextBadge={contextBadge} />;
  }
  return <div className="text-center text-[11px] text-ink-subtle py-0.5">{m.text}</div>;
}

// CEO 记忆引用溯源:项目群消息卡的引用条。渲染服务端 memory_pack_used 事件 payload.citedMemories
// (注入即引用),每条可点击 → 跳到经验(记忆)页复用既有详情承载(opc-navigate 跨页契约,同 App.tsx)。
function openMemoryPage() {
  window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page: "memory" } }));
}

function CitedMemoriesBar({ cited }: { cited: CitedMemory[] }) {
  const tr = useT();
  if (!cited.length) return null;
  return (
    <div className="flex items-center justify-center gap-1 flex-wrap py-0.5">
      <span className="inline-flex items-center gap-1 text-[11px] text-ink-subtle">
        <BookMarked size={11} />{tr("cockpit.citedMemories.label")}
      </span>
      {cited.map((c) => (
        <button
          key={c.id}
          onClick={openMemoryPage}
          title={tr("cockpit.citedMemories.viewHint")}
          className="max-w-[220px] truncate text-[11px] text-accent bg-accent/10 rounded-full px-2 py-0.5 border-none cursor-pointer hover:bg-accent/20 transition-colors"
        >
          《{c.title}》
        </button>
      ))}
    </div>
  );
}

function TaskActivityRow({ text, tone }: { text: string; tone: "work" | "success" | "error" }) {
  const color = tone === "error" ? "text-red" : tone === "success" ? "text-green" : "text-ink-subtle";
  return <div className={"mx-auto max-w-[88%] rounded-full bg-surface-1 px-3 py-1 text-[10px] " + color}>{text}</div>;
}

function TraceBubble({ e, name, role, onAvatarActivate, contextBadge }: { e: TraceEvent; name: string; role?: string; onAvatarActivate?: (ev: MouseEvent<HTMLElement>) => void; contextBadge?: string }) {
  const p = e.payload as any;
  if (e.type === "agent_message") {
    const from = p?.from && p.from !== e.agentId ? String(p.from) : name;
    return <MessageBubble variant="agent" name={from} role={role} content={String(p?.text ?? "")} timestamp={e.timestamp} onAvatarActivate={onAvatarActivate} contextBadge={contextBadge} />;
  }
  if (e.type === "error") {
    return <div className="text-center text-[11px] py-0.5 text-red">⚠ {String(p?.message ?? "error")}</div>;
  }
  if (e.type === "tool_call") {
    return <TaskActivityRow tone="work" text={"调用工具 " + String(p?.name ?? "tool") + (p?.args ? ": " + JSON.stringify(p.args).slice(0, 180) : "")} />;
  }
  if (e.type === "tool_result") {
    const failed = p?.ok === false || p?.error;
    return <TaskActivityRow tone={failed ? "error" : "success"} text={String(p?.name ?? "tool") + (failed ? " 执行失败" : " 执行完成")} />;
  }
  if (e.type === "model_call_started") {
    return <TaskActivityRow tone="work" text={"调用模型 " + String(p?.provider ?? "") + "/" + String(p?.model ?? "")} />;
  }
  if (e.type === "model_call_finished") {
    const tokens = Number(p?.totalTokens ?? p?.tokens ?? 0);
    return <TaskActivityRow tone="success" text={"模型调用完成" + (tokens > 0 ? " · " + tokens.toLocaleString() + " tokens" : "")} />;
  }
  if (e.type === "agent_status_changed") {
    const status = String(p?.status ?? "");
    const task = p?.currentTask ? " · " + String(p.currentTask).slice(0, 100) : "";
    return <TaskActivityRow tone={status === "failed" ? "error" : "work"} text={"状态: " + status + task} />;
  }
  // info with message。带 citedMemories(memory_pack_used)时:正文只显示首行摘要,追加的
  // "依据经验:…" 纯文本兜底行不重复渲染,改用结构化可点击引用条。
  const cited = readCitedMemories(p);
  const message = String(p?.message ?? "");
  const summary = cited.length ? message.split("\n")[0] : message;
  return (
    <div>
      <div className="text-center text-[11px] text-ink-subtle py-0.5">{summary}</div>
      {cited.length > 0 && <CitedMemoriesBar cited={cited} />}
    </div>
  );
}
