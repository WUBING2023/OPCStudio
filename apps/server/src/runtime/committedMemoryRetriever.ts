// WS4 · Committed Memory Retriever — cross-run memory injection for contextBuilder.
// Reads CommittedMemory entries from .opc/runs/*/committed-memories.json (written by
// orchestrator at the end of each clean run) and returns those most relevant to the
// current goal, ranked by keyword overlap + confidence + recency.
// Contract: NEVER throws. Every code path returns [] on any error (best-effort).

import * as fs from "node:fs";
import * as path from "node:path";
import type { CommittedMemory } from "./memoryCommit.js";
import { normalizeRole } from "./memoryCommit.js";
import { normalizeCompanyId } from "@opc/shared";
import { tokenize, tokenOverlap } from "../storage/textTokenize.js";
import { loadReuseStats, type MemoryReuseStat } from "../storage/memoryReuseStore.js";

// Stage 4 · 角色隔离规则:无 role(旧条目/共享)→可见;非 agent scope(project/team/run)→共享可见;
// scope=agent → 严格 role 匹配(归一小写)。调用方 role 未知时看不到 agent 私有记忆。
export function isVisibleToRole(entry: CommittedMemory, agentRole: string | undefined): boolean {
  if (entry.role === undefined) return true;
  if (entry.scope !== "agent") return true;
  const ar = normalizeRole(agentRole);
  return ar !== undefined && normalizeRole(entry.role) === ar;
}

// Scan at most this many past run dirs (most-recent-first) to keep startup latency low.
const MAX_RUNS_TO_SCAN = 30;
// Minimum confidence to even consider an entry.
const MIN_CONFIDENCE = 0.5;
// Per-entry content snippet length (characters).
const MAX_SNIPPET_CHARS = 200;

// Splits a goal string into a Set of meaningful tokens, used for relevance.
// P1#7: delegates to the shared tokenize() so CJK text (no spaces) doesn't collapse into one
// giant token — see textTokenize.ts for why a plain space/punctuation split degrades to recency.
function goalTokens(goal: string): Set<string> {
  return new Set(tokenize(goal).slice(0, 40));
}

// D3 · 复用结果加权(reuse-log.jsonl 的验证回路反馈进检索排序;比率制天然封顶,替代 raw hits 自增强):
// 加成 = 0.2 * cleanRuns/(injected+1) —— cleanRuns ≤ injected ⇒ 恒 < +0.2,注入次数越多分母越大,
// 必须持续产出干净 run 才能维持加成(不会像 raw hits 一样单调自增强);
// 惩罚:failedRuns 占优(> cleanRuns)→ -0.2(注入后 run 常失败的记忆沉底;confidence 底分仍在,
// 不做硬排除——过滤规则保守,防误杀通用记忆)。无 stats(从未注入过/日志缺失)→ 0,与引入前行为一致。
function outcomeWeight(stat: MemoryReuseStat | undefined): number {
  if (!stat || stat.injected <= 0) return 0;
  const bonus = 0.2 * (stat.cleanRuns / (stat.injected + 1));
  const penalty = stat.failedRuns > stat.cleanRuns ? -0.2 : 0;
  return bonus + penalty;
}

// Returns a relevance score for a CommittedMemory entry.
// score = confidence (base) + 0.3 per token that appears in content + outcomeWeight(复用结果加权,D3)
//         + taskType 相关性(D1:同类任务 +0.5)。
// Returns -1 if the entry should be excluded (confidence below threshold, 或 D1 的 taskType 硬闸)。
// P1#7: both the query tokens AND the content are tokenized before matching (was: raw substring
// .includes() against an un-tokenized content string, which for CJK goals almost never hit).
// D1 · taskType 相关性闸(codex 问题6:conf=1.0 快排结论零重叠也被注进 HTTP 任务)——保守设计:
//   · overlap>0 一律保留(唯一返回 -1 的 taskType 路径都要求 overlap===0,绝不误杀有关键词重叠的通用记忆);
//   · 仅当 overlap===0 且当前任务与该条目**都**明确带 taskType 且不相等 → 硬排除(-1),挡跨领域噪声;
//   · taskType 匹配 → +0.5,即便零重叠也救回(同类任务的经验值得复用);
//   · 老条目无 taskType(或调用方未传 taskType)→ 跳过 taskType 判定,仅靠 overlap 闸,行为与引入前一致(向后兼容)。
function scoreEntry(entry: CommittedMemory, tokens: Set<string>, reuseStats?: Map<string, MemoryReuseStat>, taskType?: string): number {
  if (entry.confidence < MIN_CONFIDENCE) return -1;
  const overlap = tokenOverlap(entry.content, tokens);
  let taskBonus = 0;
  if (taskType && entry.taskType) {
    if (entry.taskType === taskType) taskBonus = 0.5;
    else if (overlap === 0) return -1;
  }
  return entry.confidence + overlap * 0.3 + outcomeWeight(reuseStats?.get(entry.memoryId)) + taskBonus;
}

// 失败/降级/simulated run 的结论隔离(护栏):真相源提取到 storage/runInjectionPolicy.ts(收口作战令
// 一.2:storage 不得反向 import runtime;memoryStore 与本模块共用同一无状态 policy)。这里保留同名
// re-export,既有 import 面(记忆页/测试)不破。语义详见 policy 模块顶注。
import { runExcludedFromInjection, isFromExcludedRun } from "../storage/runInjectionPolicy.js";
export { isFromExcludedRun };

// Reads and parses a single committed-memories.json; returns [] on any error.
function readCommittedFile(filePath: string): CommittedMemory[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is CommittedMemory =>
        e !== null &&
        typeof e === "object" &&
        typeof e.memoryId === "string" &&
        typeof e.content === "string" &&
        typeof e.confidence === "number",
      // 注:companyId 是加性可选字段——旧 committed-memories.json 无此字段照常解析(=无归属),不参与形状校验。
    );
  } catch {
    return [];
  }
}

/**
 * Retrieves committed memories from past runs relevant to the current goal.
 *
 * @param projectRoot   - The OPC project root (same as contextBuilder receives).
 * @param goal          - The current agent's goal string (used for keyword relevance).
 * @param currentRunId  - The in-flight run's ID; its directory is excluded so a run
 *                        never reads its own (still-incomplete) committed memories.
 * @param charBudget    - Total character budget for all returned entries' content.
 *                        Defaults to 800 chars to stay well inside context limits.
 * @returns             CommittedMemory[] sorted by relevance, within charBudget.
 *                      Always returns [] rather than throwing.
 */
// Stage 2 · 记忆可见最小:列举跨 run 的已提交记忆(真记忆,非空的 4 层 memoryStore),
// 供「员工档案/记忆面板」展示。按 recency 排序,带来源 runId。NEVER throws → [] on error。
export interface ListedCommittedMemory extends CommittedMemory {
  runId: string;
}
export function listAllCommittedMemories(
  projectRoot: string,
  opts?: { scope?: string; type?: string; minConfidence?: number; limit?: number; role?: string },
): ListedCommittedMemory[] {
  try {
    const runsDir = path.join(projectRoot, ".opc", "runs");
    if (!fs.existsSync(runsDir)) return [];
    const { scope, type, minConfidence = 0, limit = 200, role } = opts ?? {};
    let dirs: string[];
    try {
      dirs = fs.readdirSync(runsDir)
        .map((d) => { let m = 0; try { m = fs.statSync(path.join(runsDir, d)).mtimeMs; } catch { /* */ } return { d, m }; })
        .sort((a, b) => b.m - a.m)
        .map((x) => x.d);
    } catch { return []; }
    const out: ListedCommittedMemory[] = [];
    for (const d of dirs) {
      for (const e of readCommittedFile(path.join(runsDir, d, "committed-memories.json"))) {
        if (scope && e.scope !== scope) continue;
        if (type && e.type !== type) continue;
        if (e.confidence < minConfidence) continue;
        if (role && !isVisibleToRole(e, role)) continue; // Stage 4:按 role 隔离(scope=agent 私有记忆)
        out.push({ ...e, runId: d });
        if (out.length >= limit) return out;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function retrieveCommittedMemories(
  projectRoot: string,
  goal: string,
  currentRunId: string,
  charBudget = 800,
  agentRole?: string, // Stage 4:当前 agent 角色,用于按 role 隔离注入(scope=agent 私有记忆)
  reuseStats?: Map<string, MemoryReuseStat>, // D3:复用结果统计(测试可注入;缺省从 reuse-log.jsonl 现读)
  opts?: { taskType?: string; companyId?: string }, // D1:任务类型;C12-P0:当前 agent 公司(注入侧公司硬隔离)
): CommittedMemory[] {
  try {
    const runsDir = path.join(projectRoot, ".opc", "runs");
    if (!fs.existsSync(runsDir)) return [];

    // List run subdirectories, sort most-recent first by mtime, cap at MAX_RUNS_TO_SCAN.
    let scanDirs: string[];
    try {
      const entries = fs.readdirSync(runsDir);
      scanDirs = entries
        .filter((d) => d !== currentRunId)
        .map((d) => {
          let mtime = 0;
          try { mtime = fs.statSync(path.join(runsDir, d)).mtimeMs; } catch { /* skip */ }
          return { d, mtime };
        })
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, MAX_RUNS_TO_SCAN)
        .map((x) => x.d);
    } catch {
      return [];
    }

    // Collect all valid CommittedMemory entries from scanned dirs.
    // 护栏:失败/降级 run 的目录整体跳过(其结论不进 prompt)。每目录只读一次 task.json(O(dirs),非 O(n²))。
    const all: CommittedMemory[] = [];
    for (const d of scanDirs) {
      if (runExcludedFromInjection(runsDir, d)) continue;
      const file = path.join(runsDir, d, "committed-memories.json");
      all.push(...readCommittedFile(file));
    }
    if (all.length === 0) return [];

    // Score, filter, and sort. Stage 4:先按 role 隔离(scope=agent 私有记忆只对同 role 可见),再打分。
    // D3:打分叠加复用结果加权(loadReuseStats NEVER throws,空日志 → 空 Map → 加权恒 0,行为不变)。
    const stats = reuseStats ?? loadReuseStats(projectRoot);
    const tokens = goalTokens(goal);
    // C12-P0 · 公司硬隔离(注入侧):opts.companyId 设了 → 只注入 companyId 相等的条目;不同公司 **及无归属**
    // (legacy 无 companyId)条目一律不注入(照 reflectionStore lessons 先例)。未传 companyId(无公司作用域的
    // 调用点)→ 不隔离,零回归。展示/待批路径(listAllCommittedMemories)不做此隔离,失败/无归属结论仍可见。
    // 令二.3:查询侧归一(记录侧不归一 → legacy 无 companyId 条目一律不匹配,被硬隔离)。
    const companyId = opts?.companyId ? normalizeCompanyId(opts.companyId) : undefined;
    const scored = all
      .filter((e) => isVisibleToRole(e, agentRole))
      .filter((e) => !companyId || e.companyId === companyId)
      .map((e) => ({ e, score: scoreEntry(e, tokens, stats, opts?.taskType) }))
      .filter((x) => x.score >= 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          // tie-break by recency (ISO strings sort lexicographically)
          (b.e.createdAt > a.e.createdAt ? 1 : -1),
      );

    // Select entries within char budget.
    const result: CommittedMemory[] = [];
    let used = 0;
    for (const { e } of scored) {
      const snippet = e.content.slice(0, MAX_SNIPPET_CHARS);
      if (used + snippet.length > charBudget) break;
      result.push(e);
      used += snippet.length;
    }
    return result;
  } catch {
    return [];
  }
}
