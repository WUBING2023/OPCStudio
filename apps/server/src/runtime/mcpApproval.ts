import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { McpServerConfig } from "@opc/shared";

export interface McpApprovalRecord {
  serverId: string;
  bindingHash: string;
  descriptorHash: string;
  workspaceHash: string;
  envNames: string[];
  envValueHashes: Record<string, string>;
  approvedAt: string;
  expiresAt: string;
}

const APPROVAL_FILE = "mcp_approvals.json";
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalWorkspace(projectRoot: string): string {
  let resolved: string;
  try { resolved = fs.realpathSync(path.resolve(projectRoot)); }
  catch { resolved = path.resolve(projectRoot); }
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function mcpApprovalDescriptor(projectRoot: string, server: McpServerConfig) {
  const envNames = Object.keys(server.env ?? {}).sort();
  const envValueHashes = Object.fromEntries(envNames.map((name) => [name, hash(server.env?.[name] ?? "")]));
  const descriptor = {
    transport: server.transport,
    command: server.command ?? null,
    args: server.args ?? [],
    url: server.url ?? null,
    envNames,
    envValueHashes,
    workspace: canonicalWorkspace(projectRoot),
  };
  const descriptorHash = hash(stable({ ...descriptor, workspace: undefined }));
  const workspaceHash = hash(descriptor.workspace);
  return { ...descriptor, descriptorHash, workspaceHash, bindingHash: hash(stable(descriptor)) };
}

function approvalPath(projectRoot: string): string {
  return path.join(projectRoot, ".opc", APPROVAL_FILE);
}

export function loadMcpApprovals(projectRoot: string): Record<string, McpApprovalRecord> {
  try {
    const raw = JSON.parse(fs.readFileSync(approvalPath(projectRoot), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch { return {}; }
}

function saveMcpApprovals(projectRoot: string, approvals: Record<string, McpApprovalRecord>): void {
  const target = approvalPath(projectRoot);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(approvals, null, 2), { encoding: "utf8", flag: "wx" });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

export function approveMcpServer(
  projectRoot: string,
  server: McpServerConfig,
  nowMs = Date.now(),
  ttlMs = DEFAULT_APPROVAL_TTL_MS,
): McpApprovalRecord {
  const descriptor = mcpApprovalDescriptor(projectRoot, server);
  const record: McpApprovalRecord = {
    serverId: server.id,
    bindingHash: descriptor.bindingHash,
    descriptorHash: descriptor.descriptorHash,
    workspaceHash: descriptor.workspaceHash,
    envNames: descriptor.envNames,
    envValueHashes: descriptor.envValueHashes,
    approvedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMs).toISOString(),
  };
  saveMcpApprovals(projectRoot, { ...loadMcpApprovals(projectRoot), [server.id]: record });
  return record;
}

export function validMcpApproval(projectRoot: string, server: McpServerConfig, nowMs = Date.now()): McpApprovalRecord | null {
  const record = loadMcpApprovals(projectRoot)[server.id];
  if (!record || Date.parse(record.expiresAt) <= nowMs) return null;
  return record.bindingHash === mcpApprovalDescriptor(projectRoot, server).bindingHash ? record : null;
}

export function revokeMcpApproval(projectRoot: string, serverId: string): void {
  const approvals = loadMcpApprovals(projectRoot);
  if (!(serverId in approvals)) return;
  delete approvals[serverId];
  saveMcpApprovals(projectRoot, approvals);
}
