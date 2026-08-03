import { describe, it, expect } from "vitest";
import type { ProviderAccount } from "@opc/shared";
import { resolveApiKeyOverride } from "./apiKeyAccount.js";

// claude-code 简化后(2026-07):不再有专属 configDir 绑定的账号——就是 Hermes 也在用的那个普通
// Anthropic 账号(无 frameworks 限制、无 configDir)。
const anthropicHermesAcct: ProviderAccount = {
  id: "anthropic#0", providerId: "anthropic", label: "我的 Anthropic Key",
  apiKey: "sk-ant-fake-testkey", enabled: true, maxConcurrent: 6,
};
const subAcct: ProviderAccount = {
  id: "anthropic#claude-code", providerId: "anthropic", label: "订阅",
  apiKey: "", configDir: "C:/cli/sub", frameworks: ["claude-code"], enabled: true, maxConcurrent: 3,
};
const codexApiAcct: ProviderAccount = {
  id: "openai#apikey1", providerId: "openai", label: "我的 OpenAI Key",
  apiKey: "sk-fake-testkey", configDir: "C:/cli/codex-apikey1", frameworks: ["codex"], enabled: true, maxConcurrent: 1,
};
const accounts = [anthropicHermesAcct, subAcct, codexApiAcct];

describe("resolveApiKeyOverride", () => {
  it("claude-code + claudeCodeUseApiKey=true → 复用任意一个持有 apiKey 的 anthropic 账号(不看 configDir)", () => {
    expect(resolveApiKeyOverride(accounts, "claude-code", undefined, true)).toBe("sk-ant-fake-testkey");
    expect(resolveApiKeyOverride(accounts, "claude-code", "C:/cli/sub", true)).toBe("sk-ant-fake-testkey");
  });

  it("claude-code + claudeCodeUseApiKey 未设置/false → undefined(默认走订阅登录,不静默切换成按量计费)", () => {
    expect(resolveApiKeyOverride(accounts, "claude-code", undefined, false)).toBeUndefined();
    expect(resolveApiKeyOverride(accounts, "claude-code", undefined, undefined)).toBeUndefined();
  });

  it("claude-code + claudeCodeUseApiKey=true 但没有任何 anthropic apiKey 账号 → undefined(诚实,不假装有)", () => {
    expect(resolveApiKeyOverride([subAcct], "claude-code", undefined, true)).toBeUndefined();
  });

  it("codex + configDir 命中 API Key 账号 → 返回其 key(供成本核算用,引擎不拿它做认证)", () => {
    expect(resolveApiKeyOverride(accounts, "codex", "C:/cli/codex-apikey1")).toBe("sk-fake-testkey");
  });

  it("codex + 未传 cliConfigDir → undefined(仍按 configDir 精确匹配,不对称于 claude-code)", () => {
    expect(resolveApiKeyOverride(accounts, "codex", undefined)).toBeUndefined();
  });

  it("codex + configDir 未命中任何账号 → undefined", () => {
    expect(resolveApiKeyOverride(accounts, "codex", "C:/cli/unknown")).toBeUndefined();
  });

  it("hermes 框架永远不解析(该字段只服务 CLI 订阅框架)", () => {
    expect(resolveApiKeyOverride(accounts, "hermes", "C:/cli/apikey1", true)).toBeUndefined();
  });
});
