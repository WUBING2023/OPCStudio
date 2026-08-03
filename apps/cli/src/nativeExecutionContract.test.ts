import { describe, expect, it } from "vitest";
import {
  CompanySchema,
  NativeExecutionPreferenceSchema,
  parseNativeRunRequest,
  parseNativeRunResult,
} from "@opc/shared";

describe("native execution contract consumption", () => {
  it("keeps ACP as the default execution path", () => {
    expect(NativeExecutionPreferenceSchema.parse({})).toEqual({
      preference: "acp",
      fallback: "acp",
    });
  });

  it("rejects undeclared fields at the process boundary", () => {
    expect(() => parseNativeRunRequest({
      schemaVersion: "1",
      requestId: "req-1",
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-1",
      host: "codex",
      cwd: "C:/work",
      prompt: "work",
      timeoutMs: 10_000,
      apiKey: "must-not-cross-the-boundary",
    })).toThrow();
  });

  it("preserves an honest blocked result", () => {
    const result = parseNativeRunResult({
      schemaVersion: "1",
      requestId: "req-1",
      runId: "run-1",
      status: "blocked",
      failureKind: "version_incompatible",
      content: "",
      tokens: { prompt: 0, completion: 0, total: 0 },
      events: [],
    });

    expect(result.status).toBe("blocked");
    expect(result.session).toBeUndefined();
  });

  it("round-trips company native preferences through the shared schema", () => {
    const company = CompanySchema.parse({
      id: "company-1",
      name: "Native Team",
      description: "",
      createdAt: "2026-08-02T00:00:00.000Z",
      nativeExecution: { preference: "codex-native", fallback: "blocked" },
    });

    expect(company.nativeExecution).toEqual({
      preference: "codex-native",
      fallback: "blocked",
    });
  });
});
