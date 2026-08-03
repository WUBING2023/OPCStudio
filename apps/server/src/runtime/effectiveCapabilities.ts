import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
  AgentFramework,
  AgentNodeConfig,
  EffectiveCapabilityManifest,
  ExecContext,
  ExecTask,
  McpServerConfig,
} from "@opc/shared";
import { loadConfig } from "../storage/projectStore.js";
import { listMcpServers } from "../storage/mcpStore.js";
import { getProfileForRole } from "./roleProfile.js";

function normalizeFramework(framework?: AgentFramework): AgentFramework {
  return !framework || framework === "hermes" ? "api" : framework;
}

function acpWorkerEnabled(): boolean {
  const value = process.env.OPC_ACP_WORKER;
  return value !== "0" && value !== "false";
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function endpointIdentity(server: McpServerConfig): string {
  if (server.transport === "http") {
    try {
      const url = new URL(server.url ?? "");
      return `${url.protocol}//${url.host}${url.pathname}`;
    } catch {
      return "invalid-http-endpoint";
    }
  }
  return path.basename(server.command ?? "missing-command");
}

function mcpSpecs(projectRoot: string, agentId: string): EffectiveCapabilityManifest["effective"]["mcpSpecs"] {
  let servers: McpServerConfig[] = [];
  try { servers = listMcpServers(projectRoot); } catch { return []; }
  return servers
    .filter((server) => server.enabled && (server.assignedAgents.length === 0 || server.assignedAgents.includes(agentId)))
    .map((server) => ({
      id: server.id,
      transport: server.transport,
      endpointIdentity: endpointIdentity(server),
      ...(server.args?.length ? { argsHash: sha256(stable(server.args)) } : {}),
      environmentNames: Object.keys(server.env ?? {}).sort(),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function frameworkHasFullHostAccess(framework: AgentFramework | undefined): boolean {
  const normalized = normalizeFramework(framework);
  if (normalized === "api") return false;
  if (normalized === "codex" && !acpWorkerEnabled()) return false;
  return true;
}

export function buildEffectiveCapabilityManifest(input: {
  agent: AgentNodeConfig;
  framework?: AgentFramework;
  nativeExecutor?: "codex-native" | "claude-native";
  task: ExecTask;
  ctx: ExecContext;
}): EffectiveCapabilityManifest {
  const framework = normalizeFramework(input.framework ?? input.agent.framework);
  const profile = getProfileForRole(input.agent.role);
  const config = loadConfig(input.ctx.projectRoot);
  const fullHostAccess = input.nativeExecutor ? false : frameworkHasFullHostAccess(framework);
  const unsupportedConstraints: string[] = [];

  let sandboxBackend: EffectiveCapabilityManifest["effective"]["sandboxBackend"];
  let shell: EffectiveCapabilityManifest["effective"]["shell"];
  let network: EffectiveCapabilityManifest["effective"]["network"];

  if (input.nativeExecutor === "codex-native") {
    sandboxBackend = "codex-workspace-write";
    shell = !config.permissions.allowShell || profile.shellMode === "none" ? "none" : "workspace-sandbox";
    network = "denied";
  } else if (input.nativeExecutor === "claude-native") {
    sandboxBackend = "provider-native";
    shell = !config.permissions.allowShell || profile.shellMode === "none" ? "none" : "workspace-sandbox";
    network = "denied";
  } else if (framework === "api") {
    sandboxBackend = "opc-tool-guard";
    shell = !config.permissions.allowShell || profile.shellMode === "none" ? "none" : profile.shellMode;
    network = config.permissions.allowWebAccess && profile.networkMode !== "off" ? "restricted" : "denied";
  } else if (framework === "codex" && !acpWorkerEnabled()) {
    sandboxBackend = "codex-workspace-write";
    shell = config.permissions.allowShell ? "workspace-sandbox" : "none";
    network = config.permissions.allowWebAccess && profile.networkMode === "on" ? "unrestricted" : "denied";
    if (profile.shellMode === "none") unsupportedConstraints.push("codex legacy sandbox cannot remove shell while retaining agent execution");
    if (profile.networkMode === "limited") unsupportedConstraints.push("limited network collapses to denied in the V0 binary network policy");
  } else {
    sandboxBackend = "none";
    shell = "full-host";
    network = "unrestricted";
    if (!config.permissions.allowShell || profile.shellMode !== "full") unsupportedConstraints.push("external CLI shell scope is not enforceable without an OS sandbox");
    if (!config.permissions.allowWebAccess || profile.networkMode !== "on") unsupportedConstraints.push("external CLI network scope is not enforceable without an OS sandbox");
    if (!config.permissions.allowFileWrite || profile.allowedExtensions.length === 0) unsupportedConstraints.push("external CLI file-write scope is not enforceable without an OS sandbox");
  }

  const environmentNames = input.nativeExecutor === "claude-native"
    ? ["ANTHROPIC_API_KEY"]
    : input.nativeExecutor === "codex-native"
      ? ["CODEX_HOME"]
      : fullHostAccess
    ? [...new Set([...profile.envAllowlist, "OPC_RUN_ID", "OPC_AGENT_ID"])].sort()
    : framework === "api"
      ? (input.ctx.apiKeyOverride || input.ctx.leasedAccount ? ["provider-credential:opaque"] : [])
      : [...new Set([...profile.envAllowlist, "CODEX_HOME", "OPC_RUN_ID", "OPC_AGENT_ID"])].sort();

  const generatedAt = new Date();
  const lifetimeMs = Math.min(
    Math.max((input.ctx.taskTimeoutMs ?? 300_000) + 60_000, 60_000),
    24 * 60 * 60 * 1000,
  );
  const unsigned = {
    schemaVersion: "1" as const,
    runId: input.ctx.runId,
    taskId: input.task.taskId,
    agentId: input.agent.id,
    companyId: input.agent.companyId ?? "default",
    framework,
    generatedAt: generatedAt.toISOString(),
    expiresAt: new Date(generatedAt.getTime() + lifetimeMs).toISOString(),
    requested: {
      fileWrite: config.permissions.allowFileWrite && profile.allowedExtensions.length > 0,
      shell: config.permissions.allowShell ? profile.shellMode : "none" as const,
      network: config.permissions.allowWebAccess ? profile.networkMode : "off" as const,
    },
    effective: {
      fileRoots: [{
        path: path.resolve(input.ctx.workdir),
        read: true,
        write: fullHostAccess ? true : config.permissions.allowFileWrite && profile.allowedExtensions.length > 0,
      }],
      shell,
      network,
      sandboxBackend,
      fullHostAccess,
      approvalMode: fullHostAccess ? "run-governance" as const : "not-required" as const,
      credentialScope: input.nativeExecutor === "claude-native" || framework === "api"
        ? "provider-call" as const
        : "subscription-profile" as const,
      environmentNames,
      mcpSpecs: mcpSpecs(input.ctx.projectRoot, input.agent.id),
    },
    unsupportedConstraints,
  };
  return { ...unsigned, manifestHash: sha256(stable(unsigned)) };
}
