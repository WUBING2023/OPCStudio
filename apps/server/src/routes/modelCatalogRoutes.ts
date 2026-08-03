import type { Express } from "express";
import { PRESET_PROVIDERS } from "@opc/shared";
import { probeAll } from "../runtime/engineRouter.js";
import { SUBSCRIPTION_ENGINES, SUBSCRIPTION_STATIC_MODELS, type CatalogModel, type SubscriptionEngine } from "../runtime/modelResolve.js";
import { probeAcpModels, type AcpProbeEngine } from "../runtime/acpModelProbe.js";
import { BUILTIN_MODELS, clearModelCache, listModels } from "../runtime/modelRegistry.js";
import { resolveProviderKey } from "../runtime/providerRegistry.js";
import { loadProviders } from "../storage/providerStore.js";
import { loadModelCatalogRefreshRecord, saveModelCatalogRefreshRecord } from "../storage/modelCatalogStore.js";

// GET /api/model-catalog —— 三级模型选择的**单一事实源**。用户实测:选订阅或供应商 API 时模型加载不对
// (尤其订阅)。前端节点配置的三级级联(执行方式 → 具体订阅引擎/供应商 → 模型)只认这一个端点,不再各自
// 拼 /frameworks + /providers/:id/models + 前端写死的 CLI 别名。
//
// 契约:{
//   subscriptions: [{ engine:'claude-code'|'codex'|'gemini', installed, models:[{id,label,isDefault?}], source:'acp'|'static' }],
//   apiProviders:  [{ provider, label, hasKey, models:[{id,label}] }]
// }
// · 订阅模型(验收#1):已装的 ACP 引擎(claude-code/codex)优先经 ACP initialize+session/new 拿活体
//   availableModels(零模型消耗;source:"acp");握手失败/超时或引擎无 ACP adapter(gemini)→ 回退静态
//   兜底表(source:"static";id 与真实 CLI 接受的别名一致)。CLI 未装 → installed:false + 空表。
// · API 供应商:来自现有 BUILTIN_MODELS(预设)+ providers.json(自定义);hasKey 经 env>keys 文件>config
//   完整解析链(resolveProviderKey,只读)。

const SUBSCRIPTION_ENGINE_LABEL: Record<SubscriptionEngine, string> = {
  "claude-code": "Claude Code 订阅",
  codex: "Codex 订阅",
  gemini: "Gemini 订阅",
  kimi: "Kimi 订阅",
  grok: "Grok Build 订阅",
};

// 订阅引擎 → 用于 installed 探测的 framework id(gemini 首发经 gemini-cli 侦测其是否安装)。
const SUBSCRIPTION_ENGINE_FRAMEWORK: Record<SubscriptionEngine, string> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  kimi: "kimi-cli",
  grok: "grok-build",
};

const SUBSCRIPTION_ENGINE_ACP: Record<SubscriptionEngine, AcpProbeEngine> = {
  "claude-code": "claude-code",
  codex: "codex",
  gemini: "gemini-cli",
  kimi: "kimi-cli",
  grok: "grok-build",
};

// Model catalog reads happen during ordinary page rendering. Native third-party
// CLIs may turn ACP startup into an interactive OAuth flow, so they must never
// be launched by GET /api/model-catalog or by the model-refresh control. Login
// and connection-test routes are the only user-consented authentication entry.
const NON_INTERACTIVE_CATALOG_ENGINES = new Set<SubscriptionEngine>(["claude-code", "codex"]);
export function canProbeSubscriptionCatalog(engine: SubscriptionEngine): boolean {
  return NON_INTERACTIVE_CATALOG_ENGINES.has(engine);
}

const PRESET_PROVIDER_LABEL: Record<string, string> = Object.fromEntries(
  PRESET_PROVIDERS
    .filter((provider) => provider.id !== "custom")
    .map((provider) => [provider.id, provider.name]),
);

export interface SubscriptionCatalogEntry {
  engine: SubscriptionEngine;
  installed: boolean;
  models: CatalogModel[];
  source: "acp" | "static";
  refreshedAt?: string;
}
export interface ApiProviderCatalogEntry {
  provider: string;
  label: string;
  hasKey: boolean;
  models: CatalogModel[];
  source: "live" | "builtin";
  refreshedAt?: string;
}
export interface ModelCatalog {
  subscriptions: SubscriptionCatalogEntry[];
  apiProviders: ApiProviderCatalogEntry[];
}

// 订阅活体模型探针只用于不会把目录读取变成登录流程的引擎(claude-code/codex)。
// 软时限(stale-while-revalidate):冷缓存时 ACP 握手要数秒~十几秒,浏览器端等不起(用户实测:前端超时
// 回退空目录,下拉只剩当前值)。这里给 1.2s 软时限——超时先回 null(本次走静态兜底),真握手继续在后台
// 跑完并写进 probeAcpModels 的 10 分钟缓存,前端稍后重取即得活值。
const ACP_SOFT_DEADLINE_MS = 1200;
export type AcpModelProber = (engine: SubscriptionEngine) => Promise<CatalogModel[] | null>;
const defaultAcpProber: AcpModelProber = (engine) => {
  const probing = probeAcpModels(SUBSCRIPTION_ENGINE_ACP[engine]); // 绝不 reject;完成后自缓存
  const soft = new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), ACP_SOFT_DEADLINE_MS); (t as { unref?: () => void }).unref?.(); });
  return Promise.race([probing, soft]);
};

// installed 探测(默认 probeAll,零模型消耗);可注入以便测试稳定断言 acp/static 三态。
export type InstalledProbe = () => Promise<Record<string, boolean>>;
const defaultInstalledProbe: InstalledProbe = async () => {
  const map: Record<string, boolean> = {};
  try { for (const a of await probeAll()) map[a.framework] = a.installed; } catch { /* 全部按未装 */ }
  return map;
};

export interface BuildCatalogOptions {
  acpProber?: AcpModelProber;
  installedProbe?: InstalledProbe;
}

export async function buildModelCatalog(projectRoot: string, opts: BuildCatalogOptions = {}): Promise<ModelCatalog> {
  const acpProber = opts.acpProber ?? defaultAcpProber;
  const installedProbe = opts.installedProbe ?? defaultInstalledProbe;

  // ── 订阅(CLI 订阅引擎)──
  const installedByFramework = await installedProbe();

  const subscriptions: SubscriptionCatalogEntry[] = await Promise.all(
    SUBSCRIPTION_ENGINES.map(async (engine): Promise<SubscriptionCatalogEntry> => {
      const installed = installedByFramework[SUBSCRIPTION_ENGINE_FRAMEWORK[engine]] === true;
      if (!installed) return { engine, installed: false, models: [], source: "static" }; // 未装 → 诚实空表
      const saved = loadModelCatalogRefreshRecord(projectRoot, "subscription", engine);
      if (saved?.models.length) {
        return { engine, installed, models: saved.models, source: "acp", refreshedAt: saved.refreshedAt };
      }
      if (!canProbeSubscriptionCatalog(engine)) {
        return { engine, installed, models: SUBSCRIPTION_STATIC_MODELS[engine] ?? [], source: "static" };
      }
      // 已装:先试 ACP 活体握手(验收#1);拿到非空 → source:"acp",否则回退静态兜底表。
      let models: CatalogModel[] = [];
      let source: "acp" | "static" = "static";
      try {
        const live = await acpProber(engine);
        if (live && live.length) { models = live; source = "acp"; }
      } catch { /* 握手失败:静默回退静态 */ }
      if (!models.length) { models = SUBSCRIPTION_STATIC_MODELS[engine] ?? []; source = "static"; }
      return { engine, installed, models, source };
    }),
  );

  // ── API 供应商(预设 + 自定义)──
  const apiProviders: ApiProviderCatalogEntry[] = [];
  const seen = new Set<string>();
  for (const provider of Object.keys(PRESET_PROVIDER_LABEL)) {
    seen.add(provider);
    const saved = loadModelCatalogRefreshRecord(projectRoot, "provider", provider);
    const models = saved?.models ?? (BUILTIN_MODELS[provider] ?? []).map((id) => ({ id, label: id }));
    apiProviders.push({
      provider,
      label: PRESET_PROVIDER_LABEL[provider],
      hasKey: hasKeyFor(projectRoot, provider),
      models,
      source: saved ? "live" : "builtin",
      refreshedAt: saved?.refreshedAt,
    });
  }
  // 自定义供应商(providers.json):目录内无 builtin 型号(留空,前端允许手输并即时校验);hasKey 取其
  // 自带 apiKey 或完整解析链命中。
  try {
    for (const p of loadProviders(projectRoot)) {
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      const saved = loadModelCatalogRefreshRecord(projectRoot, "provider", p.id);
      apiProviders.push({
        provider: p.id,
        label: p.name || p.id,
        hasKey: !!p.apiKey || hasKeyFor(projectRoot, p.id),
        models: saved?.models ?? [],
        source: saved ? "live" : "builtin",
        refreshedAt: saved?.refreshedAt,
      });
    }
  } catch { /* providers.json 读失败:只回预设 */ }

  return { subscriptions, apiProviders };
}

function hasKeyFor(projectRoot: string, provider: string): boolean {
  try { return !!resolveProviderKey(projectRoot, provider); } catch { return false; }
}

export function register(app: Express, projectRoot: string) {
  app.get("/api/model-catalog", async (_req, res) => {
    try {
      res.json(await buildModelCatalog(projectRoot));
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "model catalog failed" });
    }
  });

  app.post("/api/model-catalog/refresh", async (req, res) => {
    const kind = req.body?.kind;
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if ((kind !== "provider" && kind !== "subscription") || !id) {
      return res.status(400).json({ error: "kind(provider|subscription) and id are required" });
    }
    try {
      const refreshedAt = new Date().toISOString();
      if (kind === "provider") {
        const known = Object.prototype.hasOwnProperty.call(PRESET_PROVIDER_LABEL, id) || loadProviders(projectRoot).some((p) => p.id === id);
        if (!known) return res.status(404).json({ error: "provider not found" });
        clearModelCache(id);
        const result = await listModels(projectRoot, id);
        if (result.source !== "live" || !result.models.length) {
          return res.status(502).json({ error: "provider model refresh failed; keeping previous catalog", source: result.source, reason: result.error });
        }
        const record = {
          kind: "provider" as const,
          id,
          models: result.models.map((modelId) => ({ id: modelId, label: modelId })),
          source: "live" as const,
          refreshedAt,
        };
        saveModelCatalogRefreshRecord(projectRoot, record);
        return res.json(record);
      }

      if (!SUBSCRIPTION_ENGINES.includes(id as SubscriptionEngine)) return res.status(404).json({ error: "subscription engine not found" });
      const engine = id as SubscriptionEngine;
      if (!canProbeSubscriptionCatalog(engine)) {
        return res.status(409).json({
          error: "model refresh never starts subscription login; use the explicit login or connection-test action first",
          code: "explicit_subscription_auth_required",
        });
      }
      const models = await probeAcpModels(SUBSCRIPTION_ENGINE_ACP[engine], { noCache: true });
      if (!models?.length) return res.status(502).json({ error: "subscription model refresh failed; keeping previous catalog" });
      const record = { kind: "subscription" as const, id, models, source: "acp" as const, refreshedAt };
      saveModelCatalogRefreshRecord(projectRoot, record);
      return res.json(record);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || "model refresh failed" });
    }
  });
}
