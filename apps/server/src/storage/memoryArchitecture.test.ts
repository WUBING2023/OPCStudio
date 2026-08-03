import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { closeAllDbs, openDb } from "./sqlite/db.js";
import { ensureSchema } from "./sqlite/schema.js";
import {
  LAYER_INDEX_MAX_BYTES,
  LAYER_INDEX_MAX_ENTRIES,
  LAYER_INDEX_MAX_LINES,
  layerIndexPath,
  parseLayerIndex,
  readLayerIndex,
  readLayeredMemory,
  rebuildLayeredMemorySearchIndex,
  searchLayeredMemories,
  writeLayeredMemory,
} from "./layeredMemory.js";
import {
  classifyMemoryScope,
  DEFAULT_MEMORY_POLICY,
  decideGovernedMemoryProposal,
  listGovernedMemoryProposals,
  proposeMemory,
} from "../runtime/memoryGovernance.js";
import {
  clearRunResourceValidationCache,
  upsertResourcePointer,
  validateResourcePointer,
} from "../runtime/resourcePointer.js";
import {
  listMemoryCuratorRuns,
  rollbackMemoryCuratorRun,
  runMemoryCurator,
} from "../runtime/memoryCurator.js";
import {
  buildProgressiveMemoryIndexContext,
  clearRunContextCache,
  discoverProjectConventions,
  freezeAgentContext,
  restoreCachedPrompt,
} from "../runtime/contextBroker.js";
import { buildSystemPrompt, type InjectionContext } from "../runtime/contextBuilder.js";
import { runMemoryDoctor } from "../runtime/memoryDoctor.js";

describe("layered Markdown memory architecture", () => {
  const roots: string[] = [];
  const priorBackend = process.env.OPC_STORAGE_BACKEND;

  const root = () => {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), "opc-layered-memory-"));
    roots.push(value);
    return value;
  };

  beforeEach(() => {
    process.env.OPC_STORAGE_BACKEND = "json";
  });

  afterEach(() => {
    closeAllDbs();
    if (priorBackend === undefined) delete process.env.OPC_STORAGE_BACKEND;
    else process.env.OPC_STORAGE_BACKEND = priorBackend;
    for (const value of roots.splice(0)) {
      try { fs.rmSync(value, { recursive: true, force: true }); } catch { /* Windows handle cleanup */ }
    }
  });

  it("writes human-readable topic Markdown plus bounded MEMORY.md index", () => {
    const projectRoot = root();
    const record = writeLayeredMemory(projectRoot, {
      scope: "user",
      scopeId: "u1",
      title: "Output preference",
      summary: "Prefer concise Chinese release reports",
      content: "Use concise Chinese for release reports and keep evidence links.",
      topic: "preferences",
      sourceType: "manual",
      status: "approved",
      confidence: 0.92,
      freshness: { status: "fresh", validatedAt: "2026-07-31T00:00:00.000Z" },
    });

    const index = readLayerIndex(projectRoot, "user", "u1");
    expect(index).toContain("modified:");
    expect(index).toContain(record.memoryId);
    expect(index).toContain(":: Prefer concise Chinese release reports");
    expect(index).not.toContain("keep evidence links");
    expect(index.split(/\r?\n/).length).toBeLessThanOrEqual(LAYER_INDEX_MAX_LINES);
    expect(Buffer.byteLength(index, "utf-8")).toBeLessThanOrEqual(LAYER_INDEX_MAX_BYTES);
    expect(LAYER_INDEX_MAX_ENTRIES).toBe(100);

    const loaded = readLayeredMemory(projectRoot, "user", "u1", record.memoryId);
    expect(loaded?.content).toContain("keep evidence links");
    expect(loaded?.topic).toBe("preferences");
    expect(loaded?.freshness?.status).toBe("fresh");
  });

  it("rebuilds bounded indexes and FTS after a direct Markdown edit", () => {
    process.env.OPC_STORAGE_BACKEND = "sqlite";
    const projectRoot = root();
    const record = writeLayeredMemory(projectRoot, {
      scope: "project", scopeId: "p1", title: "Old title", summary: "old searchable phrase",
      content: "old searchable phrase", topic: "facts", sourceType: "manual",
      status: "approved", confidence: 0.9,
    });
    const entry = parseLayerIndex(projectRoot, "project", "p1")[0];
    const detail = path.resolve(path.dirname(layerIndexPath(projectRoot, "project", "p1")), entry.topicPath);
    const beforeHash = record.contentHash;
    fs.writeFileSync(detail, fs.readFileSync(detail, "utf-8").replace("old searchable phrase", "new direct-edit marker"), "utf-8");

    const rebuilt = rebuildLayeredMemorySearchIndex(projectRoot);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.records).toBe(1);
    const loaded = readLayeredMemory(projectRoot, "project", "p1", record.memoryId);
    expect(loaded?.content).toContain("new direct-edit marker");
    expect(loaded?.contentHash).not.toBe(beforeHash);
    expect(searchLayeredMemories(projectRoot, {
      goal: "direct-edit marker", scopes: [{ scope: "project", scopeId: "p1" }], limit: 100,
    }).map((item) => item.memoryId)).toContain(record.memoryId);
  });
  it("uses SQLite FTS5 without vectors and applies scope isolation", () => {
    process.env.OPC_STORAGE_BACKEND = "sqlite";
    const projectRoot = root();
    writeLayeredMemory(projectRoot, {
      scope: "company", scopeId: "a", title: "Retry policy", summary: "Retry ETIMEDOUT once",
      content: "Retry socket ETIMEDOUT once with jitter.", topic: "policy",
      sourceType: "manual", status: "approved", confidence: 0.9,
    });
    writeLayeredMemory(projectRoot, {
      scope: "company", scopeId: "b", title: "Other secret", summary: "ETIMEDOUT unrelated",
      content: "Company B has a different policy.", topic: "policy",
      sourceType: "manual", status: "approved", confidence: 0.9,
    });

    const hits = searchLayeredMemories(projectRoot, {
      goal: "ETIMEDOUT retry",
      scopes: [{ scope: "company", scopeId: "a" }],
      limit: 100,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].scopeId).toBe("a");
  });

  it('reranks lexical matches with evidence, freshness and confidence without vectors', () => {
    const projectRoot = root();
    const now = new Date().toISOString();
    writeLayeredMemory(projectRoot, {
      memoryId: 'weak',
      scope: 'company', scopeId: 'c1', title: 'Parser retry', summary: 'retry parser',
      content: 'Retry the parser after failure.', topic: 'policy',
      sourceType: 'import', status: 'approved', confidence: 0.2,
      freshness: { status: 'unknown' },
      modified: '2020-01-01T00:00:00.000Z',
    });
    writeLayeredMemory(projectRoot, {
      memoryId: 'strong',
      scope: 'project', scopeId: 'p1', title: 'Parser retry', summary: 'retry parser safely',
      content: 'Retry the parser only after validating the delimiter.', topic: 'policy',
      sourceType: 'run', sourceRunId: 'verified-run', status: 'approved', confidence: 0.95,
      freshness: { status: 'fresh', validatedAt: now },
    });
    const hits = searchLayeredMemories(projectRoot, {
      goal: 'parser retry',
      scopes: [{ scope: 'company', scopeId: 'c1' }, { scope: 'project', scopeId: 'p1' }],
      limit: 10,
    });
    expect(hits.map((item) => item.memoryId)).toEqual(['strong', 'weak']);
  });

  it("classifies natural memory scope and rejects secrets/derivable state", () => {
    const projectRoot = root();
    expect(classifyMemoryScope("My preference is concise output").scope).toBe("user");
    expect(classifyMemoryScope("this project must not use Tailwind").scope).toBe("project");

    const secret = proposeMemory(projectRoot, {
      text: "Please remember api key sk-abcdefghijklmnop for later.",
      scope: "user",
      scopeId: "u1",
      autoApprove: true,
    });
    expect(secret.status).toBe("rejected");
    expect(secret.reasons).toContain("sensitive_content");

    const ephemeral = proposeMemory(projectRoot, {
      text: "current modified files are a.ts and b.ts in tmp/",
      scope: "project",
      scopeId: "p1",
      autoApprove: true,
    });
    expect(ephemeral.status).not.toBe("approved");
    expect(ephemeral.reasons).toContain("derivable_or_ephemeral_state");
  });

  it("accepts an already-redacted credential lesson as a proposal without persisting a secret", () => {
    const projectRoot = root();
    const proposal = proposeMemory(projectRoot, {
      text: "内部备忘:部署密钥 [REDACTED_SECRET] 切勿写进仓库。",
      objectType: "success_experience",
      scope: "company",
      scopeId: "c1",
      sourceType: "import",
      autoApprove: false,
    });
    expect(proposal.status).toBe("proposed");
    expect(proposal.reasons).not.toContain("sensitive_content");
    expect(proposal.content).not.toMatch(/\bsk-[A-Za-z0-9_-]{8,}\b/i);
  });

  it('keeps automatic approval off by default and records complete review audit fields', () => {
    const projectRoot = root();
    const proposal = proposeMemory(projectRoot, {
      text: 'Always place the release conclusion before the evidence appendix.',
      objectType: 'user_preference',
      scope: 'user',
      scopeId: 'local-user',
    });
    expect(proposal.status).toBe('proposed');
    expect(proposal.reviewer).toMatchObject({
      kind: 'deterministic+policy',
      version: 'memory-reviewer-v2',
      evidenceIds: [],
      counterexamples: [],
      rollbackVersion: proposal.inputHash,
    });
    expect(proposal.reviewer.confidence).toBeGreaterThan(0);
  });

  it("fails closed when project, team or agent memory lacks a real scope identity", () => {
    const projectRoot = root();
    for (const scope of ["project", "team", "agent"] as const) {
      const proposal = proposeMemory(projectRoot, {
        text: `Remember this non-obvious reusable constraint for the current ${scope}.`,
        scope,
        autoApprove: true,
      });
      expect(proposal.status).toBe("rejected");
      expect(proposal.reasons).toContain("scope_identity_required");
    }
    expect(listGovernedMemoryProposals(projectRoot)).toHaveLength(0);
  });

  it("keeps failure lessons stricter and supports explicit human approval", () => {
    const projectRoot = root();
    const lesson = proposeMemory(projectRoot, {
      text: "When the parser rejects an empty header, validate the delimiter before retrying.",
      objectType: "failure_lesson",
      scope: "company",
      scopeId: "c1",
      autoApprove: true,
    });
    expect(lesson.status).toBe("proposed");
    expect(lesson.reasons).toContain("failure_lesson_requires_confirmed_root_cause_and_run_evidence");

    const preference = proposeMemory(projectRoot, {
      text: "Always present release summaries in concise Chinese with evidence links.",
      objectType: "user_preference",
      scope: "user",
      scopeId: "u1",
      autoApprove: false,
    });
    const approved = decideGovernedMemoryProposal(projectRoot, preference.proposalId, "approved", "test-human");
    expect(approved?.status).toBe("approved");
    expect(approved?.memoryId).toBeTruthy();
    expect(parseLayerIndex(projectRoot, "user", "u1")).toHaveLength(1);
  });

  it("validates a resource only once per run and revalidates on the next run", async () => {
    const projectRoot = root();
    fs.writeFileSync(path.join(projectRoot, "facts.txt"), "v1");
    const pointer = upsertResourcePointer(projectRoot, {
      scope: "project",
      scopeId: "p1",
      title: "Project facts",
      uri: "facts.txt",
      kind: "file",
      freshnessPolicy: "per_run",
    });
    const first = await validateResourcePointer(projectRoot, "run-00000001", pointer);
    fs.writeFileSync(path.join(projectRoot, "facts.txt"), "v2");
    const cached = await validateResourcePointer(projectRoot, "run-00000001", pointer);
    const nextRun = await validateResourcePointer(projectRoot, "run-00000002", pointer);
    expect(cached.contentHash).toBe(first.contentHash);
    expect(nextRun.contentHash).not.toBe(first.contentHash);
    clearRunResourceValidationCache(projectRoot, "run-00000001");
  });

  it("rejects resource credentials and paths outside projectRoot", async () => {
    const projectRoot = root();
    expect(() => upsertResourcePointer(projectRoot, {
      scope: "project", scopeId: "p1", title: "bad",
      uri: "https://example.com/data?token=secret", kind: "http", freshnessPolicy: "per_run",
    })).toThrow(/credentials/i);

    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outside, "x");
    try {
      const pointer = upsertResourcePointer(projectRoot, {
        scope: "project", scopeId: "p1", title: "outside",
        uri: outside, kind: "file", freshnessPolicy: "per_run",
      });
      const checked = await validateResourcePointer(projectRoot, "run-00000003", pointer);
      expect(checked.ok).toBe(false);
      expect(checked.reason).toMatch(/outside projectRoot/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("curator dry-run is non-destructive and applied dedupe is reversible", async () => {
    const projectRoot = root();
    for (const id of ["a", "b"]) {
      writeLayeredMemory(projectRoot, {
        memoryId: `mem-${id}`,
        scope: "company", scopeId: "c1", title: `Duplicate ${id}`,
        summary: "Same reusable fact", content: "Use the same verified release checklist.",
        topic: "facts", sourceType: "manual", status: "approved", confidence: id === "a" ? 0.9 : 0.8,
      });
    }
    const dryPromise = runMemoryCurator(projectRoot, { scope: "company", scopeId: "c1", dryRun: true, modelMerge: false });
    const sameScopePromise = runMemoryCurator(projectRoot, { scope: "company", scopeId: "c1", dryRun: true, modelMerge: false });
    expect(sameScopePromise).toBe(dryPromise);
    const dry = await dryPromise;
    expect(dry.actions.some((item) => item.kind === "archive_duplicate")).toBe(true);
    expect(parseLayerIndex(projectRoot, "company", "c1")).toHaveLength(2);

    const applied = await runMemoryCurator(projectRoot, { dryRun: false, modelMerge: false });
    expect(parseLayerIndex(projectRoot, "company", "c1")).toHaveLength(1);
    expect(rollbackMemoryCuratorRun(projectRoot, applied.id)?.status).toBe("rolled_back");
    expect(parseLayerIndex(projectRoot, "company", "c1")).toHaveLength(2);
    expect(listMemoryCuratorRuns(projectRoot)[0].status).toBe("rolled_back");
  });

  it('curator model merge lifecycle can only create a review proposal', async () => {
    const projectRoot = root();
    expect(DEFAULT_MEMORY_POLICY).toMatchObject({
      autoApprove: false,
      autoModelMerge: false,
      requireManualForApprovedOverwrite: true,
    });
    const run = await runMemoryCurator(projectRoot, { dryRun: false, modelMerge: false });
    expect(run.createdMemoryIds).toEqual([]);
    expect(run.createdProposalIds).toEqual([]);
    expect(run.actions.every((action) => action.kind !== 'propose_merge' || action.applied === false)).toBe(true);
  });

  it('curator suggests conflict, low-value and derivable cleanup without applying it', async () => {
    const projectRoot = root();
    writeLayeredMemory(projectRoot, {
      memoryId: 'always-policy',
      scope: 'company', scopeId: 'c1', title: 'Release policy', summary: 'Always tag releases',
      content: 'Always create a release tag after verified delivery.', topic: 'release',
      sourceType: 'manual', status: 'approved', confidence: 0.8,
    });
    writeLayeredMemory(projectRoot, {
      memoryId: 'never-policy',
      scope: 'company', scopeId: 'c1', title: 'Release exception', summary: 'Never tag previews',
      content: 'Never create a release tag for preview builds.', topic: 'release',
      sourceType: 'manual', status: 'approved', confidence: 0.8,
    });
    writeLayeredMemory(projectRoot, {
      memoryId: 'derivable-state',
      scope: 'company', scopeId: 'c1', title: 'Current files', summary: 'git status output',
      content: 'Current modified files from git status are a.ts and b.ts.', topic: 'state',
      sourceType: 'manual', status: 'approved', confidence: 0.5,
    });
    const run = await runMemoryCurator(projectRoot, { dryRun: true, modelMerge: false });
    expect(run.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'review_conflict', applied: false }),
      expect.objectContaining({ kind: 'review_derivable', applied: false }),
    ]));
    expect(parseLayerIndex(projectRoot, 'company', 'c1')).toHaveLength(3);
  });

  it("freezes progressive context batches and reuses one prompt snapshot per run/worker", () => {
    const projectRoot = root();
    const runId = "run-00000004";
    fs.mkdirSync(path.join(projectRoot, ".opc", "runs", runId), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".opc", "runs", runId, "task.json"), JSON.stringify({
      id: runId,
      companyId: "c1",
      missionId: "p1",
      status: "running",
      workRoot: projectRoot,
      goal: "build parser",
      expectedArtifacts: ["parser.ts"],
    }));
    writeLayeredMemory(projectRoot, {
      scope: "project", scopeId: "p1", title: "Parser trap",
      summary: "Validate delimiter before parsing", content: "Validate delimiter before parsing.",
      topic: "facts", sourceType: "manual", status: "approved", confidence: 0.9,
    });
    const agent: AgentNodeConfig = {
      id: "dev-1", name: "Dev", role: "dev", companyId: "c1", parentId: "lead-1", childrenIds: [],
      model: "m", provider: "mock", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    };
    const progressive = buildProgressiveMemoryIndexContext(projectRoot, agent, "build parser", runId);
    expect(progressive.batches.map((batch) => batch.id)).toEqual(expect.arrayContaining([
      "control", "identity", "task_contract", "runtime_environment", "permissions",
      "resource_constraints", "project_conventions", "task_graph", "mcp_catalog",
      "skill_catalog", "failure_lessons", "success_experiences",
      "memory_user_index", "memory_company_index", "memory_project_index",
      "memory_team_index", "memory_agent_index",
      "upstream", "user_state", "dynamic_state", "completion",
    ]));
    expect(progressive.candidateCount).toBeLessThanOrEqual(100);
    expect(progressive.text).toContain("Context: task_contract");
    expect(progressive.text).not.toContain("Context: memory_project_index");
    expect(progressive.memoryText).toContain("Context: memory_project_index");
    const batchIds = progressive.batches.map((batch) => batch.id);
    expect(batchIds.indexOf("memory_user_index")).toBeLessThan(batchIds.indexOf("memory_company_index"));
    expect(batchIds.indexOf("memory_company_index")).toBeLessThan(batchIds.indexOf("memory_project_index"));
    expect(batchIds.indexOf("memory_project_index")).toBeLessThan(batchIds.indexOf("memory_team_index"));
    expect(batchIds.indexOf("memory_team_index")).toBeLessThan(batchIds.indexOf("memory_agent_index"));

    const out: InjectionContext = {
      projectRoot, runId, injectedSkillIds: ["skill-a"], injectedMemoryIds: ["mem-a"], injectedMemories: [],
    };
    freezeAgentContext(projectRoot, runId, agent, "build parser", "role", "frozen prompt", out, progressive);
    const otherCompany = { ...agent, companyId: "c2" };
    const isolated: InjectionContext = { projectRoot, runId, injectedSkillIds: [], injectedMemoryIds: [] };
    expect(restoreCachedPrompt(projectRoot, runId, otherCompany, "build parser", "role", isolated)).toBeNull();
    const restored: InjectionContext = {
      projectRoot, runId, injectedSkillIds: [], injectedMemoryIds: [],
    };
    expect(restoreCachedPrompt(projectRoot, runId, agent, "build parser", "role", restored)).toBe("frozen prompt");
    expect(restored.injectedSkillIds).toEqual(["skill-a"]);
    const snapshot = JSON.parse(fs.readFileSync(path.join(projectRoot, ".opc", "runs", runId, "context-snapshot.json"), "utf-8"));
    expect(snapshot.snapshotHash).toMatch(/^sha256:/);
    const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, ".opc", "runs", runId, "context-manifest.json"), "utf-8"));
    expect(manifest).toEqual(snapshot);
    expect(manifest.manifestHash).toBe(manifest.snapshotHash);
    expect(manifest.selections.agents[agent.id].skills).toEqual([
      expect.objectContaining({ id: "skill-a", contentHash: expect.stringMatching(/^sha256:/) }),
    ]);
    expect(manifest.budgets).toMatchObject({
      memoryCandidateLimit: 100,
      memoryItemLimit: 20,
      memoryCharLimit: 8_000,
      projectConventionFileCharLimit: 4_000,
      projectConventionTotalCharLimit: 12_000,
      mcpItemLimit: 20,
    });
    expect(snapshot.agents[agent.id].candidateCount).toBeLessThanOrEqual(100);
    expect(snapshot.sourceVersions[`${agent.id}:control`]).toMatch(/^sha256:/);
    clearRunContextCache(projectRoot, runId);
  });

  it("reads CRLF frontmatter written by Windows editors", () => {
    const projectRoot = root();
    const record = writeLayeredMemory(projectRoot, {
      scope: "project", scopeId: "p-crlf", title: "Windows memory",
      summary: "CRLF remains readable", content: "Keep CRLF memory readable.",
      topic: "facts", sourceType: "manual", status: "approved", confidence: 0.9,
    });
    const entry = parseLayerIndex(projectRoot, "project", "p-crlf")[0];
    const detail = path.resolve(path.dirname(layerIndexPath(projectRoot, "project", "p-crlf")), entry.topicPath);
    fs.writeFileSync(detail, fs.readFileSync(detail, "utf-8").replace(/\r?\n/g, "\r\n"), "utf-8");
    expect(readLayeredMemory(projectRoot, "project", "p-crlf", record.memoryId)?.content)
      .toBe("Keep CRLF memory readable.");
  });

  it("excludes stale and expired approved memories from retrieval", () => {
    const projectRoot = root();
    writeLayeredMemory(projectRoot, {
      scope: "company", scopeId: "c1", title: "Expired retry",
      summary: "obsolete retry instruction", content: "obsolete retry instruction",
      topic: "policy", sourceType: "manual", status: "approved", confidence: 0.9,
      freshness: { status: "fresh", expiresAt: "2020-01-01T00:00:00.000Z" },
    });
    const fresh = writeLayeredMemory(projectRoot, {
      scope: "company", scopeId: "c1", title: "Current retry",
      summary: "current retry instruction", content: "current retry instruction",
      topic: "policy", sourceType: "manual", status: "approved", confidence: 0.9,
      freshness: { status: "fresh", expiresAt: "2099-01-01T00:00:00.000Z" },
    });
    const hits = searchLayeredMemories(projectRoot, {
      goal: "retry instruction", scopes: [{ scope: "company", scopeId: "c1" }],
    });
    expect(hits.map((item) => item.memoryId)).toEqual([fresh.memoryId]);
  });

  it("keeps Markdown and SQLite unchanged when the database transaction rejects an update", () => {
    process.env.OPC_STORAGE_BACKEND = "sqlite";
    const projectRoot = root();
    const original = writeLayeredMemory(projectRoot, {
      memoryId: "mem-transaction-test",
      scope: "project", scopeId: "p1", title: "Stable value",
      summary: "old value", content: "old value", topic: "facts",
      sourceType: "manual", status: "approved", confidence: 0.9,
    });
    const db = openDb(projectRoot);
    ensureSchema(db);
    db.exec("CREATE TRIGGER reject_layered_update BEFORE UPDATE ON layered_memories BEGIN SELECT RAISE(ABORT, 'forced rollback'); END");
    expect(() => writeLayeredMemory(projectRoot, {
      memoryId: original.memoryId,
      scope: "project", scopeId: "p1", title: "Changed value",
      summary: "new value", content: "new value", topic: "facts",
      sourceType: "manual", status: "approved", confidence: 0.9,
    })).toThrow(/forced rollback/);
    expect(readLayeredMemory(projectRoot, "project", "p1", original.memoryId)?.content).toBe("old value");
    expect(parseLayerIndex(projectRoot, "project", "p1")).toHaveLength(1);
  });

  it("loads path-scoped project conventions only up to the nearest Git root", () => {
    const container = root();
    const repo = path.join(container, "repo");
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(container, "AGENTS.md"), "outside rule", "utf-8");
    fs.writeFileSync(path.join(repo, "AGENTS.md"), "repository rule", "utf-8");
    fs.writeFileSync(path.join(nested, "CLAUDE.md"), "nested rule", "utf-8");
    const conventions = discoverProjectConventions(nested);
    expect(conventions.map((item) => item.content)).toEqual(["repository rule", "nested rule"]);
    expect(conventions.map((item) => item.relativePath)).toEqual(["AGENTS.md", "packages/app/CLAUDE.md"]);
  });

  it("injects selected layered detail once and records its exact identity", () => {
    const projectRoot = root();
    const runId = "run-layered-prompt";
    fs.mkdirSync(path.join(projectRoot, ".opc", "runs", runId), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, ".opc", "runs", runId, "task.json"), JSON.stringify({
      id: runId, companyId: "c1", missionId: "p1", status: "running",
      workRoot: projectRoot, goal: "build parser",
    }));
    const memory = writeLayeredMemory(projectRoot, {
      scope: "project", scopeId: "p1", title: "Delimiter rule",
      summary: "Validate delimiter before parsing",
      content: "Validate the delimiter before parsing an empty header.",
      topic: "facts", sourceType: "manual", status: "approved", confidence: 0.95,
    });
    const agent: AgentNodeConfig = {
      id: "dev-layered", name: "Dev", role: "dev", companyId: "c1",
      parentId: "lead-1", childrenIds: [], model: "m", provider: "mock", status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    };
    const out: InjectionContext = {
      projectRoot, runId, injectedSkillIds: [], injectedMemoryIds: [], injectedMemories: [],
    };
    const prompt = buildSystemPrompt(agent, "role", "parser delimiter", projectRoot, out);
    expect(prompt).toContain("Validate the delimiter before parsing an empty header.");
    expect(prompt.split(memory.memoryId)).toHaveLength(2);
    expect(out.injectedMemoryIds).toEqual([memory.memoryId]);
    expect(out.injectedMemories).toEqual([expect.objectContaining({
      id: memory.memoryId, kind: "layered_project", title: "Delimiter rule",
    })]);
    const snapshot = JSON.parse(fs.readFileSync(path.join(projectRoot, ".opc", "runs", runId, "context-snapshot.json"), "utf-8"));
    expect(snapshot.agents[agent.id].injectedMemoryIds).toEqual([memory.memoryId]);
    expect(snapshot.agents[agent.id]).toMatchObject({
      retrievalMode: "layered",
      injectedMemories: [expect.objectContaining({
        id: memory.memoryId,
        scope: "project",
        scopeId: "p1",
        version: memory.contentHash,
        source: "layered",
        sourceType: "manual",
        selectionReason: "approved_fresh_scope_and_query_match",
      })],
    });
    expect(snapshot.selections.agents[agent.id].memories).toEqual([
      expect.objectContaining({
        id: memory.memoryId,
        contentHash: memory.contentHash,
        scope: "project",
        scopeId: "p1",
        selectionReason: "approved_fresh_scope_and_query_match",
      }),
    ]);
  });

  it("freezes project dynamic state once and reuses its hash for every worker in a run", () => {
    const projectRoot = root();
    const runId = "run-shared-state";
    fs.mkdirSync(path.join(projectRoot, ".git"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".opc", "runs", runId), { recursive: true });
    const taskFile = path.join(projectRoot, ".opc", "runs", runId, "task.json");
    fs.writeFileSync(taskFile, JSON.stringify({
      id: runId, companyId: "c1", missionId: "p1", status: "running",
      workRoot: projectRoot, goal: "shared state",
    }));
    fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "first frozen convention", "utf-8");
    const agent = (id: string): AgentNodeConfig => ({
      id, name: id, role: "dev", companyId: "c1", parentId: "lead-1", childrenIds: [],
      model: "m", provider: "mock", status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    });

    const first = buildProgressiveMemoryIndexContext(projectRoot, agent("dev-1"), "shared state", runId);
    fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), "later mutable convention", "utf-8");
    fs.writeFileSync(taskFile, JSON.stringify({
      id: runId, companyId: "c1", missionId: "p1", status: "failed",
      workRoot: projectRoot, goal: "shared state",
    }));
    const second = buildProgressiveMemoryIndexContext(projectRoot, agent("dev-2"), "different worker subtask", runId);

    expect(second.sharedStateHash).toBe(first.sharedStateHash);
    expect(second.sharedStateVerifiedAt).toBe(first.sharedStateVerifiedAt);
    expect(second.text).toContain("first frozen convention");
    expect(second.text).not.toContain("later mutable convention");
    expect(second.batches.find((batch) => batch.id === "dynamic_state")?.items.join("\n"))
      .toContain("runStatus=running");

    for (const [worker, progressive] of [[agent("dev-1"), first], [agent("dev-2"), second]] as const) {
      freezeAgentContext(projectRoot, runId, worker, "shared state", "role", `prompt-${worker.id}`, {
        projectRoot, runId, injectedSkillIds: [], injectedMemoryIds: [], injectedMemories: [],
      }, progressive);
    }
    const snapshot = JSON.parse(fs.readFileSync(path.join(projectRoot, ".opc", "runs", runId, "context-snapshot.json"), "utf-8"));
    expect(snapshot.sharedStateHash).toBe(first.sharedStateHash);
    expect(snapshot.agents["dev-1"].sharedStateHash).toBe(first.sharedStateHash);
    expect(snapshot.agents["dev-2"].sharedStateHash).toBe(first.sharedStateHash);
    clearRunContextCache(projectRoot, runId);
  });

  it("reports searchable, scoped memory and prompt budgets through Memory Doctor", () => {
    const projectRoot = root();
    const memory = writeLayeredMemory(projectRoot, {
      scope: "company", scopeId: "c1", title: "Release evidence",
      summary: "Always include evidence links", content: "Always include evidence links in release reports.",
      topic: "policy", sourceType: "manual", status: "approved", confidence: 0.9,
    });
    const report = runMemoryDoctor(projectRoot, {
      goal: "release evidence",
      scopes: [{ scope: "company", scopeId: "c1" }],
    });
    expect(report.status).toBe("ok");
    expect(report.selectedMemoryIds).toEqual([memory.memoryId]);
    expect(report.promptPolicy).toMatchObject({
      maxCandidates: 100, maxInjectedItems: 20, maxInjectedChars: 8_000,
    });
    expect(report.projectConventions).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: "AGENTS.md", status: "skipped", reason: "not_found" }),
    ]));
  });
});
