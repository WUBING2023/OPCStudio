import type { Express } from "express";
import { isBusyAgentStatus, type TaskComplexityEstimate } from "@opc/shared";
import { loadMissions } from "../runtime/missionBrief.js";
import { getAgents } from "../runtime/orchestrator.js";
import { buildPostmortem } from "../runtime/failurePostmortem.js";
import { computeCostTimeseries } from "../runtime/costSummary.js";
import { loadRunIndex } from "../storage/projectStore.js";

// Track C · C2 CEO 战略面板 v1 —— GET /api/ceo/status?companyId=xxx 聚合端点。
// 只读、纯聚合:全部来自已有落盘/内存数据(missions.json / 运行索引 _index.json / orchestrator 内存
// agent 状态 / run 目录证据文件 / cost.json),零新增模型调用、零新写路径。各数据源的公司归属口径
// 沿用其自身既有约定,不另立标准:
// - agents:companyId 缺省视为 "default"(与 BriefingPanel/missionBrief 的 roster 过滤一致)
// - mission:companyId 缺省视为 "default"(默认公司的 mission 不该在自己的驾驶舱里消失)
// - runs:严格匹配 r.companyId === companyId(与 /api/runs?company= "旧 run 只出现在全部里"的既有约定一致)
// mission 取"最近一条非 stopped"(approvalStatus 没有 archived 态,stopped 即已归档语义;
// missions.json 是 unshift 序,首个命中即最新)。
// lastFailure 的复盘复用 C1 的 buildPostmortem(纯派生、绝不抛),best-effort:失败只降级为
// postmortemAvailable:false,不影响整个聚合响应。
// todayTokens 与简报栏"老板一眼条"同一口径(computeCostTimeseries 当月按天、全局不分公司——glance 的
// 既有产品决定:按公司拆分成本高、价值低)。

export interface CeoStatusMission {
  id: string;
  goal: string;
  approvalStatus: string;
  createdAt: string;
  /** E1 字段直接透传;旧 mission 无预估 → null(前端显示"暂无预估") */
  complexityEstimate: TaskComplexityEstimate | null;
}

export interface CeoStatusWaitingAgent {
  id: string;
  name: string;
  role: string;
  currentActivity?: string;
}

export interface CeoStatusResponse {
  schemaVersion: "1";
  companyId: string;
  mission: CeoStatusMission | null;
  waitingOn: CeoStatusWaitingAgent[];
  activeRun: { runId: string; startedAt: string; goal: string } | null;
  lastFailure: {
    runId: string;
    endedAt?: string;
    postmortemAvailable: boolean;
    topCause?: string;
    topSuggestion?: string;
    // #32 · 结构化 i18n:前端有键则按 postmortem.cause.*/postmortem.suggestion.* 词典渲染,
    // 无键回退 topCause/topSuggestion 中文原文。
    topCauseKey?: string;
    topCauseParams?: Record<string, string>;
    topSuggestionKey?: string;
    topSuggestionParams?: Record<string, string>;
  } | null;
  todayTokens: number;
}

export function register(app: Express, projectRoot: string) {
  app.get("/api/ceo/status", (req, res) => {
    const companyId = typeof req.query.companyId === "string" && req.query.companyId ? req.query.companyId : undefined;
    if (!companyId) return res.status(400).json({ error: "companyId required" });
    try {
      // 当前 mission:该公司最近一条非 stopped(loadMissions 绝不抛,文件缺失返回 [])。
      const m = loadMissions(projectRoot)
        .find(x => (x.companyId ?? "default") === companyId && x.approvalStatus !== "stopped");
      const mission: CeoStatusMission | null = m ? {
        id: m.id,
        goal: m.interpretedGoal || m.originalIdea,
        approvalStatus: m.approvalStatus,
        createdAt: m.createdAt,
        complexityEstimate: m.complexityEstimate ?? null,
      } : null;

      // 正在等待谁:orchestrator 内存 agent 状态(与画布/一眼条同一来源),取"正在干活"的忙碌子集
      // (working + 11 态细分的 thinking/using_tool/reviewing,见 shared BUSY_AGENT_STATUSES)。
      // currentActivity 映射自 AgentNodeConfig.currentTask(现有字段,不新造状态)。
      const waitingOn: CeoStatusWaitingAgent[] = getAgents()
        .filter(a => (a.companyId || "default") === companyId && isBusyAgentStatus(a.status))
        .map(a => ({
          id: a.id, name: a.name, role: a.role,
          ...(a.currentTask ? { currentActivity: a.currentTask } : {}),
        }));

      // 运行索引(loadRunIndex 已按 startedAt 倒序):最新 running = activeRun;
      // 最新 failed/degraded = lastFailure 候选。
      const rows = loadRunIndex(projectRoot).filter(r => r.companyId === companyId);
      const running = rows.find(r => r.status === "running");
      const activeRun = running ? { runId: running.id, startedAt: running.startedAt, goal: running.goal } : null;

      let lastFailure: CeoStatusResponse["lastFailure"] = null;
      const failedRow = rows.find(r => r.status === "failed" || r.degraded === true);
      if (failedRow) {
        lastFailure = { runId: failedRow.id, endedAt: failedRow.endedAt, postmortemAvailable: false };
        try {
          const pm = buildPostmortem(projectRoot, failedRow.id, {
            nameOf: (agentId) => getAgents().find(a => a.id === agentId)?.name,
          });
          if (pm?.available) {
            lastFailure.postmortemAvailable = true;
            if (pm.causes[0]?.message) lastFailure.topCause = pm.causes[0].message;
            if (pm.suggestions[0]) lastFailure.topSuggestion = pm.suggestions[0];
            if (pm.causes[0]?.messageKey) {
              lastFailure.topCauseKey = pm.causes[0].messageKey;
              if (pm.causes[0].params) lastFailure.topCauseParams = pm.causes[0].params;
            }
            const si = pm.suggestionItems?.[0];
            if (si) {
              lastFailure.topSuggestionKey = si.key;
              if (si.params) lastFailure.topSuggestionParams = si.params;
            }
          }
        } catch { /* best-effort:复盘失败不拖垮聚合 */ }
      }

      // 今日 Token:与前端 glance 完全同口径(ISO UTC 的今天,当月 timeseries 里取当日 total)。
      let todayTokens = 0;
      try {
        const nowIso = new Date().toISOString();
        const ts = computeCostTimeseries(projectRoot, { month: nowIso.slice(0, 7), metric: "tokens" });
        todayTokens = ts.days.find(d => d.date === nowIso.slice(0, 10))?.total ?? 0;
      } catch { /* best-effort */ }

      const body: CeoStatusResponse = { schemaVersion: "1", companyId, mission, waitingOn, activeRun, lastFailure, todayTokens };
      res.json(body);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "ceo status failed" });
    }
  });
}
