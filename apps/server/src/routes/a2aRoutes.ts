import type { Express } from "express";
import { a2aActiveRunId, a2aActiveCompanyId, a2aDiscover, a2aRequestChannel, a2aSend, a2aAsk, a2aInbox, a2aAcknowledge, a2aResolve, a2aInjectUserInstruction } from "../runtime/orchestrator.js";
import { enqueueAutomation } from "../runtime/harness.js";
import { listSkills, getSkill } from "../storage/skillStore.js";
// B6 · 读侧直接 import a2aBus(绝不经 orchestrator 转出口——repositorySeam.guard.test 锁死其行号)。
import { readA2AMessageRecords, latestA2ARecords } from "../runtime/a2aBus.js";

// runRoutes.ts 同款安全 token(防 ..%2F 路径穿越读到 .opc 外文件)。
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

// Phase 4(方案B / live 工具级 A2A):A2A HTTP API。worker 子进程经其 code-execution SDK
// (.opc/a2a.cjs)调用本 API,实现 live agent↔agent 协作。形态选「code-execution 面」而非
// JSON-MCP-server(研究背书:三引擎本就是代码 agent,顺势且 token 省)。
//
// 跨进程会话关联(阶段一):调用方携带 from(自身 agentId)+ runId;runId 必须匹配当前活动 run,
//   否则拒绝(防止 stale/越权)。授权沿用 orchestrator 的 canCommunicate(fail-closed)。
// 安全:A2A 是传递性 prompt-injection 攻击面。阶段一仅对「内部可信」场景(同 run/同公司/worktree
//   隔离)开放;阶段二再加 per-worker token 鉴权 + 入站内容净化(见 revised-roadmap.md / 研究报告 §4.3)。

function guardRun(runId: unknown): string | null {
  const active = a2aActiveRunId();
  if (!active) return "当前没有活动的 run";
  if (typeof runId !== "string" || runId !== active) return "runId 与当前活动 run 不匹配(可能已结束)";
  return null;
}

export function register(app: Express, _projectRoot: string) {
  // ── B6 · 前端只读面:历史 A2A 消息(a2a_messages.jsonl → last-wins 合并的每消息最终态)────────
  // 与上面 agent 面(guardRun 锁活 run)不同,这是任意 run 的审计读 API:CapabilityOverview 的
  // resolved 闭环指标 / 任务档案消费。无文件 = 空数组(该 run 没有 A2A 落盘记录,如实返回空)。
  app.get("/api/runs/:id/a2a-messages", (req, res) => {
    const runId = String(req.params.id);
    if (!SAFE_RUN_ID.test(runId)) return res.status(400).json({ error: "invalid run id" });
    const messages = latestA2ARecords(readA2AMessageRecords(_projectRoot, runId));
    res.json({ runId, messages });
  });

  // 本机用户在工作台向运行中的具体员工追加要求。只接受当前活动 run;消息通过 CEO 治理身份
  // 进入真实 A2A inbox,并在该员工下一次执行轮次注入。已结束 run/跨公司员工均 fail-closed。
  app.post("/api/runs/:id/agents/:agentId/instruction", (req, res) => {
    const err = guardRun(req.params.id); if (err) return res.status(409).json({ error: err });
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) return res.status(400).json({ error: "text required" });
    if (text.length > 4000) return res.status(413).json({ error: "instruction too long" });
    const result = a2aInjectUserInstruction(String(req.params.agentId), text);
    res.status(result.ok ? 200 : 409).json(result.ok ? result : { error: result.message });
  });

  // 能力发现:列出本 run 内可协作的同事(agent cards)。
  app.post("/api/a2a/discover", (req, res) => {
    const { runId, from, role, skill, produces } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (!from) return res.status(400).json({ error: "from required" });
    res.json({ agents: a2aDiscover(from, { role, skill, produces }) });
  });

  // 申请与某同事开通通道(待协调者批准 —— 授权 fail-closed)。
  app.post("/api/a2a/request-channel", (req, res) => {
    const { runId, from, target, kind, reason } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (!from || !target) return res.status(400).json({ error: "from/target required" });
    const k = kind === "peer-lead" ? "peer-lead" : "peer-worker";
    res.json(a2aRequestChannel(from, target, k, typeof reason === "string" ? reason : ""));
  });

  // 主动发消息(inform);需已开通通道。
  app.post("/api/a2a/send", (req, res) => {
    const { runId, from, target, text, artifactId } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (!from || !target || typeof text !== "string") return res.status(400).json({ error: "from/target/text required" });
    res.json(a2aSend(from, target, text, typeof artifactId === "string" ? artifactId : undefined));
  });

  // 异步问询:投进对方 inbox 即返回 taskId(不阻塞);对方下一轮看到并回应。
  app.post("/api/a2a/ask", (req, res) => {
    const { runId, from, target, question } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (!from || !target || typeof question !== "string") return res.status(400).json({ error: "from/target/question required" });
    res.json(a2aAsk(from, target, question));
  });

  // 查看自己的 inbox(只看不消费;执行时编排器会自动 drain 注入)。A4: 响应消息带 id/lifecycle,凭 id 可 ack/resolve。
  app.get("/api/a2a/inbox", (req, res) => {
    const { runId, agentId } = req.query;
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (typeof agentId !== "string") return res.status(400).json({ error: "agentId required" });
    res.json({ messages: a2aInbox(agentId) });
  });

  // ── A4 · 消息生命周期回执 ────────────────────────────────────────────────────────
  // ack: delivered → acknowledged(仅收件人)。inbox 从「投出即完成」改为有回执。
  app.post("/api/a2a/ack", (req, res) => {
    const { runId, from, messageId } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (typeof from !== "string" || !from || typeof messageId !== "string" || !messageId) {
      return res.status(400).json({ error: "from/messageId required" });
    }
    const r = a2aAcknowledge(messageId, from);
    if (!r.ok) return res.status(409).json({ error: r.message, lifecycle: r.lifecycle });
    res.json({ ok: true, lifecycle: r.lifecycle, message: r.message });
  });

  // resolve: delivered/acknowledged → resolved(终态;消息参与者闭环该协作事项)。
  app.post("/api/a2a/resolve", (req, res) => {
    const { runId, from, messageId } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (typeof from !== "string" || !from || typeof messageId !== "string" || !messageId) {
      return res.status(400).json({ error: "from/messageId required" });
    }
    const r = a2aResolve(messageId, from);
    if (!r.ok) return res.status(409).json({ error: r.message, lifecycle: r.lifecycle });
    res.json({ ok: true, lifecycle: r.lifecycle, message: r.message });
  });

  // ── 公司级工具(agent 自由调用:技能库 + 排自动化;harness 内核波新增)────────────────
  // 技能只读:列表 + 按名取全文——agent 干活时按需拉技能,不再只依赖开工时的角色注入。
  app.get("/api/a2a/skills", (_req, res) => {
    const metas = listSkills(_projectRoot).filter(s => s.enabled && s.origin !== "persona").slice(0, 50)
      .map(s => ({ id: s.id, title: s.title, role: s.role }));
    res.json({ skills: metas });
  });
  app.get("/api/a2a/skills/:name", (req, res) => {
    const q = String(req.params.name || "").toLowerCase();
    const metas = listSkills(_projectRoot).filter(s => s.enabled && s.origin !== "persona");
    const meta = metas.find(s => s.id.toLowerCase() === q || s.title.toLowerCase() === q)
      ?? metas.find(s => s.title.toLowerCase().includes(q));
    if (!meta) return res.status(404).json({ error: `技能「${req.params.name}」不存在或未启用` });
    const skill = getSkill(_projectRoot, meta.id);
    if (!skill) return res.status(404).json({ error: "技能内容读取失败" });
    res.json({ id: skill.id, title: skill.title, content: skill.content.slice(0, 8000) });
  });

  // 排自动化:agent 在 run 里不能直接起 goal/loop(撞单 run 互斥)——入队,调度器空闲时开跑。
  // guardRun 保证只有当前活动 run 里的调用能排;companyId 取当前 run 的公司。
  app.post("/api/a2a/schedule-goal", (req, res) => {
    const { runId, from, goal } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (typeof goal !== "string" || !goal.trim()) return res.status(400).json({ error: "goal required" });
    try {
      const rec = enqueueAutomation(_projectRoot, {
        kind: "goal", prompt: goal.trim().slice(0, 2000),
        companyId: a2aActiveCompanyId() ?? undefined,
        source: `agent:${typeof from === "string" ? from : "?"}`,
      });
      res.json({ queued: rec.id, note: "已入队:当前任务结束、系统空闲后自动开始(目标模式,默认 3 轮上限)" });
    } catch (e: any) { res.status(429).json({ error: e?.message ?? String(e) }); }
  });
  app.post("/api/a2a/schedule-loop", (req, res) => {
    const { runId, from, prompt } = req.body ?? {};
    const err = guardRun(runId); if (err) return res.status(409).json({ error: err });
    if (typeof prompt !== "string" || !prompt.trim()) return res.status(400).json({ error: "prompt required" });
    try {
      const rec = enqueueAutomation(_projectRoot, {
        kind: "loop", prompt: prompt.trim().slice(0, 2000),
        companyId: a2aActiveCompanyId() ?? undefined,
        source: `agent:${typeof from === "string" ? from : "?"}`,
      });
      res.json({ queued: rec.id, note: "已入队:当前任务结束、系统空闲后自动开始(连续模式,默认 5 轮上限)" });
    } catch (e: any) { res.status(429).json({ error: e?.message ?? String(e) }); }
  });
}
