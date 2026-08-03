import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useI18n } from "../i18n.js";
import NativeExecutionPreferenceControl, {
  resolveNativeExecutionChoices,
  type NativeExecutionFeatureFlags,
} from "./NativeExecutionPreferenceControl.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENABLED: NativeExecutionFeatureFlags = {
  OPC_CODEX_NATIVE_ADAPTER: true,
  OPC_CLAUDE_NATIVE_ADAPTER: true,
};

describe("Native execution preference UI", () => {
  it("fails closed when Native feature flags are disabled", () => {
    expect(resolveNativeExecutionChoices({
      OPC_CODEX_NATIVE_ADAPTER: false,
      OPC_CLAUDE_NATIVE_ADAPTER: false,
    })).toEqual([
      { preference: "acp", enabled: true },
      { preference: "codex-native", enabled: false, reason: "feature_disabled" },
      { preference: "claude-native", enabled: false, reason: "feature_disabled" },
    ]);
  });

  it("allows only the Native adapter matching the employee framework", () => {
    expect(resolveNativeExecutionChoices(ENABLED, "codex")).toEqual([
      { preference: "acp", enabled: true },
      { preference: "codex-native", enabled: true, reason: undefined },
      { preference: "claude-native", enabled: false, reason: "framework_mismatch" },
    ]);
    expect(resolveNativeExecutionChoices(ENABLED, "claude-code")[2]).toMatchObject({
      preference: "claude-native",
      enabled: true,
    });
  });

  it("renders all routes and an explicit fail-closed fallback choice", () => {
    useI18n.setState({ lang: "en" });
    const html = renderToStaticMarkup(createElement(NativeExecutionPreferenceControl, {
      scope: "agent",
      framework: "codex",
      featureFlags: ENABLED,
      inheritedValue: { preference: "codex-native", fallback: "blocked" },
      onChange: () => undefined,
    }));
    expect(html).toContain("ACP");
    expect(html).toContain("Codex Native");
    expect(html).toContain("Claude Native");
    expect(html).toContain("Block the run");
    expect(html).toContain("Inherited from company");
    expect(html).toContain("aria-pressed=\"true\"");
    expect(html).toContain("blocked run");
  });

  it("is wired to both company and employee persistence paths", () => {
    const companySource = fs.readFileSync(path.join(HERE, "org", "CompanyStructureForms.tsx"), "utf-8");
    const agentSource = fs.readFileSync(path.join(HERE, "AgentDetailsPanel.tsx"), "utf-8");
    expect(companySource).toContain('scope="company"');
    expect(companySource).toContain("patchCompany({ nativeExecution })");
    expect(agentSource).toContain('scope="agent"');
    expect(agentSource).toContain("update(agent.id, { nativeExecution })");
    expect(agentSource).toContain("framework={currentFramework}");
    expect(agentSource).toContain("inheritedValue={companyNativeExecution}");
  });
});
