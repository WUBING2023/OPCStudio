import {
  NATIVE_ADAPTER_CONTRACT_VERSION,
  type NativeAdapter,
  type NativeAdapterProfile,
  type NativeApprovalDecision,
  type NativeExecutionRef,
  type NativeForkInput,
  type NativeInterruptInput,
  type NativeNegotiation,
  type NativeOperation,
  type NativeResumeInput,
  type NativeStartInput,
  type NativeTransport,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

export class NativeAdapterError extends Error {
  constructor(
    readonly code: "rejected" | "quota_exceeded" | "timeout" | "transport_crash" | "version_drift" | "capability_unavailable" | "invalid_native_response" | "native_transport_error",
    message: string,
    readonly details: JsonRecord = {},
    readonly retryable = false,
  ) {
    super(message);
    this.name = "NativeAdapterError";
  }
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizedTransportError(error: unknown): NativeAdapterError {
  if (error instanceof NativeAdapterError) return error;
  const record = asRecord(error);
  const nested = asRecord(record.error);
  const rawCode = String(record.code ?? nested.code ?? (error instanceof Error ? error.name : "")).toLowerCase();
  const message = String(record.message ?? nested.message ?? (error instanceof Error ? error.message : "Native transport failed"));
  if (/permission|denied|declined|rejected|unauthorized/.test(rawCode)) {
    return new NativeAdapterError("rejected", message, record, false);
  }
  if (/quota|rate.?limit|resource.?exhausted|429/.test(rawCode)) {
    return new NativeAdapterError("quota_exceeded", message, record, true);
  }
  if (/timeout|timed.?out/.test(rawCode) || /timeout|timed out/i.test(message)) {
    return new NativeAdapterError("timeout", message, record, true);
  }
  if (/crash|disconnect|closed|epipe|econnreset|transport/.test(rawCode)) {
    return new NativeAdapterError("transport_crash", message, record, true);
  }
  if (/version|protocol|schema/.test(rawCode)) {
    return new NativeAdapterError("version_drift", message, record, false);
  }
  return new NativeAdapterError("native_transport_error", message, record, false);
}

function parseVersion(value: string): [number, number, number] | null {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function isHostVersionCompatible(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const lower = range.match(/>=(\d+\.\d+\.\d+)/)?.[1];
  const upper = range.match(/<(\d+\.\d+\.\d+)/)?.[1];
  if (lower && compareVersion(parsed, parseVersion(lower)!) < 0) return false;
  if (upper && compareVersion(parsed, parseVersion(upper)!) >= 0) return false;
  return true;
}

export async function negotiateNativeCapabilities(
  profile: NativeAdapterProfile,
  transport: NativeTransport,
  now: () => string = () => new Date().toISOString(),
): Promise<NativeNegotiation> {
  let hello;
  try {
    hello = transport.initialize
      ? await transport.initialize(profile)
      : { schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION };
  } catch (error) {
    throw normalizedTransportError(error);
  }
  const contractCompatible = hello.schemaVersion === NATIVE_ADAPTER_CONTRACT_VERSION;
  const hostVersion = hello.hostVersion?.trim() || undefined;
  const hostCompatible = Boolean(hostVersion && isHostVersionCompatible(hostVersion, profile.compatibleHostVersions));
  const degradationReason = !contractCompatible
    ? "contract_version_incompatible" as const
    : !hostVersion
      ? "host_version_unverified" as const
      : !hostCompatible ? "host_version_incompatible" as const : undefined;
  const capabilities = Object.fromEntries(
    (Object.keys(profile.capabilities) as NativeOperation[]).map((operation) => [
      operation,
      profile.capabilities[operation].state === "supported" && hello.capabilities?.[operation] !== false,
    ]),
  ) as NativeNegotiation["capabilities"];
  return {
    schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    host: profile.host,
    hostVersion,
    protocolVersion: hello.protocolVersion,
    compatibleHostVersions: profile.compatibleHostVersions,
    compatible: contractCompatible && hostCompatible,
    capabilities,
    degradationReason,
    negotiatedAt: now(),
  };
}

function requireCapability(profile: NativeAdapterProfile, operation: NativeOperation): void {
  if (profile.capabilities[operation].state !== "supported") {
    throw new NativeAdapterError("capability_unavailable", `${profile.host} native ${operation} is unavailable`, {
      evidence: profile.capabilities[operation].evidence,
    });
  }
}

function externalSession(
  profile: NativeAdapterProfile,
  sessionId: string,
  turnId?: string,
): NativeExecutionRef["session"] {
  return {
    schemaVersion: "1",
    host: profile.host,
    adapterId: profile.adapterId,
    adapterVersion: profile.adapterVersion,
    externalSessionId: sessionId,
    ...(turnId ? { externalTurnId: turnId } : {}),
    capabilities: (Object.keys(profile.capabilities) as NativeOperation[])
      .filter((operation) => profile.capabilities[operation].state === "supported"),
  };
}

async function request<T>(transport: NativeTransport, method: string, params: unknown): Promise<T> {
  try {
    return await transport.request<T>(method, params);
  } catch (error) {
    throw normalizedTransportError(error);
  }
}

function requiredMethod(profile: NativeAdapterProfile, operation: Exclude<NativeOperation, "events" | "approval">): string {
  const method = profile.methods[operation];
  if (!method) throw new NativeAdapterError("capability_unavailable", `No native method is bound for ${operation}`);
  return method;
}

export function createNativeAdapter(profile: NativeAdapterProfile, transport: NativeTransport): NativeAdapter {
  return {
    profile,
    async start(input: NativeStartInput): Promise<NativeExecutionRef> {
      requireCapability(profile, "start");
      if (profile.host === "codex") {
        const threadResponse = asRecord(await request(transport, requiredMethod(profile, "start"), {
          cwd: input.cwd,
          ...(input.model ? { model: input.model } : {}),
          ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
          ...(input.sandbox ? { sandbox: input.sandbox } : {}),
          serviceName: "opc-studio",
        }));
        const thread = asRecord(threadResponse.thread);
        const threadId = identifier(thread.id);
        if (!threadId) throw new NativeAdapterError("invalid_native_response", "Codex thread/start did not return thread.id");
        const turnResponse = asRecord(await request(transport, "turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt }],
        }));
        const turnId = identifier(asRecord(turnResponse.turn).id);
        return { session: externalSession(profile, threadId, turnId), raw: { thread: threadResponse, turn: turnResponse } };
      }
      const response = asRecord(await request(transport, requiredMethod(profile, "start"), input));
      const sessionId = identifier(response.sessionId ?? response.session_id);
      if (!sessionId) throw new NativeAdapterError("invalid_native_response", "Claude native start did not return a session id");
      return { session: externalSession(profile, sessionId, identifier(response.turnId ?? response.turn_id)), raw: response };
    },
    async resume(input: NativeResumeInput): Promise<NativeExecutionRef> {
      requireCapability(profile, "resume");
      const response = asRecord(await request(transport, requiredMethod(profile, "resume"), profile.host === "codex"
        ? {
          threadId: input.externalSessionId,
          ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        }
        : { sessionId: input.externalSessionId, prompt: input.prompt }));
      const sessionId = profile.host === "codex"
        ? identifier(asRecord(response.thread).id) ?? input.externalSessionId
        : identifier(response.sessionId ?? response.session_id) ?? input.externalSessionId;
      let raw: unknown = response;
      let turnId: string | undefined;
      if (profile.host === "codex" && input.prompt) {
        const turn = asRecord(await request(transport, "turn/start", {
          threadId: sessionId,
          input: [{ type: "text", text: input.prompt }],
        }));
        turnId = identifier(asRecord(turn.turn).id);
        raw = { resume: response, turn };
      }
      return { session: externalSession(profile, sessionId, turnId), raw };
    },
    async fork(input: NativeForkInput): Promise<NativeExecutionRef> {
      requireCapability(profile, "fork");
      const response = asRecord(await request(transport, requiredMethod(profile, "fork"), profile.host === "codex"
        ? {
          threadId: input.externalSessionId,
          ...(input.lastTurnId ? { lastTurnId: input.lastTurnId } : {}),
          ...(input.approvalPolicy ? { approvalPolicy: input.approvalPolicy } : {}),
        }
        : { sessionId: input.externalSessionId }));
      const sessionId = profile.host === "codex"
        ? identifier(asRecord(response.thread).id)
        : identifier(response.sessionId ?? response.session_id);
      if (!sessionId) throw new NativeAdapterError("invalid_native_response", `${profile.host} native fork did not return a session id`);
      if (profile.host === "codex" && input.prompt) {
        const turn = asRecord(await request(transport, "turn/start", {
          threadId: sessionId,
          input: [{ type: "text", text: input.prompt }],
        }));
        return {
          session: externalSession(profile, sessionId, identifier(asRecord(turn.turn).id)),
          raw: { fork: response, turn },
        };
      }
      return { session: externalSession(profile, sessionId), raw: response };
    },
    async interrupt(input: NativeInterruptInput): Promise<void> {
      requireCapability(profile, "interrupt");
      if (profile.host === "claude-code" && transport.interrupt) {
        try { await transport.interrupt(input.externalSessionId, input.externalTurnId); }
        catch (error) { throw normalizedTransportError(error); }
        return;
      }
      await request(transport, requiredMethod(profile, "interrupt"), profile.host === "codex"
        ? { threadId: input.externalSessionId, turnId: input.externalTurnId }
        : { sessionId: input.externalSessionId, turnId: input.externalTurnId });
    },
    async resolveApproval(input: NativeApprovalDecision): Promise<void> {
      requireCapability(profile, "approval");
      if (!transport.respond) throw new NativeAdapterError("capability_unavailable", "Native transport cannot answer server-initiated approval requests");
      const decision = input.decision === "approved"
        ? "accept"
        : input.decision === "approved_for_session" ? "acceptForSession"
          : input.decision === "rejected" ? "decline" : "cancel";
      try { await transport.respond(input.approvalId, { decision }); }
      catch (error) { throw normalizedTransportError(error); }
    },
  };
}
