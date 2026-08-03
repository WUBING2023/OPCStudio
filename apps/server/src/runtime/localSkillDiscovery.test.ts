import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverLocalSkills, isLocalSkillInstalled, localSkillSlug } from "./localSkillDiscovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local Skill discovery", () => {
  it("discovers bounded SKILL.md files and ignores system/symlink content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-local-skills-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "review"), { recursive: true });
    fs.writeFileSync(path.join(root, "review", "SKILL.md"), "---\nname: Review Flow\ndescription: Review safely\nrole: test\n---\nRun focused checks.", "utf8");
    fs.mkdirSync(path.join(root, ".system", "hidden"), { recursive: true });
    fs.writeFileSync(path.join(root, ".system", "hidden", "SKILL.md"), "hidden", "utf8");

    const found = discoverLocalSkills(root, [{ source: "codex", scope: "user", root }]);

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: "Review Flow",
      description: "Review safely",
      role: "test",
      source: "codex",
      relativePath: "review/SKILL.md",
      content: "Run focused checks.",
    });
  });

  it("detects content-equivalent installed Skills", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-local-skills-"));
    roots.push(root);
    fs.mkdirSync(path.join(root, "debug"), { recursive: true });
    fs.writeFileSync(path.join(root, "debug", "SKILL.md"), "---\nname: Debug\n---\nInspect logs first.", "utf8");
    const candidate = discoverLocalSkills(root, [{ source: "claude-code", scope: "project", root }])[0];

    expect(isLocalSkillInstalled(candidate, [{
      id: "installed",
      title: "Different title",
      role: "dev",
      enabled: true,
      content: "Inspect logs first.",
      lastModified: "2026-01-01T00:00:00.000Z",
    }])).toBe(true);
    expect(localSkillSlug(candidate)).toBe("debug");
  });
});
