import type { Express } from "express";
import type { AgentNodeConfig, Company, Skill } from "@opc/shared";
import { getAgents, updateAgent, removeAgentsByIds } from "../runtime/orchestrator.js";
import { getCompany, updateCompany } from "../storage/companyStore.js";
import { createSkill, deleteSkill, getSkill, listSkills } from "../storage/skillStore.js";
import { loadRunIndex } from "../storage/projectStore.js";
import { type ChatMessage } from "../runtime/modelGateway.js";
import { invokeAgentModel } from "../runtime/systemModelInvoke.js";
import { resolveCeoForChat } from "./chatRoutes.js";
import { resolveDecomposer, parseDecomposeReply, type Decomposer } from "../runtime/taskDecomposer.js";
import {
  ARCHITECT_CHAT_TOPIC_RULES, ARCHITECT_ACTION_TYPES_DOC, buildArchitectContext, parseActionsArray,
  applyArchitectActions, ArchitectActionSchema, type ArchitectAction, type ArchitectApplyResult,
  collectArchitectHighRiskFlags, architectTouchedFields, COMPANY_ARCHITECT_SKILL,
} from "../runtime/architectAssistant.js";
import { stableHash, buildArchitectApplyLedger, summarizeCompanyEditLedger, scanFreeTextValues } from "../runtime/companyArchitect.js";
import {
  recordArchitectApplyTransaction, getArchitectApplyTransaction, markArchitectApplyTransactionRolledBack,
  saveLiveArchitectProposal, getLiveArchitectProposal, markLiveArchitectProposalApplied,
  markLiveArchitectProposalFailed, markLiveArchitectProposalRolledBack, claimLiveArchitectProposal,
  issueConfirmationToken, consumeConfirmationToken, loadLiveArchitectProposals,
  type ArchitectApplyTransaction,
} from "../storage/companyEditProposalStore.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import { stripDirectAnswerHeader } from "../runtime/outputSanitizer.js";

// 深拷贝(JSON 往返:剥离 undefined 键、稳定序列——快照/hash 两侧口径一致)。undefined 原样返回不炸。
function cloneJson<T>(v: T): T { return v === undefined ? (undefined as unknown as T) : JSON.parse(JSON.stringify(v)); }

// 活公司受影响面(agents / workflow / presetChannels)的规范化 hash——beforeHash/afterHash 与回滚后
// 复算共用同一份公式,避免公式漂移导致"字节一致"校验假阴性。
function hashArchitectSurfaceV1(agents: unknown[], workflow: unknown, presetChannels: unknown): string {
  return stableHash({ agents, workflow: workflow ?? null, presetChannels: presetChannels ?? null });
}

function architectGovernanceSurface(company: Company): Record<string, unknown> {
  return {
    visibilityPolicy: company.visibilityPolicy ?? null,
    recommendedConfig: cloneJson(company.recommendedConfig) ?? null,
    requiredPermissions: cloneJson(company.requiredPermissions) ?? null,
    manifestToolRequirements: cloneJson(company.manifestToolRequirements) ?? null,
    manifestMcpRequirements: cloneJson(company.manifestMcpRequirements) ?? null,
  };
}

function companyBundledSkills(projectRoot: string, companyId: string): Skill[] {
  return listSkills(projectRoot)
    .filter(s => s.origin === "bundled" && s.companyId === companyId)
    .map(meta => getSkill(projectRoot, meta.id))
    .filter((skill): skill is Skill => !!skill)
    .map(skill => cloneJson(skill))
    .sort((a, b) => a.id.localeCompare(b.id));
}

interface CompanyPlanSummary {
  agentCount: number;
  roleCount: number;
  verificationEdgeCount: number;
  a2aChannelCount: number;
  requiredSkillCount: number;
}

function previewCompanyPlan(company: Company, roster: AgentNodeConfig[], actions: ArchitectAction[]) {
  const before: CompanyPlanSummary = {
    agentCount: roster.length,
    roleCount: new Set(roster.map(agent => agent.role)).size,
    verificationEdgeCount: company.workflow?.verificationEdges?.length ?? 0,
    a2aChannelCount: company.presetChannels?.length ?? 0,
    requiredSkillCount: company.manifestToolRequirements?.requiredSkills?.length ?? 0,
  };
  const people = new Map(roster.map(agent => [agent.name, agent.role] as const));
  let verificationEdgeCount = before.verificationEdgeCount;
  let a2aChannelCount = before.a2aChannelCount;
  let requiredSkillCount = before.requiredSkillCount;
  for (const action of actions) {
    switch (action.type) {
      case "add_agent": people.set(action.name, action.role); break;
      case "remove_agent": people.delete(action.name); break;
      case "update_agent": {
        const role = action.role ?? people.get(action.name);
        people.delete(action.name);
        if (role) people.set(action.newName ?? action.name, role);
        break;
      }
      case "add_verification_edge": verificationEdgeCount += 1; break;
      case "remove_verification_edge": verificationEdgeCount = Math.max(0, verificationEdgeCount - 1); break;
      case "add_a2a_channel": a2aChannelCount += 1; break;
      case "remove_a2a_channel": a2aChannelCount = Math.max(0, a2aChannelCount - 1); break;
      case "update_company_governance":
        if (action.toolRequirements) requiredSkillCount = action.toolRequirements.requiredSkills.length;
        break;
      default: break;
    }
  }
  const after: CompanyPlanSummary = {
    agentCount: people.size,
    roleCount: new Set(people.values()).size,
    verificationEdgeCount,
    a2aChannelCount,
    requiredSkillCount,
  };
  return {
    before,
    after,
    risks: collectArchitectHighRiskFlags(actions, roster).map(flag => flag.kind),
    source: "server-proposal-preview" as const,
  };
}

function hashArchitectSurfaceV2(agents: unknown[], company: Company, skills: Skill[]): string {
  return stableHash({
    agents,
    workflow: cloneJson(company.workflow) ?? null,
    presetChannels: cloneJson(company.presetChannels) ?? null,
    governance: architectGovernanceSurface(company),
    skills,
  });
}
// C(波4)· 回滚活公司 architect-apply 的快照:删掉本次新建的 agent、把快照里的 agent 逐个整值恢复
// (含 enabled/childrenIds/parentId,因此软删除的 remove_agent 也复活)、company 的 workflow/presetChannels
// 整值恢复。lost>0 拒绝路径与 rollback 端点共用同一份恢复逻辑(勿复制粘贴)。每个原语都继续尝试,最后用同一 surface hash 复验。
interface ArchitectRestoreResult {
  ok: boolean;
  errors: string[];
  actualHash?: string;
}

function restoreArchitectApplySnapshot(
  projectRoot: string,
  companyId: string,
  snap: Pick<ArchitectApplyTransaction, "surfaceVersion" | "createdAgentIds" | "agentsBefore" | "companyBefore" | "skillsBefore" | "workflowBefore" | "presetChannelsBefore">,
  expectedHash: string,
): ArchitectRestoreResult {
  const errors: string[] = [];
  const messageOf = (e: unknown): string => e instanceof Error ? e.message : String(e);
  const attempt = (label: string, fn: () => void): void => {
    try { fn(); } catch (e) { errors.push(`${label}: ${messageOf(e)}`); }
  };

  if (snap.createdAgentIds.length) {
    attempt("remove created agents", () => {
      const removed = removeAgentsByIds(snap.createdAgentIds);
      if (removed !== snap.createdAgentIds.length) throw new Error(`removed ${removed}/${snap.createdAgentIds.length}`);
    });
  }
  for (const a of snap.agentsBefore) {
    const id = typeof (a as { id?: unknown }).id === "string" ? (a as { id: string }).id : undefined;
    if (!id) {
      errors.push("restore agent: snapshot is missing id");
      continue;
    }
    attempt(`restore agent ${id}`, () => {
      if (!updateAgent(id, a as Partial<AgentNodeConfig>)) throw new Error("agent not found");
    });
  }
  attempt("restore company governance", () => {
    const patch = snap.surfaceVersion === 2 && snap.companyBefore
      ? {
          ...snap.companyBefore as Partial<Company>,
          workflow: snap.workflowBefore as Company["workflow"],
          presetChannels: snap.presetChannelsBefore as Company["presetChannels"],
        }
      : { workflow: snap.workflowBefore as Company["workflow"], presetChannels: snap.presetChannelsBefore as Company["presetChannels"] };
    if (!updateCompany(projectRoot, companyId, patch)) throw new Error("company not found");
  });
  if (snap.surfaceVersion === 2) {
    attempt("restore bundled skills", () => {
      for (const current of companyBundledSkills(projectRoot, companyId)) {
        if (!deleteSkill(projectRoot, current.id)) throw new Error(`failed to delete current Skill ${current.id}`);
      }
      for (const raw of snap.skillsBefore) createSkill(projectRoot, raw as unknown as Skill);
    });
  }

  let actualHash: string | undefined;
  attempt("verify restored surface", () => {
    const company = getCompany(projectRoot, companyId);
    if (!company) throw new Error("company not found");
    const agents = getAgents()
      .filter(a => (a.companyId || "default") === companyId)
      .map(a => cloneJson(a) as unknown as Record<string, unknown>);
    actualHash = snap.surfaceVersion === 2
      ? hashArchitectSurfaceV2(agents, company, companyBundledSkills(projectRoot, companyId))
      : hashArchitectSurfaceV1(agents, cloneJson(company.workflow), cloneJson(company.presetChannels));
    if (actualHash !== expectedHash) throw new Error(`hash mismatch: expected ${expectedHash}, got ${actualHash}`);
  });
  return { ok: errors.length === 0, errors, actualHash };
}

// architect-apply 落地时,只有下面这几个字段是"新写入的内容"(其余 name/producerName/verifierName/
// fromName/toName 都是引用公司里*已有*成员的名字做查找——如果查找字段本身乱码,自然会在
// applyArchitectActions 里查无此人而失败,不需要在这里重复校验):
// - add_agent.name:新成员的名字(真正会被 addAgents 落盘、进而出现在报告页脚 contributions 里)
// - update_agent.newName:改名目标(与 PATCH /api/agents/:id 的 name 是同一条被写入路径,同样会
//   进报告页脚,只是这里走的是 applyArchitectActions 而不是 agentRoutes.ts 那条 PATCH)
// - add_a2a_channel.purpose:通道用途自由文本(展示在架构页,同样不该带乱码)
function newlyWrittenTextFields(action: ArchitectAction): string[] {
  switch (action.type) {
    case "add_agent":
      return [action.name, action.role, action.provider, action.model].filter((v): v is string => typeof v === "string");
    case "update_agent":
      return [action.newName, action.role, action.provider, action.model, action.framework, action.systemPrompt]
        .filter((v): v is string => typeof v === "string");
    case "add_a2a_channel":
      return action.purpose ? [action.purpose] : [];
    case "upsert_bundled_skill":
      return [action.skillName, action.description, action.content, ...action.roles]
        .filter((v): v is string => typeof v === "string");
    case "remove_bundled_skill":
      return [action.skillName];
    case "update_company_governance": {
      const config = action.recommendedConfig;
      const permissions = action.requiredPermissions;
      const tools = action.toolRequirements;
      return [
        config?.defaultModel,
        ...(permissions?.mcpServers ?? []),
        ...(tools?.requiredEngines ?? []),
        ...(tools?.requiredProviders ?? []),
        ...(tools?.requiredMcpServers ?? []),
        ...(tools?.requiredSkills ?? []),
        ...(tools?.optionalTools ?? []),
        ...(action.mcpRequirements ?? []).flatMap(item => [item.name, item.purpose]),
      ].filter((v): v is string => typeof v === "string");
    }
    default:
      return [];
  }
}

// 架构助手(2026-07 第四版·最终定调,三个端点):
// ① /architect-chat      对话模式——和该公司真实 CEO 对话,话题限定在架构调整,纯问答,响应类型
//    不带 actions 字段(端点级硬保证,不是前端拿到后自己不渲染)。
// ② /architect-decompose 执行模式 stage①②——一句话需求 → 该公司 Leader(没有则 CEO 兜底)判断是否
//    存在真正需要用户决定的分歧点,有就出选择题,没有就直接给出结构性修改方案(actions[])。完全复用
//    taskRoutes.ts 同一份 taskDecomposer.ts 骨架,不重新发明;actions 为空数组是架构场景的合法结果。
// ③ /architect-apply     用户确认后真正落地(stage③),逻辑与旧版完全一致、未改动。
//
// 用户第一次纠正(把这里设计成"系统模型",与该公司 CEO/Lead 身份解耦——是错的):对话复用 /api/chat
// 同一份身份解析函数(resolveCeoForChat)——找该公司真实 CEO,用 ceo.provider/model 推理,agentId
// 就是这个真实 CEO 自己的 id(token/成本记账落在真实员工节点上,不再用固定伪身份串)。
//
// 用户第二次纠正(把这里设计成"对话/执行两个模式 + 执行模式三段式 Leader 拆解/选择题确认"内嵌在这
// 个文件里——也是错的):那套三段式机制先被整体搬去了"日常任务对话"(BriefingPanel/taskRoutes.ts)。
//
// 用户第三次纠正(最终定调):两个模式**都要**,形式要和简报栏完全一致——执行模式因此回到这里,但
// 直接复用 taskDecomposer.ts 那份共享骨架(resolveDecomposer/parseDecomposeReply),而不是把三段式
// 状态机在这个文件里重新写一遍。
export function register(app: Express, projectRoot: string) {
  // 把前端传来的 history(role: "user" | "assistant")转成 ChatMessage[]。未知 role 一律按 user
  // 处理(防御性默认,不因为一条脏数据整体炸掉)。
  function mapHistory(history: unknown): ChatMessage[] {
    if (!Array.isArray(history)) return [];
    return history
      .filter((h: unknown): h is { role: unknown; content: unknown } => !!h && typeof (h as any).content === "string")
      .slice(-20)
      .map((h: { role: unknown; content: unknown }) => ({
        role: h.role === "assistant" ? "assistant" : "user",
        content: String(h.content).slice(0, 4000),
      }));
  }

  app.post("/api/companies/:id/architect-chat", async (req, res) => {
    try {
      const companyId = req.params.id;
      const company = getCompany(projectRoot, companyId);
      if (!company) return res.status(404).json({ error: "company not found" });

      const { message, history } = req.body ?? {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message required" });
      }
      const chatIntegrity = checkTextIntegrity(message);
      if (chatIntegrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: chatIntegrity.reason });

      // 用户纠正:这是"和该公司真实 CEO 对话",只是话题被限定在架构调整——身份解析和 /api/chat
      // 复用同一个函数(resolveCeoForChat),不是纯问答就不需要 CEO 身份。这家公司确实还没有 CEO
      // 时(比如刚创建、还没搭团队),给出和 /api/chat 一样的人话错误,而不是假装一个无关身份也能答。
      const resolved = resolveCeoForChat(projectRoot, companyId);
      if ("error" in resolved) return res.status(400).json({ error: resolved.error });
      const { ceo, system: ceoSystem } = resolved;

      const roster = getAgents().filter(a => (a.companyId || "default") === companyId);
      const system = `${ceoSystem}\n\n${ARCHITECT_CHAT_TOPIC_RULES}\n\n${buildArchitectContext(company, roster, companyBundledSkills(projectRoot, companyId))}`;
      const messages: ChatMessage[] = [...mapHistory(history), { role: "user", content: message.trim().slice(0, 4000) }];

      const record = await invokeAgentModel(projectRoot, ceo, {
        agentId: ceo.id, system, messages, maxTokens: 1600,
      });
      // DIRECT_ANSWER: 角色提示词内部协议头,和其余聊天端点一致地显式剥离(全文首标记提取,带前言也
      // 不泄漏)。对话模式现在是纯问答——响应类型本身就不含 actions 字段(端点级硬保证),不需要再解析 JSON 代码块。
      const reply = stripDirectAnswerHeader(record.content ?? "").trim();
      res.json({ reply, ceoName: ceo.name });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "architect chat failed" });
    }
  });

  // 执行模式 stage①②(只读,不落盘,只提议)——完全复用 taskRoutes.ts 同一份 taskDecomposer.ts 骨架:
  // 该公司 Leader(没有则 CEO 兜底)判断这次架构调整需求是否存在真正需要用户决定的分歧点,有就出
  // 选择题,没有就直接给出一份结构性修改方案(actions[])。与日常任务拆解不同的一点:actions 为空
  // 数组在架构场景是合法结果("想清楚了,不需要做任何改动"),不额外校验非空、不因此报错。
  function buildArchitectDecomposeSystemPrompt(decomposer: Decomposer): string {
    const roleLabel = decomposer.role === "lead" ? "Leader" : "CEO";
    const fallbackNote = decomposer.fallbackToCeo ? "(这家公司目前没有配置 Leader,由 CEO 兜底负责这次拆解)" : "";
    return `你现在负责把用户对公司架构的调整需求,拆解成一份具体的结构性修改方案。这个需求由这家公司的 ${roleLabel}「${decomposer.agent.name}」${fallbackNote}负责拆解。

你每次回复必须是且只是一个 JSON 对象(不要 markdown 代码块、不要代码块之外的任何文字),严格按下面两种情况二选一:

情况 A——这个需求存在真正需要用户决定的关键分歧点(比如新成员该汇报给谁、要不要新建验证关系这类"选哪个都合理但结果不同"的点):不要自己替用户拍板,输出:
{"summary": "你理解的需求概要(一两句话)", "needsChoice": true, "questions": [{"question": "问题文本", "options": ["A. 选项一", "B. 选项二"]}], "actions": []}
questions 最多 3 条,每条 options 给 2-4 个、每个都已经写成"A. ……"这种可以直接展示的完整句子。

情况 B——需求已经足够明确,没有真正需要用户决定的分歧点(包括:这是你已经问过澄清问题、用户已经在对话历史里给出回答的这一轮;也包括你判断这次根本不需要任何结构性改动的情况):直接给出最终方案:
{"summary": "你打算怎么改、为什么这么改(一两句话;如果判断不需要任何改动,在这里说明理由)", "needsChoice": false, "questions": [], "actions": [...]}
actions 可以是空数组——如果这次需求不需要任何结构性修改,给空数组并在 summary 里说明即可,不要为了"有产出"而硬凑不必要的改动。

${ARCHITECT_ACTION_TYPES_DOC}

硬规则:所有字符串值内部禁止出现英文双引号 " (会破坏 JSON 解析);需要引用或强调某个词时,一律改用中文书名号「」包裹。

不要为了"走流程"而在需求已经明确时硬凑一个没有意义的选择题;也不要在用户已经回答过你的问题后,还拿同一个问题反复追问用户。`;
  }

  app.post("/api/companies/:id/architect-decompose", async (req, res) => {
    try {
      const companyId = req.params.id;
      const company = getCompany(projectRoot, companyId);
      if (!company) return res.status(404).json({ error: "company not found" });

      const { message, history } = req.body ?? {};
      if (!message || typeof message !== "string" || !message.trim()) {
        return res.status(400).json({ error: "message required" });
      }
      const decomposeIntegrity = checkTextIntegrity(message);
      if (decomposeIntegrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: decomposeIntegrity.reason });

      const roster = getAgents().filter(a => (a.companyId || "default") === companyId);
      const decomposer = resolveDecomposer(roster);
      if (!decomposer) return res.status(400).json({ error: "这家公司还没有 Leader 或 CEO,无法拆解架构调整方案" });

      const system = `${buildArchitectDecomposeSystemPrompt(decomposer)}\n\n${buildArchitectContext(company, roster, companyBundledSkills(projectRoot, companyId))}`;
      const messages: ChatMessage[] = [...mapHistory(history), { role: "user", content: message.trim().slice(0, 4000) }];

      // 用该真实 decomposer(Leader,没有则 CEO 兜底)自己配置的 provider/model 推理,而不是项目级
      // 「系统模型」——与对话模式(resolveCeoForChat)、日常任务拆解(taskRoutes.ts)同一个原则。
      const record = await invokeAgentModel(projectRoot, decomposer.agent, {
        agentId: decomposer.agent.id, system, messages, maxTokens: 2200, agentRole: decomposer.agent.role,
      });
      const raw = stripDirectAnswerHeader(record.content ?? "");

      let parsed;
      try {
        parsed = parseDecomposeReply<ArchitectAction[]>(
          raw,
          p => parseActionsArray(p?.actions),
          [],
        );
      } catch (e: any) {
        return res.status(400).json({ error: e.message || "架构方案拆解失败", raw: raw.slice(0, 400) });
      }
      // 与 taskRoutes 不同:这里不校验"needsChoice=false 但结果为空"——actions:[] 在架构场景是合法
      // 结果("想清楚了,不需要改任何东西"),不因此报 400。

      const proposal = !parsed.needsChoice && parsed.result.length > 0
        ? (() => {
            const agentsSnapshot = roster.map(a => cloneJson(a) as unknown as Record<string, unknown>);
            const beforeHash = hashArchitectSurfaceV2(agentsSnapshot, company, companyBundledSkills(projectRoot, companyId));
            const nowIso = new Date().toISOString();
            return saveLiveArchitectProposal(projectRoot, {
              companyId,
              summary: parsed.summary,
              architectSkill: { id: COMPANY_ARCHITECT_SKILL.id, version: COMPANY_ARCHITECT_SKILL.version },
              actions: parsed.result,
              actionsHash: stableHash(parsed.result),
              beforeHash,
              expiresAt: new Date(Date.parse(nowIso) + 30 * 60 * 1000).toISOString(),
            }, nowIso);
          })()
        : undefined;

      res.json({
        summary: parsed.summary, needsChoice: parsed.needsChoice, questions: parsed.questions,
        actions: parsed.result,
        ...(proposal ? {
          proposalId: proposal.proposalId,
          actionsHash: proposal.actionsHash,
          beforeHash: proposal.beforeHash,
          expiresAt: proposal.expiresAt,
          architectSkill: proposal.architectSkill,
        } : {}),
        decomposer: { agentId: decomposer.agent.id, name: decomposer.agent.name, role: decomposer.role, fallbackToCeo: decomposer.fallbackToCeo },
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "architect decompose failed" });
    }
  });

  // Host/CLI discovery is read-only. Applying a proposal still has to go through
  // architect-apply, which revalidates the persisted hashes and current company surface.
  app.get("/api/companies/:id/architect-proposals", (req, res) => {
    const companyId = req.params.id;
    if (!getCompany(projectRoot, companyId)) return res.status(404).json({ error: "company not found" });
    const status = typeof req.query.status === "string" ? req.query.status : "pending";
    const allowed = new Set(["all", "pending", "applying", "applied", "failed", "rolled_back"]);
    if (!allowed.has(status)) return res.status(400).json({ error: "invalid proposal status" });
    const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
    const proposals = loadLiveArchitectProposals(projectRoot)
      .filter(proposal => proposal.companyId === companyId && (status === "all" || proposal.status === status))
      .slice(0, limit);
    res.json({ companyId, proposals });
  });

  app.get("/api/companies/:id/architect-proposals/:proposalId", (req, res) => {
    const companyId = req.params.id;
    if (!getCompany(projectRoot, companyId)) return res.status(404).json({ error: "company not found" });
    const proposal = getLiveArchitectProposal(projectRoot, req.params.proposalId);
    if (!proposal || proposal.companyId !== companyId) return res.status(404).json({ error: "architect proposal not found" });
    const roster = getAgents().filter(agent => (agent.companyId || "default") === companyId);
    const actions = proposal.actions.flatMap(action => {
      const parsed = ArchitectActionSchema.safeParse(action);
      return parsed.success ? [parsed.data] : [];
    });
    res.json({ ...proposal, preview: previewCompanyPlan(getCompany(projectRoot, companyId)!, roster, actions) });
  });

  // 用户确认后真正落地。建议一律来自 /architect-decompose(执行模式),落地终点只有这一个。
  // C(波4)新增(直接写活公司,与草稿侧只回给前端不同,故原子性/可回滚/ledger/高危确认在这里同款接线):
  // ① 高危二次确认门(删除员工 / 变更 A2A 通道 / 新增成员导致权限面扩大):令三.4 起为后端签发的
  //    一次性 confirmationToken 两步流——缺 token → 428 并随体签发 {highRisk,confirmationToken},
  //    带回后放行(客户端布尔 confirmHighRisk 已废);
  // ② apply 前拍受影响面(agents/workflow/presetChannels)快照 + 前后 hash,落一条可回滚事务台账;
  // ③ fidelity ledger(lost>0 = 落地污染了不该动的字段)→ 回滚快照并拒绝(降级 400)。
  app.post("/api/companies/:id/architect-apply", async (req, res) => {
    try {
      const companyId = req.params.id;
      const company = getCompany(projectRoot, companyId);
      if (!company) return res.status(404).json({ error: "company not found" });

      const proposalId = typeof req.body?.proposalId === "string" ? req.body.proposalId : undefined;
      if (!proposalId) {
        return res.status(400).json({ error: "proposalId required —— 活公司修改只能消费 architect-decompose 生成的持久提案" });
      }
      const proposal = getLiveArchitectProposal(projectRoot, proposalId);
      if (!proposal) return res.status(404).json({ error: "未找到对应的活公司架构提案" });
      if (proposal.companyId !== companyId) return res.status(400).json({ error: "该提案不属于当前公司" });
      if (proposal.status !== "pending") return res.status(409).json({ error: `该提案当前状态为「${proposal.status}」,只有 pending 状态可以应用` });
      if (Date.parse(proposal.expiresAt) <= Date.now()) {
        markLiveArchitectProposalFailed(projectRoot, proposalId, "proposal expired", new Date().toISOString());
        return res.status(410).json({ error: "该架构提案已过期,请重新生成" });
      }
      const rawActions = proposal.actions;
      if (!Array.isArray(rawActions) || rawActions.length === 0) return res.status(422).json({ error: "提案没有可执行 actions" });
      if (req.body?.actions !== undefined && stableHash(req.body.actions) !== proposal.actionsHash) {
        return res.status(409).json({ error: "客户端 actions 与持久提案不一致,拒绝应用" });
      }

      // 该公司当前有 run 在跑 → 409 拒绝整批,不做部分应用(与 GET /api/runs 同一份滚动索引口径判断)。
      const hasRunningRun = loadRunIndex(projectRoot).some(r => r.companyId === companyId && r.status === "running");
      if (hasRunningRun) {
        return res.status(409).json({ error: "该公司有任务在执行,暂不能修改架构" });
      }

      // 令三.1:前端理应原样回传 architect-decompose 给过的 actions,但按同一份 schema 严格校验——
      // 任何非法条目 → 整批 422 + 逐条错误清单,禁止静默 drop / 部分应用。
      const invalidActions: { index: number; error: string }[] = [];
      const actions: ArchitectAction[] = [];
      rawActions.forEach((a: unknown, i: number) => {
        const r = ArchitectActionSchema.safeParse(a);
        if (r.success) actions.push(r.data);
        else invalidActions.push({ index: i, error: r.error.issues.slice(0, 3).map(x => `${x.path.join(".") || "action"}: ${x.message}`).join("; ") });
      });
      if (invalidActions.length > 0) {
        return res.status(422).json({ error: "actions 中存在非法操作,整批拒绝", invalid: invalidActions });
      }

      // add_agent.name / update_agent.newName 是真正会被落盘、进而出现在报告页脚 contributions 里的
      // 新内容(与 agentRoutes.ts PATCH /api/agents/:id 的 name 是同一条被写入路径,只是走
      // applyArchitectActions 这条独立落地逻辑,PATCH 那边的校验管不到这里)——同一道防线在这里补上。
      for (const action of actions) {
        for (const val of newlyWrittenTextFields(action)) {
          const integrity = checkTextIntegrity(val);
          if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
        }
      }

      // 令三.7:活公司侧 actions 新写入的自由文本(成员名 / 改名 / A2A 通道用途)过 prompt-injection +
      // 敏感内容(密钥/本机路径)扫描,与草稿侧共用同一份防线。命中 → 422 拒绝整批,不落地。
      const freeTexts = actions.flatMap(newlyWrittenTextFields);
      const contentFindings = scanFreeTextValues(freeTexts);
      if (contentFindings.length > 0) {
        return res.status(422).json({ error: "actions 自由文本命中内容安全扫描,拒绝应用", findings: contentFindings });
      }

      const agentsBeforeLive = getAgents().filter(a => (a.companyId || "default") === companyId);

      // ② 事务快照(apply 前:agents 全量 + workflow + presetChannels 整值)。先于高危门拍快照,令三.6
      // 的写盘失败回滚要用到它。
      const agentsBefore = agentsBeforeLive.map(a => cloneJson(a) as unknown as Record<string, unknown>);
      const workflowBefore = cloneJson(company.workflow);
      const presetChannelsBefore = cloneJson(company.presetChannels);
      const companyBefore = architectGovernanceSurface(company);
      const skillsBefore = companyBundledSkills(projectRoot, companyId) as unknown as Record<string, unknown>[];
      const beforeHash = hashArchitectSurfaceV2(agentsBefore, company, skillsBefore as unknown as Skill[]);
      if (beforeHash !== proposal.beforeHash) {
        markLiveArchitectProposalFailed(projectRoot, proposalId, "company changed after proposal creation", new Date().toISOString());
        return res.status(409).json({
          error: "公司架构自提案生成后已发生变化,拒绝应用旧方案",
          expectedHash: proposal.beforeHash,
          actualHash: beforeHash,
          requiresReplan: true,
        });
      }
      if (stableHash(actions) !== proposal.actionsHash) {
        return res.status(409).json({ error: "提案 actions hash 校验失败,拒绝应用" });
      }
      const beforeIds = new Set(agentsBefore.map(a => a.id as string));

      // ① 令三.4 · 高危一次性 confirmation token 门(替换客户端布尔 confirmHighRisk):删除员工 / 变更
      // A2A 通道 / 新增成员导致权限面扩大 → 后端签发一枚绑定 companyId+actionsHash+dangerFlags 的一次性
      // token(10 分钟过期)。前端二次确认带 confirmationToken 重发;校验存在+未消费+未过期+绑定全符 → 放行
      // 并即刻失效;重放/过期/绑定不符(如中途换 actions)→ 428 重新签发。
      const highRisk = collectArchitectHighRiskFlags(actions, agentsBeforeLive);
      if (highRisk.length > 0) {
        const actionsHash = stableHash(actions);
        const bindingHash = stableHash({ purpose: "architect-apply", proposalId, companyId, beforeHash, actionsHash, danger: highRisk.map(f => f.kind).sort() });
        const consumed = consumeConfirmationToken("architect-apply", req.body?.confirmationToken, bindingHash);
        if (consumed !== "ok") {
          const issued = issueConfirmationToken("architect-apply", bindingHash);
          return res.status(428).json({
            error: "本批修改包含高危操作,请二次确认后再应用", requiresConfirmation: true, highRisk,
            confirmationToken: issued.token, tokenExpiresAt: issued.expiresAt, reason: consumed,
          });
        }
      }

      const claimedProposal = claimLiveArchitectProposal(projectRoot, proposalId);
      if (!claimedProposal) {
        return res.status(409).json({ error: "提案已被其它请求认领或状态已经变化,拒绝重复应用" });
      }

      // 令三.6:真实写盘(orchestrator/companyStore)可能中途抛错。用快照兜底——抛错即回滚已写部分并
      // 500 失败,绝不落 committed 事务台账(台账只在下面 apply+ledger 全部成功后 recordArchitectApplyTransaction)。
      let results: ArchitectApplyResult[];
      try {
        results = await applyArchitectActions(projectRoot, companyId, actions);
      } catch (applyErr: any) {
        markLiveArchitectProposalFailed(projectRoot, proposalId, applyErr?.message || String(applyErr), new Date().toISOString());
        const createdSoFar = getAgents().filter(a => (a.companyId || "default") === companyId && !beforeIds.has(a.id)).map(a => a.id);
        const rollback = restoreArchitectApplySnapshot(
          projectRoot, companyId,
          { surfaceVersion: 2, createdAgentIds: createdSoFar, agentsBefore, companyBefore, skillsBefore, workflowBefore, presetChannelsBefore },
          beforeHash,
        );
        if (!rollback.ok) {
          return res.status(500).json({
            error: "架构落地写盘失败,自动回滚未完成",
            detail: applyErr?.message || String(applyErr),
            requires_rollback: true,
            rollbackErrors: rollback.errors,
            expectedHash: beforeHash,
            actualHash: rollback.actualHash,
          });
        }
        return res.status(500).json({ error: "架构落地写盘失败,已回滚已写部分", detail: applyErr?.message || String(applyErr) });
      }

      const failedResults = results.filter(r => !r.ok);
      if (failedResults.length > 0) {
        const createdSoFar = getAgents().filter(a => (a.companyId || "default") === companyId && !beforeIds.has(a.id)).map(a => a.id);
        const rollback = restoreArchitectApplySnapshot(
          projectRoot, companyId,
          { surfaceVersion: 2, createdAgentIds: createdSoFar, agentsBefore, companyBefore, skillsBefore, workflowBefore, presetChannelsBefore },
          beforeHash,
        );
        const reason = failedResults.map(r => r.reason || "unknown action failure").join("; ");
        markLiveArchitectProposalFailed(projectRoot, proposalId, reason, new Date().toISOString());
        if (!rollback.ok) {
          return res.status(500).json({
            error: "架构操作部分失败,自动回滚未完成",
            failed: failedResults,
            requires_rollback: true,
            rollbackErrors: rollback.errors,
            expectedHash: beforeHash,
            actualHash: rollback.actualHash,
          });
        }
        return res.status(422).json({ error: "架构操作未能整批完成,已原子回滚", failed: failedResults });
      }

      const agentsAfterLive = getAgents().filter(a => (a.companyId || "default") === companyId);
      const agentsAfter = agentsAfterLive.map(a => cloneJson(a) as unknown as Record<string, unknown>);
      const companyAfter = getCompany(projectRoot, companyId) ?? company;
      const workflowAfter = cloneJson(companyAfter.workflow);
      const presetChannelsAfter = cloneJson(companyAfter.presetChannels);
      const governanceAfter = architectGovernanceSurface(companyAfter);
      const skillsAfter = companyBundledSkills(projectRoot, companyId);
      const createdAgentIds = agentsAfter.filter(a => !beforeIds.has(a.id as string)).map(a => a.id as string);
      const afterHash = hashArchitectSurfaceV2(agentsAfter, companyAfter, skillsAfter);

      // ③ fidelity ledger:被 actions 触及的字段判有意改动,其余应保真——lost>0 = 静默污染,回滚 + 拒绝。
      const ledger = buildArchitectApplyLedger(
        {
          agents: agentsBefore,
          workflow: workflowBefore ?? null,
          presetChannels: presetChannelsBefore ?? null,
          governance: companyBefore,
          bundledSkills: skillsBefore,
        },
        {
          agents: agentsAfter,
          workflow: workflowAfter ?? null,
          presetChannels: presetChannelsAfter ?? null,
          governance: governanceAfter,
          bundledSkills: skillsAfter,
        },
        architectTouchedFields(actions),
      );
      if (ledger.lost.length > 0) {
        markLiveArchitectProposalFailed(projectRoot, proposalId, `fidelity ledger lost: ${ledger.lost.map(v => v.field).join(",")}`, new Date().toISOString());
        // 活公司侧 apply 已经写库,不能像草稿侧那样纯拒绝——先用快照回滚,再降级 400。
        const rollback = restoreArchitectApplySnapshot(
          projectRoot, companyId,
          { surfaceVersion: 2, createdAgentIds, agentsBefore, companyBefore, skillsBefore, workflowBefore, presetChannelsBefore },
          beforeHash,
        );
        if (!rollback.ok) {
          return res.status(500).json({
            error: "fidelity ledger 检测到字段静默丢失,自动回滚未完成",
            lost: ledger.lost.map(v => v.field),
            ledger: summarizeCompanyEditLedger(ledger),
            requires_rollback: true,
            rollbackErrors: rollback.errors,
            expectedHash: beforeHash,
            actualHash: rollback.actualHash,
          });
        }
        return res.status(400).json({
          error: "fidelity ledger 检测到字段静默丢失,已回滚并拒绝应用",
          lost: ledger.lost.map(v => v.field),
          ledger: summarizeCompanyEditLedger(ledger),
        });
      }

      const ledgerSummary = summarizeCompanyEditLedger(ledger);
      const appliedAt = new Date().toISOString();
      const tx = recordArchitectApplyTransaction(projectRoot, {
        proposalId, surfaceVersion: 2, companyId, createdAgentIds, agentsBefore, companyBefore, skillsBefore, workflowBefore, presetChannelsBefore, beforeHash, afterHash, ledger: ledgerSummary,
      }, appliedAt);
      if (!markLiveArchitectProposalApplied(projectRoot, proposalId, tx.txId, appliedAt)) {
        const rollback = restoreArchitectApplySnapshot(
          projectRoot, companyId,
          { surfaceVersion: 2, createdAgentIds, agentsBefore, companyBefore, skillsBefore, workflowBefore, presetChannelsBefore },
          beforeHash,
        );
        return res.status(500).json({
          error: rollback.ok ? "架构已回滚:提案状态更新失败" : "提案状态更新失败且自动回滚未完成",
          requires_rollback: !rollback.ok,
          rollbackErrors: rollback.errors,
        });
      }

      res.json({ results, company: companyAfter, agents: agentsAfterLive, txId: tx.txId, proposalId, ledger: ledgerSummary });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "architect apply failed" });
    }
  });

  // C(波4)· 回滚一次已应用的活公司架构改动——消费事务台账快照恢复 agents/workflow/presetChannels,
  // 并把台账标 rolled_back。与草稿侧 /company-architect/rollback 是两套(草稿把快照交回前端;这里直接
  // 写回活公司持久层)。有在飞 run → 409;找不到事务 → 404;非 applied 状态 → 409。
  app.post("/api/companies/:id/architect-apply/rollback", async (req, res) => {
    try {
      const companyId = req.params.id;
      const company = getCompany(projectRoot, companyId);
      if (!company) return res.status(404).json({ error: "company not found" });

      const txId = typeof req.body?.txId === "string" ? req.body.txId : undefined;
      if (!txId) return res.status(400).json({ error: "txId required" });

      const hasRunningRun = loadRunIndex(projectRoot).some(r => r.companyId === companyId && r.status === "running");
      if (hasRunningRun) return res.status(409).json({ error: "该公司有任务在执行,暂不能回滚架构改动" });

      const tx = getArchitectApplyTransaction(projectRoot, txId);
      if (!tx) return res.status(404).json({ error: "未找到对应的架构改动事务" });
      if (tx.companyId !== companyId) return res.status(400).json({ error: "该事务不属于当前公司" });
      if (tx.status !== "applied") return res.status(409).json({ error: `该事务当前状态为「${tx.status}」,只有 applied 状态可以回滚` });

      // apply 后若又发生过任何公司架构编辑,不能用旧快照覆盖这些新改动。先证明当前面仍等于 tx.afterHash。
      const currentAgents = getAgents()
        .filter(a => (a.companyId || "default") === companyId)
        .map(a => cloneJson(a) as unknown as Record<string, unknown>);
      const currentHash = tx.surfaceVersion === 2
        ? hashArchitectSurfaceV2(currentAgents, company, companyBundledSkills(projectRoot, companyId))
        : hashArchitectSurfaceV1(currentAgents, cloneJson(company.workflow), cloneJson(company.presetChannels));
      // A previous attempt may have restored the state successfully but failed
      // while persisting the ledger transition. Make that state retryable.
      if (currentHash === tx.beforeHash) {
        const reconciledAt = new Date().toISOString();
        const reconciled = markArchitectApplyTransactionRolledBack(projectRoot, txId, reconciledAt);
        if (!reconciled) {
          return res.status(409).json({
            error: "架构状态已恢复,但事务台账仍无法完成对账",
            requires_reconciliation: true,
          });
        }
        if (tx.proposalId) markLiveArchitectProposalRolledBack(projectRoot, tx.proposalId, reconciledAt);
        const agentsAfter = getAgents().filter(a => (a.companyId || "default") === companyId);
        const companyAfter = getCompany(projectRoot, companyId) ?? company;
        return res.json({ ok: true, reconciled: true, company: companyAfter, agents: agentsAfter, txId });
      }
      if (currentHash !== tx.afterHash) {
        return res.status(409).json({
          error: "架构在本事务应用后又发生了修改,拒绝用旧快照覆盖当前状态",
          expectedHash: tx.afterHash,
          actualHash: currentHash,
          requiresReapply: true,
        });
      }

      const rollback = restoreArchitectApplySnapshot(projectRoot, companyId, tx, tx.beforeHash);
      if (!rollback.ok) {
        return res.status(500).json({
          error: "架构回滚未完成,事务仍保持 applied",
          requires_rollback: true,
          rollbackErrors: rollback.errors,
          expectedHash: tx.beforeHash,
          actualHash: rollback.actualHash,
        });
      }
      const rolledBackAt = new Date().toISOString();
      const updated = markArchitectApplyTransactionRolledBack(projectRoot, txId, rolledBackAt);
      if (!updated) return res.status(409).json({ error: "状态已恢复,但事务台账更新失败:事务状态已变更", requires_reconciliation: true });
      if (tx.proposalId) markLiveArchitectProposalRolledBack(projectRoot, tx.proposalId, rolledBackAt);

      const agentsAfter = getAgents().filter(a => (a.companyId || "default") === companyId);
      const companyAfter = getCompany(projectRoot, companyId) ?? company;
      res.json({ ok: true, company: companyAfter, agents: agentsAfter, txId });
    } catch (e: any) {
      res.status(500).json({ error: e.message || "architect apply rollback failed" });
    }
  });
}
