import type { Express } from "express";
import * as path from "node:path";
import type { TaskComplexityEstimate } from "@opc/shared";
import { loadGoals, startGoal, requestStopGoal, isGoalInFlight, signalContinueGoal, pushGoalFeedback } from "../runtime/goalRunner.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { estimateTaskComplexity } from "../runtime/taskComplexityEstimator.js";
import { loadAgents } from "../storage/projectStore.js";
import { writeJSON } from "../storage/jsonFile.js";

// E1:goal 记录新增可选字段 complexityEstimate(旧 goals.json 无此字段=未估算,读取方按缺省处理)。
// GoalRecord 接口在 goalRunner.ts(Track E 无该文件所有权,不改它),这里用交叉类型在路由层附加;
// 持久化走 loadGoals + writeJSON 就地改写 goals.json(路径与 goalRunner.goalsPath 同一约定)。
// startGoal 返回的 rec 与 runner 闭包持有的是同一对象,内存里同步打上字段,后续 upsert 不会丢。
function attachGoalEstimate(projectRoot: string, goalId: string, estimate: TaskComplexityEstimate) {
  const all = loadGoals(projectRoot);
  const rec = all.find(g => g.id === goalId);
  if (!rec) return;
  (rec as typeof rec & { complexityEstimate?: TaskComplexityEstimate }).complexityEstimate = estimate;
  writeJSON(path.join(projectRoot, ".opc", "goals.json"), all);
}

// 目标模式 API(harness 范式):锁定长目标 → 多轮 run 自动推进直到达成/轮次上限。
// POST /api/goals {goal, companyId?, maxRounds?, acceptanceCriteria?[], confirmEachRound?} → 立即返回记录
// GET  /api/goals → 目标档案(含每轮 runId/判定/缺口;waiting_user=每轮确认门等待中)
// POST /api/goals/:id/stop → 请求停止(当前轮跑完后生效)
// POST /api/goals/:id/continue {feedback?} → 每轮确认门放行(可带反馈,最高优先级回灌下一轮)
// POST /api/goals/:id/feedback {text} → 方向盘:异步捎话给下一轮(不打断)
export function registerGoalRoutes(app: Express, projectRoot: string) {
  app.get("/api/goals", (_req, res) => {
    res.json({ inFlight: isGoalInFlight(), goals: loadGoals(projectRoot) });
  });

  app.post("/api/goals", (req, res) => {
    const { goal, companyId, maxRounds, acceptanceCriteria, confirmEachRound } = (req.body ?? {}) as {
      goal?: string; companyId?: string; maxRounds?: number; acceptanceCriteria?: string[]; confirmEachRound?: boolean;
    };
    if (!goal || typeof goal !== "string" || !goal.trim()) return res.status(400).json({ error: "goal required" });
    const integrity = checkTextIntegrity(goal);
    if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    const criteria = Array.isArray(acceptanceCriteria)
      ? acceptanceCriteria.filter((c): c is string => typeof c === "string" && !!c.trim()).slice(0, 8)
      : undefined;
    try {
      const rec = startGoal(projectRoot, goal.trim(), { companyId, maxRounds, acceptanceCriteria: criteria, confirmEachRound: !!confirmEachRound });
      // E1:goal 创建即估算(agent 数从 agents.json 按 companyId 过滤;goal 场景无 artifact/MCP/shell 先验,不传)。
      const agentCount = loadAgents(projectRoot, []).filter(a => (a.companyId ?? "default") === (companyId ?? "default")).length;
      const estimate = estimateTaskComplexity({ goalText: goal.trim(), agentCount });
      (rec as typeof rec & { complexityEstimate?: TaskComplexityEstimate }).complexityEstimate = estimate;
      attachGoalEstimate(projectRoot, rec.id, estimate);
      res.json(rec);
    } catch (e: any) {
      res.status(409).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/goals/:id/stop", (req, res) => {
    requestStopGoal(String(req.params.id));
    res.json({ ok: true, note: "当前轮完成后停止" });
  });

  app.post("/api/goals/:id/continue", (req, res) => {
    const fb = typeof req.body?.feedback === "string" ? req.body.feedback.slice(0, 500) : undefined;
    if (fb) {
      const integrity = checkTextIntegrity(fb);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    }
    signalContinueGoal(String(req.params.id), fb);
    res.json({ ok: true });
  });

  app.post("/api/goals/:id/feedback", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text required" });
    const integrity = checkTextIntegrity(text);
    if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    const ok = pushGoalFeedback(projectRoot, String(req.params.id), text);
    if (!ok) return res.status(404).json({ error: "目标不存在或已结束" });
    res.json({ ok: true, note: "已捎话给下一轮" });
  });
}
