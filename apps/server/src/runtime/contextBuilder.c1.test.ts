import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { buildSystemPrompt, type InjectionContext } from "./contextBuilder.js";
import { bundledSkillId } from "./install.js";
import { createSkill } from "../storage/skillStore.js";
import { migrateJsonToSqlite } from "../storage/sqlite/migrateJsonToSqlite.js";
import { closeAllDbs } from "../storage/sqlite/db.js";

// C1 · 泄漏堵点验收:contextBuilder 注入 bundled 技能时**按公司归属过滤**——A 公司装的 bundled skill
// 绝不再注入 B 公司同 role 的 agent。三级归属(新形状精确等 / legacy tx / legacy manifestTemplateId
// 前缀)都在这里对着真实 buildSystemPrompt 断言 injectedSkillIds / excludedBundledSkillIds。

let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-cb-c1-"));
  process.env.OPC_SKILLS_DIR = skillsTmp;
});
afterAll(() => {
  delete process.env.OPC_SKILLS_DIR;
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

let root: string;
function clearSkills(): void {
  for (const f of fs.readdirSync(skillsTmp)) { if (f.endsWith(".md")) fs.unlinkSync(path.join(skillsTmp, f)); }
}
function writeCompanies(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), JSON.stringify(rows), "utf-8");
  migrateJsonToSqlite(root);
}
function agent(companyId: string, role = "dev"): AgentNodeConfig {
  return {
    id: `a-${companyId}`, name: "A", role, childrenIds: [], model: "m", provider: "deepseek",
    framework: "api", companyId, status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
  };
}
function ctx(): InjectionContext {
  return { projectRoot: root, runId: "r", injectedSkillIds: [], injectedMemoryIds: [] };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-c1-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  clearSkills();
});
afterEach(() => { closeAllDbs(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("C1 · contextBuilder bundled 技能按公司隔离注入", () => {
  it("新形状:A 公司 agent 只注入 A 的 bundled skill;B 公司同 role agent 注入自己的,拿不到 A 的", () => {
    const idA = bundledSkillId("tpl", "guide", "dev", "co-a");
    const idB = bundledSkillId("tpl", "guide", "dev", "co-b");
    createSkill(root, { id: idA, title: "A指南", role: "dev", enabled: true, content: "A内容", origin: "bundled", companyId: "co-a", lastModified: new Date().toISOString() });
    createSkill(root, { id: idB, title: "B指南", role: "dev", enabled: true, content: "B内容", origin: "bundled", companyId: "co-b", lastModified: new Date().toISOString() });
    writeCompanies([{ id: "co-a", name: "A", createdAt: "x" }, { id: "co-b", name: "B", createdAt: "x" }]);

    const outA = ctx();
    buildSystemPrompt(agent("co-a"), "你是开发", "干活", root, outA);
    expect(outA.injectedSkillIds).toContain(idA);
    expect(outA.injectedSkillIds).not.toContain(idB); // 泄漏堵点:拿不到别家的

    const outB = ctx();
    buildSystemPrompt(agent("co-b"), "你是开发", "干活", root, outB);
    expect(outB.injectedSkillIds).toContain(idB);
    expect(outB.injectedSkillIds).not.toContain(idA);
  });

  it("legacy(无 companyId)靠 manifestTemplateId 前缀兜底:本公司注入;前缀不匹配的公司排除并记 excludedBundledSkillIds", () => {
    const legacyId = "bundled-acme-tpl-guide--dev"; // 无 companyId 的存量打包技能
    createSkill(root, { id: legacyId, title: "老指南", role: "dev", enabled: true, content: "老内容", origin: "bundled", lastModified: new Date().toISOString() });
    writeCompanies([
      { id: "co-c", name: "C", createdAt: "x", manifestTemplateId: "acme-tpl" },   // 前缀匹配 → 归属
      { id: "co-d", name: "D", createdAt: "x", manifestTemplateId: "other-tpl" },  // 前缀不匹配 → residual
    ]);

    const outC = ctx();
    buildSystemPrompt(agent("co-c"), "你是开发", "干活", root, outC);
    expect(outC.injectedSkillIds).toContain(legacyId);
    expect(outC.excludedBundledSkillIds ?? []).not.toContain(legacyId);

    const outD = ctx();
    buildSystemPrompt(agent("co-d"), "你是开发", "干活", root, outD);
    expect(outD.injectedSkillIds).not.toContain(legacyId);
    expect(outD.excludedBundledSkillIds ?? []).toContain(legacyId); // residual 不静默
  });
});
