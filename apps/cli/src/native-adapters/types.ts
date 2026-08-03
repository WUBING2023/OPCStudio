import type { ApprovalRequest, ExternalSessionRef, NativeRunRequest, RunEvent } from "@opc/shared";

export const NATIVE_ADAPTER_CONTRACT_VERSION = "1" as const;

export type NativeHost = "codex" | "claude-code";
export type NativeOperation = "start" | "resume" | "fork" | "interrupt" | "approval" | "events";
export type NativeRunnerOperation = "start" | "resume" | "fork" | "interrupt";
export type NativeApprovalPolicy = "never" | "on-request";

/**
 * Versioned stdin contract used by the standalone native runner. The shared v1
 * contract remains backward compatible; these additive fields carry lifecycle
 * control without making Server import CLI-private implementations.
 */
export type NativeRunnerRequest = Omit<
  NativeRunRequest,
  "operation" | "approvalPolicy" | "externalSessionId"
> & {
  operation: NativeRunnerOperation;
  approvalPolicy: NativeApprovalPolicy;
  externalSessionId?: string;
  externalTurnId?: string;
  externalSessionRef?: ExternalSessionRef;
};
export type NativeCapabilityState = "supported" | "unsupported" | "unknown";

export interface NativeCapabilityDeclaration {
  state: NativeCapabilityState;
  evidence: string;
}

export type NativeCapabilityDeclarations = Record<NativeOperation, NativeCapabilityDeclaration>;
export type NativeCapabilityFlags = Record<NativeOperation, boolean>;

export interface NativeAdapterProfile {
  schemaVersion: typeof NATIVE_ADAPTER_CONTRACT_VERSION;
  adapterId: string;
  adapterVersion: string;
  host: NativeHost;
  protocol: "codex-app-server-jsonrpc" | "claude-agent-sdk";
  compatibleHostVersions: string;
  capabilities: NativeCapabilityDeclarations;
  methods: Partial<Record<Exclude<NativeOperation, "events" | "approval">, string>>;
}

export interface NativeTransportHello {
  schemaVersion: typeof NATIVE_ADAPTER_CONTRACT_VERSION;
  hostVersion?: string;
  protocolVersion?: string;
  capabilities?: Partial<NativeCapabilityFlags>;
}

export interface NativeTransport {
  readonly kind: string;
  initialize?(profile: NativeAdapterProfile): Promise<NativeTransportHello>;
  request<T = unknown>(method: string, params: unknown): Promise<T>;
  notify?(method: string, params: unknown): void;
  respond?(requestId: string | number, result: unknown): Promise<void>;
  interrupt?(sessionId: string, turnId?: string): Promise<void>;
  close?(): Promise<void>;
}

export interface NativeNegotiation {
  schemaVersion: typeof NATIVE_ADAPTER_CONTRACT_VERSION;
  adapterId: string;
  adapterVersion: string;
  host: NativeHost;
  hostVersion?: string;
  protocolVersion?: string;
  compatibleHostVersions: string;
  compatible: boolean;
  capabilities: NativeCapabilityFlags;
  degradationReason?: "host_version_unverified" | "host_version_incompatible" | "contract_version_incompatible";
  negotiatedAt: string;
}

export interface NativeStartInput {
  runId: string;
  cwd: string;
  prompt: string;
  model?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
}

export interface NativeResumeInput {
  runId: string;
  externalSessionId: string;
  prompt?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
}

export interface NativeForkInput {
  runId: string;
  externalSessionId: string;
  lastTurnId?: string;
  prompt?: string;
  approvalPolicy?: "untrusted" | "on-request" | "never";
}

export interface NativeInterruptInput {
  externalSessionId: string;
  externalTurnId?: string;
}

export interface NativeApprovalDecision {
  approvalId: string;
  decision: "approved" | "approved_for_session" | "rejected" | "cancelled";
}

export interface NativeExecutionRef {
  session: ExternalSessionRef;
  raw: unknown;
}

export interface NativeAdapter {
  readonly profile: NativeAdapterProfile;
  start(input: NativeStartInput): Promise<NativeExecutionRef>;
  resume(input: NativeResumeInput): Promise<NativeExecutionRef>;
  fork(input: NativeForkInput): Promise<NativeExecutionRef>;
  interrupt(input: NativeInterruptInput): Promise<void>;
  resolveApproval(input: NativeApprovalDecision): Promise<void>;
}

export interface NativeEventContext {
  runId: string;
  sequence: number;
  now?: () => string;
}

export interface NativeApprovalContext {
  runId: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface ShadowOutcome {
  status: "completed" | "failed" | "interrupted" | "degraded";
  artifactHashes: string[];
  durationMs: number;
  errorCode?: string;
}

export interface ShadowComparisonRecord {
  schemaVersion: typeof NATIVE_ADAPTER_CONTRACT_VERSION;
  runId: string;
  operation: NativeOperation;
  native: ShadowOutcome;
  fallback: ShadowOutcome;
  equivalent: boolean;
  differences: Array<"status" | "artifact_hashes" | "error_code">;
  durationDeltaMs: number;
  createdAt: string;
}

export type MappedRunEvent = RunEvent;
export type MappedApprovalRequest = ApprovalRequest;
