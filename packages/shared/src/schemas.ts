import { z } from "zod";
import { NativeExecutionPreferenceSchema } from "./nativeExecutionContract.js";

export const VisibilityPolicySchema = z.enum(["default", "isolated", "game"]);

// A2A: 能力自描述 schema(全可选;UI 编辑/序列化入口,单进程内不强制 parse)。
export const AgentSkillDescSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
});
export const AgentCapabilityCardSchema = z.object({
  summary: z.string(),
  skills: z.array(AgentSkillDescSchema),
  produces: z.array(z.string()).optional(),
  consumes: z.array(z.string()).optional(),
  acceptsQuery: z.boolean().optional(),
  tools: z.array(z.string()).optional(),
});

// C5 · 员工成长(见 types.ts AgentGrowth 注释)。
export const AgentGrowthSchema = z.object({
  level: z.number(),
  xp: z.number(),
  successRate: z.number().optional(),
  specialties: z.array(z.string()).optional(),
  weaknesses: z.array(z.string()).optional(),
  recentLessons: z.array(z.string()).optional(),
});

// 执行框架 enum + 读侧永久 alias:历史值 "hermes"(契约冻结 fixture / 存量 .opc/agents.json /
// 旧社区模板,一律不改写)读到即归一为 "api"(OPC 内部 in-process API 引擎);写侧只出 "api"。
// "hermes" 绝不从 enum 删——删了旧 bundle 立刻导入非法,违反 roundTripFidelity/bundleMigrationDrill
// 锁死的"老 bundle 永远可导入"契约。
const normalizeFrameworkAlias = (v: unknown) => (v === "hermes" ? "api" : v);
export const AgentFrameworkSchema = z.preprocess(normalizeFrameworkAlias, z.enum([
  "api", "hermes", "claude-code", "codex",
  "gemini-cli", "kimi-cli", "grok-build",
  "qwen-code", "opencode", "aider", "goose", "openhands",
  "amp", "plandex", "open-interpreter", "generic-cli",
]));

export const AgentNodeConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.string(),
  parentId: z.string().optional(),
  childrenIds: z.array(z.string()),
  model: z.string(),
  provider: z.string(),
  framework: AgentFrameworkSchema.optional(),
  cliConfigDir: z.string().optional(),
  claudeCodeUseApiKey: z.boolean().optional(),
  genericCli: z.object({
    command: z.string(),
    args: z.array(z.string()),
    authEnvVar: z.string().optional(),
  }).optional(),
  companyId: z.string().optional(),
  workspaceDir: z.string().optional(),
  // MUP Gate A#4:员工级相对工作子目录(POSIX 相对路径;写侧应经 validateAgentWorkingDirectory 校验)。
  workingDirectory: z.string().optional(),
  // .nullable():"自动排列"(OrgPage.tsx)会显式把这个字段设成 null(清空手动位置,回退默认布局),
  // 这类节点导出的公司模板本来就带着 null,导入校验不该拒收——之前只接受 object|undefined,
  // 任何用过一次自动排列的公司导出后永远无法通过本产品自己的导入校验重新导入。
  uiPosition: z.object({ x: z.number(), y: z.number() }).nullable().optional(),
  visibilityPolicy: VisibilityPolicySchema.optional(),
  // AgentStatus 11 态(与 types.ts 的联合类型同步;新 4 态是 working 窗口内的细粒度真状态)。
  status: z.enum(["idle", "working", "waiting", "disabled", "failed", "done", "restricted", "thinking", "using_tool", "reviewing", "waiting_review"]),
  currentTask: z.string().optional(),
  tokenUsage: z.object({ prompt: z.number(), completion: z.number(), total: z.number() }),
  costUsd: z.number().nullable().optional(), // null = 订阅制引擎,非 $0
  lastAction: z.string().optional(),
  editable: z.boolean(),
  deletable: z.boolean(),
  enabled: z.boolean(),
  card: AgentCapabilityCardSchema.optional(),
  // C8 · 一等 systemPrompt(可选、加性;旧模板/旧 bundle 无此字段照常合法)。dispatch 用它作 worker 执行
  // prompt 的基底,未设置则回退 getRolePrompt(role)。上限防止一条超长 prompt 撑爆模板/bundle。
  systemPrompt: z.string().max(32 * 1024).optional(),
  growth: AgentGrowthSchema.optional(),
  // ③ 订阅执行推理档位(types.ts AgentNodeConfig.reasoningEffort 已有,schema 此前漏收 → 经
  //    CompanyTemplateSchema 校验时被静默 strip,导致模板/Bundle 往返丢字段)。补上:可选、加性,
  //    旧模板/旧 bundle 无此字段照常合法(免 bump)。
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  nativeExecution: NativeExecutionPreferenceSchema.optional(),
});

// A2A 消息/产出物 schema(序列化/校验备用,全 A2A 字段可选)。
export const PerformativeSchema = z.enum(["inform", "request", "ask", "reply", "share", "propose", "accept", "reject"]);
export const A2APartSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string() }),
  z.object({ kind: z.literal("data"), data: z.record(z.unknown()) }),
  z.object({ kind: z.literal("artifact"), ref: z.string() }),
]);
export const ArtifactRefSchema = z.object({ id: z.string(), name: z.string(), type: z.string(), summary: z.string().optional() });
export const ArtifactSchema = z.object({
  id: z.string(),
  runId: z.string().optional(),
  producedBy: z.string(),
  kind: z.enum(["file-change", "report", "text"]),
  name: z.string(),
  type: z.string(),
  workdirPath: z.string().optional(),
  inlineText: z.string().optional(),
  summary: z.string().optional(),
  createdAt: z.string(),
});

export const RunInputSchema = z.object({
  goal: z.string().min(1),
});

// Stage 6 · 交叉验证链 schema(manifest + company 共用)。
export const VerificationEdgeSchema = z.object({
  id: z.string().optional(),
  producer: z.string(),
  verifier: z.string(),
  method: z.enum(["fact-check", "llm-review", "code-review", "custom"]),
  onReject: z.enum(["redo", "flag"]),
  maxRounds: z.number().optional(),
});
export const WorkflowConfigSchema = z.object({
  verificationEdges: z.array(VerificationEdgeSchema).optional(),
});

// Stage 8+ · 生态深化(全部可选,additive;老模板无这些字段照常安装)。
// 内容内联自包含 —— 打包进模板的 skill 正文随模板走,不依赖发布方本地文件系统。
export const BundledSkillSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string().min(1).max(256 * 1024),
  roles: z.array(z.string()).optional(), // 缺省 = install 时绑定到本模板出现过的全部角色(非全局 "*",防串染)
});
// 声明而非打包 —— MCP 是本机服务,模板只声明"需要哪个",install 时对照本机已配 MCP 报 missing。
export const McpRequirementSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  optional: z.boolean().optional(),
});
// 角色卡引用(同 VerificationEdge.producer/verifier 惯例:模板内 agentId 或 role 名)。
// P0-2 · A2A 通道正式编辑:从/到/方向/用途/授权策略/启用。
// 新字段全可选(向后兼容),消费方缺省按 oneway/trusted/true。
export const A2AChannelSpecSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  direction: z.enum(["oneway", "bidirectional"]).optional(),
  purpose: z.string().optional(),
  authPolicy: z.enum(["trusted", "gated", "manual"]).optional(),
  enabled: z.boolean().optional(),
});

// D5 · 记忆导出(指南「7月6日第一个大重构指南.md」11.6)——五级成熟度台账,统一容器承载
// conclusion_summary/procedural_skill/lessons 三种既有记忆的导出视图(见 runtime/memoryBundle.ts 的映射规则)。
// 放在 schemas.ts(而非 companyBundle.schema.ts)是为了让 CompanyTemplateSchema 能在同文件内直接引用它
// (companyBundle.schema.ts 已经 import 本文件的 AgentNodeConfigSchema,若反向从这里 import 会形成循环)。
export const MemoryLevelSchema = z.enum(["draft", "noted", "verified", "sop", "doctrine"]);
export const BundleMemoryRecordSchema = z.object({
  memory_id: z.string().min(1),
  scope: z.string().default(""),
  owner_type: z.enum(["company", "team", "agent", "project"]),
  owner_id: z.string().default(""),
  content: z.string(),
  source: z.object({
    type: z.string().default("run"),
    run_id: z.string().default(""),
    task_id: z.string().default(""),
    agent_id: z.string().optional(),
  }),
  level: MemoryLevelSchema,
  score: z.number().min(0).max(100).default(0),
  status: z.enum(["active", "archived"]).default("active"),
  tags: z.array(z.string()).default([]),
  metrics: z.object({
    cited_count: z.number().int().min(0).default(0),
    cited_success_count: z.number().int().min(0).default(0),
    prevented_failure_count: z.number().int().min(0).default(0),
    contradicted_count: z.number().int().min(0).default(0),
    reviewer_upvote_count: z.number().int().min(0).default(0),
  }),
  created_at: z.string().default(""),
  updated_at: z.string().default(""),
  last_used_at: z.string().default(""),
});
// D4 · 导出隐私(指南 11.7):required_secrets 从"只声明名字数组"升级成带说明的对象数组(与指南示例同形状)。
export const RequiredSecretSpecSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  required_for: z.string().default(""),
});

export const CompanySchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  folder: z.string().optional(),
  ceoId: z.string().optional(),
  visibilityPolicy: VisibilityPolicySchema.optional(),
  createdAt: z.string(),
  // Stage 5:install 时保留的 manifest 作者元数据(全可选,向后兼容)。
  manifestTemplateId: z.string().optional(),
  manifestUseCases: z.array(z.string()).optional(),
  manifestRiskNotes: z.array(z.string()).optional(),
  manifestToolRequirements: z.object({
    requiredEngines: z.array(z.string()),
    requiredProviders: z.array(z.string()),
    requiredMcpServers: z.array(z.string()),
    requiredSkills: z.array(z.string()),
    optionalTools: z.array(z.string()),
  }).optional(),
  workflow: WorkflowConfigSchema.optional(),
  // Stage 8+ · MCP 需求(从 template.mcpRequirements 保留,供能力边界报告交叉核对本机 MCP 配置)。
  manifestMcpRequirements: z.array(McpRequirementSchema).optional(),
  // Stage 8+ · A2A 预置通道:模板 a2aChannels 换算成真实 agent id 后落盘(见 runtime/install.ts),
  // orchestrator 起 run 时读它自动 grant(见 orchestrator.ts startRun)。
  presetChannels: z.array(A2AChannelSpecSchema).optional(),
  // 记忆导出开关(可选,缺省按 true 处理,不改变现有行为)。
  memoryExportEnabled: z.boolean().optional(),
  maxTokensTotal: z.number().int().min(0).max(10_000_000_000).optional(),
  // P0-B③:安装模板时保留的示例任务(作者手填 defaultTasks 的持久落点)。可选、加性——旧公司无此字段照常。
  defaultTasks: z.array(z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    suggestedRole: z.string().optional(),
  })).optional(),
  nativeExecution: NativeExecutionPreferenceSchema.optional(),
});

export const ProviderAccountSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  label: z.string(),
  apiKey: z.string().max(8192).optional().default(""), // 订阅制账号(claude-code/codex)无 key,靠 configDir 登录态认证
  baseUrl: z.string().max(2048).optional(),
  allowLocalNetwork: z.boolean().optional(),
  configDir: z.string().max(2048).optional(),
  frameworks: z.array(AgentFrameworkSchema).optional(),
  enabled: z.boolean(),
  preferred: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(64),
  // "我愿意冒险":订阅 CLI 账号默认并发钳 5(实测 10 并发未触发限流/封号,取安全余量 5);开启后放宽到 10。
  // 只对订阅登录制账号有意义(API Key 模式本就按 maxConcurrent 放行,无共享登录被封风险)。
  acceptBanRisk: z.boolean().optional(),
  cliBackend: z.enum(["native", "glm-coding-plan"]).optional(),
});

export const ParallelConfigSchema = z.object({
  maxConcurrentWorkers: z.number(),
  perAccountDefault: z.number(),
  taskMaxAttempts: z.number(),
  taskTimeoutMs: z.number(),
  useWorktree: z.boolean(),
});

export const ProjectConfigSchema = z.object({
  version: z.string(),
  projectName: z.string(),
  apiKeys: z.record(z.string()),
  defaultModel: z.string(),
  budget: z.object({
    totalUsd: z.number().min(0).max(100000), // deprecated compatibility field; not enforced
    maxTokensPerTask: z.number().int().min(1).max(2000000),
    maxAttemptsPerTask: z.number().int().min(1).max(20).optional(),
    taskTimeoutMs: z.number().int().min(1000).max(24 * 60 * 60 * 1000).optional(),
    maxTokensPerRun: z.number().int().min(1).max(20000000).optional(),
    maxTokensTotal: z.number().int().min(1).max(200000000).optional(),
    maxCostPerRun: z.number().min(0).max(100000).optional(), // deprecated compatibility field; not enforced
  }),
  permissions: z.object({
    allowShell: z.boolean(),
    allowFileWrite: z.boolean(),
    allowWebAccess: z.boolean(),
  }),
  edition: z.enum(["personal", "pro", "enterprise"]).optional(), // Stage 10:标记位(零 enforcement)
  parallel: ParallelConfigSchema.optional(),
  onboarding: z.object({
    completed: z.boolean(),
    identity: z.enum(["developer", "product", "founder", "researcher", "student", "other"]).optional(),
    tutorial: z.boolean().optional(),
    completedAt: z.string().optional(),
  }).optional(),
  // 默认 AI 模型。creative/judge 仅保留旧配置读取兼容；新配置统一写 default。
  systemModel: z.object({
    default: z.object({ framework: z.string().optional(), provider: z.string(), model: z.string() }).optional(),
    creative: z.object({ framework: z.string().optional(), provider: z.string(), model: z.string() }).optional(),
    judge: z.object({ framework: z.string().optional(), provider: z.string(), model: z.string() }).optional(),
  }).optional(),
});

// POST /api/config accepts a partial update; the merged result is validated against the full schema.
export const ProjectConfigPatchSchema = ProjectConfigSchema.partial();

// 市场参考单价(USD / 1M tokens)。键 = canonical 模型 id(与 modelResolve.builtinFor / BUILTIN_MODELS 同代);
// 保留少量历史键(gpt-4.1*/claude-sonnet-4-6)只为存量节点的旧 id 仍能查到价,不作默认选型。
export const MARKET_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic(canonical)
  "claude-sonnet-5": { input: 3.00, output: 15.00 },
  "claude-opus-4-8": { input: 15.00, output: 75.00 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00 },
  // OpenAI(canonical)
  "gpt-5.1": { input: 1.25, output: 10.00 },
  "gpt-5": { input: 1.25, output: 10.00 },
  "gpt-5-mini": { input: 0.25, output: 2.00 },
  "gpt-5-nano": { input: 0.05, output: 0.40 },
  "o3": { input: 2.00, output: 8.00 },
  // 其他供应商
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "MiniMax-M3": { input: 0.30, output: 1.20 },
  "doubao-seed-2-0-pro-260215": { input: 0.47, output: 2.37 },
  // 历史键(仅存量节点旧 id 兜底,勿新选)
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

// 各供应商的 canonical 默认模型 —— 单一事实源。要切换某供应商的默认选型,只改这里一处;种子数据 / 示例公司
// 统一引用它,不再各自硬编码模型名(根治"换一次模型要改十几处 seed 文件"的问题)。值与 BUILTIN_MODELS[x][0]
// 同代;别名(claude-sonnet-4-6 等旧 id)仍由 modelResolve 兜底,但新数据一律落 canonical。
export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.1",
  deepseek: "deepseek-v4-pro",
  minimax: "MiniMax-M3",
  doubao: "doubao-seed-2-0-pro-260215",
  openrouter: "deepseek/deepseek-chat",
  ollama: "llama3.1",
};

export const ToolConfigEntrySchema = z.object({
  name: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});

// Stage 8 安全:内容 id 用于 `${id}.json/.md` 文件名 → 必须是安全 token(防写出目录外)。
export const SAFE_CONTENT_ID = z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, "invalid content id").refine(s => !s.includes(".."), "content id 不能含 '..'");

export const AgentCardSchema = z.object({
  id: SAFE_CONTENT_ID,
  title: z.string().min(1),
  description: z.string(),
  role: z.string(),
  author: z.string(),
  authorGitHub: z.string().optional(),
  sourceUrl: z.string().optional(),
  license: z.string().optional(),
  createdAt: z.string(),
  tags: z.array(z.string()),
  downloads: z.number(),
  stars: z.number(),
  agent: z.object({
    suggestedId: z.string(),
    name: z.string().min(1),
    recommendedProvider: z.string(),
    recommendedModel: z.string(),
    systemPrompt: z.string(),
    tools: z.array(ToolConfigEntrySchema),
    expectedRole: z.string(),
    recommendedParents: z.array(z.string()),
  }),
});

export const CompanyTemplateSchema = z.object({
  id: SAFE_CONTENT_ID,
  title: z.string().min(1),
  description: z.string(),
  author: z.string(),
  authorGitHub: z.string().optional(),
  verifiedAuthor: z.boolean().optional(), // D8:预留字段,现状多数模板缺失,判不出时不假定已验证
  // 收口④:license 在 types.ts CompanyTemplate 早已有,schema 此前漏声明、只靠 .passthrough() 幸存
  // (bundleToTemplateShape/templateToBundle 都读写它)。显式声明 + 登记进 companyFieldRegistry。
  license: z.string().optional(),
  createdAt: z.string(),
  tags: z.array(z.string()),
  downloads: z.number(),
  stars: z.number(),
  readme: z.string(),
  agents: z.array(AgentNodeConfigSchema),
  recommendedConfig: z.object({
    defaultModel: z.string().max(256).optional(),
    budget: z.object({ totalUsd: z.number(), maxTokensPerTask: z.number(), maxAttemptsPerTask: z.number().optional(), taskTimeoutMs: z.number().optional(), maxTokensPerRun: z.number().optional(), maxTokensTotal: z.number().optional() }).optional(),
    maxTokensPerTask: z.number().int().positive().optional(),
    permissions: z.object({ allowShell: z.boolean(), allowFileWrite: z.boolean(), allowWebAccess: z.boolean() }).optional(),
  }).optional(),
  // Manifest v1.5(可加性扩展,全可选)
  useCases: z.array(z.string()).optional(),
  compatibility: z.string().optional(),
  riskNotes: z.array(z.string()).optional(),
  toolRequirements: z.object({
    requiredEngines: z.array(z.string()),
    requiredProviders: z.array(z.string()),
    requiredMcpServers: z.array(z.string()),
    requiredSkills: z.array(z.string()),
    optionalTools: z.array(z.string()),
  }).optional(),
  workflow: WorkflowConfigSchema.optional(),
  // P0-B①:公司级消息可见性/信息隔离策略(调度语义)。可选、加性——旧模板无此字段照常合法,免 bump。
  visibilityPolicy: VisibilityPolicySchema.optional(),
  // Stage 8 · 模板供应链(全部可选,additive)
  version: z.string().optional(),
  trustLevel: z.enum(["official", "verified_community", "community", "local_import", "untrusted"]).optional(), // D8:5 级,旧三级值仍合法
  hash: z.string().optional(),
  signature: z.string().optional(),
  forkedFrom: z.string().optional(),
  requiredPermissions: z.object({
    allowShell: z.boolean().optional(),
    allowFileWrite: z.boolean().optional(),
    allowWebAccess: z.boolean().optional(),
    mcpServers: z.array(z.string()).optional(),
  }).optional(),
  exampleTrace: z.object({ goal: z.string(), steps: z.array(z.string()), outcome: z.string() }).optional(),
  exampleArtifacts: z.array(z.object({ name: z.string(), type: z.string(), description: z.string(), previewUrl: z.string().optional() })).optional(),
  // ── Stage 8+ · 生态深化(全部可选,additive)──
  bundledSkills: z.array(BundledSkillSchema).optional(),
  mcpRequirements: z.array(McpRequirementSchema).optional(),
  a2aChannels: z.array(A2AChannelSpecSchema).optional(),
  // D5 · Bundle 的 memory.records 桥接进扁平 CompanyTemplate 形状,才能在既有"社区库存 CompanyTemplate
  // JSON"管线(saveTemplate/getTemplate)里原样往返——不然 templates/import 把 CompanyBundle 桥接成
  // CompanyTemplate(bundleToTemplateShape)时,zod 会把它不认识的字段直接剥掉,导出的记忆会在
  // "导入模板库"这一步就静默丢失。
  seedMemories: z.array(BundleMemoryRecordSchema).optional(),
  // C3 · 示例任务(安装预览 newDefaultTasks 真数据源)。可选、加性——旧模板无此字段照常;zod 默认
  // strip 未知键,不加这条,库存管线(saveTemplate/getTemplate 经 CompanyTemplateSchema 的入口)会把
  // 该字段静默剥掉(与 seedMemories 同一理由)。
  defaultTasks: z.array(z.object({
    title: z.string().min(1),
    goal: z.string().min(1),
    suggestedRole: z.string().optional(),
  })).optional(),
  // ① 员工个人记忆(agent-memory.md)在扁平 CompanyTemplate 形状里的落点(与 CompanyBundle.agentMemories
  //   同形状,内联定义避免与 companyBundle.schema.ts 反向成环)。让"公司→工坊→社区模板"主路径能把员工
  //   记忆随模板库存往返(saveTemplate/getTemplate 经本 schema 的入口不再把它 strip 掉);templateToBundle
  //   导出时默认从此字段回填 bundle.agentMemories。可选、加性,旧模板无此字段照常合法(免 bump)。
  agentMemories: z.array(z.object({
    agent_id: z.string(),
    role: z.string().optional(),
    content: z.string(),
  })).optional(),
// P2(审计)· 前向兼容:.passthrough() 保留**未知顶层键**——否则 zod 默认 strip,未来新增的 Bundle 顶层
// 字段(尚未在本 schema 显式列出的)会在 saveTemplate/getTemplate 经本 schema 的入口被静默剥离(工坊
// templatePassthrough 暂存了也白搭)。此前靠"每加一个字段就补一条 schema"逐一救,passthrough 是通用兜底。
// 注:字段仍按上方声明校验类型;passthrough 只放行 schema 未声明的额外键,不放松已声明字段的校验。
}).passthrough();

// Stage 8 安全:teams/import 之前无校验,补 schema(参照 CompanyTemplate,id 用 SAFE_CONTENT_ID)。
export const TeamTemplateSchema = z.object({
  id: SAFE_CONTENT_ID,
  title: z.string().min(1),
  description: z.string(),
  author: z.string(),
  authorGitHub: z.string().optional(),
  createdAt: z.string(),
  tags: z.array(z.string()),
  downloads: z.number(),
  stars: z.number(),
  license: z.string().optional(),
  readme: z.string(),
  leadId: z.string(),
  agents: z.array(AgentNodeConfigSchema),
});

export const PromptTemplateSchema = z.object({
  id: SAFE_CONTENT_ID,
  name: z.string().min(1),
  content: z.string().max(256 * 1024),
  enabled: z.boolean(),
  author: z.string(),
  authorGitHub: z.string().optional(),
  tags: z.array(z.string()),
  downloads: z.number(),
  stars: z.number(),
  createdAt: z.string(),
});

export const CommunityIndexEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  author: z.string(),
  authorGitHub: z.string().optional(),
  role: z.string().optional(),
  tags: z.array(z.string()),
  downloads: z.number(),
  stars: z.number(),
  createdAt: z.string(),
  agentCount: z.number().optional(),
  license: z.string().optional(),
  sourceUrl: z.string().optional(),
  visibility: z.enum(["listed", "unlisted"]).optional(), // D8:下架标记,不是物理删除
  unlistedAt: z.string().optional(),
});

export const CommunityIndexSchema = z.object({
  templates: z.array(CommunityIndexEntrySchema),
  agents: z.array(CommunityIndexEntrySchema),
  prompts: z.array(CommunityIndexEntrySchema),
});

export const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  note: z.string().optional(),
  website: z.string().optional(),
  kind: z.enum(["claude", "unified", "local", "custom"]),
  apiFormat: z.enum(["openai", "anthropic", "gemini", "ollama", "custom"]),
  baseUrl: z.string().url().max(2048),
  apiKey: z.string().max(8192),
  defaultModel: z.string().max(256).optional(),
  models: z.array(z.string().max(256)).max(512),
  headers: z.record(z.string().max(128), z.string().max(4096)),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)),
  options: z.object({
    hideAISignature: z.boolean(),
    enableTeammatesMode: z.boolean(),
    enableToolSearch: z.boolean(),
    enableMaxThinking: z.boolean(),
    disableAutoUpgrade: z.boolean(),
    allowPromptCaching: z.boolean(),
    allowStreaming: z.boolean(),
  }),
  permissions: z.object({ allow: z.array(z.string().max(128)).max(256), deny: z.array(z.string().max(128)).max(256) }),
  pricing: z.object({
    currency: z.enum(["USD", "CNY"]),
    inputPer1MTokens: z.number().optional(),
    outputPer1MTokens: z.number().optional(),
    cacheReadPer1MTokens: z.number().optional(),
    cacheWritePer1MTokens: z.number().optional(),
  }).optional(),
  allowLocalNetwork: z.boolean().optional(),
  test: z.object({
    useSeparateConfig: z.boolean(),
    model: z.string().optional(),
    prompt: z.string().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
  }).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const DEFAULT_PROVIDER_OPTIONS = {
  hideAISignature: false, enableTeammatesMode: false,
  enableToolSearch: false, enableMaxThinking: false,
  disableAutoUpgrade: false, allowPromptCaching: true, allowStreaming: true,
};

export const DEFAULT_PROVIDER_PERMISSIONS = { allow: [], deny: [] };

export const McpServerConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string(),
  transport: z.enum(["stdio", "http"]),
  command: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  args: z.array(z.string().max(1000)).max(64).optional(),
  url: z.string().url().max(2048).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/), z.string().max(4096)).optional(),
  enabled: z.boolean(),
  allowLocalNetwork: z.boolean().optional(),
  assignedAgents: z.array(z.string()),
  createdAt: z.string(),
});

// v6 交互模型重构:MissionBrief schema(字面量镜像 orchestrator.ts 的 RunType / TeamMode,不 import 运行时代码)。
export const MissionBriefSchema = z.object({
  id: z.string(),
  companyId: z.string().optional(),
  createdAt: z.string(),
  originalIdea: z.string(),
  interpretedGoal: z.string(),
  targetUser: z.string().optional(),
  problemStatement: z.string().optional(),
  proposedDirection: z.string().optional(),
  successCriteria: z.array(z.string()),
  nonGoals: z.array(z.string()),
  assumptions: z.array(z.string()),
  risks: z.array(z.string()),
  // 决策⑥(MUP)· requiredDepartments 从"部门"悬空概念收敛:runtime 从不消费该字段(选队/派发/taskGraph
  // 均不读),按契约"未接线字段一律删除或禁用"从写侧移除。读侧 tolerant:改为可选并缺省空数组,存量
  // missions.json 含该字段照常解析,新写入不再强制产出。UI/prompt 侧移除见 crossLaneNotes(非本泳道文件)。
  requiredDepartments: z.array(z.string()).optional().default([]),
  expectedArtifacts: z.array(z.string()),
  suggestedRunType: z.enum(["quick", "team"]),
  suggestedTeamMode: z.enum(["economy", "balanced", "maxQuality"]).optional(),
  permissionNeeds: z.enum(["no_code", "propose_only", "write_code", "external_actions"]),
  approvalStatus: z.enum(["draft", "approved", "stopped"]),
});

// Plan 阶段用户手改简报:PATCH /api/missions/:id 的 body 校验(不含 id/createdAt/approvalStatus)。
export const MissionBriefPatchSchema = MissionBriefSchema.omit({
  id: true,
  createdAt: true,
  approvalStatus: true,
}).partial();

export function estimateCost(model: string, promptTokens: number, completionTokens: number): number | undefined {
  const p = MARKET_PRICES[model];
  if (!p) return undefined;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}
