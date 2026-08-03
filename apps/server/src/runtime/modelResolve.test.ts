import { describe, it, expect } from "vitest";
import {
  resolveModelId,
  ModelNotFoundError,
  isModelNotFoundResponse,
  SUBSCRIPTION_STATIC_MODELS,
  SUBSCRIPTION_ENGINES,
} from "./modelResolve.js";

describe("resolveModelId · 执行面(API)别名解析与拒绝", () => {
  it("目录命中(canonical id)→ ok 原样过", () => {
    expect(resolveModelId("anthropic", "claude-sonnet-5")).toEqual({ status: "ok", model: "claude-sonnet-5" });
    expect(resolveModelId("openai", "gpt-5-mini")).toEqual({ status: "ok", model: "gpt-5-mini" });
  });

  it("裸别名(同族)→ aliased 映射为 canonical(根治 sonnet→404)", () => {
    expect(resolveModelId("anthropic", "sonnet")).toEqual({ status: "aliased", model: "claude-sonnet-5", from: "sonnet" });
    expect(resolveModelId("anthropic", "opus")).toEqual({ status: "aliased", model: "claude-opus-4-8", from: "opus" });
    expect(resolveModelId("anthropic", "haiku")).toEqual({ status: "aliased", model: "claude-haiku-4-5", from: "haiku" });
    expect(resolveModelId("openai", "gpt-5.5")).toEqual({ status: "aliased", model: "gpt-5.1", from: "gpt-5.5" });
    expect(resolveModelId("openai", "gpt-4o")).toEqual({ status: "aliased", model: "gpt-5", from: "gpt-4o" });
  });

  it("大小写不敏感的别名匹配", () => {
    expect(resolveModelId("anthropic", "Sonnet")).toMatchObject({ status: "aliased", model: "claude-sonnet-5" });
  });

  it("跨族误配 → rejected,理由指明供应商/模型矛盾(哪一级没选对)", () => {
    const r = resolveModelId("deepseek", "sonnet");
    expect(r.status).toBe("rejected");
    if (r.status === "rejected") {
      expect(r.reason).toContain("sonnet");
      expect(r.reason).toContain("deepseek");
    }
    const r2 = resolveModelId("anthropic", "gpt-4o"); // openai 族别名给了 anthropic
    expect(r2.status).toBe("rejected");
  });

  it("未知自定义串 → ok 放行(前端警告 + 供应商 API 裁决)", () => {
    expect(resolveModelId("deepseek", "deepseek-brand-new-2027")).toEqual({ status: "ok", model: "deepseek-brand-new-2027" });
    expect(resolveModelId("anthropic", "claude-some-future-id")).toEqual({ status: "ok", model: "claude-some-future-id" });
  });

  it("空模型 → ok(交给供应商默认,不拒绝)", () => {
    expect(resolveModelId("anthropic", "")).toEqual({ status: "ok", model: "" });
    expect(resolveModelId("anthropic", "   ")).toEqual({ status: "ok", model: "" });
  });

  it("传入 live 目录时优先按它判命中", () => {
    // 目录里有的自定义 id 直接原样过,即使它不在内建表里。
    expect(resolveModelId("deepseek", "deepseek-x", ["deepseek-x", "deepseek-y"]))
      .toEqual({ status: "ok", model: "deepseek-x" });
  });
});

describe("ModelNotFoundError", () => {
  it("消息以 'Model not found' 起头(供 HermesEngine restricted 正则 + gateway 熔断豁免识别)", () => {
    const e = new ModelNotFoundError("anthropic", "sonnet", "供应商不认识");
    expect(e.name).toBe("ModelNotFoundError");
    expect(e.message.startsWith("Model not found")).toBe(true);
    expect(/not found/i.test(e.message)).toBe(true); // HermesEngine.run restricted 正则命中点
    expect(e.provider).toBe("anthropic");
    expect(e.model).toBe("sonnet");
  });
});

describe("isModelNotFoundResponse · provider 4xx 归类", () => {
  it("404 恒判 model-not-found(HTTP 语义:not_found_error)", () => {
    expect(isModelNotFoundResponse(404, "")).toBe(true);
    expect(isModelNotFoundResponse(404, "whatever")).toBe(true);
  });
  it("400 + 报文含 model-not-found 文案 → true", () => {
    expect(isModelNotFoundResponse(400, `{"error":{"message":"model: sonnet not found"}}`)).toBe(true);
    expect(isModelNotFoundResponse(400, "The model `xyz` does not exist")).toBe(true);
    expect(isModelNotFoundResponse(400, "invalid model")).toBe(true);
  });
  it("400 普通报文(非模型问题)→ false;429/5xx → false(留给瞬时重试)", () => {
    expect(isModelNotFoundResponse(400, "messages: roles must alternate")).toBe(false);
    expect(isModelNotFoundResponse(429, "rate limit")).toBe(false);
    expect(isModelNotFoundResponse(503, "overloaded")).toBe(false);
  });
});

describe("SUBSCRIPTION_STATIC_MODELS · 静态兜底表", () => {
  it("三家订阅引擎各有默认模型,claude-code 用 CLI 别名 sonnet/opus/haiku", () => {
    expect(SUBSCRIPTION_ENGINES).toEqual(["claude-code", "codex", "gemini", "kimi", "grok"]);
    const cc = SUBSCRIPTION_STATIC_MODELS["claude-code"];
    expect(cc.map((m) => m.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(cc.find((m) => m.isDefault)?.id).toBe("sonnet");
    expect(SUBSCRIPTION_STATIC_MODELS.codex.find((m) => m.isDefault)?.id).toBe("gpt-5.5");
    expect(SUBSCRIPTION_STATIC_MODELS.gemini.length).toBeGreaterThan(0);
  });
});
