// C5(V0 必需)· 员工成长系统 —— 与记忆生命周期强绑定(重构指南 §6 Track C · C5 / 大重构指南 10.7)。
//
// 硬约束:员工成长不是任务数统计,XP 必须由记忆生命周期事件驱动:
//   1) memory proposal 被批准(approved,含低风险 auto)              → +XP_PROPOSAL_APPROVED
//   2) 员工经验被后续任务成功引用(procedural_skill.support 增长)     → +XP_CITED_SUCCESS × 增量
//   3) 员工经验升级为 SOP/doctrine 级(procedural_skill → verified)  → +XP_SOP_PROMOTION(一次性)
//   4) 产出被否决:review needs_revision/failed(reviewCommit 四态事件)+ admission 质量门拒收
//      (quality_gate_result·passed=false·stage=admission,即 artifact mismatch) → XP_REVIEW_PENALTY(负数)+ 记 weakness
//   5) 纯任务完成数只占小头,防刷                                    → +XP_RUN_COMPLETED(仅 run 真正完成时、仅记实际参与者)
//
// 数据现实说明(如实记录,不假装):registryStore.ts 当前**没有**真正意义上的按 memoryId 计数的
// cited_count/cited_success_count 字段(全仓库 grep 零命中)。本模块用 procedural_skill.support 的
// 跨 run 增量作为"经验被后续任务成功复用"的代理信号——它由 orchestrator 在**另一个角色的 worker
// 干净完成同任务类型**时才 +1(见 orchestrator.ts ~1894 行 upsertProceduralSkill 调用点),语义上
// 与"经验被验证/复用成功"一致,只是粒度是 role 级而非单条 memoryId 级(procedural_skill 本身就没有
// 单条被引用的 memoryId 追踪机制)。若未来 memoryPack 检索侧补上真正的"引用埋点+成功回标",
// 这里应该切换数据源,不需要改 computeGrowthDelta 的输出契约。
//
// 归因粒度限制(如实记录):procedural_skill / AgentGrowth 都是按 role 聚合,不是按具体 agentId——
// 同一 role 下有多名员工时,引用对账 XP(cited_success/sop_promotion)会**平均分给所有该 role 的
// 在编员工**,不是精确记给"提出这条经验的那一个人"。proposal_approved / review_penalty / run_completed
// 三类事件有明确 agentId,精确记账。
//
// 触发时机限制(如实记录):orchestrator 每 run 只在收尾调用一次本模块(唯一回写点)。反思教训
// (reflection lesson)由 runCritic.reflectOnRun 异步 fire-and-forget 产出,常常在本 run 收尾**之后**
// 才落盘 memory_proposals.json——那笔 XP 不会被本 run 的收尾调用捕获,也没有后续 run 的调用会回补
// (下个 run 的 collectRunGrowthEvidence 只读*那个新 run 自己*的 memory_proposals.json)。这是本批
// 单一调用点约束下的已知缺口,见任务报告"诚实未做清单"。
import type { AgentNodeConfig } from "@opc/shared";
import * as path from "node:path";
import { loadAgents, saveAgents, loadMemoryProposals, type RunMemoryProposalRecord } from "./projectStore.js";
import { loadRegistry, type ProceduralSkill } from "./registryStore.js";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readDocByPk, upsertDoc } from "./sqlite/docTableBackend.js";

// ── XP 规则常量(硬约束①-⑤,按用户给的量级)──────────────────────────────────
export const XP_PROPOSAL_APPROVED = 10;
export const XP_CITED_SUCCESS = 5;
export const XP_SOP_PROMOTION = 50;
export const XP_REVIEW_PENALTY = -8;
export const XP_RUN_COMPLETED = 2; // 防刷:五类事件里权重最小的一档

const WEAKNESS_PREVIEW_MAX = 200;
const LESSON_PREVIEW_MAX = 200;
export const MAX_WEAKNESSES = 3;
export const MAX_RECENT_LESSONS = 3;

// level = 1 + floor(sqrt(xp/100)):0-99 XP→Lv1,100-399→Lv2,400-899→Lv3,900-1599→Lv4……
// 平方根曲线让越往后升级需要的 XP 越多(常见游戏化曲线),阈值简单、无需查表,xp<0 兜底按 0 算。
export function computeLevel(xp: number): number {
  return 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 100));
}

// ── run 内证据(computeGrowthDelta 的输入)────────────────────────────────────

export interface RunProposalEvidence {
  agentId?: string;
  status: string;    // pending/approved/committed/rejected/revoked(见 RunMemoryProposalRecord.status)
  source?: string;   // "run_conclusion" | "reflection_lesson"
  content?: string;
}

export type ReviewVerdictLike = "accepted" | "needs_revision" | "failed" | "requires_human_review";

export interface RunReviewEvidence {
  agentId: string; // 被审 producer(ReviewCommittedPayload.agentId)
  verdict: ReviewVerdictLike;
  reason?: string;
}

// registryStore procedural_skill 的跨 run 对账结果(见 reconcileCitations)。
export interface CitationEvidence {
  role: string;
  taskType?: string;
  agentIds: string[];   // 归因到的在编员工(同 role,enabled!==false)
  citedDelta: number;   // 自上次快照以来 support 的增量(= "被复用成功"次数)
  promoted: boolean;    // 本次对账发现 status 从非 verified → verified(SOP 晋级)
}

export interface RunGrowthEvidence {
  runId: string;
  runCompleted: boolean;            // run.status === "done"
  participantAgentIds: string[];    // run.participatingAgents(去重)
  proposals: RunProposalEvidence[];
  reviews: RunReviewEvidence[];
  citations: CitationEvidence[];
}

// ── 输出:每 agent 的 XP 变化 + weakness/lesson 追加 ──────────────────────────

export type GrowthEventKind = "proposal_approved" | "cited_success" | "sop_promotion" | "review_penalty" | "run_completed";

export interface GrowthEventDetail {
  kind: GrowthEventKind;
  xp: number;
  note: string;
}

export interface AgentGrowthDelta {
  agentId: string;
  xpDelta: number;
  weaknesses: string[];    // 本次新增(最新在前),applyGrowth 负责与旧数据合并+截断
  recentLessons: string[]; // 本次新增(最新在前)
  events: GrowthEventDetail[];
}

// 纯函数:不碰 IO。五类事件各自独立累加,同一 agent 在同一 run 内可能命中多类。
export function computeGrowthDelta(evidence: RunGrowthEvidence): AgentGrowthDelta[] {
  const byAgent = new Map<string, AgentGrowthDelta>();
  const get = (agentId: string): AgentGrowthDelta => {
    let d = byAgent.get(agentId);
    if (!d) {
      d = { agentId, xpDelta: 0, weaknesses: [], recentLessons: [], events: [] };
      byAgent.set(agentId, d);
    }
    return d;
  };

  // ① memory proposal 被批准(approved=中间态 / committed=已生效,含低风险 auto 都算——
  // 两者都代表"这条提案被判定值得进入记忆",人工审批 vs 自动批准不影响 XP)。
  for (const p of evidence.proposals) {
    if (!p.agentId) continue;
    if (p.status !== "approved" && p.status !== "committed") continue;
    const d = get(p.agentId);
    d.xpDelta += XP_PROPOSAL_APPROVED;
    d.events.push({ kind: "proposal_approved", xp: XP_PROPOSAL_APPROVED, note: `memory proposal ${p.status}(${p.source ?? "unknown"})` });
    if (p.source === "reflection_lesson" && p.content) {
      d.recentLessons.unshift(p.content.slice(0, LESSON_PREVIEW_MAX));
    }
  }

  // ②③ 引用对账:经验被复用(cited_success)+ 升级 SOP(sop_promotion),同一条 citation 可能两者都命中。
  for (const c of evidence.citations) {
    for (const agentId of c.agentIds) {
      const d = get(agentId);
      if (c.citedDelta > 0) {
        const xp = XP_CITED_SUCCESS * c.citedDelta;
        d.xpDelta += xp;
        d.events.push({ kind: "cited_success", xp, note: `${c.role} 经验被后续任务成功复用 ${c.citedDelta} 次` });
      }
      if (c.promoted) {
        d.xpDelta += XP_SOP_PROMOTION;
        d.events.push({ kind: "sop_promotion", xp: XP_SOP_PROMOTION, note: `${c.role}${c.taskType ? "/" + c.taskType : ""} 经验升级为 SOP(procedural_skill → verified)` });
      }
    }
  }

  // ④ review 否决(needs_revision=要求返工 / failed=重试耗尽仍被拒)→ 扣分 + 记 weakness。
  // requires_human_review 不在此列(语义是"不确定待人看",不是明确否决)。
  for (const r of evidence.reviews) {
    if (r.verdict !== "needs_revision" && r.verdict !== "failed") continue;
    const d = get(r.agentId);
    d.xpDelta += XP_REVIEW_PENALTY;
    const weakness = (r.reason || (r.verdict === "failed" ? "产出未通过审查(重试耗尽)" : "产出被要求返工")).slice(0, WEAKNESS_PREVIEW_MAX);
    d.weaknesses.unshift(weakness);
    d.events.push({ kind: "review_penalty", xp: XP_REVIEW_PENALTY, note: weakness });
  }

  // ⑤ 纯任务完成数(防刷:权重最小 + 仅 run 真正完成时给 + 仅记实际参与者,去重——即便调用方传入
  // 重复 id 也只记一次,不给刷 XP 的空子)。
  if (evidence.runCompleted) {
    for (const agentId of new Set(evidence.participantAgentIds)) {
      const d = get(agentId);
      d.xpDelta += XP_RUN_COMPLETED;
      d.events.push({ kind: "run_completed", xp: XP_RUN_COMPLETED, note: `run ${evidence.runId} 完成` });
    }
  }

  return [...byAgent.values()];
}

// ── 落盘:读改写 agents.json 的 growth 字段(best-effort,全 try/catch)──────────

export function applyGrowth(projectRoot: string, deltas: AgentGrowthDelta[]): void {
  if (!deltas.length) return;
  try {
    const agents = loadAgents(projectRoot, []);
    let changed = false;
    for (const delta of deltas) {
      if (delta.xpDelta === 0 && delta.weaknesses.length === 0 && delta.recentLessons.length === 0) continue;
      const agent = agents.find((a) => a.id === delta.agentId);
      if (!agent) continue; // agent 已被删除等边缘情况:静默跳过,不报错
      const prev = agent.growth;
      const xp = Math.max(0, (prev?.xp ?? 0) + delta.xpDelta);
      const weaknesses = [...delta.weaknesses, ...(prev?.weaknesses ?? [])].slice(0, MAX_WEAKNESSES);
      const recentLessons = [...delta.recentLessons, ...(prev?.recentLessons ?? [])].slice(0, MAX_RECENT_LESSONS);
      agent.growth = {
        level: computeLevel(xp),
        xp,
        ...(prev?.successRate !== undefined ? { successRate: prev.successRate } : {}),
        ...(prev?.specialties?.length ? { specialties: prev.specialties } : {}),
        ...(weaknesses.length ? { weaknesses } : {}),
        ...(recentLessons.length ? { recentLessons } : {}),
      };
      changed = true;
    }
    if (changed) saveAgents(projectRoot, agents);
  } catch { /* best-effort:员工成长回写失败不影响 run */ }
}

// ── 跨 run 引用对账(procedural_skill.support/status 快照 diff)────────────────

interface GrowthSnapshot {
  registry: Record<string, { support: number; status: string }>;
}

function snapshotFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "memory", "growth-snapshot.json");
}

// 战役B·Phase B2a:仅"成长快照"(growth-snapshot.json)归本相中立表 growth_snapshots(单行,
// pk 固定 'growth-snapshot')。agents.json 归 projectStore(B2b),applyGrowth 写 agents.json 不在此切。
// 默认 json 逐字节不变;sqlite 时读走该单行 doc(权威)、写【双写】(JSON 照写 + 单行 upsert)。
function loadSnapshot(projectRoot: string): GrowthSnapshot {
  if (isSqliteBackend(projectRoot)) {
    return (readDocByPk(openBusinessDb(projectRoot), "growth_snapshots", "growth-snapshot") as GrowthSnapshot | undefined) ?? { registry: {} };
  }
  return readJSON<GrowthSnapshot>(snapshotFile(projectRoot), { registry: {} });
}

function saveSnapshot(projectRoot: string, snap: GrowthSnapshot): void {
  writeJSON(snapshotFile(projectRoot), snap);
  if (isSqliteBackend(projectRoot)) {
    upsertDoc(openBusinessDb(projectRoot), "growth_snapshots", "growth-snapshot", snap);
  }
}

// 对比 registryStore 当前 procedural_skill 状态与上次快照:support 增量 = 本轮"被复用成功"次数,
// status 从非 verified → verified = "升级 SOP"。**冷启动**(某条 skill 在快照里完全没有基线)不追溯
// 记账——只落新基线、这次不产出 XP 事件,避免"功能刚上线就把历史已 verified 的经验一次性倒算 XP"。
// 归因:procedural_skill 只按 role 存,没有 agentId——把对账结果分给当前所有该 role 的在编员工
// (enabled !== false),见文件顶注"归因粒度限制"。best-effort:任何失败返回空数组,不影响调用方。
export function reconcileCitations(
  projectRoot: string,
  agents: Array<Pick<AgentNodeConfig, "id" | "role" | "enabled">>,
): CitationEvidence[] {
  try {
    const skills = loadRegistry(projectRoot).filter((r): r is ProceduralSkill => r.kind === "procedural_skill");
    const snap = loadSnapshot(projectRoot);
    const nextRegistry: GrowthSnapshot["registry"] = {};
    const out: CitationEvidence[] = [];
    for (const s of skills) {
      nextRegistry[s.id] = { support: s.support, status: s.status };
      const prev = snap.registry[s.id];
      if (!prev) continue; // 冷启动:无基线,不追溯
      const citedDelta = Math.max(0, s.support - prev.support);
      const promoted = prev.status !== "verified" && s.status === "verified";
      if (citedDelta === 0 && !promoted) continue;
      const agentIds = agents.filter((a) => a.role === s.role && a.enabled !== false).map((a) => a.id);
      if (agentIds.length === 0) continue; // 没有在编员工持有该 role → 无人可记,跳过(基线仍已推进)
      out.push({ role: s.role, taskType: s.taskType, agentIds, citedDelta, promoted });
    }
    saveSnapshot(projectRoot, { registry: nextRegistry });
    return out;
  } catch {
    return [];
  }
}

// ── 组装本 run 的完整证据(orchestrator 收尾唯一调用点用)──────────────────────

export interface CollectGrowthParams {
  runId: string;
  runStatus: string;                                       // run.status
  participantAgentIds: string[];                            // run.participatingAgents
  agents: Array<Pick<AgentNodeConfig, "id" | "role" | "enabled">>;
  traceEvents: Array<{ type: string; payload?: unknown }>;  // 本 run 的 traceEvents(过滤 review_committed / admission 拒收的 quality_gate_result)
}

function isReviewCommittedPayload(p: unknown): p is { agentId: string; verdict: ReviewVerdictLike; proposal?: { reason?: string } } {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return typeof o.agentId === "string" && typeof o.verdict === "string";
}

// admission 阶段质量门拒收(orchestrator 工件契约拒收 / parallelExecutor 代码门 tsc/test 失败)。
// 只收 stage=admission:cross_verify 的失败已经由同路径的 review_committed 事件记过一笔,再收就重复计罚。
function isAdmissionGateFailurePayload(p: unknown): p is { producer: string; overallReason?: unknown } {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  return o.passed === false && o.stage === "admission" && typeof o.producer === "string";
}

export function collectRunGrowthEvidence(projectRoot: string, params: CollectGrowthParams): RunGrowthEvidence {
  const proposalRecords: RunMemoryProposalRecord[] = (() => {
    try { return loadMemoryProposals(projectRoot, params.runId); } catch { return []; }
  })();
  const proposals: RunProposalEvidence[] = proposalRecords.map((p) => ({
    agentId: p.agentId,
    status: p.status,
    source: p.source,
    content: p.content,
  }));

  const reviews: RunReviewEvidence[] = params.traceEvents
    .filter((e) => e.type === "review_committed" && isReviewCommittedPayload(e.payload))
    .map((e) => {
      const p = e.payload as { agentId: string; verdict: ReviewVerdictLike; proposal?: { reason?: string } };
      return { agentId: p.agentId, verdict: p.verdict, reason: p.proposal?.reason };
    });

  // 硬约束④的另一半事件源(artifact mismatch):admission 拒收按"审查 failed"记账——扣 XP + 记 weakness。
  for (const e of params.traceEvents) {
    if (e.type !== "quality_gate_result" || !isAdmissionGateFailurePayload(e.payload)) continue;
    const p = e.payload as { producer: string; overallReason?: unknown };
    const reason = typeof p.overallReason === "string" && p.overallReason ? p.overallReason : "产出未通过 admission 质量门";
    reviews.push({ agentId: p.producer, verdict: "failed", reason });
  }

  const citations = reconcileCitations(projectRoot, params.agents);

  return {
    runId: params.runId,
    runCompleted: params.runStatus === "done",
    participantAgentIds: [...new Set(params.participantAgentIds)],
    proposals,
    reviews,
    citations,
  };
}
