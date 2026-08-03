import type { Express } from "express";
import * as path from "node:path";
import type { Run } from "@opc/shared";
import { readJSON } from "../storage/jsonFile.js";
import { saveRunTask } from "../storage/projectStore.js";
import {
  loadGovernanceRecords, getGovernanceRecord, setGovernanceApproval, appendGovernanceEvent,
} from "../storage/governanceStore.js";
import { listRunPids, killRunPids } from "../runtime/pidRegistry.js";
import { startRun, requestStopRun, isRunInFlight, type RunType, type TeamMode } from "../runtime/orchestrator.js";
import { isRunInFlightError, drainDispatchQueue } from "../runtime/runMutex.js";
import { enqueueDispatch, removeDispatchItem } from "../storage/dispatchQueueStore.js";
import { markPrecreatedRunFailed } from "../runtime/runLifecycle.js";

// E3/E4 · Run Governance API。
// GET  /api/governance/records?limit=          → GovernanceRecord[](新的在前)
// GET  /api/governance/runs/:runId             → 单条 record
// POST /api/governance/runs/:runId/approve     → L3 人工批准;record 带 pendingDispatch 时当场派发
// POST /api/governance/runs/:runId/reject      → L3 拒绝;预建的 pending run 标 cancelled
// POST /api/governance/runs/:runId/kill        → 杀掉该 run 已登记的子进程树 + 请求停止派发
export function register(app: Express, projectRoot: string) {
  app.get("/api/governance/records", (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json(loadGovernanceRecords(projectRoot).slice(0, limit));
  });

  app.get("/api/governance/runs/:runId", (req, res) => {
    const record = getGovernanceRecord(projectRoot, req.params.runId);
    if (!record) return res.status(404).json({ error: "governance record not found" });
    res.json(record);
  });

  app.post("/api/governance/runs/:runId/approve", (req, res) => {
    const runId = req.params.runId;
    const record = getGovernanceRecord(projectRoot, runId);
    if (!record) return res.status(404).json({ error: "governance record not found" });
    if (!record.approvalRequired) return res.status(409).json({ error: `run ${runId} 是 ${record.level},不需要审批` });
    if (record.approval?.status === "rejected") return res.status(409).json({ error: "已被拒绝,不能再批准" });
    // 撞闸未派发的已批准 record(pendingDispatch 还在 + run 仍 pending)允许重打本接口重试派发
    // (只补派发,不重复记审批);其余已批准一律 409(状态机不可重入)。
    const alreadyApproved = record.approval?.status === "approved";
    const runTask = readJSON<Run | null>(path.join(projectRoot, ".opc", "runs", runId, "task.json"), null);
    if (alreadyApproved && !(record.pendingDispatch && runTask?.status === "pending")) {
      return res.status(409).json({ error: "已批准过,不能重复审批" });
    }

    const decidedBy = typeof (req.body ?? {}).decidedBy === "string" && (req.body.decidedBy as string).trim()
      ? String(req.body.decidedBy).trim().slice(0, 80) : "human";
    const updated = alreadyApproved ? record : setGovernanceApproval(projectRoot, runId, "approved", decidedBy)!;

    // 批准即派发(record 落了 pendingDispatch 的路径,即被网关拦下的 chatRoutes run)。
    // 没有 pendingDispatch 的 record(直调 startRun 被拦的路径)只解锁,由原调用方自行重试。
    let dispatched = false;
    let retryable: boolean | undefined;
    const pd = updated.pendingDispatch;
    // 缺口①根治(2026-07-18 活体:批准撞闸的 run 永久卡 pending)——此前两处撞闸分支只留下
    // "可重试派发"的口头承诺,却没有任何自动重试器,除非有人再打一次本接口。现在撞闸即入
    // P1-5 持久化派发队列:当前 run 结束时 orchestrator finally 的 drainDispatchQueue 自动出队
    // 派发。入队后再伺机 drain 一次,闭 TOCTOU 洞(isRunInFlight 检查到入队落盘之间,在飞 run
    // 恰好结束→它的 finally drain 已经跑过、看不到我们这单,不补一次 drain 就又卡死)。
    // 注:队列项不携带 forceSkills(与 chatRoutes P1-5 队列同一权衡,见 dispatchQueueStore 注释)。
    const enqueueForRetry = () => {
      try {
        enqueueDispatch(projectRoot, {
          id: `gvq-${runId}`, runId, goal: pd!.goal, companyId: pd!.companyId,
          runType: pd!.runType as RunType | undefined, teamMode: pd!.teamMode as TeamMode | undefined,
          enqueuedAt: new Date().toISOString(),
        });
        queueMicrotask(() => { try { drainDispatchQueue(projectRoot); } catch { /* 补位 drain 失败不影响审批结果 */ } });
      } catch (qe) {
        console.warn(`Governance-approved run ${runId} 入派发队列失败(保持 pending,可重打接口重试):`, (qe as Error | undefined)?.message ?? qe);
      }
    };
    if (pd) {
      if (isRunInFlight()) {
        // 撞上单 run 互斥闸:不派发、不烧审批——run 保持 pending、record 保持 approved,
        // 入队等当前 run 结束自动出队派发(不再依赖人工重打接口)。
        enqueueForRetry();
        retryable = true;
      } else {
        // 直接派发前清掉本 run 可能残留的队列项(此前撞闸入过队、现在闸开被重打 approve 直派):
        // 否则 drain 会把同一 run 二次起跑,覆盖真实终态。
        try { removeDispatchItem(projectRoot, runId); } catch { /* best-effort */ }
        dispatched = true;
        startRun(pd.goal, runId, pd.companyId, {
          runType: pd.runType as RunType | undefined,
          teamMode: pd.teamMode as TeamMode | undefined,
          forceSkills: pd.forceSkills,
        }).then(r => {
          console.log(`Governance-approved run ${r.runId} completed: ${r.summary.slice(0, 120)}`);
        }).catch(e => {
          if (isRunInFlightError(e)) {
            // 竞态兜底(isRunInFlight 检查后、startRun 抢闸前恰有别的 run 启动):同样不烧审批,
            // run 保持 pending + record approved,入队等自动出队派发(缺口①同一根治)。
            console.warn(`Governance-approved run ${runId} 撞上单 run 互斥闸,已入派发队列等待自动派发`);
            enqueueForRetry();
          } else {
            markPrecreatedRunFailed(projectRoot, runId, e);
            console.error(`Governance-approved run ${runId} failed:`, e?.message ?? e);
          }
        });
      }
    }
    res.json({ approved: true, dispatched, ...(retryable !== undefined ? { retryable } : {}), record: updated });
  });

  app.post("/api/governance/runs/:runId/reject", (req, res) => {
    const runId = req.params.runId;
    const record = getGovernanceRecord(projectRoot, runId);
    if (!record) return res.status(404).json({ error: "governance record not found" });
    if (!record.approvalRequired) return res.status(409).json({ error: `run ${runId} 是 ${record.level},不需要审批` });
    if (record.approval?.status && record.approval.status !== "pending") {
      return res.status(409).json({ error: `已处于 ${record.approval.status},不能再拒绝` });
    }
    const decidedBy = typeof (req.body ?? {}).decidedBy === "string" && (req.body.decidedBy as string).trim()
      ? String(req.body.decidedBy).trim().slice(0, 80) : "human";
    const updated = setGovernanceApproval(projectRoot, runId, "rejected", decidedBy)!;
    // 缺口①配套:若该 run 已因撞闸入了派发队列,拒绝时同步撤单——否则闸开后 drain 会把被拒的 run 起跑。
    try { removeDispatchItem(projectRoot, runId); } catch { /* best-effort */ }
    // 预建的 pending run(网关拦下时 precreate status="pending")如实收尾成 cancelled,不留僵尸。
    try {
      const task = readJSON<Run | null>(path.join(projectRoot, ".opc", "runs", runId, "task.json"), null);
      if (task && (task.status === "pending" || task.status === "running")) {
        saveRunTask(projectRoot, { ...task, status: "cancelled", endedAt: new Date().toISOString(), degraded: true, degradedReason: "governance L3 审批被拒绝,run 未派发" });
      }
    } catch { /* best-effort */ }
    res.json({ rejected: true, record: updated });
  });

  app.post("/api/governance/runs/:runId/kill", (req, res) => {
    const runId = req.params.runId;
    const record = getGovernanceRecord(projectRoot, runId);
    const registered = listRunPids(runId);
    const killed = killRunPids(runId);
    const stopping = requestStopRun(runId); // 与 kill 配套:同时停止派发新任务(优雅收口既有产出)
    if (record) {
      try { appendGovernanceEvent(projectRoot, runId, { kind: "kill", pids: killed, detail: `已 kill ${killed.length}/${registered.length} 个登记子进程;stopRequested=${stopping}` }); } catch { /* best-effort */ }
    }
    res.json({ killed, stopRequested: stopping });
  });
}
