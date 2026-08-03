import { useState, useEffect, lazy, Suspense } from "react";
import { Sparkles, Server, Plug, Coins, CreditCard, LayoutGrid, type LucideIcon } from "lucide-react";
import { useT } from "../i18n.js";
import HelpTip from "../components/HelpTip.js";

// C4(主导航 9→7):"能力"一级入口把每个能力收成独立板块 = 总览 + 订阅 + API + MCP + 技能 + 成本概览。
// 组件本体不改,只是从 App.tsx 的顶级路由收进这里的 tab。
// 「订阅」与「API 连接」分离(用户定稿"订阅就是订阅"):三订阅(claude-code/codex/gemini-cli)是一等
// 执行方式,独立成板块(SubscriptionPage);ProviderSettingsPage 回归纯 API 供应商/key 管理。
// E4(P2-58):新增「总览」首 tab(默认)——A2A/ACP/记忆/模板四张能力卡,一等呈现产品四能力。
const CapabilityOverview = lazy(() => import("../components/capability/CapabilityOverview.js"));
const SubscriptionPage = lazy(() => import("./SubscriptionPage.js"));
const SkillsPage = lazy(() => import("./SkillsPage.js"));
const McpPage = lazy(() => import("./McpPage.js"));
const ProviderSettingsPage = lazy(() => import("./ProviderSettingsPage.js"));
const CostPage = lazy(() => import("./CostPage.js"));

type CapabilityTab = "overview" | "subscription" | "api" | "mcp" | "skills" | "cost";

// 板块顺序:总览(四能力卡)领衔,执行方式(订阅 / API)其次,工具(MCP / 技能)再次,成本总览收尾。
// 订阅紧邻 API 且各有独立标题,边界清楚。导出供板块渲染逻辑单测(总览居首、订阅与 API 分离、键唯一、
// 订阅先于 API)。
export const CAPABILITY_TABS: { key: CapabilityTab; Icon: LucideIcon; labelKey: string }[] = [
  { key: "overview", Icon: LayoutGrid, labelKey: "capability.overview" },
  { key: "subscription", Icon: CreditCard, labelKey: "capability.subscription" },
  { key: "api", Icon: Plug, labelKey: "nav.api" },
  { key: "mcp", Icon: Server, labelKey: "nav.mcp" },
  { key: "skills", Icon: Sparkles, labelKey: "nav.skills" },
  { key: "cost", Icon: Coins, labelKey: "nav.cost" },
];

// 跨页契约(opc-navigate,同 App.tsx open-task-run 的双通道惯例):派发方在 detail 里除 page:"capability"
// 外可附带 tab;本页已挂载时直接消费同一事件,首次挂载(lazy)时从 sessionStorage 补取。
function readPendingTab(): CapabilityTab | null {
  try {
    const saved = sessionStorage.getItem("opc-capability-tab");
    if (saved) { sessionStorage.removeItem("opc-capability-tab"); return saved as CapabilityTab; }
  } catch { /* */ }
  return null;
}

export default function CapabilityPage() {
  const t = useT();
  const [tab, setTab] = useState<CapabilityTab>(() => readPendingTab() ?? "overview");

  useEffect(() => {
    const onNav = (e: Event) => {
      const detail = (e as CustomEvent).detail as { page?: string; tab?: string } | undefined;
      if (detail?.page === "capability" && detail?.tab) setTab(detail.tab as CapabilityTab);
    };
    window.addEventListener("opc-navigate", onNav);
    return () => window.removeEventListener("opc-navigate", onNav);
  }, []);

  return (
    <div className="h-full flex flex-col bg-bg-primary">
      <div className="shrink-0 px-6 pt-5 pb-3 border-b border-hairline">
        <div className="flex items-center gap-1.5 mb-3">
          <h1 className="text-[16px] font-semibold text-ink m-0">{t("capability.title")}</h1>
          <HelpTip text={t("capability.subtitle")} />
        </div>
        <div className="flex gap-1 p-1 rounded-lg bg-surface-1 border border-hairline max-w-2xl">
          {CAPABILITY_TABS.map(item => {
            const active = tab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setTab(item.key)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 h-8 rounded-md border-none cursor-pointer text-[13px] font-medium whitespace-nowrap transition-colors ${
                  active ? "bg-accent text-white" : "bg-transparent text-ink-muted hover:text-ink hover:bg-surface-2"
                }`}
              >
                <item.Icon size={14} />
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <Suspense fallback={<div className="h-full flex items-center justify-center text-ink-subtle text-[13px]">…</div>}>
          {tab === "overview" && <CapabilityOverview />}
          {tab === "subscription" && <SubscriptionPage />}
          {tab === "api" && <ProviderSettingsPage />}
          {tab === "mcp" && <McpPage />}
          {tab === "skills" && <SkillsPage />}
          {tab === "cost" && <CostPage />}
        </Suspense>
      </div>
    </div>
  );
}
