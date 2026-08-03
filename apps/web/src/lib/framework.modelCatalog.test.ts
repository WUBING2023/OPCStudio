import { describe, it, expect } from "vitest";
import type { AgentFramework } from "@opc/shared";
import {
  canRefreshSubscriptionCatalog,
  CLI_FRAMEWORK_ACCOUNT_PROVIDERS,
  CLI_FRAMEWORK_PROVIDER,
  FRAMEWORK_TO_CATALOG_ENGINE,
  isModelOutsideCatalog,
  isSubscriptionFramework,
  patchForTier1,
} from "./framework.js";

describe("isModelOutsideCatalog · 节点配置模型下拉的目录外告警态", () => {
  const anthropicCatalog = ["claude-sonnet-5", "claude-opus-4-8", "claude-haiku-4-5"];

  it("目录命中(canonical id)→ 不告警", () => {
    expect(isModelOutsideCatalog(anthropicCatalog, "claude-sonnet-5")).toBe(false);
  });

  it("大小写不敏感命中 → 不告警", () => {
    expect(isModelOutsideCatalog(anthropicCatalog, "Claude-Sonnet-5")).toBe(false);
  });

  it("裸别名 sonnet 落在 API/Hermes 目录外 → 告警(接住 404:model:sonnet 痛点)", () => {
    expect(isModelOutsideCatalog(anthropicCatalog, "sonnet")).toBe(true);
    expect(isModelOutsideCatalog(anthropicCatalog, "gpt-4o")).toBe(true);
  });

  it("空模型 → 不告警(交给默认)", () => {
    expect(isModelOutsideCatalog(anthropicCatalog, "")).toBe(false);
    expect(isModelOutsideCatalog(anthropicCatalog, "   ")).toBe(false);
  });

  it("目录未加载/为空(订阅 CLI 未装 → 空表)→ 不误报", () => {
    expect(isModelOutsideCatalog([], "sonnet")).toBe(false);
  });

  it("CLI 订阅别名在订阅目录内 → 不告警", () => {
    expect(isModelOutsideCatalog(["sonnet", "opus", "haiku"], "sonnet")).toBe(false);
    expect(isModelOutsideCatalog(["sonnet", "opus", "haiku"], "gpt-5.5")).toBe(true);
  });

  // ACP 活体目录上线后:claude-code 目录真值是 default/sonnet/haiku(不含 opus);opus 仍是合法 CLI 别名。
  // 订阅引擎把该引擎别名表并入"目录内"判据(extraAllowed),防止合法别名被误告警。
  describe("extraAllowed:订阅引擎别名并入目录内判据", () => {
    const liveCc = ["default", "sonnet", "haiku"]; // claude-code ACP 活体目录真值
    const ccAliases = ["sonnet", "opus", "haiku"];

    it("目录缺 opus 但 opus 是合法别名 → 并入别名表后不告警", () => {
      expect(isModelOutsideCatalog(liveCc, "opus")).toBe(true); // 不并别名:误报
      expect(isModelOutsideCatalog(liveCc, "opus", ccAliases)).toBe(false); // 并别名:不报
    });

    it("目录真值本身(default)始终不告警", () => {
      expect(isModelOutsideCatalog(liveCc, "default", ccAliases)).toBe(false);
    });

    it("既不在目录也不在别名表的串仍告警", () => {
      expect(isModelOutsideCatalog(liveCc, "gpt-4o", ccAliases)).toBe(true);
      expect(isModelOutsideCatalog(liveCc, "claude-opus-4-8", ccAliases)).toBe(true);
    });

    it("大小写不敏感(别名侧)", () => {
      expect(isModelOutsideCatalog(liveCc, "Opus", ccAliases)).toBe(false);
    });

    it("目录为空时即便传别名也不误报(CLI 未装/目录未加载)", () => {
      expect(isModelOutsideCatalog([], "opus", ccAliases)).toBe(false);
    });

    it("默认 extraAllowed=[] 保持旧行为(API 面调用不传)", () => {
      expect(isModelOutsideCatalog(liveCc, "opus")).toBe(true);
    });
  });
});

describe("subscription framework registry", () => {
  it("maps all five runtime frameworks to stable catalog engines", () => {
    expect(FRAMEWORK_TO_CATALOG_ENGINE).toEqual({
      "claude-code": "claude-code",
      codex: "codex",
      "gemini-cli": "gemini",
      "kimi-cli": "kimi",
      "grok-build": "grok",
    });
    for (const framework of ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]) {
      expect(isSubscriptionFramework(framework)).toBe(true);
    }
  });

  it("only offers passive model refresh for non-interactive catalog engines", () => {
    expect(canRefreshSubscriptionCatalog("claude-code")).toBe(true);
    expect(canRefreshSubscriptionCatalog("codex")).toBe(true);
    expect(canRefreshSubscriptionCatalog("gemini-cli")).toBe(false);
    expect(canRefreshSubscriptionCatalog("kimi-cli")).toBe(false);
    expect(canRefreshSubscriptionCatalog("grok-build")).toBe(false);
  });
  it("keeps GLM Coding Plan as a Claude Code account backend", () => {
    expect(CLI_FRAMEWORK_ACCOUNT_PROVIDERS["claude-code"]).toEqual(["anthropic", "z-ai"]);
    expect(Object.keys(FRAMEWORK_TO_CATALOG_ENGINE)).not.toContain("glm-coding-plan");
  });

  it("switches employees to coherent Kimi and Grok defaults", () => {
    const kimi = patchForTier1("kimi-cli" as AgentFramework, { provider: "anthropic", model: "sonnet" });
    const grok = patchForTier1("grok-build" as AgentFramework, { provider: "openai", model: "gpt-5.5" });
    expect(kimi).toEqual({ framework: "kimi-cli", provider: CLI_FRAMEWORK_PROVIDER["kimi-cli"], model: "default" });
    expect(grok).toEqual({ framework: "grok-build", provider: CLI_FRAMEWORK_PROVIDER["grok-build"], model: "default" });
  });
});