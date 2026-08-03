import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Building2,
  ChevronDown,
  ChevronRight,
  FolderKanban,
  List,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
} from "lucide-react";
import type { Company } from "@opc/shared";
import * as api from "../../api/client.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";
import { cleanText } from "../../lib/text.js";
import { groupCompanyTasks, taskStatusTone, type CompanyTaskRun } from "./companyTaskNav.js";

const RECENT_PROJECT_LIMIT = 4;
const PROJECT_PAGE_SIZE = 8;
const ALL_COMPANIES = "all";

const TONE_CLASS = {
  active: "bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-accent)_18%,transparent)]",
  success: "bg-green",
  warning: "bg-amber",
  error: "bg-red",
  neutral: "bg-ink-subtle",
} as const;

interface CompanyProjectSidebarProps {
  collapsed: boolean;
  activeCompanyId: string;
  selectedRunId: string | null;
  onToggle: () => void;
  onSelectCompany: (companyId: string) => void;
  onOpenRun: (runId: string, companyId: string) => void;
  onViewAll: (companyId: string) => void;
  onNewProject: (companyId: string) => void;
}

export default function CompanyTaskSidebar({
  collapsed,
  activeCompanyId,
  selectedRunId,
  onToggle,
  onSelectCompany,
  onOpenRun,
  onViewAll,
  onNewProject,
}: CompanyProjectSidebarProps) {
  const tr = useT();
  const events = useAgentStore((state) => state.events);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<CompanyTaskRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>(() => (
    activeCompanyId === ALL_COMPANIES ? {} : { [activeCompanyId]: true }
  ));
  const [visibleProjectLimits, setVisibleProjectLimits] = useState<Record<string, number>>({});
  const loadSeq = useRef(0);
  const seenEvents = useRef(events.length);

  const refresh = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const [companyRows, runRows] = await Promise.all([
        api.get<Company[]>("/companies"),
        api.get<CompanyTaskRun[]>("/runs"),
      ]);
      if (seq !== loadSeq.current) return;
      setCompanies(companyRows || []);
      setRuns(runRows || []);
    } catch {
      if (seq !== loadSeq.current) return;
      setCompanies([]);
      setRuns([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const fresh = events.slice(seenEvents.current);
    seenEvents.current = events.length;
    if (fresh.some((event) => event.type === "run_started" || event.type === "run_finished")) void refresh(true);
  }, [events, refresh]);
  useEffect(() => {
    if (!activeCompanyId || activeCompanyId === ALL_COMPANIES) return;
    setExpandedCompanies((current) => ({ ...current, [activeCompanyId]: true }));
  }, [activeCompanyId]);

  const groups = useMemo(
    () => groupCompanyTasks(companies, runs, Math.max(RECENT_PROJECT_LIMIT, runs.length)),
    [companies, runs],
  );
  const totalProjects = useMemo(() => groups.reduce((sum, group) => sum + group.total, 0), [groups]);

  if (collapsed) {
    return (
      <aside className="w-[52px] shrink-0 border-r border-hairline bg-surface-0 flex flex-col items-center py-2">
        <button
          onClick={onToggle}
          title={tr("sidebar.projects.expandPanel")}
          aria-label={tr("sidebar.projects.expandPanel")}
          className="w-8 h-8 flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink cursor-pointer"
        >
          <PanelLeftOpen size={16} />
        </button>
        <button
          onClick={onToggle}
          title={tr("sidebar.projects")}
          className="mt-2 w-8 h-8 flex items-center justify-center rounded-lg border-none bg-accent/10 text-accent cursor-pointer"
        >
          <FolderKanban size={16} />
        </button>
      </aside>
    );
  }

  return (
    <aside className="w-[252px] shrink-0 border-r border-hairline bg-surface-0 flex flex-col min-h-0" aria-label={tr("sidebar.projects")}>
      <div className="h-[52px] px-3 flex items-center gap-2 border-b border-hairline shrink-0">
        <FolderKanban size={16} className="text-accent shrink-0" />
        <span className="min-w-0 flex-1 text-[13px] font-semibold text-ink truncate">{tr("sidebar.projects")}</span>
        {loading && <LoaderCircle size={13} className="animate-spin text-ink-subtle" />}
        <button
          onClick={onToggle}
          title={tr("sidebar.projects.collapsePanel")}
          aria-label={tr("sidebar.projects.collapsePanel")}
          className="w-7 h-7 flex items-center justify-center rounded-md border-none bg-transparent text-ink-subtle hover:bg-surface-2 hover:text-ink cursor-pointer"
        >
          <PanelLeftClose size={15} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <button
          onClick={() => onSelectCompany(ALL_COMPANIES)}
          className={`w-full h-8 px-2 mb-1 flex items-center gap-2 rounded-lg border-none text-left cursor-pointer transition-colors ${
            activeCompanyId === ALL_COMPANIES ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2/60 hover:text-ink"
          }`}
        >
          <List size={14} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{tr("sidebar.projects.all")}</span>
          <span className="text-[10px] tabular-nums text-ink-subtle">{totalProjects}</span>
        </button>

        {!loading && groups.length === 0 && (
          <button
            onClick={() => onNewProject("default")}
            className="w-full px-2 py-2 flex items-center gap-2 rounded-lg border-none bg-transparent text-left text-[12px] text-ink-muted hover:bg-surface-2 cursor-pointer"
          >
            <Building2 size={13} className="shrink-0" />
            <span>{tr("sidebar.company.create")}</span>
          </button>
        )}

        <div className="flex flex-col gap-0.5">
          {groups.map(({ company, runs: allRuns, total }) => {
            const open = expandedCompanies[company.id] ?? false;
            const selectedCompany = activeCompanyId === company.id;
            const visibleLimit = visibleProjectLimits[company.id] ?? RECENT_PROJECT_LIMIT;
            const recentRuns = allRuns.slice(0, visibleLimit);
            const remaining = Math.max(0, total - recentRuns.length);
            return (
              <div key={company.id}>
                <div className={`group flex items-center rounded-lg transition-colors ${selectedCompany ? "bg-surface-2" : "hover:bg-surface-2/60"}`}>
                  <button
                    onClick={() => setExpandedCompanies((current) => ({ ...current, [company.id]: !open }))}
                    title={open ? tr("sidebar.company.collapse") : tr("sidebar.company.expand")}
                    aria-expanded={open}
                    className="w-7 h-8 shrink-0 flex items-center justify-center border-none bg-transparent text-ink-subtle hover:text-ink cursor-pointer"
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button
                    onClick={() => {
                      setExpandedCompanies((current) => ({ ...current, [company.id]: true }));
                      onSelectCompany(company.id);
                    }}
                    title={company.description ? `${company.name} - ${company.description}` : company.name}
                    className={`min-w-0 flex-1 h-8 pr-1 flex items-center gap-1.5 border-none bg-transparent text-left cursor-pointer ${selectedCompany ? "text-ink" : "text-ink-muted"}`}
                  >
                    <span className="truncate text-[12px] font-medium">{company.name}</span>
                    {total > 0 && <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-subtle">{total}</span>}
                  </button>
                  <button
                    onClick={() => onNewProject(company.id)}
                    title={tr("sidebar.newTaskFor", { company: company.name })}
                    className="w-7 h-8 shrink-0 flex items-center justify-center border-none bg-transparent text-ink-subtle opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-accent cursor-pointer transition-opacity"
                  >
                    <Plus size={13} />
                  </button>
                </div>

                {open && (
                  <div className="ml-3.5 pl-3 border-l border-hairline py-0.5">
                    {recentRuns.length === 0 ? (
                      <button
                        onClick={() => onNewProject(company.id)}
                        className="w-full min-h-7 px-1.5 flex items-center gap-1.5 border-none bg-transparent text-left text-[11px] text-ink-subtle hover:text-ink cursor-pointer"
                      >
                        <Plus size={11} className="shrink-0" />
                        <span>{tr("sidebar.company.noTasks")}</span>
                      </button>
                    ) : recentRuns.map((run) => {
                      const tone = taskStatusTone(run);
                      const selectedProject = selectedRunId === run.id;
                      return (
                        <button
                          key={run.id}
                          onClick={() => onOpenRun(run.id, company.id)}
                          title={cleanText(run.goal) || run.id}
                          className={`w-full min-h-7 px-1.5 flex items-center gap-2 rounded-md border-none text-left cursor-pointer transition-colors ${
                            selectedProject ? "bg-accent/10 text-accent" : "bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink"
                          }`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${TONE_CLASS[tone]} ${tone === "active" ? "animate-pulse" : ""}`} />
                          <span className="min-w-0 flex-1 truncate text-[11px]">{cleanText(run.goal) || tr("trace.untitledGoal")}</span>
                        </button>
                      );
                    })}
                    {remaining > 0 && (
                      <button
                        onClick={() => {
                          setVisibleProjectLimits((current) => ({
                            ...current,
                            [company.id]: Math.min(total, visibleLimit + PROJECT_PAGE_SIZE),
                          }));
                          onViewAll(company.id);
                        }}
                        className="w-full min-h-7 px-1.5 flex items-center gap-2 rounded-md border-none bg-transparent text-left text-[11px] font-medium text-ink-subtle hover:bg-surface-2 hover:text-accent cursor-pointer transition-colors"
                      >
                        <ScrollText size={11} className="shrink-0" />
                        <span className="truncate">{tr("sidebar.company.olderTasks", { count: remaining })}</span>
                      </button>
                    )}
                    {visibleLimit > RECENT_PROJECT_LIMIT && (
                      <button
                        onClick={() => setVisibleProjectLimits((current) => ({ ...current, [company.id]: RECENT_PROJECT_LIMIT }))}
                        className="w-full min-h-7 px-1.5 flex items-center gap-2 rounded-md border-none bg-transparent text-left text-[11px] text-ink-subtle hover:bg-surface-2 hover:text-accent cursor-pointer transition-colors"
                      >
                        <ChevronRight size={11} className="shrink-0 -rotate-90" />
                        <span>{tr("sidebar.company.collapseProjects", { count: RECENT_PROJECT_LIMIT })}</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}