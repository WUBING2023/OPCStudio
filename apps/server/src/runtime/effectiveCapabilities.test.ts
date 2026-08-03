import { afterEach, describe, expect, it } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { buildEffectiveCapabilityManifest, frameworkHasFullHostAccess } from "./effectiveCapabilities.js";

const agent = (framework: AgentNodeConfig["framework"], role = "dev"): AgentNodeConfig => ({
  id: "a-1", name: "A", role, childrenIds: [], model: "m", provider: "p", framework,
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true,
  deletable: true, enabled: true,
});
const task: ExecTask = { taskId: "t-1", goal: "write code", systemPrompt: "", maxTokens: 1000 };
const ctx: ExecContext = {
  runId: "r-1", projectRoot: "M:/missing-project", workdir: "M:/missing-project/work",
  emit: () => {}, budget: { maxTokensPerTask: 1000 },
};

describe("EffectiveCapabilityManifest", () => {
  const old = process.env.OPC_ACP_WORKER;
  afterEach(() => { if (old === undefined) delete process.env.OPC_ACP_WORKER; else process.env.OPC_ACP_WORKER = old; });

  it("marks in-process API execution as guarded and secret-free", () => {
    const manifest = buildEffectiveCapabilityManifest({ agent: agent("api"), framework: "api", task, ctx: { ...ctx, apiKeyOverride: "secret-value" } });
    expect(manifest.effective.sandboxBackend).toBe("opc-tool-guard");
    expect(manifest.effective.fullHostAccess).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain("secret-value");
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("marks the default ACP subscription path as full-host and approval-gated", () => {
    delete process.env.OPC_ACP_WORKER;
    const manifest = buildEffectiveCapabilityManifest({ agent: agent("codex"), framework: "codex", task, ctx });
    expect(manifest.effective.fullHostAccess).toBe(true);
    expect(manifest.effective.approvalMode).toBe("run-governance");
    expect(frameworkHasFullHostAccess("codex")).toBe(true);
  });

  it("records Codex legacy workspace sandbox and collapses limited network to denied", () => {
    process.env.OPC_ACP_WORKER = "0";
    const manifest = buildEffectiveCapabilityManifest({ agent: agent("codex", "researcher"), framework: "codex", task, ctx });
    expect(manifest.effective.sandboxBackend).toBe("codex-workspace-write");
    expect(manifest.effective.fullHostAccess).toBe(false);
    expect(manifest.effective.network).toBe("denied");
    expect(manifest.unsupportedConstraints.join()).toContain("limited network");
  });
});
