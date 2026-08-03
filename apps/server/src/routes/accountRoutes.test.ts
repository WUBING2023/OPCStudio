import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ProviderConfig } from "@opc/shared";
import { testAccountApiKey, toPublicAccount } from "./accountRoutes.js";

// 多账号自动切换的 UI 支撑面:testAccountApiKey 从"仅 claude-code/codex"泛化到任意 providerId 后的
// 行为覆盖——ProviderAccountsManager(通用组件)靠它给用户一个"这把 key 真的能用吗"的信号。用假
// fetch,不打真实网络/不花真钱。

const realFetch = global.fetch;
let lastUrl: string | undefined;
let lastInit: any;

function mockFetchOk(body: any) {
  global.fetch = vi.fn(async (url: any, init: any) => {
    lastUrl = String(url); lastInit = init;
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as any;
  }) as any;
}

function mockFetchFail(status: number, text = "unauthorized") {
  global.fetch = vi.fn(async (url: any, init: any) => {
    lastUrl = String(url); lastInit = init;
    return { ok: false, status, json: async () => { throw new Error("not json"); }, text: async () => text } as any;
  }) as any;
}

beforeEach(() => { lastUrl = undefined; lastInit = undefined; });
afterEach(() => { global.fetch = realFetch; });

describe("testAccountApiKey — 泛化到任意 providerId(不再只支持 claude-code/codex)", () => {
  it("普通 API 账号(deepseek):无 providers.json 匹配项,靠内建预设 baseUrl 解析,成功请求 → ok:true", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const r = await testAccountApiKey({ apiKey: "sk-good-key", providerId: "deepseek", allowLocalNetwork: true }, [], "deepseek-chat");
    expect(r.ok).toBe(true);
    expect(r.model).toBe("deepseek-chat");
    expect(lastUrl).toContain("api.deepseek.com");
    expect(lastInit.headers.Authorization).toBe("Bearer sk-good-key");
  });

  it("anthropic providerId → 走 anthropic 请求格式(x-api-key header,而非 Bearer)", async () => {
    mockFetchOk({ content: [{ text: "ok" }] });
    const r = await testAccountApiKey({ apiKey: "sk-ant-key", providerId: "anthropic" }, [], "claude-haiku-4-5");
    expect(r.ok).toBe(true);
    expect(lastInit.headers["x-api-key"]).toBe("sk-ant-key");
    expect(lastInit.headers.Authorization).toBeUndefined();
  });

  it("自定义 provider(providers.json 里有匹配项)→ 用它的 apiFormat/baseUrl/defaultModel,不用内建预设", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const providers: ProviderConfig[] = [{
      id: "my-custom", name: "My Custom", kind: "custom", apiFormat: "openai", baseUrl: "https://custom.example.com/v1",
      apiKey: "", models: [], headers: {}, env: {}, options: {} as any, permissions: {} as any,
      defaultModel: "custom-model-1", createdAt: "", updatedAt: "",
    }];
    const r = await testAccountApiKey({ apiKey: "sk-custom-key", providerId: "my-custom", allowLocalNetwork: true }, providers);
    expect(r.ok).toBe(true);
    expect(r.model).toBe("custom-model-1"); // 没显式传 model → 落到 providers.json 里的 defaultModel
    expect(lastUrl).toContain("custom.example.com");
  });

  it("没有 apiKey → 诚实返回失败,不发起请求", async () => {
    mockFetchOk({});
    const r = await testAccountApiKey({ apiKey: "", providerId: "deepseek" }, [], "deepseek-chat");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("API Key");
    expect(lastUrl).toBeUndefined(); // 没打网络请求
  });

  it("解析不出 baseUrl(未知 provider,不在内建预设也不在 providers.json)→ 诚实报错,不猜一个假地址", async () => {
    const r = await testAccountApiKey({ apiKey: "sk-x", providerId: "totally-unknown-provider" }, [], "some-model");
    expect(r.ok).toBe(false);
    expect(r.message).toContain("baseUrl");
  });

  it("解析不出 model(provider 没配 defaultModel,调用方也没传 modelOverride)→ 诚实报错", async () => {
    const r = await testAccountApiKey({ apiKey: "sk-x", providerId: "deepseek" }, []);
    // deepseek 有内建 baseUrl 但没有内建 defaultModel,又没传 modelOverride → 报"请指定模型"而非瞎测
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/模型/);
  });

  it("鉴权失败(401)→ ok:false,带上游返回的状态", async () => {
    mockFetchFail(401, "invalid api key");
    const r = await testAccountApiKey({ apiKey: "sk-bad-key", providerId: "deepseek", allowLocalNetwork: true }, [], "deepseek-chat");
    expect(r.ok).toBe(false);
  });

  it("向后兼容:CLI 框架账号(codex)仍走原本的固定探针,不受泛化影响", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const r = await testAccountApiKey({ apiKey: "sk-codex-key", frameworks: ["codex"], providerId: "openai" }, []);
    expect(r.ok).toBe(true);
    expect(lastUrl).toContain("api.openai.com");
    expect(r.model).toBe("gpt-5-nano"); // CLI_APIKEY_TEST_TARGET 固定值,不受 providers 参数影响
  });
  it("blocks a loopback account endpoint unless local access is explicit", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const r = await testAccountApiKey({
      apiKey: "sk-local",
      providerId: "local-openai",
      baseUrl: "http://127.0.0.1:11434/v1",
    }, [], "local-model");
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/private|local/i);
    expect(lastUrl).toBeUndefined();
  });

  it("allows a loopback account endpoint after explicit authorization", async () => {
    mockFetchOk({ choices: [{ message: { content: "ok" } }] });
    const r = await testAccountApiKey({
      apiKey: "sk-local",
      providerId: "local-openai",
      baseUrl: "http://127.0.0.1:11434/v1",
      allowLocalNetwork: true,
    }, [], "local-model");
    expect(r.ok).toBe(true);
  });
});
describe("toPublicAccount", () => {
  it("does not expose the raw apiKey", () => {
    const pub = toPublicAccount({
      id: "deepseek#0",
      providerId: "deepseek",
      label: "main",
      apiKey: "sk-1234567890abcdef",
      enabled: true,
      maxConcurrent: 6,
    });
    expect(pub).not.toHaveProperty("apiKey");
    expect(pub.hasApiKey).toBe(true);
    expect(pub.authMode).toBe("apiKey");
    expect(pub.apiKeyPreview).toBe("sk-1...ef");
  });

  it("marks subscription accounts without exposing a preview", () => {
    const pub = toPublicAccount({
      id: "codex#0",
      providerId: "openai",
      label: "codex",
      apiKey: "",
      frameworks: ["codex"],
      enabled: true,
      maxConcurrent: 1,
    });
    expect(pub).not.toHaveProperty("apiKey");
    expect(pub.hasApiKey).toBe(false);
    expect(pub.authMode).toBe("subscription");
    expect(pub.apiKeyPreview).toBeUndefined();
  });
});
