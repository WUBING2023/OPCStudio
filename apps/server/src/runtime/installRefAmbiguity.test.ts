import { describe, it, expect } from "vitest";
import { resolveTemplateAgentRef, detectAmbiguousTemplateRefs, computeInstallDangerSurface } from "./install.js";
import type { AgentNodeConfig, CompanyTemplate } from "@opc/shared";

// 令四.3 · canonical=agent ID;role alias 只有唯一命中才解析,多义整体 422。
// 令四.1 · computeInstallDangerSurface 六元绑定快照。

const agent = (over: Partial<AgentNodeConfig>): AgentNodeConfig => ({
  id: "x", name: "X", role: "dev", parentId: undefined, childrenIds: [],
  model: "m", provider: "deepseek", framework: "api", companyId: "c",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
  ...over,
} as AgentNodeConfig);

describe("令四.3 · resolveTemplateAgentRef 唯一才解析", () => {
  const agents = [
    agent({ id: "ceo-0", role: "ceo" }),
    agent({ id: "dev-1", role: "dev" }),
    agent({ id: "dev-2", role: "dev" }),
  ];
  const idMap: Record<string, string> = { "ceo-0": "real-ceo", "dev-1": "real-dev-1", "dev-2": "real-dev-2" };

  it("canonical id 引用 → 精确解析", () => {
    expect(resolveTemplateAgentRef(agents, idMap, "dev-2")).toBe("real-dev-2");
  });

  it("role 名唯一命中 → 解析", () => {
    expect(resolveTemplateAgentRef(agents, idMap, "ceo")).toBe("real-ceo");
  });

  it("role 名命中多个同 role → undefined(不再取第一个)", () => {
    expect(resolveTemplateAgentRef(agents, idMap, "dev")).toBeUndefined();
  });

  it("role 名命中 0 个(悬空)→ undefined", () => {
    expect(resolveTemplateAgentRef(agents, idMap, "nobody")).toBeUndefined();
  });
});

describe("令四.3 · detectAmbiguousTemplateRefs", () => {
  const base: Pick<CompanyTemplate, "agents" | "a2aChannels"> = {
    agents: [
      agent({ id: "ceo-0", role: "ceo" }),
      agent({ id: "dev-1", role: "dev" }),
      agent({ id: "dev-2", role: "dev" }),
    ],
    a2aChannels: undefined,
  };

  it("a2a 用 role 名指向多员工 role → 报歧义", () => {
    const t = { ...base, a2aChannels: [{ from: "ceo", to: "dev", purpose: "分派" }] };
    const amb = detectAmbiguousTemplateRefs(t);
    expect(amb.length).toBe(1);
    expect(amb[0].ref).toBe("dev");
    expect(amb[0].field).toBe("a2aChannels[0].to");
    expect(amb[0].matchedAgentIds.sort()).toEqual(["dev-1", "dev-2"]);
  });

  it("a2a 用 canonical id(dup role 的合成 id)→ 无歧义", () => {
    const t = { ...base, a2aChannels: [{ from: "ceo", to: "dev-2", purpose: "分派" }] };
    expect(detectAmbiguousTemplateRefs(t).length).toBe(0);
  });

  it("无 a2aChannels → 无歧义", () => {
    expect(detectAmbiguousTemplateRefs(base).length).toBe(0);
  });
});

describe("令四.1 · computeInstallDangerSurface", () => {
  it("six元绑定:hash/trustLevel/dangerFlags/mcp/cli/fileWrite", () => {
    const tpl = {
      id: "t1", title: "T", description: "", author: "a", createdAt: "", tags: [], downloads: 0, stars: 0,
      agents: [agent({ id: "ceo-0", role: "ceo", framework: "claude-code" })],
      requiredPermissions: { allowShell: true, allowFileWrite: true, allowWebAccess: false, mcpServers: ["github"] },
      trustLevel: "community",
    } as unknown as CompanyTemplate;
    const s = computeInstallDangerSurface(tpl);
    expect(s.templateHash).toBeTruthy();
    expect(s.trustLevel).toBe("community");
    expect(s.fileWrite).toBe(true);
    expect(s.dangerFlags).toContain("shell-access");
    expect(s.dangerFlags).toContain("file-write");
    expect(s.mcp).toContain("github");
    expect(s.cli).toContain("claude-code");
    // 同一模板两次算 → 稳定(供 preview/install 比对)
    expect(computeInstallDangerSurface(tpl)).toEqual(s);
  });
});
