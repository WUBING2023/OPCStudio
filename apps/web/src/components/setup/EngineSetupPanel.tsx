import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal, KeyRound, Check, Copy, RefreshCw, Loader2, AlertTriangle } from "lucide-react";
import type { EngineAvailability } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";

// 引导第 1 步已探测过一次订阅 CLI(GET /api/onboarding/cli-status)。第 2 步复用本面板时,父级把那次
// 结果作为 initialFrameworks 传下来 → 直接当种子、跳过挂载时的 /frameworks 首探,避免同一件事在引导里
// 连探两次(用户实测反馈的"检测出现两次")。无 prop(设置页/旧引导独立复用)→ 种子空 + 挂载即自探,
// 行为不回归。纯函数,便于单测"探测计数"。
export function planInitialProbe(
  initialFrameworks?: EngineAvailability[],
): { seed: EngineAvailability[]; shouldProbe: boolean } {
  if (initialFrameworks && initialFrameworks.length > 0) {
    return { seed: initialFrameworks, shouldProbe: false };
  }
  return { seed: [], shouldProbe: true };
}

// 纯小白环境向导:两张订阅版引擎卡(Claude Code / Codex)+ 一张"不装 CLI 也能用" 的 API Key 备选卡。
// 复用已有 GET /api/frameworks 探测三态(未装/已装未登录/已装已登录);安装走新端点 POST
// /api/setup/install，轮询 GET /api/setup/install/status 拿日志尾巴。登录**从不**在这里自动执行——
// 只展示要跑的命令 + 复制按钮，交给用户自己在终端跑(登录是交互式的，代码不该替用户按回车)。
type CliEngine = "claude-code" | "codex";
type CliAuthMode = "subscription" | "apikey";

interface InstallJob {
  engine: CliEngine;
  status: "running" | "done" | "error" | "timeout";
  log: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  error?: string;
  probe?: EngineAvailability;
}

const ENGINES: { id: CliEngine; label: string; loginCmd: string; loginNote: string }[] = [
  { id: "claude-code", label: "Claude Code", loginCmd: "claude auth login", loginNote: "Anthropic" },
  { id: "codex", label: "Codex", loginCmd: "codex login", loginNote: "OpenAI" },
];

function StatusBadge({ av, t }: { av?: EngineAvailability; t: ReturnType<typeof useT> }) {
  if (!av) return <span className="badge bg-surface-2 text-ink-subtle">{t("setup.status.detecting")}</span>;
  if (av.installed && av.loggedIn) return <span className="badge bg-success/15 text-success">{t("setup.status.ready")}</span>;
  if (av.installed) return <span className="badge bg-amber/15 text-amber">{t("setup.status.installedNotLoggedIn")}</span>;
  return <span className="badge bg-surface-2 text-ink-subtle">{t("setup.status.notInstalled")}</span>;
}

function CopyButton({ text, t }: { text: string; t: ReturnType<typeof useT> }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(text)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };
  return (
    <button onClick={copy} className="btn-sm inline-flex items-center gap-1 shrink-0">
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {copied ? t("setup.login.copied") : t("setup.login.copy")}
    </button>
  );
}

// CLI 引擎的「API Key 模式」验证卡:粘贴 key → 调新端点 POST /api/setup/cli-api-key-account(创建账号 +
// 真实测试合一)→ 给出明确的 ✓/✗ 反馈,不是静默收下就跳下一步。测试失败时该端点仍会保留已创建的账号
// (接口不支持回滚),所以失败文案里如实告知"账号已创建、可去「API」页处理",不假装什么都没发生。
function CliApiKeyPanel({ engine, t }: { engine: CliEngine; t: ReturnType<typeof useT> }) {
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);
  const [configDir, setConfigDir] = useState<string | null>(null);
  const [reqError, setReqError] = useState<string | null>(null);

  const runTest = async () => {
    const key = apiKey.trim();
    if (!key) return;
    setTesting(true); setReqError(null); setResult(null);
    try {
      const d = await api.post<{ account: { configDir?: string }; test: { ok: boolean; latencyMs: number; message: string } }>(
        "/setup/cli-api-key-account", { engine, apiKey: key },
      );
      setResult(d.test);
      setConfigDir(d.account?.configDir ?? null);
    } catch (e: any) {
      setReqError(e?.message || t("setup.cliApiKey.requestFailed"));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 min-w-0">
        <input type="password" autoComplete="off" value={apiKey}
          onChange={e => { setApiKey(e.target.value); setResult(null); setReqError(null); }}
          placeholder={t("api.cli.apikey.keyPlaceholder")}
          className="flex-1 min-w-0 border border-border rounded-md bg-surface-0 text-[12px] py-1.5 px-2 outline-none focus:border-accent text-ink font-mono" />
        <button onClick={runTest} disabled={testing || !apiKey.trim()}
          className="btn-sm shrink-0 flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed">
          {testing ? <Loader2 size={11} className="animate-spin" /> : <KeyRound size={11} />}
          {testing ? t("setup.cliApiKey.testing") : t("setup.cliApiKey.testBtn")}
        </button>
      </div>

      {result && (result.ok ? (
        <div className="text-[11px] text-success leading-snug">
          <div className="flex items-center gap-1"><Check size={12} /> {t("setup.cliApiKey.passed", { ms: String(result.latencyMs) })}</div>
          {/* 补齐闭环:claudeCodeUseApiKey 是逐员工的开关(AgentDetailsPanel.tsx),只在这里建号验证
              不会让任何员工真的用上它——不给提示,用户测试通过后回组织图会发现员工还是订阅模式,
              不知道去哪启用。 */}
          {engine === "claude-code" && (
            <div className="mt-1 text-[10px] text-ink-muted">{t("setup.cliApiKey.claudeCodeNextStep")}</div>
          )}
          {engine === "codex" && configDir && (
            <div className="mt-1.5 pt-1.5 border-t border-border text-[10px] text-ink-muted leading-relaxed">
              <div className="text-ink font-medium mb-1">{t("api.cli.apikey.loginGuide.title")}</div>
              <div>1. {t("api.cli.apikey.loginGuide.step1")}</div>
              <div className="font-mono bg-surface-0 rounded px-1.5 py-0.5 my-1 break-all">CODEX_HOME={configDir}</div>
              <div>2. {t("api.cli.apikey.loginGuide.step2")}</div>
              <div className="font-mono bg-surface-0 rounded px-1.5 py-0.5 my-1">codex login --with-api-key</div>
              <div>3. {t("api.cli.apikey.loginGuide.step3")}</div>
            </div>
          )}
        </div>
      ) : (
        <div className="text-[11px] text-error leading-snug flex items-start gap-1">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{t("setup.cliApiKey.failed", { message: result.message })} {t("setup.cliApiKey.failedNote")}</span>
        </div>
      ))}
      {reqError && (
        <div className="text-[11px] text-error leading-snug flex items-start gap-1">
          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
          <span>{reqError}</span>
        </div>
      )}
    </div>
  );
}

export default function EngineSetupPanel({ onUseApiKeyInstead, initialFrameworks }: { onUseApiKeyInstead: () => void; initialFrameworks?: EngineAvailability[] }) {
  const t = useT();
  // 挂载决策一次定死:有种子(父级传下第 1 步结果)则以种子起手、跳过首探;否则空种子 + 挂载自探。
  const [frameworks, setFrameworks] = useState<EngineAvailability[]>(() => planInitialProbe(initialFrameworks).seed);
  const shouldSelfProbe = useRef(planInitialProbe(initialFrameworks).shouldProbe);
  const [job, setJob] = useState<InstallJob | null>(null);
  const [triggerError, setTriggerError] = useState<string | null>(null);
  // 每个 CLI 引擎卡"已装未登录"时的第二级切换:订阅登录(默认,原有行为)或 API Key 模式(新路径)。
  const [cliAuthMode, setCliAuthMode] = useState<Record<CliEngine, CliAuthMode>>({ "claude-code": "subscription", codex: "subscription" });
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const refreshFrameworks = useCallback(async () => {
    try {
      const d = await api.get<{ frameworks: EngineAvailability[] }>("/frameworks");
      setFrameworks(d.frameworks ?? []);
    } catch { /* 探测失败不阻断界面,卡片回退到"检测中" */ }
  }, []);

  const poll = useCallback(async () => {
    try {
      const d = await api.get<{ job: InstallJob | null }>("/setup/install/status");
      if (!alive.current) return;
      setJob(d.job);
      if (d.job?.status === "running") {
        pollTimer.current = setTimeout(poll, 1000);
      } else if (d.job) {
        refreshFrameworks(); // 装完(成功/失败/超时)都重新拉一次真实状态
      }
    } catch { /* 轮询失败静默重试由下次挂载/手动刷新兜底 */ }
  }, [refreshFrameworks]);

  useEffect(() => {
    alive.current = true;
    // 有种子时跳过首探(结果已由父级传入,StatusBadge 直接出结果、不二次转圈);poll 只查安装任务态,
    // 不是 CLI 检测,始终保留(可续上正在进行的安装)。手动"刷新"按钮与装完后的 refreshFrameworks 不受影响。
    if (shouldSelfProbe.current) refreshFrameworks();
    poll();
    return () => { alive.current = false; if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, [refreshFrameworks, poll]);

  const startInstall = async (engine: CliEngine) => {
    setTriggerError(null);
    try {
      const d = await api.post<{ job?: InstallJob; supported?: boolean; error?: string }>("/setup/install", { engine });
      if (d.job) {
        setJob(d.job);
        if (pollTimer.current) clearTimeout(pollTimer.current);
        pollTimer.current = setTimeout(poll, 1000);
      }
    } catch (e: any) {
      setTriggerError(e?.message || t("setup.install.failed"));
    }
  };

  const anyInstalling = job?.status === "running";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <button onClick={refreshFrameworks} className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink cursor-pointer bg-transparent border-none shrink-0">
          <RefreshCw size={12} /> {t("setup.refresh")}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {ENGINES.map(({ id, label, loginCmd, loginNote }) => {
          const av = frameworks.find(f => f.framework === id);
          const ready = !!(av?.installed && av?.loggedIn);
          const installing = job?.engine === id && job.status === "running";
          const myJobDone = job?.engine === id && job.status !== "running";

          return (
            <div key={id} className="card flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <Terminal size={15} className="text-accent shrink-0" />
                  <span className="text-[13px] font-medium text-ink truncate">{label}</span>
                </div>
                <StatusBadge av={av} t={t} />
              </div>
              {av?.version && <div className="text-[11px] text-ink-subtle truncate" title={av.version}>{av.version}</div>}

              {!av?.installed && (
                <div className="flex flex-col gap-1.5 mt-0.5">
                  {installing ? (
                    <div className="flex flex-col gap-1.5">
                      <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden">
                        <div className="h-full w-1/3 bg-accent rounded-full animate-[installbar_1.1s_ease-in-out_infinite]" />
                      </div>
                      <div className="flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 size={12} className="animate-spin" /> {t("setup.install.installing")}</div>
                      {job.log.length > 0 && (
                        <pre className="text-[10px] font-mono text-ink-subtle bg-surface-0 rounded-md p-2 max-h-20 overflow-auto whitespace-pre-wrap break-all m-0">
                          {job.log.slice(-6).join("\n")}
                        </pre>
                      )}
                    </div>
                  ) : (
                    <>
                      <button
                        onClick={() => startInstall(id)}
                        disabled={anyInstalling}
                        className="btn-primary w-fit disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {t("setup.install.btn")}
                      </button>
                      {myJobDone && job.status === "done" && (
                        <span className="text-[11px] text-success flex items-center gap-1"><Check size={12} /> {t("setup.install.done")}</span>
                      )}
                      {myJobDone && (job.status === "error" || job.status === "timeout") && (
                        <span className="text-[11px] text-error flex items-start gap-1">
                          <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                          {job.status === "timeout" ? t("setup.install.timeout") : t("setup.install.failed")}{job.error ? ` · ${job.error}` : ""}
                        </span>
                      )}
                    </>
                  )}
                </div>
              )}

              {av?.installed && !av.loggedIn && (
                <div className="flex flex-col gap-1.5 mt-0.5">
                  <div>
                    <div className="text-[10px] text-ink-subtle mb-1">{t("agent.authMode.label")}</div>
                    <div className="flex items-center gap-1.5">
                      {(["subscription", "apikey"] as CliAuthMode[]).map(m => (
                        <button key={m} type="button" onClick={() => setCliAuthMode(s => ({ ...s, [id]: m }))}
                          className={`px-2.5 py-1 rounded-full text-[11px] cursor-pointer border transition-colors ${
                            cliAuthMode[id] === m ? "border-accent bg-accent/10 text-accent" : "border-border bg-surface-2 text-ink-muted hover:border-ink-subtle"
                          }`}>
                          {m === "subscription" ? t('agent.authMode.subscription') : t('agent.authMode.apikey')}
                        </button>
                      ))}
                      {cliAuthMode[id] === "apikey" && (
                        <HelpTip text={id === "claude-code" ? t("agent.authMode.claudeCodeApiKeyNote") : t("agent.authMode.codexApiKeyNote")} />
                      )}
                    </div>
                  </div>

                  {cliAuthMode[id] === "subscription" ? (
                    <>
                      <div className="text-[11px] text-ink-muted">{t("setup.login.desc", { provider: loginNote })}</div>
                      <div className="flex items-center gap-1.5 min-w-0">
                        <code className="flex-1 min-w-0 text-[12px] font-mono text-ink bg-surface-0 rounded-md px-2 py-1 truncate">{loginCmd}</code>
                        <CopyButton text={loginCmd} t={t} />
                      </div>
                      <div className="text-[10px] text-ink-subtle">{t("setup.login.refreshHint")}</div>
                    </>
                  ) : (
                    <CliApiKeyPanel engine={id} t={t} />
                  )}
                </div>
              )}

              {ready && <div className="text-[11px] text-success flex items-center gap-1 mt-0.5"><Check size={12} /> {t("setup.status.ready")}</div>}
            </div>
          );
        })}

        {/* 并列的备选卡:不装任何 CLI,直接用 API Key 驱动团队(deepseek 等) */}
        <div className="card flex flex-col gap-2 border-accent/40 bg-accent/5">
          <div className="flex items-center gap-1.5">
            <KeyRound size={15} className="text-accent shrink-0" />
            <span className="text-[13px] font-medium text-ink">{t("setup.apiKeyCard.title")}</span>
            <HelpTip text={t("setup.apiKeyCard.desc")} />
          </div>
          <button onClick={onUseApiKeyInstead} className="btn-primary w-fit">{t("setup.apiKeyCard.cta")}</button>
        </div>
      </div>

      {triggerError && <div className="text-[11px] text-error">{triggerError}</div>}
      <style>{`@keyframes installbar { 0% { margin-left: -33%; } 100% { margin-left: 100%; } }`}</style>
    </div>
  );
}
