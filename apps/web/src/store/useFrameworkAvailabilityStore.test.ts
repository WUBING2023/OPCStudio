import { describe, expect, it } from "vitest";
import { parseFrameworkAvailabilitySnapshot } from "./useFrameworkAvailabilityStore.js";

describe("framework availability snapshot", () => {
  it("restores a confirmed installed/login state", () => {
    const snapshot = parseFrameworkAvailabilitySnapshot(JSON.stringify({
      frameworks: [{ framework: "codex", installed: true, loggedIn: true, version: "1.2.3" }],
      lastCheckedAt: "2026-07-26T00:00:00.000Z",
    }));
    expect(snapshot?.frameworks[0]).toMatchObject({ framework: "codex", installed: true, loggedIn: true });
  });

  it("rejects malformed or incomplete snapshots", () => {
    expect(parseFrameworkAvailabilitySnapshot(null)).toBeNull();
    expect(parseFrameworkAvailabilitySnapshot("not json")).toBeNull();
    expect(parseFrameworkAvailabilitySnapshot(JSON.stringify({ frameworks: [{ framework: "codex" }], lastCheckedAt: "now" }))).toBeNull();
  });
});
