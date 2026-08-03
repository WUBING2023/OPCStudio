import type { AgentNodeConfig, CapabilityReport, CapabilityReportItem, CapabilityNeedsAuth, CapabilitySubstitution, EngineAvailability, ManifestBoundaryNote, SuggestedTeamMember } from "@opc/shared";
import { loadAgents } from "../storage/projectStore.js";
import { getCompany } from "../storage/companyStore.js";
import { probeClaudeCodeAsync, probeCodexAsync, probeNativeSubscriptionPassiveAsync, probeGenericCliAsync } from "./engines/probes.js";
import { GENERIC_CLI_PRESETS } from "./engines/genericCliPresets.js";
import { syncProvidersFromStore, isProviderAvailable } from "./providerRegistry.js";
import { resolveAutoSubscription } from "./systemModel.js";
import { listMcpServers } from "../storage/mcpStore.js";
import { listSkills } from "../storage/skillStore.js";
// P0(活体抓出)· effEngineForMode 是"执行计划的现实":economy/balanced/maxQuality 会按 role 覆盖 framework/provider。
// 预检必须按【生效引擎】判可用性,否则会报 canRun=true 而调度时 no_account(用户实测)。effEngineForMode 在
// workerRuntime.ts(非本模块铁律禁止的 engineRouter/agentCapabilities),导入合法。
import { effEngineForMode, type TeamMode } from "./workerRuntime.js";
import { isProbeReady, SUBSCRIPTION_FRAMEWORKS } from "./executionAvailability.js";

// Stage 5 · 能力边界报告。SEC ①② = 运行时**客观静态事实**(引擎装没装/key 在不在/MCP 配没配);
// SEC ③ = **仅** manifest 作者标注(buildSection3 纯函数,签名物理上无法接收运行时状态)。
// 反陷阱铁律:本模块**不 import** engineRouter / agentCapabilities —— 防 CAPABILITY_TABLE / capabilityMatch
// 这类"框架路由提示"被误当作"本团队不能可靠完成"写进第③段(那是未解决的 agent 自我认知难题)。
// audit: 上面这行的 engineRouter/agentCapabilities/CAPABILITY_TABLE 仅出现在注释,本文件无对应 import(对抗审查已确认密封)。

const CAPABILITY_PROBE_TIMEOUT_MS = Number(process.env.OPC_CAPABILITY_PROBE_TIMEOUT_MS ?? 2500);

function timedOutAvailability(framework: string): EngineAvailability {
  return {
    framework: framework as EngineAvailability["framework"],
    installed: false,
    loggedIn: false,
    version: "",
    detail: `${framework} probe timed out after ${CAPABILITY_PROBE_TIMEOUT_MS}ms; availability was not proven`,
  };
}

async function withProbeTimeout(framework: string, probe: () => Promise<EngineAvailability>): Promise<EngineAvailability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<EngineAvailability>((resolve) => {
    timer = setTimeout(() => resolve(timedOutAvailability(framework)), CAPABILITY_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── 第③段:纯函数,只接受 manifest 字段 ──────────────────────────────────────
// 物理边界:参数只有 string[]|undefined,编译器层面阻止传入 projectRoot/goal/agents/能力表。
export function buildSection3(
  riskNotes: string[] | undefined,
  useCases: string[] | undefined,
): { notApplicable: ManifestBoundaryNote[]; authorAnnotated: boolean } {
  const notApplicable: ManifestBoundaryNote[] = [];
  for (const n of riskNotes ?? []) {
    if (typeof n === "string" && n.trim()) notApplicable.push({ note: n.trim(), source: "manifest-riskNote" });
  }
  for (const u of useCases ?? []) {
    if (typeof u === "string" && u.trim()) notApplicable.push({ note: `设计用途: ${u.trim()}(不在此列的场景可能不适用)`, source: "manifest-useCase" });
  }
  return { notApplicable, authorAnnotated: notApplicable.length > 0 };
}

// 读侧 alias 归一(本模块铁律不 import engineRouter,见上,自持一份最小归一):存量节点的
// "hermes"/缺省 framework 一律按 "api"(in-process ApiEngine)对待,绝不因 hermes.exe 不在而误报引擎不可用。
function normalizeFw(framework?: string): string {
  return !framework || framework === "hermes" ? "api" : framework;
}

// ── 引擎就绪(全 async 探针 → 不阻塞事件循环;多 framework 并行)─────────────
async function probeFramework(framework: string, cliConfigDir?: string) {
  try {
    // api = 内置 in-process 引擎,无 CLI/登录态可探,恒就绪;可用性的诚实闸门是下方 provider key 维度。
    if (framework === "api") return { framework: "api", installed: true, loggedIn: true, version: "in-process" } as any;
    if (framework === "claude-code") return await withProbeTimeout(framework, () => probeClaudeCodeAsync(cliConfigDir));
    if (framework === "codex") return await withProbeTimeout(framework, () => probeCodexAsync(cliConfigDir));
    if (framework === "gemini-cli" || framework === "kimi-cli" || framework === "grok-build") {
      return await withProbeTimeout(framework, () => probeNativeSubscriptionPassiveAsync(framework, cliConfigDir));
    }
    // 12+1 框架扩展:9 个 GenericCliEngine 预设(gemini-cli…open-interpreter)按各自的 command 真探测
    // 是否已安装——之前这里落到最后的"未知引擎"兜底会让这些框架的能力报告永远显示"不可用",哪怕用户
    // 机器上其实真的装了对应 CLI。
    const preset = (GENERIC_CLI_PRESETS as Record<string, any>)[framework];
    if (preset) return await withProbeTimeout(framework, () => probeGenericCliAsync(preset));
    if (framework === "generic-cli") {
      return { framework: "generic-cli", installed: true, loggedIn: true, version: "", detail: "自定义 CLI:安装状态取决于各节点自填的 command,需在节点上单独确认" } as any;
    }
  } catch { /* probe 失败视为不可用 */ }
  return { framework, installed: false, loggedIn: false, version: "", detail: `未知引擎 ${framework}` } as any;
}

// 依赖注入 seam(测试用,同 globalDoctor 惯例):默认走真实引擎探针 + 真实 provider 注册查询;单测注入
// fake 控制引擎/订阅安装态与 provider key 有无,不真 spawn CLI、不依赖全局 registry / 本机 key 文件。
// probeEngine 同时供 ① 引擎维度与 ②′ 订阅平替探测复用(一处控制两处,口径统一)。
export interface CapabilityReportDeps {
  probeEngine?: (framework: string, cliConfigDir?: string) => Promise<EngineAvailability>;
  hasProviderKey?: (provider: string) => boolean;
}

export async function buildCapabilityReport(
  projectRoot: string,
  companyId: string,
  deps: CapabilityReportDeps = {},
  opts: { teamMode?: TeamMode; runType?: "quick" | "team"; targetAgentId?: string } = {},
): Promise<CapabilityReport> {
  const company = getCompany(projectRoot, companyId);
  if (!company) throw new Error(`company not found: ${companyId}`);
  const allAgents = loadAgents(projectRoot, []).filter(a => a.companyId === companyId && (a as any).enabled !== false);
  // P0:quick run 只跑目标 agent(或 CEO),预检也应只按它判——否则拿全公司(含用不到引擎)误报 blocked。
  const agents = opts.runType === "quick"
    ? allAgents.filter(a => opts.targetAgentId ? a.id === opts.targetAgentId : a.role === "ceo")
    : allAgents;

  const probeEngine = deps.probeEngine ?? probeFramework;
  const hasProviderKey = deps.hasProviderKey ?? isProviderAvailable;

  // P0 · 生效引擎解析:按 effEngineForMode(role, teamMode) 后的 framework/provider 判可用性(与真实执行/scheduler
  // 租约同口径);无覆盖(null)退回静态 framework(经 normalizeFw:hermes/缺省→api)/provider。
  const effFor = (a: AgentNodeConfig): { fw: string; provider: string } => {
    const e = effEngineForMode(a.role, opts.teamMode);
    return { fw: e?.framework ?? normalizeFw(a.framework), provider: e?.provider ?? a.provider };
  };

  const ready: CapabilityReportItem[] = [];
  const needsAuth: CapabilityNeedsAuth[] = [];
  const substituted: CapabilitySubstitution[] = [];
  const blockedBy: string[] = [];

  // ① 引擎维度:每个被实际使用的 framework 探一次(按 cliConfigDir 去重)。
  const fwUsed = new Map<string, AgentNodeConfig[]>();
  for (const a of agents) {
    const fw = effFor(a).fw; // 生效引擎(非静态 a.framework)
    (fwUsed.get(fw) ?? fwUsed.set(fw, []).get(fw)!).push(a);
  }
  const engineReady = new Map<string, boolean>(); // framework → ready
  // 并行探测所有 framework(async 探针,wall-clock = 最慢单个 ≈ max,而非求和)。
  // api(in-process ApiEngine)不经探针(注入的 fake 也不该管它):无 CLI/登录态可探,恒就绪,
  // 可用性的诚实闸门在下方 provider key 维度。
  const probed = await Promise.all([...fwUsed.entries()].map(async ([fw, fwAgents]) => {
    if (fw === "api") return { fw, av: { framework: "api", installed: true, loggedIn: true, version: "in-process" } as EngineAvailability };
    const dir = fwAgents.find(a => a.cliConfigDir)?.cliConfigDir;
    return { fw, av: await probeEngine(fw, dir) };
  }));
  for (const { fw, av } of probed) {
    const ok = isProbeReady(av);
    engineReady.set(fw, ok);
    if (ok) {
      ready.push({ kind: "cli", name: fw, detail: av.version || undefined });
    } else {
      // 引擎未就绪:不做"订阅未登录自动回退 API"(执行语义不同,见任务书②),但把 blockedBy / howTo
      // 写成人话可操作——已装未登录时明确两条出路(去能力页订阅板块登录 / 把该员工改为 API 模式),
      // 未安装时带上探针给的安装指引。
      const howTo = av.installed
        ? `引擎 ${fw} 未登录:请在「能力」页的订阅板块登录,或把使用该引擎的员工改为 API 模式${av.detail ? `(${av.detail})` : ""}`
        : (av.detail || `安装并登录 ${fw}`);
      needsAuth.push({ item: { kind: "cli", name: fw, detail: av.detail }, required: true, howTo });
      blockedBy.push(av.installed
        ? `引擎 ${fw} 未登录:请在能力页订阅板块登录,或把该员工改为 API 模式`
        : `引擎 ${fw} 未安装:${av.detail || `请先安装并登录 ${fw}`}`);
    }
  }

  // ② Provider key 维度:仅非 CLI 框架的 agent 需要(CLI 订阅制无 key)。
  syncProvidersFromStore(projectRoot);
  const providerReady = new Map<string, boolean>();
  const providersNeeded = new Set<string>();
  for (const a of agents) {
    const { fw, provider } = effFor(a); // 生效引擎/provider(非静态)
    if (SUBSCRIPTION_FRAMEWORKS.has(fw)) continue;
    providersNeeded.add(provider);
  }
  // 无 key 订阅平替探测(与 globalDoctor / systemModelInvoke 同口径:复用 resolveAutoSubscription,
  // 只有探针确认 installed+loggedIn 才算可平替,避免预检放行后真正派发才暴露未登录。按 framework 记忆化,
  // 避免同一订阅被多个缺 key 的 provider 重复探测。
  const subInstalledCache = new Map<string, Promise<boolean>>();
  const isSubscriptionReady = (sub: string): Promise<boolean> => {
    let pr = subInstalledCache.get(sub);
    if (!pr) {
      pr = Promise.resolve(probeEngine(sub)).then(isProbeReady).catch(() => false);
      subInstalledCache.set(sub, pr);
    }
    return pr;
  };
  for (const p of providersNeeded) {
    if (hasProviderKey(p)) {
      providerReady.set(p, true);
      ready.push({ kind: "provider", name: p });
      continue;
    }
    // 无 key:看该 provider 有没有对应订阅可平替(anthropic→claude-code / openai→codex / google→gemini-cli)。
    const outcome = await resolveAutoSubscription(
      { framework: "api", provider: p, model: "" },
      { hasProviderKey, isSubscriptionReady },
    );
    if (outcome.kind === "substituted") {
      // 有可平替订阅 → 该 provider 视为可执行,不阻塞 canRun,记入 substituted 供 UI 如实展示。
      providerReady.set(p, true);
      const note = `${p} 无 API key,将走 ${outcome.to} 订阅执行`;
      substituted.push({ item: { kind: "provider", name: p, detail: note }, via: outcome.to, note });
    } else {
      // 既无 key 也无可用订阅(订阅未装或无映射)→ 硬拦。
      providerReady.set(p, false);
      const sub = outcome.kind === "unavailable" ? outcome.subscription : undefined;
      const howTo = sub
        ? `为 ${p} 配置 API Key(设置 > Provider,或放 .opc/keys/${p}.key),或安装并登录 ${sub} 订阅 CLI`
        : `在 设置 > Provider 填入 ${p} 的 API Key(或放 .opc/keys/${p}.key)`;
      needsAuth.push({ item: { kind: "provider", name: p }, required: true, howTo });
      blockedBy.push(`缺 ${p} API key${sub ? `(也未检测到 ${sub} 订阅)` : ""}`);
    }
  }

  // ③(可选信息)MCP / skill 维度:展示用,非 required(缺了不阻塞运行——MCP 是本机服务,装不装是用户的选择,
  // 不该因为一个模板想用某个 MCP 就硬挡整条团队跑不起来)。
  try {
    const localMcp = listMcpServers(projectRoot);
    for (const s of localMcp) {
      const configured = s.transport === "http" ? !!s.url : !!s.command;
      if (s.enabled && configured) ready.push({ kind: "mcp", name: s.name, detail: s.transport });
      else if (s.enabled && !configured) needsAuth.push({ item: { kind: "mcp", name: s.name }, required: false, howTo: `MCP「${s.name}」缺 ${s.transport === "http" ? "url" : "command"} 配置` });
    }
    // Stage 8+:模板作者声明的 mcpRequirements(install 时保留在 company.manifestMcpRequirements)——
    // 交叉核对本机是否已配置同名 MCP,缺失的报进 needsAuth(仍非 required,维持"MCP 不阻塞运行"的既有闸门语义;
    // 如果未来产品要让"必需"的 MCP 真正阻塞执行,这里的 required 需要改成看 !req.optional,并同步评估 canRun 的影响面)。
    const configuredNames = new Set(localMcp.filter(s => s.enabled && (s.transport === "http" ? !!s.url : !!s.command)).map(s => s.name.trim().toLowerCase()));
    for (const mcpReq of company.manifestMcpRequirements ?? []) {
      if (!mcpReq?.name || configuredNames.has(mcpReq.name.trim().toLowerCase())) continue;
      needsAuth.push({
        item: { kind: "mcp", name: mcpReq.name, detail: mcpReq.purpose },
        required: false,
        howTo: `模板声明需要 MCP「${mcpReq.name}」${mcpReq.purpose ? `(${mcpReq.purpose})` : ""}${mcpReq.optional ? "(可选)" : ""}——去「MCP」页添加`,
      });
    }
  } catch { /* best-effort */ }
  try {
    const roles = new Set(agents.map(a => a.role));
    for (const sk of listSkills(projectRoot)) {
      // origin:"memory" 技能不是用户资产,不该出现在面向用户的能力报告里(只在专门的技能库页面按
      // origin=user 展示)。曾经的生成源是 skillEvolution.ts(把成功任务沉淀成 workflow-<role>-<goal>
      // 技能)——那条路径已经砍掉,不再产生新的 origin:memory 技能;这行过滤现在是纯防御性的(万一
      // 用户手动创建/导入了一个 origin:memory 的技能,或未来又有别的路径写出这个 origin),不再是
      // "过滤自动生成噪音"的核心防线。
      if ((sk.origin ?? "user") === "memory") continue;
      if (sk.enabled && (roles.has(sk.role) || sk.role === "*")) ready.push({ kind: "skill", name: sk.title, detail: sk.role });
    }
  } catch { /* best-effort */ }

  // 第③段:严格只读 manifest。
  const { notApplicable, authorAnnotated } = buildSection3(company.manifestRiskNotes, company.manifestUseCases);

  // 建议团队:每个 agent 的就绪快照。
  const suggestedTeam: SuggestedTeamMember[] = agents.map(a => {
    const { fw, provider } = effFor(a); // 生效引擎/provider(与执行/scheduler 同口径)
    const engOk = engineReady.get(fw) ?? false;
    const provOk = SUBSCRIPTION_FRAMEWORKS.has(fw) ? true : (providerReady.get(provider) ?? false);
    const readyToRun = engOk && provOk;
    let blockedReason: string | undefined;
    if (!engOk) blockedReason = `引擎 ${fw} 未就绪`;
    else if (!provOk) blockedReason = `缺 ${provider} API key`;
    return { agentId: a.id, agentName: a.name, role: a.role, framework: fw, provider, readyToRun, blockedReason };
  });

  // canRun:所有 required(引擎 + provider key)就绪才能跑。
  const canRun = needsAuth.filter(n => n.required).length === 0;

  return {
    companyId, generatedAt: new Date().toISOString(),
    ready, needsAuth, substituted, notApplicable, authorAnnotated, suggestedTeam,
    canRun, blockedBy,
  };
}
