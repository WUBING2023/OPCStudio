import { createHash } from "node:crypto";
import type {
  AgentNodeConfig, CompanyEditTarget, CompanyEditOperation, CompanyEditOpResult,
  CompanyEditValidationReport, CompanyEditDiffEntry, CompanyTemplate,
} from "@opc/shared";
import { COMPANY_EDIT_OPERATION_APPLIED_TYPES, buildLedger, deepEqual, validateAgentWorkingDirectory } from "@opc/shared";
import type { FidelityLedger, FieldSpec } from "@opc/shared";
import { orgHasCycle, scanContentSafety } from "./templateDoctor.js";
import { dangerFlags } from "./templateTrust.js";

// D7 · CompanyEditProposal 落地引擎(指南 11.11/11.12)。纯函数,不碰 fs/网络/orchestrator——和
// architectAssistant.ts 的 applyArchitectActions 是同一类"落地逻辑"分层,但操作对象不同:这里操作的是
// TemplateWorkshop.tsx 正在编辑、尚未落盘的 CompanyEditTarget(公司草稿),不是 orchestrator 里真实运行
// 的活公司——因此完全不 import orchestrator.js/companyStore.js,不产生任何真实副作用,操作结果原样
// 返回给 route 层由调用方(前端草稿状态)决定是否采纳。

function cloneTarget(target: CompanyEditTarget): CompanyEditTarget {
  return {
    ...target,
    agents: target.agents.map(a => ({ ...a, childrenIds: [...a.childrenIds] })),
    workflow: target.workflow
      ? { ...target.workflow, verificationEdges: target.workflow.verificationEdges ? [...target.workflow.verificationEdges] : undefined }
      : undefined,
    a2aChannels: target.a2aChannels ? target.a2aChannels.map(c => ({ ...c })) : undefined,
    mcpRequirements: target.mcpRequirements ? target.mcpRequirements.map(r => ({ ...r })) : undefined,
    defaultTasks: target.defaultTasks ? target.defaultTasks.map(t => ({ ...t })) : undefined,
    seedMemories: target.seedMemories ? target.seedMemories.map(s => ({ ...s, source: { ...s.source }, tags: [...s.tags], metrics: { ...s.metrics } })) : undefined,
    bundledSkills: target.bundledSkills ? target.bundledSkills.map(skill => ({ ...skill, roles: skill.roles ? [...skill.roles] : undefined })) : undefined,
    recommendedConfig: target.recommendedConfig ? { ...target.recommendedConfig, permissions: target.recommendedConfig.permissions ? { ...target.recommendedConfig.permissions } : undefined } : undefined,
    requiredPermissions: target.requiredPermissions ? { ...target.requiredPermissions, mcpServers: target.requiredPermissions.mcpServers ? [...target.requiredPermissions.mcpServers] : undefined } : undefined,
    toolRequirements: target.toolRequirements ? {
      requiredEngines: [...target.toolRequirements.requiredEngines], requiredProviders: [...target.toolRequirements.requiredProviders],
      requiredMcpServers: [...target.toolRequirements.requiredMcpServers], requiredSkills: [...target.toolRequirements.requiredSkills],
      optionalTools: [...target.toolRequirements.optionalTools],
    } : undefined,
  };
}

function slugify(s: string): string {
  const base = (s || "agent").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "agent";
}

function genAgentId(existing: Set<string>, role: string): string {
  const base = slugify(role);
  let id = base, n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  return id;
}

function genSeedId(existing: Set<string>): string {
  let id = `seed-${Math.random().toString(36).slice(2, 8)}`;
  while (existing.has(id)) id = `seed-${Math.random().toString(36).slice(2, 8)}`;
  return id;
}

function agentSummary(a: AgentNodeConfig) {
  return { id: a.id, name: a.name, role: a.role, parentId: a.parentId, provider: a.provider, model: a.model, framework: a.framework };
}

const ok = (op: CompanyEditOperation, diff: CompanyEditDiffEntry[], reason?: string): CompanyEditOpResult =>
  ({ op, ok: true, applied: diff.length > 0, reason: diff.length > 0 ? reason : (reason ?? "没有实际变化"), diff });
const fail = (op: CompanyEditOperation, reason: string): CompanyEditOpResult => ({ op, ok: false, applied: false, reason, diff: [] });

// 单条 operation 在 target(工作副本)上落地——找不到引用/冲突时不抛异常,原样标注 ok:false 并继续
// (与 applyArchitectActions 同一原则:一条坏引用不该拖累整批;是否整体阻断由 validate 层的
// errors/apply_allowed 决定,这里只负责"逐条尝试")。
function applyOne(target: CompanyEditTarget, op: CompanyEditOperation): CompanyEditOpResult {
  switch (op.op) {
    case "add_agent": {
      const existingIds = new Set(target.agents.map(a => a.id));
      let agentId = op.agent.agentId;
      if (agentId) {
        if (existingIds.has(agentId)) return fail(op, `agent_id「${agentId}」已存在,存在冲突`);
      } else {
        agentId = genAgentId(existingIds, op.agent.role);
      }
      let parentId: string | undefined;
      if (op.agent.parentId) {
        if (!existingIds.has(op.agent.parentId)) return fail(op, `未找到汇报对象 agent_id「${op.agent.parentId}」`);
        parentId = op.agent.parentId;
      }
      let workingDirectory: string | undefined;
      if (op.agent.workingDirectory) {
        const validated = validateAgentWorkingDirectory(op.agent.workingDirectory);
        if (!validated.ok) return fail(op, validated.error);
        workingDirectory = validated.normalized;
      }
      const node: AgentNodeConfig = {
        id: agentId, name: op.agent.name, role: op.agent.role, parentId, childrenIds: [],
        model: op.agent.model || "", provider: op.agent.provider || "",
        framework: (op.agent.framework as AgentNodeConfig["framework"]) || "api",
        status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
        editable: true, deletable: true, enabled: op.agent.enabled ?? true,
        workingDirectory,
        systemPrompt: op.agent.systemPrompt,
        visibilityPolicy: op.agent.visibilityPolicy,
        reasoningEffort: op.agent.reasoningEffort,
      };
      target.agents.push(node);
      if (parentId) {
        const parent = target.agents.find(a => a.id === parentId)!;
        if (!parent.childrenIds.includes(agentId)) parent.childrenIds.push(agentId);
      }
      return ok(op, [{ field: `agents.${agentId}`, before: null, after: agentSummary(node) }]);
    }

    case "remove_agent": {
      const idx = target.agents.findIndex(a => a.id === op.agentId);
      if (idx === -1) return fail(op, `未找到 agent_id「${op.agentId}」`);
      const removed = target.agents[idx];
      target.agents.splice(idx, 1);
      // 不级联删除:子节点提升为顶层(parentId 清空),父级的 childrenIds 摘除对它的引用。
      let orphaned = 0;
      for (const a of target.agents) {
        if (a.parentId === removed.id) { a.parentId = undefined; orphaned++; }
        if (a.childrenIds.includes(removed.id)) a.childrenIds = a.childrenIds.filter(c => c !== removed.id);
      }
      const reason = orphaned > 0
        ? `已移除「${removed.name}」;${orphaned} 个原下属被提升为顶层,请确认新的汇报关系`
        : `已移除「${removed.name}」`;
      return ok(op, [{ field: `agents.${removed.id}`, before: agentSummary(removed), after: null }], reason);
    }

    case "update_agent": {
      const a = target.agents.find(x => x.id === op.agentId);
      if (!a) return fail(op, `未找到 agent_id「${op.agentId}」`);
      const patch = op.patch;
      if (patch.parentId !== undefined && patch.parentId) {
        if (!target.agents.some(x => x.id === patch.parentId)) return fail(op, `未找到汇报对象 agent_id「${patch.parentId}」`);
        if (patch.parentId === a.id) return fail(op, "不能把自己设为自己的汇报对象");
      }
      const diff: CompanyEditDiffEntry[] = [];
      (["name", "role", "provider", "model"] as const).forEach((k) => {
        const v = patch[k];
        if (v !== undefined && v !== a[k]) { diff.push({ field: `agents.${a.id}.${k}`, before: a[k], after: v }); (a as any)[k] = v; }
      });
      if (patch.framework !== undefined && patch.framework !== a.framework) {
        diff.push({ field: `agents.${a.id}.framework`, before: a.framework, after: patch.framework });
        a.framework = patch.framework as AgentNodeConfig["framework"];
      }
      if (patch.workingDirectory !== undefined) {
        const normalized = patch.workingDirectory === null ? undefined : validateAgentWorkingDirectory(patch.workingDirectory);
        if (normalized && !normalized.ok) return fail(op, normalized.error);
        const value = normalized ? normalized.normalized : undefined;
        if (value !== a.workingDirectory) {
          diff.push({ field: `agents.${a.id}.workingDirectory`, before: a.workingDirectory, after: value });
          a.workingDirectory = value;
        }
      }
      for (const key of ["systemPrompt", "visibilityPolicy", "reasoningEffort"] as const) {
        if (patch[key] !== undefined) {
          const value = patch[key] === null ? undefined : patch[key];
          if (value !== a[key]) {
            diff.push({ field: `agents.${a.id}.${key}`, before: a[key], after: value });
            (a as any)[key] = value;
          }
        }
      }
      if (patch.enabled !== undefined && patch.enabled !== a.enabled) {
        diff.push({ field: `agents.${a.id}.enabled`, before: a.enabled, after: patch.enabled });
        a.enabled = patch.enabled;
      }
      if (patch.parentId !== undefined && patch.parentId !== a.parentId) {
        const oldParent = a.parentId ? target.agents.find(x => x.id === a.parentId) : undefined;
        if (oldParent) oldParent.childrenIds = oldParent.childrenIds.filter(c => c !== a.id);
        diff.push({ field: `agents.${a.id}.parentId`, before: a.parentId, after: patch.parentId || undefined });
        a.parentId = patch.parentId || undefined;
        if (a.parentId) {
          const newParent = target.agents.find(x => x.id === a.parentId)!;
          if (!newParent.childrenIds.includes(a.id)) newParent.childrenIds.push(a.id);
        }
      }
      return ok(op, diff);
    }

    case "add_edge": {
      if (op.from === op.to) return fail(op, "不能汇报给自己");
      const from = target.agents.find(a => a.id === op.from);
      const to = target.agents.find(a => a.id === op.to);
      if (!from) return fail(op, `未找到 agent_id「${op.from}」`);
      if (!to) return fail(op, `未找到 agent_id「${op.to}」`);
      if (to.parentId === from.id) return fail(op, "这条汇报边已存在");
      const before = to.parentId;
      const oldParent = to.parentId ? target.agents.find(a => a.id === to.parentId) : undefined;
      if (oldParent) oldParent.childrenIds = oldParent.childrenIds.filter(c => c !== to.id);
      to.parentId = from.id;
      if (!from.childrenIds.includes(to.id)) from.childrenIds.push(to.id);
      return ok(op, [{ field: `agents.${to.id}.parentId`, before, after: from.id }]);
    }

    case "remove_edge": {
      const to = target.agents.find(a => a.id === op.to);
      if (!to) return fail(op, `未找到 agent_id「${op.to}」`);
      if (to.parentId !== op.from) return fail(op, "未找到匹配的汇报边");
      const from = target.agents.find(a => a.id === op.from);
      if (from) from.childrenIds = from.childrenIds.filter(c => c !== to.id);
      const before = to.parentId;
      to.parentId = undefined;
      return ok(op, [{ field: `agents.${to.id}.parentId`, before, after: undefined }]);
    }

    case "rename_company": {
      if (op.name === target.title) return ok(op, []);
      const before = target.title;
      target.title = op.name;
      return ok(op, [{ field: "title", before, after: op.name }]);
    }

    case "update_description": {
      if (op.description === target.description) return ok(op, []);
      const before = target.description;
      target.description = op.description;
      return ok(op, [{ field: "description", before, after: op.description }]);
    }

    case "update_a2a_policy": {
      if (op.from === op.to) return fail(op, "不能与自己开通道");
      if (!target.agents.some(a => a.id === op.from)) return fail(op, `未找到 agent_id「${op.from}」`);
      if (!target.agents.some(a => a.id === op.to)) return fail(op, `未找到 agent_id「${op.to}」`);
      const channels = target.a2aChannels ?? [];
      const match = channels.find(c => (c.from === op.from && c.to === op.to) || (c.from === op.to && c.to === op.from));
      if (op.action === "remove") {
        if (!match) return fail(op, "未找到匹配的协作通道");
        target.a2aChannels = channels.filter(c => c !== match);
        return ok(op, [{ field: "a2aChannels", before: match, after: null }]);
      }
      if (match) return fail(op, "这条协作通道已存在");
      const entry = { from: op.from, to: op.to, purpose: op.purpose };
      target.a2aChannels = [...channels, entry];
      return ok(op, [{ field: "a2aChannels", before: null, after: entry }]);
    }

    case "add_verification_edge": {
      const refExists = (ref: string) => ref === "*" || target.agents.some(a => a.id === ref || a.role === ref);
      if (!refExists(op.edge.producer)) return fail(op, `未找到生产者引用「${op.edge.producer}」`);
      if (!refExists(op.edge.verifier)) return fail(op, `未找到核验者引用「${op.edge.verifier}」`);
      const edges = target.workflow?.verificationEdges ?? [];
      if (edges.some(edge => edge.producer === op.edge.producer && edge.verifier === op.edge.verifier)) return fail(op, "这条验证关系已存在");
      const edge = { ...op.edge };
      target.workflow = { ...(target.workflow ?? {}), verificationEdges: [...edges, edge] };
      return ok(op, [{ field: "workflow.verificationEdges", before: null, after: edge }]);
    }

    case "remove_verification_edge": {
      const edges = target.workflow?.verificationEdges ?? [];
      const match = edges.find(edge => edge.producer === op.producer && edge.verifier === op.verifier);
      if (!match) return fail(op, "未找到匹配的验证关系");
      target.workflow = { ...(target.workflow ?? {}), verificationEdges: edges.filter(edge => edge !== match) };
      return ok(op, [{ field: "workflow.verificationEdges", before: match, after: null }]);
    }

    case "upsert_bundled_skill": {
      const knownRoles = new Set(target.agents.map(agent => agent.role));
      const unknownRoles = (op.skill.roles ?? []).filter(role => !knownRoles.has(role));
      if (unknownRoles.length > 0) return fail(op, `Skill 绑定了不存在的角色:${unknownRoles.join(", ")}`);
      const skills = target.bundledSkills ?? [];
      const index = skills.findIndex(skill => skill.name === op.skill.name);
      const before = index >= 0 ? skills[index] : null;
      const next = skills.map(skill => ({ ...skill, roles: skill.roles ? [...skill.roles] : undefined }));
      if (index >= 0) next[index] = { ...op.skill, roles: op.skill.roles ? [...op.skill.roles] : undefined };
      else next.push({ ...op.skill, roles: op.skill.roles ? [...op.skill.roles] : undefined });
      target.bundledSkills = next;
      return ok(op, [{ field: "bundledSkills", before, after: op.skill }]);
    }

    case "remove_bundled_skill": {
      const skills = target.bundledSkills ?? [];
      const match = skills.find(skill => skill.name === op.name);
      if (!match) return fail(op, `未找到 Skill「${op.name}」`);
      target.bundledSkills = skills.filter(skill => skill !== match);
      return ok(op, [{ field: "bundledSkills", before: match, after: null }]);
    }

    case "update_company_governance": {
      const diff: CompanyEditDiffEntry[] = [];
      for (const key of ["visibilityPolicy", "recommendedConfig", "requiredPermissions", "toolRequirements"] as const) {
        if (op.patch[key] === undefined) continue;
        const next = op.patch[key] === null ? undefined : structuredClone(op.patch[key]);
        if (!deepEqual(target[key], next)) {
          diff.push({ field: key, before: target[key], after: next });
          (target as any)[key] = next;
        }
      }
      return ok(op, diff);
    }
    // ── C11 收敛:三种有 canonical 字段的 op 完整落地(seedMemories/defaultTasks/mcpRequirements)──
    case "add_memory_seed": {
      const seeds = target.seedMemories ?? [];
      const existingIds = new Set(seeds.map(s => s.memory_id));
      let memoryId = op.seed.memory_id;
      if (memoryId) {
        if (existingIds.has(memoryId)) return fail(op, `memory_id「${memoryId}」已存在,存在冲突`);
      } else {
        memoryId = genSeedId(existingIds);
      }
      const nowIso = new Date().toISOString();
      const record = {
        memory_id: memoryId,
        scope: op.seed.scope ?? "",
        owner_type: op.seed.owner_type,
        owner_id: op.seed.owner_id ?? "",
        content: op.seed.content,
        source: { type: "architect", run_id: "", task_id: "" },
        level: op.seed.level,
        score: 0,
        status: "active" as const,
        tags: op.seed.tags ?? [],
        metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
        created_at: nowIso,
        updated_at: nowIso,
        last_used_at: "",
      };
      target.seedMemories = [...seeds, record];
      return ok(op, [{ field: `seedMemories.${memoryId}`, before: null, after: { memory_id: memoryId, owner_type: record.owner_type, level: record.level, content: record.content.slice(0, 120) } }]);
    }

    case "add_default_mission": {
      const tasks = target.defaultTasks ?? [];
      const norm = (g: string) => g.trim().toLowerCase();
      if (tasks.some(t => norm(t.goal) === norm(op.mission.goal))) return fail(op, "已存在相同目标的示例任务");
      const entry = { title: op.mission.title, goal: op.mission.goal, suggestedRole: op.mission.suggestedRole };
      target.defaultTasks = [...tasks, entry];
      return ok(op, [{ field: "defaultTasks", before: null, after: entry }]);
    }

    case "update_capability_requirement": {
      const reqs = target.mcpRequirements ?? [];
      const match = reqs.find(r => r.name === op.requirement.name);
      if (op.requirement.action === "remove") {
        if (!match) return fail(op, `未找到能力需求「${op.requirement.name}」`);
        target.mcpRequirements = reqs.filter(r => r !== match);
        return ok(op, [{ field: "mcpRequirements", before: match, after: null }]);
      }
      if (match) return fail(op, `能力需求「${op.requirement.name}」已声明`);
      const entry = { name: op.requirement.name, purpose: op.requirement.purpose, optional: op.requirement.optional };
      target.mcpRequirements = [...reqs, entry];
      return ok(op, [{ field: "mcpRequirements", before: null, after: entry }]);
    }
  }
}

export function applyCompanyEditOperations(
  target: CompanyEditTarget,
  operations: CompanyEditOperation[],
): { target: CompanyEditTarget; results: CompanyEditOpResult[] } {
  const working = cloneTarget(target);
  const results = operations.map(op => applyOne(working, op));
  return { target: working, results };
}

// dangerFlags(templateTrust.ts)只读 recommendedConfig/agents/requiredPermissions/toolRequirements,
// 均为可选字段——传入只含 agents 的裁剪对象在运行时是安全的;cast 只是为了满足 CompanyTemplate 的
// 类型形状,避免为了这一次权限判断就要伪造 author/createdAt/tags 等一堆无关必填字段。
function dangerFlagsFor(target: CompanyEditTarget): string[] {
  return dangerFlags(target as unknown as CompanyTemplate);
}

// ── 令三.7 · 自由文本 prompt-injection + 敏感内容扫描 ──────────────────────────────────
// operations 里"会被新写入草稿的自由文本"(成员名/公司名/描述/通道用途/记忆正文/示例任务/能力用途)
// 过两道扫描:①scanContentSafety(templateDoctor,密钥形态 + 本机绝对路径,与工坊入库/分享同一防线);
// ②本地 prompt-injection 模式(ignore previous instructions 类越权指令注入)。命中 → validate 报 error
// 拒绝(与 scanContentSafety 的 error 语义一致)。只扫 operations 新写入的自由文本,不扫 target 里用户
// 自己已有的 title/description(那是既有草稿内容,不是本批注入面),避免误伤存量草稿。
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|the\s+)*(?:previous|above|prior|earlier|preceding)\s+(?:instructions?|prompts?|messages?|context|rules?)/i,
  /disregard\s+(?:all\s+|the\s+|any\s+)*(?:previous|above|prior|earlier|system)\s+/i,
  /忽略(?:掉)?(?:之前|以上|上述|前面|先前|所有)*(?:的)?(?:所有)?(?:指令|指示|提示词?|要求|规则|上下文)/,
  /(?:reveal|expose|print|leak|show me)\s+(?:the\s+|your\s+)*(?:system\s*prompt|api[_\s-]?key|secret|password)/i,
  /(?:泄露|输出|打印|告诉我|显示)(?:你的|系统)?(?:系统提示词?|系统指令|密钥|api\s*key|口令|密码)/,
];

function operationFreeTextFields(op: CompanyEditOperation): string[] {
  switch (op.op) {
    case "add_agent": return [op.agent.name, op.agent.role];
    case "update_agent": return [op.patch.name, op.patch.role].filter((v): v is string => typeof v === "string");
    case "rename_company": return [op.name];
    case "update_description": return [op.description];
    case "update_a2a_policy": return op.purpose ? [op.purpose] : [];
    case "add_memory_seed": return [op.seed.content, op.seed.scope ?? "", ...(op.seed.tags ?? [])];
    case "add_default_mission": return [op.mission.title, op.mission.goal, op.mission.suggestedRole ?? ""];
    case "update_capability_requirement": return [op.requirement.name, op.requirement.purpose ?? ""];
    case "upsert_bundled_skill": return [op.skill.name, op.skill.description ?? "", op.skill.content, ...(op.skill.roles ?? [])];
    case "remove_bundled_skill": return [op.name];
    case "update_company_governance": return [
      op.patch.recommendedConfig?.defaultModel ?? "",
      ...(op.patch.requiredPermissions?.mcpServers ?? []),
      ...(op.patch.toolRequirements?.requiredEngines ?? []),
      ...(op.patch.toolRequirements?.requiredProviders ?? []),
      ...(op.patch.toolRequirements?.requiredMcpServers ?? []),
      ...(op.patch.toolRequirements?.requiredSkills ?? []),
      ...(op.patch.toolRequirements?.optionalTools ?? []),
    ];
    default: return [];
  }
}

// 通用自由文本扫描:一批文本值 → 命中错误清单(空 = 干净)。同一类命中去重(密钥/路径/注入各只报一次)。
// 草稿侧(operations)与活公司侧(architect actions 的 name/purpose)共用同一份防线(勿各写一份)。
export function scanFreeTextValues(texts: string[]): string[] {
  const nonEmpty = texts.filter(t => typeof t === "string" && t.length > 0);
  if (nonEmpty.length === 0) return [];
  const errors = new Set<string>();
  // ① 密钥 / 本机路径(schema-agnostic 内容级扫描;整批序列化一次即可)。
  for (const f of scanContentSafety(nonEmpty)) errors.add(f.message);
  // ② prompt-injection 越权指令。
  if (nonEmpty.some(t => INJECTION_PATTERNS.some(re => re.test(t)))) {
    errors.add("检测到疑似 prompt-injection 越权指令(如「忽略之前的指令」类),拒绝写入");
  }
  return [...errors];
}

// 草稿侧 operations 的自由文本扫描(令三.7)。
export function scanCompanyEditFreeText(operations: CompanyEditOperation[]): string[] {
  const texts: string[] = [];
  for (const op of operations) for (const t of operationFreeTextFields(op)) if (t) texts.push(t);
  return scanFreeTextValues(texts);
}

// Studio Core 的校验网关(指南 11.11):校验 operations → agent_id 冲突 → 组织成环 → A2A policy 合法 →
// 权限是否过宽 → 生成 diff preview。前三类阻断(errors,apply_allowed:false);权限扩张/删除员工/
// 暂不支持的操作类型只作提示(warnings),不阻断——它们是"必须让用户看见",不是"结构上不可行"。
export function validateCompanyEditOperations(
  target: CompanyEditTarget,
  operations: CompanyEditOperation[],
): CompanyEditValidationReport {
  const { target: after, results } = applyCompanyEditOperations(target, operations);
  const errors: string[] = [];
  const warnings: string[] = [];
  const appliedTypes = new Set<string>(COMPANY_EDIT_OPERATION_APPLIED_TYPES as readonly string[]);

  for (const r of results) {
    if (!r.ok) {
      if (appliedTypes.has(r.op.op)) errors.push(`[${r.op.op}] ${r.reason ?? "操作失败"}`);
      else warnings.push(`[${r.op.op}] ${r.reason ?? "暂不支持"}`);
    } else if (r.op.op === "remove_agent") {
      warnings.push(`[remove_agent] ${r.reason} —— 删除员工是高风险操作,请确认后再应用`);
    }
  }

  // 组织成环:多条 add_edge 单条看都合法,合起来可能成环(如 A→B、B→A),必须在整批应用后统一检查。
  if (orgHasCycle(after.agents)) errors.push("组织汇报链成环:按当前 operations 应用后 parentId 链存在循环,拒绝应用");

  // agent_id 重复的兜底二次核对(applyOne 已经逐条拦过冲突;这里对最终结果再核一遍,双重保险不改变行为)。
  const idCounts = new Map<string, number>();
  for (const a of after.agents) idCounts.set(a.id, (idCounts.get(a.id) ?? 0) + 1);
  for (const [id, n] of idCounts) if (n > 1) errors.push(`agent_id「${id}」重复`);

  const expanded = dangerFlagsFor(after).filter(f => !dangerFlagsFor(target).includes(f));
  if (expanded.length > 0) warnings.push(`权限范围扩大:新增「${expanded.join("、")}」,涉及权限扩张,请向用户明确告知风险`);

  // 令三.7:自由文本 prompt-injection / 敏感内容命中 → 阻断级 error(拒绝写入草稿)。
  for (const msg of scanCompanyEditFreeText(operations)) errors.push(`[内容安全] ${msg}`);

  const status: CompanyEditValidationReport["status"] = errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "pass";
  return { status, opResults: results, errors, warnings, apply_allowed: errors.length === 0, template: after, permissionExpanded: expanded.length > 0 };
}

// ── C(波4)· 变更前后 hash:规范化 JSON(key 排序、undefined 剥离,与 JSON 往返语义一致)的 sha256。
// 用于 proposal 记录持久化 targetBeforeHash/targetAfterHash,rollback 端点据此判断"目标草稿是否已被
// 后续编辑",避免把陈旧快照直接盖回一个已经改动过的草稿。纯确定性函数,不碰 fs/网络。
function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(x => stableStringify(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter(k => o[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

// 通用规范化 sha256(任意值),供活公司侧(architectRoutes /architect-apply 事务台账)复用同一份
// 确定性 hash——避免为草稿侧/活公司侧各写一份 stableStringify+sha256(勿复制粘贴)。
export function stableHash(v: unknown): string {
  return createHash("sha256").update(stableStringify(v)).digest("hex");
}

export function hashCompanyEditTarget(target: CompanyEditTarget): string {
  return stableHash(target);
}

// ── C(波4)· 高危 operation 二次确认(用户令「权限扩大、删除员工、变更 MCP/A2A 必须二次确认」)。
// 高危集按 op 类型判定:remove_agent(删除员工)、update_a2a_policy(A2A 协作通道变更)、
// update_capability_requirement(MCP 能力需求变更);外加 validate 检测到的权限面扩大(permissionExpanded)。
// apply 端点凭这个列表走令三.4 一次性 confirmationToken 门:命中高危而未带 token → 428 并随体
// 签发 {highRisk,confirmationToken},带回后放行(客户端布尔 confirmHighRisk 已废)。
export interface CompanyEditHighRiskFlag {
  op: string;   // 触发高危的 operation 类型(权限扩大用合成标记 "permission_expansion")
  kind: "remove_agent" | "a2a" | "mcp" | "permission_expansion";
  detail: string; // 人读要点(被删员工 id / 通道方向 / 能力名 等)
}

const HIGH_RISK_OP_TYPES = new Set<CompanyEditOperation["op"]>(["remove_agent", "update_a2a_policy", "update_capability_requirement", "update_company_governance"]);

export function collectHighRiskFlags(
  operations: CompanyEditOperation[],
  report: Pick<CompanyEditValidationReport, "permissionExpanded">,
): CompanyEditHighRiskFlag[] {
  const flags: CompanyEditHighRiskFlag[] = [];
  for (const op of operations) {
    if (!HIGH_RISK_OP_TYPES.has(op.op)) continue;
    if (op.op === "remove_agent") flags.push({ op: op.op, kind: "remove_agent", detail: op.agentId });
    else if (op.op === "update_a2a_policy") flags.push({ op: op.op, kind: "a2a", detail: `${op.from} ↔ ${op.to} (${op.action})` });
    else if (op.op === "update_capability_requirement") flags.push({ op: op.op, kind: "mcp", detail: `${op.requirement.name} (${op.requirement.action})` });
    else if (op.op === "update_company_governance") flags.push({ op: op.op, kind: "permission_expansion", detail: "company governance" });
  }
  if (report.permissionExpanded) flags.push({ op: "permission_expansion", kind: "permission_expansion", detail: "" });
  return flags;
}

// C11 · fidelity ledger 接线(契约第 11 条"每一种 proposal 必须具备 fidelity ledger"):apply 前后跑
// buildLedger,量化"哪些字段被有意改动、哪些字段本该保真"。被 operations 触及的顶层字段(有 opResult
// diff 的)判 intentionally_transformed(runtime-reset 之外的有意改动 → transformKind:new-id 兜底人读),
// 未触及的顶层设计字段判 preserved——任何"本该保真却漂移"的字段会被 buildLedger 判 lost。apply 端点在
// lost>0 时拒绝落地(降级 400),把"AI 改动静默污染了不该动的字段"这条路径封死。
const LEDGER_TOP_FIELDS = ["title", "description", "agents", "workflow", "a2aChannels", "mcpRequirements", "defaultTasks", "seedMemories", "bundledSkills", "visibilityPolicy", "recommendedConfig", "requiredPermissions", "toolRequirements"] as const;

export function buildCompanyEditLedger(
  before: CompanyEditTarget,
  after: CompanyEditTarget,
  results: CompanyEditOpResult[],
): FidelityLedger {
  // 收集被有意改动的顶层字段名(opResult.diff 的 field 前缀,如 "agents.x.name" → "agents")。
  const touched = new Set<string>();
  for (const r of results) {
    if (!r.applied) continue;
    for (const d of r.diff) {
      const top = d.field.split(".")[0].split("[")[0];
      if ((LEDGER_TOP_FIELDS as readonly string[]).includes(top)) touched.add(top);
    }
  }
  const specs: FieldSpec[] = LEDGER_TOP_FIELDS.map((key) => {
    const src = (before as Record<string, unknown>)[key];
    const rt = (after as Record<string, unknown>)[key];
    if (touched.has(key)) {
      return { field: `company.${key}`, expect: "intentionally_transformed" as const, source: src, roundTrip: rt, transformKind: "new-id" as const, note: "AI 架构师有意改动" };
    }
    return { field: `company.${key}`, expect: "preserved" as const, source: src, roundTrip: rt };
  });
  return buildLedger(specs);
}

export function summarizeCompanyEditLedger(ledger: FidelityLedger): { fieldCount: number; preserved: number; intentionally_transformed: number; lost: number } {
  return {
    fieldCount: ledger.verdicts.length,
    preserved: ledger.counts.preserved,
    intentionally_transformed: ledger.counts.intentionally_transformed,
    lost: ledger.counts.lost,
  };
}

// ── C(波4)· 活公司 architect-apply 的 fidelity ledger(复用草稿侧 buildCompanyEditLedger 的思路,
// 换成活公司受影响面的三个顶层字段:agents / workflow / presetChannels)。被 actions 触及的字段判
// intentionally_transformed(有意改动,恰好没变也不算丢失),未触及的判 preserved——任何"本该保真却
// 静默漂移"的字段 buildLedger 会判 lost。architectRoutes /architect-apply 在 lost>0 时回滚+拒绝,把
// "actions 落地时污染了不该动的字段"这条路径封死。纯确定性函数,不碰 fs/网络。
export type ArchitectApplyField = "agents" | "workflow" | "presetChannels" | "governance" | "bundledSkills";
const ARCHITECT_APPLY_FIELDS: readonly ArchitectApplyField[] = [
  "agents",
  "workflow",
  "presetChannels",
  "governance",
  "bundledSkills",
];

export function buildArchitectApplyLedger(
  before: Record<ArchitectApplyField, unknown>,
  after: Record<ArchitectApplyField, unknown>,
  touched: ReadonlySet<ArchitectApplyField>,
): FidelityLedger {
  const specs: FieldSpec[] = ARCHITECT_APPLY_FIELDS.map((key) => {
    const src = before[key];
    const rt = after[key];
    if (touched.has(key)) {
      return { field: `company.${key}`, expect: "intentionally_transformed" as const, source: src, roundTrip: rt, transformKind: "new-id" as const, note: "架构师有意改动" };
    }
    return { field: `company.${key}`, expect: "preserved" as const, source: src, roundTrip: rt };
  });
  return buildLedger(specs);
}
