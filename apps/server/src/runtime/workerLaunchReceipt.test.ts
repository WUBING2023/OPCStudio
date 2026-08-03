import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentNodeConfig, EffectiveCapabilityManifest, ExecContext, ExecTask } from "@opc/shared";
import {
  buildWorkerLaunchReceipt,
  captureWorkerLaunchMetadata,
  emitWorkerLaunchReceipt,
} from "./workerLaunchReceipt.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("WorkerLaunchReceipt", () => {
  it("binds the executable and capability manifest without persisting secret values", async () => {
    const root = mkdtempSync(join(tmpdir(), "opc-launch-receipt-"));
    roots.push(root);
    const executable = join(root, "worker.exe");
    writeFileSync(executable, "deterministic executable bytes", "utf8");

    const capabilityManifest: EffectiveCapabilityManifest = {
      schemaVersion: "1",
      runId: "run-1",
      taskId: "task-1",
      agentId: "agent-1",
      companyId: "company-1",
      framework: "codex",
      generatedAt: new Date(0).toISOString(),
      expiresAt: new Date(60_000).toISOString(),
      requested: { fileWrite: true, shell: "full", network: "on" },
      effective: {
        fileRoots: [{ path: root, read: true, write: true }],
        shell: "full-host",
        network: "unrestricted",
        sandboxBackend: "none",
        fullHostAccess: true,
        approvalMode: "run-governance",
        credentialScope: "subscription-profile",
        environmentNames: ["SECRET_TOKEN"],
        mcpSpecs: [],
      },
      unsupportedConstraints: [],
      manifestHash: "a".repeat(64),
    };
    const events: unknown[] = [];
    const ctx: ExecContext = {
      runId: "run-1",
      projectRoot: root,
      workdir: root,
      emit: (_type, _agentId, payload) => events.push(payload),
      budget: { maxTokensPerTask: 1000 },
      capabilityManifest,
    };
    const node: AgentNodeConfig = {
      id: "agent-1", name: "Agent", role: "dev", childrenIds: [], model: "m", provider: "p",
      framework: "codex", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
      editable: true, deletable: true, enabled: true,
    };
    const task: ExecTask = { taskId: "task-1", goal: "g", systemPrompt: "", maxTokens: 1000 };
    const metadata = captureWorkerLaunchMetadata({
      file: executable,
      args: ["--token", "do-not-persist"],
      env: { SECRET_TOKEN: "do-not-persist" },
      cwd: root,
      attempt: 2,
    });

    const receipt = await buildWorkerLaunchReceipt(node, task, ctx, metadata);
    emitWorkerLaunchReceipt(ctx, node, receipt);

    expect(receipt).toMatchObject({
      schemaVersion: "1",
      attempt: 2,
      completeness: "complete",
      capabilityManifestHash: "a".repeat(64),
      mcpSpecsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      environmentNames: ["SECRET_TOKEN"],
      executable: { path: executable },
    });
    expect(receipt?.executable?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt?.argvHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ receipt, events })).not.toContain("do-not-persist");
  });
});
