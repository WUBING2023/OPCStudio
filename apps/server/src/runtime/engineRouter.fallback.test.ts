import { describe, expect, it } from "vitest";
import { pickFallbackEngine } from "./engineRouter.js";

describe("pickFallbackEngine availability", () => {
  it("does not route to an API fallback without a usable provider", () => {
    const fallback = pickFallbackEngine(
      "codex/openai/gpt-5.6-luna",
      Date.now(),
      () => false,
    );
    expect(fallback).toBeNull();
  });

  it("returns the first fallback that is both healthy and available", () => {
    const fallback = pickFallbackEngine(
      "codex/openai/gpt-5.6-luna",
      Date.now(),
      (candidate) => candidate.provider === "deepseek",
    );
    expect(fallback).toMatchObject({ framework: "api", provider: "deepseek" });
  });
});