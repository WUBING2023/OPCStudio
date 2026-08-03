import type { AgentFramework } from "@opc/shared";

// ── API 执行方式 · 单点判定(写侧一律 "api";读侧双接受存量 "hermes") ─────────────────
// 写侧唯一合法值。全站凡是"写出 framework 值"的地方都用这个常量,不再出现字面 "hermes"。
export const API_FRAMEWORK: AgentFramework = "api";
// 读侧兼容:存量本地草稿/旧模板/旧 agents 仍可能携带 "hermes" 原始值(服务端读侧已由 shared schema
// alias 归一,但 Workshop 本地草稿、本地导入 JSON 不经服务端)——判等一律走这里,镜像 shared schema alias。
export const isApiFramework = (f?: string) => f === "api" || f === "hermes";
// 归一化:hermes/undefined → "api",其余原样。只用于"判等/展示查表"场景;
// 持久化数据(旧卡片/旧草稿)不经此静默改写,写侧新值直接用 API_FRAMEWORK。
export const normalizeFramework = (f?: AgentFramework): AgentFramework =>
  (f == null || f === "hermes" ? API_FRAMEWORK : f);

// P4=A 混合：按模型族选默认执行框架——用 Claude 走 claude-code CLI(订阅,$0,质量高)、用 GPT 走 codex、
// 其余(deepseek/minimax/doubao…)默认走 api 引擎(便宜、可并行、经 MCP 联网)。用户仍可在两级执行方式选择器里手动覆盖。
export function defaultFrameworkFor(provider: string, model: string): AgentFramework {
  const s = `${provider} ${model}`.toLowerCase();
  if (/(anthropic|claude|opus|sonnet|haiku)/.test(s)) return "claude-code";
  if (/(openai|gpt|codex|\bo3\b|\bo4\b)/.test(s)) return "codex";
  return API_FRAMEWORK; // 其余(deepseek/minimax 等)= API 引擎员工(in-process tool-loop,自带工具/记忆/skill)
}

// ── 执行配置三级化(用户定稿 2026-07-10)──────────────────────────────────────
// 第一级=「订阅 / API」两分支;第二级=具体订阅引擎(CC/Codex/Gemini/Kimi/Grok)或 API 供应商;第三级=模型
// (来自 /api/model-catalog 单一事实源)。"API"的内部 framework 值即 "api"(存量数据里的旧值经
// isApiFramework 读侧双接受),UI 层一律只呈现"API"。

// Bug 修复(2026-07-04,活体探测确认):codex 订阅原来给的 gpt-5-codex/o4-mini/o3 三个别名，
// 用真实 codex CLI(0.141.0，ChatGPT 账号登录)逐个探测，三个全部报错 "not supported when using
// Codex with a ChatGPT account"——只有账号自身 config.toml 里配的 gpt-5.5 真的能调通。ChatGPT 订阅
// 能跑哪些模型是账号/套餐相关的，不是像 claude-code 的 sonnet/opus/haiku 那样通用稳定的别名(那三个
// 已用 claude CLI 2.1.199 逐个探测确认可用)，所以这里只给唯一验证过的值，不再堆砌猜测出来的模型名。
// 订阅框架由 shared AgentFramework 持久化。这里保留显式字符串联合，便于 Web 分支在 shared 改动合入前
// 独立类型检查；shared 合入 gemini-cli/kimi-cli/grok-build 后这些值与 AgentFramework 完全一致。
export type SubscriptionFramework = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";
export function isSubscriptionFramework(f: string | undefined): f is SubscriptionFramework {
  return f === "claude-code"
    || f === "codex"
    || f === "gemini-cli"
    || f === "kimi-cli"
    || f === "grok-build";
}
// 目录端点(/api/model-catalog)使用稳定的产品 engine id；framework 则使用运行时 id。
export const FRAMEWORK_TO_CATALOG_ENGINE: Record<SubscriptionFramework, "claude-code" | "codex" | "gemini" | "kimi" | "grok"> = {
  "claude-code": "claude-code",
  codex: "codex",
  "gemini-cli": "gemini",
  "kimi-cli": "kimi",
  "grok-build": "grok",
};

// Ordinary catalog reads and refresh controls must never start an interactive
// OAuth flow. Claude Code and Codex expose non-interactive catalog probes;
// Gemini/Kimi/Grok only refresh through an explicit login or connection test.
export function canRefreshSubscriptionCatalog(framework: SubscriptionFramework): boolean {
  return framework === "claude-code" || framework === "codex";
}
export const CLI_MODEL_ALIASES: Record<SubscriptionFramework, string[]> = {
  "claude-code": ["sonnet", "opus", "haiku"],
  "codex": ["gpt-5.5"],
  "gemini-cli": ["gemini-3-pro", "gemini-2.5-pro", "gemini-2.5-flash"], // 与服务端 SUBSCRIPTION_STATIC_MODELS.gemini 同步;装机后目录走 ACP/探测活值
  // Kimi/Grok 的可用模型随订阅套餐与 CLI 目录变化，未拿到活目录时只表达“使用账号默认”，不伪造型号。
  "kimi-cli": ["default"],
  "grok-build": ["default"],
};

// CLI 订阅框架天然绑定其归属供应商(Claude Code = Anthropic 账号、Codex = OpenAI 账号)——选了这个框架就
// 没有"供应商"可选，防止出现 framework:"claude-code" 却 provider:"deepseek" 的矛盾组合。
export const CLI_FRAMEWORK_PROVIDER: Record<SubscriptionFramework, string> = {
  "claude-code": "anthropic",
  "codex": "openai",
  "gemini-cli": "google",
  "kimi-cli": "moonshot",
  "grok-build": "xai",
};

// 可挂到各订阅执行框架的账号供应商。GLM Coding Plan 不是一个新 ACP 引擎：
// 它以 z-ai 凭据配置 Claude Code 后端，运行时仍走 claude-code ACP。
export const CLI_FRAMEWORK_ACCOUNT_PROVIDERS: Record<SubscriptionFramework, readonly string[]> = {
  "claude-code": ["anthropic", "z-ai"],
  codex: ["openai"],
  "gemini-cli": ["google"],
  "kimi-cli": ["moonshot"],
  "grok-build": ["xai"],
};

// 与服务端 modelRegistry.BUILTIN_MODELS 同步的当代默认(2026-01 世代)。切供应商时把模型同步到该供应商的
// 默认，否则模型会停在旧供应商的值，造成供应商/模型不同步；anthropic 走 API 引擎路径用完整模型 id
// (CLI 别名 sonnet/opus 只属于 claude-code 框架，不能塞进 API 引擎的裸 API 调用里)。
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  deepseek: "deepseek-v4-flash", minimax: "MiniMax-M3", doubao: "doubao-seed-2-0-pro-260215",
  openai: "gpt-5-mini", anthropic: "claude-sonnet-5", openrouter: "deepseek/deepseek-chat", ollama: "llama3.1",
};

export interface Tier1Option {
  id: AgentFramework;
  emoji: string;
  labelKey: string; // i18n key(E2 去硬编码:本文件非组件,由消费组件 t() 渲染)
  blurbKey: string; // 第一级按钮下的一句话说明(i18n key)
  warningKey?: string; // 已知限制/风险提示 i18n key(如实带上;非全部选项都有)
}

// 第一级"执行方式"(用户定稿 2026-07-10):只保留三家订阅 + API 直连,历史上的 9 个第三方 CLI 与
// 自定义 CLI 不再出现在选择器里(framework 类型保留,存量员工不受影响,面板对其显示"已下线"提示)。
// "API"的内部 framework 值即 API_FRAMEWORK("api"),UI 层一律只写 API。
export const SUBSCRIPTION_TIER1: Tier1Option[] = [
  { id: "claude-code", emoji: "🤖", labelKey: "org.executionModeClaudeCodeLabel", blurbKey: "org.executionModeClaudeCodeBlurb" },
  { id: "codex", emoji: "⚡", labelKey: "org.executionModeCodexLabel", blurbKey: "org.executionModeCodexBlurb" },
  { id: "gemini-cli", emoji: "✨", labelKey: "org.executionModeGeminiCliLabel", blurbKey: "org.executionModeGeminiCliBlurb", warningKey: "org.executionModeGeminiCliWarning" },
  { id: "kimi-cli" as AgentFramework, emoji: "K", labelKey: "org.executionModeKimiCliLabel", blurbKey: "org.executionModeKimiCliBlurb" },
  { id: "grok-build" as AgentFramework, emoji: "x", labelKey: "org.executionModeGrokBuildLabel", blurbKey: "org.executionModeGrokBuildBlurb" },
];
export const EXECUTION_TIER1: Tier1Option[] = [
  ...SUBSCRIPTION_TIER1,
  { id: API_FRAMEWORK, emoji: "🔌", labelKey: "org.executionModeApiLabel", blurbKey: "org.executionModeApiBlurb" },
];

// 订阅引擎品牌徽标(用户定稿:三订阅用其主要形象,如 CC)。CSP 自包含不许外链图,用字母徽+品牌主色。
export const SUBSCRIPTION_BRAND: Record<SubscriptionFramework, { mono: string; bg: string }> = {
  "claude-code": { mono: "CC", bg: "#CC785C" },
  codex: { mono: "Cx", bg: "#10A37F" },
  "gemini-cli": { mono: "G", bg: "#4285F4" },
  "kimi-cli": { mono: "K", bg: "#111111" },
  "grok-build": { mono: "x", bg: "#1D1D1F" },
};

// 切第一级"执行方式"时，一次性算出自洽的 {framework, provider, model} 落地补丁——调用方应把三个字段作为
// 同一个 update()/patch 调用发出去，避免出现 framework 已切、provider 还没跟上的中间矛盾态。
// - 切到 CLI 订阅(claude-code/codex)：provider 锁定为该订阅归属的供应商；model 若已是合法别名则保留，否则取别名表第一个。
// - 切到 api(API 引擎)：provider 保留当前值(API 面下 provider 仍是 deepseek/anthropic 等真实供应商，见现有
//   agents.json 里 framework:"api" + provider:"anthropic"/"deepseek" 等组合)；但如果当前 model 是一个 CLI
//   模型别名(在 API 语境下没有意义)，换成该 provider 的默认模型。
export function patchForTier1(
  next: AgentFramework,
  current: { provider: string; model: string },
  providerDefaultModel: Record<string, string> = PROVIDER_DEFAULT_MODEL,
): { framework: AgentFramework; provider: string; model: string } {
  if (isSubscriptionFramework(next)) {
    const aliases = CLI_MODEL_ALIASES[next];
    const provider = CLI_FRAMEWORK_PROVIDER[next];
    const model = aliases.includes(current.model) ? current.model : aliases[0];
    return { framework: next, provider, model };
  }
  // next 是 api(API 引擎)或 12+1 扩展里那 9 个 GenericCliEngine 预设之一 + 裸 generic-cli——它们都用
  // "供应商 + 模型"这套自由文本第二级 UI（不是 CLI 别名下拉），framework 直接落成 next 本身。
  // Bug 修复(2026-07)：这里以前硬编码返回 API 面的 framework 值，导致点其它 tier1 选项(如 gemini-cli)
  // 看起来什么都没发生——因为 framework 又被这里强行改了回去。
  const allAliases: string[] = Object.values(CLI_MODEL_ALIASES).flat();
  const model = allAliases.includes(current.model)
    ? (providerDefaultModel[current.provider] || current.model)
    : current.model;
  return { framework: next, provider: current.provider, model };
}

// 三级模型选择 · 目录外即时校验(供节点配置的模型下拉警告态)。模型非空、目录非空、且不在目录内
// (大小写不敏感)→ true。目录未加载/为空(如订阅 CLI 未装)时不误报;canonical 命中或空模型返回 false。
// 专治用户痛点"选模型名是难点 + HTTP 404 model:sonnet":旧配置把 CLI 别名 sonnet 落在 API 面时
// 即在 UI 高亮告警。
// extraAllowed:订阅引擎的合法 CLI 别名表(CLI_MODEL_ALIASES[engine])。ACP 活体目录上线后,claude-code
// 目录真值是 default/sonnet/haiku(不含 opus——default 即 opus),但 opus 仍是 claude CLI 合法输入;把
// 该引擎别名并入"目录内"判据,防止真值目录上线后既有 opus 等合法别名被误告警。API 面不传(空)。
export function isModelOutsideCatalog(catalogModelIds: string[], model: string, extraAllowed: string[] = []): boolean {
  const m = (model || "").trim().toLowerCase();
  if (!m) return false;
  if (!catalogModelIds || catalogModelIds.length === 0) return false;
  const allowed = [...catalogModelIds, ...extraAllowed];
  return !allowed.some((id) => id.toLowerCase() === m);
}

// C: 已配置优先——把"有账号(已配置 key/登录)"的 provider 排在下拉前面。configured 来自 /api/accounts
// 的 providerId 集合。返回排序后的去重列表(configured 在前，保持各自原有相对顺序)。
export function sortConfiguredFirst(providerIds: string[], configured: Set<string>): string[] {
  const seen = new Set<string>();
  const uniq = providerIds.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return [...uniq.filter((p) => configured.has(p)), ...uniq.filter((p) => !configured.has(p))];
}
