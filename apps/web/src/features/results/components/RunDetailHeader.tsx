import { AlertTriangle, Ban, CheckCircle2, Radio, RefreshCw, Timer } from "lucide-react";
import { AvatarStack } from "../../../components/trace/AgentAvatar.js";
import { BADGE_COLOR, BADGE_LABEL_KEY, type BadgeKey } from "../../../components/trace/traceTypes.js";
import { fmtRelativeTime, fmtTime } from "../../../components/trace/traceFormat.js";
import { useT } from "../../../i18n.js";

export default function RunDetailHeader({
  goal,
  badge,
  participants,
  runId,
  startedAt,
  finishedAt,
  hasPartial,
  isLive,
}: {
  goal: string;
  badge: BadgeKey;
  participants: string[];
  runId: string;
  startedAt: string | null;
  finishedAt: string | null;
  hasPartial: boolean;
  isLive: boolean;
}) {
  const tr = useT();
  return (
    <div className="card">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <h1 className="m-0 text-[18px] font-semibold text-ink leading-snug break-words min-w-0 flex-1">{goal}</h1>
        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <span className="badge flex items-center gap-1.5 text-white shrink-0" style={{ background: BADGE_COLOR[badge] }}>
            {badge === "running" ? <RefreshCw size={12} className="animate-spin" />
              : badge === "interrupted" || badge === "cancelled" ? <Ban size={12} />
                : badge === "done" ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            {tr(BADGE_LABEL_KEY[badge])}
          </span>
          {hasPartial && (
            <span className="badge flex items-center gap-1 text-white shrink-0" style={{ background: "var(--color-warning)" }}>
              <Timer size={12} /> {tr("trace.status.partial")}
            </span>
          )}
          {isLive && (
            <span className="badge flex items-center gap-1 shrink-0" style={{ background: "transparent", border: "1px solid var(--color-success)", color: "var(--color-success)" }}>
              <Radio size={12} className="animate-pulse" /> {tr("trace.live")}
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between flex-wrap gap-3">
        <AvatarStack agentIds={participants} max={8} size={24} />
        <div className="flex items-center gap-3 text-[12px] text-ink-subtle">
          <span title={fmtTime(startedAt)}>{tr("trace.started")}: {fmtRelativeTime(startedAt, tr)}</span>
          {finishedAt && <span title={fmtTime(finishedAt)}>{tr("trace.finished")}: {fmtRelativeTime(finishedAt, tr)}</span>}
          <span className="font-mono">Run {runId}</span>
        </div>
      </div>
    </div>
  );
}
