import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, ChevronDown, ChevronLeft, ChevronRight, Receipt } from "lucide-react";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { openRun } from "../../lib/navigation.js";
import { AvatarGroup } from "./Avatar.js";
import { agentDisplay } from "../../lib/costAgentMeta.js";
import { fmtAbsTime, fmtTok, relativeTimeOf, safeGoal, truncate } from "./format.js";
import type { LedgerRow, Roster, RunLedger } from "./types.js";

interface RunDetail { agents: string[]; deferredCount: number }

function useRunDetails(runIds: string[]) {
  const cache = useRef(new Map<string, RunDetail>());
  const [, setVersion] = useState(0);
  useEffect(() => {
    const missing = runIds.filter(id => !cache.current.has(id));
    if (!missing.length) return;
    missing.forEach(id => cache.current.set(id, { agents: [], deferredCount: 0 }));
    Promise.allSettled(missing.map(id => api.get<{ participatingAgents?: string[]; deferredTasks?: unknown[] }>(`/runs/${id}`))).then(results => {
      results.forEach((result, index) => {
        if (result.status === "fulfilled") cache.current.set(missing[index], { agents: result.value.participatingAgents ?? [], deferredCount: (result.value.deferredTasks ?? []).length });
      });
      setVersion(value => value + 1);
    });
  }, [runIds.join(",")]);
  return cache.current;
}

function TaskRow({ row, roster, detail, expanded, onToggle }: { row: LedgerRow; roster: Roster; detail?: RunDetail; expanded: boolean; onToggle: () => void }) {
  const tr = useT();
  const relative = relativeTimeOf(row.startedAt);
  const timeLabel = relative ? tr(relative.key, { n: relative.n }) : fmtAbsTime(row.startedAt);
  const goal = truncate(safeGoal(row.goal, tr("cost.bill.goalFallback", { id: row.runId.slice(0, 8) })), 60);
  const agents = detail?.agents ?? [];

  return <div className="border-b border-hairline/60 last:border-b-0">
    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-surface-2/40">
      <button onClick={onToggle} title={tr("cost.bill.toggleDetail")} className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md border-none bg-transparent text-ink-subtle hover:text-ink cursor-pointer"><ChevronDown size={14} className={expanded ? "rotate-180" : ""} /></button>
      <button onClick={() => openRun(row.runId)} title={tr("cost.bill.openRun")} className="min-w-0 flex-1 flex items-center gap-3 px-1 py-2 text-left bg-transparent border-none cursor-pointer group">
        <div className="flex-1 min-w-0"><div className="text-ink text-[13px] truncate flex items-center gap-1.5"><span className="truncate">{goal}</span>{row.degraded && <span className="shrink-0 text-amber text-[10px]">{tr("cost.bill.degraded")}</span>}</div><div className="text-ink-subtle text-[11px] mt-0.5 tabular-nums">{timeLabel}</div></div>
        {agents.length > 0 ? <AvatarGroup agentIds={agents} roster={roster} /> : <span className="text-ink-subtle text-[11px] tabular-nums w-8 text-center">{row.agentCount || ""}</span>}
        <div className="text-ink font-semibold text-[13px] tabular-nums w-24 text-right shrink-0">{fmtTok(row.tokens)} tok</div>
        <ArrowUpRight size={13} className="text-ink-subtle group-hover:text-accent shrink-0" />
      </button>
    </div>
    <AnimatePresence initial={false}>{expanded && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.15 }} className="overflow-hidden"><div className="px-4 pb-4 pt-1 pl-11">
      {!detail ? <div className="text-ink-subtle text-[12px]">{tr("cost.bill.detail.loading")}</div> : agents.length === 0 ? <div className="text-ink-subtle text-[12px]">{tr("cost.bill.detail.noParticipants")}</div> : <div className="flex flex-wrap gap-2">{agents.map(id => { const meta = agentDisplay(id, roster); return <span key={id} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 pl-1 pr-2.5 py-1 text-[12px] text-ink-muted"><span className="w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-semibold text-white" style={{ background: meta.color }}>{meta.initial}</span>{meta.name}</span>; })}</div>}
      {!!detail?.deferredCount && <div className="text-ink-subtle text-[11px] mt-2">{tr("cost.bill.detail.deferred", { n: detail.deferredCount })}</div>}
      <button onClick={() => openRun(row.runId)} className="mt-3 inline-flex items-center gap-1 text-[11px] text-accent bg-transparent border-none cursor-pointer">{tr("cost.bill.openRun")}<ArrowUpRight size={11} /></button>
    </div></motion.div>}</AnimatePresence>
  </div>;
}

export default function TaskBillList({ ledger, roster, page, pageSize, onPageChange, roleFilter }: { ledger: RunLedger | null; roster: Roster; page: number; pageSize: number; onPageChange: (page: number) => void; roleFilter?: string | null }) {
  const tr = useT();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rows = ledger?.rows ?? [];
  const details = useRunDetails(rows.map(row => row.runId));
  const filteredRows = useMemo(() => !roleFilter ? rows : rows.filter(row => {
    const detail = details.get(row.runId);
    return !detail || detail.agents.some(id => agentDisplay(id, roster).role === roleFilter);
  }), [details, roleFilter, roster, rows]);

  return <div className="rounded-lg border border-hairline/60 bg-surface-1 overflow-hidden">
    <div className="px-4 py-3 flex items-center gap-2 border-b border-hairline/60"><Receipt size={14} className="text-ink-muted" /><span className="text-ink font-semibold text-[13px]">{tr("cost.bill.title")}</span>{!!ledger?.total && <span className="text-ink-muted text-[11px]">{tr("cost.bill.count", { n: ledger.total })}</span>}<div className="flex-1" />{!!ledger && ledger.total > pageSize && <>
      <button disabled={page === 0} onClick={() => onPageChange(Math.max(0, page - 1))} className="w-6 h-6 flex items-center justify-center rounded-lg bg-surface-2 text-ink-muted cursor-pointer border-none disabled:opacity-40"><ChevronLeft size={13} /></button>
      <span className="text-ink-muted text-[11px] tabular-nums">{page + 1} / {Math.max(1, Math.ceil(ledger.total / pageSize))}</span>
      <button disabled={(page + 1) * pageSize >= ledger.total} onClick={() => onPageChange(page + 1)} className="w-6 h-6 flex items-center justify-center rounded-lg bg-surface-2 text-ink-muted cursor-pointer border-none disabled:opacity-40"><ChevronRight size={13} /></button>
    </>}</div>
    {!rows.length ? <div className="px-4 py-8 text-center text-ink-muted text-[13px]">{tr("cost.bill.empty")}</div> :
      !filteredRows.length ? <div className="px-4 py-8 text-center text-ink-muted text-[13px]">{tr("cost.bill.emptyFiltered")}</div> :
      filteredRows.map(row => <TaskRow key={row.runId} row={row} roster={roster} detail={details.get(row.runId)} expanded={expandedId === row.runId} onToggle={() => setExpandedId(current => current === row.runId ? null : row.runId)} />)}
  </div>;
}
