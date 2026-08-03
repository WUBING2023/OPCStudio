import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelCache, listModels } from "./modelRegistry.js";

function rootWithProvider(provider: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-registry-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "providers.json"), JSON.stringify([provider]), "utf8");
  return root;
}

afterEach(() => {
  clearModelCache();
  vi.unstubAllGlobals();
});

describe("listModels live provider discovery", () => {
  it("uses bearer authentication for OpenAI-compatible providers", async () => {
    const root = rootWithProvider({
      id: "custom-openai", name: "Custom", kind: "custom", apiFormat: "openai",
      baseUrl: "http://127.0.0.1:11435/v1", apiKey: "secret", allowLocalNetwork: true,
    });
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: "chat-live" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listModels(root, "custom-openai");

    expect(result).toEqual({ models: ["chat-live"], source: "live" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer secret" });
  });

  it("uses Gemini authentication and normalizes models/ prefixes", async () => {
    const root = rootWithProvider({
      id: "custom-gemini", name: "Gemini", kind: "custom", apiFormat: "gemini",
      baseUrl: "http://127.0.0.1:11436/v1beta", apiKey: "gemini-secret", allowLocalNetwork: true,
    });
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ models: [{ name: "models/gemini-live" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listModels(root, "custom-gemini");

    expect(result).toEqual({ models: ["gemini-live"], source: "live" });
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-goog-api-key": "gemini-secret" });
  });

  it("refreshes local Ollama without requiring an API key", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ id: "qwen-live" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-registry-"));

    const result = await listModels(root, "ollama");

    expect(result.source).toBe("live");
    expect(result.models).toContain("qwen-live");
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({});
  });
});