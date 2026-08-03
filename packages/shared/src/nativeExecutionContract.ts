import { z } from "zod";
import { ExternalSessionRefSchema, RunEventSchema } from "./ecosystemContract.js";

export const NATIVE_EXECUTION_SCHEMA_VERSION = "1" as const;

export const NativeExecutionPreferenceSchema = z.object({
  preference: z.enum(["acp", "codex-native", "claude-native"]).default("acp"),
  fallback: z.enum(["acp", "blocked"]).default("acp"),
});
export type NativeExecutionPreference = z.infer<typeof NativeExecutionPreferenceSchema>;

export const NativeExecutionFailureKindSchema = z.enum([
  "feature_disabled",
  "native_unavailable",
  "version_incompatible",
  "capability_unavailable",
  "approval_rejected",
  "authentication_failed",
  "quota_exceeded",
  "process_crash",
  "timeout",
  "host_failed",
  "invalid_response",
]);
export type NativeExecutionFailureKind = z.infer<typeof NativeExecutionFailureKindSchema>;

export const NativeRunRequestSchema = z.object({
  schemaVersion: z.literal(NATIVE_EXECUTION_SCHEMA_VERSION),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  host: z.enum(["codex", "claude-code"]),
  operation: z.enum(["start", "resume", "fork"]).default("start"),
  externalSessionId: z.string().min(1).max(512).optional(),
  cwd: z.string().min(1),
  prompt: z.string().min(1).max(512 * 1024),
  model: z.string().min(1).max(256).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  approvalPolicy: z.literal("never").default("never"),
  sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  allowedTools: z.array(z.enum(["Read", "Write", "Edit", "Glob", "Grep", "Bash"])).max(6).default([]),
}).strict().superRefine((value, context) => {
  if (value.operation !== "start" && !value.externalSessionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalSessionId"],
      message: `${value.operation} requires externalSessionId`,
    });
  }
});
export type NativeRunRequest = z.infer<typeof NativeRunRequestSchema>;

export const NativeRunResultSchema = z.object({
  schemaVersion: z.literal(NATIVE_EXECUTION_SCHEMA_VERSION),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["done", "failed", "blocked"]),
  failureKind: NativeExecutionFailureKindSchema.optional(),
  message: z.string().optional(),
  content: z.string(),
  tokens: z.object({
    prompt: z.number().int().nonnegative(),
    completion: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  costUsd: z.number().nonnegative().nullable().optional(),
  events: z.array(RunEventSchema),
  session: ExternalSessionRefSchema.optional(),
  negotiation: z.object({
    adapterId: z.string().min(1),
    adapterVersion: z.string().min(1),
    hostVersion: z.string().optional(),
    protocolVersion: z.string().optional(),
    compatible: z.boolean(),
    degradationReason: z.string().optional(),
  }).optional(),
}).strict();
export type NativeRunResult = z.infer<typeof NativeRunResultSchema>;

export function parseNativeRunRequest(value: unknown): NativeRunRequest {
  return NativeRunRequestSchema.parse(value);
}

export function parseNativeRunResult(value: unknown): NativeRunResult {
  return NativeRunResultSchema.parse(value);
}
