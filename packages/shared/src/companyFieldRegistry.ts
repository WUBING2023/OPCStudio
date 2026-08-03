// 收口④ · Company Blueprint canonical 字段属性登记表(唯一真相源)。
//
// 公司架构 = 唯一 Company Blueprint:凡"用户设计出来、应当可迁移"的公司能力字段,都在这里
// 声明其属性 {category, editable, portable, sensitive, requiresLocalSetup, mergeStrategy}。
// 架构 UI / 导出 CompanyBundle / 导入 / 模板工坊消费同一份属性表,不再各自硬编码字段清单:
//   · installMerge.mergeCompanyLevelFields —— 公司级字段的 mergeStrategy 与五数组子键清单;
//   · memoryBundle.sanitizeBundleForExport —— agent 级本机路径/CLI 字段的 sensitive 清单;
//   · install.rerootAgents —— non-portable 本机路径清空清单(运行态复位值仍在其函数内);
//   · workshopTypes.TEMPLATE_PASSTHROUGH_SKIP / AGENT_PASSTHROUGH_SKIP —— 工坊两级 skip 集合;
//   · fieldFidelityLedger 链路测试 —— 可移植设计字段投影(PORTABLE_DESIGN_FIELD_KEYS)。
// 一致性守卫:apps/server/src/runtime/companyFieldRegistry.guard.test.ts ——
//   CompanyTemplateSchema 顶层字段与本表一一对应(新增字段忘记登记即测试红),
//   sensitive 字段绝不以原始值出现在导出的 share/full bundle。
//
// 刻意不收进本表的两类判定(允许各消费方保留自己的转换逻辑,收口④口径):
//   · 内容形态扫描(memoryBundle SECRET_PATTERNS/PATH_PATTERNS 深扫)——按值不按字段名;
//   · deriveRequiredSecrets —— 按 agent 的 framework/provider 属性推导,非静态字段属性。
// 纯数据表 + 查询函数,无副作用、无 fs/网络依赖,server 与 web 两侧共用。

import type { AgentNodeConfig, Company, CompanyTemplate } from "./types.js";

// Blueprint 六大类(收口④「公司架构应成为唯一 Company Blueprint」的分类口径)。
export type CompanyFieldCategory = "org" | "execution" | "collab" | "governance" | "memory" | "workspace";

// merge 到既有公司时该字段的策略(收口②词表):
//   union            —— 稳定并集,目标在前且权威(去重口径见各实现);
//   target-preferred —— 目标已设置则永远保留,仅目标未设置时采用来源;
//   requires-review  —— 双方都有时保留目标并进 requires_review 报告,不静默合并/覆盖;
//   keep-target      —— merge 路径一律不采纳来源(身份/元数据/advisory 类);
//   non-portable     —— 字段本就不出包(本机路径/运行态),merge 无从谈起。
export type FieldMergeStrategy = "union" | "target-preferred" | "requires-review" | "keep-target" | "non-portable";

// 模板工坊对该顶层字段的处理方式(TEMPLATE_PASSTHROUGH_SKIP 的四类分区 + passthrough):
//   edited          —— 工坊各页真正编辑/结构重建;
//   named-carried   —— 已提为具名 draft 字段,原样带回不编辑;
//   server-filled   —— 服务端补齐/覆盖(author/downloads/stars/createdAt);
//   security-signal —— 安全信号,导入侧重算不固化(hash/signature/trustLevel);
//   passthrough     —— 进 templatePassthrough 兜底原样带回。
export type WorkshopHandling = "edited" | "named-carried" | "server-filled" | "security-signal" | "passthrough";

export interface CompanyFieldAttr {
  /** CompanyTemplate 顶层字段名(模板 key 空间;Bundle 侧同名字段见 companyBundle.schema.ts 桥接)。 */
  key: Extract<keyof CompanyTemplate, string>;
  category: CompanyFieldCategory;
  /** 工坊/架构 UI 是否提供编辑入口(named-carried/passthrough 均视为不可编辑=false)。 */
  editable: boolean;
  /** 是否随导出包迁移(false = 服务端重算/补齐,wire 值不作数)。 */
  portable: boolean;
  /** 顶层字段本身是否敏感(API key/本机路径类)。模板顶层无敏感字段——敏感载荷在 agent 级
   *  (AGENT_FIELD_REGISTRY)与内容形态扫描(memoryBundle)两处把关。 */
  sensitive: boolean;
  /** 导入后是否需要接收方本机配置/授权才可用(声明≠授权红线)。 */
  requiresLocalSetup: boolean;
  mergeStrategy: FieldMergeStrategy;
  workshop: WorkshopHandling;
  /** 该字段落在 Company 持久对象上的 key(模板↔公司命名映射;无映射 = 不落公司对象)。 */
  companyKey?: Extract<keyof Company, string>;
  /** 身份/社区元数据(非可移植"设计载荷")——PORTABLE_DESIGN_FIELD_KEYS 据此排除。 */
  metadata?: boolean;
  /** mergeCompanyLevelFields(收口②)处理的公司级字段(COMPANY_LEVEL_MERGE_FIELDS 据此派生)。 */
  companyLevelMerge?: boolean;
  note?: string;
}

// ── CompanyTemplate 顶层字段全集(与 CompanyTemplateSchema 一一对应,守卫测试强制)──────────
export const COMPANY_TEMPLATE_FIELD_REGISTRY: readonly CompanyFieldAttr[] = [
  // —— 身份/社区元数据(org)——
  { key: "id", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", companyKey: "manifestTemplateId", metadata: true },
  { key: "title", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", metadata: true },
  { key: "description", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", metadata: true },
  { key: "tags", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", metadata: true },
  { key: "readme", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", metadata: true, note: "独立富文本文档;工坊无编辑保存时原样写回,不由 description 派生覆盖" },
  { key: "forkedFrom", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", metadata: true },
  { key: "author", category: "org", editable: false, portable: false, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "server-filled", metadata: true },
  { key: "authorGitHub", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough", metadata: true },
  { key: "createdAt", category: "org", editable: false, portable: false, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "server-filled", metadata: true },
  { key: "downloads", category: "org", editable: false, portable: false, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "server-filled", metadata: true },
  { key: "stars", category: "org", editable: false, portable: false, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "server-filled", metadata: true },
  { key: "license", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough", metadata: true, note: "此前只靠 .passthrough() 幸存,收口④起在 CompanyTemplateSchema 显式声明" },
  { key: "version", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough", metadata: true },
  { key: "compatibility", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough", metadata: true, note: "模板侧是字符串;与 CompanyBundle.compatibility(对象)同名不同义,勿混" },

  // —— 组织/声明(org,设计载荷)——
  { key: "agents", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "edited", note: "merge 按 agentId 五类冲突策略(installMerge.resolveMerge),缺省 copy-as-new 并入" },
  { key: "useCases", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", companyKey: "manifestUseCases" },
  { key: "riskNotes", category: "org", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", companyKey: "manifestRiskNotes" },
  { key: "exampleTrace", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough" },
  { key: "exampleArtifacts", category: "org", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough" },

  // —— 执行(execution)——
  { key: "toolRequirements", category: "execution", editable: false, portable: true, sensitive: false, requiresLocalSetup: true, mergeStrategy: "union", workshop: "named-carried", companyKey: "manifestToolRequirements", companyLevelMerge: true, note: "五数组稳定 union;只声明/缺失诊断,绝不自动启用(声明≠授权红线)" },
  { key: "bundledSkills", category: "execution", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "edited" },
  { key: "mcpRequirements", category: "execution", editable: true, portable: true, sensitive: false, requiresLocalSetup: true, mergeStrategy: "union", workshop: "edited", companyKey: "manifestMcpRequirements", note: "capability strictest 并集(installMerge.mergeCapabilities);MCP 是本机服务,导入只声明" },
  { key: "defaultTasks", category: "execution", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "named-carried", companyKey: "defaultTasks", companyLevelMerge: true, note: "按规范化 goal 去重 union,目标在前且权威" },

  // —— 协作(collab)——
  { key: "workflow", category: "collab", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "requires-review", workshop: "edited", companyKey: "workflow", companyLevelMerge: true, note: "目标已有则保留目标并进 requires_review;目标无才采纳来源" },
  { key: "a2aChannels", category: "collab", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "edited", companyKey: "presetChannels", note: "a2aRule 缺省 union(installMerge.mergeChannels);Safe Install 默认剥自动授权入批准队列" },
  { key: "visibilityPolicy", category: "collab", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "target-preferred", workshop: "named-carried", companyKey: "visibilityPolicy", companyLevelMerge: true, note: "禁止导入放宽既有信息隔离:目标已设永远保留" },

  // —— 治理(governance)——
  { key: "recommendedConfig", category: "governance", editable: true, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "edited", note: "advisory:导入不自动生效,不覆盖接收方 ProjectConfig" },
  { key: "requiredPermissions", category: "governance", editable: false, portable: true, sensitive: false, requiresLocalSetup: true, mergeStrategy: "keep-target", workshop: "passthrough", note: "导入前透明展示;Safe Install 默认降权,授权需接收方本机批准" },
  { key: "verifiedAuthor", category: "governance", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "passthrough", metadata: true, note: "D8 预留自声明,判不出不假定已验证" },
  { key: "trustLevel", category: "governance", editable: false, portable: false, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "security-signal", metadata: true, note: "服务端按 hash 校验重赋,不信 wire 自我声明" },
  { key: "hash", category: "governance", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "security-signal", metadata: true },
  { key: "signature", category: "governance", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "keep-target", workshop: "security-signal", metadata: true },

  // —— 记忆(memory)——
  { key: "seedMemories", category: "memory", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "named-carried", note: "memoryScope 缺省 skip-duplicate(目标优先去重并入);正文经导出侧脱敏" },
  { key: "agentMemories", category: "memory", editable: false, portable: true, sensitive: false, requiresLocalSetup: false, mergeStrategy: "union", workshop: "named-carried", note: "merge 只导新建员工;映射到既有员工/被跳过的进 requires_review,不静默覆盖" },
] as const;

const REGISTRY_BY_KEY: ReadonlyMap<string, CompanyFieldAttr> = new Map(
  COMPANY_TEMPLATE_FIELD_REGISTRY.map((e) => [e.key, e]),
);

/** 查询单字段属性(未登记返回 undefined —— 调用方应把未登记字段送进 import/merge 报告)。 */
export function companyFieldAttr(key: string): CompanyFieldAttr | undefined {
  return REGISTRY_BY_KEY.get(key);
}

/** 已登记的模板顶层字段 key 全集。 */
export const REGISTERED_TEMPLATE_FIELD_KEYS: readonly string[] =
  COMPANY_TEMPLATE_FIELD_REGISTRY.map((e) => e.key);

/** 工坊顶层 skip 集合(= 非 passthrough 的全部字段;TEMPLATE_PASSTHROUGH_SKIP 的唯一来源)。 */
export const TEMPLATE_WORKSHOP_SKIP_KEYS: readonly string[] =
  COMPANY_TEMPLATE_FIELD_REGISTRY.filter((e) => e.workshop !== "passthrough").map((e) => e.key);

/** 可移植"设计载荷"字段(portable 且非身份/元数据/安全信号)——fidelity 链路的投影比对用。 */
export const PORTABLE_DESIGN_FIELD_KEYS: readonly string[] =
  COMPANY_TEMPLATE_FIELD_REGISTRY.filter((e) => e.portable && !e.metadata).map((e) => e.key);

// ── 收口② · mergeCompanyLevelFields 处理的公司级字段(templateKey→companyKey + 策略)─────────
export interface CompanyLevelMergeField {
  templateKey: Extract<keyof CompanyTemplate, string>;
  companyKey: Extract<keyof Company, string>;
  mergeStrategy: FieldMergeStrategy;
}
export const COMPANY_LEVEL_MERGE_FIELDS: readonly CompanyLevelMergeField[] =
  COMPANY_TEMPLATE_FIELD_REGISTRY.filter((e) => e.companyLevelMerge).map((e) => ({
    templateKey: e.key,
    companyKey: e.companyKey!,
    mergeStrategy: e.mergeStrategy,
  }));

/** toolRequirements/manifestToolRequirements 的五个子数组 key(union 清单的唯一来源)。 */
export const TOOL_REQUIREMENT_KEYS = [
  "requiredEngines", "requiredProviders", "requiredMcpServers", "requiredSkills", "optionalTools",
] as const;
export type ToolRequirementKey = (typeof TOOL_REQUIREMENT_KEYS)[number];

// ── 未登记顶层字段 → 进 import/merge 报告(不静默丢)────────────────────────────────────
// 导入路由允许 body 顶层与模板字段并存控制字段(zod passthrough 会把它们一并留在模板对象上,
// 这是既有行为)——报告"未登记字段"时排除这些已知控制键,避免把请求参数误报成模板字段。
export const IMPORT_CONTROL_KEYS: readonly string[] = [
  "mode", "targetCompanyId", "mergeStrategies", "confirmOverwrite",
  "unsafeAcknowledged", "memoryImportMode", "name", "templateId",
];

/**
 * 列出对象上"未登记的模板顶层字段"(值为 undefined 的键与导入控制键不算)。
 * 用途:import/merge 报告如实列出 passthrough 保留下来的未知字段,lost 恒为 0 的最后一环。
 */
export function listUnregisteredTemplateFields(template: object): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(template)) {
    if (v === undefined) continue;
    if (REGISTRY_BY_KEY.has(k)) continue;
    if (IMPORT_CONTROL_KEYS.includes(k)) continue;
    out.push(k);
  }
  return out;
}

// ── agent 级字段属性表(AgentNodeConfig;敏感/运行态/结构清单的唯一来源)──────────────────
// 处理方式(handling):
//   structural —— 工坊映射/结构重建(id/name/role/…/card);
//   local-path —— 本机绝对路径(sensitive+non-portable):reroot 双向清空;share 档剥离、
//                 full 档占位($OPC_REMAP_*$,见 companyBundle.schema.ts);
//   runtime    —— 运行态:导出/导入一律 start-fresh 复位(复位值在 rerootAgents 内);
//   binding    —— 本机归属绑定(companyId),install/reroot 重写;
//   share-strip—— share 档整块剥离、full 档原样保留(genericCli:本机命令,接收方需重配);
//   portable   —— 可移植设计字段,原样往返。
export type AgentFieldHandling = "structural" | "local-path" | "runtime" | "binding" | "share-strip" | "portable";

export interface AgentFieldAttr {
  key: Extract<keyof AgentNodeConfig, string>;
  category: CompanyFieldCategory;
  portable: boolean;
  sensitive: boolean;
  requiresLocalSetup: boolean;
  handling: AgentFieldHandling;
  note?: string;
}

export const AGENT_FIELD_REGISTRY: readonly AgentFieldAttr[] = [
  { key: "id", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "name", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "role", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "provider", category: "execution", portable: true, sensitive: false, requiresLocalSetup: true, handling: "structural", note: "API 框架下接收方需自备该 provider 的 key(deriveRequiredSecrets 据此推导声明)" },
  { key: "model", category: "execution", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "framework", category: "execution", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural", note: "读侧 hermes→api 永久 alias(schema 层),reroot 写侧归一" },
  { key: "parentId", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "childrenIds", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural" },
  { key: "card", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "structural", note: "summary 经工坊 systemPrompt 编辑;完整 card 另经 passthrough 保留" },
  { key: "systemPrompt", category: "execution", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable", note: "C8 一等公民 prompt:dispatch 消费为 worker 执行 prompt 基底(未设回退 ROLE_PROMPTS);可移植设计字段,原样往返" },
  { key: "companyId", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "binding" },
  { key: "workspaceDir", category: "workspace", portable: false, sensitive: true, requiresLocalSetup: true, handling: "local-path", note: "本机工作目录绝对路径:share 剥离 / full 占位 $OPC_REMAP_WORKSPACE$ / reroot 双向清空" },
  { key: "workingDirectory", category: "workspace", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable", note: "MUP A#4 员工级相对工作子目录(POSIX 相对路径,不含本机信息)——可移植、可编辑,写侧经 validateAgentWorkingDirectory 校验" },
  { key: "cliConfigDir", category: "workspace", portable: false, sensitive: true, requiresLocalSetup: true, handling: "local-path", note: "本机 CLI 凭据目录:share 剥离 / full 占位 $OPC_REMAP_CLI_CONFIG$ / reroot 双向清空" },
  { key: "genericCli", category: "execution", portable: true, sensitive: false, requiresLocalSetup: true, handling: "share-strip", note: "本机命令:share 档整块剥离并记入 redacted_fields;full 档(自己备份)原样保留" },
  { key: "status", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "runtime" },
  { key: "currentTask", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "runtime" },
  { key: "lastAction", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "runtime" },
  { key: "tokenUsage", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "runtime" },
  { key: "costUsd", category: "workspace", portable: false, sensitive: false, requiresLocalSetup: false, handling: "runtime" },
  { key: "claudeCodeUseApiKey", category: "execution", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "reasoningEffort", category: "execution", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "nativeExecution", category: "execution", portable: true, sensitive: false, requiresLocalSetup: true, handling: "portable", note: "Portable execution preference only; the receiving host must negotiate native capability and may explicitly fall back or block. No auth material is included." },
  { key: "uiPosition", category: "org", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "visibilityPolicy", category: "collab", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "growth", category: "memory", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable", note: "成长档案两档都带走(用户拍板:权限降权≠记忆/成长不带)" },
  { key: "editable", category: "governance", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "deletable", category: "governance", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
  { key: "enabled", category: "governance", portable: true, sensitive: false, requiresLocalSetup: false, handling: "portable" },
] as const;

function agentKeysByHandling(handling: AgentFieldHandling): readonly Extract<keyof AgentNodeConfig, string>[] {
  return AGENT_FIELD_REGISTRY.filter((e) => e.handling === handling).map((e) => e.key);
}

/** 本机绝对路径字段(sensitive+non-portable):reroot 清空、sanitize 按档位剥离/占位。 */
export const AGENT_LOCAL_PATH_FIELDS = agentKeysByHandling("local-path") as readonly ("workspaceDir" | "cliConfigDir")[];
/** 运行态字段:导出/导入一律 start-fresh 复位(复位值在 install.rerootAgents 内)。 */
export const AGENT_RUNTIME_RESET_FIELDS = agentKeysByHandling("runtime");
/** share 档整块剥离的本机执行字段(full 档原样保留)。 */
export const AGENT_SHARE_STRIPPED_FIELDS = agentKeysByHandling("share-strip");
/** 工坊结构重建字段(角色卡映射)。 */
export const AGENT_STRUCTURAL_FIELDS = agentKeysByHandling("structural");
/** 工坊 agent 级 passthrough skip 集合(结构重建 + 本机绑定/路径/运行态,由 install/reroot 重置)。 */
export const AGENT_WORKSHOP_SKIP_KEYS: readonly string[] = [
  ...AGENT_STRUCTURAL_FIELDS,
  ...agentKeysByHandling("binding"),
  ...AGENT_LOCAL_PATH_FIELDS,
  ...AGENT_RUNTIME_RESET_FIELDS,
];
/** agent 级敏感字段(绝不以原始值进任何导出档位;守卫测试逐字段断言)。 */
export const AGENT_SENSITIVE_FIELDS: readonly string[] =
  AGENT_FIELD_REGISTRY.filter((e) => e.sensitive).map((e) => e.key);
