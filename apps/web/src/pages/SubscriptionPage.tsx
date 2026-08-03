import { Fragment, useEffect, useState } from "react";
import { RefreshCw, Loader2, Check, LogIn, LogOut, Download, ArrowUpCircle } from "lucide-react";
import * as api from "../api/client.js";
import { useT } from "../i18n.js";
import { confirmDialog } from "../components/common/ConfirmDialog.js";
import HelpTip from "../components/HelpTip.js";
import type { AgentFramework } from "@opc/shared";
import { canRefreshSubscriptionCatalog, FRAMEWORK_TO_CATALOG_ENGINE, SUBSCRIPTION_BRAND, type SubscriptionFramework } from "../lib/framework.js";
import { SUBSCRIPTIONS, subscriptionStatus, statusDotColor, SUB_LOGIN_CMD, type SubStatus } from "../lib/subscriptionSection.js";
import { ProviderAccountsManager } from "../components/CliApiKeyAccounts.js";
import { useSetupInstallJob } from "../lib/useSetupInstallJob.js";
import { useFrameworkAvailabilityStore } from "../store/useFrameworkAvailabilityStore.js";

const STATUS_BADGE: Record<SubStatus, { cls: string; key: string }> = {
  detecting: { cls: "bg-bg-hover text-text-muted", key: "setup.status.detecting" },
  "not-installed": { cls: "bg-bg-hover text-text-muted", key: "api.cli.status.notInstalled" },
  "installed-not-logged-in": { cls: "bg-amber/15 text-amber", key: "setup.status.installedNotLoggedIn" },
  ready: { cls: "bg-green/15 text-green", key: "setup.status.ready" },
};

interface SubscriptionAccountConfig {
  providerId: string;
  label: string;
  subscription: boolean;
  note?: string;
  cliBackend?: "native" | "glm-coding-plan";
}

const SUBSCRIPTION_ACCOUNT_CONFIGS: Record<SubscriptionFramework, SubscriptionAccountConfig[]> = {
  "claude-code": [{ providerId: "anthropic", label: "Claude Code", subscription: true }],
  codex: [{ providerId: "openai", label: "Codex", subscription: true }],
  "gemini-cli": [{ providerId: "google", label: "Gemini CLI", subscription: true }],
  "kimi-cli": [{ providerId: "moonshot", label: "Kimi Code", subscription: true }],
  "grok-build": [{ providerId: "xai", label: "Grok Build", subscription: true }],
};

const GLM_CODING_PLAN_ENDPOINTS = [
  { value: "https://open.bigmodel.cn/api/anthropic", label: "中国区 · open.bigmodel.cn" },
  { value: "https://api.z.ai/api/anthropic", label: "国际区 · api.z.ai" },
];

export default function SubscriptionPage() {
  const t = useT();
  const frameworks = useFrameworkAvailabilityStore(state => state.frameworks);
  const frameworksRefreshing = useFrameworkAvailabilityStore(state => state.refreshing);
  const hydrateFrameworks = useFrameworkAvailabilityStore(state => state.hydrate);
  const refreshFrameworks = useFrameworkAvailabilityStore(state => state.refresh);
  const [operationMsg, setOperationMsg] = useState<Record<string, { kind: "ok" | "error"; text: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [catalogBusy, setCatalogBusy] = useState<string | null>(null);

  const { job: installJob, installing, requestError: installRequestError, start: startInstallJob } = useSetupInstallJob(job => {
    setOperationMsg(messages => ({
      ...messages,
      [job.engine]: {
        kind: job.status === "done" ? "ok" : "error",
        text: job.status === "done" ? t("subscription.updateDone") : t("agent.install.failed", { reason: job.error ?? job.status }),
      },
    }));
    void refreshFrameworks().catch(() => {});
  });

  useEffect(() => { hydrateFrameworks(); }, [hydrateFrameworks]);

  const installOrUpdate = async (fw: SubscriptionFramework) => {
    if (installing) return;
    setOperationMsg(messages => ({ ...messages, [fw]: { kind: "ok", text: t("agent.install.running", { engine: fw }) } }));
    try {
      await startInstallJob(fw);
    } catch (cause) {
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "error", text: cause instanceof Error ? cause.message : String(cause) } }));
    }
  };

  const login = async (fw: SubscriptionFramework) => {
    setBusyId(fw);
    setOperationMsg(messages => ({ ...messages, [fw]: { kind: "ok", text: t("api.accounts.loginLaunched") } }));
    try {
      await api.post(`/frameworks/${fw}/login`, {});
    } catch (cause) {
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "error", text: cause instanceof Error ? cause.message : String(cause) } }));
    } finally { setBusyId(null); }
  };

  const logout = async (fw: SubscriptionFramework, label: string) => {
    if (!await confirmDialog({ title: t("api.cli.logoutConfirm", { label }), confirmLabel: t("api.cli.btn.logout") })) return;
    setBusyId(fw);
    try {
      await api.post(`/frameworks/${fw}/logout`, {});
      await refreshFrameworks();
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "ok", text: t("subscription.loggedOut") } }));
    } catch (cause) {
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "error", text: cause instanceof Error ? cause.message : String(cause) } }));
    } finally { setBusyId(null); }
  };

  const refreshModels = async (fw: SubscriptionFramework) => {
    const engine = FRAMEWORK_TO_CATALOG_ENGINE[fw];
    setCatalogBusy(fw);
    try {
      await api.refreshModelCatalog("subscription", engine);
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "ok", text: t("subscription.modelsUpdated") } }));
    } catch (cause) {
      setOperationMsg(messages => ({ ...messages, [fw]: { kind: "error", text: cause instanceof Error ? cause.message : String(cause) } }));
    } finally { setCatalogBusy(null); }
  };

  return <div className="p-6 max-w-[960px] mx-auto">
    <div className="flex items-center justify-between gap-3 mb-4">
      <div className="flex items-center gap-1.5">
        <h2 className="text-[15px] font-semibold text-text-primary m-0">{t("subscription.heading")}</h2>
        <HelpTip text={t("subscription.subtitle")} />
      </div>
      <button onClick={() => void refreshFrameworks().catch(() => {})} disabled={frameworksRefreshing} title={t("api.cli.refresh")} className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-50">
        <RefreshCw size={13} className={frameworksRefreshing ? "animate-spin" : ""} />
      </button>
    </div>

    <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-start">
      {SUBSCRIPTIONS.map(({ fw, name }) => {
        const availability = frameworks.find(item => item.framework === fw);
        const status = subscriptionStatus(availability);
        const brand = SUBSCRIPTION_BRAND[fw];
        const badge = STATUS_BADGE[status];
        const message = operationMsg[fw];
        const accountConfigs = SUBSCRIPTION_ACCOUNT_CONFIGS[fw];

        return <Fragment key={fw}><div className="rounded-lg border border-hairline bg-surface-1 p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 w-7 h-7 rounded-md text-[11px] font-bold text-white flex items-center justify-center" style={{ backgroundColor: brand.bg }}>{brand.mono}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-text-primary truncate">{name}</div>
              {availability?.version && <div className="text-[10px] text-text-muted truncate" title={availability.version}>{availability.version}</div>}
            </div>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusDotColor(availability) }} title={availability?.detail || undefined} />
          </div>

          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${badge.cls}`}>{t(badge.key)}</span>
            <div className="flex-1" />
            {(status === "installed-not-logged-in" || status === "ready") && canRefreshSubscriptionCatalog(fw) && <button onClick={() => void refreshModels(fw)} disabled={catalogBusy === fw} title={t("subscription.refreshModels")} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40"><RefreshCw size={12} className={catalogBusy === fw ? "animate-spin" : ""} /></button>}
            {(status === "installed-not-logged-in" || status === "ready") && <button onClick={() => void installOrUpdate(fw)} disabled={!!installing} title={t("subscription.updateCli")} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">{installing === fw ? <Loader2 size={12} className="animate-spin" /> : <ArrowUpCircle size={12} />}</button>}
          </div>

          {status === "not-installed" && <button onClick={() => void installOrUpdate(fw)} disabled={!!installing} title={t("agent.install.btn") + " " + name} className="mt-1 flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-md text-[12px] font-medium border border-accent/40 bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 disabled:opacity-50">{installing === fw ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}{installing === fw ? t("agent.install.btnRunning") : t("agent.install.btn")}</button>}

          {status === "installed-not-logged-in" && <button onClick={() => void login(fw)} disabled={busyId === fw} title={t("api.cli.btn.login") + ": " + SUB_LOGIN_CMD[fw]} className="flex items-center justify-center gap-1.5 w-full px-3 py-1.5 rounded-md text-[12px] font-medium border border-accent/40 bg-accent/10 text-accent cursor-pointer hover:bg-accent/20 disabled:opacity-50"><LogIn size={12} />{busyId === fw ? t("api.cli.btn.launching") : t("api.cli.btn.login")}</button>}

          {status === "ready" && <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1 text-[11px] text-green"><Check size={12} />{t("setup.status.ready")}</span><button onClick={() => void logout(fw, name)} disabled={busyId === fw} title={t("api.cli.btn.logout") + " " + name} className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-red disabled:opacity-50"><LogOut size={12} /></button></div>}

          {message && <div className={`rounded-md px-2 py-1 text-[10px] ${message.kind === "ok" ? "bg-green/10 text-green" : "bg-red/10 text-red"}`}>{message.text}</div>}
          {installing === fw && installJob?.log?.length ? <div className="max-h-20 overflow-auto rounded-md bg-bg-hover px-2 py-1 font-mono text-[9px] text-text-muted" title={installJob.log.slice(-12).join("\n")}>{installJob.log.slice(-3).map((line, index) => <div key={index + "-" + line}>{line}</div>)}</div> : null}
          {installRequestError && installing === fw && <div className="text-[10px] text-red">{installRequestError}</div>}

          {accountConfigs.map(config => <div key={config.providerId}>
            {config.note && <div className="mt-1 rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">{config.note}</div>}
            <ProviderAccountsManager
              subscription={config.subscription}
              cliBackend={config.cliBackend}
              providerId={config.providerId}
              providerLabel={config.label}
              frameworks={[fw as AgentFramework]}
            />
          </div>)}
        </div>

        {fw === "claude-code" && <div data-testid="glm-coding-plan-card" className="rounded-lg border border-hairline bg-surface-1 p-4 flex flex-col gap-2.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 w-7 h-7 rounded-md bg-[#635BFF] text-[10px] font-bold text-white flex items-center justify-center">GLM</span>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-text-primary truncate">GLM Coding Plan</div>
              <div className="text-[10px] text-text-muted truncate">通过 Claude Code 运行</div>
            </div>
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: availability?.installed ? "var(--color-success)" : "var(--color-ink-subtle)" }} title={availability?.installed ? "Claude Code CLI 已安装" : "需要先安装 Claude Code CLI"} />
          </div>

          <div className="flex items-center gap-1.5">
            <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${availability?.installed ? "bg-green/15 text-green" : "bg-bg-hover text-text-muted"}`}>{availability?.installed ? "Claude Code 已安装" : "需要 Claude Code CLI"}</span>
            <div className="flex-1" />
            {!availability?.installed && <button onClick={() => void installOrUpdate("claude-code")} disabled={!!installing} title="安装 Claude Code CLI" className="w-7 h-7 inline-flex items-center justify-center rounded-md border border-border bg-transparent text-text-muted hover:text-text-primary disabled:opacity-40">{installing === "claude-code" ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}</button>}
          </div>

          <div className="rounded-md border border-accent/20 bg-accent/5 px-2 py-1.5 text-[10px] leading-relaxed text-text-secondary">填写 GLM Coding Plan Token 并选择服务区域。任务由 Claude Code CLI 执行，模型与额度来自 GLM。</div>
          <ProviderAccountsManager
            subscription={false}
            cliBackend="glm-coding-plan"
            providerId="z-ai"
            providerLabel="GLM Coding Plan"
            frameworks={["claude-code"]}
            baseUrlOptions={GLM_CODING_PLAN_ENDPOINTS}
            defaultBaseUrl={GLM_CODING_PLAN_ENDPOINTS[0]!.value}
            collapsible
            secretPlaceholder="Coding Plan Token"
          />
        </div>}
        </Fragment>;
      })}
    </div>
  </div>;
}
