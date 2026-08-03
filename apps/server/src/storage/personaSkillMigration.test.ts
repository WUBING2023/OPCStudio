import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { createSkill, getSkill, migrateLegacyPersonaSkills } from "./skillStore.js";

function agent(overrides: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "agent-1",
    name: "Worker",
    role: "worker-role",
    companyId: "company-1",
    childrenIds: [],
    model: "model",
    provider: "provider",
    framework: "api",
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0,
    editable: true,
    deletable: true,
    enabled: true,
    ...overrides,
  };
}

let skillsDir: string;
beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "persona-skill-migration-"));
  vi.stubEnv("OPC_SKILLS_DIR", skillsDir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(skillsDir, { recursive: true, force: true });
});

describe("legacy persona Skill migration", () => {
  it("moves a company-scoped persona to AgentNodeConfig.systemPrompt and removes the Skill", () => {
    createSkill(undefined, {
      id: "sk-worker-role",
      title: "Legacy worker persona",
      role: "worker-role",
      companyId: "company-1",
      origin: "persona",
      enabled: true,
      lastModified: new Date().toISOString(),
      content: "You are a careful implementation worker.",
    });
    const agents = [agent(), agent({ id: "other", companyId: "company-2" })];
    const persisted: Array<{ id: string; prompt: string }> = [];

    const result = migrateLegacyPersonaSkills(undefined, agents, (id, prompt) => {
      persisted.push({ id, prompt });
    });

    expect(persisted).toEqual([{ id: "agent-1", prompt: "You are a careful implementation worker." }]);
    expect(agents[0].systemPrompt).toBe("You are a careful implementation worker.");
    expect(agents[1].systemPrompt).toBeUndefined();
    expect(result.migratedAgentIds).toEqual(["agent-1"]);
    expect(result.removedSkillIds).toEqual(["sk-worker-role"]);
    expect(getSkill(undefined, "sk-worker-role")).toBeNull();
  });

  it("removes an orphaned persona Skill instead of exposing it as a reusable capability", () => {
    createSkill(undefined, {
      id: "sk-orphan",
      title: "Orphan persona",
      role: "missing-role",
      companyId: "missing-company",
      origin: "persona",
      enabled: true,
      lastModified: new Date().toISOString(),
      content: "Legacy persona text",
    });

    const result = migrateLegacyPersonaSkills(undefined, [agent()], () => undefined);

    expect(result.orphanedSkillIds).toEqual(["sk-orphan"]);
    expect(result.removedSkillIds).toEqual(["sk-orphan"]);
    expect(getSkill(undefined, "sk-orphan")).toBeNull();
  });

  it("keeps the legacy Skill when persisting the agent prompt fails", () => {
    createSkill(undefined, {
      id: "sk-worker-role",
      title: "Legacy worker persona",
      role: "worker-role",
      companyId: "company-1",
      origin: "persona",
      enabled: true,
      lastModified: new Date().toISOString(),
      content: "Prompt that must not be lost",
    });

    const result = migrateLegacyPersonaSkills(undefined, [agent()], () => {
      throw new Error("disk write failed");
    });

    expect(result.failedSkillIds).toEqual(["sk-worker-role"]);
    expect(result.removedSkillIds).toEqual([]);
    expect(getSkill(undefined, "sk-worker-role")).not.toBeNull();
  });
});