import { z } from "zod";
import {
  AgentNodeConfigSchema, WorkflowConfigSchema, A2AChannelSpecSchema,
  McpRequirementSchema, BundledSkillSchema, VisibilityPolicySchema,
} from "./schemas.js";
import type { AgentNodeConfig, WorkflowConfig, A2AChannelSpec } from "./types.js";

// D7 · AI 架构师(CompanyEditProposal,指南 11.11/11.12)。
//
// 设计决策(与 CompanyTemplate 的关系):这套 operation 不是操作"活公司"(那是 architectRoutes.ts/
// architectAssistant.ts 已有的 ArchitectAction 系统,面向 orchestrator 里真实运行的 agent),而是操作
// TemplateWorkshop.tsx 里正在编辑、尚未落盘的"公司草稿"。草稿在前端已经能和 CompanyTemplate 相互换算
// (workshopTypes.ts 的 buildPayload/draftFromTemplate),但 CompanyTemplate 本身的 zod schema 对
// author/createdAt/tags/downloads/stars/readme 等"发布态"字段有强制要求(如 title 必须非空),编辑中的
// 草稿常常还不满足——因此这里另开一个更贴合"编辑目标"的轻量 schema(CompanyEditTarget),只含
// operations 真正需要读写的字段;不复用 CompanyTemplateSchema 本体,避免为了改几个 agent 就被迫先
// 补全一堆和这次编辑无关的发布态字段。

// C3/D5 复用:defaultTasks / seedMemories 用与 CompanyTemplate 顶层同形状,保证草稿编辑 → 保存 → 导出往返一致。
const CompanyEditDefaultTaskSchema = z.object({
  title: z.string().min(1),
  goal: z.string().min(1),
  suggestedRole: z.string().optional(),
});
const CompanyEditSeedMemorySchema = z.object({
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
  level: z.enum(["draft", "noted", "verified", "sop", "doctrine"]),
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

const CompanyEditRecommendedConfigSchema = z.object({
  defaultModel: z.string().optional(),
  // Deprecated monetary fields are accepted only so old bundles remain fully
  // representable while the product exposes token limits as the active control.
  budget: z.object({
    totalUsd: z.number(),
    maxTokensPerTask: z.number(),
    maxAttemptsPerTask: z.number().optional(),
    taskTimeoutMs: z.number().optional(),
    maxTokensPerRun: z.number().optional(),
    maxTokensTotal: z.number().optional(),
  }).optional(),
  maxTokensPerTask: z.number().int().positive().optional(),
  permissions: z.object({ allowShell: z.boolean(), allowFileWrite: z.boolean(), allowWebAccess: z.boolean() }).optional(),
});
const CompanyEditRequiredPermissionsSchema = z.object({
  allowShell: z.boolean().optional(),
  allowFileWrite: z.boolean().optional(),
  allowWebAccess: z.boolean().optional(),
  mcpServers: z.array(z.string().min(1)).optional(),
});
const CompanyEditToolRequirementsSchema = z.object({
  requiredEngines: z.array(z.string()).default([]),
  requiredProviders: z.array(z.string()).default([]),
  requiredMcpServers: z.array(z.string()).default([]),
  requiredSkills: z.array(z.string()).default([]),
  optionalTools: z.array(z.string()).default([]),
});
export const CompanyEditTargetSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(""),
  description: z.string().default(""),
  agents: z.array(AgentNodeConfigSchema).default([]),
  workflow: WorkflowConfigSchema.optional(),
  a2aChannels: z.array(A2AChannelSpecSchema).optional(),
  // C11 收敛:三种有 canonical 字段的 op 落地目标(与 CompanyTemplate 同名同形状,工坊桥接双向带上)。
  mcpRequirements: z.array(McpRequirementSchema).optional(),
  defaultTasks: z.array(CompanyEditDefaultTaskSchema).optional(),
  seedMemories: z.array(CompanyEditSeedMemorySchema).optional(),
  bundledSkills: z.array(BundledSkillSchema).optional(),
  visibilityPolicy: VisibilityPolicySchema.optional(),
  recommendedConfig: CompanyEditRecommendedConfigSchema.optional(),
  requiredPermissions: CompanyEditRequiredPermissionsSchema.optional(),
  toolRequirements: CompanyEditToolRequirementsSchema.optional(),
});
export type CompanyEditTarget = z.infer<typeof CompanyEditTargetSchema>;

// ── CompanyEditOperation(MUP Gate C#11 收敛后:只保留"已真实支持的 canonical 字段"操作)──────────
// 契约第 11 条原文:AI 架构师"只允许它编辑已真实支持的 canonical 字段";"目前'声明但不执行'的
// add/update team、memory scope、artifact contract 等操作,要么完整实现,要么从模型、接口和 UI 移除"。
// 本次收敛:①有 canonical 字段的三种(add_memory_seed→seedMemories、add_default_mission→defaultTasks、
// update_capability_requirement→mcpRequirements)完整实现,apply 真落地;②无 canonical 字段的六种
// (add/update/remove_team、update_layout、update_memory_scope、update_artifact_contract)从写侧联合、
// prompt、UI、i18n 全部移除——AI 不再被允许产出、schema 写侧不再接受。存量历史记录(含这六种 op 的
// JSONL/SQLite proposal 台账)由读侧 tolerant schema(CompanyEditOperationReadSchema)兼容解析,不整条
// 掉进 unknown(沿用 hermes 读侧 alias 永久保留的先例)。

const CompanyEditAgentInputSchema = z.object({
  agentId: z.string().min(1).optional(), // 缺省 = 服务端按 role 派生一个稳定唯一 id
  name: z.string().min(1),
  role: z.string().min(1),
  parentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  framework: z.string().optional(),
  workingDirectory: z.string().optional(),
  systemPrompt: z.string().max(32 * 1024).optional(),
  visibilityPolicy: VisibilityPolicySchema.optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
  enabled: z.boolean().optional(),
});
export type CompanyEditAgentInput = z.infer<typeof CompanyEditAgentInputSchema>;

const CompanyEditAgentPatchSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  parentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  framework: z.string().optional(),
  workingDirectory: z.string().nullable().optional(),
  systemPrompt: z.string().max(32 * 1024).nullable().optional(),
  visibilityPolicy: VisibilityPolicySchema.nullable().optional(),
  reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type CompanyEditAgentPatch = z.infer<typeof CompanyEditAgentPatchSchema>;

// add_memory_seed 的输入(AI 只需给最小语义:owner_type/content/level/scope/tags;memory_id 缺省服务端派生,
// 其余审计字段服务端补齐成完整 seedMemories 记录,不要求 AI 产出全套 metrics/时间戳)。
const CompanyEditMemorySeedInputSchema = z.object({
  memory_id: z.string().min(1).optional(),
  owner_type: z.enum(["company", "team", "agent", "project"]).default("company"),
  owner_id: z.string().optional(),
  content: z.string().min(1),
  level: z.enum(["draft", "noted", "verified", "sop", "doctrine"]).default("noted"),
  scope: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type CompanyEditMemorySeedInput = z.infer<typeof CompanyEditMemorySeedInputSchema>;

// update_capability_requirement:声明本公司需要的一个 MCP 能力(落地到 mcpRequirements,action=add/remove)。
const CompanyEditCapabilityRequirementSchema = z.object({
  name: z.string().min(1),
  purpose: z.string().optional(),
  optional: z.boolean().optional(),
  action: z.enum(["add", "remove"]).default("add"),
});
export type CompanyEditCapabilityRequirement = z.infer<typeof CompanyEditCapabilityRequirementSchema>;

export const CompanyEditOperationSchema = z.discriminatedUnion("op", [
  // ── 核心:落地 ──
  z.object({ op: z.literal("add_agent"), agent: CompanyEditAgentInputSchema }),
  z.object({ op: z.literal("update_agent"), agentId: z.string().min(1), patch: CompanyEditAgentPatchSchema }),
  z.object({ op: z.literal("remove_agent"), agentId: z.string().min(1) }),
  // add_edge/remove_edge:组织汇报边(agentId 引用,to 汇报给 from——区别于 architectAssistant.ts 那套
  // 面向"活公司"、按 role 字符串引用的 verification/A2A 边)。
  z.object({ op: z.literal("add_edge"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ op: z.literal("remove_edge"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ op: z.literal("rename_company"), name: z.string().min(1) }),
  z.object({ op: z.literal("update_description"), description: z.string() }),
  // update_a2a_policy:CompanyEditTarget.a2aChannels 已有对应字段,直接落地(add=新增/去重覆盖,
  // remove=删除匹配项)。
  z.object({
    op: z.literal("update_a2a_policy"),
    from: z.string().min(1),
    to: z.string().min(1),
    purpose: z.string().optional(),
    action: z.enum(["add", "remove"]).default("add"),
  }),
  z.object({
    op: z.literal("add_verification_edge"),
    edge: z.object({
      producer: z.string().min(1), verifier: z.string().min(1),
      method: z.enum(["fact-check", "llm-review", "code-review", "custom"]),
      onReject: z.enum(["redo", "flag"]).default("redo"), maxRounds: z.number().int().min(1).max(10).optional(),
    }),
  }),
  z.object({ op: z.literal("remove_verification_edge"), producer: z.string().min(1), verifier: z.string().min(1) }),
  z.object({ op: z.literal("upsert_bundled_skill"), skill: BundledSkillSchema }),
  z.object({ op: z.literal("remove_bundled_skill"), name: z.string().min(1) }),
  z.object({
    op: z.literal("update_company_governance"),
    patch: z.object({
      visibilityPolicy: VisibilityPolicySchema.nullable().optional(),
      recommendedConfig: CompanyEditRecommendedConfigSchema.nullable().optional(),
      requiredPermissions: CompanyEditRequiredPermissionsSchema.nullable().optional(),
      toolRequirements: CompanyEditToolRequirementsSchema.nullable().optional(),
    }),
  }),  // ── C11 新落地:三种有 canonical 字段的 op(seedMemories/defaultTasks/mcpRequirements 真改 target)──
  z.object({ op: z.literal("add_memory_seed"), seed: CompanyEditMemorySeedInputSchema }),
  z.object({ op: z.literal("add_default_mission"), mission: CompanyEditDefaultTaskSchema }),
  z.object({ op: z.literal("update_capability_requirement"), requirement: CompanyEditCapabilityRequirementSchema }),
]);
export type CompanyEditOperation = z.infer<typeof CompanyEditOperationSchema>;

// C11 收敛后写侧支持的 op 类型全集(供 system prompt/测试核对完整性用;六种悬空 op 已移除)。
export const COMPANY_EDIT_OPERATION_TYPES = [
  "add_agent", "update_agent", "remove_agent",
  "add_edge", "remove_edge",
  "update_a2a_policy",
  "add_verification_edge", "remove_verification_edge",
  "upsert_bundled_skill", "remove_bundled_skill", "update_company_governance",
  "add_memory_seed",
  "add_default_mission",
  "update_capability_requirement",
  "rename_company",
  "update_description",
] as const;

// 全部写侧 op 都会真正改变 CompanyEditTarget(收敛后不再有"声明不执行"类型)。
export const COMPANY_EDIT_OPERATION_APPLIED_TYPES = [
  "add_agent", "update_agent", "remove_agent",
  "add_edge", "remove_edge",
  "update_a2a_policy",
  "add_verification_edge", "remove_verification_edge",
  "upsert_bundled_skill", "remove_bundled_skill", "update_company_governance",
  "add_memory_seed", "add_default_mission", "update_capability_requirement",
  "rename_company", "update_description",
] as const;

// ── 读侧 tolerant schema(存量兼容,永久保留)──────────────────────────────────────────
// C11 收敛把六种悬空 op(add/update/remove_team、update_layout、update_memory_scope、
// update_artifact_contract)从写侧移除后,历史 proposal 台账(.opc/architect/company-edit-proposals.jsonl
// 与 SQLite edit_proposals)里含这些 op 的存量记录若仍按写侧 union 解析会整条 safeParse 失败、掉进
// unknown 行不可见。读侧用这个更宽松的 union 兼容解析——存量 op 原样带回(只作审计展示,apply 侧已不
// 再落地),不做数据迁移不删历史。companyEditProposalStore 读路径专用,写路径仍用严格的
// CompanyEditOperationSchema。
const LEGACY_DANGLING_OP_TYPES = [
  "add_team", "update_team", "remove_team",
  "update_layout", "update_memory_scope", "update_artifact_contract",
] as const;
export const CompanyEditOperationReadSchema = z.union([
  CompanyEditOperationSchema,
  // 存量六种悬空 op:只要求 op 字段是这批已知类型之一,其余字段 passthrough 原样保留。
  z.object({ op: z.enum(LEGACY_DANGLING_OP_TYPES) }).passthrough(),
]);
export type CompanyEditOperationRead = z.infer<typeof CompanyEditOperationReadSchema>;

// ── CompanyEditProposal(指南 11.11)──────────────────────────────────────────────
// AI 只输出这个结构;proposal_id/requires_user_confirmation 由服务端赋值,不信任 AI 自己声称的值。
export const CompanyEditProposalSchema = z.object({
  proposal_id: z.string().min(1),
  summary: z.string(),
  operations: z.array(CompanyEditOperationSchema).max(20),
  risks: z.array(z.string()).default([]),
  requires_user_confirmation: z.literal(true),
});
export type CompanyEditProposal = z.infer<typeof CompanyEditProposalSchema>;

// ── 校验/落地结果(纯 TS 接口——不跨越"接收外部不可信 JSON"边界,不需要 zod)──────────────
export interface CompanyEditDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}

export interface CompanyEditOpResult {
  op: CompanyEditOperation;
  ok: boolean;       // 该条操作本身是否成功解析/落地(冲突、引用不到、暂不支持 → false)
  applied: boolean;  // 是否真的改变了 CompanyEditTarget(与 ok 通常一致;"暂不支持"类型 ok/applied 都为 false)
  reason?: string;   // 人话原因(失败原因,或"已解析暂不支持自动应用"这类说明;ok:true 时也可能带高风险提示)
  diff: CompanyEditDiffEntry[];
}

export interface CompanyEditValidationReport {
  status: "pass" | "warning" | "error";
  opResults: CompanyEditOpResult[];
  errors: string[];    // 阻断级:agent_id 冲突 / 组织成环 / 引用解析失败(含 A2A policy 非法)
  warnings: string[];  // 非阻断:权限扩张、删除员工高风险提示、暂不支持的操作类型
  apply_allowed: boolean; // errors.length === 0
  template: CompanyEditTarget; // dry-run 预演后的最终态,供前端渲染 diff;不代表已落盘
  // 结构化高危信号:本批 operations 应用后是否让公司危险权限面(dangerFlags)扩大——供 apply 端点的
  // "高危二次确认"门做判定(不靠 warnings 文案 string-match)。加性字段,存量消费方忽略即可。
  permissionExpanded: boolean;
}

// re-export 便于消费方不用同时 import from "./schemas.js"/"./types.js"。
export type { AgentNodeConfig, WorkflowConfig, A2AChannelSpec };
