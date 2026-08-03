import type {
  AgentNodeConfig,
  Company,
  Run,
  RunArtifactCollection,
  RunStatus,
} from "@opc/shared";
import type { ExecutionPermissionPostureDto } from "../../components/trace/evidencePermissionTypes.js";

export interface EmbeddedEcosystemRoute {
  runId?: string;
  companyId?: string;
  proposalId?: string;
}

export type GovernanceDecision = "approve" | "reject";

export interface CompanyPlanSummary {
  agentCount: number;
  roleCount: number;
  verificationEdgeCount: number;
  a2aChannelCount: number;
  requiredSkillCount: number;
}

/**
 * A host may pass a proposal into the embedded comparison surface only after
 * obtaining it from OPC Studio. The hashes and expiry are presentation-time
 * bindings; the server remains authoritative when the proposal is applied.
 */
export interface BoundCompanyPlanProposal {
  proposalId: string;
  companyId: string;
  summary: string;
  beforeHash: string;
  actionsHash: string;
  expiresAt: string;
  status?: "pending" | "applying" | "applied" | "failed" | "rolled_back";
  before: CompanyPlanSummary;
  after: CompanyPlanSummary;
  risks?: string[];
}

export interface CompanyPlanApplyOutcome {
  applied: boolean;
  requiresConfirmation?: boolean;
  confirmationReceipt?: string;
  receiptExpiresAt?: string;
  highRisk?: string[];
}

export type EcosystemConfirmationIntent =
  | {
      kind: "governance-decision";
      runId: string;
      decision: GovernanceDecision;
      createsRun: false;
    }
  | {
      kind: "company-plan-apply";
      proposalId: string;
      companyId: string;
      beforeHash: string;
      actionsHash: string;
      expiresAt: string;
      createsRun: false;
    };

export interface RunIndexDto {
  id: string;
  goal?: string;
  status?: string;
  degraded?: boolean;
  degradedReason?: string;
  startedAt?: string;
  endedAt?: string;
  totalTokens?: number;
  companyId?: string;
}

export interface GovernanceRecordDto {
  runId: string;
  level: string;
  reason: string[];
  decidedAt: string;
  approvalRequired?: boolean;
  approval?: {
    status: "pending" | "approved" | "rejected";
    decidedAt?: string;
    decidedBy?: string;
  };
  inputs?: { goalPreview?: string; companyId?: string };
}

export interface EvidenceFileDto {
  path: string;
  kind: string;
  sha256: string;
  size: number;
}

export interface EvidenceManifestDto {
  schemaVersion: number;
  runId: string;
  generatedAt: string;
  files: EvidenceFileDto[];
  workspaceChanges: Array<{ path: string; changeType: string | null }> | null;
  artifactDownloads: Array<{ artifactId: string; downloadUrl?: string; hash?: string; size?: number }> | null;
  tests: Array<{ command: string; passed: boolean; independent?: boolean }> | null;
  evidenceComplete?: boolean;
  permissionPosture?: ExecutionPermissionPostureDto;
}

export interface ArtifactPreviewDto {
  content: string;
  contentType: string;
  filename: string;
  truncated: boolean;
  totalBytes: number;
  previewBytes: number;
}

export interface EmbeddedRunView {
  run: Run;
  status: RunStatus;
  goal: string;
}

export interface EmbeddedEcosystemSnapshot {
  runs: RunIndexDto[];
  selectedRun: EmbeddedRunView | null;
  approvals: GovernanceRecordDto[];
  artifacts: RunArtifactCollection | null;
  evidence: EvidenceManifestDto | null;
  companies: Company[];
  agents: AgentNodeConfig[];
  selectedCompany: Company | null;
  companyPlan: BoundCompanyPlanProposal | null;
}
