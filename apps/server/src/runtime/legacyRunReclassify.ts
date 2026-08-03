import * as fs from "node:fs";
import * as path from "node:path";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadRunReport, updateRunIndex } from "../storage/projectStore.js";
import { checkTextIntegrity } from "../security/inputIntegrity.js";

// 审计 P2 · 历史 run 重分类(幂等启动期一次性迁移,与 startupReconcile 同规):.opc/runs 里存在
// 两类"账目不实"的旧 run —— ①输出是失败文本(如 "API call failed after 3 retries")却 status 成功;
// ②content/goal 已是不可逆编码损坏(乱码,U+FFFD 成堆)。二者都被当作纯净成功计入台账/记忆,污染统计。
// 本迁移只给 task.json 补 degraded 标注字段(不改 status 本身,避免连锁;UI 徽章按 degraded 呈现),
// 绝不删除/移动任何证据文件(report.md/events/trace 原样保留)。双重幂等:①一次性标记文件防重扫,
// ②即便标记丢失,per-run"已 degraded 即跳过"守卫保证不重复打标。

const MARKER_VERSION = 1;
const SUCCESS_STATUS = new Set(["done", "completed", "accepted"]);

const FAIL_TEXT_REASON = "legacy:输出为失败文本,历史数据重分类";
const GARBLED_REASON = "legacy:content/goal 编码损坏(乱码),历史数据重分类";
const UNVERIFIED_TESTS_REASON = "legacy:测试通过来自 auto-detected(跑到源码树自身而非本 run 产物),成功证据不可信,历史数据重分类";

// 失败特征文本 pattern 表 —— 均为 OPC harness / provider 的具体错误串,几乎不会作为正常交付内容出现:
//   · "API call failed"(重试耗尽的固定文案)、"Provider unavailable"、"after N retries"
//   · HTTP 4xx/5xx(必须带 "HTTP" 字面量或标准 reason 短语,避免把正文里的三位数字如 "574 行"误判)
const FAILURE_PATTERNS: RegExp[] = [
  /API call failed/,
  /Provider unavailable/i,
  /\bafter \d+ retries?\b/i,
  /(^|\n)\s*HTTP\/?[\d.]*\s*[45]\d\d\b/i,
  /(^|\n)\s*[45]\d\d\s+(Bad Request|Unauthorized|Forbidden|Not Found|Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
];

// 报告页脚(`<sub>OPC Studio · 目标: …</sub>`)会回显 goal,可能把用户 goal 文本带进匹配面 —— 匹配失败
// 特征前先剥掉页脚,只看正文,避免"用户 goal 恰好含错误串"这类边角误判。
function stripReportFooter(md: string): string {
  return md.replace(/<sub>OPC Studio[\s\S]*$/i, "");
}

export function reportHasFailureText(report: string): boolean {
  if (!report) return false;
  const body = stripReportFooter(report);
  return FAILURE_PATTERNS.some((p) => p.test(body));
}

export type LegacyReclassifyKind = "failure-text" | "garbled" | "unverified-tests";

export interface LegacyReclassifyResult {
  scanned: number;
  reclassified: number;
  skippedMarker: boolean;
  touched: Array<{ id: string; kind: LegacyReclassifyKind }>;
}

function markerPathFor(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "legacy-run-reclassify.v1.json");
}

// 判定单个 run 应否重分类:命中返回 kind,否则 null。纯函数,便于测试。
// - failure-text:仅当 status 成功(把失败伪装成成功的才是要修的账),且报告正文含失败特征文本。
// - garbled:goal 或报告内容任一编码损坏(status 无关,损坏内容本身就不该计成纯净产出)。
// - unverified-tests:status 成功且 structured-report.tests.passed=true,但 tests.command="auto-detected"
//   —— 该模式会跑到 OPC 源码树自身的 vitest(而非本 run workRoot 的产物测试,真实案例 ab4b1c14 编码 smoke
//   的 output 即 OPC 自己的 vitest RUN),这个"通过"是虚假证据,不能作为成功背书。诚实测试(command 为
//   明确命令,或 command="none"/passed=false 如实标注没跑,如调研类 run)不命中。
export function classifyLegacyRun(
  task: { status?: unknown; userGoal?: unknown; goal?: unknown },
  report: string,
  evidence?: { tests?: { passed?: unknown; command?: unknown } | null },
): LegacyReclassifyKind | null {
  const status = typeof task.status === "string" ? task.status : "";
  if (SUCCESS_STATUS.has(status) && reportHasFailureText(report)) return "failure-text";
  const goal = (typeof task.userGoal === "string" ? task.userGoal : "") || (typeof task.goal === "string" ? task.goal : "");
  if (checkTextIntegrity(goal).corrupted || checkTextIntegrity(report).corrupted) return "garbled";
  const tests = evidence?.tests;
  if (SUCCESS_STATUS.has(status) && tests && tests.passed === true && tests.command === "auto-detected") return "unverified-tests";
  return null;
}

export function reclassifyLegacyRunsOnStartup(projectRoot: string): LegacyReclassifyResult {
  const result: LegacyReclassifyResult = { scanned: 0, reclassified: 0, skippedMarker: false, touched: [] };

  // 幂等守卫①:一次性标记文件已存在 → 整体跳过,绝不重扫。
  const markerPath = markerPathFor(projectRoot);
  try {
    if (readJSON<unknown>(markerPath, null) !== null) {
      result.skippedMarker = true;
      return result;
    }
  } catch { /* 标记不可读 → 继续(下方 per-run 守卫仍保证不重复打标) */ }

  const runsDir = path.join(projectRoot, ".opc", "runs");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(runsDir);
  } catch {
    return result; // runs 目录不存在,无需迁移
  }

  for (const dir of dirs) {
    const taskPath = path.join(runsDir, dir, "task.json");
    try {
      const task = readJSON<any>(taskPath, null);
      if (!task || typeof task !== "object" || typeof task.status !== "string") continue; // 非 run/损坏/空
      result.scanned++;
      // 幂等守卫②:已 degraded 的 run 已被正确分类,不重复打标、不覆盖其原有 degradedReason。
      if (task.degraded === true) continue;

      const report = loadRunReport(projectRoot, dir) ?? "";
      let tests: { passed?: unknown; command?: unknown } | null = null;
      try {
        const sr = readJSON<any>(path.join(runsDir, dir, "structured-report.json"), null);
        if (sr && typeof sr === "object" && sr.tests && typeof sr.tests === "object") tests = sr.tests;
      } catch { /* 无 structured-report → tests 保持 null */ }
      const kind = classifyLegacyRun(task, report, { tests });
      if (!kind) continue;

      task.degraded = true;
      task.degradedReason = kind === "failure-text" ? FAIL_TEXT_REASON : kind === "garbled" ? GARBLED_REASON : UNVERIFIED_TESTS_REASON;
      task.legacyReclassified = true;
      writeJSON(taskPath, task); // 只改标注字段,原子写(与 startupReconcile 同规)
      const id: string = typeof task.id === "string" ? task.id : dir;
      // 滚动索引同步(否则任务档案卡徽章陈旧);merge 语义:已存在条目只覆盖 degraded 相关字段。
      updateRunIndex(projectRoot, {
        id,
        status: task.status,
        degraded: true,
        degradedReason: task.degradedReason,
        goal: (typeof task.userGoal === "string" ? task.userGoal : typeof task.goal === "string" ? task.goal : "").slice(0, 200),
        startedAt: typeof task.startedAt === "string" ? task.startedAt : "",
      });
      result.reclassified++;
      result.touched.push({ id, kind });
    } catch {
      // best-effort:单个 run 的 task.json 缺失/损坏不影响其余 run 与服务启动
    }
  }

  // 迁移完成 → 写标记防重跑(即便本次 reclassified=0:扫描已完成,盘上已无待迁移项)。
  try {
    writeJSON(markerPath, {
      version: MARKER_VERSION,
      ranAt: new Date().toISOString(),
      scanned: result.scanned,
      reclassified: result.reclassified,
      touched: result.touched,
    });
  } catch { /* 标记写失败:下次启动会重扫,但 per-run 守卫保证幂等,不会重复打标 */ }

  return result;
}
