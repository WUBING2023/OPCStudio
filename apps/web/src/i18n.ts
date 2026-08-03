import { useCallback } from "react";
import { create } from "zustand";
import RAW_DICTS from "./i18n.dict.json";

// v6 C1 — 轻量 i18n:11 种世界主要语言。核心 UI 串全覆盖,未覆盖键回退英文(不出乱码/占位)。
// RTL(阿拉伯语)切 document.dir。语言持久化 + 首次按 navigator.language 猜测。
// v9:字典外置到 i18n.dict.json(单一来源,scripts/i18n-fill.mjs 用 deepseek 批量补齐非 en/zh 语言)。
export type Lang = "en" | "zh-CN" | "zh-TW" | "es" | "hi" | "ar" | "pt" | "ru" | "ja" | "fr" | "de";

export const LANGS: { code: Lang; label: string; dir: "ltr" | "rtl" }[] = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "zh-CN", label: "简体中文", dir: "ltr" },
  { code: "zh-TW", label: "繁體中文", dir: "ltr" },
  { code: "es", label: "Español", dir: "ltr" },
  { code: "hi", label: "हिन्दी", dir: "ltr" },
  { code: "ar", label: "العربية", dir: "rtl" },
  { code: "pt", label: "Português", dir: "ltr" },
  { code: "ru", label: "Русский", dir: "ltr" },
  { code: "ja", label: "日本語", dir: "ltr" },
  { code: "fr", label: "Français", dir: "ltr" },
  { code: "de", label: "Deutsch", dir: "ltr" },
];

// key → 每语言文案。en 为基准与回退。内容在 i18n.dict.json(勿在此内联,脚本以 JSON 为单一来源)。
type Dict = Record<string, string>;
export const DICTS = RAW_DICTS as unknown as Record<Lang, Dict>;

function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("opc-lang") as Lang | null;
    if (saved && DICTS[saved]) return saved;
    const nav = (navigator.language || "en").toLowerCase();
    if (nav.startsWith("zh")) return nav.includes("tw") || nav.includes("hk") ? "zh-TW" : "zh-CN";
    const two = nav.slice(0, 2);
    const hit = LANGS.find(l => l.code === two);
    return (hit?.code as Lang) ?? "en";
  } catch { return "en"; }
}

function applyDir(lang: Lang) {
  try {
    const dir = LANGS.find(l => l.code === lang)?.dir ?? "ltr";
    document.documentElement.setAttribute("dir", dir);
    document.documentElement.setAttribute("lang", lang);
  } catch { /* ignore (SSR) */ }
}

interface I18nStore { lang: Lang; setLang: (l: Lang) => void; }
export const useI18n = create<I18nStore>((set) => {
  const initial = detectLang();
  applyDir(initial);
  return {
    lang: initial,
    setLang: (lang) => {
      try { localStorage.setItem("opc-lang", lang); } catch { /* ignore */ }
      applyDir(lang);
      set({ lang });
    },
  };
});

// 占位插值：把模板里的 {name} 用 params 替换；缺失占位原样保留。
function interpolate(s: string, params?: Record<string, string | number>): string {
  if (!params) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

// 翻译：当前语言缺该 key → 回退英文 → 回退 key 本身（永不出空/乱码）。可选 params 做 {占位} 插值。
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = useI18n.getState().lang;
  return interpolate(DICTS[lang]?.[key] ?? DICTS.en[key] ?? key, params);
}

// React hook：组件订阅 lang 变化后重渲染，再用 t()。
// 复审修复:返回函数用 useCallback 锁定(deps=[lang])——否则每次渲染都是新闭包,任何把 tr 放进
// useMemo/useEffect deps 的调用方(BriefingPanel.entries、AgentRail.companyName…)记忆化全部失效。
export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useI18n((s) => s.lang);
  return useCallback((key, params) => interpolate(DICTS[lang]?.[key] ?? DICTS.en[key] ?? key, params), [lang]);
}
