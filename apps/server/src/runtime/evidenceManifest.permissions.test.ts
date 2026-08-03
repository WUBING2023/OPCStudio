import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EffectiveCapabilityManifest, WorkerLaunchReceipt } from "@opc/shared";
import { buildEvidenceManifest, commitEvidenceReceipts, summarizeExecutionPermissionPosture } from "./evidenceManifest.js";

const REQUIRED = [
  "task.json", "report.md", "report.html", "events.jsonl", "trace.json", "cost.json",
  "changes.json", "deferred.json", "structured-report.json", "result.json", "artifacts.json",
];

describe("EvidenceManifest execution permission posture", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-evidence-permissions-"));
  });

  afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

  function writeRequired(events: unknown[], participatingAgents = ["agent-1"]): void {
    for (const file of REQUIRED) {
      let value = file.endsWith(".json") ? "{}" : "evidence\n";
      if (["changes.json", "deferred.json", "trace.json"].includes(file)) value = "[]";
      if (file === "artifacts.json") value = JSON.stringify({ artifacts: [] });
      if (file === "task.json") value = JSON.stringify({ id: path.basename(runDir), participatingAgents });
      if (file === "events.jsonl") value = events.map((event) => JSON.stringify(event)).join("\n");
      fs.writeFileSync(path.join(runDir, file), value, "utf-8");
    }
  }

  function permissionEvents(options: { includeReceipt?: boolean; includeCapability?: boolean; receiptCompleteness?: "complete" | "partial" } = {}): unknown[] {
    const runId = path.basename(runDir);
    const manifestHash = "a".repeat(64);
    const capability: EffectiveCapabilityManifest = {
      schemaVersion: "1", runId, taskId: "task-1", agentId: "agent-1", companyId: "company-1",
      framework: "codex", generatedAt: "2026-08-02T00:00:00.000Z", expiresAt: "2026-08-02T01:00:00.000Z",
      requested: { fileWrite: true, shell: "allowlist", network: "limited" },
      effective: {
        fileRoots: [{ path: "C:/workspace", read: true, write: true }],
        shell: "full-host", network: "unrestricted", sandboxBackend: "none", fullHostAccess: true,
        approvalMode: "run-governance", credentialScope: "subscription-profile", environmentNames: [], mcpSpecs: [],
      },
      unsupportedConstraints: ["external CLI network scope is not enforceable without an OS sandbox"],
      manifestHash,
    };
    const receipt: WorkerLaunchReceipt = {
      schemaVersion: "1", runId, taskId: "task-1", agentId: "agent-1", attempt: 1,
      launchedAt: "2026-08-02T00:00:01.000Z", launchKind: "subprocess",
      argvHash: "b".repeat(64), environmentNames: [], cwd: "C:/workspace", sandboxBackend: "none",
      fullHostAccess: true, approvalMode: "run-governance", capabilityManifestHash: manifestHash,
      mcpSpecsHash: "c".repeat(64), completeness: options.receiptCompleteness ?? "complete",
    };
    return [
      { type: "model_call_started", agentId: "agent-1", payload: { model: "gpt", provider: "openai" } },
      ...(options.includeCapability === false ? [] : [{ type: "info", agentId: "agent-1", payload: { kind: "effective_capability_manifest", manifest: capability } }]),
      { type: "info", agentId: "agent-1", payload: { kind: "executor_selected", executor: "acp", engine: "codex" } },
      ...(options.includeReceipt === false ? [] : [{ type: "info", agentId: "agent-1", payload: { kind: "worker_launch_receipt", receipt } }]),
    ];
  }

  it("projects committed receipts and their bound capability manifests into an explicit posture", () => {
    writeRequired(permissionEvents());
    commitEvidenceReceipts(runDir);

    const manifest = buildEvidenceManifest(runDir);
    expect(manifest.evidenceComplete).toBe(true);
    expect(manifest.permissionPosture).toMatchObject({
      source: "committed-events",
      completeness: "complete",
      fullHostAccess: true,
      noOsSandbox: true,
      approvalModes: ["run-governance"],
      missingReceiptAgentIds: [],
    });
    expect(manifest.permissionPosture?.workers[0]).toMatchObject({
      agentId: "agent-1", engine: "codex", adapter: "acp", sandboxBackend: "none",
      fullHostAccess: true, network: { requested: "limited", effective: "unrestricted" },
      shell: { requested: "allowlist", effective: "full-host" },
      file: { requestedWrite: true, effective: "full-host", rootCount: 1 },
      approvalMode: "run-governance",
    });
    expect(manifest.permissionPosture?.unsupportedConstraints).toHaveLength(1);
  });

  it("fails permission completeness when an executing agent has no launch receipt", () => {
    writeRequired(permissionEvents({ includeReceipt: false }));
    commitEvidenceReceipts(runDir);

    const posture = summarizeExecutionPermissionPosture(runDir);
    expect(posture.completeness).toBe("incomplete");
    expect(posture.missingReceiptAgentIds).toEqual(["agent-1"]);
    expect(posture.reasons).toContain("missing_launch_receipt:agent-1");
    expect(buildEvidenceManifest(runDir).evidenceComplete).toBe(false);
  });

  it("fails closed when a receipt is partial or cannot bind its capability manifest", () => {
    writeRequired(permissionEvents({ includeCapability: false, receiptCompleteness: "partial" }));
    commitEvidenceReceipts(runDir);

    const posture = summarizeExecutionPermissionPosture(runDir);
    expect(posture.completeness).toBe("incomplete");
    expect(posture.reasons).toEqual(expect.arrayContaining([
      "missing_capability_manifest:agent-1:task-1",
      "partial_launch_receipt:agent-1:task-1",
    ]));
    expect(posture.workers[0].network).toEqual({ requested: "unknown", effective: "unknown" });
  });

  it("never labels live uncommitted events as complete", () => {
    writeRequired(permissionEvents());
    const manifest = buildEvidenceManifest(runDir);
    expect(manifest.permissionPosture?.source).toBe("uncommitted-events");
    expect(manifest.permissionPosture?.completeness).toBe("incomplete");
    expect(manifest.evidenceComplete).toBe(false);
  });

  it("uses not_applicable only for a committed run with no expected worker launch", () => {
    writeRequired([{ type: "run_finished", payload: { status: "failed" } }], []);
    commitEvidenceReceipts(runDir);
    const posture = summarizeExecutionPermissionPosture(runDir);
    expect(posture.completeness).toBe("not_applicable");
    expect(buildEvidenceManifest(runDir).evidenceComplete).toBe(true);
  });
});
