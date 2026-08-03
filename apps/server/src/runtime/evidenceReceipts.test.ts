import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildEvidenceManifest,
  commitEvidenceReceipts,
  loadEvidenceReceiptLedger,
  verifyEvidenceManifest,
  writeEvidenceManifest,
} from "./evidenceManifest.js";

const required = [
  "task.json", "report.md", "report.html", "events.jsonl", "trace.json", "cost.json",
  "changes.json", "deferred.json", "structured-report.json", "result.json", "artifacts.json",
];

describe("committed evidence receipts", () => {
  let runDir: string;

  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), "opc-evidence-receipts-"));
    for (const file of required) {
      const body = file === "changes.json" || file === "deferred.json" || file === "trace.json"
        ? "[]"
        : file === "artifacts.json"
          ? JSON.stringify({ artifacts: [] })
          : file.endsWith(".json")
            ? "{}"
            : "committed evidence\n";
      fs.writeFileSync(path.join(runDir, file), body);
    }
  });

  afterEach(() => fs.rmSync(runDir, { recursive: true, force: true }));

  it("projects manifest exclusively from the committed receipt ledger", () => {
    const ledger = commitEvidenceReceipts(runDir, [{ command: "node test.js", exitCode: 0, passed: true } as any]);
    expect(ledger.files.map((file) => file.path)).toEqual(expect.arrayContaining(required));
    expect(loadEvidenceReceiptLedger(runDir)?.runId).toBe(path.basename(runDir));

    const manifest = buildEvidenceManifest(runDir);
    expect(manifest.receiptLedgerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.files.some((file) => file.kind === "receipt_ledger")).toBe(true);
    writeEvidenceManifest(runDir, manifest);
    expect(verifyEvidenceManifest(runDir)).toMatchObject({ ok: true });
  });

  it("fails closed when a required evidence file was never committed", () => {
    fs.rmSync(path.join(runDir, "result.json"));
    expect(() => commitEvidenceReceipts(runDir)).toThrow(/required evidence was not committed: result\.json/);
  });

  it("detects receipt-ledger tampering independently of file hashes", () => {
    commitEvidenceReceipts(runDir);
    writeEvidenceManifest(runDir, buildEvidenceManifest(runDir));
    fs.appendFileSync(path.join(runDir, "evidence-receipts.json"), " ");
    const verified = verifyEvidenceManifest(runDir);
    expect(verified.ok).toBe(false);
    expect(verified.mismatches.some((item) => item.path === "evidence-receipts.json")).toBe(true);
  });
});
