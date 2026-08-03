// 模板工坊 v1 · 草稿数据模型 + 校验 + 落盘 payload 构建。
// 设计要点(与既有 CompanyTemplate/AgentNodeConfig schema 对齐,packages/shared 不改):
// - 草稿里每张"角色卡"用本地稳定 key 编辑(汇报关系/验证边都引用 key),保存时才换算成最终 agent id。
// - CEO/Lead 是结构性角色(orchestrator/install 多处按 role==="ceo"|"lead" 做特判),永远保留字面 role。
// - 角色的系统提示词直接保存在 AgentNodeConfig.systemPrompt 中,随模板导出、导入并在运行时生效。
// - personas payload 只用于兼容旧服务端与安全扫描,服务端会合并回 agent.systemPrompt,不会生成 Skill。
import type {
  AgentFramework, AgentNodeConfig, AgentCapabilityCard, BundleAgentMemory, BundleMemoryRecord,
  CompanyTemplate, VerificationEdge, VerificationMethod, VisibilityPolicy,
} from "@opc/shared";
import { AGENT_WORKSHOP_SKIP_KEYS, TEMPLATE_WORKSHOP_SKIP_KEYS } from "@opc/shared";
import { API_FRAMEWORK } from "../../lib/framework.js";

export type WorkshopOrigin = "blank" | "company" | "fork";

export interface WorkshopCard {
  key: string;
  role: string;
  name: string;
  provider: string; // "" = 使用者自配;CLI 订阅框架下不参与(归属账号由 framework 决定)
  model: string;    // "" = 使用者自配;CLI 订阅框架下是模型别名(见 CLI_MODEL_ALIASES)
  framework?: AgentFramework; // undefined = 缺省按 "api" 处理(旧草稿/模板带 "hermes" 原始值时读侧双接受,不静默改写)
  systemPrompt: string;
  reportsTo: string; // 另一张卡的 key;"" = 顶层
  // ② 是否为本卡生成模板内唯一 role。系统提示词始终保存在该 agent 的 systemPrompt 中。
  //   · 手搭新卡(newCard)默认 true —— 保留既有"填了提示词即视为人设"的作者语义。
  //   · 从公司/模板反推(draftFromTemplate)按【来源 role 是否已是 scoped 人设角色】判定:普通员工
  //     (语义 role,即便带 card.summary)= false,绝不因有 summary 就被自动改成 `wk-*`;原本就是人设的
  //     (role 形如 `wk-…`)= true,保留人设身份。只有本开关为 true 才会在 buildPayload 里改写 role。
  isPersona: boolean;
  // ③ Bundle 投影:本卡对应 agent 上工坊 UI 不编辑的其余字段(claudeCodeUseApiKey / reasoningEffort /
  //   card(除 summary 外的 skills/produces/consumes/tools 等)/ growth / uiPosition / enabled /
  //   editable / deletable / genericCli / visibilityPolicy / 以及未来新增的可安全携带字段)。原样保留,
  //   buildPayload 时作为底合并回,不经工坊静默丢。本机路径/运行态(workspaceDir/cliConfigDir/status/
  //   tokenUsage/costUsd/companyId 等)刻意【不】进 passthrough——它们由 install/reroot 重置。
  passthrough?: Partial<AgentNodeConfig>;
}

export interface WorkshopEdge {
  key: string;
  producer: string; // 卡片 key,或 "*" 通配
  verifier: string; // 卡片 key
  method: VerificationMethod;
  onReject: "redo" | "flag";
  maxRounds?: number;
}

// 打包的 skill(从本地 skill store 勾选);content 内联自包含,roles 空 = install 时缺省绑定本模板全部角色。
export interface WorkshopSkillRef {
  key: string;
  skillId: string;    // 来源本地 skill 的 id(仅用于工坊内去重/展示,不随模板落盘)
  name: string;
  description: string;
  content: string;
  roles: string[];    // 目标角色名(取自 cards 的 role 值);空 = 缺省绑定本模板出现过的全部角色
}

// 声明依赖的 MCP 服务器(不打包——MCP 是本机服务),install 时对照本机已配置报 missing。
export interface WorkshopMcpReq {
  key: string;
  name: string;
  purpose: string;
  optional: boolean;
}

// 预置 A2A 通道:两张角色卡之间常驻的协作通道(install 后自动 grant,不需 worker 再 request_channel 审批)。
export interface WorkshopA2AChannel {
  key: string;
  from: string; // 卡片 key
  to: string;   // 卡片 key
  purpose: string;
  direction?: "oneway" | "bidirectional";
  authPolicy?: "trusted" | "gated" | "manual";
  enabled?: boolean;
}

export interface WorkshopDraft {
  id: string;
  title: string;
  description: string;
  tags: string;      // 逗号分隔
  useCases: string;   // 每行一条
  riskNotes: string;  // 每行一条
  // P1(审计)· readme 是独立于 description 的富文本文档(常是整篇 markdown 说明),不是"由描述派生"。
  // 从模板反推时**原样捕获**,保存时原样写回;仅当来源模板本就无 readme(新建/无 readme 模板)才在
  // buildPayload 回退用 description/title 生成。避免"工坊无编辑保存 → readme 被 description 覆盖"的静默丢失。
  readme?: string;
  cards: WorkshopCard[];
  edges: WorkshopEdge[];
  bundledSkills: WorkshopSkillRef[];
  mcpRequirements: WorkshopMcpReq[];
  a2aChannels: WorkshopA2AChannel[];
  // recommendedConfig(可加性,原来工坊完全没有编辑入口——从公司导出/fork 一份带 recommendedConfig 的模板
  // 再保存会静默丢字段,同"公司导出丢字段"是同一类问题)。enabled 控制是否落盘该字段;defaultModel 单独
  // 可选(空 = 不建议);Token 上限填正数才落盘(见 buildPayload);permissions 只要 enabled 就整体落盘。
  recommendedConfigEnabled: boolean;
  recommendedDefaultModel: string;
  recommendedMaxTokensPerTask: string;   // 数字字符串,""/非正数 = 不设 Token 上限
  // Hidden compatibility payload. It is never shown as a money budget, but keeping it
  // lets legacy bundles survive a no-op workshop/Architect edit without shape loss.
  recommendedLegacyBudget?: NonNullable<CompanyTemplate["recommendedConfig"]>["budget"];
  recommendedAllowShell: boolean;
  recommendedAllowFileWrite: boolean;
  recommendedAllowWebAccess: boolean;
  forkedFrom?: string;
  origin: WorkshopOrigin;
  // ① 记忆随工坊走:从公司/模板反推时保留,保存时原样写回最终模板 —— 让"带记忆导出"在"创建社区
  //   模板"主路径真正生效(此前 buildPayload 完全不产出这两个字段,工坊保存的模板一律无记忆)。
  seedMemories?: BundleMemoryRecord[];   // 公司/团队/员工/项目分层的经验记忆
  agentMemories?: BundleAgentMemory[];   // 员工个人记忆(agent-memory.md)
  // ③ 其余 Bundle 顶层可移植字段的投影(工坊 UI 不逐一编辑,但必须原样带回,不静默丢):
  defaultTasks?: Array<{ title: string; goal: string; suggestedRole?: string }>; // 示例任务
  visibilityPolicy?: VisibilityPolicy;   // 公司级消息可见性/信息隔离策略
  toolRequirements?: CompanyTemplate["toolRequirements"]; // 原始工具/引擎/provider 需求(含作者手写不可从 agents 反推的项)
  // 兜底:上面未逐一提为具名字段的其余顶层字段(version/license/compatibility/requiredPermissions/
  //   exampleTrace/exampleArtifacts/… 以及未来新增可安全携带字段)原样保留,buildPayload 里作为底展开、
  //   再被工坊真正编辑的字段覆盖。不含被编辑字段与服务端补齐/安全信号字段(见 draftFromTemplate)。
  templatePassthrough?: Record<string, unknown>;
}

// ② 判定来源 role 是否已是 scoped 人设角色(工坊人设落盘惯例 `wk-<templateId>-<agentId>`)。普通员工
//    用的是语义 role(researcher/dev/…),不以 `wk-` 起头 → 反推时 isPersona=false,不被自动人设化。
function isPersonaRole(role: string): boolean {
  return /^wk-/i.test((role || "").trim());
}

// ③ draftFromTemplate 反推每张卡的 passthrough 时,这些 agent 字段【不】进 passthrough:
//    · 被工坊映射/结构重建的:id/name/role/provider/model/framework/parentId/childrenIds/card
//      (card 的 summary 走 systemPrompt 回填,完整 card 另经 passthrough.card 保留)。
//    · 本机路径/运行态(由 install/reroot 重置,不该经工坊固化):companyId/workspaceDir/cliConfigDir/
//      status/currentTask/lastAction/tokenUsage/costUsd。
// 收口④:清单收敛到 companyFieldRegistry(唯一真相源,= structural+binding+local-path+runtime 四组),
// 与 install/reroot、导出脱敏引用同一份字段属性表;集合内容与收敛前逐键一致(守卫测试钉死)。
const AGENT_PASSTHROUGH_SKIP = new Set<string>(AGENT_WORKSHOP_SKIP_KEYS);

// ③ draftFromTemplate 捕获顶层 templatePassthrough 时跳过的键:被工坊各页真正编辑的、服务端补齐/覆盖的、
//    以及已提为具名 draft 字段的、还有安全信号(不由工坊固化,导入侧按 hash 重算)。
// 收口④:清单收敛到 companyFieldRegistry(唯一真相源,= workshop 属性非 "passthrough" 的全部顶层字段:
// edited 各页编辑 / named-carried 具名 draft 字段 / server-filled 服务端补齐 / security-signal 安全信号);
// 集合内容与收敛前逐键一致(守卫测试钉死)。
const TEMPLATE_PASSTHROUGH_SKIP = new Set<string>(TEMPLATE_WORKSHOP_SKIP_KEYS);

export function genKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function genTemplateId(): string {
  return `wk-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export function newCard(over: Partial<WorkshopCard> = {}): WorkshopCard {
  return {
    key: genKey(), role: "", name: "", provider: "", model: "", systemPrompt: "", reportsTo: "",
    // 手搭新卡默认 isPersona=true:非结构角色一旦填了系统提示词就固化成人设(保留既有作者语义)。
    // 结构角色(ceo/lead)buildPayload 无视此开关。反推场景(draftFromTemplate)会显式覆盖为真实来源判定。
    isPersona: true,
    ...over,
  };
}

export function blankDraft(): WorkshopDraft {
  return {
    id: genTemplateId(),
    title: "", description: "", tags: "", useCases: "", riskNotes: "",
    cards: [newCard({ role: "ceo", name: "CEO" })],
    edges: [],
    bundledSkills: [],
    mcpRequirements: [],
    a2aChannels: [],
    recommendedConfigEnabled: false,
    recommendedDefaultModel: "",
    recommendedMaxTokensPerTask: "",
    recommendedAllowShell: false,
    recommendedAllowFileWrite: true,
    recommendedAllowWebAccess: true,
    origin: "blank",
  };
}

// 从一份完整 CompanyTemplate(公司导出 / fork 结果)反推草稿,供继续编辑。
export function draftFromTemplate(tpl: CompanyTemplate, origin: WorkshopOrigin): WorkshopDraft {
  const keyFor = new Map<string, string>();
  for (const a of tpl.agents) keyFor.set(a.id, genKey());
  const findKeyByRef = (ref: string): string => {
    if (ref === "*") return "*";
    const m = tpl.agents.find(a => a.id === ref || a.role === ref);
    return m ? (keyFor.get(m.id) ?? "") : "";
  };
  const cards: WorkshopCard[] = tpl.agents.map(a => {
    // ③ passthrough:工坊 UI 不编辑的其余 agent 字段(除映射/结构/本机路径/运行态外全部原样带回),
    //    含未来新增的可安全携带字段(denylist 而非 allowlist,自动前向兼容)。
    const passthrough: Partial<AgentNodeConfig> = {};
    for (const [k, v] of Object.entries(a)) {
      if (AGENT_PASSTHROUGH_SKIP.has(k) || v === undefined) continue;
      (passthrough as Record<string, unknown>)[k] = v;
    }
    // 完整 card(skills/produces/consumes/tools 等)单独保留;summary 另经 systemPrompt 回填/覆盖。
    if (a.card) passthrough.card = a.card;
    return {
      key: keyFor.get(a.id)!,
      role: a.role || "",
      name: a.name || "",
      provider: a.provider || "",
      model: a.model || "",
      framework: a.framework,
      systemPrompt: a.systemPrompt || a.card?.summary || "",
      reportsTo: a.parentId && keyFor.has(a.parentId) ? keyFor.get(a.parentId)! : "",
      // ② 普通员工(语义 role)= false,即便带 card.summary 也不自动人设化;原本人设(wk-* role)= true。
      isPersona: isPersonaRole(a.role),
      passthrough,
    };
  });
  const edges: WorkshopEdge[] = (tpl.workflow?.verificationEdges || []).map(e => ({
    key: genKey(),
    producer: findKeyByRef(e.producer),
    verifier: findKeyByRef(e.verifier),
    method: e.method,
    onReject: e.onReject,
    maxRounds: e.maxRounds,
  }));
  const bundledSkills: WorkshopSkillRef[] = (tpl.bundledSkills || []).map(s => ({
    key: genKey(), skillId: "", name: s.name, description: s.description || "", content: s.content, roles: s.roles || [],
  }));
  const mcpRequirements: WorkshopMcpReq[] = (tpl.mcpRequirements || []).map(m => ({
    key: genKey(), name: m.name, purpose: m.purpose || "", optional: !!m.optional,
  }));
  const a2aChannels: WorkshopA2AChannel[] = (tpl.a2aChannels || []).map(c => ({
    key: genKey(), from: findKeyByRef(c.from), to: findKeyByRef(c.to), purpose: c.purpose || "",
    direction: c.direction, authPolicy: c.authPolicy, enabled: c.enabled,
  }));
  const rc = tpl.recommendedConfig;
  return {
    id: origin === "company" ? genTemplateId() : (tpl.id || genTemplateId()),
    title: origin === "company" ? `${tpl.title} 模板` : tpl.title,
    description: tpl.description || "",
    tags: (tpl.tags || []).join(", "),
    useCases: (tpl.useCases || []).join("\n"),
    riskNotes: (tpl.riskNotes || []).join("\n"),
    // P1(审计)· 原样捕获来源模板的独立 readme(常与 description 不同的富文本);无编辑保存不丢。
    readme: tpl.readme,
    cards: cards.length ? cards : [newCard({ role: "ceo", name: "CEO" })],
    edges,
    bundledSkills,
    mcpRequirements,
    a2aChannels,
    // recommendedConfig 反推:origin 是 "company"/"fork" 时若源模板带这个字段,必须原样带进草稿,否则
    // 编辑后保存会把它静默丢掉(同"公司导出丢字段"是一类 bug)。
    recommendedConfigEnabled: !!rc,
    recommendedDefaultModel: rc?.defaultModel || "",
    recommendedMaxTokensPerTask: rc?.maxTokensPerTask
      ? String(rc.maxTokensPerTask)
      : (rc?.budget ? String(rc.budget.maxTokensPerTask) : ""),
    recommendedLegacyBudget: rc?.budget ? { ...rc.budget } : undefined,
    recommendedAllowShell: rc?.permissions?.allowShell ?? false,
    recommendedAllowFileWrite: rc?.permissions?.allowFileWrite ?? true,
    recommendedAllowWebAccess: rc?.permissions?.allowWebAccess ?? true,
    forkedFrom: origin === "fork" ? (tpl.forkedFrom || tpl.id) : undefined,
    origin,
    // ① 记忆随工坊走:原样带进草稿(编辑其它页不动它们),保存时 buildPayload 写回。
    seedMemories: tpl.seedMemories,
    // 员工个人记忆的 agent_id 从【源模板 agent id】改写成【卡片本地 key】——buildPayload 会把 agent id
    //   重排成 `${slug(role)}` 系列(与源模板 id 不同),若这里不把 agentMemories 的锚点一并挪到稳定的
    //   卡片 key 上,保存后 agent_id 就与新 agent id 对不上、安装时按 idMap 查不到人 → 员工记忆被静默丢。
    //   查不到对应卡片的(悬空记忆)保留原值兜底(安装侧 importAgentMemories 查无即跳过,无害)。
    agentMemories: tpl.agentMemories?.map(m => ({ ...m, agent_id: keyFor.get(m.agent_id) ?? m.agent_id })),
    // ③ 其余顶层可移植字段:具名保留 + 兜底 passthrough。
    defaultTasks: tpl.defaultTasks,
    visibilityPolicy: tpl.visibilityPolicy,
    toolRequirements: tpl.toolRequirements,
    templatePassthrough: captureTemplatePassthrough(tpl),
  };
}

// ③ 捕获顶层 templatePassthrough:除被工坊编辑/服务端补齐/已具名/安全信号外的字段原样收拢。
function captureTemplatePassthrough(tpl: CompanyTemplate): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(tpl)) {
    if (TEMPLATE_PASSTHROUGH_SKIP.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

export interface ValidationResult {
  errors: Record<string, string>;
  valid: boolean;
}

function isStructuralRole(role: string): boolean {
  const r = role.trim().toLowerCase();
  return r === "ceo" || r === "lead";
}

function hasCycle(cards: WorkshopCard[], startKey: string): boolean {
  const byKey = new Map(cards.map(c => [c.key, c]));
  let cur: string | undefined = startKey;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const c = byKey.get(cur);
    cur = c?.reportsTo || undefined;
    if (cur === startKey) return true;
  }
  return false;
}

export function validateDraft(draft: WorkshopDraft): ValidationResult {
  const errors: Record<string, string> = {};
  if (!draft.title.trim()) errors["basic:title"] = "标题必填";
  if (draft.cards.length === 0) errors["global:cards"] = "至少需要一张角色卡";

  const cardKeys = new Set(draft.cards.map(c => c.key));
  let ceoCount = 0;
  for (const c of draft.cards) {
    if (!c.name.trim()) errors[`card:${c.key}:name`] = "姓名必填";
    if (!c.role.trim()) errors[`card:${c.key}:role`] = "角色必填";
    if (isStructuralRole(c.role) && c.role.trim().toLowerCase() === "ceo") {
      ceoCount++;
      if (c.reportsTo) errors[`card:${c.key}:reportsTo`] = "CEO 不能有汇报对象";
    }
    if (c.reportsTo) {
      if (c.reportsTo === c.key) errors[`card:${c.key}:reportsTo`] = "不能汇报给自己";
      else if (!cardKeys.has(c.reportsTo)) errors[`card:${c.key}:reportsTo`] = "汇报对象不存在";
      else if (hasCycle(draft.cards, c.key)) errors[`card:${c.key}:reportsTo`] = "汇报关系成环";
    }
  }
  if (ceoCount === 0) errors["global:ceo"] = "缺少 CEO:至少一张角色卡的「角色」需填 ceo";
  else if (ceoCount > 1) errors["global:ceo"] = "只能有一个 CEO(现有 " + ceoCount + " 个)";

  draft.edges.forEach(e => {
    if (e.producer !== "*" && !cardKeys.has(e.producer)) errors[`edge:${e.key}:producer`] = "producer 引用的角色不存在";
    if (!cardKeys.has(e.verifier)) errors[`edge:${e.key}:verifier`] = "verifier 引用的角色不存在";
  });

  draft.bundledSkills.forEach(s => {
    if (!s.name.trim()) errors[`skill:${s.key}:name`] = "技能名称必填";
    if (!s.content.trim()) errors[`skill:${s.key}:content`] = "技能内容不能为空";
  });

  draft.mcpRequirements.forEach(m => {
    if (!m.name.trim()) errors[`mcp:${m.key}:name`] = "MCP 名称必填";
  });

  draft.a2aChannels.forEach(c => {
    if (!c.from || !cardKeys.has(c.from)) errors[`a2a:${c.key}:from`] = "发起方引用的角色不存在";
    if (!c.to || !cardKeys.has(c.to)) errors[`a2a:${c.key}:to`] = "对方引用的角色不存在";
    if (c.from && c.to && c.from === c.to) errors[`a2a:${c.key}:to`] = "不能与自己开通道";
  });

  return { errors, valid: Object.keys(errors).length === 0 };
}

function slugify(s: string): string {
  const base = (s || "agent").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "agent";
}

export interface PersonaPayload { role: string; title: string; content: string }
// ② 一次保存里发生的"语义角色 → 人设(wk-*)"转换,供 UI 在 diff 中展示(以及说明"已同步改写引用")。
//   人设→人设的机械重编号(换新 templateId 前缀)不计入——那不是用户视角的"转 persona"。
export interface RoleChange { cardKey: string; name: string; fromRole: string; toRole: string }
export interface WorkshopBuildResult { template: CompanyTemplate; personas: PersonaPayload[]; roleChanges: RoleChange[] }

// 把草稿换算成一份合法的 CompanyTemplate(author/downloads/stars/createdAt 由服务端补齐/覆盖)。
export function buildPayload(draft: WorkshopDraft): WorkshopBuildResult {
  const idFor = new Map<string, string>();
  const used = new Set<string>();
  for (const c of draft.cards) {
    const roleNorm = c.role.trim().toLowerCase();
    const base = roleNorm === "ceo" ? "ceo" : roleNorm === "lead" ? "lead" : slugify(c.role);
    let id = base, n = 2;
    while (used.has(id)) id = `${base}-${n++}`;
    used.add(id);
    idFor.set(c.key, id);
  }

  const childrenOf = new Map<string, string[]>();
  for (const c of draft.cards) childrenOf.set(idFor.get(c.key)!, []);
  for (const c of draft.cards) {
    if (c.reportsTo && idFor.has(c.reportsTo)) {
      childrenOf.get(idFor.get(c.reportsTo)!)!.push(idFor.get(c.key)!);
    }
  }

  const personas: PersonaPayload[] = [];
  const roleChanges: RoleChange[] = [];
  const roleRename = new Map<string, string>(); // 旧 role 名 → 新 scoped 人设 role(供 bundledSkills.roles 同步改写)
  const agents: AgentNodeConfig[] = draft.cards.map(c => {
    const finalId = idFor.get(c.key)!;
    const structural = isStructuralRole(c.role);
    const prompt = c.systemPrompt.trim();
    let runtimeRole = structural ? c.role.trim().toLowerCase() : (c.role.trim() || "worker");
    // ② 仅在【显式 isPersona】且非结构角色且有提示词时,才固化成 scoped 人设角色 + 人设 skill,并同步
    //    改写引用(bundledSkills.roles / 在 roleChanges 里展示)。普通员工(isPersona=false)即便有
    //    card.summary 也保留原 role,绝不被自动改成 wk-*。
    if (!structural && c.isPersona && prompt) {
      const newRole = `wk-${draft.id}-${finalId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80);
      if (newRole !== runtimeRole) {
        roleRename.set(runtimeRole, newRole);
        // 只有"语义角色 → 人设"这类真转换进 diff;人设→人设的机械重编号不打扰用户(引用照样同步)。
        if (!isPersonaRole(runtimeRole)) roleChanges.push({ cardKey: c.key, name: c.name.trim() || c.role.trim(), fromRole: runtimeRole, toRole: newRole });
      }
      runtimeRole = newRole;
      personas.push({ role: runtimeRole, title: c.name.trim() || c.role.trim(), content: prompt });
    }
    // ③ passthrough(工坊不编辑的字段)作为底展开,再由工坊真正编辑/结构重建的字段覆盖。
    const pass = (c.passthrough ?? {}) as Partial<AgentNodeConfig>;
    const node: AgentNodeConfig = {
      ...pass,
      id: finalId,
      name: c.name.trim(),
      role: runtimeRole,
      parentId: c.reportsTo && idFor.has(c.reportsTo) ? idFor.get(c.reportsTo) : undefined,
      childrenIds: childrenOf.get(finalId) || [],
      model: c.model.trim(),
      provider: c.provider.trim(),
      // 缺省新卡写侧落 "api";旧卡片显式带的 framework(含存量 "hermes")原样保留——导入经 shared
      // schema 读侧归一,不在此处强转。
      framework: c.framework || API_FRAMEWORK,
      // 运行态一律复位(passthrough 本就不含这些,这里再显式钉死,防未来 passthrough 口径放宽误带)。
      status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      costUsd: 0,
      editable: pass.editable ?? true,
      deletable: pass.deletable ?? true,
      enabled: pass.enabled ?? true,
      systemPrompt: prompt || pass.systemPrompt,
    };
    // card:保留 passthrough.card 的其余字段(skills/produces/consumes/tools 等),summary 用当前
    // systemPrompt(编辑生效);无 prompt 但有既有 card → 原样保留;都没有 → 不设 card。
    const baseCard = pass.card as AgentCapabilityCard | undefined;
    if (prompt) node.card = { ...(baseCard ?? { skills: [] }), summary: prompt.slice(0, 4000) };
    else if (baseCard) node.card = baseCard;
    else delete node.card;
    return node;
  });

  const edges: VerificationEdge[] = draft.edges.map(e => ({
    producer: e.producer === "*" ? "*" : (idFor.get(e.producer) || e.producer),
    verifier: idFor.get(e.verifier) || e.verifier,
    method: e.method,
    onReject: e.onReject,
    maxRounds: e.maxRounds,
  }));

  const tags = draft.tags.split(",").map(s => s.trim()).filter(Boolean);
  const useCases = draft.useCases.split("\n").map(s => s.trim()).filter(Boolean);
  const riskNotes = draft.riskNotes.split("\n").map(s => s.trim()).filter(Boolean);

  // Stage 8+:打包 skill(内容随模板走)。roles 留空 = install 时缺省绑定本模板出现过的全部角色(服务端算)。
  const bundledSkills = draft.bundledSkills
    .filter(s => s.name.trim() && s.content.trim())
    .map(s => ({
      name: s.name.trim(),
      description: s.description.trim() || undefined,
      content: s.content,
      roles: s.roles.length ? s.roles : undefined,
    }));

  // 声明依赖的 MCP(不打包)。
  const mcpRequirements = draft.mcpRequirements
    .filter(m => m.name.trim())
    .map(m => ({ name: m.name.trim(), purpose: m.purpose.trim() || undefined, optional: m.optional || undefined }));

  // 预置 A2A 通道:卡片 key 换算成最终 agent id(同验证边惯例)。
  const a2aChannelsOut = draft.a2aChannels
    .filter(c => c.from && c.to && idFor.has(c.from) && idFor.has(c.to) && c.from !== c.to)
    .map(c => ({
      from: idFor.get(c.from)!, to: idFor.get(c.to)!, purpose: c.purpose.trim() || undefined,
      ...(c.direction ? { direction: c.direction } : {}),
      ...(c.authPolicy ? { authPolicy: c.authPolicy } : {}),
      ...(c.enabled !== undefined ? { enabled: c.enabled } : {}),
    }));

  // recommendedConfig:三段各自独立可选——defaultModel 非空才带;Token 上限解析出正数才带。
  // totalUsd 仅为旧 bundle schema 兼容占位,固定写 0 且不参与统计或执行;permissions 只要整体开关打开就带(三个 checkbox 本身就是完整的布尔值,
  // 没有"未设置"态)。
  let recommendedConfig: CompanyTemplate["recommendedConfig"];
  if (draft.recommendedConfigEnabled) {
    const maxTokensPerTask = parseInt(draft.recommendedMaxTokensPerTask, 10);
    const hasTokenLimit = Number.isFinite(maxTokensPerTask) && maxTokensPerTask > 0;
    recommendedConfig = {
      ...(draft.recommendedDefaultModel.trim() ? { defaultModel: draft.recommendedDefaultModel.trim() } : {}),
      ...(draft.recommendedLegacyBudget
        ? { budget: {
            ...draft.recommendedLegacyBudget,
            ...(hasTokenLimit ? { maxTokensPerTask } : {}),
          } }
        : (hasTokenLimit ? { maxTokensPerTask } : {})),
      permissions: {
        allowShell: draft.recommendedAllowShell,
        allowFileWrite: draft.recommendedAllowFileWrite,
        allowWebAccess: draft.recommendedAllowWebAccess,
      },
    };
  }

  const template: CompanyTemplate = {
    // ③ 兜底:draft.templatePassthrough(工坊不逐一编辑、但可安全携带的顶层字段:version/license/
    //   compatibility/requiredPermissions/exampleTrace/exampleArtifacts/… )作为底展开,随后被工坊真正
    //   编辑/结构重建的字段覆盖(templatePassthrough 已排除这些字段,天然无冲突)。CompanyBundle 是唯一
    //   canonical:未编辑字段必须原样带回,禁经 WorkshopDraft 静默丢字段(P0-B 硬约束)。
    ...((draft.templatePassthrough ?? {}) as Partial<CompanyTemplate>),
    id: draft.id,
    title: draft.title.trim(),
    description: draft.description.trim(),
    author: "", // 服务端补本地用户名占位
    createdAt: new Date().toISOString(),
    tags,
    downloads: 0,
    stars: 0,
    // P1(审计)· 优先原样写回来源模板的独立 readme(无编辑保存不被 description 覆盖);仅当来源本就无
    // readme(新建/无 readme 模板)才回退用 description/title 生成。
    readme: draft.readme?.trim() || draft.description.trim() || draft.title.trim(),
    agents,
    ...(useCases.length ? { useCases } : {}),
    ...(riskNotes.length ? { riskNotes } : {}),
    ...(edges.length ? { workflow: { verificationEdges: edges } } : {}),
    ...(draft.forkedFrom ? { forkedFrom: draft.forkedFrom } : {}),
    ...(bundledSkills.length ? { bundledSkills } : {}),
    ...(mcpRequirements.length ? { mcpRequirements } : {}),
    ...(a2aChannelsOut.length ? { a2aChannels: a2aChannelsOut } : {}),
    ...(recommendedConfig ? { recommendedConfig } : {}),
    // ② 其余可移植设计字段原样写回(工坊 UI 不逐一编辑,但不能静默丢):
    ...(draft.visibilityPolicy ? { visibilityPolicy: draft.visibilityPolicy } : {}),
    ...(draft.toolRequirements ? { toolRequirements: draft.toolRequirements } : {}),
    ...(draft.defaultTasks?.length ? { defaultTasks: draft.defaultTasks } : {}),
    // ① 记忆随工坊走:seed(公司/团队/员工/项目分层)+ 员工个人记忆(agent-memory.md)原样写回,
    //   让"带记忆导出"在"公司→工坊→社区模板"主路径真正生效(此前 buildPayload 完全不产出这两个字段)。
    ...(draft.seedMemories?.length ? { seedMemories: draft.seedMemories } : {}),
    // 员工个人记忆的锚点从【卡片本地 key】(draftFromTemplate 挪过去的)换算回【最终 agent id】,与上面
    //   agents 的 id 重排口径一致(idFor:卡片 key → 最终 id),使 template.agentMemories.agent_id 与
    //   template.agents.id 对齐 → 安装侧 importAgentMemories 才查得到人、员工记忆随工坊链路真正落地。
    ...(draft.agentMemories?.length
      ? { agentMemories: draft.agentMemories.map(m => ({ ...m, agent_id: idFor.get(m.agent_id) ?? m.agent_id })) }
      : {}),
  };

  return { template, personas, roleChanges };
}
