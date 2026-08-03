import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, KeyRound, Pencil, Plus, Trash2, RefreshCw, X, Zap, LogIn, Star } from "lucide-react";
import type { PublicProviderAccount, EngineAvailability, AgentFramework } from "@opc/shared";
import * as api from "../api/client.js";
import type { CatalogModel } from "../api/client.js";
import { useT } from "../i18n.js";
import { confirmDialog } from "./common/ConfirmDialog.js";

export interface ProviderAccountsManagerProps {
  providerId: string;
  providerLabel: string;
  frameworks?: AgentFramework[];
  defaultTestModel?: string;
  modelOptions?: CatalogModel[];
  subscription?: boolean;
  cliBackend?: "native" | "glm-coding-plan";
  baseUrlOptions?: Array<{ value: string; label: string }>;
  defaultBaseUrl?: string;
  collapsible?: boolean;
  defaultExpanded?: boolean;
  secretPlaceholder?: string;
}

interface AccountKeyTestResult { ok: boolean; latencyMs: number; model: string; message: string }
interface AccountHealth { healthy: boolean; stats: { consecutiveFailures: number; lastFailure: string | null; lastError: string | null } | null }

export function resolveTestModel(current: string, fallback: string, models: CatalogModel[]): string {
  if (models.length === 0) return current || fallback;
  if (models.some(model => model.id === current)) return current;
  if (models.some(model => model.id === fallback)) return fallback;
  return models.find(model => model.isDefault)?.id || models[0]!.id;
}

export function ProviderAccountsManager({ providerId, frameworks, defaultTestModel, modelOptions = [], subscription, cliBackend, baseUrlOptions = [], defaultBaseUrl, collapsible = false, defaultExpanded = false, secretPlaceholder }: ProviderAccountsManagerProps) {
  const t = useT();
  const frameworkKey = (frameworks ?? []).join(",");
  const frameworkList = useMemo(() => frameworkKey ? frameworkKey.split(",") as AgentFramework[] : undefined, [frameworkKey]);
  const isCli = !!frameworkList?.length;
  const fw = frameworkList?.[0];
  const [accounts, setAccounts] = useState<PublicProviderAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [accountsExpanded, setAccountsExpanded] = useState(!collapsible || defaultExpanded);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl || baseUrlOptions[0]?.value || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, EngineAvailability>>({});
  const [tests, setTests] = useState<Record<string, AccountKeyTestResult>>({});
  const [health, setHealth] = useState<Record<string, AccountHealth>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [testModel, setTestModel] = useState(defaultTestModel || "");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const modelOptionsKey = modelOptions.map(model => model.id).join("\n");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.get<PublicProviderAccount[]>("/accounts");
      setAccounts(all.filter(account => account.providerId === providerId
        && (subscription ? !account.hasApiKey : account.hasApiKey)
        && (isCli ? (account.frameworks ?? []).some(value => frameworkList!.includes(value)) : true)));
    } catch (cause) {
      setAccounts([]);
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setLoading(false); }
  }, [providerId, subscription, isCli, frameworkList]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    setTestModel(current => resolveTestModel(current, defaultTestModel || "", modelOptions));
  }, [providerId, defaultTestModel, modelOptionsKey]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all(accounts.map(async (account): Promise<[string, AccountHealth] | null> => {
      try { return [account.id, await api.get<AccountHealth>(`/accounts/${encodeURIComponent(account.id)}/health`)]; } catch { return null; }
    })).then(entries => {
      if (!cancelled) setHealth(Object.fromEntries(entries.filter((entry): entry is [string, AccountHealth] => !!entry)));
    });
    return () => { cancelled = true; };
  }, [accounts]);

  useEffect(() => {
    if (!isCli || accounts.length === 0) return;
    let cancelled = false;
    void Promise.all(accounts.map(async (account): Promise<[string, EngineAvailability] | null> => {
      try { return [account.id, await api.get<EngineAvailability>(`/accounts/${encodeURIComponent(account.id)}/probe`)]; } catch { return null; }
    })).then(entries => {
      if (!cancelled) setProbes(Object.fromEntries(entries.filter((entry): entry is [string, EngineAvailability] => !!entry)));
    });
    return () => { cancelled = true; };
  }, [accounts, isCli]);

  const probe = async (id: string) => {
    setBusyId(id); setNotice(null);
    try {
      const availability = await api.get<EngineAvailability>(`/accounts/${encodeURIComponent(id)}/probe`);
      setProbes(previous => ({ ...previous, [id]: availability }));
      const ok = availability.installed && availability.loggedIn;
      setNotice({ kind: ok ? "ok" : "error", text: ok ? t("setup.status.ready") : (availability.detail || t("setup.status.installedNotLoggedIn")) });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  const test = async (id: string) => {
    setBusyId(id); setNotice(null);
    try {
      const query = testModel.trim() ? `?model=${encodeURIComponent(testModel.trim())}` : "";
      const result = await api.post<AccountKeyTestResult>(`/accounts/${encodeURIComponent(id)}/test${query}`, {});
      setTests(previous => ({ ...previous, [id]: result }));
      setNotice({ kind: result.ok ? "ok" : "error", text: result.ok ? `${t("api.accounts.testOk")} (${result.latencyMs}ms)` : `${t("api.accounts.testFailed")}: ${result.message}` });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  const login = async (account: PublicProviderAccount) => {
    if (!fw) return;
    setBusyId(account.id); setNotice(null);
    try {
      await api.post(`/frameworks/${fw}/login`, { configDir: account.configDir });
      setNotice({ kind: "ok", text: t("api.accounts.loginLaunched") });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  const create = async () => {
    if (!label.trim() || (!subscription && !apiKey.trim())) return;
    setSaving(true); setError(null); setNotice(null);
    try {
      const account = await api.post<PublicProviderAccount>("/accounts", {
        providerId,
        label: label.trim(),
        ...(subscription ? {} : { apiKey: apiKey.trim() }),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(cliBackend ? { cliBackend } : {}),
        ...(isCli ? { frameworks: frameworkList } : {}),
        enabled: true,
        maxConcurrent: isCli ? 1 : 6,
      });
      setLabel(""); setApiKey(""); setBaseUrl(defaultBaseUrl || baseUrlOptions[0]?.value || ""); setAdding(false);
      await refresh();
      if (subscription) void login(account);
      else void (isCli ? probe(account.id) : test(account.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSaving(false); }
  };

  const setPreferred = async (id: string) => {
    setBusyId(id); setNotice(null);
    try {
      await api.post(`/accounts/${encodeURIComponent(id)}/preferred`, {});
      await refresh();
      setNotice({ kind: "ok", text: t("api.accounts.primarySet") });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  const rename = async (id: string) => {
    const nextLabel = renameLabel.trim();
    if (!nextLabel) return;
    setBusyId(id); setNotice(null);
    try {
      await api.patch(`/accounts/${encodeURIComponent(id)}`, { label: nextLabel });
      setRenamingId(null);
      setRenameLabel("");
      await refresh();
      setNotice({ kind: "ok", text: t("api.accounts.renamed") });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  const remove = async (id: string) => {
    if (!await confirmDialog({ title: t(subscription ? "api.cli.sub.deleteConfirm" : "api.cli.apikey.deleteConfirm"), danger: true, confirmLabel: t("common.delete") })) return;
    setBusyId(id); setNotice(null);
    try {
      const result = await api.del<{ deleted: boolean }>(`/accounts/${encodeURIComponent(id)}`);
      if (!result.deleted) throw new Error(t("api.accounts.deleteFailed"));
      await refresh();
      setNotice({ kind: "ok", text: t("api.accounts.deleted") });
    } catch (cause) {
      setNotice({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusyId(null); }
  };

  return (
    <div className="mt-3 pt-3 border-t border-hairline" data-testid={`accounts-${providerId}-${subscription ? "subscription" : "api"}`}>
      <div className="flex items-center justify-between gap-2">
        <button type="button" data-testid={`accounts-${providerId}-toggle`} onClick={() => { if (!collapsible) return; if (accountsExpanded) setAdding(false); setAccountsExpanded(value => !value); }} disabled={!collapsible} aria-expanded={accountsExpanded} className="min-w-0 flex items-center gap-1.5 text-[12px] font-medium text-text-secondary bg-transparent border-none p-0 disabled:cursor-default cursor-pointer">
          {collapsible && <ChevronDown size={12} className={`transition-transform ${accountsExpanded ? "rotate-0" : "-rotate-90"}`} />}
          <KeyRound size={12} /> {t("api.accounts.heading")}
          {!loading && <span className="text-[10px] text-text-muted">{accounts.length}</span>}
        </button>
        <div className="flex items-center gap-2 min-w-0">
          <button data-testid={`accounts-${providerId}-add`} onClick={() => { setAccountsExpanded(true); setAdding(value => !value); }} title={t("api.accounts.add")} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-border text-accent cursor-pointer hover:bg-bg-hover bg-transparent shrink-0"><Plus size={13} /></button>
          {!isCli && (modelOptions.length > 0 ? (
            <select
              data-testid={`accounts-${providerId}-test-model`}
              value={testModel}
              onChange={event => { setTestModel(event.target.value); setNotice(null); }}
              title={t("api.accounts.testModelPlaceholder")}
              className="w-48 max-w-[min(48vw,20rem)] border border-border rounded-md bg-bg-primary text-[11px] py-1 px-1.5 outline-none focus:border-accent font-mono cursor-pointer"
            >
              {modelOptions.map(model => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
            </select>
          ) : (
            <input
              data-testid={`accounts-${providerId}-test-model`}
              value={testModel}
              onChange={event => { setTestModel(event.target.value); setNotice(null); }}
              placeholder={t("api.accounts.testModelPlaceholder")}
              title={t("api.accounts.testModelPlaceholder")}
              className="w-40 border border-border rounded-md bg-bg-primary text-[11px] py-1 px-1.5 outline-none focus:border-accent font-mono"
            />
          ))}
        </div>
      </div>

      {accountsExpanded && <>
      {notice && <div className={`mt-2 rounded-md px-2 py-1 text-[10px] ${notice.kind === "ok" ? "bg-green/10 text-green" : "bg-red/10 text-red"}`}>{notice.text}</div>}

      {!loading && accounts.length > 0 && <div className="mt-2 flex flex-col gap-1.5">
        {accounts.map(account => {
          const availability = probes[account.id];
          const testResult = tests[account.id];
          const accountHealth = health[account.id];
          const ready = isCli ? !!(availability?.installed && availability?.loggedIn) : !!testResult?.ok;
          const cooling = accountHealth && !accountHealth.healthy;
          const dot = cooling ? "var(--color-error)" : (isCli ? (!availability ? "var(--color-ink-subtle)" : ready ? "var(--color-success)" : "var(--color-warning)") : (!testResult ? "var(--color-ink-subtle)" : ready ? "var(--color-success)" : "var(--color-error)"));
          return <div key={account.id} data-testid={`account-row-${account.id}`} className="rounded-md bg-bg-primary border border-hairline px-2.5 py-2">
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
              {renamingId === account.id ? (
                <input
                  autoFocus
                  value={renameLabel}
                  onChange={event => setRenameLabel(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter") void rename(account.id);
                    if (event.key === "Escape") { setRenamingId(null); setRenameLabel(""); }
                  }}
                  maxLength={120}
                  aria-label={t("api.accounts.rename")}
                  className="min-w-0 flex-1 rounded border border-accent bg-bg-card px-1.5 py-0.5 text-[12px] text-text-primary outline-none"
                />
              ) : (
                <div className="min-w-0 flex-1 text-[12px] text-text-primary truncate" title={account.label}>{account.label}</div>
              )}
              {account.preferred && <span className="text-[10px] text-accent shrink-0">{t("api.cli.defaultAccount")}</span>}
              {renamingId === account.id ? (
                <>
                  <button onClick={() => void rename(account.id)} disabled={busyId === account.id || !renameLabel.trim()} className="w-6 h-6 inline-flex items-center justify-center text-green cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("common.save")}><Check size={12} /></button>
                  <button onClick={() => { setRenamingId(null); setRenameLabel(""); }} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-text-muted cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("common.cancel")}><X size={12} /></button>
                </>
              ) : (
                <button data-testid={`account-rename-${account.id}`} onClick={() => { setRenamingId(account.id); setRenameLabel(account.label); }} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("api.accounts.rename")}><Pencil size={12} /></button>
              )}
              {!account.preferred && <button data-testid={`account-preferred-${account.id}`} onClick={() => setPreferred(account.id)} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-text-muted hover:text-amber cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("api.accounts.setPrimary")}><Star size={12} /></button>}
              {subscription && !ready && <button onClick={() => login(account)} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-accent cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("api.cli.btn.login")}><LogIn size={12} /></button>}
              <button data-testid={`account-test-${account.id}`} onClick={() => void (isCli ? probe(account.id) : test(account.id))} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-text-muted hover:text-text-primary cursor-pointer disabled:opacity-50 bg-transparent border-none" title={isCli ? t("api.cli.apikey.refreshStatus") : t("api.accounts.test")}>{isCli ? <RefreshCw size={12} className={busyId === account.id ? "animate-spin" : ""} /> : <Zap size={12} className={busyId === account.id ? "animate-pulse" : ""} />}</button>
              <button data-testid={`account-delete-${account.id}`} onClick={() => void remove(account.id)} disabled={busyId === account.id} className="w-6 h-6 inline-flex items-center justify-center text-text-muted hover:text-red cursor-pointer disabled:opacity-50 bg-transparent border-none" title={t("common.delete")}><Trash2 size={12} /></button>
            </div>
            {cooling && <div className="mt-1 text-[10px] text-red">{t(subscription ? "api.cli.sub.cooling" : "api.accounts.cooling")}</div>}
          </div>;
        })}
      </div>}

      {adding && <div className="mt-2 p-2.5 rounded-md bg-bg-hover flex flex-col gap-1.5">
        <input data-testid={`accounts-${providerId}-label`} value={label} onChange={event => setLabel(event.target.value)} maxLength={120} placeholder={t("api.accounts.labelPlaceholder")} className="border border-border rounded-md bg-bg-card text-[12px] py-1.5 px-2 outline-none focus:border-accent" />
        {baseUrlOptions.length > 0 && <select data-testid={`accounts-${providerId}-base-url`} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} className="border border-border rounded-md bg-bg-card text-[12px] py-1.5 px-2 outline-none focus:border-accent cursor-pointer">
          {baseUrlOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>}
        {!subscription && <input data-testid={`accounts-${providerId}-key`} value={apiKey} onChange={event => setApiKey(event.target.value)} type="password" autoComplete="off" placeholder={secretPlaceholder || t("api.cli.apikey.keyPlaceholder")} className="border border-border rounded-md bg-bg-card text-[12px] py-1.5 px-2 outline-none focus:border-accent font-mono" />}
        {error && <div className="text-[10px] text-red">{error}</div>}
        <div className="flex gap-1.5 justify-end mt-1">
          <button onClick={() => { setAdding(false); setError(null); }} className="px-3 py-1 rounded-md text-[11px] border border-border text-text-secondary cursor-pointer hover:bg-bg-card bg-transparent">{t("common.cancel")}</button>
          <button data-testid={`accounts-${providerId}-create`} onClick={() => void create()} disabled={saving || !label.trim() || (!subscription && !apiKey.trim())} className="px-3 py-1 rounded-md text-[11px] border border-accent/40 bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 disabled:opacity-50">{saving ? t("api.cli.apikey.creating") : t("api.cli.apikey.create")}</button>
        </div>
      </div>}
      </>}
    </div>
  );
}

export default function CliApiKeyAccounts() {
  return <ProviderAccountsManager providerId="openai" providerLabel="Codex" frameworks={["codex"]} />;
}
