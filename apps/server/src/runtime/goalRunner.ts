import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { invokeSystemModel } from "./systemModelInvoke.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadChanges } from "../storage/projectStore.js";
import { runIterative, type IterationAdapter, type IterationOutcome } from "./harness.js";

// 目标模式(goal):锁定一个长目标,多轮 run 自动推进直到"验收官判定达成"或轮次/时长上限。
// 迭代引擎在 harness.ts(与 loop 共用同一内核);本文件只是 goal 语义的 adapter:
// judge=严格验收({achieved, done, gap}),达成即停,缺口回灌下一轮。

export interface GoalRound {
  round: number;
  runId: string;
  achieved: boolean;
  gap?: string;
  doneSummary?: string;
  error?: string;
}

export interface GoalRecord {
  id: string;
  goal: string;
  companyId?: string;
  status: "running" | "waiting_user" | "achieved" | "exhausted" | "stopped" | "failed";
  maxRounds: number;
  rounds: GoalRound[];
  createdAt: string;
  endedAt?: string;
  /** harness 范式:用户写下的显式验收标准——验收官按这些判定,不靠 LLM 猜 */
  acceptanceCriteria?: string[];
  /** 每轮确认模式:本轮判定后停在 waiting_user,等用户 继续/带反馈继续/停止 */
  confirmEachRound?: boolean;
  /** 方向盘:用户异步捎给下一轮的话(取用后清空) */
  pendingFeedback?: string;
}

const goalsPath = (root: string) => path.join(root, ".opc", "goals.json");

export function loadGoals(root: string): GoalRecord[] {
  return readJSON<GoalRecord[]>(goalsPath(root), []);
}

function saveGoals(root: string, goals: GoalRecord[]) {
  writeJSON(goalsPath(root), goals);
}

function upsert(root: string, rec: GoalRecord) {
  const all = loadGoals(root);
  const i = all.findIndex(g => g.id === rec.id);
  if (i >= 0) all[i] = rec; else all.unshift(rec);
  saveGoals(root, all.slice(0, 100));
}

const stopFlags = new Set<string>();
export function requestStopGoal(id: string) { stopFlags.add(id); }

// 每轮确认门:continue 信号(带可选反馈)由路由写入,adapter 的等待循环消费。
const continueSignals = new Map<string, { feedback?: string }>();
export function signalContinueGoal(id: string, feedback?: string) { continueSignals.set(id, { feedback }); }
// 方向盘:异步捎话给下一轮(写到记录上,内核拼 directive 前取用并清空)。
export function pushGoalFeedback(root: string, id: string, text: string): boolean {
  const all = loadGoals(root);
  const rec = all.find(g => g.id === id);
  if (!rec || (rec.status !== "running" && rec.status !== "waiting_user")) return false;
  rec.pendingFeedback = [rec.pendingFeedback, text.trim().slice(0, 500)].filter(Boolean).join(";");
  saveGoals(root, all);
  return true;
}

const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function loadGoalRunFileChanges(root: string, runId: string): string[] {
  if (!SAFE_RUN_ID.test(runId)) return [];
  const changes = loadChanges(root, runId) as Array<{ path?: unknown; changeType?: unknown }>;
  return changes
    .filter(c => typeof c.path === "string" && c.path !== "partial.md")
    .map(c => `${typeof c.changeType === "string" ? c.changeType : "change"}: ${c.path}`);
}
let goalInFlight = false;
export function isGoalInFlight() { return goalInFlight; }

// 达成判定:便宜模型按【用户显式验收标准】逐条核对(harness 范式——人定标准,不靠模型猜)。
// fileChanges:本轮真实文件变更清单——报告会吹牛,文件不会;交付型目标(做游戏/写代码)
// 无文件产出时验收官必须知情,防"报告漂亮无实物"的假达成。
async function judgeGoal(root: string, goal: string, reportMd: string, criteria?: string[], fileChanges?: string[]): Promise<{ achieved: boolean; done: string; gap: string }> {
  const criteriaBlock = criteria?.length
    ? `\n用户显式验收标准(必须逐条满足才算达成):\n${criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}\n`
    : "";
  const filesBlock = `\n本轮真实文件产出(系统记录,非模型自述${fileChanges?.length ? "" : "——为空!交付型目标无文件=通常未达成"}):\n${fileChanges?.length ? fileChanges.slice(0, 30).join("\n") : "(无任何文件变更)"}\n`;
  const prompt = `你是严格的验收官。判断下面的交付报告是否已经完全达成用户目标。报告是团队的自述,可能夸大;文件清单是系统记录的事实,以事实为准。
用户目标:
${goal.slice(0, 1200)}
${criteriaBlock}${filesBlock}
交付报告(节选):
${reportMd.slice(0, 6000)}

只输出一个 JSON 对象,不要任何其他文字:
{"achieved": true|false, "done": "本轮已完成内容一句话", "gap": "若未达成,还缺什么(具体、可执行${criteria?.length ? ",指明未满足的标准编号" : ""});已达成则空串"}`;
  const out = await invokeSystemModel(root, "judge", {
    agentId: "goal-judge",
    messages: [{ role: "user", content: prompt }], maxTokens: 400, agentRole: "verifier",
  });
  const m = (out.content ?? "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("judge 输出无 JSON");
  const j = JSON.parse(m[0]) as { achieved?: boolean; done?: string; gap?: string };
  return { achieved: !!j.achieved, done: String(j.done ?? "").slice(0, 300), gap: String(j.gap ?? "").slice(0, 800) };
}

// 启动目标(异步推进,立即返回记录;进度通过 GET /api/goals 观察)。
export function startGoal(
  root: string,
  goal: string,
  opts?: { companyId?: string; maxRounds?: number; maxHours?: number; acceptanceCriteria?: string[]; confirmEachRound?: boolean },
): GoalRecord {
  if (goalInFlight) throw new Error("已有目标正在推进(单目标约束):请先停止当前目标");
  const rec: GoalRecord = {
    id: randomUUID().slice(0, 8),
    goal, companyId: opts?.companyId,
    status: "running",
    maxRounds: Math.min(Math.max(opts?.maxRounds ?? 3, 1), 6), // 1..6 轮硬上限,防失控烧钱
    rounds: [], createdAt: new Date().toISOString(),
    acceptanceCriteria: opts?.acceptanceCriteria?.map(c => c.trim()).filter(Boolean).slice(0, 8),
    confirmEachRound: !!opts?.confirmEachRound,
  };
  upsert(root, rec);
  goalInFlight = true;

  // 方向盘取用:内核拼下一轮 directive 前调一次,取后清空(从盘上读,保证 UI 写入的也能吃到)。
  const takeFeedback = (): string | null => {
    const all = loadGoals(root);
    const cur = all.find(g => g.id === rec.id);
    if (!cur?.pendingFeedback) return null;
    const fb = cur.pendingFeedback;
    cur.pendingFeedback = undefined;
    rec.pendingFeedback = undefined;
    saveGoals(root, all);
    return fb;
  };

  const adapter: IterationAdapter = {
    kind: "goal",
    maxRounds: rec.maxRounds,
    maxHours: Math.min(Math.max(opts?.maxHours ?? 6, 0.5), 12),
    stopRequested: () => stopFlags.has(rec.id),
    judge: async (original, report, runId): Promise<IterationOutcome> => {
      if (!report) return { stop: false, roundNote: "本轮未产出报告", feedForward: "本轮未产出报告,请先解决产出问题" };
      const files = loadGoalRunFileChanges(root, runId);
      const v = await judgeGoal(root, original, report, rec.acceptanceCriteria, files);
      return { stop: v.achieved, roundNote: v.done || "见本轮报告", feedForward: v.gap };
    },
    onRound: (round, runId, outcome, error) => {
      rec.rounds.push({
        round, runId,
        achieved: outcome?.stop ?? false,
        doneSummary: outcome?.roundNote,
        gap: outcome && !outcome.stop ? outcome.feedForward || undefined : undefined,
        error,
      });
      upsert(root, rec);
    },
    pendingFeedback: takeFeedback,
    // 每轮确认门(harness 范式):判定后停在 waiting_user,直到用户 继续/停止;每 3s 轮询信号。
    awaitUserGate: rec.confirmEachRound
      ? async (_round, _outcome) => {
          rec.status = "waiting_user";
          upsert(root, rec);
          continueSignals.delete(rec.id);
          try {
            for (;;) {
              if (stopFlags.has(rec.id)) return { action: "stop" as const };
              const sig = continueSignals.get(rec.id);
              if (sig) { continueSignals.delete(rec.id); return { action: "continue" as const, feedback: sig.feedback }; }
              await new Promise(r => setTimeout(r, 3000));
            }
          } finally {
            rec.status = "running";
            upsert(root, rec);
          }
        }
      : undefined,
  };

  void (async () => {
    try {
      const result = await runIterative(root, goal, rec.companyId, adapter);
      rec.status = result;
    } finally {
      rec.endedAt = new Date().toISOString();
      upsert(root, rec);
      stopFlags.delete(rec.id);
      goalInFlight = false;
    }
  })();
  return rec;
}
