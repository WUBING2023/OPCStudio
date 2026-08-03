import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, Company, SkillMeta } from "@opc/shared";
import { companyToDraft, cardsToWorkshopCards, workshopCardToDraftCard, diffCardPatch, classifyCompanySkills } from "./companyDraft.js";
import { newCard } from "../components/community/workshopTypes.js";

function agent(over: Partial<AgentNodeConfig> & { id: string; role: string }): AgentNodeConfig {
  return {
    // framework 默认给存量原始值 "hermes"——本文件多处即以此充当读侧兼容回归(E1 写侧去品牌后,
    // 本地草稿/旧 agents 仍可能携带 "hermes",读路径必须原样保留、判等双接受)。
    name: over.id, parentId: undefined, childrenIds: [], model: "m", provider: "p", framework: "hermes",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

const company: Company = { id: "co1", name: "Co", description: "", createdAt: new Date().toISOString() };

describe("companyDraft · framework passthrough (TeamTab 真实 agent 同步路径)", () => {
  it("companyToDraft -> cardsToWorkshopCards 保留 agent.framework(含存量 'hermes',不静默改写)", () => {
    const agents: AgentNodeConfig[] = [
      agent({ id: "ceo", role: "ceo", framework: "hermes", companyId: "co1" }),
      agent({ id: "dev", role: "dev", framework: "claude-code", parentId: "ceo", companyId: "co1" }),
      agent({ id: "ops", role: "ops", framework: "api", parentId: "ceo", companyId: "co1" }),
    ];
    const wcards = cardsToWorkshopCards(companyToDraft(company, agents).cards);
    expect(wcards.find(c => c.key === "dev")?.framework).toBe("claude-code");
    expect(wcards.find(c => c.key === "ceo")?.framework).toBe("hermes");
    expect(wcards.find(c => c.key === "ops")?.framework).toBe("api");
  });

  it("workshopCardToDraftCard 原样带回 framework", () => {
    const wc = newCard({ key: "dev", role: "dev", name: "Dev", framework: "codex", provider: "openai", model: "gpt-5.5" });
    const draftCard = workshopCardToDraftCard(wc);
    expect(draftCard.framework).toBe("codex");
  });
});

describe("companyDraft · diffCardPatch(TeamTab 字段级 diff)", () => {
  it("framework 变化时正确产出 patch.framework", () => {
    const old = newCard({ key: "dev", role: "dev", name: "Dev", framework: "api", provider: "deepseek", model: "deepseek-v4-flash" });
    const next = { ...old, framework: "claude-code" as const, provider: "anthropic", model: "sonnet" };
    const patch = diffCardPatch(old, next);
    expect(patch.framework).toBe("claude-code");
    expect(patch.provider).toBe("anthropic");
    expect(patch.model).toBe("sonnet");
  });

  it("未选过框架(undefined)、存量 'hermes' 与 'api' 视为同一状态,不产生多余 PATCH(旧卡不被静默改写)", () => {
    const old = newCard({ key: "dev", role: "dev", name: "Dev", provider: "deepseek", model: "deepseek-v4-flash" }); // framework undefined
    expect(diffCardPatch(old, { ...old, framework: "hermes" as const }).framework).toBeUndefined();
    expect(diffCardPatch(old, { ...old, framework: "api" as const }).framework).toBeUndefined();
    const oldHermes = { ...old, framework: "hermes" as const };
    expect(diffCardPatch(oldHermes, { ...oldHermes, framework: "api" as const }).framework).toBeUndefined();
  });

  it("写侧归一:真有变化时 PATCH 一律落 'api',即使草稿新值仍是存量 'hermes'", () => {
    const old = newCard({ key: "dev", role: "dev", name: "Dev", framework: "claude-code", provider: "anthropic", model: "sonnet" });
    expect(diffCardPatch(old, { ...old, framework: "hermes" as const }).framework).toBe("api");
    expect(diffCardPatch(old, { ...old, framework: "api" as const }).framework).toBe("api");
    expect(diffCardPatch(old, { ...old, framework: undefined }).framework).toBe("api");
  });

  it("没有任何变化时返回空 patch", () => {
    const c = newCard({ key: "dev", role: "dev", name: "Dev", framework: "codex", provider: "openai", model: "gpt-5.5" });
    const patch = diffCardPatch(c, { ...c });
    expect(patch).toEqual({});
  });

  it("半填的 name/role 不同步(不清空真实 agent)", () => {
    const old = newCard({ key: "dev", role: "dev", name: "Dev" });
    const next = { ...old, name: "   ", role: "" };
    const patch = diffCardPatch(old, next);
    expect(patch.name).toBeUndefined();
    expect(patch.role).toBeUndefined();
  });
});

// P0-B · 公司结构页 skills 三态区分:镜像服务端 collectBundledSkills 的导出口径,把"会导出 / 关联但
// 不导出 / 安装后注入"精确切开(不再是宽松反查笼统一堆)。
function skill(over: Partial<SkillMeta> & { id: string; role: string }): SkillMeta {
  return { title: over.id, enabled: true, lastModified: "2026-07-01T00:00:00Z", ...over };
}

describe("companyDraft · classifyCompanySkills(公司结构页 skills 三态区分)", () => {
  const co: Company = { id: "co1", name: "Co", description: "", createdAt: "2026-07-01T00:00:00Z", manifestTemplateId: "tpl-x" };
  const agents: AgentNodeConfig[] = [
    agent({ id: "ceo", role: "ceo", companyId: "co1" }),
    agent({ id: "dev", role: "dev", companyId: "co1" }),
    agent({ id: "qa", role: "qa", companyId: "co1" }),
  ];

  it("bundled 新形状:companyId 精确命中本公司 → 会导出;同标题按角色去重合并(dev+qa)+ 安装注入逐角色展开", () => {
    const skills = [
      skill({ id: "b1", title: "release-checklist", role: "dev", origin: "bundled", companyId: "co1" }),
      skill({ id: "b2", title: "release-checklist", role: "qa", origin: "bundled", companyId: "co1" }),
    ];
    const c = classifyCompanySkills(co, agents, skills);
    expect(c.exported).toEqual([{ title: "release-checklist", roles: ["dev", "qa"] }]);
    expect(c.notExported).toEqual([]);
    // 安装后按 (标题 × 角色) 逐条注入。
    expect(c.injected).toEqual([{ title: "release-checklist", role: "dev" }, { title: "release-checklist", role: "qa" }]);
  });

  it("bundled 新形状:companyId 属于别的公司 → 不会导出(reason=other-company),即便角色同名", () => {
    const skills = [skill({ id: "b1", title: "leaked", role: "dev", origin: "bundled", companyId: "co-other" })];
    const c = classifyCompanySkills(co, agents, skills);
    expect(c.exported).toEqual([]);
    expect(c.notExported).toEqual([{ skillId: "b1", title: "leaked", role: "dev", reason: "other-company" }]);
    expect(c.injected).toEqual([]);
  });

  it("bundled legacy(无 companyId):本公司模板前缀 + 角色后缀双命中才会导出;错前缀 → not-exported", () => {
    const skills = [
      skill({ id: "bundled-tpl-x-release-checklist--dev", title: "release-checklist", role: "dev", origin: "bundled" }),
      skill({ id: "bundled-other-tpl-release-checklist--dev", title: "leaked", role: "dev", origin: "bundled" }),
    ];
    const c = classifyCompanySkills(co, agents, skills);
    expect(c.exported).toEqual([{ title: "release-checklist", roles: ["dev"] }]);
    expect(c.notExported).toEqual([{ skillId: "bundled-other-tpl-release-checklist--dev", title: "leaked", role: "dev", reason: "no-template-match" }]);
  });

  it("persona:sk-{role} 命中 → 会导出;命名对不上 → not-exported(no-template-match)", () => {
    const skills = [
      skill({ id: "sk-dev", title: "Dev 人设", role: "dev", origin: "persona" }),
      skill({ id: "sk-weird-suffix", title: "游离人设", role: "qa", origin: "persona" }),
    ];
    const c = classifyCompanySkills(co, agents, skills);
    expect(c.exported).toEqual([{ title: "Dev 人设", roles: ["dev"] }]);
    expect(c.notExported).toEqual([{ skillId: "sk-weird-suffix", title: "游离人设", role: "qa", reason: "no-template-match" }]);
  });

  it("角色不在本公司 / origin=user|memory:一律排除出三态视图(不属于'打包类且挂在本公司角色上'的 universe)", () => {
    const skills = [
      skill({ id: "b-mkt", title: "营销", role: "marketer", origin: "bundled", companyId: "co1" }), // 角色不在公司
      skill({ id: "u1", title: "用户自建", role: "dev", origin: "user" }),                          // 用户资产(本机)
      skill({ id: "m1", title: "记忆物化", role: "dev", origin: "memory" }),                        // 记忆系统产物
    ];
    const c = classifyCompanySkills(co, agents, skills);
    expect(c.exported).toEqual([]);
    expect(c.notExported).toEqual([]);
    expect(c.injected).toEqual([]);
  });
});
