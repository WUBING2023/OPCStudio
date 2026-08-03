import type { Express } from "express";
import { computeCostSummary, computeBudgetStatus, computeCostTimeseries, computeRunLedger } from "../runtime/costSummary.js";
import { listCooldowns } from "../runtime/rateLimitCooldown.js";

// Token 用量与限额状态(纯派生,只读)。
export function register(app: Express, projectRoot: string) {
  // Token 用量看板:按 provider/model/agent/run 聚合已有调用记录。?since=ISO&limit=N。
  // 维度栏(只读):?month=YYYY-MM 按月精确匹配(时间维度"本月/上月";"全部"不传);?company=<id> 按 run 归属公司。
  app.get("/api/cost/summary", (req, res) => {
    try {
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const month = typeof req.query.month === "string" ? req.query.month : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const company = typeof req.query.company === "string" && req.query.company ? req.query.company : undefined;
      const limit = req.query.limit ? Math.max(1, Math.min(500, Number(req.query.limit))) : undefined;
      res.json(computeCostSummary(projectRoot, { since, until, month, company, limit, now: new Date().toISOString() }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Token 限额状态。货币预算已延期,不在此接口返回或判断。
  app.get("/api/budget/status", (_req, res) => {
    try {
      res.json(computeBudgetStatus(projectRoot));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 账单式运行台账(分页)。?offset=&limit=。维度栏(只读):?month=YYYY-MM 账单按月;?company=<id> 按公司。
  app.get("/api/cost/runs", (req, res) => {
    try {
      const offset = req.query.offset ? Number(req.query.offset) : 0;
      const limit = req.query.limit ? Number(req.query.limit) : 25;
      const month = typeof req.query.month === "string" ? req.query.month : undefined; // YYYY-MM 账单按月
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const company = typeof req.query.company === "string" && req.query.company ? req.query.company : undefined;
      res.json(computeRunLedger(projectRoot, { offset, limit, since, until, month, company, now: new Date().toISOString() }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 当前仍在限流冷却中的模型(纯内存、自过期)。供 UI 顶部提示"X 模型限流中,约几点恢复"。
  app.get("/api/cost/cooldowns", (_req, res) => {
    try {
      const now = Date.now();
      res.json({ cooldowns: listCooldowns(now).map(e => ({ ...e, rateLimitedUntilIso: new Date(e.rateLimitedUntil).toISOString() })), now: new Date(now).toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 月度时间序列(按天 × provider),供堆叠柱状图。?period=YYYY-MM&metric=tokens|cost。
  // 维度栏(只读):?company=<id> 按公司(图表本身按天聚合无公司维度,只能整 run 取舍——见 computeCostTimeseries 注释)。
  app.get("/api/cost/timeseries", (req, res) => {
    try {
      const month = typeof req.query.period === "string" ? req.query.period : undefined;
      const metric = req.query.metric === "cost" ? "cost" : "tokens";
      const since = typeof req.query.since === "string" ? req.query.since : undefined;
      const until = typeof req.query.until === "string" ? req.query.until : undefined;
      const all = req.query.all === "1";
      const company = typeof req.query.company === "string" && req.query.company ? req.query.company : undefined;
      res.json(computeCostTimeseries(projectRoot, { month, since, until, all, metric, company }));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
