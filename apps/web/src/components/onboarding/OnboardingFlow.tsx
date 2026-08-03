import { useEffect, useMemo, useState } from "react";
import {
  Code2, Briefcase, Rocket, FlaskConical, GraduationCap, User,
  ArrowRight, ArrowLeft, Check, Sparkles, Wrench, Store, Hammer, Download,
  Loader2, Terminal, X, Globe, Search, KeyRound, type LucideIcon,
} from "lucide-react";
import type { CompanyTemplate, UserIdentity, EngineAvailability } from "@opc/shared";
import { useT } from "../../i18n.js";
import * as api from "../../api/client.js";
import { useCommunityStore } from "../../store/useCommunityStore.js";
import { useProviderStore } from "../../store/useProviderStore.js";
import EngineSetupPanel from "../setup/EngineSetupPanel.js";
import {
  markOnboardingDone, recommendTemplates, filterTemplates,
  QUICK_PROVIDERS, PROVIDER_DEFAULT_MODEL, buildQuickProviderConfig,
} from "./onboardingState.js";

// 定稿 2.3(用户 B3 亲自设计的三步)首跑引导:①身份+检测本机订阅 CLI ②准备引擎(有 CLI 可跳过 API 配置,
// 否则复用 EngineSetupPanel 引导装 CLI / 填 key)③模板三选一(推荐/导入/自建)。可随时跳过,跳过后不再骚扰。
//
// 落点由 onDone 的 dest 决定:装了推荐模板→公司页(org);去导入→模板社区(community);自建→模板工坊(workshop)。
// 跳过 / 无落点 → onDone() 不带 dest,停在当前页。完成或跳过都会由 App 侧写 localStorage 完成标记。
export type OnboardingDest = "org" | "workshop" | "community";

interface CliStatusEntry { framework: string; installed: boolean; version: string; loggedIn: boolean }
interface CliStatusResult { engines: CliStatusEntry[]; anyInstalled: boolean; anyLoggedIn: boolean }

const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "kimi-cli": "Kimi Code",
  "grok-build": "Grok Build",
};

// 把第 1 步 cli-status 的探测结果映射成 EngineSetupPanel 认的 EngineAvailability 形状,作为 prop 下传,
// 让第 2 步复用面板时跳过重复探测。四字段完全对齐(framework/installed/loggedIn/version);framework 取值
// 是 AgentFramework 子集(claude-code/codex/gemini-cli),EngineSetupPanel 只匹配前两者,gemini 项无害忽略。
// cli 为 null(还没探回来 / 探测失败)→ 返回 undefined,面板回退到自探,行为不回归。纯函数,便于单测。
export function cliStatusToFrameworks(cli: CliStatusResult | null): EngineAvailability[] | undefined {
  if (!cli) return undefined;
  return cli.engines.map((e) => ({
    framework: e.framework as EngineAvailability["framework"],
    installed: e.installed,
    loggedIn: e.loggedIn,
    version: e.version,
  }));
}

const IDENTITIES: { id: UserIdentity; Icon: LucideIcon }[] = [
  { id: "developer", Icon: Code2 },
  { id: "researcher", Icon: FlaskConical },
  { id: "product", Icon: Briefcase },
  { id: "founder", Icon: Rocket },
  { id: "student", Icon: GraduationCap },
  { id: "other", Icon: User },
];

export default function OnboardingFlow({ onDone }: { onDone: (dest?: OnboardingDest) => void }) {
  const t = useT();
  const [step, setStep] = useState(0);
  const [identity, setIdentity] = useState<UserIdentity | null>(null);

  const [cli, setCli] = useState<CliStatusResult | null>(null);
  const [cliLoading, setCliLoading] = useState(true);

  const [templates, setTemplates] = useState<CompanyTemplate[] | null>(null);
  const [tplError, setTplError] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);
  const installCompany = useCommunityStore((s) => s.installCompany);

  // 第 2 步内嵌「API Key 快速配置」(用户定稿的两段式引导第一段:身份 + 配置 API/订阅都在引导内完成,
  // 绝不把用户踢到配置页丢失引导)。测试链路真实:POST /providers/test 打最省 token 的请求。
  const [showApi, setShowApi] = useState(false);
  const [providerId, setProviderId] = useState<string>("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; latencyMs: number; message: string } | null>(null);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const createProvider = useProviderStore((s) => s.create);

  // 第 3 步「浏览社区模板」内嵌子视图:在引导内直接挑全部社区模板并一键安装。
  // 装完 → finish("org")(markOnboardingDone + 落公司页,不扔回引导起点);返回未装 → 关子视图,停在第 3 步原样。
  const [browsing, setBrowsing] = useState(false);
  const [browseQuery, setBrowseQuery] = useState("");
  const browseList = useMemo(
    () => (templates ? filterTemplates(templates, browseQuery) : []),
    [templates, browseQuery],
  );

  // 身份页同步检测本机订阅 CLI(只测在不在与版本,服务端禁真实模型调用)。探测失败不阻断引导。
  useEffect(() => {
    let alive = true;
    api.get<CliStatusResult>("/onboarding/cli-status")
      .then((r) => { if (alive) { setCli(r); if (!r?.anyInstalled) setShowApi(true); } })
      .catch(() => { if (alive) setShowApi(true); /* 探测失败:按"无订阅 CLI"处理,直接亮出 API 配置 */ })
      .finally(() => { if (alive) setCliLoading(false); });
    return () => { alive = false; };
  }, []);

  // 推荐模板的数据源 = 种子公司模板(/api/community/templates)。第 3 步才用,提前拉好。
  useEffect(() => {
    let alive = true;
    api.get<CompanyTemplate[]>("/community/templates")
      .then((list) => { if (alive) setTemplates(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) { setTemplates([]); setTplError(true); } });
    return () => { alive = false; };
  }, []);

  const recommended = useMemo(
    () => (templates ? recommendTemplates(identity, templates) : []),
    [templates, identity],
  );
  const detectedNames = (cli?.engines ?? []).filter((e) => e.installed).map((e) => CLI_LABEL[e.framework] ?? e.framework);

  // 完成引导 = 同时接通第二段「新手教程」(TutorialHints 读 config.onboarding.tutorial):
  // 走完引导 → tutorial:true(教程条会带用户完成第一个任务:配 key ✓ → 说需求 → 看结果);
  // 顶部 X 跳过 → tutorial:false(用户明确不要被引导,不骚扰)。写 config 失败不阻断收尾。
  const finish = (dest?: OnboardingDest, opts?: { tutorial?: boolean }) => {
    api.post("/config", {
      onboarding: { completed: true, identity: identity ?? "other", tutorial: opts?.tutorial ?? true, completedAt: new Date().toISOString() },
    }).catch(() => { /* config 写失败不阻断:教程条下次仍可经设置手动触发 */ });
    markOnboardingDone();
    onDone(dest);
  };

  // 第 2 步「下一步」:填了 key 就先真建供应商(失败留在本步把原因讲清,成功才进第 3 步);没填直接过。
  const saveKeyAndNext = async () => {
    const cfg = buildQuickProviderConfig(providerId, apiKey, new Date().toISOString());
    if (!cfg) { setStep(2); return; }
    setSavingKey(true);
    setKeyError(null);
    try {
      await createProvider(cfg);
      setStep(2);
    } catch (e: any) {
      setKeyError(t("ob.step2.api.createFailed", { message: e?.message || "" }));
    } finally {
      setSavingKey(false);
    }
  };

  const testProviderKey = async () => {
    const key = apiKey.trim();
    if (!key) return;
    const preset = QUICK_PROVIDERS.find((p) => p.id === providerId)!;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.post<{ ok: boolean; latencyMs: number; message: string }>("/providers/test", {
        apiFormat: preset.apiFormat, baseUrl: preset.baseUrl, apiKey: key, model: PROVIDER_DEFAULT_MODEL[preset.id],
      });
      setTestResult(r);
    } catch (e: any) {
      setTestResult({ ok: false, latencyMs: 0, message: e?.message || t("onboarding.provider.testFailed") });
    } finally {
      setTesting(false);
    }
  };

  // 第 4 步(用户定稿顺序:身份→配引擎→选模板→【自己探索 or 继续引导】):模板步的各出口不再
  // 直接结束,先记住落点进抉择步;用户在第 4 步明确选教程与否,选完才 finish。
  const [pendingDest, setPendingDest] = useState<OnboardingDest | undefined>(undefined);
  const goChoice = (dest?: OnboardingDest) => { setPendingDest(dest); setStep(3); };

  // 推荐模板与「浏览社区模板」子视图共用同一条安装链路(installCompany → 抉择步,落点=公司页)。
  const installTemplate = async (id: string) => {
    setInstalling(id);
    setInstallError(null);
    try {
      await installCompany(id);
      goChoice("org");
    } catch (e: any) {
      setInstallError(t("ob.step3.installFailed", { message: e?.message || "" }));
    } finally {
      setInstalling(null);
    }
  };

  const StepDot = ({ i }: { i: number }) => (
    <div className={`h-1.5 rounded-full transition-all ${i === step ? "w-6 bg-accent" : i < step ? "w-1.5 bg-accent/60" : "w-1.5 bg-surface-2"}`} />
  );

  return (
    <div className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-surface-1 rounded-2xl w-[600px] max-w-full max-h-[90vh] overflow-auto p-7 shadow-2xl border border-hairline">
        {/* 顶部:进度点 + 随时可跳过 */}
        <div className="flex items-center gap-3 mb-5">
          <div className="flex items-center gap-1.5">{[0, 1, 2, 3].map((i) => <StepDot key={i} i={i} />)}</div>
          <div className="flex-1" />
          <button onClick={() => finish(undefined, { tutorial: false })} title={t("ob.skip")}
            className="flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink cursor-pointer bg-transparent border-none">
            {t("ob.skip")} <X size={13} />
          </button>
        </div>

        {step === 0 && (
          <>
            <div className="flex items-center gap-2 text-accent mb-1.5"><Sparkles size={16} /><span className="text-[12px] font-medium tracking-wide">{t("ob.welcome.badge")}</span></div>
            <h2 className="text-xl font-semibold text-ink m-0">{t("ob.step1.title")}</h2>
            <p className="text-[13px] text-ink-muted mt-1.5 mb-4">{t("ob.step1.subtitle")}</p>
            <div className="grid grid-cols-2 gap-2.5">
              {IDENTITIES.map(({ id, Icon }) => (
                <button key={id} onClick={() => setIdentity(id)}
                  className={`text-left p-3 rounded-xl border cursor-pointer transition-colors ${identity === id ? "border-accent bg-accent/10" : "border-hairline bg-surface-2 hover:border-ink-subtle"}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <Icon size={16} className={identity === id ? "text-accent" : "text-ink-muted"} />
                    <span className="text-[13px] font-medium text-ink">{t(`ob.identity.${id}`)}</span>
                  </div>
                  <div className="text-[11px] text-ink-subtle leading-snug">{t(`ob.identity.${id}.desc`)}</div>
                </button>
              ))}
            </div>

            {/* 本机订阅引擎检测结果:即时告诉用户"检测到哪些",供第 2 步决定是否可跳过 API 配置 */}
            <div className="mt-4 flex items-start gap-2 rounded-lg border border-hairline bg-surface-2 px-3 py-2.5 text-[12px] leading-snug">
              <Terminal size={13} className="text-accent shrink-0 mt-0.5" />
              {cliLoading ? (
                <span className="text-ink-muted flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {t("ob.cli.detecting")}</span>
              ) : detectedNames.length > 0 ? (
                <span className="text-ink-muted">{t("ob.cli.detected", { list: detectedNames.join(" · ") })}</span>
              ) : (
                <span className="text-ink-muted">{t("ob.cli.none")}</span>
              )}
            </div>

            <div className="flex justify-end mt-5">
              <button disabled={!identity} onClick={() => setStep(1)}
                className="btn-primary flex items-center gap-1.5 px-4 py-2">
                {t("ob.next")} <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h2 className="text-xl font-semibold text-ink m-0 flex items-center gap-2"><Wrench size={18} className="text-accent" />{t("ob.step2.title")}</h2>
            <p className="text-[13px] text-ink-muted mt-1.5 mb-4">{t("ob.step2.subtitle")}</p>

            {cli?.anyInstalled && (
              <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 p-3.5">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-1"><Check size={15} className="text-accent" />{t("ob.step2.hasCli.title")}</div>
                <div className="text-[12px] text-ink-muted mb-2.5">{t("ob.step2.hasCli.desc")}</div>
                <button onClick={() => setStep(2)} className="btn-primary w-fit">{t("ob.step2.skipApi")}</button>
              </div>
            )}

            {/* 订阅 CLI 路线:面板复用第 1 步的探测结果。「用 API Key」不再把用户踢出引导——就地展开下方表单。 */}
            <EngineSetupPanel initialFrameworks={cliStatusToFrameworks(cli)} onUseApiKeyInstead={() => setShowApi(true)} />

            {/* API Key 路线(内嵌,自废弃的 OnboardingWizard 迁入):选供应商 → 粘 key → 可真实测试 →
                「下一步」时真建供应商(失败留在本步讲清原因,不静默吞)。无订阅 CLI 时自动展开。 */}
            {showApi && (
              <div className="mt-4 rounded-xl border border-hairline bg-surface-2 p-3.5">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-1"><KeyRound size={15} className="text-accent" />{t("ob.step2.api.title")}</div>
                <div className="text-[12px] text-ink-muted mb-2.5">{t("ob.step2.api.desc")}</div>
                <div className="flex gap-2 mb-2.5 flex-wrap">
                  {QUICK_PROVIDERS.map((p) => (
                    <button key={p.id} onClick={() => { setProviderId(p.id); setTestResult(null); }}
                      className={`px-3 py-1.5 rounded-full text-[13px] border cursor-pointer transition-colors ${providerId === p.id ? "border-accent bg-accent/10 text-ink" : "border-hairline bg-surface-1 text-ink-muted hover:border-ink-subtle"}`}>
                      {p.name}
                    </button>
                  ))}
                </div>
                <input type="password" value={apiKey} onChange={(e) => { setApiKey(e.target.value); setTestResult(null); setKeyError(null); }}
                  placeholder={t("ob.step2.api.keyPh", { name: QUICK_PROVIDERS.find((p) => p.id === providerId)?.name ?? "" })}
                  className="w-full rounded-lg border border-hairline bg-surface-1 py-2.5 px-3 text-[13px] text-ink font-mono outline-none focus:border-accent" />
                <div className="text-[11px] text-ink-subtle mt-1.5">
                  {t("ob.step2.api.getAt")}<a href={QUICK_PROVIDERS.find((p) => p.id === providerId)?.website} target="_blank" rel="noreferrer" className="text-accent ml-1">{QUICK_PROVIDERS.find((p) => p.id === providerId)?.website}</a>
                </div>
                <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                  <button onClick={testProviderKey} disabled={testing || !apiKey.trim()}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] border transition-colors ${
                      testing || !apiKey.trim() ? "border-hairline text-ink-subtle cursor-not-allowed" : "border-accent/40 bg-accent/10 text-accent cursor-pointer hover:bg-accent/20"}`}>
                    {testing && <Loader2 size={12} className="animate-spin" />}
                    {testing ? t("onboarding.provider.testing") : t("onboarding.provider.testBtn")}
                  </button>
                  {testResult && (testResult.ok ? (
                    <span className="text-[12px] text-green flex items-center gap-1"><Check size={13} /> {t("onboarding.provider.passed", { ms: String(testResult.latencyMs) })}</span>
                  ) : (
                    <span className="text-[12px] text-error">{t("onboarding.provider.failed", { message: testResult.message })}</span>
                  ))}
                </div>
                {keyError && <div className="text-[11px] text-error mt-2">{keyError}</div>}
              </div>
            )}

            <div className="flex justify-between mt-5">
              <button onClick={() => setStep(0)} className="btn-secondary flex items-center gap-1.5"><ArrowLeft size={14} /> {t("ob.back")}</button>
              <button onClick={saveKeyAndNext} disabled={savingKey}
                className="btn-primary flex items-center gap-1.5 px-4 py-2">
                {savingKey && <Loader2 size={13} className="animate-spin" />}
                {apiKey.trim() ? t("ob.next") : t("ob.step2.api.later")} <ArrowRight size={14} />
              </button>
            </div>
          </>
        )}

        {step === 2 && !browsing && (
          <>
            <h2 className="text-xl font-semibold text-ink m-0">{t("ob.step3.title")}</h2>
            <p className="text-[13px] text-ink-muted mt-1.5 mb-4">{t("ob.step3.subtitle")}</p>

            {/* 推荐模板:按身份从种子公司模板挑 1-2 个,一键装成公司,落到公司页 */}
            <div className="rounded-xl border border-hairline bg-surface-2 p-3.5 mb-3">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-2"><Sparkles size={15} className="text-accent" />{t("ob.step3.recommend.title")}</div>
              <div className="text-[12px] text-ink-muted mb-2.5">{t("ob.step3.recommend.desc")}</div>

              {templates === null ? (
                <div className="text-[12px] text-ink-muted flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> {t("ob.step3.recommend.loading")}</div>
              ) : recommended.length === 0 ? (
                <div className="text-[12px] text-ink-muted">{tplError ? t("ob.step3.recommend.error") : t("ob.step3.recommend.empty")}</div>
              ) : (
                <div className="flex flex-col gap-2">
                  {recommended.map((tpl) => (
                    <div key={tpl.id} className="flex items-center gap-3 rounded-lg border border-hairline bg-surface-1 px-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium text-ink truncate">{tpl.title}</div>
                        <div className="text-[11px] text-ink-subtle truncate">{t("ob.templateAgents", { n: String(tpl.agents?.length ?? 0) })}</div>
                      </div>
                      <button onClick={() => installTemplate(tpl.id)} disabled={!!installing}
                        className="btn-primary shrink-0 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
                        {installing === tpl.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                        {installing === tpl.id ? t("ob.step3.installing") : t("ob.step3.install")}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {installError && <div className="text-[11px] text-error mt-2">{installError}</div>}
            </div>

            {/* 第四入口:想看更多推荐之外的模板 → 在引导内直接浏览全部社区模板并挑选安装(不离开引导)。 */}
            <button onClick={() => { setBrowseQuery(""); setBrowsing(true); }}
              className="w-full text-left p-3.5 mb-3 rounded-xl border border-hairline bg-surface-2 hover:border-ink-subtle cursor-pointer transition-colors">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-1"><Globe size={15} className="text-accent" />{t("ob.step3.browse.title")}</div>
              <div className="text-[11px] text-ink-subtle leading-snug">{t("ob.step3.browse.desc")}</div>
            </button>

            {/* 导入 / 自建:记下落点,进第 4 步抉择(不直接结束) */}
            <div className="grid grid-cols-2 gap-2.5">
              <button onClick={() => goChoice("community")}
                className="text-left p-3.5 rounded-xl border border-hairline bg-surface-2 hover:border-ink-subtle cursor-pointer transition-colors">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-1"><Store size={15} className="text-accent" />{t("ob.step3.import.title")}</div>
                <div className="text-[11px] text-ink-subtle leading-snug">{t("ob.step3.import.desc")}</div>
              </button>
              <button onClick={() => goChoice("workshop")}
                className="text-left p-3.5 rounded-xl border border-hairline bg-surface-2 hover:border-ink-subtle cursor-pointer transition-colors">
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-1"><Hammer size={15} className="text-accent" />{t("ob.step3.build.title")}</div>
                <div className="text-[11px] text-ink-subtle leading-snug">{t("ob.step3.build.desc")}</div>
              </button>
            </div>

            <div className="flex justify-between mt-5">
              <button onClick={() => setStep(1)} className="btn-secondary flex items-center gap-1.5"><ArrowLeft size={14} /> {t("ob.back")}</button>
              <button onClick={() => goChoice()} className="text-[12px] text-ink-muted hover:text-ink cursor-pointer bg-transparent border-none">{t("ob.step3.later")}</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2 className="text-xl font-semibold text-ink m-0">{t("ob.step4.title")}</h2>
            <p className="text-[13px] text-ink-muted mt-1.5 mb-4">{t("ob.step4.subtitle")}</p>
            <div className="grid grid-cols-2 gap-2.5">
              <button onClick={() => finish(pendingDest ?? "org", { tutorial: true })}
                className="text-left p-4 rounded-xl border border-accent bg-accent/10 cursor-pointer transition-colors hover:bg-accent/15">
                <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink mb-1"><Sparkles size={15} className="text-accent" />{t("ob.step4.tutorial.title")}</div>
                <div className="text-[11px] text-ink-muted leading-snug">{t("ob.step4.tutorial.desc")}</div>
              </button>
              <button onClick={() => finish(pendingDest, { tutorial: false })}
                className="text-left p-4 rounded-xl border border-hairline bg-surface-2 hover:border-ink-subtle cursor-pointer transition-colors">
                <div className="text-[14px] font-medium text-ink mb-1">{t("ob.step4.explore.title")}</div>
                <div className="text-[11px] text-ink-subtle leading-snug">{t("ob.step4.explore.desc")}</div>
              </button>
            </div>
            <div className="flex justify-start mt-5">
              <button onClick={() => setStep(2)} className="btn-secondary flex items-center gap-1.5"><ArrowLeft size={14} /> {t("ob.back")}</button>
            </div>
          </>
        )}

        {step === 2 && browsing && (
          <>
            <div className="flex items-center gap-2 mb-3">
              <button onClick={() => setBrowsing(false)} title={t("ob.back")}
                className="flex items-center gap-1 text-[12px] text-ink-muted hover:text-ink cursor-pointer bg-transparent border-none">
                <ArrowLeft size={14} /> {t("ob.back")}
              </button>
              <h2 className="text-base font-semibold text-ink m-0 flex items-center gap-1.5"><Globe size={16} className="text-accent" />{t("ob.browse.title")}</h2>
            </div>

            <div className="relative mb-3">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
              <input value={browseQuery} onChange={(e) => setBrowseQuery(e.target.value)} placeholder={t("ob.browse.searchPh")}
                className="w-full rounded-lg border border-hairline bg-surface-2 py-2 pl-8 pr-3 text-[13px] text-ink outline-none focus:border-accent" />
            </div>

            {templates === null ? (
              <div className="text-[12px] text-ink-muted flex items-center gap-1.5 py-6 justify-center"><Loader2 size={12} className="animate-spin" /> {t("ob.step3.recommend.loading")}</div>
            ) : browseList.length === 0 ? (
              <div className="text-[12px] text-ink-muted py-6 text-center">{tplError ? t("ob.step3.recommend.error") : t("ob.browse.empty")}</div>
            ) : (
              <div className="flex flex-col gap-2 max-h-[46vh] overflow-auto pr-0.5">
                {browseList.map((tpl) => (
                  <div key={tpl.id} className="flex items-center gap-3 rounded-lg border border-hairline bg-surface-1 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">{tpl.title}</div>
                      <div className="text-[11px] text-ink-subtle truncate">{t("ob.templateAgents", { n: String(tpl.agents?.length ?? 0) })}</div>
                    </div>
                    <button onClick={() => installTemplate(tpl.id)} disabled={!!installing}
                      className="btn-primary shrink-0 flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
                      {installing === tpl.id ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
                      {installing === tpl.id ? t("ob.step3.installing") : t("ob.step3.install")}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {installError && <div className="text-[11px] text-error mt-2">{installError}</div>}
          </>
        )}
      </div>
    </div>
  );
}
