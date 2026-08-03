import { afterEach, describe, expect, it } from "vitest";
import { routeEngine } from "./engineRouter.js";
import {
  CapabilityBlockedEngine,
  NativeFallbackEngine,
  NativeRouteFallbackEngine,
} from "./engines/CodexNativeEngine.js";
import { ClaudeNativeEngine } from "./engines/ClaudeNativeEngine.js";

afterEach(() => {
  delete process.env.OPC_CODEX_NATIVE_ADAPTER;
  delete process.env.OPC_CLAUDE_NATIVE_ADAPTER;
});

describe("native execution routing", () => {
  it("is default-off and explicitly degrades to ACP when fallback is allowed", () => {
    const route = routeEngine("codex", "dev", { preference: "codex-native", fallback: "acp" });
    expect(route.nativeExecution).toMatchObject({
      requested: "codex-native",
      selected: "acp",
      failureKind: "feature_disabled",
    });
    expect(route.engine).toBeInstanceOf(NativeRouteFallbackEngine);
  });

  it("selects the native bridge only when the feature flag is enabled", () => {
    process.env.OPC_CODEX_NATIVE_ADAPTER = "true";
    const route = routeEngine("codex", "dev", { preference: "codex-native", fallback: "acp" });
    expect(route.nativeExecution).toEqual({ requested: "codex-native", selected: "codex-native" });
    expect(route.engine).toBeInstanceOf(NativeFallbackEngine);
  });

  it("blocks instead of silently falling back when fallback=blocked", async () => {
    const route = routeEngine("codex", "dev", { preference: "codex-native", fallback: "blocked" });
    expect(route.engine).toBeInstanceOf(CapabilityBlockedEngine);
    expect(route.nativeExecution).toMatchObject({ selected: "blocked", failureKind: "feature_disabled" });
  });

  it("selects the official Claude Agent SDK bridge only when its feature flag is enabled", () => {
    process.env.OPC_CLAUDE_NATIVE_ADAPTER = "true";
    const route = routeEngine("claude-code", "dev", { preference: "claude-native", fallback: "blocked" });
    expect(route.engine).toBeInstanceOf(ClaudeNativeEngine);
    expect(route.nativeExecution).toEqual({ requested: "claude-native", selected: "claude-native" });
  });

  it("keeps Claude native default-off and rejects framework mismatches", () => {
    expect(routeEngine("claude-code", "dev", { preference: "claude-native", fallback: "acp" }).nativeExecution)
      .toMatchObject({ selected: "acp", failureKind: "feature_disabled" });
    process.env.OPC_CLAUDE_NATIVE_ADAPTER = "true";
    expect(routeEngine("codex", "dev", { preference: "claude-native", fallback: "blocked" }).nativeExecution)
      .toMatchObject({ selected: "blocked", failureKind: "capability_unavailable" });
  });
});
