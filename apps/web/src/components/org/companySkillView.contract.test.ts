import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = fs.readFileSync(path.join(__dirname, "CompanyStructureForms.tsx"), "utf-8");

describe("company structure Skill view contract", () => {
  it("loads the hidden bundled layer used by runtime injection and export", () => {
    expect(SOURCE).toContain('api.get<SkillMeta[]>("/skills?origin=bundled")');
    expect(SOURCE).toContain("setAllSkills([...userSkills, ...bundledSkills])");
  });
});