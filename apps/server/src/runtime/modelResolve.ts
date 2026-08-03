// 三级模型选择 · 执行面别名解析与 404 根治(用户实测:选订阅/供应商 API 时模型加载不对 +
// "API call failed after 3 retries: HTTP 404: model: sonnet")。本模块是"目录 + 别名"的单一事实源:
//   · SUBSCRIPTION_STATIC_MODELS —— 订阅引擎(claude-code/codex/gemini)的静态兜底模型表(ACP 握手
//     失败/未装时用它,标 source:"static";与 web/lib/framework 的 CLI 别名同源)。
//   · API_PROVIDER_ALIASES —— API 供应商(anthropic/openai)的裸别名→canonical id 映射,专治把 CLI
//     别名(sonnet/opus/haiku/gpt-5.5)误落到 Hermes/裸 API 路径导致的 404 model-not-found。
//   · resolveModelId(provider, model) —— 执行面(API 面)解析:目录命中原样过;裸别名映射为 canonical
//     并标 aliased(调用方据此 emit model_alias_resolved);跨族误配(如 provider=deepseek 却填 sonnet)
//     或空模型 → rejected,带可读理由(指明哪一级没选对),调用方据此在**打 API 之前**拒绝、绝不重试。
//   · ModelNotFoundError —— 不可重试的模型配置错误标记;消息含 "model not found",既便于路由把它按
//     restricted(而非 failed→重试3次)处理,也便于 modelGateway 不把它记进 provider 健康熔断器。

// 订阅引擎的规范模型(id + 展示名 + 默认)。ACP 握手拿到 availableModels 时覆盖它(source:"acp");
// 拿不到(CLI 未装/握手失败)时作静态兜底(source:"static")。id 与真实 CLI 接受的别名一致:
//  · claude-code:claude CLI(订阅登录)接受 sonnet/opus/haiku 通用别名(已探测确认)。
//  · codex:ChatGPT 订阅能跑哪些型号因账号/套餐而异,只列唯一验证过的 gpt-5.5。
//  · gemini:未装、待 OAuth 后补探;给当代已知 id 作兜底,前端允许手输。
export interface CatalogModel { id: string; label: string; isDefault?: boolean }

export const SUBSCRIPTION_STATIC_MODELS: Record<string, CatalogModel[]> = {
  "claude-code": [
    { id: "sonnet", label: "Sonnet(claude-sonnet-5)", isDefault: true },
    { id: "opus", label: "Opus(claude-opus-4-8)" },
    { id: "haiku", label: "Haiku(claude-haiku-4-5)" },
  ],
  codex: [
    { id: "gpt-5.5", label: "gpt-5.5", isDefault: true },
  ],
  gemini: [
    { id: "gemini-3-pro", label: "gemini-3-pro", isDefault: true },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
    { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
  ],
  // Kimi/Grok 的订阅可用型号由账号和 CLI 版本决定。ACP 握手失败时保持空表，绝不编造型号。
  kimi: [],
  grok: [],
};

export const SUBSCRIPTION_ENGINES = ["claude-code", "codex", "gemini", "kimi", "grok"] as const;
export type SubscriptionEngine = (typeof SUBSCRIPTION_ENGINES)[number];

// provider → 供应商族(决定用哪张别名表)。只有 anthropic/openai 有裸别名逃逸到 API 面的现实风险
// (它们对应 CLI 订阅的 claude/codex);其余供应商各自成族、无别名映射(裸串照原样过,由供应商 API 裁决)。
function providerFamily(provider: string): "anthropic" | "openai" | "other" {
  const p = (provider || "").toLowerCase();
  if (p === "anthropic") return "anthropic";
  if (p === "openai") return "openai";
  return "other";
}

// API 面的裸别名 → canonical 模型 id(按供应商族)。键覆盖:CLI 订阅别名(sonnet/opus/haiku、gpt-5.5)+
// 常见历史简称(gpt-4o、claude-3-5-sonnet 等)。canonical 值与 modelRegistry.BUILTIN_MODELS 同代。
// 这些是"这个裸串属于哪一族"的判据:命中且供应商同族 → 映射;命中但供应商异族 → 拒绝并指明矛盾。
export const API_PROVIDER_ALIASES: Record<"anthropic" | "openai", Record<string, string>> = {
  anthropic: {
    sonnet: "claude-sonnet-5",
    opus: "claude-opus-4-8",
    haiku: "claude-haiku-4-5",
    "claude-sonnet": "claude-sonnet-5",
    "claude-opus": "claude-opus-4-8",
    "claude-haiku": "claude-haiku-4-5",
    "claude-3-5-sonnet": "claude-sonnet-5",
    "claude-3-5-haiku": "claude-haiku-4-5",
    "claude-3-sonnet": "claude-sonnet-5",
    "claude-3-opus": "claude-opus-4-8",
    "claude-3-haiku": "claude-haiku-4-5",
    "claude-sonnet-4": "claude-sonnet-5",
    "claude-sonnet-4-5": "claude-sonnet-5",
    "claude-sonnet-4-6": "claude-sonnet-5", // 修复:此前漏了 4-6,导致大量存量 agent 把陈旧 ID 直发 API(不升级)
    "claude-opus-4": "claude-opus-4-8",
    "claude-opus-4-1": "claude-opus-4-8",
    "claude-opus-4-5": "claude-opus-4-8",
    "claude-opus-4-6": "claude-opus-4-8",
  },
  openai: {
    "gpt-5.5": "gpt-5.1",
    "gpt-4o": "gpt-5",
    "gpt-4o-mini": "gpt-5-mini",
    "gpt-4": "gpt-5",
    "gpt-4-turbo": "gpt-5",
    "gpt-4.1": "gpt-5",
    "gpt-4.1-mini": "gpt-5-mini",
    "gpt-3.5-turbo": "gpt-5-nano",
    "o4-mini": "o3",
    "o1": "o3",
    "o1-mini": "o3",
  },
};

// 哪些裸别名"暗示"某一族(供跨族误配检测)。凡出现在任一族别名表键里的串,都归该族。
function aliasFamily(model: string): "anthropic" | "openai" | null {
  const m = model.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(API_PROVIDER_ALIASES.anthropic, m)) return "anthropic";
  if (Object.prototype.hasOwnProperty.call(API_PROVIDER_ALIASES.openai, m)) return "openai";
  return null;
}

// 不可重试的模型配置错误。消息刻意以 "Model not found" 起头:
//  1) HermesEngine.run 的 restricted 正则含 "not found",命中即判 restricted(不进 attempt 重试循环)。
//  2) modelGateway 据 instanceof 跳过 provider 健康熔断记账(供应商本身没坏,是模型选错了)。
export class ModelNotFoundError extends Error {
  constructor(
    public readonly provider: string,
    public readonly model: string,
    reason: string,
  ) {
    super(`Model not found: ${reason}`);
    this.name = "ModelNotFoundError";
  }
}

export type ResolveResult =
  | { status: "ok"; model: string }                                   // 目录命中或无法判定的自定义串,原样过
  | { status: "aliased"; model: string; from: string }                // 裸别名 → canonical,已映射
  | { status: "rejected"; reason: string; model: string; provider: string };

// 执行面(API/Hermes 面)模型解析。CLI 订阅引擎(claude-code/codex)不经此函数——它们把 sonnet 等别名
// 直接交给 CLI,是合法的;本函数只治"裸别名逃逸到 API 面"这一类 404。
// 规则(顺序即优先级):
//   1) 空串 → 交由 provider 默认(不拒绝;有些系统级调用允许空)。
//   2) 命中该 provider 的 canonical 目录(catalogModels 传入,或内建 anthropic/openai)→ ok 原样。
//   3) 命中该供应商族的别名表 → aliased 映射为 canonical。
//   4) 是"别的族"的别名(如 provider=deepseek/anthropic 却填了 openai 族的 gpt-4o,或反之)→ rejected,
//      理由指明"这个模型属于 X 族,但你选的供应商是 Y——去改供应商或改模型"。
//   5) 其余未知串 → ok 原样过(可能是用户新填的自定义型号;前端已即时警告,供应商 API 会给准确裁决)。
export function resolveModelId(
  provider: string,
  model: string,
  catalogModels?: string[],
): ResolveResult {
  const raw = (model ?? "").trim();
  if (!raw) return { status: "ok", model: raw };

  const fam = providerFamily(provider);
  const lower = raw.toLowerCase();

  // (2) 目录命中原样过。优先用调用方给的目录(live/custom),否则用内建静态族目录。
  const known = catalogModels && catalogModels.length ? catalogModels : builtinFor(fam);
  if (known.some((m) => m.toLowerCase() === lower)) return { status: "ok", model: raw };

  // (3) 同族别名映射。
  if (fam === "anthropic" || fam === "openai") {
    const canonical = API_PROVIDER_ALIASES[fam][lower];
    if (canonical) return { status: "aliased", model: canonical, from: raw };
  }

  // (4) 跨族误配:这个裸串是某一族的别名,但当前供应商不属于那一族 → 拒绝并指明矛盾。
  const impliedFam = aliasFamily(raw);
  if (impliedFam && impliedFam !== fam) {
    const canonical = API_PROVIDER_ALIASES[impliedFam][lower];
    const engine = impliedFam === "anthropic" ? "Claude(claude-code 订阅 / anthropic 供应商)" : "OpenAI(codex 订阅 / openai 供应商)";
    const reason = `"${raw}" 是 ${engine} 的模型别名(应解析为 ${canonical}),但此节点的供应商是 "${provider || "(未设)"}"。请把供应商改为 ${impliedFam}、或改选一个属于 "${provider}" 的模型——别名不会被灌到不匹配的供应商上。`;
    return { status: "rejected", reason, model: raw, provider };
  }

  // (5) 未知自定义串:放行(前端已警告目录外;真正合法与否交给供应商 API)。
  return { status: "ok", model: raw };
}

// 内建 canonical 目录(与 modelRegistry.BUILTIN_MODELS 同代,避免跨模块运行时依赖;仅作解析的"命中集")。
function builtinFor(fam: "anthropic" | "openai" | "other"): string[] {
  if (fam === "anthropic") return ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];
  if (fam === "openai") return ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-5-nano", "o3"];
  return [];
}

// modelGateway/供应商 handler 用:把 provider API 的 4xx 报文识别成"模型不存在"(→ ModelNotFoundError,
// 不可重试、不记熔断)。覆盖 Anthropic/OpenAI 兼容端点的常见 404/400 model-not-found 文案。
export function isModelNotFoundResponse(status: number, body: string): boolean {
  if (status === 404) return true;
  if (status === 400) {
    return /model[^\n]{0,40}(not found|does not exist|not exist|invalid|unknown|unsupported|not available)|(unknown|invalid|unsupported)[^\n]{0,20}model|no such model/i.test(body || "");
  }
  return false;
}
