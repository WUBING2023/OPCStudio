import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../storage/projectStore.js";
import { loadProviders, loadAccounts } from "../storage/providerStore.js";
import { registerProvider, createOpenAICompatProvider, createAnthropicProvider, getHandler } from "./modelGateway.js";
import { DEFAULT_MODELS, PRESET_PROVIDERS } from "@opc/shared";

// 公网 preset 只信任与内置 HTTPS endpoint 完全相同的 origin，并仅放行代理软件常用的
// RFC 2544 198.18.0.0/15 Fake-IP；其它私网、loopback、metadata 地址仍由 SSRF guard 拒绝。
// 自定义/本地 provider 只有用户显式 allowLocalNetwork 或 kind=local 时才放行本地网络。
type ProviderFetchOptions = {
  allowLocalNetwork?: boolean;
  allowSyntheticProxyAddress?: boolean;
};

function normalizeProviderUrl(value: string | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "").toLowerCase();
}

export function canonicalProviderId(provider: { id: string; baseUrl?: string; name?: string }): string | undefined {
  const baseUrl = normalizeProviderUrl(provider.baseUrl);
  const byId = PRESET_PROVIDERS.find((preset) => preset.id === provider.id && preset.id !== "custom");
  if (byId && (!baseUrl || normalizeProviderUrl(byId.baseUrl) === baseUrl)) return provider.id;
  if (!baseUrl) return undefined;
  return PRESET_PROVIDERS.find((preset) => preset.id !== "custom" && normalizeProviderUrl(preset.baseUrl) === baseUrl)?.id;
}

export function providerNetworkOptions(
  providerId: string,
  baseUrl: string | undefined,
  explicitAllowLocalNetwork = false,
  kind?: string,
): ProviderFetchOptions {
  if (explicitAllowLocalNetwork || kind === "local") return { allowLocalNetwork: true };
  const canonical = canonicalProviderId({ id: providerId, baseUrl });
  const preset = canonical ? PRESET_PROVIDERS.find((item) => item.id === canonical) : undefined;
  if (!preset?.baseUrl || !baseUrl) return {};
  try {
    const candidate = new URL(baseUrl);
    const trusted = new URL(preset.baseUrl);
    const exactTrustedOrigin = candidate.protocol === "https:" && candidate.origin === trusted.origin;
    return exactTrustedOrigin ? { allowSyntheticProxyAddress: true } : {};
  } catch {
    return {};
  }
}

export const PRESET_BASE_URLS: Record<string, string> = {
  deepseek: "https://api.deepseek.com/v1",
  minimax: "https://api.minimaxi.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  openai: "https://api.openai.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

// 密钥来源(优先级 高→低):① 环境变量 <PROVIDER>_API_KEY(如 DEEPSEEK_API_KEY)② keys 目录里的
// <provider>.key 文件,按序探测:OPC_KEYS_DIR > <projectRoot>/.opc/keys(项目内,自包含)>
// <projectRoot>/../../keys(旧的父目录布局,兼容)③ config.apiKeys。三类来源全部 gitignore,
// 也不进 exe —— **打包/上传绝不携带密钥**。①:项目内 .opc/keys 让 OPCstudio 可整目录搬运/独立运行。
export function collectApiKeys(projectRoot: string, configKeys: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...configKeys };
  const keyDirs = [
    process.env.OPC_KEYS_DIR,
    path.join(projectRoot, ".opc", "keys"),
    path.resolve(projectRoot, "..", "..", "keys"),
  ].filter((d): d is string => !!d);
  for (const p of Object.keys(PRESET_BASE_URLS).concat("anthropic")) {
    for (const dir of keyDirs) {
      try {
        const f = path.join(dir, `${p}.key`);
        if (fs.existsSync(f)) { const k = fs.readFileSync(f, "utf-8").trim(); if (k) { out[p] = k; break; } }
      } catch { /* ignore unreadable key file, try next dir */ }
    }
    const ev = process.env[`${p.toUpperCase()}_API_KEY`];
    if (ev) out[p] = ev; // env 最高优先级
  }
  return out;
}

// 单 provider 的密钥解析(同 collectApiKeys 优先级 高→低:env <PROVIDER>_API_KEY > keys/<provider>.key > config.apiKeys)。
// 供"原本直接读 config.apiKeys[provider]"的路由改用——这样把明文 key 移出 config 后,这些路径仍能从 env/keys 目录拿到。
export function resolveProviderKey(projectRoot: string, provider: string): string | undefined {
  const envName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  const ev = process.env[envName];
  if (ev) return ev;
  const keyDirs = [
    process.env.OPC_KEYS_DIR,
    path.join(projectRoot, ".opc", "keys"),
    path.resolve(projectRoot, "..", "..", "keys"),
  ].filter((d): d is string => !!d);
  for (const dir of keyDirs) {
    try {
      const f = path.join(dir, `${provider}.key`);
      if (fs.existsSync(f)) { const k = fs.readFileSync(f, "utf-8").trim(); if (k) return k; }
    } catch { /* try next */ }
  }
  try {
    const configKey = loadConfig(projectRoot).apiKeys?.[provider];
    if (configKey) return configKey;
  } catch { /* continue to stores */ }
  try {
    const stored = loadProviders(projectRoot).find((item) => item.id === provider || canonicalProviderId(item) === provider);
    if (stored?.apiKey) return stored.apiKey;
  } catch { /* continue to accounts */ }
  try {
    const providers = loadProviders(projectRoot);
    const account = loadAccounts(projectRoot).find((item) => {
      if (item.enabled === false || !item.apiKey) return false;
      if (item.providerId === provider) return true;
      const stored = providers.find((candidate) => candidate.id === item.providerId);
      return !!stored && canonicalProviderId(stored) === provider;
    });
    if (account?.apiKey) return account.apiKey;
  } catch { /* no stores */ }
  return undefined;
}

export interface ConfiguredProviderCapabilities {
  availableProviders: Set<string>;
  defaultModels: Map<string, string>;
}

export function collectConfiguredProviderCapabilities(projectRoot: string): ConfiguredProviderCapabilities {
  const availableProviders = new Set<string>();
  const defaultModels = new Map<string, string>();
  try {
    const config = loadConfig(projectRoot);
    for (const [id, key] of Object.entries(collectApiKeys(projectRoot, config.apiKeys ?? {}))) if (key) availableProviders.add(id);
  } catch { /* no config */ }
  let providers: ReturnType<typeof loadProviders> = [];
  try { providers = loadProviders(projectRoot); } catch { /* no provider store */ }
  for (const item of providers) {
    const canonical = canonicalProviderId(item);
    const model = item.defaultModel || item.models?.[0] || DEFAULT_MODELS[canonical ?? item.id];
    if (model) {
      defaultModels.set(item.id, model);
      if (canonical) defaultModels.set(canonical, model);
    }
    if (!item.apiKey && item.kind !== "local") continue;
    availableProviders.add(item.id);
    if (canonical) availableProviders.add(canonical);
  }
  try {
    for (const account of loadAccounts(projectRoot)) {
      if (account.enabled === false || !account.apiKey) continue;
      availableProviders.add(account.providerId);
      const stored = providers.find((item) => item.id === account.providerId);
      const canonical = stored ? canonicalProviderId(stored) : undefined;
      if (canonical) availableProviders.add(canonical);
    }
  } catch { /* no account store */ }
  for (const id of availableProviders) {
    const model = defaultModels.get(id) || DEFAULT_MODELS[id];
    if (model) defaultModels.set(id, model);
  }
  return { availableProviders, defaultModels };
}

// Register provider handlers at runtime from config.apiKeys (presets) + providers.json
// (custom baseUrl providers). Replaces the one-time hardcoded switch in index.ts, and can
// be re-invoked after config changes without a restart.
export function syncProvidersFromStore(projectRoot: string): string[] {
  const registered: string[] = [];
  const config = loadConfig(projectRoot);
  const apiKeys = collectApiKeys(projectRoot, config.apiKeys); // env + 外部 keys 目录 + config 合并

  for (const [name, key] of Object.entries(apiKeys)) {
    if (!key) continue;
    if (name === "anthropic") {
      registerProvider("anthropic", createAnthropicProvider(key));
      registered.push("anthropic");
      continue;
    }
    const baseUrl = PRESET_BASE_URLS[name];
    if (baseUrl) {
      registerProvider(name, createOpenAICompatProvider(baseUrl, key, providerNetworkOptions(name, baseUrl)));
      registered.push(name);
    }
  }

  const providers = loadProviders(projectRoot);
  for (const p of providers) {
    if (!p.apiKey || !p.baseUrl) continue; // no key/url → not registered → runtime restricted, never fake
    const canonical = canonicalProviderId(p);
    const handler = p.apiFormat === "anthropic"
      ? createAnthropicProvider(p.apiKey)
      : createOpenAICompatProvider(p.baseUrl, p.apiKey, providerNetworkOptions(canonical ?? p.id, p.baseUrl, p.allowLocalNetwork === true, p.kind));
    for (const id of new Set([p.id, canonical].filter((value): value is string => !!value))) {
      registerProvider(id, handler);
      if (!registered.includes(id)) registered.push(id);
    }
  }

  // accounts.json(多账号/CLI API Key 账号体系)是与 config.apiKeys/providers.json 平行的另一份凭据
  // 存储——不回填这里会导致"系统级"模型调用(Mission Brief/意图分类/Harness 验收官/Loop 复盘等,均走
  // callModel → registry)永远看不到只在"账号"UI 里配置的 key,哪怕它持有同名 provider 的有效 apiKey
  // (即便 accountPool 那边的 team/worker 执行链路能正常租到它)。按"任意一个持有 apiKey 的该 provider
  // 账号即可"登记:只在该 provider 名尚未被 config.apiKeys/providers.json 注册时才回填,不覆盖用户在
  // 经典 Settings 里显式配置的凭据(保持既有优先级不变)。
  for (const a of loadAccounts(projectRoot)) {
    if (a.enabled === false || !a.apiKey || registered.includes(a.providerId)) continue;
    if (a.providerId === "anthropic") {
      registerProvider("anthropic", createAnthropicProvider(a.apiKey));
      registered.push("anthropic");
      continue;
    }
    const baseUrl = a.baseUrl || PRESET_BASE_URLS[a.providerId] || providers.find((p) => p.id === a.providerId)?.baseUrl;
    if (baseUrl) {
      const matchedProvider = providers.find((p) => p.id === a.providerId);
      registerProvider(a.providerId, createOpenAICompatProvider(baseUrl, a.apiKey, providerNetworkOptions(a.providerId, baseUrl, a.allowLocalNetwork === true || matchedProvider?.allowLocalNetwork === true, matchedProvider?.kind)));
      registered.push(a.providerId);
    }
  }

  return registered;
}

// A provider is usable iff a handler is registered for it.
export function isProviderAvailable(provider: string): boolean {
  return getHandler(provider) !== undefined;
}
