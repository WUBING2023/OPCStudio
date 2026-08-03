import type { AgentNodeConfig, Company, RunStatus } from "@opc/shared";
import type { BoundCompanyPlanProposal, CompanyPlanSummary, RunIndexDto } from "./types.js";

const RUN_STATUSES = new Set<RunStatus>([
  "pending", "running", "failed", "done", "planned", "blocked",
  "waiting_review", "needs_revision", "accepted", "cancelled",
]);

export function canonicalRunStatus(value: unknown, degraded = false): RunStatus {
  if (typeof value === "string" && RUN_STATUSES.has(value as RunStatus)) {
    return value as RunStatus;
  }
  if (degraded || value === "degraded" || value === "error") return "failed";
  // Unknown lifecycle values must never be rendered as success.
  return "blocked";
}

export const RUN_STATUS_LABEL: Record<RunStatus, string> = {
  pending: "待派发",
  running: "运行中",
  failed: "失败",
  done: "完成",
  planned: "已规划",
  blocked: "已阻断",
  waiting_review: "待审核",
  needs_revision: "需返工",
  accepted: "已验收",
  cancelled: "已取消",
};

export function runStatusTone(status: RunStatus): string {
  if (status === "done" || status === "accepted") return "text-success bg-success/10";
  if (status === "failed" || status === "cancelled") return "text-danger bg-danger/10";
  if (status === "running") return "text-accent bg-accent/10";
  if (status === "waiting_review" || status === "needs_revision") return "text-warning bg-warning/10";
  return "text-ink-muted bg-surface-2";
}

export function selectRunId(rows: RunIndexDto[], requested?: string): string | undefined {
  if (requested && rows.some((row) => row.id === requested)) return requested;
  return rows[0]?.id;
}

export function summarizeCompanyPlan(company: Company | null, agents: AgentNodeConfig[]): CompanyPlanSummary {
  if (!company) {
    return { agentCount: 0, roleCount: 0, verificationEdgeCount: 0, a2aChannelCount: 0, requiredSkillCount: 0 };
  }
  const roster = agents.filter((agent) => (agent.companyId || "default") === company.id);
  return {
    agentCount: roster.length,
    roleCount: new Set(roster.map((agent) => agent.role)).size,
    verificationEdgeCount: company.workflow?.verificationEdges?.length ?? 0,
    a2aChannelCount: company.presetChannels?.length ?? 0,
    requiredSkillCount: company.manifestToolRequirements?.requiredSkills?.length ?? 0,
  };
}

export interface CompanyPlanDifference {
  key: keyof CompanyPlanSummary;
  label: string;
  before: number;
  after: number;
}

const COMPANY_PLAN_FIELDS: Array<{ key: keyof CompanyPlanSummary; label: string }> = [
  { key: "agentCount", label: "员工" },
  { key: "roleCount", label: "角色" },
  { key: "verificationEdgeCount", label: "验证边" },
  { key: "a2aChannelCount", label: "A2A 通道" },
  { key: "requiredSkillCount", label: "必需 Skill" },
];

export function compareCompanyPlan(proposal: BoundCompanyPlanProposal): CompanyPlanDifference[] {
  return COMPANY_PLAN_FIELDS.map(({ key, label }) => ({
    key,
    label,
    before: proposal.before[key],
    after: proposal.after[key],
  }));
}

export function companyPlanBindingError(
  proposal: BoundCompanyPlanProposal,
  expectedCompanyId?: string,
  nowMs = Date.now(),
): string | null {
  if (!proposal.proposalId || !proposal.beforeHash || !proposal.actionsHash) return "提案绑定信息不完整";
  if (proposal.status && proposal.status !== "pending") return `提案状态已变更为 ${proposal.status}，不能再次应用`;
  if (expectedCompanyId && proposal.companyId !== expectedCompanyId) return "提案不属于当前公司";
  const expiresAt = Date.parse(proposal.expiresAt);
  if (!Number.isFinite(expiresAt)) return "提案过期时间无效";
  if (expiresAt <= nowMs) return "提案已过期，请重新生成";
  return null;
}
