// 公司管理页 · 草稿数据模型 + Company ↔ Draft 换算(纯函数,无副作用)。
// 与 workshopTypes.ts 的 WorkshopDraft 同一设计范式,但这里对应的是"活公司"(真实 Company + 真实
// agents),不是模板——因此没有本地 key 映射换算这一层:card.key 直接就是真实 agentId,
// 验证边/预置通道也直接是 Company.workflow.verificationEdges / presetChannels 的真实值(agentId 或 role),
// 不需要像模板工坊那样在保存时再做一次 key→id 的 buildPayload 换算。
import type {
  Company, AgentFramework, AgentNodeConfig, VerificationMethod, SkillMeta,
} from "@opc/shared";
import { type WorkshopCard } from "../components/community/workshopTypes.js";
import { normalizeFramework } from "./framework.js";

export interface CompanyDraftCard {
  key: string;        // = agentId(活公司没有"模板本地 key"这层间接,key 就是真实 id)
  agentId: string;
  role: string;
  name: string;
  provider: string;
  model: string;
  framework?: AgentFramework; // undefined = 缺省按 "api" 处理(存量 "hermes" 读侧双接受),同 WorkshopCard.framework
  reportsToKey?: string; // = 汇报对象的 agentId;undefined = 顶层(直接向 CEO/无上级)
}

export interface CompanyDraftEdge {
  producer: string; // agentId、role 名或 "*"
  verifier: string; // agentId 或 role 名
  method: VerificationMethod;
  onReject: "redo" | "flag";
  maxRounds?: number;
}

// 技能打包视图(只读反查,非模板打包语义):按 origin(persona/bundled)+ 角色匹配,反查这个公司
// 当前各角色实际绑定了哪些技能——companyToTemplate() 导出时也是按这个思路反查(见
// companyTemplate.ts collectBundledSkills),这里做的是同类但更宽松的展示版(不要求 manifestTemplateId
// 前缀精确匹配,只要 origin+role 对上就算"当前关联"),给用户一个"导出时大概会带上什么"的预览。
export interface CompanyDraftSkillView {
  skillId: string;
  title: string;
  roles: string[];
}

export interface CompanyDraftMcp {
  name: string;
  purpose?: string;
  optional?: boolean;
}

export interface CompanyDraftA2A {
  from: string; // agentId
  to: string;   // agentId
  purpose?: string;
}

export interface CompanyDraft {
  id: string;
  name: string;
  description: string;
  memoryExportEnabled: boolean;
  cards: CompanyDraftCard[];
  edges: CompanyDraftEdge[];
  bundledSkillsView: CompanyDraftSkillView[];
  mcpRequirements: CompanyDraftMcp[];
  a2aChannels: CompanyDraftA2A[];
}

// 活跃(未被软删)、属于该公司的 agents——enabled:false 是既有的软删惯例(见 useAgentStore.load 的注释),
// 管理页不应该把已软删的员工当真实成员参与团队结构/验证边/A2A 的下拉引用。
function companyLiveAgents(company: Company, agents: AgentNodeConfig[]): AgentNodeConfig[] {
  return agents.filter(a => (a.companyId || "default") === company.id && a.enabled !== false);
}

export function companyToDraft(company: Company, agents: AgentNodeConfig[]): CompanyDraft {
  const companyAgents = companyLiveAgents(company, agents);
  const idSet = new Set(companyAgents.map(a => a.id));
  const cards: CompanyDraftCard[] = companyAgents.map(a => ({
    key: a.id,
    agentId: a.id,
    role: a.role,
    name: a.name,
    provider: a.provider,
    model: a.model,
    framework: a.framework,
    reportsToKey: a.parentId && idSet.has(a.parentId) ? a.parentId : undefined,
  }));
  const edges: CompanyDraftEdge[] = (company.workflow?.verificationEdges ?? []).map(e => ({
    producer: e.producer, verifier: e.verifier, method: e.method, onReject: e.onReject, maxRounds: e.maxRounds,
  }));
  const mcpRequirements: CompanyDraftMcp[] = (company.manifestMcpRequirements ?? []).map(m => ({
    name: m.name, purpose: m.purpose, optional: m.optional,
  }));
  const a2aChannels: CompanyDraftA2A[] = (company.presetChannels ?? []).map(c => ({
    from: c.from, to: c.to, purpose: c.purpose,
  }));
  return {
    id: company.id,
    name: company.name,
    description: company.description ?? "",
    // Company.memoryExportEnabled 未设置时按 true 处理(见 packages/shared/src/types.ts 的字段注释)。
    memoryExportEnabled: company.memoryExportEnabled ?? true,
    cards,
    edges,
    bundledSkillsView: [], // 需要额外的 skills 列表输入,由 deriveBundledSkillsView() 另算(见下)
    mcpRequirements,
    a2aChannels,
  };
}

// 把整份草稿映射成一份可直接 PATCH /api/companies/:id 的请求体。各 tab 的显式保存按钮各自只需要
// 其中一部分字段,但整体覆盖式发送是安全的(CompanySchema.partial() 逐字段合并,不会清空未提及字段;
// 这里每次都把当前 draft 已知的完整值带上,不存在"半份 patch 把别的 tab 内容冲掉"的问题)。
export function draftToPatch(draft: CompanyDraft): Partial<Company> {
  return {
    name: draft.name.trim(),
    description: draft.description,
    memoryExportEnabled: draft.memoryExportEnabled,
    workflow: { verificationEdges: draft.edges.map(e => ({ ...e })) },
    manifestMcpRequirements: draft.mcpRequirements.map(m => ({ ...m })),
    presetChannels: draft.a2aChannels.map(c => ({ ...c })),
  };
}

// 技能打包视图的反查:遍历本地技能库,origin 为 persona/bundled 且 role 命中本公司现有角色集合的,
// 都算"当前关联"。persona 技能(sk-{role})与 bundled 技能(模板安装扇出)概念不同,这里合并展示成
// 同一份"这个公司现在挂着哪些技能"清单,不区分来源(来源在 title 旁没有区分展示的必要——反查视图
// 只回答"有没有""是什么"，不回答"从哪个模板来的"这种供应链问题，那是导出时 companyToTemplate 的职责)。
export function deriveBundledSkillsView(agents: AgentNodeConfig[], skills: SkillMeta[]): CompanyDraftSkillView[] {
  const roles = new Set(agents.filter(a => a.enabled !== false).map(a => a.role).filter(Boolean));
  return skills
    .filter(s => (s.origin === "persona" || s.origin === "bundled") && roles.has(s.role))
    .map(s => ({ skillId: s.id, title: s.title, roles: [s.role] }));
}

// ── P0-B · 公司结构页 skills 三态区分 ────────────────────────────────────────────────
// deriveBundledSkillsView 是"宽松反查"(origin+role 命中就算关联),会 **过度声称**:它把"恰好角色同名
// 但归属别的公司/别的模板"的打包技能也算进"这个公司的技能"。真正导出(companyTemplate.collectBundledSkills)
// 的口径要严得多——只有 companyId 精确命中(新形状)或 `bundled-{tplSlug}-…--{roleSlug}` 前后缀命中(legacy)
// 的 bundled、以及 `sk-{role}`/`sk-{role}-{tplId}` 命中的 persona 才会真被带走。本函数在客户端 **镜像**
// 那套服务端匹配口径,把公司当前挂着的打包类技能显式分成三类,让页面诚实回答"哪些会走 / 哪些不会走 /
// 接收方装完得到什么",而不是笼统地"只读反查"糊在一起。纯函数,可单测(companyDraft.test.ts)。
export interface CompanySkillExportView { title: string; roles: string[] }
export type NotExportedReason = "other-company" | "no-template-match";
export interface CompanySkillNotExportedView { skillId: string; title: string; role: string; reason: NotExportedReason }
export interface CompanySkillInjectView { title: string; role: string }
export interface CompanySkillClassification {
  // ① 已绑定且会导出:full/share 导出真会把它带走(companyToTemplate.collectBundledSkills 会收)。
  exported: CompanySkillExportView[];
  // ② 关联但不会导出:宽松反查会显示、真导出却不带(归属别的公司 / 匹配不上本公司模板前缀)——诚实标因。
  notExported: CompanySkillNotExportedView[];
  // ③ 社区安装后会实际注入:接收方装这份分享时,每条会导出的技能按其目标角色在新公司里生成一份技能文件。
  injected: CompanySkillInjectView[];
}

// 镜像 install.ts slugForSkillId(收窄到 ascii 短横线 slug + 截断 40)——bundled id 的三段就是这样拼的。
function slugSkillId(s: string): string {
  const base = (s || "skill").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "skill").slice(0, 40);
}

export function classifyCompanySkills(
  company: Pick<Company, "id" | "manifestTemplateId">,
  agents: AgentNodeConfig[],
  skills: SkillMeta[],
): CompanySkillClassification {
  const roles = new Set(agents.filter(a => (a.companyId || "default") === company.id && a.enabled !== false).map(a => a.role).filter(Boolean));
  const tplId = company.manifestTemplateId;
  const tplPrefix = tplId ? `bundled-${slugSkillId(tplId)}-` : undefined;
  const exported: CompanySkillExportView[] = [];
  const notExported: CompanySkillNotExportedView[] = [];
  const byTitle = new Map<string, Set<string>>(); // title → roles(去重合并,同 collectBundledSkills)

  const addExported = (title: string, role: string) => {
    const set = byTitle.get(title) ?? new Set<string>();
    set.add(role);
    byTitle.set(title, set);
  };

  // 只看打包类技能(persona/bundled)且角色命中本公司——与旧 deriveBundledSkillsView 同一 universe,
  // 但在其中把"会走 / 不会走"精确切开(旧视图全塞进"关联",这里补上真导出口径的裁决)。
  for (const s of skills) {
    if (s.origin !== "persona" && s.origin !== "bundled") continue;
    if (!roles.has(s.role)) continue;
    if (s.origin === "bundled") {
      if (s.companyId) {
        // 新形状:companyId 精确命中才带走;别的公司的资产一律不圈进本公司导出(镜像 collectBundledSkills)。
        if (s.companyId === company.id) addExported(s.title, s.role);
        else notExported.push({ skillId: s.id, title: s.title, role: s.role, reason: "other-company" });
      } else {
        // legacy:本公司模板前缀 + 角色后缀双命中才带走。
        const matched = !!tplPrefix && s.id.startsWith(tplPrefix) && s.id.endsWith(`--${slugSkillId(s.role)}`);
        if (matched) addExported(s.title, s.role);
        else notExported.push({ skillId: s.id, title: s.title, role: s.role, reason: "no-template-match" });
      }
    } else {
      // persona:两种落盘命名(sk-{role} 裸 / sk-{role}-{tplId})任一命中即带走(镜像 collectBundledSkills)。
      const bare = `sk-${s.role}`;
      const withTpl = tplId ? `sk-${s.role}-${tplId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80) : undefined;
      if (s.id === bare || (withTpl && s.id === withTpl)) addExported(s.title, s.role);
      else notExported.push({ skillId: s.id, title: s.title, role: s.role, reason: "no-template-match" });
    }
  }

  for (const [title, roleSet] of byTitle) exported.push({ title, roles: [...roleSet].sort() });
  exported.sort((a, b) => a.title.localeCompare(b.title));
  // ③ 接收方装完得到的具体注入项:每条会导出技能 × 其目标角色。
  const injected: CompanySkillInjectView[] = [];
  for (const e of exported) for (const role of e.roles) injected.push({ title: e.title, role });
  return { exported, notExported, injected };
}

// ── WorkshopCard 适配层 ──────────────────────────────────────────────────────────────
// WorkshopTeamEditor / WorkshopVerificationEditor / WorkshopA2AEditor 三个可复用编辑器都只认
// WorkshopCard 的形状({key,role,name,provider,model,systemPrompt,reportsTo}),且只用 key 做下拉引用/
// React key——不关心 key 具体是"模板本地 key"还是"真实 agentId"。CompanyDraftCard.key 本来就是
// agentId,所以直接把 key 对上就天然满足了 A2A/验证边编辑器"用 agentId 当 key"的需求,不需要额外换算层。
//
// 唯一的形状缺口是 systemPrompt/reportsTo 两个字段名 / 语义差异:
//   - reportsTo(Workshop) ↔ reportsToKey(CompanyDraft):改名而已,直接映射。
//   - systemPrompt:活公司里"编辑一个已存在员工的系统提示词"目前没有对应的真实持久化位置(不像模板工坊
//     的人设文本会落成 agent.card.summary/绑定 skill——那套换算只在"新建模板"这个一次性动作里发生,
//     实时公司走的是完全不同的角色内置 prompt/技能体系,见 orchestrator.ts getRolePrompt)。因此这里
//     永远把 systemPrompt 置空传入,且不把它写回任何字段——页面里会在团队结构 tab 顶部说明这一点,
//     避免用户以为在这里编辑人设会生效。
export function cardsToWorkshopCards(cards: CompanyDraftCard[]): WorkshopCard[] {
  return cards.map(c => ({
    key: c.key, role: c.role, name: c.name, provider: c.provider, model: c.model,
    framework: c.framework,
    // P0-B②:活公司员工用语义 role(非 wk-*)→ isPersona=false,经工坊保存不被自动改成 wk-* 人设 role。
    isPersona: /^wk-/i.test((c.role || "").trim()),
    systemPrompt: "", reportsTo: c.reportsToKey ?? "",
  }));
}

export function workshopCardToDraftCard(c: WorkshopCard): CompanyDraftCard {
  return {
    key: c.key, agentId: c.key, role: c.role.trim(), name: c.name.trim(),
    provider: c.provider.trim(), model: c.model.trim(), framework: c.framework,
    reportsToKey: c.reportsTo || undefined,
  };
}

// TeamTab(活公司团队编辑)的字段级 diff——给定"最后一次已同步到服务端"的快照 old 和当前编辑态 next,
// 只返回真正变化的 AgentNodeConfig 字段,不做整份覆盖式 PATCH。reportsTo/parentId 不在这里处理:
// 重新挂靠父节点需要读当下真实 agent 状态来同步维护旧/新父节点的 childrenIds,这部分有副作用,
// 留在 syncTeam 里单独处理(同 CompanyStructureForms.tsx TeamTab 的既有惯例)。
// name/role 沿用既有惯例:半填的值不同步(不能让用户还在打字的空白瞬间把真实 agent 的名字/角色清空)。
export function diffCardPatch(old: WorkshopCard, next: WorkshopCard): Partial<AgentNodeConfig> {
  const patch: Partial<AgentNodeConfig> = {};
  if (old.name !== next.name && next.name.trim()) patch.name = next.name.trim();
  if (old.role !== next.role && next.role.trim()) patch.role = next.role.trim();
  if (old.provider !== next.provider) patch.provider = next.provider.trim();
  if (old.model !== next.model) patch.model = next.model.trim();
  // 归一化比较:undefined/存量 "hermes" 与 "api" 视为同一状态(不产生多余 PATCH,也不静默改写旧值);
  // 真有变化时写侧一律落归一后的值(hermes→api)。
  if (normalizeFramework(old.framework) !== normalizeFramework(next.framework)) patch.framework = normalizeFramework(next.framework);
  return patch;
}
