import { randomBytes } from "node:crypto";

export interface CredentialLeaseScope {
  runId: string;
  taskId: string;
  agentId: string;
}

export interface CredentialLeaseHandle {
  ref: string;
  environmentName: string;
  expiresAt: string;
}

interface CredentialLeaseRecord extends CredentialLeaseScope {
  secret: string;
  environmentName: string;
  expiresAtMs: number;
}

const leases = new Map<string, CredentialLeaseRecord>();
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;

function purgeExpired(now = Date.now()): void {
  for (const [ref, record] of leases) {
    if (record.expiresAtMs <= now) leases.delete(ref);
  }
}

export function issueCredentialLease(input: CredentialLeaseScope & {
  secret: string;
  environmentName: string;
  ttlMs?: number;
}): CredentialLeaseHandle {
  purgeExpired();
  if (!input.secret) throw new Error("credential secret is empty");
  if (!ENV_NAME_RE.test(input.environmentName)) throw new Error("invalid credential environment name");
  const ttlMs = Math.min(Math.max(input.ttlMs ?? 30_000, 1_000), 5 * 60_000);
  const ref = `cred_${randomBytes(24).toString("base64url")}`;
  const expiresAtMs = Date.now() + ttlMs;
  leases.set(ref, {
    runId: input.runId,
    taskId: input.taskId,
    agentId: input.agentId,
    secret: input.secret,
    environmentName: input.environmentName,
    expiresAtMs,
  });
  return { ref, environmentName: input.environmentName, expiresAt: new Date(expiresAtMs).toISOString() };
}

export function consumeCredentialLease(ref: string, scope: CredentialLeaseScope): {
  environmentName: string;
  secret: string;
} {
  purgeExpired();
  const record = leases.get(ref);
  leases.delete(ref);
  if (!record) throw new Error("credential lease is missing, expired, or already consumed");
  if (record.runId !== scope.runId || record.taskId !== scope.taskId || record.agentId !== scope.agentId) {
    throw new Error("credential lease scope mismatch");
  }
  return { environmentName: record.environmentName, secret: record.secret };
}

export function revokeCredentialLease(ref: string | undefined): void {
  if (ref) leases.delete(ref);
}

export function __credentialLeaseCountForTest(): number {
  purgeExpired();
  return leases.size;
}

