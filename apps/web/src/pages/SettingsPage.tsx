import { useState, useEffect, useCallback, useRef } from "react";
import * as api from "../api/client.js";
import { useT } from "../i18n.js";
import GithubLogin from "../components/GithubLogin.js";
import EngineSetupPanel from "../components/setup/EngineSetupPanel.js";
import { pushToast } from "../components/common/Toast.js";
import type { ProjectConfig, AgentFramework } from "@opc/shared";
import ArchiveManager from "../components/archive/ArchiveManager.js";
import HelpTip from "../components/HelpTip.js";
import InfoDisclosure from "../components/common/InfoDisclosure.js";
import {
  ArrowLeft, SlidersHorizontal, ShieldCheck, Lock, Info, Wrench, Archive,
  Check, ExternalLink, AlertTriangle, type LucideIcon,
} from "lucide-react";
import {
  defaultFrameworkFor, isSubscriptionFramework, sortConfiguredFirst,
  SUBSCRIPTION_TIER1, SUBSCRIPTION_BRAND, patchForTier1, PROVIDER_DEFAULT_MODEL,
  CLI_MODEL_ALIASES, FRAMEWORK_TO_CATALOG_ENGINE, isModelOutsideCatalog,
  API_FRAMEWORK, isApiFramework,
  type SubscriptionFramework,
} from "../lib/framework.js";


const VERSION = "0.1.0";
const HOMEPAGE_URL = "https://opc-studio.dev";
const DOWNLOAD_URL = "https://opc-studio.dev/download";

type TabKey = "general" | "permissions" | "auth" | "env" | "archive" | "about";

const TABS: { key: TabKey; icon: LucideIcon }[] = [
  { key: "general", icon: SlidersHorizontal },
  { key: "permissions", icon: ShieldCheck },
  { key: "auth", icon: Lock },
  { key: "env", icon: Wrench },
  { key: "archive", icon: Archive },
  { key: "about", icon: Info },
];

/* ────────── Shared UI ────────── */

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border-none cursor-pointer transition-colors duration-200 ${
        on ? "bg-accent" : "bg-surface-2 border border-hairline"
      }`}
    >
      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform duration-200 ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

// 信息密度瘦身:常驻说明段落收起——短提示用 HelpTip(悬停/点问号才出),长说明(多句/含机制或
// 注意事项)用 InfoDisclosure(行内「说明 ▸」折叠,默认收起)。两者都不再占用常驻版面。
function Field({ title, hint, longHint, children }: { title: string; hint?: string; longHint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="flex items-center gap-1.5 text-[14px] font-semibold text-ink">
        {title}
        {hint && <HelpTip text={hint} />}
      </label>
      {longHint && <InfoDisclosure className="mt-1">{longHint}</InfoDisclosure>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

// 系统模型三级选择器(与员工面板同构):第一级 订阅/API;第二级 三家订阅引擎 或 API 供应商;
// 第三级 模型只出目录(/api/model-catalog 单一事实源)。存储结构 {framework, provider, model},
// 旧值(无 framework)按 defaultFrameworkFor 推断落进正确的第一级分组。
type SystemModelValue = { framework?: string; provider: string; model: string };

function SystemModelSelector({ label, value, catalog, configured, onChange }: {
  label?: string;
  value: SystemModelValue;
  catalog: api.ModelCatalog | null;
  configured: Set<string>;
  onChange: (v: { framework: string; provider: string; model: string }) => void;
}) {
  const t = useT();
  const currentFramework: AgentFramework = value.framework
    ? (value.framework as AgentFramework)
    : defaultFrameworkFor(value.provider, value.model);
  const isCli = isSubscriptionFramework(currentFramework);
  const [customModel, setCustomModel] = useState(false);
  const [draftModel, setDraftModel] = useState(value.model);
  useEffect(() => { setDraftModel(value.model); }, [value.model]);

  // 第三级模型来源:订阅→目录订阅段(未到位回退 CLI 别名);API→目录该供应商 builtin 模型。
  const models: string[] = (() => {
    if (isCli) {
      const engineId = FRAMEWORK_TO_CATALOG_ENGINE[currentFramework as SubscriptionFramework];
      const fromCat = catalog?.subscriptions.find(s => s.engine === engineId)?.models.map(m => m.id) ?? [];
      return fromCat.length ? fromCat : CLI_MODEL_ALIASES[currentFramework as SubscriptionFramework];
    }
    return catalog?.apiProviders.find(p => p.provider === value.provider)?.models.map(m => m.id) ?? [];
  })();
  const notInCatalog = isModelOutsideCatalog(models, value.model);

  // 第二级(API)供应商列表:目录 hasKey 优先排前,并去重加上当前值。
  const providerOptions = catalog
    ? sortConfiguredFirst([...catalog.apiProviders.map(p => p.provider), value.provider], configured)
    : [value.provider];

  const emit = (patch: { framework: AgentFramework; provider: string; model: string }) => {
    setCustomModel(false);
    onChange(patch);
  };

  return (
    <div>
      {label && <div className="text-[12px] font-medium text-ink mb-2">{label}</div>}

      {/* 第一级:订阅 / API */}
      <div className="flex gap-1.5 mb-2">
        {([["sub", t("settings.systemModel.subscription")], ["api", t("settings.systemModel.api")]] as const).map(([m, mLabel]) => {
          const active = m === "sub" ? isCli : isApiFramework(currentFramework);
          return (
            <button key={m} type="button"
              onClick={() => {
                if (active) return;
                const nextFw: AgentFramework = m === "api"
                  ? API_FRAMEWORK
                  : (SUBSCRIPTION_TIER1.find(o => catalog?.subscriptions.find(s => s.engine === FRAMEWORK_TO_CATALOG_ENGINE[o.id as SubscriptionFramework] && s.installed))?.id ?? "claude-code");
                emit(patchForTier1(nextFw, { provider: value.provider, model: value.model }, PROVIDER_DEFAULT_MODEL));
              }}
              className={`flex-1 px-3 py-1.5 rounded-full text-[12px] font-medium border cursor-pointer transition-colors ${
                active ? "border-accent bg-accent/10 text-accent" : "border-hairline bg-surface-1 text-ink-muted hover:border-ink-subtle"
              }`}>
              {mLabel}
            </button>
          );
        })}
      </div>

      {/* 第二级(订阅):三家订阅引擎 */}
      {isCli && (
        <div className="flex flex-col gap-1.5 mb-2">
          {SUBSCRIPTION_TIER1.map(opt => {
            const sub = catalog?.subscriptions.find(s => s.engine === FRAMEWORK_TO_CATALOG_ENGINE[opt.id as SubscriptionFramework]);
            const selected = currentFramework === opt.id;
            const brand = SUBSCRIPTION_BRAND[opt.id as SubscriptionFramework];
            return (
              <button key={opt.id} type="button"
                onClick={() => { if (!selected) emit(patchForTier1(opt.id, { provider: value.provider, model: value.model }, PROVIDER_DEFAULT_MODEL)); }}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] text-left border transition-colors ${
                  selected ? "border-accent bg-accent/10 text-accent" : "border-hairline bg-surface-1 text-ink-muted hover:border-ink-subtle"
                }`}>
                <span className="shrink-0 w-5 h-5 rounded-md text-[10px] font-bold text-white flex items-center justify-center"
                  style={{ backgroundColor: brand.bg }}>{brand.mono}</span>
                <span className="font-medium">{t(opt.labelKey)}</span>
                {sub && <span className="ml-auto text-[10px] text-ink-subtle shrink-0">{sub.installed ? (sub.source === "acp" ? t("settings.systemModel.connected") : t("settings.systemModel.installed")) : t("settings.systemModel.notInstalled")}</span>}
                {selected && <Check size={14} className={sub ? "ml-1.5 shrink-0" : "ml-auto shrink-0"} />}
              </button>
            );
          })}
        </div>
      )}

      {/* 第二级(API):供应商下拉(✓=已配置 key) */}
      {!isCli && (
        <div className="mb-2">
          <div className="text-[11px] text-ink-muted mb-1">{t("settings.systemModel.provider")}</div>
          <select value={value.provider}
            onChange={e => {
              const p = e.target.value;
              emit({ framework: API_FRAMEWORK, provider: p, model: PROVIDER_DEFAULT_MODEL[p] || value.model });
            }}
            className="input-field w-full">
            {providerOptions.map(p => <option key={p} value={p}>{p}{configured.has(p) ? " ✓" : ""}</option>)}
          </select>
        </div>
      )}

      {/* 第三级:模型(只出目录 + 自定义手输) */}
      <div>
        <div className="text-[11px] text-ink-muted mb-1">{t("settings.systemModel.model")}</div>
        <select value={customModel ? "__custom__" : value.model}
          onChange={e => {
            if (e.target.value === "__custom__") { setDraftModel(value.model); setCustomModel(true); return; }
            onChange({ framework: currentFramework, provider: value.provider, model: e.target.value });
          }}
          className="input-field w-full">
          {models.map(m => <option key={m} value={m}>{m}</option>)}
          {value.model && !models.includes(value.model) && <option value={value.model}>{value.model}</option>}
          <option value="__custom__">{t("settings.systemModel.custom")}</option>
        </select>
        {customModel && (
          <input value={draftModel} autoFocus placeholder={t("settings.systemModel.modelPlaceholder")}
            onChange={e => setDraftModel(e.target.value)}
            onBlur={() => { const v = draftModel.trim(); setCustomModel(false); if (v && v !== value.model) onChange({ framework: currentFramework, provider: value.provider, model: v }); }}
            onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
            className="input-field w-full mt-2" />
        )}
        {notInCatalog && (
          <div className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber leading-snug">
            <AlertTriangle size={12} className="shrink-0 mt-0.5" />
            <span>{t("agent.model.notInCatalog", { model: value.model })}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ToggleRow({ icon: Icon, title, hint, on, onChange }: {
  icon: LucideIcon; title: string; hint?: string; on: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3.5 rounded-lg border border-hairline bg-surface-1">
      <div className="flex items-center gap-3 min-w-0">
        <Icon size={18} className="text-ink-subtle shrink-0" />
        <div className="min-w-0 flex items-center gap-1.5">
          <div className="text-[14px] font-medium text-ink">{title}</div>
          {hint && <HelpTip text={hint} />}
        </div>
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

/* ────────── Page ────────── */

export default function SettingsPage({ onClose }: {
  onClose: () => void;
}) {
  const t = useT();
  const TAB_LABELS: Record<TabKey, string> = {
    general: t("settings.tab.general"),
    permissions: t("settings.tab.permissions"),
    auth: t("settings.tab.auth"),
    env: t("settings.tab.env"),
    archive: t("settings.tab.archive"),
    about: t("settings.tab.about"),
  };
  const [tab, setTab] = useState<TabKey>("general");
  const [config, setConfig] = useState<ProjectConfig | null>(null);
  const [catalog, setCatalog] = useState<api.ModelCatalog | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Font size (frontend-local, real: sets root font-size)
  const [fontSize, setFontSizeState] = useState<number>(() => {
    try { const v = parseInt(localStorage.getItem("opc-font-size") || ""); if (v >= 12 && v <= 16) return v; } catch {}
    return 14;
  });
  const setFontSize = (v: number) => {
    setFontSizeState(v);
    try { localStorage.setItem("opc-font-size", String(v)); } catch {}
    document.documentElement.style.fontSize = `${v}px`;
  };

  const [autoCheck, setAutoCheck] = useState(() => {
    try { return localStorage.getItem("opc-auto-update") !== "false"; } catch { return true; }
  });
  const setAutoCheckFn = (v: boolean) => {
    setAutoCheck(v);
    try { localStorage.setItem("opc-auto-update", String(v)); } catch {}
  };

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [updateKind, setUpdateKind] = useState<"upToDate" | "newVersion" | "failed" | null>(null);

  useEffect(() => { api.get<ProjectConfig>("/config").then(setConfig).catch(() => {}); }, []);
  // 三级模型目录(单一事实源):系统模型选择器的第二级供应商 hasKey、第三级模型都以它为准。
  // 服务端 ACP 握手有 1.2s 软时限,冷缓存首拉可能是 static 兜底——10 秒后重取一次换活值。
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = (retryOnStale: boolean) => {
      api.getModelCatalog().then(c => {
        if (!alive) return;
        setCatalog(c);
        if (retryOnStale && c.subscriptions.some(s => s.installed && s.source === "static")) timer = setTimeout(() => load(false), 10_000);
      }).catch(() => {
        if (!alive) return;
        setCatalog(null);
        if (retryOnStale) timer = setTimeout(() => load(false), 10_000);
      });
    };
    load(true);
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, []);
  // 第二级(API)"已配置"标记:目录 hasKey(env>keys文件>config 全链解析)。
  const configuredProviders = catalog
    ? new Set(catalog.apiProviders.filter(p => p.hasKey).map(p => p.provider))
    : new Set<string>();
  const defaultModelValue: SystemModelValue | null = config ? (
    config.systemModel?.default
    ?? config.systemModel?.creative
    ?? config.systemModel?.judge
    ?? {
      model: config.defaultModel,
      provider: catalog?.apiProviders.find(p => p.models.some(m => m.id === config.defaultModel))?.provider
        ?? [...configuredProviders][0]
        ?? "deepseek",
    }
  ) : null;

  const flashSaved = useCallback(() => {
    setSavedFlash(true);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setSavedFlash(false), 1400);
  }, []);

  // Update local state immediately (responsive UI); debounce the disk write so typing a
  // key / number doesn't POST + flash on every keystroke.
  const save = useCallback((patch: Partial<ProjectConfig>) => {
    setConfig(prev => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        api.post("/config", next).then(flashSaved).catch(() => {});
      }, 400);
      return next;
    });
  }, [flashSaved]);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateMsg(null);
    setUpdateKind(null);
    try {
      const resp = await fetch(`${HOMEPAGE_URL}/version.json`);
      if (!resp.ok) throw new Error("HTTP " + resp.status);
      const data = await resp.json();
      if (data.version && data.version !== VERSION) {
        setUpdateKind("newVersion");
        setUpdateMsg(t("settings.about.newVersionAvailable", { version: data.version }));
      } else {
        setUpdateKind("upToDate");
        setUpdateMsg(t("settings.about.upToDate"));
      }
    } catch {
      setUpdateKind("failed");
      setUpdateMsg(t("settings.about.checkFailed"));
    } finally {
      setCheckingUpdate(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-canvas flex flex-col">
      {/* Header */}
      <div className="h-14 shrink-0 px-6 border-b border-hairline">
        <div className="h-full flex items-center gap-3 max-w-3xl mx-auto">
          <button
            onClick={onClose}
            title={t("common.back")}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-hairline bg-surface-1 text-ink-muted cursor-pointer hover:bg-surface-2 hover:text-ink transition-colors"
          >
            <ArrowLeft size={16} />
          </button>
          <span className="text-[16px] font-semibold text-ink tracking-tight">{t("nav.settings")}</span>
          <div className="flex-1" />
          <span className={`flex items-center gap-1.5 text-[12px] text-success transition-opacity duration-200 ${savedFlash ? "opacity-100" : "opacity-0"}`}>
            <Check size={13} /> {t("settings.saved")}
          </span>
        </div>
      </div>

      {/* Tab bar */}
      <div className="shrink-0 px-6 pt-4">
        <div className="flex gap-0.5 p-0.5 rounded-full bg-surface-2 max-w-3xl mx-auto">
          {TABS.map(item => {
            const Icon = item.icon;
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 h-8 rounded-full border-none cursor-pointer text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                }`}
              >
                <Icon size={14} />
                <span>{TAB_LABELS[item.key]}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto px-6 py-8">
        <div className="max-w-3xl mx-auto">
          {!config && tab !== "general" && tab !== "about" && tab !== "env" && tab !== "archive" ? (
            <div className="text-ink-muted text-[13px]">{t("settings.loadingConfig")}</div>
          ) : (
            <>
              {tab === "general" && (
                <div className="space-y-8">
                  <Field title={t("settings.fontSize")} hint={t("settings.fontSize.desc").replace("{n}", String(fontSize))}>
                    <input type="range" min={12} max={16} step={1} value={fontSize}
                      onChange={e => setFontSize(parseInt(e.target.value))}
                      className="w-full max-w-xs h-1.5 accent-accent cursor-pointer" />
                    <div className="flex items-center justify-between max-w-xs mt-1">
                      <span className="text-[10px] text-ink-subtle">12px</span>
                      <span className="text-[11px] font-medium text-ink tabular-nums">{fontSize}px</span>
                      <span className="text-[10px] text-ink-subtle">16px</span>
                    </div>
                  </Field>

                  {config && defaultModelValue && (
                    <Field title={t("settings.defaultModel")} longHint={t("settings.defaultModel.desc")}>
                      <div className="max-w-md">
                        <SystemModelSelector
                          value={defaultModelValue}
                          catalog={catalog}
                          configured={configuredProviders}
                          onChange={v => save({ defaultModel: v.model, systemModel: { default: v } })}
                        />
                      </div>
                    </Field>
                  )}

                  <ToggleRow icon={Info} title={t("settings.autoUpdate")}
                    hint={t("settings.autoUpdate.desc")}
                    on={autoCheck} onChange={setAutoCheckFn} />
                </div>
              )}

              {tab === "permissions" && config && (
                <div className="space-y-3">
                  <ToggleRow icon={ShieldCheck} title={t("settings.perm.shell")}
                    hint={t("settings.perm.shell.desc")}
                    on={config.permissions.allowShell}
                    onChange={v => save({ permissions: { ...config.permissions, allowShell: v } })} />
                  <ToggleRow icon={ShieldCheck} title={t("settings.perm.fileWrite")}
                    hint={t("settings.perm.fileWrite.desc")}
                    on={config.permissions.allowFileWrite}
                    onChange={v => save({ permissions: { ...config.permissions, allowFileWrite: v } })} />
                  <ToggleRow icon={ShieldCheck} title={t("settings.perm.webAccess")}
                    hint={t("settings.perm.webAccess.desc")}
                    on={config.permissions.allowWebAccess}
                    onChange={v => save({ permissions: { ...config.permissions, allowWebAccess: v } })} />
                </div>
              )}

              {tab === "auth" && config && (
                <div className="space-y-8">
                  <Field title={t("settings.auth.githubAccount")} longHint={t("settings.auth.githubAccount.desc")}>
                    <GithubLogin />
                  </Field>
                  <Field title={t("settings.auth.githubOauth")} longHint={t("settings.auth.githubOauth.desc")}>
                    <div className="space-y-3 max-w-md">
                      <div>
                        <span className="text-[12px] text-ink-muted">Client ID</span>
                        <input value={config.github?.oauth?.clientId ?? ""}
                          onChange={e => save({ github: { ...config.github, oauth: { clientSecret: config.github?.oauth?.clientSecret ?? "", ...config.github?.oauth, clientId: e.target.value } } })}
                          className="input-field mt-1" placeholder="Ov23li…" />
                      </div>
                      <div>
                        <span className="text-[12px] text-ink-muted">Client Secret</span>
                        <input type="password" autoComplete="off" value={config.github?.oauth?.clientSecret ?? ""}
                          onChange={e => save({ github: { ...config.github, oauth: { clientId: config.github?.oauth?.clientId ?? "", ...config.github?.oauth, clientSecret: e.target.value } } })}
                          className="input-field mt-1" placeholder="••••••••" />
                      </div>
                    </div>
                  </Field>
                </div>
              )}

              {tab === "env" && (
                <div className="space-y-6">
                  <Field title={t("settings.tab.env")}>
                    <EngineSetupPanel onUseApiKeyInstead={() => {
                      pushToast("info", t("setup.apiKeyCard.settingsHint"));
                      onClose();
                    }} />
                  </Field>
                </div>
              )}

              {tab === "archive" && <ArchiveManager />}

              {tab === "about" && (
                <div className="space-y-6">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl bg-accent/15 border border-accent/30 flex items-center justify-center text-accent font-bold text-[18px]">OP</div>
                    <div>
                      <div className="text-[16px] font-semibold text-ink">OPC Studio</div>
                      <div className="text-[13px] text-ink-muted">{t("settings.about.versionLine", { version: VERSION })}</div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <button onClick={handleCheckUpdate} disabled={checkingUpdate} className="btn-primary disabled:opacity-50">
                      {checkingUpdate ? t("settings.about.checking") : t("settings.about.checkUpdate")}
                    </button>
                    {updateMsg && (
                      <span className={`text-[13px] ${updateKind === "failed" ? "text-error" : updateKind === "upToDate" ? "text-success" : "text-accent"}`}>
                        {updateMsg}
                      </span>
                    )}
                  </div>

                  <div className="section-divider" />
                  <Field title={t("settings.about.onboarding")}>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => { window.dispatchEvent(new CustomEvent("open-onboarding")); onClose(); }}
                        className="btn-secondary">{t("settings.about.replayOnboarding")}</button>
                      <button onClick={() => { window.dispatchEvent(new CustomEvent("open-launchpad")); onClose(); }}
                        className="btn-secondary">{t("settings.about.previewLaunchpad")}</button>
                    </div>
                  </Field>
                  <div className="section-divider" />

                  <div className="flex flex-col gap-2">
                    <a href={HOMEPAGE_URL} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-accent transition-colors w-fit">
                      <ExternalLink size={13} /> {t("settings.about.homepage")}
                    </a>
                    <a href={DOWNLOAD_URL} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 text-[13px] text-ink-muted hover:text-accent transition-colors w-fit">
                      <ExternalLink size={13} /> {t("settings.about.downloadLatest")}
                    </a>
                  </div>

                  <div className="text-[12px] text-ink-subtle">{t("settings.about.maintainer", { name: "OPC Team" })}</div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
