import { describe, expect, it } from "vitest";
import { computeA2AClosure } from "./a2aBus.js";
import { decideLeadOutcomeA2A } from "./leadOutcomeA2A.js";

describe("lead outcome A2A truth gate", () => {
  it("accepted delivery with a real artifact creates required artifact_handoff", () => {
    const decision = decideLeadOutcomeA2A({
      task: "implement feature", deliveryAccepted: true,
      acceptedArtifactRefs: ["art-1"], acceptedFileCount: 1, acceptanceStatus: "independent_tests_passed",
    });
    expect(decision).toMatchObject({
      messageType: "artifact_handoff", contractType: "handoff",
      artifactRefs: ["art-1"], requiredArtifactHandoff: true,
    });
    expect(decision.text).toContain("Accepted deliverables");
    expect(decision.text).not.toContain("team work completed");
  });

  it.each(["no_delivery", "test_failed", "missing_independent_verification"])(
    "%s never creates artifact_handoff even when an early artifact candidate exists",
    (acceptanceStatus) => {
      const decision = decideLeadOutcomeA2A({
        task: "implement feature", deliveryAccepted: false,
        acceptedArtifactRefs: ["early-artifact"], acceptedFileCount: 1, acceptanceStatus,
      });
      expect(decision.messageType).toBe("dependency_blocked");
      expect(decision.contractType).toBe("blocker");
      expect(decision.requiredArtifactHandoff).toBe(false);
      expect(decision.text).toContain("No accepted deliverable");
    },
  );

  it("accepted status without any actual artifact is dependency_blocked and outside required closure", () => {
    const decision = decideLeadOutcomeA2A({
      task: "empty result", deliveryAccepted: true,
      acceptedArtifactRefs: [], acceptedFileCount: 0, acceptanceStatus: "not_required",
    });
    expect(decision.messageType).toBe("dependency_blocked");
    const closure = computeA2AClosure([{
      id: "msg-1", runId: "run-1", from: "lead", to: ["ceo"], text: decision.text,
      timestamp: new Date(0).toISOString(), visibility: { audience: "lead-only" },
      performative: "inform", messageType: decision.messageType, lifecycle: "delivered",
    }]);
    expect(closure.required).toBe(0);
    expect(closure.unresolvedIds).toEqual([]);
  });
});
