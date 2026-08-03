import { randomUUID } from "node:crypto";
import { z } from "zod";
import { validateAgentWorkingDirectory, type AgentNodeConfig, type Company, type CompanyTemplate, type Skill } from "@opc/shared";
import { getAgents, addAgents, updateAgent } from "./orchestrator.js";
import { getCompany, updateCompany } from "../storage/companyStore.js";
import { createSkill, deleteSkill, listSkills, updateSkill } from "../storage/skillStore.js";
import { dangerFlags } from "./templateTrust.js";
import { resolveAdaptiveModelBinding } from "./adaptiveModelBinding.js";
import { ARCHITECT_BEST_PRACTICES, COMPANY_ARCHITECT_SKILL } from "./companyArchitectSkill.js";
// 高危旗标形状 + ledger 受影响面字段类型:与草稿侧(companyArchitect.ts)共用同一份定义(仅 type,
// 运行时无循环依赖)——428 响应体形状/ledger 字段两侧一致,不各写一份。
import type { CompanyEditHighRiskFlag, ArchitectApplyField } from "./companyArchitect.js";
const LEAD_ROLE_ALIASES = new Set([
  "lead", "leader", "team_lead", "tech_lead", "technical_lead", "engineering_lead",
  "manager", "supervisor", "主管", "技术主管", "工程主管", "团队主管",
]);

/** Keep user-facing job titles in agent.name, while preserving runtime role contracts. */
export function normalizeArchitectRuntimeRole(role: string): string {
  const raw = role.trim();
  const key = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return LEAD_ROLE_ALIASES.has(key) || LEAD_ROLE_ALIASES.has(raw) ? "lead" : key;
}

const ArchitectRoleSchema = z.string().min(1).transform(normalizeArchitectRuntimeRole);

// 架构助手(2026-07 第四版·最终定调)——用户在"公司架构编辑模式"下讨论/调整组织结构,对话与执行
// 两个模式都要,形式与日常简报栏(BriefingPanel)完全一致。
//
// 第一版把这里设计成"和该公司 CEO/Lead 身份解耦,改用项目级系统模型(resolveSystemModel)推理"——
// 用户纠正:这是错的。架构对话本质上就是"和日常工作里那个真实的 CEO 对话",只是话题被限定在架构
// 调整;日常对话与架构对话应该是同一套身份解析机制,不是两套并存的相似实现。
//
// 第二版把这里设计成"对话/执行两个严格分离的模式,执行模式走 Leader 拆解→选择题/方案→用户确认"
// 三段式——用户纠正:这套三段式机制本该属于"日常任务对话"(BriefingPanel),不该加在架构对话上。
//
// 第三版因此退回"单一连续对话,CEO 在意图清楚时于回复末尾自然附带一段 actions JSON"——用户第三次
// 纠正:这次是反过来,两个模式**都要**,只是执行模式不应该在这里另起一套三段式实现,而应该直接复用
// 已经在 taskDecomposer.ts 里跑通的那套骨架(resolveDecomposer + parseDecomposeReply),不重新发明。
//
// 现在(最终版):
// - 对话模式(/architect-chat):和该公司真实 CEO 对话(resolveCeoForChat,与 /api/chat 同一份身份
//   解析),话题限定在架构调整,纯问答——**不再允许**模型附带任何 actions JSON。这是端点级的硬保证
//   (ARCHITECT_CHAT_TOPIC_RULES 本身就不再声明"可以附 JSON 代码块"这条规则,响应类型也不带 actions
//   字段),不是前端拿到 actions 后自己选择不渲染那种软保证。
// - 执行模式(/architect-decompose):一句话需求 → 该公司 Leader(没有则 CEO 兜底)判断是否存在真正
//   需要用户决定的分歧点,有就出选择题,没有就直接给出一份结构性修改方案(actions[])——与日常任务
//   拆解共用同一份 taskDecomposer.ts 骨架,只是"最终产出"换成 actions 而不是一段任务描述文本,且
//   actions 为空数组在架构场景是合法结果("想清楚了,不需要做任何改动"),不像日常任务那样报错。
// - 用户确认后真正落地(/architect-apply,applyArchitectActions,与旧版完全一致,未改动)。
//
// 这份系统提示词/解析/落地逻辑不进 skillStore——它不是"一条技能记录",而是这个端点自身固定的行为
// 契约(谁来问都是同一套规则,不该被用户在技能库里意外改动/停用/删除)。直接当代码常量维护,改动走
// 代码 review,而不是技能库的 CRUD。

// action 类型说明文字(下面 ARCHITECT_CHAT_TOPIC_RULES 拼入,先声明以避免模板字面量引用时的 TDZ)。
export const ARCHITECT_ACTION_TYPES_DOC = `action 只允许下面 10 种类型(判别式联合,字段必须严格匹配,不要多加字段、不要编造别的类型):
{"type":"add_agent","role":"dev","name":"新成员名","reportsToName":"汇报对象名(可选)","provider":"可选","model":"可选"}
{"type":"remove_agent","name":"要移除的成员名"}
{"type":"update_agent","name":"现成员名","newName":"可选","role":"可选","provider":"可选","model":"可选","framework":"可选","reportsToName":"可选","workingDirectory":"可选或 null","systemPrompt":"可选或 null","visibilityPolicy":"default、isolated 或 game,可选或 null","reasoningEffort":"low、medium、high 或 xhigh,可选或 null","enabled":true}
{"type":"add_verification_edge","producerName":"产出方成员名","verifierName":"核验方成员名","method":"llm-review、code-review、fact-check 或 custom","onReject":"redo 或 flag,可选","maxRounds":2}
{"type":"remove_verification_edge","producerName":"产出方成员名","verifierName":"核验方成员名"}
{"type":"add_a2a_channel","fromName":"成员名","toName":"成员名","purpose":"用途(可选)"}
{"type":"remove_a2a_channel","fromName":"成员名","toName":"成员名"}
{"type":"upsert_bundled_skill","skillName":"Skill 名称","description":"用途说明(可选)","content":"完整可执行 Skill 内容","roles":["dev","test"]}
{"type":"remove_bundled_skill","skillName":"Skill 名称"}
{"type":"update_company_governance","visibilityPolicy":"default、isolated 或 game,可选或 null","recommendedConfig":{"defaultModel":"可选","maxTokensPerTask":100000,"permissions":{"allowShell":true,"allowFileWrite":true,"allowWebAccess":false}},"requiredPermissions":{"allowShell":true,"allowFileWrite":true,"allowWebAccess":false,"mcpServers":[]},"toolRequirements":{"requiredEngines":[],"requiredProviders":[],"requiredMcpServers":[],"requiredSkills":[],"optionalTools":[]},"mcpRequirements":[{"name":"server-name","purpose":"用途","optional":false}]}

规则:
1. 现有成员引用一律使用当前组织结构中的完整 name,不要使用 id。
2. 修改工作目录、系统提示词、权限、工具、验证制度或 bundled Skill 时,必须使用上面对应的显式字段,不得只写进 summary。
3. bundled Skill 的 roles 使用真实岗位 role,不得使用员工姓名；Skill 与记忆严格分离,不要把经验或员工人设写成 Skill。
4. 一次最多提出 5 项修改,保持必要且克制。`;

// 运行时公司设计知识只来自版本化 COMPANY_ARCHITECT_SKILL；不再维护 Markdown/常量双副本。
// 用户 Skill CRUD 不得停用控制平面，但每次生成方案都显式记录使用的 Skill id/version。
export { ARCHITECT_BEST_PRACTICES, COMPANY_ARCHITECT_SKILL };

// Topic-only rules are layered over the real company CEO identity. Structural edits are produced only by /architect-decompose.
export const ARCHITECT_CHAT_TOPIC_RULES = `现在这场对话被限定在“公司架构调整”这个话题域内。你可以回答成员构成、汇报关系、验证关系和 A2A 协作通道，以及这些设计背后的考虑。

规则：
1. 只回答架构相关问题。日常任务派发、任务进展、Skill/MCP 配置请去简报栏处理。
2. 严格依据当前组织结构，不编造不存在的成员或关系。
3. 这里只做讨论，不输出 JSON、结构化修改方案或声称修改已经生效。
4. 不附加代码块。

${ARCHITECT_BEST_PRACTICES}`;

// ── ArchitectAction:判别式联合 + zod schema(单一权威定义,route 层复用同一份做入参校验)。
// 对话模式和执行模式共用同一套 action 类型/apply 落地逻辑——变的只是"谁来提议、什么时候提议",
// 落地这一步(applyArchitectActions)从旧版原样保留,不重新发明。──
export const ArchitectActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("add_agent"), role: ArchitectRoleSchema, name: z.string().min(1), reportsToName: z.string().optional(), provider: z.string().optional(), model: z.string().optional() }),
  z.object({ type: z.literal("remove_agent"), name: z.string().min(1) }),
  z.object({
    type: z.literal("update_agent"), name: z.string().min(1), newName: z.string().optional(), role: ArchitectRoleSchema.optional(),
    provider: z.string().optional(), model: z.string().optional(), framework: z.string().optional(), reportsToName: z.string().optional(),
    workingDirectory: z.string().nullable().optional(), systemPrompt: z.string().max(32 * 1024).nullable().optional(),
    visibilityPolicy: z.enum(["default", "isolated", "game"]).nullable().optional(),
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(), enabled: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add_verification_edge"), producerName: z.string().min(1), verifierName: z.string().min(1),
    method: z.enum(["llm-review", "code-review", "fact-check", "custom"]),
    onReject: z.enum(["redo", "flag"]).optional(), maxRounds: z.number().int().min(1).max(10).optional(),
  }),
  z.object({ type: z.literal("remove_verification_edge"), producerName: z.string().min(1), verifierName: z.string().min(1) }),
  z.object({ type: z.literal("add_a2a_channel"), fromName: z.string().min(1), toName: z.string().min(1), purpose: z.string().optional() }),
  z.object({ type: z.literal("remove_a2a_channel"), fromName: z.string().min(1), toName: z.string().min(1) }),
  z.object({ type: z.literal("upsert_bundled_skill"), skillName: z.string().min(1).max(120), description: z.string().max(1000).optional(), content: z.string().min(1).max(256 * 1024), roles: z.array(ArchitectRoleSchema).min(1).max(30) }),
  z.object({ type: z.literal("remove_bundled_skill"), skillName: z.string().min(1).max(120) }),
  z.object({
    type: z.literal("update_company_governance"), visibilityPolicy: z.enum(["default", "isolated", "game"]).nullable().optional(),
    recommendedConfig: z.object({ defaultModel: z.string().optional(), budget: z.object({ totalUsd: z.number(), maxTokensPerTask: z.number(), maxAttemptsPerTask: z.number().optional(), taskTimeoutMs: z.number().optional(), maxTokensPerRun: z.number().optional(), maxTokensTotal: z.number().optional() }).optional(), maxTokensPerTask: z.number().int().positive().optional(), permissions: z.object({ allowShell: z.boolean(), allowFileWrite: z.boolean(), allowWebAccess: z.boolean() }).optional() }).nullable().optional(),
    requiredPermissions: z.object({ allowShell: z.boolean().optional(), allowFileWrite: z.boolean().optional(), allowWebAccess: z.boolean().optional(), mcpServers: z.array(z.string().min(1)).optional() }).nullable().optional(),
    toolRequirements: z.object({ requiredEngines: z.array(z.string()).default([]), requiredProviders: z.array(z.string()).default([]), requiredMcpServers: z.array(z.string()).default([]), requiredSkills: z.array(z.string()).default([]), optionalTools: z.array(z.string()).default([]) }).nullable().optional(),
    mcpRequirements: z.array(z.object({ name: z.string().min(1), purpose: z.string().optional(), optional: z.boolean().optional() })).nullable().optional(),
  }),
]);export type ArchitectAction = z.infer<typeof ArchitectActionSchema>;

export interface ArchitectApplyResult {
  action: ArchitectAction;
  ok: boolean;
  reason?: string;
}

// 把当前组织(成员/角色/汇报对象/启用状态)+ 验证边(换算成名字)+ A2A 通道(换算成名字)序列化成一段
// 简洁的中文描述,拼进 system prompt,让 LLM"看得见"真实结构而不是凭空猜。对话模式/执行模式共用。
export function buildArchitectContext(company: Company, agents: AgentNodeConfig[], bundledSkills: Skill[] = []): string {
  const roster = agents.filter(a => (a.companyId || "default") === company.id);
  const byId = new Map(roster.map(a => [a.id, a] as const));

  const memberLines = roster.map(a => {
    const parent = a.parentId ? byId.get(a.parentId) : undefined;
    const reportsTo = parent ? parent.name : (a.role === "ceo" ? "—" : "(无上级)");
    const status = a.enabled === false ? "已停用" : "启用中";
    return `- ${a.name}(id:${a.id};角色:${a.role};汇报对象:${reportsTo};状态:${status};provider/model:${a.provider || "(未设)"}/${a.model || "(未设)"};framework:${a.framework || "(未设)"};工作目录:${a.workingDirectory || "(公司根目录)"};可见性:${a.visibilityPolicy || "(继承公司)"};推理强度:${a.reasoningEffort || "(默认)"};systemPrompt:${JSON.stringify(a.systemPrompt || "")})`;
  });

  const edges = company.workflow?.verificationEdges ?? [];
  const edgeLines = edges.map(e => {
    const producers = roster.filter(a => e.producer === "*" || a.role === e.producer).map(a => a.name);
    const verifiers = roster.filter(a => e.verifier === "*" || a.role === e.verifier).map(a => a.name);
    return `- ${producers.join("、") || e.producer} 的产出由 ${verifiers.join("、") || e.verifier} 用「${e.method}」方式核验`;
  });

  const channels = company.presetChannels ?? [];
  const channelLines = channels.map(c => {
    const from = byId.get(c.from)?.name ?? c.from;
    const to = byId.get(c.to)?.name ?? c.to;
    return `- ${from} ↔ ${to}${c.purpose ? `(用途:${c.purpose})` : ""}`;
  });
  const skillLines = bundledSkills.map(skill =>
    `- ${skill.title}(id:${skill.id};角色:${skill.role || "*"};启用:${skill.enabled !== false};内容:${JSON.stringify(skill.content || "")})`
  );
  const governance = {
    visibilityPolicy: company.visibilityPolicy ?? null,
    recommendedConfig: company.recommendedConfig ?? null,
    requiredPermissions: company.requiredPermissions ?? null,
    toolRequirements: company.manifestToolRequirements ?? null,
    mcpRequirements: company.manifestMcpRequirements ?? null,
  };

  return `## 当前组织结构(公司:${company.name})
${memberLines.join("\n") || "(暂无成员)"}

## 当前验证关系
${edgeLines.join("\n") || "(暂无)"}

## 当前 A2A 协作通道
${channelLines.join("\n") || "(暂无)"}

## 当前公司 Skill
${skillLines.join("\n") || "(暂无)"}

## 当前公司治理配置
${JSON.stringify(governance)}`;
}

// actions 数组里逐条用 zod 校验,只丢弃不合法的那一条,不因为一条坏数据废掉整批(与 apply 阶段
// "不阻断其余 action"同一原则,解析阶段先就地过滤一次)。导出给 parseArchitectReply 复用。
export function parseActionsArray(raw: unknown): ArchitectAction[] {
  if (!Array.isArray(raw)) return [];
  const out: ArchitectAction[] = [];
  for (const item of raw) {
    const r = ArchitectActionSchema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out.slice(0, 5); // 硬上限:即便模型没遵守"最多5条",这里兜底截断。
}

// ── C(波4)· 活公司侧高危二次确认门(与草稿侧 collectHighRiskFlags 同款,换成 ArchitectAction 形状)。
// 高危集:删除员工(remove_agent)、变更 A2A 协作通道(add/remove_a2a_channel)、新增成员导致危险权限面
// 扩大(权限扩大)。ArchitectAction 没有 MCP 能力需求类操作,故不含 mcp 旗标。/architect-apply 凭这个
// 列表走令三.4 一次性 confirmationToken 门:命中高危而未带 token → 428 并随体签发 token,带回后放行
// (客户端布尔 confirmHighRisk 已废)。纯函数,不落地。──
function dangerFlagsForAgents(agents: AgentNodeConfig[]): string[] {
  // dangerFlags 只读 agents/requiredPermissions/toolRequirements(均可选),传只含 agents 的裁剪对象
  // 在运行时安全(与 companyArchitect.dangerFlagsFor 同一做法),cast 只为满足类型形状。
  return dangerFlags({ agents } as unknown as CompanyTemplate);
}

export function collectArchitectHighRiskFlags(
  actions: ArchitectAction[],
  beforeAgents: AgentNodeConfig[],
): CompanyEditHighRiskFlag[] {
  const flags: CompanyEditHighRiskFlag[] = [];
  const simulatedNewNodes: AgentNodeConfig[] = [];
  for (const action of actions) {
    if (action.type === "remove_agent") {
      flags.push({ op: "remove_agent", kind: "remove_agent", detail: action.name });
    } else if (action.type === "add_a2a_channel") {
      flags.push({ op: "add_a2a_channel", kind: "a2a", detail: `${action.fromName} ↔ ${action.toName} (add)` });
    } else if (action.type === "remove_a2a_channel") {
      flags.push({ op: "remove_a2a_channel", kind: "a2a", detail: `${action.fromName} ↔ ${action.toName} (remove)` });
    } else if (action.type === "update_company_governance") {
      const permissions = action.requiredPermissions ?? action.recommendedConfig?.permissions;
      if (permissions?.allowShell || permissions?.allowFileWrite || permissions?.allowWebAccess) {
        flags.push({ op: action.type, kind: "permission_expansion", detail: "company permissions" });
      }
      if ((permissions && "mcpServers" in permissions && (permissions.mcpServers?.length ?? 0) > 0)
        || (action.toolRequirements?.requiredMcpServers.length ?? 0) > 0
        || (action.mcpRequirements?.length ?? 0) > 0) {
        flags.push({ op: action.type, kind: "mcp", detail: "company MCP/tool requirements" });
      }
    } else if (action.type === "add_agent") {
      // 权限扩大要看"加了新成员后危险权限面是否变化",先攒 add_agent 的模拟节点,统一比对 dangerFlags。
      simulatedNewNodes.push({
        id: `__sim_${simulatedNewNodes.length}`, name: action.name, role: action.role, parentId: undefined, childrenIds: [],
        model: action.model || "", provider: action.provider || "", framework: "api",
        status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
        editable: true, deletable: true, enabled: true,
      });
    }
  }
  if (simulatedNewNodes.length > 0) {
    const beforeFlags = dangerFlagsForAgents(beforeAgents);
    const afterFlags = dangerFlagsForAgents([...beforeAgents, ...simulatedNewNodes]);
    const expanded = afterFlags.filter(f => !beforeFlags.includes(f));
    if (expanded.length > 0) flags.push({ op: "permission_expansion", kind: "permission_expansion", detail: expanded.join("、") });
  }
  return flags;
}

// 每种 action 触及的活公司受影响面(agents / workflow / presetChannels)——供 buildArchitectApplyLedger
// 判定哪些字段是"有意改动"(intentionally_transformed)、哪些应"保真"(preserved,漂移即 lost)。
export function architectTouchedFields(actions: ArchitectAction[]): Set<ArchitectApplyField> {
  const s = new Set<ArchitectApplyField>();
  for (const a of actions) {
    if (a.type === "add_agent" || a.type === "remove_agent" || a.type === "update_agent") s.add("agents");
    else if (a.type === "add_verification_edge" || a.type === "remove_verification_edge") s.add("workflow");
    else if (a.type === "add_a2a_channel" || a.type === "remove_a2a_channel") s.add("presetChannels");
    else if (a.type === "upsert_bundled_skill" || a.type === "remove_bundled_skill") s.add("bundledSkills");
    else if (a.type === "update_company_governance") s.add("governance");
  }
  return s;
}

function resolveAgentByName(
  roster: AgentNodeConfig[],
  name: string,
): { agent?: AgentNodeConfig; reason?: string } {
  const matches = roster.filter(a => a.name === name);
  if (matches.length === 0) return { reason: `未找到名为「${name}」的成员` };
  if (matches.length > 1) return { reason: `名字「${name}」在公司内不唯一,无法确定引用哪一个` };
  return { agent: matches[0] };
}

function companyRoster(companyId: string): AgentNodeConfig[] {
  return getAgents().filter(a => (a.companyId || "default") === companyId);
}

// 对每条 action 按 name 解析出真实 agent/role/id,然后用现成原语落地。找不到/歧义的 action 标记
// ok:false + reason,不阻断其余 action(整批里一条坏引用不该拖累其他条)。每条 action 处理前都重新
// 读取 roster,让同一批次里"先加人、再让新人被汇报/被核验"这类前后依赖的 action 生效。
//
// 这段落地逻辑本身在这次重新设计里完全没有变化——无论 action 是"对话模式"(旧版)还是新版"执行模式
// 拆解"出来的,落地方式都一样,复用同一份原语。
export async function applyArchitectActions(
  projectRoot: string,
  companyId: string,
  actions: ArchitectAction[],
): Promise<ArchitectApplyResult[]> {
  const results: ArchitectApplyResult[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "add_agent": {
        const roster = companyRoster(companyId);
        if (roster.some(a => a.name === action.name)) {
          results.push({ action, ok: false, reason: `已存在同名成员「${action.name}」` });
          break;
        }
        let parentId: string | undefined;
        if (action.reportsToName) {
          const { agent, reason } = resolveAgentByName(roster, action.reportsToName);
          if (!agent) { results.push({ action, ok: false, reason }); break; }
          parentId = agent.id;
        } else {
          parentId = roster.find(a => a.role === "ceo")?.id;
        }
        let binding;
        try {
          binding = await resolveAdaptiveModelBinding(
            projectRoot,
            action.provider || action.model
              ? { framework: "api", provider: action.provider, model: action.model }
              : undefined,
            "creative",
            { strictRequested: !!(action.provider || action.model) },
          );
        } catch (error: any) {
          results.push({ action, ok: false, reason: error?.message ?? String(error) });
          break;
        }
        const id = `${action.role}-${randomUUID().slice(0, 6)}`;
        const node: AgentNodeConfig = {
          id, name: action.name, role: action.role, parentId, childrenIds: [],
          model: binding.choice.model, provider: binding.choice.provider,
          framework: binding.choice.framework, companyId,
          status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
          editable: true, deletable: true, enabled: true,
        };
        addAgents([node]);
        results.push({ action, ok: true });
        break;
      }

      case "remove_agent": {
        const roster = companyRoster(companyId);
        const { agent, reason } = resolveAgentByName(roster, action.name);
        if (!agent) { results.push({ action, ok: false, reason }); break; }
        // 复用 OrgPage.handleDeleteAgent 的软删除语义:先从父级(们)的 childrenIds 摘除引用,
        // 再把该 agent 自己 enabled:false(后端没有硬删除单个 agent 的接口,也不该在这里新造一个)。
        for (const a of roster) {
          if (a.childrenIds.includes(agent.id)) {
            updateAgent(a.id, { childrenIds: a.childrenIds.filter(cid => cid !== agent.id) });
          }
        }
        updateAgent(agent.id, { enabled: false });
        results.push({ action, ok: true });
        break;
      }

      case "update_agent": {
        const roster = companyRoster(companyId);
        const { agent, reason } = resolveAgentByName(roster, action.name);
        if (!agent) { results.push({ action, ok: false, reason }); break; }

        const patch: Partial<AgentNodeConfig> = {};
        if (action.newName) {
          if (roster.some(a => a.id !== agent.id && a.name === action.newName)) {
            results.push({ action, ok: false, reason: `已存在同名成员「${action.newName}」` });
            break;
          }
          patch.name = action.newName;
        }
        if (action.provider || action.model) {
          try {
            const binding = await resolveAdaptiveModelBinding(projectRoot, {
              framework: action.provider ? "api" : agent.framework,
              provider: action.provider ?? agent.provider,
              model: action.model ?? agent.model,
            }, "creative", { strictRequested: true });
            patch.framework = binding.choice.framework;
            patch.provider = binding.choice.provider;
            patch.model = binding.choice.model;
          } catch (error: any) {
            results.push({ action, ok: false, reason: error?.message ?? String(error) });
            break;
          }
        }

        if (action.role) patch.role = action.role;
        if (action.framework && !action.provider && !action.model) patch.framework = action.framework as AgentNodeConfig["framework"];
        if (action.workingDirectory !== undefined) {
          if (action.workingDirectory === null) patch.workingDirectory = undefined;
          else {
            const checked = validateAgentWorkingDirectory(action.workingDirectory);
            if (!checked.ok) { results.push({ action, ok: false, reason: checked.error }); break; }
            patch.workingDirectory = checked.normalized;
          }
        }
        if (action.systemPrompt !== undefined) patch.systemPrompt = action.systemPrompt ?? undefined;
        if (action.visibilityPolicy !== undefined) patch.visibilityPolicy = action.visibilityPolicy ?? undefined;
        if (action.reasoningEffort !== undefined) patch.reasoningEffort = action.reasoningEffort ?? undefined;
        if (action.enabled !== undefined) patch.enabled = action.enabled;
        if (action.reportsToName) {
          const parentResolved = resolveAgentByName(roster, action.reportsToName);
          if (!parentResolved.agent) { results.push({ action, ok: false, reason: parentResolved.reason }); break; }
          if (parentResolved.agent.id === agent.id) {
            results.push({ action, ok: false, reason: "不能把自己设为自己的汇报对象" });
            break;
          }
          // updateAgent 只 patch 目标节点本身,不会联动其他节点的 childrenIds——重新挂靠时手动维护
          // 旧父级(摘除)和新父级(加入),否则组织树会出现 parentId 和 childrenIds 互相矛盾。
          const oldParent = agent.parentId ? roster.find(a => a.id === agent.parentId) : undefined;
          if (oldParent && oldParent.id !== parentResolved.agent.id) {
            updateAgent(oldParent.id, { childrenIds: oldParent.childrenIds.filter(cid => cid !== agent.id) });
          }
          if (!parentResolved.agent.childrenIds.includes(agent.id)) {
            updateAgent(parentResolved.agent.id, { childrenIds: [...parentResolved.agent.childrenIds, agent.id] });
          }
          patch.parentId = parentResolved.agent.id;
        }

        updateAgent(agent.id, patch);
        results.push({ action, ok: true });
        break;
      }

      case "add_verification_edge": {
        const roster = companyRoster(companyId);
        const producer = resolveAgentByName(roster, action.producerName);
        if (!producer.agent) { results.push({ action, ok: false, reason: producer.reason }); break; }
        const verifier = resolveAgentByName(roster, action.verifierName);
        if (!verifier.agent) { results.push({ action, ok: false, reason: verifier.reason }); break; }
        const company = getCompany(projectRoot, companyId);
        if (!company) { results.push({ action, ok: false, reason: "公司不存在" }); break; }

        const edges = company.workflow?.verificationEdges ?? [];
        const exists = edges.some(e => e.producer === producer.agent!.role && e.verifier === verifier.agent!.role);
        if (exists) { results.push({ action, ok: false, reason: "这条验证关系已存在" }); break; }

        const nextEdges = [...edges, {
          producer: producer.agent.role, verifier: verifier.agent.role,
          method: action.method, onReject: action.onReject ?? "redo", maxRounds: action.maxRounds ?? 1,
        }];
        updateCompany(projectRoot, companyId, { workflow: { ...company.workflow, verificationEdges: nextEdges } });
        results.push({ action, ok: true });
        break;
      }

      case "remove_verification_edge": {
        const roster = companyRoster(companyId);
        const producer = resolveAgentByName(roster, action.producerName);
        if (!producer.agent) { results.push({ action, ok: false, reason: producer.reason }); break; }
        const verifier = resolveAgentByName(roster, action.verifierName);
        if (!verifier.agent) { results.push({ action, ok: false, reason: verifier.reason }); break; }
        const company = getCompany(projectRoot, companyId);
        if (!company) { results.push({ action, ok: false, reason: "公司不存在" }); break; }

        const edges = company.workflow?.verificationEdges ?? [];
        const nextEdges = edges.filter(e => !(e.producer === producer.agent!.role && e.verifier === verifier.agent!.role));
        if (nextEdges.length === edges.length) { results.push({ action, ok: false, reason: "未找到匹配的验证关系" }); break; }
        updateCompany(projectRoot, companyId, { workflow: { ...company.workflow, verificationEdges: nextEdges } });
        results.push({ action, ok: true });
        break;
      }

      case "add_a2a_channel": {
        const roster = companyRoster(companyId);
        const from = resolveAgentByName(roster, action.fromName);
        if (!from.agent) { results.push({ action, ok: false, reason: from.reason }); break; }
        const to = resolveAgentByName(roster, action.toName);
        if (!to.agent) { results.push({ action, ok: false, reason: to.reason }); break; }
        if (from.agent.id === to.agent.id) { results.push({ action, ok: false, reason: "不能给自己开协作通道" }); break; }
        const company = getCompany(projectRoot, companyId);
        if (!company) { results.push({ action, ok: false, reason: "公司不存在" }); break; }

        const channels = company.presetChannels ?? [];
        const exists = channels.some(c =>
          (c.from === from.agent!.id && c.to === to.agent!.id) || (c.from === to.agent!.id && c.to === from.agent!.id));
        if (exists) { results.push({ action, ok: false, reason: "这条协作通道已存在" }); break; }

        const nextChannels = [...channels, { from: from.agent.id, to: to.agent.id, purpose: action.purpose }];
        updateCompany(projectRoot, companyId, { presetChannels: nextChannels });
        results.push({ action, ok: true });
        break;
      }

      case "remove_a2a_channel": {
        const roster = companyRoster(companyId);
        const from = resolveAgentByName(roster, action.fromName);
        if (!from.agent) { results.push({ action, ok: false, reason: from.reason }); break; }
        const to = resolveAgentByName(roster, action.toName);
        if (!to.agent) { results.push({ action, ok: false, reason: to.reason }); break; }
        const company = getCompany(projectRoot, companyId);
        if (!company) { results.push({ action, ok: false, reason: "公司不存在" }); break; }

        const channels = company.presetChannels ?? [];
        const nextChannels = channels.filter(c =>
          !((c.from === from.agent!.id && c.to === to.agent!.id) || (c.from === to.agent!.id && c.to === from.agent!.id)));
        if (nextChannels.length === channels.length) { results.push({ action, ok: false, reason: "未找到匹配的协作通道" }); break; }
        updateCompany(projectRoot, companyId, { presetChannels: nextChannels });
        results.push({ action, ok: true });
        break;
      }
      case "upsert_bundled_skill": {
        const roster = companyRoster(companyId);
        const knownRoles = new Set(roster.map(a => a.role));
        const unknownRoles = action.roles.filter(role => !knownRoles.has(role));
        if (unknownRoles.length > 0) { results.push({ action, ok: false, reason: `公司中不存在角色: ${unknownRoles.join(", ")}` }); break; }
        const existing = listSkills(projectRoot).filter(s => s.origin === "bundled" && s.companyId === companyId && s.title === action.skillName);
        for (const meta of existing) if (!action.roles.includes(meta.role)) deleteSkill(projectRoot, meta.id);
        for (const role of action.roles) {
          const current = existing.find(s => s.role === role);
          const patch: Partial<Skill> = { title: action.skillName, description: action.description, role, content: action.content, enabled: true, origin: "bundled", companyId, kind: "instruction" };
          if (current) updateSkill(projectRoot, current.id, patch);
          else createSkill(projectRoot, { id: `bundled-architect-${randomUUID().slice(0, 8)}`, title: action.skillName, description: action.description, role, content: action.content, enabled: true, lastModified: new Date().toISOString(), origin: "bundled", companyId, kind: "instruction" });
        }
        results.push({ action, ok: true }); break;
      }

      case "remove_bundled_skill": {
        const matches = listSkills(projectRoot).filter(s => s.origin === "bundled" && s.companyId === companyId && s.title === action.skillName);
        if (matches.length === 0) { results.push({ action, ok: false, reason: "未找到匹配的公司 Skill" }); break; }
        for (const skill of matches) deleteSkill(projectRoot, skill.id);
        results.push({ action, ok: true }); break;
      }

      case "update_company_governance": {
        const company = getCompany(projectRoot, companyId);
        if (!company) { results.push({ action, ok: false, reason: "公司不存在" }); break; }
        const patch: Partial<Company> = {};
        if (action.visibilityPolicy !== undefined) patch.visibilityPolicy = action.visibilityPolicy ?? undefined;
        if (action.recommendedConfig !== undefined) patch.recommendedConfig = action.recommendedConfig ?? undefined;
        if (action.requiredPermissions !== undefined) patch.requiredPermissions = action.requiredPermissions ?? undefined;
        if (action.toolRequirements !== undefined) patch.manifestToolRequirements = action.toolRequirements ?? undefined;
        if (action.mcpRequirements !== undefined) patch.manifestMcpRequirements = action.mcpRequirements ?? undefined;
        if (!updateCompany(projectRoot, companyId, patch)) { results.push({ action, ok: false, reason: "公司治理配置写入失败" }); break; }
        results.push({ action, ok: true }); break;
      }
    }
  }

  return results;
}
