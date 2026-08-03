import type { Express } from "express";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  listTemplates, listTeams, listAgentCards, listPrompts,
  getTemplate, getTeam, getAgentCard, getPrompt,
  saveTemplate, saveTeam, saveAgentCard, savePrompt,
  incrementDownload, incrementStar,
  loadFavorites, toggleFavorite,
  listGitHubSources, addGitHubSource, removeGitHubSource,
  fetchGitHubSkillFiles, isLicenseAllowed, listBuiltinCommunitySkills,
  markRemoteUnlisted, filterUnlistedRemoteEntries, unlistLocalEntry,
  type IndexShelf,
} from "../storage/communityStore.js";
import { listSkills, getSkill, createSkill, updateSkill, deleteSkill } from "../storage/skillStore.js";
import { listMcpServers } from "../storage/mcpStore.js";
import type { CommunityIndexEntry, Skill, AgentNodeConfig, CompanyTemplate } from "@opc/shared";
import { DEFAULT_ALLOWED_LICENSES, CompanyTemplateSchema, AgentCardSchema, PromptTemplateSchema, TeamTemplateSchema, parseCompanyBundle, migrateBundleViaRegistry, bundleToTemplateShape, templateToBundle, deriveOrgTeamsAndEdges, listUnregisteredTemplateFields, CURRENT_BUNDLE_SCHEMA_VERSION, LEGACY_BUNDLE_VERSION } from "@opc/shared";
import { verifyAndAssignTrust, forkTemplate, dangerFlags } from "../runtime/templateTrust.js";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../storage/projectStore.js";
import { addCompany, updateCompany, getCompany, deleteCompany } from "../storage/companyStore.js";
import { addAgents, getAgents, updateAgent, removeAgentsByCompany, removeAgentsByIds, restoreAgentsInPlace } from "../runtime/orchestrator.js";
import {
  rerootAgents, isValidAttachParent, workerFromSkill,
  resolveTemplateAgentRef,
  applySafeInstall, installBundledSkills, planBundledSkillCreatedIds, computeMissingMcp,
  detectAmbiguousTemplateRefs, computeInstallDangerSurface,
} from "../runtime/install.js";
import { runTemplateDoctor, runShareSafetyGate, scanContentSafety, type TemplateDoctorReport } from "../runtime/templateDoctor.js";
import {
  detectMergeConflicts, resolveMerge, sanitizeMergeStrategies, buildInstallPreviewSummary,
  mergeCompanyLevelFields, planMergeAgentMemories, finalizeMergeReport,
  planOrgParentRebindApply, buildKeepCurrentOrgReviewItems,
  type MergeConflictReport,
} from "../runtime/installMerge.js";
import { deriveToolRequirements, importAgentMemoriesDetailed, buildImportBindingPlans, applyImportBindingPlans, type ImportBindingPlanItem, type ImportBindingLocalCapability } from "../runtime/companyTemplate.js";
import { collectConfiguredProviderCapabilities } from "../runtime/providerRegistry.js";
import { SUBSCRIPTION_STATIC_MODELS } from "../runtime/modelResolve.js";
import { sanitizeMemoryImportMode, filterMemoryRecordsByImportMode, applyMemoryImportModeTracked, sanitizeBundleForExport } from "../runtime/memoryBundle.js";
import { resolveGithubToken } from "../storage/githubTokenStore.js";
import { loadAccounts } from "../storage/providerStore.js";
import { backupCompanyBeforeDelete, compensateInstallTransaction } from "./companyRoutes.js";
import {
  recordInstallTransaction, getInstallTransaction, markInstallTransactionRolledBack,
  markInstallTransactionFailed, attachInstallTransactionMemory, loadInstallTransactions,
  issueInstallConfirmationToken, consumeInstallConfirmationToken,
  type InstallTransactionAgentSnapshot,
} from "../storage/installTransactionStore.js";
import { removeMemoryRecordsByIds } from "../storage/registryStore.js";
import { removeLessonsByIds } from "../storage/reflectionStore.js";
import { removeGovernedMemoryProposalsByIds } from "../runtime/memoryGovernance.js";
import {
  changedSemanticFields,
  finalizeSemanticFidelity,
  mergeReportOverrides,
  safeInstallApprovedFields,
  semanticFidelityReportFromError,
} from "../runtime/semanticFidelity.js";

// P0-1 · 本机能力快照(供导入绑定计划)。provider:env/keys/config/accounts 有 key 即算可用;
// engine:"api" 恒可用,订阅 CLI 用登录目录存在性做廉价启发式(诚实标注:仅目录探测,未真探针);
// MCP:listMcpServers 里 enabled 的 id/name。
function localCapabilityForBindingPlans(projectRoot: string) {
  const providerCapabilities = collectConfiguredProviderCapabilities(projectRoot);
  const engines = new Set<string>(["api"]);
  try { if (fs.existsSync(path.join(os.homedir(), ".claude"))) engines.add("claude-code"); } catch { /* */ }
  try { if (fs.existsSync(path.join(os.homedir(), ".codex"))) engines.add("codex"); } catch { /* */ }
  try {
    for (const account of loadAccounts(projectRoot)) {
      if (account.enabled === false) continue;
      for (const framework of account.frameworks ?? []) {
        if (["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"].includes(framework)) engines.add(framework);
      }
    }
  } catch { /* account registry unavailable: keep the conservative filesystem snapshot */ }
  const mcp = new Set<string>();
  try { for (const s of listMcpServers(projectRoot)) if (s.enabled !== false) { mcp.add(s.id); if (s.name) mcp.add(s.name); } } catch { /* */ }
  return {
    availableProviders: providerCapabilities.availableProviders,
    availableEngines: engines,
    availableMcpServers: mcp,
    defaultModelFor: (provider: string) => providerCapabilities.defaultModels.get(provider),
    defaultModelForEngine: (engine: string) => {
      const model = SUBSCRIPTION_STATIC_MODELS[engine]?.find((entry) => entry.isDefault) ?? SUBSCRIPTION_STATIC_MODELS[engine]?.[0];
      if (!model) return undefined;
      return {
        provider: engine === "claude-code" ? "anthropic"
          : engine === "codex" ? "openai"
          : engine === "gemini-cli" ? "google"
          : engine === "kimi-cli" ? "moonshot"
          : engine === "grok-build" ? "xai"
          : undefined,
        model: model.id,
      };
    },
  };
}

function bindingPlanKey(plan: Pick<ImportBindingPlanItem, "originalBinding">): string {
  const binding = plan.originalBinding;
  return `${binding.kind}:${binding.provider ?? ""}:${binding.name}`;
}

// P0-1 · 请求体 bindingPlans 的形状清洗:只接受合法计划项;非法条目整体丢弃(不部分应用)。
// 服务端不信任客户端伪造的 status/userApproved——只消费 action/targetBinding/userApproved 的语义,
// 应用时由 applyImportBindingPlans 重新匹配模板实际引用的 provider(纵深防御:计划指向模板不用的 provider → 无操作)。
function sanitizeBindingPlans(raw: unknown): ImportBindingPlanItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ImportBindingPlanItem[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") return undefined;
    const it = item as Record<string, unknown>;
    const ob = it.originalBinding as { kind?: unknown; name?: unknown; provider?: unknown } | undefined;
    if (!ob || typeof ob.kind !== "string" || typeof ob.name !== "string") return undefined;
    if (!["provider", "model", "engine", "mcp"].includes(ob.kind)) return undefined;
    const key = `${ob.kind}:${typeof ob.provider === "string" ? ob.provider : ""}:${ob.name}`;
    if (seen.has(key)) return undefined;
    seen.add(key);
    const action = it.action;
    if (!["keep", "map", "configure", "disable"].includes(String(action))) return undefined;
    const userApproved = it.userApproved === true;
    const tb = it.targetBinding as { engine?: unknown; provider?: unknown; model?: unknown } | undefined;
    const plan: ImportBindingPlanItem = {
      originalBinding: {
        kind: ob.kind as ImportBindingPlanItem["originalBinding"]["kind"],
        name: ob.name,
        ...(typeof ob.provider === "string" ? { provider: ob.provider } : {}),
      },
      status: "available", // 服务端不采信客户端 status;应用语义由 action 决定
      action: action as ImportBindingPlanItem["action"],
      userApproved,
      ...(tb && (typeof tb.engine === "string" || typeof tb.provider === "string" || typeof tb.model === "string")
        ? { targetBinding: {
            ...(typeof tb.engine === "string" ? { engine: tb.engine } : {}),
            ...(typeof tb.provider === "string" ? { provider: tb.provider } : {}),
            ...(typeof tb.model === "string" ? { model: tb.model } : {}),
          } }
        : {}),
    };
    out.push(plan);
  }
  return out;
}

function reconcileBindingPlans(
  authoritative: ImportBindingPlanItem[],
  submitted: ImportBindingPlanItem[],
  local: ImportBindingLocalCapability,
): { accepted: ImportBindingPlanItem[]; unresolved: ImportBindingPlanItem[] } {
  const selected = new Map(submitted.map((p) => [bindingPlanKey(p), p]));
  const accepted: ImportBindingPlanItem[] = [];
  const unresolved: ImportBindingPlanItem[] = [];
  for (const actual of authoritative) {
    if (actual.status === "available") {
      accepted.push({ ...actual, action: "keep", userApproved: true });
      continue;
    }
    if (actual.originalBinding.kind === "model" && actual.originalBinding.provider) {
      const providerResolution = accepted.find((p) =>
        p.originalBinding.kind === "provider" && p.originalBinding.name === actual.originalBinding.provider,
      );
      if (providerResolution?.action === "disable") {
        accepted.push({ ...actual, action: "disable", userApproved: true });
        continue;
      }
      if (providerResolution?.action === "map" && providerResolution.targetBinding?.model) {
        accepted.push({
          ...actual,
          action: "map",
          userApproved: true,
          targetBinding: { ...providerResolution.targetBinding },
        });
        continue;
      }
    }
    const choice = selected.get(bindingPlanKey(actual));
    if (!choice?.userApproved) {
      unresolved.push(actual);
      continue;
    }
    if (choice.action === "disable") {
      accepted.push({ ...actual, action: "disable", userApproved: true });
      continue;
    }
    if (choice.action === "map" && actual.originalBinding.kind === "provider") {
      const targetProvider = choice.targetBinding?.provider;
      if (targetProvider && local.availableProviders.has(targetProvider)) {
        accepted.push({
          ...actual,
          action: "map",
          userApproved: true,
          targetBinding: {
            provider: targetProvider,
            model: choice.targetBinding?.model || local.defaultModelFor?.(targetProvider),
          },
        });
        continue;
      }
    }
    if (choice.action === "map" && actual.originalBinding.kind === "model") {
      const targetProvider = choice.targetBinding?.provider;
      const targetModel = choice.targetBinding?.model;
      if (targetModel && (!targetProvider || local.availableProviders.has(targetProvider))) {
        accepted.push({ ...actual, action: "map", userApproved: true, targetBinding: { provider: targetProvider, model: targetModel } });
        continue;
      }
    }
    if (choice.action === "map" && actual.originalBinding.kind === "engine") {
      const targetEngine = choice.targetBinding?.engine;
      const targetProvider = choice.targetBinding?.provider;
      const targetModel = choice.targetBinding?.model;
      const apiTargetReady = targetEngine !== "api" || (!!targetProvider && local.availableProviders.has(targetProvider) && !!targetModel);
      if (targetEngine && local.availableEngines.has(targetEngine) && apiTargetReady) {
        accepted.push({
          ...actual,
          action: "map",
          userApproved: true,
          targetBinding: { engine: targetEngine, provider: targetProvider, model: targetModel },
        });
        continue;
      }
    }
    unresolved.push({ ...actual, action: choice.action, userApproved: false });
  }
  return { accepted, unresolved };
}


// downloads 仍保留极小权重(同 star 数时分高下),但不再主导热度。
function popularScore(e: CommunityIndexEntry): number {
  return e.stars * 3 + e.downloads * 0.5;
}

// Bug 修复(端到端验证抓出):Launch Mode 首发旗舰模板"AI Research Company"在种子数组里排第一位,
// 但这里从不看数组顺序——全新用户(downloads=0)按热度排根本轮不到它排前面,旗舰模板名不副实。
// 不引入"featured"这种通用策展字段(太重,近似 marketplace 基建,本阶段明确不做)——只精确置顶这一个
// 已知的、有明确产品意图的旗舰 id,其余排序逻辑不变。
//
// "One-Person AI Company" 组装完成后追加第二个置顶位——"one-person-ai-company"是三个部门模板(研究/
// 产品/发布)组装成的完整公司,是"一人公司"愿景的最终形态,首发案例价值不亚于研究模板。刻意**不**把
// ai-launch-company/ai-product-company 这两个中间态部门模板也加进来:它们已经被 one-person-ai-company
// 完整包含(读者装那一个就等于三个部门都有了),额外置顶只会让"精选"变成"半数模板都在置顶栏"、失去精选
// 的意义(现有 7 个公司模板里已经占 4 个)。保持两个置顶位——"先给一个最小可用的单部门起点(研究),
// 再给一个走完全程的完整形态(一人公司)"——比不加克制地把三个部门原件也塞进来更清楚地传达产品意图。
const PINNED_FIRST = new Set(["ai-research-company", "one-person-ai-company"]);

function applySortAndSearch(
  list: CommunityIndexEntry[],
  sort: string,
  search: string,
): CommunityIndexEntry[] {
  let result = list;
  if (search) {
    const q = search.toLowerCase();
    result = result.filter(e => e.title.toLowerCase().includes(q));
  }
  if (sort === "popular") {
    result = [...result].sort((a, b) => popularScore(b) - popularScore(a));
  } else {
    result = [...result].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const pinned = result.filter(e => PINNED_FIRST.has(e.id));
  if (pinned.length) result = [...pinned, ...result.filter(e => !PINNED_FIRST.has(e.id))];
  return result;
}

// 分场景·分享强制 share:就地把一份提交给社区分享的 data 下调成 share 语义——删除 full 保真档的
// 档位声明(export_profile,防社区流通文件自封 full 骗过本地导入的降权豁免)与每个 agent 的本机
// 命令/路径字段(genericCli / workspaceDir / cliConfigDir)。agentMemories **保留**(用户拍板:记忆
// 与成长两档都默认带走,share 也带,让模板自带经验)。原地改(share 表单的 data 是当次请求的一次性
// 对象),不动 memory/agentMemories/bundledSkills 正文——那些交给 runShareSafetyGate 扫密钥/绝对路径,
// 命中即 422 硬拦(分享前的密钥/本机路径脱敏仍硬拦,权限降权≠记忆不带)。best-effort:结构不符预期
// 就跳过,不抛。
export function forceShareDowngrade(data: unknown): void {
  if (!data || typeof data !== "object") return;
  const obj = data as Record<string, unknown>;
  delete obj.export_profile;
  const stripAgent = (a: unknown): void => {
    if (!a || typeof a !== "object") return;
    const node = a as Record<string, unknown>;
    delete node.genericCli;
    delete node.workspaceDir;
    delete node.cliConfigDir;
  };
  if (Array.isArray(obj.agents)) obj.agents.forEach(stripAgent);
  if (obj.agent) stripAgent(obj.agent); // worker 分享:单个 agent 卡
}

export function register(app: Express, projectRoot: string) {

  // ===== GitHub-backed 社区:免登录浏览(读公开仓库)+ 星标(Issue reaction 聚合) =====
  const GH_API = "https://api.github.com";
  const DEFAULT_COMMUNITY_REPO = { owner: "WUBING2023", name: "opc-studio-community", branch: "main" };
  // 董事长决策②:只允许接入 OPC 自己的社区仓库——不再读 config.github.communityRepo 覆盖(该字段仍保留于
  // ProjectConfig 结构,标 @deprecated,只为兼容旧 config.json,此处硬编码,不给任何代码路径可乘之机)。
  function communityRepo(): { owner: string; name: string; branch: string } {
    return { ...DEFAULT_COMMUNITY_REPO };
  }
  function ghHeaders(): Record<string, string> {
    const t = resolveGithubToken(projectRoot, loadConfig(projectRoot).github?.oauth?.accessToken);
    const h: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "OPC-Studio", "X-GitHub-Api-Version": "2022-11-28" };
    if (t) h.Authorization = `Bearer ${t}`;
    return h;
  }
  // GitHub 网络在本环境偶发 ConnectTimeout。带重试的 fetch,避免单次瞬时失败让浏览列表条目忽隐忽现 / 整体 500。
  async function ghFetch(url: string, opts?: RequestInit, tries = 3): Promise<Response | null> {
    for (let i = 0; i < tries; i++) {
      try { return await fetch(url, opts); }
      catch { if (i === tries - 1) return null; await new Promise(r => setTimeout(r, 400 * (i + 1))); }
    }
    return null;
  }
  // prompt 模块已下线(用处不大):社区只做团队模板 + Worker。
  const REMOTE_DIRS: Array<["template" | "agent", string]> = [["template", "templates"], ["agent", "agents"]];

  // 浏览结果缓存 + stale-while-revalidate:首次加载后,后续请求**立即**返回缓存(即便过期也先回,再后台刷新),
  // 用户不再等 GitHub 往返;自己写操作(分享/删除/点星)后失效。本环境 GitHub 网络偶发很慢,SWR 尤其重要。
  let remoteCache: { key: string; ts: number; payload: { repo: string; count: number; entries: any[] } } | null = null;
  let remoteRefreshing = false;
  const REMOTE_TTL = 60_000;
  const invalidateRemoteCache = () => { remoteCache = null; };

  // ── 星榜历史快照:董事长决策①——排行榜用 star,按日/周/月/年看涨幅。
  // 每次拉取社区数据(computeRemote 成功)把当天的 {type:id → stars} 追加一行到 .opc/community-stars-history.jsonl,
  // 同一天只记一次(用 SWR/预热等重复调用不会刷密度)。日/周/月/年榜 = 当前 stars - 最接近 N 天前的快照,数据不足 N 天则诚实地报"还差几天"(日榜 N=1,今天刚建档也会 not ready)。
  function starsHistoryFile(): string {
    return path.join(projectRoot, ".opc", "community-stars-history.jsonl");
  }
  interface StarsSnapshot { date: string; stars: Record<string, number> }
  function loadStarsHistory(): StarsSnapshot[] {
    try {
      const file = starsHistoryFile();
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter((x: any): x is StarsSnapshot => !!x && typeof x.date === "string" && x.stars && typeof x.stars === "object")
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch { return []; }
  }
  function appendStarsSnapshot(entries: Array<{ type: string; id: string; stars: number }>) {
    try {
      const dir = path.join(projectRoot, ".opc");
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const file = starsHistoryFile();
      const today = new Date().toISOString().slice(0, 10);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, "utf-8").trim().split("\n").filter(Boolean);
        const last = lines[lines.length - 1];
        if (last) {
          try { if (JSON.parse(last).date === today) return; } catch { /* 坏的最后一行,当没有,继续追加 */ }
        }
      }
      const stars: Record<string, number> = {};
      for (const e of entries) stars[`${e.type}:${e.id}`] = e.stars;
      fs.appendFileSync(file, JSON.stringify({ date: today, stars } as StarsSnapshot) + "\n");
    } catch { /* 快照失败不影响浏览,尽力而为 */ }
  }
  interface PeriodStars { ready: boolean; daysAvailable: number; daysNeeded: number; deltas: Record<string, number> }
  function periodDeltas(history: StarsSnapshot[], days: number, entries: Array<{ type: string; id: string; stars: number }>): PeriodStars {
    if (history.length === 0) return { ready: false, daysAvailable: 0, daysNeeded: days, deltas: {} };
    const firstMs = new Date(`${history[0].date}T00:00:00Z`).getTime();
    const daysAvailable = Math.floor((Date.now() - firstMs) / 86_400_000);
    if (daysAvailable < days) return { ready: false, daysAvailable, daysNeeded: days - daysAvailable, deltas: {} };
    // 取最接近「N 天前」但不晚于它的快照作基线(离 cutoff 最近的一条)。
    const cutoff = Date.now() - days * 86_400_000;
    let baseline = history[0];
    for (const h of history) {
      if (new Date(`${h.date}T00:00:00Z`).getTime() <= cutoff) baseline = h; else break;
    }
    const deltas: Record<string, number> = {};
    for (const e of entries) {
      const k = `${e.type}:${e.id}`;
      deltas[k] = Math.max(0, e.stars - (baseline.stars[k] ?? 0));
    }
    return { ready: true, daysAvailable, daysNeeded: 0, deltas };
  }

  async function computeRemote(): Promise<{ repo: string; count: number; entries: any[] }> {
    const repo = communityRepo();
    const key = `${repo.owner}/${repo.name}@${repo.branch}`;
    // 并行拉取各目录 + 目录内每个文件(原来串行,慢)。
    const perDir = await Promise.all(REMOTE_DIRS.map(async ([type, dir]) => {
      const listResp = await ghFetch(`${GH_API}/repos/${repo.owner}/${repo.name}/contents/${dir}?ref=${repo.branch}`, { headers: ghHeaders() });
      if (!listResp || !listResp.ok) return []; // 目录不存在 / 瞬时失败(已重试)→ 跳过
      const items = await listResp.json() as Array<{ type: string; name: string; path: string; download_url: string }>;
      if (!Array.isArray(items)) return [];
      const jsons = items.filter(it => it.type === "file" && it.name.endsWith(".json")).slice(0, 200);
      const entries = await Promise.all(jsons.map(async it => {
        try {
          const raw = await ghFetch(it.download_url);
          if (!raw || !raw.ok) return null;
          const data = await raw.json() as Record<string, any>;
          const id = String(data.id || it.name.replace(/\.json$/, ""));
          // author 可能是显示名(种子内容,另带 authorGitHub=login),也可能直接是上传者 login(用户提交)。
          const isLogin = (s: unknown): s is string => typeof s === "string" && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(s);
          // 优先用**审查强制过的 author**(==PR 提交者)派生主页链;authorGitHub 未校验,只作种子内容兜底,防冒名链接。
          const login = isLogin(data.author) ? data.author : isLogin(data.authorGitHub) ? data.authorGitHub : null;
          const display = (data.author && String(data.author)) || (login || null);
          // D8:内容自身若已带 visibility:"unlisted"(如社区仓库那边的下架 PR 已被合并)一并带出来,
          // 供下面 filterUnlistedRemoteEntries 兜底过滤——不依赖只靠本地 remote-unlisted.json 一处判断。
          return { type, id, title: String(data.title || data.name || id), author: display, authorLogin: login, authorUrl: login ? `https://github.com/${login}` : null, description: String(data.description || ""), path: it.path, stars: 0, downloads: 0, visibility: data.visibility === "unlisted" ? "unlisted" as const : undefined };
        } catch { return null; }
      }));
      return entries.filter(Boolean);
    }));
    // D8(指南 11.17 Community Report / Unlist)· 下架默认从列表过滤——本地标记优先(不等 PR 合并
    // 立刻在这台机器生效),内容自带的 visibility 字段兜底(PR 已合并的情况)。
    const out: any[] = filterUnlistedRemoteEntries(projectRoot, perDir.flat() as any[]);
    // 一次性取所有追踪 Issue 的 reaction(仅 1 次 API 调用):👍=star,🚀(rocket)=下载(粗略,按账号去重)。
    try {
      const isr = await ghFetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues?state=all&per_page=100`, { headers: ghHeaders() });
      if (isr && isr.ok) {
        const issues = await isr.json() as Array<any>;
        const stars = new Map<string, number>(), downloads = new Map<string, number>();
        for (const it of (Array.isArray(issues) ? issues : [])) {
          if (it.pull_request || typeof it.body !== "string") continue;
          const m = it.body.match(/\[opc-star\]([a-z]+):([^\s\]]+)/);
          if (m) { const k = `${m[1]}:${m[2]}`; stars.set(k, Number(it.reactions?.["+1"] ?? 0)); downloads.set(k, Number(it.reactions?.rocket ?? 0)); }
        }
        for (const e of out) { e.stars = stars.get(`${e.type}:${e.id}`) ?? 0; e.downloads = downloads.get(`${e.type}:${e.id}`) ?? 0; }
      }
    } catch { /* star/下载数可选,失败不影响浏览 */ }
    appendStarsSnapshot(out); // 每次成功拉取都记一笔今日快照(同一天去重)——喂给周/月涨幅榜
    const payload = { repo: key, count: out.length, entries: out };
    remoteCache = { key, ts: Date.now(), payload };
    return payload;
  }

  // 免登录浏览。无 token 也能读(public repo);有 token 时带上以抬高速率限制。
  app.get("/api/community/remote", async (req, res) => {
    try {
      const repo = communityRepo();
      const key = `${repo.owner}/${repo.name}@${repo.branch}`;
      if (req.query.fresh !== "1" && remoteCache && remoteCache.key === key) {
        const stale = (Date.now() - remoteCache.ts) >= REMOTE_TTL;
        if (stale && !remoteRefreshing) { // 过期 → 先回旧数据,后台悄悄刷新
          remoteRefreshing = true;
          computeRemote().catch(() => {}).finally(() => { remoteRefreshing = false; });
        }
        return res.json({ ...remoteCache.payload, cached: true, stale });
      }
      res.json(await computeRemote());
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });
  // 启动后台预热一次,让首个用户打开社区页就命中缓存(失败静默)。
  computeRemote().catch(() => {});

  // 取单条远程内容的完整 JSON(供导入到本地 / 编辑预填)。
  app.get("/api/community/remote/item", async (req, res) => {
    try {
      const type = String(req.query.type || ""), id = String(req.query.id || "");
      const dir = REMOTE_DIRS.find(([t]) => t === type)?.[1];
      if (!dir || !id) return res.status(400).json({ error: "type and id required" });
      const repo = communityRepo();
      const r = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/contents/${dir}/${encodeURIComponent(id)}.json?ref=${repo.branch}`,
        { headers: { ...ghHeaders(), Accept: "application/vnd.github.raw+json" } });
      if (!r.ok) return res.status(r.status === 404 ? 404 : 502).json({ error: `fetch failed ${r.status}` });
      const data = JSON.parse(await r.text());
      res.json({ type, id, data });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 日/周/月/年星标涨幅榜。ready=false 时前端应显示诚实空态,不是拿总榜凑数(日榜只需 1 天快照,当天刚建档也会 not ready)。
  app.get("/api/community/remote/history", async (_req, res) => {
    try {
      const entries = remoteCache?.payload.entries ?? (await computeRemote()).entries;
      const history = loadStarsHistory();
      res.json({
        day: periodDeltas(history, 1, entries),
        week: periodDeltas(history, 7, entries),
        month: periodDeltas(history, 30, entries),
        year: periodDeltas(history, 365, entries),
      });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 星标 = GitHub Issue 的 👍 reaction 原生聚合。每个内容项对应一个追踪 Issue(正文含 marker),
  // 点星 = 给该 Issue 加 👍;星标数 = 该 Issue 的 👍 数。免登录可读数,点星需登录。
  const starMarker = (type: string, id: string): string => `[opc-star]${type}:${id}`;
  async function findStarIssue(repo: { owner: string; name: string }, type: string, id: string): Promise<any | null> {
    const marker = starMarker(type, id);
    // MVP:扫前 100 个 issue 按 marker 匹配(社区做大需分页/索引;另:/issues 也含 PR,需排除)。
    const r = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues?state=all&per_page=100`, { headers: ghHeaders() });
    if (!r.ok) return null;
    const items = await r.json() as Array<any>;
    if (!Array.isArray(items)) return null;
    return items.find(it => !it.pull_request && typeof it.body === "string" && it.body.includes(marker)) || null;
  }
  const starCount = (issue: any): number => Number(issue?.reactions?.["+1"] ?? 0);

  app.get("/api/community/stars", async (req, res) => {
    try {
      const type = String(req.query.type || ""), id = String(req.query.id || "");
      if (!type || !id) return res.status(400).json({ error: "type and id required" });
      const repo = communityRepo();
      const issue = await findStarIssue(repo, type, id);
      if (!issue) return res.json({ stars: 0, issue: null });
      res.json({ stars: starCount(issue), issue: issue.number, url: issue.html_url });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/community/star", async (req, res) => {
    try {
      const { type, id, remove } = req.body || {};
      if (!type || !id) return res.status(400).json({ error: "type and id required" });
      const token = resolveGithubToken(projectRoot, loadConfig(projectRoot).github?.oauth?.accessToken);
      if (!token) return res.status(401).json({ error: "需要登录 GitHub 才能点星", needAuth: true });
      const repo = communityRepo();
      const H = { ...ghHeaders(), "Content-Type": "application/json" };
      let issue = await findStarIssue(repo, type, id);

      // 取消收藏/点星:删掉我自己的 👍 reaction(计数 -1)。
      if (remove) {
        if (!issue) { invalidateRemoteCache(); return res.json({ ok: true, stars: 0, removed: true }); }
        let myLogin: string | undefined;
        try { const u = await fetch(`${GH_API}/user`, { headers: ghHeaders() }); if (u.ok) myLogin = (await u.json() as any)?.login; } catch { /* */ }
        try {
          // 不在 URL 里按 content 过滤(query 里 "+" 会被解码成空格,过滤失效)——取全部 reaction,在 JS 里筛 content==="+1" 且是我。
          const rl = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/reactions?per_page=100`, { headers: ghHeaders() });
          if (rl.ok) {
            const mine = (await rl.json() as Array<any>).find(x => x.content === "+1" && String(x.user?.login || "").toLowerCase() === String(myLogin || "").toLowerCase());
            if (mine) await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/reactions/${mine.id}`, { method: "DELETE", headers: ghHeaders() });
          }
        } catch { /* */ }
        const fresh0 = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, { headers: ghHeaders() });
        const fj0 = fresh0.ok ? await fresh0.json() : null;
        invalidateRemoteCache();
        return res.json({ ok: true, stars: fj0 ? starCount(fj0) : null, issue: issue.number, removed: true });
      }

      if (!issue) {
        const cr = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues`, {
          method: "POST", headers: H,
          body: JSON.stringify({ title: `⭐ ${type}: ${id}`, body: `Star tracker for community ${type} \`${id}\`.\n\n${starMarker(type, id)}` }),
        });
        if (!cr.ok) return res.status(502).json({ error: `create star issue failed: ${cr.status}` });
        issue = await cr.json();
      }
      const rr = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/reactions`, {
        method: "POST", headers: H, body: JSON.stringify({ content: "+1" }),
      });
      // 重新读总数(reaction 幂等:同用户同 content 不重复计)
      const fresh = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, { headers: ghHeaders() });
      const fj = fresh.ok ? await fresh.json() : null;
      invalidateRemoteCache(); // 星标数变了 → 让下次浏览拿新数
      res.json({ ok: rr.ok || rr.status === 200 || rr.status === 201, stars: fj ? starCount(fj) : null, issue: issue.number, url: issue.html_url });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 下载(安装)粗略计数:给追踪 Issue 加 🚀 reaction(按账号去重,故"粗略")。未登录不计,但安装照常。
  app.post("/api/community/download", async (req, res) => {
    try {
      const { type, id } = req.body || {};
      const dir = REMOTE_DIRS.find(([t]) => t === type)?.[1];
      if (!dir || !id) return res.status(400).json({ error: "type and id required" });
      const token = resolveGithubToken(projectRoot, loadConfig(projectRoot).github?.oauth?.accessToken);
      if (!token) return res.json({ counted: false }); // 未登录:安装照常,只是不计数
      const repo = communityRepo();
      const H = { ...ghHeaders(), "Content-Type": "application/json" };
      let issue = await findStarIssue(repo, type, id);
      if (!issue) {
        const cr = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues`, {
          method: "POST", headers: H,
          body: JSON.stringify({ title: `⭐ ${type}: ${id}`, body: `Star tracker for community ${type} \`${id}\`.\n\n${starMarker(type, id)}` }),
        });
        if (!cr.ok) return res.json({ counted: false });
        issue = await cr.json();
      }
      await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}/reactions`, {
        method: "POST", headers: H, body: JSON.stringify({ content: "rocket" }),
      });
      const fresh = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/issues/${issue.number}`, { headers: ghHeaders() });
      const fj = fresh.ok ? await fresh.json() : null;
      invalidateRemoteCache();
      res.json({ counted: true, downloads: fj ? Number(fj.reactions?.rocket ?? 0) : null });
    } catch { res.json({ counted: false }); } // 计数尽力而为,绝不影响安装
  });

  // D8(指南 11.17 Community Report / Unlist)· "下架自己的远程内容",不叫"删除"——GitHub 历史不可能
  // 被真正抹掉(这条 PR 合并后,内容仍完整躺在仓库的提交历史里,只是从当前 tree 消失),UI/措辞统一
  // 用"下架"。所有权在此客户端预检 + review.mjs 二次强制(base author 必须 == PR author;该 Action
  // 在社区仓库那边独立维护,不在本项目代码里,本批不改它、也不对它的行为做任何假设)。
  // 本批新增的是"本地即时生效"这一半:所有权一确认(不等 PR 是否真的被合并),立刻在本机
  // .opc/community/remote-unlisted.json 记一笔——GET /api/community/remote 的列表默认把它滤掉,
  // 用户点完"下架"就能马上在自己的 OPC Studio 里看不到,不必等待review.mjs 跑完 + 有人手动合并 PR。
  app.post("/api/community/remote/delete", async (req, res) => {
    try {
      const { type, id } = req.body || {};
      const dir = REMOTE_DIRS.find(([t]) => t === type)?.[1];
      if (!dir || !id) return res.status(400).json({ error: "type and id required" });
      const token = resolveGithubToken(projectRoot, loadConfig(projectRoot).github?.oauth?.accessToken);
      if (!token) return res.status(401).json({ error: "需要登录 GitHub", needAuth: true });
      const repo = communityRepo();
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "OPC-Studio" };
      let ghLogin: string | undefined;
      try { const u = await fetch(`${GH_API}/user`, { headers }); if (u.ok) ghLogin = (await u.json() as any)?.login; } catch { /* */ }
      if (!ghLogin) return res.status(401).json({ error: "取不到 GitHub 身份" });
      const path = `${dir}/${id}.json`;
      // 所有权预检:文件 author 必须是我
      const cur = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/contents/${encodeURIComponent(dir)}/${encodeURIComponent(id)}.json?ref=${repo.branch}`, { headers: { ...headers, Accept: "application/vnd.github.raw+json" } });
      if (!cur.ok) return res.status(404).json({ error: "内容不存在" });
      let curAuthor: string | undefined;
      try { curAuthor = (JSON.parse(await cur.text()) as any)?.author; } catch { /* */ }
      if (String(curAuthor || "").toLowerCase() !== ghLogin.toLowerCase()) return res.status(403).json({ error: `只能下架自己的内容(该条属于 @${curAuthor || "?"})` });
      // 所有权确认 → 本地立即标下架(不等下面的 PR 流程是否走通;PR 走的是"请求上游也下架",
      // 两件事独立,本地这半先落地,用户体验上就是"点了立刻生效")。
      const unlisted = markRemoteUnlisted(projectRoot, type, id);
      invalidateRemoteCache();
      // 非 owner → fork
      const isOwner = ghLogin.toLowerCase() === repo.owner.toLowerCase();
      let headRepoOwner = repo.owner;
      if (!isOwner) {
        const fk = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/forks`, { method: "POST", headers });
        if (fk.ok) {
          headRepoOwner = ghLogin;
          for (let i = 0; i < 10; i++) { const p = await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}`, { headers }); if (p.ok) break; await new Promise(r => setTimeout(r, 1500)); }
          try { await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}/merge-upstream`, { method: "POST", headers, body: JSON.stringify({ branch: repo.branch || "main" }) }); } catch { /* */ }
        }
      }
      const br = await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}/git/refs/heads/${repo.branch || "main"}`, { headers });
      if (!br.ok) return res.status(502).json({ error: `get branch failed ${br.status}`, unlisted: true, unlistedAt: unlisted.unlistedAt });
      const baseSha = (await br.json() as any).object.sha;
      const tr = await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}/git/trees`, { method: "POST", headers, body: JSON.stringify({ base_tree: baseSha, tree: [{ path, mode: "100644", type: "blob", sha: null }] }) });
      if (!tr.ok) return res.status(502).json({ error: `tree failed ${tr.status}`, unlisted: true, unlistedAt: unlisted.unlistedAt });
      const treeSha = (await tr.json() as any).sha;
      const cm = await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}/git/commits`, { method: "POST", headers, body: JSON.stringify({ message: `Unlist ${type}: ${id}`, tree: treeSha, parents: [baseSha] }) });
      if (!cm.ok) return res.status(502).json({ error: `commit failed ${cm.status}`, unlisted: true, unlistedAt: unlisted.unlistedAt });
      const commitSha = (await cm.json() as any).sha;
      const branchName = `community-del/${ghLogin}-${type}-${String(id).slice(0, 16)}`;
      await fetch(`${GH_API}/repos/${headRepoOwner}/${repo.name}/git/refs`, { method: "POST", headers, body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitSha }) });
      const prHead = isOwner ? branchName : `${headRepoOwner}:${branchName}`;
      const pr = await fetch(`${GH_API}/repos/${repo.owner}/${repo.name}/pulls`, { method: "POST", headers, body: JSON.stringify({ title: `[Community] unlist ${type}: ${id} by ${ghLogin}`, head: prHead, base: repo.branch || "main", body: "下架自己的内容(via OPC Studio)——GitHub 历史不会真正删除,这条 PR 请求社区仓库把该文件从当前 tree 移除。" }) });
      // PR 请求本身失败(网络/权限)不影响已经生效的本地下架——如实返回 unlisted:true,
      // 前端可以据此告知用户"本地已下架,上游同步请求失败,可稍后重试"而不是笼统报错。
      if (!pr.ok) return res.status(502).json({ error: `PR failed ${pr.status} ${(await pr.text()).slice(0, 140)}`, unlisted: true, unlistedAt: unlisted.unlistedAt });
      res.json({ prUrl: (await pr.json() as any).html_url, unlisted: true, unlistedAt: unlisted.unlistedAt });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // List
  // D8 补丁·验收缺口①:?includeUnlisted=true 时看全量(体检/管理场景),缺省仍过滤 unlisted——
  // 与 communityStore.ts 的 ListOptions/excludeUnlisted 缺省口径保持一致,不在路由层另立一套判定。
  app.get("/api/community/templates", (req, res) => {
    const sort = (req.query.sort as string) || "popular";
    const search = (req.query.search as string) || "";
    const list = listTemplates(projectRoot, { includeUnlisted: req.query.includeUnlisted === "true" });
    res.json(applySortAndSearch(list, sort, search));
  });

  app.get("/api/community/teams", (req, res) => {
    const sort = (req.query.sort as string) || "popular";
    const search = (req.query.search as string) || "";
    const list = listTeams(projectRoot, { includeUnlisted: req.query.includeUnlisted === "true" });
    res.json(applySortAndSearch(list, sort, search));
  });

  app.get("/api/community/agents", (req, res) => {
    const sort = (req.query.sort as string) || "popular";
    const search = (req.query.search as string) || "";
    const list = listAgentCards(projectRoot, { includeUnlisted: req.query.includeUnlisted === "true" });
    res.json(applySortAndSearch(list, sort, search));
  });

  app.get("/api/community/prompts", (req, res) => {
    const sort = (req.query.sort as string) || "popular";
    const search = (req.query.search as string) || "";
    const list = listPrompts(projectRoot, { includeUnlisted: req.query.includeUnlisted === "true" });
    res.json(applySortAndSearch(list, sort, search));
  });

  // D8 补丁·验收缺口①(本地库下架无产品入口):存储层 unlistLocalEntry(D8)只标 visibility:"unlisted"+
  // unlistedAt,不删索引条目、不删内容文件——语义与远程下架(/api/community/remote/delete)对齐,
  // 统一叫"下架"不叫"删除"。type 复用与 /api/community/:type/:id/download 同一套命名
  // (templates|teams|agents|prompts);id 不存在于索引里 → 404,不静默返回成功。
  app.post("/api/community/local/:type/:id/unlist", (req, res) => {
    const type = req.params.type;
    if (type !== "templates" && type !== "teams" && type !== "agents" && type !== "prompts") {
      return res.status(400).json({ error: "type must be templates, teams, agents, or prompts" });
    }
    const unlisted = unlistLocalEntry(projectRoot, type as IndexShelf, req.params.id);
    if (!unlisted) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, unlisted: true });
  });

  // Get single
  app.get("/api/community/templates/:id", (req, res) => {
    const t = getTemplate(projectRoot, req.params.id);
    if (!t) return res.status(404).json({ error: "template not found" });
    res.json(t);
  });

  app.get("/api/community/teams/:id", (req, res) => {
    const t = getTeam(projectRoot, req.params.id);
    if (!t) return res.status(404).json({ error: "team not found" });
    res.json(t);
  });

  app.get("/api/community/agents/:id", (req, res) => {
    const a = getAgentCard(projectRoot, req.params.id);
    if (!a) return res.status(404).json({ error: "agent card not found" });
    res.json(a);
  });

  app.get("/api/community/prompts/:id", (req, res) => {
    const p = getPrompt(projectRoot, req.params.id);
    if (!p) return res.status(404).json({ error: "prompt not found" });
    res.json(p);
  });

  // Import(Stage 1:zod 校验防坏 manifest;Stage 8:hash 完整性校验 → 服务端赋 trustLevel;
  // D1:入库前统一跑 Template Doctor,error 级(篡改/组织成环)拒绝入库并返回 checks——
  // 之前"篡改 → untrusted 仍入库只标注",现在升级为拒绝,安全线前移到导入口)
  const doctorErrorText = (doctor: TemplateDoctorReport) =>
    "模板未通过安全体检:" + doctor.checks.filter(c => c.status === "error").map(c => c.message).join(";");
  // D6 · install transaction 的两个小工具:presetChannel 的去重 key(与 installMerge.ts
  // mergeChannels 内部的 key 同构,这里不导出复用是因为那边是模块私有 helper,两行同构逻辑
  // 不值得为它导出);agent 的最小快照(回滚前置检查"是否被用户事后改名/移动"用)。
  const channelKey = (c: { from: string; to: string }): string => `${c.from}=>${c.to}`;
  const agentSnapshot = (a: AgentNodeConfig): InstallTransactionAgentSnapshot =>
    ({ id: a.id, name: a.name, parentId: a.parentId, companyId: a.companyId ?? "default" });
  // D2:先探路 —— 带 schema_version 的原生 Company Bundle 走 parseCompanyBundle,桥接成既有 doctor/
  // install 管线认识的 CompanyTemplate 扁平形状(bundleToTemplateShape);不是(缺 schema_version,
  // 社区仓库已发布的旧模板全是这种)→ migrateBundleViaRegistry 查迁移注册表逐级兜底,确认它是一份
  // 可迁移的 legacy CompanyTemplate(响应里附带迁移后的 bundle 视图,供前端/审计使用)。legacy 分支的 candidate
  // 直接用原始 req.body ——它本就是 CompanyTemplateSchema 认识的扁平形状,不需要也不该被再桥接一次:
  // bundleToTemplateShape 只映射了 title/description/agents 等最小字段集,套用到 legacy 输入会丢
  // hash/workflow/a2aChannels/recommendedConfig 等既有导入路径依赖的字段,"迁移"反而变成"降级"。
  app.post("/api/community/templates/import", (req, res) => {
    try {
      const asBundle = parseCompanyBundle(req.body);
      const migrated = asBundle.ok ? null : migrateBundleViaRegistry(req.body);
      const candidate: unknown = asBundle.ok ? bundleToTemplateShape(asBundle.bundle!) : req.body;
      const parsed = CompanyTemplateSchema.safeParse(candidate);
      if (!parsed.success) return res.status(400).json({ error: "manifest 校验失败: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      // C2:原生 bundle 一并递给 doctor——org.teams/edges 与 agents 派生投影的交叉核对(warning 级)
      // 只能对信封做,桥接后的扁平 candidate 不携带 org。
      const doctor = runTemplateDoctor(candidate, { projectRoot, bundle: asBundle.ok ? asBundle.bundle : undefined });
      if (!doctor.install_allowed) return res.status(422).json({ error: doctorErrorText(doctor), doctor });
      // C10-P2:本地文件导入(用户从磁盘选 .json/粘贴)传 __localImport:true → 无 hash 的本地文件标
      // "本地导入(local_import)"而非笼统"未知来源(untrusted)",与 companyRoutes 本地 bundle 导入口径一致。
      // 远程拉取路径不传此旗标,保持 untrusted。zod strip 已把 __localImport 从模板体剔除(不进 hash/落盘)。
      const localImport = req.body?.__localImport === true;
      const { template, hashVerified } = verifyAndAssignTrust(parsed.data as any, { localImport });
      const semanticFidelity = finalizeSemanticFidelity({
        projectRoot,
        operation: "import",
        sourceSchemaVersion: asBundle.ok ? asBundle.bundle!.schema_version : LEGACY_BUNDLE_VERSION,
        targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
        source: parsed.data as CompanyTemplate,
        target: template,
        overrides: { redacted: asBundle.ok ? asBundle.bundle!.privacy.redacted_fields : [] },
      });
      saveTemplate(projectRoot, template);
      res.json({
        ok: true, trustLevel: template.trustLevel, hashVerified, dangerFlags: dangerFlags(template as any), doctor,
        migratedFromLegacy: migrated ? migrated.bundle : undefined,
        semanticFidelity,
      });
    } catch (e: any) {
      const semanticFidelity = semanticFidelityReportFromError(e);
      res.status(semanticFidelity ? 409 : 400).json({ error: e.message, ...(semanticFidelity ? { semanticFidelity } : {}) });
    }
  });

  // D1 · Template Doctor:统一体检报告(schema/hash/危险权限/能力缺口/组织环)。
  // GET 体检库内模板(附危险旗标 + Safe Install 默认剥离预览,供确认弹窗展示 Permission Diff);
  // POST 体检一份未入库的原始 manifest(前端导入前预检)。
  app.get("/api/community/templates/:id/doctor", (req, res) => {
    try {
      const t = getTemplate(projectRoot, req.params.id);
      if (!t) return res.status(404).json({ error: "template not found" });
      const doctor = runTemplateDoctor(t, { projectRoot });
      const { template, hashVerified } = verifyAndAssignTrust(t as any);
      const preview = applySafeInstall({ ...(t as any), trustLevel: template.trustLevel });
      res.json({
        id: t.id, doctor, dangerFlags: dangerFlags(t as any),
        trustLevel: template.trustLevel, hashVerified,
        safeInstallPreview: preview.stripped,
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/community/templates/doctor", (req, res) => {
    try {
      const doctor = runTemplateDoctor(req.body, { projectRoot });
      const parsed = CompanyTemplateSchema.safeParse(req.body);
      res.json({ doctor, dangerFlags: parsed.success ? dangerFlags(parsed.data as any) : [] });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // 模板工坊 v1 · 保存/更新一份创作者 DIY 的自定义模板(纯本地写,绝不碰远端仓库——分享仍走既有 /api/community/share)。
  // body: { template: 前端已拼好的 CompanyTemplate 草稿(author/downloads/stars/createdAt 由这里补齐/覆盖),
  //         personas?: [{ role, title, content }] }。personas 仅兼容旧客户端:内容会合并回对应
  // agent.systemPrompt 并参与安全扫描,不会再落成 Skill。同一 template id 再次 POST = 更新模板。
  function localAuthorName(): string {
    try {
      // 只作展示用的字符串（非文件名/路径），不强收窄到 ASCII；中文用户名要保留可读性。
      const raw = os.userInfo().username || "";
      const printable = Array.from(raw).filter((ch) => ch.codePointAt(0)! >= 0x20).join("");
      return printable.trim().slice(0, 40) || "local-creator";
    } catch {
      return "local-creator";
    }
  }
  app.post("/api/community/templates", (req, res) => {
    try {
      const body = req.body ?? {};
      const draftTemplate = {
        ...(body.template ?? {}),
        author: localAuthorName(),
        downloads: 0,
        stars: 0,
        createdAt: (body.template && typeof body.template.createdAt === "string" && body.template.createdAt) || new Date().toISOString(),
        // C10-P1:工坊保存剥离模板自带的信任/完整性信号——trustLevel/hash/signature 绝不信 body 自我声明,
        // 否则可构造 trustLevel:"official" 保存 → install/company 跳过 Safe Install(自封 official 绕过剥离)。
        // 信任等级由安装侧 verifyAndAssignTrust 按 hash 重赋;保存态不固化任何自封信任。
        trustLevel: undefined,
        hash: undefined,
        signature: undefined,
      };
      const personas = Array.isArray(body.personas) ? body.personas : [];
      const personaByRole = new Map<string, string>();
      for (const persona of personas) {
        if (typeof persona?.role === "string" && typeof persona?.content === "string" && persona.content.trim()) {
          personaByRole.set(persona.role, persona.content.slice(0, 32 * 1024));
        }
      }
      if (Array.isArray(draftTemplate.agents)) {
        draftTemplate.agents = draftTemplate.agents.map((agent: any) => ({
          ...agent,
          systemPrompt: agent.systemPrompt || personaByRole.get(agent.role),
        }));
      }
      const parsed = CompanyTemplateSchema.safeParse(draftTemplate);
      if (!parsed.success) return res.status(400).json({ error: "manifest 校验失败: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      const template = parsed.data as any;


      // P0-5 · 工坊库是"给别人拉取/后续分享"的地基,入库前强制过安全闸——密钥与本机绝对路径(含
      // persona 正文)一律硬拦,不落盘。危险权限不拦(安装侧 Safe Install 兜底)。
      const saveGate = runShareSafetyGate(template, { projectRoot, extraContent: personas });
      if (!saveGate.ok) {
        return res.status(422).json({ error: "内容未通过安全体检:" + saveGate.findings.map((f) => f.message).join(";"), findings: saveGate.findings });
      }

      saveTemplate(projectRoot, template);
      res.json({ ok: true, id: template.id, author: template.author });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stage 8 · Fork:克隆库内模板 + 改 agent + 新 id/version + forkedFrom 溯源 + 重新签名 → 存库,返回副本。
  app.post("/api/community/templates/:id/fork", (req, res) => {
    try {
      const src = getTemplate(projectRoot, req.params.id);
      if (!src) return res.status(404).json({ error: "template not found" });
      const forked = forkTemplate(src, req.body ?? {});
      const parsed = CompanyTemplateSchema.safeParse(forked);
      if (!parsed.success) return res.status(400).json({ error: "fork 后 manifest 非法: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      saveTemplate(projectRoot, parsed.data as any);
      res.json({ ok: true, template: parsed.data, trustLevel: forked.trustLevel, forkedFrom: forked.forkedFrom });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stage 8 · 完整性校验:重算 hash 与库内 hash 比对(检测篡改)。
  app.get("/api/community/templates/:id/verify", (req, res) => {
    try {
      const t = getTemplate(projectRoot, req.params.id);
      if (!t) return res.status(404).json({ error: "template not found" });
      const { template, hashVerified } = verifyAndAssignTrust(t as any);
      res.json({ id: t.id, hashPresent: !!(t as any).hash, hashVerified, trustLevel: template.trustLevel, dangerFlags: dangerFlags(t as any) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // P0-3(canonical)· 导出库内模板为完整 Company Bundle(带 schema_version + 结构字段 +
  // seedMemories→memory.records + privacy),不再输出旧 flat 签名模板。templateToBundle 保真携带
  // workflow/预置通道/打包技能/工具需求等结构字段;导入端(templates/import)已能 parseCompanyBundle
  // → bundleToTemplateShape 无损往返。
  app.get("/api/community/templates/:id/export", (req, res) => {
    try {
      const t = getTemplate(projectRoot, req.params.id);
      if (!t) return res.status(404).json({ error: "template not found" });
      // P0-4 · 导出脱敏统一层:剥离 agents 的 workspaceDir/cliConfigDir、占位化 bundledSkills 正文与
      // memory 里的本机路径/密钥,命中项记进 privacy.redacted_fields(canonical 导出路径的唯一脱敏关口)。
      // 分场景:社区(库内模板对外分发面)**强制 share 档**——不给 ?profile=full 逃生门,永远全脱敏、
      // 剥离 genericCli/本机路径,导入侧默认 Safe Install。full 保真档只走「我的组织」自己公司的
      // GET /api/companies/:id/export?profile=full(仅供自己备份/迁移,不经社区)。
      const bundle = sanitizeBundleForExport(templateToBundle(t as any, { exportProfile: "share" }), { profile: "share" }).bundle;
      // C2 · org 投影从**脱敏后**载荷重派生(同 companyRoutes 导出端点):templateToBundle 预填的
      // org.edges 里 a2a purpose 是脱敏前文本,sanitizeBundleForExport 对 org 只回填 agents 不深扫。
      const outBundle = {
        ...bundle,
        org: { ...bundle.org, agents: bundle.agents, ...deriveOrgTeamsAndEdges(bundle.agents, bundle.a2aChannels, bundle.workflow) },
      };
      const safeName = (bundle.bundle_id || "template").replace(/[^\w.-]/g, "_");
      res.setHeader("Content-Disposition", `attachment; filename="${safeName}.opc.bundle.json"`);
      res.json(outBundle);
    } catch (e: any) {
      res.status(404).json({ error: e.message });
    }
  });

  // Install a company template into the org as a NEW company (org mutation, not just a library save).
  // Creates the company + re-roots the template's full agent tree under it (fresh ids/usage).
  // Stage 8+:同一次安装里再落三件事(全部尽力而为,任一失败都不该拖垮整个安装):
  //   ① bundledSkills → upsert 进本机 skill store,按角色绑定(参考 persona 的 scoped-role 惯例防串染)。
  //   ② mcpRequirements → 对照本机已配 MCP,算出 missing 清单随响应返回(前端弹层引导去配置)。
  //   ③ a2aChannels → 换算成真实 agent id,落进 company.presetChannels(orchestrator 起 run 时自动 grant)。
  // D3 · 安装三模式(指南 §7 D3):new-company(缺省,现状行为逐字节不变)/ merge(合并到目标公司,
  // 五类冲突按策略处理)/ preview(仅预览,doctor + 安装摘要 + 可选合并冲突报告,不写任何状态)。
  app.post("/api/community/install/company", (req, res) => {
    // tx-first 落盘后若后续状态写入抛异常,catch 里做补偿回滚(令四.5),不静默留下 completed 假象。
    let recordedTxId: string | undefined;
    let recordedTx: import("../storage/installTransactionStore.js").InstallTransaction | undefined;
    try {
      const tplRaw = getTemplate(projectRoot, req.body?.templateId);
      if (!tplRaw) return res.status(404).json({ error: "template not found" });
      const doctor = runTemplateDoctor(tplRaw, { projectRoot });
      const mode: "new-company" | "merge" | "preview" =
        req.body?.mode === "merge" || req.body?.mode === "preview" ? req.body.mode : "new-company";
      // D5 · Memory Import Mode 四选一(指南 11.17):只结构 / 结构+SOP(缺省)/ +verified / 全部。
      // 非法值一律回退默认,不让一条坏字符串静默改变安装行为(同 installMerge.sanitizeMergeStrategies 惯例)。
      const memoryImportMode = sanitizeMemoryImportMode(req.body?.memoryImportMode);

      // preview:只读,doctor 即便 error 级也照常返回(预览的意义正是让用户在动手前看到会不会被拦),
      // 不写任何状态。传 targetCompanyId 时附带合并冲突报告(供合并模式的确认弹窗展示)。响应同时带
      // dangerFlags/trustLevel/hashVerified——与既有 GET /templates/:id/doctor 同一口径,前端弹窗可以
      // 只调这一个预览接口就拿全部体检信息,不必再多打一次 GET。
      if (mode === "preview") {
        // #38:预览必须镜像真实安装的参数与剥离——summary/conflicts 基于 applySafeInstall 之后的副本
        // 计算,否则非 official 模板预览报 newA2AChannels=N、
        // 列出 a2a_rule 冲突,而默认(Safe Install)安装实际落 0 条通道,预览承诺与落地结果不符。
        // C10-P1:预览也先按 hash 重赋 trustLevel,再喂给 applySafeInstall——保证预览的剥离结果与真实
        // 落地一致(自封 official 在预览阶段就不再跳过剥离)。
        // 令四.1:预览恒展示 **Safe Install 默认(剥离)** 视图——这是不确认时的落地结果;dangerFlags 单独
        // 告知"确认后可保留的高危面",随预览签发的 token 才是启用保留的凭据(不再靠客户端 unsafeAcknowledged 布尔)。
        const { template: previewTrusted, hashVerified } = verifyAndAssignTrust(tplRaw as any);
        const previewSafe = applySafeInstall(previewTrusted as any, { unsafeAcknowledged: false });
        const summary = buildInstallPreviewSummary(previewSafe.template);
        const safeInstallPreview = previewSafe.stripped;
        const targetCompanyId = typeof req.body?.targetCompanyId === "string" ? req.body.targetCompanyId : undefined;
        let conflicts: MergeConflictReport | undefined;
        if (targetCompanyId) {
          const targetCompany = getCompany(projectRoot, targetCompanyId);
          if (!targetCompany) return res.status(404).json({ error: "target company not found" });
          conflicts = detectMergeConflicts(previewSafe.template, targetCompany, getAgents());
        }
        // D5 · 指南 11.8 安装预览要求"显示 Memory Import Mode":totalRecords = 模板携带的全部记忆条数,
        // filteredRecords = 按当前所选 mode 过滤后真正会导入的条数(不写任何状态,纯预览)。
        const seedMemories = tplRaw.seedMemories ?? [];
        const memoryPreview = {
          mode: memoryImportMode,
          totalRecords: seedMemories.length,
          filteredRecords: filterMemoryRecordsByImportMode(seedMemories, memoryImportMode).length,
        };
        // 令四.1 · 后端签发一次性安装确认 token(绑将真正落地的危险面 = 未剥离的 trusted 模板快照)。
        // 前端两步流:preview 拿 token → 用户确认后带 token 真装以启用 unsafe 保留(否则恒走 Safe Install)。
        const issued = issueInstallConfirmationToken(computeInstallDangerSurface(previewTrusted as any), { scope: "install/company" });
        // P0-1 · 导入绑定计划:基于 Safe Install 剥离后的真实落地模板生成(provider/model/engine/MCP 逐项
        // 本机能力比对 + 候选替代)。前端逐项确认后随真装请求回传,后端 applyImportBindingPlans 落地。
        const bindingPlans = buildImportBindingPlans(previewSafe.template, localCapabilityForBindingPlans(projectRoot));
        return res.json({
          preview: true, summary, doctor, safeInstallPreview, memoryPreview,
          dangerFlags: dangerFlags(tplRaw as any), trustLevel: previewTrusted.trustLevel, hashVerified,
          installConfirmationToken: issued.installConfirmationToken, installConfirmationExpiresAt: issued.expiresAt,
          bindingPlans,
          ...(conflicts ? { conflicts } : {}),
        });
      }

      // new-company / merge:真正落地,D1 安全线依旧硬拦——error 级(篡改/组织成环)拒装并返回 checks。
      if (!doctor.install_allowed) return res.status(422).json({ error: doctorErrorText(doctor), doctor });
      // C10-P1:落地前用 verifyAndAssignTrust 按 hash 重赋 trustLevel,堵"库内文件自封 trustLevel:official
      // 跳过 Safe Install 剥离"的破口——applySafeInstall 只信重算后的信任等级,不信磁盘文件自我声明
      // (与 companyRoutes 导入侧 L537 同构;preview 分支 L751 已同样重算,保证预览=落地)。
      const { template: trustedRaw } = verifyAndAssignTrust(tplRaw as any);
      // 令四.1 · unsafe 保留只认**后端签发的一次性 token**(替代旧的客户端布尔 unsafeAcknowledged)。
      // 带 token:校验 + 一次性消费(templateHash/危险面与预览时不符 → 409;重放 → 409;过期 → 410),
      // 通过才启用 unsafe 保留;不带 token(或 token 校验失败已 return)→ 恒走 Safe Install 剥离(默认安全)。
      const installConfirmationToken = typeof req.body?.installConfirmationToken === "string" ? req.body.installConfirmationToken : undefined;
      let unsafeRetained = false;
      if (installConfirmationToken) {
        const consumed = consumeInstallConfirmationToken(installConfirmationToken, computeInstallDangerSurface(trustedRaw as any), { scope: "install/company" });
        if (!consumed.ok) return res.status(consumed.status).json({ error: consumed.reason, requiresRepreview: true });
        unsafeRetained = true;
      }
      // D1 · Safe Install Mode:社区来源(trustLevel 非 official)默认剥离高危授权(shell/MCP 授权/预置
      // A2A 自动 grant);仅当携带有效 token(unsafeRetained)才显式保留。剥离项随响应返回,UI 如实展示。
      const safeInstall = applySafeInstall(trustedRaw as any, { unsafeAcknowledged: unsafeRetained });
      const safeTemplate = safeInstall.template;
      let tpl = safeTemplate;
      let appliedBindingPlans: ImportBindingPlanItem[] = [];

      // P0-1 · 应用用户确认的导入绑定计划(map/configure/disable)。仅在请求显式携带合法 bindingPlans 时
      // 应用;如果仍有缺失绑定,不带计划必须拒绝安装,不能把问题推迟到运行时。
      // 应用后重跑 Doctor——映射/禁用改变了组织与 provider 引用,安装前的体检结果必须反映最终落地形态。
      const confirmedPlans = sanitizeBindingPlans(req.body?.bindingPlans);
      const local = localCapabilityForBindingPlans(projectRoot);
      const authoritativePlans = buildImportBindingPlans(tpl, local);
      const hasBlockingMissingBinding = authoritativePlans.some((plan) =>
        plan.status !== "available" && plan.originalBinding.kind !== "mcp",
      );
      if (hasBlockingMissingBinding && !confirmedPlans) {
        return res.status(422).json({ error: "binding configuration incomplete", bindingPlans: authoritativePlans });
      }
      if (confirmedPlans) {
        const reconciled = reconcileBindingPlans(authoritativePlans, confirmedPlans, local);
        if (reconciled.unresolved.length) {
          return res.status(422).json({
            error: "binding configuration incomplete",
            bindingPlans: reconciled.unresolved,
          });
        }
        tpl = applyImportBindingPlans(tpl, reconciled.accepted);
        appliedBindingPlans = reconciled.accepted;
        const postPlanDoctor = runTemplateDoctor(tpl as any, { projectRoot });
        if (!postPlanDoctor.install_allowed) {
          return res.status(422).json({ error: doctorErrorText(postPlanDoctor), doctor: postPlanDoctor, bindingPlansApplied: true });
        }
      }
      const bindingTransformFields = changedSemanticFields(safeTemplate, tpl);

      // 令四.3 · 引用歧义体检(canonical=agent id;role alias 多义整体拒绝)。在 Safe Install 剥离之后
      // 对将真正落地的模板做,剥离掉 a2aChannels 的社区包天然无歧义;保留通道的(official/unsafeAck)才可能触发。
      const ambiguousRefs = detectAmbiguousTemplateRefs(tpl);
      if (ambiguousRefs.length) {
        return res.status(422).json({ error: `模板存在 ${ambiguousRefs.length} 处歧义引用:role 名对应多个同 role 员工,无法确定指向哪一个,请改用 canonical agent id`, ambiguousRefs });
      }

      // merge:合并到已有公司(targetCompanyId 必填),五类冲突按策略(缺省值见 installMerge.ts)处理。
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
        const result = resolveMerge(tpl, targetCompany, getAgents(), strategies, {
          attachParentId: targetCompany.ceoId,
          confirmOverwrite: req.body?.confirmOverwrite === true,
          teamDuplicationResolution,
          orgParentResolution,
        });
        if (!result.ok) return res.status(result.status).json({ error: result.error, conflicts: result.conflicts });

        // overwrite 策略产出的 agent 与现有 id 相同——addAgents 会把已存在的 id 当重复静默跳过,
        // 必须走 updateAgent(按 id upsert)才能真正覆盖;其余(新增/copy-as-new)走 addAgents。
        const overwriteSet = new Set(result.overwriteAgentIds);
        const toAdd = result.agents.filter(a => !overwriteSet.has(a.id));
        const toOverwrite = result.agents.filter(a => overwriteSet.has(a.id));
        // 令四.5(wave4-live-acceptance P0)· addAgents 对已存在 id 会静默跳过——新增员工 id 若与【全局既有
        // agent(所有公司)】碰撞,员工不落地却仍被当作安装成功,且改挂/引用会指向外公司同 id agent。安装前
        // 显式查重:碰撞则整体拒绝(未改动任何状态,不落 tx),绝不静默跳过、绝不宣称成功。正常流下 resolveMerge
        // 已按全局冲突把 toAdd id 重排唯一,这是纵深防御。
        const globalAgentIds = new Set(getAgents().map(a => a.id));
        const collidingAddIds = toAdd.filter(a => globalAgentIds.has(a.id)).map(a => a.id);
        if (collidingAddIds.length) {
          return res.status(409).json({ error: `安装中止:${collidingAddIds.length} 名新增员工 id 与既有全局 agent 碰撞(addAgents 会静默跳过),整体未安装(未改动任何状态)`, collidingAgentIds: collidingAddIds });
        }
        // C9-P0 · adopt-template-org:既有员工改挂上级。快照受影响节点(被改挂员工 + 旧父 + 新父)整值进
        // orgParentRestores(回滚用 restoreAgentsInPlace 原地整值恢复,保序不挪位)。C9-P2:真正的 childrenIds
        // 重建改到 addAgents 之后统一做(planOrgParentRebindApply)——新父可能是本次新建员工(在 toAdd 里),
        // 必须落地后才在集合中,否则新父 childrenIds 收不到被改挂的既有员工(与 companyRoutes merge 分支同构)。
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
        // + agentMemories 只导新建员工——与 companyRoutes /api/companies/import merge 分支共用同一组
        // installMerge.ts helper,同口径。
        const fieldMerge = mergeCompanyLevelFields(targetCompany, tpl);
        const memoryPlan = planMergeAgentMemories(tpl.agentMemories, result);
        // 对抗验收缺口①②:合并前整份 manifestMcpRequirements 先拍下来(targetCompany 是合并前读出的
        // 快照对象,updateCompany 不会反过来改它),连同 resolveMerge 已经吐出的覆盖前员工/改写前边一起
        // 存进 preMerge——回滚要靠这三样把目标公司原有资产整值恢复,不能只凭 created 反推。
        // 收口②:公司级四字段整值快照进 companyFields(回滚整值恢复,undefined=恢复为「无」)。
        // 令四.6:overwrite 快照(回滚 delete+re-add)与 adopt-org 改挂快照(回滚 restoreAgentsInPlace 保序)
        // 分列两字段,回滚各走各的机制;同一 id 只走一种处置(overwrite 目标与 map 改挂目标不重叠),adopt 快照
        // 里再排除已在 overwrite 快照中的 id 做纵深去重,避免同一员工被双重恢复。
        const overwrittenIdSet = new Set(result.overwrittenAgents.map(a => a.id));
        const orgParentRestores = orgParentPreSnapshots.filter(a => !overwrittenIdSet.has(a.id));
        const preMerge = {
          manifestMcpRequirements: targetCompany.manifestMcpRequirements,
          ...(result.overwrittenAgents.length ? { overwrittenAgents: result.overwrittenAgents } : {}),
          ...(orgParentRestores.length ? { orgParentRestores } : {}),
          ...(result.modifiedChannels.length ? { modifiedChannels: result.modifiedChannels } : {}),
          companyFields: fieldMerge.preMergeCompanyFields,
        };

        // #22 · 计划文档硬规则「transaction 先落、状态后写」:所有 created/preMerge 数据 resolveMerge
        // 已产出,skill 走预演清单(planBundledSkillCreatedIds,口径同 installBundledSkills)——先落
        // transaction,再动任何状态;中途崩溃时磁盘上先有回滚依据、后有半成品。
        // D6 · merge 模式"新增"的口径——agent 只算真正新落地的一批(toAdd;overwrite 覆盖的是目标公司
        // 原有员工,不是"新增",回滚不该动它们);presetChannel 只算合并前没有的 key(union/overwrite
        // 策略可能只是改了既有 edge 的 purpose,不算新增边,回滚不该删)。
        const newChannelKeys = result.presetChannels.map(channelKey).filter(k => !beforeChannelKeys.has(k));
        const plannedSkillIds = planBundledSkillCreatedIds(projectRoot, tpl, result.agents.map(a => a.role), targetCompany.id);
        const tx = recordInstallTransaction(projectRoot, {
          mode: "merge", source: tpl.id, companyId: targetCompany.id,
          created: { agentIds: toAdd.map(a => a.id), companyIds: [], presetChannelKeys: newChannelKeys, skillIds: plannedSkillIds },
          agentSnapshots: toAdd.map(agentSnapshot),
          conflictDecisions: result.decisions,
          safeInstallStripped: safeInstall.stripped,
          preMerge,
        });
        recordedTxId = tx.txId; recordedTx = tx;

        const addedCount = addAgents(toAdd);
        // 令四.5 · 核对 request vs landed:落地数与请求数不一致 = 有 id 被静默跳过(前置查重后不应发生,兜底)。
        // 撤销本次已落地的这批新增(前置查重保证这批 id 全新,removeAgentsByIds 只删本次的,不伤既有),标 tx failed。
        if (addedCount !== toAdd.length) {
          try { removeAgentsByIds(toAdd.map(a => a.id)); } catch { /* best-effort */ }
          try { markInstallTransactionFailed(projectRoot, tx.txId); } catch { /* best-effort */ }
          return res.status(409).json({ error: `安装中止:新增员工落地数(${addedCount})与请求数(${toAdd.length})不一致,疑似 id 静默跳过,已回滚本次新增`, txId: tx.txId, requestedAgents: toAdd.length, landedAgents: addedCount });
        }
        for (const a of toOverwrite) updateAgent(a.id, a);
        // C9-P0/P2 · adopt-template-org:在 addAgents 之后,对【目标公司落地后的全体 agents(既有 ∪ 本次新建)】
        // 统一以 parentId 为真源 rebuildChildrenIds 并 patch 受影响节点(被改挂员工 + 新旧父)。新父若是本次
        // 新建员工,此时已在 getAgents() 中,双向同步不再漏挂(修复"新父 childrenIds 不含被改挂员工"的失配)。
        if (orgRebindings.length) {
          const companyAgents = getAgents().filter(a => (a.companyId ?? "default") === targetCompany.id);
          for (const p of planOrgParentRebindApply(companyAgents, orgRebindings)) updateAgent(p.id, { parentId: p.parentId, childrenIds: p.childrenIds });
        }
        const { count: bundledSkillsInstalled } = installBundledSkills(projectRoot, tpl, result.agents.map(a => a.role), targetCompany.id);
        const missingMcp = computeMissingMcp(projectRoot, tpl.mcpRequirements);
        // 收口②:公司级四字段的保守合并 patch 一并落盘(fieldMerge.patch 只含真要改的键;
        // toolRequirements union 只写声明字段,绝不自动启用任何 MCP/Provider/Shell/权限)。
        updateCompany(projectRoot, targetCompany.id, { presetChannels: result.presetChannels, manifestMcpRequirements: result.mcpRequirements, ...fieldMerge.patch });
        incrementDownload(projectRoot, "templates", tpl.id);

        // 收口②:agentMemories 只写"本次 merge 新建员工"(memoryPlan.importIdMap 已过滤掉 overwrite/
        // skipped/映射不上的——importAgentMemories 是整文件覆盖写,对既有员工调用即静默覆盖目标记忆)。
        // 回滚删这批新员工(tx.created.agentIds)即自然消除关联,不伤既有员工记忆。
        const plannedAgentMemories = (tpl.agentMemories ?? []).filter(
          (memory) => memoryPlan.importIdMap[memory.agent_id] !== undefined,
        );
        const agentMemoriesResult = importAgentMemoriesDetailed(
          projectRoot, memoryPlan.importIdMap, plannedAgentMemories);
        const agentMemoriesImported = agentMemoriesResult.written;

        // D5 · 按 memoryImportMode 过滤 + 写回 registryStore/reflectionStore(merge 模式记忆归属合并进的
        // 目标公司)。best-effort:单条失败已在 applyMemoryImportMode 内部吞掉,不影响本次安装主流程。
        // Tracked 版本额外落一条 D4 job 记录(queued→validating→processing→completed/failed)。
        // #9:真实写入的记录 id 补挂回 transaction(id 写入时才生成,无法预知),rollback 按 id 撤销。
        // C9-P1:merge 到已有公司,模板记忆走 pending 审批(asProposal:true),不静默直写生效(new-company 分支不加,保留 approved 直写)。
        const memoryImport = applyMemoryImportModeTracked(projectRoot, tpl.seedMemories, memoryImportMode, { companyId: targetCompany.id, bundleId: tpl.id, asProposal: true });
        if (memoryImport.imported > 0) attachInstallTransactionMemory(projectRoot, tx.txId, memoryImport.recordIds);

        // 收口②:四类清单(preserved/added/requires_review/requires_local_setup)——未采纳/未支持的
        // 来源字段全部进报告,不静默消失(装配口径与 companyRoutes merge 分支逐参数一致)。
        // C9-P2:keep-current-org 未采纳模板父的组织差异并入 requires_review(兑现决策 summary 的"进 requires_review"承诺);
        // 仅 map 处置下有意义(非 map 时既有员工组织未被触碰,落条目=误报)。
        const orgParentReviewItems = buildKeepCurrentOrgReviewItems(result.conflicts.orgParent, orgParentResolution, teamDuplicationResolution);
        const report = finalizeMergeReport(fieldMerge.report, { memoryReviewItems: memoryPlan.reviewItems, missingMcp, agentMemoriesImported, agentMemoryFailures: agentMemoriesResult.failures, orgParentReviewItems });
        const reportOverrides = mergeReportOverrides(report);
        const semanticFidelity = finalizeSemanticFidelity({
          projectRoot,
          operation: "merge",
          sourceSchemaVersion: LEGACY_BUNDLE_VERSION,
          targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
          source: tplRaw as CompanyTemplate,
          target: { ...tpl, agents: result.agents },
          runtime: {
            bindingPlans: appliedBindingPlans,
            missingCapabilities: missingMcp.map((item) => ({
              kind: "mcp" as const,
              name: item.name,
              reason: "not configured locally",
            })),
            proofLevel: "declarative",
          },
          overrides: {
            ...reportOverrides,
            transformed: [...(reportOverrides.transformed ?? []), ...bindingTransformFields],
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
      // Stage 5:保留 manifest 作者元数据(能力边界报告第③段 + 工具需求),手动建公司则无这些字段。
      // 导入实测修复:调用方可自定义公司名(req.body.name),不传才用模板名。
      const customName = typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 60) : undefined;

      // #22 · 计划文档硬规则「transaction 先落、状态后写」:公司 id 先生成(companyStore.addCompany
      // 缺省同款 8 位 uuid 片段),员工树/预置通道/待新建 skill 全部先在内存里推导出来,transaction
      // 落盘之后才开始写任何状态——中途崩溃时磁盘上先有回滚依据、后有半成品。
      const companyId = randomUUID().slice(0, 8);
      const shortId = companyId.slice(0, 6);
      const { agents, idMap } = rerootAgents(tpl.agents, companyId, (old) => `${old}-${shortId}`);
      const ceo = agents.find(a => a.role === "ceo");

      // ③ a2aChannels:模板内引用(agentId 或 role 名)→ 换算成真实 agent id;换算不出来的引用丢弃,不挡安装。
      const presetChannels = (tpl.a2aChannels ?? [])
        .map(c => ({
          from: resolveTemplateAgentRef(tpl.agents, idMap, c.from),
          to: resolveTemplateAgentRef(tpl.agents, idMap, c.to),
          purpose: c.purpose,
        }))
        .filter((c): c is { from: string; to: string; purpose: string | undefined } => !!c.from && !!c.to && c.from !== c.to);
      const presetChannelKeys = presetChannels.map(channelKey);

      // D6 · install transaction:new-company 模式下,回滚是"删整个公司"(见 rollback 端点),这里落的
      // created.agentIds/companyIds 主要供前置检查(是否已被用户手动改名/移动)与响应审计用。
      const tx = recordInstallTransaction(projectRoot, {
        mode: "new-company", source: tpl.id, companyId,
        created: {
          agentIds: agents.map(a => a.id), companyIds: [companyId], presetChannelKeys,
          skillIds: planBundledSkillCreatedIds(projectRoot, tpl, agents.map(a => a.role), companyId),
        },
        agentSnapshots: agents.map(agentSnapshot),
        conflictDecisions: [],
        safeInstallStripped: safeInstall.stripped,
      });
      recordedTxId = tx.txId; recordedTx = tx;

      const company = addCompany(projectRoot, {
        id: companyId,
        name: customName ?? tpl.title,
        description: tpl.description ?? "",
        manifestTemplateId: tpl.id,
        manifestUseCases: tpl.useCases,
        manifestRiskNotes: tpl.riskNotes,
        manifestToolRequirements: tpl.toolRequirements ?? deriveToolRequirements(tpl.agents),
        workflow: tpl.workflow,   // Stage 6:交叉验证链 propagate(运行时驱动 verifier gate)
        manifestMcpRequirements: tpl.mcpRequirements, // Stage 8+:供能力边界报告交叉核对(见 capabilityReport.ts)
        // P0-B · 社区安装路径与 companyRoutes.installCompanyTemplate 对齐:公司级调度语义 + 作者手填示例
        // 任务落成公司持久字段。此前社区 install/company 分支不带这两个字段 → 装完的公司 visibilityPolicy/
        // defaultTasks 静默为空,再导出也不在(工坊→社区→安装往返丢字段)。
        visibilityPolicy: tpl.visibilityPolicy,
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

      // P0-B · 员工个人记忆(agent-memory.md)随包安装(同 installCompanyTemplate:按 idMap 把
      // bundle/模板携带的 agentMemories 写回新机)。此前社区 install/company 分支完全不落 agentMemories →
      // 工坊从公司带出的员工记忆到社区安装这一步被静默剥掉。best-effort,不阻断安装。
      const agentMemoriesResult = importAgentMemoriesDetailed(projectRoot, idMap, tpl.agentMemories);

      // ① bundledSkills:逐条 upsert 进 skill store,按角色绑定。C1:id 掺 companyId(bundledSkillId),
      // 不同公司装同一模板得到各自独立的 skill 文件,互不覆盖;createdIds 由上方 tx.created.skillIds
      // (planBundledSkillCreatedIds 预演清单,同款口径)承载,这里只取 count。原内联循环已收进
      // installBundledSkills(与 merge 分支同一实现,消灭第 3 处 id 推导)。
      const { count: bundledSkillsInstalled } = installBundledSkills(projectRoot, tpl, agents.map(a => a.role), companyId);

      // ② mcpRequirements:对照本机已配 MCP(启用且已填 command/url 才算"已配置")算 missing 清单。
      const missingMcp: Array<{ name: string; purpose?: string; optional?: boolean }> = [];
      if (tpl.mcpRequirements?.length) {
        const localMcp = listMcpServers(projectRoot);
        const configuredNames = new Set(
          localMcp.filter(s => s.enabled && (s.transport === "http" ? !!s.url : !!s.command)).map(s => s.name.trim().toLowerCase()),
        );
        for (const mcpReq of tpl.mcpRequirements) {
          if (!mcpReq?.name) continue;
          if (!configuredNames.has(mcpReq.name.trim().toLowerCase())) missingMcp.push({ name: mcpReq.name, purpose: mcpReq.purpose, optional: mcpReq.optional });
        }
      }

      // ③ presetChannels 已在 transaction 落盘前推导(见上方 #22 注释),这里只做真正的状态写入。
      let presetChannelsInstalled = 0;
      if (presetChannels.length) {
        updateCompany(projectRoot, company.id, { presetChannels });
        presetChannelsInstalled = presetChannels.length;
      }

      incrementDownload(projectRoot, "templates", tpl.id);

      // D5 · 按 memoryImportMode 过滤 + 写回 registryStore/reflectionStore(归属新建的这家公司)。
      // #9:真实写入的记录 id 补挂回 transaction,rollback 按 id 撤销。
      const memoryImport = applyMemoryImportModeTracked(projectRoot, tpl.seedMemories, memoryImportMode, { companyId: company.id, bundleId: tpl.id });
      if (memoryImport.imported > 0) attachInstallTransactionMemory(projectRoot, tx.txId, memoryImport.recordIds);

      const semanticFidelity = finalizeSemanticFidelity({
        projectRoot,
        operation: "import",
        sourceSchemaVersion: LEGACY_BUNDLE_VERSION,
        targetSchemaVersion: CURRENT_BUNDLE_SCHEMA_VERSION,
        source: tplRaw as CompanyTemplate,
        target: { ...tpl, agents },
        runtime: {
          bindingPlans: appliedBindingPlans,
          missingCapabilities: missingMcp.map((item) => ({
            kind: "mcp" as const,
            name: item.name,
            reason: "not configured locally",
          })),
          proofLevel: "declarative",
        },
        overrides: {
          transformed: [
            ...bindingTransformFields,
            ...(memoryImportMode === "full" ? [] : ["seedMemories"]),
          ],
          approvedAfterImport: safeInstallApprovedFields(safeInstall.stripped),
          lost: [
            ...memoryImport.failures.map((_failure, index) => `seedMemories.importFailure[${index}]`),
            ...agentMemoriesResult.failures.map((_failure, index) => `agentMemories.importFailure[${index}]`),
          ],
        },
      });

      // 收口④:未登记的模板顶层字段如实随安装结果返回(passthrough 已保留字段本体,这里补"进报告"
      // 半边,不静默丢;merge 分支由 mergeCompanyLevelFields 落进 report.requires_review,口径一致)。
      res.json({
        companyId: company.id, ceoId: ceo?.id ?? null, agentCount: agents.length,
        missingMcp, bundledSkillsInstalled, presetChannelsInstalled,
        doctor, safeInstall: { applied: safeInstall.applied, stripped: safeInstall.stripped },
        txId: tx.txId, memoryImport, memoryImportFailures: memoryImport.failures,
        agentMemoriesImported: agentMemoriesResult.written, agentMemoryFailures: agentMemoriesResult.failures,
        unregisteredFields: listUnregisteredTemplateFields(tpl), semanticFidelity,
      });
    } catch (e: any) {
      // 令四.5 · 安装步骤抛错 → 按已落 tx 补偿回滚(逆向撤销已落地部分);回滚也失败 → requires_rollback:true
      // + txId(非成功形状)。tx 尚未落(参数校验阶段就抛)→ 无状态可回,直接 400。
      if (recordedTx) {
        const comp = compensateInstallTransaction(projectRoot, recordedTx);
        const semanticFidelity = semanticFidelityReportFromError(e);
        if (!comp.ok) return res.status(500).json({ error: e?.message || String(e), requires_rollback: true, txId: recordedTx.txId, rollbackError: comp.error, ...(semanticFidelity ? { semanticFidelity } : {}) });
        return res.status(semanticFidelity ? 409 : 500).json({ error: e?.message || String(e), rolledBack: true, txId: recordedTx.txId, ...(semanticFidelity ? { semanticFidelity } : {}) });
      }
      if (recordedTxId) { try { markInstallTransactionFailed(projectRoot, recordedTxId); } catch { /* best-effort */ } }
      const semanticFidelity = semanticFidelityReportFromError(e);
      res.status(semanticFidelity ? 409 : 400).json({ error: e.message, ...(semanticFidelity ? { semanticFidelity } : {}) });
    }
  });

  // D6(V0 必需)· Install rollback:一键撤销一次真实安装(install/company 的 new-company/merge,
  // 或 companyRoutes.ts /api/companies/import 落的同一份 .opc/install-transactions.json)。
  // new-company:复用 companyRoutes 的"删除前自动备份 → 删公司 → 连坐删其全部 agent"(与手动删公司
  // 同一条路径,不重新发明);merge:只精确撤销这次合并新增的那批(agent/presetChannel/skill),
  // 目标公司原有资产一律不碰。skill 一律按 created.skillIds 硬删(该字段本就只含"这次真新建"的,
  // 见 install.ts installBundledSkills 的口径注释)。
  //
  // 前置检查(不静默):created 的 agent 若已被用户事后手动改名/移动(名字/parentId/companyId 与
  // 安装时的快照不一致),仍按"删除"执行——回滚的意义就是撤销这次安装,不是"只删没人碰过的"——
  // 但如实把这批"已变更,仍删除"的清单放进响应,不悄悄跳过也不悄悄留下。
  app.post("/api/community/install/:txId/rollback", (req, res) => {
    try {
      const tx = getInstallTransaction(projectRoot, req.params.txId);
      if (!tx) return res.status(404).json({ error: "install transaction not found" });
      if (tx.rolledBack) return res.status(409).json({ error: "该次安装已经回滚过", rolledBackAt: tx.rolledBackAt });

      const currentAgents = getAgents();
      const changedAgents: Array<{ id: string; name: string; changes: string[] }> = [];
      const missingAgents: string[] = [];
      for (const snap of tx.agentSnapshots) {
        const cur = currentAgents.find(a => a.id === snap.id);
        if (!cur) { missingAgents.push(snap.id); continue; }
        const changes: string[] = [];
        if (cur.name !== snap.name) changes.push(`改名: "${snap.name}" → "${cur.name}"`);
        if ((cur.parentId ?? "") !== (snap.parentId ?? "")) changes.push(`移动: parentId "${snap.parentId ?? "(无)"}" → "${cur.parentId ?? "(无)"}"`);
        if ((cur.companyId ?? "default") !== snap.companyId) changes.push(`换公司: "${snap.companyId}" → "${cur.companyId ?? "default"}"`);
        if (changes.length) changedAgents.push({ id: snap.id, name: cur.name, changes });
      }

      // #27:skill 删除挪进各 mode 分支——new-company 分支的"删除前自动备份"(backupCompanyBeforeDelete
      // → companyToTemplate → collectBundledSkills)要按前缀去 skill store 读技能正文,必须先备份后删,
      // 否则备份出的模板 bundledSkills 恒为空,从备份恢复的公司会静默丢掉全部打包技能。
      // C1 · 回滚前引用检查:bundled skill 现在 id 掺 companyId、各公司独立落盘,自己回滚删自己天然安全;
      // 但 legacy(无 companyId)技能仍是"按 role 全局绑定"的单份文件,可能被别的公司共享——删前必须查:
      //   · 新 id(meta.companyId 有值且 ≠ 本 tx.companyId)→ 明确是别人的资产,跳过删除;
      //   · legacy(无 companyId)→ 扫其余未回滚 tx:同 source、装进另一个仍存在的公司 → 判定共享,跳过;
      //     (对齐 install.ts 自认的漏洞:A装[进A的tx]→B装[alreadyExisted 不进B的tx]→回滚A 不该删掉 B 在用的)
      //   · 读盘异常 → 保守不删(宁留孤儿不删在用)。跳过的如实记入 skippedSharedSkillIds,在响应里报告。
      let revertedSkills = 0;
      const skippedSharedSkillIds: string[] = [];
      const deleteCreatedSkills = () => {
        const otherTxs = loadInstallTransactions(projectRoot).filter(t => t.txId !== tx.txId && !t.rolledBack);
        for (const skillId of tx.created.skillIds) {
          let shared = false;
          try {
            const owner = getSkill(projectRoot, skillId)?.companyId;
            if (owner) {
              if (owner !== tx.companyId) shared = true; // 新 id:明确归属别的公司
            } else {
              // legacy:同 source 装进另一个仍存在的公司即视为共享(不要求该 tx.created 含此 id——
              // "已存在故未记进 created"正是要防的连坐删除场景)。
              shared = otherTxs.some(t2 =>
                t2.source === tx.source && t2.companyId !== tx.companyId && !!getCompany(projectRoot, t2.companyId));
            }
          } catch { shared = true; /* 读盘异常 → 保守不删 */ }
          if (shared) { skippedSharedSkillIds.push(skillId); continue; }
          if (deleteSkill(projectRoot, skillId)) revertedSkills++;
        }
      };

      let removedAgents = 0;
      let revertedPresetChannels = 0;
      let backupFile: string | undefined;
      let companyDeleted: boolean | undefined;
      let survivedAfterCompanyDelete: string[] = [];

      if (tx.mode === "new-company") {
        const company = getCompany(projectRoot, tx.companyId);
        if (company) {
          backupFile = backupCompanyBeforeDelete(projectRoot, tx.companyId);
          companyDeleted = deleteCompany(projectRoot, tx.companyId);
          removedAgents = companyDeleted ? removeAgentsByCompany(tx.companyId) : 0;
        } else {
          companyDeleted = false;
        }
        deleteCreatedSkills();
        // 极端情况:某个 created agent 早被用户手动挪去了别的公司——那它不在 tx.companyId 下了,
        // 整公司删除扫不到它,不能谎称"已删除"。
        const afterIds = new Set(getAgents().map(a => a.id));
        survivedAfterCompanyDelete = tx.created.agentIds.filter(id => afterIds.has(id));
      } else {
        deleteCreatedSkills();
        removedAgents = removeAgentsByIds(tx.created.agentIds);
        const company = getCompany(projectRoot, tx.companyId);
        if (company) {
          // 发现①②修复:merge 回滚不能只删"这次新增的",目标公司原有资产被这次合并覆盖/改写掉的部分
          // 也要恢复——tx.preMerge 是这批快照(老 transaction 上线前落的没有这个字段,维持原有行为,
          // 不去动一个我们没有快照依据的状态)。
          const patch: {
            presetChannels?: typeof company.presetChannels;
            manifestMcpRequirements?: typeof company.manifestMcpRequirements;
            visibilityPolicy?: typeof company.visibilityPolicy;
            defaultTasks?: typeof company.defaultTasks;
            manifestToolRequirements?: typeof company.manifestToolRequirements;
            workflow?: typeof company.workflow;
          } = {};
          if (tx.created.presetChannelKeys.length || tx.preMerge?.modifiedChannels?.length) {
            const keySet = new Set(tx.created.presetChannelKeys);
            const before = company.presetChannels ?? [];
            let kept = before.filter(c => !keySet.has(channelKey(c)));
            revertedPresetChannels = before.length - kept.length;
            if (tx.preMerge?.modifiedChannels?.length) {
              const origByKey = new Map(tx.preMerge.modifiedChannels.map(c => [channelKey(c), c]));
              kept = kept.map(c => {
                const orig = origByKey.get(channelKey(c));
                return orig && orig.purpose !== c.purpose ? { ...c, purpose: orig.purpose } : c;
              });
            }
            patch.presetChannels = kept;
          }
          if (tx.preMerge) patch.manifestMcpRequirements = tx.preMerge.manifestMcpRequirements;
          // 收口②:公司级四字段整值恢复——**只在 companyFields 快照存在时**(该键存在=这次 merge 由
          // 保守合并合同实现落盘;显式 undefined 经 updateCompany 浅 spread 覆盖回「无」,与上一行
          // manifestMcpRequirements 同一机制)。老 tx 无 companyFields → 老实现从不写这四字段,不碰,
          // 免得把用户既有值误抹掉。
          if (tx.preMerge?.companyFields) {
            const cf = tx.preMerge.companyFields;
            patch.visibilityPolicy = cf.visibilityPolicy;
            patch.defaultTasks = cf.defaultTasks;
            patch.manifestToolRequirements = cf.manifestToolRequirements;
            patch.workflow = cf.workflow;
          }
          if (Object.keys(patch).length) updateCompany(projectRoot, tx.companyId, patch);
        }
        if (tx.preMerge?.overwrittenAgents?.length) {
          // #8:整对象替换,不能走 updateAgent——那是 Object.assign 合并语义,快照里不存在的 key 不会
          // 被删掉,模板覆盖时新写上的字段(genericCli/claudeCodeUseApiKey 等)会残留在还原后的员工身上。
          // 先按 id 删除再以覆盖前快照整体加回,才是"零残留"的还原。
          removeAgentsByIds(tx.preMerge.overwrittenAgents.map(a => a.id));
          addAgents(tx.preMerge.overwrittenAgents);
        }
        // 令四.6 · adopt-template-org 改挂的受影响节点:原地整值恢复(保序)。被改挂员工/旧父/新父在合并时
        // 都是既有员工(在原位被 updateAgent 就地改),回滚必须原位整值还原——delete+re-add 会把它们挪到列表
        // 尾部,导出顺序漂移(非完整还原)。restoreAgentsInPlace 命中原索引就地替换,顺序不变。
        if (tx.preMerge?.orgParentRestores?.length) {
          restoreAgentsInPlace(tx.preMerge.orgParentRestores);
        }
      }

      // #9(指南 11.17:Rollback 应撤销「新增 memory」):按 transaction 记下的记录 id 撤销 D5 导入的
      // 记忆——新建的按 id 硬删(零残留);upsert 合并进既有记录的删掉会伤及本地原有记忆,不动,但在
      // 响应里如实报告。老 transaction 无 memory 字段 → 维持原行为(不碰记忆),响应也不带本字段。
      let memoryRollback:
          | {
            governedProposalsRemoved: number; conclusionsRemoved: number; proceduralSkillsRemoved: number; lessonsRemoved: number;
            mergedNotReverted?: { proceduralSkillIds: string[]; lessonIds: string[] };
          }
        | undefined;
      if (tx.memory) {
        const governedProposalsRemoved = removeGovernedMemoryProposalsByIds(projectRoot, tx.memory.governedProposalIds ?? []);
        const conclusionsRemoved = removeMemoryRecordsByIds(projectRoot, tx.memory.conclusionIds);
        const proceduralSkillsRemoved = removeMemoryRecordsByIds(projectRoot, tx.memory.proceduralSkillCreatedIds);
        const lessonsRemoved = removeLessonsByIds(projectRoot, tx.memory.lessonCreatedIds);
        const mergedPs = tx.memory.proceduralSkillMergedIds ?? [];
        const mergedLs = tx.memory.lessonMergedIds ?? [];
        memoryRollback = {
          governedProposalsRemoved, conclusionsRemoved, proceduralSkillsRemoved, lessonsRemoved,
          ...(mergedPs.length || mergedLs.length ? { mergedNotReverted: { proceduralSkillIds: mergedPs, lessonIds: mergedLs } } : {}),
        };
      }

      markInstallTransactionRolledBack(projectRoot, req.params.txId);

      res.json({
        ok: true, txId: tx.txId, mode: tx.mode,
        removedAgents, revertedSkills, revertedPresetChannels,
        ...(skippedSharedSkillIds.length ? { skippedSharedSkillIds } : {}),
        ...(tx.mode === "new-company" ? { companyDeleted, backupFile } : {}),
        changedAgents, missingAgents,
        ...(survivedAfterCompanyDelete.length ? { survivedAfterCompanyDelete } : {}),
        ...(memoryRollback ? { memoryRollback } : {}),
      });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/community/teams/import", (req, res) => {
    try {
      // Stage 8 安全:补 zod 校验(之前 raw body 直接落盘)。
      const parsed = TeamTemplateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "team 校验失败: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      saveTeam(projectRoot, parsed.data as any);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // C10-P1 · 团队/Worker 两类社区内容此前完全无信任/危险标记体系(schema 无 hash/trust,安装路由无
  // doctor/scan)。这里补最小防线:①两类内容一律标 unsigned:true(社区团队/Worker 无完整性指纹,
  // fail-open 标记不拒装);②团队按 agents 的 framework 推 shell-access 危险旗标;③Worker 的 persona
  // (systemPrompt)过 scanContentSafety 报密钥/本机路径命中(warning 级,导入前透明展示,不硬拦)。
  function teamDangerFlags(agents: { framework?: string; role?: string }[]): string[] {
    const flags = new Set<string>();
    for (const a of agents) {
      if (a.framework && ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"].includes(a.framework)) flags.add("shell-access");
      if (a.role === "dev" || a.role === "coder" || a.role === "code") flags.add("file-write");
    }
    return [...flags];
  }
  function contentWarningsFor(text: string): string[] {
    return scanContentSafety(text).map(f => f.message);
  }

  // 团队安装前预检:unsigned 徽标 + 危险旗标(供 ImportToOrgDialog 一次性确认展示)。
  app.post("/api/community/install/team/precheck", (req, res) => {
    try {
      const team = getTeam(projectRoot, req.body?.teamId);
      if (!team) return res.status(404).json({ error: "team not found" });
      res.json({ unsigned: true, dangerFlags: teamDangerFlags(team.agents), contentWarnings: contentWarningsFor(JSON.stringify(team.agents.map(a => a.card ?? {}))) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Worker 安装前预检:unsigned 徽标 + persona 内容安全扫描 + framework 危险旗标。
  app.post("/api/community/install/worker/precheck", (req, res) => {
    try {
      const card = getAgentCard(projectRoot, req.body?.workerId);
      if (!card) return res.status(404).json({ error: "worker not found" });
      res.json({ unsigned: true, dangerFlags: teamDangerFlags([{ role: card.agent.expectedRole }]), contentWarnings: contentWarningsFor(card.agent.systemPrompt || "") });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Install a team (lead + subtree) under a chosen CEO/Lead (never a worker).
  app.post("/api/community/install/team", (req, res) => {
    try {
      const { teamId, parentId } = req.body ?? {};
      const team = getTeam(projectRoot, teamId);
      if (!team) return res.status(404).json({ error: "team not found" });
      const parent = getAgents().find(a => a.id === parentId);
      if (!parent) return res.status(400).json({ error: "parent agent not found" });
      if (!isValidAttachParent(parent.role)) return res.status(400).json({ error: "团队只能接到 CEO 或 Lead 下" });
      const companyId = parent.companyId || "default";
      const suffix = randomUUID().slice(0, 6);
      const { agents } = rerootAgents(team.agents, companyId, (old) => `${old}-${suffix}`, { newParentForRoots: parentId });
      const added = addAgents(agents);
      incrementDownload(projectRoot, "teams", teamId);
      res.json({ added, parentId, companyId, unsigned: true, dangerFlags: teamDangerFlags(team.agents) });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Install a single worker (AgentCard) under a chosen CEO/Lead.
  // Worker 使用唯一 role 避免重复安装,人设直接保存在 AgentNodeConfig.systemPrompt 并由运行时读取。
  // C3: 同 parent 下已装同一来源 worker → 幂等返回，不堆叠副本。
  app.post("/api/community/install/worker", (req, res) => {
    try {
      const { workerId, parentId } = req.body ?? {};
      const card = getAgentCard(projectRoot, workerId);
      if (!card) return res.status(404).json({ error: "worker not found" });
      const parent = getAgents().find(a => a.id === parentId);
      if (!parent) return res.status(400).json({ error: "parent agent not found" });
      if (!isValidAttachParent(parent.role)) return res.status(400).json({ error: "worker 只能接到 CEO 或 Lead 下" });
      const companyId = parent.companyId || "default";
      const role = `skill-${card.id}`;
      // C3 去重：同 parent 下同 scoped role 已存在 → 不再新增。
      const dup = getAgents().find(a => a.parentId === parentId && a.role === role);
      if (dup) return res.json({ added: 0, agentId: dup.id, role, parentId, companyId, duplicate: true });

      const persona = card.agent.systemPrompt;
      const skillLike = { id: card.id, title: card.agent.name || card.title, role, enabled: true, content: persona, lastModified: new Date().toISOString() };
      const newId = `${role}-${randomUUID().slice(0, 6)}`;
      const node = workerFromSkill(skillLike, parentId, companyId, newId, role);
      // 保留卡片推荐的 provider/model（workerFromSkill 默认 deepseek）。
      node.provider = card.agent.recommendedProvider || node.provider;
      node.model = card.agent.recommendedModel || node.model;
      addAgents([node]);
      incrementDownload(projectRoot, "agents", workerId);
      res.json({ added: 1, agentId: newId, role, parentId, companyId, unsigned: true, contentWarnings: contentWarningsFor(persona || "") });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/community/agents/import", (req, res) => {
    try {
      // Stage 8 安全:补 zod 校验(之前 raw body 直接落盘 + id 未净化 → 路径穿越/坏数据)。
      const parsed = AgentCardSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "agent card 校验失败: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      saveAgentCard(projectRoot, parsed.data);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post("/api/community/prompts/import", (req, res) => {
    try {
      const parsed = PromptTemplateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "prompt 校验失败: " + parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ") });
      savePrompt(projectRoot, parsed.data);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Stars
  app.post("/api/community/templates/:id/star", (req, res) => {
    incrementStar(projectRoot, "templates", req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/community/teams/:id/star", (req, res) => {
    incrementStar(projectRoot, "teams", req.params.id);
    res.json({ ok: true });
  });

  app.post("/api/community/agents/:id/star", (req, res) => {
    incrementStar(projectRoot, "agents", req.params.id);
    res.json({ ok: true });
  });

  // Favorites shelf (per content type: company | team | worker)
  app.get("/api/community/favorites", (_req, res) => {
    res.json(loadFavorites(projectRoot));
  });

  app.post("/api/community/favorites/toggle", (req, res) => {
    const { type, id } = req.body ?? {};
    if (!["company", "team", "worker"].includes(type) || !id) {
      return res.status(400).json({ error: "type (company|team|worker) and id are required" });
    }
    res.json({ favorited: toggleFavorite(projectRoot, type, id) });
  });

  app.post("/api/community/prompts/:id/star", (req, res) => {
    incrementStar(projectRoot, "prompts", req.params.id);
    res.json({ ok: true });
  });

  // GitHub remote community sources (persisted across restarts)
  app.get("/api/community/sources", (_req, res) => {
    res.json(listGitHubSources(projectRoot));
  });

  app.post("/api/community/sources", (req, res) => {
    const { owner, name, branch, label } = req.body ?? {};
    if (!owner || !name) return res.status(400).json({ error: "owner and name are required" });
    res.json(addGitHubSource(projectRoot, { owner, name, branch: branch || "main", label }));
  });

  app.delete("/api/community/sources/:owner/:name", (req, res) => {
    res.json({ deleted: removeGitHubSource(projectRoot, req.params.owner, req.params.name) });
  });

  // ── v3: GitHub skill 市场（worker = 下载的 skill）──
  // 列出远程 skill（指定 source 或遍历已注册 source）+ 本地已装 skill。
  app.get("/api/community/skills", async (req, res) => {
    try {
      const { owner, repo, branch, dir } = req.query as Record<string, string>;
      const local = listSkills(projectRoot);
      const localIds = new Set(local.map(s => s.id));
      // OPC 官方 builtin skills（worker=skill 模型）：标 licenseAllowed + installed。
      const legacyBuiltinCount = listBuiltinCommunitySkills(projectRoot).length;
      // Legacy versions materialized every built-in worker persona as a "system skill".
      // Worker cards are not executable/instruction skills; startup migration removes those records,
      // and this endpoint never advertises them as installable skills.
      const builtin: never[] = [];
      const sources = listGitHubSources(projectRoot);
      const allowedFor = (o: string, n: string) =>
        sources.find(s => s.owner === o && s.name === n)?.allowedLicenses ?? DEFAULT_ALLOWED_LICENSES;

      let remote: any[] = [];
      if (owner && repo) {
        remote = await fetchGitHubSkillFiles(owner, repo, branch || "main", dir || "skills", allowedFor(owner, repo));
      } else {
        for (const s of sources) {
          const items = await fetchGitHubSkillFiles(s.owner, s.name, s.branch || "main", "skills", allowedFor(s.owner, s.name));
          remote.push(...items);
        }
      }
      // 标注哪些已在本地安装（前端区分"下载"/"已安装"）。
      remote = remote.map(r => ({ ...r, installed: localIds.has(r.id) }));
      res.json({ builtin, remote, local, legacyBuiltinCount });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // 下载一个远程 skill 落地为本地 skill。License 服务端再校验一次（fail-closed），不合规拒绝。
  app.post("/api/community/skills/download", (req, res) => {
    try {
      const sk = req.body as Skill & { source?: { owner: string; name?: string; repo?: string } };
      if (!sk?.id || !sk?.content) return res.status(400).json({ error: "skill id 和 content 必填" });
      const ownerForAllow = sk.source?.owner;
      const repoForAllow = (sk.source as any)?.repo;
      const allowed = listGitHubSources(projectRoot)
        .find(s => s.owner === ownerForAllow && s.name === repoForAllow)?.allowedLicenses ?? DEFAULT_ALLOWED_LICENSES;
      if (!isLicenseAllowed(sk.license, allowed)) {
        return res.status(403).json({ error: `License 不合规或未知（${sk.license ?? "无"}），已拦截下载`, license: sk.license ?? null });
      }
      const payload: Skill = {
        id: sk.id, title: sk.title || sk.id, role: sk.role || "dev", enabled: true,
        lastModified: new Date().toISOString(),
        description: sk.description, license: sk.license, licenseUrl: sk.licenseUrl,
        author: sk.author, authorGitHub: sk.authorGitHub, checksum: sk.checksum, source: sk.source as any,
        content: sk.content,
      };
      // 幂等：已存在则更新（不报错堆叠）。
      const existed = !!getSkill(projectRoot, sk.id);
      const saved = existed ? updateSkill(projectRoot, sk.id, payload) : createSkill(projectRoot, payload);
      res.json({ ok: true, skillId: saved.id, updated: existed, license: saved.license, source: saved.source ?? null });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Download counter (was a dead import — now wired)
  app.post("/api/community/:type/:id/download", (req, res) => {
    const type = req.params.type;
    if (type !== "templates" && type !== "teams" && type !== "agents" && type !== "prompts") {
      return res.status(400).json({ error: "type must be templates, teams, agents, or prompts" });
    }
    incrementDownload(projectRoot, type, req.params.id);
    res.json({ ok: true });
  });

  // Share to GitHub community repo
  app.post("/api/community/share", async (req, res) => {
    try {
      const { type, data, author, message } = req.body;
      if (!type || !data || !author) {
        return res.status(400).json({ error: "type, data, and author are required" });
      }
      // C2 · 社区二分类闭环:分享类型白名单只留 template(公司模板)/ agent(员工卡)。prompt 模块
      // 已下线(见上方 REMOTE_DIRS 注释),不再接受新的 prompt 分享(存量浏览/导入路由保留,只关上传口)。
      if (!["template", "agent"].includes(type)) {
        return res.status(400).json({ error: "type must be template or agent(prompt 分享已下线)" });
      }
      // 拒绝"空壳":团队模板必须含至少一个 agent,worker 必须含 agent 内容。
      // (根因:旧分享表单只填名字/描述就能提交,产生 title="3"、agents 为空的垃圾卡片。)
      if (type === "template" && (!Array.isArray((data as { agents?: unknown[] }).agents) || (data as { agents: unknown[] }).agents.length === 0)) {
        return res.status(400).json({ error: "空模板不能上传:请从「我的组织」选择一个有员工的公司/团队" });
      }
      if (type === "agent" && !(data as { agent?: unknown }).agent) {
        return res.status(400).json({ error: "无效的 worker:缺少 agent 内容" });
      }

      // 分场景·分享强制 share 档:社区是对陌生人的公开面,绝不外发 full 保真档的本机命令/权限。
      // 无论客户端提交的 data 里带没带 full 档标记(export_profile / 员工 agent 的 genericCli /
      // workspaceDir / cliConfigDir),这里一律就地下调成 share 语义:删档位声明、剥离每个 agent 的
      // 本机命令/路径字段(agentMemories 保留——记忆两档都带走)。剥离后再过 runShareSafetyGate
      // (记忆/技能正文里的密钥/绝对路径命中即 422 硬拦)。
      forceShareDowngrade(data);

      // P0-5 · 分享到公开社区前强制过安全闸——序列化整份 data(覆盖 persona/bundledSkills/memory 正文)
      // 扫密钥与本机绝对路径,命中即 422 拒绝并返回结构化 findings,绝不把带密钥/本机路径的内容推上 GitHub。
      // 闸门在任何 GitHub 交互(取凭据/建 PR)之前,不安全内容根本走不到网络这一步。
      const shareGate = runShareSafetyGate(data, { projectRoot });
      if (!shareGate.ok) {
        return res.status(422).json({ error: "内容未通过安全体检:" + shareGate.findings.map((f) => f.message).join(";"), findings: shareGate.findings });
      }

      const config = loadConfig(projectRoot);
      const gh = config.github;
      // 密钥卫生(#1):优先从环境变量读 GitHub 凭据,允许把 token/secret 移出明文 config.json。
      // 设置 OPC_GITHUB_TOKEN(PAT,public_repo) + OPC_GITHUB_CLIENT_ID 即可不在 config 存明文。
      const clientId = process.env.OPC_GITHUB_CLIENT_ID || gh?.oauth?.clientId;
      const token = resolveGithubToken(projectRoot, gh?.oauth?.accessToken);
      if (!clientId) {
        return res.status(500).json({ error: "GitHub OAuth not configured" });
      }
      if (!token) {
        const authUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&scope=public_repo`;
        return res.json({ needAuth: true, authUrl });
      }

      // 锁定官方社区仓库(不再读 config.github.communityRepo 覆盖)——同 communityRepo() helper 保持一致,
      // 分享入口和浏览/点星走同一份仓库地址,不给旁路。
      const repo = communityRepo();

      const apiBase = "https://api.github.com";
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      };

      // 所有权:author = token 用户的**权威 GitHub login**(覆盖客户端传的,防冒名)。自动审查 Action 据此判"只能改/删自己的"。
      let ghLogin: string | undefined;
      try { const u = await fetch(`${apiBase}/user`, { headers }); if (u.ok) ghLogin = (await u.json() as any)?.login; } catch { /* ignore */ }
      if (ghLogin) (data as any).author = ghLogin;
      const actor = ghLogin || author || "anon";

      // fork 策略:非仓库 owner 的用户先 fork(推不了别人的仓库),分支推到自己的 fork,再从 fork 提 PR。
      // owner 直接在本仓库开分支 + PR。fork 是异步的,创建后短暂等待其就绪。
      const isOwner = !!ghLogin && ghLogin.toLowerCase() === repo.owner.toLowerCase();
      let headRepoOwner = repo.owner; // 分支所在仓库(fork 时 = 用户)
      if (!isOwner && ghLogin) {
        try {
          const fk = await fetch(`${apiBase}/repos/${repo.owner}/${repo.name}/forks`, { method: "POST", headers });
          if (fk.ok) {
            headRepoOwner = ghLogin;
            // fork 是异步的:轮询 fork 仓库直到就绪(最多 ~15s),否则后续在 fork 上建对象会 404。
            for (let i = 0; i < 10; i++) {
              const probe = await fetch(`${apiBase}/repos/${headRepoOwner}/${repo.name}`, { headers });
              if (probe.ok) break;
              await new Promise(r => setTimeout(r, 1500));
            }
            // 重复贡献者的旧 fork 会落后于 base → 把 fork 默认分支同步到上游,避免 base_tree/parent 在 fork 里不存在 + PR 带脏 diff。
            try {
              await fetch(`${apiBase}/repos/${headRepoOwner}/${repo.name}/merge-upstream`, {
                method: "POST", headers, body: JSON.stringify({ branch: repo.branch || "main" }),
              });
            } catch { /* 同步失败 → 退回用 fork 当前 SHA(全新 fork 时本就同步) */ }
          }
        } catch { /* fork 失败 → 退回直推(可能 403,前端会显示) */ }
      }

      // 1. Get default branch SHA —— 从 head 仓库(fork 时 = 用户 fork,已同步上游)读,确保后续对象的 base 在该仓库存在。
      const branchResp = await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/refs/heads/${repo.branch || "main"}`,
        { headers }
      );
      if (!branchResp.ok) {
        return res.status(502).json({ error: `Failed to get branch: ${branchResp.status}` });
      }
      const branchData = await branchResp.json() as any;
      const baseSha = branchData.object.sha;

      // 2. Create blob —— 后续 git 对象都建在 head 仓库(非 owner 时 = 用户的 fork)。
      const content = JSON.stringify(data, null, 2);
      const blobResp = await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/blobs`,
        { method: "POST", headers, body: JSON.stringify({ content, encoding: "utf-8" }) }
      );
      if (!blobResp.ok) {
        return res.status(502).json({ error: `Failed to create blob: ${blobResp.status}` });
      }
      const blobData = await blobResp.json() as any;

      // 3. Determine file path
      const typeDir = type === "template" ? "templates" : "agents"; // 白名单已收窄到 template/agent(prompt 分享下线)
      const id = data.id || `${ghLogin || author}-${Date.now()}`;
      const filePath = `${typeDir}/${id}.json`; // 顶层目录,对齐仓库结构 + 自动审查 Action 的 CONTENT_DIRS

      // 4. Create tree
      const treeResp = await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/trees`,
        {
          method: "POST", headers,
          body: JSON.stringify({
            base_tree: baseSha,
            tree: [{ path: filePath, mode: "100644", type: "blob", sha: blobData.sha }],
          }),
        }
      );
      if (!treeResp.ok) {
        return res.status(502).json({ error: `Failed to create tree: ${treeResp.status}` });
      }
      const treeData = await treeResp.json() as any;

      // 5. Create commit
      const parentResp = await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/commits/${baseSha}`,
        { headers }
      );
      let parentSha = baseSha;
      if (parentResp.ok) {
        const parentData = await parentResp.json() as any;
        parentSha = parentData.sha;
      }

      const commitResp = await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/commits`,
        {
          method: "POST", headers,
          body: JSON.stringify({
            message: message || `Share ${type}: ${data.title || id}`,
            tree: treeData.sha,
            parents: [parentSha],
          }),
        }
      );
      if (!commitResp.ok) {
        return res.status(502).json({ error: `Failed to create commit: ${commitResp.status}` });
      }
      const commitData = await commitResp.json() as any;

      // 6. Create branch(建在 head 仓库;fork 时 = 用户的 fork)
      const branchName = `community/${actor}-${type}-${id.slice(0, 16)}`;
      await fetch(
        `${apiBase}/repos/${headRepoOwner}/${repo.name}/git/refs`,
        {
          method: "POST", headers,
          body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: commitData.sha }),
        }
      );

      // 7. Create PR —— 始终提到 base 仓库;fork 时 head 要带 owner 前缀 `<user>:<branch>`。
      const prHead = headRepoOwner.toLowerCase() === repo.owner.toLowerCase() ? branchName : `${headRepoOwner}:${branchName}`;
      const prResp = await fetch(
        `${apiBase}/repos/${repo.owner}/${repo.name}/pulls`,
        {
          method: "POST", headers,
          body: JSON.stringify({
            title: `[Community] ${type}: ${data.title || id} by ${actor}`,
            head: prHead,
            base: repo.branch || "main",
            body: message || `Shared via OPC Studio`,
          }),
        }
      );
      if (!prResp.ok) {
        const errBody = await prResp.text();
        return res.status(502).json({ error: `Failed to create PR: ${prResp.status} ${errBody}` });
      }
      const prData = await prResp.json() as any;

      invalidateRemoteCache();
      return res.json({ prUrl: prData.html_url });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });
}
