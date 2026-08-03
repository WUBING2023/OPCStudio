import { useCallback, useEffect, useMemo, useState } from "react";
import { Building2, Check, Circle, FolderOpen, Play, ShieldCheck, Trophy, X, type LucideIcon } from "lucide-react";
import type { Company } from "@opc/shared";
import * as api from "../api/client.js";
import type { DoctorReport } from "./common/DoctorPanel.js";
import { useAgentStore } from "../store/useAgentStore.js";
import { useT } from "../i18n.js";
import { navigateApp, openRun } from "../lib/navigation.js";

const DISMISS_KEY = "opc-tutorial-dismissed";
const TERMINAL = new Set(["done", "completed", "verified", "failed", "error", "degraded", "interrupted", "cancelled"]);

interface RunRow { id: string; companyId?: string; status: string; startedAt?: string }

export default function TutorialHints({ companyId }: { companyId: string }) {
  const tr = useT();
  const events = useAgentStore((state) => state.events);
  const lifecycleVersion = useMemo(() => events.filter((event) => event.type === "run_started" || event.type === "run_finished").length, [events]);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "true"; } catch { return false; }
  });
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);

  const refresh = useCallback(() => {
    Promise.all([
      api.get<Company[]>("/companies").catch(() => []),
      api.get<RunRow[]>("/runs").catch(() => []),
      api.get<DoctorReport>("/doctor").catch(() => null),
    ]).then(([companyRows, runRows, doctorReport]) => {
      setCompanies(companyRows);
      setRuns(runRows);
      setDoctor(doctorReport);
    });
  }, []);
  useEffect(() => { refresh(); }, [refresh, lifecycleVersion, companyId]);
  useEffect(() => {
    const onDoctor = () => refresh();
    window.addEventListener("opc-doctor-updated", onDoctor);
    return () => window.removeEventListener("opc-doctor-updated", onDoctor);
  }, [refresh]);

  if (dismissed) return null;
  const selectedCompany = companies.find((company) => company.id === companyId) || companies[0];
  const selectedCompanyId = selectedCompany?.id || companyId || "default";
  const companyRuns = runs
    .filter((run) => (run.companyId || "default") === selectedCompanyId)
    .sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  const latestResult = companyRuns.find((run) => TERMINAL.has((run.status || "").toLowerCase()));

  const openArchitecture = () => {
    navigateApp({ page: "org", companyId: selectedCompanyId });
    window.setTimeout(() => window.dispatchEvent(new CustomEvent("opc-open-company-architecture", { detail: { companyId: selectedCompanyId } })), 0);
  };
  const steps: Array<{ done: boolean; Icon: LucideIcon; label: string; hint: string; action: () => void }> = [
    {
      done: !!selectedCompany,
      Icon: Building2,
      label: tr("firstRun.company"),
      hint: tr("firstRun.company.hint"),
      action: () => navigateApp({ page: selectedCompany ? "org" : "community", companyId: selectedCompany?.id }),
    },
    {
      done: !!doctor?.checked_at && doctor.status !== "error",
      Icon: ShieldCheck,
      label: tr("firstRun.doctor"),
      hint: tr("firstRun.doctor.hint"),
      action: () => window.dispatchEvent(new CustomEvent("opc-open-doctor")),
    },
    {
      done: !!selectedCompany?.folder,
      Icon: FolderOpen,
      label: tr("firstRun.workspace"),
      hint: tr("firstRun.workspace.hint"),
      action: openArchitecture,
    },
    {
      done: companyRuns.length > 0,
      Icon: Play,
      label: tr("firstRun.mission"),
      hint: tr("firstRun.mission.hint"),
      action: () => navigateApp({ page: "cockpit", companyId: selectedCompanyId }),
    },
    {
      done: !!latestResult,
      Icon: Trophy,
      label: tr("firstRun.result"),
      hint: tr("firstRun.result.hint"),
      action: () => latestResult ? openRun(latestResult.id, selectedCompanyId) : navigateApp({ page: "results", companyId: selectedCompanyId }),
    },
  ];
  const dismiss = () => { try { localStorage.setItem(DISMISS_KEY, "true"); } catch { /* ignore */ } setDismissed(true); };

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-hairline bg-accent/8 text-[11px] overflow-x-auto shrink-0">
      <span className="text-accent font-semibold shrink-0">{tr("firstRun.title")}</span>
      {steps.map((step, index) => (
        <button key={step.label} onClick={step.action} title={step.hint}
          className="h-7 min-w-0 flex items-center gap-1.5 px-2 rounded-md border-none bg-transparent hover:bg-surface-2 text-left cursor-pointer shrink-0">
          {step.done ? <Check size={12} className="text-green shrink-0" /> : <Circle size={11} className="text-ink-subtle shrink-0" />}
          <step.Icon size={12} className={step.done ? "text-ink-muted" : "text-accent"} />
          <span className={step.done ? "text-ink-muted" : "text-ink"}>{index + 1}. {step.label}</span>
          {index < steps.length - 1 && <span className="text-ink-subtle ml-1">→</span>}
        </button>
      ))}
      <button onClick={dismiss} title={tr("onboarding.dismiss")} className="ml-auto shrink-0 w-7 h-7 flex items-center justify-center rounded-md border-none bg-transparent text-ink-subtle hover:bg-surface-2 hover:text-ink cursor-pointer">
        <X size={13} />
      </button>
    </div>
  );
}
