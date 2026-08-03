import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = fs.readFileSync(path.join(HERE, "MemoryPage.tsx"), "utf-8");
const DICTS = JSON.parse(fs.readFileSync(path.join(HERE, "../i18n.dict.json"), "utf-8")) as Record<string, Record<string, string>>;

describe("run memory proposal review contract", () => {
  it("loads pending proposals via batch endpoint (no per-company N+1)", () => {
    expect(PAGE).toContain("/memory/run-proposals");
    expect(PAGE).toContain("setRunProposals(runProps || [])");
  });

  it("uses the existing run-scoped approve and reject endpoints and refreshes", () => {
    expect(PAGE).toMatch(/memory-proposals\/\$\{encodeURIComponent\(proposal\.proposalId\)\}\/approve/);
    expect(PAGE).toMatch(/memory-proposals\/\$\{encodeURIComponent\(proposal\.proposalId\)\}\/reject/);
    expect(PAGE).toContain("<RunProposalCard");
    expect(PAGE).toContain("load();");
  });

  it("has user-facing source, risk, and outcome copy in English and Chinese", () => {
    const keys = [
      "memory.proposals.runApproveSuccess",
      "memory.proposals.runRejectSuccess",
      "memory.proposals.source.run_conclusion",
      "memory.proposals.source.reflection_lesson",
      "memory.proposals.risk.low",
      "memory.proposals.risk.high",
    ];
    for (const language of ["en", "zh-CN"]) {
      for (const key of keys) expect(DICTS[language]?.[key], language + " missing " + key).toBeTruthy();
    }
  });
});