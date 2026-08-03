import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSystemModel, inferSystemFramework, resolveAutoSubscription } from "./systemModel.js";

// systemModel 三级化(订阅/API 级联)单测:全部走临时目录真实读写 config.json,不打外网、不 mock。
// 覆盖 requirement:旧值兼容(无 framework 推断)/ 新结构存取 / 订阅与 API 两态解析。

let root: string;

function setupRoot(systemModel?: unknown): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  const cfg: Record<string, unknown> = {
    version: "0.1.0", projectName: "t", apiKeys: {}, defaultModel: "deepseek-v4-pro",
    budget: { totalUsd: 10, maxTokensPerTask: 200000 },
    permissions: { allowShell: false, allowFileWrite: true, allowWebAccess: false },
  };
  if (systemModel !== undefined) cfg.systemModel = systemModel;
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify(cfg));
  return root;
}

afterEach(() => {
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("inferSystemFramework — 旧值执行方式推断", () => {
  it("Claude 系 → claude-code 订阅", () => {
    expect(inferSystemFramework("anthropic", "claude-sonnet-5")).toBe("claude-code");
    expect(inferSystemFramework("deepseek", "sonnet")).toBe("claude-code");
  });
  it("GPT/Codex 系 → codex 订阅", () => {
    expect(inferSystemFramework("openai", "gpt-5")).toBe("codex");
    expect(inferSystemFramework("openai", "o3")).toBe("codex");
  });
  it("其余(deepseek/minimax/豆包)→ API(api)", () => {
    expect(inferSystemFramework("deepseek", "deepseek-chat")).toBe("api");
    expect(inferSystemFramework("minimax", "MiniMax-M3")).toBe("api");
  });
});

describe("resolveSystemModel — 旧值兼容(无 framework 字段)", () => {
  it("旧 {provider,model} 无 framework → 按 provider/model 推断执行方式(读旧写新)", () => {
    setupRoot({ creative: { provider: "deepseek", model: "deepseek-chat" }, judge: { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(resolveSystemModel(root, "creative")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-chat" });
    // 历史两档若冲突，固定以 creative 为统一默认，judge 标签也解析为同一个模型。
    expect(resolveSystemModel(root, "judge")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-chat" });
  });
});

describe("resolveSystemModel — 新结构存取(订阅与 API 两态)", () => {
  it("API 态:旧配置 framework:hermes 读侧归一为 api(不改写 config)", () => {
    setupRoot({ default: { framework: "hermes", provider: "deepseek", model: "deepseek-v4-pro" } });
    expect(resolveSystemModel(root, "creative")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("订阅态 claude-code:CLI 别名 sonnet 原样保留(CLI 直接吃别名,绝不 canonical 化)", () => {
    setupRoot({ default: { framework: "claude-code", provider: "anthropic", model: "sonnet" } });
    expect(resolveSystemModel(root, "creative")).toEqual({ framework: "claude-code", provider: "anthropic", model: "sonnet" });
  });

  it("订阅态 codex:gpt-5.5 原样保留(不映射成 API 面的 gpt-5.1)", () => {
    setupRoot({ default: { framework: "codex", provider: "openai", model: "gpt-5.5" } });
    expect(resolveSystemModel(root, "judge")).toEqual({ framework: "codex", provider: "openai", model: "gpt-5.5" });
  });

  it("显式 framework 优先于推断:即使 provider/model 像 Claude,framework:hermes 也保留 API 态(归一 api)", () => {
    setupRoot({ default: { framework: "hermes", provider: "anthropic", model: "claude-sonnet-5" } });
    expect(resolveSystemModel(root, "creative").framework).toBe("api");
  });
});

describe("resolveSystemModel — 兜底", () => {
  it("未配置 systemModel → 使用统一 defaultModel", () => {
    setupRoot();
    expect(resolveSystemModel(root, "creative")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(resolveSystemModel(root, "judge")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
  });

  it("旧版只配一档 → 两个系统用途统一使用该档", () => {
    setupRoot({ creative: { framework: "api", provider: "minimax", model: "MiniMax-M3" } });
    expect(resolveSystemModel(root, "creative").provider).toBe("minimax");
    expect(resolveSystemModel(root, "judge")).toEqual({ framework: "api", provider: "minimax", model: "MiniMax-M3" });
  });

  it("项目未初始化(无 config.json)→ 不抛,退回 fallback", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "system-model-empty-"));
    try {
      expect(resolveSystemModel(empty, "creative")).toEqual({ framework: "api", provider: "deepseek", model: "deepseek-v4-pro" });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveAutoSubscription — 无 key 自动订阅替换", () => {
  const api = (provider: string, model = "m"): { framework: string; provider: string; model: string } => ({ framework: "api", provider, model });

  it("有 key → keep(has-key),不替换", async () => {
    const out = await resolveAutoSubscription(api("anthropic", "claude-sonnet-5"), {
      hasProviderKey: () => true,
      isSubscriptionReady: async () => true, // 即便订阅已就绪,有 key 也优先直用 API
    });
    expect(out).toEqual({ kind: "keep", choice: api("anthropic", "claude-sonnet-5"), reason: "has-key" });
  });

  it("无 key 但订阅已登录就绪 → substituted,framework 改为对应订阅、保留 provider/model、记录 from/to", async () => {
    const installed = new Set<string>();
    const out = await resolveAutoSubscription(api("anthropic", "claude-sonnet-5"), {
      hasProviderKey: () => false,
      isSubscriptionReady: async (fw) => { installed.add(fw); return true; },
    });
    expect(out).toEqual({
      kind: "substituted",
      choice: { framework: "claude-code", provider: "anthropic", model: "claude-sonnet-5" },
      from: "anthropic", to: "claude-code",
    });
    expect(installed.has("claude-code")).toBe(true); // 探的是 provider 对应的订阅
  });

  it("openai→codex / google→gemini-cli 映射一致", async () => {
    const oai = await resolveAutoSubscription(api("openai", "gpt-5.5"), { hasProviderKey: () => false, isSubscriptionReady: async () => true });
    expect(oai).toMatchObject({ kind: "substituted", to: "codex", choice: { framework: "codex", provider: "openai" } });
    const g = await resolveAutoSubscription(api("google", "gemini-2.5-pro"), { hasProviderKey: () => false, isSubscriptionReady: async () => true });
    expect(g).toMatchObject({ kind: "substituted", to: "gemini-cli", choice: { framework: "gemini-cli", provider: "google" } });
  });

  it("无 key 且订阅未安装或未登录 → unavailable,点名 provider + 订阅", async () => {
    const out = await resolveAutoSubscription(api("anthropic"), { hasProviderKey: () => false, isSubscriptionReady: async () => false });
    expect(out).toEqual({ kind: "unavailable", provider: "anthropic", subscription: "claude-code" });
  });

  it("订阅态配置(framework 非 API 面)→ keep(already-subscription),不需要 key、不探订阅", async () => {
    let probed = false;
    const out = await resolveAutoSubscription({ framework: "claude-code", provider: "anthropic", model: "sonnet" }, {
      hasProviderKey: () => false,
      isSubscriptionReady: async () => { probed = true; return false; },
    });
    expect(out).toMatchObject({ kind: "keep", reason: "already-subscription" });
    expect(probed).toBe(false);
  });

  it("无 key 且无订阅映射(如 deepseek)→ keep(no-key-no-subscription),交调用方处理", async () => {
    const out = await resolveAutoSubscription(api("deepseek", "deepseek-chat"), { hasProviderKey: () => false, isSubscriptionReady: async () => true });
    expect(out).toMatchObject({ kind: "keep", reason: "no-key-no-subscription" });
  });
});
