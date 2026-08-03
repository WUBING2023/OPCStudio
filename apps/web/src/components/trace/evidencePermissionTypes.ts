export interface WorkerPermissionPostureDto {
  agentId: string;
  taskId: string;
  attempt: number;
  engine: string;
  adapter: string;
  launchKind: "in-process" | "subprocess";
  sandboxBackend: "opc-tool-guard" | "codex-workspace-write" | "provider-native" | "none";
  fullHostAccess: boolean;
  network: { requested: string; effective: string };
  shell: { requested: string; effective: string };
  file: { requestedWrite: boolean | null; effective: "full-host" | "workspace-write" | "read-only" | "unknown"; rootCount: number };
  unsupportedConstraints: string[];
  approvalMode: "not-required" | "run-governance";
  receiptCompleteness: "partial" | "complete";
}

export interface ExecutionPermissionPostureDto {
  source: "committed-events" | "uncommitted-events" | "invalid-committed-events" | "missing-events";
  completeness: "complete" | "incomplete" | "not_applicable";
  reasons: string[];
  expectedAgentIds: string[];
  receiptAgentIds: string[];
  missingReceiptAgentIds: string[];
  fullHostAccess: boolean;
  noOsSandbox: boolean;
  unsupportedConstraints: string[];
  approvalModes: string[];
  workers: WorkerPermissionPostureDto[];
}

export interface RunEvidenceManifestDto {
  schemaVersion: number;
  runId: string;
  generatedAt: string;
  evidenceComplete?: boolean;
  permissionPosture?: ExecutionPermissionPostureDto;
}
