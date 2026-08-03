import type { EngineAvailability } from "@opc/shared";
import type { ModelCatalog } from "../api/client.js";
import { FRAMEWORK_TO_CATALOG_ENGINE, type SubscriptionFramework } from "./framework.js";

// 能力页「订阅」板块的纯逻辑(与 SubscriptionPage.tsx 视图分离,便于无 DOM 单测)。五种订阅一等执行方式
// (Claude/Codex/Gemini/Kimi/Grok)——每张卡的安装/登录三态、状态点颜色、模型目录来源都由这里推导,
// 与员工面板(AgentDetailsPanel)同款语义(dotColor / catalog source),口径统一。
export const SUBSCRIPTIONS: { fw: SubscriptionFramework; name: string }[] = [
  { fw: "claude-code", name: "Claude Code" },
  { fw: "codex", name: "Codex" },
  { fw: "gemini-cli", name: "Gemini CLI" },
  { fw: "kimi-cli", name: "Kimi Code" },
  { fw: "grok-build", name: "Grok Build" },
];

// 订阅 CLI 的终端登录命令(登录是各家 CLI 的交互式 OAuth,UI 只给指引不代按回车)。
export const SUB_LOGIN_CMD: Record<SubscriptionFramework, string> = {
  "claude-code": "claude",
  codex: "codex login",
  "gemini-cli": "gemini",
  "kimi-cli": "kimi login",
  "grok-build": "grok login",
};

export type SubStatus = "detecting" | "not-installed" | "installed-not-logged-in" | "ready";

// 探针未回(undefined)= 检测中;其余按 installed/loggedIn 两位判三态。
export function subscriptionStatus(av?: EngineAvailability): SubStatus {
  if (!av) return "detecting";
  if (av.installed && av.loggedIn) return "ready";
  if (av.installed) return "installed-not-logged-in";
  return "not-installed";
}

const GREEN = "var(--color-success)";
const AMBER = "var(--color-warning)";
const GRAY = "var(--color-ink-subtle)";

// 状态点颜色(与 AgentDetailsPanel.dotColor 同款):就绪绿、已装未登录琥珀、未装/检测中灰。
export function statusDotColor(av?: EngineAvailability): string {
  switch (subscriptionStatus(av)) {
    case "ready": return GREEN;
    case "installed-not-logged-in": return AMBER;
    default: return GRAY;
  }
}

export interface SubCatalogView {
  installed: boolean;
  source: "acp" | "static";
  modelIds: string[];
  refreshedAt?: string;
}

// 模型目录来源(/api/model-catalog 单一事实源):framework → 目录 engine id(gemini-cli 经 gemini 侦测),
// 取到该订阅段则回报 installed + source(acp 活值 / static 兜底)+ 模型 id 列表;目录未加载/无该段返回 null。
export function catalogViewFor(catalog: ModelCatalog | null, fw: SubscriptionFramework): SubCatalogView | null {
  if (!catalog) return null;
  const engineId = FRAMEWORK_TO_CATALOG_ENGINE[fw];
  const entry = catalog.subscriptions.find(s => s.engine === engineId);
  if (!entry) return null;
  return { installed: entry.installed, source: entry.source, modelIds: entry.models.map(m => m.id), refreshedAt: entry.refreshedAt };
}
