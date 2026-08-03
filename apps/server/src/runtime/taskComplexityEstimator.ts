import type { ComplexityTier, ComplexityRiskLevel, TaskComplexityEstimate } from "@opc/shared";

// Track E E1:Task Complexity Estimator v1(重构指南 §7)。
// 纯函数、零 IO:输入由调用方(missionRoutes/goalRoutes)从 mission/goal/公司结构里取好再传进来。
// 第一版是纯规则估算,不依赖历史数据(historyAvgMinutes 有值时只影响时长与置信度);
// reason 数组里的每一条都对应一条真实命中的规则,可解释、可追溯——不许出现没命中规则的空话。
// Estimator 不决定任务成败,只给 Studio Core / Run Governance / 用户提供可解释预估(指南 §7 原话)。

export interface TaskComplexityInput {
  /** 任务目标文本(mission.interpretedGoal / goal 原文) */
  goalText: string;
  /** 该公司可参与的 agent 数量(调用方从 agents.json 按 companyId 过滤后计数) */
  agentCount?: number;
  /** 是否涉及代码:调用方可显式指定(如 mission.permissionNeeds=write_code);缺省时从 goal 文本关键词判 */
  hasCodeSignals?: boolean;
  /** 预计产出 artifact 数(mission.expectedArtifacts.length;goal 场景通常未知) */
  expectedArtifactCount?: number;
  involvesMcp?: boolean;
  involvesShell?: boolean;
  /** 历史相似任务平均耗时(分钟);v1 不自动挖历史,调用方有数据就传 */
  historyAvgMinutes?: number;
}

// 代码信号关键词:中文子串匹配 + 英文词边界匹配(防 "api" 匹配进 "rapid" 这类误伤)。
const CODE_KEYWORDS_CJK = [
  "代码", "编程", "脚本", "重构", "函数", "接口", "组件", "模块", "前端", "后端",
  "编译", "单元测试", "修复bug", "写文件", "改文件", "文件改动", "建站", "网页", "爬虫", "数据库",
];
const CODE_KEYWORDS_ASCII = [
  "code", "coding", "refactor", "implement", "script", "debug", "bug",
  "python", "typescript", "javascript", "java", "sql", "html", "css", "api", "sdk", "cli",
];

// 调研广度关键词:命中说明任务需要展开面上的信息收集/比较,而非单点直答。
const RESEARCH_KEYWORDS_CJK = [
  "调研", "研究", "分析", "对比", "评测", "竞品", "市场", "全面", "深入", "综述", "报告",
];
const RESEARCH_KEYWORDS_ASCII = ["survey", "research", "analysis", "compare", "benchmark"];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchKeywords(text: string, cjk: string[], ascii: string[]): string[] {
  const hits: string[] = [];
  for (const kw of cjk) if (text.includes(kw)) hits.push(kw);
  for (const kw of ascii) if (new RegExp(`\\b${escapeRegExp(kw)}\\b`, "i").test(text)) hits.push(kw);
  return hits;
}

/** 从 goal 文本判代码信号,返回命中的关键词列表(空数组=无信号)。导出供调用方/测试复用。 */
export function detectCodeSignals(goalText: string): string[] {
  return matchKeywords(goalText, CODE_KEYWORDS_CJK, CODE_KEYWORDS_ASCII);
}

const DURATION_BANDS: Record<ComplexityTier, [number, number]> = {
  S: [1, 2],    // 指南 §7:S 简单 1-2 分钟
  M: [3, 8],    // M 中等 3-8 分钟
  L: [8, 20],   // L 复杂 8-20 分钟
  XL: [20, 60], // XL 大型任务,建议拆分
};

const BASE_GOVERNANCE: Record<ComplexityTier, 0 | 1 | 2 | 3> = { S: 0, M: 1, L: 2, XL: 3 };

export function estimateTaskComplexity(input: TaskComplexityInput): TaskComplexityEstimate {
  const goalText = (input.goalText ?? "").trim();
  const reason: string[] = [];
  let score = 0;

  // 规则 1:goal 文本长度 → 任务范围的粗代理。
  const len = goalText.length;
  if (len > 800) { score += 3; reason.push(`目标描述很长(${len} 字),任务范围大`); }
  else if (len > 300) { score += 2; reason.push(`目标描述较长(${len} 字),包含较多要求`); }
  else if (len >= 80) { score += 1; reason.push(`目标描述中等长度(${len} 字)`); }
  else { reason.push(`目标描述较短(${len} 字),范围有限`); }

  // 规则 2:调研广度关键词。
  const researchHits = matchKeywords(goalText, RESEARCH_KEYWORDS_CJK, RESEARCH_KEYWORDS_ASCII);
  if (researchHits.length > 0) {
    score += 1;
    reason.push(`命中调研/分析类关键词:${researchHits.slice(0, 3).join("、")}`);
  }

  // 规则 3:代码信号(显式传入优先;缺省从文本关键词判)。
  const codeHits = detectCodeSignals(goalText);
  const hasCode = input.hasCodeSignals ?? codeHits.length > 0;
  if (hasCode) {
    score += 2;
    reason.push(codeHits.length > 0
      ? `涉及代码/文件改动(命中关键词:${codeHits.slice(0, 3).join("、")})`
      : "涉及代码/文件改动(调用方标记)");
  }

  // 规则 4:预计 artifact 数量。
  const artifacts = input.expectedArtifactCount ?? 0;
  if (artifacts >= 3) { score += 2; reason.push(`预计产出 ${artifacts} 个 artifact,多产物任务`); }
  else if (artifacts === 2) { score += 1; reason.push("预计产出 2 个 artifact"); }

  // 规则 5:公司 agent 规模(协作/协调成本)。
  const agentCount = input.agentCount ?? 0;
  if (agentCount >= 8) { score += 2; reason.push(`公司规模较大(${agentCount} 名 agent),协调成本高`); }
  else if (agentCount >= 4) { score += 1; reason.push(`需要多角色协作(${agentCount} 名 agent)`); }

  // 规则 6:MCP / shell-filesystem 涉入(既加复杂度分,也在下面强制抬监督等级)。
  if (input.involvesMcp) { score += 1; reason.push("涉及 MCP 工具调用"); }
  if (input.involvesShell) { score += 1; reason.push("涉及 shell/文件系统操作"); }

  // 档位:score 0-1=S,2-3=M,4-6=L,>=7=XL。
  const complexity: ComplexityTier = score <= 1 ? "S" : score <= 3 ? "M" : score <= 6 ? "L" : "XL";
  if (complexity === "XL") reason.push("综合评分达到 XL 档,建议拆分为多个子任务");

  // 监督等级:按档位起步,代码/MCP 至少 2,shell 至少 3(升档时给出对应 reason)。
  let governance: 0 | 1 | 2 | 3 = BASE_GOVERNANCE[complexity];
  if (hasCode && governance < 2) { governance = 2; reason.push("涉及代码改动,监督等级升至 2"); }
  if (input.involvesMcp && governance < 2) { governance = 2; reason.push("涉及 MCP,监督等级升至 2"); }
  if (input.involvesShell && governance < 3) { governance = 3; reason.push("涉及 shell/文件系统,监督等级升至 3"); }

  // 风险:按最重的信号取值(shell > 代码/MCP/XL > 一般 > S 简单)。
  let risk: ComplexityRiskLevel = complexity === "S" ? "low" : "standard";
  if (complexity === "XL" || hasCode || input.involvesMcp) risk = "elevated";
  if (input.involvesShell) risk = "high";

  // 时长:按档位取带;有历史均值则围绕历史收窄并提升置信度。
  let [minMinutes, maxMinutes] = DURATION_BANDS[complexity];
  let confidence: "low" | "medium" | "high" = complexity === "S" || complexity === "M" ? "medium" : "low";
  if (typeof input.historyAvgMinutes === "number" && Number.isFinite(input.historyAvgMinutes) && input.historyAvgMinutes > 0) {
    minMinutes = Math.max(1, Math.round(input.historyAvgMinutes * 0.5));
    maxMinutes = Math.max(minMinutes + 1, Math.round(input.historyAvgMinutes * 1.5));
    confidence = "high";
    reason.push(`历史同类任务平均 ${input.historyAvgMinutes} 分钟完成`);
  }

  return {
    complexity,
    risk_level: risk,
    estimated_duration: { min_minutes: minMinutes, max_minutes: maxMinutes, confidence },
    recommended_governance_level: governance,
    reason,
  };
}
