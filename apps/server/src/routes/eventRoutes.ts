import type { Express } from "express";
import type { TraceEvent } from "@opc/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { subscribe, unsubscribe } from "../runtime/eventBus.js";
import { loadRunSummary } from "../storage/runHistoryStore.js";
import { loadRunEventsRaw } from "../storage/projectStore.js";
import { runExists } from "./runRoutes.js";

// 安全:runId 必须是安全 token 或字面量 "latest"(防 ..%2F 路径穿越读到 .opc/runs 外的文件)——
// 同 runRoutes.ts 的 SAFE_RUN_ID。
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

// MUP B5:SSE 心跳周期。注释行(冒号开头)EventSource 原生忽略,只为让代理/客户端确认连接活着;
// 绝不经 eventBus.emit(否则污染 events.jsonl/RunHistory 并流进前端 addEvent)。
const SSE_HEARTBEAT_MS = 15_000;

export function register(app: Express, projectRoot: string, opts?: { heartbeatMs?: number }) {
  const heartbeatMs = opts?.heartbeatMs ?? SSE_HEARTBEAT_MS;
  // 实时事件流(SSE)。
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // MUP B5:writeHead 只暂存头部,字节要到首次 write 才上网线——空闲服务器(无 run)上客户端
    // 零字节、EventSource 停在 CONNECTING、onopen 永不触发。立即 flush + 写一行连接注释,
    // 让首字节不依赖任何业务事件。
    res.flushHeaders();
    res.write(": connected\n\n");
    const hb = setInterval(() => { res.write(": hb\n\n"); }, heartbeatMs);
    hb.unref?.();
    const onEvent = (event: TraceEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    subscribe(onEvent);
    req.on("close", () => {
      // P0#8:客户端断开(刷新/关闭标签页)时反注册,否则 listener 永久留在 eventBus 里
      // 持续收事件并 res.write 到已关闭的连接上 —— 长跑服务下逐个连接累积成内存/描述符泄漏。
      clearInterval(hb);
      unsubscribe(onEvent);
    });
  });

  // Phase 0(工作台):历史事件回放。读 <projectRoot>/.opc/runs/<id>/events.jsonl,
  // 可选 ?agentId= 过滤,供聊天/监视台拉回刷新或重连丢失的历史。
  // 历史事件回放。id 可为具体 runId,或 "latest"(取磁盘上最新的 run)。返回 {runId, events}。
  // 工作台监视台用它把"连上 SSE 之前/刷新前"的活动加载回来(否则只看得到实时片段)。
  app.get("/api/runs/:id/events", (req, res) => {
    try {
      let id = req.params.id;
      if (id !== "latest" && !SAFE_RUN_ID.test(id)) return res.status(400).json({ error: "invalid run id" });
      const runsDir = path.join(projectRoot, ".opc", "runs");
      if (id === "latest") {
        const cands = fs.existsSync(runsDir)
          ? fs.readdirSync(runsDir).map((d) => ({ d, p: path.join(runsDir, d, "events.jsonl") })).filter((x) => fs.existsSync(x.p))
          : [];
        cands.sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
        if (!cands.length) return res.json({ runId: null, events: [] });
        id = cands[0].d;
      } else if (!runExists(projectRoot, id)) {
        // MUP B7:不存在的 run 一律 404(与 runRoutes.requireRunExists 同源判据 task.json)。
        // 保留:run 存在但 events.jsonl 缺失 → 200 空数组(useAgentStore.loadHistory 依赖)。
        return res.status(404).json({ error: "run not found" });
      }
      const raw = loadRunEventsRaw(projectRoot, id);
      if (raw === null) return res.json({ runId: id, events: [] });
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
      const events = raw
        .split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as TraceEvent; } catch { return null; } })
        .filter((e): e is TraceEvent => e !== null);
      res.json({ runId: id, events: agentId ? events.filter((e) => e.agentId === agentId) : events });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // E5 trace viewer:从事件流 replay 派生的 run 摘要(参与方/事件计数/降级状态/关键领域事件时间线)。
  // id 可为具体 runId 或 "latest"(取磁盘最新 run)。供前端历史回放视图,与实时 SSE(/api/events)互补。
  app.get("/api/runs/:id/trace", (req, res) => {
    try {
      let id = req.params.id;
      if (id !== "latest" && !SAFE_RUN_ID.test(id)) return res.status(400).json({ error: "invalid run id" });
      const runsDir = path.join(projectRoot, ".opc", "runs");
      if (id === "latest") {
        const cands = fs.existsSync(runsDir)
          ? fs.readdirSync(runsDir)
              .map((d) => ({ d, p: path.join(runsDir, d, "events.jsonl") }))
              .filter((x) => fs.existsSync(x.p))
          : [];
        cands.sort((a, b) => fs.statSync(b.p).mtimeMs - fs.statSync(a.p).mtimeMs);
        if (!cands.length) return res.json({ runId: null, totalEvents: 0, timeline: [], participatingAgents: [] });
        id = cands[0].d;
      } else if (!runExists(projectRoot, id)) {
        // MUP B7:存在性判据与 runExists 同源(task.json)——存在但零事件 → 200 空摘要,
        // 不再以"有无事件"判 run 是否存在(此前较早批次 run 无 events.jsonl 被误判 404)。
        return res.status(404).json({ error: "run not found" });
      }
      res.json(loadRunSummary(projectRoot, id));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
