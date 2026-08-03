import { useMemo, type ReactNode } from "react";
import { Download, FileClock, Files, ListTodo, X } from "lucide-react";
import type { RunArtifact } from "@opc/shared";
import { useT } from "../../i18n.js";
import { openRun } from "../../lib/navigation.js";

export interface CockpitRunRow {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  totalTokens?: number;
  companyId?: string;
  agentIds?: string[];
}

export type TaskContextPanel = "tasks" | "files" | null;

function statusTone(status: string): string {
  if (status === "done" || status === "accepted") return "bg-green";
  if (status === "failed" || status === "cancelled") return "bg-red";
  if (status === "running") return "bg-accent";
  return "bg-amber";
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function taskShortLabel(run: CockpitRunRow | undefined): string {
  const goal = run?.goal?.trim();
  return goal ? (goal.length > 22 ? goal.slice(0, 22) + "…" : goal) : "Task";
}

export default function TaskContextNavigator({ runs, selectedRunId, onSelect, panel, onPanelChange, artifacts, artifactsLoading, allowConversation = false, children }: {
  runs: CockpitRunRow[];
  selectedRunId: string | null;
  onSelect: (runId: string | null) => void;
  panel: TaskContextPanel;
  onPanelChange: (panel: TaskContextPanel) => void;
  artifacts: RunArtifact[];
  artifactsLoading: boolean;
  allowConversation?: boolean;
  children: ReactNode;
}) {
  const tr = useT();
  const selected = runs.find((run) => run.id === selectedRunId);
  const downloadable = useMemo(() => artifacts.filter((artifact) => artifact.downloadUrl), [artifacts]);
  return (
    <div className="relative flex-1 min-h-0 overflow-hidden">
      {children}
      <div className="absolute top-2 right-3 z-20 flex items-center gap-1 rounded-lg border border-hairline bg-surface-0/95 p-1 shadow-sm backdrop-blur">
        <button type="button" onClick={() => onPanelChange(panel === "files" ? null : "files")} title={tr("cockpit.taskContext.filesHint")}
          className={"inline-flex h-7 items-center gap-1 rounded-md border-none px-2 text-[11px] cursor-pointer transition-colors " + (panel === "files" ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2")}>
          <FileClock size={13} />{tr("cockpit.taskContext.files")}
        </button>
        <button type="button" onClick={() => onPanelChange(panel === "tasks" ? null : "tasks")} title={tr("cockpit.taskContext.tasksHint")}
          className={"inline-flex h-7 items-center gap-1 rounded-md border-none px-2 text-[11px] cursor-pointer transition-colors " + (panel === "tasks" ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2")}>
          <ListTodo size={13} />{tr("cockpit.taskContext.tasks")}
        </button>
      </div>
      {runs.length > 0 && (
        <div className="absolute right-2 top-12 bottom-3 z-10 flex w-9 flex-col items-end justify-center gap-2 overflow-y-auto py-2" aria-label={tr("cockpit.taskContext.rail")}>
          {runs.map((run) => {
            const active = run.id === selectedRunId;
            const title = (run.goal || run.id) + " · " + run.status + (run.startedAt ? " · " + when(run.startedAt) : "");
            return <button key={run.id} type="button" onClick={() => onSelect(run.id)} title={title} aria-label={run.goal || run.id}
              className={"shrink-0 rounded-full border-none cursor-pointer transition-all duration-300 " + (active ? "w-8 h-[3px] bg-ink" : "w-5 h-0.5 bg-ink-subtle hover:w-7 hover:bg-ink-muted")} />;
          })}
        </div>
      )}
      {panel && (
        <div className="absolute z-30 top-12 right-12 w-[min(360px,calc(100%-64px))] max-h-[calc(100%-64px)] overflow-hidden rounded-xl border border-hairline bg-surface-0 shadow-xl flex flex-col">
          <div className="h-10 shrink-0 flex items-center gap-2 border-b border-hairline px-3">
            {panel === "tasks" ? <ListTodo size={14} /> : <Files size={14} />}
            <span className="text-[12px] font-semibold text-ink flex-1">{panel === "tasks" ? tr("cockpit.taskContext.taskHistory") : tr("cockpit.taskContext.fileHistory")}</span>
            <button type="button" onClick={() => onPanelChange(null)} title={tr("common.close")} className="w-7 h-7 inline-flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer"><X size={13} /></button>
          </div>
          {panel === "tasks" ? (
            <div className="overflow-y-auto p-2 flex flex-col gap-1">
              {allowConversation && (
                <button type="button" onClick={() => { onSelect(null); onPanelChange(null); }} className={"w-full rounded-lg border px-3 py-2 text-left cursor-pointer " + (selectedRunId === null ? "border-accent bg-accent/5" : "border-transparent bg-surface-1 hover:bg-surface-2")}>
                  <div className="text-[12px] font-medium text-ink">{tr("cockpit.taskContext.directChat")}</div>
                  <div className="mt-0.5 text-[10px] text-ink-subtle">{tr("cockpit.taskContext.directChatHint")}</div>
                </button>
              )}
              {runs.map((run) => (
                <button key={run.id} type="button" onClick={() => { onSelect(run.id); onPanelChange(null); }} title={run.goal}
                  className={"w-full rounded-lg border px-3 py-2 text-left cursor-pointer transition-colors " + (run.id === selectedRunId ? "border-accent bg-accent/5" : "border-transparent bg-surface-1 hover:bg-surface-2")}>
                  <div className="flex items-center gap-2"><span className={"w-1.5 h-1.5 rounded-full shrink-0 " + statusTone(run.status)} /><span className="min-w-0 flex-1 text-[12px] font-medium text-ink line-clamp-2">{run.goal || run.id}</span></div>
                  <div className="mt-1 flex items-center gap-2 pl-3.5 text-[10px] text-ink-subtle"><span>{run.status}</span><span>{when(run.startedAt)}</span>{typeof run.totalTokens === "number" && <span>{run.totalTokens.toLocaleString()} tok</span>}</div>
                </button>
              ))}
              {!runs.length && <div className="px-2 py-6 text-center text-[11px] text-ink-subtle">{tr("cockpit.taskContext.noTasks")}</div>}
            </div>
          ) : (
            <div className="overflow-y-auto p-3">
              <div className="mb-2 rounded-lg bg-surface-1 px-3 py-2"><div className="text-[10px] text-ink-subtle">{tr("cockpit.taskContext.currentTask")}</div><div className="mt-0.5 text-[12px] font-medium text-ink line-clamp-2">{selected?.goal || tr("cockpit.taskContext.selectTask")}</div></div>
              {artifactsLoading ? <div className="py-6 text-center text-[11px] text-ink-subtle">{tr("cockpit.loadingEllipsis")}</div> : artifacts.length ? (
                <div className="flex flex-col gap-1.5">
                  {artifacts.map((artifact) => (
                    <div key={artifact.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-surface-1 px-2.5 py-2">
                      <div className="min-w-0 flex-1"><div className="truncate text-[11px] font-medium text-ink" title={artifact.title}>{artifact.title}</div><div className="mt-0.5 text-[9px] text-ink-subtle">{artifact.kind}{artifact.producer ? " · @" + artifact.producer : ""}{artifact.reviewStatus ? " · " + artifact.reviewStatus : ""}</div></div>
                      {artifact.downloadUrl ? <a href={artifact.downloadUrl} download title={tr("cockpit.downloadFile")} className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md text-accent hover:bg-accent/10"><Download size={13} /></a> : selectedRunId ? <button type="button" onClick={() => openRun(selectedRunId)} title={tr("org.ceo.failure.viewRun")} className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted hover:bg-surface-2 cursor-pointer"><Files size={13} /></button> : null}
                    </div>
                  ))}
                  {downloadable.length === 0 && <div className="pt-1 text-[10px] text-ink-subtle">{tr("cockpit.taskContext.noDownloadable")}</div>}
                </div>
              ) : <div className="py-6 text-center text-[11px] text-ink-subtle">{tr("cockpit.taskContext.noFiles")}</div>}
              {selectedRunId && <button type="button" onClick={() => openRun(selectedRunId)} className="mt-3 w-full rounded-lg border border-hairline bg-surface-1 py-2 text-[11px] font-medium text-accent cursor-pointer hover:bg-surface-2">{tr("org.ceo.failure.viewRun")}</button>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
