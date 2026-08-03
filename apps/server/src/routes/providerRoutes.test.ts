import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProviderConfig } from "@opc/shared";
import { register, maskApiKey } from "./providerRoutes.js";
import { saveProviders, loadProviders } from "../storage/providerStore.js";

// MUP B7 · provider 泄漏面:headers(可含 Authorization Bearer token)/env 与 apiKey 同口径
// 响应侧掩码 + 掩码往返不回写。存储 schema 不动(hermes 读侧 alias 红线),真值只活在盘上。

const REAL_KEY = "sk-realapikey1234567890";
const REAL_AUTH = "Bearer real-authorization-token-42";
const REAL_ENV = "env-secret-value-7890";

function seedProvider(root: string): ProviderConfig {
  const p = {
    id: "prov-1", name: "测试供应商", kind: "custom", apiFormat: "openai",
    baseUrl: "https://api.example.com/v1", apiKey: REAL_KEY,
    models: [], headers: { Authorization: REAL_AUTH }, env: { MY_TOKEN: REAL_ENV },
    options: {
      hideAISignature: false, enableTeammatesMode: false, enableToolSearch: false,
      enableMaxThinking: false, disableAutoUpgrade: false, allowPromptCaching: true, allowStreaming: true,
    },
    permissions: { allow: [], deny: [] },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ProviderConfig;
  saveProviders(root, [p]);
  return p;
}

async function startTestServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("providerRoutes — apiKey/headers/env 掩码与往返", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-routes-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    seedProvider(root);
    ({ server, baseUrl } = await startTestServer(root));
  });

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  it("GET 列表与详情:apiKey/headers/env 值全部掩码,不回明文", async () => {
    const list = await (await fetch(`${baseUrl}/api/providers`)).json();
    expect(list[0].apiKey).toBe(maskApiKey(REAL_KEY));
    expect(list[0].headers.Authorization).toBe(maskApiKey(REAL_AUTH));
    expect(list[0].env.MY_TOKEN).toBe(maskApiKey(REAL_ENV));
    const one = await (await fetch(`${baseUrl}/api/providers/prov-1`)).json();
    expect(one.headers.Authorization).toBe(maskApiKey(REAL_AUTH));
    expect(JSON.stringify([list, one])).not.toContain(REAL_AUTH);
    expect(JSON.stringify([list, one])).not.toContain(REAL_ENV);
    expect(JSON.stringify([list, one])).not.toContain(REAL_KEY);
  });

  it("PATCH 掩码往返不回写:回显掩码串不覆盖 headers/env/apiKey 真值", async () => {
    const res = await fetch(`${baseUrl}/api/providers/prov-1`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "改名供应商",
        apiKey: maskApiKey(REAL_KEY),
        headers: { Authorization: maskApiKey(REAL_AUTH) },
        env: { MY_TOKEN: maskApiKey(REAL_ENV) },
      }),
    });
    expect(res.status).toBe(200);
    const stored = loadProviders(root)[0];
    expect(stored.name).toBe("改名供应商");
    expect(stored.apiKey).toBe(REAL_KEY);
    expect(stored.headers?.Authorization).toBe(REAL_AUTH);
    expect(stored.env?.MY_TOKEN).toBe(REAL_ENV);
    // 响应侧仍掩码
    const body = await res.json();
    expect(body.headers.Authorization).toBe(maskApiKey(REAL_AUTH));
  });

  it("PATCH 新明文值正常更新;新增 key 不受往返保护误伤", async () => {
    const res = await fetch(`${baseUrl}/api/providers/prov-1`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        headers: { Authorization: "Bearer brand-new-token-99", "X-Extra": "plain-new-value" },
        env: { MY_TOKEN: maskApiKey(REAL_ENV), NEW_TOKEN: "another-secret-123" },
      }),
    });
    expect(res.status).toBe(200);
    const stored = loadProviders(root)[0];
    expect(stored.headers?.Authorization).toBe("Bearer brand-new-token-99");
    expect(stored.headers?.["X-Extra"]).toBe("plain-new-value");
    expect(stored.env?.MY_TOKEN).toBe(REAL_ENV);
    expect(stored.env?.NEW_TOKEN).toBe("another-secret-123");
  });

  it("POST test: masked key is restored to the stored secret before the provider request", async () => {
    const originalFetch = globalThis.fetch;
    let authorization = "";
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:9/")) {
        authorization = String((init?.headers as Record<string, string>)?.Authorization ?? "");
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    });
    try {
      const res = await originalFetch(`${baseUrl}/api/providers/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          providerId: "prov-1",
          apiFormat: "openai",
          baseUrl: "http://127.0.0.1:9",
          apiKey: maskApiKey(REAL_KEY),
          model: "test-model",
          allowLocalNetwork: true,
        }),
      });
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(authorization).toBe(`Bearer ${REAL_KEY}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });});
