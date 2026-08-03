import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { startRun } from "./orchestrator.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadRunIndex, loadRunReport } from "../storage/projectStore.js";

// Harness 内核:goal(验收达成即停)与 loop(开放式持续推进)共用同一个迭代引擎——
// startRun → 读报告 → judge → 决定 停/续 → 缺口/方向回灌下一轮。两种模式只是 adapter 不同。
// 另辖"自动化队列":agent 在 run 里调用 schedule_goal/schedule_loop 工具时不能立刻起跑
// (会撞单 run 互斥),入队;调度器在系统空闲时(无 run/goal/loop 在飞)自动开跑。

// ── 迭代引擎 ────────────────────────────────────────────────────────────────────

export interface IterationOutcome {
  stop: boolean;            // adapter 判定:本轮后是否停止(goal=达成;loop=永 false,靠上限)
  roundNote: string;        // 本轮一句话(记录用)
  feedForward: string;      // 回灌到下一轮 directive 的增量指引(空=原样重跑)
}

export interface IterationAdapter {
  kind: "goal" | "loop";
  maxRounds: number;
  maxHours: number;
  /** 每轮 run 结束后的复盘/验收(报告可能为空串)。抛错由内核按"保守继续"处理。 */
  judge(originalPrompt: string, reportMd: string, runId: string): Promise<IterationOutcome>;
  /** 每轮落账(runId 为空串=run 启动失败)。内核在 judge 后调用;由 adapter 持久化自己的记录。 */
  onRound(round: number, runId: string, outcome: IterationOutcome | null, error?: string): void;
  /** 外部停止信号(用户点了停止)。 */
  stopRequested(): boolean;
  /**
   * 反馈回路(harness/loop engineering 的人机协作面):
   * - awaitUserGate(有值时=每轮确认模式):本轮判定后停下等用户——返回 continue(可带反馈)或 stop。
   *   adapter 负责把"等待中"状态持久化给 UI 看;内核只 await。
   * - pendingFeedback(方向盘):不打断的异步捎话——内核在拼下一轮 directive 前取一次(取后由 adapter 清空),
   *   用户反馈**优先于**judge 的 feedForward。
   */
  awaitUserGate?(round: number, outcome: IterationOutcome): Promise<{ action: "continue" | "stop"; feedback?: string }>;
  pendingFeedback?(): string | null;
}

export type IterativeResult = "achieved" | "stopped" | "exhausted" | "failed";

function readReport(root: string, runId: string): string {
  return loadRunReport(root, runId) ?? "";
}

export async function runIterative(
  root: string,
  prompt: string,
  companyId: string | undefined,
  adapter: IterationAdapter,
): Promise<IterativeResult> {
  const t0 = Date.now();
  let directive = prompt;
  const notes: string[] = [];
  for (let round = 1; round <= adapter.maxRounds; round++) {
    if (adapter.stopRequested()) return "stopped";
    if ((Date.now() - t0) / 3_600_000 >= adapter.maxHours) return "exhausted";
    let runId = "";
    try {
      const r = await startRun(directive, undefined, companyId, { runType: "team" });
      runId = r.runId;
    } catch (e: any) {
      adapter.onRound(round, "", null, e?.message ?? String(e));
      return "failed";
    }
    let outcome: IterationOutcome;
    try {
      outcome = await adapter.judge(prompt, readReport(root, runId), runId);
    } catch (e: any) {
      outcome = { stop: false, roundNote: `复盘失败(${(e?.message ?? "").slice(0, 80)}),保守继续`, feedForward: "" };
    }
    adapter.onRound(round, runId, outcome);
    if (outcome.stop) return "achieved";
    notes.push(`第${round}轮:${outcome.roundNote}`);

    // 反馈回路①·每轮确认门(harness 范式:人看完这轮结果再放行下一轮)
    let gateFeedback = "";
    if (adapter.awaitUserGate && round < adapter.maxRounds) {
      const gate = await adapter.awaitUserGate(round, outcome);
      if (gate.action === "stop") return "stopped";
      gateFeedback = gate.feedback?.trim() ?? "";
    }
    // 反馈回路②·方向盘(loop 范式:异步捎话,不打断也能转向)
    const steer = adapter.pendingFeedback?.()?.trim() ?? "";
    const userFeedback = [gateFeedback, steer].filter(Boolean).join(";");

    directive = `${prompt}

【${adapter.kind === "goal" ? "目标模式" : "连续模式"}·第 ${round + 1} 轮】已完成:${notes.slice(-4).join(";") || "见前轮"}。
${userFeedback ? `⚠️ 用户反馈(最高优先级,必须遵从):${userFeedback}
` : ""}${outcome.feedForward ? `本轮聚焦推进:${outcome.feedForward}` : "请继续寻找最有价值的下一步并推进。"}
不要重复已完成的工作,聚焦增量。`;
  }
  return "exhausted";
}

// ── 自动化队列(agent 工具 schedule_goal/schedule_loop 的落点)────────────────────

export interface QueuedAutomation {
  id: string;
  kind: "goal" | "loop";
  prompt: string;
  companyId?: string;
  maxRounds?: number;
  maxHours?: number;
  source: string;         // "user" | "agent:<agentId>"
  enqueuedAt: string;
}

const queuePath = (root: string) => path.join(root, ".opc", "automation-queue.json");
const MAX_QUEUE = 20;

export function loadAutomationQueue(root: string): QueuedAutomation[] {
  return readJSON<QueuedAutomation[]>(queuePath(root), []);
}
function saveQueue(root: string, q: QueuedAutomation[]) { writeJSON(queuePath(root), q); }

export function enqueueAutomation(
  root: string,
  item: Omit<QueuedAutomation, "id" | "enqueuedAt">,
): QueuedAutomation {
  const q = loadAutomationQueue(root);
  if (q.length >= MAX_QUEUE) throw new Error(`自动化队列已满(${MAX_QUEUE} 条),请先清理`);
  const rec: QueuedAutomation = { ...item, id: randomUUID().slice(0, 8), enqueuedAt: new Date().toISOString() };
  q.push(rec);
  saveQueue(root, q);
  return rec;
}

export function removeQueuedAutomation(root: string, id: string): boolean {
  const q = loadAutomationQueue(root);
  const next = q.filter(i => i.id !== id);
  if (next.length === q.length) return false;
  saveQueue(root, next);
  return true;
}

// 空闲判定+起跑由调度器做;starters 由 index.ts 注入(goalRunner/loopRunner 的 startGoal/startLoop),
// 避免 harness↔runner 循环依赖(runner 依赖本文件的 runIterative)。
type Starter = (root: string, prompt: string, opts: { companyId?: string; maxRounds?: number; maxHours?: number }) => unknown;
let starters: { goal: Starter; loop: Starter; busy: () => boolean } | null = null;
export function registerAutomationStarters(s: { goal: Starter; loop: Starter; busy: () => boolean }) { starters = s; }

function anyRunActive(root: string): boolean {
  try { return loadRunIndex(root).some(r => r.status === "running"); } catch { return false; }
}

let draining = false;
export function drainAutomationQueue(root: string) {
  if (draining || !starters) return;
  draining = true;
  try {
    if (starters.busy() || anyRunActive(root)) return; // 系统忙:留队,下个 tick 再看
    const q = loadAutomationQueue(root);
    const item = q.shift();
    if (!item) return;
    saveQueue(root, q);
    try {
      const opts = { companyId: item.companyId, maxRounds: item.maxRounds, maxHours: item.maxHours };
      if (item.kind === "goal") starters.goal(root, item.prompt, opts);
      else starters.loop(root, item.prompt, opts);
    } catch (e: any) {
      // 起跑失败(如恰好撞上刚起的 run):放回队首,别弄丢
      const q2 = loadAutomationQueue(root);
      q2.unshift(item);
      saveQueue(root, q2.slice(0, MAX_QUEUE));
    }
  } finally {
    draining = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startAutomationScheduler(root: string) {
  if (timer) return;
  timer = setInterval(() => { try { drainAutomationQueue(root); } catch { /* 调度器永不炸 */ } }, 30_000);
  timer.unref?.();
}
