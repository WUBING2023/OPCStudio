import { describe, expect, it } from "vitest";
import { resolveTestModel } from "./CliApiKeyAccounts.js";

const models = [
  { id: "doubao-seed-2-0-pro-260215", label: "Doubao Seed 2.0 Pro", isDefault: true },
  { id: "doubao-pro-32k", label: "Doubao Pro 32K" },
];

describe("resolveTestModel", () => {
  it("keeps a model that still exists in the provider catalog", () => {
    expect(resolveTestModel("doubao-pro-32k", "stale-default", models)).toBe("doubao-pro-32k");
  });

  it("replaces a stale model with the catalog default", () => {
    expect(resolveTestModel("doubao-seed-1-6-250615", "stale-default", models))
      .toBe("doubao-seed-2-0-pro-260215");
  });

  it("uses free text when the provider exposes no model catalog", () => {
    expect(resolveTestModel("custom-model", "fallback", [])).toBe("custom-model");
  });
});