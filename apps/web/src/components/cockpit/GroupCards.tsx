import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Package, ScrollText, ShieldCheck } from "lucide-react";
import type { TraceEvent } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { computeRunQuality } from "../../lib/runQuality.js";
import { SUCCESS, WARNING, ERROR } from "../trace/traceTypes.js";
import PostmortemModal, { type PostmortemData } from "../common/PostmortemModal.js";

// Track C · C3:群消息流的内联卡片(成果卡/失败卡/审查卡)。铁律:只渲染真实数据——
// goal/产物数/复盘 topCause 全部来自现有端点(/runs 索引、/runs/:id/artifacts、/runs/:id/postmortem),
// 拿不到的字段不显示;quality 摘要复用 ResultSection 同一份 computeRunQuality 口径。

function openTaskRun(runId: string) {
  window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId } }));
}

function CardShell({ color, icon, title, children }: {
  color: string; icon: ReactNode; title: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[200px] max-w-[420px]">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color }}>
        {icon}{title}
      </div>
      {children}
    </div>
  );
}

// ── 成果卡:run_finished 且成功 ────────────────────────────────────────────────
// goal 摘要(runs 索引)+ 产物数(/runs/:id/artifacts,失败则整行不显示)+ quality 摘要
// (本 run 在事件缓冲里的信号,无信号不占地方)+ 查看报告 →(open-task-run 跨页契约)。
export function RunResultCard({ runId, goal, deferredCount, runEvents }: {
  runId: string;
  goal?: string;
  deferredCount?: number;
  runEvents: TraceEvent[]; // 已按 runId 过滤的该 run 事件(调用方从事件缓冲筛出)
}) {
  const tr = useT();
  const [artifactCount, setArtifactCount] = useState<number | null>(null);
  useEffect(() => {
    let gone = false;
    api.get<{ artifacts: unknown[] }>(`/runs/${encodeURIComponent(runId)}/artifacts`)
      .then((r) => { if (!gone && Array.isArray(r.artifacts)) setArtifactCount(r.artifacts.length); })
      .catch(() => { /* 拿不到就不显示 */ });
    return () => { gone = true; };
  }, [runId]);

  const quality = useMemo(() => computeRunQuality(runEvents), [runEvents]);
  const qualityParts = useMemo(() => {
    if (!quality.hasAnySignal || quality.allClear) return [];
    const parts: string[] = [];
    if (quality.verifyTotal > 0) parts.push(tr("trace.quality.verification", { passed: quality.verifyPassed, total: quality.verifyTotal }));
    const mergeCount = quality.mergeFiles.length;
    if (mergeCount > 0) parts.push(tr("trace.quality.mergeConflict", { count: mergeCount }));
    else if (quality.hasUnstructuredMergeConflict) parts.push(tr("trace.quality.mergeConflictUnknown"));
    if (quality.sameModelCount > 0) parts.push(tr("trace.quality.sameModelReview", { count: quality.sameModelCount }));
    if (quality.salvageCount > 0) parts.push(tr("trace.quality.partialSalvage", { count: quality.salvageCount }));
    return parts;
  }, [quality, tr]);

  return (
    <CardShell color={SUCCESS} icon={<CheckCircle2 size={12} />} title={tr("cockpit.card.resultTitle")}>
      {goal && <div className="text-[13px] font-medium text-ink leading-snug line-clamp-2">{goal}</div>}
      <div className="flex items-center gap-2 flex-wrap text-[11px] text-ink-muted">
        {artifactCount !== null && (
          <span className="inline-flex items-center gap-1"><Package size={11} />{tr("cockpit.card.artifactCount", { n: artifactCount })}</span>
        )}
        {typeof deferredCount === "number" && deferredCount > 0 && (
          <span style={{ color: WARNING }}>{tr("cockpit.card.deferredCount", { n: deferredCount })}</span>
        )}
      </div>
      {quality.hasAnySignal && (
        quality.allClear
          ? <div className="inline-flex items-center gap-1 text-[11px]" style={{ color: SUCCESS }}><ShieldCheck size={11} />{tr("trace.quality.allClear")}</div>
          : <div className="inline-flex items-start gap-1 text-[11px]" style={{ color: WARNING }}><ShieldCheck size={11} className="mt-0.5 shrink-0" /><span>{qualityParts.join(" · ")}</span></div>
      )}
      <button
        onClick={() => openTaskRun(runId)}
        className="self-start text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity"
      >
        {tr("org.brief.card.viewReport")}
      </button>
    </CardShell>
  );
}

// ── 失败卡:run_finished 失败/降级 ────────────────────────────────────────────
// C1 复盘端点(GET /runs/:id/postmortem)的 topCause 摘要 + 一键打开 PostmortemModal(只 import
// 复用,不改 modal 本体);postmortem 不可用时只留"查看任务"入口,不编造原因。
export function RunFailureCard({ runId, goal, degraded }: { runId: string; goal?: string; degraded: boolean }) {
  const tr = useT();
  const [pm, setPm] = useState<PostmortemData | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  useEffect(() => {
    let gone = false;
    api.get<PostmortemData>(`/runs/${encodeURIComponent(runId)}/postmortem`)
      .then((d) => { if (!gone && d?.available) setPm(d); })
      .catch(() => { /* 复盘拿不到就不显示 topCause */ });
    return () => { gone = true; };
  }, [runId]);

  const topCause = pm?.causes[0]?.message;
  return (
    <CardShell color={degraded ? WARNING : ERROR} icon={<AlertTriangle size={12} />}
      title={tr(degraded ? "cockpit.card.degradedTitle" : "cockpit.card.failureTitle")}>
      {goal && <div className="text-[13px] font-medium text-ink leading-snug line-clamp-2">{goal}</div>}
      {topCause && (
        <div className="text-[12px] text-ink-muted leading-snug line-clamp-3">
          <span className="font-medium">{tr("cockpit.card.topCause")}: </span>{topCause}
        </div>
      )}
      <div className="flex items-center gap-3">
        {pm && (
          <button
            onClick={() => setModalOpen(true)}
            className="text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity"
          >
            {tr("org.ceo.failure.viewPostmortem")}
          </button>
        )}
        <button
          onClick={() => openTaskRun(runId)}
          className="inline-flex items-center gap-1 text-[11px] text-ink-subtle bg-transparent border-none cursor-pointer p-0 hover:text-ink transition-colors"
        >
          <ScrollText size={11} />{tr("org.ceo.failure.viewRun")}
        </button>
      </div>
      {modalOpen && pm && <PostmortemModal postmortem={pm} onClose={() => setModalOpen(false)} />}
    </CardShell>
  );
}

// ── 审查卡:review_committed(A1 结构化裁决事件) ─────────────────────────────
// verdict 四态徽章 + verifier/被审 agent 名;payload 形状镜像 server reviewCommit.ts 的
// ReviewCommittedPayload(不跨包引入 server 内部类型,与 PostmortemData 同一做法)。
const VERDICT_COLOR: Record<string, string> = {
  accepted: SUCCESS,
  needs_revision: WARNING,
  failed: ERROR,
  requires_human_review: "#957bc1",
};
const VERDICT_LABEL_KEY: Record<string, string> = {
  accepted: "review.verdict.accepted",
  needs_revision: "review.verdict.needs_revision",
  failed: "review.verdict.failed",
  requires_human_review: "review.verdict.requires_human_review",
};

export function ReviewCard({ e, nameOf }: { e: TraceEvent; nameOf: (id: string | undefined) => string }) {
  const tr = useT();
  const p = (e.payload ?? {}) as { agentId?: string; verdict?: string; proposal?: { reason?: string } };
  const verdict = typeof p.verdict === "string" ? p.verdict : "";
  const color = VERDICT_COLOR[verdict] ?? "var(--color-ink-subtle)";
  const label = VERDICT_LABEL_KEY[verdict] ? tr(VERDICT_LABEL_KEY[verdict]) : verdict;
  const verifier = nameOf(e.agentId);
  const target = nameOf(p.agentId);
  return (
    <CardShell color="#957bc1" icon={<ShieldCheck size={12} />} title={tr("cockpit.card.reviewTitle")}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[12px] text-ink">{tr("cockpit.card.reviewOf", { verifier, target })}</span>
        {label && (
          <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap"
            style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}>
            {label}
          </span>
        )}
      </div>
      {p.proposal?.reason && <div className="text-[11px] text-ink-muted leading-snug line-clamp-2">{p.proposal.reason}</div>}
    </CardShell>
  );
}
