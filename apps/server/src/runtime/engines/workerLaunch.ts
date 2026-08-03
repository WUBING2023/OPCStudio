import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface WorkerLaunch {
  file: string;
  args: string[];
  entry: string;
}

export function buildCliWorkerEnv(baseEnv: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  if (!/^node(?:\.exe)?$/i.test(path.basename(executable))) {
    env.ELECTRON_RUN_AS_NODE = "1";
  }
  if (/^node(?:\.exe)?$/i.test(path.basename(executable))) delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function findWorkspaceRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "apps", "cli"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function configuredNodeExecutable(): string {
  const configured = process.env.OPC_NODE_EXECUTABLE;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  return process.execPath;
}

function resolveTsxCli(entry: string, workspaceRoot: string): string {
  const candidates = [
    path.join(path.dirname(path.dirname(entry)), "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(workspaceRoot, "apps", "server", "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(workspaceRoot, "node_modules", "tsx", "dist", "cli.mjs"),
  ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("tsx CLI not found for TypeScript worker entry");
  return found;
}

export function resolveCliWorkerEntry(moduleUrl: string): string {
  const configured = process.env.OPC_CLI_WORKER_ENTRY;
  if (configured) {
    const absolute = path.resolve(configured);
    if (!path.isAbsolute(configured) || !fs.existsSync(absolute)) {
      throw new Error("OPC_CLI_WORKER_ENTRY must be an existing absolute path");
    }
    return absolute;
  }

  const here = path.dirname(fileURLToPath(moduleUrl));
  const workspaceRoot = findWorkspaceRoot(here);
  if (!workspaceRoot) throw new Error("cannot locate apps/cli worker from server runtime");
  const source = path.join(workspaceRoot, "apps", "cli", "src", "worker.ts");
  const compiled = path.join(workspaceRoot, "apps", "cli", "dist", "worker.mjs");
  const candidates = process.env.NODE_ENV === "production" ? [compiled, source] : [source, compiled];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("OPC CLI worker entry is missing; run the runtime build");
  return found;
}

export function buildCliWorkerLaunch(moduleUrl: string, workerArgs: string[]): WorkerLaunch {
  const entry = resolveCliWorkerEntry(moduleUrl);
  const ext = path.extname(entry).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") {
    const workspaceRoot = findWorkspaceRoot(path.dirname(entry));
    if (!workspaceRoot) throw new Error("cannot locate workspace root for TypeScript OPC CLI worker");
    return { file: configuredNodeExecutable(), args: [resolveTsxCli(entry, workspaceRoot), entry, ...workerArgs], entry };
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { file: configuredNodeExecutable(), args: ["--conditions=production", entry, ...workerArgs], entry };
  }
  throw new Error(`unsupported OPC CLI worker extension: ${ext || "(none)"}`);
}

export function resolveCliNativeEntry(moduleUrl: string): string {
  const configured = process.env.OPC_CLI_NATIVE_ENTRY;
  if (configured) {
    const absolute = path.resolve(configured);
    if (!path.isAbsolute(configured) || !fs.existsSync(absolute)) {
      throw new Error("OPC_CLI_NATIVE_ENTRY must be an existing absolute path");
    }
    return absolute;
  }

  // Packaged Electron already points at cli-dist/worker.js. The native runner is staged beside it.
  const workerEntry = process.env.OPC_CLI_WORKER_ENTRY;
  if (workerEntry && path.isAbsolute(workerEntry)) {
    const sibling = path.join(path.dirname(workerEntry), "native-adapters", "runner.js");
    if (fs.existsSync(sibling)) return sibling;
  }

  const here = path.dirname(fileURLToPath(moduleUrl));
  const workspaceRoot = findWorkspaceRoot(here);
  if (!workspaceRoot) throw new Error("cannot locate apps/cli native runner from server runtime");
  const source = path.join(workspaceRoot, "apps", "cli", "src", "native-adapters", "runner.ts");
  const compiled = path.join(workspaceRoot, "apps", "cli", "dist", "native-adapters", "runner.js");
  const candidates = process.env.NODE_ENV === "production" ? [compiled, source] : [source, compiled];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error("OPC CLI native runner is missing; run the runtime build");
  return found;
}

export function buildCliNativeLaunch(moduleUrl: string): WorkerLaunch {
  const entry = resolveCliNativeEntry(moduleUrl);
  const ext = path.extname(entry).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") {
    const workspaceRoot = findWorkspaceRoot(path.dirname(entry));
    if (!workspaceRoot) throw new Error("cannot locate workspace root for TypeScript OPC native runner");
    return { file: configuredNodeExecutable(), args: [resolveTsxCli(entry, workspaceRoot), entry], entry };
  }
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
    return { file: configuredNodeExecutable(), args: ["--conditions=production", entry], entry };
  }
  throw new Error(`unsupported OPC CLI native runner extension: ${ext || "(none)"}`);
}
