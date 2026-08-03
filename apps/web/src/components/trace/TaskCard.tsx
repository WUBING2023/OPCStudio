import { AlertTriangle, Ban, CheckCircle2, Clock, GitMerge, RefreshCw, Timer } from "lucide-react";
import { AvatarStack } from "./AgentAvatar.js";
import {
  BADGE_COLOR, BADGE_LABEL_KEY, EXECUTOR_BADGE, FINAL_STATE_BADGE, finalStateBadgeFor,
  type BadgeKey, type RunExecutor, type RunFinalState, type RunMergeConflict,
} from "./traceTypes.js";
import { SIMULATED_BADGE } from "../../lib/executorBadge.js";
import { fmtRelativeTime } from "./traceFormat.js";
import { cleanText } from "../../lib/text.js";
import { useT } from "../../i18n.js";

// 任务卡——列表(任务卡流)的最小单元。goal 一句话 + 参与者头像组 + 状态徽章 + 一句话结果摘要 + 相对时间。
// 进行中(badge==="running")置顶排序由调用方(TaskListView)负责，这里只负责"呼吸边框"的视觉表现。
export interface TaskCardProps {
  goal: string;
  startedAt: string;
  badge: BadgeKey;
  hasPartial?: boolean;
  participatingAgents: string[];
  summary: string | undefined; // undefined=还在拉；空串=拉到了但没内容→显示"点击查看"
  selected?: boolean;
  queuePosition?: number; // P1-5:badge==="queued" 时的 1 基排队位次
  executor?: RunExecutor; // 定稿 2.2:ACP / 降级 徽章(缺省=非订阅引擎或历史 run 无事件 → 不显示)
  simulated?: boolean; // MUP Gate A#2:mock run 永远标 SIMULATED,绝不冒充真实成功
  finalState?: RunFinalState; // MUP 波1:deriveFinalRunState 收敛终态(verified/requires_review 等)
  mergeConflicts?: RunMergeConflict[]; // Gate A#3:未决合并冲突清单(hover 看文件)
  onClick: () => void;
}

function BadgeIcon({ badge }: { badge: BadgeKey }) {
  if (badge === "running") return <RefreshCw size={11} className="animate-spin" />;
  if (badge === "queued") return <Clock size={11} />;
  if (badge === "interrupted") return <Ban size={11} />;
  if (badge === "done") return <CheckCircle2 size={11} />;
  return <AlertTriangle size={11} />;
}

export default function TaskCard({ goal, startedAt, badge, hasPartial, participatingAgents, summary, selected, queuePosition, executor, simulated, finalState, mergeConflicts, onClick }: TaskCardProps) {
  const t = useT();
  const isRunning = badge === "running";
  const cleanGoal = cleanText(goal) || t("trace.untitledGoal");
  const exBadge = executor ? EXECUTOR_BADGE[executor] : undefined;
  const fsKey = finalStateBadgeFor(finalState, badge);
  const fsBadge = fsKey ? FINAL_STATE_BADGE[fsKey] : undefined;
  const conflictFiles = (mergeConflicts ?? []).flatMap(c => c.files);
  return (
    <button
      onClick={onClick}
      title={cleanGoal}
      className={`relative w-full text-left rounded-lg border px-4 py-3 cursor-pointer transition-colors bg-surface-1
        ${selected ? "border-accent" : isRunning ? "border-accent/50" : "border-hairline hover:border-hairline-light hover:bg-surface-2/40"}`}
    >
      {isRunning && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-lg animate-pulse"
          style={{ boxShadow: "0 0 0 1px var(--color-accent)", opacity: 0.55 }}
        />
      )}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-ink truncate leading-snug">{cleanGoal}</div>
          <div className="mt-1 text-[12px] text-ink-muted line-clamp-1">
            {summary === undefined ? <span className="text-ink-subtle">{t("trace.summary.loading")}</span>
              : summary ? summary : <span className="text-ink-subtle">{t("trace.summary.placeholder")}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {simulated && (
            <span
              title={t(SIMULATED_BADGE.labelKey) || SIMULATED_BADGE.labelFallback}
              className="badge flex items-center shrink-0 text-white"
              style={{ background: SIMULATED_BADGE.color }}
            >
              {t(SIMULATED_BADGE.labelKey) || SIMULATED_BADGE.labelFallback}
            </span>
          )}
          {mergeConflicts && mergeConflicts.length > 0 && (
            <span
              title={conflictFiles.join("\n") || t("trace.mergeConflicts.badge", { n: mergeConflicts.length })}
              className="badge flex items-center gap-1 shrink-0 text-white"
              style={{ background: "var(--color-error)" }}
            >
              <GitMerge size={10} /> {t("trace.mergeConflicts.badge", { n: mergeConflicts.length })}
            </span>
          )}
          {fsBadge && (
            <span
              title={t(fsBadge.labelKey)}
              className="badge flex items-center shrink-0 text-white"
              style={{ background: fsBadge.color }}
            >
              {t(fsBadge.labelKey)}
            </span>
          )}
          {exBadge && (
            <span
              title={exBadge.labelKey ? t(exBadge.labelKey) : exBadge.label}
              className="badge flex items-center shrink-0 text-white"
              style={{ background: exBadge.color }}
            >
              {exBadge.labelKey ? t(exBadge.labelKey) : exBadge.label}
            </span>
          )}
          {hasPartial && (
            <span title={t("trace.status.partial")} className="badge flex items-center gap-1 text-white shrink-0" style={{ background: "var(--color-warning)" }}>
              <Timer size={10} />
            </span>
          )}
          <span className="badge flex items-center gap-1 text-white shrink-0" style={{ background: BADGE_COLOR[badge] }}>
            <BadgeIcon badge={badge} /> {t(BADGE_LABEL_KEY[badge])}{badge === "queued" && queuePosition ? ` #${queuePosition}` : ""}
          </span>
        </div>
      </div>
      <div className="mt-2.5 flex items-center justify-between">
        <AvatarStack agentIds={participatingAgents} />
        <span className="text-[11px] text-ink-subtle tabular-nums shrink-0">{fmtRelativeTime(startedAt, t)}</span>
      </div>
    </button>
  );
}
