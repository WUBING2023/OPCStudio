import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type {
  AgentFramework,
  AgentNodeConfig,
  EngineAvailability,
  ExecutionEngine,
  ExternalSessionRef,
  ExecContext,
  ExecResult,
  ExecTask,
  NativeExecutionFailureKind,
  NativeRunRequest,
} from "@opc/shared";
import { parseNativeRunResult } from "@opc/shared";
import { filteredSpawnEnv, redactSecrets } from "../../security/redact.js";
import { diffFileChanges } from "../fileChanges.js";
import { buildWorkerLaunchReceipt, captureWorkerLaunchMetadata, emitWorkerLaunchReceipt, type WorkerLaunchMetadata } from "../workerLaunchReceipt.js";
import { probeCodex } from "./probes.js";
import { buildCliNativeLaunch, buildCliWorkerEnv } from "./workerLaunch.js";
import { buildEffectiveCapabilityManifest } from "../effectiveCapabilities.js";

export type NativeRunnerOperation = "start" | "resume" | "fork" | "interrupt";
export type NativeApprovalPolicy = "never" | "on-request";

export interface NativeTaskRequest {
  operation: NativeRunnerOperation;
  session?: ExternalSessionRef;
  approvalPolicy?: NativeApprovalPolicy;
}

export type NativeRunnerRequest = Omit<
  NativeRunRequest,
  "operation" | "approvalPolicy" | "externalSessionId"
> & {
  operation: NativeRunnerOperation;
  approvalPolicy: NativeApprovalPolicy;
  externalSessionId?: string;
  externalTurnId?: string;
  externalSessionRef?: ExternalSessionRef;
};

type NativeAwareTask = ExecTask & { nativeRequest?: NativeTaskRequest };

interface NativeSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string;
  timedOut?: boolean;
  aborted?: boolean;
  launch?: WorkerLaunchMetadata;
}

export type NativeRunnerSpawn = (request: NativeRunnerRequest, input: {
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) => Promise<NativeSpawnResult>;

function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  } catch { /* best effort */ }
}

function nativeEnvironment(node: AgentNodeConfig): NodeJS.ProcessEnv {
  // provider is deliberately undefined: remove every API key/token/secret. The official host may
  // use its existing login directory, but OPC never reads or copies its auth files.
  const env = filteredSpawnEnv(undefined, []);
  if (node.cliConfigDir) env.CODEX_HOME = node.cliConfigDir;
  delete env.CLAUDECODE;
  return env;
}

export const spawnNativeRunner: NativeRunnerSpawn = (request, input) => new Promise((resolve) => {
  let launch;
  try { launch = buildCliNativeLaunch(import.meta.url); }
  catch (error) {
    resolve({ code: null, stdout: "", stderr: "", spawnError: error instanceof Error ? error.message : String(error) });
    return;
  }
  const env = buildCliWorkerEnv(input.env, launch.file);
  const metadata = captureWorkerLaunchMetadata({ file: launch.file, args: launch.args, env, cwd: request.cwd });
  const child = spawn(launch.file, launch.args, {
    cwd: request.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const done = (result: NativeSpawnResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    input.abortSignal?.removeEventListener("abort", onAbort);
    resolve({ ...result, launch: metadata });
  };
  const onAbort = () => { killTree(child.pid); done({ code: null, stdout, stderr, aborted: true }); };
  const timer = setTimeout(() => { killTree(child.pid); done({ code: null, stdout, stderr, timedOut: true }); }, input.timeoutMs);
  if (input.abortSignal?.aborted) onAbort();
  else input.abortSignal?.addEventListener("abort", onAbort, { once: true });
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
    if (stdout.length > 4 * 1024 * 1024) { killTree(child.pid); done({ code: null, stdout: "", stderr, spawnError: "native runner output exceeded 4 MiB" }); }
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4096); });
  child.once("error", (error) => done({ code: null, stdout, stderr, spawnError: error.message }));
  child.once("close", (code) => done({ code, stdout, stderr }));
  child.stdin.end(JSON.stringify(request));
});

function emptyResult(status: "failed" | "restricted", kind: NativeExecutionFailureKind, error: string, latencyMs: number): ExecResult {
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

const NATIVE_OPERATIONS = new Set<NativeRunnerOperation>(["start", "resume", "fork", "interrupt"]);

export function nativeOperationFromTask(task: ExecTask): NativeRunnerOperation | "invalid" {
  const operation = (task as NativeAwareTask).nativeRequest?.operation;
  if (operation === undefined) return "start";
  return NATIVE_OPERATIONS.has(operation) ? operation : "invalid";
}

export function resolveNativeTaskRequest(
  task: ExecTask,
  ctx: ExecContext,
  expected: { host: "codex" | "claude-code"; adapterId: string; interruptSupported: boolean },
): { control?: NativeTaskRequest; error?: string } {
  const raw = (task as NativeAwareTask).nativeRequest;
  const operation = raw?.operation ?? "start";
  if (!NATIVE_OPERATIONS.has(operation)) return { error: "Unsupported native operation: " + String(operation) };
  const approvalPolicy = raw?.approvalPolicy
    ?? (ctx.capabilityManifest?.effective.approvalMode === "run-governance" ? "on-request" : "never");
  if (approvalPolicy !== "never" && approvalPolicy !== "on-request") {
    return { error: "Unsupported native approval policy: " + String(approvalPolicy) };
  }
  if (operation === "interrupt" && !expected.interruptSupported) {
    return { error: "Detached Claude sessions cannot be interrupted by id; the original live Query object is required" };
  }
  if (operation === "start") return { control: { operation, approvalPolicy } };

  const session = raw?.session;
  if (!session?.externalSessionId) {
    return { error: operation + " requires an ExternalSessionRef with externalSessionId" };
  }
  if (session.host !== expected.host || session.adapterId !== expected.adapterId) {
    return { error: "ExternalSessionRef does not belong to " + expected.adapterId };
  }
  if (session.capabilities.length > 0 && !session.capabilities.includes(operation)) {
    return { error: "ExternalSessionRef does not declare " + operation + " capability" };
  }
  if (operation === "interrupt" && !session.externalTurnId) {
    return { error: "interrupt requires ExternalSessionRef.externalTurnId" };
  }
  return { control: { operation, approvalPolicy, session } };
}

export class CodexNativeEngine implements ExecutionEngine {
  readonly framework = "codex" as const;
  constructor(private readonly spawnRunner: NativeRunnerSpawn = spawnNativeRunner) {}

  async probe(): Promise<EngineAvailability> {
    return probeCodex();
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    const started = Date.now();
    if (path.resolve(ctx.workdir) === path.resolve(ctx.projectRoot)) {
      return emptyResult(
        "restricted",
        "capability_unavailable",
        "Codex native execution requires an isolated worker workRoot; direct project-root execution is blocked",
        Date.now() - started,
      );
    }
    const resolved = resolveNativeTaskRequest(task, ctx, {
      host: "codex",
      adapterId: "opc.codex-app-server",
      interruptSupported: true,
    });
    if (!resolved.control) {
      return emptyResult(
        "restricted",
        "capability_unavailable",
        resolved.error ?? "Invalid Codex native lifecycle request",
        Date.now() - started,
      );
    }
    const control = resolved.control;
    const request: NativeRunnerRequest = {
      schemaVersion: "1",
      requestId: randomUUID(),
      runId: ctx.runId,
      taskId: task.taskId,
      agentId: node.id,
      host: "codex",
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
      sandbox: "workspace-write",
      allowedTools: [],
    };
    ctx.emit("info", node.id, {
      kind: "executor_selected",
      executor: "native",
      engine: "codex-app-server",
      operation: request.operation,
      approvalPolicy: request.approvalPolicy,
      message: "Codex native app-server selected behind the OPC native execution contract",
    });
    const spawnResult = await this.spawnRunner(request, {
      env: nativeEnvironment(node),
      timeoutMs: request.timeoutMs + 15_000,
      abortSignal: ctx.abortSignal,
    });
    const receipt = await buildWorkerLaunchReceipt(node, task, ctx, spawnResult.launch);
    emitWorkerLaunchReceipt(ctx, node, receipt);
    if (spawnResult.aborted) return { ...emptyResult("failed", "process_crash", "native execution cancelled", Date.now() - started), launchReceipt: receipt };
    if (spawnResult.timedOut) return { ...emptyResult("failed", "timeout", "native runner timed out", Date.now() - started), launchReceipt: receipt };
    if (spawnResult.spawnError) return { ...emptyResult("restricted", "native_unavailable", spawnResult.spawnError, Date.now() - started), launchReceipt: receipt };

    let native;
    try { native = parseNativeRunResult(JSON.parse(spawnResult.stdout.trim())); }
    catch (error) {
      const detail = `${error instanceof Error ? error.message : String(error)}${spawnResult.stderr ? `; ${spawnResult.stderr}` : ""}`;
      return { ...emptyResult("failed", "invalid_response", detail, Date.now() - started), launchReceipt: receipt };
    }
    if (native.requestId !== request.requestId || native.runId !== request.runId) {
      return { ...emptyResult("failed", "invalid_response", "native response identity mismatch", Date.now() - started), launchReceipt: receipt };
    }
    for (const event of native.events) {
      ctx.emit("info", node.id, { kind: "native_run_event", event });
    }
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
        ...emptyResult("failed", "process_crash", detail, Date.now() - started),
        tokens: native.tokens,
        launchReceipt: receipt,
      };
    }
    const status = native.status === "done" ? "done" : native.status === "blocked" ? "restricted" : "failed";
    return {
      content: native.content,
      fileChanges: native.status === "done" && request.operation !== "interrupt" ? diffFileChanges(ctx.workdir) : [],
      tokens: native.tokens,
      cost: null,
      latencyMs: Date.now() - started,
      status,
      ...(native.message ? { error: redactSecrets(native.message) } : {}),
      ...(native.failureKind ? { nativeFailureKind: native.failureKind } : {}),
      executor: "native",
      launchReceipt: receipt,
    };
  }
}

export class NativeFallbackEngine implements ExecutionEngine {
  readonly framework: AgentFramework;
  constructor(
    private readonly native: ExecutionEngine,
    private readonly fallback: ExecutionEngine,
  ) {
    this.framework = native.framework;
  }

  probe(): Promise<EngineAvailability> { return this.native.probe(); }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    const result = await this.native.run(node, task, ctx);
    if (nativeOperationFromTask(task) !== "start") return result;
    if (result.status === "done" || !["native_unavailable", "version_incompatible", "capability_unavailable"].includes(result.nativeFailureKind ?? "")) {
      return result;
    }
    const requested = this.native.framework === "claude-code" ? "claude-native" : "codex-native";
    const reason = `native ${result.nativeFailureKind}: ${result.error ?? "unavailable"}`;
    ctx.emit("info", node.id, {
      kind: "native_adapter_degraded",
      requested,
      fallback: "acp",
      reason,
      message: `${requested} unavailable; explicitly falling back to the existing ACP route (${reason})`,
    });
    const fallbackManifest = buildEffectiveCapabilityManifest({
      agent: node,
      framework: this.fallback.framework,
      task,
      ctx: { ...ctx, capabilityManifest: undefined },
    });
    ctx.emit("info", node.id, {
      kind: "effective_capability_manifest",
      reason: "native_adapter_fallback",
      manifest: fallbackManifest,
    });
    const fallback = await this.fallback.run(node, task, { ...ctx, capabilityManifest: fallbackManifest });
    return { ...fallback, degradedReason: reason };
  }
}

export class NativeRouteFallbackEngine implements ExecutionEngine {
  readonly framework: AgentFramework;
  constructor(
    private readonly fallback: ExecutionEngine,
    private readonly reason: string,
    private readonly failureKind: NativeExecutionFailureKind,
  ) {
    this.framework = fallback.framework;
  }

  probe(): Promise<EngineAvailability> { return this.fallback.probe(); }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    if (nativeOperationFromTask(task) !== "start") {
      return emptyResult("restricted", this.failureKind, this.reason, 0);
    }
    const result = await this.fallback.run(node, task, ctx);
    return { ...result, degradedReason: this.reason };
  }
}

export class CapabilityBlockedEngine implements ExecutionEngine {
  constructor(
    readonly framework: AgentFramework,
    private readonly reason: string,
    private readonly failureKind: NativeExecutionFailureKind = "capability_unavailable",
  ) {}
  async probe(): Promise<EngineAvailability> {
    return { framework: this.framework, installed: false, loggedIn: false, version: "", detail: this.reason };
  }
  async run(_node: AgentNodeConfig, _task: ExecTask, _ctx: ExecContext): Promise<ExecResult> {
    return emptyResult("restricted", this.failureKind, this.reason, 0);
  }
}
