import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, ExecContext, ExecTask, WorkerLaunchReceipt } from "@opc/shared";

export interface WorkerLaunchMetadata {
  file: string;
  argvHash: string;
  environmentNames: string[];
  cwd: string;
  launchedAt: string;
  attempt: number;
}

const executableHashCache = new Map<string, { signature: string; sha256: string }>();

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function captureWorkerLaunchMetadata(input: {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  attempt?: number;
}): WorkerLaunchMetadata {
  return {
    file: path.resolve(input.file),
    argvHash: sha256Text(JSON.stringify(input.args)),
    environmentNames: Object.entries(input.env ?? process.env)
      .filter(([, value]) => value !== undefined)
      .map(([name]) => name)
      .sort(),
    cwd: path.resolve(input.cwd ?? process.cwd()),
    launchedAt: new Date().toISOString(),
    attempt: Math.max(1, input.attempt ?? 1),
  };
}

async function executableSha256(file: string): Promise<string | undefined> {
  try {
    const canonical = await fs.promises.realpath(file);
    const stat = await fs.promises.stat(canonical);
    if (!stat.isFile()) return undefined;
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = executableHashCache.get(canonical);
    if (cached?.signature === signature) return cached.sha256;

    const sha256 = await new Promise<string>((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = fs.createReadStream(canonical);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
    executableHashCache.set(canonical, { signature, sha256 });
    return sha256;
  } catch {
    return undefined;
  }
}

export async function buildWorkerLaunchReceipt(
  node: AgentNodeConfig,
  task: ExecTask,
  ctx: ExecContext,
  metadata: WorkerLaunchMetadata | undefined,
  launchKind: WorkerLaunchReceipt["launchKind"] = "subprocess",
): Promise<WorkerLaunchReceipt | undefined> {
  if (!metadata) return undefined;
  const executableHash = await executableSha256(metadata.file);
  const capability = ctx.capabilityManifest;
  const complete = !!capability && !!executableHash;
  return {
    schemaVersion: "1",
    runId: ctx.runId,
    taskId: task.taskId,
    agentId: node.id,
    attempt: metadata.attempt,
    launchedAt: metadata.launchedAt,
    launchKind,
    executable: {
      path: metadata.file,
      ...(executableHash ? { sha256: executableHash } : {}),
      ...(path.resolve(metadata.file) === path.resolve(process.execPath) ? { version: process.version } : {}),
    },
    argvHash: metadata.argvHash,
    environmentNames: metadata.environmentNames,
    cwd: metadata.cwd,
    sandboxBackend: capability?.effective.sandboxBackend ?? "none",
    fullHostAccess: capability?.effective.fullHostAccess ?? true,
    approvalMode: capability?.effective.approvalMode ?? "run-governance",
    capabilityManifestHash: capability?.manifestHash ?? "missing",
    mcpSpecsHash: sha256Text(JSON.stringify(capability?.effective.mcpSpecs ?? [])),
    completeness: complete ? "complete" : "partial",
  };
}

export function emitWorkerLaunchReceipt(
  ctx: ExecContext,
  node: AgentNodeConfig,
  receipt: WorkerLaunchReceipt | undefined,
): void {
  if (!receipt) return;
  ctx.emit("info", node.id, { kind: "worker_launch_receipt", receipt });
}
