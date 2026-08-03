import type { GovernanceRecordLite } from "../../../api/client.js";

export interface WorkbenchRun {
  id: string;
  goal: string;
  status: string;
  companyId?: string;
  startedAt?: string;
  endedAt?: string;
  degraded?: boolean;
}

export interface WorkbenchOverviewData {
  running: WorkbenchRun[];
  approvals: GovernanceRecordLite[];
  recentSessions: WorkbenchRun[];
  recentResults: WorkbenchRun[];
}

const ACTIVE = new Set(["queued", "pending", "running"]);
const TERMINAL = new Set(["done", "completed", "verified", "failed", "error", "degraded", "interrupted", "cancelled"]);

function newestFirst(a: WorkbenchRun, b: WorkbenchRun): number {
  return (b.endedAt || b.startedAt || "").localeCompare(a.endedAt || a.startedAt || "");
}

export function buildWorkbenchOverview(
  runs: WorkbenchRun[],
  approvals: GovernanceRecordLite[],
  companyId: string,
  limit = 5,
): WorkbenchOverviewData {
  const scoped = runs
    .filter((run) => companyId === "all" || (run.companyId || "default") === companyId)
    .sort(newestFirst);
  return {
    running: scoped.filter((run) => ACTIVE.has((run.status || "").toLowerCase())).slice(0, limit),
    approvals: approvals.filter((record) =>
      record.approvalRequired
      && (record.approval?.status ?? "pending") === "pending"
      && (companyId === "all" || (record.inputs?.companyId || "default") === companyId),
    ).slice(0, limit),
    recentSessions: scoped.slice(0, limit),
    recentResults: scoped.filter((run) => TERMINAL.has((run.status || "").toLowerCase())).slice(0, limit),
  };
}
