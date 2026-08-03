import type { AgentNodeConfig, Company, Run, RunArtifactCollection } from "@opc/shared";
import { get, post, type ApiError } from "../../api/client.js";
import { canonicalRunStatus, selectRunId } from "./model.js";
import type {
  ArtifactPreviewDto,
  EmbeddedEcosystemRoute,
  EmbeddedEcosystemSnapshot,
  EvidenceManifestDto,
  BoundCompanyPlanProposal,
  CompanyPlanApplyOutcome,
  EcosystemConfirmationIntent,
  GovernanceRecordDto,
  GovernanceDecision,
  RunIndexDto,
} from "./types.js";

export interface ReadonlyHttpClient {
  get<T>(path: string): Promise<T>;
}

export interface EcosystemHttpClient extends ReadonlyHttpClient {
  post?<T>(path: string, body: unknown): Promise<T>;
}

export const ecosystemHttpClient: EcosystemHttpClient = { get, post };

function encoded(value: string): string {
  return encodeURIComponent(value);
}

export async function loadArtifactPreview(
  client: ReadonlyHttpClient,
  runId: string,
  artifactId: string,
): Promise<ArtifactPreviewDto> {
  return client.get<ArtifactPreviewDto>(
    `/runs/${encoded(runId)}/artifacts/preview?artifactId=${encoded(artifactId)}`,
  );
}

export async function submitGovernanceDecision(
  client: EcosystemHttpClient,
  runId: string,
  decision: GovernanceDecision,
): Promise<GovernanceRecordDto> {
  if (!client.post) throw new Error("当前宿主未提供安全确认通道，请在 OPC Studio 正式详情中审批");
  const response = await client.post<{ record: GovernanceRecordDto }>(
    `/governance/runs/${encoded(runId)}/${decision}`,
    { decidedBy: "embedded-ui" },
  );
  return response.record;
}

interface CompanyPlanProposalDto {
  proposalId: string;
  companyId: string;
  summary: string;
  beforeHash: string;
  actionsHash: string;
  expiresAt: string;
  status: BoundCompanyPlanProposal["status"];
  preview: {
    before: BoundCompanyPlanProposal["before"];
    after: BoundCompanyPlanProposal["after"];
    risks?: string[];
  };
}

export async function loadCompanyPlanProposal(
  client: ReadonlyHttpClient,
  companyId: string,
  proposalId: string,
): Promise<BoundCompanyPlanProposal> {
  const value = await client.get<CompanyPlanProposalDto>(
    `/companies/${encoded(companyId)}/architect-proposals/${encoded(proposalId)}`,
  );
  return {
    proposalId: value.proposalId,
    companyId: value.companyId,
    summary: value.summary,
    beforeHash: value.beforeHash,
    actionsHash: value.actionsHash,
    expiresAt: value.expiresAt,
    status: value.status,
    before: value.preview.before,
    after: value.preview.after,
    risks: value.preview.risks,
  };
}

export async function submitCompanyPlanApply(
  client: EcosystemHttpClient,
  intent: Extract<EcosystemConfirmationIntent, { kind: "company-plan-apply" }>,
  confirmationReceipt?: string,
): Promise<CompanyPlanApplyOutcome> {
  if (!client.post) throw new Error("当前宿主未提供安全确认通道，请在 OPC Studio 正式详情中应用");
  try {
    await client.post(
      `/companies/${encoded(intent.companyId)}/architect-apply`,
      { proposalId: intent.proposalId, ...(confirmationReceipt ? { confirmationToken: confirmationReceipt } : {}) },
    );
    return { applied: true };
  } catch (error) {
    const apiError = error as ApiError;
    const body = apiError?.body && typeof apiError.body === "object" ? apiError.body as Record<string, unknown> : {};
    if (apiError?.status === 428 && typeof body.confirmationToken === "string") {
      const risks = Array.isArray(body.highRisk)
        ? body.highRisk.map(value => typeof value === "string" ? value : String((value as { kind?: unknown })?.kind ?? "high-risk change"))
        : [];
      return {
        applied: false,
        requiresConfirmation: true,
        confirmationReceipt: body.confirmationToken,
        receiptExpiresAt: typeof body.tokenExpiresAt === "string" ? body.tokenExpiresAt : undefined,
        highRisk: risks,
      };
    }
    throw error;
  }
}

export async function loadEmbeddedEcosystemSnapshot(
  client: ReadonlyHttpClient,
  route: EmbeddedEcosystemRoute,
): Promise<EmbeddedEcosystemSnapshot> {
  const [runs, approvals, companies, agents] = await Promise.all([
    client.get<RunIndexDto[]>("/runs"),
    client.get<GovernanceRecordDto[]>("/governance/records?limit=50"),
    client.get<Company[]>("/companies"),
    client.get<AgentNodeConfig[]>("/agents"),
  ]);
  const runId = selectRunId(runs, route.runId);
  const selectedIndex = runs.find((row) => row.id === runId);
  const requestedCompanyId = route.companyId || selectedIndex?.companyId;
  const selectedCompany = companies.find((company) => company.id === requestedCompanyId) ?? companies[0] ?? null;

  if (!runId) {
    const companyPlan = route.proposalId && selectedCompany
      ? await loadCompanyPlanProposal(client, selectedCompany.id, route.proposalId)
      : null;
    return { runs, approvals, companies, agents, selectedCompany, selectedRun: null, artifacts: null, evidence: null, companyPlan };
  }

  const [run, artifacts, evidence, companyPlan] = await Promise.all([
    client.get<Run>(`/runs/${encoded(runId)}`),
    client.get<RunArtifactCollection>(`/runs/${encoded(runId)}/artifacts`),
    client.get<EvidenceManifestDto>(`/runs/${encoded(runId)}/evidence`),
    route.proposalId && selectedCompany
      ? loadCompanyPlanProposal(client, selectedCompany.id, route.proposalId)
      : Promise.resolve(null),
  ]);
  const status = canonicalRunStatus(run.status, run.degraded);
  return {
    runs,
    approvals,
    companies,
    agents,
    selectedCompany,
    selectedRun: { run, status, goal: run.userGoal || selectedIndex?.goal || "" },
    artifacts,
    evidence,
    companyPlan,
  };
}
