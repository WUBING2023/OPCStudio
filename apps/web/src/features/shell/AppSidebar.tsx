import {
  Brain, Building2, Coins, CreditCard, Languages, LayoutDashboard, FolderKanban,
  Monitor, Moon, Plug, Server, Settings, Sparkles, Store, Sun, type LucideIcon,
} from "lucide-react";
import { LANGS, useI18n, useT } from "../../i18n.js";
import { useTheme, type ThemeMode } from "../../theme.js";
import type { AppPage } from "../../lib/navigation.js";

type ContentPage = Exclude<AppPage, "settings">;
type NavItem = { id: ContentPage; Icon: LucideIcon; labelKey: string; descKey?: string };

const NAV_ITEMS: NavItem[] = [
  { id: "org", Icon: Building2, labelKey: "nav.org", descKey: "nav.desc.org" },
  { id: "cockpit", Icon: LayoutDashboard, labelKey: "nav.cockpit", descKey: "nav.desc.cockpit" },
  { id: "results", Icon: FolderKanban, labelKey: "nav.results", descKey: "nav.desc.results" },
  { id: "memory", Icon: Brain, labelKey: "nav.memory", descKey: "nav.desc.memory" },
  { id: "subscription", Icon: CreditCard, labelKey: "capability.subscription" },
  { id: "api", Icon: Plug, labelKey: "nav.api" },
  { id: "mcp", Icon: Server, labelKey: "nav.mcp" },
  { id: "skills", Icon: Sparkles, labelKey: "nav.skills" },
  { id: "cost", Icon: Coins, labelKey: "nav.cost" },
  { id: "community", Icon: Store, labelKey: "nav.community", descKey: "nav.desc.community" },
];

export default function AppSidebar({
  expanded,
  page,
  onNavigate,
  onOpenSettings,
}: {
  expanded: boolean;
  page: ContentPage;
  onNavigate: (page: ContentPage) => void;
  onOpenSettings: () => void;
}) {
  const tr = useT();
  const lang = useI18n((state) => state.lang);
  const setLang = useI18n((state) => state.setLang);
  const themeMode = useTheme((state) => state.mode);
  const setThemeMode = useTheme((state) => state.setMode);

  return (
    <aside
      className="shrink-0 flex flex-col border-r border-hairline bg-surface-0 transition-[width] duration-200 overflow-hidden"
      style={{ width: expanded ? 248 : 56 }}
    >
      <nav className="flex-1 py-2 px-2 overflow-y-auto" aria-label={tr("app.navigation")}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            title={item.descKey ? `${tr(item.labelKey)} - ${tr(item.descKey)}` : tr(item.labelKey)}
            aria-current={page === item.id ? "page" : undefined}
            className={`w-full flex items-center gap-2.5 px-2 h-9 mb-0.5 rounded-[10px] border-none cursor-pointer transition-colors select-none ${
              page === item.id ? "bg-surface-2 text-ink" : "bg-transparent text-ink-muted hover:bg-surface-2/60 hover:text-ink"
            }`}
          >
            <span className="w-6 flex items-center justify-center shrink-0"><item.Icon size={17} strokeWidth={1.75} /></span>
            <span className="text-[13px] font-medium whitespace-nowrap transition-opacity duration-200" style={{ opacity: expanded ? 1 : 0 }}>
              {tr(item.labelKey)}
            </span>
          </button>
        ))}
      </nav>

      <div className="px-2 pt-1 shrink-0" title={tr("common.theme")}>
        <div className="flex items-center gap-2 px-2 h-9 rounded-lg text-ink-muted">
          <span className="w-6 flex items-center justify-center shrink-0">
            {themeMode === "light" ? <Sun size={15} /> : themeMode === "dark" ? <Moon size={15} /> : <Monitor size={15} />}
          </span>
          {expanded && (
            <div className="flex-1 flex gap-1">
              {(["light", "dark", "system"] as ThemeMode[]).map((mode) => {
                const Icon = mode === "light" ? Sun : mode === "dark" ? Moon : Monitor;
                return (
                  <button key={mode} onClick={() => setThemeMode(mode)} title={tr(`theme.${mode}`)}
                    className={`flex-1 flex items-center justify-center h-6 rounded-full cursor-pointer transition-colors border-none ${themeMode === mode ? "bg-surface-1 text-ink shadow-sm" : "bg-surface-2 text-ink-muted hover:text-ink"}`}>
                    <Icon size={13} />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="px-2 pt-1 pb-0.5 shrink-0" title={tr("common.language")}>
        <div className="flex items-center gap-2 px-2 h-9 rounded-lg text-ink-muted hover:bg-surface-2 transition-colors">
          <span className="w-6 flex items-center justify-center shrink-0"><Languages size={15} /></span>
          {expanded && (
            <select value={lang} onChange={(event) => setLang(event.target.value as typeof lang)}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-[13px] text-ink cursor-pointer">
              {LANGS.map((entry) => <option key={entry.code} value={entry.code} className="bg-surface-1 text-ink">{entry.label}</option>)}
            </select>
          )}
        </div>
      </div>

      <button
        onClick={onOpenSettings}
        title={tr("nav.settings")}
        className="w-full flex items-center gap-3 px-4 h-10 border-none cursor-pointer bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors shrink-0"
        style={{ borderTopWidth: 1, borderTopStyle: "solid", borderTopColor: "var(--color-hairline)" }}
      >
        <span className="w-6 text-center shrink-0 flex items-center justify-center"><Settings size={16} /></span>
        <span className="text-[13px] font-medium whitespace-nowrap transition-opacity duration-200" style={{ opacity: expanded ? 1 : 0 }}>
          {tr("nav.settings")}
        </span>
      </button>
    </aside>
  );
}
