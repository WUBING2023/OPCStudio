import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import express from "express";
import { describe, it, expect } from "vitest";
import { buildModelCatalog, canProbeSubscriptionCatalog, register } from "./modelCatalogRoutes.js";
import { saveModelCatalogRefreshRecord } from "../storage/modelCatalogStore.js";

// 目录端点单一事实源:结构 + 三态。installed 与 ACP 握手都可注入,故断言稳定不依赖本机是否装了 CLI。
const ALL_INSTALLED = async () => ({
  "claude-code": true, codex: true, "gemini-cli": true, "kimi-cli": true, "grok-build": true,
});
const NONE_INSTALLED = async () => ({});

describe("buildModelCatalog · /api/model-catalog 契约", () => {
  it("目录读取只探测不会触发交互登录的订阅引擎", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const probed: string[] = [];
    const cat = await buildModelCatalog(root, {
      installedProbe: ALL_INSTALLED,
      acpProber: async (engine) => {
        probed.push(engine);
        return engine === "claude-code" ? [{ id: "claude-live-1", label: "Live 1", isDefault: true }] : null;
      },
    });
    expect(probed).toEqual(["claude-code", "codex"]);
    expect(cat.subscriptions.map((s) => s.engine)).toEqual(["claude-code", "codex", "gemini", "kimi", "grok"]);
    const cc = cat.subscriptions.find((s) => s.engine === "claude-code")!;
    expect(cc.source).toBe("acp");
    expect(cc.models.map((m) => m.id)).toEqual(["claude-live-1"]);
    const codex = cat.subscriptions.find((s) => s.engine === "codex")!;
    expect(codex.source).toBe("static"); // 握手失败 → 回退静态兜底,非空
    expect(codex.models.length).toBeGreaterThan(0);
    const gemini = cat.subscriptions.find((s) => s.engine === "gemini")!;
    expect(gemini.source).toBe("static"); // 无 ACP adapter
    expect(gemini.models.length).toBeGreaterThan(0);
  }, 60000);

  it("never treats native catalog refresh as login consent", () => {
    expect(canProbeSubscriptionCatalog("claude-code")).toBe(true);
    expect(canProbeSubscriptionCatalog("codex")).toBe(true);
    expect(canProbeSubscriptionCatalog("gemini")).toBe(false);
    expect(canProbeSubscriptionCatalog("kimi")).toBe(false);
    expect(canProbeSubscriptionCatalog("grok")).toBe(false);
  });
  it("rejects native model refresh without launching subscription authentication", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-route-"));
    const app = express();
    app.use(express.json());
    register(app, root);
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test address");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/model-catalog/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "subscription", id: "gemini" }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "explicit_subscription_auth_required" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it("订阅段:未装 → installed:false + 空表,source 仍标 static", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const cat = await buildModelCatalog(root, { installedProbe: NONE_INSTALLED, acpProber: async () => null });
    for (const s of cat.subscriptions) {
      expect(s.installed).toBe(false);
      expect(s.models.length).toBe(0);
      expect(s.source).toBe("static");
    }
  }, 60000);

  it("订阅段:已装但 ACP 全部握手失败 → 全部静态兜底(非空)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const cat = await buildModelCatalog(root, { installedProbe: ALL_INSTALLED, acpProber: async () => null });
    for (const s of cat.subscriptions) {
      expect(s.installed).toBe(true);
      expect(s.source).toBe("static");
      if (s.engine === "kimi" || s.engine === "grok") expect(s.models).toEqual([]);
      else expect(s.models.length).toBeGreaterThan(0);
    }
  }, 60000);

  it("API 供应商段:含 anthropic/openai/deepseek 预设,带 builtin 模型与 hasKey 布尔", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    const cat = await buildModelCatalog(root, { installedProbe: NONE_INSTALLED, acpProber: async () => null });
    const ids = cat.apiProviders.map((p) => p.provider);
    expect(ids).toContain("anthropic");
    expect(ids).toContain("openai");
    expect(ids).toContain("deepseek");
    expect(ids).toContain("groq");
    expect(ids).toContain("kimi");
    expect(ids).toContain("gemini");
    const anthropic = cat.apiProviders.find((p) => p.provider === "anthropic")!;
    expect(typeof anthropic.hasKey).toBe("boolean");
    expect(anthropic.models.map((m) => m.id)).toContain("claude-sonnet-5");
    expect(anthropic.label).toBe("Anthropic");
  }, 60000);

  it("自定义供应商(providers.json)被并入,hasKey 依据自带 apiKey", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".opc", "providers.json"),
      JSON.stringify([{ id: "my-llm", name: "我的私有 LLM", baseUrl: "https://x.test/v1", apiKey: "sk-xyz", apiFormat: "openai" }]),
      "utf-8",
    );
    const cat = await buildModelCatalog(root, { installedProbe: NONE_INSTALLED, acpProber: async () => null });
    const custom = cat.apiProviders.find((p) => p.provider === "my-llm");
    expect(custom).toBeDefined();
    expect(custom!.label).toBe("我的私有 LLM");
    expect(custom!.hasKey).toBe(true);
  }, 60000);

  it("uses the persisted live catalog and exposes its refresh time", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
    saveModelCatalogRefreshRecord(root, {
      kind: "provider",
      id: "deepseek",
      models: [{ id: "deepseek-live", label: "DeepSeek Live" }],
      source: "live",
      refreshedAt: "2026-07-21T12:00:00.000Z",
    });
    saveModelCatalogRefreshRecord(root, {
      kind: "subscription",
      id: "codex",
      models: [{ id: "gpt-live", label: "GPT Live" }],
      source: "acp",
      refreshedAt: "2026-07-21T12:01:00.000Z",
    });

    const cat = await buildModelCatalog(root, { installedProbe: ALL_INSTALLED, acpProber: async () => null });
    expect(cat.apiProviders.find((p) => p.provider === "deepseek")).toMatchObject({
      source: "live",
      refreshedAt: "2026-07-21T12:00:00.000Z",
      models: [{ id: "deepseek-live", label: "DeepSeek Live" }],
    });
    expect(cat.subscriptions.find((s) => s.engine === "codex")).toMatchObject({
      source: "acp",
      refreshedAt: "2026-07-21T12:01:00.000Z",
      models: [{ id: "gpt-live", label: "GPT Live" }],
    });
  });
});
