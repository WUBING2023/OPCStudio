import { createHash } from "node:crypto";
import type { CompanyTemplate, FieldSpec, FidelityLedger, TransformKind } from "@opc/shared";
import {
  AGENT_FIELD_REGISTRY,
  COMPANY_TEMPLATE_FIELD_REGISTRY,
  buildLedger,
  deepEqual,
} from "@opc/shared";
import { redactSecrets } from "../security/redact.js";
import { persistSemanticFidelityReport } from "../storage/semanticFidelityStore.js";

export const SEMANTIC_FIDELITY_SCHEMA_VERSION = "2" as const;

export type SemanticFidelityOperation = "import" | "merge" | "restore";
export type RuntimeProofLevel = "not-collected" | "declarative" | "readiness" | "observed";
export type RuntimeSemanticStatus =
  | "equivalent"
  | "declarative-match"
  | "transformed-not-proven"
  | "degraded"
  | "not-collected";
export type RuntimeSemanticDimension =
  | "provider-engine-model"
  | "agent-availability"
  | "permissions"
  | "mcp"
  | "verification-edges"
  | "a2a"
  | "working-directory"
  | "visibility"
  | "memory-scope"
  | "runtime-readiness";

export interface RuntimeSemanticCheck {
  dimension: RuntimeSemanticDimension;
  status: RuntimeSemanticStatus;
  proofLevel: RuntimeProofLevel;
  sourceDeclarationHash?: string;
  targetDeclarationHash?: string;
  details: string[];
}

export interface RuntimeSemanticFidelity {
  status: RuntimeSemanticStatus;
  proofLevel: RuntimeProofLevel;
  equivalent: boolean;
  checks: RuntimeSemanticCheck[];
  transformedNotProven: RuntimeSemanticDimension[];
  degraded: RuntimeSemanticDimension[];
  notCollected: RuntimeSemanticDimension[];
}

export interface FieldFidelitySummary {
  status: "ok" | "failed";
  ok: boolean;
  preserved: string[];
  transformed: string[];
  redacted: string[];
  requiresLocalSetup: string[];
  lost: string[];
  lostCount: number;
}

export interface SemanticFidelityReport {
  schemaVersion: typeof SEMANTIC_FIDELITY_SCHEMA_VERSION;
  operation: SemanticFidelityOperation;
  sourceSchemaVersion: string;
  targetSchemaVersion: string;
  preserved: string[];
  transformed: string[];
  redacted: string[];
  requiresLocalSetup: string[];
  lost: string[];
  lostCount: number;
  /** Field preservation only. This must never be read as runtime equivalence. */
  ok: boolean;
  fieldFidelity: FieldFidelitySummary;
  runtimeSemantics: RuntimeSemanticFidelity;
  runtimeEquivalent: boolean;
  reportHash: string;
}

export interface RuntimeBindingPlanEvidence {
  originalBinding: { kind: "provider" | "model" | "engine" | "mcp"; name: string; provider?: string };
  status: "available" | "missing" | "incompatible";
  action: "keep" | "map" | "configure" | "disable";
  targetBinding?: { engine?: string; provider?: string; model?: string };
  reason?: string;
  userApproved: boolean;
}

export interface RuntimeMissingCapabilityEvidence {
  kind: "provider" | "model" | "engine" | "mcp";
  name: string;
  reason?: string;
}

export interface RuntimeSemanticEvidence {
  bindingPlans?: RuntimeBindingPlanEvidence[];
  missingCapabilities?: RuntimeMissingCapabilityEvidence[];
  /** Only an execution verifier may set observed. Import routes use declarative evidence. */
  proofLevel?: RuntimeProofLevel;
  readiness?: { status: "ready" | "missing" | "not-collected"; details?: string[] };
}

export interface SemanticFidelityOverrides {
  preserved?: string[];
  transformed?: string[];
  redacted?: string[];
  requiresLocalSetup?: string[];
  lost?: string[];
  /** Safe Install 中进入逐项确认/降权队列的字段。 */
  approvedAfterImport?: string[];
}

export interface BuildSemanticFidelityInput {
  operation: SemanticFidelityOperation;
  sourceSchemaVersion: string;
  runtime?: RuntimeSemanticEvidence;
  targetSchemaVersion: string;
  source: CompanyTemplate;
  target: CompanyTemplate;
  overrides?: SemanticFidelityOverrides;
}

export interface FinalizeSemanticFidelityInput extends BuildSemanticFidelityInput {
  projectRoot: string;
}

export class SemanticFidelityError extends Error {
  readonly report: SemanticFidelityReport;

  constructor(report: SemanticFidelityReport) {
    super(`semantic fidelity failed: ${report.lostCount} field(s) lost`);
    this.name = "SemanticFidelityError";
    this.report = report;
  }
}

function canonicalize(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;
}

function safeLabel(value: string): string {
  const trimmed = value.trim().slice(0, 240);
  const redacted = redactSecrets(trimmed);
  if (!trimmed || redacted !== trimmed || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    return `redacted-field:${sha256(trimmed).slice(7, 23)}`;
  }
  return trimmed;
}

function safeVersion(value: string): string {
  const trimmed = value.trim().slice(0, 64);
  return /^[A-Za-z0-9._-]+$/.test(trimmed) ? trimmed : `redacted-version:${sha256(trimmed).slice(7, 23)}`;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set([...values].map(safeLabel))].sort((a, b) => a.localeCompare(b));
}

function pathMatches(path: string, candidates: Set<string>): boolean {
  for (const candidate of candidates) {
    if (
      path === candidate
      || path.startsWith(`${candidate}.`)
      || path.startsWith(`${candidate}[`)
      || candidate.startsWith(`${path}.`)
      || candidate.startsWith(`${path}[`)
    ) return true;
  }
  return false;
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizedAgentValue(
  key: string,
  value: unknown,
  idMap: Map<string, string>,
  index: number,
): unknown {
  if (key === "id") return `$agent[${index}]`;
  if (key === "companyId") return "$company";
  if (key === "parentId") return typeof value === "string" ? (idMap.get(value) ?? value) : value;
  if (key === "childrenIds" && Array.isArray(value)) return value.map((id) => typeof id === "string" ? (idMap.get(id) ?? id) : id);
  return value;
}

function topLevelSpecs(input: BuildSemanticFidelityInput, sets: ReturnType<typeof overrideSets>): FieldSpec[] {
  const specs: FieldSpec[] = [];
  const source = input.source as unknown as Record<string, unknown>;
  const target = input.target as unknown as Record<string, unknown>;

  for (const attr of COMPANY_TEMPLATE_FIELD_REGISTRY) {
    if (!attr.portable || attr.metadata || attr.key === "agents") continue;
    if (!hasOwn(source, attr.key) || source[attr.key] === undefined) continue;
    const field = attr.key;
    const sourceValue = source[attr.key];
    const targetValue = target[attr.key];

    if (pathMatches(field, sets.redacted)) {
      specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "secret-removed" });
    } else if (pathMatches(field, sets.approved)) {
      specs.push({ field, expect: "approved_after_import", source: sourceValue, roundTrip: targetValue, approvalQueue: [field], approvalMatch: (item) => item === field });
    } else if (pathMatches(field, sets.transformed)) {
      specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "runtime-reset" });
    } else if (attr.requiresLocalSetup || pathMatches(field, sets.requiresLocalSetup)) {
      specs.push({ field, expect: "requires_local_setup", source: sourceValue, roundTrip: targetValue, declaredIn: targetValue });
    } else {
      specs.push({ field, expect: "preserved", source: sourceValue, roundTrip: targetValue });
    }
  }

  const registered = new Set<string>(COMPANY_TEMPLATE_FIELD_REGISTRY.map((field) => field.key));
  for (const [key, sourceValue] of Object.entries(source)) {
    if (sourceValue === undefined || registered.has(key)) continue;
    specs.push({ field: key, expect: "preserved", source: sourceValue, roundTrip: target[key] });
  }
  return specs;
}

function agentSpecs(input: BuildSemanticFidelityInput, sets: ReturnType<typeof overrideSets>): FieldSpec[] {
  const specs: FieldSpec[] = [];
  const sourceAgents = input.source.agents ?? [];
  const targetAgents = input.target.agents ?? [];
  const sourceIds = new Map(sourceAgents.map((agent, index) => [agent.id, `$agent[${index}]`]));
  const targetIds = new Map(targetAgents.map((agent, index) => [agent.id, `$agent[${index}]`]));

  sourceAgents.forEach((sourceAgent, index) => {
    const targetAgent = targetAgents[index];
    for (const attr of AGENT_FIELD_REGISTRY) {
      if (!hasOwn(sourceAgent, attr.key) || sourceAgent[attr.key] === undefined) continue;
      const field = `agents[${index}].${attr.key}`;
      const sourceValue = normalizedAgentValue(attr.key, sourceAgent[attr.key], sourceIds, index);
      const targetValue = targetAgent
        ? normalizedAgentValue(attr.key, targetAgent[attr.key], targetIds, index)
        : undefined;

      if (pathMatches(field, sets.redacted) || attr.handling === "local-path") {
        specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "secret-removed" });
      } else if (pathMatches(field, sets.approved)) {
        specs.push({ field, expect: "approved_after_import", source: sourceValue, roundTrip: targetValue, approvalQueue: [field], approvalMatch: (item) => item === field });
      } else if (pathMatches(field, sets.transformed)) {
        specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "runtime-reset" });
      } else if (attr.requiresLocalSetup || pathMatches(field, sets.requiresLocalSetup)) {
        specs.push({ field, expect: "requires_local_setup", source: sourceValue, roundTrip: targetValue, declaredIn: targetValue });
      } else if (attr.handling === "runtime" || attr.handling === "binding") {
        const transformKind: TransformKind = attr.handling === "binding" ? "new-id" : "runtime-reset";
        specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind });
      } else if (attr.handling === "structural" && (attr.key === "id" || attr.key === "parentId" || attr.key === "childrenIds")) {
        specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "new-id" });
      } else if (attr.key === "framework" && sourceValue === "hermes" && targetValue === "api") {
        specs.push({ field, expect: "intentionally_transformed", source: sourceValue, roundTrip: targetValue, transformKind: "runtime-reset" });
      } else {
        specs.push({ field, expect: "preserved", source: sourceValue, roundTrip: targetValue });
      }
    }
  });
  return specs;
}

function overrideSets(overrides: SemanticFidelityOverrides = {}) {
  return {
    preserved: new Set(overrides.preserved ?? []),
    transformed: new Set(overrides.transformed ?? []),
    redacted: new Set(overrides.redacted ?? []),
    requiresLocalSetup: new Set(overrides.requiresLocalSetup ?? []),
    lost: new Set(overrides.lost ?? []),
    approved: new Set(overrides.approvedAfterImport ?? []),
  };
}

function categorySets(ledger: FidelityLedger, overrides: SemanticFidelityOverrides = {}) {
  const preserved = new Set(overrides.preserved ?? []);
  const transformed = new Set(overrides.transformed ?? []);
  const redacted = new Set(overrides.redacted ?? []);
  const requiresLocalSetup = new Set(overrides.requiresLocalSetup ?? []);
  const lost = new Set(overrides.lost ?? []);

  for (const verdict of ledger.verdicts) {
    if (verdict.actual === "lost") lost.add(verdict.field);
    else if (verdict.actual === "requires_local_setup") requiresLocalSetup.add(verdict.field);
    else if (verdict.actual === "approved_after_import") transformed.add(verdict.field);
    else if (verdict.actual === "intentionally_transformed") {
      const intrinsicRedaction = AGENT_FIELD_REGISTRY.some((field) =>
        field.handling === "local-path" && verdict.field.endsWith(`.${field.key}`));
      if (intrinsicRedaction || pathMatches(verdict.field, new Set(overrides.redacted ?? []))) redacted.add(verdict.field);
      else transformed.add(verdict.field);
    } else preserved.add(verdict.field);
  }

  // A field belongs to exactly one final bucket; higher-risk outcomes win.
  for (const field of lost) { preserved.delete(field); transformed.delete(field); redacted.delete(field); requiresLocalSetup.delete(field); }
  for (const field of redacted) { preserved.delete(field); transformed.delete(field); requiresLocalSetup.delete(field); }
  for (const field of requiresLocalSetup) { preserved.delete(field); transformed.delete(field); }
  for (const field of transformed) preserved.delete(field);
  return { preserved, transformed, redacted, requiresLocalSetup, lost };
}

function declarationHash(value: unknown): string {
  return sha256(canonicalize(value));
}

function normalizedFramework(value: unknown): string {
  return typeof value === "string" && value && value !== "hermes" ? value : "api";
}

function normalizedAgentReference(value: string, ids: Map<string, string>): string {
  return ids.get(value) ?? `role:${value}`;
}

function sortedCanonical<T>(values: T[]): T[] {
  return [...values].sort((left, right) => canonicalize(left).localeCompare(canonicalize(right)));
}

function runtimeDeclarations(template: CompanyTemplate) {
  const agents = template.agents ?? [];
  const ids = new Map(agents.map((agent, index) => [agent.id, `$agent[${index}]`]));
  const agentKey = (index: number) => `$agent[${index}]`;
  return {
    bindings: agents.map((agent, index) => ({
      agent: agentKey(index),
      provider: agent.provider,
      engine: normalizedFramework(agent.framework),
      model: agent.model,
    })),
    availability: agents.map((agent, index) => ({ agent: agentKey(index), enabled: agent.enabled !== false })),
    permissions: {
      required: {
        network: template.requiredPermissions?.allowWebAccess ?? null,
        shell: template.requiredPermissions?.allowShell ?? null,
        file: template.requiredPermissions?.allowFileWrite ?? null,
      },
      recommended: {
        network: template.recommendedConfig?.permissions?.allowWebAccess ?? null,
        shell: template.recommendedConfig?.permissions?.allowShell ?? null,
        file: template.recommendedConfig?.permissions?.allowFileWrite ?? null,
      },
    },
    mcp: {
      permissionServers: [...(template.requiredPermissions?.mcpServers ?? [])].sort(),
      requiredServers: [...(template.toolRequirements?.requiredMcpServers ?? [])].sort(),
      requirements: sortedCanonical((template.mcpRequirements ?? []).map((requirement) => ({
        name: requirement.name,
        optional: requirement.optional === true,
      }))),
    },
    verification: sortedCanonical((template.workflow?.verificationEdges ?? []).map((edge) => ({
      producer: normalizedAgentReference(edge.producer, ids),
      verifier: normalizedAgentReference(edge.verifier, ids),
      method: edge.method,
      onReject: edge.onReject,
      maxRounds: edge.maxRounds ?? null,
    }))),
    a2a: sortedCanonical((template.a2aChannels ?? []).map((channel) => ({
      from: normalizedAgentReference(channel.from, ids),
      to: normalizedAgentReference(channel.to, ids),
      direction: channel.direction ?? "oneway",
      purpose: channel.purpose ?? "",
      authPolicy: channel.authPolicy ?? "trusted",
      enabled: channel.enabled !== false,
    }))),
    workingDirectory: agents.map((agent, index) => ({ agent: agentKey(index), path: agent.workingDirectory ?? null })),
    visibility: {
      company: template.visibilityPolicy ?? "default",
      agents: agents.map((agent, index) => ({ agent: agentKey(index), policy: agent.visibilityPolicy ?? null })),
    },
    memoryScope: {
      records: sortedCanonical((template.seedMemories ?? []).map((memory) => ({
        scope: memory.scope,
        ownerType: memory.owner_type,
        ownerId: normalizedAgentReference(memory.owner_id, ids),
      }))),
      agents: sortedCanonical((template.agentMemories ?? []).map((memory) => ({
        agent: normalizedAgentReference(memory.agent_id, ids),
        role: memory.role ?? null,
      }))),
    },
  };
}

function comparisonCheck(
  dimension: RuntimeSemanticDimension,
  source: unknown,
  target: unknown,
): RuntimeSemanticCheck {
  const matches = deepEqual(source, target);
  return {
    dimension,
    status: matches ? "declarative-match" : "transformed-not-proven",
    proofLevel: "declarative",
    sourceDeclarationHash: declarationHash(source),
    targetDeclarationHash: declarationHash(target),
    details: matches
      ? ["declarations match; runtime behavior is not proven"]
      : ["declarations differ; runtime equivalence is not proven"],
  };
}

function bindingDetail(plan: RuntimeBindingPlanEvidence): string {
  const source = `${plan.originalBinding.kind}:${plan.originalBinding.provider ? `${plan.originalBinding.provider}/` : ""}${plan.originalBinding.name}`;
  const target = plan.targetBinding
    ? [plan.targetBinding.engine, plan.targetBinding.provider, plan.targetBinding.model].filter(Boolean).join("/")
    : "none";
  return `${source} action=${plan.action} target=${target}`;
}

function buildRuntimeSemanticFidelity(input: BuildSemanticFidelityInput): RuntimeSemanticFidelity {
  const source = runtimeDeclarations(input.source);
  const target = runtimeDeclarations(input.target);
  const checks: RuntimeSemanticCheck[] = [
    comparisonCheck("provider-engine-model", source.bindings, target.bindings),
    comparisonCheck("agent-availability", source.availability, target.availability),
    comparisonCheck("permissions", source.permissions, target.permissions),
    comparisonCheck("mcp", source.mcp, target.mcp),
    comparisonCheck("verification-edges", source.verification, target.verification),
    comparisonCheck("a2a", source.a2a, target.a2a),
    comparisonCheck("working-directory", source.workingDirectory, target.workingDirectory),
    comparisonCheck("visibility", source.visibility, target.visibility),
    comparisonCheck("memory-scope", source.memoryScope, target.memoryScope),
  ];

  const disabledAgents = target.availability
    .filter((item, index) => item.enabled === false && source.availability[index]?.enabled !== false)
    .map((item) => item.agent);
  if (disabledAgents.length) {
    checks.push({
      dimension: "agent-availability",
      status: "degraded",
      proofLevel: "declarative",
      details: disabledAgents.map((agent) => `enabled source agent imported disabled: ${agent}`),
    });
  }

  for (const plan of input.runtime?.bindingPlans ?? []) {
    const dimension: RuntimeSemanticDimension = plan.originalBinding.kind === "mcp" ? "mcp" : "provider-engine-model";
    if (plan.action === "map") {
      checks.push({
        dimension,
        status: "transformed-not-proven",
        proofLevel: "declarative",
        details: [`mapped binding is not proof of equivalent capability: ${bindingDetail(plan)}`],
      });
    }
    if (plan.status !== "available" || plan.action === "disable") {
      checks.push({
        dimension,
        status: "degraded",
        proofLevel: "declarative",
        details: [`missing/incompatible or disabled binding: ${bindingDetail(plan)}${plan.reason ? ` (${plan.reason})` : ""}`],
      });
    }
  }

  for (const missing of input.runtime?.missingCapabilities ?? []) {
    checks.push({
      dimension: missing.kind === "mcp" ? "mcp" : "provider-engine-model",
      status: "degraded",
      proofLevel: "declarative",
      details: [`missing ${missing.kind}: ${missing.name}${missing.reason ? ` (${missing.reason})` : ""}`],
    });
  }

  const requestedProof = input.runtime?.proofLevel ?? "declarative";
  const readiness = input.runtime?.readiness;
  if (!readiness || readiness.status === "not-collected") {
    checks.push({
      dimension: "runtime-readiness",
      status: "not-collected",
      proofLevel: "not-collected",
      details: ["local provider, engine, model, MCP and work-directory readiness was not synchronously collected"],
    });
  } else if (readiness.status === "missing") {
    checks.push({
      dimension: "runtime-readiness",
      status: "degraded",
      proofLevel: requestedProof === "observed" ? "observed" : "readiness",
      details: readiness.details?.length ? readiness.details : ["runtime readiness check reported missing capability"],
    });
  } else if (requestedProof === "observed") {
    checks.push({
      dimension: "runtime-readiness",
      status: "equivalent",
      proofLevel: "observed",
      details: readiness.details?.length ? readiness.details : ["runtime execution equivalence was observed"],
    });
  } else {
    checks.push({
      dimension: "runtime-readiness",
      status: "not-collected",
      proofLevel: "readiness",
      details: ["readiness was collected, but equivalent execution was not observed"],
    });
  }

  for (const check of checks) check.details = uniqueSorted(check.details);
  const has = (status: RuntimeSemanticStatus) => checks.some((check) => check.status === status);
  const status: RuntimeSemanticStatus = has("degraded")
    ? "degraded"
    : has("transformed-not-proven")
      ? "transformed-not-proven"
      : has("not-collected")
        ? "not-collected"
        : requestedProof === "observed"
          ? "equivalent"
          : "declarative-match";
  const proofLevel: RuntimeProofLevel = requestedProof === "observed" && status === "equivalent"
    ? "observed"
    : requestedProof === "readiness"
      ? "readiness"
      : "declarative";
  const dimensionsFor = (checkStatus: RuntimeSemanticStatus) => uniqueSorted(
    checks.filter((check) => check.status === checkStatus).map((check) => check.dimension),
  ) as RuntimeSemanticDimension[];
  return {
    status,
    proofLevel,
    equivalent: status === "equivalent" && proofLevel === "observed",
    checks,
    transformedNotProven: dimensionsFor("transformed-not-proven"),
    degraded: dimensionsFor("degraded"),
    notCollected: dimensionsFor("not-collected"),
  };
}
export function buildSemanticFidelityReport(input: BuildSemanticFidelityInput): SemanticFidelityReport {
  const sets = overrideSets(input.overrides);
  const specs = [...topLevelSpecs(input, sets), ...agentSpecs(input, sets)];
  for (const field of sets.lost) {
    specs.push({ field, expect: "preserved", source: "present", roundTrip: undefined });
  }
  const ledger = buildLedger(specs);
  const categories = categorySets(ledger, input.overrides);
  const fieldFidelity: FieldFidelitySummary = {
    status: categories.lost.size === 0 ? "ok" : "failed",
    ok: categories.lost.size === 0,
    preserved: uniqueSorted(categories.preserved),
    transformed: uniqueSorted(categories.transformed),
    redacted: uniqueSorted(categories.redacted),
    requiresLocalSetup: uniqueSorted(categories.requiresLocalSetup),
    lost: uniqueSorted(categories.lost),
    lostCount: categories.lost.size,
  };
  const runtimeSemantics = buildRuntimeSemanticFidelity(input);
  const body = {
    schemaVersion: SEMANTIC_FIDELITY_SCHEMA_VERSION,
    operation: input.operation,
    sourceSchemaVersion: safeVersion(input.sourceSchemaVersion),
    targetSchemaVersion: safeVersion(input.targetSchemaVersion),
    preserved: fieldFidelity.preserved,
    transformed: fieldFidelity.transformed,
    redacted: fieldFidelity.redacted,
    requiresLocalSetup: fieldFidelity.requiresLocalSetup,
    lost: fieldFidelity.lost,
    lostCount: fieldFidelity.lostCount,
    ok: fieldFidelity.ok,
    fieldFidelity,
    runtimeSemantics,
    runtimeEquivalent: runtimeSemantics.equivalent,
  };
  return { ...body, reportHash: sha256(canonicalize(body)) };
}

export function finalizeSemanticFidelity(input: FinalizeSemanticFidelityInput): SemanticFidelityReport {
  const { projectRoot, ...buildInput } = input;
  const report = buildSemanticFidelityReport(buildInput);
  persistSemanticFidelityReport(projectRoot, report);
  if (!report.ok) throw new SemanticFidelityError(report);
  return report;
}

export function semanticFidelityReportFromError(error: unknown): SemanticFidelityReport | undefined {
  return error instanceof SemanticFidelityError ? error.report : undefined;
}

export function safeInstallApprovedFields(stripped: Array<{ id: string }> = []): string[] {
  const ids = new Set(stripped.map((item) => item.id));
  const fields: string[] = [];
  if (ids.has("shell-access")) fields.push("requiredPermissions", "recommendedConfig.permissions");
  if (ids.has("mcp-dependency")) fields.push("requiredPermissions.mcpServers", "toolRequirements.requiredMcpServers");
  if (ids.has("preset-a2a-channels")) fields.push("a2aChannels");
  return fields;
}

/**
 * Return only registry-backed fields changed by an explicitly approved binding plan.
 * Callers compare the Safe Install template before and after applyImportBindingPlans,
 * so this list cannot excuse unrelated import/merge losses.
 */
export function changedSemanticFields(source: CompanyTemplate, target: CompanyTemplate): string[] {
  const changed: string[] = [];
  const sourceObject = source as unknown as Record<string, unknown>;
  const targetObject = target as unknown as Record<string, unknown>;
  for (const field of COMPANY_TEMPLATE_FIELD_REGISTRY) {
    if (field.key === "agents" || field.metadata || !field.portable) continue;
    if (!deepEqual(sourceObject[field.key], targetObject[field.key])) changed.push(field.key);
  }
  const count = Math.max(source.agents.length, target.agents.length);
  for (let index = 0; index < count; index++) {
    const before = source.agents[index];
    const after = target.agents[index];
    for (const field of AGENT_FIELD_REGISTRY) {
      if (!field.portable) continue;
      if (!deepEqual(before?.[field.key], after?.[field.key])) changed.push(`agents[${index}].${field.key}`);
    }
  }
  return uniqueSorted(changed);
}

export function mergeReportOverrides(report: {
  preserved?: Array<{ field: string }>;
  added?: Array<{ field: string }>;
  requires_review?: Array<{ field: string }>;
  requires_local_setup?: Array<{ field: string }>;
}): SemanticFidelityOverrides {
  return {
    preserved: [...(report.preserved ?? []), ...(report.added ?? [])].map((item) => item.field),
    transformed: (report.requires_review ?? []).map((item) => item.field),
    requiresLocalSetup: (report.requires_local_setup ?? []).map((item) => item.field),
  };
}
