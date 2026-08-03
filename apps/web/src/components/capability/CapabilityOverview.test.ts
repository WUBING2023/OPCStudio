import { describe, expect, it } from "vitest";
import { countA2AResolved } from "./CapabilityOverview.js";

describe("A2A capability closure metrics", () => {
  it("uses the same required-closure denominator as Core", () => {
    expect(countA2AResolved([
      { messageType: "delegate_task", to: ["dev"], lifecycle: "resolved" },
      { messageType: "artifact_handoff", to: ["ceo"], lifecycle: "delivered" },
      { messageType: "dependency_blocked", to: ["ceo"], lifecycle: "delivered" },
      { messageType: "artifact_handoff", to: [], lifecycle: "resolved" },
      { lifecycle: "resolved" },
    ])).toEqual({ resolved: 1, total: 2 });
  });
});
