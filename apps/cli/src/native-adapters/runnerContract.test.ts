import { describe, expect, it } from "vitest";
import { parseNativeRunnerRequest } from "./runnerContract.js";

const base = {
  schemaVersion: "1",
  requestId: "request-1",
  runId: "run-1",
  taskId: "task-1",
  agentId: "agent-1",
  host: "codex",
  cwd: "C:/work",
  prompt: "continue",
  timeoutMs: 5_000,
  sandbox: "workspace-write",
  allowedTools: [],
};

describe("native runner process contract", () => {
  it("keeps the v1 start request backward compatible", () => {
    expect(parseNativeRunnerRequest(base)).toMatchObject({
      operation: "start",
      approvalPolicy: "never",
    });
  });

  it("normalizes lifecycle ids from ExternalSessionRef", () => {
    expect(parseNativeRunnerRequest({
      ...base,
      operation: "resume",
      approvalPolicy: "on-request",
      externalSessionRef: {
        schemaVersion: "1",
        host: "codex",
        adapterId: "opc.codex-app-server",
        externalSessionId: "thread-1",
        externalTurnId: "turn-1",
        capabilities: ["resume"],
      },
    })).toMatchObject({
      operation: "resume",
      approvalPolicy: "on-request",
      externalSessionId: "thread-1",
      externalTurnId: "turn-1",
    });
  });

  it.each([
    [{ ...base, operation: "resume" }, "ExternalSessionRef"],
    [{
      ...base,
      operation: "resume",
      externalSessionRef: {
        schemaVersion: "1",
        host: "claude-code",
        adapterId: "opc.claude-agent-sdk",
        externalSessionId: "session-1",
        capabilities: ["resume"],
      },
    }, "does not match request host"],
    [{
      ...base,
      operation: "interrupt",
      externalSessionId: "thread-1",
    }, "externalTurnId"],
  ])("rejects an invalid lifecycle request before dispatch", (input, message) => {
    expect(() => parseNativeRunnerRequest(input)).toThrow(message);
  });
});
