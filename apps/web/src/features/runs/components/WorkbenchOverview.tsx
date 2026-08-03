import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock3, LoaderCircle, Play, RefreshCw } from "lucide-react";
import type { Company } from "@opc/shared";
import * as api from "../../../api/client.js";
import { useAgentStore } from "../../../store/useAgentStore.js";
import { useT } from "../../../i18n.js";
import { cleanText } from "../../../lib/text.js";
import { openRun } from "../../../lib/navigation.js";
import { buildWorkbenchOverview, type WorkbenchRun } from "../services/workbenchOverview.js";

function RunRow({ run, companyId }: { run: WorkbenchRun; companyId: string }) {
  const tr = useT();
  const status = (run.status || "").toLowerCase();
  const active = status === "running" || status === "queued" || status === "pending";
  return (
    <button onClick={() => openRun(run.id, run.companyId || (companyId === "all" ? undefined : companyId))} title={cleanText(run.goal) || run.id}
      className="w-full min-h-11 px-3 py-2 flex items-center gap-2 border-none border-b border-hairline last:border-b-0 bg-transparent text-left hover:bg-surface-2 cursor-pointer">
      {active ? <RefreshCw size={13} className="text-accent animate-spin shrink-0" />
        : status === "failed" || status === "error" ? <AlertTriangle size={13} className="text-error shrink-0" />
          : <CheckCircle2 size={13} className="text-green shrink-0" />}
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{cleanText(run.goal) || tr("trace.untitledGoal")}</span>
      <span className="text-[10px] text-ink-subtle shrink-0">Run {run.id.slice(0, 8)}</span>
    </button>
  );
}

export default function WorkbenchOverview({ companyId, routeRunId }: { companyId: string; routeRunId?: string }) {
  const tr = useT();
  const events = useAgentStore((state) => state.events);
  const lifecycleVersion = useMemo(
    () => events.filter((event) => event.type === "run_started" || event.type === "run_finished").length,
    [events],
  );
  const [runs, setRuns] = useState<WorkbenchRun[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [approvals, setApprovals] = useState<api.GovernanceRecordLite[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      api.get<WorkbenchRun[]>("/runs"),
      api.listGovernanceRecords(),
      api.get<Company[]>("/companies"),
    ]).then(([runRows, approvalRows, companyRows]) => {
      if (!alive) return;
      setRuns(runRows || []);
      setApprovals(approvalRows || []);
      setCompanies(companyRows || []);
    }).catch(() => {
      if (!alive) return;
      setRuns([]);
      setApprovals([]);
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [companyId, lifecycleVersion]);

  const data = useMemo(() => buildWorkbenchOverview(runs, approvals, companyId), [runs, approvals, companyId]);
  const companyName = companyId === "all"
    ? tr("workbench.overview.allCompanies")
    : companies.find((company) => company.id === companyId)?.name || companyId;
  const sections = [
    { key: "running", title: tr("workbench.overview.running"), Icon: Play, rows: data.running },
    { key: "sessions", title: tr("workbench.overview.sessions"), Icon: Clock3, rows: data.recentSessions },
    { key: "results", title: tr("workbench.overview.results"), Icon: CheckCircle2, rows: data.recentResults },
  ];

  return (
    <div className="h-full overflow-y-auto bg-canvas px-5 py-4">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h1 className="m-0 text-[17px] font-semibold text-ink truncate">{tr("workbench.overview.title", { company: companyName })}</h1>
            <p className="m-0 mt-1 text-[12px] text-ink-muted">{tr("workbench.overview.subtitle")}</p>
          </div>
          {routeRunId && (
            <button onClick={() => openRun(routeRunId, companyId)} className="btn-secondary shrink-0">
              {tr("workbench.overview.openCurrentRun")}
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 max-[900px]:grid-cols-1">
          <section className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
            <div className="h-10 px-3 flex items-center gap-2 border-b border-hairline">
              <AlertTriangle size={14} className={data.approvals.length ? "text-amber" : "text-ink-subtle"} />
              <h2 className="m-0 text-[13px] font-semibold text-ink">{tr("workbench.overview.approvals")}</h2>
              <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">{data.approvals.length}</span>
            </div>
            <div className="min-h-20 p-3 text-[12px] text-ink-muted">
              {data.approvals.length
                ? tr("workbench.overview.approvalsPending", { n: data.approvals.length })
                : tr("workbench.overview.approvalsEmpty")}
            </div>
          </section>

          {sections.map(({ key, title, Icon, rows }) => (
            <section key={key} className="rounded-lg border border-hairline bg-surface-1 overflow-hidden">
              <div className="h-10 px-3 flex items-center gap-2 border-b border-hairline">
                <Icon size={14} className="text-accent" />
                <h2 className="m-0 text-[13px] font-semibold text-ink">{title}</h2>
                <span className="ml-auto text-[11px] tabular-nums text-ink-subtle">{rows.length}</span>
              </div>
              <div className="min-h-20">
                {rows.map((run) => <RunRow key={run.id} run={run} companyId={companyId} />)}
                {!rows.length && <div className="p-3 text-[12px] text-ink-subtle">{loading ? <LoaderCircle size={14} className="animate-spin" /> : tr("workbench.overview.empty")}</div>}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
