import { describe, expect, it } from "vitest";
import { FakeNativeTransport } from "./testing/fakeTransport.js";
import { executeCodexNativeRun } from "./nativeRun.js";
import type { NativeRunnerRequest } from "./types.js";

const request: NativeRunnerRequest = {
  schemaVersion: "1", requestId: "req-1", runId: "run-1", taskId: "task-1", agentId: "agent-1",
  host: "codex", operation: "start", cwd: "C:/work", prompt: "Create a file", timeoutMs: 5_000,
  approvalPolicy: "never", sandbox: "workspace-write", allowedTools: [],
};

function readyTransport(): FakeNativeTransport {
  const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
  transport.respondWith("thread/start", { thread: { id: "thread-1" } });
  transport.respondWith("turn/start", { turn: { id: "turn-1" } });
  return transport;
}

async function waitForTurnStart(transport: FakeNativeTransport): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (transport.calls.some((call) => call.method === "turn/start")) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("native test transport never observed turn/start");
}

function lifecycleRequest(
  operation: NativeRunnerRequest["operation"],
  overrides: Partial<NativeRunnerRequest> = {},
): NativeRunnerRequest {
  return {
    ...request,
    operation,
    externalSessionRef: {
      schemaVersion: "1",
      host: "codex",
      adapterId: "opc.codex-app-server",
      adapterVersion: "0.1.0",
      externalSessionId: "thread-existing",
      externalTurnId: "turn-existing",
      capabilities: ["start", "resume", "fork", "interrupt", "approval", "events"],
    },
    externalSessionId: "thread-existing",
    externalTurnId: "turn-existing",
    ...overrides,
  };
}

describe("Codex native headless run", () => {
  it("returns done only after the host completion event", async () => {
    const transport = readyTransport();
    const running = executeCodexNativeRun(request, { transport });
    await waitForTurnStart(transport);
    transport.emit({ method: "item/completed", params: { item: { id: "i1", type: "agentMessage", text: "finished" } } });
    transport.emit({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
          total: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
        },
      },
    });
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-1", status: "completed" } } });
    await expect(running).resolves.toMatchObject({ status: "done", content: "finished", tokens: { total: 11 }, costUsd: null });
  });

  it("denies an unexpected approval and reports blocked", async () => {
    const transport = readyTransport();
    const running = executeCodexNativeRun(request, { transport });
    await waitForTurnStart(transport);
    transport.emit({ id: 19, method: "item/fileChange/requestApproval", params: { reason: "write outside policy" } });
    const result = await running;
    expect(result).toMatchObject({ status: "blocked", failureKind: "approval_rejected" });
    expect(transport.calls).toContainEqual({ method: "respond", params: { requestId: 19, result: { decision: "decline" } } });
  });

  it("reports transport crashes as failed", async () => {
    const transport = readyTransport();
    const running = executeCodexNativeRun(request, { transport });
    await waitForTurnStart(transport);
    transport.emit({ method: "transport/crashed", params: { message: "child exited" } });
    await expect(running).resolves.toMatchObject({ status: "failed", failureKind: "process_crash" });
  });

  it("blocks incompatible versions before starting a paid turn", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "99.0.0" });
    const result = await executeCodexNativeRun(request, { transport });
    expect(result).toMatchObject({ status: "blocked", failureKind: "version_incompatible" });
    expect(transport.calls.some((call) => call.method === "thread/start")).toBe(false);
  });

  it("resumes the referenced session and starts the requested turn", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    transport.respondWith("thread/resume", { thread: { id: "thread-existing" } });
    transport.respondWith("turn/start", { turn: { id: "turn-resumed" } });
    const running = executeCodexNativeRun(lifecycleRequest("resume"), { transport });
    await waitForTurnStart(transport);
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-resumed", status: "completed" } } });
    await expect(running).resolves.toMatchObject({
      status: "done",
      session: { externalSessionId: "thread-existing", externalTurnId: "turn-resumed" },
    });
    expect(transport.calls.slice(-2)).toEqual([
      { method: "thread/resume", params: { threadId: "thread-existing", approvalPolicy: "never" } },
      { method: "turn/start", params: { threadId: "thread-existing", input: [{ type: "text", text: "Create a file" }] } },
    ]);
  });

  it("forks the referenced session and runs the prompt on the new thread", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    transport.respondWith("thread/fork", { thread: { id: "thread-forked" } });
    transport.respondWith("turn/start", { turn: { id: "turn-forked" } });
    const running = executeCodexNativeRun(lifecycleRequest("fork"), { transport });
    await waitForTurnStart(transport);
    transport.emit({ method: "turn/completed", params: { turn: { id: "turn-forked", status: "completed" } } });
    await expect(running).resolves.toMatchObject({
      status: "done",
      session: { externalSessionId: "thread-forked", externalTurnId: "turn-forked" },
    });
    expect(transport.calls.slice(-2)).toEqual([
      {
        method: "thread/fork",
        params: { threadId: "thread-existing", lastTurnId: "turn-existing", approvalPolicy: "never" },
      },
      { method: "turn/start", params: { threadId: "thread-forked", input: [{ type: "text", text: "Create a file" }] } },
    ]);
  });

  it("interrupts the exact referenced turn without waiting for a completion event", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    const result = await executeCodexNativeRun(lifecycleRequest("interrupt"), { transport });
    expect(result).toMatchObject({
      status: "done",
      content: "",
      session: { externalSessionId: "thread-existing", externalTurnId: "turn-existing" },
    });
    expect(transport.calls.at(-1)).toEqual({
      method: "turn/interrupt",
      params: { threadId: "thread-existing", turnId: "turn-existing" },
    });
    expect(transport.calls.some((call) => call.method === "turn/start")).toBe(false);
  });

  it("fails closed before host dispatch when resume lacks an ExternalSessionRef", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    const result = await executeCodexNativeRun({ ...request, operation: "resume" }, { transport });
    expect(result).toMatchObject({ status: "blocked", failureKind: "capability_unavailable" });
    expect(result.message).toContain("requires an ExternalSessionRef");
    expect(transport.calls).toEqual([]);
  });

  it("fails closed before host dispatch when interrupt lacks a turn id", async () => {
    const transport = new FakeNativeTransport({ hostVersion: "0.145.0" });
    const candidate = lifecycleRequest("interrupt", {
      externalTurnId: undefined,
      externalSessionRef: {
        ...lifecycleRequest("interrupt").externalSessionRef!,
        externalTurnId: undefined,
      },
    });
    const result = await executeCodexNativeRun(candidate, { transport });
    expect(result).toMatchObject({ status: "blocked", failureKind: "capability_unavailable" });
    expect(result.message).toContain("requires externalTurnId");
    expect(transport.calls).toEqual([]);
  });
});
