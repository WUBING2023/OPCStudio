import { useCallback, useEffect, useMemo, useState } from "react";
import { Wrench, Repeat, Clock, ChevronDown, ChevronUp, X, Play, Edit3, Square, Send, ListChecks, History } from "lucide-react";
import type { AgentNodeConfig } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { pushToast } from "../common/Toast.js";
import { DEFAULT_COMPANY, type GoalRecord, type GoalRound, type LoopRecord, type LoopRound, type QueuedAutomation } from "./automationTypes.js";

// 简报栏内、一眼条下方的"进行中自动化"卡片——目标模式(goal)与连续模式(loop)各自最多同时一条
// (服务端单实例约束),有活动的才渲染;两者都没有 → 整块不占位(BriefingPanel 决定挂载哪，这里
// 只负责"有没有东西可画")。GET /api/goals + /api/loops 轮询 15s，仅面板可见(标签页不隐藏)时跑。
//
// 目标卡:跑完即收起(status 不是 running 就不再是"活动目标"，历史结果留给任务档案)。
// 连续卡:多一档"粘滞"——用户可能正盯着它看它自然跑完/触顶，这时不该突然消失，所以结束态
// (stopped/exhausted/failed)会继续显示 stopReason，直到用户手动关掉或换公司/换了新的活动连续任务。

interface RoundLike { round: number; runId: string; error?: string; achieved?: boolean; }

function RoundChip({ n, round, isCurrent, tooltip, onOpen }: {
  n: number; round?: RoundLike; isCurrent: boolean; tooltip?: string; onOpen: (runId: string) => void;
}) {
  if (round) {
    const color = round.error ? "var(--color-error)" : round.achieved ? "var(--color-success)" : "var(--color-info)";
    return (
      <button
        onClick={() => round.runId && onOpen(round.runId)}
        disabled={!round.runId}
        title={tooltip || undefined}
        className="w-5 h-5 rounded-full text-[10px] font-semibold text-white border-none flex items-center justify-center shrink-0 disabled:cursor-default cursor-pointer transition-opacity hover:opacity-80"
        style={{ background: color }}
      >
        {n}
      </button>
    );
  }
  if (isCurrent) {
    return <span className="w-5 h-5 rounded-full border-2 shrink-0 animate-pulse" style={{ borderColor: "var(--color-accent)" }} />;
  }
  return <span className="w-5 h-5 rounded-full border border-hairline shrink-0" />;
}

function RoundTracker({ max, rounds, running, onOpen, tooltipFor }: {
  max: number; rounds: RoundLike[]; running: boolean; onOpen: (runId: string) => void;
  tooltipFor: (round: RoundLike) => string | undefined;
}) {
  const next = rounds.length + 1;
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {Array.from({ length: max }, (_, i) => i + 1).map(n => {
        const r = rounds.find(x => x.round === n);
        return (
          <RoundChip key={n} n={n} round={r} isCurrent={running && n === next && n <= max}
            tooltip={r ? tooltipFor(r) : undefined} onOpen={onOpen} />
        );
      })}
    </div>
  );
}

type Tr = (key: string, params?: Record<string, string | number>) => string;

// ── 反馈回路①·每轮确认门(harness/loop 共用契约)───────────────────────────────────
// status==="waiting_user" 时渲染:本轮判定文案(由调用方按 goal/loop 各自的字段拼好传入)+
// ▶ 继续 / ✍ 带反馈继续(展开小输入框) / ■ 停止。kind 决定打 /goals 还是 /loops。
function WaitingUserGate({ kind, id, judgment, onAction, tr }: {
  kind: "goal" | "loop"; id: string; judgment: string | undefined; onAction: () => void; tr: Tr;
}) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");
  const [busy, setBusy] = useState(false);

  const doContinue = useCallback(async (feedback?: string) => {
    setBusy(true);
    try { await api.continueAutomation(kind, id, feedback); } catch { /* best-effort:下一轮起不来会在轮询里体现 */ }
    setBusy(false);
    setFeedbackOpen(false);
    setFeedbackText("");
    onAction();
  }, [kind, id, onAction]);

  const doStop = useCallback(async () => {
    setBusy(true);
    try { await api.post(`/${kind}s/${id}/stop`, {}); } catch { /* best-effort */ }
    setBusy(false);
    onAction();
  }, [kind, id, onAction]);

  return (
    <div className="rounded-md border border-amber bg-amber/10 p-2 flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-amber">{tr("org.brief.automation.waitingUser")}</span>
      {judgment && <div className="text-[12px] text-ink leading-snug">{judgment}</div>}
      {feedbackOpen ? (
        <div className="flex items-center gap-1">
          <input
            autoFocus
            value={feedbackText}
            onChange={e => setFeedbackText(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); void doContinue(feedbackText.trim() || undefined); }
              if (e.key === "Escape") setFeedbackOpen(false);
            }}
            placeholder={tr("org.brief.automation.feedbackPlaceholder")}
            className="flex-1 min-w-0 rounded-md bg-surface-0 border border-hairline px-2 py-1 text-[11px] text-ink outline-none focus:border-accent placeholder:text-ink-subtle"
          />
          <button disabled={busy} onClick={() => void doContinue(feedbackText.trim() || undefined)} title={tr("org.brief.send")}
            className="w-6 h-6 rounded-md flex items-center justify-center text-accent hover:opacity-80 bg-transparent border-none cursor-pointer disabled:opacity-40 shrink-0">
            <Send size={11} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button disabled={busy} onClick={() => void doContinue()}
            className="flex items-center gap-1 text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 disabled:opacity-40 text-green">
            <Play size={11} />{tr("org.brief.automation.gate.continue")}
          </button>
          <button disabled={busy} onClick={() => setFeedbackOpen(true)}
            className="flex items-center gap-1 text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 text-accent disabled:opacity-40">
            <Edit3 size={11} />{tr("org.brief.automation.gate.continueWithFeedback")}
          </button>
          <button disabled={busy} onClick={() => void doStop()}
            className="flex items-center gap-1 text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 disabled:opacity-40 text-red">
            <Square size={11} />{tr("org.brief.automation.stopButton")}
          </button>
        </div>
      )}
    </div>
  );
}

// ── 反馈回路②·方向盘(仅 running 时常驻)───────────────────────────────────────────
// 不打断当前轮,异步捎话给下一轮(POST .../feedback)。pendingFeedback 非空 = 已捎话但下一轮还没取用。
function SteeringBar({ kind, id, pendingFeedback, onSent, tr }: {
  kind: "goal" | "loop"; id: string; pendingFeedback: string | undefined; onSent: () => void; tr: Tr;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  const submit = useCallback(async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      await api.sendAutomationFeedback(kind, id, t);
      setText("");
      pushToast("info", tr("org.brief.automation.feedbackSent"));
      onSent();
    } catch (e: any) {
      pushToast("info", tr("org.brief.automation.error", { message: e?.message ?? String(e) }));
    } finally {
      setSending(false);
    }
  }, [text, sending, kind, id, onSent, tr]);

  return (
    <div className="flex flex-col gap-1">
      {pendingFeedback && (
        <div className="text-[11px] text-ink-subtle line-clamp-1">{tr("org.brief.automation.pendingFeedback", { text: pendingFeedback })}</div>
      )}
      <div className="flex items-center gap-1">
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void submit(); } }}
          disabled={sending}
          placeholder={tr("org.brief.automation.steerPlaceholder")}
          className="flex-1 min-w-0 rounded-md bg-surface-0 border border-hairline px-2 py-1 text-[11px] text-ink outline-none focus:border-accent placeholder:text-ink-subtle disabled:opacity-60"
        />
        <button onClick={() => void submit()} disabled={sending || !text.trim()} title={tr("org.brief.send")}
          className="w-6 h-6 rounded-md flex items-center justify-center text-ink-muted hover:text-accent bg-transparent border-none cursor-pointer disabled:opacity-40 shrink-0">
          <Send size={11} />
        </button>
      </div>
    </div>
  );
}

// ── 每轮判定对照(可折叠,Harness/Loop 共用)────────────────────────────────────────
function RoundHistory({ rounds, tr }: { rounds: { round: number; text: string }[]; tr: Tr }) {
  const [open, setOpen] = useState(false);
  if (rounds.length === 0) return null;
  return (
    <div className="rounded-md border border-hairline bg-surface-0 overflow-hidden">
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2 py-1 bg-transparent border-none cursor-pointer text-left">
        {open ? <ChevronUp size={11} className="text-ink-subtle shrink-0" /> : <ChevronDown size={11} className="text-ink-subtle shrink-0" />}
        <History size={11} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.automation.roundDetail.title")}</span>
      </button>
      {open && (
        <ul className="px-2 pb-1.5 flex flex-col gap-1 list-none m-0">
          {rounds.map(r => (
            <li key={r.round} className="text-[11px] text-ink-muted leading-snug flex gap-1.5">
              <span className="shrink-0 font-medium text-ink-subtle">#{r.round}</span>
              <span className="line-clamp-2">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function goalRoundText(r: GoalRound, tr: Tr): string {
  if (r.error) return tr("org.brief.automation.judgment.error", { text: r.error });
  const parts: string[] = [];
  if (r.doneSummary) parts.push(tr("org.brief.automation.judgment.done", { text: r.doneSummary }));
  if (r.gap) parts.push(tr("org.brief.automation.judgment.gap", { text: r.gap }));
  return parts.join(" · ") || tr("org.brief.automation.judgment.done", { text: "" });
}

function loopRoundText(r: LoopRound, tr: Tr): string {
  if (r.error) return tr("org.brief.automation.judgment.error", { text: r.error });
  const parts: string[] = [];
  if (r.note) parts.push(tr("org.brief.automation.judgment.note", { text: r.note }));
  if (r.next) parts.push(tr("org.brief.automation.judgment.next", { text: r.next }));
  return parts.join(" · ") || tr("org.brief.automation.judgment.note", { text: "" });
}

// 验收标准列表(可折叠)——Harness 卡片专属,goal.acceptanceCriteria 非空才渲染(见调用处)。
function CriteriaList({ criteria, tr }: { criteria: string[]; tr: Tr }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-1.5 px-2 py-1 bg-transparent border-none cursor-pointer text-left">
        {open ? <ChevronUp size={11} className="text-ink-subtle shrink-0" /> : <ChevronDown size={11} className="text-ink-subtle shrink-0" />}
        <ListChecks size={11} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.automation.harness.criteriaTitle", { n: criteria.length })}</span>
      </button>
      {open && (
        <ul className="px-2 pb-1.5 flex flex-col gap-0.5 list-none m-0">
          {criteria.map((c, i) => (
            <li key={i} className="text-[11px] text-ink-muted leading-snug">· {c}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function HarnessCard({ goal, onStop, onOpen, onGateAction, tr }: {
  goal: GoalRecord; onStop: () => void; onOpen: (runId: string) => void; onGateAction: () => void; tr: Tr;
}) {
  const waiting = goal.status === "waiting_user";
  const currentRound = Math.min(goal.rounds.length + 1, goal.maxRounds);
  const lastRound = goal.rounds[goal.rounds.length - 1];
  const judgment = lastRound ? goalRoundText(lastRound, tr) : undefined;
  const criteria = goal.acceptanceCriteria ?? [];
  return (
    <div
      className={`rounded-lg border p-2.5 flex flex-col gap-1.5 bg-surface-1 ${waiting ? "border-amber" : "border-hairline"}`}
    >
      <div className="flex items-center gap-1.5">
        <Wrench size={12} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.automation.goalTitle")}</span>
        <span className="text-[11px] text-ink-subtle ml-auto tabular-nums">{tr("org.brief.automation.roundProgress", { n: currentRound, m: goal.maxRounds })}</span>
      </div>
      <div className="text-[12px] text-ink leading-snug line-clamp-2">{goal.goal}</div>
      <RoundTracker max={goal.maxRounds} rounds={goal.rounds} running={!waiting} onOpen={onOpen}
        tooltipFor={r => (r as GoalRound).doneSummary || (r as GoalRound).gap || r.error} />
      {criteria.length > 0 && (
        <div className="rounded-md border border-hairline bg-surface-0 overflow-hidden">
          <CriteriaList criteria={criteria} tr={tr} />
        </div>
      )}
      <RoundHistory rounds={goal.rounds.map(r => ({ round: r.round, text: goalRoundText(r, tr) }))} tr={tr} />
      {waiting ? (
        <WaitingUserGate kind="goal" id={goal.id} judgment={judgment} onAction={onGateAction} tr={tr} />
      ) : (
        <>
          <SteeringBar kind="goal" id={goal.id} pendingFeedback={goal.pendingFeedback} onSent={onGateAction} tr={tr} />
          <button onClick={onStop}
            className="self-start text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity text-red">
            {tr("org.brief.automation.stopButton")}
          </button>
        </>
      )}
    </div>
  );
}

function LoopCard({ loop, onStop, onOpen, onDismiss, onGateAction, tr }: {
  loop: LoopRecord; onStop: () => void; onOpen: (runId: string) => void; onDismiss: () => void; onGateAction: () => void; tr: Tr;
}) {
  const waiting = loop.status === "waiting_user";
  const active = loop.status === "running" || waiting; // 未触顶/未停止/未失败——仍在推进(含暂停等确认)
  const currentRound = active ? Math.min(loop.rounds.length + 1, loop.maxRuns) : loop.rounds.length;
  const lastRound = loop.rounds[loop.rounds.length - 1];
  const judgment = lastRound ? loopRoundText(lastRound, tr) : undefined;
  return (
    <div
      className={`rounded-lg border p-2.5 flex flex-col gap-1.5 bg-surface-1 ${waiting ? "border-amber" : "border-hairline"}`}
    >
      <div className="flex items-center gap-1.5">
        <Repeat size={12} className="text-accent shrink-0" />
        <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.automation.loopTitle")}</span>
        <span className="text-[11px] text-ink-subtle ml-auto tabular-nums">{tr("org.brief.automation.roundProgress", { n: currentRound, m: loop.maxRuns })}</span>
      </div>
      <div className="text-[12px] text-ink leading-snug line-clamp-2">{loop.prompt}</div>
      <RoundTracker max={loop.maxRuns} rounds={loop.rounds} running={active && !waiting} onOpen={onOpen}
        tooltipFor={r => (r as LoopRound).note || (r as LoopRound).next || r.error} />
      <RoundHistory rounds={loop.rounds.map(r => ({ round: r.round, text: loopRoundText(r, tr) }))} tr={tr} />
      {waiting ? (
        <WaitingUserGate kind="loop" id={loop.id} judgment={judgment} onAction={onGateAction} tr={tr} />
      ) : active ? (
        <>
          <SteeringBar kind="loop" id={loop.id} pendingFeedback={loop.pendingFeedback} onSent={onGateAction} tr={tr} />
          <button onClick={onStop}
            className="self-start text-[11px] font-medium bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity text-red">
            {tr("org.brief.automation.stopButton")}
          </button>
        </>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-ink-muted line-clamp-1">{loop.stopReason}</span>
          <button onClick={onDismiss}
            className="text-[11px] text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer p-0 shrink-0">
            {tr("common.close")}
          </button>
        </div>
      )}
    </div>
  );
}

// 排队中的自动化(agent 工具 schedule_goal/schedule_loop 排的队,GET /api/automation/queue 只读展示)——
// 目标/连续卡之下、非空才占位的折叠列表。规则化截断(不调 LLM),裁了才补省略号,与 BriefingPanel 的
// truncate 同款逻辑(各处按自己需要各存一份，见该文件同类注释)。
function truncatePrompt(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + "…" : s;
}

// source 是 "user" | "agent:<agentId>"——员工来源按 agents store 反查名字，查不到就回落原始 id。
function sourceLabel(source: string, agentsById: Map<string, AgentNodeConfig>, tr: Tr): string {
  if (source === "user") return tr("org.brief.automation.queue.sourceUser");
  const m = source.match(/^agent:(.+)$/);
  if (!m) return source;
  return agentsById.get(m[1])?.name ?? m[1];
}

function QueueRow({ item, agentsById, onDelete, tr }: {
  item: QueuedAutomation; agentsById: Map<string, AgentNodeConfig>; onDelete: (id: string) => void; tr: Tr;
}) {
  const Icon = item.kind === "goal" ? Wrench : Repeat;
  return (
    <div className="flex items-center gap-2 py-1.5 border-t border-hairline first:border-t-0">
      <Icon size={12} className="text-ink-subtle shrink-0" />
      <span className="text-[12px] text-ink flex-1 min-w-0 truncate">{truncatePrompt(item.prompt, 60)}</span>
      <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-2 text-ink-subtle shrink-0">{sourceLabel(item.source, agentsById, tr)}</span>
      <button
        onClick={() => onDelete(item.id)}
        title={tr("org.brief.automation.queue.remove")}
        className="w-5 h-5 rounded-lg flex items-center justify-center text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer shrink-0"
      >
        <X size={11} />
      </button>
    </div>
  );
}

export default function AutomationPanel({ activeCompanyId, refreshSignal }: { activeCompanyId: string; refreshSignal: number }) {
  const tr = useT();
  const [goals, setGoals] = useState<GoalRecord[]>([]);
  const [loops, setLoops] = useState<LoopRecord[]>([]);
  const [queue, setQueue] = useState<QueuedAutomation[]>([]);
  const [queueOpen, setQueueOpen] = useState(false);
  const [stickyLoopId, setStickyLoopId] = useState<string | null>(null);
  const [dismissedLoopId, setDismissedLoopId] = useState<string | null>(null);
  const agents = useAgentStore(s => s.agents);
  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);

  const fetchAll = useCallback(() => {
    api.get<{ inFlight: boolean; goals: GoalRecord[] }>("/goals").then(r => setGoals(r.goals ?? [])).catch(() => { /* best-effort */ });
    api.get<{ inFlight: boolean; loops: LoopRecord[] }>("/loops").then(r => setLoops(r.loops ?? [])).catch(() => { /* best-effort */ });
    api.get<{ queue: QueuedAutomation[] }>("/automation/queue").then(r => setQueue(r.queue ?? [])).catch(() => { /* best-effort */ });
  }, []);

  // 15s 轮询，仅标签页可见时跑(与 OrgPage 的 /channels 轮询同一模式)。
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!timer) { fetchAll(); timer = setInterval(fetchAll, 15000); } };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => { if (document.hidden) stop(); else start(); };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); };
  }, [fetchAll]);

  // BriefingPanel 刚发起一个新目标/连续任务后 bump 一下，不必等下一次 15s 轮询才看到。
  useEffect(() => { fetchAll(); }, [refreshSignal, fetchAll]);

  // 切公司 → 清掉粘滞的连续任务收尾状态(避免看到别家公司刚结束的卡片)。
  useEffect(() => { setStickyLoopId(null); setDismissedLoopId(null); }, [activeCompanyId]);

  const companyMatch = useCallback((companyId: string | undefined) => (companyId || DEFAULT_COMPANY) === activeCompanyId, [activeCompanyId]);

  // waiting_user(每轮确认门等待中)也算"活动中"——不能因为状态字段不是 running 就让卡片消失,
  // 那正是用户最需要看到它、做决定的时刻。
  const activeGoal = useMemo(() => goals.find(g => (g.status === "running" || g.status === "waiting_user") && companyMatch(g.companyId)), [goals, companyMatch]);

  useEffect(() => {
    const running = loops.find(l => (l.status === "running" || l.status === "waiting_user") && companyMatch(l.companyId));
    if (running) setStickyLoopId(running.id);
  }, [loops, companyMatch]);

  const displayLoop = useMemo(() => {
    if (!stickyLoopId || stickyLoopId === dismissedLoopId) return undefined;
    const l = loops.find(x => x.id === stickyLoopId);
    return l && companyMatch(l.companyId) ? l : undefined;
  }, [loops, stickyLoopId, dismissedLoopId, companyMatch]);

  const filteredQueue = useMemo(() => queue.filter(q => companyMatch(q.companyId)), [queue, companyMatch]);

  const handleDeleteQueueItem = useCallback(async (id: string) => {
    try { await api.del(`/automation/queue/${id}`); } catch { /* best-effort:即使删除失败也乐观移除,下次轮询会纠正 */ }
    setQueue(q => q.filter(x => x.id !== id));
  }, []);

  const openRun = useCallback((runId: string) => {
    window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId } }));
  }, []);

  const handleStopGoal = useCallback(async () => {
    if (!activeGoal) return;
    const ok = await confirmDialog({
      title: tr("org.brief.automation.goalStopConfirmTitle"),
      body: tr("org.brief.automation.stopConfirmBody"),
      danger: true,
      confirmLabel: tr("org.brief.automation.stopButton"),
    });
    if (!ok) return;
    try { await api.post(`/goals/${activeGoal.id}/stop`, {}); } catch { /* best-effort */ }
    fetchAll();
  }, [activeGoal, tr, fetchAll]);

  const handleStopLoop = useCallback(async () => {
    if (!displayLoop) return;
    const ok = await confirmDialog({
      title: tr("org.brief.automation.loopStopConfirmTitle"),
      body: tr("org.brief.automation.stopConfirmBody"),
      danger: true,
      confirmLabel: tr("org.brief.automation.stopButton"),
    });
    if (!ok) return;
    try { await api.post(`/loops/${displayLoop.id}/stop`, {}); } catch { /* best-effort */ }
    fetchAll();
  }, [displayLoop, tr, fetchAll]);

  if (!activeGoal && !displayLoop && filteredQueue.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-hairline bg-surface-2/20 px-3 py-2.5 flex flex-col gap-2 max-h-[280px] overflow-y-auto">
      {activeGoal && <HarnessCard goal={activeGoal} onStop={handleStopGoal} onOpen={openRun} onGateAction={fetchAll} tr={tr} />}
      {displayLoop && (
        <LoopCard loop={displayLoop} onStop={handleStopLoop} onOpen={openRun}
          onDismiss={() => setDismissedLoopId(displayLoop.id)} onGateAction={fetchAll} tr={tr} />
      )}
      {filteredQueue.length > 0 && (
        <div className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
          <button
            onClick={() => setQueueOpen(o => !o)}
            className="w-full flex items-center gap-1.5 px-2.5 py-2 bg-transparent border-none cursor-pointer text-left"
          >
            {queueOpen ? <ChevronUp size={12} className="text-ink-subtle shrink-0" /> : <ChevronDown size={12} className="text-ink-subtle shrink-0" />}
            <Clock size={12} className="text-accent shrink-0" />
            <span className="text-[11px] font-medium text-ink-muted">{tr("org.brief.automation.queue.title", { n: filteredQueue.length })}</span>
          </button>
          {queueOpen && (
            <div className="px-2.5 pb-2 max-h-[180px] overflow-y-auto">
              {filteredQueue.map(item => (
                <QueueRow key={item.id} item={item} agentsById={agentsById} onDelete={handleDeleteQueueItem} tr={tr} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
