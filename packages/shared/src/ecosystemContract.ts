import { z } from "zod";

export const ECOSYSTEM_CONTRACT_SCHEMA_VERSION = "1" as const;
const NonEmptyString = z.string().min(1);

export const ActorRefSchema = z.object({
  kind: z.enum(["system", "user", "company", "team", "agent", "tool", "adapter"]),
  id: NonEmptyString,
  name: NonEmptyString.optional(),
  role: NonEmptyString.optional(),
}).passthrough();
export type ActorRef = z.infer<typeof ActorRefSchema>;

export const ExternalSourceRefSchema = z.object({
  host: z.enum(["codex", "claude-code", "acp", "other"]),
  adapterId: NonEmptyString,
  adapterVersion: NonEmptyString.optional(),
  externalEventId: NonEmptyString.optional(),
}).passthrough();
export type ExternalSourceRef = z.infer<typeof ExternalSourceRefSchema>;

export const RunEventTypeSchema = z.enum([
  "run.started", "run.completed", "run.failed", "agent.started", "agent.message",
  "tool.started", "tool.completed", "artifact.created", "approval.requested", "approval.resolved",
]);
export type RunEventType = z.infer<typeof RunEventTypeSchema>;

export const RunEventSchema = z.object({
  schemaVersion: z.literal(ECOSYSTEM_CONTRACT_SCHEMA_VERSION),
  eventId: NonEmptyString,
  runId: NonEmptyString,
  sequence: z.number().int().nonnegative(),
  timestamp: NonEmptyString,
  type: RunEventTypeSchema,
  actor: ActorRefSchema.optional(),
  payload: z.unknown(),
  source: ExternalSourceRefSchema.optional(),
}).passthrough();
export type RunEvent = z.infer<typeof RunEventSchema>;

export const ExternalSessionRefSchema = z.object({
  schemaVersion: z.literal(ECOSYSTEM_CONTRACT_SCHEMA_VERSION),
  host: z.enum(["codex", "claude-code", "acp", "other"]),
  adapterId: NonEmptyString,
  adapterVersion: NonEmptyString.optional(),
  externalSessionId: NonEmptyString.optional(),
  externalTurnId: NonEmptyString.optional(),
  capabilities: z.array(NonEmptyString).default([]),
}).passthrough();
export type ExternalSessionRef = z.infer<typeof ExternalSessionRefSchema>;

export const ApprovalImpactSchema = z.object({
  summary: NonEmptyString,
  resources: z.array(NonEmptyString).default([]),
  permissions: z.array(NonEmptyString).default([]),
}).passthrough();

export const ApprovalRequestSchema = z.object({
  schemaVersion: z.literal(ECOSYSTEM_CONTRACT_SCHEMA_VERSION),
  approvalId: NonEmptyString,
  runId: NonEmptyString,
  action: NonEmptyString,
  impact: ApprovalImpactSchema,
  dataDestinations: z.array(NonEmptyString),
  reversible: z.boolean(),
  source: ActorRefSchema,
  expiresAt: NonEmptyString,
  idempotencyKey: NonEmptyString,
  status: z.enum(["pending", "approved", "rejected", "expired", "cancelled"]).default("pending"),
}).passthrough();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ArtifactVerificationSchema = z.object({
  status: z.enum(["unverified", "verified", "rejected", "degraded", "missing", "unknown"]),
  evidenceRefs: z.array(NonEmptyString).default([]),
  verifiedAt: NonEmptyString.optional(),
  verifiedBy: ActorRefSchema.optional(),
}).passthrough();

export const EcosystemArtifactRefSchema = z.object({
  schemaVersion: z.literal(ECOSYSTEM_CONTRACT_SCHEMA_VERSION),
  artifactId: NonEmptyString,
  name: NonEmptyString,
  mediaType: NonEmptyString.optional(),
  hash: z.string().regex(/^sha256:[a-fA-F0-9]{64}$/).nullable(),
  size: z.number().int().nonnegative().optional(),
  sourceRunId: NonEmptyString,
  producer: ActorRefSchema,
  verification: ArtifactVerificationSchema,
  source: z.object({
    host: z.enum(["codex", "claude-code", "acp", "other"]),
    externalFileId: NonEmptyString.optional(),
    path: NonEmptyString.optional(),
  }).passthrough().optional(),
  downloadUrl: NonEmptyString.optional(),
  summary: z.string().optional(),
}).passthrough();
export type ArtifactRef = z.infer<typeof EcosystemArtifactRefSchema>;

export const AdapterCapabilitiesSchema = z.object({
  streaming: z.boolean(), resume: z.boolean(), fork: z.boolean(), approvals: z.boolean(),
  subagentEvents: z.boolean(), fileCheckpointing: z.boolean(), structuredOutput: z.boolean(),
}).passthrough();
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export const CapabilityNegotiationSchema = z.object({
  schemaVersion: z.literal(ECOSYSTEM_CONTRACT_SCHEMA_VERSION),
  adapterId: NonEmptyString,
  adapterVersion: NonEmptyString,
  host: z.enum(["codex", "claude-code", "acp", "other"]),
  hostVersion: NonEmptyString.optional(),
  compatibleHostVersions: NonEmptyString.optional(),
  capabilities: AdapterCapabilitiesSchema,
  negotiatedAt: NonEmptyString.optional(),
}).passthrough();
export type CapabilityNegotiation = z.infer<typeof CapabilityNegotiationSchema>;

export class EcosystemContractError extends Error {
  readonly code = "invalid_ecosystem_contract";
  constructor(readonly contract: string, readonly issues: string[]) {
    super(`${contract} is invalid: ${issues.join("; ")}`);
    this.name = "EcosystemContractError";
  }
}

function parseOrThrow<TSchema extends z.ZodTypeAny>(
  contract: string,
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new EcosystemContractError(contract, parsed.error.issues.map(
    (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  ));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assertSupportedVersion(contract: string, value: Record<string, unknown>): void {
  if (value.schemaVersion !== undefined && value.schemaVersion !== ECOSYSTEM_CONTRACT_SCHEMA_VERSION) {
    throw new EcosystemContractError(contract, [`schemaVersion: unsupported version ${String(value.schemaVersion)}`]);
  }
}

function legacyRunEventType(type: unknown, payload: Record<string, unknown>): RunEventType {
  switch (type) {
    case "run_started": return "run.started";
    case "run_finished":
      return payload.status === "failed" || payload.finalState === "failed" ? "run.failed" : "run.completed";
    case "agent_status_changed":
    case "model_call_started": return "agent.started";
    case "tool_call": return "tool.started";
    case "tool_result":
    case "model_call_finished":
    case "verifier_result":
    case "review_committed":
    case "quality_gate_result": return "tool.completed";
    case "artifact_created": return "artifact.created";
    case "approval_requested": return "approval.requested";
    case "approval_resolved": return "approval.resolved";
    default: return "agent.message";
  }
}

/** Parse canonical v1 or migrate the persisted pre-v1 TraceEvent shape. */
export function parseRunEvent(value: unknown, fallbackSequence = 0): RunEvent {
  const current = RunEventSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = asRecord(value);
  assertSupportedVersion("RunEvent", legacy);
  const payload = asRecord(legacy.payload);
  const agentId = typeof legacy.agentId === "string" && legacy.agentId ? legacy.agentId : undefined;
  return parseOrThrow("RunEvent", RunEventSchema, {
    schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    eventId: legacy.eventId ?? legacy.id,
    runId: legacy.runId,
    sequence: typeof legacy.sequence === "number" ? legacy.sequence : fallbackSequence,
    timestamp: legacy.timestamp ?? legacy.ts,
    type: legacyRunEventType(legacy.type, payload),
    ...(agentId ? { actor: { kind: "agent", id: agentId } } : {}),
    payload: { legacyType: legacy.type, data: legacy.payload },
  });
}

export function parseRunEvents(values: unknown[]): RunEvent[] {
  return values.map((value, index) => parseRunEvent(value, index));
}

export function parseExternalSessionRef(value: unknown): ExternalSessionRef {
  const current = ExternalSessionRefSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = asRecord(value);
  assertSupportedVersion("ExternalSessionRef", legacy);
  return parseOrThrow("ExternalSessionRef", ExternalSessionRefSchema, {
    ...legacy, schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
  });
}

export function parseApprovalRequest(value: unknown): ApprovalRequest {
  const current = ApprovalRequestSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = asRecord(value);
  assertSupportedVersion("ApprovalRequest", legacy);
  return parseOrThrow("ApprovalRequest", ApprovalRequestSchema, {
    ...legacy,
    schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    approvalId: legacy.approvalId ?? legacy.id ?? legacy.requestId,
    dataDestinations: legacy.dataDestinations ?? legacy.destinations ?? [],
  });
}

function legacyVerificationStatus(value: Record<string, unknown>): z.infer<typeof ArtifactVerificationSchema>["status"] {
  if (value.status === "rejected" || value.reviewStatus === "rejected") return "rejected";
  if (value.status === "degraded" || value.reviewStatus === "degraded") return "degraded";
  if (value.reviewStatus === "accepted" || value.status === "accepted" || typeof value.acceptedBy === "string") return "verified";
  return "unknown";
}

/** Parse v1 or migrate existing RunArtifact/ArtifactRef data without inventing a hash. */
export function parseArtifactRef(value: unknown, fallbackRunId?: string): ArtifactRef {
  const current = EcosystemArtifactRefSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = asRecord(value);
  assertSupportedVersion("ArtifactRef", legacy);
  const producerId = typeof legacy.producer === "string" && legacy.producer
    ? legacy.producer
    : typeof legacy.producedBy === "string" && legacy.producedBy ? legacy.producedBy : "unknown";
  const rawHash = typeof legacy.hash === "string" ? legacy.hash : null;
  const hash = rawHash && /^sha256:[a-fA-F0-9]{64}$/.test(rawHash)
    ? rawHash
    : rawHash && /^[a-fA-F0-9]{64}$/.test(rawHash) ? `sha256:${rawHash}` : null;
  return parseOrThrow("ArtifactRef", EcosystemArtifactRefSchema, {
    schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    artifactId: legacy.artifactId ?? legacy.id,
    name: legacy.name ?? legacy.title,
    mediaType: legacy.mediaType ?? legacy.type ?? legacy.kind,
    hash,
    size: legacy.size,
    sourceRunId: legacy.sourceRunId ?? legacy.runId ?? fallbackRunId,
    producer: { kind: "agent", id: producerId, role: legacy.producerRole },
    verification: {
      status: legacyVerificationStatus(legacy),
      evidenceRefs: Array.isArray(legacy.evidenceRefs) ? legacy.evidenceRefs : [],
    },
    source: legacy.path ? { host: "other", path: legacy.path } : undefined,
    downloadUrl: legacy.downloadUrl,
    summary: legacy.summary ?? legacy.reason,
  });
}

export function parseCapabilityNegotiation(
  value: unknown,
  fallback: { adapterId?: string; adapterVersion?: string; host?: CapabilityNegotiation["host"] } = {},
): CapabilityNegotiation {
  const current = CapabilityNegotiationSchema.safeParse(value);
  if (current.success) return current.data;
  const legacy = asRecord(value);
  assertSupportedVersion("CapabilityNegotiation", legacy);
  const rawCapabilities = asRecord(legacy.capabilities ?? legacy);
  const capability = (key: keyof AdapterCapabilities): boolean => rawCapabilities[key] === true;
  return parseOrThrow("CapabilityNegotiation", CapabilityNegotiationSchema, {
    ...legacy,
    schemaVersion: ECOSYSTEM_CONTRACT_SCHEMA_VERSION,
    adapterId: legacy.adapterId ?? fallback.adapterId ?? "legacy-adapter",
    adapterVersion: legacy.adapterVersion ?? fallback.adapterVersion ?? "unknown",
    host: legacy.host ?? fallback.host ?? "other",
    capabilities: {
      ...rawCapabilities,
      streaming: capability("streaming"), resume: capability("resume"), fork: capability("fork"),
      approvals: capability("approvals"), subagentEvents: capability("subagentEvents"),
      fileCheckpointing: capability("fileCheckpointing"), structuredOutput: capability("structuredOutput"),
    },
  });
}

export function safeParseEcosystemContract<T>(parse: (value: unknown) => T, value: unknown):
  { success: true; data: T } | { success: false; error: EcosystemContractError } {
  try { return { success: true, data: parse(value) }; }
  catch (error) {
    if (error instanceof EcosystemContractError) return { success: false, error };
    throw error;
  }
}
