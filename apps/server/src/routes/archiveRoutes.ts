import type { Express, Response } from "express";
import {
  archiveCompany, archiveRuns, restoreArchive, listArchives,
  ArchiveConflictError, ArchiveNotFoundError,
} from "../storage/archiveStore.js";
import { isDispatchInFlight } from "../runtime/runMutex.js";
import { removeAgentsByCompany, addAgents } from "../runtime/orchestrator.js";

// 归档路由:归档=移动到 .opc/archive/<ts>/(可恢复),绝不删除证据文件。所有归档写操作前置双闸:
// ① isDispatchInFlight()——有活 run 时移动 run 目录/改写 agents.json 都不安全,一律 409;
// ② store 层按 run 索引 status 再查目标公司/run 自身是否在飞(见 archiveStore)。
// 内存一致性(本任务最险的坑):orchestrator 单例持有 agents 内存数组,归档公司后必须同步剔除,
// 否则下一次 mergeSaveAgents(如任一 agent 状态变化)会把归档掉的员工写回 agents.json("复活")。
// removeAgentsByCompany 同时清磁盘与内存;恢复侧对称调用 addAgents 把员工加回内存。

const BUSY_MSG = "现在有任务正在进行,归档需要移动任务文件,请等当前任务完成后再试";

function sendArchiveError(res: Response, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof ArchiveConflictError) { res.status(409).json({ error: msg }); return; }
  if (e instanceof ArchiveNotFoundError) { res.status(404).json({ error: msg }); return; }
  res.status(400).json({ error: msg });
}

export function register(app: Express, projectRoot: string) {
  app.get("/api/archive", (_req, res) => {
    try {
      res.json(listArchives(projectRoot));
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/archive/company/:id", (req, res) => {
    if (isDispatchInFlight()) return res.status(409).json({ error: BUSY_MSG });
    try {
      const manifest = archiveCompany(projectRoot, req.params.id);
      removeAgentsByCompany(req.params.id);
      res.json({
        archived: true, archiveId: manifest.archiveId,
        runCount: manifest.runIds.length, agentCount: manifest.agents.length,
      });
    } catch (e) {
      sendArchiveError(res, e);
    }
  });

  app.post("/api/archive/runs", (req, res) => {
    if (isDispatchInFlight()) return res.status(409).json({ error: BUSY_MSG });
    const runIds = req.body?.runIds;
    if (!Array.isArray(runIds) || runIds.length === 0 || runIds.some((x: unknown) => typeof x !== "string")) {
      return res.status(400).json({ error: "runIds required(非空字符串数组)" });
    }
    try {
      const manifest = archiveRuns(projectRoot, runIds);
      res.json({ archived: true, archiveId: manifest.archiveId, runCount: manifest.runIds.length });
    } catch (e) {
      sendArchiveError(res, e);
    }
  });

  app.post("/api/archive/:archiveId/restore", (req, res) => {
    if (isDispatchInFlight()) return res.status(409).json({ error: BUSY_MSG });
    try {
      const manifest = restoreArchive(projectRoot, req.params.archiveId);
      if (manifest.kind === "company" && manifest.agents.length > 0) addAgents(manifest.agents);
      res.json({
        restored: true, archiveId: manifest.archiveId, kind: manifest.kind,
        runCount: manifest.runIds.length, agentCount: manifest.agents.length,
      });
    } catch (e) {
      sendArchiveError(res, e);
    }
  });
}
