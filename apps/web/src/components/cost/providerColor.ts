// Stable provider → color mapping shared by the monthly chart, provider/model breakdown tables
// and the real-usage panel, so the same provider always reads the same color across the page.
const PROVIDER_COLOR: Record<string, string> = {
  deepseek: "#5e6ad2", anthropic: "#d97757", minimax: "#0d9488",
  doubao: "#8b5cf6", openai: "#10a37f", unknown: "#8b8b96",
};
export const colorForProvider = (p: string): string => PROVIDER_COLOR[p] ?? "#8b8b96";
