import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AgentNodeConfig,
  ExecContext,
  ExecResult,
  ExecutionEngine,
  NativeRunResult,
} from "@opc/shared";
import {
  CodexNativeEngine,
  NativeFallbackEngine,
  NativeRouteFallbackEngine,
  type NativeRunnerRequest,
  type NativeRunnerSpawn,
} from "./CodexNativeEngine.js";
import { captureWorkerLaunchMetadata } from "../workerLaunchReceipt.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.OPC_NATIVE_TEST_API_KEY;
});

function workspace(): { projectRoot: string; workdir: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opc-native-engine-"));
  roots.push(projectRoot);
  const workdir = path.join(projectRoot, "isolated-worker");
  fs.mkdirSync(workdir);
  return { projectRoot, workdir };
}

function agent(): AgentNodeConfig {
  return {
    id: "dev-native",
    name: "Native Dev",
    role: "dev",
    childrenIds: [],
    model: "gpt-5",
    provider: "openai",
    framework: "codex",
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true,
    deletable: true,
    enabled: true,
  };
}

function context(projectRoot: string, workdir: string): ExecContext {
  return {
    runId: "run-native-1",
    projectRoot,
    workdir,
    emit: () => {},
    budget: { maxTokensPerTask: 10_000 },
  };
}

function result(request: NativeRunnerRequest, overrides: Partial<NativeRunResult> = {}): NativeRunResult {
  return {
    schemaVersion: "1",
    requestId: request.requestId,
    runId: request.runId,
    status: "done",
    content: "native completed",
    tokens: { prompt: 5, completion: 3, total: 8 },
    events: [],
    ...overrides,
  };
}

describe("CodexNativeEngine Server bridge", () => {
  it("collects real isolated workRoot delta for the existing artifact/evidence funnel", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => {
      fs.writeFileSync(path.join(request.cwd, "native-output.txt"), "real output", "utf8");
      return { code: 0, stdout: JSON.stringify(result(request)), stderr: "" };
    };
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "write output", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "done", executor: "native", cost: null });
    expect(execution.fileChanges).toEqual([
      expect.objectContaining({ path: "native-output.txt", changeType: "create", after: "real output" }),
    ]);
  });

  it("fails closed when a non-zero process exit contradicts a reported done result", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => {
      fs.writeFileSync(path.join(request.cwd, "must-not-be-recovered.txt"), "untrusted delta", "utf8");
      return {
        code: 17,
        stdout: JSON.stringify(result(request, { status: "done", content: "false success" })),
        stderr: "native host crashed after writing stdout",
        launch: captureWorkerLaunchMetadata({
          file: process.execPath,
          args: ["native-runner"],
          env: {},
          cwd: request.cwd,
        }),
      };
    };

    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "write output", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );

    expect(execution).toMatchObject({
      status: "failed",
      executor: "native",
      nativeFailureKind: "process_crash",
      fileChanges: [],
      content: "",
      tokens: { prompt: 5, completion: 3, total: 8 },
      launchReceipt: expect.objectContaining({ runId: "run-native-1", taskId: "task-1", agentId: "dev-native" }),
    });
    expect(execution.error).toContain("exited with code 17 but reported done");
    expect(fs.existsSync(path.join(workdir, "must-not-be-recovered.txt"))).toBe(true);
  });

  it.each([
    ["blocked", "approval_rejected", "restricted"],
    ["failed", "process_crash", "failed"],
  ] as const)("maps %s/%s honestly and never reports a delivery delta", async (nativeStatus, failureKind, expectedStatus) => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => ({
      code: nativeStatus === "blocked" ? 4 : 1,
      stdout: JSON.stringify(result(request, {
        status: nativeStatus,
        failureKind,
        message: failureKind,
        content: "",
        tokens: { prompt: 0, completion: 0, total: 0 },
      })),
      stderr: "",
    });
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "work", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: expectedStatus, nativeFailureKind: failureKind, fileChanges: [] });
  });

  it("falls back only for availability failures, never for approval rejection or crashes", async () => {
    const fallbackRun = vi.fn(async (): Promise<ExecResult> => ({
      status: "done",
      content: "fallback",
      fileChanges: [],
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: null,
      latencyMs: 1,
      executor: "acp",
    }));
    const fallback: ExecutionEngine = {
      framework: "codex",
      probe: async () => ({ framework: "codex", installed: true, loggedIn: true, version: "test" }),
      run: fallbackRun,
    };
    const nativeResult = (failureKind: ExecResult["nativeFailureKind"]): ExecutionEngine => ({
      framework: "codex",
      probe: async () => ({ framework: "codex", installed: false, loggedIn: false, version: "" }),
      run: async () => ({
        status: failureKind === "process_crash" ? "failed" : "restricted",
        content: "",
        fileChanges: [],
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost: null,
        latencyMs: 1,
        executor: "native",
        nativeFailureKind: failureKind,
        error: failureKind,
      }),
    });
    const { projectRoot, workdir } = workspace();
    const task = { taskId: "task-1", goal: "work", systemPrompt: "work", maxTokens: 1_000 };
    await expect(new NativeFallbackEngine(nativeResult("native_unavailable"), fallback).run(
      agent(), task, context(projectRoot, workdir),
    )).resolves.toMatchObject({ status: "done", degradedReason: expect.stringContaining("native_unavailable") });
    expect(fallbackRun).toHaveBeenCalledTimes(1);

    await expect(new NativeFallbackEngine(nativeResult("approval_rejected"), fallback).run(
      agent(), task, context(projectRoot, workdir),
    )).resolves.toMatchObject({ status: "restricted", nativeFailureKind: "approval_rejected" });
    await expect(new NativeFallbackEngine(nativeResult("process_crash"), fallback).run(
      agent(), task, context(projectRoot, workdir),
    )).resolves.toMatchObject({ status: "failed", nativeFailureKind: "process_crash" });
    expect(fallbackRun).toHaveBeenCalledTimes(1);
  });

  it("does not pass API keys to the headless native runner", async () => {
    const { projectRoot, workdir } = workspace();
    process.env.OPC_NATIVE_TEST_API_KEY = "sk-should-not-cross";
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const spawn: NativeRunnerSpawn = async (request, input) => {
      observedEnv = input.env;
      return { code: 0, stdout: JSON.stringify(result(request)), stderr: "" };
    };
    await new CodexNativeEngine(spawn).run(
      { ...agent(), cliConfigDir: path.join(projectRoot, "codex-home") },
      { taskId: "task-1", goal: "work", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(observedEnv?.OPC_NATIVE_TEST_API_KEY).toBeUndefined();
    expect(observedEnv?.CODEX_HOME).toBe(path.join(projectRoot, "codex-home"));
  });

  it("blocks direct project-root execution before spawning a native host", async () => {
    const { projectRoot } = workspace();
    const spawn = vi.fn<NativeRunnerSpawn>();
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "work", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, projectRoot),
    );
    expect(execution).toMatchObject({ status: "restricted", nativeFailureKind: "capability_unavailable" });
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["resume", "fork"] as const)("forwards %s with the bound ExternalSessionRef and explicit approval policy", async (operation) => {
    const { projectRoot, workdir } = workspace();
    let observed: NativeRunnerRequest | undefined;
    const spawn: NativeRunnerSpawn = async (request) => {
      observed = request;
      return {
        code: 0,
        stdout: JSON.stringify(result(request, {
          session: {
            schemaVersion: "1",
            host: "codex",
            adapterId: "opc.codex-app-server",
            adapterVersion: "0.1.0",
            externalSessionId: operation === "fork" ? "thread-new" : "thread-old",
            externalTurnId: "turn-new",
            capabilities: ["resume", "fork", "interrupt"],
          },
        })),
        stderr: "",
      };
    };
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      {
        taskId: "task-1",
        goal: "continue",
        systemPrompt: "work",
        maxTokens: 1_000,
        nativeRequest: {
          operation,
          approvalPolicy: "on-request",
          session: {
            schemaVersion: "1",
            host: "codex",
            adapterId: "opc.codex-app-server",
            adapterVersion: "0.1.0",
            externalSessionId: "thread-old",
            externalTurnId: "turn-old",
            capabilities: ["resume", "fork", "interrupt"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution.status).toBe("done");
    expect(observed).toMatchObject({
      operation,
      approvalPolicy: "on-request",
      externalSessionId: "thread-old",
      externalTurnId: "turn-old",
      externalSessionRef: { externalSessionId: "thread-old", externalTurnId: "turn-old" },
    });
  });

  it("fails closed before spawn when a continuation request has no usable session", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn = vi.fn<NativeRunnerSpawn>();
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      {
        taskId: "task-1",
        goal: "continue",
        systemPrompt: "",
        maxTokens: 1_000,
        nativeRequest: { operation: "resume", approvalPolicy: "never" },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({
      status: "restricted",
      nativeFailureKind: "capability_unavailable",
      fileChanges: [],
    });
    expect(execution.error).toContain("ExternalSessionRef");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not collect file deltas for an interrupt control operation", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => {
      fs.writeFileSync(path.join(workdir, "preexisting-native-delta.txt"), "not an interrupt delivery", "utf8");
      return { code: 0, stdout: JSON.stringify(result(request)), stderr: "" };
    };
    const execution = await new CodexNativeEngine(spawn).run(
      agent(),
      {
        taskId: "task-1",
        goal: "interrupt",
        systemPrompt: "",
        maxTokens: 1_000,
        nativeRequest: {
          operation: "interrupt",
          session: {
            schemaVersion: "1",
            host: "codex",
            adapterId: "opc.codex-app-server",
            externalSessionId: "thread-old",
            externalTurnId: "turn-old",
            capabilities: ["interrupt"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "done", fileChanges: [] });
  });

  it("never falls a continuation operation back to ACP", async () => {
    const fallbackRun = vi.fn(async (): Promise<ExecResult> => ({
      status: "done",
      content: "wrong session",
      fileChanges: [],
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: null,
      latencyMs: 1,
      executor: "acp",
    }));
    const fallback: ExecutionEngine = {
      framework: "codex",
      probe: async () => ({ framework: "codex", installed: true, loggedIn: true, version: "test" }),
      run: fallbackRun,
    };
    const native: ExecutionEngine = {
      framework: "codex",
      probe: async () => ({ framework: "codex", installed: false, loggedIn: false, version: "" }),
      run: async () => ({
        status: "restricted",
        content: "",
        fileChanges: [],
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost: null,
        latencyMs: 1,
        executor: "native",
        nativeFailureKind: "version_incompatible",
        error: "version drift",
      }),
    };
    const { projectRoot, workdir } = workspace();
    const execution = await new NativeFallbackEngine(native, fallback).run(
      agent(),
      {
        taskId: "task-1",
        goal: "continue",
        systemPrompt: "",
        maxTokens: 1_000,
        nativeRequest: {
          operation: "resume",
          session: {
            schemaVersion: "1",
            host: "codex",
            adapterId: "opc.codex-app-server",
            externalSessionId: "thread-old",
            capabilities: ["resume"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "restricted", nativeFailureKind: "version_incompatible" });
    expect(fallbackRun).not.toHaveBeenCalled();
  });

  it("blocks continuation when native routing is unavailable before an adapter launch", async () => {
    const fallbackRun = vi.fn(async (): Promise<ExecResult> => ({
      status: "done",
      content: "must not run",
      fileChanges: [],
      tokens: { prompt: 1, completion: 1, total: 2 },
      cost: null,
      latencyMs: 1,
      executor: "acp",
    }));
    const fallback: ExecutionEngine = {
      framework: "codex",
      probe: async () => ({ framework: "codex", installed: true, loggedIn: true, version: "test" }),
      run: fallbackRun,
    };
    const { projectRoot, workdir } = workspace();
    const execution = await new NativeRouteFallbackEngine(
      fallback,
      "native feature disabled",
      "feature_disabled",
    ).run(
      agent(),
      {
        taskId: "task-1",
        goal: "continue",
        systemPrompt: "",
        maxTokens: 1_000,
        nativeRequest: {
          operation: "resume",
          session: {
            schemaVersion: "1",
            host: "codex",
            adapterId: "opc.codex-app-server",
            externalSessionId: "thread-old",
            capabilities: ["resume"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "restricted", nativeFailureKind: "feature_disabled" });
    expect(fallbackRun).not.toHaveBeenCalled();
  });
});
