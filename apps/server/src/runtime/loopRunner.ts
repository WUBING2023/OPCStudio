import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { invokeSystemModel } from "./systemModelInvoke.js";
import { isGoalInFlight } from "./goalRunner.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { runIterative, type IterationAdapter, type IterationOutcome } from "./harness.js";

// 连续模式(loop,借鉴 CC /loop 的"一直干不要停"):按下即连轴转——迭代引擎在 harness.ts
// (与 goal 共用同一内核);本文件只是 loop 语义的 adapter:judge=持续改进复盘({note, next}),
// 永不主动停(靠轮数/时长上限/用户停止),方向回灌下一轮。

export interface LoopRound {
  round: number;
  runId: string;
  note?: string;
  next?: string;
  error?: string;
}

export interface LoopRecord {
  id: string;
  prompt: string;
  companyId?: string;
  status: "running" | "waiting_user" | "stopped" | "exhausted" | "failed";
  maxRuns: number;
  maxHours: number;
  rounds: LoopRound[];
  createdAt: string;
  endedAt?: string;
  stopReason?: string;
  /** 每轮确认模式(可选):本轮复盘后停在 waiting_user 等用户放行 */
  confirmEachRound?: boolean;
  /** 方向盘:用户异步捎给下一轮的话(取用后清空) */
  pendingFeedback?: string;
}

const loopsPath = (root: string) => path.join(root, ".opc", "loops.json");

export function loadLoops(root: string): LoopRecord[] {
  return readJSON<LoopRecord[]>(loopsPath(root), []);
}
function saveLoops(root: string, loops: LoopRecord[]) { writeJSON(loopsPath(root), loops); }
function upsert(root: string, rec: LoopRecord) {
  const all = loadLoops(root);
  const i = all.findIndex(l => l.id === rec.id);
  if (i >= 0) all[i] = rec; else all.unshift(rec);
  saveLoops(root, all.slice(0, 100));
}

const stopFlags = new Set<string>();
export function requestStopLoop(id: string) { stopFlags.add(id); }

// 每轮确认门 + 方向盘(与 goalRunner 同款契约,供 loopRoutes 使用)。
const continueSignals = new Map<string, { feedback?: string }>();
export function signalContinueLoop(id: string, feedback?: string) { continueSignals.set(id, { feedback }); }
export function pushLoopFeedback(root: string, id: string, text: string): boolean {
  const all = loadLoops(root);
  const rec = all.find(l => l.id === id);
  if (!rec || (rec.status !== "running" && rec.status !== "waiting_user")) return false;
  rec.pendingFeedback = [rec.pendingFeedback, text.trim().slice(0, 500)].filter(Boolean).join(";");
  saveLoops(root, all);
  return true;
}

let loopInFlight = false;
export function isLoopInFlight() { return loopInFlight; }

// 轮间复盘:读原始任务+本轮报告,产出 {note(这轮做了什么), next(下一轮最值得推进的一件事)}。
async function reviewRound(root: string, prompt: string, reportMd: string): Promise<{ note: string; next: string }> {
  const p = `你是持续改进教练。用户的持续任务和本轮交付报告如下,请给出下一轮迭代方向。
持续任务:
${prompt.slice(0, 1000)}

本轮交付报告(节选):
${reportMd.slice(0, 6000)}

只输出一个 JSON 对象:
{"note": "本轮完成内容一句话", "next": "下一轮最值得推进的一件事(具体、增量,不要重复已完成的)"}`;
  const out = await invokeSystemModel(root, "judge", {
    agentId: "loop-review",
    messages: [{ role: "user", content: p }], maxTokens: 300, agentRole: "verifier",
  });
  const m = (out.content ?? "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("复盘输出无 JSON");
  const j = JSON.parse(m[0]) as { note?: string; next?: string };
  return { note: String(j.note ?? "").slice(0, 200), next: String(j.next ?? "").slice(0, 600) };
}

// 启动连续模式:立即返回记录,后台连轴推进(GET /api/loops 观察进度)。
export function startLoop(
  root: string,
  prompt: string,
  opts?: { companyId?: string; maxRuns?: number; maxRounds?: number; maxHours?: number; confirmEachRound?: boolean },
): LoopRecord {
  if (loopInFlight) throw new Error("已有连续任务在推进(单循环约束):请先停止当前循环");
  if (isGoalInFlight()) throw new Error("目标模式正在推进中,请先等它完成或停止");
  const rec: LoopRecord = {
    id: randomUUID().slice(0, 8),
    prompt: prompt.trim(), companyId: opts?.companyId,
    status: "running",
    maxRuns: Math.min(Math.max(opts?.maxRuns ?? opts?.maxRounds ?? 5, 1), 20),
    maxHours: Math.min(Math.max(opts?.maxHours ?? 3, 0.5), 8),
    rounds: [], createdAt: new Date().toISOString(),
    confirmEachRound: !!opts?.confirmEachRound,
  };
  upsert(root, rec);
  loopInFlight = true;

  const takeFeedback = (): string | null => {
    const all = loadLoops(root);
    const cur = all.find(l => l.id === rec.id);
    if (!cur?.pendingFeedback) return null;
    const fb = cur.pendingFeedback;
    cur.pendingFeedback = undefined;
    rec.pendingFeedback = undefined;
    saveLoops(root, all);
    return fb;
  };

  const adapter: IterationAdapter = {
    kind: "loop",
    maxRounds: rec.maxRuns,
    maxHours: rec.maxHours,
    stopRequested: () => stopFlags.has(rec.id),
    judge: async (original, report): Promise<IterationOutcome> => {
      if (!report) return { stop: false, roundNote: "本轮未产出报告", feedForward: "重试原任务,先解决产出问题" };
      const r = await reviewRound(root, original, report);
      return { stop: false, roundNote: r.note || "见本轮报告", feedForward: r.next };
    },
    onRound: (round, runId, outcome, error) => {
      rec.rounds.push({ round, runId, note: outcome?.roundNote, next: outcome?.feedForward || undefined, error });
      upsert(root, rec);
    },
    pendingFeedback: takeFeedback,
    awaitUserGate: rec.confirmEachRound
      ? async () => {
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
      const result = await runIterative(root, rec.prompt, rec.companyId, adapter);
      rec.status = result === "achieved" ? "exhausted" : result; // loop 无"达成"语义
      rec.stopReason = result === "stopped" ? "用户停止" : result === "failed" ? "run 启动失败" : `触顶(${rec.maxRuns} 轮 / ${rec.maxHours}h)`;
    } finally {
      rec.endedAt = new Date().toISOString();
      upsert(root, rec);
      stopFlags.delete(rec.id);
      loopInFlight = false;
    }
  })();
  return rec;
}
