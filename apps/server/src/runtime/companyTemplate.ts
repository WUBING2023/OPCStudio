import type { AgentNodeConfig, CompanyTemplate, AgentCard, BundledSkillSpec, CompanyBundle, ExportProfile, BundleAgentMemory } from "@opc/shared";
import { DEFAULT_EXPORT_PROFILE, deriveOrgTeamsAndEdges } from "@opc/shared";
import { getCompany } from "../storage/companyStore.js";
import { loadAgents, loadConfig, loadRunIndex } from "../storage/projectStore.js";
import { rerootAgents, slugForSkillId } from "./install.js";
import { collectConfiguredProviderCapabilities } from "./providerRegistry.js";
import { listSkills, getSkill } from "../storage/skillStore.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { exportMemoryRecordsForCompany, redactMemoryRecords, deriveRequiredSecrets } from "./memoryBundle.js";
import { readAgentMemory, agentMemoryPath } from "../storage/mdMemory.js";
import { createMemoryJob, updateMemoryJob, type MemoryJobRecord } from "../storage/memoryJobStore.js";

// Stage 1 · Company Template Lifecycle —— 导出方向(install.rerootAgents 的反向):
// 把一个"活公司"的 agents 子树序列化成自洽、可重新导入的 CompanyTemplate(内部 id、清零用量)。
// schema v1.5:尽量填充 toolRequirements(从 agents 派生);useCases/riskNotes 留作者补。

/** 从 agents 派生工具/引擎/provider 需求(供导入时 requirements check)。 */
export function deriveToolRequirements(agents: AgentNodeConfig[]): NonNullable<CompanyTemplate["toolRequirements"]> {
  const engines = new Set<string>();
  const providers = new Set<string>();
  for (const a of agents) {
    if (a.framework) engines.add(a.framework);
    if (a.provider) providers.add(a.provider);
  }
  return {
    requiredEngines: [...engines],
    requiredProviders: [...providers],
    requiredMcpServers: [],
    requiredSkills: [],
    optionalTools: [],
  };
}

// P0-B② · 导出 toolRequirements 的正确口径:读【原始 manifestToolRequirements】(导入时存进 Company 的,
// 含 requiredSkills / optionalTools / 作者手写 requiredMcpServers —— 这些无法从 agents 反推),而不是只
// 从 agents 重推、把作者手写字段覆盖丢光。可从 agents 推导的两项(engines/providers)与当前员工树取并集
// 保持最新(公司结构被编辑后新增的 provider/engine 也如实反映);不可推导的三项原样保留 stored。
// stored 缺失(手搭公司,从没装过模板)→ 退回纯派生。
export function resolveToolRequirements(
  stored: CompanyTemplate["toolRequirements"] | undefined,
  agents: AgentNodeConfig[],
): NonNullable<CompanyTemplate["toolRequirements"]> {
  const derived = deriveToolRequirements(agents);
  if (!stored) return derived;
  return {
    requiredEngines: [...new Set([...stored.requiredEngines, ...derived.requiredEngines])],
    requiredProviders: [...new Set([...stored.requiredProviders, ...derived.requiredProviders])],
    requiredMcpServers: stored.requiredMcpServers, // 作者手写,不可从 agents 推导 → 原样保留
    requiredSkills: stored.requiredSkills,         // 同上
    optionalTools: stored.optionalTools,           // 同上
  };
}

// bundledSkills 导出(2026-07-04 补的缺口):companyToTemplate 之前完全不生成这个字段,导出=完整备份
// 这个用途因此不成立(打包技能装得进去、导不出来)。这里按 install/company(communityRoutes.ts)真实落盘时
// 用的两种命名模式反向匹配、把技能内容找回来:
//   ① origin:"bundled",id = `bundled-{slugForSkillId(模板id)}-{slugForSkillId(技能名)}--{slugForSkillId(role)}`
//      —— 只有公司当初是通过 /api/community/install/company 装的模板才会有这类技能,而这条路径
//      每次都会把 tpl.id 记进 company.manifestTemplateId(companyStore.addCompany 无条件带上)。
//      因此 manifestTemplateId 缺失时,该公司不可能有 bundled 技能,直接跳过匹配(避免用纯 role 后缀
//      做宽松匹配、误拉到"恰好同名角色"的其它模板/公司的打包技能)。
//   ② origin:"persona",id = `sk-{role}`(install/worker 与工坊人设落盘用的精确命名,role 本身即为
//      全局唯一的 scoped role,不需要模板 id 前缀也足够精确)。
// 同一个打包技能可能按多个角色扇出成多份同内容的技能文件(install 时逐 role upsert)——这里按
// 标题+正文去重合并回一条 BundledSkillSpec,roles 收拢全部匹配到的角色。
function collectBundledSkills(
  projectRoot: string,
  manifestTemplateId: string | undefined,
  companyId: string,
  companyAgents: AgentNodeConfig[],
): BundledSkillSpec[] {
  const roles = [...new Set(companyAgents.map((a) => a.role).filter((r): r is string => !!r))];
  if (roles.length === 0) return [];
  const roleSuffix = new Map(roles.map((r) => [r, `--${slugForSkillId(r)}`]));
  const result: BundledSkillSpec[] = [];

  // ① bundled:C1 双轨反向匹配——
  //   · 新形状(meta.companyId 有值):按公司精确圈定(不再靠 endsWith(roleSuffix) 猜),role 直接取技能
  //     自报的 frontmatter role(新 id 尾部是 `--c-{company}` 而非 `--{role}`,不能再从 id 反解 role)。
  //   · legacy(无 companyId):保留 manifestTemplateId 前缀 + 当前公司角色后缀的既有匹配。
  const tplPrefix = manifestTemplateId ? `bundled-${slugForSkillId(manifestTemplateId)}-` : undefined;
  if (companyId || tplPrefix) {
    for (const meta of listSkills(projectRoot, { origin: "bundled" })) {
      let matchedRole: string | undefined;
      if (meta.companyId) {
        if (meta.companyId !== companyId) continue; // 新形状:别的公司的资产一律不圈进本公司导出
        matchedRole = meta.role || undefined;
      } else {
        if (!tplPrefix || !meta.id.startsWith(tplPrefix)) continue; // legacy:前缀精确过滤
        matchedRole = roles.find((r) => meta.id.endsWith(roleSuffix.get(r)!));
      }
      if (!matchedRole) continue;
      let full: ReturnType<typeof getSkill> = null;
      try { full = getSkill(projectRoot, meta.id); } catch { /* 坏 id 跳过,不阻断导出 */ }
      if (!full) continue;
      const existing = result.find((b) => b.name === full.title && b.content === full.content);
      if (existing) { if (!existing.roles!.includes(matchedRole)) existing.roles!.push(matchedRole); }
      else result.push({ name: full.title, description: full.description, content: full.content, roles: [matchedRole] });
    }
  }

  // ② persona:两种落盘命名都要试(逐条核实过 skillRoutes.ts 的三条孵化安装路径,命名并不统一):
  //   · worker/squad 孵化(直接建活公司,不经过模板):role 本身已按 inc-{skillId}/{tplId}-w{n} 加了
  //     唯一后缀,人设技能 id = sk-{role}(裸)。
  //   · team 孵化(先存成模板再走常规安装,安装后 company.manifestTemplateId === 该模板 id):
  //     ceo/lead 的 role 是通用名(会跨公司撞名),人设技能 id 因此多拼了一段 = sk-{role}-{模板id}
  //     (worker 的 role 本身已含模板 id,这里再拼一次是历史遗留的重复后缀,原样兼容,不改写入侧)。
  //   两种候选都试(与写入侧同款的 80 字符截断/字符替换),查到哪个用哪个;都查不到才判定该角色无人设。
  for (const role of roles) {
    const candidates = [`sk-${role}`];
    if (manifestTemplateId) candidates.push(`sk-${role}-${manifestTemplateId}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 80));
    let full: ReturnType<typeof getSkill> = null;
    for (const cid of candidates) {
      try { full = getSkill(projectRoot, cid); } catch { full = null; }
      if (full) break;
    }
    if (!full || (full.origin && full.origin !== "persona")) continue;
    result.push({ name: full.title, description: full.description, content: full.content, roles: [role] });
  }

  return result;
}

// C3 · defaultTasks 真数据源:该公司真实历史里"成功完结"run 的 goal(runs 滚动索引 _index.json,
// loadRunIndex 缺失时懒重建)——导出的示例任务是"这家公司真跑成过的任务",不是运行时臆造。口径:
//   · 只取 status done/accepted 且未降级(degraded run 的产出不是有效交付,不当成功范例导出);
//   · goal 文本去重,按索引既有排序(startedAt 降序)取最近 ≤3 条;title 取 goal 首 60 字。
// best-effort:索引读不到/该公司无成功 run → 返回空数组,调用方不产出该字段(不阻断导出)。
export function collectDefaultTasks(projectRoot: string, companyId: string): NonNullable<CompanyTemplate["defaultTasks"]> {
  const out: NonNullable<CompanyTemplate["defaultTasks"]> = [];
  try {
    const seen = new Set<string>();
    for (const e of loadRunIndex(projectRoot)) {
      if (e.companyId !== companyId) continue;
      if (e.status !== "done" && e.status !== "accepted") continue;
      if (e.degraded) continue;
      const goal = (e.goal || "").trim();
      if (!goal || seen.has(goal)) continue;
      seen.add(goal);
      out.push({ title: goal.slice(0, 60), goal });
      if (out.length >= 3) break;
    }
  } catch { /* best-effort:读索引失败不阻断导出,该字段如实缺省 */ }
  return out;
}

// P0-B③ · 合并公司持久 defaultTasks(作者手填,权威在前)与历史成功 run 采集的示例任务,按 goal 去重。
export function mergeDefaultTasks(
  persisted: NonNullable<CompanyTemplate["defaultTasks"]>,
  collected: NonNullable<CompanyTemplate["defaultTasks"]>,
): NonNullable<CompanyTemplate["defaultTasks"]> {
  const out: NonNullable<CompanyTemplate["defaultTasks"]> = [];
  const seen = new Set<string>();
  for (const t of [...persisted, ...collected]) {
    const goal = (t.goal || "").trim();
    if (!goal || seen.has(goal)) continue;
    seen.add(goal);
    out.push(t);
  }
  return out;
}

/** 把 companyId 对应的活公司导出成 CompanyTemplate(可重新导入)。绝不含密钥/用量。 */
export function companyToTemplate(projectRoot: string, companyId: string): CompanyTemplate {
  const company = getCompany(projectRoot, companyId);
  if (!company) throw new Error(`company ${companyId} not found`);
  const all = loadAgents(projectRoot, []);
  const companyAgents = all.filter((a) => a.companyId === companyId);
  if (companyAgents.length === 0) throw new Error(`company ${companyId} 没有 agent,无法导出`);

  // 反向 reroot:自洽内部 id(role-索引,稳定),companyId 置空(导入时 rerootAgents 会重设),清零用量。
  const { agents } = rerootAgents(companyAgents, "", (_old, i) => {
    const role = companyAgents[i].role || "agent";
    return `${role}-${i}`;
  });
  const tplAgents = agents.map((a) => ({ ...a, companyId: "", editable: true, deletable: true }));

  // Bug 修复(2026-07-03 审计发现):安装侧(communityRoutes.ts install/company)逐字段真落地
  // verificationEdges/a2aChannels/mcpRequirements,导出侧此前完全不读 company.workflow/presetChannels/
  // manifestMcpRequirements——"能装进去、装不出来",导出→分享→重新导入会静默丢光验证边与预置通道。
  // 验证边直接沿用 role 字符串(reroot 不改 role,天然稳定,无需换算)。
  // C9-P1 · a2aChannels 重复 role 用稳定合成 id 防串线/坍缩:presetChannels 存真实 agent id,模板 a2aChannels
  // 的 from/to 按惯例换算成 role 名(install.ts resolveTemplateAgentRef 安装时既认 id 也认 role)。但**同 role
  // 多员工**时,role 名不再唯一标识某个员工——CEO→dev2 的通道被 role 换算后与 CEO→dev1 坍缩,或 dev1↔dev2
  // 通道两端同名 role 经导入端 find-first 解析成自环被过滤丢弃。故:role 在公司内**唯一**时维持输出 role 名
  // (roundTripFidelity 冻结金样本逐字节不变);role **重复**时改用 reroot 后的稳定合成 id(`${role}-${i}`,与
  // rerootAgents 的 idFor 完全同款)。导入侧 resolveTemplateAgentRef 先查 idMap 精确命中该合成 id → 零改动、
  // schema 仍是纯 string 免 bump。换算不出来的(悬空引用)丢弃,不让整个导出失败。
  const roleCounts = new Map<string, number>();
  for (const a of companyAgents) if (a.role) roleCounts.set(a.role, (roleCounts.get(a.role) ?? 0) + 1);
  const idToRef = new Map<string, string>();
  companyAgents.forEach((a, i) => {
    if (!a.role) return;
    const dupRole = (roleCounts.get(a.role) ?? 0) > 1;
    idToRef.set(a.id, dupRole ? `${a.role}-${i}` : a.role);
  });
  const a2aChannels = (company.presetChannels ?? [])
    .map((c) => {
      const from = idToRef.get(c.from);
      const to = idToRef.get(c.to);
      return from && to ? { from, to, purpose: c.purpose } : null;
    })
    .filter((c): c is NonNullable<typeof c> => !!c);

  const bundledSkills = collectBundledSkills(projectRoot, company.manifestTemplateId, companyId, companyAgents);
  // P0-B③ · defaultTasks 优先读公司持久字段(导入时落进的作者手填示例任务),再并上历史成功 run 采集的
  // (去重 by goal,持久的排在前——作者手填是权威)。此前只从成功 run 临时采集,导入的示例任务落不进公司、
  // 再导出就不在;现在"导入后再导出仍在"。持久字段缺失(手搭公司)→ 退化成纯 run 采集,行为不变。
  const defaultTasks = mergeDefaultTasks(company.defaultTasks ?? [], collectDefaultTasks(projectRoot, companyId));

  // C2 · recommendedConfig 数据源 = loadConfig(projectRoot) 的真实运行配置——如实是**当前项目运行
  // 配置快照**(ProjectConfig 是全局的、非按公司隔离,不谎称公司级配置;这是"这家公司实际跑在什么
  // 配置下",不是臆造的推荐值)。loadConfig 失败则该可选字段如实缺省,不阻断导出。此前
  // companyToTemplate 完全不产出该字段 ⇒ companyRoutes 导出端点的 recommendedConfig 恒 undefined。
  // P0-B⑤ · 语义澄清:这是**建议配置(advisory),导入不自动生效**。导入侧 bundleToTemplateShape→
  // installCompanyTemplate 不会用它覆盖接收方的全局 ProjectConfig——它保真往返只代表"作者当时的运行
  // 环境",接收方要采纳需在设置页手动落到自己的配置(schema 字段注释是权威口径,见 companyBundle.schema.ts)。
  let recommendedConfig: CompanyTemplate["recommendedConfig"] = company.recommendedConfig;
  try {
    const cfg = loadConfig(projectRoot);
    if (!recommendedConfig) recommendedConfig = {
      ...(cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {}),
      ...(cfg.budget ? { budget: { totalUsd: cfg.budget.totalUsd, maxTokensPerTask: cfg.budget.maxTokensPerTask } } : {}),
      ...(cfg.permissions
        ? { permissions: { allowShell: !!cfg.permissions.allowShell, allowFileWrite: !!cfg.permissions.allowFileWrite, allowWebAccess: !!cfg.permissions.allowWebAccess } }
        : {}),
    };
    if (Object.keys(recommendedConfig).length === 0) recommendedConfig = undefined;
  } catch { /* 读 config 失败 → 如实缺省 */ }

  return {
    id: `local-${companyId}`,
    title: company.name,
    description: company.description ?? "",
    author: "local",
    createdAt: new Date().toISOString(),
    tags: ["local-export"],
    downloads: 0,
    stars: 0,
    readme: company.description ?? `导出自本地公司「${company.name}」`,
    agents: tplAgents,
    // P0-B②:读原始 manifestToolRequirements(含作者手写 requiredSkills/optionalTools/requiredMcpServers,
    // 无法从 agents 反推),engines/providers 与当前员工树取并集保持最新;stored 缺失退回纯派生。
    toolRequirements: resolveToolRequirements(company.manifestToolRequirements, tplAgents),
    // Bug 修复(端到端验证抓出的第二处导出丢字段,和验证边/预置通道是同一类问题):
    // 能力边界报告第③段"本团队不适用"专读这两个字段,之前硬编码空数组导出即丢光。
    useCases: company.manifestUseCases ?? [],
    riskNotes: company.manifestRiskNotes ?? [],
    // P0-B①:公司级消息可见性/信息隔离策略随包(导入落回 Company.visibilityPolicy)。
    visibilityPolicy: company.visibilityPolicy,
    workflow: company.workflow,
    mcpRequirements: company.manifestMcpRequirements,
    a2aChannels: a2aChannels.length ? a2aChannels : undefined,
    bundledSkills: bundledSkills.length ? bundledSkills : undefined,
    defaultTasks: defaultTasks.length ? defaultTasks : undefined,
    recommendedConfig,
    requiredPermissions: company.requiredPermissions,
  };
}

// 分场景导出补齐:采集每个员工的 agent-memory.md(个人持久记忆,存于 .opc/knowledge/agents/<id>-memory.md,
// 不是 AgentNodeConfig 字段,此前导出完全不带 = 真丢)。agent_id 用**导出侧 reroot 后的稳定合成 id**
// (`${role}-${i}`,与 companyToTemplate 内 rerootAgents 的 idFor 完全同款)——导入侧 rerootAgents 会把这个
// 合成 id 再映射成新机真实 id,按 idMap 回写就能对上人。空记忆的员工跳过;best-effort,读失败不阻断导出。
export function collectAgentMemories(projectRoot: string, companyAgents: AgentNodeConfig[]): BundleAgentMemory[] {
  const out: BundleAgentMemory[] = [];
  companyAgents.forEach((a, i) => {
    let content = "";
    try { content = readAgentMemory(projectRoot, a.id); } catch { content = ""; }
    if (!content.trim()) return;
    const role = a.role || "agent";
    out.push({ agent_id: `${role}-${i}`, role, content });
  });
  return out;
}

// collectAgentMemories 的逆向(导入侧):把 bundle.agentMemories 写回新机的 agent-memory.md。
// bundle 里的 agent_id 是导出侧 reroot 后的稳定合成 id(`${role}-${i}`);导入侧 installCompanyTemplate
// 的 rerootAgents 产出 idMap(合成 id → 新机真实 id),按 idMap 回写就对上人。整块覆盖写(新公司刚
// reroot 出的 agent id 是全新的,不存在旧文件,不会误伤本机原有记忆)。best-effort:idMap 查无、
// 内容为空或写盘失败都跳过,不阻断安装。返回真正写回的条数。
// 令四.4 · 逐项报告:agent 个人记忆写回的失败(idMap 查无 / 内容为空 / 写盘异常)逐条带
// {agent_id, role, reason}。best-effort 语义不变(单条失败不阻断),但结局对调用方/响应可见。
export interface AgentMemoryImportFailure { agent_id: string; role?: string; reason: string }
export interface AgentMemoryImportResult { written: number; failures: AgentMemoryImportFailure[] }

export function assertAgentMemoryImportSucceeded(result: AgentMemoryImportResult): void {
  if (!result.failures.length) return;
  throw new Error(`agent memory import failed: ${result.failures.map((failure) => `${failure.agent_id}: ${failure.reason}`).join("; ")}`);
}

// 详版:写回 + 逐条失败明细(令四.4 起安装路由用此版本,把 failures 并入 merge 报告/响应)。
export function importAgentMemoriesDetailed(
  projectRoot: string,
  idMap: Record<string, string>,
  memories?: BundleAgentMemory[],
): AgentMemoryImportResult {
  if (!memories?.length) return { written: 0, failures: [] };

  type Operation = {
    memory: BundleAgentMemory;
    path: string;
    content: string;
    existed: boolean;
    previous?: string;
  };

  const failures: AgentMemoryImportFailure[] = [];
  const operations: Operation[] = [];
  const targetIds = new Set<string>();

  for (const memory of memories) {
    const newId = idMap[memory.agent_id];
    if (!newId) {
      failures.push({ agent_id: memory.agent_id, role: memory.role, reason: "idMap 无此 agent_id 映射(对应员工未在本次安装落地)" });
      continue;
    }
    if (!memory.content?.trim()) {
      failures.push({ agent_id: memory.agent_id, role: memory.role, reason: "记忆正文为空,未写回" });
      continue;
    }
    if (targetIds.has(newId)) {
      failures.push({ agent_id: memory.agent_id, role: memory.role, reason: `多个记忆条目映射到同一员工 ${newId}` });
      continue;
    }
    targetIds.add(newId);

    try {
      const targetPath = agentMemoryPath(projectRoot, newId);
      const existed = fs.existsSync(targetPath);
      const previous = existed ? fs.readFileSync(targetPath, "utf-8") : undefined;
      operations.push({
        memory,
        path: targetPath,
        content: memory.content.endsWith("\n") ? memory.content : memory.content + "\n",
        existed,
        previous,
      });
    } catch (error) {
      failures.push({ agent_id: memory.agent_id, role: memory.role, reason: `预检失败: ${(error as Error)?.message || String(error)}` });
    }
  }

  // Validation is batch-wide: no file is written if any input cannot be mapped or snapshotted.
  if (failures.length) return { written: 0, failures };

  const attempted: Operation[] = [];
  try {
    for (const operation of operations) {
      attempted.push(operation);
      fs.mkdirSync(path.dirname(operation.path), { recursive: true });
      fs.writeFileSync(operation.path, operation.content, "utf-8");
      if (fs.readFileSync(operation.path, "utf-8") !== operation.content) {
        throw new Error(`agent memory verification failed: ${operation.memory.agent_id}`);
      }
    }
    return { written: operations.length, failures: [] };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const operation of [...attempted].reverse()) {
      try {
        if (operation.existed) {
          fs.writeFileSync(operation.path, operation.previous ?? "", "utf-8");
        } else if (fs.existsSync(operation.path)) {
          fs.unlinkSync(operation.path);
        }
      } catch (rollbackError) {
        rollbackErrors.push(`${operation.memory.agent_id}: ${(rollbackError as Error)?.message || String(rollbackError)}`);
      }
    }
    const reason = `写盘失败,本批已回滚: ${(error as Error)?.message || String(error)}${rollbackErrors.length ? `; 回滚失败: ${rollbackErrors.join("; ")}` : ""}`;
    return {
      written: 0,
      failures: memories.map((memory) => ({ agent_id: memory.agent_id, role: memory.role, reason })),
    };
  }
}

// 兼容版(返回写回条数):既有调用方(best-effort no-return / 只需计数的测试)保持不变。
export function importAgentMemories(
  projectRoot: string,
  idMap: Record<string, string>,
  memories?: BundleAgentMemory[],
): number {
  const result = importAgentMemoriesDetailed(projectRoot, idMap, memories);
  assertAgentMemoryImportSucceeded(result);
  return result.written;
}

// D2+D4+D5 · 把 companyId 导出成 Company Bundle(包装 companyToTemplate 产物 + bundle 外壳,不改
// companyToTemplate 本体)。导出文件命名约定 <bundle_id>.opc.bundle.json;UI 下载入口留 D4,
// 这里先出一个可独立单测的纯函数。
//
// 分场景导出:opts.exportProfile("full" 自己备份 / "share" 社区分享,缺省 share)。用户拍板:记忆与
// 成长**两档都默认带走**(share 也带,让模板自带经验;growth 本就是 agents 的可选字段随包走)——
// memoryExportEnabled 时两档都采集员工 agent-memory.md 进 bundle.agentMemories(纯加性)。档位差异只在
// 脱敏强度:share 档记忆正文的密钥+本机路径全占位化、full 档只剥密钥,由导出端点统一经
// sanitizeBundleForExport(bundle, { profile }) 兜底(权限降权≠记忆不带)。
//
// D5:memory.records 从 registryStore/reflectionStore 映射填充(runtime/memoryBundle.ts),按
// tpl.agents 的角色集合圈定范围(company/team/agent/project 分层保留于各记录的 owner_type/owner_id)。
// 公司设置页的"导出时一并带上记忆"开关(Company.memoryExportEnabled,默认 true)在这里统一把关——
// 与 /api/companies/:id/memory-digest(P3 安全摘要导出)的既有口径一致:显式设为 false 才拦。
//
// D4:导出脱敏——扫描 memory 内容里的密钥/本机路径形态,命中的记录脱敏值并计入
// privacy.redacted_fields;required_secrets 从 agents 的 provider 依赖推导(非 CLI 订阅框架才需要
// API key)。这里没有额外扫描 agents/workflow 等其它字段的密钥/路径(那是 D1 templateDoctor 在
// 导入侧统一做的事,导出侧本次范围只覆盖 memory,如实标注不重复实现)。
export function companyToBundle(
  projectRoot: string,
  companyId: string,
  opts: { exportProfile?: ExportProfile } = {},
): CompanyBundle {
  const exportProfile: ExportProfile = opts.exportProfile ?? DEFAULT_EXPORT_PROFILE;
  const company = getCompany(projectRoot, companyId);
  const tpl = companyToTemplate(projectRoot, companyId);
  const roles = [...new Set(tpl.agents.map((a) => a.role).filter((r): r is string => !!r))];
  const memoryExportEnabled = company?.memoryExportEnabled !== false; // 未设置(undefined)按允许处理,不改变旧公司行为
  const rawMemory = memoryExportEnabled ? exportMemoryRecordsForCompany(projectRoot, companyId, roles) : [];
  // 记忆正文脱敏分档:share 密钥+本机路径全占位;full(自己的备份)只剥密钥、路径保留。与
  // sanitizeBundleForExport 的 redactPaths 口径一致(这里是 memory.records 的第一道关口)。
  const { records: memoryRecords, redactedFields } = redactMemoryRecords(rawMemory, exportProfile !== "full");
  const requiredSecrets = deriveRequiredSecrets(tpl.agents);
  // 记忆两档都带(用户拍板),只受 memoryExportEnabled 开关把关;share 档正文的密钥/本机路径由
  // sanitizeBundleForExport 深扫占位化,full 档只剥密钥。
  const agentMemories = memoryExportEnabled
    ? collectAgentMemories(projectRoot, loadAgents(projectRoot, []).filter((a) => a.companyId === companyId))
    : [];
  return {
    schema_version: "0.3.0",
    bundle_type: "company",
    bundle_id: tpl.id,
    title: tpl.title,
    description: tpl.description,
    metadata: {
      version: tpl.version ?? "0.1.0",
      created_at: tpl.createdAt,
      updated_at: new Date().toISOString(),
      license: tpl.license,
    },
    company: {
      company_id: companyId,
      name: tpl.title,
      description: tpl.description,
    },
    // C2 · org 真填(teams/edges 从 agents+a2aChannels/workflow 派生投影,与 templateToBundle 同款);
    // recommendedConfig 一并入 bundle(companyToTemplate 的"当前项目运行配置快照",见该函数注释)。
    org: { agents: tpl.agents, ...deriveOrgTeamsAndEdges(tpl.agents, tpl.a2aChannels, tpl.workflow) },
    agents: tpl.agents,
    // P0-B⑥ · 单次构建:companyToBundle 内已持有完整 companyToTemplate 产物,这里一次性把全部可移植结构
    // 字段落进 bundle(此前只落 agents/memory/privacy/recommendedConfig,导出端点再 companyToTemplate 二扫
    // 补挂 → 双重扫描)。现在端点直接拿这份完整 bundle,不再二次 companyToTemplate。
    readme: tpl.readme,
    useCases: tpl.useCases,
    riskNotes: tpl.riskNotes,
    toolRequirements: tpl.toolRequirements,
    recommendedConfig: tpl.recommendedConfig,
    ...(tpl.visibilityPolicy ? { visibilityPolicy: tpl.visibilityPolicy } : {}), // P0-B①:公司级调度语义随包
    ...(tpl.workflow ? { workflow: tpl.workflow } : {}),
    ...(tpl.bundledSkills ? { bundledSkills: tpl.bundledSkills } : {}),
    ...(tpl.mcpRequirements ? { mcpRequirements: tpl.mcpRequirements } : {}),
    ...(tpl.a2aChannels ? { a2aChannels: tpl.a2aChannels } : {}),
    ...(tpl.defaultTasks ? { defaultTasks: tpl.defaultTasks } : {}), // P0-B③:持久 + 采集合并后的示例任务
    memory: { records: memoryRecords },
    export_profile: exportProfile,
    ...(agentMemories.length ? { agentMemories } : {}),
    privacy: { redacted: true, redacted_fields: redactedFields, required_secrets: requiredSecrets },
    compatibility: { migration_notes: [] },
  };
}

// D4(要求 4)· companyToBundle 的 job-tracked 版本:queued→validating→processing→completed/failed
// 落一条 memoryJobStore 记录(供后续 UI 展示导出进度/历史)。companyToBundle 本体保持纯函数、无
// 副作用(既有单测直接调用,不希望每次导出都隐式落一个 job 文件)——这个包装函数是给未来真正的
// "导出" HTTP 路由用的入口(该路由本次不做,UI 下载入口仍如 D2 注释所述留待后续;这里先把可独立
// 单测的调用点建好)。
export function companyToBundleTracked(
  projectRoot: string,
  companyId: string,
  opts: { exportProfile?: ExportProfile } = {},
): { bundle: CompanyBundle; job: MemoryJobRecord } {
  const nowIso = new Date().toISOString();
  let job = createMemoryJob(projectRoot, { kind: "export", companyId }, nowIso);
  job = updateMemoryJob(projectRoot, job.jobId, { status: "validating" }, nowIso) ?? job;
  try {
    job = updateMemoryJob(projectRoot, job.jobId, { status: "processing" }, nowIso) ?? job;
    const bundle = companyToBundle(projectRoot, companyId, opts);
    job = updateMemoryJob(projectRoot, job.jobId, {
      status: "completed",
      result: {
        recordCount: bundle.memory?.records.length ?? 0,
        redactedFieldCount: bundle.privacy.redacted_fields.length,
        requiredSecretCount: bundle.privacy.required_secrets.length,
      },
    }, nowIso) ?? job;
    return { bundle, job };
  } catch (e) {
    job = updateMemoryJob(projectRoot, job.jobId, { status: "failed", error: (e as Error).message }, nowIso) ?? job;
    throw e;
  }
}

// 单个"活员工"序列化成可分享的 AgentCard(worker)。持久化的 persona 在 node.card(summary/skills/tools),
// 比整公司导出更轻(员工的价值多在公司结构内)——这里做尽力而为的映射。
export function agentToCard(projectRoot: string, agentId: string): AgentCard {
  const all = loadAgents(projectRoot, []);
  const a = all.find((x) => x.id === agentId);
  if (!a) throw new Error(`agent ${agentId} not found`);
  const card = a.card;
  const tools = (card?.tools ?? []).map((name) => ({ name, enabled: true }));
  return {
    id: `local-agent-${agentId}`,
    title: a.name || a.role || "Worker",
    description: card?.summary ?? "",
    role: a.role || "agent",
    author: "local",
    createdAt: new Date().toISOString(),
    tags: ["local-export"],
    downloads: 0,
    stars: 0,
    agent: {
      suggestedId: a.role || "worker",
      name: a.name || "Worker",
      recommendedProvider: a.provider || "deepseek",
      recommendedModel: a.model || "",
      systemPrompt: card?.summary || `${a.role || "worker"} 员工`,
      tools,
      expectedRole: a.role || "agent",
      recommendedParents: [],
    },
  };
}

export interface RequirementsCheck {
  ok: boolean;
  ready: { engines: string[]; providers: string[] };
  missing: Array<{ kind: "provider" | "engine"; name: string; reason: string }>;
  note: string;
}

/** 导入/部署前检查模板的工具需求是否就绪(Stage 1:provider key 同步检;engine 就绪性留 Stage 5 能力扫描)。 */
export function checkTemplateRequirements(projectRoot: string, template: CompanyTemplate): RequirementsCheck {
  const req = template.toolRequirements ?? deriveToolRequirements(template.agents);
  // 与真实运行和社区导入共享同一能力口径:env/keys/config/providers/accounts + canonical alias。
  const keyed = collectConfiguredProviderCapabilities(projectRoot).availableProviders;

  // 只对 API(非订阅 CLI)agent 的 provider 检 key——claude-code/codex 是订阅制,无 provider key,
  // 其就绪性 = CLI 是否登录,属 Stage 5 能力扫描,这里不当"缺 key"误报。
  const CLI_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
  const apiProviders = new Set(
    template.agents.filter((a) => !CLI_FRAMEWORKS.has(a.framework ?? "api")).map((a) => a.provider).filter((p): p is string => !!p),
  );
  const missing: RequirementsCheck["missing"] = [];
  const readyProviders: string[] = [];
  for (const p of apiProviders) {
    if (keyed.has(p)) readyProviders.push(p);
    else missing.push({ kind: "provider", name: p, reason: `缺 provider「${p}」的 API key 或账号` });
  }
  return {
    ok: missing.length === 0,
    ready: { engines: req.requiredEngines, providers: readyProviders },
    missing,
    note: "engine(claude-code/codex 等订阅 CLI)的安装/登录就绪性在执行前的能力扫描(Stage 5)中检查;此处仅检 API provider 的 key/账号。",
  };
}

// P0-1 · 基于模板的 toolRequirements + 本机能力,生成导入绑定计划。
// 诚实性约束:
//  1) provider 缺失 → status:"missing",action 默认 "configure",并给出本机可用的候选替代(带各自默认模型),
//     用户可改选 "map"(用候选替代)/ "configure"(去配置)/ "disable"(禁用依赖它的员工)。
//  2) model 的 status 不做假——API 面模型的可用性派生自 provider(有 key 才可调);provider 缺失时 model 同样
//     标 missing 并注明派生原因,绝不一律 "available"(此前占位实现会把"模型可用性"伪装成已检查)。
//  3) MCP 服务器缺失 → status:"missing",action 默认 "configure"。
//  4) engine(api/claude-code/codex/...)缺失 → status:"missing",action 默认 "configure"。
// 计划必须由用户逐项确认(userApproved);后端 applyImportBindingPlans 只消费 userApproved=true 的计划。
export interface ImportBindingCandidate {
  engine?: string;
  provider?: string;
  model?: string;
  recommended?: boolean;
  recommendationReason?: string;
}
export interface ImportBindingPlanItem {
  originalBinding: { kind: "provider" | "model" | "engine" | "mcp"; name: string; provider?: string };
  status: "available" | "missing" | "incompatible";
  action: "keep" | "map" | "configure" | "disable";
  targetBinding?: { engine?: string; provider?: string; model?: string };
  candidates?: ImportBindingCandidate[];
  reason?: string;
  userApproved: boolean;
}

export interface ImportBindingLocalCapability {
  availableProviders: Set<string>;
  availableEngines: Set<string>;
  availableMcpServers: Set<string>;
  defaultModelFor?: (provider: string) => string | undefined;
  defaultModelForEngine?: (engine: string) => { provider?: string; model?: string } | undefined;
}

const CLI_FRAMEWORKS_SET = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);

type ModelQualityBand = "fast" | "balanced" | "strong";
const BAND_VALUE: Record<ModelQualityBand, number> = { fast: 0, balanced: 1, strong: 2 };
const CRITICAL_BINDING_ROLES = /^(ceo|lead|architect|test|security|fact_checker|code_reviewer)$/i;

function modelQualityBand(model: string | undefined): ModelQualityBand {
  const value = String(model ?? "").toLowerCase();
  if (/(opus|sonnet|gpt-5|\bo[134]\b|reason|r1|deepseek-v4-pro|minimax-m3|\bpro\b)/.test(value)) return "strong";
  if (/(flash|haiku|mini|lite|turbo|small)/.test(value)) return "fast";
  return "balanced";
}

function recommendBindingCandidates(
  candidates: ImportBindingCandidate[],
  sourceModels: string[],
  affectedRoles: string[],
): ImportBindingCandidate[] {
  if (candidates.length === 0) return [];
  const targetBand = sourceModels.reduce((max, model) => Math.max(max, BAND_VALUE[modelQualityBand(model)]), 1);
  const critical = affectedRoles.some((role) => CRITICAL_BINDING_ROLES.test(role));
  const score = (candidate: ImportBindingCandidate) => {
    const band = BAND_VALUE[modelQualityBand(candidate.model)];
    const downgrade = Math.max(0, targetBand - band);
    return Math.abs(targetBand - band) * 20 + downgrade * (critical ? 80 : 35);
  };
  const ranked = [...candidates].sort((left, right) => score(left) - score(right));
  return ranked.map((candidate, index) => index === 0 ? {
    ...candidate,
    recommended: true,
    recommendationReason: sourceModels.length
      ? critical
        ? "按原模型档位与关键岗位责任做的保守匹配(启发式,不是模型等价性证明)"
        : "按原模型档位做的本机可用候选匹配(启发式,安装前仍需确认)"
      : "本机当前可用的执行候选(安装前仍需确认)",
  } : candidate);
}

export function buildImportBindingPlans(
  template: CompanyTemplate,
  local: ImportBindingLocalCapability,
): ImportBindingPlanItem[] {
  const plans: ImportBindingPlanItem[] = [];
  const req = template.toolRequirements ?? deriveToolRequirements(template.agents);
  const defaultModelFor = local.defaultModelFor ?? (() => undefined);

  const candidatesFor = (exclude: string, sourceModels: string[], affectedRoles: string[]): ImportBindingCandidate[] =>
    recommendBindingCandidates(
      [...local.availableProviders]
        .filter((p) => p !== exclude)
        .map((p) => ({ provider: p, model: defaultModelFor(p) ?? "" })),
      sourceModels,
      affectedRoles,
    );

  const engineCandidatesFor = (exclude: string, sourceModels: string[], affectedRoles: string[]): ImportBindingCandidate[] => {
    const candidates: ImportBindingCandidate[] = [];
    for (const engine of local.availableEngines) {
      if (engine === exclude) continue;
      if (engine === "api") {
        for (const provider of local.availableProviders) {
          candidates.push({ engine, provider, model: defaultModelFor(provider) ?? "" });
        }
        continue;
      }
      candidates.push({ engine, ...(local.defaultModelForEngine?.(engine) ?? {}) });
    }
    return recommendBindingCandidates(candidates, sourceModels, affectedRoles);
  };

  // 1) provider:模板里非订阅 CLI 员工引用的 provider
  const neededProviders = new Set<string>();
  for (const a of template.agents) {
    if (!CLI_FRAMEWORKS_SET.has(a.framework ?? "api") && a.provider) neededProviders.add(a.provider);
  }
  for (const p of neededProviders) {
    const ok = local.availableProviders.has(p);
    plans.push({
      originalBinding: { kind: "provider", name: p },
      status: ok ? "available" : "missing",
      action: ok ? "keep" : "configure",
      candidates: ok ? undefined : candidatesFor(
        p,
        template.agents.filter((agent) => !CLI_FRAMEWORKS_SET.has(agent.framework ?? "api") && agent.provider === p).map((agent) => agent.model),
        template.agents.filter((agent) => !CLI_FRAMEWORKS_SET.has(agent.framework ?? "api") && agent.provider === p).map((agent) => agent.role),
      ),
      reason: ok ? undefined : `缺 provider「${p}」的 API key 或账号`,
      userApproved: ok,
    });
  }

  // 2) model:诚实派生——provider 可用即 available;provider 缺失即 missing(注明派生)。
  const seenModels = new Set<string>();
  for (const a of template.agents) {
    if (CLI_FRAMEWORKS_SET.has(a.framework ?? "api") || !a.model) continue;
    const modelKey = `${a.provider}:${a.model}`;
    if (seenModels.has(modelKey)) continue;
    seenModels.add(modelKey);
    const providerOk = local.availableProviders.has(a.provider);
    plans.push({
      originalBinding: { kind: "model", name: a.model, provider: a.provider },
      status: providerOk ? "available" : "missing",
      action: providerOk ? "keep" : "configure",
      candidates: providerOk ? undefined : candidatesFor(
        a.provider,
        [a.model],
        template.agents.filter((agent) => agent.provider === a.provider && agent.model === a.model).map((agent) => agent.role),
      ),
      reason: providerOk ? undefined : `model「${a.model}」不可用:其 provider「${a.provider}」本机未配置(模型合法性在运行时由 modelResolve 复核)`,
      userApproved: providerOk,
    });
  }

  // 3) engine。历史 framework 值 "hermes"/缺省归一为 "api"(与 engineRouter.normalizeFramework 同口径),
  // 否则旧模板/存量员工会把 "hermes" 当成缺失引擎误报。
  for (const raw of req.requiredEngines) {
    const e = !raw || raw === "hermes" ? "api" : raw;
    const ok = local.availableEngines.has(e);
    plans.push({
      originalBinding: { kind: "engine", name: e },
      status: ok ? "available" : "missing",
      action: ok ? "keep" : "configure",
      candidates: ok ? undefined : engineCandidatesFor(
        e,
        template.agents.filter((agent) => (!agent.framework || agent.framework === "hermes" ? "api" : agent.framework) === e).map((agent) => agent.model),
        template.agents.filter((agent) => (!agent.framework || agent.framework === "hermes" ? "api" : agent.framework) === e).map((agent) => agent.role),
      ),
      reason: ok ? undefined : `执行引擎「${e}」本机不可用`,
      userApproved: ok,
    });
  }

  // 4) MCP
  const requiredMcpNames = new Set([
    ...req.requiredMcpServers,
    ...(template.mcpRequirements ?? []).filter((m) => m.optional !== true).map((m) => m.name),
  ]);
  for (const m of requiredMcpNames) {
    const name = typeof m === "string" ? m : (m as { name?: string }).name ?? String(m);
    const ok = local.availableMcpServers.has(name);
    plans.push({
      originalBinding: { kind: "mcp", name },
      status: ok ? "available" : "missing",
      action: ok ? "keep" : "configure",
      reason: ok ? undefined : `MCP 服务器「${name}」本机未启用`,
      userApproved: ok,
    });
  }

  return plans;
}

// 消费经用户确认的计划,产出将真正落地的模板副本:
//  · action "map"(userApproved):按 targetBinding 改写受影响员工的 provider/model。
//  · action "disable"(userApproved):受影响员工 enabled=false。
//  · action "configure"(userApproved 或未确认):诚实降级为 disable——用户选择去配置但本次仍直接安装,
//    未配置的 provider 无法执行,员工禁用比运行时 restricted 更可预期。action "keep" 不变。
// 未确认(userApproved=false)的非 "keep" 计划同样按 disable 处理(绝不静默替换,也绝不留运行时炸点)。
export function applyImportBindingPlans(template: CompanyTemplate, plans: ImportBindingPlanItem[]): CompanyTemplate {
  const providerPlan = new Map<string, ImportBindingPlanItem>();
  const modelPlan = new Map<string, ImportBindingPlanItem>();
  const enginePlan = new Map<string, ImportBindingPlanItem>();
  const disabledMcp = new Set<string>();
  for (const p of plans) {
    if (p.originalBinding.kind === "provider") providerPlan.set(p.originalBinding.name, p);
    if (p.originalBinding.kind === "model") modelPlan.set(`${p.originalBinding.provider ?? "*"}:${p.originalBinding.name}`, p);
    if (p.originalBinding.kind === "engine") enginePlan.set(p.originalBinding.name, p);
    if (p.originalBinding.kind === "mcp" && p.userApproved && p.action === "disable") disabledMcp.add(p.originalBinding.name);
  }
  const agents = template.agents.map((a) => {
    const framework = !a.framework || a.framework === "hermes" ? "api" : a.framework;
    const ep = enginePlan.get(framework);
    let next = a;
    if (ep) {
      if (ep.action === "map" && ep.userApproved && ep.targetBinding?.engine) {
        next = {
          ...a,
          framework: ep.targetBinding.engine as AgentNodeConfig["framework"],
          provider: ep.targetBinding.provider ?? a.provider,
          model: ep.targetBinding.model ?? a.model,
          cliConfigDir: undefined,
          claudeCodeUseApiKey: undefined,
          enabled: a.enabled !== false,
        };
      } else if (ep.status !== "available" && !(ep.action === "keep" && ep.userApproved)) {
        return { ...a, enabled: false };
      }
    }

    const effectiveFramework = !next.framework || next.framework === "hermes" ? "api" : next.framework;
    if (!CLI_FRAMEWORKS_SET.has(effectiveFramework) && next.provider) {
      const pp = providerPlan.get(a.provider);
      if (pp) {
        if (pp.action === "map" && pp.userApproved && pp.targetBinding?.provider) {
          next = {
            ...a,
            provider: pp.targetBinding.provider,
            model: pp.targetBinding.model || a.model,
            enabled: a.enabled !== false,
          };
        } else if (pp.status !== "available" && !(pp.action === "keep" && pp.userApproved)) {
          return { ...a, enabled: false };
        }
      }
    }

    const mp = modelPlan.get(`${a.provider}:${a.model}`) ?? modelPlan.get(`*:${a.model}`);
    if (mp) {
      if (mp.action === "map" && mp.userApproved && mp.targetBinding?.model) {
        return {
          ...next,
          provider: mp.targetBinding.provider ?? next.provider,
          model: mp.targetBinding.model,
          enabled: next.enabled !== false,
        };
      }
      if (mp.status !== "available" && !(mp.action === "keep" && mp.userApproved)) {
        return { ...a, enabled: false };
      }
    }
    return next;
  });

  const rewriteRequired = (kind: "engine" | "provider", values: string[]): string[] => {
    const plansByName = kind === "engine" ? enginePlan : providerPlan;
    const rewritten: string[] = [];
    for (const value of values) {
      const normalized = kind === "engine" && (!value || value === "hermes") ? "api" : value;
      const plan = plansByName.get(normalized);
      if (plan?.action === "disable" && plan.userApproved) continue;
      if (plan?.action === "map" && plan.userApproved) {
        const replacement = kind === "engine" ? plan.targetBinding?.engine : plan.targetBinding?.provider;
        if (replacement) rewritten.push(replacement);
        continue;
      }
      rewritten.push(value);
    }
    return [...new Set(rewritten)];
  };
  const toolRequirements = template.toolRequirements
    ? {
        ...template.toolRequirements,
        requiredEngines: rewriteRequired("engine", template.toolRequirements.requiredEngines),
        requiredProviders: rewriteRequired("provider", template.toolRequirements.requiredProviders),
        requiredMcpServers: template.toolRequirements.requiredMcpServers.filter((name) => !disabledMcp.has(name)),
      }
    : undefined;
  const mcpRequirements = template.mcpRequirements?.filter((m) => !disabledMcp.has(m.name));
  return { ...template, agents, toolRequirements, mcpRequirements };
}
