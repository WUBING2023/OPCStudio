import { loadConfig } from "../storage/projectStore.js";
import { resolveModelId } from "./modelResolve.js";
import { isProviderAvailable } from "./providerRegistry.js";
import { probeClaudeCodeAsync, probeCodexAsync, probeNativeSubscriptionPassiveAsync } from "./engines/probes.js";

// 系统内部调用仍保留 creative/judge 语义标签，便于 Trace 区分用途；两者统一解析到
// config.systemModel.default。旧版分档配置仅作读取迁移，不再形成两套独立的模型选择。
export type SystemModelKind = "creative" | "judge";

export interface SystemModelChoice {
  framework: string; // 执行方式:订阅(claude-code/codex/gemini-cli)或 API("api";旧配置的 "hermes" 读到即归一)
  provider: string;
  model: string;
}

const FALLBACK: SystemModelChoice = { framework: "api", provider: "deepseek", model: "deepseek-chat" };

// 旧值(只存 {provider,model},无 framework)按 provider/model 推断执行方式——与前端
// lib/framework.defaultFrameworkFor 同一套判据(Claude 系→claude-code 订阅、GPT 系→codex 订阅、
// 其余→API)。读旧写新:老配置照常可读,不写回也能正确解析成三级结构。
export function inferSystemFramework(provider: string, model: string): string {
  const s = `${provider} ${model}`.toLowerCase();
  if (/(anthropic|claude|opus|sonnet|haiku)/.test(s)) return "claude-code";
  if (/(openai|gpt|codex|\bo3\b|\bo4\b)/.test(s)) return "codex";
  return "api";
}

export function inferProviderForModel(model: string, configuredProviders: string[] = []): string {
  const m = model.toLowerCase();
  if (m.includes("/")) return "openrouter";
  if (/claude|opus|sonnet|haiku/.test(m)) return "anthropic";
  if (/gpt|codex|(^|[-_])o[134]($|[-_])/.test(m)) return "openai";
  if (/minimax/.test(m)) return "minimax";
  if (/doubao|seed-/.test(m)) return "doubao";
  if (/llama|qwen|mistral/.test(m)) return "ollama";
  if (/deepseek/.test(m)) return "deepseek";
  return configuredProviders.find(Boolean) ?? FALLBACK.provider;
}

export function resolveSystemModel(projectRoot: string, kind: SystemModelKind): SystemModelChoice {
  try {
    const config = loadConfig(projectRoot);
    // 新配置只有 default。旧配置若曾分档，固定优先 creative，再取 judge，确保两个调用标签
    // 从这一版本起得到完全相同的模型，不再继续放大历史分歧。
    const entry = config.systemModel?.default ?? config.systemModel?.creative ?? config.systemModel?.judge;
    if (entry?.provider && entry?.model) {
      // 读侧 alias:旧配置存的 "hermes"(API 面历史 id)归一为 "api",不改写 config 文件。
      const stored = entry.framework === "hermes" ? "api" : entry.framework;
      const framework = stored || inferSystemFramework(entry.provider, entry.model);
      // 模型 id 按执行方式(framework)分别裁决:
      //  · api(API 面):派发前经 resolveModelId 把裸别名(如 sonnet→claude-sonnet-5)映射成 canonical
      //    id,根治裸别名打 API 的 404;跨族误配/未知自定义串保持原样,交由 callModel 内既有的 resolveModelId
      //    做最终裁决(不在此静默兜底,让配置错误诚实暴露)。
      //  · 订阅/CLI 引擎(claude-code/codex/gemini-cli…):CLI 直接吃自己的别名(sonnet/gpt-5.5 等,见
      //    modelResolve 顶部说明"CLI 订阅引擎不经此函数"),绝不能被 canonical 化——否则 `claude --model
      //    claude-sonnet-5` 撞上 CLI 不认的型号。这里保持配置原值,原样交给引擎执行链。
      let model = entry.model;
      if (framework === "api") {
        const resolved = resolveModelId(entry.provider, entry.model);
        if (resolved.status === "aliased") model = resolved.model;
      }
      return { framework, provider: entry.provider, model };
    }
    if (config.defaultModel) {
      const provider = inferProviderForModel(config.defaultModel, Object.keys(config.apiKeys ?? {}));
      return { framework: inferSystemFramework(provider, config.defaultModel), provider, model: config.defaultModel };
    }
  } catch { /* 配置读取失败(如项目未初始化):退回默认,不阻断调用方 */ }
  return { ...FALLBACK };
}

// ── 无 key 自动订阅替换 ────────────────────────────────────────────────────────
// 某角色解析成 API 面(api)的 provider,但该 provider 没有可用 key 时:若对应订阅 CLI 已安装且登录可用,
// 就自动改走订阅执行,不再直接失败。provider→订阅映射与前端 lib/framework.SUBSCRIPTION_PROVIDER 反向同口径
// (claude-code→anthropic / codex→openai / gemini-cli→google)。未登录不能算可替代路径，否则 Doctor
// 会放行一个真正派发时必然失败的执行器，并阻止继续选择已配置 API 或其他已登录订阅。

// 纯函数 + 依赖注入:副作用(emit 事件 / 抛人话错误)由调用方按 outcome 决定,doctor 与 invoke 复用同一裁决。
export const PROVIDER_SUBSCRIPTION_FALLBACK: Record<string, string> = {
  anthropic: "claude-code",
  openai: "codex",
  google: "gemini-cli",
  gemini: "gemini-cli",
  kimi: "kimi-cli",
  moonshot: "kimi-cli",
  xai: "grok-build",
};

export interface AutoSubscriptionDeps {
  // provider 是否有可用 key(默认:runtime registry 已注册 handler = 有 key)。doctor 注入自己的 providerRegistered。
  hasProviderKey?: (provider: string) => boolean;
  // 订阅 CLI 是否可执行(已安装且登录/ACP 握手成功)。
  isSubscriptionReady?: (framework: string) => Promise<boolean>;
  /** @deprecated 兼容旧调用方；语义同 isSubscriptionReady，不再表示“仅安装”。 */
  isSubscriptionInstalled?: (framework: string) => Promise<boolean>;
}

export type AutoSubscriptionOutcome =
  | { kind: "keep"; choice: SystemModelChoice; reason: "already-subscription" | "has-key" | "no-key-no-subscription" }
  | { kind: "substituted"; choice: SystemModelChoice; from: string; to: string }
  | { kind: "unavailable"; provider: string; subscription: string };

async function defaultSubscriptionReady(framework: string): Promise<boolean> {
  try {
    if (framework === "claude-code") { const av = await probeClaudeCodeAsync(); return av.installed && av.loggedIn; }
    if (framework === "codex") { const av = await probeCodexAsync(); return av.installed && av.loggedIn; }
    if (framework === "gemini-cli" || framework === "kimi-cli" || framework === "grok-build") {
      const av = await probeNativeSubscriptionPassiveAsync(framework);
      return av.installed && av.loggedIn;
    }
  } catch { /* 探测失败按不可用处理 */ }
  return false;
}

export async function resolveAutoSubscription(
  choice: SystemModelChoice,
  deps: AutoSubscriptionDeps = {},
): Promise<AutoSubscriptionOutcome> {
  // 订阅态配置(非 API 面)本就不吃 provider key,原样执行。"hermes" 是 API 面历史 id(读侧 alias)。
  if (choice.framework !== "api" && choice.framework !== "hermes") return { kind: "keep", choice, reason: "already-subscription" };
  const hasKey = deps.hasProviderKey ?? isProviderAvailable;
  if (hasKey(choice.provider)) return { kind: "keep", choice, reason: "has-key" };
  // API 面且无可用 key:看该 provider 有没有已安装且已登录的对应订阅。
  const sub = PROVIDER_SUBSCRIPTION_FALLBACK[choice.provider];
  if (sub) {
    const ready = deps.isSubscriptionReady ?? deps.isSubscriptionInstalled ?? defaultSubscriptionReady;
    if (await ready(sub)) {
      return { kind: "substituted", choice: { framework: sub, provider: choice.provider, model: choice.model }, from: choice.provider, to: sub };
    }
    return { kind: "unavailable", provider: choice.provider, subscription: sub };
  }
  // 无 key 且无订阅映射:交调用方处理(callModel 会照旧抛 ProviderUnavailable;doctor 记为配置漂移)。
  return { kind: "keep", choice, reason: "no-key-no-subscription" };
}
