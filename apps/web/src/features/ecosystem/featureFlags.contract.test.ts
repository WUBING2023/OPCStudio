import { describe, expect, it } from "vitest";
import {
  FEATURE_FLAG_REGISTRY,
  FEATURE_FLAG_REGISTRY_ERRORS,
  resolveFeatureFlag,
  resolveFeatureFlags,
  validateFeatureFlagRegistry,
} from "@opc/shared";
import { resolveWebFeatureFlags } from "./runtimeFlags.js";

describe("ecosystem feature flag registry", () => {
  it("declares every horizontal flag with ownership and lifecycle metadata", () => {
    expect(Object.keys(FEATURE_FLAG_REGISTRY)).toEqual([
      "OPC_NEW_NAVIGATION",
      "OPC_HEADLESS_CLI_V2",
      "OPC_CANONICAL_EVENTS_V1",
      "OPC_MCP_SERVER",
      "OPC_CODEX_PLUGIN",
      "OPC_CLAUDE_PLUGIN",
      "OPC_CODEX_NATIVE_ADAPTER",
      "OPC_CLAUDE_NATIVE_ADAPTER",
      "OPC_EMBEDDED_PLUGIN_UI",
      "OPC_PLUGIN_DISCOVERY",
    ]);
    expect(FEATURE_FLAG_REGISTRY_ERRORS).toEqual([]);
    for (const definition of Object.values(FEATURE_FLAG_REGISTRY)) {
      expect(definition.owner).toBeTruthy();
      expect(definition.default).toBe(false);
      expect(definition.removalCondition).toBeTruthy();
      expect(definition.minVersion).toMatch(/^\d+\.\d+\.\d+$/);
      expect(definition.deadlineVersion === "permanent" || /^\d+\.\d+\.\d+$/.test(definition.deadlineVersion)).toBe(true);
    }
    expect(FEATURE_FLAG_REGISTRY.OPC_HEADLESS_CLI_V2).toMatchObject({ releaseStage: "ga", deadlineVersion: "permanent" });
    expect(FEATURE_FLAG_REGISTRY.OPC_CANONICAL_EVENTS_V1).toMatchObject({ releaseStage: "ga", deadlineVersion: "permanent" });
  });

  it("fails closed for unknown flags, malformed overrides, and unsupported versions", () => {
    expect(resolveFeatureFlag("OPC_NOT_REGISTERED", { currentVersion: "99.0.0" })).toBe(false);
    expect(resolveFeatureFlags({
      currentVersion: "0.1.0",
      environment: { OPC_EMBEDDED_PLUGIN_UI: "maybe" },
      persisted: { OPC_EMBEDDED_PLUGIN_UI: true },
    }).OPC_EMBEDDED_PLUGIN_UI).toBe(false);
    expect(resolveFeatureFlags({
      currentVersion: "0.0.9",
      environment: { OPC_EMBEDDED_PLUGIN_UI: "true" },
    }).OPC_EMBEDDED_PLUGIN_UI).toBe(false);
    expect(resolveFeatureFlags({
      currentVersion: "0.5.0",
      environment: { OPC_EMBEDDED_PLUGIN_UI: "true" },
    }).OPC_EMBEDDED_PLUGIN_UI).toBe(false);
    expect(resolveFeatureFlags({
      currentVersion: "0.1.0",
      persisted: { flags: "malformed", OPC_EMBEDDED_PLUGIN_UI: true },
    }).OPC_EMBEDDED_PLUGIN_UI).toBe(false);
  });

  it("rejects malformed registries and incompatible lifecycle versions", () => {
    expect(validateFeatureFlagRegistry({
      bad_name: {
        owner: "",
        default: true,
        minVersion: "soon",
        releaseStage: "stable",
        removalCondition: "",
        deadlineVersion: "0.1.0",
      },
    })).toEqual(expect.arrayContaining([
      "bad_name: invalid flag name",
      "bad_name: unknown flag",
      "bad_name: owner is required",
      "bad_name: default must be fail-closed",
      "bad_name: invalid releaseStage",
      "bad_name: removalCondition is required",
      "bad_name: invalid minVersion",
    ]));
    expect(validateFeatureFlagRegistry({
      OPC_INVALID_GA: {
        owner: "test",
        default: false,
        minVersion: "1.0.0",
        releaseStage: "ga",
        removalCondition: "test only",
        deadlineVersion: "1.1.0",
      },
    })).toContain("OPC_INVALID_GA: GA flags must use a permanent deadline");
  });

  it("uses environment over persisted config and accepts Vite aliases", () => {
    const flags = resolveWebFeatureFlags(
      "0.1.0",
      {
        OPC_PLUGIN_DISCOVERY: "false",
        VITE_OPC_EMBEDDED_PLUGIN_UI: "true",
      },
      JSON.stringify({
        flags: {
          OPC_PLUGIN_DISCOVERY: true,
          OPC_CODEX_NATIVE_ADAPTER: true,
        },
      }),
    );
    expect(flags.OPC_PLUGIN_DISCOVERY).toBe(false);
    expect(flags.OPC_EMBEDDED_PLUGIN_UI).toBe(true);
    expect(flags.OPC_CODEX_NATIVE_ADAPTER).toBe(true);
    expect(flags.OPC_CLAUDE_NATIVE_ADAPTER).toBe(false);
  });
});
