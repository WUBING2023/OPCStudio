import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGoalRunFileChanges } from "./goalRunner.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-runner-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeChanges(runId: string, changes: unknown[]): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "changes.json"), JSON.stringify(changes), "utf-8");
}

describe("loadGoalRunFileChanges", () => {
  it("reads the specified run changes instead of the newest run", () => {
    writeChanges("target-run-00000001", [
      { path: "target.ts", changeType: "create" },
      { path: "partial.md", changeType: "create" },
    ]);
    writeChanges("newer-run-00000002", [
      { path: "newer.ts", changeType: "create" },
    ]);

    expect(loadGoalRunFileChanges(root, "target-run-00000001")).toEqual(["create: target.ts"]);
  });

  it("returns an empty list for missing or unsafe run ids", () => {
    expect(loadGoalRunFileChanges(root, "missing-run-00000001")).toEqual([]);
    expect(loadGoalRunFileChanges(root, "../escape")).toEqual([]);
  });
});
