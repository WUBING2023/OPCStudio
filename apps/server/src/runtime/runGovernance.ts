import type { AgentFramework, TaskComplexityEstimate } from "@opc/shared";

// Track E E3 · Run Governance 判级(重构指南 §8 E3/E4)。纯函数、零 IO——输入由调用方
// (runLifecycle.decideAndRecordRunGovernance)取好再传进来,规则全部确定性、可单测。
//
// 四级语义(与指南 Run Governance 章节对齐):
//   L0 只记录        —— 只读/直答类任务,落 governance record 即可,不加任何监督动作
//   L1 契约检查      —— 涉及产出落盘 → quality gate(A5 runQualityGateLayers)按 level 计强度
//   L2 观察          —— 外部工具面(MCP/ACP)或子进程型 CLI 后端 → workspace 文件变更记录进 record
//   L3 审批 + kill 面 —— shell/文件系统级操作 → pid registry + 按 runId kill + 派发前人工审批
//
// 与 taskComplexityEstimator 的 recommended_governance_level(0-3)合流:一致时直接采纳;
// 冲突时取较严格者,并在 reason 里写明两边各判了什么。

export type GovernanceLevel = "L0" | "L1" | "L2" | "L3";

export const GOVERNANCE_LEVELS: readonly GovernanceLevel[] = ["L0", "L1", "L2", "L3"];

export function governanceLevelRank(level: GovernanceLevel): 0 | 1 | 2 | 3 {
  return GOVERNANCE_LEVELS.indexOf(level) as 0 | 1 | 2 | 3;
}

export function governanceLevelFromRank(rank: number): GovernanceLevel {
  return GOVERNANCE_LEVELS[Math.max(0, Math.min(3, Math.round(rank)))];
}

// 子进程型后端:api 之外的执行框架都以真实 CLI 子进程运行(claude-code/codex/12+1 generic-cli),
// 自带文件/终端工具面 → 至少 L2 观察。api(ApiEngine)是 in-process tool-loop,不 spawn 任何子进程,
// 工具面是 OPC 自己的 tools.ts(runShell 按角色 shellMode 拦截 + runWithAgent 身份隔离),不单独因
// 后端类型升级——真 shell 信号仍由 involvesShell 独立触发 L3。"hermes" 是 api 的历史 id(存量
// agents.json 不改写,读侧 alias),同 api 对待。
function hasCliBackend(frameworks: (AgentFramework | undefined)[]): boolean {
  return frameworks.some(f => f !== undefined && f !== "api" && f !== "hermes");
}

export interface GovernanceDecisionInput {
  /** 参与本 run 的 agent 执行后端(公司过滤后的 agents.framework;undefined 视作 api) */
  frameworks: (AgentFramework | undefined)[];
  /** 是否涉及写文件/代码产出(调用方从 goal 代码信号或 mission.permissionNeeds 判) */
  writesFiles: boolean;
  involvesMcp: boolean;
  involvesAcp: boolean;
  involvesShell: boolean;
  /** The selected executor cannot enforce file, shell or network boundaries at OS level. */
  fullHostAccess?: boolean;
  /** E1 复杂度预估(可选):其 recommended_governance_level 参与合流 */
  complexityEstimate?: Pick<TaskComplexityEstimate, "complexity" | "recommended_governance_level">;
}

export interface GovernanceDecision {
  level: GovernanceLevel;
  reason: string[];
}

export function decideGovernanceLevel(input: GovernanceDecisionInput): GovernanceDecision {
  const reason: string[] = [];
  let rank: 0 | 1 | 2 | 3 = 0;
  const raise = (to: 0 | 1 | 2 | 3, why: string) => {
    if (to > rank) { rank = to; reason.push(why); }
    else reason.push(`${why}(等级已不低于 ${governanceLevelFromRank(to)},不再升档)`);
  };

  if (input.writesFiles) raise(1, "涉及写文件/代码产出 → 至少 L1(产出走质量门契约检查)");
  if (input.involvesMcp) raise(2, "涉及 MCP 工具调用 → 至少 L2(workspace 观察记录)");
  if (input.involvesAcp) raise(2, "涉及 ACP 外部 agent → 至少 L2(workspace 观察记录)");
  if (hasCliBackend(input.frameworks)) raise(2, "含 CLI 子进程型执行后端(非 API 引擎)→ 至少 L2(workspace 观察记录)");
  if (input.fullHostAccess) raise(3, "外部 CLI 当前以完整宿主权限执行且无法强制收窄 → L3(派发前人工审批)");
  if (input.involvesShell) raise(3, "涉及 shell/文件系统操作 → L3(pid 登记 + 可 kill + 派发前人工审批)");
  if (reason.length === 0) reason.push("无写文件/MCP/ACP/shell/CLI 后端信号 → L0 只记录");

  const ruleLevel = governanceLevelFromRank(rank);

  const est = input.complexityEstimate;
  if (est && typeof est.recommended_governance_level === "number") {
    const estRank = Math.max(0, Math.min(3, est.recommended_governance_level)) as 0 | 1 | 2 | 3;
    const estLevel = governanceLevelFromRank(estRank);
    if (estRank === rank) {
      reason.push(`复杂度预估(${est.complexity})建议 ${estLevel},与规则判级一致,直接采纳`);
    } else if (estRank > rank) {
      rank = estRank;
      reason.push(`复杂度预估(${est.complexity})建议 ${estLevel} 高于规则判级 ${ruleLevel},取较严格者 ${estLevel}`);
    } else {
      reason.push(`复杂度预估(${est.complexity})建议 ${estLevel} 低于规则判级 ${ruleLevel},取较严格者 ${ruleLevel}`);
    }
  }

  return { level: governanceLevelFromRank(rank), reason };
}
