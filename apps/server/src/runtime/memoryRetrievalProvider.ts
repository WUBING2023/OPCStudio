import { createHash } from "node:crypto";
import { goalToSlug, queryMemory } from "../storage/memoryStore.js";
import { retrieveLessons } from "../storage/reflectionStore.js";
import {
  loadRegistry,
  retrieveConclusionPoints,
  retrieveSuccessExperiences,
  type ConclusionSummary,
  type MemoryRecord,
} from "../storage/registryStore.js";
import {
  searchLayeredMemories,
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import {
  readAgentMemory,
  readCompanyMd,
  readProjectMd,
  readTeamMd,
  readUserMd,
} from "../storage/mdMemory.js";
import { retrieveCommittedMemories } from "./committedMemoryRetriever.js";
import { classifyTaskType } from "./runCritic.js";

export interface PromptMemoryRecord {
  id: string;
  kind: string;
  title: string;
  summary: string;
  content: string;
  scope?: LayeredMemoryScope;
  scopeId?: string;
  modified?: string;
  version?: string;
  sourceType?: string;
  sourceRunId?: string;
  confidence?: number;
  selectionReason?: string;
  source: "layered" | "legacy_fallback";
}

export interface PromptMemoryRetrieval {
  mode: "layered" | "legacy_fallback" | "empty";
  candidates: PromptMemoryRecord[];
}

export interface PromptMemoryQuery {
  goal: string;
  runId: string;
  companyId: string;
  teamId?: string;
  agentId: string;
  role: string;
  scopes: Array<{ scope: LayeredMemoryScope; scopeId: string }>;
  limit?: number;
}

const compact = (value: string, max = 600) => value.replace(/\s+/g, " ").trim().slice(0, max);
const normalized = (value: string) => value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
const contentVersion = (value: string) =>
  `sha256:${createHash("sha256").update(value, "utf-8").digest("hex")}`;

function dedupe(items: PromptMemoryRecord[], limit: number): PromptMemoryRecord[] {
  const ids = new Set<string>();
  const contents = new Set<string>();
  const out: PromptMemoryRecord[] = [];
  for (const item of items) {
    const contentKey = normalized(item.content);
    if (!item.id || ids.has(item.id) || (contentKey && contents.has(contentKey))) continue;
    ids.add(item.id);
    if (contentKey) contents.add(contentKey);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

export function retrievePromptMemories(root: string, query: PromptMemoryQuery): PromptMemoryRetrieval {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 100);
  const layered = searchLayeredMemories(root, {
    goal: query.goal,
    scopes: query.scopes,
    limit,
  }).map((item): PromptMemoryRecord => ({
    id: item.memoryId,
    kind: `layered_${item.scope}`,
    title: item.title,
    summary: item.summary,
    content: item.content,
    scope: item.scope,
    scopeId: item.scopeId,
    modified: item.modified,
    version: item.contentHash,
    sourceType: item.sourceType,
    sourceRunId: item.sourceRunId,
    confidence: item.confidence,
    selectionReason: "approved_fresh_scope_and_query_match",
    source: "layered",
  }));
  if (layered.length) return { mode: "layered", candidates: dedupe(layered, limit) };

  const fallback: PromptMemoryRecord[] = [];
  const scopedMarkdown: Array<{
    id: string;
    kind: string;
    title: string;
    scope: LayeredMemoryScope;
    scopeId: string;
    content: string;
  }> = [];
  const scopeId = (scope: LayeredMemoryScope) =>
    query.scopes.find((item) => item.scope === scope)?.scopeId;
  const userId = scopeId("user");
  const projectId = scopeId("project");
  if (userId) {
    scopedMarkdown.push({
      id: `legacy-md-user-${userId}`,
      kind: "md_user",
      title: "User memory",
      scope: "user",
      scopeId: userId,
      content: readUserMd(root, userId),
    });
  }
  scopedMarkdown.push({
    id: `legacy-md-company-${query.companyId}`,
    kind: "md_company",
    title: "Company memory",
    scope: "company",
    scopeId: query.companyId,
    content: readCompanyMd(root, query.companyId),
  });
  if (projectId) {
    scopedMarkdown.push({
      id: `legacy-md-project-${projectId}`,
      kind: "md_project",
      title: "Project memory",
      scope: "project",
      scopeId: projectId,
      content: readProjectMd(root, projectId),
    });
  }
  if (query.teamId) {
    scopedMarkdown.push({
      id: `legacy-md-team-${query.teamId}`,
      kind: "md_team",
      title: "Team memory",
      scope: "team",
      scopeId: query.teamId,
      content: readTeamMd(root, query.teamId),
    });
  }
  scopedMarkdown.push({
    id: `legacy-md-agent-${query.agentId}`,
    kind: "md_agent",
    title: "Agent memory",
    scope: "agent",
    scopeId: query.agentId,
    content: readAgentMemory(root, query.agentId),
  });
  for (const item of scopedMarkdown) {
    if (!item.content.trim()) continue;
    fallback.push({
      ...item,
      summary: compact(item.content, 180),
      content: item.content.slice(0, 4_000),
      version: contentVersion(item.content),
      selectionReason: "legacy_scoped_markdown_compatibility",
      source: "legacy_fallback",
    });
  }

  for (const item of queryMemory(root, {
    agentRole: query.role,
    companyId: query.companyId,
    goal: query.goal,
    limit: 5,
  })) {
    fallback.push({
      id: item.id,
      kind: "memory_entry",
      title: compact(item.text, 80),
      summary: compact(item.text, 180),
      content: compact(item.text),
      source: "legacy_fallback",
    });
  }

  try {
    for (const item of retrieveLessons(root, {
      role: query.role,
      agentId: query.agentId,
      teamId: query.teamId,
      companyId: query.companyId,
      taskType: classifyTaskType(query.goal),
      limit: 3,
      bumpHits: true,
    })) {
      fallback.push({
        id: item.id,
        kind: "lesson",
        title: compact(item.injection.promptText, 80),
        summary: compact(item.injection.promptText, 180),
        content: compact(item.injection.promptText),
        source: "legacy_fallback",
      });
    }
  } catch { /* legacy fallback must not block the run */ }

  let registry: MemoryRecord[] = [];
  try { registry = loadRegistry(root); } catch { /* empty legacy registry */ }
  try {
    const points = retrieveConclusionPoints(root, {
      companyId: query.companyId,
      goalSlug: goalToSlug(query.goal),
      goal: query.goal,
      limit: 2,
      minScore: 1,
      preloaded: registry,
    });
    const records = registry.filter((record): record is MemoryRecord & ConclusionSummary =>
      (record as { kind?: unknown }).kind === "conclusion"
      && Array.isArray((record as { points?: unknown }).points));
    const used = new Set<string>();
    for (const point of points) {
      const record = records.find((item) => !used.has(item.id) && item.points.includes(point));
      if (record) used.add(record.id);
      fallback.push({
        id: record?.id ?? `conclusion-${goalToSlug(query.goal)}-${fallback.length}`,
        kind: "conclusion",
        title: compact(point, 80),
        summary: compact(point, 180),
        content: compact(point),
        source: "legacy_fallback",
      });
    }
  } catch { /* empty conclusion fallback */ }

  try {
    const experience = retrieveSuccessExperiences(root, {
      role: query.role,
      companyId: query.companyId,
      taskType: classifyTaskType(query.goal),
      limit: 1,
      preloaded: registry,
    })[0];
    if (experience?.successfulSequence.length >= 2) {
      const content = experience.successfulSequence.slice(0, 12).join(" -> ");
      fallback.push({
        id: experience.id,
        kind: "success_experience",
        title: "Reusable success experience",
        summary: compact(content, 180),
        content: compact(content),
        source: "legacy_fallback",
      });
    }
  } catch { /* empty success fallback */ }

  try {
    for (const item of retrieveCommittedMemories(
      root,
      query.goal,
      query.runId,
      800,
      query.role,
      undefined,
      { taskType: classifyTaskType(query.goal), companyId: query.companyId },
    )) {
      fallback.push({
        id: item.memoryId,
        kind: "committed",
        title: compact(item.content, 80),
        summary: compact(item.content, 180),
        content: compact(item.content),
        source: "legacy_fallback",
      });
    }
  } catch { /* empty committed fallback */ }

  const candidates = dedupe(fallback, Math.min(limit, 20));
  return { mode: candidates.length ? "legacy_fallback" : "empty", candidates };
}
