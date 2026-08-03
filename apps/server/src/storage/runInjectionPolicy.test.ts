import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isFromExcludedRun, runExcludedFromInjection } from "./runInjectionPolicy.js";

let root: string;
let runsDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "run-injection-policy-"));
  runsDir = path.join(root, ".opc", "runs");
  fs.mkdirSync(runsDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTask(runId: string, value: unknown): void {
  const dir = path.join(runsDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), typeof value === "string" ? value : JSON.stringify(value), "utf-8");
}

describe("run injection policy", () => {
  it("fails closed for missing, malformed, queued, running, and failed runs", () => {
    expect(runExcludedFromInjection(runsDir, "missing")).toBe(true);
    writeTask("malformed", "{not-json");
    expect(runExcludedFromInjection(runsDir, "malformed")).toBe(true);

    for (const status of ["queued", "running", "failed"]) {
      writeTask(status, { status });
      expect(runExcludedFromInjection(runsDir, status)).toBe(true);
    }
  });

  it("rejects every known degraded done state", () => {
    const badStates = [
      { status: "done", degraded: true },
      { status: "done", simulated: true },
      { status: "done", executorDegraded: true },
      { status: "done", partialDelivery: true },
      { status: "done", evidenceIntegrity: "degraded" },
      { status: "done", finalState: "degraded" },
      { status: "done", finalState: "failed" },
      { status: "done", finalState: "requires_review" },
    ];

    badStates.forEach((task, index) => {
      const runId = `bad-${index}`;
      writeTask(runId, task);
      expect(runExcludedFromInjection(runsDir, runId)).toBe(true);
    });
  });

  it("accepts only durable clean done runs", () => {
    writeTask("legacy-clean", { status: "done" });
    writeTask("verified-clean", { status: "done", finalState: "verified", evidenceIntegrity: "ok" });
    expect(runExcludedFromInjection(runsDir, "legacy-clean")).toBe(false);
    expect(runExcludedFromInjection(runsDir, "verified-clean")).toBe(false);
  });

  it("keeps explicit non-run memory eligible when no run id exists", () => {
    expect(isFromExcludedRun(root, undefined)).toBe(false);
  });
});
