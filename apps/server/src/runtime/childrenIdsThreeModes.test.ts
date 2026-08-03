import { describe, it, expect } from "vitest";
import { rerootAgents } from "./install.js";
import { rebuildChildrenIds } from "./installMerge.js";
import type { AgentNodeConfig } from "@opc/shared";

// 令四.2 · 三模式统一以 parentId 为真源重建 childrenIds。
// orchestrator.addAgents/updateAgent 在落地后调 rebuildChildrenIdsInPlace(与 rebuildChildrenIds 同逻辑),
// 三条安装路径(new-company reroot / merge / overwrite)最终都经此关口。本测试锁定:无论 id 如何重映射,
// **只要 parentId 正确,childrenIds 就被从 parentId 正确重建**——哪怕来源 childrenIds 是空/陈旧的。

const a = (over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig => ({
  name: over.id, role: "dev", childrenIds: [], model: "m", provider: "deepseek", framework: "api",
  companyId: "src", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
  ...over,
});

// 来源模板:parentId 正确,但 childrenIds 故意留空(模拟陈旧/漏挂,parentId 才是真源)。
const source: AgentNodeConfig[] = [
  a({ id: "ceo", role: "ceo", childrenIds: [] }),
  a({ id: "lead", role: "lead", parentId: "ceo", childrenIds: [] }),
  a({ id: "w1", parentId: "lead", childrenIds: [] }),
  a({ id: "w2", parentId: "lead", childrenIds: [] }),
];

describe("令四.2 · 三模式 childrenIds 以 parentId 为真源重建", () => {
  it("① new-company(reroot 新 id)后重建 → childrenIds 由 parentId 派生", () => {
    const { agents } = rerootAgents(source, "co-new", (old) => `${old}-x`);
    const rebuilt = rebuildChildrenIds(agents);
    const byId = (id: string) => rebuilt.find((n) => n.id === id)!;
    expect(byId("ceo-x").childrenIds).toEqual(["lead-x"]);
    expect(byId("lead-x").childrenIds.sort()).toEqual(["w1-x", "w2-x"]);
    expect(byId("w1-x").childrenIds).toEqual([]);
  });

  it("② restore(preserveIds:恒等 id)后重建 → 原 id 保留且 childrenIds 正确", () => {
    const { agents } = rerootAgents(source, "co-restore", (old) => old);
    const rebuilt = rebuildChildrenIds(agents);
    const byId = (id: string) => rebuilt.find((n) => n.id === id)!;
    expect(byId("ceo").childrenIds).toEqual(["lead"]);
    expect(byId("lead").childrenIds.sort()).toEqual(["w1", "w2"]);
  });

  it("③ overwrite(既有员工保留原挂载点)→ 换父后 childrenIds 双向同步(旧父摘除/新父加入)", () => {
    // 目标公司已有 ceo/leadA/leadB/w1(w1 挂 leadA);overwrite 把 w1 改挂到 leadB(parentId 变),
    // 重建以 parentId 为真源:leadA 摘除 w1、leadB 加入 w1,无双重。
    const existing: AgentNodeConfig[] = [
      a({ id: "ceo", role: "ceo", companyId: "co", childrenIds: ["leadA", "leadB"] }),
      a({ id: "leadA", role: "lead", companyId: "co", parentId: "ceo", childrenIds: ["w1"] }),
      a({ id: "leadB", role: "lead", companyId: "co", parentId: "ceo", childrenIds: [] }),
      a({ id: "w1", companyId: "co", parentId: "leadB", childrenIds: [] }), // parentId 已改指 leadB,childrenIds 尚未同步
    ];
    const rebuilt = rebuildChildrenIds(existing);
    const byId = (id: string) => rebuilt.find((n) => n.id === id)!;
    expect(byId("leadA").childrenIds).toEqual([]);
    expect(byId("leadB").childrenIds).toEqual(["w1"]);
    const parentsOfW1 = rebuilt.filter((n) => n.childrenIds.includes("w1")).map((n) => n.id);
    expect(parentsOfW1).toEqual(["leadB"]);
  });
});
