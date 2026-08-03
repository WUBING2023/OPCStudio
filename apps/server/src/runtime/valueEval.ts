// 阶段2 · 最小价值评测 runner 的核心逻辑(纯函数,可单测)。
// 目标:同一确定性任务,单 Agent 基线 vs OPC 公司,同 provider/model/时间·token 上限,各重复 N 次,
// 输出成功率/机器可验质量/耗时/token·成本/deferred·degraded/人工介入/方差的对照。
// 红线:N 小(建议 2)只支持"Private Beta 初步证据",禁止据此宣传"普遍优于单 Agent"。
// 本文件只做聚合与表格;真实派发+轮询+从 .opc/runs/<runId>/result.json 抽字段由 scripts 侧 runner 做,
// 抽出的每条喂给 summarizeArm——派发不可单测(需真付费 run),聚合逻辑必须单测(此处)。

export type EvalArm = "single-agent" | "opc-company";

// 一次真实 run 抽出的证据(从 result.json + 对产物的机器核验 evalTask 得到)。
export interface ArmRunResult {
  arm: EvalArm;
  taskId: string;
  repeat: number;
  runId: string;
  finalState?: string;        // verified | degraded | failed | requires_review
  deliveryStatus?: string;    // deliveryAcceptance.status(verified/tests_ran_unbound/...)
  verified: boolean;          // 机器可验成功(benchmark.evalTask 对冻结产物核验,非仅 finalState)
  cost: number;
  tokens: number;
  durationMs: number;
  deferred: number;           // 本 run deferred 任务数
  degraded: boolean;
  humanInterventions: number; // 人工介入次数(审批/冲突决裁等)
}

export interface ArmSummary {
  arm: EvalArm;
  taskId: string;
  n: number;
  verifiedCount: number;
  successRate: number;        // verifiedCount / n(真实成功率=机器可验)
  avgCost: number;
  avgTokens: number;
  avgDurationMs: number;
  degradedCount: number;
  deferredTotal: number;
  humanInterventionsTotal: number;
  costVariance: number;       // 成本方差(N 次之间的稳定性)
  evidenceNote: string;
}

function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
}
const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// 聚合同一 (arm, taskId) 的多次重复。空输入抛错(不静默造 0 成功假象)。
export function summarizeArm(results: ArmRunResult[]): ArmSummary {
  if (!results.length) throw new Error("summarizeArm: 无 run 结果,无法聚合(不得静默造假成功)");
  const arm = results[0].arm;
  const taskId = results[0].taskId;
  if (results.some((r) => r.arm !== arm || r.taskId !== taskId)) {
    throw new Error("summarizeArm: 混入了不同 arm/taskId 的结果");
  }
  const n = results.length;
  const verifiedCount = results.filter((r) => r.verified).length;
  const costs = results.map((r) => r.cost);
  return {
    arm, taskId, n,
    verifiedCount,
    successRate: verifiedCount / n,
    avgCost: avg(costs),
    avgTokens: avg(results.map((r) => r.tokens)),
    avgDurationMs: avg(results.map((r) => r.durationMs)),
    degradedCount: results.filter((r) => r.degraded).length,
    deferredTotal: results.reduce((a, r) => a + r.deferred, 0),
    humanInterventionsTotal: results.reduce((a, r) => a + r.humanInterventions, 0),
    costVariance: variance(costs),
    evidenceNote: n < 3
      ? `N=${n}:仅 Private Beta 初步证据,禁止据此宣传"普遍优于单 Agent"`
      : `N=${n}`,
  };
}

// 对照表(Markdown)。按 taskId 分组,每组把各 arm 并列;附诚实声明。
export function comparisonMarkdown(summaries: ArmSummary[]): string {
  const byTask = new Map<string, ArmSummary[]>();
  for (const s of summaries) {
    const arr = byTask.get(s.taskId) ?? [];
    arr.push(s);
    byTask.set(s.taskId, arr);
  }
  const lines: string[] = [
    "# 最小价值评测:单 Agent vs OPC 公司",
    "",
    "> 同 provider/model、同时间·token 上限。真实成功率=机器可验(非仅 finalState)。",
    "> **N 小仅初步证据,禁止宣传「普遍优于单 Agent」。**",
    "",
    "| 任务 | 臂 | N | 成功率(可验) | 均成本 | 均token | 均耗时ms | degraded | deferred | 人工介入 | 成本方差 |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const [taskId, arr] of byTask) {
    for (const s of arr) {
      lines.push(
        `| ${taskId} | ${s.arm} | ${s.n} | ${(s.successRate * 100).toFixed(0)}% (${s.verifiedCount}/${s.n}) | ` +
        `$${s.avgCost.toFixed(5)} | ${Math.round(s.avgTokens)} | ${Math.round(s.avgDurationMs)} | ` +
        `${s.degradedCount} | ${s.deferredTotal} | ${s.humanInterventionsTotal} | ${s.costVariance.toExponential(2)} |`,
      );
    }
  }
  lines.push("", `_${summaries[0]?.evidenceNote ?? "无数据"}_`);
  return lines.join("\n");
}

// 判读辅助:OPC 是否在该任务上"净优于"单 Agent(成功率不降 且 成本不显著更高)。诚实口径:
// 需成功率严格更高或(持平且成本更低)才算净优;否则不算——绝不把"更贵更慢但没更好"美化成优势。
export function opcNetBetter(single: ArmSummary, opc: ArmSummary): { better: boolean; reason: string } {
  if (single.taskId !== opc.taskId) throw new Error("opcNetBetter: taskId 不一致");
  if (opc.successRate > single.successRate) return { better: true, reason: "OPC 成功率更高" };
  if (opc.successRate === single.successRate && opc.avgCost < single.avgCost) {
    return { better: true, reason: "成功率持平但 OPC 成本更低" };
  }
  if (opc.successRate < single.successRate) return { better: false, reason: "OPC 成功率更低" };
  return { better: false, reason: "成功率持平但 OPC 成本不更低(更复杂/更贵而无净收益)" };
}
