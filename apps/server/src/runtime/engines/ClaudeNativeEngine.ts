import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  AgentNodeConfig,
  EngineAvailability,
  ExecutionEngine,
  ExecContext,
  ExecResult,
  ExecTask,
  NativeExecutionFailureKind,
} from "@opc/shared";
import { parseNativeRunResult } from "@opc/shared";
import { filteredSpawnEnv, redactSecrets } from "../../security/redact.js";
import { loadAccounts } from "../../storage/providerStore.js";
import { diffFileChanges } from "../fileChanges.js";
import { buildWorkerLaunchReceipt, emitWorkerLaunchReceipt } from "../workerLaunchReceipt.js";
import { resolveApiKeyOverride } from "./apiKeyAccount.js";
import {
  resolveNativeTaskRequest,
  spawnNativeRunner,
  type NativeRunnerRequest,
  type NativeRunnerSpawn,
} from "./CodexNativeEngine.js";

function failure(
  status: "failed" | "restricted",
  kind: NativeExecutionFailureKind,
  error: string,
  latencyMs: number,
): ExecResult {
  return {
    content: "",
    fileChanges: [],
    tokens: { prompt: 0, completion: 0, total: 0 },
    cost: null,
    latencyMs,
    status,
    error: redactSecrets(error),
    executor: "native",
    nativeFailureKind: kind,
  };
}

function allowedTools(ctx: ExecContext): NativeRunnerRequest["allowedTools"] | null {
  const manifest = ctx.capabilityManifest;
  if (!manifest || manifest.effective.sandboxBackend !== "provider-native" || manifest.effective.fullHostAccess) return null;
  const root = manifest.effective.fileRoots.find((entry) => path.resolve(entry.path) === path.resolve(ctx.workdir));
  if (!root?.read) return null;
  const tools: NativeRunnerRequest["allowedTools"] = ["Read", "Glob", "Grep"];
  if (root.write) tools.push("Write", "Edit");
  if (manifest.effective.shell !== "none") tools.push("Bash");
  return tools;
}

function nativeEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const env = filteredSpawnEnv(undefined, []);
  env.ANTHROPIC_API_KEY = apiKey;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CONFIG_DIR;
  return env;
}

/**
 * Official Claude Agent SDK execution path. It is API-key only by design: consumer
 * Claude subscription credentials remain on the existing ACP route and are never read.
 */
export class ClaudeNativeEngine implements ExecutionEngine {
  readonly framework = "claude-code" as const;

  constructor(private readonly spawnRunner: NativeRunnerSpawn = spawnNativeRunner) {}

  async probe(): Promise<EngineAvailability> {
    return {
      framework: this.framework,
      installed: true,
      loggedIn: false,
      version: "0.3.220",
      detail: "Claude Agent SDK is available; an Anthropic API key is resolved per project when a native run starts",
    };
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    const started = Date.now();
    if (path.resolve(ctx.workdir) === path.resolve(ctx.projectRoot)) {
      return failure(
        "restricted",
        "capability_unavailable",
        "Claude native execution requires an isolated worker workRoot; direct project-root execution is blocked",
        Date.now() - started,
      );
    }
    const resolved = resolveNativeTaskRequest(task, ctx, {
      host: "claude-code",
      adapterId: "opc.claude-agent-sdk",
      interruptSupported: false,
    });
    if (!resolved.control) {
      return failure(
        "restricted",
        "capability_unavailable",
        resolved.error ?? "Invalid Claude native lifecycle request",
        Date.now() - started,
      );
    }
    const control = resolved.control;
    const tools = allowedTools(ctx);
    if (!tools) {
      return failure(
        "restricted",
        "capability_unavailable",
        "Claude native execution requires a provider-native effective capability manifest bound to this workRoot",
        Date.now() - started,
      );
    }

    let apiKey: string | undefined;
    try {
      // Selecting claude-native is the explicit opt-in to Anthropic API billing. Subscription
      // OAuth/keychain material is not inspected and cannot satisfy this path.
      apiKey = resolveApiKeyOverride(loadAccounts(ctx.projectRoot), "claude-code", node.cliConfigDir, true);
    } catch (error) {
      return failure("restricted", "authentication_failed", error instanceof Error ? error.message : String(error), Date.now() - started);
    }
    if (!apiKey) {
      return failure(
        "restricted",
        "authentication_failed",
        "Claude native execution requires a configured Anthropic API key; Claude subscription accounts must use ACP",
        Date.now() - started,
      );
    }

    const request: NativeRunnerRequest = {
      schemaVersion: "1",
      requestId: randomUUID(),
      runId: ctx.runId,
      taskId: task.taskId,
      agentId: node.id,
      host: "claude-code",
      operation: control.operation,
      ...(control.session ? {
        externalSessionRef: control.session,
        externalSessionId: control.session.externalSessionId,
        ...(control.session.externalTurnId ? { externalTurnId: control.session.externalTurnId } : {}),
      } : {}),
      cwd: ctx.workdir,
      prompt: task.systemPrompt ? `${task.systemPrompt}\n\n${task.goal}` : task.goal,
      ...(node.model && /^[\w./:-]+$/.test(node.model) ? { model: node.model } : {}),
      timeoutMs: Math.max(1_000, ctx.taskTimeoutMs ?? 300_000),
      approvalPolicy: control.approvalPolicy ?? "never",
      sandbox: ctx.capabilityManifest?.effective.fileRoots.some((entry) => path.resolve(entry.path) === path.resolve(ctx.workdir) && entry.write)
        ? "workspace-write"
        : "read-only",
      allowedTools: tools,
    };
    ctx.emit("info", node.id, {
      kind: "executor_selected",
      executor: "native",
      engine: "claude-agent-sdk",
      operation: request.operation,
      approvalPolicy: request.approvalPolicy,
      billing: "api",
      message: "Official Claude Agent SDK selected with project-scoped API authentication",
    });

    const spawnResult = await this.spawnRunner(request, {
      env: nativeEnvironment(apiKey),
      timeoutMs: request.timeoutMs + 15_000,
      abortSignal: ctx.abortSignal,
    });
    const receipt = await buildWorkerLaunchReceipt(node, task, ctx, spawnResult.launch);
    emitWorkerLaunchReceipt(ctx, node, receipt);
    if (spawnResult.aborted) return { ...failure("failed", "process_crash", "native execution cancelled", Date.now() - started), launchReceipt: receipt };
    if (spawnResult.timedOut) return { ...failure("failed", "timeout", "native runner timed out", Date.now() - started), launchReceipt: receipt };
    if (spawnResult.spawnError) return { ...failure("restricted", "native_unavailable", spawnResult.spawnError, Date.now() - started), launchReceipt: receipt };

    let native;
    try {
      native = parseNativeRunResult(JSON.parse(spawnResult.stdout.trim()));
    } catch (error) {
      const detail = `${error instanceof Error ? error.message : String(error)}${spawnResult.stderr ? `; ${spawnResult.stderr}` : ""}`;
      return { ...failure("failed", "invalid_response", detail, Date.now() - started), launchReceipt: receipt };
    }
    if (native.requestId !== request.requestId || native.runId !== request.runId) {
      return { ...failure("failed", "invalid_response", "native response identity mismatch", Date.now() - started), launchReceipt: receipt };
    }
    for (const event of native.events) ctx.emit("info", node.id, { kind: "native_run_event", event });
    if (native.session) ctx.emit("info", node.id, { kind: "external_session_ref", session: native.session });

    if (spawnResult.code !== null && spawnResult.code !== 0 && native.status === "done") {
      const detail = `native runner exited with code ${spawnResult.code} but reported done${spawnResult.stderr ? `; ${spawnResult.stderr}` : ""}`;
      ctx.emit("error", node.id, {
        kind: "native_exit_status_mismatch",
        exitCode: spawnResult.code,
        reportedStatus: native.status,
        message: redactSecrets(detail),
      });
      return {
        ...failure("failed", "process_crash", detail, Date.now() - started),
        tokens: native.tokens,
        cost: native.costUsd ?? null,
        launchReceipt: receipt,
      };
    }

    const status = native.status === "done" ? "done" : native.status === "blocked" ? "restricted" : "failed";
    return {
      content: native.content,
      fileChanges: native.status === "done" ? diffFileChanges(ctx.workdir) : [],
      tokens: native.tokens,
      cost: native.costUsd ?? null,
      latencyMs: Date.now() - started,
      status,
      ...(native.message ? { error: redactSecrets(native.message) } : {}),
      ...(native.failureKind ? { nativeFailureKind: native.failureKind } : {}),
      executor: "native",
      launchReceipt: receipt,
    };
  }
}
