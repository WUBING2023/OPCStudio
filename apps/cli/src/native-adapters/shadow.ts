import { NATIVE_ADAPTER_CONTRACT_VERSION, type ShadowComparisonRecord, type ShadowOutcome, type NativeOperation } from "./types.js";

function canonicalHashes(outcome: ShadowOutcome): string[] {
  return [...new Set(outcome.artifactHashes)].sort();
}

export function createShadowComparison(input: {
  runId: string;
  operation: NativeOperation;
  native: ShadowOutcome;
  fallback: ShadowOutcome;
  createdAt?: string;
}): ShadowComparisonRecord {
  const differences: ShadowComparisonRecord["differences"] = [];
  if (input.native.status !== input.fallback.status) differences.push("status");
  if (JSON.stringify(canonicalHashes(input.native)) !== JSON.stringify(canonicalHashes(input.fallback))) {
    differences.push("artifact_hashes");
  }
  if ((input.native.errorCode ?? null) !== (input.fallback.errorCode ?? null)) differences.push("error_code");
  return {
    schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION,
    runId: input.runId,
    operation: input.operation,
    native: { ...input.native, artifactHashes: canonicalHashes(input.native) },
    fallback: { ...input.fallback, artifactHashes: canonicalHashes(input.fallback) },
    equivalent: differences.length === 0,
    differences,
    durationDeltaMs: input.native.durationMs - input.fallback.durationMs,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}
