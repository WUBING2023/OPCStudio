import { PRESET_PROVIDERS, type ApiFormat } from "@opc/shared";
import { loadProviders } from "../storage/providerStore.js";
import { resolveProviderKey } from "./providerRegistry.js";
import { safeFetch } from "../security/localGuards.js";

// Representative models per preset provider (selectable in the UI). Live sync via /v1/models
// augments this; users can also enter a custom model string. Kept short on purpose (a few
// representative choices) per the design — not an exhaustive dump.
export const BUILTIN_MODELS: Record<string, string[]> = {
  deepseek: ["deepseek-v4-pro", "deepseek-v4-flash", "deepseek-chat", "deepseek-reasoner"],
  minimax: ["MiniMax-M3", "MiniMax-Text-01"],
  doubao: ["doubao-seed-2-0-pro-260215", "doubao-pro-32k", "doubao-lite-32k"],
  openai: ["gpt-5.1", "gpt-5", "gpt-5-mini", "gpt-5-nano", "o3"],
  anthropic: ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"],
  openrouter: ["anthropic/claude-sonnet-5", "openai/gpt-5.1", "deepseek/deepseek-chat", "google/gemini-3-pro"],
  ollama: ["llama3.1", "qwen2.5", "mistral"],
};

// live /v1/models 是全家桶(openai 会回吐 whisper/embeddings/dall-e/gpt-3.5 等几十个)——
// 用户实测下拉被过时/非对话模型淹没。只保留对话向、非古董的,并限量。
const LIVE_MODEL_BLOCKLIST = /embed|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|search|davinci|babbage|curie|ada|gpt-3\.5|gpt-4-\d|instruct|batch|codex-mini/i;
function filterLiveModels(ids: string[]): string[] {
  return ids.filter((id) => !LIVE_MODEL_BLOCKLIST.test(id)).slice(0, 24);
}

const PRESET_META = Object.fromEntries(
  PRESET_PROVIDERS.filter((provider) => provider.id !== "custom").map((provider) => [provider.id, provider]),
);

const cache = new Map<string, { models: string[]; at: number }>();
const TTL = 5 * 60 * 1000;

async function fetchLiveModels(
  baseUrl: string,
  key: string,
  apiFormat: ApiFormat,
  allowLocalNetwork = false,
  allowSyntheticProxyAddress = false,
): Promise<string[]> {
  const url = baseUrl.replace(/\/+$/, "") + "/models";
  const headers: Record<string, string> = apiFormat === "anthropic"
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : apiFormat === "gemini"
      ? { "x-goog-api-key": key }
      : key
        ? { Authorization: `Bearer ${key}` }
        : {};
  const r = await safeFetch(url, { headers, signal: AbortSignal.timeout(8000) }, { allowLocalNetwork, allowSyntheticProxyAddress });
  if (!r.ok) throw new Error(`models ${r.status}`);
  const j: any = await r.json();
  const data: any[] = j.data ?? j.models ?? [];
  return data
    .map((model) => model.id ?? model.name)
    .filter((value): value is string => typeof value === "string")
    .map((value) => apiFormat === "gemini" ? value.replace(/^models\//, "") : value);
}

// Models for a provider: live (synced + merged with builtin) when a key+baseUrl are known, else
// builtin. Cached 5 min. Never throws — falls back to builtin.
export async function listModels(projectRoot: string, providerId: string): Promise<{ models: string[]; source: "live" | "builtin" | "cached"; error?: string }> {
  const builtin = BUILTIN_MODELS[providerId] ?? [];
  const preset = PRESET_META[providerId];
  let baseUrl = preset?.baseUrl;
  let key = resolveProviderKey(projectRoot, providerId);
  let apiFormat: ApiFormat = preset?.apiFormat ?? "openai";
  const custom = loadProviders(projectRoot).find((p) => p.id === providerId);
  let allowLocalNetwork = providerId === "ollama";
  if (custom) {
    baseUrl = custom.baseUrl;
    key = custom.apiKey || key;
    apiFormat = custom.apiFormat;
    allowLocalNetwork = custom.allowLocalNetwork === true || custom.kind === "local" || custom.apiFormat === "ollama";
  }

  const keyRequired = apiFormat !== "ollama";
  if (!baseUrl) return { models: builtin, source: "builtin", error: "provider base URL is not configured" };
  if (keyRequired && !key) return { models: builtin, source: "builtin", error: "provider API key is not configured" };
  const cached = cache.get(providerId);
  if (cached && Date.now() - cached.at < TTL) return { models: cached.models, source: "cached" };
  try {
    const candidateUrl = new URL(baseUrl);
    const presetUrl = preset?.baseUrl ? new URL(preset.baseUrl) : undefined;
    const allowSyntheticProxyAddress = !!presetUrl
      && candidateUrl.protocol === "https:"
      && candidateUrl.hostname === presetUrl.hostname
      && candidateUrl.port === presetUrl.port;
    const live = await fetchLiveModels(baseUrl, key ?? "", apiFormat, allowLocalNetwork, allowSyntheticProxyAddress);
    const merged = Array.from(new Set([...builtin, ...filterLiveModels(live)]));
    cache.set(providerId, { models: merged, at: Date.now() });
    return { models: merged, source: "live" };
  } catch (error) {
    return {
      models: builtin,
      source: "builtin",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function clearModelCache(providerId?: string) {
  if (providerId) cache.delete(providerId); else cache.clear();
}
