import { z } from "zod";
import {
  AgentNodeConfigSchema, BundleMemoryRecordSchema, MemoryLevelSchema, RequiredSecretSpecSchema,
  WorkflowConfigSchema, BundledSkillSchema, McpRequirementSchema, A2AChannelSpecSchema, VisibilityPolicySchema,
} from "./schemas.js";
import type { AgentNodeConfig, CompanyTemplate } from "./types.js";

// D5 · 记忆记录 schema 本体定义在 schemas.ts(理由见该文件的注释:避免与本文件已有的
// "companyBundle.schema.ts → schemas.ts" 依赖方向反向成环);这里原样重新导出,
// 让 companyBundle.schema 仍是"Company Bundle 相关 schema"的统一对外入口。
export { BundleMemoryRecordSchema, MemoryLevelSchema, RequiredSecretSpecSchema };
export type BundleMemoryRecord = z.infer<typeof BundleMemoryRecordSchema>;
export type MemoryLevel = z.infer<typeof MemoryLevelSchema>;
export type RequiredSecretSpec = z.infer<typeof RequiredSecretSpecSchema>;

// D2(V0 必需)· Company Bundle schema(指南 11.4)。
// V0 范围收窄:顶层结构按 11.4 的骨架(schema_version/bundle_type/title/description/metadata/
// company/org/privacy/compatibility),但 agents 直接复用现有 CompanyTemplate.agents 的
// AgentNodeConfig[] 形状,不重造 11.5 的富员工结构(prompt/experience/memory_refs 等)——那些
// 属于 D4(导出补全)/D5(记忆导出)的范围。org 目前只是轻量占位(可选),核心载荷仍是顶层 agents。

export const CompanyBundleMetadataSchema = z.object({
  version: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  license: z.string().optional(),
  tags: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  exported_from_app_version: z.string().optional(),
});

export const CompanyBundleCompanyInfoSchema = z.object({
  company_id: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  type: z.string().optional(),
  default_language: z.string().optional(),
});

// C2 · org.teams/edges 从 z.unknown() 占位收紧成真 schema(V0 至今无任何生产者写过这两字段,
// grep + 金样本核实:仅金样本带空数组,空数组两种类型都满足 → 收紧零破坏;字段保持 optional,
// 旧 bundle 缺省照常合法,按兼容宪法免 bump schema_version)。
// teams/edges 是 agents 的**派生投影**(deriveOrgTeamsAndEdges),不是第二事实源:导入侧不从 org
// 回桥任何结构(bundleToTemplateShape 以顶层 agents 为源),templateDoctor 对带 org 的 bundle 做
// 派生一致性交叉核对(warning 级,防手改 bundle 说谎)。
export const BundleTeamSchema = z.object({
  team_id: z.string().min(1),
  name: z.string().optional(),
  lead_agent_id: z.string().min(1),
  member_agent_ids: z.array(z.string()),
});
export type BundleTeam = z.infer<typeof BundleTeamSchema>;

export const BundleEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: z.enum(["org", "a2a", "verification"]),
  purpose: z.string().optional(),
});
export type BundleEdge = z.infer<typeof BundleEdgeSchema>;

export const CompanyBundleOrgSchema = z.object({
  agents: z.array(AgentNodeConfigSchema).optional(),
  teams: z.array(BundleTeamSchema).optional(),
  edges: z.array(BundleEdgeSchema).optional(),
});

// C2 · 从 agents(+可选 a2aChannels/workflow)派生 org.teams/edges 投影。纯函数、无 fs:
//   · teams:每个 role==="lead" 的节点成一队,成员 = 其 parentId 子树全部后代(含嵌套 lead 的
//     后代——嵌套 lead 场景同一成员会出现在多个队里,如实反映汇报链);team_id 取 `team-{leadId}`
//     (确定性,同一输入永远同一产物,round-trip 可比对)。
//   · edges:org 边 = parentId 汇报链(from=上级,to=下级;悬空 parentId 不出边);a2a 边 =
//     a2aChannels 原样(from/to 按模板惯例是 role 名或 agent id,不换算);verification 边 =
//     workflow.verificationEdges(producer→verifier,purpose 落 method 供人读)。
//   · 汇报链成环时按 visited 集合截断,不死循环(环本身由 templateDoctor no_cycle_in_org 拦)。
export function deriveOrgTeamsAndEdges(
  agents: Array<Pick<AgentNodeConfig, "id" | "name" | "role" | "parentId">>,
  a2aChannels?: Array<{ from: string; to: string; direction?: string; purpose?: string; authPolicy?: string; enabled?: boolean }>,
  workflow?: { verificationEdges?: Array<{ producer: string; verifier: string; method: string }> },
): { teams: BundleTeam[]; edges: BundleEdge[] } {
  const ids = new Set(agents.map((a) => a.id));
  const childrenOf = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.parentId || !ids.has(a.parentId) || a.parentId === a.id) continue;
    const list = childrenOf.get(a.parentId);
    if (list) list.push(a.id);
    else childrenOf.set(a.parentId, [a.id]);
  }

  const teams: BundleTeam[] = [];
  for (const lead of agents) {
    if (lead.role !== "lead") continue;
    const members: string[] = [];
    const seen = new Set<string>([lead.id]);
    const queue = [...(childrenOf.get(lead.id) ?? [])];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      members.push(id);
      queue.push(...(childrenOf.get(id) ?? []));
    }
    teams.push({ team_id: `team-${lead.id}`, name: lead.name, lead_agent_id: lead.id, member_agent_ids: members });
  }

  const edges: BundleEdge[] = [];
  for (const a of agents) {
    if (a.parentId && ids.has(a.parentId) && a.parentId !== a.id) edges.push({ from: a.parentId, to: a.id, type: "org" });
  }
  for (const c of a2aChannels ?? []) {
    edges.push({ from: c.from, to: c.to, type: "a2a", ...(c.purpose ? { purpose: c.purpose } : {}) });
  }
  for (const e of workflow?.verificationEdges ?? []) {
    edges.push({ from: e.producer, to: e.verifier, type: "verification", purpose: e.method });
  }
  return { teams, edges };
}

export const CompanyBundlePrivacySchema = z.object({
  redacted: z.boolean(),
  redacted_fields: z.array(z.string()),
  // D4:从"只声明名字"的 string[] 升级成带说明的对象数组(指南 11.7 示例形状)。安全:此前只有
  // companyToTemplate 的空数组 [] 生产过这个字段(D5 之前从未填过值),空数组两种类型都满足,
  // 不存在需要迁移的历史数据。
  required_secrets: z.array(RequiredSecretSpecSchema),
});

export const CompanyBundleCompatibilitySchema = z.object({
  min_app_version: z.string().optional(),
  migration_notes: z.array(z.string()),
});

// D5 · memory.records 容器(指南 11.6)。可选字段——旧 bundle(D5 之前导出的、或 migrateLegacyTemplate
// 迁移壳产出的)没有这个字段,安装/校验管线必须把它当"没有记忆可导入"处理,不是 schema 错误。
export const CompanyBundleMemorySchema = z.object({
  records: z.array(BundleMemoryRecordSchema).default([]),
});

// ── 导出档位(自己备份/迁移 vs 社区分享)──────────────────────────────────────────
// 用户拍板:自己导出自己导入=全量保真;社区陌生模板=默认降权+知情勾选保留。这两档由 bundle 顶层的
// export_profile 声明,导出侧(sanitizeBundleForExport)与导入侧(路由 unsafeAcknowledged 判定)据此
// 分道:
//   · "full":自己的完整备份/迁移包——保留 genericCli(命令原样)、危险权限声明、a2aChannels/
//     mcpRequirements、growth/记忆;本机绝对路径 workspaceDir/cliConfigDir 只占位成相对标记(导入时
//     提示重映射,不删除);只剥离密钥形态。导出物明确标注"含本机命令与权限,仅供自己使用,勿分享"。
//   · "share"(缺省):社区分享包——维持现状(全脱敏 + 导入侧 Safe Install 默认剥离高危授权)。
// 用户拍板补充:记忆(memory.records/agentMemories)与成长(agents[].growth)**两档都默认带走**
// (share 也带,让模板自带经验)——档位差异只在权限/本机命令与脱敏强度,权限降权≠记忆不带。
export const EXPORT_PROFILES = ["full", "share"] as const;
export type ExportProfile = (typeof EXPORT_PROFILES)[number];
export const DEFAULT_EXPORT_PROFILE: ExportProfile = "share";
// 白名单校验:不认识的值一律回退默认("share",偏安全的一档),不让一条坏字符串静默把包升级成
// 保真 full 档(同 sanitizeMemoryImportMode 的既有惯例)。
export function sanitizeExportProfile(input: unknown): ExportProfile {
  return typeof input === "string" && (EXPORT_PROFILES as readonly string[]).includes(input)
    ? (input as ExportProfile)
    : DEFAULT_EXPORT_PROFILE;
}
// full 档:本机绝对路径字段(workspaceDir/cliConfigDir)不删除、只占位成这两个相对标记——既不外泄
// 作者机器的盘符/家目录路径,又给导入侧一个"该字段需要在新机重映射"的显式信号。
export const WORKSPACE_DIR_PLACEHOLDER = "$OPC_REMAP_WORKSPACE$";
export const CLI_CONFIG_DIR_PLACEHOLDER = "$OPC_REMAP_CLI_CONFIG$";

// 员工 agent-memory.md(个人持久记忆)——它不是 AgentNodeConfig 的字段(存于
// .opc/knowledge/agents/<id>-memory.md),此前导出完全不带,是"真丢"的一项。按 agent 采集进这个
// 可加性字段(agent_id 用导出侧 reroot 后的稳定合成 id,导入侧按 idMap 回写)。记忆两档都带
// (share 正文经全脱敏,full 只剥密钥),受公司 memoryExportEnabled 开关把关;旧 bundle 无此字段。
export const BundleAgentMemorySchema = z.object({
  agent_id: z.string(),
  role: z.string().optional(),
  content: z.string(),
});
export type BundleAgentMemory = z.infer<typeof BundleAgentMemorySchema>;

export const CompanyBundleSchema = z.object({
  // schema_version 严格化(数据兼容宪法):不再接受任意非空串,只认 BUNDLE_SCHEMA_VERSION_HISTORY
  // 里的 canonical 已知版本。未知/更新版本的信封在此被拒 —— 交给 migrateBundleViaRegistry 出人话拒绝;
  // legacy(无 schema_version)与历史 "0.3.0-legacy" 标签走注册表归一到 canonical,永不作为产物版本出现。
  schema_version: z.string().min(1).refine(
    (v) => BUNDLE_SCHEMA_VERSION_HISTORY.includes(v),
    (v) => ({ message: `schema_version「${v}」不在受支持版本集合内(受支持:${BUNDLE_SCHEMA_VERSION_HISTORY.join("、")})` }),
  ),
  bundle_type: z.enum(["company", "agent"]),
  bundle_id: z.string().optional(), // 供导出文件命名 <bundle_id>.opc.bundle.json(D4 UI 接线)
  title: z.string().min(1),
  description: z.string().optional().default(""),
  metadata: CompanyBundleMetadataSchema.optional(),
  company: CompanyBundleCompanyInfoSchema.optional(),
  org: CompanyBundleOrgSchema.optional(),
  agents: z.array(AgentNodeConfigSchema),
  // P0-3 · canonical 导出 round-trip:导出侧(companyToBundle/templateToBundle)携带的完整结构字段,
  // 使"导出 Company Bundle → 重新导入"不丢 workflow/预置通道/打包技能/工具需求等(与旧 flat 模板导出
  // 等价保真)。全部可选:旧 bundle(D5 之前导出、migrateLegacyTemplate 迁移壳、V0 companyToBundle 产出的)
  // 没有这些字段,照常合法;bundleToTemplateShape 原样桥接回扁平 CompanyTemplate 形状。
  readme: z.string().optional(),
  useCases: z.array(z.string()).optional(),
  riskNotes: z.array(z.string()).optional(),
  toolRequirements: z.object({
    requiredEngines: z.array(z.string()),
    requiredProviders: z.array(z.string()),
    requiredMcpServers: z.array(z.string()),
    requiredSkills: z.array(z.string()),
    optionalTools: z.array(z.string()),
  }).optional(),
  // P0-B⑤ · 语义澄清:recommendedConfig 是**建议配置(advisory),导入不自动生效**。它是导出侧对
  // 当前项目运行配置(全局 ProjectConfig,非按公司隔离)的一份快照,供接收方参考;导入管线
  // (bundleToTemplateShape→installCompanyTemplate)不会用它覆盖接收方的全局运行配置。字段名 recommended
  // 已表意为"建议",此处再明确:不要把它当"会生效的公司配置"读——它保真往返只代表"作者当时的运行环境",
  // 不代表导入后会被应用。若接收方要采纳,需在设置页手动落到自己的 ProjectConfig。
  recommendedConfig: z.object({
    defaultModel: z.string().max(256).optional(),
    budget: z.object({ totalUsd: z.number(), maxTokensPerTask: z.number(), maxAttemptsPerTask: z.number().optional(), taskTimeoutMs: z.number().optional(), maxTokensPerRun: z.number().optional(), maxTokensTotal: z.number().optional() }).optional(),
    maxTokensPerTask: z.number().int().positive().optional(),
    permissions: z.object({ allowShell: z.boolean(), allowFileWrite: z.boolean(), allowWebAccess: z.boolean() }).optional(),
  }).optional(),
  // P0-B① · 公司级消息可见性/信息隔离策略(调度语义,非本机路径/密钥)。可选、加性——旧 bundle 无此
  // 字段照常合法(免 bump);full/share 两档都保真(可移植执行语义,无隐私风险)。导入侧 bundleToTemplateShape
  // 桥回扁平 CompanyTemplate → installCompanyTemplate 落回 Company.visibilityPolicy。
  visibilityPolicy: VisibilityPolicySchema.optional(),
  workflow: WorkflowConfigSchema.optional(),
  bundledSkills: z.array(BundledSkillSchema).optional(),
  mcpRequirements: z.array(McpRequirementSchema).optional(),
  a2aChannels: z.array(A2AChannelSpecSchema).optional(),
  // C3 · 示例任务(与 CompanyTemplateSchema.defaultTasks 同形状)。可选、加性,免 bump(兼容宪法先例)。
  defaultTasks: z.array(z.object({ title: z.string().min(1), goal: z.string().min(1), suggestedRole: z.string().optional() })).optional(),
  memory: CompanyBundleMemorySchema.optional(),
  // 导出档位(full=自己备份 / share=社区分享)。可选、可加性字段——旧 bundle(无此字段)按缺省 "share"
  // 语义处理,不改变既有导入行为;因此**无需 bump** schema_version(数据兼容宪法只要求"新字段可选、
  // 缺省行为不变"即可免 bump,同 memory/readme 等既有可选字段的先例)。
  export_profile: z.enum(EXPORT_PROFILES).optional(),
  // 员工个人记忆(agent-memory.md)——可选可加性,两档都带(share 正文经全脱敏);旧 bundle 无此字段。
  agentMemories: z.array(BundleAgentMemorySchema).optional(),
  privacy: CompanyBundlePrivacySchema,
  compatibility: CompanyBundleCompatibilitySchema,
// 收口④(对抗审查):.passthrough() 保留信封层**未知顶层键**——与 CompanyTemplateSchema.passthrough() 对称,
// 闭合 bundle 格式导入路径上"未来/未登记顶层字段被 parse 静默 strip"的缺口(硬约束 lost=0 也覆盖 .opcx 信封空间)。
// 已声明字段仍按 schema 校验、schema_version refine 不放松;passthrough 只放行未声明的额外键。
}).passthrough();

export type CompanyBundle = z.infer<typeof CompanyBundleSchema>;

export interface ParseCompanyBundleResult {
  ok: boolean;
  bundle?: CompanyBundle;
  errors?: string[];
}

/** 容错解析:成功回 {ok:true, bundle},失败回 {ok:false, errors}(不抛异常,供导入路径先探路)。 */
export function parseCompanyBundle(json: unknown): ParseCompanyBundleResult {
  const parsed = CompanyBundleSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`),
    };
  }
  return { ok: true, bundle: parsed.data };
}

export interface MigrateLegacyResult {
  bundle: CompanyBundle;
}

// 迁移兼容层:社区仓库已发布的全部旧模板(CompanyTemplate)都没有 schema_version,导入不能因此
// 失败(硬验收)。产出一份**干净**的 CompanyBundle(显式字段映射,不做"整个原对象 spread 进
// 同一个对象"的壳)——原因:CompanyTemplate 早已有一个同名但语义不同的 compatibility 字段(可选
// 兼容性说明字符串,见 packages/shared/src/schemas.ts),与本 schema 的 compatibility(对象:
// {migration_notes}) 类型冲突,没法用同一个对象同时满足两边校验。所以:
//   · 这里返回的 bundle 只用于"确认可迁移 + 供 D3/D4 及审计使用"的 CompanyBundle 视图;
//   · 实际喂给既有 templateDoctor/CompanyTemplateSchema/安装管线的,communityRoutes.ts 里继续用
//     legacy 原始对象本身(它已经是 CompanyTemplateSchema 认识的扁平形状,不需要也不应该被
//     再桥接一次——bundleToTemplateShape 那种最小字段映射会丢 hash/workflow/a2aChannels/
//     recommendedConfig 等既有导入路径依赖的字段)。
export function migrateLegacyTemplate(raw: unknown): MigrateLegacyResult {
  const obj: Record<string, unknown> = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rawAgents = Array.isArray(obj.agents) ? (obj.agents as AgentNodeConfig[]) : [];
  const bundleType: "company" | "agent" = rawAgents.length > 0 ? "company" : "agent";
  const bundle: CompanyBundle = {
    // legacy 归一:产物落 canonical 当前版本;"自动迁移自 legacy" 的痕迹进 migration_notes(见下)。
    schema_version: CURRENT_BUNDLE_SCHEMA_VERSION,
    bundle_type: bundleType,
    bundle_id: typeof obj.id === "string" ? obj.id : undefined,
    title: typeof obj.title === "string" && obj.title.trim() ? obj.title : "未命名模板",
    description: typeof obj.description === "string" ? obj.description : "",
    metadata: {
      version: typeof obj.version === "string" ? obj.version : undefined,
      created_at: typeof obj.createdAt === "string" ? obj.createdAt : undefined,
      license: typeof obj.license === "string" ? obj.license : undefined,
      tags: Array.isArray(obj.tags) ? (obj.tags as string[]) : undefined,
    },
    company: { name: typeof obj.author === "string" ? obj.author : undefined },
    agents: rawAgents,
    privacy: { redacted: true, redacted_fields: [], required_secrets: [] },
    compatibility: { migration_notes: [LEGACY_MIGRATION_NOTE] },
  };
  return { bundle };
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundle 迁移注册表(版本号 → 迁移函数)。
//
// 兼容宪法:社区仓库已发布的旧模板全都没有 schema_version,导入永远不能因此失败;将来 schema
// 形状演进(bump CURRENT_BUNDLE_SCHEMA_VERSION)时,旧版本 bundle 也必须能逐级升级到当前形状。
// 这个注册表把「某来源版本 → 下一档」的升级函数逐格登记;导入兜底(communityRoutes 的
// templates/import,parseCompanyBundle 失败后)顺着它一路迁移,直到产物能被 CompanyBundleSchema 接受。
//
// 守卫(见 apps/server/src/runtime/companyBundle.schema.test.ts):bump 版本却不登记对应迁移条目 →
// CI 红;金样本(__fixtures__/company-bundle-golden-v1.json)任何时候都必须可被 parseCompanyBundle 接受。
// ─────────────────────────────────────────────────────────────────────────────

// 当前 canonical CompanyBundle 版本。改这个值 = schema 形状演进,必须配套在 bundleMigrations 里
// 登记 <旧版本> → <新版本> 的迁移条目(守卫测试强制)。
export const CURRENT_BUNDLE_SCHEMA_VERSION = "0.3.0";

// 历史版本序列(最后一格必须等于 CURRENT_BUNDLE_SCHEMA_VERSION)。守卫测试要求相邻两档之间都能在
// bundleMigrations 找到以「前一档」为 key 的迁移条目——bump 版本时若忘了加迁移,这里就会 CI 红。
export const BUNDLE_SCHEMA_VERSION_HISTORY: readonly string[] = ["0.3.0"];

// 无 schema_version 的输入(bundle 信封出现之前发布的全部社区模板)用这个哨兵 key 迁移。
export const LEGACY_BUNDLE_VERSION = "legacy";

// 历史包袱:更早版本的 migrateLegacyTemplate 曾把迁移产物打成 "0.3.0-legacy" 标签。schema 严格化后
// 该标签不再被 CompanyBundleSchema 接受、也永不作为新产物出现;它只作为注册表内部 key 存在,把这类
// 历史 bundle 归一到 canonical 当前版本(见 bundleMigrations / normalizeLegacyTaggedBundle)。
export const LEGACY_BUNDLE_SCHEMA_TAG = "0.3.0-legacy";

// legacy 迁移痕迹落在 compatibility.migration_notes 的固定文案(兼容宪法要求保留"自动迁移自 legacy"记录)。
export const LEGACY_MIGRATION_NOTE = "自动迁移自 legacy template(无 schema_version)";

export type BundleMigrationFn = (raw: unknown) => CompanyBundle;

// 归一:一份被旧版本打上 "0.3.0-legacy" 标签的 bundle → 只改 schema_version 到 canonical 当前版本,
// 其余字段原样保留;并保证 compatibility.migration_notes 里留有 legacy 迁移痕迹(已有则不重复追加)。
function normalizeLegacyTaggedBundle(raw: unknown): CompanyBundle {
  const obj: Record<string, unknown> = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  const compat: Record<string, unknown> =
    obj.compatibility && typeof obj.compatibility === "object" ? { ...(obj.compatibility as Record<string, unknown>) } : {};
  const notes = Array.isArray(compat.migration_notes) ? [...(compat.migration_notes as unknown[])] : [];
  if (!notes.some((n) => typeof n === "string" && n.includes("legacy"))) notes.push(LEGACY_MIGRATION_NOTE);
  compat.migration_notes = notes;
  obj.compatibility = compat;
  obj.schema_version = CURRENT_BUNDLE_SCHEMA_VERSION;
  return obj as unknown as CompanyBundle;
}

// 注册表(来源版本 → 迁移函数)。
//   · legacy(无 schema_version 的扁平 CompanyTemplate)→ 当前 CompanyBundle 形状;
//   · "0.3.0-legacy"(历史标签)→ 归一到 canonical 当前版本(schema 严格化后必须经此归一,标签不入产物)。
export const bundleMigrations: Record<string, BundleMigrationFn> = {
  [LEGACY_BUNDLE_VERSION]: (raw) => migrateLegacyTemplate(raw).bundle,
  [LEGACY_BUNDLE_SCHEMA_TAG]: (raw) => normalizeLegacyTaggedBundle(raw),
};

export interface MigrateBundleResult {
  ok: boolean;
  bundle?: CompanyBundle;
  appliedMigrations: string[];
  errors?: string[];
}

// 读取输入的来源版本:有非空 schema_version 就用它,否则回退 legacy 哨兵。
export function detectBundleVersion(raw: unknown): string {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const v = obj.schema_version;
  return typeof v === "string" && v.trim() ? v : LEGACY_BUNDLE_VERSION;
}

// 查注册表逐级迁移:反复(校验通过即停;否则按来源版本取迁移函数升一档),直到产物被
// CompanyBundleSchema 接受,或无迁移可用/超步数为止。步数上限 = 注册表条目数 + 1,保证任何迁移链
// 都收敛,且不会因错误的循环登记而死循环。
export function migrateBundleViaRegistry(raw: unknown): MigrateBundleResult {
  const appliedMigrations: string[] = [];
  let current: unknown = raw;
  const maxSteps = Object.keys(bundleMigrations).length + 1;
  for (let step = 0; step <= maxSteps; step++) {
    const parsed = CompanyBundleSchema.safeParse(current);
    if (parsed.success) return { ok: true, bundle: parsed.data, appliedMigrations };
    const version = detectBundleVersion(current);
    const migrate = bundleMigrations[version];
    if (!migrate) {
      // 版本本身是 canonical 已知版本(如当前 0.3.0)、只是结构没过校验 → 如实回结构错误(不是"未知版本")。
      if (BUNDLE_SCHEMA_VERSION_HISTORY.includes(version)) {
        return {
          ok: false,
          appliedMigrations,
          errors: parsed.error.issues.map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`),
        };
      }
      // 版本既非 canonical 已知版本、注册表也查无此版的迁移 → 人话拒绝(多半来自更新版本的产品)。
      return {
        ok: false,
        appliedMigrations,
        errors: [`该 bundle 声称版本「${version}」,本产品不认识;可能来自更新版本的产品(本产品支持的版本:${BUNDLE_SCHEMA_VERSION_HISTORY.join("、")})`],
      };
    }
    try {
      // A failed migration must not mutate the caller's source object before
      // the registry can report the failure.
      const migrationInput =
        current && typeof current === "object"
          ? JSON.parse(JSON.stringify(current))
          : current;
      current = migrate(migrationInput);
      appliedMigrations.push(version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        appliedMigrations,
        errors: [`bundle migration ${version} failed: ${message}`],
      };
    }
  }
  return { ok: false, appliedMigrations, errors: ["迁移步数超限(可能存在循环迁移登记)"] };
}

function slugifyBundleId(input: string): string {
  const slug = input.trim().toLowerCase().replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return (slug || "bundle").slice(0, 64);
}

// 把一份"原生"(带 schema_version,非 legacy 迁移壳)CompanyBundle 桥接成既有 templateDoctor/
// communityRoutes 安装管线认识的 CompanyTemplate 扁平形状——该管线尚未原生识别 bundle 信封,
// 直接吃 bundle(以及 D3 的三种安装模式/合并冲突策略)是 D3/D4 的范围,这里先把接口打通。
// C2 · org 回桥**不做**:org.teams/edges 是 agents 的派生投影(deriveOrgTeamsAndEdges),扁平模板
// 以顶层 agents 为唯一事实源——回桥会制造第二事实源;bundle 声明与派生不一致由 templateDoctor
// 的 org_projection_consistent 检查点破(warning),导入结构永远从 agents 重建。
export function bundleToTemplateShape(bundle: CompanyBundle): Record<string, unknown> {
  return {
    id: bundle.bundle_id ? slugifyBundleId(bundle.bundle_id) : slugifyBundleId(bundle.title),
    title: bundle.title,
    description: bundle.description ?? "",
    author: bundle.company?.name ?? "community",
    createdAt: bundle.metadata?.created_at ?? new Date().toISOString(),
    tags: bundle.metadata?.tags ?? [],
    downloads: 0,
    stars: 0,
    readme: bundle.readme ?? bundle.description ?? "",
    agents: bundle.agents,
    license: bundle.metadata?.license,
    // P0-3 · canonical 导出携带的完整结构字段桥接回扁平 CompanyTemplate,使"导出 bundle → 重新导入"
    // 不丢 workflow/预置通道/打包技能/工具需求等(旧 flat 导出等价保真)。仅在 bundle 真带该字段时映射,
    // 缺省(V0/legacy bundle 无此字段)保持既有最小形状不变。
    ...(bundle.metadata?.version ? { version: bundle.metadata.version } : {}),
    ...(bundle.useCases ? { useCases: bundle.useCases } : {}),
    ...(bundle.riskNotes ? { riskNotes: bundle.riskNotes } : {}),
    ...(bundle.toolRequirements ? { toolRequirements: bundle.toolRequirements } : {}),
    ...(bundle.recommendedConfig ? { recommendedConfig: bundle.recommendedConfig } : {}),
    ...(bundle.visibilityPolicy ? { visibilityPolicy: bundle.visibilityPolicy } : {}), // P0-B①:公司级调度语义桥回,导入落 Company
    ...(bundle.workflow ? { workflow: bundle.workflow } : {}),
    ...(bundle.bundledSkills ? { bundledSkills: bundle.bundledSkills } : {}),
    ...(bundle.mcpRequirements ? { mcpRequirements: bundle.mcpRequirements } : {}),
    ...(bundle.a2aChannels ? { a2aChannels: bundle.a2aChannels } : {}),
    ...(bundle.defaultTasks ? { defaultTasks: bundle.defaultTasks } : {}),
    // D5:memory.records 桥接成 CompanyTemplate.seedMemories,否则 templates/import 把原生 Bundle
    // 存进社区库(saveTemplate 只认 CompanyTemplateSchema 形状)那一步就会把记忆数据丢光。
    ...(bundle.memory?.records?.length ? { seedMemories: bundle.memory.records } : {}),
    // ① 同理:员工个人记忆桥接进扁平模板形状(CompanyTemplate.agentMemories),否则"Bundle→扁平模板"
    //   这一步(工坊从公司导出、社区库存往返、本地文件导入)就把员工记忆静默剥掉。
    ...(bundle.agentMemories?.length ? { agentMemories: bundle.agentMemories } : {}),
  };
}

// P0-3 · canonical 导出:把一份扁平 CompanyTemplate 包装成完整 Company Bundle(带 schema_version +
// 结构字段 + memory + privacy)。bundleToTemplateShape 的反向;两者组成"扁平 ⇄ bundle"的无损往返,
// 供公司/库内模板的导出路径统一产出 canonical bundle(不再输出旧 flat 模板)。memory 缺省取
// tpl.seedMemories;导出侧(companyRoutes 活公司导出)可经 opts 覆盖成"按 memoryExportEnabled 过滤 +
// 脱敏"后的记忆与派生的 required_secrets(见 runtime/companyTemplate.ts companyToBundle 的口径)。
export function templateToBundle(
  tpl: CompanyTemplate,
  opts: {
    memoryRecords?: BundleMemoryRecord[];
    redactedFields?: string[];
    requiredSecrets?: RequiredSecretSpec[];
    companyId?: string;
    exportProfile?: ExportProfile;
    agentMemories?: BundleAgentMemory[];
  } = {},
): CompanyBundle {
  const records = opts.memoryRecords ?? tpl.seedMemories ?? [];
  // ① 员工个人记忆:导出侧(companyRoutes 活公司导出)经 opts.agentMemories 传"采集+脱敏"后的记忆;
  //   库内扁平模板(工坊保存的、社区库存的)则默认从 tpl.agentMemories 回填,使"工坊模板→分享导出→
  //   安装带记忆"整条链不丢。
  const agentMemories = opts.agentMemories ?? tpl.agentMemories;
  return {
    schema_version: CURRENT_BUNDLE_SCHEMA_VERSION,
    bundle_type: tpl.agents.length > 0 ? "company" : "agent",
    bundle_id: tpl.id,
    title: tpl.title,
    description: tpl.description ?? "",
    metadata: {
      version: tpl.version,
      created_at: tpl.createdAt,
      license: tpl.license,
      tags: tpl.tags,
    },
    company: { company_id: opts.companyId, name: tpl.title, description: tpl.description },
    // C2 · org 真填:teams/edges 从 agents(+a2aChannels/workflow)派生投影(此前只填 agents)。
    org: { agents: tpl.agents, ...deriveOrgTeamsAndEdges(tpl.agents, tpl.a2aChannels, tpl.workflow) },
    agents: tpl.agents,
    readme: tpl.readme,
    useCases: tpl.useCases,
    riskNotes: tpl.riskNotes,
    toolRequirements: tpl.toolRequirements,
    recommendedConfig: tpl.recommendedConfig,
    visibilityPolicy: tpl.visibilityPolicy, // P0-B①:公司级调度语义随包(undefined 时 JSON 自动省略)
    workflow: tpl.workflow,
    bundledSkills: tpl.bundledSkills,
    mcpRequirements: tpl.mcpRequirements,
    a2aChannels: tpl.a2aChannels,
    defaultTasks: tpl.defaultTasks,
    memory: { records },
    ...(opts.exportProfile ? { export_profile: opts.exportProfile } : {}),
    ...(agentMemories?.length ? { agentMemories } : {}),
    privacy: { redacted: true, redacted_fields: opts.redactedFields ?? [], required_secrets: opts.requiredSecrets ?? [] },
    compatibility: { migration_notes: [] },
  };
}
