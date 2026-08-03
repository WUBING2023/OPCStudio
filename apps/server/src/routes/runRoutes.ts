import type { Express, Request, Response } from "express";
import type { TraceEvent } from "@opc/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { startRun, getRunChannels, getRunMessages, requestRunChannel, decideRunChannel, openRunChannel, requestStopRun, getAgents } from "../runtime/orchestrator.js";
import { buildPostmortem } from "../runtime/failurePostmortem.js";
import { runBenchmark, runBenchmarkComparison, benchmarkComparisonTable, type BenchmarkVariant } from "../runtime/benchmark.js";
import { setInjectionEnabled, isInjectionEnabled } from "../runtime/contextBuilder.js";
import { loadRunArtifacts } from "../runtime/runArtifacts.js";
import { deriveRunStory } from "../runtime/runStory.js";
import { deriveRunMemories } from "../runtime/runMemories.js";
import { artifactLineage, resolveArtifactDownload, resolveArtifactPreview } from "../runtime/artifactLineage.js";
import { getAllReports, getReportsByTeam, getCrossTeamReports, getReportContent, updateReportMetaName, loadChanges, loadDeferred, loadStructuredReport, loadRunIndex, loadRunTask, loadRunReport, loadRunEventsRaw } from "../storage/projectStore.js";
import { computeRunLedger } from "../runtime/costSummary.js";
import { buildEvidenceManifest, loadEvidenceManifest, verifyEvidenceManifest } from "../runtime/evidenceManifest.js";
import {
  bindIdempotencyTarget,
  claimIdempotency,
  completeIdempotency,
  hashIdempotencyRequest,
  validateIdempotencyKey,
} from "../storage/idempotencyStore.js";

// 安全:runId 必须是安全 token(防 ..%2F 路径穿越读到 projectRoot 外的文件,如 keys/config)。
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

// run-scoped 只读路由的统一存在性判据:该 run 的 task.json 是否落盘(orchestrator 起跑即写,是 run
// 存在的权威信号)。此前只有 /changes 查它,其余 run-scoped GET 对不存在的 run 返回 200 空壳——语义
// 可被伪造成"这个 run 真有、只是没数据"。收口到 requireRunExists(register 内闭包),不存在一律 404。
// 导出:eventRoutes/memoryRoutes 里同样的 run-scoped GET(见文件末尾接入点清单)后续可复用同一判据。
export function runExists(projectRoot: string, runId: string): boolean {
  return fs.existsSync(path.join(projectRoot, ".opc", "runs", runId, "task.json"));
}

function isGitRepo(root: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function hasGitChanges(root: string): boolean {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], { cwd: root, stdio: "pipe", encoding: "utf-8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// P0 RunEnvelope:run 实际的 git 工作发生在该 run 的公司工作根(orchestrator.ts activeWorkRoot,见其注释
// "the run works inside the company's workspace folder, NOT the app repo"),不是 projectRoot——
// 默认公司就落在 <projectRoot>/.opc-studio/default,是与 projectRoot 分开的另一个 git 仓库。
// 现在 workRoot 是 Run 的持久字段(task.json.workRoot,orchestrator 起跑时写、不可变),解析优先级:
//   ① task.json.workRoot(权威);
//   ② 历史 run 无该字段 → 从 events.jsonl "工作目录: <path>" info 事件文本推断(与 runMemories/runStory 同派生模式);
//   ③ 两者都无 → 返回 null(**绝不回退 projectRoot**——否则 diff/approve/下载会误操作项目仓库自身)。调用方各自 404/明确错误。
const WORK_ROOT_PREFIX = "工作目录: ";
export function resolveRunWorkRoot(projectRoot: string, runId: string): string | null {
  // ① 持久字段(权威)
  try {
    const wr = loadRunTask(projectRoot, runId)?.workRoot;
    if (typeof wr === "string" && wr.trim()) return wr;
  } catch { /* 落到事件推断 */ }
  // ② 历史 run 回退:events.jsonl "工作目录: <path>" 文本推断
  try {
    const raw = loadRunEventsRaw(projectRoot, runId);
    if (raw !== null) {
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let evt: TraceEvent;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.type !== "info") continue;
        const msg = (evt.payload as { message?: unknown } | null)?.message;
        if (typeof msg === "string" && msg.startsWith(WORK_ROOT_PREFIX)) {
          const root = msg.slice(WORK_ROOT_PREFIX.length).trim();
          if (root && fs.existsSync(root)) return root;
        }
      }
    }
  } catch { /* 落到 null */ }
  // ③ 都推断不出 → null(绝不兜底 projectRoot)
  return null;
}

export function register(app: Express, projectRoot: string) {
  const runs: any[] = [];

  // 所有 run-scoped GET 的入口守卫:runId 合法(SAFE_RUN_ID,防路径穿越)且该 run 存在(runExists)。
  // 任一不满足即写 4xx 并返回 false,调用方模式统一为 `if (!requireRunExists(req, res)) return;`。
  // 400(非法 id)必须先于 404(不存在),与既有各路由顺序一致。
  const requireRunExists = (req: Request, res: Response): boolean => {
    const id = String(req.params.id);
    if (!SAFE_RUN_ID.test(id)) { res.status(400).json({ error: "invalid run id" }); return false; }
    if (!runExists(projectRoot, id)) { res.status(404).json({ error: "run not found" }); return false; }
    return true;
  };

  // 从磁盘(.opc/runs/*/task.json)派生运行列表 —— 之前返回的是进程内存数组,重启即空、且 chatTask 启动的 run
  // 根本不进这个数组(它只被 POST /api/runs append),导致 UI 运行列表恒空、启动台不退。改读盘=真相来源。
  app.get("/api/runs", (req, res) => {
    try {
      // P2#7 滚动索引:增量维护的 _index.json(缺失时懒重建一次),不再每请求全目录扫描。
      // 字段是旧形状的超集(新增 degraded/endedAt/totalTokens/totalCostUsd/agents/summary,任务档案卡直接用)。
      // ?company=<id> 按公司过滤(公司作用域;无 companyId 的旧 run 只出现在不过滤的"全部"里)。
      let rows = loadRunIndex(projectRoot);
      const company = typeof req.query.company === "string" && req.query.company ? req.query.company : undefined;
      if (company) rows = rows.filter((r) => r.companyId === company);
      // 工作台部门群按真实参与员工过滤。索引里的 agentIds 只为头像展示且会截断,不能据此判定归属;
      // 仅显式传 agents= 时读取候选 task.json 做准确过滤,普通 /runs 列表仍走纯索引快路径。
      const participantIds = typeof req.query.agents === "string"
        ? new Set(req.query.agents.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 64))
        : null;
      if (participantIds?.size) {
        rows = rows.filter((row) => {
          const task = loadRunTask(projectRoot, row.id);
          return !!task?.participatingAgents?.some((id) => participantIds.has(id));
        });
      }
      if (rows.length > 0 || company || participantIds) return res.json(rows.slice(0, 200));
      const led = computeRunLedger(projectRoot, { offset: 0, limit: 200 }); // 兜底:索引为空(全新项目)
      res.json(led.rows.map(r => ({ id: r.runId, goal: r.goal, status: r.status ?? (r.degraded ? "degraded" : "done"), startedAt: r.startedAt })));
    } catch {
      res.json([]);
    }
  });

  // v5: 当前运行的通信通道 + 消息（UI 画"谁和谁有通道/正在交流"）。
  app.get("/api/channels", (_req, res) => {
    res.json({ ...getRunChannels(), messages: getRunMessages() });
  });

  // v5 P3：worker 申请与某人交流（待协调者批准）。
  app.post("/api/channels/request", (req, res) => {
    const { from, to, kind, reason } = req.body ?? {};
    if (!from || !to || !kind) return res.status(400).json({ error: "from/to/kind required" });
    const r = requestRunChannel(from, to, kind, reason ?? "");
    res.status(r.error ? 400 : 200).json(r);
  });
  // 协调者批准/拒绝申请。
  app.post("/api/channels/decide", (req, res) => {
    const { requestId, grant, decidedBy } = req.body ?? {};
    if (!requestId || !decidedBy) return res.status(400).json({ error: "requestId/decidedBy required" });
    res.json(decideRunChannel(requestId, grant !== false, decidedBy));
  });
  // 协调者直接开通道（lead 给同队 worker 互通；CEO 给 lead 开学习通道）。
  app.post("/api/channels/open", (req, res) => {
    const { a, b, kind, coordinatedBy, reason } = req.body ?? {};
    if (!a || !b || !kind || !coordinatedBy) return res.status(400).json({ error: "a/b/kind/coordinatedBy required" });
    const r = openRunChannel(a, b, kind, coordinatedBy, reason);
    res.status(r.error ? 400 : 200).json(r);
  });

  app.post("/api/runs", async (req, res) => {
    try {
      const { goal } = req.body;
      if (!goal || typeof goal !== "string") return res.status(400).json({ error: "goal required" });
      const result = await startRun(goal);
      runs.unshift({ id: result.runId, goal, status: "done", startedAt: new Date().toISOString() });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/runs/:id", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      const data = loadRunTask(projectRoot, req.params.id);
      if (!data) return res.status(404).json({ error: "run not found" });
      res.json(data);
    } catch {
      res.status(404).json({ error: "run not found" });
    }
  });

  app.get("/api/runs/:id/report", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      const md = loadRunReport(projectRoot, req.params.id);
      if (md === null) return res.status(404).json({ error: "report not found" });
      res.json({ md });
    } catch {
      res.status(404).json({ error: "report not found" });
    }
  });

  app.get("/api/runs/:id/diff", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      const root = resolveRunWorkRoot(projectRoot, req.params.id);
      if (!root) return res.status(404).json({ error: "该历史 run 未记录工作区,无法生成 diff" });
      if (!isGitRepo(root)) return res.json({ diff: "" });
      if (!hasGitChanges(root)) return res.json({ diff: "" });
      const diff = execFileSync("git", ["diff"], { cwd: root, stdio: "pipe", encoding: "utf-8" });
      res.json({ diff });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Structured file changes produced by the run's accepted worker diffs (for DiffReviewPanel / "产出文件" 区块).
  // workRoot 一并回传:changes.json 里的 path 都是相对该 run 工作区(resolveRunWorkRoot,同 diff/approve/reject
  // 用的那套解析),前端需要它拼出资源管理器/file:// 链接的绝对路径。
  app.get("/api/runs/:id/changes", (req, res) => {
    if (!requireRunExists(req, res)) return;
    const workRoot = resolveRunWorkRoot(projectRoot, req.params.id);
    res.json({ workRoot, changes: loadChanges(projectRoot, req.params.id) });
  });

  // B4 · 单一证据清单:GET 读 run-end 落盘的 manifest.json(缺失则现扫兜底,如老 run);
  // ?verify=1 → 重算各证据文件 sha256 与 manifest 存的比对,报 mismatches(证据链防篡改自证)。
  app.get("/api/runs/:id/evidence", (req, res) => {
    if (!requireRunExists(req, res)) return;
    const runDir = path.join(projectRoot, ".opc", "runs", req.params.id);
    try {
      if (req.query.verify === "1" || req.query.verify === "true") {
        return res.json(verifyEvidenceManifest(runDir));
      }
      // manifest.json 存在直接回;老 run(run-end 前无此文件)现扫构建兜底(tests 缺省 null——不追溯旧测试)
      const manifest = loadEvidenceManifest(runDir) ?? buildEvidenceManifest(runDir);
      res.json(manifest);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "evidence manifest failed" });
    }
  });

  // "打开产出文件夹":用系统资源管理器(Windows 桌面应用合法能力)把 run 的实际产出目录亮给用户看——
  // 修上游那个信任缺口的直接手段(文件明明真实落盘在 workRoot,用户却只在任务详情里看到报告文本)。
  // body.path 可选:相对 workRoot 的具体文件/目录(不传则打开 workRoot 根)。
  // 安全:resolve 后必须落在 workRoot 内(词法前缀比对,防 ../ 穿越到公司工作区外)。
  app.post("/api/runs/:id/open-folder", (req, res) => {
    try {
      if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
      const root = resolveRunWorkRoot(projectRoot, req.params.id);
      if (!root) return res.status(404).json({ error: "该历史 run 未记录工作区" });
      const rootAbs = path.resolve(root);
      const rel = typeof req.body?.path === "string" ? req.body.path : "";
      let target = rootAbs;
      if (rel) {
        const abs = path.resolve(rootAbs, rel);
        if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) {
          return res.status(400).json({ error: "path escapes workRoot" });
        }
        target = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
      }
      if (!fs.existsSync(target)) return res.status(404).json({ error: "folder not found" });
      if (process.platform !== "win32") return res.status(400).json({ error: "open-folder only supported on Windows" });

      let responded = false;
      const child = spawn("explorer.exe", [target], { detached: true, stdio: "ignore" });
      child.on("error", (err) => {
        if (responded) return;
        responded = true;
        res.status(500).json({ error: err.message });
      });
      child.on("spawn", () => {
        if (responded) return;
        responded = true;
        child.unref();
        res.json({ ok: true, opened: target });
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Track C · C1 失败复盘卡:失败/降级/有延后的 run 的结构化复盘(原因/建议/操作)。
  // 纯派生自已落盘证据(task.json/failure-report.json/run-summary.json/deferred.json),见
  // runtime/failurePostmortem.ts。run 不存在 → 404;成功且无失败信号 → { available:false }。
  app.get("/api/runs/:id/postmortem", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      const pm = buildPostmortem(projectRoot, req.params.id, {
        nameOf: (agentId) => getAgents().find((a) => a.id === agentId)?.name,
      });
      if (!pm) return res.status(404).json({ error: "run not found" });
      res.json(pm);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Tasks deferred during the run (stuck → skipped → summarized).
  app.get("/api/runs/:id/deferred", (req, res) => {
    if (!requireRunExists(req, res)) return;
    res.json({ deferred: loadDeferred(projectRoot, req.params.id) });
  });

  // Structured run report (report center).
  app.get("/api/runs/:id/structured-report", (req, res) => {
    if (!requireRunExists(req, res)) return;
    const report = loadStructuredReport(projectRoot, req.params.id);
    if (!report) return res.status(404).json({ error: "structured report not found" });
    res.json(report);
  });

  // Stage 2/3 · 产物归集:优先 Stage 3 注册表(producer/状态/来源链),回退 Stage 2 纯派生。
  app.get("/api/runs/:id/artifacts", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      res.json(loadRunArtifacts(projectRoot, req.params.id));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 3 · 单个产物详情(?artifactId= 避免 file:path 斜杠问题)。
  app.get("/api/runs/:id/artifacts/detail", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      if (!req.query.artifactId) return res.status(400).json({ error: "artifactId required" });
      const aid = String(req.query.artifactId);
      const col = loadRunArtifacts(projectRoot, req.params.id);
      const art = col.artifacts.find(a => a.id === aid);
      if (!art) return res.status(404).json({ error: "artifact not found" });
      res.json(art);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 3 · 单个产物的来源链/血缘(上游来源 + 下游消费者)。
  app.get("/api/runs/:id/artifacts/lineage", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      if (!req.query.artifactId) return res.status(400).json({ error: "artifactId required" });
      const aid = String(req.query.artifactId);
      const col = loadRunArtifacts(projectRoot, req.params.id);
      const lin = artifactLineage(col, aid);
      if (!lin) return res.status(404).json({ error: "artifact not found" });
      res.json(lin);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 3 · 下载单个产物(report → report.md;file → 工作区文件,词法+realpath 双重越界守卫)。
  app.get("/api/runs/:id/artifacts/download", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      if (!req.query.artifactId) return res.status(400).json({ error: "artifactId required" });
      const aid = String(req.query.artifactId);
      const col = loadRunArtifacts(projectRoot, req.params.id);
      const art = col.artifacts.find(a => a.id === aid);
      if (!art) return res.status(404).json({ error: "artifact not found" });
      const workRoot = resolveRunWorkRoot(projectRoot, req.params.id);
      const resolved = resolveArtifactDownload(projectRoot, workRoot, req.params.id, art);
      if (!resolved) return res.status(404).json({ error: "artifact not downloadable" });
      res.setHeader("Content-Type", resolved.contentType);
      res.setHeader("Content-Disposition", `attachment; filename="${resolved.filename}"`);
      res.send(resolved.body);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 成果卡文本预览(report/file/worker-output 归档):大小上限 + 超限截断标注,复用下载解析的越界守卫。
  // 不可预览(状态不可下载 / 无实体来源)→ 404。
  app.get("/api/runs/:id/artifacts/preview", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      if (!req.query.artifactId) return res.status(400).json({ error: "artifactId required" });
      const aid = String(req.query.artifactId);
      const col = loadRunArtifacts(projectRoot, req.params.id);
      const art = col.artifacts.find(a => a.id === aid);
      if (!art) return res.status(404).json({ error: "artifact not found" });
      const workRoot = resolveRunWorkRoot(projectRoot, req.params.id);
      const preview = resolveArtifactPreview(projectRoot, workRoot, req.params.id, art);
      if (!preview) return res.status(404).json({ error: "artifact not previewable" });
      res.json(preview);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 2 · Trace Summary v1:把事件流翻成人话 run story(里程碑级,滤掉低层噪声)。
  app.get("/api/runs/:id/story", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      res.json(deriveRunStory(projectRoot, req.params.id));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stage 4 · 本次 run 用了哪些记忆:每个 agent 注入的 memoryId + 解析内容(可选 ?agentId= 过滤)。
  app.get("/api/runs/:id/memories", (req, res) => {
    if (!requireRunExists(req, res)) return;
    try {
      const usage = deriveRunMemories(projectRoot, req.params.id);
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      if (agentId) usage.injections = usage.injections.filter(i => i.agentId === agentId);
      res.json(usage);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 分享欲 Stage · 对话回放剧本:把 events.jsonl 里的 agent_message + 关键领域事件翻成结构化"群聊
  // 剧本"条目,供任务详情"对话回放" tab(ChatReplay.tsx)与导出分享 HTML 复用。只读、纯派生,同
  // deriveRunStory/deriveRunMemories 模式(见 runtime/runStory.ts、runtime/runMemories.ts):找不到
  // 文件/解析失败一律返回空 entries,绝不抛。
  //
  // 范围刻意小于 ProcessTimeline 的"过程回放"(它读 loadRunSummary→run-history.jsonl,那份数据
  // 额外含 agent_deferred/worker_timeout/module_stuck——这三种领域事件只 append 进 run-history.jsonl,
  // 不 emit() 落 events.jsonl,见 orchestrator.ts 收尾处注释"尚未经 emit 表面流出的领域事件")。
  // 若把它们也塞进这里,历史 run 会静默缺失(events.jsonl 里根本没有)而直播 run 又看得到,数据不一致——
  // 索性不收:这三类留给"过程回放" tab 的既有事实来源,对话回放只讲 events.jsonl 确实记录的部分。
  const CHAT_ENTRY_TEXT_CAP = 8000; // 防御:worker 产出偶发超长,截断避免响应体失控(前端仍可去"结果"段看全文)。
  const chatTrunc = (s: unknown): string | undefined => {
    if (typeof s !== "string" || !s) return undefined;
    return s.length > CHAT_ENTRY_TEXT_CAP ? `${s.slice(0, CHAT_ENTRY_TEXT_CAP)}…` : s;
  };
  function deriveChatTranscript(runId: string): { runId: string; entries: Array<Record<string, unknown>> } {
    const entries: Array<Record<string, unknown>> = [];
    try {
      const rawFile = loadRunEventsRaw(projectRoot, runId);
      if (rawFile === null) return { runId, entries };
      for (const raw of rawFile.split("\n")) {
        if (!raw.trim()) continue;
        let ev: TraceEvent;
        try { ev = JSON.parse(raw) as TraceEvent; } catch { continue; }
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        const base = { id: ev.id, at: ev.timestamp };
        switch (ev.type) {
          case "run_started":
            entries.push({ ...base, kind: "system_start", text: chatTrunc(p.goal) });
            break;
          case "agent_message": {
            const text = chatTrunc(p.text);
            if (!text) break; // 无文本内容(如纯元数据消息)不入剧本
            entries.push({ ...base, kind: "message", agentId: ev.agentId, text, meta: { audience: p.audience } });
            break;
          }
          case "verifier_result":
            entries.push({ ...base, kind: "verifier", agentId: ev.agentId, meta: { producer: p.producer, method: p.method, accept: p.accept, reason: p.reason } });
            break;
          case "artifact_rejected":
            entries.push({ ...base, kind: "rejected", agentId: ev.agentId, meta: { artifactId: p.artifactId, reason: p.reason } });
            break;
          case "deliverable_degraded":
            entries.push({ ...base, kind: "degraded", meta: { reason: p.reason } });
            break;
          case "run_finished":
            entries.push({ ...base, kind: "system_end", meta: { totalTokens: p.totalTokens, totalCost: p.totalCost, allClean: p.allClean, deferredCount: p.deferredCount, failed: p.failed } });
            break;
          default:
            break; // 其余类型(model_call_*/tool_call/agent_output_chunk/info 等)是执行层噪声,剧本不收
        }
      }
    } catch { /* best-effort → 已收集的 entries */ }
    return { runId, entries };
  }

  app.get("/api/runs/:id/transcript", (req, res) => {
    if (!requireRunExists(req, res)) return;
    res.json(deriveChatTranscript(req.params.id));
  });

  // P0#13 拆弹:approve/reject 只作用于**该 run 自己改动的文件**(changes.json 清单)。
  // 之前 `git add -A` / `git checkout .` 打在整个工作根上——工作根常就是产品仓库本身,
  // 会把与该 run 无关的所有未提交工作一并提交/抹掉(本次审计期间差点真实发生)。
  const runChangedPaths = (runId: string): string[] => {
    try {
      const arr = loadChanges(projectRoot, runId) as Array<{ path?: string }>;
      return [...new Set((Array.isArray(arr) ? arr : []).map((c) => String(c?.path || "")).filter(Boolean))];
    } catch { return []; }
  };

  app.post("/api/runs/:id/approve", (req, res) => {
    try {
      // 安全:runId token 守卫 + execFileSync(无 shell)双重防命令注入(runId 进了 git commit -m)。
      if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
      const root = resolveRunWorkRoot(projectRoot, req.params.id);
      if (!root) return res.status(400).json({ error: "该历史 run 未记录工作区,无法审批(拒绝对项目仓库自身操作)" });
      if (!isGitRepo(root)) return res.status(400).json({ error: "not a git repository" });
      const paths = runChangedPaths(req.params.id);
      if (paths.length === 0) return res.status(400).json({ error: "该 run 无文件改动记录(changes.json 为空),拒绝整仓 add -A" });
      execFileSync("git", ["add", "--", ...paths], { cwd: root, stdio: "pipe" });
      execFileSync("git", ["commit", "-m", `OPC approved: ${req.params.id}`], { cwd: root, stdio: "pipe" });
      res.json({ ok: true, files: paths.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // P0#11 · 最小取消能力:置停止标志 → run 在下一个派发闸点优雅收口(停止派新任务,已有产出照常合成交付)。
  app.post("/api/runs/:id/stop", (req, res) => {
    try {
      if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
      const idempotencyKey = req.get("idempotency-key")?.trim();
      if (idempotencyKey && !validateIdempotencyKey(idempotencyKey)) {
        return res.status(400).json({ error: "invalid idempotency key" });
      }
      if (idempotencyKey) {
        const requestHash = hashIdempotencyRequest({ runId: req.params.id, reason: req.body?.reason });
        const claim = claimIdempotency(projectRoot, idempotencyKey, "run.stop", requestHash);
        if (claim.kind === "conflict") return res.status(409).json({ error: "idempotency_conflict" });
        if (claim.kind === "replay") {
          return res.status(claim.record.statusCode ?? 200).json(claim.record.response ?? { ok: true });
        }
        bindIdempotencyTarget(projectRoot, idempotencyKey, req.params.id);
      }
      const active = requestStopRun(req.params.id);
      const body = { ok: true, active, note: active ? "已请求停止:正在取消当前模型/工具调用,并用已有产出诚实收口" : "该 run 当前不在执行中(标志已置,若它仍在跑会生效)" };
      if (idempotencyKey) completeIdempotency(projectRoot, idempotencyKey, 200, body);
      res.json(body);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/runs/:id/reject", (req, res) => {
    try {
      if (!SAFE_RUN_ID.test(req.params.id)) return res.status(400).json({ error: "invalid run id" });
      const root = resolveRunWorkRoot(projectRoot, req.params.id);
      if (!root) return res.status(400).json({ error: "该历史 run 未记录工作区,无法回滚(拒绝对项目仓库自身操作)" });
      if (!isGitRepo(root)) return res.status(400).json({ error: "not a git repository" });
      const paths = runChangedPaths(req.params.id);
      if (paths.length === 0) return res.status(400).json({ error: "该 run 无文件改动记录(changes.json 为空),拒绝整仓 checkout ." });
      // 复审抓出(medium-high):changeType=create 的文件是 untracked,`git checkout --` 对其 pathspec 不匹配
      // → 整条命令炸 500、一个文件都没回滚。按类型分流:新建 → 直接删;修改/删除 → checkout 还原。
      const changes = loadChanges(projectRoot, req.params.id) as Array<{ path?: string; changeType?: string }>;
      const created = new Set(changes.filter((c) => c?.changeType === "create").map((c) => String(c?.path || "")).filter(Boolean));
      const tracked = paths.filter((p) => !created.has(p));
      if (tracked.length) execFileSync("git", ["checkout", "--", ...tracked], { cwd: root, stdio: "pipe" });
      let removed = 0;
      for (const p of created) {
        const abs = path.resolve(root, p);
        if (!abs.startsWith(path.resolve(root) + path.sep)) continue; // 防 changes.json 被污染时越界删
        try { fs.rmSync(abs, { force: true }); removed++; } catch { /* 已不存在等 */ }
      }
      res.json({ ok: true, files: paths.length, reverted: tracked.length, removed });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Report API — team-based archive
  app.get("/api/reports", (_req, res) => {
    try {
      const data = getAllReports(projectRoot);
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/reports/:teamId", (req, res) => {
    try {
      const reports = req.params.teamId === "__cross-team"
        ? getCrossTeamReports(projectRoot)
        : getReportsByTeam(projectRoot, req.params.teamId);
      res.json(reports);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/reports/:teamId/:filename", (req, res) => {
    try {
      const content = getReportContent(projectRoot, req.params.teamId, req.params.filename);
      if (content === null) return res.status(404).json({ error: "report not found" });
      res.json({ md: content });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Benchmark
  app.post("/api/benchmark/run", async (_req, res) => {
    try {
      const getStats = (runId: string) => {
        const data = loadRunTask(projectRoot, runId);
        if (!data) return null;
        return { tokens: data.totalTokens ?? 0, cost: data.totalCostUsd ?? 0 };
      };
      if (_req.query.mode === "comparison") {
        // weak+memory (injection ON) vs bare (injection OFF), same configured model. Differentiates
        // the value of accumulated memory/skills directly. (Per-node weak/strong model override is
        // a future enhancement; this measures memory's contribution.)
        const runVariant = async (goal: string, v: BenchmarkVariant) => {
          const prev = isInjectionEnabled(); // 复审加固:恢复进入前快照,而非无条件 true(否则 bare 臂实验的 kill-switch 会被 benchmark 静默翻回)
          setInjectionEnabled(v.useMemorySkills);
          try { return await startRun(goal); } finally { setInjectionEnabled(prev); }
        };
        const weak: BenchmarkVariant = { label: "weak+memory", provider: "deepseek", model: "deepseek-v4-pro", useMemorySkills: true };
        const strong: BenchmarkVariant = { label: "strong-bare", provider: "deepseek", model: "deepseek-v4-pro", useMemorySkills: false };
        const comparison = await runBenchmarkComparison(runVariant, getStats, projectRoot, { weak, strong });
        return res.json({ comparison, table: benchmarkComparisonTable(comparison) });
      }
      const results = await runBenchmark(startRun, getStats, projectRoot);
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
