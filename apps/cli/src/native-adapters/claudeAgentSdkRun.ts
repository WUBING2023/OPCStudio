import {
  query as claudeQuery,
  type Options as ClaudeOptions,
  type Query as ClaudeQuery,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  NATIVE_EXECUTION_SCHEMA_VERSION,
  type NativeExecutionFailureKind,
  type NativeRunResult,
} from "@opc/shared";
import { mapClaudeStreamEvent } from "./eventMapping.js";
import type { NativeRunnerRequest } from "./types.js";

export type ClaudeQueryFactory = (input: { prompt: string; options?: ClaudeOptions }) => ClaudeQuery;

export interface ClaudeNativeDependencies {
  query?: ClaudeQueryFactory;
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  now?: () => string;
}

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    const record = asRecord(part);
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("\n");
}

function usage(value: unknown): NativeRunResult["tokens"] {
  const record = asRecord(value);
  const prompt = Number(record.input_tokens ?? record.inputTokens ?? record.prompt_tokens ?? 0);
  const completion = Number(record.output_tokens ?? record.outputTokens ?? record.completion_tokens ?? 0);
  return {
    prompt: Number.isFinite(prompt) ? Math.max(0, Math.trunc(prompt)) : 0,
    completion: Number.isFinite(completion) ? Math.max(0, Math.trunc(completion)) : 0,
    total: Number.isFinite(prompt + completion) ? Math.max(0, Math.trunc(prompt + completion)) : 0,
  };
}

function safeMessage(value: unknown): string {
  return String(value ?? "Claude Agent SDK failed")
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .slice(0, 4096);
}

function classifyFailure(message: string, permissionDenied: boolean): NativeExecutionFailureKind {
  if (permissionDenied || /permission|approval|denied|rejected/i.test(message)) return "approval_rejected";
  if (/401|authentication|api.?key|unauthorized/i.test(message)) return "authentication_failed";
  if (/quota|rate.?limit|credit|billing|429|max_budget/i.test(message)) return "quota_exceeded";
  if (/timeout|timed out|deadline/i.test(message)) return "timeout";
  if (/ENOENT|not found|unsupported platform/i.test(message)) return "native_unavailable";
  return "host_failed";
}

function failed(
  request: NativeRunnerRequest,
  kind: NativeExecutionFailureKind,
  message: string,
  events: NativeRunResult["events"] = [],
): NativeRunResult {
  return {
    schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    status: ["approval_rejected", "authentication_failed", "native_unavailable", "capability_unavailable"].includes(kind)
      ? "blocked"
      : "failed",
    failureKind: kind,
    message: safeMessage(message),
    content: "",
    tokens: { prompt: 0, completion: 0, total: 0 },
    costUsd: null,
    events,
  };
}

function strictEnvironment(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const allowed = new Set([
    "ANTHROPIC_API_KEY", "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
    "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "COMSPEC",
    "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  ]);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => allowed.has(key) && value !== undefined));
}

function selectedTools(request: NativeRunnerRequest): string[] {
  const allowed = request.allowedTools.length > 0
    ? request.allowedTools
    : request.sandbox === "read-only" ? ["Read", "Glob", "Grep"] : ["Read", "Write", "Edit", "Glob", "Grep", "Bash"];
  return request.sandbox === "read-only"
    ? allowed.filter((tool) => ["Read", "Glob", "Grep"].includes(tool))
    : allowed;
}

export async function executeClaudeNativeRun(
  request: NativeRunnerRequest,
  dependencies: ClaudeNativeDependencies = {},
): Promise<NativeRunResult> {
  if (request.host !== "claude-code") {
    return failed(request, "capability_unavailable", `Claude native runner cannot execute host ${request.host}`);
  }
  if (request.operation === "interrupt") {
    return failed(
      request,
      "capability_unavailable",
      "Detached Claude sessions cannot be interrupted by id: the Agent SDK requires the original live Query object",
    );
  }
  if (request.approvalPolicy === "on-request") {
    return failed(
      request,
      "capability_unavailable",
      "Claude headless native execution has no external approval broker; on-request approval cannot be honored",
    );
  }
  if (request.operation !== "start") {
    const session = request.externalSessionRef;
    const sessionId = session?.externalSessionId ?? request.externalSessionId;
    if (!sessionId) {
      return failed(request, "capability_unavailable", request.operation + " requires an ExternalSessionRef with externalSessionId");
    }
    if (session && (session.host !== "claude-code" || session.adapterId !== "opc.claude-agent-sdk")) {
      return failed(request, "capability_unavailable", "ExternalSessionRef does not belong to the Claude Agent SDK adapter");
    }
    if (session?.capabilities.length && !session.capabilities.includes(request.operation)) {
      return failed(request, "capability_unavailable", "ExternalSessionRef does not declare " + request.operation + " capability");
    }
  }
  const env = strictEnvironment(dependencies.env ?? process.env);
  if (!env.ANTHROPIC_API_KEY) {
    return failed(
      request,
      "authentication_failed",
      "Claude Agent SDK requires an Anthropic API key; Claude Free/Pro/Max subscription credentials remain on the ACP path",
    );
  }

  const tools = selectedTools(request);
  const abortController = new AbortController();
  let timedOut = false;
  const forwardAbort = () => abortController.abort(dependencies.abortSignal?.reason ?? new Error("native execution cancelled"));
  if (dependencies.abortSignal?.aborted) forwardAbort();
  else dependencies.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    abortController.abort(new Error(`Claude native turn timed out after ${request.timeoutMs}ms`));
  }, request.timeoutMs);

  const options: ClaudeOptions = {
    cwd: request.cwd,
    ...(request.model ? { model: request.model } : {}),
    ...(request.operation !== "start" ? {
      resume: request.externalSessionId,
      forkSession: request.operation === "fork",
    } : {}),
    abortController,
    env: { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: "opc-studio/0.1.0" },
    tools,
    allowedTools: tools,
    disallowedTools: ["WebFetch", "WebSearch"],
    permissionMode: "dontAsk",
    settingSources: [],
    skills: [],
    persistSession: true,
    includePartialMessages: true,
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: false,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [], strictAllowlist: true, allowLocalBinding: false },
      filesystem: { allowRead: [request.cwd], allowWrite: request.sandbox === "workspace-write" ? [request.cwd] : [] },
    },
    managedSettings: {
      permissions: { deny: ["WebFetch", "WebSearch"] },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: [], strictAllowlist: true, allowManagedDomainsOnly: true },
        filesystem: { allowRead: [request.cwd], allowWrite: request.sandbox === "workspace-write" ? [request.cwd] : [] },
      },
    },
    canUseTool: async (toolName, input) => tools.includes(toolName)
      ? { behavior: "allow" as const, updatedInput: input }
      : { behavior: "deny" as const, message: `${toolName} is outside the OPC effective capability manifest` },
  };

  const events: NativeRunResult["events"] = [];
  let sequence = 0;
  let stream: ClaudeQuery | undefined;
  try {
    stream = (dependencies.query ?? claudeQuery)({ prompt: request.prompt, options });
    for await (const sdkMessage of stream as AsyncIterable<SDKMessage>) {
      events.push(mapClaudeStreamEvent(sdkMessage, { runId: request.runId, sequence: sequence++, now: dependencies.now }));
      const record = asRecord(sdkMessage);
      if (record.type !== "result") continue;
      const resultTokens = usage(record.usage);
      const cost = Number(record.total_cost_usd);
      const sessionId = typeof record.session_id === "string" ? record.session_id : request.externalSessionId;
      if (record.subtype === "success" && record.is_error !== true) {
        return {
          schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
          requestId: request.requestId,
          runId: request.runId,
          status: "done",
          content: typeof record.result === "string" ? record.result : messageText(asRecord(record.message).content),
          tokens: resultTokens,
          costUsd: Number.isFinite(cost) ? Math.max(0, cost) : null,
          events,
          ...(sessionId ? {
            session: {
              schemaVersion: "1",
              host: "claude-code",
              adapterId: "opc.claude-agent-sdk",
              adapterVersion: "0.3.220",
              externalSessionId: sessionId,
              capabilities: ["start", "resume", "fork", "interrupt", "approval", "events"],
            },
          } : {}),
          negotiation: {
            adapterId: "opc.claude-agent-sdk",
            adapterVersion: "0.3.220",
            hostVersion: "0.3.220",
            protocolVersion: "claude-agent-sdk",
            compatible: true,
          },
        };
      }
      const errors = Array.isArray(record.errors) ? record.errors.join("; ") : String(record.subtype ?? "Claude Agent SDK failed");
      const permissionDenied = Array.isArray(record.permission_denials) && record.permission_denials.length > 0;
      const kind = classifyFailure(errors, permissionDenied);
      const base = failed(request, kind, errors, events);
      return {
        ...base,
        tokens: resultTokens,
        costUsd: Number.isFinite(cost) ? Math.max(0, cost) : null,
      };
    }
    return failed(request, "invalid_response", "Claude Agent SDK stream ended without a result message", events);
  } catch (error) {
    const message = timedOut ? `Claude native turn timed out after ${request.timeoutMs}ms` : error instanceof Error ? error.message : String(error);
    return failed(request, timedOut ? "timeout" : classifyFailure(message, false), message, events);
  } finally {
    clearTimeout(timer);
    dependencies.abortSignal?.removeEventListener("abort", forwardAbort);
    if (abortController.signal.aborted) {
      try { await stream?.interrupt(); } catch { /* process cleanup continues in the SDK */ }
    }
    try { stream?.close(); } catch { /* already closed */ }
  }
}
