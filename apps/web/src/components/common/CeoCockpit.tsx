import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Target, Users, AlertTriangle, Clock } from "lucide-react";
import type { AgentNodeConfig } from "@opc/shared";
import * as api from "../../api/client.js";
import type { CeoStatus } from "../../api/client.js";
import { CAUSE_MSG_KEYS, SUGGESTION_KEYS } from "./PostmortemModal.js";
import TaskGraphTree from "./TaskGraphTree.js";
import { cleanText } from "../../lib/text.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { RUN_UI_STATE_EVENT, type RunUiStateDetail } from "../../lib/runUiState.js";

// ── CEO 驾驶舱(共享组件)──────────────────────────────────────────────────────────────
// 一眼条之下的折叠区块:当前目标(mission+审批徽章)/ 预估卡(旧 mission 显示"暂无预估")/ 正在等待谁
// (working agents)/ 最近失败卡(postmortem 摘要+入口)/ 任务拆解树(真实任务图,无图不渲染)/ 进行中 run + 倒计时 + 今日成本页脚。
// 原为 BriefingPanel 内部私有组件,E3 抽出为 common/ 共享件,让组织页简报栏与工作台右列同一面板同源。
// 数据 = GET /api/ceo/status 聚合(见 useCeoStatus)+ 等待谁用 agents store 实时状态(由调用方过滤好传入)。
// 配色:局部小配色表(同既有做法,不为几行抽公共模块)。
const TIER_COLOR: Record<string, string> = { S: "var(--color-success)", M: "var(--color-info)", L: "var(--color-warning)", XL: "var(--color-error)" };
const MISSION_STATUS_COLOR: Record<string, string> = {
  draft: "var(--color-warning)", approved: "var(--color-success)", stopped: "var(--color-ink-subtle)",
  queued: "var(--color-ink-subtle)", preparing: "var(--color-info)", running: "var(--color-info)",
  completed: "var(--color-success)", degraded: "var(--color-warning)", failed: "var(--color-error)",
};
const RISK_COLOR: Record<string, string> = { low: "var(--color-success)", standard: "var(--color-info)", elevated: "var(--color-warning)", high: "var(--color-error)" };

// 徽章淡底色:token 现在是 var(...) 字符串,不能再拼旧写法的 16 进制透明度后缀(如 + "22"),
// 改用 color-mix 在该 token 上混透明得到淡底,视觉效果与旧写法等价。
function tint(color: string): string {
  return `color-mix(in srgb, ${color} 16%, transparent)`;
}

type Tr = (key: string, params?: Record<string, string | number>) => string;

function fmtTokens(v: number | null | undefined): string {
  if (v == null) return "—";
  return v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}m` : v >= 1_000 ? `${(v / 1_000).toFixed(1)}k` : String(v);
}

// 规则化截断(不调 LLM):cleanText 去乱码前缀后按字符裁剪,裁了才补省略号。BriefingPanel 另存一份同名
// 助手,各处按需各存(既有惯例),不为这几行抽公共模块。
function truncate(s: string, n: number): string {
  const c = cleanText(s);
  return c.length > n ? c.slice(0, n).trimEnd() + "…" : c;
}

// 自足数据钩子:GET /api/ceo/status 聚合 + run_started/run_finished 增量触发刷新(与一眼条同节奏,
// 不新造轮询器)+ 切公司先清骨架态再重拉(避免闪现上一家公司的 mission/失败卡)。调用方只需给 companyId。
export function useCeoStatus(companyId: string): CeoStatus | null {
  const [ceo, setCeo] = useState<CeoStatus | null>(null);
  const events = useAgentStore(s => s.events);
  const seen = useRef(0);
  const refresh = useCallback(() => {
    api.getCeoStatus(companyId).then(setCeo).catch(() => { /* best-effort */ });
  }, [companyId]);
  useEffect(() => { setCeo(null); refresh(); }, [refresh]);
  useEffect(() => {
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    if (fresh.some(e => e.type === "run_started" || e.type === "run_finished")) refresh();
  }, [events, refresh]);
  return ceo;
}

// 倒计时:activeRun.startedAt + 预估 max_minutes 递减(30s 刷一次)。未超时报"预计剩余 ~N 分钟",
// 超时诚实报"已超出预估"(不掩盖)。startedAt 解析不出则不渲染。
function Countdown({ startedAt, maxMinutes, tr }: { startedAt: string; maxMinutes: number; tr: Tr }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return null;
  const remaining = maxMinutes - (now - started) / 60_000;
  const overdue = remaining <= 0;
  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums shrink-0" style={{ color: overdue ? "var(--color-warning)" : "var(--color-ink-subtle)" }}>
      <Clock size={10} className="shrink-0" />
      {overdue ? tr("org.ceo.countdown.overdue") : tr("org.ceo.countdown.remaining", { n: Math.max(1, Math.ceil(remaining)) })}
    </span>
  );
}

export default function CeoCockpit({ companyId, ceo, workingAgents, open, onToggle, onViewFailure, tr }: {
  companyId: string;
  ceo: CeoStatus | null;
  workingAgents: AgentNodeConfig[];
  open: boolean;
  onToggle: () => void;
  onViewFailure: (f: NonNullable<CeoStatus["lastFailure"]>) => void;
  tr: Tr;
}) {
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const mission = ceo?.mission ?? null;
  const est = mission?.complexityEstimate ?? null;
  const lastFailure = ceo?.lastFailure ?? null;
  const events = useAgentStore(s => s.events);
  const [announcedRun, setAnnouncedRun] = useState<RunUiStateDetail | null>(null);

  useEffect(() => {
    const onRunUiState = (event: Event) => {
      const detail = (event as CustomEvent<RunUiStateDetail>).detail;
      if (detail && detail.companyId === companyId) setAnnouncedRun(detail);
    };
    window.addEventListener(RUN_UI_STATE_EVENT, onRunUiState);
    return () => window.removeEventListener(RUN_UI_STATE_EVENT, onRunUiState);
  }, [companyId]);
  useEffect(() => { setAnnouncedRun(null); }, [companyId]);

  let runPhase: "queued" | "preparing" | "running" | "completed" | "degraded" | "failed" | null = announcedRun?.status ?? null;
  if (announcedRun) {
    const latest = [...events].reverse().find(e => e.runId === announcedRun.runId && (e.type === "run_started" || e.type === "run_finished"));
    if (latest?.type === "run_started") runPhase = "running";
    if (latest?.type === "run_finished") {
      const payload = (latest.payload ?? {}) as Record<string, unknown>;
      runPhase = payload.finalState === "failed" || payload.status === "failed"
        ? "failed"
        : payload.finalState === "degraded" || payload.degraded === true ? "degraded" : "completed";
    }
    if (lastFailure?.runId === announcedRun.runId) runPhase = "failed";
  } else if (ceo?.activeRun && mission && cleanText(ceo.activeRun.goal) === cleanText(mission.goal)) {
    runPhase = "running";
  } else if (mission && lastFailure?.endedAt && new Date(lastFailure.endedAt).getTime() >= new Date(mission.createdAt).getTime()) {
    runPhase = "failed";
  }
  const missionStatus = runPhase ?? mission?.approvalStatus ?? null;
  const visibleRun = runPhase && ["queued", "preparing", "running"].includes(runPhase)
    ? (announcedRun ? { runId: announcedRun.runId, goal: announcedRun.goal, startedAt: announcedRun.announcedAt } : ceo?.activeRun)
    : ceo?.activeRun;
  const hasActiveUiRun = runPhase != null && ["queued", "preparing", "running"].includes(runPhase);
  const displayedGoal = hasActiveUiRun && announcedRun ? announcedRun.goal : mission?.goal;
  const displayedStatus = missionStatus ?? mission?.approvalStatus ?? "preparing";

  return (
    <div className="shrink-0 border-b border-hairline bg-surface-2/20">
      <button onClick={onToggle} className="w-full flex items-center gap-1.5 px-3 py-2 bg-transparent border-none cursor-pointer text-left">
        {open ? <ChevronUp size={12} className="text-ink-subtle shrink-0" /> : <ChevronDown size={12} className="text-ink-subtle shrink-0" />}

        <span className="text-[11px] font-medium text-ink-muted">{tr("org.ceo.title")}</span>
        {!open && displayedGoal && (
          <span className="ml-auto text-[10px] text-ink-subtle truncate max-w-[55%]">{displayedGoal}</span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-2.5 flex flex-col gap-1.5 max-h-[320px] overflow-y-auto">
          {/* 当前目标卡(+ 依附其下的预估:有 mission 才谈预估) */}
          <div className="rounded-lg border border-hairline bg-surface-1 p-2.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Target size={11} className="text-accent shrink-0" />
              <span className="text-[11px] font-medium text-ink-subtle">{tr("org.ceo.mission.title")}</span>
              {displayedGoal && (
                <span
                  className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0"
                  style={{ background: tint(MISSION_STATUS_COLOR[displayedStatus] || "var(--color-ink-subtle)"), color: MISSION_STATUS_COLOR[displayedStatus] || "var(--color-ink-subtle)" }}
                >
                  {tr(`org.ceo.mission.status.${displayedStatus}`)}
                </span>
              )}
            </div>
            {displayedGoal
              ? <div className="text-[12px] text-ink leading-snug line-clamp-2">{displayedGoal}</div>
              : <div className="text-[12px] text-ink-subtle">{tr("org.ceo.mission.empty")}</div>}
            {mission && (
              <div className="flex flex-col gap-1 border-t border-hairline pt-1.5">
                {est ? (
                  <>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white shrink-0" style={{ background: TIER_COLOR[est.complexity] || "var(--color-info)" }}>
                        {est.complexity}
                      </span>
                      <span className="text-[11px] text-ink-muted tabular-nums">
                        {tr("org.ceo.estimate.duration", { min: est.estimated_duration.min_minutes, max: est.estimated_duration.max_minutes })}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0" style={{ background: tint(RISK_COLOR[est.risk_level] || "var(--color-info)"), color: RISK_COLOR[est.risk_level] || "var(--color-info)" }}>
                        {tr(`org.ceo.estimate.risk.${est.risk_level}`)}
                      </span>
                      <span className="text-[10px] text-ink-subtle">{tr("org.ceo.estimate.governance", { n: est.recommended_governance_level })}</span>
                    </div>
                    {est.reason.length > 0 && (
                      <>
                        <button
                          onClick={() => setReasonsOpen(o => !o)}
                          className="self-start flex items-center gap-1 text-[10px] text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer p-0 transition-colors"
                        >
                          {reasonsOpen ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                          {tr("org.ceo.estimate.reasons", { n: est.reason.length })}
                        </button>
                        {reasonsOpen && (
                          <ul className="m-0 pl-1 flex flex-col gap-0.5 list-none">
                            {est.reason.map((r, i) => (
                              <li key={i} className="text-[11px] text-ink-muted leading-snug">· {r}</li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-[11px] text-ink-subtle">{tr("org.ceo.estimate.empty")}</span>
                )}
              </div>
            )}
          </div>

          {/* 正在等待谁:agents store 实时 working 名单(与一眼条 workingCount 同源) */}
          <div className="rounded-lg border border-hairline bg-surface-1 p-2.5 flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <Users size={11} className="text-accent shrink-0" />
              <span className="text-[11px] font-medium text-ink-subtle">{tr("org.ceo.waiting.title")}</span>
            </div>
            {workingAgents.length === 0 ? (
              <div className="text-[12px] text-ink-subtle">{runPhase && ["queued", "preparing", "running"].includes(runPhase) ? tr("org.ceo.waiting.preparing") : tr("org.ceo.waiting.idle")}</div>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {workingAgents.map(a => (
                  <span
                    key={a.id}
                    title={a.currentTask || a.role}
                    className="inline-flex items-center gap-1 pl-0.5 pr-2 py-0.5 rounded-full bg-surface-2 text-[11px] text-ink"
                  >
                    <span className="w-4 h-4 rounded-full bg-accent text-white text-[10px] font-semibold flex items-center justify-center shrink-0">
                      {(a.name || a.id).slice(0, 1).toUpperCase()}
                    </span>
                    {a.name || a.id}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 最近失败卡(存在才渲染):postmortem 摘要 + 查看复盘入口 */}
          {lastFailure && (
            <div className="rounded-lg border p-2.5 flex flex-col gap-1" style={{ borderColor: "color-mix(in srgb, var(--color-error) 45%, transparent)", background: "color-mix(in srgb, var(--color-error) 7%, transparent)" }}>
              <div className="flex items-center gap-1.5">
                <AlertTriangle size={11} className="shrink-0 text-red" />
                <span className="text-[11px] font-medium text-red">{tr("org.ceo.failure.title")}</span>
                <span className="ml-auto text-[10px] text-ink-subtle tabular-nums shrink-0">run {lastFailure.runId.slice(0, 8)}</span>
              </div>
              {/* 有结构化键按 postmortem.cause.* / postmortem.suggestion.* 词典渲染,否则回退服务端原文 */}
              {lastFailure.topCause && (
                <div className="text-[12px] text-ink leading-snug line-clamp-2">
                  {lastFailure.topCauseKey && CAUSE_MSG_KEYS.has(lastFailure.topCauseKey)
                    ? tr(`postmortem.cause.${lastFailure.topCauseKey}`, lastFailure.topCauseParams)
                    : lastFailure.topCause}
                </div>
              )}
              {lastFailure.topSuggestion && (
                <div className="text-[11px] text-ink-muted leading-snug line-clamp-2">
                  {lastFailure.topSuggestionKey && SUGGESTION_KEYS.has(lastFailure.topSuggestionKey)
                    ? tr(`postmortem.suggestion.${lastFailure.topSuggestionKey}`, lastFailure.topSuggestionParams)
                    : lastFailure.topSuggestion}
                </div>
              )}
              <button
                onClick={() => onViewFailure(lastFailure)}
                className="self-start text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity"
              >
                {lastFailure.postmortemAvailable ? tr("org.ceo.failure.viewPostmortem") : tr("org.ceo.failure.viewRun")}
              </button>
            </div>
          )}

          {/* B6 · 任务拆解树(真实任务图):mission 走了 task-graph 派发路径才有图;404/无图整卡不渲染 */}
          {mission && <TaskGraphTree missionId={mission.id} tr={tr} />}

          {/* 页脚:进行中 run(点击去任务档案)+ 倒计时(有预估才渲染)+ 今日成本(与一眼条同口径,全局) */}
          <div className="flex items-center gap-2 px-0.5 min-h-[16px]">
            {visibleRun && (
              <button
                onClick={() => window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId: visibleRun!.runId } }))}
                className="flex items-center gap-1 min-w-0 text-[11px] text-ink-subtle hover:text-accent bg-transparent border-none cursor-pointer p-0 transition-colors"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" />
                <span className="truncate">{tr(runPhase === "queued" ? "org.ceo.activeRun.queued" : runPhase === "preparing" ? "org.ceo.activeRun.preparing" : "org.ceo.activeRun.label")}: {truncate(visibleRun.goal, 48)}</span>
              </button>
            )}
            {ceo?.activeRun && est && (
              <Countdown startedAt={ceo.activeRun.startedAt} maxMinutes={est.estimated_duration.max_minutes} tr={tr} />
            )}
            <span className="ml-auto text-[11px] text-ink-subtle tabular-nums shrink-0">
              {tr("org.glance.todayCost")} ({tr("org.glance.allScope")}): {fmtTokens(ceo ? ceo.todayTokens : null)}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
