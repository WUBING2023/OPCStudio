import type { Express } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import { listMemory, queryMemory, deleteMemory } from "../storage/memoryStore.js";
import { loadReuseStats } from "../storage/memoryReuseStore.js";
import { listAllCommittedMemories, isFromExcludedRun } from "../runtime/committedMemoryRetriever.js";
import { loadLessons, revokeLesson, approveLesson, rejectLesson, bindLessonToAgent } from "../storage/reflectionStore.js";
import { loadMemoryProposals, upsertMemoryProposals, appendCommittedMemory, loadRunEventsRaw, loadRunTask, type RunMemoryProposalRecord } from "../storage/projectStore.js";
import { listSkills } from "../storage/skillStore.js";
import { MemoryLedger, type MemoryScope, type ProposalStatus } from "../runtime/memoryCommit.js";
import {
  loadRegistry, isReviewModeEnabled, setReviewMode,
  isRunConclusionAutoCommitEnabled, setRunConclusionAutoCommit,
  listConclusionProposals, approveConclusionSummary, rejectConclusionSummary,
  approveProceduralSkill, rejectProceduralSkill,
} from "../storage/registryStore.js";
import { backfillLessons } from "../runtime/backfill.js";
import { resolveProviderKey } from "../runtime/providerRegistry.js";
import { getAgents } from "../runtime/orchestrator.js";
import { deepseekChat } from "../runtime/runCritic.js";
import { buildMemoryPack, buildMemorySummary, deriveRunMemoryPackUsage, GENERIC_GOAL } from "../runtime/memoryPack.js";
import { getCompany, loadCompanies } from "../storage/companyStore.js";
import { sanitizeMemoryText } from "../security/memorySanitizer.js";
import { runExists } from "./runRoutes.js";
import {
  loadMemoryPolicy,
  saveMemoryPolicy,
  proposeMemoryWithReview,
  listGovernedMemoryProposals,
  decideGovernedMemoryProposal,
  type MemoryObjectType,
} from "../runtime/memoryGovernance.js";
import {
  readLayerIndex,
  readLayeredMemory,
  searchLayeredMemories,
  rebuildLayeredMemorySearchIndex,
  type LayeredMemoryScope,
} from "../storage/layeredMemory.js";
import {
  runMemoryCurator,
  listMemoryCuratorRuns,
  rollbackMemoryCuratorRun,
  markMemoryActivity,
} from "../runtime/memoryCurator.js";
import {
  upsertResourcePointer,
  listResourcePointers,
  validateResourcePointer,
  type ResourcePointerKind,
} from "../runtime/resourcePointer.js";
import { runMemoryDoctor } from "../runtime/memoryDoctor.js";
import {
  auditLegacyMemoryMigration,
  migrateLegacyMemoryToLayeredProposals,
} from "../runtime/memoryMigration.js";

// 同 runRoutes.ts 的 SAFE_RUN_ID:runId 必须是安全 token(防 ..%2F 路径穿越读到 projectRoot 外的文件)。
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;
// proposalId / lesson id 同口径(prop-xxxx / lesson-xxxx)。
const SAFE_PROPOSAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface PendingRunMemoryProposal {
  runId: string;
  proposalId: string;
  companyId: string;
  kind: string;
  content: string;
  risk: "low" | "high";
  status: "pending";
  source: RunMemoryProposalRecord["source"];
  createdAt: string;
  updatedAt: string;
  reviewPriority: "key" | "background";
  reviewReason: "verified_high_risk_conclusion" | "repeated_lesson" | "substantive_risk" | "background_candidate";
  support?: number;
}

export function classifyPendingMemoryReview(
  proposal: RunMemoryProposalRecord,
  task: { status?: string; deliveryAcceptance?: { status?: string } } | null,
  lessonSupport = 0,
): Pick<PendingRunMemoryProposal, "reviewPriority" | "reviewReason" | "support"> {
  const support = Math.max(0, Number.isFinite(lessonSupport) ? lessonSupport : 0);
  if (proposal.source === "run_conclusion") {
    const cleanTerminal = task?.status === "done";
    if (proposal.risk === "high" && cleanTerminal) {
      return { reviewPriority: "key", reviewReason: "verified_high_risk_conclusion" };
    }
    return { reviewPriority: "background", reviewReason: "background_candidate" };
  }

  const reasons = proposal.riskReasons ?? [];
  const substantiveRisk = proposal.risk === "high"
    && (proposal.kind === "policy_candidate" || reasons.includes("content_keyword"))
    && !reasons.includes("system_failure_mode");
  if (substantiveRisk) return { reviewPriority: "key", reviewReason: "substantive_risk", support };
  if (support >= 2) return { reviewPriority: "key", reviewReason: "repeated_lesson", support };
  return { reviewPriority: "background", reviewReason: "background_candidate", support };
}

// Run proposals are stored per run, so company ownership comes from task.json
// instead of a client-supplied or proposal-only field.
export function listPendingRunMemoryProposals(projectRoot: string, companyId?: string): PendingRunMemoryProposal[] {
  const runsDir = path.join(projectRoot, ".opc", "runs");
  if (!fs.existsSync(runsDir)) return [];

  const result: PendingRunMemoryProposal[] = [];
  const lessonsById = new Map(loadLessons(projectRoot).map((lesson) => [lesson.id, lesson]));
  for (const entry of fs.readdirSync(runsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_RUN_ID.test(entry.name)) continue;
    const task = loadRunTask(projectRoot, entry.name);
    if (!task) continue;
    if (companyId && task.companyId !== companyId) continue;

    for (const proposal of loadMemoryProposals(projectRoot, entry.name)) {
      if (proposal.status !== "pending" || proposal.runId !== entry.name) continue;
      const proposalCompanyId = (proposal as RunMemoryProposalRecord & { companyId?: string }).companyId;
      if (companyId && proposalCompanyId && proposalCompanyId !== companyId) continue;
      const authoritativeLesson = proposal.source === "reflection_lesson" ? lessonsById.get(proposal.proposalId) : undefined;
      if (authoritativeLesson && authoritativeLesson.status !== "proposed") continue;
      const triage = classifyPendingMemoryReview(proposal, task, authoritativeLesson?.support ?? 0);
      result.push({
        runId: entry.name,
        proposalId: proposal.proposalId,
        companyId: task.companyId || proposalCompanyId || "",
        kind: proposal.kind ?? proposal.type ?? proposal.source,
        content: proposal.content,
        risk: proposal.risk,
        status: "pending",
        source: proposal.source,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
        ...triage,
      });
    }
  }

  const sorted = result.sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
    || b.createdAt.localeCompare(a.createdAt)
    || a.runId.localeCompare(b.runId)
    || a.proposalId.localeCompare(b.proposalId));
  const seen = new Set<string>();
  return sorted.filter((proposal) => {
    const key = `${proposal.source}:${proposal.proposalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A1-V2 · run 级记忆提案人工审批核心(路由是薄壳;导出以便单测直接驱动)。
// approve:pending → approved → committed(MemoryLedger 完整走账)+ committed-memories.json 追加入库
// (committedMemoryRetriever 跨 run 检索即刻可见)+ 回写 memory_proposals.json 台账。
// lesson 提案的正主在 lessons.jsonl → 转交 reflectionStore.approveLesson(它会自己回写台账)。
export function approveRunMemoryProposal(projectRoot: string, runId: string, proposalId: string, approvedBy: string, nowIso: string): RunMemoryProposalRecord | null {
  const rec = loadMemoryProposals(projectRoot, runId).find((r) => r.proposalId === proposalId);
  if (!rec || rec.status !== "pending") return null;
  if (rec.source === "reflection_lesson") {
    const l = approveLesson(projectRoot, proposalId, approvedBy, nowIso);
    if (!l) return null;
    return loadMemoryProposals(projectRoot, runId).find((r) => r.proposalId === proposalId) ?? null;
  }
  const ledger = new MemoryLedger();
  ledger.add({
    proposalId: rec.proposalId,
    runId,
    scope: (rec.scope as MemoryScope) ?? "project",
    type: rec.type ?? "run_conclusion",
    content: rec.content,
    sourceArtifactRefs: rec.sourceArtifactRefs ?? [], // D2:透传台账里的真实 artifact id(不再硬编码 [])
    proposedBy: rec.proposedBy ?? "orchestrator",
    agentId: rec.agentId,
    // C12-P0:透传台账里的公司归属 → commitProposal 写进 committed-memories.json,人工审批路径也保持公司硬隔离。
    // 台账 companyId 由 orchestrator 以加性 JSON 字段落盘(RunMemoryProposalRecord 未显式声明,读侧按可选读取)。
    companyId: (rec as { companyId?: string }).companyId,
    role: rec.role,
    taskType: rec.taskType, // D2:透传 taskType → committed-memories.json 供检索侧匹配
    confidence: rec.confidence ?? 0.65,
    tags: rec.tags ?? [],
    status: "pending",
    risk: rec.risk,
    statusHistory: rec.statusHistory as Array<{ status: ProposalStatus; at?: string; by?: string }>,
  });
  ledger.approve(rec.proposalId, approvedBy, nowIso);
  const committed = ledger.commit(rec.proposalId, approvedBy, nowIso, rec.memoryId ?? `mem-${runId.slice(0, 8)}`);
  appendCommittedMemory(projectRoot, runId, committed);
  const updated: RunMemoryProposalRecord = {
    ...rec,
    status: "committed",
    memoryId: committed.memoryId,
    updatedAt: nowIso,
    statusHistory: [...(rec.statusHistory ?? []), { status: "approved", at: nowIso, by: approvedBy }, { status: "committed", at: nowIso, by: approvedBy }],
  };
  upsertMemoryProposals(projectRoot, runId, [updated]);
  return updated;
}

// reject:pending → rejected(台账终态,不入库);lesson 提案转交 rejectLesson(落 revoked 终态,不复活)。
export function rejectRunMemoryProposal(projectRoot: string, runId: string, proposalId: string, rejectedBy: string, nowIso: string): RunMemoryProposalRecord | null {
  const rec = loadMemoryProposals(projectRoot, runId).find((r) => r.proposalId === proposalId);
  if (!rec || rec.status !== "pending") return null;
  if (rec.source === "reflection_lesson") {
    const l = rejectLesson(projectRoot, proposalId, rejectedBy, nowIso);
    if (!l) return null;
    return loadMemoryProposals(projectRoot, runId).find((r) => r.proposalId === proposalId) ?? null;
  }
  const updated: RunMemoryProposalRecord = {
    ...rec,
    status: "rejected",
    updatedAt: nowIso,
    statusHistory: [...(rec.statusHistory ?? []), { status: "rejected", at: nowIso, by: rejectedBy }],
  };
  upsertMemoryProposals(projectRoot, runId, [updated]);
  return updated;
}

// ── GET /api/memory/layers · 记忆层级真实注入资格(只读聚合)──────────────────────────
// 诉求:让用户看得出「哪一层记忆真的会进 prompt」。eligibleForPrompt 是 contextBuilder.buildSystemPrompt
// 的注入事实(不是猜测):company/team/project/agent md、skill、历史经验、失败教训(仅 committed)、
// 结论要点(pending/rejected 除外)、推荐工作流(verified 且序列≥2)会被检索注入;plan_template 与跨 run
// committed 记忆 contextBuilder 从不检索(retrieveCommittedMemories 只被 memoryPack 审计投影调用),故 false。
// 纯计数+静态资格,不重跑检索/打分/LLM;任一 store 报错只降级那一层,绝不整体抛。
export interface MemoryLayerStat {
  key: string;
  count: number;          // 该 store 现有条目总数
  eligibleCount: number;  // 其中当前真正满足注入门槛的条数(不满足门槛的层为 0)
  eligibleForPrompt: boolean; // 该层是否会被 contextBuilder 检索注入(层级事实,与内容多少无关)
  // C12-P0 · 无归属(无 companyId)条目数:公司硬隔离下这些旧记录**停止注入**(缺省拒),但不删除,
  // 记忆页据此标 "unattributed" 供用户手动归属。仅公司隔离生效的层(memory_entry/committed)返回该计数。
  unattributedCount?: number;
}
export interface MemoryLayersResult {
  layers: MemoryLayerStat[];
  lastContextBuild: { runId: string; at: string } | null; // best-effort:记忆系统最近一次参与某 run 的上下文构建
  generatedAt: string;
}

function countMdFiles(root: string): { company: number; team: number; project: number; agent: number } {
  const res = { company: 0, team: 0, project: 0, agent: 0 };
  try {
    const kd = path.join(root, ".opc", "knowledge");
    if (fs.existsSync(path.join(kd, "company.md"))) res.company = 1;
    const countDir = (sub: string) => {
      const dir = path.join(kd, sub);
      if (!fs.existsSync(dir)) return 0;
      try { return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).length; } catch { return 0; }
    };
    res.team = countDir("teams");
    res.project = countDir("projects");
    res.agent = countDir("agents");
  } catch { /* degrade */ }
  return res;
}

// best-effort:扫最近(mtime 倒序)最多 15 个 run 目录,取第一个含 memory_pack_used 事件的 run 及其最新时间戳。
// memory_pack_used 是 contextBuilder 每次为某 agent 装配记忆上下文时 emit 的事件——是「记忆系统参与上下文构建」
// 的诚实信号(注:它是整包信号,非某一层的注入信号;逐层最近注入时间当前事件里没有可靠来源,不臆造)。
function findLastContextBuild(root: string): { runId: string; at: string } | null {
  try {
    const runsDir = path.join(root, ".opc", "runs");
    if (!fs.existsSync(runsDir)) return null;
    const dirs = fs.readdirSync(runsDir)
      .map((d) => { let m = 0; try { m = fs.statSync(path.join(runsDir, d)).mtimeMs; } catch { /* skip */ } return { d, m }; })
      .sort((a, b) => b.m - a.m)
      .slice(0, 15)
      .map((x) => x.d);
    for (const d of dirs) {
      const raw = loadRunEventsRaw(root, d);
      if (!raw) continue;
      let best: string | null = null;
      for (const line of raw.split("\n")) {
        if (!line.includes("memory_pack_used")) continue;
        let ev: any;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev?.type === "info" && ev?.payload?.kind === "memory_pack_used" && typeof ev.timestamp === "string") {
          if (!best || ev.timestamp > best) best = ev.timestamp;
        }
      }
      if (best) return { runId: d, at: best };
    }
    return null;
  } catch { return null; }
}

export function buildMemoryLayers(root: string): MemoryLayersResult {
  const layers: MemoryLayerStat[] = [];
  const push = (key: string, count: number, eligibleCount: number, eligibleForPrompt: boolean, unattributedCount?: number) =>
    layers.push({ key, count, eligibleCount, eligibleForPrompt, ...(unattributedCount !== undefined ? { unattributedCount } : {}) });

  const md = countMdFiles(root);
  push("md_company", md.company, md.company, true);
  push("md_team", md.team, md.team, true);
  push("md_project", md.project, md.project, true);
  push("md_agent", md.agent, md.agent, true);

  // skill:enabled 且 origin!=="memory" 才是 contextBuilder 的注入池(注入时再按角色过滤、上限 3;此处给全局池计数)。
  let skillCount = 0;
  try { skillCount = listSkills(root).filter((s) => s.enabled && (s.origin ?? "user") !== "memory").length; } catch { /* degrade */ }
  push("skill", skillCount, skillCount, true);

  // memory_entry:memoryStore(D 层清理后只剩 project 层),queryMemory 命中即注入。
  // C12-P0:公司硬隔离下,无 companyId 的旧条目对有公司归属的 agent 不再注入 → 标 unattributed(不删,供手动归属)。
  let memCount = 0, memUnattributed = 0;
  try { for (const m of listMemory(root)) { memCount++; if (!(m as { companyId?: string }).companyId) memUnattributed++; } } catch { /* degrade */ }
  push("memory_entry", memCount, memCount, true, memUnattributed);

  // 失败教训:全量 vs 仅 committed 可注入(proposed/revoked/superseded 不进 prompt,见 reflectionStore.retrieveLessons)。
  // 令二.3:无公司归属(legacy)的历史教训对有公司归属的 agent 硬隔离不注入 → 标 unattributed(不删,供手动归属)。
  let lessonTotal = 0, lessonEligible = 0, lessonUnattributed = 0;
  try { for (const l of loadLessons(root)) { lessonTotal++; if (l.status === "committed") lessonEligible++; if (!l.scope.companyId) lessonUnattributed++; } } catch { /* degrade */ }
  push("lesson", lessonTotal, lessonEligible, true, lessonUnattributed);

  // registry:结论要点(pending/rejected 不注入)/ 推荐工作流(verified 且序列≥2)/ 计划模板(contextBuilder 从不检索)。
  // 令二.3/令二.5:conclusion/procedural_skill 无 companyId 的 legacy 记录同样标 unattributed(硬隔离不注入,可手动归属)。
  let conclusionTotal = 0, conclusionEligible = 0, conclusionUnattributed = 0, procTotal = 0, procEligible = 0, procUnattributed = 0, planTotal = 0;
  try {
    for (const r of loadRegistry(root)) {
      if (r.kind === "conclusion_summary") { conclusionTotal++; if (r.status !== "pending" && r.status !== "rejected") conclusionEligible++; if (!r.companyId) conclusionUnattributed++; }
      else if (r.kind === "procedural_skill") { procTotal++; if (r.status === "verified" && (r.successfulSequence?.length ?? 0) >= 2) procEligible++; if (!r.companyId) procUnattributed++; }
      else if (r.kind === "plan_template") planTotal++;
    }
  } catch { /* degrade */ }
  push("conclusion", conclusionTotal, conclusionEligible, true, conclusionUnattributed);
  push("procedural_skill", procTotal, procEligible, true, procUnattributed);
  push("plan_template", planTotal, 0, false); // contextBuilder 无 retrievePlanTemplate 调用 → 不进 prompt

  // 已审批经验(跨 run committed):contextBuilder 现在真的注入它("## 已审批的经验(跨 run 复用)"段,
  // 独立 800 字预算)。护栏:失败/降级 run 产出的结论在检索侧被隔离(committedMemoryRetriever),仅存档不注入
  // ——所以 eligibleCount 只数"来自成功 run"的条目,与实际注入资格一致(记忆页不许说谎,正反都不许)。
  let committedCount = 0;
  let committedEligible = 0;
  let committedUnattributed = 0;
  try {
    const all = listAllCommittedMemories(root);
    committedCount = all.length;
    committedEligible = all.filter((m) => !isFromExcludedRun(root, (m as { runId?: string }).runId)).length;
    // C12-P0:无 companyId 的 committed 条目对有公司归属的 agent 硬隔离不注入 → 标 unattributed(不删,供手动归属)。
    committedUnattributed = all.filter((m) => !(m as { companyId?: string }).companyId).length;
  } catch { /* degrade */ }
  push("committed", committedCount, committedEligible, true, committedUnattributed);

  return { layers, lastContextBuild: findLastContextBuild(root), generatedAt: new Date().toISOString() };
}

// Inspect / debug / prune the four-layer agent memory (Phase 4).
export function register(app: Express, projectRoot: string) {
  let backfillInFlight = false;
  const memoryScopes = new Set<LayeredMemoryScope>(["user", "company", "project", "team", "agent"]);
  const parseScope = (value: unknown): LayeredMemoryScope | undefined =>
    typeof value === "string" && memoryScopes.has(value as LayeredMemoryScope)
      ? value as LayeredMemoryScope
      : undefined;

  app.get("/api/memory/policy", (_req, res) => {
    res.json(loadMemoryPolicy(projectRoot));
  });

  app.put("/api/memory/policy", (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Record<string, boolean | number> = {};
    for (const key of ["autoApprove", "autoCurate", "autoModelMerge", "requireManualForApprovedOverwrite"] as const) {
      if (typeof body[key] === "boolean") patch[key] = body[key];
    }
    for (const key of ["maxCandidates", "maxPromptItems", "maxPromptChars"] as const) {
      if (typeof body[key] === "number" && Number.isFinite(body[key])) patch[key] = body[key];
    }
    res.json(saveMemoryPolicy(projectRoot, patch));
  });

  app.post("/api/memory/remember", async (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text required" });
    if (req.body?.sourceRunId !== undefined
      && (typeof req.body.sourceRunId !== "string" || !SAFE_RUN_ID.test(req.body.sourceRunId))) {
      return res.status(400).json({ error: "invalid sourceRunId" });
    }
    const scope = parseScope(req.body?.scope);
    if (req.body?.scope !== undefined && !scope) return res.status(400).json({ error: "invalid memory scope" });
    const allowedTypes = new Set<MemoryObjectType>([
      "user_preference", "fact", "success_experience", "failure_lesson", "resource_pointer",
    ]);
    const objectType = typeof req.body?.objectType === "string" && allowedTypes.has(req.body.objectType as MemoryObjectType)
      ? req.body.objectType as MemoryObjectType
      : undefined;
    try {
      markMemoryActivity(projectRoot);
      const proposal = await proposeMemoryWithReview(projectRoot, {
        text,
        title: typeof req.body?.title === "string" ? req.body.title : undefined,
        summary: typeof req.body?.summary === "string" ? req.body.summary : undefined,
        objectType,
        scope,
        scopeId: typeof req.body?.scopeId === "string" ? req.body.scopeId : undefined,
        sourceType: req.body?.sourceRunId ? "run" : "manual",
        sourceRunId: req.body?.sourceRunId,
        autoApprove: typeof req.body?.autoApprove === "boolean" ? req.body.autoApprove : undefined,
        rootCauseConfirmed: req.body?.rootCauseConfirmed === true,
        evidenceIds: Array.isArray(req.body?.evidenceIds)
          ? req.body.evidenceIds.filter((item: unknown): item is string => typeof item === 'string').slice(0, 20)
          : undefined,
        counterexamples: Array.isArray(req.body?.counterexamples)
          ? req.body.counterexamples.filter((item: unknown): item is string => typeof item === 'string').slice(0, 10)
          : undefined,
      });
      res.status(proposal.status === "approved" ? 201 : 202).json(proposal);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/memory/proposals-v2", (req, res) => {
    const status = typeof req.query.status === "string"
      && ["proposed", "approved", "rejected"].includes(req.query.status)
      ? req.query.status as "proposed" | "approved" | "rejected"
      : undefined;
    res.json(listGovernedMemoryProposals(projectRoot, status));
  });

  app.post("/api/memory/proposals-v2/:id/approve", (req, res) => {
    if (!SAFE_PROPOSAL_ID.test(req.params.id)) return res.status(400).json({ error: "invalid proposal id" });
    const proposal = decideGovernedMemoryProposal(projectRoot, req.params.id, "approved", "human");
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    res.json(proposal);
  });

  app.post("/api/memory/proposals-v2/:id/reject", (req, res) => {
    if (!SAFE_PROPOSAL_ID.test(req.params.id)) return res.status(400).json({ error: "invalid proposal id" });
    const proposal = decideGovernedMemoryProposal(projectRoot, req.params.id, "rejected", "human");
    if (!proposal) return res.status(404).json({ error: "proposal not found" });
    res.json(proposal);
  });

  app.get("/api/memory/layer-index/:scope/:scopeId", (req, res) => {
    const scope = parseScope(req.params.scope);
    if (!scope) return res.status(400).json({ error: "invalid memory scope" });
    res.type("text/markdown").send(readLayerIndex(projectRoot, scope, req.params.scopeId));
  });

  app.get("/api/memory/layer-index/:scope/:scopeId/:memoryId", (req, res) => {
    const scope = parseScope(req.params.scope);
    if (!scope) return res.status(400).json({ error: "invalid memory scope" });
    const memory = readLayeredMemory(projectRoot, scope, req.params.scopeId, req.params.memoryId);
    if (!memory) return res.status(404).json({ error: "memory not found" });
    res.json(memory);
  });

  app.get("/api/memory/search-v2", (req, res) => {
    const goal = typeof req.query.goal === "string" ? req.query.goal.trim() : "";
    const scope = parseScope(req.query.scope);
    const scopeId = typeof req.query.scopeId === "string" ? req.query.scopeId.trim() : "";
    if (!goal || !scope || !scopeId) return res.status(400).json({ error: "goal, scope and scopeId required" });
    res.json(searchLayeredMemories(projectRoot, {
      goal,
      scopes: [{ scope, scopeId }],
      limit: Math.min(100, Math.max(1, Number(req.query.limit) || 100)),
    }));
  });

  app.get("/api/memory/doctor", (req, res) => {
    const scopeValue = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const scopeId = typeof req.query.scopeId === "string" ? req.query.scopeId.trim() : "";
    const scope = scopeValue ? parseScope(scopeValue) : undefined;
    if ((scopeValue && !scope) || (scope && !scopeId) || (!scope && scopeId)) {
      return res.status(400).json({ error: "scope and scopeId must be supplied together" });
    }
    const goal = typeof req.query.goal === "string" ? req.query.goal.trim() : undefined;
    const report = runMemoryDoctor(projectRoot, {
      goal,
      scopes: scope && scopeId ? [{ scope, scopeId }] : undefined,
      workRoot: projectRoot,
    });
    res.status(report.status === "error" ? 207 : 200).json(report);
  });

  app.get("/api/memory/migration-report", (_req, res) => {
    const report = auditLegacyMemoryMigration(projectRoot);
    res.status(report.failureCount > 0 || report.conflictCount > 0 ? 207 : 200).json(report);
  });

  app.post("/api/memory/migrate-legacy", (_req, res) => {
    const result = migrateLegacyMemoryToLayeredProposals(projectRoot);
    res.status(result.status === "partial" ? 207 : 200).json(result);
  });

  app.post("/api/memory/rebuild-index", (_req, res) => {
    const report = rebuildLayeredMemorySearchIndex(projectRoot);
    res.status(report.errors.length ? 207 : 200).json(report);
  });

  app.get("/api/memory/resources", (req, res) => {
    const scope = parseScope(req.query.scope);
    const scopeId = typeof req.query.scopeId === "string" ? req.query.scopeId : undefined;
    res.json(listResourcePointers(projectRoot, { scope, scopeId }));
  });

  app.post("/api/memory/resources", (req, res) => {
    const scope = parseScope(req.body?.scope);
    const allowedKinds = new Set<ResourcePointerKind>(["file", "git", "http", "mcp"]);
    if (!scope || typeof req.body?.scopeId !== "string" || typeof req.body?.title !== "string"
      || typeof req.body?.uri !== "string" || !allowedKinds.has(req.body?.kind)) {
      return res.status(400).json({ error: "scope, scopeId, title, uri and valid kind required" });
    }
    try {
      const pointer = upsertResourcePointer(projectRoot, {
        id: typeof req.body?.id === "string" ? req.body.id : undefined,
        scope,
        scopeId: req.body.scopeId,
        title: req.body.title,
        uri: req.body.uri,
        provider: typeof req.body?.provider === "string" ? req.body.provider : undefined,
        kind: req.body.kind,
        contentHash: typeof req.body?.contentHash === "string" ? req.body.contentHash : undefined,
        etag: typeof req.body?.etag === "string" ? req.body.etag : undefined,
        authRef: typeof req.body?.authRef === "string" ? req.body.authRef : undefined,
        expiresAt: typeof req.body?.expiresAt === "string" ? req.body.expiresAt : undefined,
        ttlMs: typeof req.body?.ttlMs === "number" ? req.body.ttlMs : undefined,
        freshnessPolicy: ["per_run", "ttl", "manual"].includes(req.body?.freshnessPolicy)
          ? req.body.freshnessPolicy
          : "per_run",
        sourceRunId: typeof req.body?.sourceRunId === "string" ? req.body.sourceRunId : undefined,
      });
      res.status(201).json(pointer);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/memory/resources/:id/validate", async (req, res) => {
    const runId = typeof req.body?.runId === "string" ? req.body.runId : "";
    if (!SAFE_RUN_ID.test(runId)) return res.status(400).json({ error: "valid runId required" });
    if (!runExists(projectRoot, runId)) return res.status(404).json({ error: "run not found" });
    try {
      res.json(await validateResourcePointer(projectRoot, runId, req.params.id, {
        allowLocalNetwork: req.body?.allowLocalNetwork === true,
      }));
    } catch (error) {
      res.status(404).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/memory/curator-runs", (_req, res) => {
    res.json(listMemoryCuratorRuns(projectRoot));
  });

  app.post("/api/memory/curate", async (req, res) => {
    const scope = parseScope(req.body?.scope);
    if (req.body?.scope !== undefined && !scope) return res.status(400).json({ error: "invalid memory scope" });
    try {
      res.json(await runMemoryCurator(projectRoot, {
        scope,
        scopeId: typeof req.body?.scopeId === "string" ? req.body.scopeId : undefined,
        dryRun: req.body?.dryRun !== false,
        modelMerge: typeof req.body?.modelMerge === "boolean" ? req.body.modelMerge : undefined,
      }));
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/memory/curator-runs/:id/rollback", (req, res) => {
    const run = rollbackMemoryCuratorRun(projectRoot, req.params.id);
    if (!run) return res.status(404).json({ error: "curator run not found or not reversible" });
    res.json(run);
  }); // 串行锁:防并发 backfill 重复刷 deepseek
  app.get("/api/memory", (req, res) => {
    const role = req.query.role as string | undefined;
    res.json(listMemory(projectRoot, role));
  });

  // Stage 2/4 · 记忆可见:跨 run 已提交的「真记忆」(被注入复用的那套),供员工档案/记忆面板展示。
  // Stage 4:?role= 按角色隔离(scope=agent 私有记忆只对同 role 可见;project/team/run 始终共享)。
  app.get("/api/memory/committed", (req, res) => {
    const scope = typeof req.query.scope === "string" && req.query.scope ? req.query.scope : undefined;
    const type = typeof req.query.type === "string" && req.query.type ? req.query.type : undefined;
    // 空/空白 role 归一为 undefined:避免 ?role= 空串短路隔离守卫(= 当作无过滤 = admin 全量,语义一致)。
    const role = typeof req.query.role === "string" && req.query.role.trim() ? req.query.role.trim() : undefined;
    const minConfidence = req.query.minConfidence ? Number(req.query.minConfidence) : undefined;
    res.json(listAllCommittedMemories(projectRoot, { scope, type, minConfidence, role }));
  });

  app.get("/api/memory/query", (req, res) => {
    const goal = String(req.query.goal ?? "");
    const role = String(req.query.role ?? "*");
    if (!goal) return res.status(400).json({ error: "goal required" });
    res.json(queryMemory(projectRoot, { agentRole: role, goal }));
  });

  app.delete("/api/memory/:id", (req, res) => {
    res.json({ deleted: deleteMemory(projectRoot, req.params.id) });
  });

  // Layer E · 失败反思教训:员工页 / lesson list 用。默认全部(含 revoked,展示生命周期);可按 role/company 过滤。
  app.get("/api/memory/lessons", (req, res) => {
    const role = typeof req.query.role === "string" && req.query.role.trim() ? req.query.role.trim().toLowerCase() : undefined;
    const companyId = typeof req.query.company === "string" && req.query.company ? req.query.company : undefined;
    let ls = loadLessons(projectRoot);
    if (role) ls = ls.filter((l) => (l.scope.role || "").toLowerCase() === role);
    if (companyId) ls = ls.filter((l) => !l.scope.companyId || l.scope.companyId === companyId);
    res.json(ls.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")));
  });

  // C1 · 手动新建经验:失败复盘卡「加入经验库」的后端入口。用户主动保存即人工批准——
  // addManualLesson 走 reflectionStore 账本模式,lifecycle 完整记 proposed→approved(by:"user")→committed;
  // content 过既有质量线(过短/口号型 → 400)并截断;带合法 runId 时同步记进该 run 的 memory_proposals.json 台账。
  app.post("/api/memory/lessons", async (req, res) => {
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";
    if (!content) return res.status(400).json({ error: "content required" });
    if (req.body?.runId !== undefined && (typeof req.body.runId !== "string" || !SAFE_RUN_ID.test(req.body.runId))) {
      return res.status(400).json({ error: "invalid run id" });
    }
    const pick = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : undefined);
    const rawScope = (req.body?.scope ?? {}) as Record<string, unknown>;
    const scope: { companyId?: string; teamId?: string; role?: string; agentId?: string; taskType?: string; workflowStage?: string } = {};
    for (const k of ["companyId", "teamId", "role", "agentId", "taskType", "workflowStage"] as const) {
      const v = pick(rawScope[k]);
      if (v) scope[k] = v;
    }
    const tags = Array.isArray(req.body?.tags)
      ? (req.body.tags as unknown[]).filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 8)
      : undefined;
    const selectedScope = scope.agentId
      ? { scope: "agent" as const, scopeId: scope.agentId }
      : scope.teamId
        ? { scope: "team" as const, scopeId: scope.teamId }
        : scope.companyId
          ? { scope: "company" as const, scopeId: scope.companyId }
          : {};
    try {
      const proposal = await proposeMemoryWithReview(projectRoot, {
        text: content,
        title: typeof req.body?.title === "string" ? req.body.title.slice(0, 120) : "手动经验",
        summary: tags?.length ? tags.join(" · ").slice(0, 180) : content.slice(0, 180),
        objectType: req.body?.objectType === "user_preference"
          || req.body?.objectType === "fact"
          || req.body?.objectType === "success_experience"
          || req.body?.objectType === "resource_pointer"
          ? req.body.objectType
          : "failure_lesson",
        ...selectedScope,
        sourceType: "manual",
        sourceRunId: req.body?.runId,
        autoApprove: req.body?.asProposal === false,
        rootCauseConfirmed: req.body?.rootCauseConfirmed === true,
        evidenceIds: req.body?.runId ? [req.body.runId] : [],
        counterexamples: Array.isArray(req.body?.counterexamples)
          ? req.body.counterexamples.filter((item: unknown): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 10)
          : [],
      });
      res.json(proposal);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // 统一 Memory Registry(P2 conclusion_summary / P4 procedural_skill)。
  app.get("/api/memory/registry", (_req, res) => {
    res.json(loadRegistry(projectRoot));
  });

  // P2 · 人工审核模式开关:关闭(默认)= conclusion_summary 继续自动 approved 生效,不打断现有流程;
  // 开启后新写入的 conclusion_summary 落 pending,需下面三个 /proposals 端点人工审核。
  // D2:响应/入参加性带 autoCommitRunConclusion(run_conclusion 自动 commit 开关)。
  // 决策④默认档翻转:默认 false——run_conclusion 默认停 proposed 需人工审批,显式开(review-mode 设 true
  // 或 OPC_MEMORY_AUTOCOMMIT=on)才自动 commit;与 registryStore.isRunConclusionAutoCommitEnabled 口径一致。
  app.get("/api/memory/review-mode", (_req, res) => {
    res.json({ enabled: isReviewModeEnabled(projectRoot), autoCommitRunConclusion: isRunConclusionAutoCommitEnabled(projectRoot) });
  });
  app.post("/api/memory/review-mode", (req, res) => {
    if ("enabled" in (req.body ?? {})) setReviewMode(projectRoot, req.body.enabled === true);
    if (typeof req.body?.autoCommitRunConclusion === "boolean") setRunConclusionAutoCommit(projectRoot, req.body.autoCommitRunConclusion);
    res.json({ enabled: isReviewModeEnabled(projectRoot), autoCommitRunConclusion: isRunConclusionAutoCommitEnabled(projectRoot) });
  });

  // P2 · 记忆提案审核(参照 reflectionStore.ts 的 committed/revoked 状态机命名):
  // 目前只有 conclusion_summary 有 pending 态(procedural_skill 靠 support>=3 天然晋升、plan_template 无需审核)。
  app.get("/api/memory/proposals", (_req, res) => {
    res.json(listConclusionProposals(projectRoot));
  });

  // companyId is mandatory so the run review queue can never become a
  // cross-company listing when a caller forgets to set a scope.
  app.get("/api/memory/run-proposals", (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId.trim() : undefined;
    res.json(listPendingRunMemoryProposals(projectRoot, companyId));
  });
  app.post("/api/memory/proposals/:id/approve", (req, res) => {
    const updated = approveConclusionSummary(projectRoot, req.params.id);
    if (!updated) return res.status(404).json({ error: "proposal not found" });
    res.json(updated);
  });
  app.post("/api/memory/proposals/:id/reject", (req, res) => {
    const updated = rejectConclusionSummary(projectRoot, req.params.id);
    if (!updated) return res.status(404).json({ error: "proposal not found" });
    res.json(updated);
  });

  // 令二.5 · procedural_skill 提案人工审批(镜像 lessons/:id/approve 风格):
  //   approve:proposed → verified(即刻可注入/可导出);reject:proposed → retired 终态。
  //   只对 proposed 生效,candidate/verified/retired/不存在 → 404。
  app.post("/api/memory/skills/:id/approve", (req, res) => {
    const updated = approveProceduralSkill(projectRoot, req.params.id, new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "proposed skill not found" });
    res.json(updated);
  });
  app.post("/api/memory/skills/:id/reject", (req, res) => {
    const updated = rejectProceduralSkill(projectRoot, req.params.id, new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "proposed skill not found" });
    res.json(updated);
  });

  // 手动撤销一条无效教训(UI 上用户可操作)。
  app.post("/api/memory/lessons/:id/revoke", (req, res) => {
    res.json({ revoked: revokeLesson(projectRoot, req.params.id) });
  });

  // A1-V2 · pending(proposed)lesson 人工审批:approve → committed(可注入);reject → revoked 终态。
  // 只对 proposed 生效,已生效/已撤销/不存在 → 404(沿用上方 /proposals/:id/approve 的 404 风格)。
  app.post("/api/memory/lessons/:id/approve", (req, res) => {
    const updated = approveLesson(projectRoot, req.params.id, "human", new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "proposed lesson not found" });
    res.json(updated);
  });
  app.post("/api/memory/lessons/:id/reject", (req, res) => {
    const updated = rejectLesson(projectRoot, req.params.id, "human", new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "proposed lesson not found" });
    res.json(updated);
  });

  // C6 · 记忆页/员工详情"应用到员工训练":把一条经验手动强绑定到指定员工(检索加权,
  // 见 reflectionStore.retrieveLessonsForAgent)。只接受真实存在的 agentId,防止绑定到
  // 拼错/已删除的员工上;revoked(终态)经验不可再绑定。
  app.post("/api/memory/lessons/:id/bind-agent", (req, res) => {
    const agentId = typeof req.body?.agentId === "string" ? req.body.agentId.trim() : "";
    if (!agentId) return res.status(400).json({ error: "agentId required" });
    if (!getAgents().some((a) => a.id === agentId)) return res.status(400).json({ error: "agent not found" });
    const updated = bindLessonToAgent(projectRoot, req.params.id, agentId, "human", new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "lesson not found or revoked" });
    res.json(updated);
  });

  // A1-V2 · run 级记忆提案台账 + 审批:memory_proposals.json 是每轮提案的磁盘证据;
  // 高风险 run_conclusion 停 pending,在这里人工放行(入库 committed-memories.json)或拒绝。
  app.get("/api/runs/:id/memory-proposals", (req, res) => {
    if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
    // MUP B7:不存在的 run 一律 404(与 runRoutes.requireRunExists 同源判据 task.json;400 先于 404)。
    if (!runExists(projectRoot, req.params.id)) return res.status(404).json({ error: "run not found" });
    const recs = loadMemoryProposals(projectRoot, req.params.id);
    // D2:pending 计数走响应头(X-Pending-Count),body 仍是原始数组 —— 加性、不破坏既有数组消费方。
    res.setHeader("X-Pending-Count", String(recs.filter((r) => r.status === "pending").length));
    res.json(recs);
  });
  app.post("/api/runs/:id/memory-proposals/:pid/approve", (req, res) => {
    if (!SAFE_RUN_ID.test(req.params.id) || !SAFE_PROPOSAL_ID.test(req.params.pid)) return res.status(400).json({ error: "invalid id" });
    const updated = approveRunMemoryProposal(projectRoot, req.params.id, req.params.pid, "human", new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "pending proposal not found" });
    res.json(updated);
  });
  app.post("/api/runs/:id/memory-proposals/:pid/reject", (req, res) => {
    if (!SAFE_RUN_ID.test(req.params.id) || !SAFE_PROPOSAL_ID.test(req.params.pid)) return res.status(400).json({ error: "invalid id" });
    const updated = rejectRunMemoryProposal(projectRoot, req.params.id, req.params.pid, "human", new Date().toISOString());
    if (!updated) return res.status(404).json({ error: "pending proposal not found" });
    res.json(updated);
  });

  // P4 · 历史 backfill:从过去有失败信号的 run 补出教训(冷启动)。best-effort;deepseek 没配则报错。
  // 加固:limit 夹到 [1,50] 防刷 deepseek;单进程串行锁防并发重复触发。
  app.post("/api/memory/backfill", async (req, res) => {
    const key = resolveProviderKey(projectRoot, "deepseek");
    if (!key) return res.status(400).json({ error: "deepseek 未配置,无法回填" });
    if (backfillInFlight) return res.status(409).json({ error: "backfill 正在进行,请稍后" });
    const limit = Math.min(50, Math.max(1, Number(req.body?.limit) || 20));
    backfillInFlight = true;
    try {
      const r = await backfillLessons({
        projectRoot,
        callModel: (sys, user) => deepseekChat(key, sys, user),
        roleOf: (id) => getAgents().find((a) => a.id === id)?.role,
        teamIdOf: (id) => { const a = getAgents().find((x) => x.id === id); return a ? (a.role === "lead" ? a.id : a.parentId) : undefined; },
        companyIdOf: (id) => getAgents().find((a) => a.id === id)?.companyId,
        nowIso: new Date().toISOString(), limit,
      });
      res.json(r);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
    finally { backfillInFlight = false; }
  });

  // D3 · 复用验证回路只读聚合:reuse-log.jsonl(注入 × run 终态关联)→ 每条记忆的
  // injected/cleanRuns/failedRuns(run 粒度去重)。只交付可观测关联,不虚标因果;前端展示归 E 泳道。
  app.get("/api/memory/reuse-stats", (_req, res) => {
    try {
      const stats = loadReuseStats(projectRoot);
      res.json({
        stats: [...stats.entries()].map(([memoryId, s]) => ({ memoryId, ...s })),
        generatedAt: new Date().toISOString(),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // Memory Pack · 统一投影(6 套记忆子系统聚合成一个带 provenance 的可审计视图)。

  // 全局概览:各 scope/kind 各有多少条,不分角色/不打分/不限量——纯计数,给管理视图看记忆库总量。
  app.get("/api/memory/summary", (_req, res) => {
    try { res.json(buildMemorySummary(projectRoot)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 记忆层级真实注入资格视图(记忆页「记忆层级」标签用):每层条目数 + 是否真的进 prompt(与 contextBuilder 事实对齐)。
  app.get("/api/memory/layers", (_req, res) => {
    try { res.json(buildMemoryLayers(projectRoot)); }
    catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 某个 agent(按其 role/companyId/所属团队)当前能检索到的完整 memory pack——不绑定某次具体 run,
  // 是"如果现在有个任务,大概会用到这些"的静态视图(传入通用占位 goal)。
  app.get("/api/agents/:id/memories", (req, res) => {
    try {
      const agent = getAgents().find((a) => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: "agent not found" });
      const teamId = agent.role === "lead" ? agent.id : agent.parentId;
      res.json(buildMemoryPack(projectRoot, { goal: GENERIC_GOAL, companyId: agent.companyId, teamId, agentId: agent.id, role: agent.role }));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 该次 run 实际用过的记忆:纯派生自 events.jsonl 里 orchestrator 每个 agent 执行时 emit 的
  // "memory_pack_used" info 事件(见 runtime/memoryPack.ts deriveRunMemoryPackUsage)。
  app.get("/api/runs/:id/memory-pack", (req, res) => {
    try {
      if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
      // MUP B7:同上,run 不存在 → 404(判据与 runRoutes.runExists 同源)。
      if (!runExists(projectRoot, req.params.id)) return res.status(404).json({ error: "run not found" });
      res.json(deriveRunMemoryPackUsage(projectRoot, req.params.id));
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // P3 · 安全摘要导出:该公司 committed 教训里 confidence+recency 打分 top N,脱敏后输出,供对外分享。
  // 刻意只取 reflectionStore 的 committed lesson——不碰 conclusion_summary / 跨 run committed 的 run_conclusion,
  // 那两个信息密度最高,最容易带出具体项目/客户细节,不适合直接对外导出(见调查结论)。
  // practices 暂留空数组:procedural_skill 目前没有"最佳实践"的提炼字段(successfulSequence 是内部执行序列,
  // 不是对外可读的实践描述),没有现成数据源可用,如实留空而非硬凑。
  app.get("/api/companies/:id/memory-digest", (req, res) => {
    try {
      const company = getCompany(projectRoot, req.params.id);
      if (!company) return res.status(404).json({ error: "company not found" });
      // 记忆导出开关(公司设置页可关):显式设为 false 才拦,缺省(未设置)按允许处理,不改变旧公司行为。
      if (company.memoryExportEnabled === false) return res.status(403).json({ error: "该公司已关闭记忆导出" });
      const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
      const companyNames = loadCompanies(projectRoot).map((c) => c.name).filter(Boolean);
      const memberNames = getAgents().map((a) => a.name).filter(Boolean);
      const nowMs = Date.now();
      // 打分公式思路同 reflectionStore.retrieveLessons:confidence + recency 衰减(半衰期 30 天),
      // 越新、越有把握的教训排越前;这里不加 role/taskType 加分项(公司级摘要,不针对某个角色)。
      const lessons = loadLessons(projectRoot)
        .filter((l) => l.status === "committed")
        .filter((l) => !l.scope.companyId || l.scope.companyId === company.id)
        .map((l) => {
          const days = Math.max(0, (nowMs - Date.parse(l.updatedAt || l.createdAt)) / 86400000);
          const score = l.confidence + (Number.isFinite(days) ? 0.4 * Math.pow(0.5, days / 30) : 0);
          return { l, score };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ l }) => {
          const { text, safeToShare } = sanitizeMemoryText({
            text: l.injection?.promptText || l.lesson,
            companyNames, memberNames,
          });
          return { id: l.id, text, confidence: l.confidence, safeToShare };
        });
      res.json({ practices: [], lessons, generatedAt: new Date().toISOString() });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
}
