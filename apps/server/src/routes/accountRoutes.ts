import type { Express } from "express";
import { v4 as uuid } from "uuid";
import * as fs from "node:fs";
import * as path from "node:path";
import { ProviderAccountSchema, type ProviderAccount, type ProviderConfig, type PublicProviderAccount } from "@opc/shared";
import { loadAccounts, saveAccounts, addAccount, updateAccount, deleteAccount, ensureAccountsFromProviders, loadProviders } from "../storage/providerStore.js";
import { getUsage, BALANCE_FETCHERS, NO_BALANCE_API_NOTE, type BalanceInfo } from "../storage/usageStore.js";
import { providerNetworkOptions, resolveProviderKey, syncProvidersFromStore, PRESET_BASE_URLS } from "../runtime/providerRegistry.js";
import { createOpenAICompatProvider, createAnthropicProvider } from "../runtime/modelGateway.js";
import { loadConfig } from "../storage/projectStore.js";
import { probeClaudeCodeAsync, probeCodexAsync, probeGeminiCliAsync, probeKimiCliAsync, probeGrokBuildAsync } from "../runtime/engines/probes.js";
import { isHealthy, getHealthStats } from "../runtime/providerHealth.js";
import { safeFetch } from "../security/localGuards.js";

// CLI API Key 模式账号的真实可用性测试目标(仅 claude-code/codex 两种):直连各自官方 API,
// 而不是走 CLI 子进程——claude-code 的 API Key 模式本就是纯 ANTHROPIC_API_KEY 环境变量直连
// Anthropic API(见 apiKeyAccount.ts 顶部说明),所以直测该 API 就等价于测"这把 key 能否驱动真实
// 执行"；codex 的 API Key 模式虽仍需 `codex login --with-api-key` 才能接入执行链路,但预先校验
// key 本身有效，能在用户跑那条命令前就给出信号，避免白跑一趟登录。用最省 token 的请求(max_tokens
// 个位数 + 一句极短 prompt)，只为验证 key 有效性/额度未耗尽，不是真做一次任务。
const CLI_APIKEY_TEST_TARGET: Record<"claude-code" | "codex", { apiFormat: "anthropic" | "openai"; baseUrl: string; model: string }> = {
  "claude-code": { apiFormat: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5" },
  "codex": { apiFormat: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-5-nano" },
};

export interface AccountKeyTestResult { ok: boolean; latencyMs: number; model: string; message: string }

// 泛化(把"添加第二个账号"从 codex 专属扩展到任意 provider 后新增):claude-code/codex 走上面那套
// 直连官方 API 的固定探针;普通 API 账号(providerId 是 deepseek/anthropic/minimax/自定义 provider 等)
// 没有一个统一的"官方 API"可以硬编码——按 providerId 解析 apiFormat/baseUrl(与 providerRegistry.ts
// syncProvidersFromStore 的解析优先级一致:account.baseUrl 覆盖 > 内建预设 > providers.json 里的自定义
// provider),复用 modelGateway.ts 里真实执行路径用的同一个 createOpenAICompatProvider/
// createAnthropicProvider(不是另起一套 fetch 逻辑),用最省 token 的请求验证 key 有效性。
async function testGenericApiAccount(
  account: Pick<ProviderAccount, "apiKey" | "providerId" | "baseUrl" | "allowLocalNetwork">,
  providers: ProviderConfig[],
  modelOverride?: string,
): Promise<AccountKeyTestResult> {
  if (!account.apiKey) return { ok: false, latencyMs: 0, model: modelOverride ?? "", message: "该账号未配置 API Key" };
  const matchedProvider = providers.find((p) => p.id === account.providerId);
  const apiFormat = account.providerId === "anthropic" ? "anthropic" : (matchedProvider?.apiFormat ?? "openai");
  const baseUrl = account.baseUrl || PRESET_BASE_URLS[account.providerId] || matchedProvider?.baseUrl;
  const model = modelOverride || matchedProvider?.defaultModel || "";
  if (apiFormat !== "anthropic" && !baseUrl) {
    return { ok: false, latencyMs: 0, model, message: "无法解析该账号的 API 地址(baseUrl)——请提供 model/baseUrl,或先在供应商设置里配置该 provider" };
  }
  if (!model) return { ok: false, latencyMs: 0, model: "", message: "请指定一个测试用的模型名(该 provider 未配置默认模型)" };
  const t0 = Date.now();
  try {
    const handler = apiFormat === "anthropic" ? createAnthropicProvider(account.apiKey) : createOpenAICompatProvider(baseUrl!, account.apiKey, providerNetworkOptions(account.providerId, baseUrl, account.allowLocalNetwork === true || matchedProvider?.allowLocalNetwork === true, matchedProvider?.kind));
    const out = await handler({ agentId: "account-test", provider: account.providerId, model, messages: [{ role: "user", content: "Reply with just: ok" }], maxTokens: 8 });
    return { ok: true, latencyMs: out.latencyMs, model, message: out.content || "OK" };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, model, message: err?.message || String(err) };
  }
}

export async function testAccountApiKey(
  account: Pick<ProviderAccount, "apiKey" | "frameworks" | "providerId" | "baseUrl" | "allowLocalNetwork" | "cliBackend">,
  providers: ProviderConfig[] = [],
  modelOverride?: string,
): Promise<AccountKeyTestResult> {
  const fw = account.frameworks?.[0];
  if (account.cliBackend === "glm-coding-plan") {
    return {
      ok: false, latencyMs: 0, model: modelOverride ?? "",
      message: "GLM Coding Plan 通过 Claude Code ACP 子进程认证，不能用 Anthropic 官方 API 测试。请运行深度体检验证真实执行。",
    };
  }
  const target = fw === "claude-code" || fw === "codex" ? CLI_APIKEY_TEST_TARGET[fw] : undefined;
  if (!target) return testGenericApiAccount(account, providers, modelOverride);
  if (!account.apiKey) return { ok: false, latencyMs: 0, model: target.model, message: "该账号未配置 API Key(订阅登录账号无需此项测试，请用 /probe 检查 CLI 登录态)" };

  const t0 = Date.now();
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const prompt = "Reply with just: ok";
    let url: string;
    let body: string;
    if (target.apiFormat === "anthropic") {
      url = `${target.baseUrl}/messages`;
      headers["x-api-key"] = account.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      body = JSON.stringify({ model: target.model, messages: [{ role: "user", content: prompt }], max_tokens: 8 });
    } else {
      url = `${target.baseUrl}/chat/completions`;
      headers["Authorization"] = `Bearer ${account.apiKey}`;
      body = JSON.stringify({ model: target.model, messages: [{ role: "user", content: prompt }], max_tokens: 8 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await safeFetch(
      url,
      { method: "POST", headers, body, signal: controller.signal },
      {
        allowLocalNetwork: false,
        // The target comes exclusively from CLI_APIKEY_TEST_TARGET above,
        // never from request input. Permit RFC 2544 addresses used by local
        // TUN proxies without weakening private or metadata IP blocking.
        allowSyntheticProxyAddress: true,
      },
    );
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;
    let message = "";
    try {
      const data: any = await resp.json();
      message = target.apiFormat === "anthropic"
        ? (data?.content?.[0]?.text ?? JSON.stringify(data))
        : (data?.choices?.[0]?.message?.content ?? JSON.stringify(data));
    } catch {
      message = resp.ok ? "OK" : `Error ${resp.status}`;
    }
    return { ok: resp.ok, latencyMs, model: target.model, message };
  } catch (err: any) {
    return { ok: false, latencyMs: Date.now() - t0, model: target.model, message: err?.message || String(err) };
  }
}

// Multi-account management (Phase 3). Accounts back the scheduler's least-busy selection; each is
// one credential under a provider, with a soft per-account concurrency cap.
function previewApiKey(apiKey: string): string | undefined {
  if (!apiKey) return undefined;
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-2)}`;
}

function accountAuthMode(account: Pick<ProviderAccount, "apiKey" | "cliBackend">): PublicProviderAccount["authMode"] {
  if (account.cliBackend === "glm-coding-plan") return "codingPlan";
  return account.apiKey ? "apiKey" : "subscription";
}

export function toPublicAccount(account: ProviderAccount): PublicProviderAccount {
  const hasApiKey = !!account.apiKey;
  return {
    id: account.id,
    providerId: account.providerId,
    label: account.label,
    baseUrl: account.baseUrl,
    allowLocalNetwork: account.allowLocalNetwork,
    configDir: account.configDir,
    frameworks: account.frameworks,
    enabled: account.enabled,
    preferred: account.preferred,
    maxConcurrent: account.maxConcurrent,
    acceptBanRisk: account.acceptBanRisk,
    cliBackend: account.cliBackend,
    hasApiKey,
    apiKeyPreview: previewApiKey(account.apiKey),
    authMode: accountAuthMode(account),
  };
}

function toPublicAccounts(accounts: ProviderAccount[]): PublicProviderAccount[] {
  return accounts.map(toPublicAccount);
}
export function register(app: Express, projectRoot: string) {
  // Pool view: persisted accounts (runtime active-session snapshot is attached per-run elsewhere).
  app.get("/api/pool", (_req, res) => {
    const accounts = ensureAccountsFromProviders(projectRoot);
    res.json({
      accounts: toPublicAccounts(accounts),
      snapshot: accounts.map((a) => ({ accountId: a.id, providerId: a.providerId, maxConcurrent: a.maxConcurrent, enabled: a.enabled })),
    });
  });

  app.get("/api/accounts", (_req, res) => {
    res.json(toPublicAccounts(ensureAccountsFromProviders(projectRoot)));
  });

  app.post("/api/accounts", (req, res) => {
    // apiKey:"" 默认——订阅制账号(claude-code/codex)本就无 key,靠 configDir 登录态认证;不默认会被
    // ProviderAccountSchema(apiKey 必填)卡成 400"Required",导致"加第二个 anthropic 订阅号"根本建不出来。
    // req.body 里显式传了 apiKey(API Key 模式)会覆盖此默认。
    const body = { id: req.body?.id || `${req.body?.providerId || "acct"}#${uuid().slice(0, 6)}`, enabled: true, maxConcurrent: 1, apiKey: "", ...req.body };
    // CLI 账号(claude-code/codex,含"API Key 模式")需要一个隔离的 configDir 当账号身份锚点——
    // claude-code 的 API Key 模式本身不靠它认证(纯 env var,见 apiKeyAccount.ts),但仍分配一个:
    // ①给节点"选哪个账号"提供稳定的选择键 ②避免污染用户全局 ~/.claude、~/.codex 的设置/信任缓存。
    // 用户显式传了 configDir 就尊重之(如接入已有的隔离目录)。
    const fws: string[] = Array.isArray(body.frameworks) ? body.frameworks : [];
    const needsConfigDir = fws.some((fw) => ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"].includes(fw)) && !body.configDir;
    if (needsConfigDir) {
      const dir = path.join(projectRoot, ".opc", "cli-accounts", body.id);
      try { fs.mkdirSync(dir, { recursive: true }); body.configDir = dir; } catch { /* best-effort:分配失败就不填,账号仍可建(退化为全局登录) */ }
    }
    const parsed = ProviderAccountSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    if (loadAccounts(projectRoot).some((a) => a.id === parsed.data.id)) {
      return res.status(409).json({ error: `account ${parsed.data.id} already exists` });
    }
    const account = addAccount(projectRoot, parsed.data);
    // 新账号若持有 apiKey,回填进系统级模型调用注册表(见 providerRegistry.ts 里的说明),
    // 否则只在 accounts.json 落盘、team/worker 执行链路(accountPool)可见,系统级调用永远拿不到。
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.json(toPublicAccount(account));
  });

  app.patch("/api/accounts/:id", (req, res) => {
    const patch = { ...(req.body ?? {}) };
    if (Object.prototype.hasOwnProperty.call(patch, "label")) {
      if (typeof patch.label !== "string" || !patch.label.trim() || patch.label.trim().length > 120) {
        return res.status(400).json({ error: "account label must be between 1 and 120 characters" });
      }
      patch.label = patch.label.trim();
    }
    const updated = updateAccount(projectRoot, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "account not found" });
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.json(toPublicAccount(updated));
  });

  app.post("/api/accounts/:id/preferred", (req, res) => {
    const accounts = loadAccounts(projectRoot);
    const target = accounts.find((account) => account.id === req.params.id);
    if (!target) return res.status(404).json({ error: "account not found" });

    const targetFrameworks = [...(target.frameworks ?? [])].sort().join(",");
    const targetAuthMode = accountAuthMode(target);
    for (const account of accounts) {
      const samePool = account.providerId === target.providerId
        && [...(account.frameworks ?? [])].sort().join(",") === targetFrameworks
        && accountAuthMode(account) === targetAuthMode;
      if (samePool) account.preferred = account.id === target.id;
    }
    saveAccounts(projectRoot, accounts);
    res.json(toPublicAccount(target));
  });

  app.delete("/api/accounts/:id", (req, res) => {
    const account = loadAccounts(projectRoot).find((item) => item.id === req.params.id);
    if (!account) return res.status(404).json({ error: "account not found" });
    const deleted = deleteAccount(projectRoot, req.params.id);
    if (!deleted) return res.status(404).json({ error: "account not found" });

    if (account.configDir) {
      const managedRoot = path.resolve(projectRoot, ".opc", "cli-accounts");
      const resolvedDir = path.resolve(account.configDir);
      const relative = path.relative(managedRoot, resolvedDir);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        try { fs.rmSync(resolvedDir, { recursive: true, force: true }); } catch { /* orphan cleanup is best-effort */ }
      }
    }
    try { syncProvidersFromStore(projectRoot); } catch { /* non-fatal */ }
    res.json({ deleted: true });
  });

  // 探测单个账号的就绪态——复用 probes.ts 的同一套探针(不另起逻辑)。claude-code 的 API Key 模式账号
  // (apiKey 非空)不需要 configDir 里有登录态(纯 env var,每次调用现注入):只要 CLI 已装就绪,不看
  // credentials.json。codex 无论订阅还是 API Key 模式,都得靠 configDir 里手动登录持久化的 auth.json——
  // 见 apiKeyAccount.ts 顶部的不对称说明,这里如实按各自机制探测,不假装 codex 也能"即建即用"。
  app.get("/api/accounts/:id/probe", async (req, res) => {
    const acct = loadAccounts(projectRoot).find((a) => a.id === req.params.id);
    if (!acct) return res.status(404).json({ error: "account not found" });
    const fw = acct.frameworks?.[0];
    if (fw === "claude-code" && acct.cliBackend === "glm-coding-plan") {
      const availability = await probeClaudeCodeAsync(acct.configDir);
      return res.json({
        ...availability,
        loggedIn: false,
        detail: availability.installed
          ? "GLM Coding Plan Token 已保存；请通过深度体检或真实任务验证可用性"
          : "需要先安装 Claude Code CLI",
      });
    }
    const probe = fw === "claude-code" ? probeClaudeCodeAsync
      : fw === "codex" ? probeCodexAsync
      : fw === "gemini-cli" ? probeGeminiCliAsync
      : fw === "kimi-cli" ? probeKimiCliAsync
      : fw === "grok-build" ? probeGrokBuildAsync
      : null;
    if (!probe) return res.status(400).json({ error: "该账号不是受支持的订阅 CLI 账号" });
    const av = await probe(acct.configDir);
    // Claude API Key 与 GLM Coding Plan 都由子进程环境注入认证，不依赖 Claude 凭据文件。
    // 这里只确认 CLI 已安装和账号配置已登记；真实 token 可用性由 deep Doctor/tool canary 验证。
    if (fw === "claude-code" && acct.apiKey) {
      if (acct.cliBackend === "glm-coding-plan") {
        return res.json({
          ...av,
          loggedIn: false,
          detail: av.installed
            ? "GLM Coding Plan 已配置但尚未验证；请运行深度体检验证真实执行"
            : av.detail,
        });
      }
      return res.json({
        ...av,
        loggedIn: av.installed,
        detail: av.installed ? undefined : av.detail,
      });
    }    res.json(av);
  });

  // 多账号自动切换(CLI 订阅框架)的健康态只读查询——复用 providerHealth.ts 的同一套熔断器(accountPool
  // .reportOutcome 拿 account id 当 key 写入,见 runtime/pool/accountPool.ts 顶部说明),不是另起的持久化。
  // 熔断态只跨"曾经跑过 run"的账号才有意义;从没执行过的账号 stats 为 null,healthy 恒 true(诚实,不是假数据)。
  app.get("/api/accounts/:id/health", (req, res) => {
    const id = req.params.id;
    res.json({ healthy: isHealthy(id), stats: getHealthStats(id) });
  });

  // 真实 key 可用性测试(区别于上面的 /probe):/probe 只看"CLI 装没装、本地有没有登录文件"，
  // 从不校验 apiKey 本身是否有效/欠费/被撤销——引导流程里用户刚粘贴一把 key 时,格式校验/CLI 是否
  // 安装都不能回答"这把 key 真的能用吗"。这里直连供应商 API 打一个最省 token 的真实请求核实。
  app.post("/api/accounts/:id/test", async (req, res) => {
    const acct = loadAccounts(projectRoot).find((a) => a.id === req.params.id);
    if (!acct) return res.status(404).json({ error: "account not found" });
    const modelOverride = typeof req.query.model === "string" ? req.query.model : (typeof req.body?.model === "string" ? req.body.model : undefined);
    res.json(await testAccountApiKey(acct, loadProviders(projectRoot), modelOverride));
  });

  // 成本/额度:按 provider 累计 token 用量 + 近 5h 窗口已用 + 多供应商真余额。
  // 用户反馈"填了很多 API 只能查 DeepSeek"→ 改注册表:凡配置了 key 且供应商有公开余额 API 的
  // (deepseek/openrouter/siliconflow/moonshot)全部并行查询;没有公开 API 的诚实标注。
  // key 仅用于查询,绝不回显。
  app.get("/api/usage", async (_req, res) => {
    const providers = getUsage();
    const configured = new Set<string>();
    try {
      const cfg = loadConfig(projectRoot);
      for (const id of Object.keys(cfg.apiKeys ?? {})) configured.add(id);
    } catch { /* 无 config → 只靠 resolveProviderKey 的 env/keys 链 */ }
    // 多账号体系:key 也可能只存在 accounts store(不在 config.apiKeys)——账号的 provider 一并纳入。
    try { for (const a of loadAccounts(projectRoot)) if (a.providerId) configured.add(a.providerId); } catch { /* */ }
    for (const id of Object.keys(BALANCE_FETCHERS)) {
      if (!configured.has(id)) { try { if (resolveProviderKey(projectRoot, id)) configured.add(id); } catch { /* */ } }
    }
    const balances = (await Promise.all(
      [...configured].map(async (id): Promise<BalanceInfo | null> => {
        const fetcher = BALANCE_FETCHERS[id];
        if (fetcher) {
          try {
            // key 解析:env/keys 文件/config 链之外,兜底查该 provider 的 API 账号(多账号体系)。
            let key = resolveProviderKey(projectRoot, id);
            if (!key) { try { key = loadAccounts(projectRoot).find(a => a.providerId === id && a.apiKey)?.apiKey; } catch { /* */ } }
            return key ? await fetcher(key) : null;
          } catch { return null; }
        }
        if (NO_BALANCE_API_NOTE[id]) return { provider: id, available: null, note: NO_BALANCE_API_NOTE[id] };
        return null;
      }),
    )).filter((b): b is BalanceInfo => !!b);
    const deepseekBalance = balances.find(b => b.provider === "deepseek"); // 兼容旧前端字段
    res.json({
      providers,
      balances,
      deepseekBalance,
      subscriptionNote: "订阅制 provider(claude-code/codex)无余额查询 API:仅记录已用 token 与近 5h 窗口已用,无法精确查询剩余额度/重置时间。",
    });
  });
}
