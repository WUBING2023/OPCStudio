import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { AgentNodeConfig } from "@opc/shared";
import { type ChatMessage } from "../runtime/modelGateway.js";
import { getAgents, startRun } from "../runtime/orchestrator.js";
import { emit } from "../runtime/eventBus.js";
import { getRolePrompt } from "../runtime/prompts.js";
import { readAgentMemory } from "../storage/mdMemory.js";
import { appendTurns, loadThread, getRecentTurns, selectHistoryForPrompt, chatThreadId } from "../storage/chatThreadStore.js";
import { loadCompanies } from "../storage/companyStore.js";
import { invokeSystemModel, invokeAgentModel } from "../runtime/systemModelInvoke.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { stripDirectAnswerHeader } from "../runtime/outputSanitizer.js";
import { markPrecreatedRunFailed, precreateRunTask, decideAndRecordRunGovernance } from "../runtime/runLifecycle.js";
import { isDispatchInFlight, dispatchOrEnqueue, type DispatchQueueItem } from "../runtime/runMutex.js";
import type { GovernanceRecord } from "../storage/governanceStore.js";
import { upsertMission, type MissionBrief } from "../runtime/missionBrief.js";
import { generateRunTaskGraph } from "./missionRoutes.js";
import { bindRunObservability, loadRunTask } from "../storage/projectStore.js";
import {
  bindIdempotencyTarget,
  claimIdempotency,
  completeIdempotency,
  hashIdempotencyRequest,
  validateIdempotencyKey,
} from "../storage/idempotencyStore.js";

import {
  compactChatSession,
  createChatSession,
  ensureActiveChatSession,
  forkChatSession,
  listChatSessions,
  loadChatSession,
  resumeChatSession,
} from '../storage/chatSessionStore.js';

// 令五.4 · Chat 英雄回路可观测:为 Chat 发起的 run 落最小 Mission 记录(复用 upsertMission),
// 让详情页能把 run 反查到任务图。不打 generateMissionBrief 的 LLM(用户已给出具体目标,再花一次
// 模型展开既慢又易幻觉)——直接用目标构造最小 mission;approvalStatus="approved" 表示"已派发",
// 不会作为草稿出现在 Plan 待办里。runType 用于任务图拆解口径(team/quick)。
function createChatMission(projectRoot: string, message: string, companyId: string | undefined, runType: "quick" | "team"): MissionBrief {
  const mission: MissionBrief = {
    id: randomUUID().slice(0, 8),
    companyId,
    createdAt: new Date().toISOString(),
    originalIdea: message,
    interpretedGoal: message.slice(0, 500),
    successCriteria: [], nonGoals: [], assumptions: [], risks: [],
    requiredDepartments: [], expectedArtifacts: [],
    suggestedRunType: runType,
    permissionNeeds: "propose_only",
    approvalStatus: "approved",
  };
  return upsertMission(projectRoot, mission);
}

const CEO_CONVERSATIONAL_PROMPT = `You are the CEO of OPC Studio, an AI-powered development platform. You manage a team of AI agents.

Your team:
- Engineering Lead (frontend, backend, testing)
- Product Lead (research, specs)
- Review Lead (code review, security audit)

Tone: friendly, professional, conversational. Like a startup CTO talking to a colleague.
- Greetings ("你好", "hello"): respond warmly, briefly introduce yourself and your team
- Task descriptions: acknowledge enthusiastically, explain which team you'll delegate to
- Keep responses concise (2-4 sentences)
- Use Chinese for Chinese input, English for English input
- NEVER output JSON, markdown tables, or structured formats — just natural conversation
- Do NOT output task plans or ## headers — those are for internal use only`;

export interface CeoChatResolution {
  ceo: AgentNodeConfig;
  /** CEO_CONVERSATIONAL_PROMPT + 该 CEO 的真实语境(公司名+真实花名册)——"和这家公司的 CEO 对话"
   *  这件事唯一的一份身份/基础提示词来源。调用方(/api/chat、架构对话)都在这份 system 之上按自己的
   *  话题域再叠加规则段,不重新拼一份等价但独立维护的身份提示词。 */
  system: string;
}

// 找该公司真实的 CEO(角色分派,不是裸 id)+ 拼真实语境 system prompt——"和日常工作里的 CEO 对话"
// 与"在公司架构模式里和 CEO 谈架构"共用同一份身份解析,不是两套并存的相似实现(2026-07 用户纠正:
// 上一轮把架构对话设计成借用与该公司 CEO 无关的系统模型身份,是错的——架构对话本质上就是和这家公司
// 真实 CEO 的对话,只是话题被限定在架构调整)。
//
// 解析顺序:优先指定公司的 CEO,再退默认公司的,再退任意一个 CEO——这家公司还没有 CEO 时返回
// {error},由调用方决定怎么把这句人话错误包装成响应(不同端点的错误状态码惯例不完全一样)。
export function resolveCeoForChat(projectRoot: string, companyId?: string): CeoChatResolution | { error: string } {
  const all = getAgents();
  const ceos = all.filter(a => a.role === "ceo");
  const ceo =
    (companyId ? ceos.find(a => (a.companyId || "default") === companyId) : undefined) ??
    ceos.find(a => (a.companyId || "default") === "default") ??
    ceos[0];
  if (!ceo) return { error: "这家公司还没有 CEO——先在组织页添加一个 CEO,或从社区导入一个团队模板" };

  // 用户实测抓出的假话:提示词里写死的"Engineering/Product/Review Lead"根本不是该公司的真实编制,
  // CEO 还自称"没绑定公司"。改喂真实语境:公司名 + 实际花名册(名字/角色),让它介绍自己时说真话。
  const ceoCompanyId = ceo.companyId || "default";
  const roster = all.filter(a => (a.companyId || "default") === ceoCompanyId && a.id !== ceo.id);
  const rosterLines = roster.slice(0, 20).map(a => `- ${a.name}(${a.role})`).join("\n");
  const companyName = loadCompanies(projectRoot).find(c => c.id === ceoCompanyId)?.name ?? ceoCompanyId;
  const system = `${CEO_CONVERSATIONAL_PROMPT}

## 你的真实语境(如实回答,不要编造)
你是公司「${companyName}」的 CEO,名字是「${ceo.name}」。
你的团队(${roster.length} 人):
${rosterLines || "(暂时只有你一个人——建议用户添加员工或从社区导入团队)"}
用户问你是谁/管什么团队时,按上面真实信息回答。`;

  return { ceo, system };
}

export function register(app: Express, projectRoot: string) {
  app.get('/api/chat/sessions', (req, res) => {
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
    res.json(listChatSessions(projectRoot, companyId, agentId));
  });

  app.post('/api/chat/sessions', (req, res) => {
    const companyId = typeof req.body?.companyId === 'string' ? req.body.companyId.trim() : '';
    const agentId = typeof req.body?.agentId === 'string' ? req.body.agentId.trim() : '';
    if (!companyId || !agentId) return res.status(400).json({ error: 'companyId and agentId required' });
    try { res.status(201).json(createChatSession(projectRoot, { companyId, agentId })); }
    catch (error: any) { res.status(400).json({ error: error?.message || 'create session failed' }); }
  });

  app.get('/api/chat/sessions/:id', (req, res) => {
    const session = loadChatSession(projectRoot, req.params.id);
    if (!session) return res.status(404).json({ error: 'session not found or workspace mismatch' });
    res.json(session);
  });

  app.post('/api/chat/sessions/:id/resume', (req, res) => {
    try { res.json(resumeChatSession(projectRoot, req.params.id)); }
    catch (error: any) { res.status(404).json({ error: error?.message || 'session not found' }); }
  });

  app.post('/api/chat/sessions/:id/fork', (req, res) => {
    try { res.status(201).json(forkChatSession(projectRoot, req.params.id)); }
    catch (error: any) { res.status(404).json({ error: error?.message || 'session not found' }); }
  });

  app.post('/api/chat/sessions/:id/compact', (req, res) => {
    try {
      const retainTokens = Number.isFinite(Number(req.body?.retainTokens)) ? Number(req.body.retainTokens) : undefined;
      const minRecentMessages = Number.isFinite(Number(req.body?.minRecentMessages)) ? Number(req.body.minRecentMessages) : undefined;
      res.json({ compaction: compactChatSession(projectRoot, req.params.id, { retainTokens, minRecentMessages }) });
    } catch (error: any) {
      res.status(404).json({ error: error?.message || 'session not found' });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { message, companyId } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message required" });
      }
      const integrity = checkTextIntegrity(message);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });

      const resolved = resolveCeoForChat(projectRoot, companyId);
      if ("error" in resolved) return res.status(400).json({ error: resolved.error });
      const { ceo, system } = resolved;
      const threadCompanyId = ceo.companyId || "default";
      const sessionId = ensureActiveChatSession(projectRoot, threadCompanyId, ceo.id).sessionId;

      // CEO 对话此前不注入其持久记忆(员工单聊有,CEO 没有,是缺口)——补上同款"## 你的持久记忆"块,
      // 让 CEO 记得住跨对话的经验/口径。
      const mem = readAgentMemory(projectRoot, ceo.id).slice(0, 800);
      const systemWithMemory = system + (mem ? `\n\n## 你的持久记忆\n${mem}` : "");

      // 请求先落用户消息(即便模型调用失败也不丢用户这句),再据整条线程按预算裁出历史注入模型上下文——
      // 历史随消息折进 prompt,与执行引擎无关,故切换订阅/刷新页面上下文都连续。
      appendTurns(projectRoot, threadCompanyId, ceo.id, [{ role: "user", content: message }]);
      const history = selectHistoryForPrompt(loadThread(projectRoot, threadCompanyId, ceo.id));
      const messages: ChatMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
      // 员工人格调用按 framework 分流(订阅→引擎链;API 无 key 有订阅→自动替换),不再裸走 callModel。
      const record = await invokeAgentModel(projectRoot, ceo, {
        agentId: ceo.id,
        system: systemWithMemory,
        messages,
        maxTokens: 1024,
      });

      // DIRECT_ANSWER: 是 CEO 提示词的内部协议头,不该漏给用户看。全文首标记提取(模型常带前言,
      // 行首锚定会把标记原样露出;与 orchestrator.parseDirectAnswer 同口径)。
      const reply = stripDirectAnswerHeader(record.content ?? "");
      appendTurns(projectRoot, threadCompanyId, ceo.id, [{ role: "assistant", content: reply }]);

      res.json({
        reply,
        tokens: record.totalTokens,
        threadId: chatThreadId(threadCompanyId, ceo.id),
        sessionId,
        history: getRecentTurns(projectRoot, threadCompanyId, ceo.id, 20),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "chat failed" });
    }
  });

  // 前端打开会话时拉取服务端线程渲染(不再只靠本地易失 state)。按 agentId 定位:传的是真实 agent
  // (含真实 CEO)→ 返回其线程;传空/伪 id("ceo")或找不到 → 解析该公司 CEO 的线程。这样刷新页面 /
  // 换设备都能看回此前对话。thread 键与两个 POST 端点一致:(agent.companyId||default, agent.id)。
  app.get("/api/chat/thread", (req, res) => {
    try {
      const companyId = typeof req.query.companyId === "string" ? req.query.companyId : undefined;
      const agentIdQ = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      const agent = agentIdQ ? getAgents().find((a) => a.id === agentIdQ) : undefined;
      let threadCompanyId: string;
      let threadAgentId: string;
      if (agent) {
        threadCompanyId = agent.companyId || "default";
        threadAgentId = agent.id;
      } else {
        const resolved = resolveCeoForChat(projectRoot, companyId);
        if ("error" in resolved) return res.json({ threadId: null, agentId: null, turns: [] });
        threadCompanyId = resolved.ceo.companyId || "default";
        threadAgentId = resolved.ceo.id;
      }
      res.json({
        threadId: chatThreadId(threadCompanyId, threadAgentId),
        agentId: threadAgentId,
        turns: getRecentTurns(projectRoot, threadCompanyId, threadAgentId, 60),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "load thread failed" });
    }
  });

  app.post("/api/chat/task", async (req, res) => {
    let idempotencyKey: string | undefined;
    const reply = (statusCode: number, body: unknown) => {
      if (idempotencyKey) completeIdempotency(projectRoot, idempotencyKey, statusCode, body);
      return res.status(statusCode).json(body);
    };
    try {
      const { message, companyId, runType, teamMode, skills } = req.body;
      if (!message || typeof message !== "string") {
        return res.status(400).json({ error: "message required" });
      }
      const integrity = checkTextIntegrity(message);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
      // Stage 2 · Run Type / Team Mode(产品契约):quick=单 agent 直答;team+mode=team-level 引擎策略。
      const _runType = runType === "quick" ? "quick" : "team";
      const _teamMode = ["economy", "balanced", "maxQuality"].includes(teamMode) ? teamMode : undefined;
      // "/" 面板点技能:本次任务对全员强制注入指定技能(按 id/标题匹配,上限 3 个防提示词爆炸)。
      const _forceSkills = Array.isArray(skills) ? skills.filter((x: unknown): x is string => typeof x === "string").slice(0, 3) : undefined;

      const rawIdempotencyKey = req.get("idempotency-key")?.trim();
      let recoveredRunId: string | undefined;
      if (rawIdempotencyKey) {
        if (!validateIdempotencyKey(rawIdempotencyKey)) {
          return res.status(400).json({ error: "invalid idempotency key" });
        }
        idempotencyKey = rawIdempotencyKey;
        const requestHash = hashIdempotencyRequest({
          message,
          companyId: typeof companyId === "string" ? companyId : undefined,
          runType: _runType,
          teamMode: _teamMode,
          skills: _forceSkills,
        });
        const claim = claimIdempotency(projectRoot, idempotencyKey, "chat.task", requestHash);
        if (claim.kind === "conflict") {
          idempotencyKey = undefined;
          return res.status(409).json({ error: "idempotency_conflict" });
        }
        if (claim.kind === "replay") {
          idempotencyKey = undefined;
          return res.status(claim.record.statusCode ?? 200).json(claim.record.response ?? { runId: claim.record.targetId });
        }
        if (claim.kind === "in_progress" && claim.record.targetId) {
          const existingTask = loadRunTask(projectRoot, claim.record.targetId);
          if (existingTask) {
            const body = { runId: claim.record.targetId, status: existingTask.status, idempotencyReplayed: true };
            completeIdempotency(projectRoot, rawIdempotencyKey, 200, body);
            idempotencyKey = undefined;
            return res.status(200).json(body);
          }
          recoveredRunId = claim.record.targetId;
        }
      }

      // The authoritative capability gate runs inside startRun, after the durable run is created.
      // Keeping a second synchronous Doctor here delayed the HTTP response and could disagree with scheduling.
      const runId = recoveredRunId ?? uuid();
      if (idempotencyKey) bindIdempotencyTarget(projectRoot, idempotencyKey, runId);
      const runCompanyId = typeof companyId === "string" ? companyId : undefined;

      // 令五.4 · Chat 英雄回路可观测:落最小 Mission(同步)+ 异步生成观测任务图(team/编码→CEO 真实拆解;
      // quick→单节点占位)。missionId 在每条派发路径 precreate 之后绑到 run.task.json(startRun 起跑时磁盘
      // 合并保留),让详情页凭 run.missionId 反查任务图。全 best-effort:可观测性失败绝不阻塞/拦截派发。
      let chatMissionId: string | undefined;
      try {
        const mission = createChatMission(projectRoot, message, runCompanyId, _runType);
        chatMissionId = mission.id;
        void generateRunTaskGraph(projectRoot, mission, _runType)
          .then(g => { if (g) { try { bindRunObservability(projectRoot, runId, { taskGraphId: g.id }); } catch { /* 加性 */ } } })
          .catch(() => { /* 加性 */ });
      } catch { /* 可观测性加性,失败不影响派发 */ }
      const bindMissionObs = () => { if (chatMissionId) { try { bindRunObservability(projectRoot, runId, { missionId: chatMissionId }); } catch { /* 加性 */ } } };

      // E3 · 派发前判级 + 落 record(幂等,startRun 内的钩子会直接复用这条);pendingDispatch 随
      // record 落盘,批准后 governanceRoutes 能照原参数派发。E4 · L3 网关:未批不派发。
      let governance: GovernanceRecord | undefined;
      try {
        governance = decideAndRecordRunGovernance(projectRoot, {
          runId, goal: message, companyId: runCompanyId,
          pendingDispatch: { goal: message, companyId: runCompanyId, runType: _runType, teamMode: _teamMode, forceSkills: _forceSkills },
        });
      } catch { /* 判级失败不拦 run(治理是加性防线),startRun 的钩子还会兜底 */ }
      if (governance?.approvalRequired && governance.approval?.status !== "approved") {
        precreateRunTask(projectRoot, { runId, goal: message, companyId: runCompanyId, status: "pending" });
        bindMissionObs();
        return reply(200, {
          runId,
          approvalRequired: true,
          governanceLevel: governance.level,
          governanceReason: governance.reason,
          message: `任务被 Run Governance 判为 L3(高风险),需人工审批后才会派发:POST /api/governance/runs/${runId}/approve`,
        });
      }

      // P1-5:生产主 UI 派发接队列。旧行为撞上单 run 互斥闸时 startRun 直接抛 RUN_IN_FLIGHT_ERROR、
      // 被 .catch 标 failed —— 用户的第二条任务白白烧掉。改为:有活 run → 入持久化队列(run 结束由
      // orchestrator finally 的 drainDispatchQueue 出队派发下一单),把"已排队#N"回给前端;无活 run
      // 才立即起跑。立即起跑仍走本地 startRun 以携带 forceSkills("/"面板技能)——持久化队列项不落
      // 技能字段,故只在直接起跑这条路注入(与 mission-approve 派发同源的 dispatchOrEnqueue 语义一致)。
      if (isDispatchInFlight()) {
        precreateRunTask(projectRoot, { runId, goal: message, companyId: runCompanyId, status: "pending" });
        bindMissionObs();
        const decision = dispatchOrEnqueue(projectRoot, {
          id: uuid(), runId, goal: message, companyId: runCompanyId,
          runType: _runType, teamMode: _teamMode as DispatchQueueItem["teamMode"],
          enqueuedAt: new Date().toISOString(),
        });
        if (decision.queued) {
          return reply(200, {
            runId, queued: true, queuePosition: decision.position,
            message: `任务已排队（前面还有任务在运行），排队序号 #${decision.position}，轮到时会自动开始`,
          });
        }
        // 竞态兜底:isDispatchInFlight 判定后活 run 恰好结束,dispatchOrEnqueue 直接起跑了本单 → 按已派发回执。
        return reply(200, { runId, message: "任务已下发，团队开始工作" });
      }

      precreateRunTask(projectRoot, { runId, goal: message, companyId: runCompanyId });
      bindMissionObs();
      reply(200, { runId, message: "任务已下发，团队开始工作" });

      startRun(message, runId, runCompanyId, { runType: _runType, teamMode: _teamMode, forceSkills: _forceSkills }).then(result => {
        console.log(`Run ${result.runId} completed: ${result.summary.slice(0, 120)}`);
      }).catch(e => {
        markPrecreatedRunFailed(projectRoot, runId, e);
        console.error("Background run failed:", e.message);
        console.error("STACK:", e.stack);
        emit("error", undefined, { message: e.message });
      });
    } catch (e: any) {
      if (!res.headersSent) {
        reply(500, { error: e.message || "task failed" });
      }
    }
  });

  // 头脑风暴/澄清模式(用户定调"像 CC 一样先研究再让用户选方向"):CEO 顾问口吻分析用户的粗略目标,
  // 给出 2-4 个关键澄清问题(每题带 2-4 个选项 + 允许自己填空)+ 2-5 条验收标准建议 + 一句话理解——
  // 前端渲染成"澄清卡",用户答完组装成增强目标文本回填输入框,这就是"中间报告让用户选方向"的落地。
  // 用 systemModel.creative 档(默认 deepseek/deepseek-chat,config.systemModel.creative 可覆盖);
  // 解析失败诚实报 400(带模型原文截断,不装懂、不编造假数据兜底)。
  app.post("/api/clarify", async (req, res) => {
    try {
      const { goal } = req.body;
      if (!goal || typeof goal !== "string" || !goal.trim()) {
        return res.status(400).json({ error: "goal required" });
      }
      const goalIntegrity = checkTextIntegrity(goal);
      if (goalIntegrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: goalIntegrity.reason });
      const prompt = `你是一名经验丰富的创业公司 CEO 顾问,擅长把用户粗略的一句话目标追问清楚,再交给团队执行。

用户目标:
${goal.trim().slice(0, 1000)}

请找出这个目标里最影响执行方式的 2-4 个模糊点,分别提出一个澄清问题;每个问题给 2-4 个简短、互斥、覆盖常见选择的选项,同时允许用户不选而自己填空(allowFree)。再给出你认为合理的 2-5 条验收标准建议(用户会看到并可修改,不代表最终结果)。

只输出一个 JSON 对象,不要 markdown 代码块、不要任何其他文字:
{"summary": "对这个需求的一句话理解", "questions": [{"q": "问题文本", "options": ["选项1", "选项2"], "allowFree": true}], "draftCriteria": ["验收标准1", "验收标准2"]}`;

      const record = await invokeSystemModel(projectRoot, "creative", {
        agentId: "clarify-advisor",
        messages: [{ role: "user", content: prompt }], maxTokens: 1200, agentRole: "advisor",
      });
      // DIRECT_ANSWER: 部分角色提示词的内部协议头,这里没用那套提示词但仍剥一下以防模型学舌(全文首标记提取)。
      const raw = stripDirectAnswerHeader(record.content ?? "");
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return res.status(400).json({ error: "澄清输出无法解析为 JSON", raw: raw.slice(0, 400) });

      let parsed: any;
      try {
        parsed = JSON.parse(m[0]);
      } catch {
        return res.status(400).json({ error: "澄清输出 JSON 解析失败", raw: raw.slice(0, 400) });
      }

      const questions = (Array.isArray(parsed?.questions) ? parsed.questions : [])
        .slice(0, 4)
        .map((q: any) => ({
          q: String(q?.q ?? "").trim().slice(0, 200),
          options: (Array.isArray(q?.options) ? q.options : [])
            .filter((o: unknown): o is string => typeof o === "string" && !!o.trim())
            .slice(0, 4),
          allowFree: q?.allowFree !== false,
        }))
        .filter((q: { q: string }) => q.q);
      if (questions.length === 0) {
        return res.status(400).json({ error: "澄清输出缺少可用问题", raw: raw.slice(0, 400) });
      }

      const draftCriteria = (Array.isArray(parsed?.draftCriteria) ? parsed.draftCriteria : [])
        .filter((c: unknown): c is string => typeof c === "string" && !!c.trim())
        .map((c: string) => c.trim())
        .slice(0, 5);
      const summary = typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 300) : "";

      res.json({ questions, draftCriteria, summary });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "clarify failed" });
    }
  });

  // Phase 2:直聊单个员工。以该 agent 的身份(角色提示 + 其持久 md 记忆)做**对话**回复
  // (非任务执行——不开 worktree、不跑引擎子进程)。需要实际动手时,提示用户作为正式任务下发。
  app.post("/api/agents/:id/chat", async (req, res) => {
    try {
      const { message } = req.body;
      if (!message || typeof message !== "string") return res.status(400).json({ error: "message required" });
      const integrity = checkTextIntegrity(message);
      if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
      const agent = getAgents().find((a) => a.id === req.params.id);
      if (!agent) return res.status(404).json({ error: "agent not found" });

      const mem = readAgentMemory(projectRoot, agent.id).slice(0, 800);
      // 真实语境注入(用户截图实锤 CEO 直聊自称管着不存在的团队):公司名+同事花名册,
      // 明确"以此为准,角色提示词里的示例团队描述一律作废"。对所有角色生效(谁都不该编造同事)。
      const agCompanyId = agent.companyId || "default";
      const sessionId = ensureActiveChatSession(projectRoot, agCompanyId, agent.id).sessionId;
      const colleagues = getAgents().filter(a => (a.companyId || "default") === agCompanyId && a.id !== agent.id);
      const companyName = loadCompanies(projectRoot).find(c => c.id === agCompanyId)?.name ?? agCompanyId;
      const contextBlock = `\n\n## 你的真实语境(以此为准;角色说明里的示例团队描述一律作废)\n你在公司「${companyName}」,同事(${colleagues.length} 人):\n${colleagues.slice(0, 20).map(a => `- ${a.name}(${a.role})`).join("\n") || "(暂无其他同事)"}`;
      const system = `${getRolePrompt(agent.role)}

你现在以「${agent.name}」(角色:${agent.role})的身份,与团队成员/用户**对话**(不是执行任务)。
- 自然、简洁(2-5 句);中文问就中文答,英文问就英文答。
- 不要输出 JSON / 表格 / 计划头(## 标题)。
- 若用户要你实际动手做需要多步执行的工作,说明你可以做,并建议把它作为正式任务下发(交给 CEO 编排),而不是在对话里空谈。`
        + contextBlock
        + (mem ? `\n\n## 你的持久记忆\n${mem}` : "");

      // 与 CEO 对话同款:先落用户消息,再据整条线程按预算裁出历史注入模型(引擎无关的上下文续接),
      // 模型回复也落线程——切订阅/刷新页面对话都连续。
      appendTurns(projectRoot, agCompanyId, agent.id, [{ role: "user", content: message }]);
      const history = selectHistoryForPrompt(loadThread(projectRoot, agCompanyId, agent.id));
      const messages: ChatMessage[] = history.map((t) => ({ role: t.role, content: t.content }));
      const record = await invokeAgentModel(projectRoot, agent, {
        agentId: agent.id,
        system,
        messages,
        maxTokens: 1024,
      });
      const reply = stripDirectAnswerHeader(record.content ?? "");
      appendTurns(projectRoot, agCompanyId, agent.id, [{ role: "assistant", content: reply }]);
      res.json({
        reply,
        tokens: record.totalTokens,
        threadId: chatThreadId(agCompanyId, agent.id),
        sessionId,
        history: getRecentTurns(projectRoot, agCompanyId, agent.id, 20),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "chat failed" });
    }
  });
}
