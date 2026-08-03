import { X, AlertTriangle, Check, RefreshCw, ExternalLink } from "lucide-react";
import type { AgentNodeConfig, AgentFramework, NativeExecutionPreference, ReasoningEffort, EngineAvailability, PublicProviderAccount } from "@opc/shared";
import { useAgentStore } from "../store/useAgentStore.js";
import { useState, useEffect } from "react";
import * as api from "../api/client.js";
import { STATUS_COLORS, ROLE_COLORS, ROLE_LABELS, NEUTRAL_GRAY, statusLabel } from "../lib/agentMeta.js";
import { cleanText } from "../lib/text.js";
import MemoryLessons from "./MemoryLessons.js";
import { defaultFrameworkFor, sortConfiguredFirst, EXECUTION_TIER1, SUBSCRIPTION_TIER1, SUBSCRIPTION_BRAND, patchForTier1, PROVIDER_DEFAULT_MODEL, CLI_MODEL_ALIASES, CLI_FRAMEWORK_PROVIDER, CLI_FRAMEWORK_ACCOUNT_PROVIDERS, FRAMEWORK_TO_CATALOG_ENGINE, canRefreshSubscriptionCatalog, isSubscriptionFramework, isModelOutsideCatalog, API_FRAMEWORK, isApiFramework, normalizeFramework, type SubscriptionFramework } from "../lib/framework.js";
import { useT } from "../i18n.js";
import { useSetupInstallJob } from "../lib/useSetupInstallJob.js";
import { useFrameworkAvailabilityStore } from "../store/useFrameworkAvailabilityStore.js";
import { openRun } from "../lib/navigation.js";
import NativeExecutionPreferenceControl from "./NativeExecutionPreferenceControl.js";

const GREEN = "var(--color-success)";
const AMBER = "var(--color-warning)";
const GRAY = "var(--color-ink-subtle)";

// 订阅推理档位四档(低/中/高/超高),顺序 = 由浅到深。i18n key = agent.effort.<value>。
const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh"];
// 哪些订阅引擎支持推理档位调节(侦察结论):codex 经 CODEX_CONFIG.model_reasoning_effort 生效;
// claude-code 经 CLAUDE_CODE_EFFORT_LEVEL(claude CLI 2.1.x+ 原生 low/medium/high/xhigh,SDK 直接读取)生效;
// 两者均与 OPC ReasoningEffort 四档 1:1。Gemini/Kimi/Grok 暂不支持——UI 禁用并如实标注。
function frameworkSupportsEffort(fw: AgentFramework): boolean {
  return fw === "codex" || fw === "claude-code";
}

// 版本串可能很长(引擎探针把整段环境信息塞进来)→ 只取首段、截断,避免溢出;完整放 title。
function shortVersion(v: string): string {
  const head = (v || "").split(/[·\n]|Project:|Update available/)[0].trim();
  return head.length > 30 ? head.slice(0, 30) + "…" : head;
}

// C5 · 员工成长:等级曲线镜像后端 agentGrowthStore.computeLevel(level = 1 + floor(sqrt(xp/100)))。
// 前端不重算 level(始终以后端写入的 agent.growth.level 为准),只反推"当前等级的 XP 区间"画进度条。
function growthLevelBounds(level: number): { lower: number; upper: number } {
  const lv = Math.max(1, level);
  return { lower: (lv - 1) ** 2 * 100, upper: lv ** 2 * 100 };
}

function dotColor(av?: EngineAvailability): string {
  if (!av) return GRAY;
  if (av.installed && av.loggedIn) return GREEN; // ready
  if (av.installed && !av.loggedIn) return AMBER; // installed but not logged in
  return GRAY; // not installed
}

// CLI 订阅框架"认证方式"的第二级切换——纯视图态,不落盘(底层真值始终只是 agent.cliConfigDir 这一个
// 字符串字段):"订阅账号"=原有自由文本 configDir 输入;"API Key"=从 /api/accounts 里挑一个该框架的
// API Key 账号,选中即把它的 configDir 写回 agent.cliConfigDir(与订阅账号复用同一套 cliConfigDir 隔离
// 机制,见 apps/server/src/runtime/engines/apiKeyAccount.ts)。
type CliAuthMode = "subscription" | "apikey";

export default function AgentDetailsPanel({ agent, onClose, canEditStructure, companyNativeExecution }: {
  agent: AgentNodeConfig;
  onClose: () => void;
  /** 只锁「组织结构」编辑(改名/层级)——执行配置(执行方式/供应商/模型/认证)任何模式都可改。
   *  用户实测(2026-07-10):此前 readOnly=!canEditStructure 把执行配置区整体禁用,日常模式下点
   *  执行方式/模型毫无反应,表现为"切换失效"——运行配置是日常操作,不是组织结构,不该被该门锁住。 */
  canEditStructure: boolean;
  companyNativeExecution?: NativeExecutionPreference;
}) {
  const t = useT();
  const update = useAgentStore(s => s.update);
  const readOnly = false; // 执行配置永不只读;组织结构编辑仍由 canEditStructure 单独把守(见改名处)
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const frameworks = useFrameworkAvailabilityStore(s => s.frameworks);
  const frameworksRefreshing = useFrameworkAvailabilityStore(s => s.refreshing);
  const hydrateFrameworks = useFrameworkAvailabilityStore(s => s.hydrate);
  const refreshFrameworks = useFrameworkAvailabilityStore(s => s.refresh);
  const [models, setModels] = useState<string[]>([]);
  const [customModel, setCustomModel] = useState(false);
  const [providerIds, setProviderIds] = useState<string[]>(["deepseek", "minimax", "doubao", "openai", "anthropic", "openrouter", "ollama"]);
  const [configured, setConfigured] = useState<Set<string>>(new Set());
  const [accounts, setAccounts] = useState<PublicProviderAccount[]>([]);
  const [authMode, setAuthMode] = useState<CliAuthMode>("subscription");
  const [catalog, setCatalog] = useState<api.ModelCatalog | null>(null);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [catalogRefreshError, setCatalogRefreshError] = useState("");
  const [installMsg, setInstallMsg] = useState("");

  useEffect(() => {
    setName(agent.name);
    setModel(agent.model);
    setTestResult(null);
    setCatalogRefreshError("");
    loadRuns();
  }, [agent.id, agent.name, agent.model]);

  // 三级模型目录(单一事实源）：模型下拉与"目录外"校验都以它为准。服务端对 ACP 握手设 1.2s 软时限,
  // 冷缓存首拉可能拿到 source:static 的兜底——10 秒后重取一次(此时后台真握手已写入缓存,换成活值)。
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retryOnStale: boolean) => {
      api.getModelCatalog().then(c => {
        if (!alive) return;
        setCatalog(c);
        if (retryOnStale && c.subscriptions.some(s => s.installed && s.source === "static")) {
          timer = setTimeout(() => load(false), 10_000);
        }
      }).catch(() => {
        if (!alive) return;
        setCatalog(null);
        if (retryOnStale) timer = setTimeout(() => load(false), 10_000);
      });
    };
    load(true);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);

  // 第一级"执行方式"的当前生效值——老节点(agents.json 里没存 framework 字段的)按 provider/model 猜(与
  // 建 agent 时的 defaultFrameworkFor 同一套规则),不然它们在两级 UI 里会落进错误的第一级分组。
  const currentFramework: AgentFramework = agent.framework ?? defaultFrameworkFor(agent.provider, agent.model);
  const isCli = isSubscriptionFramework(currentFramework);
  // 当前生效的第一级选项(存量 "hermes" 归一后查表);blurb/warning 均经 i18n key 渲染(E2)。
  const tier1Option = EXECUTION_TIER1.find(o => o.id === normalizeFramework(currentFramework));
  // 已从选择器下线的历史执行方式(9个第三方CLI/自定义CLI):存量员工照常运行,但面板提示迁移。
  // isApiFramework 双接受存量 "hermes"——旧员工不误报"已下线"。
  const isLegacyFramework = !isCli && !isApiFramework(currentFramework);
  const currentCatalogEntry = isCli
    ? catalog?.subscriptions.find(s => s.engine === FRAMEWORK_TO_CATALOG_ENGINE[currentFramework as SubscriptionFramework])
    : catalog?.apiProviders.find(p => p.provider === agent.provider);
  const refreshCurrentModels = async () => {
    const id = isCli ? FRAMEWORK_TO_CATALOG_ENGINE[currentFramework as SubscriptionFramework] : agent.provider;
    if (!id || catalogRefreshing) return;
    setCatalogRefreshing(true);
    setCatalogRefreshError("");
    try {
      await api.refreshModelCatalog(isCli ? "subscription" : "provider", id);
      setCatalog(await api.getModelCatalog());
    } catch (e) {
      setCatalogRefreshError(e instanceof Error ? e.message : String(e));
    } finally {
      setCatalogRefreshing(false);
    }
  };

  // 目录外即时校验:所填/所选模型不在当前引擎(订阅)或供应商(API)的目录内 → 醒目警告。专治用户痛点
  // "选模型名是难点 + HTTP 404 model:sonnet"——尤其接住旧配置把 CLI 别名(sonnet 等)落在 API 面。
  // 目录未加载、或目录为空(如订阅 CLI 未装)时不误报。
  const catalogModelIds: string[] = (() => {
    if (!catalog) return [];
    if (isCli) {
      const engineId = FRAMEWORK_TO_CATALOG_ENGINE[currentFramework as SubscriptionFramework];
      return (catalog.subscriptions.find(s => s.engine === engineId)?.models ?? []).map(m => m.id);
    }
    return (catalog.apiProviders.find(p => p.provider === agent.provider)?.models ?? []).map(m => m.id);
  })();
  const trimmedModel = (model || "").trim();
  // 订阅引擎:目录真值 ∪ 该引擎合法 CLI 别名表 都算目录内(ACP 活体目录上线后 opus 等合法别名不误告警)。
  const catalogAliases = isCli ? (CLI_MODEL_ALIASES[currentFramework as SubscriptionFramework] ?? []) : [];
  const notInCatalog = isModelOutsideCatalog(catalogModelIds, model, catalogAliases);

  // 第二级(API 分支)供应商列表与"已配置"标记:目录 hasKey(env>keys文件>config 全链解析)优先,
  // 目录未到位回退 /accounts 的 hasApiKey 口径。
  const configuredFinal = catalog
    ? new Set(catalog.apiProviders.filter(p => p.hasKey).map(p => p.provider))
    : configured;
  const providerIdsFinal = catalog
    ? sortConfiguredFirst([...catalog.apiProviders.map(p => p.provider), agent.provider], configuredFinal)
    : sortConfiguredFirst([...providerIds, agent.provider], configured);
  const catalogWarning = notInCatalog ? (
    <div className="mt-2 flex items-start gap-1.5 text-[10px] text-amber leading-snug">
      <AlertTriangle size={12} className="shrink-0 mt-0.5" />
      <span>{t('agent.model.notInCatalog', { model: trimmedModel })}</span>
    </div>
  ) : null;

  // Selectable models. For CLI subscription frameworks the model is a CLI alias (see
  // CLI_MODEL_ALIASES — single source of truth, live-verified against the real CLIs), NOT a
  // provider API model — so don't pass e.g. deepseek-chat to `claude --model`. For the API framework,
  // list the provider's live-synced + builtin models. "custom" always allows a free-text override.
  useEffect(() => {
    if (isSubscriptionFramework(currentFramework)) {
      // 订阅引擎模型来自目录(反映 installed 状态与 ACP/静态来源);目录未到位则回退客户端 CLI 别名。
      const engineId = FRAMEWORK_TO_CATALOG_ENGINE[currentFramework];
      const fromCatalog = catalog?.subscriptions.find(s => s.engine === engineId)?.models.map(x => x.id);
      const m = fromCatalog && fromCatalog.length ? fromCatalog : CLI_MODEL_ALIASES[currentFramework];
      setModels(m); setCustomModel(!!agent.model && !m.includes(agent.model));
      return;
    }
    // API 供应商:第三级只出目录模型(/api/model-catalog 单一事实源);目录外经"自定义…"手输并即时告警。
    const fromCatalog = catalog?.apiProviders.find(p => p.provider === agent.provider)?.models.map(x => x.id) ?? [];
    setModels(fromCatalog);
    setCustomModel(!!agent.model && !fromCatalog.includes(agent.model));
  }, [agent.provider, agent.model, currentFramework, catalog]);

  useEffect(() => { hydrateFrameworks(); }, [hydrateFrameworks]);

  // 订阅 CLI 一键安装(用户定稿):走既有 /setup/install(npm -g,白名单常量表)+ 状态轮询,
  // 装完重探 /frameworks 刷新安装点;登录是各家 CLI 的终端交互(OAuth),这里只给指引不假装能代办。
  const LOGIN_CMD: Record<SubscriptionFramework, string> = {
    "claude-code": "claude(首次进入即引导登录)",
    codex: "codex login",
    "gemini-cli": "gemini(首次进入即引导 Google 登录)",
    "kimi-cli": "kimi login",
    "grok-build": "grok login",
  };
  const { installing, start: startInstallJob } = useSetupInstallJob((job) => {
    if (job.status === "done") setInstallMsg(t('agent.install.done', { engine: job.engine, login: LOGIN_CMD[job.engine] }));
    else setInstallMsg(t('agent.install.failed', { reason: job.error ?? job.status }));
    void refreshFrameworks().catch(() => {});
  });
  const startInstall = async (fw: SubscriptionFramework) => {
    if (installing) return;
    setInstallMsg(t('agent.install.running', { engine: fw }));
    try {
      await startInstallJob(fw);
    } catch (e) {
      setInstallMsg(t('agent.install.failed', { reason: e instanceof Error ? e.message : String(e) }));
    }
  };

  // Provider dropdown: presets ∪ custom (providers.json), with CONFIGURED providers (those that have
  // an account / key, from /api/accounts) sorted first (C: 切换优先已配置)。同一份 /accounts 结果也喂给
  // 下面 CLI 认证方式的"API Key 账号"选择器(cliApiKeyAccounts),不再多发一次请求。
  useEffect(() => {
    const presets = ["deepseek", "minimax", "doubao", "openai", "anthropic", "openrouter", "ollama"];
    Promise.all([
      api.get<Array<{ id: string }>>("/providers").catch(() => []),
      api.get<PublicProviderAccount[]>("/accounts").catch(() => []),
    ]).then(([ps, accts]) => {
      // Bug 修复:CLI 订阅账号(Claude Code/Codex 登录)apiKey 是空字符串,只是 OAuth 会话,
      // 不代表 API 引擎能调这家的 API——只有真正持有 apiKey 的账号才算"已配置"。
      const cfg = new Set((accts || []).filter(a => a.enabled !== false && a.hasApiKey).map(a => a.providerId));
      setConfigured(cfg);
      setAccounts(accts || []);
      setProviderIds(sortConfiguredFirst([...presets, ...(ps || []).map(p => p.id)], cfg));
    }).catch(() => {});
  }, []);

  // CLI 订阅框架的"认证方式"视图态初始化。claude-code 简化后(2026-07):真值就是 agent.claudeCodeUseApiKey
  // 这一个布尔开关,不再靠 cliConfigDir 反查账号猜测。codex 不对称——它仍靠 configDir 精确匹配一个专属
  // API Key 账号(见 apiKeyAccount.ts 顶部说明),这部分判断逻辑不变。
  useEffect(() => {
    const isCliFw = currentFramework === "claude-code" || currentFramework === "codex";
    if (!isCliFw) return;
    if (currentFramework === "claude-code") {
      setAuthMode(agent.claudeCodeUseApiKey ? "apikey" : "subscription");
      return;
    }
    const hit = agent.cliConfigDir ? accounts.find(a => a.configDir === agent.cliConfigDir) : undefined;
    setAuthMode(hit?.hasApiKey ? "apikey" : "subscription");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, agent.cliConfigDir, agent.claudeCodeUseApiKey, currentFramework, accounts]);

  const loadRuns = async () => {
    setLoadingRuns(true);
    try {
      const data = await api.get<any[]>(`/agents/${agent.id}/runs`);
      setRuns(data);
    } catch {
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<any>(`/agents/${agent.id}/test`, {});
      setTestResult(result);
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message });
    } finally {
      setTesting(false);
    }
  };

  const totalTokens = agent.tokenUsage.total;

  return (
    <div className="w-[350px] border-l border-border overflow-auto bg-bg-card flex flex-col animate-[slideLeft_0.2s_ease-out]">
      <style>{`
        @keyframes slideLeft {
          from { transform: translateX(20px); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>

      {/* Header */}
      <div className="px-5 py-4 border-b border-border flex justify-between items-center">
        <div>
          <div className="text-base font-semibold tracking-tight text-text-primary">{agent.name}</div>
          <div className="text-[10px] text-text-muted font-mono mt-0.5">{agent.id}</div>
        </div>
        <button onClick={onClose}
          className="border-none bg-bg-hover rounded-lg w-7 h-7 cursor-pointer flex items-center justify-center text-text-muted hover:bg-border hover:text-text-secondary transition-colors">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-auto px-5 py-4">
        {/* Status + Role badges */}
        <div className="flex gap-2 mb-5">
          <span className="px-3 py-1 rounded-full text-[11px] font-medium"
            style={{
              backgroundColor: (STATUS_COLORS[agent.status] || NEUTRAL_GRAY) + "15",
              color: STATUS_COLORS[agent.status] || NEUTRAL_GRAY,
            }}>
            {statusLabel(t, agent.status)}
          </span>
          <span className="px-3 py-1 rounded-full text-[11px] font-medium"
            style={{
              backgroundColor: (ROLE_COLORS[agent.role] || NEUTRAL_GRAY) + "15",
              color: ROLE_COLORS[agent.role] || NEUTRAL_GRAY,
            }}>
            {ROLE_LABELS[agent.role] || agent.role}
          </span>
        </div>

        {/* C5 · 员工成长(与记忆生命周期强绑定,见 storage/agentGrowthStore.ts):Lv 徽章 + XP 进度条 +
            成功率(有数据才显示)+ 擅长标签 + 最近踩坑(最新 3 条)。无 growth 字段的旧 agent 照实显示
            Lv.1 0XP,不虚构历史成长。 */}
        <div className="mb-5">
          <div className="text-[13px] font-semibold text-text-secondary mb-3">{t('agent.growth.title')}</div>
          {(() => {
            const level = agent.growth?.level ?? 1;
            const xp = agent.growth?.xp ?? 0;
            const { lower, upper } = growthLevelBounds(level);
            const pct = upper > lower ? Math.max(0, Math.min(100, ((xp - lower) / (upper - lower)) * 100)) : 100;
            return (
              <>
                <div className="flex items-center gap-3 mb-2">
                  <span className="px-2.5 py-1 rounded-full text-[12px] font-semibold bg-accent/10 text-accent shrink-0">
                    {t('agent.growth.level', { level })}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-bg-hover overflow-hidden">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="text-[11px] text-text-muted whitespace-nowrap shrink-0">{t('agent.growth.xpProgress', { xp, next: upper })}</span>
                </div>
                {agent.growth?.successRate !== undefined && (
                  <div className="text-[11px] text-text-muted mb-2">
                    {t('agent.growth.successRate')}: <span className="text-text-primary font-medium">{Math.round(agent.growth.successRate * 100)}%</span>
                  </div>
                )}
                {!!agent.growth?.specialties?.length && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {agent.growth.specialties.slice(0, 8).map((s, i) => (
                      <span key={i} className="px-2 py-0.5 rounded-full text-[10px] bg-green/10 text-green">{s}</span>
                    ))}
                  </div>
                )}
                {!!agent.growth?.weaknesses?.length && (
                  <div>
                    <div className="text-[11px] text-text-muted mb-1">{t('agent.growth.weaknesses')}</div>
                    <ul className="flex flex-col gap-1">
                      {agent.growth.weaknesses.slice(0, 3).map((w, i) => (
                        <li key={i} className="text-[11px] text-red bg-red/5 rounded-lg px-2 py-1 leading-snug break-words">{w}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            );
          })()}
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* Model & Provider Info — 两级化:第一级选执行方式(API/Claude Code 订阅/Codex 订阅),
            第二级按第一级动态出现(API→供应商+模型;CLI 订阅→模型别名,不再有"供应商"概念)。 */}
        <div className="mb-5">
          <div className="text-[13px] font-semibold text-text-secondary mb-3">{t('agent.exec.section')}</div>
          {/* 供应商/模型对所有节点可切换（含 CEO）；editable 仅控核心 agent 改名。 */}
          <div className="flex flex-col gap-3">
            <div>
              <label className="block text-[12px] text-text-muted mb-1.5">{t('agent.exec.name')}</label>
              {canEditStructure && agent.editable ? (
                <input value={name} onChange={e => setName(e.target.value)}
                  onBlur={() => { if (name.trim() && name !== agent.name) update(agent.id, { name: name.trim() }); }}
                  onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="border-0 border-b-2 border-border bg-transparent text-sm py-2 w-full outline-none focus:border-accent transition-colors" />
              ) : (
                <div className="text-[13px] text-text-primary">{agent.name}</div>
              )}
            </div>

            {/* 第一级:执行方式 = 订阅 / API；订阅分支包含 Claude/Codex/Gemini/Kimi/Grok。 */}
            <div>
              <label className="block text-[12px] text-text-muted mb-1.5">{t('agent.exec.mode')}</label>
              <div className="flex gap-1.5 mb-2">
                {([["sub", t('agent.exec.subscription')], ["api", t('agent.exec.api')]] as const).map(([m, mLabel]) => {
                  const active = m === "sub" ? isCli : isApiFramework(currentFramework);
                  return (
                    <button key={m} type="button" disabled={readOnly}
                      onClick={() => {
                        if (readOnly || active) return;
                        const nextFw = m === "api"
                          ? API_FRAMEWORK
                          : (SUBSCRIPTION_TIER1.find(o => frameworks.find(f => f.framework === o.id)?.installed)?.id ?? "claude-code");
                        const patch = patchForTier1(nextFw, { provider: agent.provider, model }, PROVIDER_DEFAULT_MODEL);
                        setModel(patch.model); setCustomModel(false);
                        update(agent.id, m === "sub" ? { ...patch, claudeCodeUseApiKey: false } : patch);
                      }}
                      className={`flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                        active ? "border-accent bg-accent/10 text-accent" : "border-border bg-bg-hover text-text-secondary hover:border-text-muted"
                      } ${readOnly ? "cursor-default" : "cursor-pointer"}`}>
                      {mLabel}
                    </button>
                  );
                })}
              </div>
              {isLegacyFramework && (
                <div className="mb-2 flex items-start gap-1.5 text-[10px] text-amber leading-snug">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span>{t('agent.exec.legacyRetired', { fw: currentFramework })}</span>
                </div>
              )}
              {/* 第二级(订阅分支):具体订阅引擎，共五家。 */}
              {isCli && (
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => void refreshFrameworks().catch(() => {})}
                    disabled={frameworksRefreshing}
                    title={t('api.cli.refresh')}
                    className="inline-flex items-center gap-1 text-[10px] text-text-muted hover:text-text-primary bg-transparent border-none cursor-pointer disabled:opacity-50"
                  >
                    <RefreshCw size={11} className={frameworksRefreshing ? "animate-spin" : ""} />
                    {t('api.cli.refresh')}
                  </button>
                </div>
                {SUBSCRIPTION_TIER1.map(opt => {
                  const av = frameworks.find(f => f.framework === opt.id);
                  const ready = !!(av?.installed && av?.loggedIn);
                  const hint = av && !ready ? (av.installed ? t('agent.exec.installedNotLoggedIn') : t('agent.exec.notInstalled')) : (av?.version || "");
                  const selected = currentFramework === opt.id;
                  return (
                    <button key={opt.id}
                      disabled={readOnly}
                      onClick={() => {
                        if (readOnly || selected) return;
                        const patch = patchForTier1(opt.id, { provider: agent.provider, model }, PROVIDER_DEFAULT_MODEL);
                        setModel(patch.model); setCustomModel(false);
                        update(agent.id, { ...patch, claudeCodeUseApiKey: false });
                      }}
                      title={av?.detail || hint}
                      className={`flex items-center gap-2 px-3 py-2 rounded-xl text-[13px] text-left transition-colors border min-w-0 overflow-hidden ${
                        selected ? "border-accent bg-accent/10 text-accent" : "border-border bg-bg-hover text-text-secondary hover:border-text-muted"
                      } ${readOnly ? "cursor-default" : "cursor-pointer"}`}>
                      <span className="shrink-0 w-5 h-5 rounded-md text-[10px] font-bold text-white flex items-center justify-center"
                        style={{ backgroundColor: SUBSCRIPTION_BRAND[opt.id as SubscriptionFramework].bg }}>{SUBSCRIPTION_BRAND[opt.id as SubscriptionFramework].mono}</span>
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: dotColor(av) }} />
                      <span className="font-medium shrink-0">{t(opt.labelKey)}</span>
                      {hint && <span className="text-[10px] text-text-muted ml-auto truncate min-w-0" title={av?.detail || hint}>{shortVersion(hint)}</span>}
                      {!av?.installed && (
                        <span role="button"
                          onClick={(e) => { e.stopPropagation(); if (!installing) void startInstall(opt.id as SubscriptionFramework); }}
                          className={`ml-1.5 shrink-0 px-2 py-0.5 rounded-md text-[10px] border transition-colors ${installing ? "border-border text-text-muted cursor-default" : "border-accent text-accent hover:bg-accent/10 cursor-pointer"}`}>
                          {installing === opt.id ? t('agent.install.btnRunning') : t('agent.install.btn')}
                        </span>
                      )}
                      {selected && <Check size={14} className="ml-1.5 shrink-0" />}
                    </button>
                  );
                })}
              </div>
              )}
              {isCli && installMsg && <div className="mt-1.5 text-[10px] text-text-muted leading-snug">{installMsg}</div>}
              {isCli && (() => {
                const av = frameworks.find(f => f.framework === currentFramework);
                return av?.installed && !av.loggedIn ? (
                  <div className="mt-1.5 flex items-start gap-1.5 text-[10px] text-amber leading-snug">
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                    <span>{t('agent.install.loginHint', { cmd: LOGIN_CMD[currentFramework as SubscriptionFramework] })}</span>
                  </div>
                ) : null;
              })()}
              {/* 已知限制/风险(framework 专属)——保留但收敛为单条,去掉每节点重复的通用免责噪音。 */}
              {tier1Option?.warningKey && (
                <div className="mt-2 flex items-start gap-1.5 text-[11px] text-amber leading-snug">
                  <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                  <span>{t(tier1Option.warningKey)}</span>
                </div>
              )}
              {/* 用户定稿(2026-07-10):订阅就是订阅——选定订阅引擎后不再提供"API Key"认证切换,
                  多订阅账号并用的接口暂不做;API 需求走第一级"API"分支。切到订阅时强制
                  claudeCodeUseApiKey:false,存量开过该开关的员工不悄悄走 key。 */}
            </div>

            {/* 第二级：CLI 订阅只有模型别名，没有"供应商"下拉；API 面才有供应商 */}
            <NativeExecutionPreferenceControl
              scope="agent"
              framework={currentFramework}
              value={agent.nativeExecution}
              inheritedValue={companyNativeExecution}
              onChange={async (nativeExecution) => { await update(agent.id, { nativeExecution }); }}
            />

            {isCli ? (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="text-[12px] text-text-muted">{t('agent.model.cliAliasLabel')}</label>
                  <div className="flex items-center gap-1.5 min-w-0">
                    {currentCatalogEntry?.refreshedAt && <span className="text-[9px] text-text-muted truncate">{new Date(currentCatalogEntry.refreshedAt).toLocaleString()}</span>}
                    {canRefreshSubscriptionCatalog(currentFramework as SubscriptionFramework) && <button type="button" onClick={refreshCurrentModels} disabled={catalogRefreshing}
                      title={t('subscription.refreshModels')}
                      className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">
                      <RefreshCw size={11} className={catalogRefreshing ? "animate-spin" : ""} />
                    </button>}
                  </div>
                </div>
                <select value={customModel ? "__custom__" : model}
                  disabled={readOnly}
                  onChange={e => {
                    if (e.target.value === "__custom__") { setCustomModel(true); return; }
                    setCustomModel(false); setModel(e.target.value); update(agent.id, { model: e.target.value });
                  }}
                  className="border border-border rounded-lg bg-bg-card text-[13px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary disabled:opacity-60 disabled:cursor-default cursor-pointer">
                  {models.map(m => <option key={m} value={m}>{m}</option>)}
                  {!models.includes(model) && model && <option value={model}>{model}</option>}
                  <option value="__custom__">{t('agent.model.custom')}</option>
                </select>
                {customModel && (
                  <input value={model} onChange={e => setModel(e.target.value)} autoFocus placeholder={t('agent.model.cliCustomPlaceholder')}
                    readOnly={readOnly}
                    onBlur={() => { if (readOnly || model === agent.model) return; update(agent.id, { model: model.trim() }); }}
                    onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                    className="mt-2 border-0 border-b-2 border-border bg-transparent text-sm py-1.5 w-full outline-none focus:border-accent transition-colors" />
                )}
                {catalogWarning}
                {catalogRefreshError && <div className="mt-1.5 text-[10px] text-red leading-snug">{catalogRefreshError}</div>}
              </div>
            ) : (
              <>
                <div>
                  <label className="block text-[12px] text-text-muted mb-1.5">{t('agent.exec.provider')}</label>
                  <select value={agent.provider}
                    disabled={readOnly}
                    onChange={e => {
                      const p = e.target.value;
                      const dm = PROVIDER_DEFAULT_MODEL[p];
                      // Bug 修复(2026-07 · 12+1 框架扩展):以前这里硬编码 API 面的 framework 值——在只有
                      // API 面能落进这个"供应商+模型"分支时无害,但现在 gemini-cli 等 9 个新框架也走这个
                      // 分支，硬编码会在用户只是切供应商时把 framework 悄悄拉回 API 面。
                      // 不显式改 framework，保留 currentFramework 不动。
                      const patch: Partial<AgentNodeConfig> = { provider: p };
                      if (dm) { patch.model = dm; setModel(dm); setCustomModel(false); } // 模型跟随供应商默认,保持同步
                      update(agent.id, patch);
                    }}
                    className="border border-border rounded-lg bg-bg-card text-[13px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary disabled:opacity-60 disabled:cursor-default cursor-pointer">
                    {providerIdsFinal.map(p => <option key={p} value={p}>{p}{configuredFinal.has(p) ? ` ${t('agent.exec.configuredSuffix')}` : ""}</option>)}
                  </select>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <label className="text-[12px] text-text-muted">{t('agent.model.label')}</label>
                    <div className="flex items-center gap-1.5 min-w-0">
                      {currentCatalogEntry?.refreshedAt && <span className="text-[9px] text-text-muted truncate">{new Date(currentCatalogEntry.refreshedAt).toLocaleString()}</span>}
                      <button type="button" onClick={refreshCurrentModels} disabled={catalogRefreshing}
                        title={t('api.refreshModels')}
                        className="w-6 h-6 shrink-0 flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">
                        <RefreshCw size={11} className={catalogRefreshing ? "animate-spin" : ""} />
                      </button>
                    </div>
                  </div>
                  <select value={customModel ? "__custom__" : model}
                    disabled={readOnly}
                    onChange={e => {
                      if (e.target.value === "__custom__") { setCustomModel(true); return; }
                      setCustomModel(false); setModel(e.target.value); update(agent.id, { model: e.target.value });
                    }}
                    className="border border-border rounded-lg bg-bg-card text-[13px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary disabled:opacity-60 disabled:cursor-default cursor-pointer">
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                    {!models.includes(model) && model && <option value={model}>{model}</option>}
                    <option value="__custom__">{t('agent.model.custom')}</option>
                  </select>
                  {customModel && (
                    <input value={model} onChange={e => setModel(e.target.value)} autoFocus placeholder={t('agent.model.customPlaceholder')}
                      readOnly={readOnly}
                      onBlur={() => { if (readOnly || model === agent.model) return; update(agent.id, { model: model.trim() }); }}
                      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                      className="mt-2 border-0 border-b-2 border-border bg-transparent text-sm py-1.5 w-full outline-none focus:border-accent transition-colors" />
                  )}
                  {catalogWarning}
                  {catalogRefreshError && <div className="mt-1.5 text-[10px] text-red leading-snug">{catalogRefreshError}</div>}
                </div>
              </>
            )}

            {/* 订阅账号:默认由账号池选择；也可钉住具体隔离账号。GLM Coding Plan 账号挂在
                claude-code 下，但 provider 为 z-ai，选择后仍由 Claude Code ACP 执行。 */}
            {isCli && (() => {
              const fw = currentFramework as SubscriptionFramework;
              const allowedProviders = CLI_FRAMEWORK_ACCOUNT_PROVIDERS[fw];
              const subAccounts = accounts.filter(a =>
                allowedProviders.includes(a.providerId)
                && (a.frameworks ?? []).some(accountFramework => accountFramework === currentFramework)
                && !!a.configDir
                && (!a.hasApiKey || a.providerId === "z-ai")
              );
              return (
                <div>
                  <label className="block text-[12px] text-text-muted mb-1.5">{t('agent.account.label')}</label>
                  <select value={agent.cliConfigDir ?? ""} disabled={readOnly}
                    onChange={e => {
                      const selected = subAccounts.find(account => account.configDir === e.target.value);
                      update(agent.id, {
                        cliConfigDir: e.target.value || undefined,
                        provider: selected?.providerId ?? CLI_FRAMEWORK_PROVIDER[fw],
                      });
                    }}
                    className="border border-border rounded-lg bg-bg-card text-[13px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary disabled:opacity-60 disabled:cursor-default cursor-pointer">
                    <option value="">{t('agent.account.auto')}</option>
                    {subAccounts.map(a => <option key={a.id} value={a.configDir}>{a.providerId === "z-ai" ? `GLM · ${a.label}` : a.label}</option>)}
                  </select>
                  {currentFramework === "claude-code" && agent.provider === "z-ai" && (
                    <div className="mt-1.5 text-[10px] leading-snug text-text-muted">
                      GLM Coding Plan 作为 Claude Code 后端使用；执行协议仍为 Claude Code ACP。
                    </div>
                  )}
                </div>
              );
            })()}

            {/* 订阅推理档位仅在真实支持时开放；Gemini/Kimi/Grok 当前保持禁用，不伪造能力。 */}
            {isCli && (() => {
              const effortSupported = frameworkSupportsEffort(currentFramework);
              const current = agent.reasoningEffort;
              return (
                <div>
                  <label className="block text-[12px] text-text-muted mb-1.5">{t('agent.effort.label')}</label>
                  <div className="flex gap-1.5">
                    {REASONING_EFFORTS.map(e => {
                      const active = current === e;
                      const disabled = readOnly || !effortSupported;
                      return (
                        <button key={e} type="button" disabled={disabled}
                          aria-pressed={active}
                          onClick={() => { if (disabled || active) return; update(agent.id, { reasoningEffort: e }); }}
                          title={effortSupported ? undefined : t('agent.effort.unsupported', { engine: currentFramework })}
                          className={`flex-1 px-2 py-1.5 rounded-lg text-[12px] font-medium border transition-colors ${
                            active ? "border-accent bg-accent/10 text-accent" : "border-border bg-bg-hover text-text-secondary hover:border-text-muted"
                          } ${disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}>
                          {t(`agent.effort.${e}`)}
                        </button>
                      );
                    })}
                  </div>
                  {!effortSupported && (
                    <div className="text-[11px] text-text-muted mt-1.5">{t('agent.effort.unsupported', { engine: currentFramework })}</div>
                  )}
                </div>
              );
            })()}

            {/* generic-cli(自定义 CLI)专属:command + 参数模板。12+1 框架扩展新增——GenericCliEngine
                没有内置 preset 时读这份配置现拼调用(见 apps/server/runtime/engines/GenericCliEngine.ts)。 */}
            {currentFramework === "generic-cli" && (
              <div>
                <label className="block text-[12px] text-text-muted mb-1.5">自定义 CLI 配置</label>
                <input
                  defaultValue={agent.genericCli?.command ?? ""}
                  placeholder="可执行文件名,如 mytool(需在 PATH 上)"
                  readOnly={readOnly}
                  onBlur={(e) => {
                    if (readOnly) return;
                    const v = e.target.value.trim();
                    if (v === (agent.genericCli?.command ?? "")) return;
                    update(agent.id, { genericCli: { command: v, args: agent.genericCli?.args ?? [], authEnvVar: agent.genericCli?.authEnvVar } });
                  }}
                  className="border border-border rounded-lg bg-bg-card text-[12px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary font-mono disabled:opacity-60 mb-1.5"
                />
                <textarea
                  defaultValue={(agent.genericCli?.args ?? []).join("\n")}
                  placeholder={"每行一个参数,如:\nrun\n--input\n{{PROMPT}}\n--json"}
                  readOnly={readOnly}
                  rows={4}
                  onBlur={(e) => {
                    if (readOnly) return;
                    const args = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
                    update(agent.id, { genericCli: { command: agent.genericCli?.command ?? "", args, authEnvVar: agent.genericCli?.authEnvVar } });
                  }}
                  className="border border-border rounded-lg bg-bg-card text-[12px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary font-mono disabled:opacity-60 resize-y mb-1.5"
                />
                <input
                  defaultValue={agent.genericCli?.authEnvVar ?? ""}
                  placeholder="可选:认证环境变量名(如 MYTOOL_API_KEY),留空则不注入密钥"
                  readOnly={readOnly}
                  onBlur={(e) => {
                    if (readOnly) return;
                    const v = e.target.value.trim();
                    update(agent.id, { genericCli: { command: agent.genericCli?.command ?? "", args: agent.genericCli?.args ?? [], authEnvVar: v || undefined } });
                  }}
                  className="border border-border rounded-lg bg-bg-card text-[12px] py-1.5 px-2 w-full outline-none focus:border-accent transition-colors text-text-primary font-mono disabled:opacity-60"
                />
                <div className="text-[10px] text-text-muted mt-1.5 leading-snug">
                  参数里含字面量 <code>{"{{PROMPT}}"}</code> 的项会被替换成实际 prompt;一个都不含时 prompt 会追加到参数末尾。
                  上面「供应商」下拉决定 API Key 从哪个已配置账号取(经 <code>{"${PROVIDER}_API_KEY"}</code> 同款解析链),再注入到这里填的认证环境变量名下。
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* Token usage */}
        <div className="mb-5">
          <div className="text-[13px] font-semibold text-text-secondary mb-3">累计用量（全历史）</div>
          <div className="grid grid-cols-1 gap-3">
            <div className="bg-bg-hover rounded-xl p-3">
              <div className="text-[10px] text-text-muted uppercase tracking-wide mb-1">Tokens</div>
              <div className="text-lg font-semibold tracking-tight text-text-primary">
                {totalTokens >= 1000 ? `${(totalTokens / 1000).toFixed(1)}k` : totalTokens}
              </div>
              <div className="flex gap-2 mt-1 text-[10px] text-text-muted">
                <span>入 {agent.tokenUsage.prompt.toLocaleString()}</span>
                <span>出 {agent.tokenUsage.completion.toLocaleString()}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* Test Connection */}
        <div className="mb-5">
          <div className="text-[13px] font-semibold text-text-secondary mb-3">连接测试</div>
          <button onClick={handleTest} disabled={testing}
            className="px-4 py-1.5 border border-accent/30 rounded-xl bg-accent/10 text-accent cursor-pointer text-xs font-medium hover:bg-accent/20 disabled:opacity-60 disabled:cursor-default transition-colors">
            {testing ? "测试中..." : "测试连接"}
          </button>
          {testResult && (
            <div className={`mt-2 p-2.5 rounded-xl text-xs border ${testResult.ok ? "bg-green/10 border-green/20" : "bg-red/10 border-red/20"}`}>
              {testResult.ok ? (
                <div>
                  <div className="text-green font-semibold">连接成功</div>
                  <div className="text-green/80 text-[11px] mt-1">
                    响应: {testResult.response} | {testResult.tokens} tokens | {testResult.latencyMs}ms
                  </div>
                </div>
              ) : (
                <div>
                  <div className="text-red font-semibold">连接失败</div>
                  <div className="text-red/80 text-[11px] mt-1">
                    {testResult.error || `HTTP ${testResult.status}`}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* Current Work */}
        <div className="mb-5">
          <div className="text-[13px] font-semibold text-text-secondary mb-3">当前工作</div>
          <div className="mb-2">
            <label className="block text-[11px] text-text-muted mb-0.5">当前任务</label>
            <div className="text-[13px] text-text-primary break-words">{cleanText(agent.currentTask) || "(无)"}</div>
          </div>
          <div>
            <label className="block text-[11px] text-text-muted mb-0.5">最后操作</label>
            <div className="text-[13px] text-text-primary break-words">{cleanText(agent.lastAction) || "(无)"}</div>
          </div>
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* Recent Runs */}
        <div>
          <div className="text-[13px] font-semibold text-text-secondary mb-3">最近运行</div>
          {loadingRuns ? (
            <div className="text-xs text-text-muted">加载中...</div>
          ) : runs.length === 0 ? (
            <div className="text-xs text-text-muted">暂无运行记录</div>
          ) : (
            <div className="flex flex-col gap-2">
              {runs.map((run, i) => (
                <button
                  type="button"
                  key={run.id || i}
                  disabled={!run.id}
                  onClick={() => run.id && openRun(run.id)}
                  title={run.id ? t('memory.viewRun') : undefined}
                  className="group w-full p-2.5 bg-bg-hover hover:bg-bg-card rounded-xl border border-transparent hover:border-border text-left cursor-pointer disabled:cursor-default transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-text-primary mb-1.5">
                        {run.goal?.slice(0, 60) || "(no description)"}
                      </div>
                      <div className="flex gap-3 text-[11px] text-text-muted">
                        <span className={run.status === "done" ? "text-green" : run.status === "failed" ? "text-red" : "text-amber"}>
                          {run.status}
                        </span>
                        <span>{run.totalTokens?.toLocaleString()} tokens</span>
                      </div>
                    </div>
                    <ExternalLink size={12} className="mt-0.5 shrink-0 text-text-muted group-hover:text-accent" />
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="h-px bg-bg-hover my-5" />

        {/* 记忆(Memory Pack):部门/公司/个人记忆 + 失败反思教训(从失败里学的、注入过几次、可撤销) */}
        <div>
          <div className="text-[13px] font-semibold text-text-secondary mb-3">🧠 记忆</div>
          <MemoryLessons agentId={agent.id} role={agent.role} companyId={agent.companyId} />
        </div>
      </div>
    </div>
  );
}
