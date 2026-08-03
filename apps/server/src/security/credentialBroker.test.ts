import { afterEach, describe, expect, it } from "vitest";
import {
  __credentialLeaseCountForTest,
  consumeCredentialLease,
  issueCredentialLease,
  revokeCredentialLease,
} from "./credentialBroker.js";

const issued: string[] = [];
afterEach(() => {
  for (const ref of issued.splice(0)) revokeCredentialLease(ref);
});

describe("credentialBroker", () => {
  it("returns an opaque one-time reference bound to run/task/agent", () => {
    const handle = issueCredentialLease({
      runId: "run-1", taskId: "task-1", agentId: "agent-1",
      environmentName: "ANTHROPIC_AUTH_TOKEN", secret: "super-secret-value",
    });
    issued.push(handle.ref);
    expect(JSON.stringify(handle)).not.toContain("super-secret-value");
    expect(handle.ref).toMatch(/^cred_[A-Za-z0-9_-]+$/);
    expect(consumeCredentialLease(handle.ref, { runId: "run-1", taskId: "task-1", agentId: "agent-1" }))
      .toEqual({ environmentName: "ANTHROPIC_AUTH_TOKEN", secret: "super-secret-value" });
    expect(() => consumeCredentialLease(handle.ref, { runId: "run-1", taskId: "task-1", agentId: "agent-1" }))
      .toThrow(/missing, expired, or already consumed/);
  });

  it("destroys a lease when a consumer presents the wrong scope", () => {
    const handle = issueCredentialLease({
      runId: "run-1", taskId: "task-1", agentId: "agent-1",
      environmentName: "TOKEN", secret: "secret",
    });
    issued.push(handle.ref);
    expect(() => consumeCredentialLease(handle.ref, { runId: "other", taskId: "task-1", agentId: "agent-1" }))
      .toThrow(/scope mismatch/);
    expect(__credentialLeaseCountForTest()).toBe(0);
  });
});

