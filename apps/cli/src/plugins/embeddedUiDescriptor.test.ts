import { describe, expect, it } from "vitest";
import {
  EMBEDDED_UI_DESCRIPTOR,
  validateEmbeddedUiDescriptor,
} from "./embeddedUiDescriptor.js";

function clone(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(EMBEDDED_UI_DESCRIPTOR)) as Record<string, unknown>;
}

describe("host-neutral embedded UI descriptor", () => {
  it("declares all five Phase 7 cards with non-creating refresh semantics", () => {
    expect(validateEmbeddedUiDescriptor(EMBEDDED_UI_DESCRIPTOR)).toEqual([]);
    expect(EMBEDDED_UI_DESCRIPTOR.cards.map((card) => card.id)).toEqual([
      "run-status", "approval", "artifacts", "evidence", "company-plan",
    ]);
    expect(EMBEDDED_UI_DESCRIPTOR.cards.every((card) => card.refresh.createsRun === false)).toBe(true);
    expect(EMBEDDED_UI_DESCRIPTOR.headless.requiresEmbeddedUi).toBe(false);
  });

  it("fails closed on an unknown schema or a confirmation that could create a Run", () => {
    const future = clone();
    future.schemaVersion = 2;
    expect(validateEmbeddedUiDescriptor(future)).toContain("embedded UI schema version mismatch");

    const unsafe = clone();
    const cards = unsafe.cards as Array<Record<string, unknown>>;
    const approval = cards.find((card) => card.id === "approval")!;
    const actions = approval.actions as Array<Record<string, unknown>>;
    actions[0].createsRun = true;
    expect(validateEmbeddedUiDescriptor(unsafe)).toContain(
      "embedded UI confirmation must be explicit and non-creating: approval",
    );
  });

  it("rejects local paths and secret-like material from publication metadata", () => {
    const unsafe = clone();
    unsafe.entrypoint = "file:///C:/Users/private/.opc/keys";
    expect(validateEmbeddedUiDescriptor(unsafe)).toContain(
      "embedded UI descriptor contains local path or secret material",
    );
  });
});
