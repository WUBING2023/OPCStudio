import type { ApprovalRequest, RunEvent, RunEventType } from "@opc/shared";
import type { NativeApprovalContext, NativeEventContext } from "./types.js";

type JsonRecord = Record<string, unknown>;
const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|api.?key|credential|private.?key|headers|env)/i;
const TOKEN_USAGE_KEY = /^(?:tokenUsage|inputTokens|outputTokens|cachedInputTokens|cacheWriteInputTokens|reasoningOutputTokens|totalTokens|promptTokens|completionTokens|input_tokens|output_tokens|cached_input_tokens|cache_write_input_tokens|reasoning_output_tokens|total_tokens|prompt_tokens|completion_tokens)$/i;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitize(item, depth + 1));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, nested]) => [
    key,
    SENSITIVE_KEY.test(key) && !TOKEN_USAGE_KEY.test(key) ? "[redacted]" : sanitize(nested, depth + 1),
  ]));
}

function runEvent(
  host: "codex" | "claude-code",
  type: RunEventType,
  payload: unknown,
  context: NativeEventContext,
  externalEventId?: string,
): RunEvent {
  const adapterId = host === "codex" ? "opc.codex-app-server" : "opc.claude-agent-sdk";
  return {
    schemaVersion: "1",
    eventId: externalEventId || `${adapterId}:${context.runId}:${context.sequence}`,
    runId: context.runId,
    sequence: context.sequence,
    timestamp: (context.now ?? (() => new Date().toISOString()))(),
    type,
    actor: { kind: "adapter", id: adapterId },
    payload: sanitize(payload),
    source: { host, adapterId },
  };
}

export function mapCodexNotification(notification: unknown, context: NativeEventContext): RunEvent {
  const record = asRecord(notification);
  const method = typeof record.method === "string" ? record.method : "unknown";
  const params = asRecord(record.params);
  const turn = asRecord(params.turn);
  const item = asRecord(params.item);
  const status = String(turn.status ?? item.status ?? "");
  let type: RunEventType = "agent.message";
  if (method === "turn/started") type = "run.started";
  else if (method === "turn/completed") type = status === "completed" ? "run.completed" : "run.failed";
  else if (/requestApproval$/.test(method)) type = "approval.requested";
  else if (method === "serverRequest/resolved") type = "approval.resolved";
  else if (method === "item/started") type = "tool.started";
  else if (method === "item/completed") type = item.type === "fileChange" ? "artifact.created" : "tool.completed";
  const externalId = typeof params.id === "string" ? params.id
    : typeof turn.id === "string" ? turn.id
      : typeof item.id === "string" ? item.id : undefined;
  return runEvent("codex", type, { method, params }, context, externalId);
}

export function mapClaudeStreamEvent(event: unknown, context: NativeEventContext): RunEvent {
  const record = asRecord(event);
  const eventType = String(record.type ?? "");
  const subtype = String(record.subtype ?? "");
  let type: RunEventType = "agent.message";
  if (eventType === "system" && subtype === "init") type = "run.started";
  else if (eventType === "result") type = subtype === "success" ? "run.completed" : "run.failed";
  else if (eventType === "tool_use") type = "tool.started";
  else if (eventType === "tool_result") type = "tool.completed";
  else if (eventType === "permission_request") type = "approval.requested";
  const externalId = typeof record.uuid === "string" ? record.uuid
    : typeof record.session_id === "string" ? `${record.session_id}:${context.sequence}` : undefined;
  return runEvent("claude-code", type, event, context, externalId);
}

export function mapCodexApprovalRequest(
  requestId: string | number,
  method: string,
  paramsValue: unknown,
  context: NativeApprovalContext,
): ApprovalRequest {
  const params = asRecord(paramsValue);
  const reason = typeof params.reason === "string" && params.reason.trim() ? params.reason : method;
  const network = asRecord(params.networkApprovalContext);
  const resources = [params.cwd, params.grantRoot, network.host]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  const permissions = method.includes("fileChange")
    ? ["filesystem.write"]
    : method.includes("permissions") ? ["requested.permissions"] : network.host ? ["network.connect"] : ["command.execute"];
  return {
    schemaVersion: "1",
    approvalId: String(requestId),
    runId: context.runId,
    action: method,
    impact: { summary: reason, resources, permissions },
    dataDestinations: typeof network.host === "string" ? [network.host] : ["local-workspace"],
    reversible: method.includes("fileChange"),
    source: { kind: "adapter", id: "opc.codex-app-server" },
    expiresAt: context.expiresAt,
    idempotencyKey: context.idempotencyKey,
    status: "pending",
  };
}
