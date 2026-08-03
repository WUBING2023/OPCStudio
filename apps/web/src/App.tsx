import { useState, useEffect, lazy, Suspense, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { PanelLeft } from "lucide-react";
import { useAgentStore } from "./store/useAgentStore.js";
import { useCockpitStore } from "./store/useCockpitStore.js";
import SettingsPage from "./pages/SettingsPage.js";
import OrgPage from "./pages/OrgPage.js";
// P2#11 代码分割:首页(OrgPage)静态引入保证首屏;其余页面 React.lazy 按需加载,
// reactflow/markdown 等重依赖不再全部挤进单一入口 chunk。
// C4(主导航 9→7):技能/MCP/API/成本四个原顶级页收进 CapabilityPage 内部 tab(懒加载挪到那边)。
const CockpitPage = lazy(() => import("./pages/CockpitPage.js"));
const CommunityPage = lazy(() => import("./pages/CommunityPage.js"));
const ResultsPage = lazy(() => import("./pages/ResultsPage.js"));
const MemoryPage = lazy(() => import("./pages/MemoryPage.js"));
// 拆分导航(用户定稿):原「能力」页的五个板块提为侧栏一级入口,CapabilityPage 壳退役。
const SubscriptionPage = lazy(() => import("./pages/SubscriptionPage.js"));
const ProviderSettingsPage = lazy(() => import("./pages/ProviderSettingsPage.js"));
const McpPage = lazy(() => import("./pages/McpPage.js"));
const SkillsPage = lazy(() => import("./pages/SkillsPage.js"));
const CostPage = lazy(() => import("./pages/CostPage.js"));
const EmbeddedEcosystemPage = lazy(() => import("./features/ecosystem/EmbeddedEcosystemPage.js"));
import OnboardingFlow, { type OnboardingDest } from "./components/onboarding/OnboardingFlow.js";
import { shouldShowOnboarding, isOnboardingDone } from "./components/onboarding/onboardingState.js";
import TutorialHints from "./components/TutorialHints.js";
const TemplateWorkshop = lazy(() => import("./components/community/TemplateWorkshop.js"));
import { ToastHost } from "./components/common/Toast.js";
import { ConfirmHost } from "./components/common/ConfirmDialog.js";
import PostmortemModal, { isPostmortemMuted, type PostmortemData } from "./components/common/PostmortemModal.js";
import DoctorPanel from "./components/common/DoctorPanel.js";
import ErrorBoundary from "./components/common/ErrorBoundary.js";
import AppSidebar from "./features/shell/AppSidebar.js";
import FirstRunEntry, { type FirstRunDestination } from "./features/onboarding/FirstRunEntry.js";
import * as api from "./api/client.js";
import { getSessionToken } from "./lib/sessionToken.js";
import { useT, t } from "./i18n.js";
import type { TraceEvent, ProjectConfig } from "@opc/shared";
import { observeControlHints } from "./lib/controlHints.js";
import {
  currentAppRoute,
  navigateApp,
  subscribeAppRoute,
  type AppPage,
  type AppRoute,
} from "./lib/navigation.js";
import {
  parseEmbeddedEcosystemRoute,
  subscribeEmbeddedEcosystemRoute,
} from "./features/ecosystem/routes.js";
import { readWebFeatureFlags } from "./features/ecosystem/runtimeFlags.js";


// 导航拆分(用户定稿,取代 C4 的 9→7 收纳):原「能力」页五个板块(订阅/API/MCP/技能/成本)
// 提为侧栏一级入口,分组在「能力」小节标题下;CapabilityPage 壳退役。"设置"沿用既有设计,
// 不进 NAV_ITEMS/Page 联合类型,保留为侧栏底部独立入口(打开 SettingsPage 覆层)。
type Page = Exclude<AppPage, "settings">;

const CURRENT_VERSION = "0.1.0";

// 跨页契约兼容:旧派发方仍发 {page:"capability", tab}(命令面板 /cost、MCP 安装成功跳转等),
// 这里映射到拆分后的新页 id;无 tab 时落到组内第一项「订阅」。
const CAPABILITY_TAB_TO_PAGE: Record<string, Page> = {
  overview: "subscription", subscription: "subscription", api: "api",
  mcp: "mcp", skills: "skills", cost: "cost",
};

const pageVariants = {
  initial: { opacity: 0, y: 6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -4 },
};

export default function App() {
  useEffect(() => observeControlHints(), []);
  const [route, setRoute] = useState<AppRoute>(currentAppRoute);
  const [embeddedRoute, setEmbeddedRoute] = useState(() =>
    typeof window === "undefined" ? null : parseEmbeddedEcosystemRoute(window.location.hash),
  );
  const [featureFlags] = useState(() =>
    readWebFeatureFlags(CURRENT_VERSION, import.meta.env as Readonly<Record<string, unknown>>),
  );
  const embeddedMode = featureFlags.OPC_EMBEDDED_PLUGIN_UI && embeddedRoute !== null;
  const page: Page = route.page === "settings" ? "org" : route.page;
  const settingsOpen = route.page === "settings";
  const settingsReturnRoute = useRef<AppRoute>({ page: "org" });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("opc-sidebar-collapsed") === "true"; } catch { return false; }
  });
  const load = useAgentStore(s => s.load);
  const addEvent = useAgentStore(s => s.addEvent);
  const tr = useT();
  const [updateBanner, setUpdateBanner] = useState<{ version: string; url: string } | null>(null);
  // 定稿 2.3 首跑引导:首跑判定 = 无任何公司(companies 空)且未在 localStorage 标记完成。可随时跳过,
  // 跳过后写完成标记不再骚扰(设置→关于「重看新手引导」仍可手动触发)。落点由 OnboardingFlow 的 dest 决定。
  const [firstRun, setFirstRun] = useState(false);
  const [showOnboardingManual, setShowOnboardingManual] = useState(false); // 设置→关于「重看新手引导」手动触发
  const [workshopOpen, setWorkshopOpen] = useState(false); // 引导选「自建」→ 直接挂模板工坊(空白起点)
  const [showTutorial, setShowTutorial] = useState(false);
  useEffect(() => {
    const unsubscribe = subscribeAppRoute(setRoute);
    if (!window.location.hash) {
      let companyId: string | undefined;
      try { companyId = localStorage.getItem("opc-org-company") || undefined; } catch { /* ignore */ }
      navigateApp({ page: "org", companyId }, { replace: true });
    }
    return unsubscribe;
  }, []);
  useEffect(() => subscribeEmbeddedEcosystemRoute(setEmbeddedRoute), []);

  const preferredCompanyId = () => {
    if (route.companyId) return route.companyId;
    try { return localStorage.getItem("opc-org-company") || "default"; } catch { return "default"; }
  };
  const goToPage = (nextPage: Page) => {
    const companyId = preferredCompanyId();
    if (nextPage === "org" || nextPage === "cockpit" || nextPage === "results" || nextPage === "cost") {
      navigateApp({ page: nextPage, companyId });
    } else {
      navigateApp({ page: nextPage });
    }
  };
  const openSettings = () => {
    settingsReturnRoute.current = route.page === "settings" ? { page: "org", companyId: preferredCompanyId() } : route;
    navigateApp({ page: "settings" });
  };
  const closeSettings = () => navigateApp(settingsReturnRoute.current, { replace: true });
  const refreshOnboarding = () => api.get<ProjectConfig>("/config")
    .then(c => { setShowTutorial(!!c?.onboarding?.completed && !!c?.onboarding?.tutorial); })
    .catch(() => { /* 取不到 config 不阻断 */ });
  useEffect(() => { refreshOnboarding(); }, []);
  // 首跑判定真源 = config.onboarding.completed(旧口径按"无公司"判,安装态 server 兜底内建
  // default 公司导致引导在安装包里永远不弹——活体抓出)。取不到 config 不弹,避免误弹。
  useEffect(() => {
    if (isOnboardingDone()) return; // 本机完成/跳过过就不再自动弹
    api.get<ProjectConfig>("/config")
      .then(c => setFirstRun(shouldShowOnboarding({ configCompleted: !!c?.onboarding?.completed, done: false })))
      .catch(() => { /* 取不到 config:不弹 */ });
  }, []);
  const handleOnboardingDone = (dest?: OnboardingDest | FirstRunDestination) => {
    setFirstRun(false);
    setShowOnboardingManual(false);
    // 两段式引导第二段:引导刚写完 config.onboarding(completed+tutorial),立刻重读把
    // TutorialHints 教程条亮起来(否则要等下次刷新,新手教程链在当次会话里是断的)。
    refreshOnboarding();
    if (dest === "org") goToPage("org");
    else if (dest === "community") goToPage("community");
    else if (dest === "workshop") setWorkshopOpen(true);
    else if (dest === "subscription") goToPage("subscription");
  };

  const toggleSidebar = () => setSidebarCollapsed(v => {
    const n = !v;
    try { localStorage.setItem("opc-sidebar-collapsed", String(n)); } catch {}
    return n;
  });

  // 事件流断了(后端重启/网络抖动)之前完全没提示,界面看着像"卡死"。EventSource 会自动重连,
  // 这里只是把断线状态露出来:onerror 置位 + console.warn,重连成功(onopen)后自动消失。
  const [connectionLost, setConnectionLost] = useState(false);
  // Track C · C1 失败复盘卡:run_finished(failed/降级)→ fetch postmortem → available 则弹卡。
  const [postmortem, setPostmortem] = useState<PostmortemData | null>(null);
  useEffect(() => { load(); }, []);
  useEffect(() => {
    // 令五.6:SSE(EventSource 不能设自定义 header)用 query token 携带凭证。GET 只读服务端放行,
    // 这里仍带上以保持一致并覆盖未来收紧。token 异步解析(见 lib/sessionToken),解析完再建流。
    let es: EventSource | null = null;
    let cancelled = false;
    (async () => {
      const token = await getSessionToken();
      if (cancelled) return;
      const url = token ? `/api/events?opcSessionToken=${encodeURIComponent(token)}` : "/api/events";
      es = new EventSource(url);
      wireEventSource(es);
    })();
    return () => { cancelled = true; es?.close(); };
  }, []);

  function wireEventSource(es: EventSource) {
    es.onmessage = (e) => {
      // MUP B5:收到任何数据即视为连接健康,幂等清横幅(代理链路上 onopen 可能丢失;同值 setState 会 bail out)。
      setConnectionLost(false);
      try {
        const ev = JSON.parse(e.data) as TraceEvent;
        addEvent(ev);
        if (ev.type === "run_finished") {
          load();
          // 异步任务闭环(审计 P1#13):用户挂机/睡觉跑任务,完成时发系统通知——诚实报结果(失败/延后数如实说)。
          try {
            const p = (ev.payload ?? {}) as { runId?: string; failed?: boolean; deferredCount?: number; allClean?: boolean };
            // 文案用非 hook 的 t():本 effect 依赖 [],hook 版 tr 会永远停在挂载时的语言。
            const title = p.failed ? t("notify.runFailed") : p.allClean ? t("notify.runDone") : t("notify.runDeferred", { n: p.deferredCount ?? 0 });
            const body = t("notify.clickToView", { id: (p.runId ?? "").slice(0, 8) });
            const fire = () => { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); navigateApp({ page: "results", runId: p.runId }); }; };
            if (typeof Notification !== "undefined") {
              if (Notification.permission === "granted") fire();
              else if (Notification.permission !== "denied") Notification.requestPermission().then(g => { if (g === "granted") fire(); }).catch(() => { /* 权限请求失败不产生噪声 */ });
            }
          } catch { /* 通知失败不影响任何功能 */ }
          // C1 失败复盘卡:failed 或非全净(降级/有延后)时拉 postmortem;端点自己判定 available
          // (成功且无失败信号返回 available:false,不弹)。会话级"不再自动弹出"开关可静音。
          try {
            const p = (ev.payload ?? {}) as { runId?: string; failed?: boolean; allClean?: boolean };
            if (p.runId && (p.failed || p.allClean === false) && !isPostmortemMuted()) {
              fetch(`/api/runs/${p.runId}/postmortem`)
                .then(r => (r.ok ? r.json() : null))
                .then((pm: PostmortemData | null) => { if (pm?.available) setPostmortem(pm); })
                .catch(() => { /* 复盘卡拉取失败不产生噪声 */ });
            }
          } catch { /* 复盘卡失败不影响任何功能 */ }
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => {
      console.warn("[SSE] /api/events disconnected, waiting for auto-reconnect…");
      setConnectionLost(true);
    };
    es.onopen = () => setConnectionLost(false);
  }

  // org 页右键「打开聊天」→ 切到工作台并选中该员工会话。
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent).detail?.agentId;
      if (id) {
        useCockpitStore.getState().setActiveAgent(id);
        const agent = useAgentStore.getState().agents.find((entry) => entry.id === id);
        navigateApp({ page: "cockpit", companyId: agent?.companyId || preferredCompanyId(), agentId: id });
      }
    };
    window.addEventListener("cockpit-open-agent", open);
    return () => window.removeEventListener("cockpit-open-agent", open);
  }, []);

  // 旧跨页事件保留一个版本周期,但只作为正式路由的适配器;刷新后的真相来自 URL。
  useEffect(() => {
    const openRun = (e: Event) => {
      const runId = (e as CustomEvent).detail?.runId;
      const companyId = (e as CustomEvent).detail?.companyId;
      if (runId) navigateApp({ page: "results", runId: String(runId), companyId: companyId || undefined });
    };
    window.addEventListener("open-task-run", openRun);
    return () => window.removeEventListener("open-task-run", openRun);
  }, []);

  useEffect(() => {
    const openMemory = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (!detail?.memoryId) return;
      try { sessionStorage.setItem("opc-open-memory", JSON.stringify(detail)); } catch { /* ignore */ }
      navigateApp({ page: "memory", memoryId: String(detail.memoryId), companyId: detail.companyId || undefined });
    };
    window.addEventListener("open-memory-item", openMemory);
    return () => window.removeEventListener("open-memory-item", openMemory);
  }, []);

  useEffect(() => {
    if (route.page !== "memory" || !route.memoryId) return;
    const detail = { memoryId: route.memoryId, companyId: route.companyId };
    try { sessionStorage.setItem("opc-open-memory", JSON.stringify(detail)); } catch { /* ignore */ }
    const timer = window.setTimeout(() => window.dispatchEvent(new CustomEvent("open-memory-item", { detail })), 0);
    return () => window.clearTimeout(timer);
  }, [route.page, route.memoryId, route.companyId]);

  // 跨页契约:命令面板(/cost /memory /templates 等)派发 opc-navigate{page[,tab]} → 切到对应页。
  // 白名单校验:未知 page 忽略,不让任意事件把 UI 切到不存在的页面。旧契约 {page:"capability", tab}
  // 经 CAPABILITY_TAB_TO_PAGE 映射到拆分后的新页 id(派发方无需改动)。
  useEffect(() => {
    const PAGES = new Set<Page>(["org", "cockpit", "results", "memory", "subscription", "api", "mcp", "skills", "cost", "community"]);
    const nav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { page?: string; tab?: string } | undefined;
      let p = detail?.page as Page | undefined;
      if (detail?.page === "capability") p = CAPABILITY_TAB_TO_PAGE[detail?.tab ?? ""] ?? "subscription";
      if (!p || !PAGES.has(p)) return;
      const companyId = detail?.page === "org" || detail?.page === "cockpit" || detail?.page === "results" || detail?.page === "cost"
        ? preferredCompanyId()
        : undefined;
      navigateApp({ page: p, companyId });
    };
    window.addEventListener("opc-navigate", nav);
    return () => window.removeEventListener("opc-navigate", nav);
  }, []);

  // 设置→关于:重看新手引导 / 预览首跑启动台(后者切到组织页,由 OrgPage 监听同名事件强制显示)。
  useEffect(() => {
    const onb = () => setShowOnboardingManual(true);
    const lp = () => goToPage("org");
    window.addEventListener("open-onboarding", onb);
    window.addEventListener("open-launchpad", lp);
    return () => { window.removeEventListener("open-onboarding", onb); window.removeEventListener("open-launchpad", lp); };
  }, []);

  useEffect(() => {
    const updaterUrl = String(import.meta.env.VITE_OPC_UPDATER_URL ?? "").trim();
    if (!updaterUrl) return;
    fetch(updaterUrl)
      .then(r => r.json())
      .then(data => {
        if (data.version && data.version !== CURRENT_VERSION && data.downloadUrl) {
          setUpdateBanner({ version: data.version, url: data.downloadUrl });
        }
      })
      .catch(() => {});
  }, []);

  const prefersReducedMotion = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const expanded = !sidebarCollapsed;

  return (
    <div className="h-screen flex flex-col font-sans" style={{ background: "var(--color-canvas)" }}>
      {firstRun && <FirstRunEntry onDone={handleOnboardingDone} />}
      {showOnboardingManual && <OnboardingFlow onDone={handleOnboardingDone} />}
      {workshopOpen && (
        <Suspense fallback={null}>
          <TemplateWorkshop onClose={() => setWorkshopOpen(false)} onSaved={() => { setWorkshopOpen(false); goToPage("community"); }} />
        </Suspense>
      )}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <SettingsPage onClose={closeSettings} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top bar — ChatGPT 式:与主画布同底,仅极淡分隔线 */}
      <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-hairline bg-canvas">
        <button
          onClick={toggleSidebar}
          title={sidebarCollapsed ? tr("app.sidebar.expand") : tr("app.sidebar.collapse")}
          className="w-8 h-8 flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted cursor-pointer hover:bg-surface-2 hover:text-ink transition-colors"
        >
          <PanelLeft size={16} />
        </button>
        <span className="text-ink font-bold text-[13px] tracking-tight select-none">OPC Studio</span>
        <div className="flex-1" />
        {/* Track E · E2:全局体检徽标(✅/⚠️/❌)+ 点击弹 checks 明细 */}
        <DoctorPanel />
      </div>

      {/* Body: sidebar + main */}
      <div className="flex-1 flex min-h-0">
        {!embeddedMode && <AppSidebar expanded={expanded} page={page} onNavigate={goToPage} onOpenSettings={openSettings} />}

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* 实时事件流断线提示（SSE onerror,自动重连成功后自动消失） */}
          {connectionLost && (
            <div className="px-4 py-1.5 text-[12px] text-center shrink-0 text-white" style={{ background: "var(--color-warning)" }}>
              {tr("app.connectionLost")}
            </div>
          )}

          {/* Update Banner */}
          {updateBanner && (
            <div className="px-4 py-2 bg-accent text-white text-[13px] text-center flex items-center justify-center gap-4 shrink-0">
              <span>{tr("app.update.available", { version: updateBanner.version })}</span>
              <a href={updateBanner.url} target="_blank" rel="noopener noreferrer"
                className="text-white underline font-medium hover:no-underline">
                {tr("app.update.download")}
              </a>
              <button onClick={() => setUpdateBanner(null)}
                className="border border-white/30 rounded px-2 py-0.5 text-[11px] bg-transparent text-white cursor-pointer hover:bg-white/10">
                {tr("app.update.dismiss")}
              </button>
            </div>
          )}

          {/* v4 O4: 新手教程三步提示条（引导里选了"要教程"时显示，可关闭） */}
          {showTutorial && !embeddedMode && <TutorialHints companyId={route.companyId || preferredCompanyId()} />}

          <div className="flex-1 overflow-auto">
            {/* 深度体验 QA 抓出的黑屏死锁:懒加载页面在 motion.div **内部** suspend 会打断 framer-motion
                的进场动画,恢复后卡死在 initial(opacity:0)——内容在但全透明,且无任何报错。
                修法:Suspense 提到 AnimatePresence **外层**,chunk 就绪后 motion.div 才挂载,进场动画完整。 */}
            <ErrorBoundary resetKey={embeddedMode ? `ecosystem:${embeddedRoute?.runId ?? ""}` : page}>
            <Suspense fallback={<div className="h-full flex items-center justify-center text-ink-subtle text-[13px]">…</div>}>
                <motion.div
                  key={embeddedMode ? `ecosystem:${embeddedRoute?.runId ?? ""}` : page}
                  initial={prefersReducedMotion ? {} : pageVariants.initial}
                  animate={prefersReducedMotion ? {} : pageVariants.animate}
                  exit={prefersReducedMotion ? {} : pageVariants.exit}
                  transition={{ duration: 0.15 }}
                  className="h-full"
                >
                  {embeddedMode && embeddedRoute && (
                    <EmbeddedEcosystemPage
                      route={embeddedRoute}
                      onOpenRun={(runId, companyId) => {
                        setEmbeddedRoute(null);
                        navigateApp({ page: "results", runId, companyId });
                      }}
                    />
                  )}
                  {!embeddedMode && page === "org" && <OrgPage routeCompanyId={route.companyId} />}
                  {!embeddedMode && page === "cockpit" && <CockpitPage routeCompanyId={route.companyId} routeRunId={route.runId} routeAgentId={route.agentId} />}
                  {!embeddedMode && page === "results" && <ResultsPage routeCompanyId={route.companyId} routeRunId={route.runId} />}
                  {!embeddedMode && page === "memory" && <MemoryPage />}
                  {!embeddedMode && page === "subscription" && <SubscriptionPage />}
                  {!embeddedMode && page === "api" && <ProviderSettingsPage />}
                  {!embeddedMode && page === "mcp" && <McpPage />}
                  {!embeddedMode && page === "skills" && <SkillsPage />}
                  {!embeddedMode && page === "cost" && <CostPage />}
                  {!embeddedMode && page === "community" && <CommunityPage />}
                </motion.div>
            </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      </div>

      {/* C1 失败复盘卡:run 失败/降级时自动弹出(可会话级静音)。 */}
      <AnimatePresence>
        {postmortem && <PostmortemModal postmortem={postmortem} onClose={() => setPostmortem(null)} />}
      </AnimatePresence>

      {/* 全局反馈层:替代原生 alert()/confirm() 的 toast + confirm 弹层,任意页面/store 均可调用。 */}
      <ToastHost />
      <ConfirmHost />
    </div>
  );
}
