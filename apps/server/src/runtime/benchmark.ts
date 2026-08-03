export interface BenchmarkTask {
  id: string;
  goal: string;
  expectedFile?: string | null;
  expectedContent?: string | null;
}

// ⚠️ 这些默认任务多数【无机器可验断言】(expectedFile:null)——它们只能作为手动/演示 goal,
// 绝不产出可作为产品证据的 success。价值评测(阶段2)会另定"确定性任务族"(带 expectedFile/
// expectedContent 的真断言:Node 编码产文件、测试跑通等),不复用这批无断言 goal。
export const BENCHMARK_TASKS: BenchmarkTask[] = [
  { id: "readme", goal: "Create a README.md with project title and description", expectedFile: "README.md" },
  { id: "refactor", goal: "Fix any TypeScript type errors in this project", expectedFile: null },
  { id: "test", goal: "Write a unit test for the pathGuard module", expectedFile: null },
  { id: "docs", goal: "Add JSDoc comments to the modelGateway.ts file", expectedFile: null },
  { id: "debug", goal: "Find and fix any console.log statements that should use a proper logger", expectedFile: null },
];

export interface BenchmarkResult {
  taskId: string;
  success: boolean;      // 机器核验通过(expectedFile 存在且 expectedContent 命中)。不可核验一律 false。
  verifiable: boolean;   // 该任务是否带机器可验断言(无断言→false,success 恒 false,禁止充当证据)。
  duration: number;
  tokensUsed: number;
  cost: number;
  qualityNotes: string;
}

// 导出以便单测直接驱动机器核验逻辑(无断言→非成功;文件断言;文件+内容断言)。
export async function evalTask(
  task: BenchmarkTask,
  runId: string,
  start: number,
  getRunStats: (runId: string) => { tokens: number; cost: number } | null,
  projectRoot: string,
): Promise<BenchmarkResult> {
  const duration = Date.now() - start;
  const stats = getRunStats(runId);
  const tokensUsed = stats?.tokens ?? 0;
  const cost = stats?.cost ?? 0;
  let success: boolean;
  let verifiable: boolean;
  let qualityNotes: string;
  if (task.expectedFile) {
    // 有文件断言:文件必须存在;若还带 expectedContent,内容必须命中——才算机器核验通过。
    const fs = await import("node:fs");
    const path = await import("node:path");
    const abs = path.join(projectRoot, task.expectedFile);
    verifiable = true;
    if (!fs.existsSync(abs)) {
      success = false;
      qualityNotes = `Expected file ${task.expectedFile} not found`;
    } else if (task.expectedContent) {
      let body = "";
      try { body = fs.readFileSync(abs, "utf-8"); } catch { /* unreadable → 视为未命中 */ }
      success = body.includes(task.expectedContent);
      qualityNotes = success ? "" : `Expected file present but content did not contain the required marker`;
    } else {
      success = true;
      qualityNotes = "";
    }
  } else {
    // 关键修复(假成功):无机器可验断言的任务【绝不】自动判成功——否则 benchmark 结果全是假阳性、
    // 不能作为产品证据。标 verifiable=false + success=false,由外层如实排除出"成功证据"口径。
    verifiable = false;
    success = false;
    qualityNotes = "No machine-verifiable assertion — NOT counted as success (needs expectedFile/expectedContent to be product evidence)";
  }
  return { taskId: task.id, success, verifiable, duration, tokensUsed, cost, qualityNotes };
}

export async function runBenchmark(
  runFn: (goal: string) => Promise<{ runId: string; summary: string }>,
  getRunStats: (runId: string) => { tokens: number; cost: number } | null,
  projectRoot: string,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const task of BENCHMARK_TASKS) {
    const start = Date.now();
    try {
      const { runId } = await runFn(task.goal);
      results.push(await evalTask(task, runId, start, getRunStats, projectRoot));
    } catch (e: any) {
      results.push({ taskId: task.id, success: false, verifiable: false, duration: Date.now() - start, tokensUsed: 0, cost: 0, qualityNotes: `Error: ${e.message}` });
    }
  }
  return results;
}

// ── Phase 4: weak+memory vs strong-bare comparison (validates the differentiated-brain thesis) ──

export interface BenchmarkVariant {
  label: "weak+memory" | "strong-bare";
  provider: string;
  model: string;
  useMemorySkills: boolean; // weak+memory=true; strong-bare=false
}

export interface BenchmarkComparison {
  taskId: string;
  weak: BenchmarkResult;
  strong: BenchmarkResult;
  weakBeatsBare: boolean; // weak succeeded AND cost no higher than the strong bare baseline
}

export async function runBenchmarkComparison(
  runVariant: (goal: string, variant: BenchmarkVariant) => Promise<{ runId: string }>,
  getRunStats: (runId: string) => { tokens: number; cost: number } | null,
  projectRoot: string,
  variants: { weak: BenchmarkVariant; strong: BenchmarkVariant },
): Promise<BenchmarkComparison[]> {
  const out: BenchmarkComparison[] = [];
  for (const task of BENCHMARK_TASKS) {
    const runVar = async (v: BenchmarkVariant): Promise<BenchmarkResult> => {
      const start = Date.now();
      try {
        const { runId } = await runVariant(task.goal, v);
        return await evalTask(task, runId, start, getRunStats, projectRoot);
      } catch (e: any) {
        return { taskId: task.id, success: false, verifiable: false, duration: Date.now() - start, tokensUsed: 0, cost: 0, qualityNotes: `Error: ${e.message}` };
      }
    };
    const weak = await runVar(variants.weak);
    const strong = await runVar(variants.strong);
    out.push({ taskId: task.id, weak, strong, weakBeatsBare: weak.success && weak.cost <= strong.cost });
  }
  return out;
}

export function benchmarkComparisonTable(comparisons: BenchmarkComparison[]): string {
  const rows = comparisons.map((c) =>
    `| ${c.taskId} | ${c.weak.success ? "✅" : "❌"} $${c.weak.cost.toFixed(5)} | ${c.strong.success ? "✅" : "❌"} $${c.strong.cost.toFixed(5)} | ${c.weakBeatsBare ? "✅ 弱胜" : "—"} |`,
  );
  const wins = comparisons.filter((c) => c.weakBeatsBare).length;
  return [
    "# Benchmark：弱模型+记忆 vs 强模型裸跑",
    "",
    "| 任务 | 弱+记忆 | 强裸跑 | 弱模型胜出 |",
    "|------|---------|--------|-----------|",
    ...rows,
    "",
    `**结论**：${wins}/${comparisons.length} 任务上「弱模型+记忆」达到成功且成本 ≤ 强模型裸跑。`,
  ].join("\n");
}
