import { describe, expect, it } from "vitest";
import type { Run } from "@opc/shared";
import { isMemoryReuseEligible } from "./memoryReuseEligibility.js";

function run(patch: Partial<Run> = {}): Run {
  return {
    id: "r1",
    userGoal: "ship",
    status: "done",
    startedAt: "2026-08-02T00:00:00.000Z",
    endedAt: "2026-08-02T00:01:00.000Z",
    totalTokens: 10,
    totalCostUsd: null,
    participatingAgents: ["dev"],
    evidenceIntegrity: "ok",
    deliveryAcceptance: {
      status: "independent_tests_passed",
      requiresCode: true,
      requiresTests: true,
      reasons: [],
    },
    finalState: "tests_passed",
    ...patch,
  };
}

describe("isMemoryReuseEligible", () => {
  it("accepts only a clean evidence-bound terminal run", () => {
    expect(isMemoryReuseEligible(run(), true, false)).toBe(true);
    expect(isMemoryReuseEligible(run({
      deliveryAcceptance: { status: "not_required", requiresCode: false, requiresTests: false, reasons: [] },
      finalState: "verified",
    }), true, false)).toBe(true);
  });

  it.each([
    ["uncertain task node", run(), true, true],
    ["manifest degraded", run({ evidenceIntegrity: "degraded" }), true, false],
    ["unbound tests", run({ deliveryAcceptance: { status: "tests_ran_unbound", requiresCode: true, requiresTests: true, reasons: [] }, finalState: "degraded" }), true, false],
    ["simulated", run({ simulated: true, finalState: "degraded" }), true, false],
    ["partial", run({ partialDelivery: true, finalState: "degraded" }), true, false],
    ["merge conflict", run({ mergeConflicts: [{ taskId: "t", agentId: "a", files: ["x"] }], finalState: "requires_review" }), true, false],
    ["not clean", run(), false, false],
  ])("rejects %s", (_name, candidate, clean, uncertain) => {
    expect(isMemoryReuseEligible(candidate as Run, clean as boolean, uncertain as boolean)).toBe(false);
  });
});
