import { describe, expect, it } from "vitest";
import {
  NativeAdapterError,
  createNativeAdapter,
  negotiateNativeCapabilities,
} from "./nativeAdapter.js";
import { FakeNativeTransport } from "./testing/fakeTransport.js";
import { decideNativeRoute } from "./routing.js";
import { createShadowComparison } from "./shadow.js";
import { mapCodexApprovalRequest, mapCodexNotification, mapClaudeStreamEvent } from "./eventMapping.js";
import { CODEX_NATIVE_PROFILE, CLAUDE_NATIVE_PROFILE } from "./profiles.js";

describe("native adapter foundation", () => {
  it.each([
    ["permission_denied", "rejected", false],
    ["quota_exceeded", "quota_exceeded", true],
    ["transport_timeout", "timeout", true],
    ["transport_crashed", "transport_crash", true],
  ] as const)("maps %s failures without inventing success", async (transportCode, expectedCode, retryable) => {
    const transport = new FakeNativeTransport();
    transport.reject("thread/start", { code: transportCode, message: transportCode });
    const adapter = createNativeAdapter(CODEX_NATIVE_PROFILE, transport);
    await expect(adapter.start({ runId: "run-1", cwd: "C:/repo", prompt: "test" })).rejects.toMatchObject({
      code: expectedCode,
      retryable,
    });
  });

  it("fails closed on host version drift and routes explicitly to fallback", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "99.0.0" });
    const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
    expect(negotiation.compatible).toBe(false);
    expect(negotiation.degradationReason).toBe("host_version_incompatible");
    expect(decideNativeRoute({
      operation: "resume",
      host: "codex",
      featureGateEnabled: true,
      fallbackAvailable: true,
      negotiation,
    })).toMatchObject({ route: "fallback", degraded: true, reason: "host_version_incompatible" });
  });

  it("fails closed on adapter contract version drift", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0", schemaVersion: "2" });
    const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
    expect(negotiation).toMatchObject({
      compatible: false,
      degradationReason: "contract_version_incompatible",
    });
  });

  it("keeps the native path behind an explicit feature gate", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
    expect(decideNativeRoute({
      operation: "start",
      host: "codex",
      featureGateEnabled: false,
      fallbackAvailable: true,
      negotiation,
    })).toEqual({ route: "fallback", degraded: true, reason: "feature_gate_disabled" });
  });

  it("uses exact Codex app-server methods for lifecycle and approval", async () => {
    const transport = new FakeNativeTransport();
    transport.respondWith("thread/start", { thread: { id: "thread-1" } });
    transport.respondWith("turn/start", { turn: { id: "turn-1" } });
    transport.respondWith("thread/resume", { thread: { id: "thread-1" } });
    transport.respondWith("thread/fork", { thread: { id: "thread-2" } });
    const adapter = createNativeAdapter(CODEX_NATIVE_PROFILE, transport);
    const started = await adapter.start({
      runId: "run-1",
      cwd: "C:/repo",
      prompt: "work",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    await adapter.resume({
      runId: "run-1",
      externalSessionId: "thread-1",
      approvalPolicy: "never",
    });
    const forked = await adapter.fork({
      runId: "run-1",
      externalSessionId: "thread-1",
      lastTurnId: "turn-1",
      approvalPolicy: "on-request",
    });
    await adapter.interrupt({ externalSessionId: "thread-1", externalTurnId: "turn-1" });
    await adapter.resolveApproval({ approvalId: "17", decision: "approved_for_session" });
    expect(started.session).toMatchObject({ externalSessionId: "thread-1", externalTurnId: "turn-1" });
    expect(forked.session.externalSessionId).toBe("thread-2");
    expect(transport.calls.map((call) => call.method)).toEqual([
      "thread/start", "turn/start", "thread/resume", "thread/fork", "turn/interrupt", "respond",
    ]);
    expect(transport.calls[0]?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    expect(transport.calls[2]?.params).toEqual({ threadId: "thread-1", approvalPolicy: "never" });
    expect(transport.calls[3]?.params).toEqual({
      threadId: "thread-1",
      lastTurnId: "turn-1",
      approvalPolicy: "on-request",
    });
    expect(transport.calls.at(-1)?.params).toEqual({ requestId: "17", result: { decision: "acceptForSession" } });
  });

  it("routes Claude Agent SDK approval decisions through its supported permission contract", async () => {
    const transport = new FakeNativeTransport();
    const adapter = createNativeAdapter(CLAUDE_NATIVE_PROFILE, transport);
    await expect(adapter.resolveApproval({ approvalId: "approval-1", decision: "rejected" })).resolves.toBeUndefined();
    expect(transport.calls.at(-1)).toEqual({
      method: "respond",
      params: { requestId: "approval-1", result: { decision: "decline" } },
    });
  });

  it("maps Codex and Claude events into the shared RunEvent shape", () => {
    const codex = mapCodexNotification({
      method: "turn/completed",
      params: { turn: { id: "turn-1", status: "completed" } },
    }, { runId: "run-1", sequence: 4, now: () => "2026-08-02T00:00:00.000Z" });
    const claude = mapClaudeStreamEvent({ type: "assistant", session_id: "session-1", message: { content: "working" } }, {
      runId: "run-2", sequence: 2, now: () => "2026-08-02T00:00:00.000Z",
    });
    expect(codex).toMatchObject({ schemaVersion: "1", type: "run.completed", runId: "run-1" });
    expect(claude).toMatchObject({ schemaVersion: "1", type: "agent.message", runId: "run-2" });
  });

  it("maps a Codex approval request without retaining auth-shaped fields", () => {
    const approval = mapCodexApprovalRequest(17, "item/commandExecution/requestApproval", {
      reason: "Needs network access",
      cwd: "C:/repo",
      networkApprovalContext: { host: "example.com", protocol: "https" },
      authorization: "Bearer should-not-survive",
    }, {
      runId: "run-1",
      expiresAt: "2026-08-02T00:05:00.000Z",
      idempotencyKey: "approval-17",
    });
    expect(approval).toMatchObject({
      schemaVersion: "1",
      approvalId: "17",
      dataDestinations: ["example.com"],
      impact: { permissions: ["network.connect"] },
      status: "pending",
    });
    expect(JSON.stringify(approval)).not.toContain("should-not-survive");
  });

  it("records shadow disagreement without selecting a winner", () => {
    const record = createShadowComparison({
      runId: "run-1",
      operation: "start",
      native: { status: "completed", artifactHashes: ["sha256:aaa"], durationMs: 100 },
      fallback: { status: "failed", artifactHashes: [], durationMs: 80 },
      createdAt: "2026-08-02T00:00:00.000Z",
    });
    expect(record).toMatchObject({ schemaVersion: "1", equivalent: false });
    expect(record.differences).toEqual(expect.arrayContaining(["status", "artifact_hashes"]));
    expect(record).not.toHaveProperty("winner");
  });
});
