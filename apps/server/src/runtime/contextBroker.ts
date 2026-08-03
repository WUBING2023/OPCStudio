import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { AgentNodeConfig } from "@opc/shared";
import { loadChanges, loadConfig, loadRunTask } from "../storage/projectStore.js";
import {
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import type { InjectionContext } from "./contextBuilder.js";
import { listMcpServers } from "../storage/mcpStore.js";
import { getSkill } from "../storage/skillStore.js";
import { listResourcePointers } from "./resourcePointer.js";
import { markMemoryActivity } from "./memoryCurator.js";
import {
  retrievePromptMemories,
  type PromptMemoryRecord,
  type PromptMemoryRetrieval,
} from "./memoryRetrievalProvider.js";

export interface ProgressiveContextBatch {
  order: number;
  id:
    | "control"
    | "identity"
    | "task_contract"
    | "runtime_environment"
    | "permissions"
    | "resource_constraints"
    | "project_conventions"
    | "task_graph"
    | "mcp_catalog"
    | "skill_catalog"
    | "failure_lessons"
    | "success_experiences"
    | "memory_user_index"
    | "memory_company_index"
    | "memory_project_index"
    | "memory_team_index"
    | "memory_agent_index"
    | "upstream"
    | "user_state"
    | "dynamic_state"
    | "completion";
  disclosure: "always" | "prefetch" | "selected" | "on_demand";
  items: string[];
}

export interface AgentContextSnapshot {
  agentId: string;
  role: string;
  teamId?: string;
  retrievalMode: PromptMemoryRetrieval["mode"];
  candidateCount: number;
  injectedMemoryIds: string[];
  injectedMemories: Array<{
    id: string;
    kind: string;
    scope?: LayeredMemoryScope;
    scopeId?: string;
    version: string;
    source: PromptMemoryRecord["source"];
    sourceType?: string;
    sourceRunId?: string;
    modified?: string;
    confidence?: number;
    selectionReason: string;
  }>;
  injectedSkillIds: string[];
  batches: ProgressiveContextBatch[];
  promptHash: string;
  sharedStateHash: string;
}

export interface ContextAgentSelections {
  memories: Array<{
    id: string;
    contentHash: string;
    scope?: LayeredMemoryScope;
    scopeId?: string;
    source: PromptMemoryRecord["source"];
    selectionReason: string;
  }>;
  skills: Array<{ id: string; contentHash: string }>;
}

export interface ContextManifestSelections {
  projectConventions: Array<{ relativePath: string; contentHash: string; truncated: boolean }>;
  mcpServers: Array<{ id: string; transport: "stdio" | "http"; specHash: string }>;
  agents: Record<string, ContextAgentSelections>;
}

export interface ContextManifestBudgets {
  memoryCandidateLimit: number;
  memoryItemLimit: number;
  memoryCharLimit: number;
  skillItemLimit: number;
  skillCharLimit: number;
  projectConventionFileCharLimit: number;
  projectConventionTotalCharLimit: number;
  mcpItemLimit: number;
  agentPromptChars: Record<string, number>;
}

export interface RunContextSnapshot {
  schemaVersion: "1";
  runId: string;
  companyId: string;
  projectId: string;
  goalHash: string;
  generatedAt: string;
  sharedStateVerifiedAt: string;
  sharedStateHash: string;
  sharedState: {
    workRoot: string;
    workRootStatus: "ready" | "missing" | "not_directory";
    gitStatus: "clean" | "dirty" | "unavailable";
    gitStatusHash: string;
    gitChangedEntries: number;
    resourcePointerHash: string;
    resourcePointerCount: number;
  };
  sourceVersions: Record<string, string>;
  selections: ContextManifestSelections;
  budgets: ContextManifestBudgets;
  agents: Record<string, AgentContextSnapshot>;
  manifestHash: string;
  snapshotHash: string;
}

/** Canonical, replay-auditable context record. RunContextSnapshot remains as a compatibility name. */
export type ContextManifest = RunContextSnapshot;

interface CachedPrompt {
  prompt: string;
  injectedSkillIds: string[];
  injectedMemoryIds: string[];
  injectedMemories: NonNullable<InjectionContext["injectedMemories"]>;
  memoryPack?: InjectionContext["memoryPack"];
  excludedBundledSkillIds?: string[];
}

const promptCache = new Map<string, CachedPrompt>();
interface RunSharedContext {
  identity: ReturnType<typeof runIdentity>;
  runDoc: Record<string, unknown>;
  projectConfig: ReturnType<typeof loadConfig>;
  conventions: string[];
  conventionSelections: ContextManifestSelections["projectConventions"];
  changedFiles: string;
  mcpItems: string[];
  mcpSelections: ContextManifestSelections["mcpServers"];
  resourceItems: string[];
  sharedState: RunContextSnapshot["sharedState"];
  verifiedAt: string;
  sharedStateHash: string;
}
const runSharedContextCache = new Map<string, RunSharedContext>();
const MAX_CACHE_ENTRIES = 256;
const MAX_SHARED_CACHE_ENTRIES = 128;
const CONTEXT_MEMORY_CANDIDATE_LIMIT = 100;
const CONTEXT_MEMORY_ITEM_LIMIT = 20;
const CONTEXT_MEMORY_CHAR_LIMIT = 8_000;
const CONTEXT_SKILL_ITEM_LIMIT = 3;
const CONTEXT_SKILL_CHAR_LIMIT = 500;
const CONTEXT_MCP_ITEM_LIMIT = 20;

function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;
}

function agentScopeKey(agent: string | AgentNodeConfig): string {
  if (typeof agent === "string") return `${agent}|default|none`;
  return `${agent.id}|${agent.companyId || "default"}|${agent.parentId || "none"}`;
}

function cacheKey(root: string, runId: string, agent: string | AgentNodeConfig, goal: string, baseRolePrompt: string): string {
  return [path.resolve(root), runId, agentScopeKey(agent), hash(goal), hash(baseRolePrompt)].join("|");
}

export function restoreCachedPrompt(
  root: string,
  runId: string,
  agent: string | AgentNodeConfig,
  goal: string,
  baseRolePrompt: string,
  out: InjectionContext,
): string | null {
  const hit = promptCache.get(cacheKey(root, runId, agent, goal, baseRolePrompt));
  if (!hit) return null;
  out.injectedSkillIds.push(...hit.injectedSkillIds);
  out.injectedMemoryIds.push(...hit.injectedMemoryIds);
  out.injectedMemories = hit.injectedMemories.map((item) => ({ ...item }));
  out.memoryPack = hit.memoryPack;
  out.excludedBundledSkillIds = hit.excludedBundledSkillIds ? [...hit.excludedBundledSkillIds] : undefined;
  return hit.prompt;
}

function trimCache(): void {
  while (promptCache.size > MAX_CACHE_ENTRIES) {
    const first = promptCache.keys().next().value as string | undefined;
    if (!first) break;
    promptCache.delete(first);
  }
}

function trimSharedCache(): void {
  while (runSharedContextCache.size > MAX_SHARED_CACHE_ENTRIES) {
    const first = runSharedContextCache.keys().next().value as string | undefined;
    if (!first) break;
    runSharedContextCache.delete(first);
  }
}

export const PROJECT_CONVENTION_FILE_MAX_CHARS = 4_000;
export const PROJECT_CONVENTION_TOTAL_MAX_CHARS = 12_000;

export interface ProjectConventionSource {
  file: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

function nearestGitRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

export interface ProjectConventionAuditEntry extends ProjectConventionSource {
  status: "loaded" | "skipped";
  reason:
    | "loaded"
    | "loaded_truncated"
    | "not_found"
    | "empty"
    | "duplicate"
    | "total_budget_exhausted"
    | "outside_git_root";
}

export function auditProjectConventions(workRoot: string): ProjectConventionAuditEntry[] {
  const start = path.resolve(workRoot);
  const boundary = nearestGitRoot(start);
  const dirs: string[] = [];
  let current = start;
  for (;;) {
    dirs.unshift(current);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current || !current.startsWith(boundary + path.sep)) break;
    current = parent;
  }

  const out: ProjectConventionAuditEntry[] = [];
  const seenContent = new Set<string>();
  let remaining = PROJECT_CONVENTION_TOTAL_MAX_CHARS;
  for (const dir of dirs) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = path.join(dir, name);
      const relativePath = path.relative(boundary, file).replace(/\\/g, "/") || name;
      let raw: string;
      try { raw = fs.readFileSync(file, "utf-8").trim(); }
      catch {
        out.push({ file, relativePath, content: "", truncated: false, status: "skipped", reason: "not_found" });
        continue;
      }
      if (!raw) {
        out.push({ file, relativePath, content: "", truncated: false, status: "skipped", reason: "empty" });
        continue;
      }
      const contentHash = hash(raw);
      if (seenContent.has(contentHash)) {
        out.push({ file, relativePath, content: "", truncated: false, status: "skipped", reason: "duplicate" });
        continue;
      }
      seenContent.add(contentHash);
      if (remaining <= 0) {
        out.push({ file, relativePath, content: "", truncated: true, status: "skipped", reason: "total_budget_exhausted" });
        continue;
      }
      const perFile = raw.slice(0, PROJECT_CONVENTION_FILE_MAX_CHARS);
      const content = perFile.slice(0, remaining);
      const truncated = content.length < raw.length;
      out.push({
        file,
        relativePath,
        content,
        truncated,
        status: "loaded",
        reason: truncated ? "loaded_truncated" : "loaded",
      });
      remaining -= content.length;
    }
  }

  const outsideDir = path.dirname(boundary);
  if (outsideDir !== boundary) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const file = path.join(outsideDir, name);
      if (!fs.existsSync(file)) continue;
      out.push({
        file,
        relativePath: path.relative(boundary, file).replace(/\\/g, "/"),
        content: "",
        truncated: false,
        status: "skipped",
        reason: "outside_git_root",
      });
    }
  }
  return out;
}

export function discoverProjectConventions(workRoot: string): ProjectConventionSource[] {
  return auditProjectConventions(workRoot)
    .filter((item) => item.status === "loaded")
    .map(({ file, relativePath, content, truncated }) => ({ file, relativePath, content, truncated }));
}
function runIdentity(
  root: string,
  runId: string,
  agent?: Pick<AgentNodeConfig, "companyId">,
): { companyId: string; projectId: string; workRoot: string; graphId?: string; baseCommit?: string } {
  const run = loadRunTask(root, runId);
  const companyId = run?.companyId || agent?.companyId || "default";
  return {
    companyId,
    projectId: run?.missionId || run?.taskGraphId || runId,
    workRoot: run?.workRoot || root,
    graphId: run?.taskGraphId,
    baseCommit: run?.baseCommit,
  };
}

function runSharedKey(root: string, runId: string, companyId: string): string {
  return [path.resolve(root), runId, companyId].join("|");
}

function getRunSharedContext(
  root: string,
  runId: string,
  agent: Pick<AgentNodeConfig, "companyId">,
): RunSharedContext {
  const identity = runIdentity(root, runId, agent);
  const key = runSharedKey(root, runId, identity.companyId);
  const cached = runSharedContextCache.get(key);
  if (cached) return cached;

  const run = loadRunTask(root, runId);
  const runDoc = (run ?? {}) as unknown as Record<string, unknown>;
  const projectConfig = loadConfig(root);
  const conventionSources = discoverProjectConventions(identity.workRoot);
  const conventions = conventionSources
    .map((item) => `${item.relativePath}${item.truncated ? " (truncated)" : ""}:\n${item.content}`);
  const conventionSelections = conventionSources.map((item) => ({
    relativePath: item.relativePath,
    contentHash: hash(item.content),
    truncated: item.truncated,
  }));
  const compactValue = (value: unknown, max = 800) => {
    if (value === undefined || value === null) return "none";
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.replace(/\s+/g, " ").slice(0, max);
  };
  let changedFiles = "none";
  try {
    const changes = loadChanges(root, runId);
    if (changes.length > 0) changedFiles = compactValue(changes);
  } catch { /* first worker may run before changes.json exists */ }

  const pointers = listResourcePointers(root)
    .filter((item) =>
      (item.scope === "company" && item.scopeId === identity.companyId)
      || (item.scope === "project" && item.scopeId === identity.projectId))
    .slice(0, 100);
  const resourceItems = pointers.slice(0, 12)
    .map((item) => `resource:${item.id} kind=${item.kind} status=${item.status}; validate once before use`);
  const enabledMcps = listMcpServers(root)
    .filter((server) => server.enabled)
    .slice(0, CONTEXT_MCP_ITEM_LIMIT);
  const mcpItems = enabledMcps
    .map((server) => `mcp:${server.id} transport=${server.transport}; availability must be checked before selection`);
  const mcpSelections = enabledMcps.map((server) => ({
    id: server.id,
    transport: server.transport,
    // Hash the effective capability shape without serializing credential values
    // into the manifest. A credential rotation must not leak through evidence.
    specHash: hash(JSON.stringify({
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: server.args,
      url: server.url,
      envNames: Object.keys(server.env ?? {}).sort(),
      allowLocalNetwork: server.allowLocalNetwork === true,
      assignedAgents: [...server.assignedAgents].sort(),
    })),
  }));

  let workRootStatus: RunContextSnapshot["sharedState"]["workRootStatus"] = "missing";
  try {
    const stat = fs.statSync(identity.workRoot);
    workRootStatus = stat.isDirectory() ? "ready" : "not_directory";
  } catch { /* missing */ }
  let gitStatus: RunContextSnapshot["sharedState"]["gitStatus"] = "unavailable";
  let gitStatusText = "";
  if (workRootStatus === "ready") {
    try {
      gitStatusText = execFileSync("git", ["status", "--porcelain=v1", "-uno"], {
        cwd: identity.workRoot,
        encoding: "utf-8",
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      gitStatus = gitStatusText ? "dirty" : "clean";
    } catch { /* non-Git work roots are valid but explicitly unavailable */ }
  }
  const sharedState: RunContextSnapshot["sharedState"] = {
    workRoot: identity.workRoot,
    workRootStatus,
    gitStatus,
    gitStatusHash: hash(gitStatusText),
    gitChangedEntries: gitStatusText ? gitStatusText.split(/\r?\n/).filter(Boolean).length : 0,
    resourcePointerHash: hash(JSON.stringify(pointers.map((item) => ({
      id: item.id,
      status: item.status,
      contentHash: item.contentHash,
      etag: item.etag,
      validatedAt: item.validatedAt,
    })))),
    resourcePointerCount: pointers.length,
  };
  const result: RunSharedContext = {
    identity,
    runDoc,
    projectConfig,
    conventions,
    conventionSelections,
    changedFiles,
    mcpItems,
    mcpSelections,
    resourceItems,
    sharedState,
    verifiedAt: new Date().toISOString(),
    sharedStateHash: hash(JSON.stringify(sharedState)),
  };
  runSharedContextCache.set(key, result);
  trimSharedCache();
  return result;
}

export function memoryScopesForAgent(root: string, agent: AgentNodeConfig, runId: string): Array<{ scope: LayeredMemoryScope; scopeId: string }> {
  const identity = runIdentity(root, runId, agent);
  const teamId = agent.role === "lead" ? agent.id : agent.parentId;
  return [
    { scope: "user", scopeId: "local-user" },
    { scope: "company", scopeId: identity.companyId },
    { scope: "project", scopeId: identity.projectId },
    ...(teamId ? [{ scope: "team" as const, scopeId: teamId }] : []),
    { scope: "agent", scopeId: agent.id },
  ];
}

export function buildProgressiveMemoryIndexContext(
  root: string,
  agent: AgentNodeConfig,
  goal: string,
  runId: string,
): {
  text: string;
  memoryText: string;
  refs: Array<{ id: string; kind: string; title: string }>;
  selectedMemories: PromptMemoryRecord[];
  retrievalMode: PromptMemoryRetrieval["mode"];
  scopes: Array<{ scope: LayeredMemoryScope; scopeId: string }>;
  batches: ProgressiveContextBatch[];
  candidateCount: number;
  sharedState: RunContextSnapshot["sharedState"];
  sharedStateHash: string;
  sharedStateVerifiedAt: string;
} {
  markMemoryActivity(root);
  const shared = getRunSharedContext(root, runId, agent);
  const { identity, projectConfig, runDoc } = shared;
  const teamId = agent.role === "lead" ? agent.id : agent.parentId;
  const scopes: Array<{ scope: LayeredMemoryScope; scopeId: string }> = [
    { scope: "user", scopeId: "local-user" },
    { scope: "company", scopeId: identity.companyId },
    { scope: "project", scopeId: identity.projectId },
    ...(teamId ? [{ scope: "team" as const, scopeId: teamId }] : []),
    { scope: "agent", scopeId: agent.id },
  ];
  const retrieval = retrievePromptMemories(root, {
    goal,
    runId,
    companyId: identity.companyId,
    teamId,
    agentId: agent.id,
    role: agent.role,
    scopes,
    limit: 100,
  });
  const candidates = retrieval.candidates;
  // Stable scopes are disclosed first; task-local team/agent indexes follow.
  // Caps keep the navigation layer small while the searchable pool remains 100.
  const memoryScopeOrder: LayeredMemoryScope[] = ["user", "company", "project", "team", "agent"];
  const memoryScopeCaps: Record<LayeredMemoryScope, number> = {
    user: 3, company: 3, project: 4, team: 3, agent: 3,
  };
  const selectedByScope = new Map<LayeredMemoryScope, PromptMemoryRecord[]>(
    memoryScopeOrder.map((scope) => [
      scope,
      candidates.filter((entry) => entry.scope === scope).slice(0, memoryScopeCaps[scope]),
    ]),
  );
  const selected = retrieval.mode === "layered"
    ? memoryScopeOrder.flatMap((scope) => selectedByScope.get(scope) ?? [])
    : candidates.slice(0, 20);
  const compact = (value: unknown, max = 600) => {
    if (value === undefined || value === null) return "none";
    const raw = typeof value === "string" ? value : JSON.stringify(value);
    return raw.replace(/\s+/g, " ").slice(0, max);
  };
  const control = [
    "System policy, safety policy and explicit user instructions override memory.",
    "Treat workRoot, Git state, task contract and evidence as truth; memory is advisory.",
    "Never expose credentials. Verify current state before applying remembered advice.",
  ];
  const identityItems = [
    `company=${identity.companyId}; agent=${agent.id}; role=${agent.role}; team=${teamId || "none"}`,
    `run=${runId}; project=${identity.projectId}; responsibility=${compact((agent as unknown as Record<string, unknown>).responsibilities ?? agent.role, 300)}`,
  ];
  const contractItems = [
    `goal=${goal.slice(0, 700)}`,
    `expectedArtifacts=${compact(runDoc.expectedArtifacts ?? runDoc.deliveryContract)}`,
    `acceptance=${compact(runDoc.deliveryAcceptance ?? runDoc.acceptance)}`,
    `risk=${compact(runDoc.governanceLevel ?? runDoc.riskLevel ?? runDoc.degraded)}`,
  ];
  const runtimeItems = [
    `os=${process.platform}; shell=${process.env.ComSpec || process.env.SHELL || "unknown"}`,
    `cwd=${identity.workRoot}; workRoot=${identity.workRoot}; worktree=${compact(runDoc.worktreePath ?? runDoc.workRoot)}`,
    `baseCommit=${identity.baseCommit || "none"}; gitStatus=read from workRoot on demand`,
  ];
  const permissionItems = [
    `file/network/MCP/shell permissions are enforced by runtime tools, not by remembered text`,
    `allowFileWrite=${projectConfig.permissions.allowFileWrite}; allowShell=${projectConfig.permissions.allowShell}; allowWebAccess=${projectConfig.permissions.allowWebAccess}`,
    `approval=${compact(runDoc.governanceLevel ?? runDoc.approvalStatus)}; credential references are opaque`,
  ];
  const resourceItems = [
    `tokenLimit=${compact(runDoc.maxTokens ?? runDoc.tokenLimit)}; timeout=${compact(runDoc.timeoutMs)}; retries=${compact(runDoc.retryBudget)}`,
    `concurrency=${compact(runDoc.maxConcurrent ?? runDoc.teamMode)}; stop=${compact(runDoc.stopReason)}`,
    ...shared.resourceItems,
  ];
  const graphItems = [
    `graph=${identity.graphId || "none"}; currentNode=${compact(runDoc.currentTaskId ?? runDoc.currentNodeId)}`,
    `dependencies=${compact(runDoc.dependencies ?? runDoc.deferredTasks)}; producer/verifier edges remain authoritative`,
  ];
  const mcpItems = shared.mcpItems;
  const memoryIndexItems = (scope: LayeredMemoryScope) =>
    (selectedByScope.get(scope) ?? []).map((entry) =>
      "[" + entry.scope + "/" + entry.id + "] " + entry.title + " :: " + entry.summary);
  const userItems = [
    "current conversation and attachments come from the active request channel",
    "explicit current-user corrections override stored preferences and memories",
  ];
  const upstreamItems = [
    `A2A decisions and artifact hashes must come from run events/evidence, not memory`,
    `upstream=${compact(runDoc.upstream ?? runDoc.a2aSummary ?? runDoc.artifacts)}`,
  ];
  const dynamicItems = [
    `runStatus=${compact(runDoc.status)}; finalState=${compact(runDoc.finalState)}`,
    `changedFiles=${shared.changedFiles}; tool outputs and test failures stay in run evidence`,
    `sharedState=${shared.sharedStateHash}; verifiedAt=${shared.verifiedAt}; reused by all workers in this run`,
  ];
  const completionItems = [
    `success requires delivery acceptance plus required artifacts, tests and evidence integrity`,
    `currentAcceptance=${compact(runDoc.deliveryAcceptance)}`,
  ];
  const batches: ProgressiveContextBatch[] = [
    { order: 0, id: "control", disclosure: "always", items: control },
    { order: 1, id: "identity", disclosure: "always", items: identityItems },
    { order: 2, id: "task_contract", disclosure: "always", items: contractItems },
    { order: 3, id: "runtime_environment", disclosure: "prefetch", items: runtimeItems },
    { order: 4, id: "permissions", disclosure: "prefetch", items: permissionItems },
    { order: 5, id: "resource_constraints", disclosure: "prefetch", items: resourceItems },
    { order: 6, id: "project_conventions", disclosure: "prefetch", items: shared.conventions },
    { order: 7, id: "task_graph", disclosure: "prefetch", items: graphItems },
    { order: 8, id: "mcp_catalog", disclosure: "selected", items: mcpItems },
    { order: 9, id: "skill_catalog", disclosure: "selected", items: [] },
    { order: 10, id: "failure_lessons", disclosure: "selected", items: [] },
    { order: 11, id: "success_experiences", disclosure: "selected", items: [] },
    { order: 12, id: "memory_user_index", disclosure: "prefetch", items: memoryIndexItems("user") },
    { order: 13, id: "memory_company_index", disclosure: "prefetch", items: memoryIndexItems("company") },
    { order: 14, id: "memory_project_index", disclosure: "prefetch", items: memoryIndexItems("project") },
    { order: 15, id: "memory_team_index", disclosure: "selected", items: memoryIndexItems("team") },
    { order: 16, id: "memory_agent_index", disclosure: "selected", items: memoryIndexItems("agent") },
    { order: 17, id: "upstream", disclosure: "selected", items: upstreamItems },
    { order: 18, id: "user_state", disclosure: "selected", items: userItems },
    { order: 19, id: "dynamic_state", disclosure: "on_demand", items: dynamicItems },
    { order: 20, id: "completion", disclosure: "always", items: completionItems },
  ];
  const renderBatches = (selectedBatches: ProgressiveContextBatch[]) => selectedBatches.flatMap((batch) => [
    `### Context: ${batch.id}`,
    ...batch.items.map((item) => `- ${item}`),
    "",
  ]).join(String.fromCharCode(10)).trim();
  const memoryBatchIds = new Set<ProgressiveContextBatch["id"]>([
    "memory_user_index", "memory_company_index", "memory_project_index",
    "memory_team_index", "memory_agent_index",
  ]);
  const promptBatches = batches.filter((batch) =>
    !memoryBatchIds.has(batch.id)
    && (batch.disclosure === "always" || batch.disclosure === "prefetch" || (batch.disclosure === "selected" && batch.items.length > 0)));
  const memoryBatches = batches.filter((batch) => memoryBatchIds.has(batch.id) && batch.items.length > 0);
  const text = renderBatches(promptBatches);
  const memoryText = renderBatches(memoryBatches);
  return {
    text,
    memoryText,
    refs: selected.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title.slice(0, 80) })),
    selectedMemories: selected,
    retrievalMode: retrieval.mode,
    scopes,
    batches,
    candidateCount: candidates.length,
    sharedState: shared.sharedState,
    sharedStateHash: shared.sharedStateHash,
    sharedStateVerifiedAt: shared.verifiedAt,
  };
}

function snapshotPath(root: string, runId: string): string {
  return path.join(root, ".opc", "runs", runId, "context-snapshot.json");
}

function manifestPath(root: string, runId: string): string {
  return path.join(root, ".opc", "runs", runId, "context-manifest.json");
}

function readSnapshot(root: string, runId: string): RunContextSnapshot | null {
  for (const file of [manifestPath(root, runId), snapshotPath(root, runId)]) {
    try { return JSON.parse(fs.readFileSync(file, "utf-8")) as RunContextSnapshot; }
    catch { /* compatibility fallback */ }
  }
  return null;
}

function writeAtomicJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const backup = `${file}.previous-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf-8");
  try {
    fs.renameSync(tmp, file);
  } catch {
    // Windows cannot always replace an existing file with renameSync. Never
    // copy over the live JSON: readers could observe a torn snapshot.
    let movedPrior = false;
    try {
      if (fs.existsSync(file)) {
        fs.renameSync(file, backup);
        movedPrior = true;
      }
      fs.renameSync(tmp, file);
      if (movedPrior) fs.unlinkSync(backup);
    } catch (error) {
      try { if (!fs.existsSync(file) && movedPrior && fs.existsSync(backup)) fs.renameSync(backup, file); } catch { /* preserve original error */ }
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* */ }
      throw error;
    }
  }
}

function writeSnapshot(root: string, snapshot: RunContextSnapshot): void {
  // context-manifest.json is canonical. context-snapshot.json remains byte-for-byte
  // equivalent for older UI and evidence consumers during the migration window.
  writeAtomicJson(manifestPath(root, snapshot.runId), snapshot);
  writeAtomicJson(snapshotPath(root, snapshot.runId), snapshot);
}

export function freezeAgentContext(
  root: string,
  runId: string,
  agent: AgentNodeConfig,
  goal: string,
  baseRolePrompt: string,
  prompt: string,
  out: InjectionContext,
  progressive: ReturnType<typeof buildProgressiveMemoryIndexContext>,
): void {
  const key = cacheKey(root, runId, agent, goal, baseRolePrompt);
  promptCache.set(key, {
    prompt,
    injectedSkillIds: [...out.injectedSkillIds],
    injectedMemoryIds: [...out.injectedMemoryIds],
    injectedMemories: (out.injectedMemories ?? []).map((item) => ({ ...item })),
    memoryPack: out.memoryPack,
    excludedBundledSkillIds: out.excludedBundledSkillIds ? [...out.excludedBundledSkillIds] : undefined,
  });
  trimCache();

  const identity = runIdentity(root, runId, agent);
  const shared = getRunSharedContext(root, runId, agent);
  const prior = readSnapshot(root, runId);
  const agents = { ...(prior?.agents ?? {}) };
  const packItems = (out.memoryPack?.items ?? []).slice(0, 100);
  const failureLessons = packItems
    .filter((item) => item.kind.includes("lesson"))
    .map((item) => `[${item.kind}/${item.memoryId}] ${item.content}`);
  const successExperiences = packItems
    .filter((item) => item.kind === "procedural_skill" || item.kind === "success_experience" || item.kind === "committed")
    .map((item) => `[success_experience/${item.memoryId}] ${item.content}`);
  const skillCapabilities = out.injectedSkillIds.map((id) => `skill:${id}`);
  const batches = progressive.batches.map((batch) =>
    batch.id === "skill_catalog" ? { ...batch, items: skillCapabilities }
      : batch.id === "failure_lessons" ? { ...batch, items: failureLessons }
      : batch.id === "success_experiences" ? { ...batch, items: successExperiences }
      : batch);
  const selectedById = new Map(progressive.selectedMemories.map((memory) => [memory.id, memory]));
  const injectedMemories = out.injectedMemoryIds.map((id) => {
    const selected = selectedById.get(id);
    return {
      id,
      kind: selected?.kind || out.injectedMemories?.find((item) => item.id === id)?.kind || "unknown",
      scope: selected?.scope,
      scopeId: selected?.scopeId,
      version: selected?.version || "legacy-unversioned",
      source: selected?.source || "legacy_fallback",
      sourceType: selected?.sourceType,
      sourceRunId: selected?.sourceRunId,
      modified: selected?.modified,
      confidence: selected?.confidence,
      selectionReason: selected?.selectionReason || "legacy_compatibility_fallback",
    };
  });
  agents[agent.id] = {
    agentId: agent.id,
    role: agent.role,
    teamId: agent.role === "lead" ? agent.id : agent.parentId,
    retrievalMode: progressive.retrievalMode,
    candidateCount: Math.min(100, progressive.candidateCount + (out.memoryPack?.items.length ?? 0)),
    injectedMemoryIds: [...out.injectedMemoryIds],
    injectedMemories,
    injectedSkillIds: [...out.injectedSkillIds],
    batches,
    promptHash: hash(prompt),
    sharedStateHash: progressive.sharedStateHash,
  };
  const sourceVersions: Record<string, string> = { ...(prior?.sourceVersions ?? {}) };
  for (const batch of batches) sourceVersions[`${agent.id}:${batch.id}`] = hash(batch.items.join("\n"));
  const priorSelections = prior?.selections ?? {
    projectConventions: shared.conventionSelections,
    mcpServers: shared.mcpSelections,
    agents: {},
  };
  const skillSelections = [...new Set(out.injectedSkillIds)].map((id) => {
    const skill = getSkill(root, id);
    return {
      id,
      contentHash: skill
        ? hash(JSON.stringify({ title: skill.title, role: skill.role, content: skill.content }))
        : hash(`missing:${id}`),
    };
  });
  const memorySelections = injectedMemories.map((memory) => ({
    id: memory.id,
    contentHash: memory.version,
    scope: memory.scope,
    scopeId: memory.scopeId,
    source: memory.source,
    selectionReason: memory.selectionReason,
  }));
  const selections: ContextManifestSelections = {
    projectConventions: priorSelections.projectConventions ?? shared.conventionSelections,
    mcpServers: priorSelections.mcpServers ?? shared.mcpSelections,
    agents: {
      ...(priorSelections.agents ?? {}),
      [agent.id]: { memories: memorySelections, skills: skillSelections },
    },
  };
  const priorBudgets = prior?.budgets;
  const budgets: ContextManifestBudgets = {
    memoryCandidateLimit: CONTEXT_MEMORY_CANDIDATE_LIMIT,
    memoryItemLimit: Number(process.env.OPC_MAX_MEM_ITEMS) || CONTEXT_MEMORY_ITEM_LIMIT,
    memoryCharLimit: Number(process.env.OPC_MAX_MEM_CHARS) || CONTEXT_MEMORY_CHAR_LIMIT,
    skillItemLimit: Math.max(CONTEXT_SKILL_ITEM_LIMIT, out.injectedSkillIds.length),
    skillCharLimit: CONTEXT_SKILL_CHAR_LIMIT,
    projectConventionFileCharLimit: PROJECT_CONVENTION_FILE_MAX_CHARS,
    projectConventionTotalCharLimit: PROJECT_CONVENTION_TOTAL_MAX_CHARS,
    mcpItemLimit: CONTEXT_MCP_ITEM_LIMIT,
    agentPromptChars: { ...(priorBudgets?.agentPromptChars ?? {}), [agent.id]: prompt.length },
  };
  const body = {
    schemaVersion: "1" as const,
    runId,
    companyId: identity.companyId,
    projectId: identity.projectId,
    goalHash: hash(goal),
    generatedAt: prior?.generatedAt || new Date().toISOString(),
    sharedStateVerifiedAt: prior?.sharedStateVerifiedAt || progressive.sharedStateVerifiedAt,
    sharedStateHash: prior?.sharedStateHash || progressive.sharedStateHash,
    sharedState: prior?.sharedState || progressive.sharedState,
    sourceVersions,
    selections,
    budgets,
    agents,
  };
  const manifestHash = hash(JSON.stringify(body));
  const snapshot: RunContextSnapshot = { ...body, manifestHash, snapshotHash: manifestHash };
  writeSnapshot(root, snapshot);
}

export function clearRunContextCache(root: string, runId: string): void {
  const prefix = `${path.resolve(root)}|${runId}|`;
  for (const key of promptCache.keys()) if (key.startsWith(prefix)) promptCache.delete(key);
  for (const key of runSharedContextCache.keys()) if (key.startsWith(prefix)) runSharedContextCache.delete(key);
}

