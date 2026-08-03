// P4 · 历史 backfill:扫 .opc/runs/* 里**有失败信号**的历史 run,补出 ReflectionLesson,让冷启动就有教训。
// 省 deepseek:① 只处理有 deferred/降级 的 run;② 已处理的 runId 记进 .opc/memory/backfilled.json 不重复;
// ③ commitLesson 按 lessonKey 去重合并,故同类失败只沉一条。全程 best-effort。
import * as fs from "node:fs";
import * as path from "node:path";
import { collectReflectionSignals, reflectOnRun } from "./runCritic.js";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadDeferred, loadRunTask } from "../storage/projectStore.js";
import { proposeMemory } from "./memoryGovernance.js";

export async function backfillLessons(input: {
  projectRoot: string;
  callModel: (sys: string, user: string) => Promise<string>;
  roleOf: (agentId: string) => string | undefined;
  teamIdOf?: (agentId: string) => string | undefined;
  companyIdOf?: (agentId: string) => string | undefined;
  nowIso: string;
  limit?: number;
  log?: (m: string) => void;
}): Promise<{ processed: number; lessons: number; skipped: number }> {
  const runsDir = path.join(input.projectRoot, ".opc", "runs");
  if (!fs.existsSync(runsDir)) return { processed: 0, lessons: 0, skipped: 0 };
  const markerFile = path.join(input.projectRoot, ".opc", "memory", "backfilled.json");
  const done = new Set<string>(readJSON<string[]>(markerFile, []));

  const runIds = (() => { try { return fs.readdirSync(runsDir); } catch { return []; } })();
  const candidates: Array<{ runId: string; goal: string; deferred: any[]; degraded: boolean; degradedReason?: string; mtime: number }> = [];
  for (const runId of runIds) {
    if (done.has(runId)) continue;
    const rd = path.join(runsDir, runId);
    try { if (!fs.statSync(rd).isDirectory()) continue; } catch { continue; }
    const deferred: any[] = loadDeferred(input.projectRoot, runId);
    const task: any = loadRunTask(input.projectRoot, runId) ?? {};
    const degraded = !!task.degraded;
    if ((!Array.isArray(deferred) || deferred.length === 0) && !degraded) continue; // 无失败信号 → 跳
    const goal = task.userGoal || task.goal || task.message || "";  // task.json 里目标字段是 userGoal
    if (!goal) continue;
    let mtime = 0; try { mtime = fs.statSync(rd).mtimeMs; } catch { /* */ }
    candidates.push({ runId, goal, deferred: Array.isArray(deferred) ? deferred : [], degraded, degradedReason: task.degradedReason, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime); // 新的优先
  const pick = candidates.slice(0, input.limit ?? 20);

  let lessons = 0;
  for (const c of pick) {
    const signals = collectReflectionSignals({
      deferred: c.deferred.map((d) => ({ agentId: d.agentId, reason: d.reason, attempts: d.attempts, lastError: d.lastError, goal: d.goal })),
      degraded: c.degraded, degradedReason: c.degradedReason,
      roleOf: input.roleOf, teamIdOf: input.teamIdOf, companyIdOf: input.companyIdOf,
      dropUnresolvedRole: true, // 历史 run 里解析不到真实角色的信号跳过,不误归成 worker
    });
    if (!signals.length) { done.add(c.runId); continue; }
    // 区分"模型正常但无教训"(应标记 done)与"模型不可用(空/异常)"(不标记,下次重试,避免教训永久丢失)。
    let modelOk = true;
    // C12-P0:backfill 候选按构造全是有失败信号(deferred/降级)的 run(见 :34)——反思一律传 failed_or_degraded,
    // 使 commitLesson 走"失败 run 反思只 proposed"路径(与 live 路径 orchestrator:2434 收口一致),不再让低风险
    // 教训(timeout/retry_budget_exhausted 等)绕过审批自动 committed 进可注入池。
    try {
      const candidates = await reflectOnRun({
        projectRoot: input.projectRoot,
        runId: c.runId,
        goal: c.goal,
        signals,
        callModel: async (s, u) => {
          const r = await input.callModel(s, u);
          if (!r) modelOk = false;
          return r;
        },
        nowIso: input.nowIso,
        runOutcome: "failed_or_degraded",
      });
      for (const candidate of candidates) {
        proposeMemory(input.projectRoot, candidate);
        lessons++;
      }
    }
    catch { modelOk = false; }
    if (modelOk) done.add(c.runId);
  }
  try { writeJSON(markerFile, [...done]); } catch { /* */ }
  input.log?.(`backfill: ${pick.length} runs → ${lessons} lessons(${candidates.length - pick.length} 超限跳过)`);
  return { processed: pick.length, lessons, skipped: candidates.length - pick.length };
}
