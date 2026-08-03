import type { Express } from "express";
import { loadLoops, startLoop, requestStopLoop, isLoopInFlight, signalContinueLoop, pushLoopFeedback } from "../runtime/loopRunner.js";
import { loadAutomationQueue, removeQueuedAutomation } from "../runtime/harness.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";

// 连续模式 API(loop):按下即连轴转——每轮跑完立刻复盘并开下一轮,直到停止/上限。
// POST /api/loops {prompt, companyId?, maxRuns?(1-20), maxHours?(0.5-8)} → 立即返回记录(后台推进)
// GET  /api/loops → {inFlight, loops[]}
// POST /api/loops/:id/stop → 请求停止(当前轮跑完后生效,不腰斩进行中的 run)
export function registerLoopRoutes(app: Express, projectRoot: string) {
  app.get("/api/loops", (_req, res) => {
    res.json({ inFlight: isLoopInFlight(), loops: loadLoops(projectRoot) });
  });

  app.post("/api/loops", (req, res) => {
    const { prompt, companyId, maxRuns, maxHours, confirmEachRound } = (req.body ?? {}) as { prompt?: string; companyId?: string; maxRuns?: number; maxHours?: number; confirmEachRound?: boolean };
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
    const integrity = checkTextIntegrity(prompt);
    if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    try {
      res.json(startLoop(projectRoot, prompt, { companyId, maxRuns, maxHours, confirmEachRound: !!confirmEachRound }));
    } catch (e: any) {
      res.status(409).json({ error: e?.message ?? String(e) });
    }
  });

  app.post("/api/loops/:id/stop", (req, res) => {
    requestStopLoop(String(req.params.id));
    res.json({ ok: true, note: "当前轮完成后停止" });
  });

  // 反馈回路(loop engineering):每轮确认门放行 + 方向盘捎话(不打断转向)。
  app.post("/api/loops/:id/continue", (req, res) => {
    const fb = typeof req.body?.feedback === "string" ? req.body.feedback.slice(0, 500) : undefined;
    if (fb) {
      const integrity = checkTextIntegrity(fb);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    }
    signalContinueLoop(String(req.params.id), fb);
    res.json({ ok: true });
  });
  app.post("/api/loops/:id/feedback", (req, res) => {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text required" });
    const integrity = checkTextIntegrity(text);
    if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
    const ok = pushLoopFeedback(projectRoot, String(req.params.id), text);
    if (!ok) return res.status(404).json({ error: "循环不存在或已结束" });
    res.json({ ok: true, note: "已捎话给下一轮" });
  });

  // 自动化队列(agent 工具 schedule_goal/schedule_loop 排的队,harness.ts 单一来源)——只读展示 + 删单条,
  // 不下发起跑请求(起跑仍由 drainAutomationQueue 的 30s 调度器接手,这里不碰调度)。
  app.get("/api/automation/queue", (_req, res) => {
    res.json({ queue: loadAutomationQueue(projectRoot) });
  });

  app.delete("/api/automation/queue/:id", (req, res) => {
    const ok = removeQueuedAutomation(projectRoot, String(req.params.id));
    if (!ok) return res.status(404).json({ error: "queue item not found" });
    res.json({ ok: true });
  });
}
