import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { RuntimeTaskContract } from '@opc/shared';
import { RUNTIME_TASK_CONTRACT_VERSION } from '@opc/shared';
import { readJSON, writeJSON } from '../storage/jsonFile.js';
import { goalForbidsCode, taskRequiresCode, taskRequiresTests } from './deliveryAcceptance.js';

export interface RuntimeTaskContractInput {
  runId: string;
  objective: string;
  companyId?: string;
  missionId?: string;
  taskGraphId?: string;
  runType: string;
  teamMode?: string;
  workRoot: string;
  baseCommit?: string;
  maxTokens?: number;
  maxRetries?: number;
  deadlineMs?: number;
}

function expectedArtifacts(objective: string): string[] {
  return [...new Set(objective.match(/(?:^|\s)([^\s'<>|]+\.[a-zA-Z0-9]{1,12})(?=\s|$|[,.;:!?，。；：！？)）])/g)
    ?.map((value) => value.trim()) ?? [])].slice(0, 64);
}

function hashContract(contract: Omit<RuntimeTaskContract, 'contractHash'>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(contract), 'utf-8').digest('hex')}`;
}

function withHash(contract: Omit<RuntimeTaskContract, 'contractHash'>): RuntimeTaskContract {
  return { ...contract, contractHash: hashContract(contract) };
}

export function createRuntimeTaskContract(input: RuntimeTaskContractInput): RuntimeTaskContract {
  const now = new Date().toISOString();
  const forbidsCode = goalForbidsCode(input.objective);
  const requiresCode = forbidsCode ? false : taskRequiresCode(input.objective);
  const requiresTests = taskRequiresTests(input.objective);
  return withHash({
    schemaVersion: RUNTIME_TASK_CONTRACT_VERSION,
    runId: input.runId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    objective: input.objective,
    scope: {
      ...(input.companyId ? { companyId: input.companyId } : {}),
      ...(input.missionId ? { missionId: input.missionId } : {}),
      ...(input.taskGraphId ? { taskGraphId: input.taskGraphId } : {}),
      runType: input.runType,
      ...(input.teamMode ? { teamMode: input.teamMode } : {}),
    },
    workspace: {
      workRoot: path.resolve(input.workRoot),
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      isolation: input.baseCommit ? 'git-worktree' : 'none',
    },
    acceptance: {
      requiresCode,
      requiresTests,
      forbidsCode,
      expectedArtifacts: expectedArtifacts(input.objective),
      requiresIndependentVerification: requiresCode && requiresTests,
    },
    resources: {
      ...(input.maxTokens && input.maxTokens > 0 ? { maxTokens: input.maxTokens } : {}),
      ...(input.maxRetries !== undefined ? { maxRetries: Math.max(0, input.maxRetries) } : {}),
      ...(input.deadlineMs && input.deadlineMs > 0 ? { deadlineMs: input.deadlineMs } : {}),
    },
    permissions: {
      fileAccess: 'workspace',
      networkAccess: 'guarded',
      shellAccess: 'role-policy',
      mcpAccess: 'registered-only',
    },
    reporting: {
      resultFile: 'result.json',
      diagnosticsFile: 'diagnostics.json',
      changesFile: 'changes.json',
      evidenceManifestFile: 'evidence-manifest.json',
    },
    escalation: {
      failClosedOnMissingCapability: true,
      failClosedOnMissingVerifier: requiresCode && requiresTests,
    },
    recovery: {
      preservePartialArtifacts: true,
      allowResume: true,
    },
    verification: {
      producerManifestRequired: requiresCode,
      testEvidenceRequired: requiresTests,
      artifactHashRequired: requiresCode,
    },
  });
}

export function tightenRuntimeTaskContract(
  current: RuntimeTaskContract,
  patch: { requiresCode?: boolean; requiresTests?: boolean; expectedArtifacts?: string[] },
): RuntimeTaskContract {
  const requiresCode = current.acceptance.forbidsCode
    ? false
    : current.acceptance.requiresCode || patch.requiresCode === true;
  const requiresTests = current.acceptance.requiresTests || patch.requiresTests === true;
  const artifacts = [...new Set([
    ...current.acceptance.expectedArtifacts,
    ...(patch.expectedArtifacts ?? []).map((value) => value.trim()).filter(Boolean),
  ])].slice(0, 64);
  if (
    requiresCode === current.acceptance.requiresCode
    && requiresTests === current.acceptance.requiresTests
    && artifacts.length === current.acceptance.expectedArtifacts.length
  ) return current;
  const { contractHash: _oldHash, ...withoutHash } = current;
  return withHash({
    ...withoutHash,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    acceptance: {
      ...current.acceptance,
      requiresCode,
      requiresTests,
      expectedArtifacts: artifacts,
      requiresIndependentVerification: requiresCode && requiresTests,
    },
    escalation: {
      ...current.escalation,
      failClosedOnMissingVerifier: requiresCode && requiresTests,
    },
    verification: {
      ...current.verification,
      producerManifestRequired: requiresCode,
      testEvidenceRequired: requiresTests,
      artifactHashRequired: requiresCode,
    },
  });
}

const contractPath = (root: string, runId: string) =>
  path.join(root, '.opc', 'runs', runId, 'task-contract.json');

export function writeRuntimeTaskContract(root: string, contract: RuntimeTaskContract): void {
  writeJSON(contractPath(root, contract.runId), contract);
}

export function readRuntimeTaskContract(root: string, runId: string): RuntimeTaskContract | null {
  const contract = readJSON<RuntimeTaskContract | null>(contractPath(root, runId), null);
  if (!contract || contract.runId !== runId || contract.schemaVersion !== RUNTIME_TASK_CONTRACT_VERSION) return null;
  const { contractHash, ...withoutHash } = contract;
  return contractHash === hashContract(withoutHash) ? contract : null;
}

export function formatRuntimeTaskContract(contract: RuntimeTaskContract): string {
  return [
    '## Runtime task contract',
    `contractHash: ${contract.contractHash}`,
    `objective: ${contract.objective}`,
    `workRoot: ${contract.workspace.workRoot}`,
    `requiresCode: ${contract.acceptance.requiresCode}`,
    `requiresTests: ${contract.acceptance.requiresTests}`,
    `forbidsCode: ${contract.acceptance.forbidsCode}`,
    `expectedArtifacts: ${contract.acceptance.expectedArtifacts.join(', ') || '(not specified)'}`,
    'This contract is authoritative. A subtask may tighten it but may not relax it.',
  ].join('\n');
}
