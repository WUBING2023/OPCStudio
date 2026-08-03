import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SHARED_SKILLS } from "./catalog.js";
import { exportSharedSkills } from "./exporter.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("shared Agent Skills export", () => {
  it("exports the three standard, progressively disclosed skills", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-skills-test-"));
    roots.push(temp);
    const output = path.join(temp, "opc-studio-skills");
    const result = exportSharedSkills(output, { now: () => "2026-08-02T00:00:00.000Z" });
    expect(SHARED_SKILLS.map((skill) => skill.name)).toEqual([
      "opc-team-run", "opc-run-review", "opc-company-design",
    ]);
    expect(result.skills).toHaveLength(3);
    for (const skill of SHARED_SKILLS) {
      const directory = path.join(output, skill.name);
      const markdown = fs.readFileSync(path.join(directory, "SKILL.md"), "utf-8");
      expect(markdown).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`));
      expect(markdown.split("\n").length).toBeLessThan(500);
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "manifest.json"), "utf-8"));
      expect(manifest).toMatchObject({
        schemaVersion: "1", name: skill.name, skillFile: "SKILL.md",
        dataPolicy: { includes: ["instructions"], excludes: ["memory", "credentials", "runtime-state"] },
      });
    }
  });

  it("contains no memory, credential or runtime-state payload files", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-skills-test-"));
    roots.push(temp);
    const output = path.join(temp, "export");
    exportSharedSkills(output);
    const relativeFiles = fs.readdirSync(output, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(entry.parentPath, entry.name).slice(output.length + 1).replace(/\\/g, "/"));
    expect(relativeFiles.sort()).toEqual([
      "manifest.json",
      "opc-company-design/SKILL.md", "opc-company-design/manifest.json",
      "opc-run-review/SKILL.md", "opc-run-review/manifest.json",
      "opc-team-run/SKILL.md", "opc-team-run/manifest.json",
    ]);
    for (const file of relativeFiles) {
      expect(file).not.toMatch(/(^|\/)(memory|keys?|credentials?|\.env)(\/|$)/i);
    }
  });

  it("refuses an existing destination instead of merging unknown files", () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "opc-skills-test-"));
    roots.push(temp);
    const output = path.join(temp, "existing");
    fs.mkdirSync(output);
    expect(() => exportSharedSkills(output)).toThrow(/already exists/i);
  });
});
