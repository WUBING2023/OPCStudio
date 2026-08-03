import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CompanyBundleSchema, RunEventSchema } from "@opc/shared";
import { GovernedMemoryProposalSchema } from "./memoryGovernance.js";

interface BaselineManifest {
  schemaVersion: 1;
  files: Array<{ path: string; sha256: string; kind: string; source?: string }>;
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const baselineRoot = path.join(repoRoot, "evidence", "ecosystem-baseline");
const readJson = (relativePath: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(baselineRoot, relativePath), "utf-8"));
const digest = (file: string): string => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

describe("Phase 0 ecosystem golden baseline", () => {
  it("keeps canonical fixtures readable by current schemas", () => {
    expect(CompanyBundleSchema.safeParse(readJson("fixtures/company-bundle.v0.3.0.json")).success).toBe(true);
    expect(RunEventSchema.safeParse(readJson("fixtures/run-event.v1.json")).success).toBe(true);
    expect(GovernedMemoryProposalSchema.safeParse(readJson("fixtures/memory-proposal.v2.json")).success).toBe(true);
  });

  it("locks every declared evidence file by SHA-256", () => {
    const manifest = readJson("manifest.json") as BaselineManifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThanOrEqual(8);
    for (const entry of manifest.files) {
      expect(entry.path).not.toMatch(/^(?:[A-Za-z]:|\\\\|\/)/);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
      const file = path.resolve(baselineRoot, entry.path);
      expect(path.relative(baselineRoot, file)).not.toMatch(/^\.\.(?:[\\/]|$)/);
      expect(fs.statSync(file).isFile()).toBe(true);
      expect(digest(file)).toBe(entry.sha256);
    }
  });
});
