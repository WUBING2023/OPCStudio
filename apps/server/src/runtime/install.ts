import type { AgentNodeConfig, AgentCard, CompanyTemplate, Skill, SkillMeta, McpRequirementSpec } from "@opc/shared";
import { AGENT_LOCAL_PATH_FIELDS } from "@opc/shared";
import { dangerFlags, deriveRequiredPermissions, computeTemplateHash } from "./templateTrust.js";
import { getSkill, createSkill, updateSkill, deleteSkill } from "../storage/skillStore.js";
import { listMcpServers } from "../storage/mcpStore.js";

// D1 · Safe Install Mode:社区来源(trustLevel 非 official)模板安装时**默认**剥离高危授权,
// 口径对齐 dangerFlags 的检测字段:shell 授权 / MCP 依赖授权 / 宽 A2A 预置通道(自动 grant)。
// file-write / web-access 保留(常规工作必需,风险已由确认弹窗透明展示)。调用方传
// unsafeAcknowledged:true 显式保留全部授权——这是内部选项:令四.1 起路由层只在一次性
// installConfirmationToken 校验+消费通过后才置 true(客户端布尔确认已废,后端 token 是唯一授权关口)。
// 剥离只作用于本次安装用的模板副本,不回写模板库;剥离项随安装结果返回,供 UI 如实展示。
export interface SafeInstallStrippedItem { id: string; detail: string }
export interface SafeInstallResult {
  template: CompanyTemplate;
  applied: boolean;
  stripped: SafeInstallStrippedItem[];
}

export function applySafeInstall(t: CompanyTemplate, opts: { unsafeAcknowledged?: boolean } = {}): SafeInstallResult {
  if (t.trustLevel === "official" || opts.unsafeAcknowledged) return { template: t, applied: false, stripped: [] };
  const stripped: SafeInstallStrippedItem[] = [];
  const out: CompanyTemplate = { ...t };
  const flags = dangerFlags(t);

  if (flags.includes("shell-access")) {
    // 以派生结果为底(保留 file-write/web-access 等其余声明),只关 shell 授权。
    out.requiredPermissions = { ...(t.requiredPermissions ?? deriveRequiredPermissions(t)), allowShell: false };
    if (out.recommendedConfig?.permissions) {
      out.recommendedConfig = { ...out.recommendedConfig, permissions: { ...out.recommendedConfig.permissions, allowShell: false } };
    }
    stripped.push({ id: "shell-access", detail: "已剥离 shell 执行授权(allowShell → false)" });
  }

  if (flags.includes("mcp-dependency")) {
    out.requiredPermissions = { ...(out.requiredPermissions ?? t.requiredPermissions ?? deriveRequiredPermissions(t)), mcpServers: [] };
    if (out.toolRequirements) out.toolRequirements = { ...out.toolRequirements, requiredMcpServers: [] };
    // mcpRequirements(声明"需要哪个 MCP"的提示清单)保留——它不授权,只驱动缺失提示。
    stripped.push({ id: "mcp-dependency", detail: "已剥离 MCP 依赖授权声明(mcpRequirements 仅作缺失提示保留)" });
  }

  if (t.a2aChannels?.length) {
    out.a2aChannels = undefined;
    stripped.push({ id: "preset-a2a-channels", detail: `已剥离 ${t.a2aChannels.length} 条预置 A2A 通道的自动授权(运行时可经审批开通)` });
  }

  return { template: out, applied: stripped.length > 0, stripped };
}

// Re-root a self-contained agent subtree (a company template's full org, or a team's lead+subtree)
// into a target company, remapping every id so parent/children links stay internally consistent and
// never collide with existing nodes. Roots (no parent within the subset) attach under
// `newParentForRoots` (a chosen CEO/Lead) when given, else stay top-level (a company's own CEO).
// Usage/cost/status are reset so the imported nodes start fresh.
export function rerootAgents(
  sourceAgents: AgentNodeConfig[],
  companyId: string,
  idFor: (oldId: string, index: number) => string,
  opts: { newParentForRoots?: string } = {},
): { agents: AgentNodeConfig[]; idMap: Record<string, string> } {
  const idSet = new Set(sourceAgents.map(a => a.id));
  const idMap: Record<string, string> = {};
  sourceAgents.forEach((a, i) => { idMap[a.id] = idFor(a.id, i); });

  const agents = sourceAgents.map(a => {
    const parentInSet = !!a.parentId && idSet.has(a.parentId);
    const node: AgentNodeConfig = {
      ...a,
      // 读旧写新:历史 framework 值 "hermes"(存量节点/旧模板)经这个导出与导入共用的关口归一为
      // "api"——写出的模板/Bundle 与新装的节点只出新值,存量文件本身不动(靠 schema 读侧 alias)。
      framework: a.framework === "hermes" ? "api" : a.framework,
      id: idMap[a.id],
      companyId,
      parentId: parentInSet ? idMap[a.parentId as string] : opts.newParentForRoots,
      childrenIds: (a.childrenIds || []).filter(c => idSet.has(c)).map(c => idMap[c]),
      status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      costUsd: 0,
      currentTask: undefined,
      lastAction: undefined,
    };
    // P0-4 · workspaceDir(本机工作目录绝对路径)与 cliConfigDir(本机 CLI 凭据目录)是纯机器本地
    // 路径。reroot 是"导出为模板"和"跨机导入安装"两个方向的公共关口,这里一律清空:导出侧不把作者
    // 机器的盘符/家目录路径外泄进模板/Bundle,导入侧也不让新公司指向别人机器上的凭据目录(按公司/
    // lead 默认在本机重新解析)。与上面 usage/cost/status 的 "start fresh" 复位是同一意图。
    // 收口④:清空的字段清单引用 companyFieldRegistry.AGENT_LOCAL_PATH_FIELDS(唯一真相源),行为不变。
    for (const k of AGENT_LOCAL_PATH_FIELDS) node[k] = undefined;
    return node;
  });

  return { agents, idMap };
}

// The ids that have no parent inside the subset — the roots that get attached under a chosen parent
// (used by team import to wire the team's lead as a child of the selected CEO/Lead).
export function rootIdsOf(sourceAgents: AgentNodeConfig[]): string[] {
  const idSet = new Set(sourceAgents.map(a => a.id));
  return sourceAgents.filter(a => !a.parentId || !idSet.has(a.parentId)).map(a => a.id);
}

// Build a single org node from a community AgentCard (worker import), attached under a chosen parent.
export function agentFromCard(card: AgentCard, parentId: string, companyId: string, newId: string): AgentNodeConfig {
  const a = card.agent;
  return {
    id: newId,
    name: a.name || card.title,
    role: a.expectedRole || card.role,
    parentId,
    childrenIds: [],
    model: a.recommendedModel || "",
    provider: a.recommendedProvider || "deepseek",
    framework: "api",
    companyId,
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0,
    editable: true,
    deletable: true,
    enabled: true,
  };
}

// A parent is a valid attach target for team/worker import iff it's a CEO or Lead (never a worker).
export function isValidAttachParent(role: string | undefined): boolean {
  return role === "ceo" || role === "lead";
}

// Stage 8+ · A2A 预置通道 / 打包 skill 的角色解析(install 方向)——两者共用同一条 id/role 换算约定
// (同 VerificationEdge.producer/verifier 惯例):模板里的引用可以是模板本地 agentId,也可以是 role 名;
// 先按 id 精确匹配(companyToTemplate 导出的模板,agentId 就是真实来源 id),否则退化按 role 匹配
// (workshop 手搭的模板,agentId 是 slugify 过的合成 id,role 才是作者填的语义角色)。

// a2aChannels.from/to → 换算成 rerootAgents 产出的**真实**(post-install)agent id。找不到就返回 undefined,
// 调用方需要过滤掉这类失效引用,不能让一条坏引用挡了整个安装。
// 令四.3 · canonical = agent ID;role alias 只有**唯一命中**时才解析,命中多个同 role agent → 返回
// undefined(不再静默取第一个,把 CEO→dev2 坍缩成 CEO→dev1 或解析成自环丢弃)。歧义在安装前由
// detectAmbiguousTemplateRefs 统一体检 → 整体 422,不走到这里;这里的 undefined 是纵深防御。
export function resolveTemplateAgentRef(
  templateAgents: AgentNodeConfig[],
  idMap: Record<string, string>,
  ref: string,
): string | undefined {
  if (idMap[ref]) return idMap[ref];
  const byRole = templateAgents.filter(a => a.role === ref);
  if (byRole.length !== 1) return undefined; // 0=解析不出(悬空),>1=歧义(不猜),都返回 undefined
  return idMap[byRole[0].id];
}

// 令四.3 · 引用歧义体检(安装前):模板的引用(a2aChannels.from/to)若用 role 名且该 role 在模板内
// 对应**多个** agent(且该 ref 不是某个 agent 的 canonical id),就是歧义引用——安装侧无法确定指向
// 哪个员工,必须整体 422 拒绝并返回歧义清单,让作者改用 canonical agent id。返回空数组=无歧义。
//   · canonical id 引用(ref === 某 agent.id)永远不歧义(精确);
//   · role 名唯一命中永远不歧义;role 名命中 0 个 = 悬空引用(既有口径:静默丢弃,不算歧义,不拦安装);
//   · role 名命中 ≥2 个 = 歧义,逐条列出 {ref, role, field, matchedAgentIds}。
export interface AmbiguousTemplateRef {
  ref: string;
  field: string; // 形如 "a2aChannels[2].from"
  matchedAgentIds: string[];
}

export function detectAmbiguousTemplateRefs(template: Pick<CompanyTemplate, "agents" | "a2aChannels">): AmbiguousTemplateRef[] {
  const agents = template.agents ?? [];
  const idSet = new Set(agents.map(a => a.id));
  const byRole = new Map<string, string[]>();
  for (const a of agents) {
    if (!a.role) continue;
    const arr = byRole.get(a.role) ?? [];
    arr.push(a.id);
    byRole.set(a.role, arr);
  }
  const out: AmbiguousTemplateRef[] = [];
  const check = (ref: string | undefined, field: string) => {
    if (!ref) return;
    if (idSet.has(ref)) return;          // canonical id 引用:精确,不歧义
    const matched = byRole.get(ref) ?? [];
    if (matched.length >= 2) out.push({ ref, field, matchedAgentIds: matched });
  };
  (template.a2aChannels ?? []).forEach((c, i) => {
    check(c.from, `a2aChannels[${i}].from`);
    check(c.to, `a2aChannels[${i}].to`);
  });
  return out;
}

// bundledSkills[].roles → 目标 role 名清单。作者显式列了就原样用(哪怕只覆盖团队一部分角色,那是本意);
// 没列 → 缺省绑定到**这份模板实际用到的全部角色**(而不是全局 "*"),对齐"参考 persona 的 scoped-role
// 机制防串染"的要求:全局 "*" 会让这个 skill 泄漏进本机其它公司/模板里同名角色的 agent,不是作者的本意。
export function resolveBundledSkillRoles(roles: string[] | undefined, installedRoles: string[]): string[] {
  const explicit = (roles ?? []).map(r => r.trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  return [...new Set(installedRoles.map(r => r.trim()).filter(Boolean))];
}

// skill 文件名安全 slug(skillStore.cid() 只挡 / \ .. 和 null,这里额外收窄到可读的 ascii 短横线形式)。
export function slugForSkillId(s: string): string {
  const base = (s || "skill").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "skill").slice(0, 40);
}

// C1 · bundled skill id 的**唯一**生成入口(plan/install 共用,保证预演清单与真落盘逐字节一致)。
// - companyId 有值(新装,写侧新值)→ `bundled-{tpl}-{name}--{role}--c-{company}`:同一模板装进不同公司
//   得到不同 id、各自独立落盘,互不覆盖(消灭"按 role 全局绑定 → 跨公司串染/回滚连坐"的根)。
// - companyId 无值(兼容路径 / 存量口径)→ 旧形状 `bundled-{tpl}-{name}--{role}`,与历史落盘串字节一致,
//   绝不改写存量文件/已存 tx.created.skillIds。
// cid() 的硬上限是 80:companyId 段短(8 位 uuid 片段),常规值 base+suffix 远小于 80;仅在 tpl/name/role
// 三段都被 slugForSkillId 顶到 40 的病态超长时按预算截断 base,保证生成的 id 一定合法(slug 只含
// [a-z0-9-],截断不会产出 `..`/分隔符等 cid 拦截向量)。
export function bundledSkillId(tplId: string, skillName: string, role: string, companyId?: string): string {
  const base = `bundled-${slugForSkillId(tplId)}-${slugForSkillId(skillName)}--${slugForSkillId(role)}`;
  if (!companyId) return base;
  const suffix = `--c-${slugForSkillId(companyId).slice(0, 12)}`;
  if (base.length + suffix.length <= 80) return base + suffix;
  return base.slice(0, 80 - suffix.length) + suffix;
}

// C1 · bundled 技能"是否归属某公司"的归属判定(纯函数,可单测;contextBuilder 注入过滤 / 导出圈定共用)。
// origin!=="bundled" 的技能不经此判定(调用方在外层按 origin 门控)。三级(读侧 alias,同 hermes 手法):
//   (a) meta.companyId 存在(新装)→ 精确等于该公司才算归属;别的公司的新装技能一律排除(堵泄漏)。
//   (b) legacy(无 companyId)→ 查 install transactions:存在**未回滚**且 companyId 命中、created.skillIds
//       含该 id 的 tx → 归属(merge 装进老公司的靠这级兜底)。
//   (c) 再兜底:该公司 manifestTemplateId 的 slug 前缀匹配 `bundled-{tpl}-` → 归属(覆盖"tx 已滚出 50
//       条上限"的老公司;new-company 装的 legacy 技能天然命中,因为 company.manifestTemplateId===tpl.id)。
// 三级都不中 → 不归属(legacy 且 tx 已淘汰且 manifestTemplateId 不匹配的 residual;调用方应如实登记,不静默)。
export function isBundledSkillOwnedByCompany(
  meta: Pick<SkillMeta, "id" | "companyId">,
  companyId: string | undefined,
  txs: ReadonlyArray<{ companyId: string; created: { skillIds: string[] }; rolledBack?: boolean }>,
  company: { manifestTemplateId?: string } | undefined,
): boolean {
  if (meta.companyId) return meta.companyId === companyId; // (a) 精确归属
  if (!companyId) return false;
  for (const tx of txs) {                                   // (b) 未回滚 tx 兜底
    if (tx.rolledBack) continue;
    if (tx.companyId === companyId && tx.created?.skillIds?.includes(meta.id)) return true;
  }
  const tplId = company?.manifestTemplateId;                // (c) manifestTemplateId 前缀兜底
  if (tplId && meta.id.startsWith(`bundled-${slugForSkillId(tplId)}-`)) return true;
  return false;
}

// "skill 即 worker 的能力": build a worker node carrying a skill. The skill is bound by a UNIQUE
// role (role-based injection is global, so a dedicated role isolates the ability to just this worker)
// and the worker takes that same role.
export function workerFromSkill(skill: Skill, parentId: string, companyId: string, newId: string, role: string): AgentNodeConfig {
  return {
    id: newId,
    name: skill.title,
    role,
    systemPrompt: skill.content,
    parentId,
    childrenIds: [],
    model: "deepseek-v4-pro",
    provider: "deepseek",
    framework: "api",
    companyId,
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0,
    editable: true,
    deletable: true,
    enabled: true,
  };
}

// D3 · 供合并安装(merge 模式)复用的两个小步骤,抽成独立函数——原 new-company 安装路径
// (communityRoutes.ts install/company、companyRoutes.ts installCompanyTemplate)各自内联了同一段逻辑,
// 那两处是已跑通的既有行为,不为"不重复自己"去动它们(改动即回归风险);这里只给**新增的** merge
// 分支用,同一套语义,不重新发明。

// tpl.bundledSkills → upsert 进 skill store,按角色绑定。返回成功安装的条数(单条失败不阻断整体),
// 以及 createdIds——其中"新建"(该 skill id 之前不存在)的那些,区别于"更新"(id 已存在,内容被覆盖)。
// D6 · install transaction 只把 createdIds 记进 created.skillIds,回滚才敢直接硬删:一个已存在的
// skill 被这次安装"更新"了内容,说明它在别处(另一次安装/另一个公司,skill 按 role 全局绑定不分公司)
// 已经被依赖,回滚硬删会牵连那些无关的依赖方;真正"这次安装凭空生出来的"才能安全撤销。
export interface InstallBundledSkillsResult { count: number; createdIds: string[] }

// #22(tx-first):安装事务必须先于第一笔状态写落盘,而 createdIds 要等 installBundledSkills 真跑完
// 才知道——这里按同一套 id 推导 + 存在性检查**预演**出"这次将真正新建"的 skill id 清单,供路由在写
// 状态前记 transaction。与 installBundledSkills 的唯一偏差:单条 createSkill 落盘失败(磁盘错误)时
// 计划里会多出一个实际未创建的 id——rollback 的 deleteSkill 对不存在的 id 返回 false,无害。
export function planBundledSkillCreatedIds(projectRoot: string, tpl: CompanyTemplate, installedRoles: string[], companyId: string): string[] {
  const ids = new Set<string>();
  for (const bs of tpl.bundledSkills ?? []) {
    if (!bs?.name || !bs?.content) continue;
    for (const role of resolveBundledSkillRoles(bs.roles, installedRoles)) {
      const skillId = bundledSkillId(tpl.id, bs.name, role, companyId);
      if (!getSkill(projectRoot, skillId)) ids.add(skillId);
    }
  }
  return [...ids];
}

export function installBundledSkills(projectRoot: string, tpl: CompanyTemplate, installedRoles: string[], companyId: string): InstallBundledSkillsResult {
  if (!tpl.bundledSkills?.length) return { count: 0, createdIds: [] };

  type Operation = { skillId: string; payload: Skill; previous: Skill | null };
  const operations = new Map<string, Operation>();
  const now = new Date().toISOString();

  for (const bs of tpl.bundledSkills) {
    if (!bs?.name || !bs?.content) continue;
    for (const role of resolveBundledSkillRoles(bs.roles, installedRoles)) {
      const skillId = bundledSkillId(tpl.id, bs.name, role, companyId);
      const payload: Skill = {
        id: skillId,
        title: bs.name,
        role,
        enabled: true,
        content: bs.content,
        description: bs.description,
        lastModified: now,
        license: "OPC-Original",
        origin: "bundled",
        companyId,
      };
      const duplicate = operations.get(skillId);
      if (duplicate) {
        const same = duplicate.payload.content === payload.content
          && duplicate.payload.title === payload.title
          && duplicate.payload.role === payload.role;
        if (!same) throw new Error(`bundled skill id collision: ${skillId}`);
        continue;
      }
      operations.set(skillId, { skillId, payload, previous: getSkill(projectRoot, skillId) });
    }
  }

  const attempted: Operation[] = [];
  const createdIds: string[] = [];
  try {
    for (const operation of operations.values()) {
      attempted.push(operation);
      if (operation.previous) updateSkill(projectRoot, operation.skillId, operation.payload);
      else createSkill(projectRoot, operation.payload);

      const landed = getSkill(projectRoot, operation.skillId);
      if (!landed
        || landed.content !== operation.payload.content
        || landed.title !== operation.payload.title
        || landed.role !== operation.payload.role
        || landed.companyId !== companyId
        || landed.origin !== "bundled") {
        throw new Error(`bundled skill verification failed: ${operation.skillId}`);
      }
      if (!operation.previous) createdIds.push(operation.skillId);
    }
    return { count: operations.size, createdIds };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const operation of [...attempted].reverse()) {
      try {
        const current = getSkill(projectRoot, operation.skillId);
        if (operation.previous) {
          if (current) updateSkill(projectRoot, operation.skillId, operation.previous);
          else createSkill(projectRoot, operation.previous);
        } else if (current && !deleteSkill(projectRoot, operation.skillId)) {
          throw new Error("delete returned false");
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${operation.skillId}: ${(rollbackError as Error)?.message || String(rollbackError)}`);
      }
    }
    const cause = (error as Error)?.message || String(error);
    if (rollbackErrors.length) {
      throw new Error(`bundled skill install failed: ${cause}; rollback failed: ${rollbackErrors.join("; ")}`);
    }
    throw new Error(`bundled skill install failed and was rolled back: ${cause}`);
  }
}

// 令四.1 · 一次性安装确认 token 绑定的**危险面快照**:preview 时算一份签发进 token,真装时对将落地的
// 模板再算一份逐字段比对——不符即模板在预览后被换,拒绝(见 installTransactionStore.consumeInstall...)。
// 绑定六元:templateHash(内容指纹,computeTemplateHash 排除 hash/signature/trustLevel)、trustLevel、
// dangerFlags、MCP 清单、CLI 清单、file-write 面。
export interface InstallDangerSurface {
  templateHash: string;
  trustLevel: string;
  dangerFlags: string[];
  mcp: string[];
  cli: string[];
  fileWrite: boolean;
}

export function computeInstallDangerSurface(t: CompanyTemplate): InstallDangerSurface {
  const flags = dangerFlags(t);
  const rp = t.requiredPermissions ?? deriveRequiredPermissions(t);
  const mcp = [
    ...(rp.mcpServers ?? []),
    ...((t.mcpRequirements ?? []).map(m => m?.name).filter((n): n is string => !!n)),
  ];
  const cliFrameworks = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
  const cli = t.agents
    .filter(a => (!!a.framework && cliFrameworks.has(a.framework)) || !!a.genericCli)
    .map(a => a.genericCli?.command || a.framework || "")
    .filter(Boolean);
  return {
    templateHash: computeTemplateHash(t),
    trustLevel: t.trustLevel ?? "untrusted",
    dangerFlags: [...flags].sort(),
    mcp: [...new Set(mcp)].sort(),
    cli: [...new Set(cli)].sort(),
    fileWrite: flags.includes("file-write"),
  };
}

// tpl.mcpRequirements 对照本机已配 MCP(启用且已填 command/url 才算"已配置"),算出 missing 清单。
export function computeMissingMcp(projectRoot: string, mcpRequirements?: McpRequirementSpec[]): McpRequirementSpec[] {
  if (!mcpRequirements?.length) return [];
  const localMcp = listMcpServers(projectRoot);
  const configuredNames = new Set(
    localMcp.filter(s => s.enabled && (s.transport === "http" ? !!s.url : !!s.command)).map(s => s.name.trim().toLowerCase()),
  );
  return mcpRequirements.filter(m => m?.name && !configuredNames.has(m.name.trim().toLowerCase()));
}
