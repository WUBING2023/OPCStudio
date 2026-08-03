import type { Run } from "@opc/shared";
import { isDeliveryVerified } from "./deliveryAcceptance.js";

export type MemoryReuseRun = Pick<Run,
  | "status"
  | "deliveryAcceptance"
  | "finalState"
  | "evidenceIntegrity"
  | "degraded"
  | "executorDegraded"
  | "simulated"
  | "partialDelivery"
  | "mergeConflicts"
>;

/**
 * Positive memory feedback is stricter than merely recording that a memory was injected.
 * Only a fully accepted, evidence-integrity-clean and non-uncertain run may strengthen memory.
 */
export function isMemoryReuseEligible(
  run: MemoryReuseRun,
  allClean: boolean,
  hasUncertainTaskNode: boolean,
): boolean {
  if (!allClean || hasUncertainTaskNode) return false;
  if (run.status !== "done" || run.evidenceIntegrity !== "ok") return false;
  if (!isDeliveryVerified(run.deliveryAcceptance)) return false;
  if (run.finalState !== "verified" && run.finalState !== "tests_passed") return false;
  if (run.degraded || run.executorDegraded || run.simulated || run.partialDelivery) return false;
  if ((run.mergeConflicts?.length ?? 0) > 0) return false;
  return true;
}
