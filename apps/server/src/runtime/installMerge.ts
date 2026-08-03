import type { AgentNodeConfig, Company, CompanyTemplate, A2AChannelSpec, McpRequirementSpec } from "@opc/shared";
import { TOOL_REQUIREMENT_KEYS, COMPANY_LEVEL_MERGE_FIELDS, listUnregisteredTemplateFields, normalizeCompanyId } from "@opc/shared";
import { orgHasCycle } from "./templateDoctor.js";
import { resolveTemplateAgentRef } from "./install.js";

// D3(V0 必需)· 安装三模式与合并冲突策略(指南「7月6日重构指南-现状对照与落地计划.md」§7 D3)。
// 本文件只做纯函数:检测冲突(detectMergeConflicts)与按策略产出可落地的结果(resolveMerge)。
// 真正写状态(addAgents/updateAgent/updateCompany)由路由层(communityRoutes.ts install/company、
// companyRoutes.ts import)完成——保持这里"AI/规则只产出提案,调用方决定何时 commit"的一贯分层。
//
// V0 组织模型没有独立的 team_id 概念(companyBundle.schema.ts 的 org.teams 目前只是占位数组),
// 表格里的"team_id / 组织边冲突"在本实现里收窄为"父子边(parentId)冲突 + 合并后成环检测"——
// 团队维度等 org.teams 结构做实后再接,这里如实标注,不假装已支持 team_id。

// ── 策略类型(五类冲突,每类一个策略,不是逐条实例可各选各的——指南原文"逐类明确") ──
export type AgentIdStrategy = "copy-as-new" | "keep-current" | "overwrite" | "manual";
export type OrgEdgeStrategy = "merge" | "keep-current" | "manual";
export type MemoryScopeStrategy = "skip-duplicate" | "coexist" | "overwrite";
export type A2ARuleStrategy = "union" | "keep-current" | "overwrite";
export type CapabilityStrategy = "strictest" | "manual";

export interface MergeStrategies {
  agentId?: AgentIdStrategy;
  orgEdge?: OrgEdgeStrategy;
  memoryScope?: MemoryScopeStrategy;
  a2aRule?: A2ARuleStrategy;
  capability?: CapabilityStrategy;
}

// 粗体默认值(指南表格):复制为新员工 / 并入去重边 / 跳过重复 / 取并集 / 取较严格者。
export const DEFAULT_MERGE_STRATEGIES: Required<MergeStrategies> = {
  agentId: "copy-as-new",
  orgEdge: "merge",
  memoryScope: "skip-duplicate",
  a2aRule: "union",
  capability: "strictest",
};

const AGENT_ID_STRATEGIES: AgentIdStrategy[] = ["copy-as-new", "keep-current", "overwrite", "manual"];
const ORG_EDGE_STRATEGIES: OrgEdgeStrategy[] = ["merge", "keep-current", "manual"];
const MEMORY_SCOPE_STRATEGIES: MemoryScopeStrategy[] = ["skip-duplicate", "coexist", "overwrite"];
const A2A_RULE_STRATEGIES: A2ARuleStrategy[] = ["union", "keep-current", "overwrite"];
const CAPABILITY_STRATEGIES: CapabilityStrategy[] = ["strictest", "manual"];

// 前端/路由传来的 body.mergeStrategies 是不可信的原始 JSON——白名单校验,非法值/缺省一律回退默认值,
// 不让一条坏字符串静默改变安装行为或抛异常。
export function sanitizeMergeStrategies(input: unknown): MergeStrategies {
  const raw = (input && typeof input === "object") ? (input as Record<string, unknown>) : {};
  const pick = <T extends string>(v: unknown, allowed: T[], fallback: T): T =>
    (typeof v === "string" && (allowed as string[]).includes(v)) ? (v as T) : fallback;
  return {
    agentId: pick(raw.agentId, AGENT_ID_STRATEGIES, DEFAULT_MERGE_STRATEGIES.agentId),
    orgEdge: pick(raw.orgEdge, ORG_EDGE_STRATEGIES, DEFAULT_MERGE_STRATEGIES.orgEdge),
    memoryScope: pick(raw.memoryScope, MEMORY_SCOPE_STRATEGIES, DEFAULT_MERGE_STRATEGIES.memoryScope),
    a2aRule: pick(raw.a2aRule, A2A_RULE_STRATEGIES, DEFAULT_MERGE_STRATEGIES.a2aRule),
    capability: pick(raw.capability, CAPABILITY_STRATEGIES, DEFAULT_MERGE_STRATEGIES.capability),
  };
}

// ── 冲突实例类型 ──
export interface AgentIdConflict { type: "agent_id"; agentId: string; existingName: string; incomingName: string }
// P1(并行审计抓出)· 语义团队重复:copy-as-new 合并会给 incoming agent 重排**新 id**,于是"按 agent.id 检冲突"
// 永远比不出——把导出的公司合并回它的克隆时,8 人静默变 16 人(两套 CEO/Lead/Dev)。改用 templateAgentKey
// (role + 归一 name,跨 id-reroot 稳定)检测:incoming 的 role+name 命中目标公司现有员工(且非 id 碰撞)→
// 语义重复,合并会新增第二套。预览据此提示"将新增第二套团队",让用户选映射/覆盖/明确新增部门,不再静默翻倍。
export interface TeamDuplicationConflict { type: "team_duplication"; role: string; incomingName: string; existingAgentId: string; existingName: string; detail: string }
export interface OrgEdgeConflict { type: "org_edge"; kind: "duplicate" | "would_cycle"; parentId: string; childId: string; detail: string }
// C9-P0 · 组织父级冲突:map 到已有员工时,模板为该员工声明的(解析后)父级与既有员工现 parentId 不同。
// 契约要求"map 到已有员工遇到新父级必须明确选择:保持原组织 / 调整组织 / 拒绝导入"。这是【组织维度】
// 冲突,与 teamDuplication(员工身份维度)正交:同一个 map 候选既是 team_duplication 又可能有 orgParent 差异。
export interface OrgParentConflict {
  type: "org_parent";
  agentId: string;          // 模板内 agent id(map 候选)
  existingAgentId: string;  // 映射到的既有员工 id
  existingName: string;
  currentParentId?: string; // 既有员工当前父(保持原组织时不变)
  templateParentId?: string;// 模板声明的父(解析到落地后的 id;调整组织时改挂到此)
  detail: string;
}
export interface A2ARuleConflict { type: "a2a_rule"; from: string; to: string; existingPurpose?: string; incomingPurpose?: string }
export interface CapabilityConflict { type: "capability"; name: string; existingOptional?: boolean; incomingOptional?: boolean }

// memory scope 冲突:V0 的 CompanyTemplate 尚无记忆导出字段(D5 才会补 bundle.memory.records),
// 这里先落地结构与纯函数,detectMergeConflicts/resolveMerge 的生产调用永远传空数组 —— 如实标注,
// 不假装已有数据源。SeedMemoryRecord 是给 D5 落地后复用的最小形状。
export interface SeedMemoryRecord { scope: string; sourceId: string; content: string }
export interface MemoryScopeConflict { type: "memory_scope"; scope: string; sourceId: string; detail: string }

export interface MergeConflictReport {
  agentId: AgentIdConflict[];
  teamDuplication: TeamDuplicationConflict[];
  orgParent: OrgParentConflict[];
  orgEdge: OrgEdgeConflict[];
  memoryScope: MemoryScopeConflict[];
  a2aRule: A2ARuleConflict[];
  capability: CapabilityConflict[];
}

export interface MergeDecision {
  category: "agent_id" | "org_edge" | "memory_scope" | "a2a_rule" | "capability" | "org_parent";
  conflictCount: number;
  strategy: string;
  summary: string;
}

function emptyReport(): MergeConflictReport {
  return { agentId: [], teamDuplication: [], orgParent: [], orgEdge: [], memoryScope: [], a2aRule: [], capability: [] };
}

// P1 · templateAgentKey:跨 id-reroot 稳定的语义身份 = role + 归一 name(id 会被 copy-as-new 重排,name/role 不会)。
export function templateAgentKey(a: { role?: string; name?: string }): string {
  return `${(a.role ?? "").trim().toLowerCase()}::${(a.name ?? "").trim().toLowerCase()}`;
}

// C9-P1 · childrenIds 由 parentId 统一重建(契约第9条:parentId 为组织关系真源,childrenIds 由其生成或强制
// 双向同步)。纯函数:以 parentId 为唯一真源,重算每个 agent 的 childrenIds = 所有 parentId 指向它的 agent id
// (按 agents 数组出现顺序,稳定确定;只在给定集合内解析,悬空 parentId 不产生边)。返回新数组(不改原对象),
// 消除"childrenIds 是与 parentId 并行的第二事实源"及 addAgents 批内顺序敏感/updateAgent 换父不同步等失配。
export function rebuildChildrenIds<T extends { id: string; parentId?: string; childrenIds?: string[]; companyId?: string }>(agents: T[]): T[] {
  // 组织父子边只在【同公司】内成立(归一化口径:空/undefined=default)。跨公司 parentId 视为悬空——
  // 既不建边、也不把子塞进外公司父的 childrenIds,并在重建时天然清除既有跨公司残边(merge 时 agent id
  // 全局碰撞把员工挂到外公司 agent 下的跨公司父子污染,wave4-live-acceptance 抓出的 P0)。
  const norm = (c?: string) => normalizeCompanyId(c); // 单一真相源(收口令二.1),消除手写 ||/?? 空串边界发散
  const byId = new Map(agents.map(a => [a.id, a]));
  const childrenByParent = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.parentId) continue;
    const parent = byId.get(a.parentId);
    if (!parent) continue; // 悬空 parentId(指向集合外)不产生边
    if (norm(parent.companyId) !== norm(a.companyId)) continue; // 跨公司父子边不建(视为悬空)
    const arr = childrenByParent.get(a.parentId) ?? [];
    arr.push(a.id);
    childrenByParent.set(a.parentId, arr);
  }
  return agents.map(a => ({ ...a, childrenIds: childrenByParent.get(a.id) ?? [] }));
}

// ── memory scope:结构预留的独立纯函数(见上方注释),单测直接调用验证逻辑。 ──
function memoryKey(m: SeedMemoryRecord): string { return `${m.scope}::${m.content}`; }

export function detectMemoryScopeConflicts(incoming: SeedMemoryRecord[], existing: SeedMemoryRecord[]): MemoryScopeConflict[] {
  const existingKeys = new Set(existing.map(memoryKey));
  return incoming
    .filter(m => existingKeys.has(memoryKey(m)))
    .map(m => ({ type: "memory_scope" as const, scope: m.scope, sourceId: m.sourceId, detail: "与现有同 scope 记录内容重复" }));
}

export function resolveMemoryScopeConflicts(
  incoming: SeedMemoryRecord[],
  existing: SeedMemoryRecord[],
  strategy: MemoryScopeStrategy = DEFAULT_MERGE_STRATEGIES.memoryScope,
): SeedMemoryRecord[] {
  const existingKeys = new Set(existing.map(memoryKey));
  if (strategy === "overwrite") return incoming; // 高风险:调用方需在此之前已拿到 confirmOverwrite,这里只是纯函数不做门禁
  if (strategy === "coexist") return incoming.map(m => existingKeys.has(memoryKey(m)) ? { ...m, sourceId: `${m.sourceId}(imported)` } : m);
  return incoming.filter(m => !existingKeys.has(memoryKey(m))); // skip-duplicate(默认)
}

// ── 检测:不改任何状态,纯读入 existingAgents/targetCompany/template,产出五类冲突清单。 ──
// existingAgents 传入调用方当前的**全量**员工(orchestrator.getAgents() 的全体,不只目标公司)——
// agent_id 在整个花名册里必须唯一(addAgents 也是按全局 id 去重),collision 检测要看全局;
// 组织边/成环检测则只看目标公司内的员工(其它公司的 parentId 链跟这次合并无关)。
export function detectMergeConflicts(
  template: CompanyTemplate,
  targetCompany: Company,
  existingAgents: AgentNodeConfig[],
  opts: { existingMemory?: SeedMemoryRecord[]; incomingMemory?: SeedMemoryRecord[] } = {},
): MergeConflictReport {
  const report = emptyReport();

  const existingById = new Map(existingAgents.map(a => [a.id, a]));
  for (const a of template.agents) {
    const ex = existingById.get(a.id);
    if (ex) report.agentId.push({ type: "agent_id", agentId: a.id, existingName: ex.name, incomingName: a.name });
  }

  const targetAgents = existingAgents.filter(a => normalizeCompanyId(a.companyId) === targetCompany.id);
  // P1(并行审计抓出)· 语义团队重复检测:copy-as-new 给 incoming 重排新 id,靠 agent.id 永远比不出——把导出公司
  // 合并回它的克隆时 8 人静默变 16。用 templateAgentKey(role+归一 name)比对**目标公司**现有员工:incoming 命中
  // 同 role+name(且非上面已报的 id 碰撞)→ 语义重复,合并将新增第二套。逐条列出,预览据此提示"将新增第二套团队"。
  const idCollisions = new Set(report.agentId.map(c => c.agentId));
  const targetKeyToAgent = new Map(targetAgents.map(a => [templateAgentKey(a), a]));
  for (const a of template.agents) {
    if (idCollisions.has(a.id)) continue; // 已按 id 碰撞报过,不重复
    const ex = targetKeyToAgent.get(templateAgentKey(a));
    if (ex) report.teamDuplication.push({
      type: "team_duplication", role: a.role ?? "", incomingName: a.name ?? "",
      existingAgentId: ex.id, existingName: ex.name,
      detail: `目标公司已有同角色同名员工「${ex.name}」(${ex.id});此次合并会**新增第二套**该员工(copy-as-new 重排新 id,非覆盖)。请选择:映射到现有员工 / 覆盖 / 或明确作为新部门新增。`,
    });
  }

  // C9-P0 · 组织父级冲突检测(只对 map 候选有意义):对每个 team_duplication 候选(map 时会落到既有员工),
  // 比对"模板为它声明的父(解析到既有员工 id)"与"既有员工当前 parentId"。不同 → orgParent 冲突,resolveMerge
  // 在 map 处置下遇到未选 orgParentResolution 时 409,逼用户选"保持原组织/调整组织/拒绝导入"。
  //   · 模板父的解析:模板 agent 的 parentId 指向模板内另一个 agent;若那个父 agent 本身也命中 team_duplication
  //     (同 role+name 撞既有员工),则模板父解析到那个既有员工 id(map 语义:引用重定向到现有);否则模板父是
  //     一个将新建的员工,其落地 id 在检测阶段未知,仍报冲突(templateParentId 用模板内 id 作可读标识)。
  const tmplById = new Map(template.agents.map(a => [a.id, a]));
  // 模板 agent id → 它 map 到的既有员工 id(仅 team_duplication 候选,且非 id 碰撞)。
  const mapCandidateToExisting = new Map<string, { existingId: string; existingName: string }>();
  for (const c of report.teamDuplication) {
    const t = template.agents.find(a => templateAgentKey(a) === templateAgentKey({ role: c.role, name: c.incomingName }) && !idCollisions.has(a.id));
    if (t) mapCandidateToExisting.set(t.id, { existingId: c.existingAgentId, existingName: c.existingName });
  }
  for (const [tmplId, mapped] of mapCandidateToExisting) {
    const a = tmplById.get(tmplId);
    if (!a) continue;
    const ex = targetAgents.find(e => e.id === mapped.existingId);
    if (!ex) continue;
    // 模板声明的父解析:父在 mapCandidate 里 → 既有员工 id;否则模板内 id(将新建,落地 id 未知)。
    const tmplParentRaw = a.parentId;
    const resolvedTemplateParent = tmplParentRaw
      ? (mapCandidateToExisting.get(tmplParentRaw)?.existingId ?? tmplParentRaw)
      : undefined;
    // 模板未声明父(根),map 语义是挂到目标公司挂载点/保持现状,不构成"新父级"冲突,跳过。
    if (!tmplParentRaw) continue;
    if (resolvedTemplateParent !== ex.parentId) {
      report.orgParent.push({
        type: "org_parent",
        agentId: tmplId,
        existingAgentId: ex.id,
        existingName: ex.name,
        currentParentId: ex.parentId,
        templateParentId: resolvedTemplateParent,
        detail: `map 到既有员工「${ex.name}」(${ex.id})时,模板声明的上级(${resolvedTemplateParent ?? "无"})与其现有上级(${ex.parentId ?? "无"})不同。请选择:保持原组织(keep-current-org)/ 调整组织(adopt-template-org)/ 拒绝导入(reject)。`,
      });
    }
  }

  const existingEdges = targetAgents.filter(a => a.parentId).map(a => ({ parent: a.parentId as string, child: a.id }));
  const incomingEdges = template.agents.filter(a => a.parentId).map(a => ({ parent: a.parentId as string, child: a.id }));
  for (const ie of incomingEdges) {
    if (existingEdges.some(ee => ee.parent === ie.parent && ee.child === ie.child)) {
      report.orgEdge.push({ type: "org_edge", kind: "duplicate", parentId: ie.parent, childId: ie.child, detail: "父子边与现有组织重复(幂等,可直接并入)" });
    }
  }
  // "按原始 id 直接合入"的成环预警——供 preview 展示;真正裁决在 resolveMerge 里用解析后的最终 id 再查一次。
  if (orgHasCycle([...targetAgents, ...template.agents])) {
    report.orgEdge.push({ type: "org_edge", kind: "would_cycle", parentId: "-", childId: "-", detail: "按原始 id 直接合入会导致组织成环(copy-as-new 会重写 id,通常可规避)" });
  }

  report.memoryScope.push(...detectMemoryScopeConflicts(opts.incomingMemory ?? [], opts.existingMemory ?? []));

  // 发现③修复:模板的 a2aChannels.from/to 既可以是模板内 agentId,也可以是 role 名(见 install.ts
  // resolveTemplateAgentRef 顶部注释),这里之前直接用原始字符串比对——role 名引用永远比不出冲突
  // (existingChannels 存的是真实 agent id,不会等于一个 role 名字符串),漏检。检测阶段还不知道最终
  // 落地会用哪个 id(那要等 agentId 冲突策略定下来),所以用"恒等 idMap"(模板 agentId → 自身)过一遍
  // resolveTemplateAgentRef,把 role 名换算成模板自己的 agentId 再比对——这正是 keep-current/overwrite
  // 策略下最终会落地的 id(copy-as-new 会改 id,届时天然不再冲突,预警提前一步给出也没有害处)。
  const identityIdMap: Record<string, string> = Object.fromEntries(template.agents.map(a => [a.id, a.id]));
  const existingChannels = targetCompany.presetChannels ?? [];
  for (const ic of (template.a2aChannels ?? [])) {
    const from = resolveTemplateAgentRef(template.agents, identityIdMap, ic.from);
    const to = resolveTemplateAgentRef(template.agents, identityIdMap, ic.to);
    if (!from || !to) continue; // 引用解析不出来(既不是模板内 agentId 也不是模板内 role)—— 与安装时同一口径,不当作冲突
    const match = existingChannels.find(ec => ec.from === from && ec.to === to);
    if (match) report.a2aRule.push({ type: "a2a_rule", from, to, existingPurpose: match.purpose, incomingPurpose: ic.purpose });
  }

  const existingCaps = targetCompany.manifestMcpRequirements ?? [];
  for (const ic of (template.mcpRequirements ?? [])) {
    const match = existingCaps.find(ec => ec.name.trim().toLowerCase() === ic.name.trim().toLowerCase());
    if (match && !!match.optional !== !!ic.optional) {
      report.capability.push({ type: "capability", name: ic.name, existingOptional: match.optional, incomingOptional: ic.optional });
    }
  }

  return report;
}

// ── 安装预览摘要(指南 11.8:安装预览应显示的内容)。C3 起经验计数按 template.seedMemories(D5 已
// 落地的真数据源)的 owner_type 真数统计——口径:project 级记忆是"公司范围的工程记忆",没有独立展示
// 档位,归入 company 计数(如实标注,不静默丢数);newDefaultTasks 按 template.defaultTasks(C3 新增
// 可选字段)真数。newArtifactContracts:模板结构至今没有 artifact contract 数据源,继续如实报 0,
// 不虚构(等 contract 真进模板形状再改)。 ──
export interface InstallPreviewSummary {
  newAgents: number;
  newOrgEdges: number;
  newA2AChannels: number;
  newCompanyExperiences: number;
  newTeamExperiences: number;
  newAgentExperiences: number;
  newDefaultTasks: number;
  newArtifactContracts: number;
  requiredCapabilities: string[];
}

export function buildInstallPreviewSummary(template: CompanyTemplate): InstallPreviewSummary {
  const memories = template.seedMemories ?? [];
  return {
    newAgents: template.agents.length,
    newOrgEdges: template.agents.filter(a => a.parentId).length,
    newA2AChannels: template.a2aChannels?.length ?? 0,
    newCompanyExperiences: memories.filter(r => r.owner_type === "company" || r.owner_type === "project").length,
    newTeamExperiences: memories.filter(r => r.owner_type === "team").length,
    newAgentExperiences: memories.filter(r => r.owner_type === "agent").length,
    newDefaultTasks: template.defaultTasks?.length ?? 0,
    newArtifactContracts: 0, // 无数据源,如实 0(见上方注释)
    requiredCapabilities: (template.mcpRequirements ?? []).map(m => m.name),
  };
}

function uniqueSuffixedId(oldId: string, taken: Set<string>): string {
  let n = 1;
  let candidate = `${oldId}-copy`;
  while (taken.has(candidate)) { n++; candidate = `${oldId}-copy${n}`; }
  taken.add(candidate);
  return candidate;
}

// 发现②(对抗验收缺口)修复:union/overwrite 会改写 existing 里已有边的 purpose,回滚需要知道"改写前
// 是什么样"才能恢复——额外返回 modifiedExisting(改写前的完整边,只含 purpose 真的变了的那些;新增的
// 通道不算改写,keep-current 不改写任何东西)。originalByKey 是 existing 的不可变快照,即使同一个 key
// 在 incoming 里出现多次(理论上模板不该有重复 from/to,但不假设),对照的始终是"这次合并开始前"的值,
// 不是循环中途已被上一次 incoming 项改过的中间态。
function mergeChannels(
  existing: A2AChannelSpec[], incoming: A2AChannelSpec[], mode: A2ARuleStrategy,
): { merged: A2AChannelSpec[]; modifiedExisting: A2AChannelSpec[] } {
  const key = (c: A2AChannelSpec) => `${c.from}=>${c.to}`;
  const originalByKey = new Map(existing.map(c => [key(c), c]));
  const map = new Map<string, A2AChannelSpec>();
  for (const c of existing) map.set(key(c), { ...c });
  const modifiedKeys = new Set<string>();
  for (const c of incoming) {
    const k = key(c);
    const cur = map.get(k);
    if (!cur) { map.set(k, { ...c }); continue; } // 新增通道(不是冲突,双方都保留,也不算"改写")
    if (mode === "keep-current") continue; // 冲突项保留 existing,丢弃 incoming
    let next: A2AChannelSpec;
    if (mode === "overwrite") next = { ...c }; // 冲突项用 incoming 覆盖
    // union(默认):purpose 不同则拼接(不丢信息),相同/缺省则取有值的一侧。
    else if (cur.purpose && c.purpose && cur.purpose !== c.purpose) next = { ...cur, purpose: `${cur.purpose}; ${c.purpose}` };
    else if (!cur.purpose && c.purpose) next = { ...cur, purpose: c.purpose };
    else next = cur;
    map.set(k, next);
    const orig = originalByKey.get(k);
    if (orig && orig.purpose !== next.purpose) modifiedKeys.add(k);
  }
  return { merged: [...map.values()], modifiedExisting: [...modifiedKeys].map(k => originalByKey.get(k)!) };
}

function mergeCapabilities(existing: McpRequirementSpec[], incoming: McpRequirementSpec[], mode: CapabilityStrategy): McpRequirementSpec[] {
  if (mode === "manual") return existing; // 不自动合并,保留目标现状(decisions 里标注需人工核对)
  const map = new Map<string, McpRequirementSpec>();
  for (const c of existing) map.set(c.name.trim().toLowerCase(), { ...c });
  for (const c of incoming) {
    const k = c.name.trim().toLowerCase();
    const cur = map.get(k);
    if (!cur) { map.set(k, { ...c }); continue; }
    // 能力声明是 requirements 列表,取并集即最严:只有两边都明确标 optional 才维持 optional,
    // 任一侧未标或标为必需,合并结果就是必需(更严格的那个胜出)。
    const optional = cur.optional === true && c.optional === true;
    map.set(k, { name: cur.name, purpose: cur.purpose || c.purpose, optional });
  }
  return [...map.values()];
}

// C9-P0 · map 到已有员工遇新父级的三选一处置(独立命名类型:两条 merge 路由与报告 helper 共用同一口径)。
export type OrgParentResolution = "keep-current-org" | "adopt-template-org" | "reject";

export interface ResolveMergeOpts {
  attachParentId?: string; // 模板内部根节点的挂载点;缺省用 targetCompany.ceoId(同团队安装的既有惯例)
  confirmOverwrite?: boolean; // agentId 策略为 overwrite 且确有冲突时,必须显式为 true,否则拒绝(高风险二次确认)
  // P1(用户序#5)· 语义团队重复(teamDuplication)的显式处置——**故意不进 sanitizeMergeStrategies、无默认值**:
  // 检出语义团队重复(同 role+name)却未显式选择时,resolveMerge 一律 409 拒绝执行,逼用户在"映射到现有员工 /
  // 覆盖现有员工 / 明确作为新部门新增"三者中选一,杜绝"静默复制整支团队(8→16)"。
  //   add-department = 按新部门新增(copy-as-new 重排新 id,与现有并存);
  //   map            = 映射到现有同名员工(跳过 incoming,不新增、不覆盖);
  //   overwrite      = 覆盖现有同名员工(incoming 落到现有 id 上)。
  teamDuplicationResolution?: "map" | "overwrite" | "add-department";
  // C9-P0 · map 到已有员工遇新父级的显式处置——**无默认值**:teamDuplicationResolution="map" 且检出
  // orgParent 冲突却未选时,resolveMerge 一律 409 拒绝执行,逼用户三选一。
  //   keep-current-org  = 保持既有员工现有上级不变(不静默采纳模板父;落一条 requires_review);
  //   adopt-template-org= 调整既有员工上级为模板声明的(解析后)父,双向同步新旧父 childrenIds,快照进 preMerge 供回滚;
  //   reject            = 拒绝本次导入(整体 409,不落地)。
  orgParentResolution?: OrgParentResolution;
}

export type ResolveMergeResult =
  | {
      ok: true;
      agents: AgentNodeConfig[]; // 待落地的节点全集(已 reroot 到目标公司,直接可用于 addAgents/updateAgent)
      overwriteAgentIds: string[]; // agents 中哪些 id 是"覆盖现有员工"——调用方需用 updateAgent(upsert)而非 addAgents(会被去重跳过)
      overwrittenAgents: AgentNodeConfig[]; // 发现②修复:overwriteAgentIds 对应的、覆盖前的完整既有员工对象(回滚快照用;没有覆盖则为空数组)
      presetChannels: A2AChannelSpec[]; // 合并后的目标公司 presetChannels 整份新值
      modifiedChannels: A2AChannelSpec[]; // 发现②修复:union/overwrite 真正改写了 purpose 的既有边,改写前的完整边(回滚快照用;没有改写则为空数组)
      mcpRequirements: McpRequirementSpec[]; // 合并后的目标公司 manifestMcpRequirements 整份新值
      decisions: MergeDecision[];
      conflicts: MergeConflictReport;
      // 收口②:模板 agentId → 最终落地 id 的完整映射(keep-current/manual 跳过的不在内)。
      // agentMemories 的"只导新建员工"策略必须靠它精确对人——copy-as-new 的后缀 id 无法从
      // agents 数组可靠反推回模板合成 id(`${role}-${i}`)。
      idMap: Record<string, string>;
      skippedAgentIds: string[]; // keep-current/manual 策略下未安装的模板 agentId(其记忆也不导,进 requires_review)
      // C9-P0 · adopt-template-org:被改挂上级的既有员工(map 目标)。调用方需对每个 rebinding 用 updateAgent
      // 落 parentId 变更并双向同步新旧父 childrenIds;preMerge 快照(rebindings 里的旧父 + 受影响父节点旧
      // childrenIds)供回滚。keep-current-org/无 orgParent 冲突 → 空数组。
      orgParentRebindings: OrgParentRebinding[];
    }
  | { ok: false; status: number; error: string; conflicts?: MergeConflictReport };

// C9-P0 · adopt-template-org 的组织改挂结果:既有员工 agentId 从 oldParentId 改挂到 newParentId。
// preMergeParents 是回滚所需的父节点 childrenIds 快照(旧父移除该子、新父新增该子,回滚整值恢复)。
export interface OrgParentRebinding {
  agentId: string;
  oldParentId?: string;
  newParentId?: string;
}

// C9-P2 修复(对抗验证 PLAUSIBLE)· adopt-template-org 改挂的**统一应用**(纯函数,两条 merge 路由共用 +
// 可单测)。给定目标公司【addAgents 之后】的全体 agents(既有 ∪ 本次新建 toAdd)与改挂清单,先把被改挂
// 员工的 parentId 改到新父,再以 parentId 为唯一真源 rebuildChildrenIds,产出受影响节点(被改挂员工 +
// 旧父 + 新父)的 {id,parentId,childrenIds} 补丁。
//   修复要点:rebuild 必须在 addAgents 之后、把**本次新建的父**一并纳入集合。旧实现在 addAgents 之前
//   对"仅既有员工"重建 —— 当模板声明的父是本次新建员工(不在既有集合里)时,新父的 childrenIds 收不到
//   被改挂的既有员工,形成"既有员工 parentId 指向新父、新父 childrenIds 却不含它"的父子双向失配。
export function planOrgParentRebindApply(
  companyAgentsAfterAdd: Array<{ id: string; parentId?: string; childrenIds?: string[] }>,
  rebindings: OrgParentRebinding[],
): Array<{ id: string; parentId?: string; childrenIds: string[] }> {
  if (!rebindings.length) return [];
  const affected = new Set<string>();
  for (const rb of rebindings) {
    affected.add(rb.agentId);
    if (rb.oldParentId) affected.add(rb.oldParentId);
    if (rb.newParentId) affected.add(rb.newParentId);
  }
  const rebindTo = new Map(rebindings.map((rb) => [rb.agentId, rb.newParentId]));
  const reparented = companyAgentsAfterAdd.map((a) => (rebindTo.has(a.id) ? { ...a, parentId: rebindTo.get(a.id) } : a));
  return rebuildChildrenIds(reparented)
    .filter((a) => affected.has(a.id))
    .map((a) => ({ id: a.id, parentId: a.parentId, childrenIds: a.childrenIds ?? [] }));
}

// ── 合并:按策略把 template 的员工/组织边/A2A 规则/能力要求并入 targetCompany。 ──
export function resolveMerge(
  template: CompanyTemplate,
  targetCompany: Company,
  existingAgents: AgentNodeConfig[],
  strategies: MergeStrategies = {},
  opts: ResolveMergeOpts = {},
): ResolveMergeResult {
  const s = { ...DEFAULT_MERGE_STRATEGIES, ...strategies };
  const conflicts = detectMergeConflicts(template, targetCompany, existingAgents);

  if (s.agentId === "overwrite" && conflicts.agentId.length > 0 && !opts.confirmOverwrite) {
    return { ok: false, status: 400, error: "agentId 策略为 overwrite 且存在冲突,需 body 显式传 confirmOverwrite:true 二次确认", conflicts };
  }
  // P1(用户序#5)· 语义团队重复检出却未显式选择处置 → **不执行**(收口"静默复制整支团队 8→16")。逼用户在
  // map/overwrite/add-department 三者中选一;未选一律 409。
  if (conflicts.teamDuplication.length > 0 && !opts.teamDuplicationResolution) {
    return { ok: false, status: 409, error: `检测到语义团队重复(${conflicts.teamDuplication.length} 名同 role+同 name 的员工),直接合并会**新增第二套团队**。请显式选择 teamDuplicationResolution:map(映射到现有员工)/ overwrite(覆盖现有员工)/ add-department(明确作为新部门新增);未选择不执行。`, conflicts };
  }
  // C9-P0 · orgParent 冲突只在 map 处置下真正落地(overwrite 保留既有员工挂载点、add-department 新建不动
  // 既有员工),故仅当 teamDuplicationResolution="map" 且检出 orgParent 冲突却未选 orgParentResolution → 409。
  if (opts.teamDuplicationResolution === "map" && conflicts.orgParent.length > 0 && !opts.orgParentResolution) {
    return { ok: false, status: 409, error: `map 到已有员工时检测到 ${conflicts.orgParent.length} 处新父级差异(模板声明的上级与既有员工现有上级不同)。请显式选择 orgParentResolution:keep-current-org(保持原组织)/ adopt-template-org(调整组织)/ reject(拒绝导入);未选择不执行。`, conflicts };
  }
  if (opts.teamDuplicationResolution === "map" && conflicts.orgParent.length > 0 && opts.orgParentResolution === "reject") {
    return { ok: false, status: 409, error: `已选择 reject:检出 ${conflicts.orgParent.length} 处新父级差异,拒绝本次 map 导入(未落地任何改动)。`, conflicts };
  }
  // incoming 语义身份(role+归一 name)→ 其命中的现有员工冲突条,供下方 id 规划按处置分流。
  const teamDupByKey = new Map(conflicts.teamDuplication.map((c) => [templateAgentKey({ role: c.role, name: c.incomingName }), c]));

  const conflictIds = new Set(conflicts.agentId.map(c => c.agentId));
  const existingById = new Map(existingAgents.map(a => [a.id, a]));
  // takenIds 除现有全体员工外还并入模板自身全部 agent id:copy-as-new 生成的 `${oldId}-copy` 后缀 id
  // 若恰与模板自带的另一个(无冲突、原样保留 id 的)agent 撞车,newAgents 会出现两个同 id 节点,
  // addAgents 按 id 去重会把后到的那个静默吞掉。
  const takenIds = new Set([...existingAgents.map(a => a.id), ...template.agents.map(a => a.id)]);
  const skippedIds = new Set<string>();
  const overwriteIds = new Set<string>();
  const downgradedIds = new Set<string>(); // overwrite 策略下跨公司同 id 被降级 copy-as-new 的那批
  const idMap: Record<string, string> = {};

  for (const a of template.agents) {
    // P1:语义团队重复(非 id 冲突,role+name 撞现有员工)按显式处置分流,优先于"无冲突原样保留"。
    const dup = !conflictIds.has(a.id) ? teamDupByKey.get(templateAgentKey(a)) : undefined;
    if (dup) {
      switch (opts.teamDuplicationResolution) {
        // P1(用户审计)· map:不装 incoming,但**必须**把 incoming id 映射到现有员工 id——否则子员工的父引用、
        // A2A 通道(resolveTemplateAgentRef 靠 idMap 解析 from/to)都会指向不存在的 incoming id 而被静默丢弃,
        // 破坏组织与协作语义。skippedIds 仍标记"不新建节点",idMap 让一切对 incoming 的引用解析到现有员工。
        case "map": idMap[a.id] = dup.existingAgentId; skippedIds.add(a.id); break;             // 映射到现有:不装 incoming,引用重定向到现有
        case "overwrite": idMap[a.id] = dup.existingAgentId; overwriteIds.add(dup.existingAgentId); break; // 覆盖现有:落到现有 id
        case "add-department": default: idMap[a.id] = uniqueSuffixedId(a.id, takenIds); break; // 新部门:重排新 id 并存(default 已被上方 409 挡,兜底)
      }
      continue;
    }
    if (!conflictIds.has(a.id)) { idMap[a.id] = a.id; continue; } // 无冲突:原样保留 id(合并语义,不像新公司模式那样全员加后缀)
    switch (s.agentId) {
      case "copy-as-new": idMap[a.id] = uniqueSuffixedId(a.id, takenIds); break;
      case "overwrite": {
        // 冲突检测按全局花名册比 id(addAgents 全局去重),但覆盖只对**目标公司内**的同 id 员工有意义:
        // 撞上其它公司的同 id 员工时如果照样覆盖,该员工会被整个改写 companyId 掳进目标公司,还留着指向
        // 原公司上级的 parentId——两家公司的组织树同时坏掉。跨公司同 id 一律降级 copy-as-new。
        const ex = existingById.get(a.id);
        if (ex && normalizeCompanyId(ex.companyId) === targetCompany.id) { idMap[a.id] = a.id; overwriteIds.add(a.id); }
        else { idMap[a.id] = uniqueSuffixedId(a.id, takenIds); downgradedIds.add(a.id); }
        break;
      }
      case "keep-current":
      case "manual": skippedIds.add(a.id); break; // 该员工不装,详见下方悬空引用处理
    }
  }

  const attachParentId = opts.attachParentId ?? targetCompany.ceoId;
  const templateIdSet = new Set(template.agents.map(a => a.id));
  const newAgents: AgentNodeConfig[] = [];
  for (const a of template.agents) {
    if (skippedIds.has(a.id)) continue;
    const rawParent = a.parentId;
    let parentId: string | undefined;
    if (!rawParent) parentId = attachParentId; // 模板内的根 → 挂到目标公司挂载点(同团队安装惯例)
    // P1(用户审计)· 父被跳过时要分流:map(有 idMap 映射)→ 挂到映射后的现有员工(保留组织从属);
    // keep-current/manual(无 idMap 映射,员工真被丢弃)→ 重新挂到挂载点,不留悬空引用。
    else if (skippedIds.has(rawParent)) parentId = idMap[rawParent] ?? attachParentId;
    else if (templateIdSet.has(rawParent)) parentId = idMap[rawParent]; // 父在模板子树内 → 按 idMap 改写
    else parentId = rawParent; // 理论上不会发生(模板 agents 的 parentId 通常都在模板自身内),兜底原样保留

    // P1(用户审计)· 子引用按 idMap 解析,包含 mapped 子(idMap 有映射即保留):map 的子映射到现有员工 id、
    // 正常安装的子映射到新 id;仅 keep-current/manual(无 idMap 映射,子真被丢弃)才从 childrenIds 剔除——
    // 否则新经理对 mapped 下属的组织边会被静默丢失(对抗验证抓出)。
    const childrenIds = (a.childrenIds || [])
      .filter(c => templateIdSet.has(c) && idMap[c] !== undefined)
      .map(c => idMap[c]);

    newAgents.push({
      ...a, id: idMap[a.id], companyId: targetCompany.id, parentId, childrenIds,
      status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
      currentTask: undefined, lastAction: undefined,
    });
  }

  // overwrite:保留现有员工在组织树里的位置(parentId/childrenIds 不因覆盖而改变挂载点),
  // 只有员工自身的其余字段(name/role/model/provider/...)换成模板声明的新值。
  // 发现②修复:覆盖前的完整既有对象(ex)先存进 overwrittenAgents——回滚要靠它整对象还原,
  // 不能只回滚 parentId/childrenIds 这两个字段。必须深拷贝:existingAgents 通常是 getAgents() 的
  // 活引用,路由层随后 updateAgent(Object.assign)会原地改写 ex,浅存引用会让"覆盖前快照"
  // 在落盘时已经变成覆盖后的值,回滚形同空转。
  const overwrittenAgents: AgentNodeConfig[] = [];
  for (const a of newAgents) {
    if (!overwriteIds.has(a.id)) continue;
    const ex = existingById.get(a.id);
    if (!ex) continue;
    overwrittenAgents.push(structuredClone(ex));
    a.parentId = ex.parentId;
    a.childrenIds = [...new Set([...(ex.childrenIds || []), ...a.childrenIds])];
  }

  const targetAgents = existingAgents.filter(a => normalizeCompanyId(a.companyId) === targetCompany.id);
  const nonOverwriteExisting = targetAgents.filter(a => !overwriteIds.has(a.id));

  // C9-P0 · adopt-template-org:把 map 目标的既有员工改挂到模板声明的(解析后)父。orgParent 冲突里
  // templateParentId 已解析到既有员工 id(或模板内 id);map 语义下模板父同样是既有员工,取该值即为落地新父。
  // rebinding 只在 map + adopt 下产生;keep-current-org 不动组织(仅落 requires_review,在路由层报告里)。
  const orgParentRebindings: OrgParentRebinding[] = [];
  if (opts.teamDuplicationResolution === "map" && opts.orgParentResolution === "adopt-template-org") {
    for (const c of conflicts.orgParent) {
      // P0(wave4-live-acceptance)· newParentId 必须经**同一 idMap** 重映射到落地后的真实 id:
      // templateParentId 若是"将新建的模板父"(检测阶段仍是原始模板 id),copy-as-new 遇全局 id 碰撞会把它
      // 重排成新 id——不重映射就会指向那个恰好同 id 的【外公司】既有 agent → 既有员工被改挂到外公司,持久
      // 跨公司污染。模板父是 map 候选时 templateParentId 已是既有员工 id(idMap 无此键 → 原样保留),两种都对。
      const resolvedNewParent = c.templateParentId !== undefined
        ? (idMap[c.templateParentId] ?? c.templateParentId)
        : undefined;
      orgParentRebindings.push({ agentId: c.existingAgentId, oldParentId: c.currentParentId, newParentId: resolvedNewParent });
    }
    // 纵深防御(任务3)· 改挂目标必须解析到【目标公司落地后】的真实 agent(本次新建 newAgents ∪ 目标公司
    // 既有员工)。解析不到 / 指向外公司 → 拒绝整体落地,绝不把既有员工改挂到不在目标公司的父下(配合上面
    // idMap 重映射后正常流不该触发,这是纵深防御)。
    const targetLandedIds = new Set<string>([...newAgents.map(a => a.id), ...targetAgents.map(a => a.id)]);
    for (const rb of orgParentRebindings) {
      if (rb.newParentId !== undefined && !targetLandedIds.has(rb.newParentId)) {
        return { ok: false, status: 422, error: `adopt-template-org 改挂目标「${rb.newParentId}」未解析到目标公司落地后的员工(指向其它公司或不存在),已拒绝整体合并`, conflicts };
      }
    }
  }
  // 成环检测把 adopt 改挂后的父一并纳入(改挂可能引入新环)。用改挂后的父建一份视图供 orgHasCycle。
  const rebindByAgent = new Map(orgParentRebindings.map(r => [r.agentId, r.newParentId]));
  const nonOverwriteForCycle = nonOverwriteExisting.map(a =>
    rebindByAgent.has(a.id) ? { ...a, parentId: rebindByAgent.get(a.id) } : a);
  if (orgHasCycle([...nonOverwriteForCycle, ...newAgents])) {
    return { ok: false, status: 422, error: "合并后组织成环,已拒绝合并", conflicts };
  }

  const incomingChannels = (template.a2aChannels ?? [])
    .map(c => ({ from: resolveTemplateAgentRef(template.agents, idMap, c.from), to: resolveTemplateAgentRef(template.agents, idMap, c.to), purpose: c.purpose }))
    .filter((c): c is { from: string; to: string; purpose: string | undefined } => !!c.from && !!c.to && c.from !== c.to);
  const { merged: presetChannels, modifiedExisting: modifiedChannels } = mergeChannels(targetCompany.presetChannels ?? [], incomingChannels, s.a2aRule);

  const mcpRequirements = mergeCapabilities(targetCompany.manifestMcpRequirements ?? [], template.mcpRequirements ?? [], s.capability);

  // decisions 里的 agent_id 策略如实标注:overwrite 撞上跨公司同 id 时实际执行的是 copy-as-new
  // 降级(见上方 case "overwrite"),不能对外仍宣称 overwrite——全部降级标 copy-as-new,部分降级
  // 标混合值,summary 带降级数。
  const agentIdEffectiveStrategy = s.agentId !== "overwrite" || downgradedIds.size === 0
    ? s.agentId
    : overwriteIds.size === 0 ? "copy-as-new" : "overwrite+copy-as-new";
  const decisions: MergeDecision[] = [
    { category: "agent_id", conflictCount: conflicts.agentId.length, strategy: agentIdEffectiveStrategy, summary: `${conflicts.agentId.length} 个 agent_id 冲突,策略 ${s.agentId}(跳过 ${skippedIds.size},覆盖 ${overwriteIds.size}${downgradedIds.size ? `,跨公司降级 copy-as-new ${downgradedIds.size}` : ""})` },
    { category: "org_edge", conflictCount: conflicts.orgEdge.length, strategy: s.orgEdge, summary: `${conflicts.orgEdge.length} 处组织边提示,策略 ${s.orgEdge}(合并后无环,已并入)` },
    { category: "memory_scope", conflictCount: conflicts.memoryScope.length, strategy: s.memoryScope, summary: `${conflicts.memoryScope.length} 条记忆 scope 冲突(V0 无记忆导出数据源,恒为 0)` },
    { category: "a2a_rule", conflictCount: conflicts.a2aRule.length, strategy: s.a2aRule, summary: `${conflicts.a2aRule.length} 条 A2A 规则冲突,策略 ${s.a2aRule},合并后共 ${presetChannels.length} 条通道` },
    { category: "capability", conflictCount: conflicts.capability.length, strategy: s.capability, summary: `${conflicts.capability.length} 条能力要求冲突,策略 ${s.capability},合并后共 ${mcpRequirements.length} 条要求` },
  ];
  // C9-P0 · orgParent 决策如实记账(仅 map 处置下有意义;overwrite/add-department 不涉及既有员工改挂)。
  if (opts.teamDuplicationResolution === "map" && conflicts.orgParent.length > 0) {
    const orgParentStrategy = opts.orgParentResolution ?? "keep-current-org";
    decisions.push({
      category: "org_parent", conflictCount: conflicts.orgParent.length, strategy: orgParentStrategy,
      summary: orgParentStrategy === "adopt-template-org"
        ? `${conflicts.orgParent.length} 处新父级差异,已调整组织(改挂 ${orgParentRebindings.length} 名既有员工上级)`
        : `${conflicts.orgParent.length} 处新父级差异,保持原组织(既有员工上级不变,进 requires_review)`,
    });
  }

  return { ok: true, agents: newAgents, overwriteAgentIds: [...overwriteIds], overwrittenAgents, presetChannels, modifiedChannels, mcpRequirements, decisions, conflicts, idMap, skippedAgentIds: [...skippedIds], orgParentRebindings };
}

// ══ 收口② · 公司级字段的保守合并(两条 merge 路径——companyRoutes /api/companies/import 与
// communityRoutes install/company——共用同一 helper,保证逐字段同口径)。硬口径(用户「收口决议」):
//   · defaultTasks:按规范化 goal 去重 union,目标公司已有项永远优先,来源只补目标没有的新项;
//   · manifestToolRequirements:五数组各自稳定 union——**只作能力声明/缺失诊断,绝不据此自动启用
//     任何 MCP/Provider/Shell/权限**(声明≠授权,新增声明进 requires_local_setup 由用户自行配置);
//   · visibilityPolicy:目标已有策略永远优先,仅目标未设置时采用来源——**禁止导入放宽既有信息隔离**;
//   · workflow:本轮不做公司级 workflow 的静默合并——目标已有 workflow 而来源也带时保留目标并进
//     requires_review(不静默丢弃也不覆盖);仅目标无 workflow 时直接采纳来源(无合并发生,非静默)。
// 产出三件套:updateCompany 的增量 patch(只含真要改的键,不带 undefined 键防误抹)、合并前四字段
// 整值快照(进 tx.preMerge.companyFields,回滚整值恢复)、四类清单报告(preserved/added/
// requires_review/requires_local_setup——任何未支持/未采纳的来源字段都进报告,不静默消失)。

export interface MergeFieldReportItem { field: string; detail: string }
export interface CompanyMergeReport {
  preserved: MergeFieldReportItem[];
  added: MergeFieldReportItem[];
  requires_review: MergeFieldReportItem[];
  requires_local_setup: MergeFieldReportItem[];
}

// tx.preMerge.companyFields 的形状(installTransactionStore 引用此类型)。**恒整值快照**:四个键在
// merge 时逐一显式赋值,undefined 代表目标合并前本无该字段,回滚经 updateCompany 浅 spread 把
// 显式 undefined 覆盖回"无"(与 preMerge.manifestMcpRequirements 既有语义完全同款)。
export interface PreMergeCompanyFields {
  visibilityPolicy?: Company["visibilityPolicy"];
  defaultTasks?: Company["defaultTasks"];
  manifestToolRequirements?: Company["manifestToolRequirements"];
  workflow?: Company["workflow"];
}

export interface CompanyFieldMergeOutcome {
  patch: Partial<Pick<Company, "visibilityPolicy" | "defaultTasks" | "manifestToolRequirements" | "workflow">>;
  preMergeCompanyFields: PreMergeCompanyFields;
  report: CompanyMergeReport;
}

const normGoal = (g: string | undefined): string => (g || "").trim();

// 五数组稳定 union:目标项按原顺序在前,来源只追加目标没有的(trim 比对,保留原字符串)。
function unionStringArrays(existing: string[] = [], incoming: string[] = []): { merged: string[]; added: string[] } {
  const seen = new Set(existing.map(s => s.trim()));
  const merged = [...existing];
  const added: string[] = [];
  for (const s of incoming) {
    const k = s.trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    merged.push(s);
    added.push(s);
  }
  return { merged, added };
}

export function mergeCompanyLevelFields(target: Company, template: CompanyTemplate): CompanyFieldMergeOutcome {
  const report: CompanyMergeReport = { preserved: [], added: [], requires_review: [], requires_local_setup: [] };
  const patch: CompanyFieldMergeOutcome["patch"] = {};
  // 收口④:四字段清单/策略的唯一真相源是 companyFieldRegistry 的 COMPANY_LEVEL_MERGE_FIELDS
  // (defaultTasks=union / manifestToolRequirements=union / visibilityPolicy=target-preferred /
  // workflow=requires-review)。快照按登记表的 companyKey 逐一取整值——下方四个合并代码块是各策略的
  // 实现体,行为不变;一致性守卫测试(companyFieldRegistry.guard.test.ts)断言两者永远对齐。
  const preMergeCompanyFields: PreMergeCompanyFields = {};
  for (const f of COMPANY_LEVEL_MERGE_FIELDS) {
    (preMergeCompanyFields as Record<string, unknown>)[f.companyKey] = target[f.companyKey as keyof Company];
  }

  // ── defaultTasks:按规范化 goal 去重 union,目标在前且权威(口径同 companyTemplate.mergeDefaultTasks
  // 的 trim+Set 先到先得,persisted 换成目标公司持久字段)。
  const targetTasks = target.defaultTasks ?? [];
  const incomingTasks = template.defaultTasks ?? [];
  if (incomingTasks.length) {
    const seen = new Set(targetTasks.map(t => normGoal(t.goal)).filter(Boolean));
    const fresh: NonNullable<Company["defaultTasks"]> = [];
    for (const t of incomingTasks) {
      const goal = normGoal(t.goal);
      if (!goal || seen.has(goal)) continue;
      seen.add(goal);
      fresh.push(t);
    }
    if (fresh.length) {
      patch.defaultTasks = [...targetTasks, ...fresh];
      report.added.push({ field: "defaultTasks", detail: `新增 ${fresh.length} 条示例任务(按 goal 去重;目标公司已有 ${targetTasks.length} 条全部保留在前)` });
    }
    const dup = incomingTasks.length - fresh.length;
    if (dup > 0) report.preserved.push({ field: "defaultTasks", detail: `${dup} 条来源示例任务与目标公司现有 goal 重复,保留目标版本` });
  }

  // ── manifestToolRequirements:五数组稳定 union。只声明、不启用:这里产出的 patch 仅写回公司
  // 清单字段,不触碰 mcpStore/providerStore/权限配置——新增的必需项进 requires_local_setup,
  // 由用户在本机自行配置/授权(与 install.ts「mcpRequirements 只声明不授权」同一红线)。
  const incomingReq = template.toolRequirements;
  if (incomingReq) {
    const cur = target.manifestToolRequirements;
    // 收口④:五数组子键清单引用登记表常量(companyFieldRegistry.TOOL_REQUIREMENT_KEYS),不再本地硬编码。
    const keys = TOOL_REQUIREMENT_KEYS;
    const merged = {} as NonNullable<Company["manifestToolRequirements"]>;
    const addedByKey: Partial<Record<(typeof keys)[number], string[]>> = {};
    let addedTotal = 0;
    for (const k of keys) {
      const { merged: m, added } = unionStringArrays(cur?.[k], incomingReq[k]);
      merged[k] = m;
      if (added.length) { addedByKey[k] = added; addedTotal += added.length; }
    }
    if (addedTotal > 0) {
      patch.manifestToolRequirements = merged;
      report.added.push({ field: "manifestToolRequirements", detail: `能力声明并集:新增 ${addedTotal} 项(仅声明/缺失诊断,不自动启用任何 MCP/Provider/Shell/权限)` });
      for (const k of keys) {
        if (k === "optionalTools") continue; // optional 项不构成"需本机配置才可用"的硬缺口
        const names = addedByKey[k];
        if (names?.length) {
          report.requires_local_setup.push({ field: `manifestToolRequirements.${k}`, detail: `新增能力声明 ${names.join("、")}:需在本机自行配置/授权后方可用,导入不会自动启用` });
        }
      }
    } else if (cur) {
      report.preserved.push({ field: "manifestToolRequirements", detail: "来源能力声明与目标公司现有清单完全重合,保持目标现状" });
    }
  }

  // ── visibilityPolicy:目标已有 → 永远保留(绝不因导入放宽既有信息隔离);仅目标未设置时采用来源。
  if (template.visibilityPolicy) {
    if (target.visibilityPolicy) {
      if (target.visibilityPolicy !== template.visibilityPolicy) {
        report.preserved.push({ field: "visibilityPolicy", detail: `目标公司策略「${target.visibilityPolicy}」保留,来源「${template.visibilityPolicy}」不采纳(导入不得放宽既有信息隔离)` });
      }
    } else {
      patch.visibilityPolicy = template.visibilityPolicy;
      report.added.push({ field: "visibilityPolicy", detail: `目标公司未设置,采用来源策略「${template.visibilityPolicy}」` });
    }
  }

  // ── workflow:不静默合并/覆盖/丢弃。目标已有 → 保留目标 + requires_review;目标无 → 直接采纳来源。
  if (template.workflow) {
    const edgeCount = template.workflow.verificationEdges?.length ?? 0;
    if (target.workflow) {
      report.requires_review.push({ field: "workflow", detail: `来源模板带 workflow(verificationEdges ${edgeCount} 条)而目标公司已有 workflow:保留目标,不静默合并/覆盖;需人工核对后手动合入` });
    } else {
      patch.workflow = template.workflow;
      report.added.push({ field: "workflow", detail: `目标公司无 workflow,采用来源(verificationEdges ${edgeCount} 条)` });
    }
  }

  // ── 收口④:未登记的模板顶层字段如实进 merge 报告(不静默丢)。CompanyTemplateSchema 已 .passthrough(),
  // 未来新增/未支持的顶层字段会原样留在模板对象上——本轮 merge 不采纳它们(登记表无属性声明,不知道
  // 该按什么策略合),但必须在 requires_review 里逐条列出,由用户人工核对;字段本身随模板 passthrough
  // 保留,lost 恒为 0。导入路由的控制键(mode/targetCompanyId 等)已在登记表侧排除,不误报。
  for (const k of listUnregisteredTemplateFields(template)) {
    report.requires_review.push({
      field: k,
      detail: `未登记顶层字段「${k}」:companyFieldRegistry 无该字段的属性声明,本次合并未采纳(字段已随模板 passthrough 保留,请人工核对后处理)`,
    });
  }

  return { patch, preMergeCompanyFields, report };
}

// ── agentMemories 的 merge 导入计划:只导"本次 merge 真正新建的员工"(idMap 有映射且不是 overwrite
// 覆盖的);映射到既有员工(overwrite)/被跳过(keep-current/manual)/映射不上的来源记忆一律不写盘
// (目标员工记忆保留,importAgentMemories 是整文件覆盖写,写了就是静默覆盖),逐条进 requires_review。
export interface MergeAgentMemoryPlan {
  importIdMap: Record<string, string>; // 模板 agent_id → 新落地 id,只含新建员工
  reviewItems: MergeFieldReportItem[];
}

export function planMergeAgentMemories(
  memories: CompanyTemplate["agentMemories"],
  merge: { idMap: Record<string, string>; overwriteAgentIds: string[]; skippedAgentIds: string[] },
): MergeAgentMemoryPlan {
  const plan: MergeAgentMemoryPlan = { importIdMap: {}, reviewItems: [] };
  if (!memories?.length) return plan;
  const overwrite = new Set(merge.overwriteAgentIds);
  const skipped = new Set(merge.skippedAgentIds);
  for (const m of memories) {
    const finalId = merge.idMap[m.agent_id];
    // C9-P0(最凶险的静默数据损毁):map 到已有员工时,模板 agent_id 同时进 skippedAgentIds(不新建节点)
    // 且 idMap[模板id]=既有员工 id。只判 `finalId && !overwrite` 会把这条误判为"新建员工"、把来源记忆写进
    // importIdMap → importAgentMemories 整文件覆盖既有员工的 agent-memory.md,把现有记忆静默清洗。契约铁律:
    // map 不得静默导入外部员工记忆,默认保留现有记忆。故凡模板 agent_id 在 skipped 集合(map/keep-current/
    // manual 三种都进 skipped),一律不导入,来源记忆进 requires_review。
    if (finalId && !overwrite.has(finalId) && !skipped.has(m.agent_id)) {
      plan.importIdMap[m.agent_id] = finalId;
      continue;
    }
    const reason = skipped.has(m.agent_id) && finalId
      ? `map 映射到既有员工「${finalId}」:保留目标员工记忆(默认不导入外部员工记忆),来源记忆进 requires_review`
      : finalId
        ? `映射到既有员工「${finalId}」(overwrite 覆盖):保留目标员工记忆,来源记忆未导入`
        : skipped.has(m.agent_id)
          ? "对应员工按 keep-current/manual 策略未安装:来源记忆未导入"
          : "agent_id 在本次合并映射中不存在:来源记忆未导入";
    plan.reviewItems.push({ field: "agentMemories", detail: `agent_id「${m.agent_id}」${m.role ? `(${m.role})` : ""}:${reason}` });
  }
  return plan;
}

// C9-P2 修复(对抗验证 CONFIRMED)· keep-current-org 的"进 requires_review"必须落**真条目**。
// resolveMerge 的 org_parent 决策 summary 对外声称保持原组织后"进 requires_review",但
// finalizeMergeReport 从不产出 orgParent 条目(只接 memoryReviewItems/missingMcp),承诺落空 ——
// 报告里既无 preserved 也无 requires_review 提及该组织差异,用户以为已进复核队列,实际无处可查。
// 此 helper 把每条未采纳模板父的 keep-current-org 冲突转成一条 requires_review 条目,由两条 merge
// 路由并入报告,兑现承诺。仅 keep-current-org 有意义:adopt 真改了组织(不需复核提示,已在
// decisions 记账);reject 已 409 不落地(根本到不了报告装配)。
// 且仅 teamDuplicationResolution===map 有意义:orgParent 改挂/409/决策记账全部门控在 map 处置下
// (overwrite/add-department 不映射既有员工,组织根本没被触碰,落条目会误导用户以为发生过改挂决策)。
export function buildKeepCurrentOrgReviewItems(
  orgParentConflicts: OrgParentConflict[],
  resolution: OrgParentResolution | undefined,
  teamDuplicationResolution?: string,
): MergeFieldReportItem[] {
  if (teamDuplicationResolution !== "map") return [];
  if (resolution !== "keep-current-org") return [];
  return orgParentConflicts.map((c) => ({
    field: "orgParent",
    detail: `保持原组织(keep-current-org):既有员工「${c.existingName}」(${c.existingAgentId})的上级维持为「${c.currentParentId ?? "无"}」,未采纳模板声明的上级「${c.templateParentId ?? "无"}」——组织差异需人工复核后手动调整(本次合并有意不动既有组织)。`,
  }));
}

// ── 四类清单终装配(两条 merge 路径各自调用,参数与拼装顺序完全一致=同口径):
// 公司级字段报告 + agentMemories review + missingMcp(本机未配置的 MCP 声明,天然 requires_local_setup)
// + 真正写盘的员工记忆条数(added)。
export function finalizeMergeReport(
  base: CompanyMergeReport,
  extras: {
    memoryReviewItems: MergeFieldReportItem[];
    missingMcp: Array<{ name: string; purpose?: string; optional?: boolean }>;
    agentMemoriesImported: number;
    // 令四.4:agent 个人记忆写回的逐条失败(idMap 查无 / 空正文 / 写盘异常)——并入 requires_review,不静默。
    agentMemoryFailures?: Array<{ agent_id: string; role?: string; reason: string }>;
    // C9-P2:keep-current-org 未采纳模板父的组织差异条目(见 buildKeepCurrentOrgReviewItems),并入
    // requires_review 兑现"进 requires_review"承诺。缺省空数组,不影响既有调用口径。
    orgParentReviewItems?: MergeFieldReportItem[];
  },
): CompanyMergeReport {
  return {
    preserved: base.preserved,
    added: [
      ...base.added,
      ...(extras.agentMemoriesImported > 0
        ? [{ field: "agentMemories", detail: `导入 ${extras.agentMemoriesImported} 份新建员工的个人记忆(仅本次新落地员工;既有员工记忆一律保留)` }]
        : []),
    ],
    requires_review: [
      ...base.requires_review,
      ...extras.memoryReviewItems,
      ...(extras.orgParentReviewItems ?? []),
      ...(extras.agentMemoryFailures ?? []).map((f) => ({
        field: "agentMemories",
        detail: `agent_id「${f.agent_id}」${f.role ? `(${f.role})` : ""} 个人记忆未写回:${f.reason}`,
      })),
    ],
    requires_local_setup: [
      ...base.requires_local_setup,
      ...extras.missingMcp.map(m => ({
        field: "mcpServers",
        detail: `MCP「${m.name}」本机未配置${m.optional ? "(optional)" : ""}${m.purpose ? `:${m.purpose}` : ""}——导入只声明,需手动配置后启用`,
      })),
    ],
  };
}
