import type { Express } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CompanyTemplate, AgentNodeConfig, BundleAgentMemory } from "@opc/shared";
import { CompanySchema, CompanyTemplateSchema, parseCompanyBundle, bundleToTemplateShape, sanitizeExportProfile, deriveOrgTeamsAndEdges, listUnregisteredTemplateFields, CURRENT_BUNDLE_SCHEMA_VERSION, LEGACY_BUNDLE_VERSION } from "@opc/shared";
import { ensureCompanies, addCompany, updateCompany, deleteCompany, getCompany } from "../storage/companyStore.js";
import { getAgents, updateAgent, removeAgentsByCompany, addAgents, removeAgentsByIds, restoreAgentsInPlace } from "../runtime/orchestrator.js";
import { deleteSkill, getSkill, listSkills } from "../storage/skillStore.js";
import { loadRegistry, removeMemoryRecordsByIds, purgeCompanyMemory } from "../storage/registryStore.js";
import { loadLessons, removeLessonsByIds, purgeCompanyLessons } from "../storage/reflectionStore.js";
import { listGovernedMemoryProposals, removeGovernedMemoryProposalsByIds } from "../runtime/memoryGovernance.js";
import { purgeCompanyMemoryEntries } from "../storage/memoryStore.js";
import { companyToTemplate, companyToBundleTracked, checkTemplateRequirements, importAgentMemoriesDetailed, type AgentMemoryImportFailure } from "../runtime/companyTemplate.js";
import { buildCapabilityReport } from "../runtime/capabilityReport.js";
import { verifyAndAssignTrust, dangerFlags } from "../runtime/templateTrust.js";
import {
  rerootAgents, resolveTemplateAgentRef, applySafeInstall,
  installBundledSkills, planBundledSkillCreatedIds, computeMissingMcp,
  detectAmbiguousTemplateRefs, computeInstallDangerSurface, isBundledSkillOwnedByCompany,
} from "../runtime/install.js";
import { runTemplateDoctor, type TemplateDoctorReport } from "../runtime/templateDoctor.js";
import {
  detectMergeConflicts, resolveMerge, sanitizeMergeStrategies, buildInstallPreviewSummary,
  mergeCompanyLevelFields, planMergeAgentMemories, finalizeMergeReport,
  planOrgParentRebindApply, buildKeepCurrentOrgReviewItems,
  type MergeConflictReport,
} from "../runtime/installMerge.js";
import { sanitizeMemoryImportMode, filterMemoryRecordsByImportMode, applyMemoryImportModeTracked, sanitizeBundleForExport } from "../runtime/memoryBundle.js";
import {
  recordInstallTransaction, attachInstallTransactionMemory, markInstallTransactionFailed,
  markInstallTransactionRolledBack, issueInstallConfirmationToken, consumeInstallConfirmationToken,
  loadInstallTransactions,
  type InstallTransaction, type InstallTransactionAgentSnapshot,
} from "../storage/installTransactionStore.js";
import { syncProvidersFromStore } from "../runtime/providerRegistry.js";
import { callModel, createAnthropicProvider } from "../runtime/modelGateway.js";
import { probeClaudeCodeAsync, probeCodexAsync } from "../runtime/engines/probes.js";
import { resolveApiKeyOverride } from "../runtime/engines/apiKeyAccount.js";
import { validateWorkspaceFolder } from "../runtime/workspaceGuard.js";
import { ensureGitRepo } from "../runtime/workspace.js";
import { loadAccounts } from "../storage/providerStore.js";
import { checkTextIntegrity, CORRUPTED_INPUT_ERROR } from "../security/inputIntegrity.js";
import {
  finalizeSemanticFidelity,
  mergeReportOverrides,
  safeInstallApprovedFields,
  semanticFidelityReportFromError,
  type SemanticFidelityReport,
} from "../runtime/semanticFidelity.js";

// 令四.1 · /api/companies/import 的控制字段:与模板本体同层(见路由注释),解析模板时不参与语义,
// 只从原始 req.body 读。扁平 CompanyTemplate 导入(无 schema_version、body 即模板本体)时,
// CompanyTemplateSchema 的 .passthrough()(收口④前向兼容)会把这些控制字段一并放进 parsed.data,
// 污染 Template Doctor 的扫描面(installConfirmationToken 的 UUID 会被密钥正则误判)与
// computeTemplateHash 的危险面(preview 的 mode 与真装的 token 进 hash → 两步流 hash 永不相符)。
// 故解析前先从扁平候选对象剥离,使扫描面/hash 对扁平输入也稳定;canonical Bundle 路径经
// bundleToTemplateShape 只取声明字段,天然干净,无需剥离。
const IMPORT_CONTROL_FIELDS = [
  "mode", "targetCompanyId", "mergeStrategies", "confirmOverwrite", "memoryImportMode",
  "installConfirmationToken", "orgParentResolution", "teamDuplicationResolution", "unsafeAcknowledged",
] as const;

// 浅拷贝后删除已知控制字段(不触碰原始 req.body——控制字段仍由路由从 req.body 读取语义)。
function stripImportControlFields(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const rest = { ...(body as Record<string, unknown>) };
  for (const k of IMPORT_CONTROL_FIELDS) delete rest[k];
  return rest;
}

// 删除公司自动备份 / 恢复(Stage 1+):companyToTemplate() 本身就是完整快照(补完 bundledSkills 缺口后),
// 直接拿来当备份格式复用,不另造一套。下面几个函数拆成可独立单测的纯逻辑(不绑定 Express req/res),
// 路由 handler 只做瘦身转发——与 fileRoutes.ts 的 isSensitive/safeResolve、companyTemplate.ts 的
// companyToTemplate 是同一惯例。
function companyBackupsDir(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "company-backups");
}

/**
 * 删除公司前的自动备份(尽力而为):把该公司完整导出成 CompanyTemplate 快照,写入
 * `.opc/company-backups/{id}-{timestamp}.json`。失败(比如公司没有 agent 导致 companyToTemplate
 * 抛错)绝不阻断删除——用户真正想做的是删除,备份只是安全网,不该反过来卡住主流程,因此这里只 warn、
 * 不抛出。返回写入的文件名;备份失败/跳过则返回 undefined。
 */
export function backupCompanyBeforeDelete(projectRoot: string, companyId: string): string | undefined {
  try {
    const tpl = companyToTemplate(projectRoot, companyId);
    const dir = companyBackupsDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/:/g, "-"); // ISO 去掉冒号,避免文件名非法字符
    const filename = `${companyId}-${stamp}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(tpl, null, 2), "utf-8");
    return filename;
  } catch (e: any) {
    console.warn(`[companyRoutes] 删除公司「${companyId}」前自动备份失败(不阻断删除): ${e?.message || e}`);
    return undefined;
  }
}

export interface CompanyBackupSummary {
  filename: string;
  companyTitle: string;
  agentCount: number;
  originalCompanyId?: string;
  backedUpAt: string; // 备份文件的文件系统 mtime(ISO),比信 JSON 内 createdAt 更可靠
}

/** 列出全部删除前自动备份(轻量:只读 title/agent 数摘要,不做 schema 校验/签名)。按时间倒序。 */
export function listCompanyBackups(projectRoot: string): CompanyBackupSummary[] {
  const dir = companyBackupsDir(projectRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const filepath = path.join(dir, f);
      const stat = fs.statSync(filepath);
      let companyTitle = "(解析失败)";
      let agentCount = 0;
      let originalCompanyId: string | undefined;
      try {
        const raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
        if (typeof raw.title === "string") companyTitle = raw.title;
        if (Array.isArray(raw.agents)) agentCount = raw.agents.length;
        if (typeof raw.id === "string") originalCompanyId = raw.id.replace(/^local-/, "");
      } catch { /* 单个备份文件损坏不影响列出其余备份 */ }
      return { filename: f, companyTitle, agentCount, originalCompanyId, backedUpAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.backedUpAt.localeCompare(a.backedUpAt));
}

export type RestoreCompanyResult =
  | {
      ok: true; companyId: string; ceoId: string | null; agentCount: number;
      bundledSkillsInstalled: number; presetChannelsInstalled: number;
      // D6:落地明细(新落地的 agent 全量 / 这次真新建的 skill id / 新增的 presetChannel key)——
      // 只有 /api/companies/import 路由拿这些去落 install transaction;restoreCompanyFromBackup
      // 走的是灾备场景,不在 D6 记账范围内,忽略这几个字段即可。
      agents: AgentNodeConfig[]; createdSkillIds: string[]; presetChannelKeys: string[];
      agentMemoriesImported: number; agentMemoryFailures: AgentMemoryImportFailure[];
      doctor?: TemplateDoctorReport; forced?: boolean;
      // 令四.6:本次是 clone(reroot 新 id)还是 restore(保留原 id + 保真断言)。缺省(installCompanyTemplate
      // 直接返回)不带此字段;restoreCompanyFromBackup 会明示。restore 模式附带保真校验明细。
      mode?: "clone" | "restore";
      fidelity?: { ok: boolean; mismatches: string[] };
      semanticFidelity?: SemanticFidelityReport;
    }
  | { ok: false; status: number; error: string; doctor?: TemplateDoctorReport; semanticFidelity?: SemanticFidelityReport };

// 与 communityRoutes 的 doctorErrorText 同一文案口径(那边是路由闭包内的局部函数,未导出;两行的小
// helper 不值得为共享它把 communityRoutes 的 register 拆开)。
const doctorErrorText = (doctor: TemplateDoctorReport): string =>
  "模板未通过安全体检:" + doctor.checks.filter((c) => c.status === "error").map((c) => c.message).join(";");

// D6 · install transaction 的两个小工具,与 communityRoutes.ts 同款(presetChannel 去重 key / agent
// 最小快照)——两处路由各自持有一份,不为两行同构逻辑跨文件导出。
const channelKey = (c: { from: string; to: string }): string => `${c.from}=>${c.to}`;
const agentSnapshot = (a: AgentNodeConfig): InstallTransactionAgentSnapshot =>
  ({ id: a.id, name: a.name, parentId: a.parentId, companyId: a.companyId ?? "default" });

// ── 令四.5 · 部分安装失败的**补偿回滚**(state-only,不带 res;两条安装路由的失败 catch 共用;
// communityRoutes install/company 也 import 本 helper,不再各写一份)。安装步骤(agents/skills/
// channels/memory/公司字段 patch)任一步抛错 → 按已落 tx 把已落地的部分逆向撤销:
//   · new-company:删整公司 + 其全部 agent + 本次真新建的 skill;
//   · merge:删本次新增 agent + 恢复 preMerge 快照(覆盖前员工/改挂节点/公司四字段/通道/mcp)+ 删新建 skill;
//   · 两者:按 tx.memory 记录撤销本次导入的记忆(新建硬删,合并进既有的不动)。
// 成功 → markInstallTransactionRolledBack,返回 {ok:true};回滚本身抛错 → markInstallTransactionFailed,
// 返回 {ok:false,error}(路由据此回 requires_rollback:true + txId,绝不返回成功形状)。best-effort:
// 单个原语失败不阻断其余撤销(尽最大努力清干净),最后有异常才判整体失败。
export function compensateInstallTransaction(
  projectRoot: string,
  tx: InstallTransaction,
): { ok: boolean; error?: string; errors?: string[] } {
  const errors: string[] = [];
  const messageOf = (e: unknown): string => e instanceof Error ? e.message : String(e);
  const attempt = (label: string, fn: () => unknown): void => {
    try { fn(); } catch (e) { errors.push(`${label}: ${messageOf(e)}`); }
  };
  const comparable = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const samePersistedValue = (actual: unknown, expected: unknown): boolean =>
    isDeepStrictEqual(comparable(actual), comparable(expected));

  // ① 记忆(两 mode 同):新建硬删,合并进既有的不动(与 rollback 端点同口径)。
  if (tx.memory) {
    attempt("remove governed memory proposals", () => removeGovernedMemoryProposalsByIds(projectRoot, tx.memory!.governedProposalIds ?? []));
    attempt("remove conclusion memory", () => removeMemoryRecordsByIds(projectRoot, tx.memory!.conclusionIds));
    attempt("remove procedural memory", () => removeMemoryRecordsByIds(projectRoot, tx.memory!.proceduralSkillCreatedIds));
    attempt("remove lesson memory", () => removeLessonsByIds(projectRoot, tx.memory!.lessonCreatedIds));
  }

  // ② 本次真新建的 skill(created.skillIds 只含"这次凭空新建"的,硬删安全)。
  for (const sid of tx.created.skillIds) attempt(`delete skill ${sid}`, () => deleteSkill(projectRoot, sid));

  if (tx.mode === "new-company") {
    // 每个原语独立尝试。deleteCompany 抛错不能阻断 agent 清理。
    attempt("delete created company", () => {
      if (getCompany(projectRoot, tx.companyId) && !deleteCompany(projectRoot, tx.companyId)) {
        throw new Error(`company ${tx.companyId} was not deleted`);
      }
    });
    attempt("remove agents by company", () => removeAgentsByCompany(tx.companyId));
    // 极端:某 created agent 被挪去别的公司 → 整公司删除扫不到,按 id 兜底删。
    attempt("remove created agents", () => removeAgentsByIds(tx.created.agentIds));
  } else {
    // merge:删本次新增 agent。
    attempt("remove merged agents", () => removeAgentsByIds(tx.created.agentIds));
    let company: ReturnType<typeof getCompany> = undefined;
    try {
      company = getCompany(projectRoot, tx.companyId);
    } catch (e) {
      errors.push(`load merge target company: ${messageOf(e)}`);
    }
    if (!company) {
      errors.push(`restore merge company: company ${tx.companyId} is missing`);
    } else {
      const companyPatch: Record<string, unknown> = {};
      if (tx.created.presetChannelKeys.length || tx.preMerge?.modifiedChannels?.length) {
        const keySet = new Set(tx.created.presetChannelKeys);
        let kept = (company.presetChannels ?? []).filter((c) => !keySet.has(channelKey(c)));
        if (tx.preMerge?.modifiedChannels?.length) {
          const origByKey = new Map(tx.preMerge.modifiedChannels.map((c) => [channelKey(c), c]));
          kept = kept.map((c) => origByKey.get(channelKey(c)) ?? c);
        }
        companyPatch.presetChannels = kept;
      }
      if (tx.preMerge) companyPatch.manifestMcpRequirements = tx.preMerge.manifestMcpRequirements;
      if (tx.preMerge?.companyFields) {
        const cf = tx.preMerge.companyFields;
        companyPatch.visibilityPolicy = cf.visibilityPolicy;
        companyPatch.defaultTasks = cf.defaultTasks;
        companyPatch.manifestToolRequirements = cf.manifestToolRequirements;
        companyPatch.workflow = cf.workflow;
      }
      if (Object.keys(companyPatch).length) {
        attempt("restore merge company fields", () => {
          if (!updateCompany(projectRoot, tx.companyId, companyPatch)) throw new Error(`company ${tx.companyId} is missing`);
        });
      }
    }

    // 覆盖前员工整对象还原。删除与恢复分开尝试,避免前一步失败后跳过后续补偿。
    if (tx.preMerge?.overwrittenAgents?.length) {
      const overwritten = tx.preMerge.overwrittenAgents;
      attempt("restore overwritten agents in place", () => {
        const restored = restoreAgentsInPlace(overwritten);
        if (restored !== overwritten.length) throw new Error(`restored ${restored}/${overwritten.length} agents`);
      });
    }
    if (tx.preMerge?.orgParentRestores?.length) {
      const snapshots = tx.preMerge.orgParentRestores;
      attempt("restore organization parents", () => {
        const restored = restoreAgentsInPlace(snapshots);
        if (restored !== snapshots.length) throw new Error(`restored ${restored}/${snapshots.length} agents`);
      });
    }
  }

  // ③ 从真实存储重新读取,证明补偿后的可观察状态与事务前一致。
  attempt("verify compensation state", () => {
    const allAgents = getAgents();
    const createdIds = new Set(tx.created.agentIds);
    const remainingCreatedAgents = allAgents.filter((a) => createdIds.has(a.id)).map((a) => a.id);
    if (remainingCreatedAgents.length) errors.push(`verification: created agents remain: ${remainingCreatedAgents.join(", ")}`);

    for (const sid of tx.created.skillIds) {
      if (getSkill(projectRoot, sid)) errors.push(`verification: created skill remains: ${sid}`);
    }

    if (tx.memory) {
      const governedIds = new Set(listGovernedMemoryProposals(projectRoot).map((proposal) => proposal.proposalId));
      const remainingGovernedIds = (tx.memory.governedProposalIds ?? []).filter((id) => governedIds.has(id));
      const registryIds = new Set(loadRegistry(projectRoot).map((r) => r.id));
      const lessonIds = new Set(loadLessons(projectRoot).map((l) => l.id));
      const remainingRegistryIds = [...tx.memory.conclusionIds, ...tx.memory.proceduralSkillCreatedIds].filter((id) => registryIds.has(id));
      const remainingLessonIds = tx.memory.lessonCreatedIds.filter((id) => lessonIds.has(id));
      if (remainingGovernedIds.length) errors.push(`verification: governed memory proposals remain: ${remainingGovernedIds.join(", ")}`);
      if (remainingRegistryIds.length) errors.push(`verification: memory records remain: ${remainingRegistryIds.join(", ")}`);
      if (remainingLessonIds.length) errors.push(`verification: lessons remain: ${remainingLessonIds.join(", ")}`);
    }

    if (tx.mode === "new-company") {
      if (getCompany(projectRoot, tx.companyId)) errors.push(`verification: company remains: ${tx.companyId}`);
      const companyAgents = allAgents.filter((a) => (a.companyId ?? "default") === tx.companyId).map((a) => a.id);
      if (companyAgents.length) errors.push(`verification: company agents remain: ${companyAgents.join(", ")}`);
      return;
    }

    const companyAfter = getCompany(projectRoot, tx.companyId);
    if (!companyAfter) {
      errors.push(`verification: merge company is missing: ${tx.companyId}`);
      return;
    }
    for (const key of tx.created.presetChannelKeys) {
      if ((companyAfter.presetChannels ?? []).some((c) => channelKey(c) === key)) {
        errors.push(`verification: created channel remains: ${key}`);
      }
    }
    for (const expected of tx.preMerge?.modifiedChannels ?? []) {
      const actual = (companyAfter.presetChannels ?? []).find((c) => channelKey(c) === channelKey(expected));
      if (!samePersistedValue(actual, expected)) errors.push(`verification: channel not restored: ${channelKey(expected)}`);
    }
    if (tx.preMerge && !samePersistedValue(companyAfter.manifestMcpRequirements, tx.preMerge.manifestMcpRequirements)) {
      errors.push("verification: manifestMcpRequirements not restored");
    }
    if (tx.preMerge?.companyFields) {
      for (const field of ["visibilityPolicy", "defaultTasks", "manifestToolRequirements", "workflow"] as const) {
        if (!samePersistedValue(companyAfter[field], tx.preMerge.companyFields[field])) errors.push(`verification: company.${field} not restored`);
      }
    }
    const currentById = new Map(allAgents.map((a) => [a.id, a]));
    for (const expected of [...(tx.preMerge?.overwrittenAgents ?? []), ...(tx.preMerge?.orgParentRestores ?? [])]) {
      if (!samePersistedValue(currentById.get(expected.id), expected)) errors.push(`verification: agent not restored: ${expected.id}`);
    }
  });

  if (errors.length) {
    attempt("mark install transaction failed", () => {
      if (!markInstallTransactionFailed(projectRoot, tx.txId)) throw new Error(`transaction ${tx.txId} not found`);
    });
    return { ok: false, error: errors.join("; "), errors };
  }

  try {
    if (!markInstallTransactionRolledBack(projectRoot, tx.txId)) throw new Error(`transaction ${tx.txId} not found`);
    return { ok: true };
  } catch (e) {
    errors.push(`mark install transaction rolled_back: ${messageOf(e)}`);
    attempt("mark install transaction failed", () => {
      if (!markInstallTransactionFailed(projectRoot, tx.txId)) throw new Error(`transaction ${tx.txId} not found`);
    });
    return { ok: false, error: errors.join("; "), errors };
  }
}

// #22(tx-first)· /api/companies/import 在真正写状态前要先落 install transaction,而 transaction 需要
// 的公司 id/员工 id/待新建 skill/通道 key 都产自本函数内部——onPlanned 在**第一笔状态写之前**把这份
// 计划交给调用方(路由在回调里落 transaction)。restoreCompanyFromBackup(灾备恢复,不记账)不传即可。
export interface InstallCompanyPlan {
  companyId: string;
  agents: AgentNodeConfig[];
  createdSkillIds: string[];
  presetChannelKeys: string[];
}

/**
 * 把一份**已通过 CompanyTemplateSchema 校验**的模板落地成一个全新的活公司:建公司 → reroot agent
 * 树(全新 id,不撞现有公司)→ workflow/manifest 元数据原样落盘 → bundledSkills 写入技能库 →
 * a2aChannels 换算成真实 agent id 落进 presetChannels。抽出成独立函数,供「从备份恢复」
 * (restoreCompanyFromBackup,读 .opc/company-backups/ 里的文件)和「直接导入本地 JSON 文件」
 * (下面 /api/companies/import 路由,文件不必在该目录里)共用同一套落地逻辑——同 install/company
 * (communityRoutes.ts)的步骤,不重新发明。
 */
export function installCompanyTemplate(
  projectRoot: string,
  tpl: CompanyTemplate,
  opts?: {
    nameSuffix?: string; onPlanned?: (plan: InstallCompanyPlan) => void; agentMemories?: BundleAgentMemory[];
    // 令四.6 · clone vs restore 语义分叉:
    //   · 缺省(clone/import):reroot 出全新随机 id + idMap 重映射(既有行为,不撞现有公司);
    //   · preserveIds=true(restore/灾备恢复):**保留模板里的 agent id 与引用逐字**(idFor 恒等),
    //     公司 id 用 companyIdOverride(备份的原公司 id),不做 reroot 重映射。usage/status 复位与本机
    //     路径字段清空仍照做(那是安装卫生,不是身份;备份侧本就已清空)。id/引用/关键字段的往返保真由
    //     调用方(restoreCompanyFromBackup restore 模式)在落地后逐一断言。
    preserveIds?: boolean; companyIdOverride?: string;
  },
): RestoreCompanyResult {
  try {
    // #22:公司 id 先生成(companyStore.addCompany 缺省同款 8 位 uuid 片段),员工树/预置通道/待新建
    // skill 全部先在内存里推导,onPlanned(落 transaction)之后才开始写任何状态。
    const companyId = opts?.preserveIds && opts.companyIdOverride ? opts.companyIdOverride : randomUUID().slice(0, 8);
    const shortId = companyId.slice(0, 6);
    // restore:idFor 恒等(保留原 id);clone:加公司短 id 后缀。
    const { agents, idMap } = opts?.preserveIds
      ? rerootAgents(tpl.agents, companyId, (old) => old)
      : rerootAgents(tpl.agents, companyId, (old) => `${old}-${shortId}`);
    const ceo = agents.find((a) => a.role === "ceo");

    const presetChannels = (tpl.a2aChannels ?? [])
      .map((c) => ({
        from: resolveTemplateAgentRef(tpl.agents, idMap, c.from),
        to: resolveTemplateAgentRef(tpl.agents, idMap, c.to),
        purpose: c.purpose,
      }))
      .filter((c): c is { from: string; to: string; purpose: string | undefined } => !!c.from && !!c.to && c.from !== c.to);
    const presetChannelKeys = presetChannels.map((c) => `${c.from}=>${c.to}`);

    opts?.onPlanned?.({
      companyId, agents,
      createdSkillIds: planBundledSkillCreatedIds(projectRoot, tpl, agents.map((a) => a.role), companyId),
      presetChannelKeys,
    });

    const company = addCompany(projectRoot, {
      id: companyId,
      name: `${tpl.title}${opts?.nameSuffix ?? ""}`,
      description: tpl.description ?? "",
      manifestTemplateId: tpl.id,
      manifestUseCases: tpl.useCases,
      manifestRiskNotes: tpl.riskNotes,
      manifestToolRequirements: tpl.toolRequirements,
      workflow: tpl.workflow,
      manifestMcpRequirements: tpl.mcpRequirements,
      // P0-B① · 公司级调度语义落回 Company(此前导入丢弃 → 再导出也不在)。
      visibilityPolicy: tpl.visibilityPolicy,
      // P0-B③ · 作者手填示例任务落成公司持久字段(此前只从成功 run 临时采,导入即丢)。
      defaultTasks: tpl.defaultTasks,
      recommendedConfig: tpl.recommendedConfig ? {
        ...(tpl.recommendedConfig.defaultModel !== undefined ? { defaultModel: tpl.recommendedConfig.defaultModel } : {}),
        ...(tpl.recommendedConfig.budget ? { budget: { ...tpl.recommendedConfig.budget } } : {}),
        ...(tpl.recommendedConfig.maxTokensPerTask !== undefined ? { maxTokensPerTask: tpl.recommendedConfig.maxTokensPerTask } : {}),
        ...(tpl.recommendedConfig.permissions ? { permissions: { ...tpl.recommendedConfig.permissions } } : {}),
      } : undefined,
      requiredPermissions: tpl.requiredPermissions,
    });
    addAgents(agents);
    if (ceo) updateCompany(projectRoot, company.id, { ceoId: ceo.id });

    // C1:id 掺 companyId(bundledSkillId),原内联循环收进 installBundledSkills(与 communityRoutes
    // 同一实现,消灭又一处 id 推导)。createdSkillIds 供响应/回滚口径,与 onPlanned 的预演清单同款。
    const { count: bundledSkillsInstalled, createdIds: createdSkillIds } =
      installBundledSkills(projectRoot, tpl, agents.map((a) => a.role), companyId);

    // presetChannels 已在 onPlanned(transaction 落盘)前推导,这里只做真正的状态写入。
    let presetChannelsInstalled = 0;
    if (presetChannels.length) {
      updateCompany(projectRoot, company.id, { presetChannels });
      presetChannelsInstalled = presetChannels.length;
    }

    // 逐项结果交给 Semantic Fidelity 门统一判定。写盘函数本身按批次原子回滚，调用方再按
    // lost 报告补偿公司/员工/技能等状态，避免在报告生成前提前抛错。
    const agentMemoriesResult = importAgentMemoriesDetailed(projectRoot, idMap, opts?.agentMemories);

    return {
      ok: true, companyId: company.id, ceoId: ceo?.id ?? null, agentCount: agents.length,
      bundledSkillsInstalled, presetChannelsInstalled,
      agents, createdSkillIds, presetChannelKeys,
      agentMemoriesImported: agentMemoriesResult.written,
      agentMemoryFailures: agentMemoriesResult.failures,
    };
  } catch (e: any) {
    return { ok: false, status: 400, error: `恢复失败: ${e.message}` };
  }
}

/**
 * 从备份文件恢复成一个**新**公司(不覆盖原公司——用户当前可能已经手动重建了同名公司,语义上是
 * "从备份新建"而非"还原覆盖")。文件读取/schema 校验后落地逻辑见 installCompanyTemplate。
 *
 * D1 闭环:schema 通过后同样跑 Template Doctor——备份目录人工可写(篡改 hash/手改出成环组织的文件
 * 也能放进来),error 级默认 422 拒。但恢复是灾备场景,opts.force=true 是逃生门:跳过体检强行恢复,
 * 结果里如实标 forced:true(只有真的越过了 error 级体检才标,force 传了但体检本来就过不算"强行")。
 * 刻意**不**做 Safe Install 剥离:备份是自家公司的完整快照,恢复保真优先,剥离授权反而造成静默降级。
 *
 * 令四.6 · clone vs restore 语义分叉:
 *   · mode 缺省 "clone"(既有行为):reroot 出全新公司(新 id + agent id 加后缀,"(恢复)" 名后缀),
 *     可从同一备份反复克隆出多份互不影响的公司。
 *   · mode="restore"(真·灾备还原):**保留备份里的原公司 id 与 agent id/引用逐字**,不 reroot。若原
 *     公司 id 与**现存活公司**冲突 → 拒绝(先删除该公司或改用克隆导入),绝不覆盖。落地后逐一断言
 *     ID/引用/关键字段与备份一致(结构保真,不靠 ledger.lost=0 冒充),不一致则判失败不宣称成功。
 */
export function restoreCompanyFromBackup(
  projectRoot: string,
  filename: string,
  opts: { force?: boolean; mode?: "clone" | "restore" } = {},
): RestoreCompanyResult {
  if (!/^[\w.-]+\.json$/.test(filename) || filename.includes("..")) {
    return { ok: false, status: 400, error: "非法文件名" };
  }
  const filepath = path.join(companyBackupsDir(projectRoot), filename);
  if (!fs.existsSync(filepath)) return { ok: false, status: 404, error: "备份文件不存在" };

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filepath, "utf-8"));
  } catch (e: any) {
    return { ok: false, status: 400, error: `备份文件不是合法 JSON: ${e.message}` };
  }
  const parsed = CompanyTemplateSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "备份内容不符合 CompanyTemplate schema: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  }
  const doctor = runTemplateDoctor(parsed.data, { projectRoot });
  if (!doctor.install_allowed && !opts.force) {
    return { ok: false, status: 422, error: doctorErrorText(doctor), doctor };
  }
  const tpl = parsed.data as CompanyTemplate;

  if (opts.mode === "restore") {
    // 备份的 tpl.id 形如 `local-<原公司 id>`;还原成原公司 id(companyToTemplate 的导出约定)。
    const originalCompanyId = tpl.id.replace(/^local-/, "");
    // id 与现存活公司冲突 → 拒绝(先删除或改用克隆导入),绝不覆盖既有公司。
    if (getCompany(projectRoot, originalCompanyId)) {
      return { ok: false, status: 409, error: `restore 拒绝:原公司 id「${originalCompanyId}」已存在活公司,还原会覆盖。请先删除该公司,或改用克隆导入(clone)。` };
    }
    // agent id 与现存活 agent(任何公司)冲突 → 拒绝(保留原 id 会撞车)。
    const liveAgentIds = new Set(getAgents().map((a) => a.id));
    const collidingAgentIds = tpl.agents.map((a) => a.id).filter((id) => liveAgentIds.has(id));
    if (collidingAgentIds.length) {
      return { ok: false, status: 409, error: `restore 拒绝:${collidingAgentIds.length} 个 agent id 与现存活 agent 冲突(保留原 id 会撞车),请先删除相关公司或改用克隆导入。`, };
    }
    const result = installCompanyTemplate(projectRoot, tpl, {
      preserveIds: true,
      companyIdOverride: originalCompanyId,
      agentMemories: tpl.agentMemories,
    });
    if (!result.ok) return result;
    // 落地后逐一断言 ID/引用/关键字段与备份一致(结构保真)。
    const fidelity = verifyRestoreFidelity(projectRoot, originalCompanyId, tpl);
    try {
      const semanticFidelity = finalizeSemanticFidelity({
        projectRoot, operation: "restore",
        sourceSchemaVersion: LEGACY_BUNDLE_VERSION, targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
        source: tpl, target: { ...tpl, agents: result.agents },
        overrides: {
          lost: [
            ...fidelity.mismatches.map((_mismatch, index) => `restoreVerification[${index}]`),
            ...result.agentMemoryFailures.map((_failure, index) => `agentMemories.importFailure[${index}]`),
          ],
        },
      });
      return { ...result, doctor, forced: !doctor.install_allowed ? true : undefined, mode: "restore", fidelity, semanticFidelity };
    } catch (error) {
      // 报告必须先持久化,再补偿回滚;响应只返回字段路径,不把可能含敏感值的校验原文写进报告。
      try { deleteCompany(projectRoot, originalCompanyId); removeAgentsByCompany(originalCompanyId); } catch { /* best-effort */ }
      const semanticFidelity = semanticFidelityReportFromError(error);
      return {
        ok: false, status: 500,
        error: fidelity.ok ? `restore 语义保真报告写入失败(已回滚):${(error as Error)?.message || String(error)}` : `restore 保真校验失败(已回滚):${fidelity.mismatches.join("; ")}`,
        ...(semanticFidelity ? { semanticFidelity } : {}),
      };
    }
  }

  const result = installCompanyTemplate(projectRoot, tpl, {
    nameSuffix: "(恢复)",
    agentMemories: tpl.agentMemories,
  });
  if (!result.ok) return result;
  try {
    const semanticFidelity = finalizeSemanticFidelity({
      projectRoot, operation: "restore",
      sourceSchemaVersion: LEGACY_BUNDLE_VERSION, targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
      source: tpl, target: { ...tpl, agents: result.agents },
      overrides: { lost: result.agentMemoryFailures.map((_failure, index) => `agentMemories.importFailure[${index}]`) },
    });
    return { ...result, doctor, forced: !doctor.install_allowed ? true : undefined, mode: "clone", semanticFidelity };
  } catch (error) {
    try { deleteCompany(projectRoot, result.companyId); removeAgentsByCompany(result.companyId); } catch { /* best-effort */ }
    const semanticFidelity = semanticFidelityReportFromError(error);
    return { ok: false, status: 500, error: `restore clone 语义保真失败(已回滚):${(error as Error)?.message || String(error)}`, ...(semanticFidelity ? { semanticFidelity } : {}) };
  }
}

// 令四.6 · restore 保真断言:落地后的公司 agent 集合(按原 id)与备份逐项比对——
// ① agent id 集合完全一致;② 每个 agent 的 parentId/role/name 与备份一致(preserveIds 下应逐字相等);
// ③ 预置通道数量与备份 a2aChannels 可解析数一致(引用保真);④ 关键公司字段(name/workflow/mcp)一致。
// 任一不符即 mismatches 记一条,ok=false。结构断言,不靠 ledger.lost=0 冒充。
export function verifyRestoreFidelity(
  projectRoot: string,
  companyId: string,
  backup: CompanyTemplate,
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const live = getAgents().filter((a) => (a.companyId ?? "default") === companyId);
  const liveById = new Map(live.map((a) => [a.id, a]));
  const backupIds = new Set(backup.agents.map((a) => a.id));

  // ① id 集合
  if (live.length !== backup.agents.length) mismatches.push(`agent 数不符(备份 ${backup.agents.length} / 落地 ${live.length})`);
  for (const a of backup.agents) {
    const l = liveById.get(a.id);
    if (!l) { mismatches.push(`备份 agent「${a.id}」未在落地公司中找到(id 未保真)`); continue; }
    // ② parentId/role/name
    if ((l.parentId ?? "") !== (a.parentId ?? "")) mismatches.push(`agent「${a.id}」parentId 不符(备份 ${a.parentId ?? "无"} / 落地 ${l.parentId ?? "无"})`);
    if ((l.role ?? "") !== (a.role ?? "")) mismatches.push(`agent「${a.id}」role 不符`);
    if ((l.name ?? "") !== (a.name ?? "")) mismatches.push(`agent「${a.id}」name 不符`);
  }
  for (const l of live) if (!backupIds.has(l.id)) mismatches.push(`落地公司多出备份没有的 agent「${l.id}」`);

  // ③ 预置通道数量(引用保真):identity idMap 解析备份 a2aChannels(自环/悬空丢弃),与落地公司 presetChannels 比数。
  const company = getCompany(projectRoot, companyId);
  const identityIdMap: Record<string, string> = Object.fromEntries(backup.agents.map((a) => [a.id, a.id]));
  const resolvableChannels = (backup.a2aChannels ?? [])
    .map((c) => ({ from: resolveTemplateAgentRef(backup.agents, identityIdMap, c.from), to: resolveTemplateAgentRef(backup.agents, identityIdMap, c.to) }))
    .filter((c) => !!c.from && !!c.to && c.from !== c.to);
  const liveChannels = company?.presetChannels ?? [];
  if (liveChannels.length !== resolvableChannels.length) mismatches.push(`预置通道数不符(备份可解析 ${resolvableChannels.length} / 落地 ${liveChannels.length})`);

  // ④ 关键公司字段
  if (company) {
    if ((company.workflow ? JSON.stringify(company.workflow) : "") !== (backup.workflow ? JSON.stringify(backup.workflow) : "")) mismatches.push("workflow(验证边)与备份不符");
    const bm = JSON.stringify(backup.mcpRequirements ?? []);
    const lm = JSON.stringify(company.manifestMcpRequirements ?? []);
    if (bm !== lm) mismatches.push("manifestMcpRequirements 与备份不符");
  }

  return { ok: mismatches.length === 0, mismatches };
}

export interface ConnectivityTestResult {
  agentId: string; name: string; role: string; provider: string; model: string;
  ok: boolean; latencyMs?: number; message?: string;
}

// 真实 bug(用户反馈"连通性测试结果很慢"):每个 agent 的测试调用(callModel/createAnthropicProvider/
// probe*Async)原来都没有超时——虽然全部 agent 已经用 Promise.all 并发测,但只要有一个 provider 配置
// 有问题(错的 baseUrl、失效的 key 导致的长时间挂起连接等),`Promise.all` 要等所有分支都 settle 才
// 返回,这一个卡住的分支就会把全部本该秒回的结果一起拖住。给每个分支包一层超时,单个 agent 最多拖
// 15 秒就诚实报"连接超时",不再拖累其余已经测完的 agent。
const CONNECTIVITY_TEST_TIMEOUT_MS = 15000;
function withConnectivityTimeout<T>(p: Promise<T>, ms = CONNECTIVITY_TEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`连接超时(超过 ${ms / 1000}s)`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/**
 * 能力报告"测试连接"按钮的固定契约实现(TrackA/TrackC 对接点):对公司内每个真实启用中的 agent,
 * 用它当前配置的 provider/model 真发一个极简 prompt 测试是否真的能调通。
 * · API(api key)agent:复用 callModel(modelGateway.ts)——同一条 env>keys 文件>config 的密钥解析链
 *   + 已注册的 provider handler,测的是"真实执行时会走的那条路",不是另起一套 fetch。
 * · codex 订阅制 CLI:没有 provider key 概念,测的是登录态是否有效(probeCodexAsync,installed &&
 *   loggedIn),不把"没有 apiKey"误报成失败——与 companyTemplate.ts checkTemplateRequirements/
 *   capabilityReport.ts 同一惯例。
 * · claude-code:**不是单纯的"订阅登录"判定**——节点面板的 claudeCodeUseApiKey 开关为 true 且解析出
 *   可用的 Anthropic apiKey 账号时,ClaudeCodeEngine.run() 会在 spawn 时现注入 ANTHROPIC_API_KEY,
 *   完全绕开订阅登录态(甚至不检查 loggedIn,见 ClaudeCodeEngine.ts `!avail.installed ||
 *   (!apiKeyMode && !avail.loggedIn)` 这一门)。连通性测试必须镜像同一条件分支,否则会两头出错:
 *   ① 已配好 key 但没登 CLI 订阅的 agent 会被误报"未登录"(其实真实执行完全能跑);
 *   ② 反过来只测"登录态"会漏掉"key 模式下 key 到底有没有真的能调通"这个更有信息量的信号。
 *   key 模式下改成对 Anthropic 真发一次极简 prompt(与 api/API agent 同等力度的真实连通性验证)。
 */
export async function runConnectivityTest(projectRoot: string, companyId: string): Promise<ConnectivityTestResult[]> {
  const agents = getAgents().filter((a) => a.companyId === companyId && a.enabled !== false);
  syncProvidersFromStore(projectRoot); // 确保 provider handler 是最新配置(key 可能在别处刚改过)
  return Promise.all(agents.map(async (a): Promise<ConnectivityTestResult> => {
    const base = { agentId: a.id, name: a.name, role: a.role, provider: a.provider, model: a.model };
    const fw = a.framework ?? "api";
    const t0 = Date.now();

    if (fw === "claude-code") {
      let apiKeyOverride: string | undefined;
      try { apiKeyOverride = resolveApiKeyOverride(loadAccounts(projectRoot), "claude-code", a.cliConfigDir, a.claudeCodeUseApiKey); }
      catch { /* best-effort:账号解析失败按未配置处理,退回订阅登录路径判定 */ }
      if (apiKeyOverride) {
        try {
          const out = await withConnectivityTimeout(createAnthropicProvider(apiKeyOverride)({
            agentId: a.id, provider: "anthropic", model: a.model,
            messages: [{ role: "user", content: "回复ok两个字" }], maxTokens: 16,
          }));
          return { ...base, ok: true, latencyMs: Date.now() - t0, message: (out.content || "").trim().slice(0, 60) || undefined };
        } catch (e: any) {
          return { ...base, ok: false, latencyMs: Date.now() - t0, message: e?.message || String(e) };
        }
      }
      try {
        const av = await withConnectivityTimeout(probeClaudeCodeAsync(a.cliConfigDir));
        const ok = !!av.installed && !!av.loggedIn;
        return { ...base, ok, latencyMs: Date.now() - t0, message: ok ? undefined : (av.detail || "未登录") };
      } catch (e: any) {
        return { ...base, ok: false, latencyMs: Date.now() - t0, message: e?.message || String(e) };
      }
    }

    if (fw === "codex") {
      try {
        const av = await withConnectivityTimeout(probeCodexAsync(a.cliConfigDir));
        const ok = !!av.installed && !!av.loggedIn;
        return { ...base, ok, latencyMs: Date.now() - t0, message: ok ? undefined : (av.detail || "未登录") };
      } catch (e: any) {
        return { ...base, ok: false, latencyMs: Date.now() - t0, message: e?.message || String(e) };
      }
    }

    try {
      const out = await withConnectivityTimeout(callModel({
        agentId: a.id, provider: a.provider, model: a.model, agentRole: a.role,
        messages: [{ role: "user", content: "回复ok两个字" }], maxTokens: 16,
      }));
      return { ...base, ok: true, latencyMs: Date.now() - t0, message: (out.content || "").trim().slice(0, 60) || undefined };
    } catch (e: any) {
      return { ...base, ok: false, latencyMs: Date.now() - t0, message: e?.message || String(e) };
    }
  }));
}

/**
 * Resolve Skill assets that are exclusively owned by a company before deleting it.
 * Legacy persona Skills without companyId are removed only when their role is unique
 * to this company; ambiguous/shared assets are deliberately retained.
 */
export function findCompanyOwnedSkillIds(projectRoot: string, companyId: string): string[] {
  const company = getCompany(projectRoot, companyId);
  if (!company) return [];

  const agents = getAgents();
  const companyRoles = new Set(
    agents.filter((agent) => (agent.companyId || "default") === companyId).map((agent) => agent.role),
  );
  const otherCompanyRoles = new Set(
    agents.filter((agent) => (agent.companyId || "default") !== companyId).map((agent) => agent.role),
  );
  const installTransactions = loadInstallTransactions(projectRoot);

  return listSkills(projectRoot)
    .filter((skill) => {
      if (skill.companyId) return skill.companyId === companyId;
      if (skill.origin === "bundled") {
        return isBundledSkillOwnedByCompany(skill, companyId, installTransactions, company);
      }
      if (skill.origin === "persona") {
        return companyRoles.has(skill.role) && !otherCompanyRoles.has(skill.role);
      }
      return false;
    })
    .map((skill) => skill.id);
}
export function register(app: Express, projectRoot: string) {
  app.get("/api/companies", (_req, res) => {
    res.json(ensureCompanies(projectRoot));
  });

  // Create a company + its root CEO so it's immediately usable.
  // 收口③:创建入口不再收 folder——主工作目录只能走带全套安全检查的 POST /api/companies/:id/folder,
  // 否则安全检查可被旁路(现有 UI 也只发 name/description)。
  app.post("/api/companies", (req, res) => {
    const { name, description } = req.body ?? {};
    if (!name || typeof name !== "string") return res.status(400).json({ error: "name required" });
    const nameIntegrity = checkTextIntegrity(name);
    if (nameIntegrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: nameIntegrity.reason });
    if (typeof description === "string") {
      const descIntegrity = checkTextIntegrity(description);
      if (descIntegrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: descIntegrity.reason });
    }
    const company = addCompany(projectRoot, { name, description: description ?? "" });
    const ceoId = `ceo-${company.id}`;
    updateAgent(ceoId, {
      id: ceoId, name: `${name} CEO`, role: "ceo", companyId: company.id,
      provider: "deepseek", model: "deepseek-v4-pro", framework: "api",
      childrenIds: [], status: "idle",
      tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
      editable: true, deletable: true, enabled: true,
    } as any);
    const withCeo = updateCompany(projectRoot, company.id, { ceoId }) ?? company;
    res.json(withCeo);
  });

  app.patch("/api/companies/:id", (req, res) => {
    const parsed = CompanySchema.partial().safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map(i => i.message).join("; ") });
    for (const field of ["name", "description"] as const) {
      const val = parsed.data[field];
      if (typeof val === "string") {
        const integrity = checkTextIntegrity(val);
        if (integrity.corrupted) return res.status(400).json({ error: CORRUPTED_INPUT_ERROR, detail: integrity.reason });
      }
    }
    // 收口③:folder(主工作目录)从通用 PATCH 剥离——CompanySchema 含 folder,partial() 会放行,
    // 不剥则 realpath/允许根/读写/磁盘/穿越检查可被这条旁路绕过;变更一律走 POST /:id/folder。
    const { folder: _folderBypassBlocked, ...patchData } = parsed.data;
    const updated = updateCompany(projectRoot, req.params.id, patchData);
    if (!updated) return res.status(404).json({ error: "company not found" });
    res.json(updated);
  });

  app.delete("/api/companies/:id", (req, res) => {
    const id = req.params.id;
    const ownedSkillIds = findCompanyOwnedSkillIds(projectRoot, id);
    const backupFile = backupCompanyBeforeDelete(projectRoot, id);
    const deleted = deleteCompany(projectRoot, id);
    const removedAgents = deleted ? removeAgentsByCompany(id) : 0;
    let removedSkills = 0;
    const failedSkillIds: string[] = [];
    if (deleted) {
      for (const skillId of ownedSkillIds) {
        try {
          if (deleteSkill(projectRoot, skillId)) removedSkills++;
        } catch {
          failedSkillIds.push(skillId);
        }
      }
    }
    // Company deletion also purges its runtime memory so pending proposals and
    // historical conclusions cannot remain visible as orphaned company assets.
    let purgedMemory = { conclusions: 0, skills: 0, lessons: 0, entries: 0 };
    if (deleted) {
      const reg = purgeCompanyMemory(projectRoot, id);
      purgedMemory = {
        conclusions: reg.conclusions, skills: reg.skills,
        lessons: purgeCompanyLessons(projectRoot, id),
        entries: purgeCompanyMemoryEntries(projectRoot, id),
      };
    }
    res.json({ deleted, removedAgents, removedSkills, failedSkillIds, backupFile, purgedMemory });
  });

  // 列出全部删除前自动备份。
  app.get("/api/companies/backups", (_req, res) => {
    res.json(listCompanyBackups(projectRoot));
  });

  // 从备份恢复成一个新公司。D1 闭环:过 Template Doctor(error 级 422 拒);灾备逃生门 body.force=true
  // 跳过体检强行恢复(响应如实标 forced:true)。不做 Safe Install 剥离(自家备份,恢复保真优先)。
  app.post("/api/companies/backups/:filename/restore", (req, res) => {
    // 令四.6:mode 显式 "restore"(保留原 id + 保真断言)/ 缺省 "clone"(reroot 新公司,既有行为)。
    const mode = req.body?.mode === "restore" ? "restore" : "clone";
    const result = restoreCompanyFromBackup(projectRoot, req.params.filename, { force: req.body?.force === true, mode });
    if (!result.ok) return res.status(result.status).json({ error: result.error, ...(result.doctor ? { doctor: result.doctor } : {}), ...(result.semanticFidelity ? { semanticFidelity: result.semanticFidelity } : {}) });
    // D6 的落地明细(agents/createdSkillIds/presetChannelKeys)只供 /api/companies/import 落 install
    // transaction 用;restore 是灾备场景不记账,响应里去掉这几个内部字段,不虚增无意义的大 payload。
    const { ok: _ok, agents: _agents, createdSkillIds: _createdSkillIds, presetChannelKeys: _presetChannelKeys, ...body } = result;
    res.json(body);
  });

  // P0-3(canonical)· 导出活公司为完整 Company Bundle(带 schema_version + 结构/员工/经验/隐私记录),
  // 不再输出旧 flat 模板。companyToBundleTracked 落一条 export job,并按公司设置页的「导出时一并带上
  // 记忆」开关(memoryExportEnabled,默认 true)过滤 + 脱敏 memory.records、派生 required_secrets;
  // 结构字段(workflow/预置通道/打包技能/工具需求等)从 companyToTemplate 补挂到 bundle 上(V0
  // companyToBundle 只落 agents+memory+privacy),保证"导出 → 重新导入"不丢字段。导入端
  // (/api/companies/import 与 communityRoutes 的 templates/import)已能 parseCompanyBundle →
  // bundleToTemplateShape 无损往返。
  app.get("/api/companies/:id/export", (req, res) => {
    try {
      // 分场景导出:?profile=full(自己备份/迁移,保真)| share(社区分享,缺省,全脱敏 + 导入侧 Safe Install)。
      // 白名单校验回退默认 share(偏安全),不认识的值不静默升级成 full。full 档 companyToBundle 额外采集
      // 员工 agent-memory.md 进 agentMemories,并声明 export_profile;sanitizeBundleForExport 据档位决定
      // genericCli 保留/剥离、本机路径保留/占位。
      const profile = sanitizeExportProfile(req.query.profile);
      // P0-B⑥ · 单次构建 Bundle:companyToBundle(Tracked) 现在一次性携带全部可移植结构字段(readme/
      // useCases/riskNotes/toolRequirements/recommendedConfig/visibilityPolicy/workflow/bundledSkills/
      // mcpRequirements/a2aChannels/defaultTasks),不再 companyToBundleTracked 后又 companyToTemplate 二扫补挂。
      const { bundle } = companyToBundleTracked(projectRoot, req.params.id, { exportProfile: profile });
      // P0-4:出口整体过 sanitizeBundleForExport——按档位剥离/占位 genericCli/workspaceDir/cliConfigDir,
      // 正文(readme/bundledSkills 等模板字段)深度扫描占位化本机路径(share)与密钥形态(两档都剥)。
      const { bundle: sanitized } = sanitizeBundleForExport(bundle, { profile });
      // C2 · org 投影从**脱敏后**的载荷重新派生:sanitizeBundleForExport 深扫顶层字段但对 org 只回填
      // agents(见其 org 注释),companyToBundle 预填的 org.edges 里 a2a purpose 是脱敏前文本——不重投影
      // 会让 org 成为唯一漏扫面,且与脱敏后的顶层 a2aChannels 不一致(自己导出的包被 doctor 点破说谎)。
      const outBundle = {
        ...sanitized,
        org: { ...sanitized.org, agents: sanitized.agents, ...deriveOrgTeamsAndEdges(sanitized.agents, sanitized.a2aChannels, sanitized.workflow) },
      };
      // 文件名必须 ASCII-safe(HTTP 头不允许中文等非 ASCII);标题保留在 JSON 内。
      const safeName = (bundle.bundle_id || "company").replace(/[^\w.-]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.opc.bundle.json"`);
      res.json(outBundle);
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  });

  // Stage 1 · 导入/部署前检查模板的工具需求是否就绪(provider key/账号;engine 就绪留 Stage 5)。
  app.post("/api/companies/import-check", (req, res) => {
    try {
      res.json(checkTemplateRequirements(projectRoot, req.body));
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // 公司架构·表单「导入导出与备份」:直接导入一份本地 JSON 文件(不要求它在 .opc/company-backups/
  // 目录里)——body 就是文件原始内容(一份 CompanyTemplate,与 GET .../export 下载下来的格式对称)。
  // 校验 + 落地复用 installCompanyTemplate,与「从备份恢复」同一套逻辑,不重新发明。
  // D1 闭环(对抗验收缺口):这里是陌生 JSON 直接落地成活公司的入口,安全线必须与
  // communityRoutes 的 install/company 同构——zod 之后先过 Template Doctor(篡改 hash/组织成环
  // 等 error 级 → 422 + doctor checks),再对非 official 模板默认 Safe Install 剥离高危授权
  // (令四.1:显式保留走后端一次性 token 两步流——preview 分支签发 installConfirmationToken,
  // 真装带回并校验+消费才放行;客户端布尔 unsafeAcknowledged 已废)。trustLevel 不信 JSON 的
  // 自我声明(自封 "official" 即可绕过剥离),按 verifyAndAssignTrust 的 hash 校验结果重新赋值
  // 后再进 applySafeInstall。
  // D3 · body 顶层可与 CompanyTemplate 字段并存 mode("new-company"缺省 | "merge" | "preview")、
  // targetCompanyId、mergeStrategies、confirmOverwrite、installConfirmationToken 等控制字段——
  // 解析模板时不参与语义,这里直接读原始 req.body。preview/merge 语义与 communityRoutes.ts 的
  // install/company 同构,不重新发明(见该路由顶部注释)。
  app.post("/api/companies/import", (req, res) => {
    // P0-3 · 导入端兼容 canonical Company Bundle:带 schema_version 的原生 bundle 先 parseCompanyBundle
    // → bundleToTemplateShape 桥接成扁平 CompanyTemplate 形状(与 communityRoutes.ts templates/import
    // 同一口径,memory.records 一并桥接成 seedMemories);旧 flat 模板(无 schema_version)照走
    // CompanyTemplateSchema 兜底 —— legacy 导入不破坏。mode/targetCompanyId/memoryImportMode 等控制字段
    // 仍从原始 req.body 读(zod 非 strict 解析模板时静默忽略它们)。
    const asBundle = parseCompanyBundle(req.body);
    // 令四.1 缺陷修复:扁平模板走兜底分支时 body 即模板本体,mode/installConfirmationToken 等控制字段与
    // 模板同层且会被 .passthrough() 收进 parsed.data —— 剥离后 doctor 扫描面与 templateHash 才对扁平输入
    // 稳定(否则 token 的 UUID 被密钥正则误判 → 422;preview 的 mode 与真装的 token 进 hash → 两步流 409)。
    const candidate: unknown = asBundle.ok ? bundleToTemplateShape(asBundle.bundle!) : stripImportControlFields(req.body);
    const parsed = CompanyTemplateSchema.safeParse(candidate);
    if (!parsed.success) {
      return res.status(400).json({ error: "文件内容不符合 CompanyTemplate schema: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    }
    const tplRaw = parsed.data as CompanyTemplate;
    const sourceSchemaVersion = asBundle.ok ? asBundle.bundle!.schema_version : LEGACY_BUNDLE_VERSION;
    const sourceRedactedFields = asBundle.ok ? asBundle.bundle!.privacy.redacted_fields : [];
    // C2:原生 bundle 一并递给 doctor(org.teams/edges 与 agents 派生投影的交叉核对只能对信封做,
    // 桥接后的扁平模板不携带 org)。
    const doctor = runTemplateDoctor(tplRaw, { projectRoot, bundle: asBundle.ok ? asBundle.bundle : undefined });
    const mode: "new-company" | "merge" | "preview" =
      req.body?.mode === "merge" || req.body?.mode === "preview" ? req.body.mode : "new-company";
    // #26 · D5:本路由注释自称与 communityRoutes 的 install/company「同构」,但 seedMemories 此前被
    // 整个丢弃——同一份文件走两条导入口记忆结局不同且无任何提示。补齐同一套 memoryImportMode 语义。
    const memoryImportMode = sanitizeMemoryImportMode(req.body?.memoryImportMode);

    // 分场景导入:full 档=完整备份/迁移包(含 genericCli 命令与危险权限),share 档/旧 flat 模板维持
    // Safe Install 默认剥离高危授权。
    //   · 员工个人记忆(agentMemories → agent-memory.md)**两档都写回**(用户拍板:记忆与成长两档都
    //     默认带走,权限降权≠记忆不带;share 包的记忆正文在导出侧已全脱敏)。
    //   · workspaceDir 的 full 档占位标记($OPC_REMAP_WORKSPACE$)在 rerootAgents 里被清空 → 新机按公司/
    //     lead 默认重新解析(即"重映射"),genericCli 则原样保留(reroot 只清路径字段,不动 genericCli)。
    //   · 安全边界(改):full 免降权**不再凭文件自带 export_profile 自动生效**——本地导入无法区分"用户
    //     自己的备份"与"陌生人发来的 JSON",文件自封 full 即可绕过 Safe Install 还原任意命令+危险权限。
    //     故完整还原只认用户当场知情确认(令四.1:preview 签发的一次性 installConfirmationToken,
    //     真装带回才免降权);containsFullProfile 仅作提示信号回给
    //     前端,由 UI 决定是否弹"完整还原"确认。社区安装(install/company)本就永远走 Safe Install;
    //     分享端点(/share)把 full 强制降为 share(forceShareDowngrade)。
    const containsFullProfile = asBundle.ok && asBundle.bundle?.export_profile === "full";
    // 令四.1:旧的客户端布尔 unsafeAcknowledged 已被后端一次性 token 取代(见下方 preview/install 分支)。
    const importedAgentMemories: BundleAgentMemory[] | undefined = asBundle.ok
      ? asBundle.bundle?.agentMemories
      : tplRaw.agentMemories;

    if (mode === "preview") {
      // D8 补丁·验收缺口②:这条路由是「直接导入本地 JSON 文件」(见上方路由注释 + 本文件
      // installCompanyTemplate 头部注释),不经过社区浏览/安装管线 → 无 hash 时判 local_import
      // 而非笼统 untrusted(有 hash 但校验不过仍是 untrusted,localImport 不放宽完整性校验)。
      const { template: previewTrusted, hashVerified } = verifyAndAssignTrust(tplRaw, { localImport: true });
      // #38 同款(communityRoutes preview):summary/conflicts 基于真实安装将生效的模板计算——
      // 先按服务端重赋的 trust 走 applySafeInstall(镜像真实安装的 unsafeAcknowledged 参数),
      // 预览数字才与默认安装的落地结果一致。
      // 令四.1:预览恒展示 Safe Install 默认(剥离)视图;确认后的 unsafe 保留靠随预览签发的一次性 token。
      const previewSafe = applySafeInstall(previewTrusted, { unsafeAcknowledged: false });
      const summary = buildInstallPreviewSummary(previewSafe.template);
      const safeInstallPreview = previewSafe.stripped;
      const targetCompanyId = typeof req.body?.targetCompanyId === "string" ? req.body.targetCompanyId : undefined;
      let conflicts: MergeConflictReport | undefined;
      if (targetCompanyId) {
        const targetCompany = getCompany(projectRoot, targetCompanyId);
        if (!targetCompany) return res.status(404).json({ error: "target company not found" });
        conflicts = detectMergeConflicts(previewSafe.template, targetCompany, getAgents());
      }
      const seedMemories = tplRaw.seedMemories ?? [];
      const memoryPreview = {
        mode: memoryImportMode,
        totalRecords: seedMemories.length,
        filteredRecords: filterMemoryRecordsByImportMode(seedMemories, memoryImportMode).length,
      };
      // 令四.1 · 后端签发一次性安装确认 token(绑未剥离的 trusted 模板危险面),前端两步流用它带回真装。
      const issued = issueInstallConfirmationToken(computeInstallDangerSurface(previewTrusted), { scope: "companies/import" });
      return res.json({
        preview: true, summary, doctor, safeInstallPreview, memoryPreview,
        dangerFlags: dangerFlags(tplRaw), trustLevel: previewTrusted.trustLevel, hashVerified,
        containsFullProfile,
        installConfirmationToken: issued.installConfirmationToken, installConfirmationExpiresAt: issued.expiresAt,
        ...(conflicts ? { conflicts } : {}),
      });
    }

    if (!doctor.install_allowed) return res.status(422).json({ error: doctorErrorText(doctor), doctor });
    // D8 补丁·验收缺口②:同上——真正落地分支同样标 local_import(与上面 preview 分支的
    // trustLevel 保持一致,不出现"预览说 local_import,真装成了 untrusted"的不一致)。
    const { template: trusted } = verifyAndAssignTrust(tplRaw, { localImport: true });
    // 令四.1 · unsafe/full 保留只认后端签发的一次性 token(替代客户端布尔 unsafeAcknowledged)。带 token:
    // 校验+一次性消费(templateHash/危险面不符→409,重放→409,过期→410);不带→恒走 Safe Install 剥离。
    const installConfirmationToken = typeof req.body?.installConfirmationToken === "string" ? req.body.installConfirmationToken : undefined;
    let unsafeRetained = false;
    if (installConfirmationToken) {
      const consumed = consumeInstallConfirmationToken(installConfirmationToken, computeInstallDangerSurface(trusted), { scope: "companies/import" });
      if (!consumed.ok) return res.status(consumed.status).json({ error: consumed.reason, requiresRepreview: true });
      unsafeRetained = true;
    }
    const safeInstall = applySafeInstall(trusted, { unsafeAcknowledged: unsafeRetained });

    // 令四.3 · 引用歧义体检(canonical=agent id;role alias 多义整体拒绝),口径同 communityRoutes install/company。
    const ambiguousRefs = detectAmbiguousTemplateRefs(safeInstall.template);
    if (ambiguousRefs.length) {
      return res.status(422).json({ error: `模板存在 ${ambiguousRefs.length} 处歧义引用:role 名对应多个同 role 员工,无法确定指向哪一个,请改用 canonical agent id`, ambiguousRefs });
    }

    // 令四.5 · 部分安装失败补偿回滚:tx 落盘后的任何状态写抛错 → compensateInstallTransaction 逆向撤销;
    // 回滚也失败 → requires_rollback:true + txId,绝不返回成功形状。
    let recordedTx: InstallTransaction | undefined;
    try {
    if (mode === "merge") {
      const targetCompanyId = req.body?.targetCompanyId;
      if (!targetCompanyId || typeof targetCompanyId !== "string") {
        return res.status(400).json({ error: "merge 模式需要 targetCompanyId" });
      }
      const targetCompany = getCompany(projectRoot, targetCompanyId);
      if (!targetCompany) return res.status(404).json({ error: "target company not found" });
      const strategies = sanitizeMergeStrategies(req.body?.mergeStrategies);
      // C9-P0:map 到已有员工遇新父级三选一(白名单校验;非法/缺省 → undefined → resolveMerge 遇 orgParent
      // 冲突时 409 拒执行)。C9-P2:hoist 出局部变量,报告装配时需按它决定是否落 keep-current-org 复核条目。
      const orgParentResolution = ["keep-current-org", "adopt-template-org", "reject"].includes(req.body?.orgParentResolution) ? req.body.orgParentResolution : undefined;
      // P1#5:语义团队重复处置(白名单校验;非法/缺省 → undefined → resolveMerge 遇 teamDuplication 时 409 拒执行)。
      const teamDuplicationResolution = ["map", "overwrite", "add-department"].includes(req.body?.teamDuplicationResolution) ? req.body.teamDuplicationResolution : undefined;
      const result = resolveMerge(safeInstall.template, targetCompany, getAgents(), strategies, {
        attachParentId: targetCompany.ceoId,
        confirmOverwrite: req.body?.confirmOverwrite === true,
        teamDuplicationResolution,
        orgParentResolution,
      });
      if (!result.ok) return res.status(result.status).json({ error: result.error, conflicts: result.conflicts });

      const overwriteSet = new Set(result.overwriteAgentIds);
      const toAdd = result.agents.filter((a) => !overwriteSet.has(a.id));
      const toOverwrite = result.agents.filter((a) => overwriteSet.has(a.id));
      // 令四.5(wave4-live-acceptance P0)· addAgents 对已存在 id 会静默跳过——新增员工 id 若与【全局既有
      // agent(所有公司)】碰撞,员工不落地却仍被当作安装成功。安装前显式查重:碰撞则整体拒绝(未改动任何
      // 状态、不落 tx),绝不静默跳过、绝不宣称成功。resolveMerge 已按全局冲突重排唯一,这是纵深防御。
      const globalAgentIds = new Set(getAgents().map((a) => a.id));
      const collidingAddIds = toAdd.filter((a) => globalAgentIds.has(a.id)).map((a) => a.id);
      if (collidingAddIds.length) {
        return res.status(409).json({ error: `安装中止:${collidingAddIds.length} 名新增员工 id 与既有全局 agent 碰撞(addAgents 会静默跳过),整体未安装(未改动任何状态)`, collidingAgentIds: collidingAddIds });
      }
      // C9-P0 · adopt-template-org:既有员工改挂上级。快照受影响节点(被改挂员工 + 旧父 + 新父)的合并前
      // 整值进 orgParentRestores(rollback 走 restoreAgentsInPlace 原地整值恢复,保序不挪位,零残留)。
      // C9-P2:真正的 childrenIds 重建改到 addAgents 之后统一做(planOrgParentRebindApply)——新父可能是本次
      // 新建员工(在 toAdd 里),必须落地后才在集合中,否则新父 childrenIds 收不到被改挂的既有员工。
      const orgRebindings = result.orgParentRebindings;
      const orgParentPreSnapshots: AgentNodeConfig[] = [];
      if (orgRebindings.length) {
        const allAgents = getAgents();
        const affectedIds = new Set<string>();
        for (const rb of orgRebindings) {
          affectedIds.add(rb.agentId);
          if (rb.oldParentId) affectedIds.add(rb.oldParentId);
          if (rb.newParentId) affectedIds.add(rb.newParentId);
        }
        for (const a of allAgents) if (affectedIds.has(a.id)) orgParentPreSnapshots.push(structuredClone(a));
      }
      const beforeChannelKeys = new Set((targetCompany.presetChannels ?? []).map(channelKey));
      // 收口② · 公司级四字段(defaultTasks/manifestToolRequirements/visibilityPolicy/workflow)保守合并
      // + agentMemories 只导新建员工——两条 merge 路径共用 installMerge.ts 的同一组 helper,同口径。
      const fieldMerge = mergeCompanyLevelFields(targetCompany, safeInstall.template);
      const memoryPlan = planMergeAgentMemories(safeInstall.template.agentMemories, result);
      // 对抗验收缺口①②(与 communityRoutes.ts install/company merge 分支同一口径):合并前整份
      // manifestMcpRequirements + resolveMerge 吐出的覆盖前员工/改写前边一起存进 preMerge,回滚要用。
      // 收口②:公司级四字段整值快照进 companyFields(回滚整值恢复,undefined=恢复为「无」)。
      // C9-P0:adopt-org 的受影响节点整值快照与 overwrite 快照合并进 overwrittenAgents(同一回滚机制:
      // delete+re-add 整值恢复)。同一 id 只保留一份(overwrite 与 adopt 不会同时命中同一员工:map 目标是
      // 既有员工、overwrite 目标也是既有员工,但一次合并里同一员工只走一种处置)。
      // 令四.6:overwrite 快照(回滚 delete+re-add)与 adopt-org 改挂快照(回滚 restoreAgentsInPlace 保序)
      // 分列两字段;同一 id 只走一种处置,adopt 快照再排除已在 overwrite 快照中的 id 做纵深去重。
      const overwrittenIdSet = new Set(result.overwrittenAgents.map((a) => a.id));
      const orgParentRestores = orgParentPreSnapshots.filter((a) => !overwrittenIdSet.has(a.id));
      const preMerge = {
        manifestMcpRequirements: targetCompany.manifestMcpRequirements,
        ...(result.overwrittenAgents.length ? { overwrittenAgents: result.overwrittenAgents } : {}),
        ...(orgParentRestores.length ? { orgParentRestores } : {}),
        ...(result.modifiedChannels.length ? { modifiedChannels: result.modifiedChannels } : {}),
        companyFields: fieldMerge.preMergeCompanyFields,
      };

      // #22 · 「transaction 先落、状态后写」(与 communityRoutes.ts merge 分支同一口径:agent 只算
      // 真正新落地的 toAdd,presetChannel 只算合并前没有的 key,skill 走预演清单)。
      const newChannelKeys = result.presetChannels.map(channelKey).filter((k) => !beforeChannelKeys.has(k));
      const tx = recordInstallTransaction(projectRoot, {
        mode: "merge", source: safeInstall.template.id, companyId: targetCompany.id,
        created: {
          agentIds: toAdd.map((a) => a.id), companyIds: [], presetChannelKeys: newChannelKeys,
          skillIds: planBundledSkillCreatedIds(projectRoot, safeInstall.template, result.agents.map((a) => a.role), targetCompany.id),
        },
        agentSnapshots: toAdd.map(agentSnapshot),
        conflictDecisions: result.decisions,
        safeInstallStripped: safeInstall.stripped,
        preMerge,
      });
      recordedTx = tx;

      const addedCount = addAgents(toAdd);
      // 令四.5 · 核对 request vs landed:落地数与请求数不一致 = 有 id 被静默跳过(前置查重后不应发生,兜底)。
      // 撤销本次已落地的新增(前置查重保证这批 id 全新),标 tx failed,绝不宣称成功。
      if (addedCount !== toAdd.length) {
        try { removeAgentsByIds(toAdd.map((a) => a.id)); } catch { /* best-effort */ }
        try { markInstallTransactionFailed(projectRoot, tx.txId); } catch { /* best-effort */ }
        return res.status(409).json({ error: `安装中止:新增员工落地数(${addedCount})与请求数(${toAdd.length})不一致,疑似 id 静默跳过,已回滚本次新增`, txId: tx.txId, requestedAgents: toAdd.length, landedAgents: addedCount });
      }
      for (const a of toOverwrite) updateAgent(a.id, a);
      // C9-P0/P2 · adopt-template-org:在 addAgents 之后,对【目标公司落地后的全体 agents(既有 ∪ 本次新建)】
      // 统一以 parentId 为真源 rebuildChildrenIds 并 patch 受影响节点(被改挂员工 + 新旧父)。新父若是本次
      // 新建员工,此时已在 getAgents() 中,双向同步不再漏挂(修复"新父 childrenIds 不含被改挂员工"的失配)。
      if (orgRebindings.length) {
        const companyAgents = getAgents().filter((a) => (a.companyId ?? "default") === targetCompany.id);
        for (const p of planOrgParentRebindApply(companyAgents, orgRebindings)) updateAgent(p.id, { parentId: p.parentId, childrenIds: p.childrenIds });
      }
      const { count: bundledSkillsInstalled } = installBundledSkills(projectRoot, safeInstall.template, result.agents.map((a) => a.role), targetCompany.id);
      const missingMcp = computeMissingMcp(projectRoot, safeInstall.template.mcpRequirements);
      // 收口②:公司级四字段的保守合并 patch 一并落盘(fieldMerge.patch 只含真要改的键;
      // toolRequirements union 只写声明字段,绝不自动启用任何 MCP/Provider/Shell/权限)。
      updateCompany(projectRoot, targetCompany.id, { presetChannels: result.presetChannels, manifestMcpRequirements: result.mcpRequirements, ...fieldMerge.patch });

      // 收口②:agentMemories 只写"本次 merge 新建员工"(memoryPlan.importIdMap 已过滤掉 overwrite/
      // skipped/映射不上的——importAgentMemories 是整文件覆盖写,对既有员工调用即静默覆盖目标记忆)。
      // 回滚删这批新员工(tx.created.agentIds)即自然消除关联,不伤既有员工记忆。
      const plannedAgentMemories = (safeInstall.template.agentMemories ?? []).filter(
        (memory) => memoryPlan.importIdMap[memory.agent_id] !== undefined,
      );
      const agentMemoriesResult = importAgentMemoriesDetailed(
        projectRoot, memoryPlan.importIdMap, plannedAgentMemories);
      const agentMemoriesImported = agentMemoriesResult.written;

      // #26/#9 · D5 记忆导入(与 communityRoutes.ts merge 分支同构),真实写入的记录 id 补挂回 transaction。
      // C9-P1:merge 到已有公司,模板记忆走 pending 审批(asProposal:true),不静默直写生效。
      const memoryImport = applyMemoryImportModeTracked(projectRoot, safeInstall.template.seedMemories, memoryImportMode, { companyId: targetCompany.id, bundleId: safeInstall.template.id, asProposal: true });
      if (memoryImport.imported > 0) attachInstallTransactionMemory(projectRoot, tx.txId, memoryImport.recordIds);

      // 收口②:四类清单(preserved/added/requires_review/requires_local_setup)——未采纳/未支持的
      // 来源字段全部进报告,不静默消失(装配口径与 communityRoutes merge 分支逐参数一致)。
      // C9-P2:keep-current-org 未采纳模板父的组织差异并入 requires_review(兑现决策 summary 的"进 requires_review"承诺);
      // 仅 map 处置下有意义(非 map 时既有员工组织未被触碰,落条目=误报)。
      const orgParentReviewItems = buildKeepCurrentOrgReviewItems(result.conflicts.orgParent, orgParentResolution, teamDuplicationResolution);
      const report = finalizeMergeReport(fieldMerge.report, { memoryReviewItems: memoryPlan.reviewItems, missingMcp, agentMemoriesImported, agentMemoryFailures: agentMemoriesResult.failures, orgParentReviewItems });
      const mergeOverrides = mergeReportOverrides(report);
      const semanticFidelity = finalizeSemanticFidelity({
        projectRoot, operation: "merge", sourceSchemaVersion, targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
        source: tplRaw,
        target: { ...safeInstall.template, agents: result.agents },
        runtime: {
          missingCapabilities: missingMcp.map((item) => ({
            kind: "mcp" as const,
            name: item.name,
            reason: "not configured locally",
          })),
          proofLevel: "declarative",
        },
        overrides: {
          ...mergeOverrides,
          redacted: sourceRedactedFields,
          approvedAfterImport: safeInstallApprovedFields(safeInstall.stripped),
          lost: [
            ...memoryImport.failures.map((_failure, index) => `seedMemories.importFailure[${index}]`),
            ...agentMemoriesResult.failures.map((_failure, index) => `agentMemories.importFailure[${index}]`),
          ],
        },
      });

      return res.json({
        companyId: targetCompany.id, ceoId: targetCompany.ceoId ?? null, agentCount: addedCount + toOverwrite.length,
        missingMcp, bundledSkillsInstalled, presetChannelsInstalled: result.presetChannels.length,
        doctor, safeInstall: { applied: safeInstall.applied, stripped: safeInstall.stripped },
        decisions: result.decisions, mergedIntoCompanyId: targetCompany.id, txId: tx.txId, memoryImport,
        agentMemoriesImported, agentMemoryFailures: agentMemoriesResult.failures,
        memoryImportFailures: memoryImport.failures, report, semanticFidelity,
      });
    }

    // D6 · install transaction(new-company)。#22:经 onPlanned 在 installCompanyTemplate 的第一笔
    // 状态写(addCompany)之前落盘——transaction 需要的 id 全部来自安装计划,而非事后的落地结果。
    let tx: InstallTransaction | undefined;
    const result = installCompanyTemplate(projectRoot, safeInstall.template, {
      nameSuffix: "(导入)",
      agentMemories: importedAgentMemories,
      onPlanned: (plan) => {
        tx = recordInstallTransaction(projectRoot, {
          mode: "new-company", source: safeInstall.template.id, companyId: plan.companyId,
          created: { agentIds: plan.agents.map((a) => a.id), companyIds: [plan.companyId], presetChannelKeys: plan.presetChannelKeys, skillIds: plan.createdSkillIds },
          agentSnapshots: plan.agents.map(agentSnapshot),
          conflictDecisions: [],
          safeInstallStripped: safeInstall.stripped,
        });
      },
    });
    recordedTx = tx;
    // 令四.5 · installCompanyTemplate 内部 catch 吞掉了异常并返回 {ok:false}——若此时 tx 已落(onPlanned
    // 跑过=已开始写状态),公司/员工可能是半成品,必须补偿回滚,不能只回 error 却留下半装公司。
    if (!result.ok) {
      if (recordedTx) {
        const comp = compensateInstallTransaction(projectRoot, recordedTx);
        if (!comp.ok) return res.status(500).json({ error: result.error, requires_rollback: true, txId: recordedTx.txId, rollbackError: comp.error });
        return res.status(result.status).json({ error: result.error, rolledBack: true, txId: recordedTx.txId });
      }
      return res.status(result.status).json({ error: result.error });
    }
    const { ok: _ok, agents: _installedAgents, createdSkillIds: _createdSkillIds, presetChannelKeys: _presetChannelKeys, ...body } = result;
    const missingMcp = computeMissingMcp(projectRoot, safeInstall.template.mcpRequirements);

    // #26/#9 · D5 记忆导入(与 communityRoutes.ts new-company 分支同构),记录 id 补挂回 transaction。
    const memoryImport = applyMemoryImportModeTracked(projectRoot, safeInstall.template.seedMemories, memoryImportMode, { companyId: result.companyId, bundleId: safeInstall.template.id });
    if (tx && memoryImport.imported > 0) attachInstallTransactionMemory(projectRoot, tx.txId, memoryImport.recordIds);

    // 收口④:未登记的模板顶层字段如实随导入结果返回(passthrough 已保留字段本体,这里补"进报告"半边,
    // 不静默丢;merge 分支由 mergeCompanyLevelFields 落进 report.requires_review,口径一致)。
    const unregisteredFields = listUnregisteredTemplateFields(safeInstall.template);
    const semanticFidelity = finalizeSemanticFidelity({
      projectRoot, operation: "import", sourceSchemaVersion, targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
      source: tplRaw,
      target: { ...safeInstall.template, agents: result.agents },
      runtime: {
        missingCapabilities: missingMcp.map((item) => ({
          kind: "mcp" as const,
          name: item.name,
          reason: "not configured locally",
        })),
        proofLevel: "declarative",
      },
      overrides: {
        redacted: sourceRedactedFields,
        approvedAfterImport: safeInstallApprovedFields(safeInstall.stripped),
        transformed: memoryImportMode === "full" ? [] : ["seedMemories"],
        lost: [
          ...memoryImport.failures.map((_failure, index) => `seedMemories.importFailure[${index}]`),
          ...result.agentMemoryFailures.map((_failure, index) => `agentMemories.importFailure[${index}]`),
        ],
      },
    });
    res.json({ ...body, doctor, safeInstall: { applied: safeInstall.applied, stripped: safeInstall.stripped }, txId: tx?.txId, memoryImport, memoryImportFailures: memoryImport.failures, unregisteredFields, semanticFidelity });
    } catch (e: any) {
      // 令四.5:安装步骤抛错 → 按已落 tx 补偿回滚;回滚也失败 → requires_rollback:true + txId(非成功形状)。
      if (recordedTx) {
        const comp = compensateInstallTransaction(projectRoot, recordedTx);
        const semanticFidelity = semanticFidelityReportFromError(e);
        if (!comp.ok) return res.status(500).json({ error: e?.message || String(e), requires_rollback: true, txId: recordedTx.txId, rollbackError: comp.error, ...(semanticFidelity ? { semanticFidelity } : {}) });
        return res.status(semanticFidelity ? 409 : 500).json({ error: e?.message || String(e), rolledBack: true, txId: recordedTx.txId, ...(semanticFidelity ? { semanticFidelity } : {}) });
      }
      const semanticFidelity = semanticFidelityReportFromError(e);
      return res.status(semanticFidelity ? 409 : 400).json({ error: e?.message || String(e), ...(semanticFidelity ? { semanticFidelity } : {}) });
    }
  });

  // Stage 5 · 能力边界报告(执行前 confirm-gate 用):三段(已就绪/需授权/本团队不适用)+ 建议团队 + canRun。
  // async:引擎探针 spawn 子进程(~1-3s)。第③段只读 manifest 作者标注(不运行时自评)。
  app.get("/api/companies/:id/capability-report", async (req, res) => {
    try {
      // P0 · 预检按【本次将用的 teamMode/runType/目标 agent】判可用性——与真实执行同口径,避免报 canRun=true
      // 却在调度时 no_account。白名单校验:非法 teamMode/runType 一律缺省(等价旧行为,不静默改判)。
      const tm = req.query.teamMode;
      const teamMode = (tm === "economy" || tm === "balanced" || tm === "maxQuality") ? tm : undefined;
      const runType = (req.query.runType === "quick" || req.query.runType === "team") ? req.query.runType : undefined;
      const targetAgentId = typeof req.query.targetAgentId === "string" ? req.query.targetAgentId : undefined;
      res.json(await buildCapabilityReport(projectRoot, req.params.id, {}, { teamMode, runType, targetAgentId }));
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  });

  // 能力报告"测试连接"按钮:对该公司每个真实 agent 真发一次极简 prompt(或探测 CLI 登录态),
  // 报每个 agent 的连通结果(见 runConnectivityTest 上方注释)。
  app.post("/api/companies/:id/connectivity-test", async (req, res) => {
    const company = getCompany(projectRoot, req.params.id);
    if (!company) return res.status(404).json({ error: "company not found" });
    try {
      const results = await runConnectivityTest(projectRoot, req.params.id);
      res.json({ results });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 收口③ · 主工作目录设置/变更/清除的唯一入口(通用 PATCH 与创建入口都已剥 folder,防旁路)。
  // 空 folder = 清除绑定(回默认 .opc-studio 沙箱)。非空则过全套安全检查(realpath/允许根/读写/
  // 磁盘/穿越,见 workspaceGuard.ts),落库的是 canonical realPath。非 Git 目录(或无首 commit)
  // **零隐式初始化**:必须 body.initAsManagedWorkspace===true(用户在 UI 显式确认"初始化为 OPC
  // 托管工作区")才执行托管初始化,否则 409 + needs_init_confirmation,目录一个字节都不动。
  app.post("/api/companies/:id/folder", (req, res) => {
    const raw = String(req.body?.folder ?? "").trim();
    if (!raw) {
      const cleared = updateCompany(projectRoot, req.params.id, { folder: undefined });
      if (!cleared) return res.status(404).json({ error: "company not found" });
      return res.json({ company: cleared, cleared: true });
    }
    const check = validateWorkspaceFolder(projectRoot, raw);
    if (!check.ok) return res.status(400).json({ error: check.error, code: check.code });
    if (check.needsInit && req.body?.initAsManagedWorkspace !== true) {
      return res.status(409).json({
        error: "该目录不是带首个 commit 的 Git 仓库。需要显式确认「初始化为 OPC 托管工作区」(git init + 首个 commit)后才能绑定;未确认前不会对该目录做任何修改。",
        code: "needs_init_confirmation",
        needsInit: true,
        isGitRepo: check.isGitRepo === true,
        realPath: check.realPath,
      });
    }
    if (check.needsInit) {
      // 用户已显式确认 → 托管初始化(managed 模式:git init/.gitignore/README/首 commit)。
      if (!ensureGitRepo(check.realPath!, { mode: "managed" })) {
        return res.status(500).json({ error: "初始化 OPC 托管工作区失败(git init/首个 commit 未成功)" });
      }
    }
    const updated = updateCompany(projectRoot, req.params.id, { folder: check.realPath });
    if (!updated) return res.status(404).json({ error: "company not found" });
    res.json({ company: updated, folder: check.realPath, initialized: check.needsInit === true });
  });

  // Folder browser for the workspace picker (local desktop tool). Lists subdirectories of `path`
  // (defaults to home). The Electron shell can also use a native dialog; this is the web fallback.
  app.get("/api/fs/browse", (req, res) => {
    const p = (req.query.path as string) || os.homedir();
    try {
      const entries = fs.readdirSync(p, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith("."))
        .map(e => ({ name: e.name, path: path.join(p, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      res.json({ path: p, parent: path.dirname(p) === p ? null : path.dirname(p), dirs: entries });
    } catch (e: any) {
      res.status(400).json({ error: e.message, path: p });
    }
  });
}
