import { describe, it, expect, afterAll } from "vitest";
import type { AgentNodeConfig } from "@opc/shared";
import { createSkill, deleteSkill } from "../storage/skillStore.js";
import { buildSystemPrompt, type InjectionContext } from "./contextBuilder.js";

// v3 C4：证明"导入即转 scoped skill"后，worker 的人设真正进入运行时 system prompt。
// 这正是导入闭环的"可用"环节——无需真 LLM key，确定性验证注入链路。
const ROLE = "skill-test-c4-xz";          // 唯一 role，隔离到这个 worker
const SKILL_ID = `sk-${ROLE}`;
const PERSONA = "第一性原理思维：剥开习以为常的假设，回到最基本的事实重新推演。用思想实验照亮难题。";

afterAll(() => { deleteSkill(undefined, SKILL_ID); });

function worker(role: string): AgentNodeConfig {
  return {
    id: "w-c4", name: "导入的 worker", role, parentId: "ceo", childrenIds: [],
    model: "deepseek-v4-pro", provider: "deepseek", framework: "hermes", companyId: "default",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
  } as AgentNodeConfig;
}

describe("导入 worker 的人设迁移到员工字段后进入运行时", () => {
  it("buildSystemPrompt 使用员工 systemPrompt，人设 Skill 不再作为 Skill 重复注入", () => {
    deleteSkill(undefined, SKILL_ID);
    // 模拟导入即转 scoped skill：落一份绑定唯一 role 的 skill
    createSkill(undefined, { id: SKILL_ID, title: "爱因斯坦（思维导师）", role: ROLE, enabled: true, content: PERSONA, lastModified: "2026-06-20T00:00:00Z" });

    const out: InjectionContext = { projectRoot: ".", runId: "r1", injectedSkillIds: [], injectedMemoryIds: [] };
    const prompt = buildSystemPrompt(worker(ROLE), PERSONA, "分析一个物理问题", ".", out);

    // 人设真生效，但 canonical 来源是员工 systemPrompt；遗留 persona Skill 不得重复注入。
    expect(prompt).toContain("第一性原理");
    expect(prompt).toContain("思想实验");
    expect(out.injectedSkillIds).not.toContain(SKILL_ID);
  });

  it("遗留 persona Skill 不会泄漏给其它 role 的 worker（隔离）", () => {
    const out: InjectionContext = { projectRoot: ".", runId: "r2", injectedSkillIds: [], injectedMemoryIds: [] };
    const prompt = buildSystemPrompt(worker("dev"), "你是一个 dev。", "写代码", ".", out);
    // dev worker 不应拿到 skill-test-c4-xz 的人设
    expect(out.injectedSkillIds).not.toContain(SKILL_ID);
  });
});
