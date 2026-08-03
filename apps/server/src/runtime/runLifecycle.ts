import * as fs from "node:fs";
import * as path from "node:path";
import type { Run } from "@opc/shared";
import { createRun, saveRunTask, loadRunTask, loadAgents } from "../storage/projectStore.js";
import { listPendingConflictsForRun } from "../storage/conflictStore.js";
import { deriveFinalRunState } from "./deliveryAcceptance.js";
import { listMcpServers } from "../storage/mcpStore.js";
import { estimateTaskComplexity, detectCodeSignals } from "./taskComplexityEstimator.js";
import { decideGovernanceLevel } from "./runGovernance.js";
import { frameworkHasFullHostAccess } from "./effectiveCapabilities.js";
import {
  recordGovernanceDecision, getGovernanceRecord, setGovernanceApproval, appendGovernanceEvent,
  type GovernanceRecord, type GovernancePendingDispatch,
} from "../storage/governanceStore.js";

export interface PrecreateRunInput {
  runId: string;
  goal: string;
  companyId?: string;
  // E4 · L3 审批网关:被网关拦下待批的 run 先落 "pending"(不是 running——它还没开工),
  // 批准后 startRun 的 createRun 会照常覆写为 running。缺省 "running" 与旧行为逐字节一致。
  status?: "running" | "pending";
}

function taskPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, ".opc", "runs", runId, "task.json");
}

function readRunTask(projectRoot: string, runId: string): Run | null {
  try {
    const raw = fs.readFileSync(taskPath(projectRoot, runId), "utf-8");
    return JSON.parse(raw) as Run;
  } catch {
    return null;
  }
}

export function precreateRunTask(projectRoot: string, input: PrecreateRunInput): Run {
  const run: Run = {
    id: input.runId,
    userGoal: input.goal,
    status: input.status ?? "running",
    companyId: input.companyId ?? "default",
    startedAt: new Date().toISOString(),
    totalTokens: 0,
    totalCostUsd: 0,
    participatingAgents: [],
  };
  createRun(projectRoot, run);
  return run;
}

export function markPrecreatedRunFailed(projectRoot: string, runId: string, error: unknown): void {
  const existing = readRunTask(projectRoot, runId);
  if (existing && existing.status !== "running" && existing.status !== "pending") return;

  const msg = error instanceof Error ? error.message : String(error ?? "unknown error");
  const now = new Date().toISOString();
  const run: Run = {
    id: runId,
    userGoal: existing?.userGoal ?? "",
    status: "failed",
    companyId: existing?.companyId ?? "default",
    startedAt: existing?.startedAt ?? now,
    totalTokens: existing?.totalTokens ?? 0,
    totalCostUsd: existing?.totalCostUsd ?? 0,
    participatingAgents: existing?.participatingAgents ?? [],
    deferredTasks: existing?.deferredTasks,
    accountUsage: existing?.accountUsage,
    // 收口③:保留已冻结的 workRoot——崩溃兜底重建 Run 时若丢了它,task.json 覆写后冻结工作目录只能靠
    // events.jsonl 文本推断兜底(不精确)。既有字段延续,不新增语义。
    ...(existing?.workRoot ? { workRoot: existing.workRoot } : {}),
    endedAt: now,
    degraded: true,
    degradedReason: `run failed before completion: ${msg.slice(0, 300)}`,
  };
  saveRunTask(projectRoot, run);
}

// ─── 波6 · 合并冲突人工决裁后的重新验收状态机 ──────────────────────────────────────────────
// 契约(五/Gate B):人工合并/决裁后必须【重新验收】,绝不沿用旧 verified。冲突 run 收尾时
// finalState=requires_review(死胡同);人工在决裁台把该 run 的所有冲突处理完后调用本函数:
//   - 仍有 pending 冲突 → 不迁移,保持 requires_review(局部决裁不解锁)。
//   - 全部 resolved → finalState 迁出 requires_review;但【铁律:绝不自动 verified】——即便其余信号
//     本可判 verified,也强制降到 degraded 并标 degradedReason("人工决裁,需重新验收"),等待人工重新验收。
// 无绕过路径:唯一出口是本函数,且对 verified 结果强制降级。
export interface ReverifyResult {
  runId: string;
  changed: boolean;                 // 是否发生了 finalState 迁移
  pendingRemaining: number;         // 仍未决裁的冲突数
  finalState?: Run["finalState"];   // 迁移后的终态(未迁移则为原值)
  forcedDowngrade?: boolean;        // 是否触发了"本可 verified 但强制降级"铁律
}

export function reverifyAfterConflictResolve(projectRoot: string, runId: string): ReverifyResult {
  const pending = listPendingConflictsForRun(projectRoot, runId);
  const run = loadRunTask(projectRoot, runId);
  if (!run) return { runId, changed: false, pendingRemaining: pending.length };
  if (pending.length > 0) {
    // 局部决裁:还有冲突未处理,run 保持 requires_review(不解锁)。
    return { runId, changed: false, pendingRemaining: pending.length, finalState: run.finalState };
  }
  // 全部冲突已决裁 → 以"无未决冲突"重算基线终态,再对 verified 施加铁律降级。
  const base = deriveFinalRunState({
    status: run.status,
    deliveryAcceptance: run.deliveryAcceptance,
    degraded: run.degraded,
    partialDelivery: run.partialDelivery,
    hasUnresolvedConflict: false,        // 冲突已全部决裁
    simulated: run.simulated,
    evidenceIntegrity: run.evidenceIntegrity,
  });
  const forcedDowngrade = base === "verified";
  const next: Run["finalState"] = forcedDowngrade ? "degraded" : base;
  if (run.finalState === next && !forcedDowngrade) {
    return { runId, changed: false, pendingRemaining: 0, finalState: next };
  }
  const updated: Run = {
    ...run,
    finalState: next,
    ...(forcedDowngrade
      ? {
          degraded: true,
          degradedReason: "合并冲突已由人工决裁,交付需重新验收——不自动沿用 verified(reverify-after-conflict)",
          // 诚实铁律(对抗验证 CF-P2):isDeliveryVerified 读的是 deliveryAcceptance.status 而非 finalState;
          // 只降 finalState 会让直读 status 的消费方仍见 verified。冲突决裁后交付不再是已验证态 →
          // 同步把 status 从 verified 降为 requires_review(isDeliveryVerified=false),等待人工重新验收。
          // 保留原 requiresCode/requiresTests 等字段(只覆盖 status+reasons),不破坏 Run 类型约束。
          ...(run.deliveryAcceptance
            ? {
                deliveryAcceptance: {
                  ...run.deliveryAcceptance,
                  status: "requires_review",
                  reasons: [
                    ...(run.deliveryAcceptance.reasons ?? []),
                    "合并冲突人工决裁后交付需重新验收,原 verified 结论不再沿用(reverify-after-conflict)",
                  ],
                },
              }
            : {}),
        }
      : {}),
  };
  saveRunTask(projectRoot, updated);
  return { runId, changed: true, pendingRemaining: 0, finalState: next, forcedDowngrade };
}

// ─── E3 · Run Governance 钩子(run 启动时判级 + 落 record) ────────────────────────────────
// 幂等:同 runId 只判一次(recordGovernanceDecision 内部去重)。两个入口都会调:
//   ① 路由层 precreate 之后(chatRoutes/missionRoutes,拿得到派发参数 → L3 gate 可用)
//   ② orchestrator.startRun 开头(直调 startRun 的路径——runRoutes/harness/测试——也有 record)

export interface GovernanceHookInput {
  runId: string;
  goal: string;
  companyId?: string;
  /** 显式信号(mission.permissionNeeds=external_actions 等);缺省按下方确定性规则推导 */
  involvesShell?: boolean;
  involvesMcp?: boolean;
  involvesAcp?: boolean;
  /** L3 被拦时批准后照此参数派发;不传则 L3 record 只拦不自动派发 */
  pendingDispatch?: GovernancePendingDispatch;
}

export function decideAndRecordRunGovernance(projectRoot: string, input: GovernanceHookInput): GovernanceRecord {
  const existing = getGovernanceRecord(projectRoot, input.runId);
  if (existing) return existing;

  const companyId = input.companyId ?? "default";
  let agents: { framework?: string; companyId?: string }[] = [];
  try {
    agents = loadAgents(projectRoot, []).filter(a => (a.companyId ?? "default") === companyId);
  } catch { /* agents 读不出来按空处理(全新项目):不因治理判级碰壁而拦 run */ }
  const frameworks = agents.map(a => a.framework as import("@opc/shared").AgentFramework | undefined);

  const codeHits = detectCodeSignals(input.goal);
  const writesFiles = codeHits.length > 0;
  let involvesMcp = input.involvesMcp ?? false;
  if (input.involvesMcp === undefined) {
    try { involvesMcp = listMcpServers(projectRoot).some(s => s.enabled); } catch { /* 无 MCP 配置 → false */ }
  }
  const involvesShell = input.involvesShell ?? false;
  const involvesAcp = input.involvesAcp ?? false;
  const fullHostAccess = frameworks.some(frameworkHasFullHostAccess);

  const estimate = estimateTaskComplexity({
    goalText: input.goal,
    agentCount: agents.length,
    hasCodeSignals: writesFiles ? true : undefined,
    involvesMcp: involvesMcp || undefined,
    involvesShell: involvesShell || undefined,
  });

  const decision = decideGovernanceLevel({
    frameworks,
    writesFiles,
    involvesMcp,
    involvesAcp,
    involvesShell,
    fullHostAccess,
    complexityEstimate: estimate,
  });

  const approvalRequired = decision.level === "L3";
  const record = recordGovernanceDecision(projectRoot, {
    runId: input.runId,
    level: decision.level,
    reason: decision.reason,
    inputs: {
      goalPreview: input.goal.slice(0, 200),
      companyId,
      frameworks: [...new Set(frameworks.map(f => f ?? "hermes"))],
      writesFiles,
      involvesMcp,
      involvesAcp,
      involvesShell,
      fullHostAccess,
      complexity: estimate.complexity,
      estimatorRecommendedLevel: estimate.recommended_governance_level,
    },
    ...(approvalRequired
      ? {
          approvalRequired: true,
          approval: { status: "pending" as const },
          pendingDispatch: input.pendingDispatch,
          events: [{ at: new Date().toISOString(), kind: "approval_requested" as const, detail: "L3 run 派发前需人工审批" }],
        }
      : {}),
  });
  return record;
}

/** L3 网关的批准助手:mission approve 等"本身就是人工批准动作"的路径直接放行并留痕。 */
export function approveGovernanceForRun(projectRoot: string, runId: string, decidedBy: string): GovernanceRecord | undefined {
  const record = getGovernanceRecord(projectRoot, runId);
  // 只有 pending 可批:rejected 是终态,不许被"顺路批准"翻转(与 governanceRoutes 的 409 语义一致)。
  if (!record?.approvalRequired || record.approval?.status !== "pending") return record;
  return setGovernanceApproval(projectRoot, runId, "approved", decidedBy);
}

/** 派发前闸门:未批的 L3 run 记 dispatch_blocked 事件并返回 false(调用方据此不派发)。 */
export function checkGovernanceDispatch(projectRoot: string, runId: string): { allowed: boolean; record?: GovernanceRecord } {
  const record = getGovernanceRecord(projectRoot, runId);
  if (!record?.approvalRequired) return { allowed: true, record };
  if (record.approval?.status === "approved") return { allowed: true, record };
  const updated = appendGovernanceEvent(projectRoot, runId, { kind: "dispatch_blocked", detail: `L3 审批状态 ${record.approval?.status ?? "pending"},未批不派发` });
  return { allowed: false, record: updated ?? record };
}
