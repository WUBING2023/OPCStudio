import { randomUUID, createHash } from "node:crypto";
import * as path from "node:path";
import { z } from "zod";
import { BundleMemoryRecordSchema, type BundleMemoryRecord } from "@opc/shared";
import type { LayeredMemoryScope, LayeredMemoryRecord } from "../storage/layeredMemory.js";
import { searchLayeredMemories, writeLayeredMemory } from "../storage/layeredMemory.js";
import { isSqliteBackend } from "../storage/backend.js";
import { openDb } from "../storage/sqlite/db.js";
import { ensureSchema } from "../storage/sqlite/schema.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadRunTask } from "../storage/projectStore.js";
import { invokeSystemModel } from "./systemModelInvoke.js";

export type MemoryObjectType =
  | "user_preference"
  | "fact"
  | "success_experience"
  | "failure_lesson"
  | "resource_pointer";

export interface MemoryReviewScores {
  novelty: number;
  reusability: number;
  specificity: number;
  evidenceStrength: number;
  freshnessRisk: number;
  sensitivityRisk: number;
  contradictionRisk: number;
}

export interface GovernedMemoryProposal {
  proposalId: string;
  objectType: MemoryObjectType;
  scope: LayeredMemoryScope;
  scopeId: string;
  title: string;
  content: string;
  summary: string;
  sourceType: "manual" | "run" | "import" | "curator";
  sourceRunId?: string;
  status: "proposed" | "approved" | "rejected";
  scores: MemoryReviewScores;
  reasons: string[];
  relatedMemoryIds: string[];
  createdAt: string;
  reviewedAt?: string;
  memoryId?: string;
  inputHash: string;
  portableBundleRecord?: BundleMemoryRecord;
  reviewer: {
    kind: "deterministic+policy" | "deterministic+model+policy";
    version: "memory-reviewer-v2";
    provider?: string;
    model?: string;
    modelReason?: string;
    evidenceIds: string[];
    confidence: number;
    counterexamples: string[];
    rollbackVersion: string;
  };
}

const MemoryReviewScoresSchema = z.object({
  novelty: z.number().min(0).max(1),
  reusability: z.number().min(0).max(1),
  specificity: z.number().min(0).max(1),
  evidenceStrength: z.number().min(0).max(1),
  freshnessRisk: z.number().min(0).max(1),
  sensitivityRisk: z.number().min(0).max(1),
  contradictionRisk: z.number().min(0).max(1),
});

const PortableBundleMemoryRecordSchema = z.custom<BundleMemoryRecord>(
  (value) => BundleMemoryRecordSchema.safeParse(value).success,
  "invalid portable bundle memory record",
);

/** Canonical persisted proposal contract used by JSON, SQLite and golden fixtures. */
export const GovernedMemoryProposalSchema: z.ZodType<GovernedMemoryProposal> = z.object({
  proposalId: z.string().min(1),
  objectType: z.enum(["user_preference", "fact", "success_experience", "failure_lesson", "resource_pointer"]),
  scope: z.enum(["user", "company", "project", "team", "agent"]),
  scopeId: z.string().min(1),
  title: z.string().min(1),
  content: z.string().min(1),
  summary: z.string().min(1),
  sourceType: z.enum(["manual", "run", "import", "curator"]),
  sourceRunId: z.string().min(1).optional(),
  status: z.enum(["proposed", "approved", "rejected"]),
  scores: MemoryReviewScoresSchema,
  reasons: z.array(z.string()),
  relatedMemoryIds: z.array(z.string()),
  createdAt: z.string().min(1),
  reviewedAt: z.string().min(1).optional(),
  memoryId: z.string().min(1).optional(),
  inputHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  portableBundleRecord: PortableBundleMemoryRecordSchema.optional(),
  reviewer: z.object({
    kind: z.enum(["deterministic+policy", "deterministic+model+policy"]),
    version: z.literal("memory-reviewer-v2"),
    provider: z.string().optional(),
    model: z.string().optional(),
    modelReason: z.string().optional(),
    evidenceIds: z.array(z.string()),
    confidence: z.number().min(0).max(1),
    counterexamples: z.array(z.string()),
    rollbackVersion: z.string().min(1),
  }),
}).passthrough();

export interface MemoryPolicy {
  autoApprove: boolean;
  autoCurate: boolean;
  autoModelMerge: boolean;
  requireManualForApprovedOverwrite: boolean;
  maxCandidates: number;
  maxPromptItems: number;
  maxPromptChars: number;
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  autoApprove: false,
  autoCurate: true,
  autoModelMerge: false,
  requireManualForApprovedOverwrite: true,
  maxCandidates: 100,
  maxPromptItems: 20,
  maxPromptChars: 8_000,
};

const policyPath = (root: string) => path.join(root, ".opc", "memory", "policy.json");
const normalize = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const hash = (value: string) => `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;

export function loadMemoryPolicy(root: string): MemoryPolicy {
  const raw = readJSON<Partial<MemoryPolicy>>(policyPath(root), {});
  return {
    ...DEFAULT_MEMORY_POLICY,
    ...raw,
    maxCandidates: Math.min(Math.max(raw.maxCandidates ?? 100, 1), 100),
    maxPromptItems: Math.min(Math.max(raw.maxPromptItems ?? 20, 1), 20),
    maxPromptChars: Math.min(Math.max(raw.maxPromptChars ?? 8_000, 1_000), 8_000),
  };
}

export function saveMemoryPolicy(root: string, patch: Partial<MemoryPolicy>): MemoryPolicy {
  const next = { ...loadMemoryPolicy(root), ...patch };
  next.maxCandidates = Math.min(Math.max(next.maxCandidates, 1), 100);
  next.maxPromptItems = Math.min(Math.max(next.maxPromptItems, 1), 20);
  next.maxPromptChars = Math.min(Math.max(next.maxPromptChars, 1_000), 8_000);
  writeJSON(policyPath(root), next);
  return next;
}

export function classifyMemoryScope(text: string, explicit?: { scope?: LayeredMemoryScope; scopeId?: string }): { scope: LayeredMemoryScope; scopeId: string } {
  if (explicit?.scope) return { scope: explicit.scope, scopeId: explicit.scopeId?.trim() || (explicit.scope === "user" ? "local-user" : "default") };
  const lower = text.toLowerCase();
  if (/(\u6211\u7684\u504f\u597d|\u7528\u6237\u504f\u597d|\u59cb\u7ec8\u56de\u7b54|always respond|remember that my|my reports?|my preference|\u6211\u559c\u6b22|\u6211\u4e0d\u559c\u6b22)/i.test(lower)) {
    return { scope: "user", scopeId: "local-user" };
  }
  if (/(\u8fd9\u4e2a\u9879\u76ee|\u672c\u9879\u76ee|\u5f53\u524d\u9879\u76ee|this project|this repo|repository)/i.test(lower)) {
    return { scope: "project", scopeId: explicit?.scopeId?.trim() || "default-project" };
  }
  if (/(\u8fd9\u4e2a\u56e2\u961f|\u672c\u56e2\u961f|this team|\u90e8\u95e8)/i.test(lower)) return { scope: "team", scopeId: explicit?.scopeId?.trim() || "default-team" };
  if (/(\u8fd9\u4e2a\u5458\u5de5|\u672c\u5458\u5de5|this agent|worker)/i.test(lower)) return { scope: "agent", scopeId: explicit?.scopeId?.trim() || "default-agent" };
  return { scope: "company", scopeId: explicit?.scopeId?.trim() || "default" };
}

function resolveMemoryScopeIdentity(
  root: string,
  classified: { scope: LayeredMemoryScope; scopeId: string },
  input: { scopeId?: string; sourceRunId?: string },
): { scope: LayeredMemoryScope; scopeId: string; missingIdentity: boolean } {
  const explicitId = input.scopeId?.trim();
  if (explicitId) return { scope: classified.scope, scopeId: explicitId, missingIdentity: false };
  if (classified.scope === "user") return { scope: "user", scopeId: "local-user", missingIdentity: false };

  const run = input.sourceRunId ? loadRunTask(root, input.sourceRunId) : null;
  if (classified.scope === "company") {
    return { scope: "company", scopeId: run?.companyId?.trim() || "default", missingIdentity: false };
  }
  if (classified.scope === "project") {
    const projectId = run?.missionId?.trim() || run?.taskGraphId?.trim();
    if (projectId) return { scope: "project", scopeId: projectId, missingIdentity: false };
  }
  return { ...classified, missingIdentity: true };
}

function containsCredentialMaterial(content: string): boolean {
  // Exported bundles deliberately retain the surrounding lesson while replacing
  // the credential value with a canonical placeholder. Treating the words
  // "password" or "密钥" themselves as a secret made those already-redacted
  // records impossible to import. Remove only known placeholders, then look for
  // actual token shapes or a credential label followed by a plausible value.
  const inspectable = content.replace(
    /\[(?:REDACTED(?:_SECRET)?|SECRET_REDACTED|密钥已隐去)\]|<redacted>/gi,
    " ",
  );
  if (/\b(?:sk-|ark-)[A-Za-z0-9_-]{8,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[0-9A-Z]{16}\b/i.test(inspectable)) return true;
  if (/\bBearer\s+[A-Za-z0-9._-]{8,}/i.test(inspectable)) return true;
  return /(?:api[_ -]?key|apikey|x-api-key|client[_ -]?secret|access[_ -]?token|password|passwd|密钥|密码)\s*(?:是|为)?\s*[:=：]?\s*["']?[A-Za-z0-9._/+:-]{8,}/i.test(inspectable);
}

function deterministicReject(content: string): string[] {
  const reasons: string[] = [];
  if (content.trim().length < 8) reasons.push("content_too_short");
  if (content.length > 8_000) reasons.push("content_too_long");
  if (containsCredentialMaterial(content)) reasons.push("sensitive_content");
  if (/(node_modules|package-lock\.json \u5185\u5bb9|git log \u8f93\u51fa|\u5f53\u524d\u5df2\u4fee\u6539\u6587\u4ef6|\u4e34\u65f6\u76ee\u5f55 [a-z]:\\|\u8c03\u8bd5\u4e2d\u95f4\u72b6\u6001|tmp\/)/i.test(content)) reasons.push("derivable_or_ephemeral_state");
  if (/^(\u65e5\u5fd7|log|stack trace|\u539f\u59cb\u8f93\u51fa|raw output)[:\uff1a]/i.test(content.trim())) reasons.push("raw_runtime_output");
  return reasons;
}

function evidenceStrength(root: string, objectType: MemoryObjectType, sourceRunId?: string): number {
  if (!sourceRunId) return objectType === "user_preference" || objectType === "fact" ? 0.65 : 0.2;
  const run = loadRunTask(root, sourceRunId);
  if (!run) return 0.1;
  if (run.simulated || run.degraded || run.status === "failed") return objectType === "failure_lesson" ? 0.55 : 0;
  if (run.finalState === "verified" || run.finalState === "tests_passed" || run.deliveryAcceptance?.status === "verified") return 1;
  return run.status === "done" ? 0.7 : 0.3;
}

function scoreProposal(
  root: string,
  objectType: MemoryObjectType,
  content: string,
  sourceRunId: string | undefined,
  related: LayeredMemoryRecord[],
): MemoryReviewScores {
  const normalized = normalize(content);
  const exact = related.some((item) => normalize(item.content) === normalized);
  const subsumed = related.some((item) => normalize(item.content).includes(normalized) || normalized.includes(normalize(item.content)));
  const contradiction = related.some((item) => {
    const sameTopic = item.summary.split(/\s+/).some((word) => word.length > 3 && content.includes(word));
    return sameTopic && /(\u4e0d\u8981|\u7981\u6b62|never|not|\u6539\u4e3a|instead)/i.test(content + " " + item.content);
  });
  const specificity = Math.min(1, (content.match(/[\w\u3400-\u9fff]+/g)?.length ?? 0) / 35);
  return {
    novelty: exact ? 0 : subsumed ? 0.25 : 0.9,
    reusability: objectType === "user_preference" ? 0.9 : Math.min(1, 0.45 + specificity * 0.5),
    specificity,
    evidenceStrength: evidenceStrength(root, objectType, sourceRunId),
    freshnessRisk: /(\u73b0\u5728|\u5f53\u524d|today|current|\u6700\u65b0)/i.test(content) ? 0.7 : 0.15,
    sensitivityRisk: deterministicReject(content).includes("sensitive_content") ? 1 : 0,
    contradictionRisk: contradiction ? 0.85 : 0.1,
  };
}

function approvalThreshold(type: MemoryObjectType): number {
  if (type === "failure_lesson") return 0.88;
  if (type === "success_experience") return 0.82;
  if (type === "resource_pointer") return 0.78;
  return 0.72;
}

function aggregateScore(scores: MemoryReviewScores): number {
  return scores.novelty * 0.22 + scores.reusability * 0.2 + scores.specificity * 0.16
    + scores.evidenceStrength * 0.27 + (1 - scores.freshnessRisk) * 0.05
    + (1 - scores.sensitivityRisk) * 0.07 + (1 - scores.contradictionRisk) * 0.03;
}

function persistProposal(root: string, proposal: GovernedMemoryProposal): void {
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    db.prepare(
      "INSERT INTO memory_proposals_v2(proposalId,scope,scopeId,objectType,status,createdAt,doc) VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(proposalId) DO UPDATE SET status=excluded.status,doc=excluded.doc",
    ).run(proposal.proposalId, proposal.scope, proposal.scopeId, proposal.objectType, proposal.status, proposal.createdAt, JSON.stringify(proposal));
    return;
  }
  const file = path.join(root, ".opc", "memory", "proposals-v2.json");
  const all = readJSON<GovernedMemoryProposal[]>(file, []).filter((item) => item.proposalId !== proposal.proposalId);
  all.unshift(proposal);
  writeJSON(file, all.slice(0, 500));
}

export function listGovernedMemoryProposals(root: string, status?: GovernedMemoryProposal["status"]): GovernedMemoryProposal[] {
  let all: GovernedMemoryProposal[];
  if (isSqliteBackend(root)) {
    const db = openDb(root); ensureSchema(db);
    const rows = status
      ? db.prepare("SELECT doc FROM memory_proposals_v2 WHERE status=? ORDER BY createdAt DESC").all(status)
      : db.prepare("SELECT doc FROM memory_proposals_v2 ORDER BY createdAt DESC").all();
    all = (rows as Array<{ doc: string }>).flatMap((row) => {
      try {
        const parsed = GovernedMemoryProposalSchema.safeParse(JSON.parse(row.doc));
        return parsed.success ? [parsed.data] : [];
      } catch { return []; }
    });
  } else {
    all = readJSON<unknown[]>(path.join(root, ".opc", "memory", "proposals-v2.json"), [])
      .flatMap((value) => {
        const parsed = GovernedMemoryProposalSchema.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      });
  }
  return status ? all.filter((item) => item.status === status) : all;
}

/**
 * Remove uncommitted governed proposals created by an installation transaction.
 * Approved proposals already own canonical Markdown memory and are deliberately
 * refused here: rollback must not orphan or silently delete user-approved knowledge.
 */
export function removeGovernedMemoryProposalsByIds(root: string, proposalIds: string[]): number {
  const ids = new Set(proposalIds.filter(Boolean));
  if (!ids.size) return 0;
  const matching = listGovernedMemoryProposals(root).filter((proposal) => ids.has(proposal.proposalId));
  const committed = matching.filter((proposal) => proposal.memoryId);
  if (committed.length) {
    throw new Error(`cannot rollback approved memory proposals: ${committed.map((proposal) => proposal.proposalId).join(", ")}`);
  }
  if (isSqliteBackend(root)) {
    const db = openDb(root);
    ensureSchema(db);
    const remove = db.prepare("DELETE FROM memory_proposals_v2 WHERE proposalId=?");
    db.exec("BEGIN");
    try {
      for (const id of ids) remove.run(id);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
      throw error;
    }
    return matching.length;
  }
  const file = path.join(root, ".opc", "memory", "proposals-v2.json");
  const all = readJSON<GovernedMemoryProposal[]>(file, []);
  writeJSON(file, all.filter((proposal) => !ids.has(proposal.proposalId)));
  return matching.length;
}

export function proposeMemory(root: string, input: {
  text: string;
  title?: string;
  summary?: string;
  objectType?: MemoryObjectType;
  scope?: LayeredMemoryScope;
  scopeId?: string;
  sourceType?: GovernedMemoryProposal["sourceType"];
  sourceRunId?: string;
  autoApprove?: boolean;
  rootCauseConfirmed?: boolean;
  evidenceIds?: string[];
  counterexamples?: string[];
  portableBundleRecord?: BundleMemoryRecord;
}): GovernedMemoryProposal {
  const text = input.text.replace(/\s+/g, " ").trim();
  const objectType = input.objectType ?? (/(\u6211\u559c\u6b22|\u6211\u4e0d\u559c\u6b22|\u8bf7\u8bb0\u4f4f|always respond)/i.test(text) ? "user_preference" : "fact");
  const classified = classifyMemoryScope(text, { scope: input.scope, scopeId: input.scopeId });
  const scoped = resolveMemoryScopeIdentity(root, classified, input);
  const inputHash = hash(JSON.stringify({ text, objectType, scope: scoped, portableBundleRecord: input.portableBundleRecord }));
  const existingProposal = listGovernedMemoryProposals(root).find((proposal) =>
    proposal.inputHash === inputHash && proposal.status !== "rejected");
  if (existingProposal) {
    return { ...existingProposal, reasons: [...existingProposal.reasons, "idempotent_existing"] };
  }
  const related = scoped.missingIdentity
    ? []
    : searchLayeredMemories(root, { goal: text, scopes: [{ scope: scoped.scope, scopeId: scoped.scopeId }], limit: 20 });
  const scores = scoreProposal(root, objectType, text, input.sourceRunId, related);
  const reasons = deterministicReject(text);
  const policy = loadMemoryPolicy(root);
  const score = aggregateScore(scores);
  const evidenceIds = [...new Set([
    ...(input.sourceRunId ? [input.sourceRunId] : []),
    ...(input.evidenceIds ?? []).filter((item) => item.trim()),
  ])].slice(0, 20);
  const counterexamples = [...new Set((input.counterexamples ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 10);
  const strictFailureInvalid = objectType === "failure_lesson" && (
    !input.sourceRunId
    || scores.evidenceStrength < 0.55
    || input.rootCauseConfirmed !== true
    || evidenceIds.length === 0
    || counterexamples.length === 0
  );
  const successInvalid = objectType === "success_experience" && scores.evidenceStrength < 0.9;
  if (scoped.missingIdentity) reasons.push("scope_identity_required");
  if (strictFailureInvalid) reasons.push("failure_lesson_requires_confirmed_root_cause_and_run_evidence");
  if (successInvalid) reasons.push("success_experience_requires_verified_delivery");
  if (scores.novelty === 0) reasons.push("exact_duplicate");

  const requestedAuto = input.autoApprove ?? policy.autoApprove;
  const highRisk = scores.sensitivityRisk > 0 || scores.contradictionRisk >= 0.8 || objectType === "resource_pointer";
  const approved = !reasons.length && requestedAuto && !highRisk && score >= approvalThreshold(objectType);
  const status: GovernedMemoryProposal["status"] =
    reasons.includes("sensitive_content")
    || reasons.includes("exact_duplicate")
    || reasons.includes("scope_identity_required")
      ? "rejected"
      : approved ? "approved" : "proposed";
  const now = new Date().toISOString();
  const proposal: GovernedMemoryProposal = {
    proposalId: `memprop-${randomUUID()}`,
    objectType,
    scope: scoped.scope,
    scopeId: scoped.scopeId,
    title: input.title?.trim() || text.slice(0, 60),
    content: text,
    summary: input.summary?.trim() || text.slice(0, 180),
    sourceType: input.sourceType || "manual",
    sourceRunId: input.sourceRunId,
    status,
    scores,
    reasons: [...reasons, `aggregate_score=${score.toFixed(3)}`],
    relatedMemoryIds: related.map((item) => item.memoryId),
    createdAt: now,
    reviewedAt: now,
    inputHash,
    portableBundleRecord: input.portableBundleRecord,
    reviewer: {
      kind: "deterministic+policy",
      version: "memory-reviewer-v2",
      evidenceIds,
      confidence: score,
      counterexamples,
      rollbackVersion: inputHash,
    },
  };
  if (approved) {
    const memory = writeLayeredMemory(root, {
      scope: scoped.scope,
      scopeId: scoped.scopeId,
      title: proposal.title,
      summary: proposal.summary,
      content: proposal.content,
      topic: objectType,
      sourceType: proposal.sourceType,
      sourceRunId: proposal.sourceRunId,
      status: "approved",
      confidence: score,
      portableBundleRecord: proposal.portableBundleRecord,
    });
    proposal.memoryId = memory.memoryId;
  }
  // Sensitive or unscoped input is rejected ephemerally: never persist secrets
  // or placeholder scope identities into the canonical proposal store.
  if (!reasons.includes("sensitive_content") && !reasons.includes("scope_identity_required")) {
    persistProposal(root, proposal);
  }
  return proposal;
}


function findProposal(root: string, proposalId: string): GovernedMemoryProposal | null {
  return listGovernedMemoryProposals(root).find((item) => item.proposalId === proposalId) ?? null;
}

export function decideGovernedMemoryProposal(
  root: string,
  proposalId: string,
  decision: "approved" | "rejected",
  reviewer = "human",
): GovernedMemoryProposal | null {
  const proposal = findProposal(root, proposalId);
  if (!proposal || proposal.status === "rejected") return null;
  if (decision === "approved" && !proposal.memoryId) {
    const score = aggregateScore(proposal.scores);
    const memory = writeLayeredMemory(root, {
      scope: proposal.scope,
      scopeId: proposal.scopeId,
      title: proposal.title,
      summary: proposal.summary,
      content: proposal.content,
      topic: proposal.objectType,
      sourceType: proposal.sourceType,
      sourceRunId: proposal.sourceRunId,
      status: "approved",
      confidence: score,
      portableBundleRecord: proposal.portableBundleRecord,
    });
    proposal.memoryId = memory.memoryId;
  }
  proposal.status = decision;
  proposal.reviewedAt = new Date().toISOString();
  proposal.reasons.push(`decision_by=${reviewer}`);
  persistProposal(root, proposal);
  return proposal;
}

function parseReviewerJson(content: string): Partial<{
  decision: "approve" | "propose" | "reject";
  summary: string;
  rationale: string;
  novelty: number;
  reusability: number;
  specificity: number;
  freshnessRisk: number;
  contradictionRisk: number;
  counterexamples: string[];
}> | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]) as ReturnType<typeof parseReviewerJson>; }
  catch { return null; }
}

const clampScore = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

export async function proposeMemoryWithReview(root: string, input: Parameters<typeof proposeMemory>[1]): Promise<GovernedMemoryProposal> {
  const proposal = proposeMemory(root, { ...input, autoApprove: false });
  if (proposal.reasons.includes("idempotent_existing")) return proposal;
  if (proposal.status === "rejected") return proposal;
  const policy = loadMemoryPolicy(root);
  if (!(input.autoApprove ?? policy.autoApprove)) return proposal;

  try {
    const response = await invokeSystemModel(root, "judge", {
      agentId: "memory-reviewer",
      agentRole: "memory_reviewer",
      maxTokens: 700,
      system: [
        "You are OPC Memory Reviewer. Return one JSON object only.",
        "Judge future reuse value and non-obviousness. Never approve secrets, raw logs, temporary state, or facts derivable from code/Git.",
        "Fields: decision(approve|propose|reject),summary,rationale,novelty,reusability,specificity,freshnessRisk,contradictionRisk,counterexamples(string[]). Scores are 0..1.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: JSON.stringify({
          type: proposal.objectType,
          scope: proposal.scope,
          title: proposal.title,
          content: proposal.content,
          deterministicScores: proposal.scores,
          deterministicReasons: proposal.reasons,
          relatedMemoryIds: proposal.relatedMemoryIds,
        }),
      }],
    });
    const review = parseReviewerJson(response.content);
    if (!review) {
      proposal.reasons.push("model_reviewer_invalid_json");
      persistProposal(root, proposal);
      return proposal;
    }

    proposal.summary = typeof review.summary === "string" && review.summary.trim()
      ? review.summary.replace(/\s+/g, " ").trim().slice(0, 180)
      : proposal.summary;
    proposal.scores.novelty = (proposal.scores.novelty + clampScore(review.novelty, proposal.scores.novelty)) / 2;
    proposal.scores.reusability = (proposal.scores.reusability + clampScore(review.reusability, proposal.scores.reusability)) / 2;
    proposal.scores.specificity = (proposal.scores.specificity + clampScore(review.specificity, proposal.scores.specificity)) / 2;
    proposal.scores.freshnessRisk = Math.max(proposal.scores.freshnessRisk, clampScore(review.freshnessRisk, proposal.scores.freshnessRisk));
    proposal.scores.contradictionRisk = Math.max(proposal.scores.contradictionRisk, clampScore(review.contradictionRisk, proposal.scores.contradictionRisk));
    proposal.reviewer = {
      kind: "deterministic+model+policy",
      version: "memory-reviewer-v2",
      provider: response.provider,
      model: response.model,
      modelReason: typeof review.rationale === "string" ? review.rationale.slice(0, 500) : undefined,
      evidenceIds: proposal.reviewer.evidenceIds,
      confidence: aggregateScore(proposal.scores),
      counterexamples: Array.isArray(review.counterexamples)
        ? review.counterexamples.filter((item): item is string => typeof item === 'string').map((item) => item.slice(0, 300)).slice(0, 10)
        : proposal.reviewer.counterexamples,
      rollbackVersion: proposal.inputHash,
    };

    const hardReason = proposal.reasons.some((reason) =>
      reason === "sensitive_content"
      || reason === "derivable_or_ephemeral_state"
      || reason === "raw_runtime_output"
      || reason === "failure_lesson_requires_confirmed_root_cause_and_run_evidence"
      || reason === "success_experience_requires_verified_delivery");
    const score = aggregateScore(proposal.scores);
    const canApprove = review.decision === "approve"
      && !hardReason
      && proposal.scores.contradictionRisk < 0.8
      && proposal.objectType !== "resource_pointer"
      && (proposal.objectType !== 'failure_lesson' || proposal.reviewer.counterexamples.length > 0)
      && score >= approvalThreshold(proposal.objectType);
    proposal.reasons.push(`model_decision=${review.decision ?? "propose"}`, `reviewed_score=${score.toFixed(3)}`);

    if (review.decision === "reject") {
      proposal.status = "rejected";
      proposal.reviewedAt = new Date().toISOString();
      persistProposal(root, proposal);
      return proposal;
    }
    if (canApprove) {
      persistProposal(root, proposal);
      return decideGovernedMemoryProposal(root, proposal.proposalId, "approved", "memory-reviewer") ?? proposal;
    }
    persistProposal(root, proposal);
    return proposal;
  } catch (error) {
    proposal.reasons.push(`model_reviewer_unavailable=${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`);
    persistProposal(root, proposal);
    return proposal;
  }
}
