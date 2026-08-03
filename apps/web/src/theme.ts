import { create } from "zustand";

// v6 C3 — 主题：浅色 / 深色 / 跟随系统。应用方式 = 在 <html> 上设 .light/.dark 类
// （index.css 的 html.light / html.dark 覆盖 CSS 变量）。system 监听 prefers-color-scheme。
export type ThemeMode = "light" | "dark" | "system";

function systemPrefersDark(): boolean {
  try { return window.matchMedia("(prefers-color-scheme: dark)").matches; } catch { return true; }
}

function applyTheme(mode: ThemeMode) {
  try {
    const effective = mode === "system" ? (systemPrefersDark() ? "dark" : "light") : mode;
    const el = document.documentElement;
    el.classList.remove("light", "dark");
    el.classList.add(effective);
  } catch { /* ignore */ }
}

function initialMode(): ThemeMode {
  try {
    const saved = localStorage.getItem("opc-theme") as ThemeMode | null;
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch { /* ignore */ }
  return "system"; // v8 ChatGPT pass:默认跟随系统(与 ChatGPT 网页一致;此前历史默认深色)
}

interface ThemeStore { mode: ThemeMode; setMode: (m: ThemeMode) => void; }
export const useTheme = create<ThemeStore>((set) => {
  const mode = initialMode();
  applyTheme(mode);
  // system 模式下跟随系统切换实时更新
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (useTheme.getState().mode === "system") applyTheme("system");
    });
  } catch { /* ignore */ }
  return {
    mode,
    setMode: (m) => {
      try { localStorage.setItem("opc-theme", m); } catch { /* ignore */ }
      applyTheme(m);
      set({ mode: m });
    },
  };
});
