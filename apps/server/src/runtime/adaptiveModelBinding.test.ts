import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  resolveSystem: vi.fn(),
  resolveAuto: vi.fn(),
  probeClaude: vi.fn(),
  probeCodex: vi.fn(),
  probeGemini: vi.fn(),
  probeKimi: vi.fn(),
  probeGrok: vi.fn(),
}));

vi.mock("./providerRegistry.js", () => ({
  collectConfiguredProviderCapabilities: mocks.collect,
}));
vi.mock("./systemModel.js", () => ({
  inferSystemFramework: (provider: string) => provider === "openai" ? "codex" : "api",
  resolveSystemModel: mocks.resolveSystem,
  resolveAutoSubscription: mocks.resolveAuto,
}));
vi.mock("./engines/probes.js", () => ({
  probeClaudeCodeAsync: mocks.probeClaude,
  probeCodexAsync: mocks.probeCodex,
  probeGeminiCliAsync: mocks.probeGemini,
  probeKimiCliAsync: mocks.probeKimi,
  probeGrokBuildAsync: mocks.probeGrok,
}));

import { resolveAdaptiveModelBinding } from "./adaptiveModelBinding.js";

const ready = { installed: true, loggedIn: true, version: "test" };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.collect.mockReturnValue({ availableProviders: new Set<string>(), defaultModels: new Map<string, string>() });
  mocks.resolveSystem.mockReturnValue({ framework: "api", provider: "deepseek", model: "deepseek-chat" });
  mocks.resolveAuto.mockImplementation(async (choice: any) => ({ kind: "keep", choice, reason: "has-key" }));
  mocks.probeClaude.mockResolvedValue({ framework: "claude-code", ...ready });
  mocks.probeCodex.mockResolvedValue({ framework: "codex", ...ready });
  mocks.probeGemini.mockResolvedValue({ framework: "gemini-cli", ...ready });
  mocks.probeKimi.mockResolvedValue({ framework: "kimi-cli", ...ready });
  mocks.probeGrok.mockResolvedValue({ framework: "grok-build", ...ready });
});

describe("resolveAdaptiveModelBinding", () => {
  it("keeps an explicitly requested API binding only after the runtime availability resolver accepts it", async () => {
    const result = await resolveAdaptiveModelBinding("X:/project", {
      framework: "api", provider: "minimax", model: "MiniMax-M3",
    });
    expect(result).toMatchObject({
      choice: { framework: "api", provider: "minimax", model: "MiniMax-M3" },
      source: "requested", substituted: false,
    });
  });

  it("falls back to a logged-in system subscription when the requested API is unavailable", async () => {
    mocks.resolveSystem.mockReturnValue({ framework: "codex", provider: "openai", model: "gpt-5.5" });
    mocks.resolveAuto.mockImplementation(async (choice: any) => choice.provider === "minimax"
      ? { kind: "unavailable", provider: "minimax", subscription: "" }
      : { kind: "keep", choice, reason: "already-subscription" });

    const result = await resolveAdaptiveModelBinding("X:/project", {
      framework: "api", provider: "minimax", model: "MiniMax-M3",
    });
    expect(result.source).toBe("system-default");
    expect(result.choice.framework).toBe("codex");
    expect(mocks.probeCodex).toHaveBeenCalledOnce();
  });

  it("does not require a Gemini account and falls back from unavailable Google models to ready Codex", async () => {
    mocks.resolveSystem.mockReturnValue({ framework: "codex", provider: "openai", model: "gpt-5.5" });
    mocks.resolveAuto.mockImplementation(async (choice: any) => choice.provider === "google"
      ? { kind: "unavailable", provider: "google", subscription: "gemini-cli" }
      : { kind: "keep", choice, reason: "already-subscription" });

    const result = await resolveAdaptiveModelBinding("X:/project", {
      framework: "api", provider: "google", model: "gemini-2.5-pro",
    });
    expect(result).toMatchObject({ source: "system-default", choice: { framework: "codex" } });
    expect(mocks.probeGemini).not.toHaveBeenCalled();
    expect(mocks.probeCodex).toHaveBeenCalledOnce();
  });
  it("strict requested mode rejects an unavailable explicit choice instead of silently changing models", async () => {
    mocks.collect.mockReturnValue({
      availableProviders: new Set(["doubao"]),
      defaultModels: new Map([["doubao", "doubao-seed-2"]]),
    });
    mocks.resolveAuto.mockImplementation(async (choice: any) => choice.provider === "minimax"
      ? { kind: "unavailable", provider: "minimax", subscription: "" }
      : { kind: "keep", choice, reason: "has-key" });

    await expect(resolveAdaptiveModelBinding(
      "X:/project",
      { framework: "api", provider: "minimax", model: "MiniMax-M3" },
      "creative",
      { strictRequested: true },
    )).rejects.toThrow("没有可用于新员工");
  });

  it("uses a configured API default when both requested and system choices are unavailable", async () => {
    mocks.collect.mockReturnValue({
      availableProviders: new Set(["doubao"]),
      defaultModels: new Map([["doubao", "doubao-seed-2"]]),
    });
    mocks.resolveAuto.mockImplementation(async (choice: any) => choice.provider === "doubao"
      ? { kind: "keep", choice, reason: "has-key" }
      : { kind: "unavailable", provider: choice.provider, subscription: "" });

    const result = await resolveAdaptiveModelBinding("X:/project", {
      framework: "api", provider: "minimax", model: "MiniMax-M3",
    });
    expect(result).toMatchObject({
      source: "configured-api",
      choice: { framework: "api", provider: "doubao", model: "doubao-seed-2" },
    });
  });

  it("rejects installed-but-not-logged-in subscriptions and leaves no fake executable binding", async () => {
    mocks.resolveSystem.mockReturnValue({ framework: "codex", provider: "openai", model: "gpt-5.5" });
    mocks.resolveAuto.mockImplementation(async (choice: any) => ({ kind: "keep", choice, reason: "already-subscription" }));
    mocks.probeCodex.mockResolvedValue({ framework: "codex", installed: true, loggedIn: false, version: "test" });
    await expect(resolveAdaptiveModelBinding("X:/project")).rejects.toThrow("没有可用于新员工");
  });

  it("does not mistake no-key-no-subscription for an available custom API", async () => {
    mocks.resolveAuto.mockImplementation(async (choice: any) => ({ kind: "keep", choice, reason: "no-key-no-subscription" }));
    await expect(resolveAdaptiveModelBinding("X:/project", {
      framework: "api", provider: "custom", model: "custom-model",
    })).rejects.toThrow("没有可用于新员工");
  });
});
