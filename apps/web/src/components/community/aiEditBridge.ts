// D7 · WorkshopDraft ↔ CompanyEditTarget 互转(AI 辅助编辑的桥接层)。
//
// 设计决策:AI 编辑操作的对象是"公司草稿",不是发布态的 CompanyTemplate——workshopTypes.ts 的
// buildPayload() 会把草稿换算成一份完整、id 经过 slugify 重排的 CompanyTemplate(还会顺带抽取
// persona 文本),那是"保存"这个动作专用的换算,字段比这里需要的多得多。这里保持更轻量的 1:1 映射:
// 直接拿 WorkshopCard.key 当 CompanyEditTarget 里的 agentId——不重新分配 id——这样 AI 提议的
// add_agent/update_agent/remove_agent/add_edge/remove_edge 操作里出现的 agent_id,能在"应用回草稿"
// 这一步不做任何换算地直接对上 draft.cards 的 key,不需要额外维护一份 id 映射表。
import type { AgentNodeConfig, CompanyEditTarget } from "@opc/shared";
import { newCard, genKey, type WorkshopDraft, type WorkshopCard, type WorkshopA2AChannel } from "./workshopTypes.js";

export function draftToEditTarget(draft: WorkshopDraft): CompanyEditTarget {
  const childrenOf = new Map<string, string[]>();
  for (const c of draft.cards) childrenOf.set(c.key, []);
  for (const c of draft.cards) {
    if (c.reportsTo && childrenOf.has(c.reportsTo)) childrenOf.get(c.reportsTo)!.push(c.key);
  }
  const agents: AgentNodeConfig[] = draft.cards.map(c => ({
    ...(c.passthrough ?? {}),
    id: c.key,
    name: c.name,
    role: c.role,
    parentId: c.reportsTo || undefined,
    childrenIds: childrenOf.get(c.key) || [],
    model: c.model,
    provider: c.provider,
    framework: c.framework,
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0,
    editable: c.passthrough?.editable ?? true,
    deletable: c.passthrough?.deletable ?? true,
    enabled: c.passthrough?.enabled ?? true,
    systemPrompt: c.systemPrompt || undefined,
  }));
  const a2aChannels = draft.a2aChannels
    .filter(c => c.from && c.to)
    .map(c => ({ from: c.from, to: c.to, purpose: c.purpose || undefined, direction: c.direction, authPolicy: c.authPolicy, enabled: c.enabled }));
  // C11 收敛:三种 canonical 字段(mcpRequirements/defaultTasks/seedMemories)双向桥接,否则 AI 的
  // add_memory_seed/add_default_mission/update_capability_requirement 落地后写回草稿时会被静默丢。
  const mcpRequirements = draft.mcpRequirements
    .filter(m => m.name)
    .map(m => ({ name: m.name, purpose: m.purpose || undefined, optional: m.optional || undefined }));
  return {
    id: draft.id,
    title: draft.title,
    description: draft.description,
    agents,
    workflow: draft.edges.length ? { verificationEdges: draft.edges.map(edge => ({
      producer: edge.producer, verifier: edge.verifier, method: edge.method, onReject: edge.onReject, maxRounds: edge.maxRounds,
    })) } : undefined,
    a2aChannels: a2aChannels.length ? a2aChannels : undefined,
    mcpRequirements: mcpRequirements.length ? mcpRequirements : undefined,
    bundledSkills: draft.bundledSkills.map(skill => ({ name: skill.name, description: skill.description || undefined, content: skill.content, roles: skill.roles.length ? [...skill.roles] : undefined })),
    defaultTasks: draft.defaultTasks,
    seedMemories: draft.seedMemories,
    visibilityPolicy: draft.visibilityPolicy,
    recommendedConfig: draft.recommendedConfigEnabled ? {
      ...(draft.recommendedDefaultModel.trim() ? { defaultModel: draft.recommendedDefaultModel.trim() } : {}),
      ...(draft.recommendedLegacyBudget
        ? { budget: {
            ...draft.recommendedLegacyBudget,
            ...((Number(draft.recommendedMaxTokensPerTask) || 0) > 0
              ? { maxTokensPerTask: Number(draft.recommendedMaxTokensPerTask) }
              : {}),
          } }
        : ((Number(draft.recommendedMaxTokensPerTask) || 0) > 0
          ? { maxTokensPerTask: Number(draft.recommendedMaxTokensPerTask) }
          : {})),
      permissions: { allowShell: draft.recommendedAllowShell, allowFileWrite: draft.recommendedAllowFileWrite, allowWebAccess: draft.recommendedAllowWebAccess },
    } : undefined,
    requiredPermissions: draft.templatePassthrough?.requiredPermissions as CompanyEditTarget["requiredPermissions"],
    toolRequirements: draft.toolRequirements,
  };
}

// 把 apply 端点返回的最终态 CompanyEditTarget 写回草稿——保留原有卡片的 systemPrompt(target 里没有
// 这个字段,不能丢);新出现的 agentId(add_agent 生成的)直接拿它当新卡片的 key。
export function applyEditTargetToDraft(target: CompanyEditTarget, draft: WorkshopDraft): WorkshopDraft {
  const existingByKey = new Map(draft.cards.map(c => [c.key, c] as const));
  const cards: WorkshopCard[] = target.agents.map(a => {
    const existing = existingByKey.get(a.id);
    return {
      key: a.id,
      role: a.role,
      // P0-B②:AI 编辑回写保留原卡的 isPersona;新出现的 agent 按 role 是否 wk-* 反推(普通语义 role=false,
      // 不因有 systemPrompt 就自动人设化)。
      isPersona: existing?.isPersona ?? /^wk-/i.test((a.role || "").trim()),
      name: a.name,
      provider: a.provider || "",
      model: a.model || "",
      framework: a.framework,
      systemPrompt: a.systemPrompt || "",
      reportsTo: a.parentId || "",
      passthrough: {
        ...(existing?.passthrough ?? {}),
        workingDirectory: a.workingDirectory,
        visibilityPolicy: a.visibilityPolicy,
        reasoningEffort: a.reasoningEffort,
        enabled: a.enabled,
        editable: a.editable,
        deletable: a.deletable,
        genericCli: a.genericCli,
        card: a.card,
      },
    };
  });

  const existingChannelKey = new Map<string, string>();
  for (const c of draft.a2aChannels) {
    existingChannelKey.set(`${c.from}|${c.to}`, c.key);
    existingChannelKey.set(`${c.to}|${c.from}`, c.key);
  }
  const a2aChannels: WorkshopA2AChannel[] = (target.a2aChannels || []).map(c => ({
    key: existingChannelKey.get(`${c.from}|${c.to}`) || genKey(),
    from: c.from,
    to: c.to,
    purpose: c.purpose || "",
    direction: c.direction,
    authPolicy: c.authPolicy,
    enabled: c.enabled,
  }));

  // C11 收敛:把 target 里的三种 canonical 字段写回草稿(mcpRequirements 需补 key,按 name 复用既有 key)。
  const existingMcpKey = new Map(draft.mcpRequirements.map(m => [m.name, m.key] as const));
  const mcpRequirements = (target.mcpRequirements || []).map(m => ({
    key: existingMcpKey.get(m.name) || genKey(),
    name: m.name,
    purpose: m.purpose || "",
    optional: !!m.optional,
  }));

  const existingEdgeKey = new Map(draft.edges.map(edge => [`${edge.producer}|${edge.verifier}`, edge.key] as const));
  const edges = (target.workflow?.verificationEdges ?? []).map(edge => ({
    key: existingEdgeKey.get(`${edge.producer}|${edge.verifier}`) || genKey(),
    producer: edge.producer,
    verifier: edge.verifier,
    method: edge.method,
    onReject: edge.onReject,
    maxRounds: edge.maxRounds,
  }));
  const existingSkillKey = new Map(draft.bundledSkills.map(skill => [skill.name, { key: skill.key, skillId: skill.skillId }] as const));
  const bundledSkills = (target.bundledSkills ?? []).map(skill => ({
    key: existingSkillKey.get(skill.name)?.key || genKey(),
    skillId: existingSkillKey.get(skill.name)?.skillId || `architect-${skill.name}`,
    name: skill.name,
    description: skill.description || "",
    content: skill.content,
    roles: [...(skill.roles ?? [])],
  }));
  const recommended = target.recommendedConfig;
  return {
    ...draft,
    title: target.title,
    description: target.description,
    cards: cards.length ? cards : [newCard({ role: "ceo", name: "CEO" })],
    edges,
    bundledSkills,
    a2aChannels,
    mcpRequirements,
    defaultTasks: target.defaultTasks,
    seedMemories: target.seedMemories,
    visibilityPolicy: target.visibilityPolicy,
    toolRequirements: target.toolRequirements,
    recommendedConfigEnabled: !!recommended,
    recommendedDefaultModel: recommended?.defaultModel ?? "",
    recommendedMaxTokensPerTask: recommended?.maxTokensPerTask
      ? String(recommended.maxTokensPerTask)
      : (recommended?.budget ? String(recommended.budget.maxTokensPerTask) : ""),
    recommendedLegacyBudget: recommended?.budget ? { ...recommended.budget } : undefined,
    recommendedAllowShell: recommended?.permissions?.allowShell ?? false,
    recommendedAllowFileWrite: recommended?.permissions?.allowFileWrite ?? true,
    recommendedAllowWebAccess: recommended?.permissions?.allowWebAccess ?? true,
    templatePassthrough: {
      ...(draft.templatePassthrough ?? {}),
      ...(target.requiredPermissions ? { requiredPermissions: target.requiredPermissions } : {}),
    },
  };
}
