import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanyTemplate, Skill } from "@opc/shared";

const mocked = vi.hoisted(() => ({
  skills: new Map<string, Skill>(),
  failCreateId: "",
}));

vi.mock("../storage/skillStore.js", () => ({
  getSkill: (_root: string, id: string) => {
    const skill = mocked.skills.get(id);
    return skill ? structuredClone(skill) : null;
  },
  createSkill: (_root: string, skill: Skill) => {
    if (skill.id === mocked.failCreateId) throw new Error("simulated create failure");
    if (mocked.skills.has(skill.id)) throw new Error("already exists");
    mocked.skills.set(skill.id, structuredClone(skill));
    return skill;
  },
  updateSkill: (_root: string, id: string, patch: Partial<Skill>) => {
    const previous = mocked.skills.get(id);
    if (!previous) throw new Error("not found");
    const next = { ...previous, ...patch, id } as Skill;
    mocked.skills.set(id, structuredClone(next));
    return next;
  },
  deleteSkill: (_root: string, id: string) => mocked.skills.delete(id),
}));

import { bundledSkillId, installBundledSkills } from "./install.js";

function template(): CompanyTemplate {
  return {
    id: "atomic-template",
    title: "Atomic template",
    author: "test",
    description: "Atomic install fixture",
    createdAt: "2026-07-13T00:00:00.000Z",
    tags: [],
    downloads: 0,
    stars: 0,
    readme: "test",
    agents: [],
    bundledSkills: [
      { name: "first", content: "new first", roles: ["dev"] },
      { name: "second", content: "new second", roles: ["dev"] },
    ],
  };
}

describe("installBundledSkills atomicity", () => {
  beforeEach(() => {
    mocked.skills.clear();
    mocked.failCreateId = "";
  });

  it("restores overwritten skills and removes newly created skills when a later write fails", () => {
    const companyId = "company-a";
    const firstId = bundledSkillId("atomic-template", "first", "dev", companyId);
    const secondId = bundledSkillId("atomic-template", "second", "dev", companyId);
    mocked.skills.set(firstId, {
      id: firstId,
      title: "old first",
      role: "dev",
      enabled: true,
      content: "old content",
      lastModified: "2026-01-01T00:00:00.000Z",
      origin: "bundled",
      companyId,
    });
    mocked.failCreateId = secondId;

    expect(() => installBundledSkills("root", template(), ["dev"], companyId))
      .toThrow(/failed and was rolled back/);
    expect(mocked.skills.get(firstId)?.content).toBe("old content");
    expect(mocked.skills.has(secondId)).toBe(false);
  });
});
