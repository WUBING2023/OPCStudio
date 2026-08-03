import { describe, expect, it } from "vitest";
import {
  NativeExecutionPreferenceSchema,
  parseNativeRunRequest,
  parseNativeRunResult,
} from "./nativeExecutionContract.js";
import { CompanySchema } from "./schemas.js";

describe("native execution contract", () => {
  it("defaults to the existing ACP route", () => {
    expect(NativeExecutionPreferenceSchema.parse({})).toEqual({ preference: "acp", fallback: "acp" });
  });

  it("rejects unknown fields so auth material cannot hitchhike across the boundary", () => {
    expect(() => parseNativeRunRequest({
      schemaVersion: "1", requestId: "req-1", runId: "run-1", taskId: "task-1", agentId: "agent-1",
      host: "codex", cwd: "C:/work", prompt: "work", timeoutMs: 10_000, apiKey: "secret",
    })).toThrow();
  });

  it("requires a session id for resume and fork operations", () => {
    expect(() => parseNativeRunRequest({
      schemaVersion: "1", requestId: "req-1", runId: "run-1", taskId: "task-1", agentId: "agent-1",
      host: "claude-code", operation: "resume", cwd: "C:/work", prompt: "continue", timeoutMs: 10_000,
    })).toThrow(/externalSessionId/);
  });

  it("parses a blocked result without inventing a successful session", () => {
    const result = parseNativeRunResult({
      schemaVersion: "1", requestId: "req-1", runId: "run-1", status: "blocked",
      failureKind: "version_incompatible", content: "", tokens: { prompt: 0, completion: 0, total: 0 }, events: [],
    });
    expect(result.status).toBe("blocked");
    expect(result.session).toBeUndefined();
  });

  it("persists company-level native preference through the public company schema", () => {
    const company = CompanySchema.parse({
      id: "company-1",
      name: "Native Team",
      description: "",
      createdAt: "2026-08-02T00:00:00.000Z",
      nativeExecution: { preference: "codex-native", fallback: "blocked" },
    });
    expect(company.nativeExecution).toEqual({ preference: "codex-native", fallback: "blocked" });
  });
});
