import { describe, expect, it } from "vitest";
import {
  EcosystemContractError,
  parseApprovalRequest,
  parseArtifactRef,
  parseCapabilityNegotiation,
  parseExternalSessionRef,
  parseRunEvent,
} from "@opc/shared";

describe("ecosystem contract compatibility", () => {
  it("preserves canonical RunEvent v1", () => {
    const event = parseRunEvent({
      schemaVersion: "1",
      eventId: "event-1",
      runId: "run-12345678",
      sequence: 4,
      timestamp: "2026-08-02T00:00:00.000Z",
      type: "tool.completed",
      actor: { kind: "tool", id: "shell" },
      payload: { exitCode: 0 },
    });
    expect(event.type).toBe("tool.completed");
    expect(event.sequence).toBe(4);
  });

  it("migrates persisted TraceEvent without losing its original type", () => {
    const event = parseRunEvent({
      id: "legacy-1",
      runId: "run-12345678",
      timestamp: "2026-08-01T00:00:00.000Z",
      type: "tool_result",
      agentId: "agent-1",
      payload: { ok: true },
    }, 7);
    expect(event).toMatchObject({
      schemaVersion: "1",
      eventId: "legacy-1",
      sequence: 7,
      type: "tool.completed",
      actor: { kind: "agent", id: "agent-1" },
      payload: { legacyType: "tool_result", data: { ok: true } },
    });
  });

  it("migrates old external sessions and approval requests", () => {
    expect(parseExternalSessionRef({ host: "codex", adapterId: "codex-native" })).toMatchObject({
      schemaVersion: "1", host: "codex", capabilities: [],
    });
    expect(parseApprovalRequest({
      id: "approval-1",
      runId: "run-12345678",
      action: "write files",
      impact: { summary: "modify workspace" },
      destinations: ["local-worktree"],
      reversible: true,
      source: { kind: "agent", id: "agent-1" },
      expiresAt: "2026-08-03T00:00:00.000Z",
      idempotencyKey: "idem-1",
    })).toMatchObject({
      schemaVersion: "1", approvalId: "approval-1", dataDestinations: ["local-worktree"], status: "pending",
    });
  });

  it("does not invent an artifact hash or verification result", () => {
    const artifact = parseArtifactRef({
      id: "file:index.ts",
      title: "index.ts",
      kind: "file",
      producer: "dev-1",
      path: "src/index.ts",
      status: "added",
    }, "run-12345678");
    expect(artifact.hash).toBeNull();
    expect(artifact.verification.status).toBe("unknown");
    expect(artifact.source?.path).toBe("src/index.ts");
  });

  it("defaults undeclared adapter capabilities to false", () => {
    const negotiation = parseCapabilityNegotiation(
      { streaming: true, approvals: true },
      { adapterId: "legacy", adapterVersion: "0.1", host: "acp" },
    );
    expect(negotiation.capabilities).toEqual(expect.objectContaining({
      streaming: true,
      approvals: true,
      resume: false,
      fork: false,
      subagentEvents: false,
      fileCheckpointing: false,
      structuredOutput: false,
    }));
  });

  it("rejects unknown future schema versions instead of treating them as legacy", () => {
    expect(() => parseRunEvent({
      schemaVersion: "2",
      eventId: "future",
      runId: "run-12345678",
      sequence: 0,
      timestamp: "2026-08-02T00:00:00.000Z",
      type: "run.started",
      payload: {},
    })).toThrow(EcosystemContractError);
  });
});
