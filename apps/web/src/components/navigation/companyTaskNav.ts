import type { Company } from "@opc/shared";

export interface CompanyTaskRun {
  id: string;
  goal: string;
  status: string;
  startedAt: string;
  companyId?: string;
  degraded?: boolean;
}

export interface CompanyTaskGroup {
  company: Company;
  runs: CompanyTaskRun[];
  total: number;
}

const ACTIVE_STATUSES = new Set(["queued", "pending", "running"]);

export function isActiveCompanyTask(status: string): boolean {
  return ACTIVE_STATUSES.has((status || "").toLowerCase());
}

export function taskStatusTone(run: Pick<CompanyTaskRun, "status" | "degraded">): "active" | "success" | "warning" | "error" | "neutral" {
  if (isActiveCompanyTask(run.status)) return "active";
  if (run.degraded) return "warning";
  const status = (run.status || "").toLowerCase();
  if (status === "done" || status === "completed" || status === "verified") return "success";
  if (status === "failed" || status === "error" || status === "interrupted") return "error";
  if (status === "degraded" || status === "deferred") return "warning";
  return "neutral";
}

export function groupCompanyTasks(companies: Company[], runs: CompanyTaskRun[], limit = 4): CompanyTaskGroup[] {
  const safeLimit = Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 4));
  return companies.map((company) => {
    const companyRuns = runs
      .filter((run) => run.companyId === company.id)
      .sort((a, b) => {
        const activeDelta = Number(isActiveCompanyTask(b.status)) - Number(isActiveCompanyTask(a.status));
        return activeDelta || (b.startedAt || "").localeCompare(a.startedAt || "");
      });
    return { company, runs: companyRuns.slice(0, safeLimit), total: companyRuns.length };
  });
}
