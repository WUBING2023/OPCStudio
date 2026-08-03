import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, CapabilityReport, EngineAvailability, ProviderAccount } from "@opc/shared";
import { buildCapabilityReport } from "./capabilityReport.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import {
  isAgentExecutable,
  isProbeReady,
  withGlobalCliSubscriptionAccounts,
} from "./executionAvailability.js";

function agent(): AgentNodeConfig {
  return {
    id: "dev-1", name: "Developer", role: "dev", companyId: "c1",
    framework: "api", provider: "deepseek", model: "m", childrenIds: [],
    editable: true, deletable: true, enabled: true,
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  } as AgentNodeConfig;
}

function report(readyToRun: boolean): CapabilityReport {
  return {
    companyId: "c1", generatedAt: new Date(0).toISOString(), ready: [], needsAuth: [],
    substituted: [], notApplicable: [], authorAnnotated: false, canRun: readyToRun,
    blockedBy: readyToRun ? [] : ["claude-code unavailable"],
    suggestedTeam: [{
      agentId: "dev-1", agentName: "Developer", role: "dev",
      framework: "claude-code", provider: "anthropic", readyToRun,
    }],
  };
}

describe("execution availability · preflight and worker scheduler share one truth", () => {
  let root = "";
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  it("maxQuality global Claude login becomes an executable in-memory AccountPool lease", async () => {
    const r = report(true);
    const accounts = withGlobalCliSubscriptionAccounts([], r);
    expect(isAgentExecutable(agent(), "maxQuality", r, accounts)).toBe(true);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      id: "global-cli#claude-code#anthropic", apiKey: "", frameworks: ["claude-code"], enabled: true,
    });

    const scheduler = new DefaultScheduler(new AccountPool(accounts), { acquireTimeoutMs: 50, cliBackoffMs: 0 });
    const lease = await scheduler.acquire({ providerId: "anthropic", framework: "claude-code", allowFailover: false });
    expect(lease.account.id).toBe("global-cli#claude-code#anthropic");
    lease.release();
  });

  it("unready CLI probe creates no lease carrier and worker selection stays unavailable", () => {
    const r = report(false);
    const accounts = withGlobalCliSubscriptionAccounts([], r);
    expect(accounts).toEqual([]);
    expect(isAgentExecutable(agent(), "maxQuality", r, accounts)).toBe(false);
  });

  it("does not duplicate a persisted global CLI account", () => {
    const existing: ProviderAccount[] = [{
      id: "anthropic#claude", providerId: "anthropic", label: "Claude", apiKey: "",
      frameworks: ["claude-code"], enabled: true, maxConcurrent: 3,
    }];
    expect(withGlobalCliSubscriptionAccounts(existing, report(true))).toHaveLength(1);
  });

  it("probe readiness requires both installation and login", () => {
    const base = { framework: "claude-code", version: "test" } as EngineAvailability;
    expect(isProbeReady({ ...base, installed: true, loggedIn: true })).toBe(true);
    expect(isProbeReady({ ...base, installed: true, loggedIn: false })).toBe(false);
    expect(isProbeReady({ ...base, installed: false, loggedIn: true })).toBe(false);
  });

  it("buildCapabilityReport maxQuality exposes the same ready global CLI target", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "exec-avail-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify([
      { id: "c1", name: "Company", description: "", createdAt: "2026-01-01" },
    ]));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([agent()]));
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: {} }));

    const r = await buildCapabilityReport(root, "c1", {
      probeEngine: async (framework) => ({
        framework: framework as EngineAvailability["framework"], installed: true, loggedIn: true, version: "test",
      }),
      hasProviderKey: () => false,
    }, { teamMode: "maxQuality", runType: "team" });

    expect(r.canRun).toBe(true);
    expect(r.suggestedTeam[0]).toMatchObject({
      agentId: "dev-1", framework: "claude-code", provider: "anthropic", readyToRun: true,
    });
    const accounts = withGlobalCliSubscriptionAccounts([], r);
    expect(isAgentExecutable(agent(), "maxQuality", r, accounts)).toBe(true);
  });
});
