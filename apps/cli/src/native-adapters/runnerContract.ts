import { ExternalSessionRefSchema, NATIVE_EXECUTION_SCHEMA_VERSION } from "@opc/shared";
import { z } from "zod";
import type { NativeRunnerRequest } from "./types.js";

const RunnerRequestSchema = z.object({
  schemaVersion: z.literal(NATIVE_EXECUTION_SCHEMA_VERSION),
  requestId: z.string().min(1),
  runId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  host: z.enum(["codex", "claude-code"]),
  operation: z.enum(["start", "resume", "fork", "interrupt"]).default("start"),
  externalSessionId: z.string().min(1).max(512).optional(),
  externalTurnId: z.string().min(1).max(512).optional(),
  externalSessionRef: ExternalSessionRefSchema.optional(),
  cwd: z.string().min(1),
  prompt: z.string().min(1).max(512 * 1024),
  model: z.string().min(1).max(256).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000),
  approvalPolicy: z.enum(["never", "on-request"]).default("never"),
  sandbox: z.enum(["read-only", "workspace-write"]).default("workspace-write"),
  allowedTools: z.array(z.enum(["Read", "Write", "Edit", "Glob", "Grep", "Bash"])).max(6).default([]),
}).strict().superRefine((value, context) => {
  const sessionId = value.externalSessionRef?.externalSessionId ?? value.externalSessionId;
  const turnId = value.externalSessionRef?.externalTurnId ?? value.externalTurnId;
  if (value.operation !== "start" && !sessionId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalSessionRef"],
      message: `${value.operation} requires an ExternalSessionRef with externalSessionId`,
    });
  }
  if (value.operation === "interrupt" && !turnId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalSessionRef", "externalTurnId"],
      message: "interrupt requires externalTurnId",
    });
  }
  if (value.externalSessionRef && value.externalSessionRef.host !== value.host) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalSessionRef", "host"],
      message: `session host ${value.externalSessionRef.host} does not match request host ${value.host}`,
    });
  }
  if (
    value.externalSessionRef?.externalSessionId
    && value.externalSessionId
    && value.externalSessionRef.externalSessionId !== value.externalSessionId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalSessionId"],
      message: "externalSessionId does not match externalSessionRef",
    });
  }
  if (
    value.externalSessionRef?.externalTurnId
    && value.externalTurnId
    && value.externalSessionRef.externalTurnId !== value.externalTurnId
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalTurnId"],
      message: "externalTurnId does not match externalSessionRef",
    });
  }
});

export function parseNativeRunnerRequest(value: unknown): NativeRunnerRequest {
  const parsed = RunnerRequestSchema.parse(value);
  return {
    ...parsed,
    ...(parsed.externalSessionRef?.externalSessionId
      ? { externalSessionId: parsed.externalSessionRef.externalSessionId }
      : {}),
    ...(parsed.externalSessionRef?.externalTurnId
      ? { externalTurnId: parsed.externalSessionRef.externalTurnId }
      : {}),
  };
}
