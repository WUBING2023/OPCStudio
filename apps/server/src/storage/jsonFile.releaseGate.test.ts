import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle cleanup */ }
  }
});

describe("Wave 5 release gate: crash-safe JSON persistence", () => {
  it("recovers the previous complete value after a crash between backup and publish", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "wave5-json-crash-"));
    roots.push(root);
    const file = path.join(root, "state.json");
    writeJSON(file, { revision: 1, complete: true });

    fs.renameSync(file, `${file}.bak`);
    fs.writeFileSync(`${file}.tmp-crashed`, '{"revision":2', "utf-8");

    expect(readJSON(file, { revision: 0 })).toEqual({ revision: 1, complete: true });
    expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ revision: 1, complete: true });
    expect(fs.existsSync(`${file}.bak`)).toBe(false);
    expect(fs.existsSync(`${file}.tmp-crashed`)).toBe(true);
  });
});
