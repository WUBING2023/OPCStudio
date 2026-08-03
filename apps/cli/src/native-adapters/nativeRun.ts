import {
  NATIVE_EXECUTION_SCHEMA_VERSION,
  type NativeExecutionFailureKind,
  type NativeRunResult,
} from "@opc/shared";
import { CodexAppServerTransport, readInstalledCodexVersion } from "./codexAppServer.js";
import { mapCodexNotification } from "./eventMapping.js";
import { createNativeAdapter, NativeAdapterError, negotiateNativeCapabilities } from "./nativeAdapter.js";
import { CODEX_NATIVE_PROFILE } from "./profiles.js";
import type { NativeRunnerRequest, NativeTransport } from "./types.js";

type JsonRecord = Record<string, unknown>;
type ObservableTransport = NativeTransport & { onMessage(listener: (message: JsonRecord) => void): () => void };

export interface NativeRunDependencies {
  transport?: ObservableTransport;
  hostVersion?: string;
  codexCommand?: string;
  now?: () => string;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function textFromItem(value: unknown): string {
  const item = asRecord(value);
  const raw = item.text ?? item.message ?? item.content;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((part) => {
    const record = asRecord(part);
    return typeof record.text === "string" ? record.text : "";
  }).filter(Boolean).join("");
  return "";
}

function usageFromMessage(message: JsonRecord): { prompt: number; completion: number; total: number } | null {
  const params = asRecord(message.params);
  const turn = asRecord(params.turn);
  const threadUsage = asRecord(params.tokenUsage);
  const usage = asRecord(threadUsage.last ?? threadUsage.total ?? params.usage ?? turn.usage ?? params.tokenUsage);
  const prompt = Number(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens ?? 0);
  const completion = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? prompt + completion);
  if (![prompt, completion, total].every(Number.isFinite)) return null;
  return { prompt: Math.max(0, prompt), completion: Math.max(0, completion), total: Math.max(0, total) };
}

function blocked(
  request: NativeRunnerRequest,
  failureKind: NativeExecutionFailureKind,
  message: string,
  extra: Partial<NativeRunResult> = {},
): NativeRunResult {
  return {
    schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    status: "blocked",
    failureKind,
    message,
    content: "",
    tokens: { prompt: 0, completion: 0, total: 0 },
    costUsd: null,
    events: [],
    ...extra,
  };
}

function failed(
  request: NativeRunnerRequest,
  failureKind: NativeExecutionFailureKind,
  message: string,
): NativeRunResult {
  return {
    schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
    requestId: request.requestId,
    runId: request.runId,
    status: "failed",
    failureKind,
    message,
    content: "",
    tokens: { prompt: 0, completion: 0, total: 0 },
    costUsd: null,
    events: [],
  };
}

function failureKind(error: unknown): NativeExecutionFailureKind {
  if (error instanceof NativeAdapterError) {
    if (error.code === "version_drift") return "version_incompatible";
    if (error.code === "capability_unavailable") return "capability_unavailable";
    if (error.code === "rejected") return "approval_rejected";
    if (error.code === "timeout") return "timeout";
    if (error.code === "transport_crash") return "process_crash";
    if (error.code === "invalid_native_response") return "invalid_response";
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT|not recognized|not found/i.test(message)) return "native_unavailable";
  if (/timeout|timed out/i.test(message)) return "timeout";
  return "process_crash";
}

function sessionContractError(request: NativeRunnerRequest): string | undefined {
  if (request.operation === "start") return undefined;
  const session = request.externalSessionRef;
  const sessionId = session?.externalSessionId ?? request.externalSessionId;
  const turnId = session?.externalTurnId ?? request.externalTurnId;
  if (!sessionId) return request.operation + " requires an ExternalSessionRef with externalSessionId";
  if (session && session.host !== "codex") return "ExternalSessionRef host does not match codex";
  if (session && session.adapterId !== CODEX_NATIVE_PROFILE.adapterId) {
    return "ExternalSessionRef adapterId does not match " + CODEX_NATIVE_PROFILE.adapterId;
  }
  if (session?.capabilities.length && !session.capabilities.includes(request.operation)) {
    return "ExternalSessionRef does not declare " + request.operation + " capability";
  }
  if (request.operation === "interrupt" && !turnId) return "interrupt requires externalTurnId";
  return undefined;
}

export async function executeCodexNativeRun(
  request: NativeRunnerRequest,
  dependencies: NativeRunDependencies = {},
): Promise<NativeRunResult> {
  const invalidSession = sessionContractError(request);
  if (invalidSession) return blocked(request, "capability_unavailable", invalidSession);
  const command = dependencies.codexCommand ?? "codex";
  let owned = false;
  let transport = dependencies.transport;
  try {
    if (!transport) {
      const hostVersion = dependencies.hostVersion ?? await readInstalledCodexVersion(command);
      transport = CodexAppServerTransport.start({
        command,
        hostVersion,
        cwd: request.cwd,
        requestTimeoutMs: Math.min(request.timeoutMs, 60_000),
      }) as ObservableTransport;
      owned = true;
    }

    const events: NativeRunResult["events"] = [];
    const content: string[] = [];
    let tokens = { prompt: 0, completion: 0, total: 0 };
    let sequence = 0;
    let settle!: (value: { status: "done" | "failed" | "blocked"; kind?: NativeExecutionFailureKind; message?: string }) => void;
    const terminal = new Promise<{ status: "done" | "failed" | "blocked"; kind?: NativeExecutionFailureKind; message?: string }>((resolve) => { settle = resolve; });

    const unsubscribe = transport.onMessage((message) => {
      const method = typeof message.method === "string" ? message.method : "";
      const params = asRecord(message.params);
      events.push(mapCodexNotification(message, { runId: request.runId, sequence: sequence++, now: dependencies.now }));
      const nextUsage = usageFromMessage(message);
      if (nextUsage) tokens = {
        prompt: Math.max(tokens.prompt, nextUsage.prompt),
        completion: Math.max(tokens.completion, nextUsage.completion),
        total: Math.max(tokens.total, nextUsage.total),
      };
      if (method === "item/completed") {
        const item = asRecord(params.item);
        if (/agent.?message/i.test(String(item.type ?? ""))) {
          const text = textFromItem(item);
          if (text) content.push(text);
        }
      }
      if (method === "transport/crashed") {
        settle({ status: "failed", kind: "process_crash", message: String(params.message ?? "Codex app-server crashed") });
      } else if (method === "turn/completed") {
        const turn = asRecord(params.turn);
        const status = String(turn.status ?? params.status ?? "");
        settle(status === "completed"
          ? { status: "done" }
          : { status: "failed", kind: "host_failed", message: `Codex turn ended with status ${status || "unknown"}` });
      } else if (message.id !== undefined && /requestApproval$/.test(method)) {
        void transport!.respond?.(message.id as string | number, { decision: "decline" })
          .then(() => settle({
            status: "blocked",
            kind: "approval_rejected",
            message: request.approvalPolicy === "on-request"
              ? "Native approval requires an external approval broker; this headless request supplied no approved decision"
              : "Native approval was denied by the explicit never-approve OPC policy",
          }))
          .catch((error) => settle({ status: "failed", kind: "process_crash", message: error instanceof Error ? error.message : String(error) }));
      }
    });

    try {
      const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
      const negotiationResult = {
        adapterId: negotiation.adapterId,
        adapterVersion: negotiation.adapterVersion,
        ...(negotiation.hostVersion ? { hostVersion: negotiation.hostVersion } : {}),
        ...(negotiation.protocolVersion ? { protocolVersion: negotiation.protocolVersion } : {}),
        compatible: negotiation.compatible,
        ...(negotiation.degradationReason ? { degradationReason: negotiation.degradationReason } : {}),
      };
      if (!negotiation.compatible) {
        return blocked(request, "version_incompatible", negotiation.degradationReason ?? "Codex native version is incompatible", {
          events,
          negotiation: negotiationResult,
        });
      }
      if (!negotiation.capabilities[request.operation]) {
        return blocked(request, "capability_unavailable", "Codex host does not support native " + request.operation, {
          events,
          negotiation: negotiationResult,
        });
      }
      const adapter = createNativeAdapter(CODEX_NATIVE_PROFILE, transport);
      const externalSessionId = request.externalSessionRef?.externalSessionId ?? request.externalSessionId;
      const externalTurnId = request.externalSessionRef?.externalTurnId ?? request.externalTurnId;
      const execution = request.operation === "start"
        ? await adapter.start({
          runId: request.runId,
          cwd: request.cwd,
          prompt: request.prompt,
          model: request.model,
          approvalPolicy: request.approvalPolicy,
          sandbox: request.sandbox,
        })
        : request.operation === "resume"
          ? await adapter.resume({
            runId: request.runId,
            externalSessionId: externalSessionId!,
            prompt: request.prompt,
            approvalPolicy: request.approvalPolicy,
          })
          : request.operation === "fork"
            ? await adapter.fork({
              runId: request.runId,
              externalSessionId: externalSessionId!,
              lastTurnId: externalTurnId,
              prompt: request.prompt,
              approvalPolicy: request.approvalPolicy,
            })
            : undefined;
      if (request.operation === "interrupt") {
        await adapter.interrupt({
          externalSessionId: externalSessionId!,
          externalTurnId,
        });
        return {
          schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
          requestId: request.requestId,
          runId: request.runId,
          status: "done",
          content: "",
          tokens,
          costUsd: null,
          events,
          session: request.externalSessionRef ?? {
            schemaVersion: "1",
            host: "codex",
            adapterId: CODEX_NATIVE_PROFILE.adapterId,
            adapterVersion: CODEX_NATIVE_PROFILE.adapterVersion,
            externalSessionId,
            externalTurnId,
            capabilities: ["interrupt"],
          },
          negotiation: negotiationResult,
        };
      }
      const timeout = setTimeout(() => settle({ status: "failed", kind: "timeout", message: `Native turn timed out after ${request.timeoutMs}ms` }), request.timeoutMs);
      const terminalResult = await terminal;
      clearTimeout(timeout);
      return {
        schemaVersion: NATIVE_EXECUTION_SCHEMA_VERSION,
        requestId: request.requestId,
        runId: request.runId,
        status: terminalResult.status,
        ...(terminalResult.kind ? { failureKind: terminalResult.kind } : {}),
        ...(terminalResult.message ? { message: terminalResult.message } : {}),
        content: content.join("\n").trim(),
        tokens,
        costUsd: null,
        events,
        session: execution!.session,
        negotiation: negotiationResult,
      };
    } finally {
      unsubscribe();
    }
  } catch (error) {
    const kind = failureKind(error);
    const message = error instanceof Error ? error.message : String(error);
    return ["native_unavailable", "version_incompatible", "capability_unavailable", "approval_rejected"].includes(kind)
      ? blocked(request, kind, message)
      : failed(request, kind, message);
  } finally {
    if (owned) await transport?.close?.().catch(() => {});
  }
}
