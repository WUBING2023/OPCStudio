import { describe, expect, it } from "vitest";
import { deriveControlHint } from "./controlHints.js";

function fake(attrs: Record<string, string>, textContent = ""): Element {
  return {
    textContent,
    getAttribute(name: string) { return attrs[name] ?? null; },
  } as unknown as Element;
}

describe("deriveControlHint", () => {
  it("prefers an explicit explanation over aria and visible text", () => {
    expect(deriveControlHint(fake({ "data-tooltip": "Refresh the live model catalog", "aria-label": "Refresh" }, "R")))
      .toBe("Refresh the live model catalog");
  });

  it("falls back to aria-label for icon-only controls", () => {
    expect(deriveControlHint(fake({ "aria-label": "Close details" }))).toBe("Close details");
  });

  it("uses concise visible text for ordinary buttons", () => {
    expect(deriveControlHint(fake({}, "  Save   provider  "))).toBe("Save provider");
  });
});