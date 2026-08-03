import * as fs from "node:fs";
import * as path from "node:path";
import type { PricingMap, PriceEntry } from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";

// 键 = canonical 模型 id(与 modelResolve/BUILTIN_MODELS 同代)。默认系统模型(claude-sonnet-5 / claude-opus-4-8 /
// gpt-5.1)必须在表内,否则 estimateCostFromPricing 返回 undefined → 成本报 0。历史键仅为存量节点旧 id 兜底。
const DEFAULT_PRICES: PricingMap = {
  // Anthropic(canonical)
  "claude-sonnet-5": { input: 3.00, output: 15.00 },
  "claude-opus-4-8": { input: 15.00, output: 75.00 },
  "claude-haiku-4-5": { input: 1.00, output: 5.00 },
  // OpenAI(canonical)
  "gpt-5.1": { input: 1.25, output: 10.00 },
  "gpt-5": { input: 1.25, output: 10.00 },
  "gpt-5-mini": { input: 0.25, output: 2.00 },
  "gpt-5-nano": { input: 0.05, output: 0.40 },
  "o3": { input: 2.00, output: 8.00 },
  // 其他供应商
  "deepseek-v4-pro": { input: 0.435, output: 0.87 },
  "deepseek-v4-flash": { input: 0.14, output: 0.28 },
  "MiniMax-M3": { input: 0.30, output: 1.20 },
  "doubao-seed-2-0-pro-260215": { input: 0.47, output: 2.37 },
  // 历史键(仅存量节点旧 id 兜底)
  "gpt-4.1": { input: 2.00, output: 8.00 },
  "gpt-4.1-mini": { input: 0.40, output: 1.60 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

function pricingPath(projectRoot: string) {
  return path.join(projectRoot, ".opc", "pricing.json");
}

export function loadPricing(projectRoot: string): PricingMap {
  const p = pricingPath(projectRoot);
  if (!fs.existsSync(p)) {
    writeJSON(p, DEFAULT_PRICES);
    console.log("[pricingStore] Seeded default pricing");
    return { ...DEFAULT_PRICES };
  }
  // 默认单价作基底、用户 pricing.json 覆盖之:存量安装(早于新 canonical 键播种)也能查到 claude-sonnet-5 /
  // claude-opus-4-8 / gpt-5.x 的价,不再对默认系统模型报 undefined 成本;用户手改的价仍优先(不回退)。
  // 仅内存合并,不改盘上文件(savePricing 时才落用户实际配置)。
  return { ...DEFAULT_PRICES, ...readJSON<PricingMap>(p, DEFAULT_PRICES) };
}

export function savePricing(projectRoot: string, pricing: PricingMap) {
  writeJSON(pricingPath(projectRoot), pricing);
}

export function getModelPrice(projectRoot: string, model: string): PriceEntry | undefined {
  const pricing = loadPricing(projectRoot);
  return pricing[model];
}

export function estimateCostFromPricing(projectRoot: string, model: string, promptTokens: number, completionTokens: number): number | undefined {
  const p = getModelPrice(projectRoot, model);
  if (!p) return undefined;
  return (promptTokens / 1_000_000) * p.input + (completionTokens / 1_000_000) * p.output;
}
