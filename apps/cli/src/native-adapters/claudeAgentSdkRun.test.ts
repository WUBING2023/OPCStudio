import { describe, expect, it, vi } from "vitest";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { executeClaudeNativeRun, type ClaudeQueryFactory } from "./claudeAgentSdkRun.js";
import type { NativeRunnerRequest } from "./types.js";

const baseRequest: NativeRunnerRequest = {
  schemaVersion: "1",
  requestId: "request-claude-1",
  runId: "run-claude-1",
  taskId: "task-claude-1",
  agentId: "agent-claude-1",
  host: "claude-code",
  operation: "start",
  cwd: "C:/isolated-worktree",
  prompt: "Create result.txt",
  model: "claude-sonnet-4-6",
  timeoutMs: 1_000,
  approvalPolicy: "never",
  sandbox: "workspace-write",
  allowedTools: ["Read", "Write", "Edit", "Glob", "Grep", "Bash"],
};

function fakeQuery(messages: SDKMessage[], onOptions?: (options: Options | undefined) => void): ClaudeQueryFactory {
  return ({ options }) => {
    onOptions?.(options);
    const generator = (async function* () {
      for (const message of messages) yield message;
    })();
    return Object.assign(generator, {
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
    }) as unknown as Query;
  };
}

function resultMessage(overrides: Record<string, unknown> = {}): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    stop_reason: "end_turn",
    total_cost_usd: 0.012,
    usage: { input_tokens: 30, output_tokens: 12 },
    modelUsage: {},
    permission_denials: [],
    result: "created result.txt",
    session_id: "claude-session-1",
    uuid: "00000000-0000-4000-8000-000000000001",
    ...overrides,
  } as unknown as SDKMessage;
}

describe("Claude Agent SDK native runner", () => {
  it("requires API authentication and never treats a Claude subscription as SDK auth", async () => {
    const query = vi.fn<ClaudeQueryFactory>();
    const result = await executeClaudeNativeRun(baseRequest, { query, env: {} });
    expect(result).toMatchObject({ status: "blocked", failureKind: "authentication_failed", costUsd: null });
    expect(result.message).toContain("subscription credentials remain on the ACP path");
    expect(query).not.toHaveBeenCalled();
  });

  it("maps the official stream, usage, cost and session while enforcing the OPC sandbox policy", async () => {
    let observed: Options | undefined;
    const result = await executeClaudeNativeRun(baseRequest, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret", PATH: "C:/bin", UNRELATED_SECRET: "must-not-cross" },
      query: fakeQuery([
        { type: "system", subtype: "init", session_id: "claude-session-1", uuid: "00000000-0000-4000-8000-000000000002" } as unknown as SDKMessage,
        resultMessage(),
      ], (options) => { observed = options; }),
      now: () => "2026-08-02T00:00:00.000Z",
    });

    expect(result).toMatchObject({
      status: "done",
      content: "created result.txt",
      tokens: { prompt: 30, completion: 12, total: 42 },
      costUsd: 0.012,
      session: { host: "claude-code", adapterId: "opc.claude-agent-sdk", externalSessionId: "claude-session-1" },
      negotiation: { compatible: true, protocolVersion: "claude-agent-sdk" },
    });
    expect(result.events.map((event) => event.type)).toEqual(["run.started", "run.completed"]);
    expect(observed).toMatchObject({
      cwd: baseRequest.cwd,
      permissionMode: "dontAsk",
      settingSources: [],
      skills: [],
      disallowedTools: ["WebFetch", "WebSearch"],
      sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
    });
    expect(observed?.env?.ANTHROPIC_API_KEY).toBe("sk-ant-test-secret");
    expect(observed?.env).not.toHaveProperty("UNRELATED_SECRET");
    await expect(observed?.canUseTool?.("WebFetch", {}, {
      signal: new AbortController().signal,
      toolUseID: "tool-1",
    } as never)).resolves.toMatchObject({ behavior: "deny" });
  });

  it.each([
    ["resume", false],
    ["fork", true],
  ] as const)("passes %s through the official session options", async (operation, forkSession) => {
    let observed: Options | undefined;
    const result = await executeClaudeNativeRun({
      ...baseRequest,
      operation,
      externalSessionId: "claude-session-old",
    }, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
      query: fakeQuery([resultMessage({ session_id: "claude-session-new" })], (options) => { observed = options; }),
    });
    expect(result.status).toBe("done");
    expect(observed).toMatchObject({ resume: "claude-session-old", forkSession });
  });

  it("maps permission and quota failures without inventing success", async () => {
    const permission = await executeClaudeNativeRun(baseRequest, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
      query: fakeQuery([resultMessage({
        subtype: "error_during_execution",
        is_error: true,
        errors: ["permission denied"],
        permission_denials: [{ tool_name: "Bash" }],
      })]),
    });
    expect(permission).toMatchObject({ status: "blocked", failureKind: "approval_rejected" });

    const quota = await executeClaudeNativeRun(baseRequest, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
      query: fakeQuery([resultMessage({
        subtype: "error_max_budget_usd",
        is_error: true,
        errors: ["quota exhausted"],
      })]),
    });
    expect(quota).toMatchObject({ status: "failed", failureKind: "quota_exceeded" });
  });

  it("fails closed when interactive approval is requested without an approval broker", async () => {
    const query = vi.fn<ClaudeQueryFactory>();
    const result = await executeClaudeNativeRun({
      ...baseRequest,
      approvalPolicy: "on-request",
    } as NativeRunnerRequest, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
      query,
    });
    expect(result).toMatchObject({ status: "blocked", failureKind: "capability_unavailable" });
    expect(result.message).toContain("approval broker");
    expect(query).not.toHaveBeenCalled();
  });

  it("fails closed for detached-session interrupt because the SDK requires the live Query object", async () => {
    const query = vi.fn<ClaudeQueryFactory>();
    const result = await executeClaudeNativeRun({
      ...baseRequest,
      operation: "interrupt",
      externalSessionId: "claude-session-old",
      externalTurnId: "turn-old",
      externalSessionRef: {
        schemaVersion: "1",
        host: "claude-code",
        adapterId: "opc.claude-agent-sdk",
        externalSessionId: "claude-session-old",
        externalTurnId: "turn-old",
        capabilities: ["interrupt"],
      },
    } as NativeRunnerRequest, {
      env: { ANTHROPIC_API_KEY: "sk-ant-test-secret" },
      query,
    });
    expect(result).toMatchObject({ status: "blocked", failureKind: "capability_unavailable" });
    expect(result.message).toContain("live Query");
    expect(query).not.toHaveBeenCalled();
  });
});
