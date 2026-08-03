import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { Plug, Star, ArrowLeft, RefreshCw } from "lucide-react";
import ProviderPresetSelector from "../components/ProviderPresetSelector.js";
import ProviderForm from "../components/ProviderForm.js";
import ProviderAdvancedOptions from "../components/ProviderAdvancedOptions.js";
import ProviderJsonEditor from "../components/ProviderJsonEditor.js";
import ProviderTestConfig from "../components/ProviderTestConfig.js";
import CollapsibleSection from "../components/CollapsibleSection.js";
import { ProviderAccountsManager } from "../components/CliApiKeyAccounts.js";
import { useProviderStore } from "../store/useProviderStore.js";
import { useT } from "../i18n.js";
import { confirmDialog } from "../components/common/ConfirmDialog.js";
import * as api from "../api/client.js";
import { DEFAULT_MODELS, DEFAULT_PROVIDER_OPTIONS, DEFAULT_PROVIDER_PERMISSIONS, PRESET_PROVIDERS } from "@opc/shared";
import type { ProviderConfig, ProjectConfig, PublicProviderAccount } from "@opc/shared";

type Tab = "claude" | "unified";
type View = "list" | "add" | "edit";

const API_FORMAT_LABELS: Record<string, string> = {
  openai: "OpenAI", anthropic: "Anthropic", gemini: "Gemini", ollama: "Ollama",
};

const API_FORMAT_COLORS: Record<string, string> = {
  openai: "bg-green/10 text-green", anthropic: "bg-purple/10 text-purple",
  gemini: "bg-accent/10 text-accent", ollama: "bg-amber/10 text-amber", custom: "bg-bg-hover text-text-secondary",
};

// 多账号自动切换(把"添加第二个账号"从 codex 专属扩展到所有供应商):连通性测试用的兜底模型名——
// 大多数供应商没有把 defaultModel 落在 providers.json/PRESET_PROVIDERS 里(尤其是纯走 env/keys 文件
// 配置、从没经过"经典设置表单"的那些),ProviderAccountsManager 需要一个能打通请求的模型名才能测。
// 只是个起点,不是权威值——组件里的模型名输入框可编辑,猜错了用户能自己改。
const DEFAULT_TEST_MODEL: Record<string, string> = {
  deepseek: "deepseek-chat",
  minimax: "MiniMax-M2",
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  doubao: DEFAULT_MODELS.doubao,
  openrouter: "openai/gpt-5-mini",
};

export default function ProviderSettingsPage() {
  const t = useT();
  const formatLabel = (fmt: string) =>
    API_FORMAT_LABELS[fmt] || (fmt === "custom" ? t('api.custom') : fmt);
  const store = useProviderStore();
  const [view, setView] = useState<View>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("unified");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [form, setForm] = useState<Partial<ProviderConfig>>({});
  // Block C:经 env/keys/config 链"已配置"的 provider id(/api/config 掩码回报),让 keys 目录/环境变量配的 provider 也显示为已配置。
  const [configuredKeys, setConfiguredKeys] = useState<Set<string>>(new Set());
  const [catalog, setCatalog] = useState<api.ModelCatalog | null>(null);
  const [refreshingModels, setRefreshingModels] = useState<string | null>(null);
  const [modelRefreshError, setModelRefreshError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { store.load(); }, []);
  useEffect(() => {
    Promise.all([
      api.get<ProjectConfig>("/config").catch(() => ({} as ProjectConfig)),
      api.get<PublicProviderAccount[]>("/accounts").catch(() => []),
      api.getModelCatalog().catch(() => null),
    ]).then(([config, accounts, nextCatalog]) => {
      setCatalog(nextCatalog);
      const ids = new Set(Object.entries(config?.apiKeys ?? {}).filter(([, value]) => !!value).map(([id]) => id));
      for (const account of accounts) if (account.enabled !== false && account.hasApiKey) ids.add(account.providerId);
      for (const provider of nextCatalog?.apiProviders ?? []) if (provider.hasKey) ids.add(provider.provider);
      setConfiguredKeys(ids);
    });
  }, [store.providers.length]);

  const refreshProviderModels = async (providerId: string) => {
    setRefreshingModels(providerId);
    setModelRefreshError(null);
    try {
      await api.refreshModelCatalog("provider", providerId);
      setCatalog(await api.getModelCatalog());
    } catch (e) {
      setModelRefreshError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshingModels(null);
    }
  };

  const startAdd = () => {
    setEditingId(null);
    setSelectedPreset(null);
    setForm({});
    setSaveError(null);
    setView("add");
  };

  const startEdit = (id: string) => {
    const p = store.providers.find(x => x.id === id);
    if (p) {
      setEditingId(id);
      setSelectedPreset(null);
      setForm({ ...p });
      setSaveError(null);
      setTab(p.kind === "claude" ? "claude" : "unified");
      setView("edit");
    }
  };

  const handlePresetSelect = (preset: typeof PRESET_PROVIDERS[number]) => {
    setSelectedPreset(preset.id);
    setForm(prev => ({
      ...prev,
      name: preset.name,
      // Preset is authoritative for link/format — previously `prev.baseUrl || preset.baseUrl`
      // kept a stale URL when switching presets (link no longer matched the chosen provider).
      apiFormat: preset.apiFormat,
      baseUrl: preset.baseUrl,
      website: preset.website,
      kind: preset.kind,
      defaultModel: DEFAULT_MODELS[preset.id],
      models: DEFAULT_MODELS[preset.id] ? [DEFAULT_MODELS[preset.id]] : [],
    }));
  };

  const handleBack = () => { setView("list"); setEditingId(null); setSaveError(null); };

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const now = new Date().toISOString();
    const provider: ProviderConfig = {
      id: editingId || (selectedPreset && selectedPreset !== "custom" ? selectedPreset : crypto.randomUUID()),
      name: form.name || "Unnamed",
      note: form.note,
      website: form.website,
      kind: form.kind || "custom",
      apiFormat: form.apiFormat || "custom",
      baseUrl: form.baseUrl || "",
      apiKey: form.apiKey || "",
      allowLocalNetwork: form.allowLocalNetwork === true,
      defaultModel: form.defaultModel,
      models: form.models || [],
      headers: form.headers || {},
      env: form.env || {},
      options: { ...DEFAULT_PROVIDER_OPTIONS, ...(form.options || {}) },
      permissions: { ...DEFAULT_PROVIDER_PERMISSIONS, ...(form.permissions || {}) },
      pricing: form.pricing,
      test: form.test,
      createdAt: form.createdAt || now,
      updatedAt: now,
    };

    try {
      if (editingId) {
        await store.update(editingId, provider);
      } else {
        await store.create(provider);
      }
      setView("list");
      setEditingId(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSaveError(message);
      console.error("Failed to save provider:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!await confirmDialog({ title: t('api.confirmDelete'), danger: true, confirmLabel: t('common.delete') })) return;
    try {
      await store.remove(id);
    } catch (e) {
      console.error("Failed to delete provider:", e);
    }
  };

  if (view !== "list") {
    return (
      <div className="h-full flex flex-col bg-bg-primary">
        <div className="px-6 py-4 bg-bg-card border-b border-border flex items-center gap-4">
          <button onClick={handleBack} title={t("common.back")}
            className="bg-transparent border-none cursor-pointer text-text-secondary p-0 hover:text-text-primary transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h2 className="m-0 text-lg font-semibold text-text-primary">
            {editingId ? t('api.editProvider') : t('api.addNewProvider')}
          </h2>
        </div>

        <div className="flex-1 overflow-auto p-6">
          <div className="max-w-[720px] mx-auto">
            <div className="inline-flex gap-0.5 p-0.5 rounded-full bg-surface-2 mb-5">
              {([
                { key: "unified" as Tab, label: t('api.unifiedProvider') },
                { key: "claude" as Tab, label: t('api.claudeProvider') },
              ]).map(t => (
                <button key={t.key} onClick={() => setTab(t.key)}
                  className={`px-5 py-2 rounded-full border-none cursor-pointer text-[13px] transition-colors ${
                    tab === t.key ? "bg-surface-1 text-ink shadow-sm font-semibold" : "bg-transparent text-ink-muted hover:text-ink"
                  }`}>
                  {t.label}
                </button>
              ))}
            </div>

            <div className="bg-bg-card rounded-xl p-4 mb-5 border border-border shadow-sm">
              <div className="text-[13px] font-semibold text-text-primary mb-2.5">{t('api.selectPreset')}</div>
              <ProviderPresetSelector selectedId={selectedPreset} onSelect={handlePresetSelect} />
            </div>

            <div className="flex flex-col gap-4">
              <div className="bg-bg-card rounded-xl p-5 border border-border shadow-sm">
                <div className="text-sm font-semibold text-text-primary mb-4">{t('api.basicInfo')}</div>
                <ProviderForm form={form} onChange={patch => setForm(prev => ({ ...prev, ...patch }))} />
              </div>

              <div className="bg-bg-card rounded-xl border border-border shadow-sm">
                <div className="p-5 pb-0">
                  <ProviderAdvancedOptions form={form} onChange={patch => setForm(prev => ({ ...prev, ...patch }))} />
                </div>
              </div>

              <div className="bg-bg-card rounded-xl border border-border shadow-sm">
                <div className="p-5 pb-0">
                  <CollapsibleSection title={t('api.customHeadersEnv')}>
                    <div className="flex flex-col gap-3.5">
                      <ProviderJsonEditor label={t('api.customHeaders')} value={form.headers || {}}
                        onChange={v => setForm(prev => ({ ...prev, headers: v }))} />
                      <ProviderJsonEditor label={t('api.envVars')} value={form.env || {}}
                        onChange={v => setForm(prev => ({ ...prev, env: v }))} />
                    </div>
                  </CollapsibleSection>
                </div>
              </div>

              <div className="bg-bg-card rounded-xl border border-border shadow-sm">
                <div className="p-5 pb-0"><ProviderTestConfig form={form} /></div>
              </div>

            </div>
          </div>
        </div>

        <div className="px-6 py-3 bg-bg-card border-t border-border flex items-center justify-end gap-3">
          {saveError && <div className="mr-auto max-w-[60%] text-[11px] text-red">{saveError}</div>}
          <button onClick={handleBack} className="btn-secondary" title={t('common.cancel')}>{t('common.cancel')}</button>
          <button onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50" title={editingId ? t('common.save') : t('api.add')}>
            {saving ? t('common.save') + "..." : editingId ? t('common.save') : t('api.add')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="px-6 py-4 bg-bg-card border-b border-border flex items-center gap-4">
        <h2 className="m-0 text-lg font-semibold text-text-primary">{t('api.title')}</h2>
        <div className="flex-1" />
        <button onClick={startAdd} title={t('api.addProvider')} className="btn-primary text-[13px] px-4 py-1.5">
          + {t('api.addProvider')}
        </button>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-[960px] mx-auto flex flex-col">
          {modelRefreshError && <div className="mb-3 rounded-md border border-red/20 bg-red/10 px-3 py-2 text-[12px] text-red">{modelRefreshError}</div>}
          {/* 「API 连接」回归纯 API(用户定稿"订阅就是订阅"):CLI 订阅(claude-code/codex/gemini-cli)已移到
              独立的「订阅」板块(SubscriptionPage),此处只管供应商账号 / key。多账号自动切换仍由下方各
              供应商卡内的 ProviderAccountsManager 承载。 */}
          {store.providers.length === 0 && (
            <div className="h-full flex items-center justify-center bg-mesh">
              <div className="text-center p-8">
                <Plug size={48} className="mx-auto mb-4 text-text-muted opacity-30" />
                <div className="text-text-secondary text-[14px] mb-2">{t('api.emptyTitle')}</div>
                <div className="text-text-muted text-[13px] mb-6">{t('api.emptyHint')}</div>
                <button onClick={startAdd} className="btn-primary">{t('api.addFirstProvider')}</button>
              </div>
            </div>
          )}

          {/* 预设(只列"未配置"的;已配置的移到上方"已配置"区,见 order-1/order-2)*/}
          {(() => {
            const unconfigured = PRESET_PROVIDERS.filter(p => p.id !== "custom" && !store.providers.some(prov => prov.name === p.name) && !configuredKeys.has(p.id));
            return unconfigured.length === 0 ? null : (
            <div className="mb-6 order-2">
              <div className="text-[13px] font-semibold text-text-primary mb-3">{t('api.presetProviders')}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {unconfigured.map(p => {
                  const isConfigured = false;
                  const viaKeys = false, inStore = false;
                  return (
                    <motion.div
                      key={p.id}
                      whileHover={{ scale: 1.02 }}
                      transition={{ duration: 0.15 }}
                      className={`bg-bg-card rounded-xl p-4 border ${isConfigured ? "border-accent/30" : "border-border"} shadow-sm hover:shadow-md transition-shadow`}>
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <span className="text-[14px] font-semibold text-text-primary">{p.name}</span>
                          {p.popular && <Star size={12} className="ml-1 inline text-amber" />}
                        </div>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${API_FORMAT_COLORS[p.apiFormat] || "bg-bg-hover text-text-secondary"}`}>
                          {formatLabel(p.apiFormat)}
                        </span>
                      </div>
                      {p.website && (
                        <a href={p.website} target="_blank" rel="noopener noreferrer"
                          className="block text-[12px] text-accent no-underline hover:underline mb-1 truncate">
                          {p.website.replace(/^https?:\/\//, "")}
                        </a>
                      )}
                      <div className="text-[11px] text-text-secondary truncate font-mono mt-1">{p.baseUrl || t('api.customUrl')}</div>
                      <button
                        onClick={() => {
                          startAdd();
                          handlePresetSelect(p);
                        }}
                        className={`mt-3 w-full px-3 py-1.5 rounded-full text-[12px] font-medium cursor-pointer transition-colors ${
                          isConfigured
                            ? "bg-bg-hover text-text-secondary border border-border cursor-default"
                            : "bg-bg-hover text-text-primary border border-border hover:bg-border"
                        }`}
                        disabled={isConfigured}>
                        {isConfigured ? t('api.configured') : t('api.quickConfig')}
                      </button>
                      {viaKeys && !inStore && <div className="text-[10px] text-text-muted mt-1 text-center">{t('api.viaKeys')}</div>}
                    </motion.div>
                  );
                })}
              </div>
            </div>
            );
          })()}

          {/* 已配置(放在预设之上:order-1)。含 store 里可编辑的 + keys/环境变量配置的只读项。 */}
          {(store.providers.length > 0 || configuredKeys.size > 0) && (
            <div className="order-1">
              <div className="text-[13px] font-semibold text-text-primary mb-3">{t('api.configuredProviders')}</div>
              <div className="space-y-2">
                {PRESET_PROVIDERS.filter(p => configuredKeys.has(p.id) && !store.providers.some(prov => prov.name === p.name)).map(p => (
                  <div key={"vk-" + p.id} className="bg-bg-card rounded-lg p-4 border border-border shadow-sm">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold text-text-primary flex-1 truncate">{p.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${API_FORMAT_COLORS[p.apiFormat] || "bg-bg-hover text-text-secondary"}`}>{formatLabel(p.apiFormat)}</span>
                      <button type="button" onClick={() => refreshProviderModels(p.id)} disabled={refreshingModels === p.id} title={t("api.refreshModels")} className="w-7 h-7 flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">
                        <RefreshCw size={12} className={refreshingModels === p.id ? "animate-spin" : ""} />
                      </button>
                    </div>
                    <ProviderAccountsManager
                      providerId={p.id}
                      providerLabel={p.name}
                      defaultTestModel={DEFAULT_TEST_MODEL[p.id]}
                      modelOptions={catalog?.apiProviders.find(entry => entry.provider === p.id)?.models ?? []}
                    />
                  </div>
                ))}
                {store.providers.map(p => {
                  const preset = PRESET_PROVIDERS.find(pp => pp.name === p.name);
                  return (
                    <motion.div
                      key={p.id}
                      whileHover={{ scale: 1.005 }}
                      transition={{ duration: 0.15 }}
                      className="bg-bg-card rounded-xl p-4 border border-border shadow-sm hover:border-accent/30 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[14px] font-semibold text-text-primary">{p.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${API_FORMAT_COLORS[p.apiFormat] || "bg-bg-hover text-text-secondary"}`}>
                              {formatLabel(p.apiFormat)}
                            </span>
                          </div>
                          <div className="flex items-center gap-3 text-[12px] text-text-muted">
                            {p.website && (
                              <a href={p.website} target="_blank" rel="noopener noreferrer"
                                className="text-accent no-underline hover:underline truncate">
                                {p.website.replace(/^https?:\/\//, "")}
                              </a>
                            )}
                            <span className="font-mono truncate">{p.baseUrl}</span>
                            {p.models.length > 0 && (
                              <span className="text-text-muted">{t('api.modelsCount').replace('{n}', String(p.models.length))}</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <button type="button" onClick={() => refreshProviderModels(p.id)} disabled={refreshingModels === p.id}
                            title={t("api.refreshModels")}
                            className="w-7 h-7 flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">
                            <RefreshCw size={12} className={refreshingModels === p.id ? "animate-spin" : ""} />
                          </button>
                          <button onClick={() => startEdit(p.id)}
                            className="px-3 py-1 rounded-full text-[12px] border border-border bg-transparent cursor-pointer text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors">
                            {t('api.edit')}
                          </button>
                          <button onClick={() => handleDelete(p.id)}
                            className="px-3 py-1 rounded-full text-[12px] border border-border bg-transparent cursor-pointer text-text-secondary hover:bg-red/10 hover:text-red hover:border-red/20 transition-colors">
                            {t('common.delete')}
                          </button>
                        </div>
                      </div>
                      {/* 多账号自动切换:自定义供应商(经典设置表单配置)同样可以加第二个、第三个账号。 */}
                      <ProviderAccountsManager
                        providerId={p.id}
                        providerLabel={p.name}
                        defaultTestModel={p.defaultModel || DEFAULT_TEST_MODEL[preset?.id ?? ""]}
                        modelOptions={catalog?.apiProviders.find(entry => entry.provider === p.id)?.models
                          ?? p.models.map(model => ({ id: model, label: model }))}
                      />
                    </motion.div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
