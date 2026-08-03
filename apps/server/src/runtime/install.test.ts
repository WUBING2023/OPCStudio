import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, AgentCard, CompanyTemplate } from "@opc/shared";
import { rerootAgents, rootIdsOf, agentFromCard, isValidAttachParent, workerFromSkill, applySafeInstall, bundledSkillId, isBundledSkillOwnedByCompany } from "./install.js";
import { dangerFlags } from "./templateTrust.js";

function node(id: string, role: string, parentId?: string, childrenIds: string[] = []): AgentNodeConfig {
  return {
    id, name: id, role, parentId, childrenIds, model: "m", provider: "p", framework: "hermes",
    status: "idle", tokenUsage: { prompt: 5, completion: 5, total: 10 }, costUsd: 1.5,
    currentTask: "old", lastAction: "did", editable: true, deletable: true, enabled: true,
  };
}

// company template: ceo → lead → (w1, w2)
const COMPANY: AgentNodeConfig[] = [
  node("ceo", "ceo", undefined, ["lead"]),
  node("lead", "lead", "ceo", ["w1", "w2"]),
  node("w1", "dev", "lead"),
  node("w2", "test", "lead"),
];

describe("rerootAgents — company install (roots stay top-level)", () => {
  it("remaps every id and keeps parent/children internally consistent", () => {
    const { agents, idMap } = rerootAgents(COMPANY, "co-abc", (old) => `${old}-abc`);
    expect(agents.map(a => a.id)).toEqual(["ceo-abc", "lead-abc", "w1-abc", "w2-abc"]);
    expect(agents.every(a => a.companyId === "co-abc")).toBe(true);

    const ceo = agents.find(a => a.role === "ceo")!;
    expect(ceo.parentId).toBeUndefined();           // root stays top-level (no newParentForRoots)
    expect(ceo.childrenIds).toEqual(["lead-abc"]);  // child remapped

    const lead = agents.find(a => a.role === "lead")!;
    expect(lead.parentId).toBe("ceo-abc");
    expect(lead.childrenIds).toEqual(["w1-abc", "w2-abc"]);
    expect(idMap).toMatchObject({ ceo: "ceo-abc", w2: "w2-abc" });
  });

  it("resets usage/cost/status/task so imports start fresh", () => {
    const { agents } = rerootAgents(COMPANY, "co-abc", (old) => `${old}-abc`);
    for (const a of agents) {
      expect(a.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
      expect(a.costUsd).toBe(0);
      expect(a.status).toBe("idle");
      expect(a.currentTask).toBeUndefined();
      expect(a.lastAction).toBeUndefined();
    }
  });
});

describe("rerootAgents — team install (attach roots under a chosen parent)", () => {
  // a team subtree: lead → (w1, w2); imported under an existing lead "host"
  const TEAM: AgentNodeConfig[] = [
    node("tlead", "lead", undefined, ["tw1", "tw2"]),
    node("tw1", "dev", "tlead"),
    node("tw2", "test", "tlead"),
  ];

  it("wires the team's root lead as a child of the selected parent", () => {
    const { agents } = rerootAgents(TEAM, "co-host", (old, i) => `${old}-x${i}`, { newParentForRoots: "host" });
    const lead = agents.find(a => a.role === "lead")!;
    expect(lead.parentId).toBe("host");            // attached under chosen CEO/Lead
    expect(lead.childrenIds.length).toBe(2);        // its own workers preserved
    expect(agents.every(a => a.companyId === "co-host")).toBe(true);
  });

  it("rootIdsOf finds the subtree roots", () => {
    expect(rootIdsOf(TEAM)).toEqual(["tlead"]);
    expect(rootIdsOf(COMPANY)).toEqual(["ceo"]);
  });
});

describe("worker install (agentFromCard) + attach validation", () => {
  const card: AgentCard = {
    id: "einstein", title: "爱因斯坦", description: "物理学家", role: "advisor",
    author: "me", createdAt: "2026-01-01T00:00:00Z", tags: ["science"], downloads: 0, stars: 0,
    agent: {
      suggestedId: "einstein", name: "Albert Einstein", recommendedProvider: "deepseek",
      recommendedModel: "deepseek-v4-pro", systemPrompt: "think deeply", tools: [],
      expectedRole: "advisor", recommendedParents: ["lead"],
    },
  };

  it("maps a card to a fresh node under the chosen parent", () => {
    const node = agentFromCard(card, "host", "co-x", "einstein-abc");
    expect(node).toMatchObject({
      id: "einstein-abc", name: "Albert Einstein", role: "advisor",
      parentId: "host", companyId: "co-x", provider: "deepseek", model: "deepseek-v4-pro",
      childrenIds: [], status: "idle",
    });
    expect(node.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });

  it("only CEO/Lead are valid attach parents (never a worker)", () => {
    expect(isValidAttachParent("ceo")).toBe(true);
    expect(isValidAttachParent("lead")).toBe(true);
    expect(isValidAttachParent("dev")).toBe(false);
    expect(isValidAttachParent(undefined)).toBe(false);
  });
});

describe("D1 · applySafeInstall — Safe Install Mode 默认剥离高危授权", () => {
  function riskyTpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
    return {
      id: "risky", title: "高危模板", description: "d", author: "a", createdAt: "2026-07-01T00:00:00Z",
      tags: [], downloads: 0, stars: 0, readme: "r",
      agents: [node("ceo", "ceo")],
      recommendedConfig: { permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false } },
      toolRequirements: { requiredEngines: [], requiredProviders: [], requiredMcpServers: ["github"], requiredSkills: [], optionalTools: [] },
      a2aChannels: [{ from: "ceo", to: "dev", purpose: "sync" }],
      trustLevel: "community",
      ...over,
    };
  }

  it("社区来源:剥离 shell / MCP 授权 / 预置 A2A,并逐项列明;file-write 保留可见", () => {
    const src = riskyTpl();
    const { template: out, applied, stripped } = applySafeInstall(src);
    expect(applied).toBe(true);
    expect(stripped.map(s => s.id).sort()).toEqual(["mcp-dependency", "preset-a2a-channels", "shell-access"]);
    // 剥离后 dangerFlags 不再报 shell/MCP;file-write 如实保留(不属于剥离范围)
    const flags = dangerFlags(out);
    expect(flags).not.toContain("shell-access");
    expect(flags).not.toContain("mcp-dependency");
    expect(flags).toContain("file-write");
    expect(out.a2aChannels).toBeUndefined();
    expect(out.recommendedConfig?.permissions?.allowShell).toBe(false);
    expect(out.toolRequirements?.requiredMcpServers).toEqual([]);
    // 不改动传入的原模板(剥离只作用于本次安装的副本)
    expect(src.recommendedConfig?.permissions?.allowShell).toBe(true);
    expect(src.a2aChannels).toHaveLength(1);
    expect(src.toolRequirements?.requiredMcpServers).toEqual(["github"]);
  });

  it("trustLevel 缺失(本地/工坊模板)同样按非 official 剥离", () => {
    const { applied, stripped } = applySafeInstall(riskyTpl({ trustLevel: undefined }));
    expect(applied).toBe(true);
    expect(stripped.map(s => s.id)).toContain("shell-access");
  });

  it("official 模板不剥离;unsafeAcknowledged:true 显式保留全部授权", () => {
    const official = applySafeInstall(riskyTpl({ trustLevel: "official" }));
    expect(official.applied).toBe(false);
    expect(official.stripped).toEqual([]);
    expect(official.template.a2aChannels).toHaveLength(1);

    const acked = applySafeInstall(riskyTpl(), { unsafeAcknowledged: true });
    expect(acked.applied).toBe(false);
    expect(acked.template.recommendedConfig?.permissions?.allowShell).toBe(true);
  });

  it("无高危授权的干净模板:applied=false,stripped 为空", () => {
    const clean = riskyTpl({ recommendedConfig: undefined, toolRequirements: undefined, a2aChannels: undefined });
    const r = applySafeInstall(clean);
    expect(r.applied).toBe(false);
    expect(r.stripped).toEqual([]);
    expect(r.template).toMatchObject({ id: "risky" });
  });
});

describe("workerFromSkill — skill → worker (unique role isolates the ability)", () => {
  it("builds a worker carrying the skill under a dedicated role", () => {
    const skill = { id: "kongzi", title: "孔子", role: "advisor", enabled: true, lastModified: "2026-01-01T00:00:00Z", content: "因材施教" };
    const node = workerFromSkill(skill, "host", "co-x", "skill-kongzi-ab12", "skill-kongzi");
    expect(node).toMatchObject({
      id: "skill-kongzi-ab12", name: "孔子", role: "skill-kongzi",
      parentId: "host", companyId: "co-x", childrenIds: [], status: "idle",
    });
    expect(node.systemPrompt).toBe(skill.content);
    expect(node.tokenUsage).toEqual({ prompt: 0, completion: 0, total: 0 });
  });
});

describe("C1 · bundledSkillId — id 双轨(companyId 有值出新形状,无值兼容旧形状)", () => {
  it("无 companyId → 旧形状(与历史落盘串字节一致,兜底/存量路径)", () => {
    expect(bundledSkillId("acme-tpl", "onboarding", "dev")).toBe("bundled-acme-tpl-onboarding--dev");
  });

  it("有 companyId → 新形状:同模板同技能同角色,不同公司得到不同 id(互不覆盖)", () => {
    const a = bundledSkillId("acme-tpl", "onboarding", "dev", "co-a1b2c3");
    const b = bundledSkillId("acme-tpl", "onboarding", "dev", "co-x9y8z7");
    expect(a).toBe("bundled-acme-tpl-onboarding--dev--c-co-a1b2c3");
    expect(a).not.toBe(b);
  });

  it("病态超长各段也保证 id ≤80(cid 硬上限)且仍带公司后缀", () => {
    const id = bundledSkillId("t".repeat(60), "n".repeat(60), "r".repeat(60), "company-very-long-id");
    expect(id.length).toBeLessThanOrEqual(80);
    expect(id).toContain("--c-");
  });
});

describe("C1 · isBundledSkillOwnedByCompany — bundled 技能公司归属三级判定", () => {
  const tx = (companyId: string, skillIds: string[], rolledBack = false) => ({ companyId, created: { skillIds }, rolledBack });

  it("(a) 新形状:meta.companyId 精确等才归属,别的公司一律排除", () => {
    const meta = { id: "bundled-t-s--dev--c-co-a", companyId: "co-a" };
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [], undefined)).toBe(true);
    expect(isBundledSkillOwnedByCompany(meta, "co-b", [], undefined)).toBe(false); // 堵泄漏
  });

  it("(b) legacy:未回滚 tx 命中(companyId + created.skillIds 含该 id)→ 归属;已回滚 tx 不算", () => {
    const meta = { id: "bundled-t-s--dev", companyId: undefined };
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [tx("co-a", [meta.id])], undefined)).toBe(true);
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [tx("co-b", [meta.id])], undefined)).toBe(false);
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [tx("co-a", [meta.id], true)], undefined)).toBe(false);
  });

  it("(c) legacy 兜底:manifestTemplateId slug 前缀匹配 → 归属(覆盖 tx 已滚出上限的老公司)", () => {
    const meta = { id: "bundled-acme-tpl-onboarding--dev", companyId: undefined };
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [], { manifestTemplateId: "acme-tpl" })).toBe(true);
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [], { manifestTemplateId: "other-tpl" })).toBe(false);
  });

  it("三级都不中(residual)→ 不归属", () => {
    const meta = { id: "bundled-gone-tpl-s--dev", companyId: undefined };
    expect(isBundledSkillOwnedByCompany(meta, "co-a", [], { manifestTemplateId: "acme-tpl" })).toBe(false);
    expect(isBundledSkillOwnedByCompany(meta, undefined, [], undefined)).toBe(false);
  });
});
