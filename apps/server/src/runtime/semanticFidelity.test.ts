import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanyTemplate } from "@opc/shared";
import {
  SemanticFidelityError,
  buildSemanticFidelityReport,
  finalizeSemanticFidelity,
  safeInstallApprovedFields,
} from "./semanticFidelity.js";
import { loadSemanticFidelityReports } from "../storage/semanticFidelityStore.js";

function template(overrides: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "source",
    title: "Semantic team",
    description: "test",
    agents: [{
      id: "ceo-source", name: "CEO", role: "ceo", provider: "deepseek", model: "chat",
      framework: "api", childrenIds: [], companyId: "source", workspaceDir: "C:\\secret\\workspace",
      status: "working", tokenUsage: { prompt: 10, completion: 5, total: 15 },
    }],
    workflow: { verificationEdges: [] },
    mcpRequirements: [{ name: "browser" }],
    ...overrides,
  } as CompanyTemplate;
}

describe("Phase5 Semantic Fidelity Report", () => {
  it("uses registry + ledger to classify preserved, transformed, redacted and local setup fields", () => {
    const source = template({ a2aChannels: [{ from: "ceo-source", to: "ceo-source" }] });
    const target = template({
      agents: [{ ...source.agents[0], id: "ceo-target", companyId: "target", workspaceDir: undefined, status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 } }],
      a2aChannels: undefined,
    });
    const report = buildSemanticFidelityReport({
      operation: "import", sourceSchemaVersion: "0.3.0", targetSchemaVersion: "0.3.0",
      source, target,
      overrides: {
        redacted: ["agents[0].workspaceDir"],
        approvedAfterImport: safeInstallApprovedFields([{ id: "preset-a2a-channels" }]),
      },
    });

    expect(report.ok).toBe(true);
    expect(report.lostCount).toBe(0);
    expect(report.preserved).toContain("workflow");
    expect(report.transformed).toContain("a2aChannels");
    expect(report.redacted).toContain("agents[0].workspaceDir");
    expect(report.requiresLocalSetup).toContain("mcpRequirements");
    expect(report.reportHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it("persists the report before failing closed and never serializes source secret values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-fidelity-"));
    const source = template({ workflow: { verificationEdges: [{ producer: "dev", verifier: "test", method: "code-review", onReject: "redo" }] } });
    const target = template({ workflow: undefined });
    expect(() => finalizeSemanticFidelity({
      projectRoot: root,
      operation: "restore", sourceSchemaVersion: "legacy", targetSchemaVersion: "0.3.0",
      source, target,
      overrides: { redacted: ["agents[0].workspaceDir"] },
    })).toThrow(SemanticFidelityError);

    const [stored] = loadSemanticFidelityReports(root);
    expect(stored.report.ok).toBe(false);
    expect(stored.report.lost).toContain("workflow");
    const raw = fs.readFileSync(path.join(root, ".opc", "semantic-fidelity-reports.json"), "utf-8");
    expect(raw).not.toContain("C:\\secret\\workspace");
  });

  it("hash is deterministic and changes when semantic categories change", () => {
    const source = template();
    const base = { operation: "import" as const, sourceSchemaVersion: "legacy", targetSchemaVersion: "0.3.0", source, target: template() };
    const a = buildSemanticFidelityReport(base);
    const b = buildSemanticFidelityReport(base);
    const c = buildSemanticFidelityReport({ ...base, overrides: { transformed: ["workflow"] } });
    expect(a.reportHash).toBe(b.reportHash);
    expect(c.reportHash).not.toBe(a.reportHash);
  });
  it("keeps field fidelity separate from runtime equivalence when bindings are mapped", () => {
    const source = template();
    const target = template({
      agents: [{ ...source.agents[0], provider: "openai", model: "gpt-5", framework: "codex" }],
    });
    const report = buildSemanticFidelityReport({
      operation: "import",
      sourceSchemaVersion: "0.3.0",
      targetSchemaVersion: "0.3.0",
      source,
      target,
      overrides: { transformed: ["agents[0].provider", "agents[0].model", "agents[0].framework"] },
      runtime: {
        bindingPlans: [{
          originalBinding: { kind: "provider", name: "deepseek" },
          status: "missing",
          action: "map",
          targetBinding: { engine: "codex", provider: "openai", model: "gpt-5" },
          userApproved: true,
        }],
      },
    });

    expect(report.fieldFidelity.ok).toBe(true);
    expect(report.ok).toBe(true);
    expect(report.runtimeEquivalent).toBe(false);
    expect(report.runtimeSemantics.status).toBe("degraded");
    expect(report.runtimeSemantics.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: "provider-engine-model", status: "transformed-not-proven" }),
      expect.objectContaining({ dimension: "provider-engine-model", status: "degraded" }),
    ]));
    expect(report.runtimeSemantics.notCollected).toContain("runtime-readiness");
  });

  it("compares every declared runtime dimension and degrades disabled agents or missing MCP", () => {
    const source = template({
      requiredPermissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true, mcpServers: ["browser"] },
      toolRequirements: { requiredEngines: ["api"], requiredProviders: ["deepseek"], requiredMcpServers: ["browser"], requiredSkills: [], optionalTools: [] },
      workflow: { verificationEdges: [{ producer: "ceo-source", verifier: "ceo-source", method: "llm-review", onReject: "flag" }] },
      a2aChannels: [{ from: "ceo-source", to: "ceo-source", direction: "oneway", enabled: true }],
      visibilityPolicy: "isolated",
      agentMemories: [{ agent_id: "ceo-source", role: "ceo", content: "portable" }],
      agents: [{ ...template().agents[0], workingDirectory: "apps/server", visibilityPolicy: "isolated" }],
    });
    const target = template({
      requiredPermissions: { allowShell: false, allowFileWrite: false, allowWebAccess: false, mcpServers: [] },
      toolRequirements: { requiredEngines: ["codex"], requiredProviders: ["openai"], requiredMcpServers: [], requiredSkills: [], optionalTools: [] },
      workflow: { verificationEdges: [] },
      a2aChannels: [],
      visibilityPolicy: "default",
      agentMemories: [{ agent_id: "ceo-source", role: "lead", content: "portable" }],
      agents: [{
        ...source.agents[0],
        provider: "openai",
        model: "gpt-5",
        framework: "codex",
        enabled: false,
        workingDirectory: "apps/web",
        visibilityPolicy: "default",
      }],
    });
    const report = buildSemanticFidelityReport({
      operation: "import",
      sourceSchemaVersion: "0.3.0",
      targetSchemaVersion: "0.3.0",
      source,
      target,
      runtime: {
        missingCapabilities: [{ kind: "mcp", name: "browser", reason: "not configured locally" }],
      },
    });

    expect(report.runtimeEquivalent).toBe(false);
    expect(report.runtimeSemantics.status).toBe("degraded");
    expect(report.runtimeSemantics.degraded).toEqual(expect.arrayContaining(["agent-availability", "mcp"]));
    expect(report.runtimeSemantics.transformedNotProven).toEqual(expect.arrayContaining([
      "provider-engine-model",
      "agent-availability",
      "permissions",
      "mcp",
      "verification-edges",
      "a2a",
      "working-directory",
      "visibility",
      "memory-scope",
    ]));
  });

  it("migrates legacy field-only reports to explicit not-collected runtime proof", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-fidelity-v1-"));
    const store = path.join(root, ".opc", "semantic-fidelity-reports.json");
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify({
      schemaVersion: "1",
      reports: [{
        recordedAt: "2026-08-02T00:00:00.000Z",
        report: {
          schemaVersion: "1",
          operation: "import",
          sourceSchemaVersion: "legacy",
          targetSchemaVersion: "0.3.0",
          preserved: ["workflow"],
          transformed: [],
          redacted: [],
          requiresLocalSetup: [],
          lost: [],
          lostCount: 0,
          ok: true,
          reportHash: "sha256:legacy",
        },
      }],
    }), "utf-8");

    const [stored] = loadSemanticFidelityReports(root);
    expect(stored.report.schemaVersion).toBe("2");
    expect(stored.report.fieldFidelity.ok).toBe(true);
    expect(stored.report.runtimeEquivalent).toBe(false);
    expect(stored.report.runtimeSemantics).toMatchObject({
      status: "not-collected",
      proofLevel: "not-collected",
      equivalent: false,
    });
    expect(stored.report.reportHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});
