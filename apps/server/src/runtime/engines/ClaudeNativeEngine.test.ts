import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentNodeConfig, EffectiveCapabilityManifest, ExecContext, NativeRunResult } from "@opc/shared";
import { saveAccounts } from "../../storage/providerStore.js";
import { captureWorkerLaunchMetadata } from "../workerLaunchReceipt.js";
import { ClaudeNativeEngine } from "./ClaudeNativeEngine.js";
import type { NativeRunnerRequest, NativeRunnerSpawn } from "./CodexNativeEngine.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.OPENAI_API_KEY;
});

function workspace(withKey = true): { projectRoot: string; workdir: string } {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "opc-claude-native-"));
  roots.push(projectRoot);
  const workdir = path.join(projectRoot, "isolated-worker");
  fs.mkdirSync(workdir, { recursive: true });
  if (withKey) {
    saveAccounts(projectRoot, [{
      id: "anthropic#native",
      providerId: "anthropic",
      label: "Anthropic API",
      apiKey: "sk-ant-native-test",
      enabled: true,
      maxConcurrent: 1,
    }]);
  }
  return { projectRoot, workdir };
}

function agent(): AgentNodeConfig {
  return {
    id: "claude-dev",
    name: "Claude Native Dev",
    role: "dev",
    childrenIds: [],
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    framework: "claude-code",
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true,
    deletable: true,
    enabled: true,
  };
}

function manifest(projectRoot: string, workdir: string): EffectiveCapabilityManifest {
  return {
    schemaVersion: "1",
    runId: "run-claude-native",
    taskId: "task-1",
    agentId: "claude-dev",
    companyId: "test-company",
    framework: "claude-code",
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    requested: { fileWrite: true, shell: "allowlist", network: "off" },
    effective: {
      fileRoots: [{ path: workdir, read: true, write: true }],
      shell: "workspace-sandbox",
      network: "denied",
      sandboxBackend: "provider-native",
      fullHostAccess: false,
      approvalMode: "not-required",
      credentialScope: "provider-call",
      environmentNames: ["ANTHROPIC_API_KEY"],
      mcpSpecs: [],
    },
    unsupportedConstraints: [],
    manifestHash: "test-manifest-hash",
  };
}

function context(projectRoot: string, workdir: string, events: unknown[] = []): ExecContext {
  return {
    runId: "run-claude-native",
    projectRoot,
    workdir,
    emit: (_type, _agentId, payload) => events.push(payload),
    budget: { maxTokensPerTask: 10_000 },
    capabilityManifest: manifest(projectRoot, workdir),
  };
}

function result(request: NativeRunnerRequest, overrides: Partial<NativeRunResult> = {}): NativeRunResult {
  return {
    schemaVersion: "1",
    requestId: request.requestId,
    runId: request.runId,
    status: "done",
    content: "Claude native completed",
    tokens: { prompt: 11, completion: 7, total: 18 },
    costUsd: 0.0123,
    events: [],
    ...overrides,
  };
}

describe("ClaudeNativeEngine Server bridge", () => {
  it("requires an Anthropic API key and never treats a subscription login as SDK auth", async () => {
    const { projectRoot, workdir } = workspace(false);
    const spawn = vi.fn<NativeRunnerSpawn>();
    const execution = await new ClaudeNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "work", systemPrompt: "", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "restricted", nativeFailureKind: "authentication_failed", fileChanges: [] });
    expect(execution.error).toContain("API key");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes only the scoped API credential, enforced tools, usage and real delta", async () => {
    const { projectRoot, workdir } = workspace();
    process.env.OPENAI_API_KEY = "must-not-cross";
    let observedRequest: NativeRunnerRequest | undefined;
    let observedEnv: NodeJS.ProcessEnv | undefined;
    const events: unknown[] = [];
    const spawn: NativeRunnerSpawn = async (request, input) => {
      observedRequest = request;
      observedEnv = input.env;
      fs.writeFileSync(path.join(workdir, "answer.ts"), "export const answer = 42;\n", "utf8");
      return {
        code: 0,
        stdout: JSON.stringify(result(request, {
          session: {
            schemaVersion: "1",
            host: "claude-code",
            adapterId: "opc.claude-agent-sdk",
            adapterVersion: "0.3.220",
            externalSessionId: "session-1",
            capabilities: ["start", "resume", "fork", "interrupt", "approval", "events"],
          },
        })),
        stderr: "",
        launch: captureWorkerLaunchMetadata({ file: process.execPath, args: ["runner"], env: input.env, cwd: request.cwd }),
      };
    };
    const execution = await new ClaudeNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "write answer", systemPrompt: "work", maxTokens: 1_000 },
      context(projectRoot, workdir, events),
    );
    expect(execution).toMatchObject({ status: "done", executor: "native", cost: 0.0123 });
    expect(execution.fileChanges).toEqual([expect.objectContaining({ path: "answer.ts", changeType: "create" })]);
    expect(observedRequest).toMatchObject({ host: "claude-code", sandbox: "workspace-write" });
    expect(observedRequest?.allowedTools).toEqual(["Read", "Glob", "Grep", "Write", "Edit", "Bash"]);
    expect(observedEnv?.ANTHROPIC_API_KEY).toBe("sk-ant-native-test");
    expect(observedEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(events).toContainEqual(expect.objectContaining({ kind: "external_session_ref", session: expect.objectContaining({ externalSessionId: "session-1" }) }));
  });

  it("fails closed on a non-zero exit even if stdout reports done", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => {
      fs.writeFileSync(path.join(workdir, "untrusted.ts"), "bad", "utf8");
      return { code: 9, stdout: JSON.stringify(result(request)), stderr: "SDK host crashed" };
    };
    const execution = await new ClaudeNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "work", systemPrompt: "", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: "failed", nativeFailureKind: "process_crash", fileChanges: [], content: "" });
    expect(execution.error).toContain("exited with code 9 but reported done");
  });

  it.each([
    ["blocked", "approval_rejected", "restricted"],
    ["failed", "quota_exceeded", "failed"],
  ] as const)("maps %s/%s honestly", async (nativeStatus, kind, expectedStatus) => {
    const { projectRoot, workdir } = workspace();
    const spawn: NativeRunnerSpawn = async (request) => ({
      code: nativeStatus === "blocked" ? 4 : 1,
      stdout: JSON.stringify(result(request, { status: nativeStatus, failureKind: kind, message: kind, content: "" })),
      stderr: "",
    });
    const execution = await new ClaudeNativeEngine(spawn).run(
      agent(),
      { taskId: "task-1", goal: "work", systemPrompt: "", maxTokens: 1_000 },
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({ status: expectedStatus, nativeFailureKind: kind, fileChanges: [] });
  });

  it.each(["resume", "fork"] as const)("forwards Claude %s through the bound ExternalSessionRef", async (operation) => {
    const { projectRoot, workdir } = workspace();
    let observed: NativeRunnerRequest | undefined;
    const spawn: NativeRunnerSpawn = async (request) => {
      observed = request;
      return { code: 0, stdout: JSON.stringify(result(request)), stderr: "" };
    };
    const execution = await new ClaudeNativeEngine(spawn).run(
      agent(),
      {
        taskId: "task-1",
        goal: "continue",
        systemPrompt: "",
        maxTokens: 1_000,
        nativeRequest: {
          operation,
          session: {
            schemaVersion: "1",
            host: "claude-code",
            adapterId: "opc.claude-agent-sdk",
            adapterVersion: "0.3.220",
            externalSessionId: "claude-session-old",
            capabilities: ["resume", "fork"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution.status).toBe("done");
    expect(observed).toMatchObject({
      operation,
      externalSessionId: "claude-session-old",
      externalSessionRef: { host: "claude-code", externalSessionId: "claude-session-old" },
    });
  });

  it("fails closed when headless Claude is asked to interrupt a detached session", async () => {
    const { projectRoot, workdir } = workspace();
    const spawn = vi.fn<NativeRunnerSpawn>();
    const execution = await new ClaudeNativeEngine(spawn).run(
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
            host: "claude-code",
            adapterId: "opc.claude-agent-sdk",
            externalSessionId: "claude-session-old",
            externalTurnId: "turn-old",
            capabilities: ["interrupt"],
          },
        },
      } as never,
      context(projectRoot, workdir),
    );
    expect(execution).toMatchObject({
      status: "restricted",
      nativeFailureKind: "capability_unavailable",
      fileChanges: [],
    });
    expect(execution.error).toMatch(/detached Claude/i);
    expect(spawn).not.toHaveBeenCalled();
  });
});
