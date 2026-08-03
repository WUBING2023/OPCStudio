import { describe, expect, it } from "vitest";
import type { Run } from "@opc/shared";
import {
  loadArtifactPreview,
  loadCompanyPlanProposal,
  loadEmbeddedEcosystemSnapshot,
  submitCompanyPlanApply,
  submitGovernanceDecision,
  type EcosystemHttpClient,
  type ReadonlyHttpClient,
} from "./api.js";

function runFixture(): Run {
  return {
    id: "run-1",
    userGoal: "ship a real artifact",
    companyId: "co-1",
    status: "done",
    startedAt: "2026-08-02T00:00:00.000Z",
    totalTokens: 120,
    participatingAgents: [],
  };
}

describe("embedded ecosystem HTTP boundary", () => {
  it("loads only existing read-only API resources", async () => {
    const calls: string[] = [];
    const responses: Record<string, unknown> = {
      "/runs": [{ id: "run-1", goal: "ship a real artifact", status: "done", companyId: "co-1" }],
      "/governance/records?limit=50": [],
      "/companies": [{ id: "co-1", name: "Company", description: "", createdAt: "2026-08-02T00:00:00.000Z" }],
      "/agents": [],
      "/runs/run-1": runFixture(),
      "/runs/run-1/artifacts": { runId: "run-1", degraded: false, artifacts: [] },
      "/runs/run-1/evidence": {
        schemaVersion: 1,
        runId: "run-1",
        generatedAt: "2026-08-02T00:00:00.000Z",
        files: [],
        workspaceChanges: [],
        artifactDownloads: [],
        tests: null,
      },
    };
    const client: ReadonlyHttpClient = {
      async get<T>(path: string): Promise<T> {
        calls.push(path);
        return responses[path] as T;
      },
    };

    const snapshot = await loadEmbeddedEcosystemSnapshot(client, { runId: "run-1" });
    expect(snapshot.selectedRun?.status).toBe("done");
    expect(calls).toEqual([
      "/runs",
      "/governance/records?limit=50",
      "/companies",
      "/agents",
      "/runs/run-1",
      "/runs/run-1/artifacts",
      "/runs/run-1/evidence",
    ]);
    expect(calls.every((path) => !/keys|secret|local|\/file(?:\?|\/|$)/i.test(path))).toBe(true);
  });

  it("encodes artifact identifiers before using the preview API", async () => {
    let requested = "";
    const client: ReadonlyHttpClient = {
      async get<T>(path: string): Promise<T> {
        requested = path;
        return {
          content: "ok",
          contentType: "text/plain",
          filename: "x.txt",
          truncated: false,
          totalBytes: 2,
          previewBytes: 2,
        } as T;
      },
    };
    await loadArtifactPreview(client, "run/unsafe", "artifact?unsafe");
    expect(requested).toBe("/runs/run%2Funsafe/artifacts/preview?artifactId=artifact%3Funsafe");
  });

  it("uses authoritative Run detail state instead of a stale list projection", async () => {
    const responses: Record<string, unknown> = {
      "/runs": [{ id: "run-1", goal: "stale", status: "done", companyId: "co-1" }],
      "/governance/records?limit=50": [],
      "/companies": [{ id: "co-1", name: "Company", description: "", createdAt: "2026-08-02T00:00:00.000Z" }],
      "/agents": [],
      "/runs/run-1": { ...runFixture(), status: "failed" },
      "/runs/run-1/artifacts": { runId: "run-1", degraded: true, artifacts: [] },
      "/runs/run-1/evidence": { schemaVersion: 1, runId: "run-1", generatedAt: "2026-08-02T00:00:00.000Z", files: [], workspaceChanges: [], artifactDownloads: [], tests: null },
    };
    const client: ReadonlyHttpClient = { async get<T>(path: string) { return responses[path] as T; } };
    expect((await loadEmbeddedEcosystemSnapshot(client, { runId: "run-1" })).selectedRun?.status).toBe("failed");
  });

  it("refreshing the snapshot remains GET-only and never creates a Run", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const responses: Record<string, unknown> = {
      "/runs": [],
      "/governance/records?limit=50": [],
      "/companies": [],
      "/agents": [],
    };
    const client: EcosystemHttpClient = {
      async get<T>(path: string) { calls.push({ method: "GET", path }); return responses[path] as T; },
      async post<T>(path: string) { calls.push({ method: "POST", path }); throw new Error("unexpected POST"); },
    };
    await loadEmbeddedEcosystemSnapshot(client, {});
    await loadEmbeddedEcosystemSnapshot(client, {});
    expect(calls).toHaveLength(8);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(calls.some((call) => /start_run|chat\/task|mission/i.test(call.path))).toBe(false);
  });

  it("submits only an explicit decision against an existing encoded run id", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const record = {
      runId: "run/1",
      level: "L3",
      reason: ["write"],
      decidedAt: "2026-08-02T00:00:00.000Z",
      approvalRequired: true,
      approval: { status: "approved" as const },
    };
    const client: EcosystemHttpClient = {
      async get<T>() { throw new Error("unexpected GET"); },
      async post<T>(path: string, body: unknown) {
        calls.push({ path, body });
        return { record } as T;
      },
    };
    await expect(submitGovernanceDecision(client, "run/1", "approve")).resolves.toEqual(record);
    expect(calls).toEqual([{
      path: "/governance/runs/run%2F1/approve",
      body: { decidedBy: "embedded-ui" },
    }]);
    expect(calls[0].path).not.toMatch(/start|create|chat\/task/i);
  });

  it("fails closed when a host exposes no confirmation channel", async () => {
    const client: EcosystemHttpClient = { async get<T>() { return undefined as T; } };
    await expect(submitGovernanceDecision(client, "run-1", "reject")).rejects.toThrow("未提供安全确认通道");
  });

  it("loads a server-bound company proposal with comparison data", async () => {
    const client: ReadonlyHttpClient = {
      async get<T>(path: string) {
        expect(path).toBe("/companies/co-1/architect-proposals/plan-1");
        return {
          proposalId: "plan-1", companyId: "co-1", summary: "Add verification",
          beforeHash: "a".repeat(64), actionsHash: "b".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z", status: "pending",
          preview: {
            before: { agentCount: 1, roleCount: 1, verificationEdgeCount: 0, a2aChannelCount: 0, requiredSkillCount: 0 },
            after: { agentCount: 2, roleCount: 2, verificationEdgeCount: 1, a2aChannelCount: 0, requiredSkillCount: 0 },
            risks: ["permission_expansion"],
          },
        } as T;
      },
    };
    await expect(loadCompanyPlanProposal(client, "co-1", "plan-1")).resolves.toMatchObject({
      proposalId: "plan-1", status: "pending", after: { agentCount: 2 }, risks: ["permission_expansion"],
    });
  });

  it("uses the server-issued high-risk receipt only after another explicit confirmation", async () => {
    const calls: unknown[] = [];
    const client: EcosystemHttpClient = {
      async get<T>() { throw new Error("unexpected GET"); },
      async post<T>(path: string, body: unknown) {
        calls.push({ path, body });
        if (calls.length === 1) {
          const error = new Error("confirmation required") as Error & { status: number; body: unknown };
          error.status = 428;
          error.body = { confirmationToken: "receipt-1", tokenExpiresAt: "2099-01-01T00:00:00.000Z", highRisk: [{ kind: "remove_agent" }] };
          throw error;
        }
        return { applied: true } as T;
      },
    };
    const intent = {
      kind: "company-plan-apply" as const, proposalId: "plan-1", companyId: "co-1",
      beforeHash: "a".repeat(64), actionsHash: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
      createsRun: false as const,
    };
    const first = await submitCompanyPlanApply(client, intent);
    expect(first).toMatchObject({ applied: false, requiresConfirmation: true, confirmationReceipt: "receipt-1", highRisk: ["remove_agent"] });
    await expect(submitCompanyPlanApply(client, intent, first.confirmationReceipt)).resolves.toEqual({ applied: true });
    expect(calls[1]).toEqual({
      path: "/companies/co-1/architect-apply",
      body: { proposalId: "plan-1", confirmationToken: "receipt-1" },
    });
  });
});
