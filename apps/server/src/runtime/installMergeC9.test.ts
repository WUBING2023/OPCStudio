import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, Company, CompanyTemplate } from "@opc/shared";
import {
  detectMergeConflicts, resolveMerge, planMergeAgentMemories, rebuildChildrenIds,
  planOrgParentRebindApply, buildKeepCurrentOrgReviewItems, finalizeMergeReport,
  type CompanyMergeReport,
} from "./installMerge.js";
import { detectOrgChildrenMismatches, runTemplateDoctor } from "./templateDoctor.js";
import { importAgentMemoriesDetailed } from "./companyTemplate.js";
import { agentMemoryPath } from "../storage/mdMemory.js";

// 波4·泳道2·C9 契约第9条:map/merge 保真新增单测(P0 map 记忆覆盖、P0 map 遇新父级三选一、
// P1 childrenIds 由 parentId 重建、P1 doctor 互指校验)。既有 installMerge.test.ts 语义锁不动,新增独立文件。

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "prov-x",
    framework: "api", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}
function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-c9", title: "C9 模板", description: "d", author: "alice",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [agent({ id: "ceo-t", role: "ceo", childrenIds: ["dev-t"] }), agent({ id: "dev-t", role: "dev", parentId: "ceo-t" })],
    ...over,
  };
}
function company(over: Partial<Company> = {}): Company {
  return { id: "target", name: "目标公司", description: "", createdAt: "2026-01-01T00:00:00Z", ceoId: "ceo-x", ...over };
}

describe("C9-P0 · map 到已有员工不静默覆盖既有员工记忆(planMergeAgentMemories 补 !skipped)", () => {
  // 场景:模板 dev「Alice」与目标公司既有 dev「Alice」同 role+name → team_duplication;选 map。
  // resolveMerge 会把模板 id 映射到既有员工 id 且模板 id 进 skippedAgentIds。修复前:planMergeAgentMemories
  // 只排除 overwrite,把这条误判为新建员工 → importIdMap 指向既有员工 → importAgentMemories 覆盖其记忆。
  const tplDup = () => tpl({ agents: [agent({ id: "new-alice", role: "dev", name: "Alice" })] });
  const existingDup = () => [agent({ id: "old-alice", companyId: "target", role: "dev", name: "Alice" })];

  it("map 产物(idMap 指既有员工 + 同 key 在 skippedAgentIds)→ 记忆不进 importIdMap,进 requires_review", () => {
    const r = resolveMerge(tplDup(), company(), existingDup(), {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 前置:resolveMerge 确实把 map 员工映射到既有 id 且进 skipped(修复的输入前提)。
    expect(r.idMap["new-alice"]).toBe("old-alice");
    expect(r.skippedAgentIds).toContain("new-alice");

    const memories = [{ agent_id: "new-alice", role: "dev", content: "模板里 Alice 的外部记忆(不得覆盖既有)" }];
    const plan = planMergeAgentMemories(memories, r);
    // 修复核心:map 到既有员工 → 绝不写盘(importIdMap 为空),否则会整文件覆盖既有员工 agent-memory.md。
    expect(plan.importIdMap).toEqual({});
    expect(plan.reviewItems).toHaveLength(1);
    expect(plan.reviewItems[0].detail).toContain("old-alice");
    expect(plan.reviewItems[0].detail).toContain("保留目标员工记忆");
  });

  it("对照:真正新建的员工(idMap 有映射且不在 skipped)记忆仍正常导入", () => {
    const plan = planMergeAgentMemories(
      [{ agent_id: "brandnew", role: "qa", content: "x" }],
      { idMap: { brandnew: "brandnew-new-id" }, overwriteAgentIds: [], skippedAgentIds: [] },
    );
    expect(plan.importIdMap).toEqual({ brandnew: "brandnew-new-id" });
    expect(plan.reviewItems).toEqual([]);
  });

  it("回归:overwrite 覆盖既有员工时记忆同样不导(保留目标)", () => {
    const plan = planMergeAgentMemories(
      [{ agent_id: "dev-t", role: "dev", content: "x" }],
      { idMap: { "dev-t": "dev-t" }, overwriteAgentIds: ["dev-t"], skippedAgentIds: [] },
    );
    expect(plan.importIdMap).toEqual({});
    expect(plan.reviewItems[0].detail).toContain("overwrite");
  });
});

describe("C9-P0 · map 到已有员工遇新父级三选一(orgParent 冲突 + keep/adopt/reject)", () => {
  // 目标公司:CEO-x → old-lead → old-dev(old-dev 挂在 old-lead 下)。
  // 模板:new-dev「Dev」(map 到 old-dev),但模板声明 new-dev 的父是 new-ceo「CEO-X」(map 到 CEO-x)。
  //   → old-dev 现有父 = old-lead,模板声明父(解析)= ceo-x → orgParent 冲突。
  const existing = () => [
    agent({ id: "ceo-x", companyId: "target", role: "ceo", name: "CEO-X", childrenIds: ["old-lead"] }),
    agent({ id: "old-lead", companyId: "target", role: "lead", name: "Lead", parentId: "ceo-x", childrenIds: ["old-dev"] }),
    agent({ id: "old-dev", companyId: "target", role: "dev", name: "Dev", parentId: "old-lead", childrenIds: [] }),
  ];
  const tplReparent = () => tpl({
    agents: [
      agent({ id: "new-ceo", role: "ceo", name: "CEO-X", childrenIds: ["new-dev"] }),
      agent({ id: "new-dev", role: "dev", name: "Dev", parentId: "new-ceo" }),
    ],
  });

  it("detectMergeConflicts 报出 orgParent 冲突(模板声明父 ≠ 既有员工现有父)", () => {
    const report = detectMergeConflicts(tplReparent(), company(), existing());
    expect(report.orgParent).toHaveLength(1);
    expect(report.orgParent[0]).toMatchObject({
      type: "org_parent", existingAgentId: "old-dev", currentParentId: "old-lead", templateParentId: "ceo-x",
    });
  });

  it("map + 检出 orgParent 冲突但未选 orgParentResolution → 409 不执行", () => {
    const r = resolveMerge(tplReparent(), company(), existing(), {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.conflicts?.orgParent).toHaveLength(1); }
  });

  it("reject → 409 拒绝导入(未落地任何改动)", () => {
    const r = resolveMerge(tplReparent(), company(), existing(), {}, { teamDuplicationResolution: "map", orgParentResolution: "reject" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(409);
  });

  it("keep-current-org → ok,不改挂既有员工(orgParentRebindings 空),决策记 keep", () => {
    const r = resolveMerge(tplReparent(), company(), existing(), {}, { teamDuplicationResolution: "map", orgParentResolution: "keep-current-org" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orgParentRebindings).toEqual([]);
    const dec = r.decisions.find((d) => d.category === "org_parent");
    expect(dec?.strategy).toBe("keep-current-org");
  });

  it("adopt-template-org → ok,orgParentRebindings 含既有员工改挂(old-dev 从 old-lead 改挂到 ceo-x)", () => {
    const r = resolveMerge(tplReparent(), company(), existing(), {}, { teamDuplicationResolution: "map", orgParentResolution: "adopt-template-org" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.orgParentRebindings).toEqual([{ agentId: "old-dev", oldParentId: "old-lead", newParentId: "ceo-x" }]);
    const dec = r.decisions.find((d) => d.category === "org_parent");
    expect(dec?.strategy).toBe("adopt-template-org");
  });

  it("无 orgParent 差异(模板声明父与既有父一致)→ 不报冲突,map 直接可执行", () => {
    // 模板 new-dev 的父也 map 到 old-lead → 与既有一致,无 orgParent 冲突。
    const t = tpl({
      agents: [
        agent({ id: "new-lead", role: "lead", name: "Lead", childrenIds: ["new-dev"] }),
        agent({ id: "new-dev", role: "dev", name: "Dev", parentId: "new-lead" }),
      ],
    });
    const report = detectMergeConflicts(t, company(), existing());
    expect(report.orgParent).toEqual([]);
    const r = resolveMerge(t, company(), existing(), {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(true); // 无 orgParent 冲突 → 不因缺 orgParentResolution 而 409
  });
});

describe("C9-P1 · rebuildChildrenIds(parentId 为唯一真源重建 childrenIds)", () => {
  it("按 parentId 重建:声明失配的 childrenIds 被纠正,顺序稳定", () => {
    const agents = [
      { id: "a", parentId: undefined, childrenIds: ["WRONG"] },
      { id: "b", parentId: "a", childrenIds: [] },
      { id: "c", parentId: "a", childrenIds: [] },
    ];
    const rebuilt = rebuildChildrenIds(agents);
    expect(rebuilt.find((x) => x.id === "a")!.childrenIds).toEqual(["b", "c"]);
    expect(rebuilt.find((x) => x.id === "b")!.childrenIds).toEqual([]);
  });

  it("消顺序敏感:子先于父出现在数组里也能正确重建", () => {
    const agents = [
      { id: "child", parentId: "parent", childrenIds: [] },
      { id: "parent", parentId: undefined, childrenIds: [] },
    ];
    const rebuilt = rebuildChildrenIds(agents);
    expect(rebuilt.find((x) => x.id === "parent")!.childrenIds).toEqual(["child"]);
  });

  it("悬空 parentId(指向集合外)不产生边;不改原对象", () => {
    const original = [{ id: "x", parentId: "ghost", childrenIds: ["stale"] }];
    const rebuilt = rebuildChildrenIds(original);
    expect(rebuilt[0].childrenIds).toEqual([]);
    expect(original[0].childrenIds).toEqual(["stale"]); // 纯函数,不改原
  });
});

describe("C9-P1 · templateDoctor parentId↔childrenIds 互指一致性校验", () => {
  it("detectOrgChildrenMismatches:声明了子但子 parentId 不指回 → 报失配", () => {
    const agents = [
      { id: "lead", parentId: undefined, childrenIds: ["dev"] },
      { id: "dev", parentId: undefined, childrenIds: [] }, // parentId 没指回 lead
    ];
    const m = detectOrgChildrenMismatches(agents);
    expect(m.length).toBeGreaterThan(0);
    expect(m.join(" ")).toContain("lead→dev");
  });

  it("detectOrgChildrenMismatches:子 parentId 指来但未进父 childrenIds → 报失配", () => {
    const agents = [
      { id: "lead", parentId: undefined, childrenIds: [] }, // 缺 dev
      { id: "dev", parentId: "lead", childrenIds: [] },
    ];
    const m = detectOrgChildrenMismatches(agents);
    expect(m.join(" ")).toContain("lead→dev");
  });

  it("一致的父子互指 → 无失配", () => {
    const agents = [
      { id: "lead", parentId: undefined, childrenIds: ["dev"] },
      { id: "dev", parentId: "lead", childrenIds: [] },
    ];
    expect(detectOrgChildrenMismatches(agents)).toEqual([]);
  });

  it("runTemplateDoctor 对失配模板给 warning 级 org_children_consistent(不拦装)", () => {
    const t = tpl({
      hash: undefined,
      agents: [
        agent({ id: "ceo-t", role: "ceo", childrenIds: [] }), // 缺 dev-t
        agent({ id: "dev-t", role: "dev", parentId: "ceo-t" }),
      ],
    });
    const report = runTemplateDoctor(t);
    const check = report.checks.find((c) => c.id === "org_children_consistent");
    expect(check?.status).toBe("warning");
    expect(report.install_allowed).toBe(true); // warning 不拦装
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 波4b·泳道B·C9-P2(对抗验证 CONFIRMED)· keep-current-org 兑现"进 requires_review"
//   修复前:resolveMerge 的 org_parent 决策 summary 声称保持原组织后"进 requires_review",但
//   finalizeMergeReport 从不产出 orgParent 条目 → 报告里查无此条,承诺落空。
// ════════════════════════════════════════════════════════════════════════════
describe("C9-P2 · keep-current-org 落真 requires_review 条目(buildKeepCurrentOrgReviewItems + finalizeMergeReport)", () => {
  const orgConflicts = () => [{
    type: "org_parent" as const, agentId: "new-dev", existingAgentId: "old-dev", existingName: "Dev",
    currentParentId: "old-lead", templateParentId: "ceo-x", detail: "组织差异",
  }];
  const emptyBase = (): CompanyMergeReport => ({ preserved: [], added: [], requires_review: [], requires_local_setup: [] });

  it("map+keep-current-org → 每条 orgParent 冲突生成一条 requires_review 条目(含既有员工/新旧父)", () => {
    const items = buildKeepCurrentOrgReviewItems(orgConflicts(), "keep-current-org", "map");
    expect(items).toHaveLength(1);
    expect(items[0].field).toBe("orgParent");
    expect(items[0].detail).toContain("old-dev");
    expect(items[0].detail).toContain("old-lead");   // 维持的既有上级
    expect(items[0].detail).toContain("ceo-x");       // 未采纳的模板上级
  });

  it("adopt-template-org / reject / undefined → 不生成条目(只 keep 才复核)", () => {
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), "adopt-template-org", "map")).toEqual([]);
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), "reject", "map")).toEqual([]);
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), undefined, "map")).toEqual([]);
  });

  it("非 map 处置(overwrite/add-department/缺省)→ 即便带 keep-current-org 也不生成条目(组织未被触碰,落条目=误报;对抗验证 CONFIRMED 修)", () => {
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), "keep-current-org", "overwrite")).toEqual([]);
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), "keep-current-org", "add-department")).toEqual([]);
    expect(buildKeepCurrentOrgReviewItems(orgConflicts(), "keep-current-org", undefined)).toEqual([]);
  });

  it("finalizeMergeReport 真把 orgParentReviewItems 并入 requires_review(端到端兑现承诺)", () => {
    const items = buildKeepCurrentOrgReviewItems(orgConflicts(), "keep-current-org", "map");
    const report = finalizeMergeReport(emptyBase(), {
      memoryReviewItems: [], missingMcp: [], agentMemoriesImported: 0, orgParentReviewItems: items,
    });
    expect(report.requires_review.some((r) => r.field === "orgParent" && r.detail.includes("old-dev"))).toBe(true);
  });

  it("回归:不传 orgParentReviewItems 时 requires_review 只含记忆复核项(旧调用口径不破)", () => {
    const report = finalizeMergeReport(emptyBase(), {
      memoryReviewItems: [{ field: "agentMemories", detail: "x" }], missingMcp: [], agentMemoriesImported: 0,
    });
    expect(report.requires_review).toEqual([{ field: "agentMemories", detail: "x" }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 波4b·泳道B·C9-P2(对抗验证 PLAUSIBLE)· adopt-template-org 改挂在 addAgents 之后统一重建
//   修复前:两条 merge 路由在 addAgents 之前对"仅既有员工"rebuildChildrenIds。当模板声明的父是本次
//   新建员工(one-directional 模板:new-dev.parentId=new-ceo 但 new-ceo.childrenIds 不含 new-dev),
//   resolveMerge 产出的 new-ceo.childrenIds=[],且新父不在既有集合里 → 被改挂的既有员工 parentId 指向
//   new-ceo,new-ceo.childrenIds 却收不到它,父子双向失配。planOrgParentRebindApply 把新父纳入集合修死。
// ════════════════════════════════════════════════════════════════════════════
describe("C9-P2 · adopt-template-org 新父是本次新建员工时无双重/失配上下级(planOrgParentRebindApply)", () => {
  it("新父(本次新建,one-directional)纳入重建集 → 新父 childrenIds 收到被改挂员工,旧父移除,无失配", () => {
    // 模拟 addAgents 之后目标公司全体:old-lead/old-dev 既有 + new-ceo 本次新建(childrenIds 空=单向模板)。
    const companyAfterAdd = [
      { id: "ceo-x", parentId: undefined, childrenIds: ["old-lead", "new-ceo"] },
      { id: "old-lead", parentId: "ceo-x", childrenIds: ["old-dev"] },
      { id: "old-dev", parentId: "old-lead", childrenIds: [] },
      { id: "new-ceo", parentId: "ceo-x", childrenIds: [] }, // 单向:模板没在 childrenIds 里列 new-dev
    ];
    const rebindings = [{ agentId: "old-dev", oldParentId: "old-lead", newParentId: "new-ceo" }];
    const patches = planOrgParentRebindApply(companyAfterAdd, rebindings);
    const byId = new Map(patches.map((p) => [p.id, p]));

    // 修复核心:新父(本次新建)childrenIds 收到被改挂的既有员工。
    expect(byId.get("new-ceo")!.childrenIds).toEqual(["old-dev"]);
    // 旧父移除该子(不留双重从属)。
    expect(byId.get("old-lead")!.childrenIds).toEqual([]);
    // 被改挂员工 parentId 指向新父。
    expect(byId.get("old-dev")!.parentId).toBe("new-ceo");
    // 只 patch 受影响三节点,不动无关节点(ceo-x 不在补丁里)。
    expect(byId.has("ceo-x")).toBe(false);
  });

  it("整链验证:resolveMerge(map+adopt) 产出 rebindings → 应用后无 detectOrgChildrenMismatches 失配", () => {
    const existing = () => [
      agent({ id: "ceo-x", companyId: "target", role: "ceo", name: "CEO-X", childrenIds: ["old-lead"] }),
      agent({ id: "old-lead", companyId: "target", role: "lead", name: "Lead", parentId: "ceo-x", childrenIds: ["old-dev"] }),
      agent({ id: "old-dev", companyId: "target", role: "dev", name: "Dev", parentId: "old-lead", childrenIds: [] }),
    ];
    // 模板:new-boss「NewBoss」全新(不撞既有)+ new-dev「Dev」map 到 old-dev,new-dev.parentId=new-boss。
    // 关键:new-boss.childrenIds 【不】列 new-dev(单向模板)——复现 resolveMerge 不自动补 childrenIds 的场景。
    const t = tpl({
      agents: [
        agent({ id: "new-boss", role: "manager", name: "NewBoss", childrenIds: [] }),
        agent({ id: "new-dev", role: "dev", name: "Dev", parentId: "new-boss" }),
      ],
    });
    const r = resolveMerge(t, company(), existing(), {}, { teamDuplicationResolution: "map", orgParentResolution: "adopt-template-org" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // old-dev 改挂到 new-boss(本次新建的父)。
    expect(r.orgParentRebindings).toEqual([{ agentId: "old-dev", oldParentId: "old-lead", newParentId: "new-boss" }]);

    // 模拟 addAgents:既有全体 ∪ 本次新建(toAdd,new-dev map 掉了只剩 new-boss)。
    const overwriteSet = new Set(r.overwriteAgentIds);
    const toAdd = r.agents.filter((a) => !overwriteSet.has(a.id));
    expect(toAdd.map((a) => a.id)).toContain("new-boss");
    const companyAfterAdd = [...existing(), ...toAdd].map((a) => ({ id: a.id, parentId: a.parentId, childrenIds: a.childrenIds }));

    // 应用改挂补丁,写回集合。
    const patches = planOrgParentRebindApply(companyAfterAdd, r.orgParentRebindings);
    const merged = companyAfterAdd.map((a) => {
      const p = patches.find((x) => x.id === a.id);
      return p ? { ...a, parentId: p.parentId, childrenIds: p.childrenIds } : a;
    });
    // 改挂关系父子互指一致:new-boss(本次新建的父)childrenIds 含 old-dev、old-lead 不含 old-dev、
    // old-dev.parentId=new-boss —— 无双重从属(修复前:new-boss.childrenIds=[] 且不在重建集 → 失配)。
    const newBoss = merged.find((a) => a.id === "new-boss")!;
    const oldLead = merged.find((a) => a.id === "old-lead")!;
    const oldDev = merged.find((a) => a.id === "old-dev")!;
    expect(newBoss.childrenIds).toContain("old-dev");
    expect(oldLead.childrenIds).not.toContain("old-dev");
    expect(oldDev.parentId).toBe("new-boss");
    // 改挂子树(new-boss/old-lead/old-dev)三节点互指零失配(不含新根 attach 点等无关维度)。
    expect(detectOrgChildrenMismatches(merged.filter((a) => ["new-boss", "old-lead", "old-dev"].includes(a.id)))).toEqual([]);
  });

  it("空 rebindings → 空补丁(非 adopt 路径零副作用)", () => {
    expect(planOrgParentRebindApply([{ id: "a", childrenIds: [] }], [])).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 波4b·泳道B·gap③(用户令)· overwrite 场景个人记忆:map、overwrite 都不得直写既有员工 agent-memory.md。
//   活体字节不变断言:overwrite 策略下,既有员工 agent-memory.md 磁盘字节在导入前后完全一致。
// ════════════════════════════════════════════════════════════════════════════
describe("gap③ · overwrite 既有员工个人记忆不被直写(活体字节不变)", () => {
  it("overwrite → planMergeAgentMemories 不进 importIdMap;importAgentMemories 落盘后既有 md 字节不变", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c9-overwrite-mem-"));
    try {
      const EXISTING_MEM = "既有员工的原始记忆(overwrite 不得覆盖)\n";
      const memPath = agentMemoryPath(root, "old-bob");
      fs.mkdirSync(path.dirname(memPath), { recursive: true });
      fs.writeFileSync(memPath, EXISTING_MEM, "utf-8");
      const before = fs.readFileSync(memPath); // Buffer 字节快照

      // 模板 bob「Bob」与既有 old-bob「Bob」同 role+name → team_duplication;选 overwrite。
      const t = tpl({ agents: [agent({ id: "tmpl-bob", role: "dev", name: "Bob" })] });
      const existing = [agent({ id: "old-bob", companyId: "target", role: "dev", name: "Bob" })];
      const r = resolveMerge(t, company(), existing, {}, { teamDuplicationResolution: "overwrite" });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.overwriteAgentIds).toContain("old-bob"); // 落到既有 id 上

      const memories = [{ agent_id: "tmpl-bob", role: "dev", content: "来源 Bob 的外部记忆(必须不落到既有员工)" }];
      const plan = planMergeAgentMemories(memories, r);
      // gap③ 核心:overwrite 既有员工 → 记忆不进 importIdMap(不直写),转 requires_review。
      expect(plan.importIdMap).toEqual({});
      expect(plan.reviewItems).toHaveLength(1);
      expect(plan.reviewItems[0].detail).toContain("overwrite");

      // 活体:用真实 importAgentMemoriesDetailed(merge 路由同款,非抛出、best-effort)按计划落盘,
      // overwrite 下 importIdMap 为 {} → 来源记忆未映射不写盘(既有 md 字节必须一字节未改),written=0。
      const written = importAgentMemoriesDetailed(root, plan.importIdMap, memories).written;
      expect(written).toBe(0);
      const after = fs.readFileSync(memPath);
      expect(after.equals(before)).toBe(true); // 字节级不变断言
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 波4b·泳道B·gap④(用户令)· idMap 统一重写审计:A2A channels / memory owner 引用经同一 idMap 重写。
//   审计结论(见任务报告 evidence):
//     · A2A channels:resolveMerge 用 resolveTemplateAgentRef(template.agents, idMap, ref) 重写 from/to,
//       map 候选的引用解析到既有员工 id —— 本测试断言。
//     · workflow verification 边(producer/verifier):是 role 名(reroot 稳定,非 agent id),无需 idMap
//       重写;merge 模式 workflow 不合并(走 requires_review),不涉及。
//     · memory owner:planMergeAgentMemories 用 merge.idMap 精确对人;agentMemories 键经 idMap 映射;
//       seedMemories 的 agent 级 owner_id 是 role(稳定)。全部覆盖,无引用指向不存在的模板 id。
// ════════════════════════════════════════════════════════════════════════════
// ════════════════════════════════════════════════════════════════════════════
// 泳道O·P0(wave4-live-acceptance)· 跨公司组织完整性:adopt-template-org 的新父与【外公司】既有 agent
//   id 全局碰撞时,改挂目标必须经同一 idMap 重映射到落地后的真实 id(copy-as-new 重排后的),绝不指向那个
//   恰好同 id 的外公司 agent。否则既有员工被改挂到外公司 → 持久跨公司污染。
// ════════════════════════════════════════════════════════════════════════════
describe("泳道O·P0 · adopt-template-org 新父与外公司 id 碰撞 → 改挂目标经 idMap 重映射,外公司零触碰", () => {
  // 目标公司 target:ceo-x → old-dev(挂在 ceo-x 下)。外公司 other-co 有个 id 恰为 "new-boss" 的 agent。
  // 模板:new-boss「NewBoss」(id 与外公司碰撞 → 全局冲突 → copy-as-new 重排新 id)作为新父;
  //       new-dev「Dev」map 到 old-dev,new-dev.parentId=new-boss。adopt-template-org 把 old-dev 改挂到 new-boss。
  const existing = () => [
    agent({ id: "ceo-x", companyId: "target", role: "ceo", name: "CEO-X", childrenIds: ["old-dev"] }),
    agent({ id: "old-dev", companyId: "target", role: "dev", name: "Dev", parentId: "ceo-x", childrenIds: [] }),
    agent({ id: "new-boss", companyId: "other-co", role: "manager", name: "外公司经理" }), // 外公司,id 与模板父碰撞
  ];
  const tplCollide = () => tpl({
    agents: [
      agent({ id: "new-boss", role: "manager", name: "NewBoss" }),
      agent({ id: "new-dev", role: "dev", name: "Dev", parentId: "new-boss" }),
    ],
  });

  it("改挂目标 = copy-as-new 重排后的落地 id(在 target 公司),不是外公司同 id agent", () => {
    const r = resolveMerge(tplCollide(), company({ ceoId: "ceo-x" }), existing(), {}, {
      teamDuplicationResolution: "map", orgParentResolution: "adopt-template-org",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // new-boss 与外公司 id 碰撞 → 被 copy-as-new 重排(idMap 值 ≠ 原始 "new-boss")。
    expect(r.idMap["new-boss"]).not.toBe("new-boss");
    // 改挂目标经同一 idMap 重映射到落地后的新 id,绝不残留原始 "new-boss"(外公司 agent)。
    expect(r.orgParentRebindings).toEqual([
      { agentId: "old-dev", oldParentId: "ceo-x", newParentId: r.idMap["new-boss"] },
    ]);
    expect(r.orgParentRebindings.some((rb) => rb.newParentId === "new-boss")).toBe(false);
    // 落地的 new-boss(copy)归属 target 公司。
    const landedBoss = r.agents.find((a) => a.id === r.idMap["new-boss"]);
    expect(landedBoss?.companyId).toBe("target");
    // result.agents 不含外公司原始 new-boss(零触碰外公司)。
    expect(r.agents.some((a) => a.id === "new-boss")).toBe(false);
  });

  it("改挂后应用:old-dev 挂到落地新父,外公司 new-boss 的 childrenIds 不被塞入 old-dev(跨公司边不建)", () => {
    const r = resolveMerge(tplCollide(), company({ ceoId: "ceo-x" }), existing(), {}, {
      teamDuplicationResolution: "map", orgParentResolution: "adopt-template-org",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const landedBossId = r.idMap["new-boss"];
    // 模拟 addAgents 后目标公司全体(既有 target ∪ 本次新建;外公司 agent 不在目标公司集合内)。
    const overwriteSet = new Set(r.overwriteAgentIds);
    const toAdd = r.agents.filter((a) => !overwriteSet.has(a.id));
    const companyAfterAdd = [
      ...existing().filter((a) => a.companyId === "target"),
      ...toAdd,
    ].map((a) => ({ id: a.id, parentId: a.parentId, childrenIds: a.childrenIds, companyId: a.companyId }));
    const patches = planOrgParentRebindApply(companyAfterAdd, r.orgParentRebindings);
    const byId = new Map(patches.map((p) => [p.id, p]));
    // old-dev 改挂到落地新父(target 公司内)。
    expect(byId.get("old-dev")?.parentId).toBe(landedBossId);
    // 落地新父的 childrenIds 收到 old-dev(同公司,建边)。
    expect(byId.get(landedBossId)?.childrenIds).toEqual(["old-dev"]);
  });
});

describe("gap④ · A2A channels 引用经同一 idMap 重写(map 候选解析到既有员工 id)", () => {
  it("map:模板 a2aChannel 指向被 map 的员工 → 落地通道 to 是既有员工 id,不是模板 id", () => {
    // 模板:new-ceo(全新)→ new-dev「Dev」(map 到既有 old-dev);通道 new-ceo→new-dev。
    const existing = [
      agent({ id: "ceo-x", companyId: "target", role: "ceo", name: "CEO", childrenIds: ["old-dev"] }),
      agent({ id: "old-dev", companyId: "target", role: "dev", name: "Dev", parentId: "ceo-x" }),
    ];
    // new-dev「Dev」map 到 old-dev,且【无 parentId】(根,map 语义=保持现状,不触发 orgParent 冲突)——
    // 专测 A2A 引用的 idMap 重写,不掺入组织父级维度。
    const t = tpl({
      agents: [
        agent({ id: "new-ceo", role: "manager", name: "Boss" }),
        agent({ id: "new-dev", role: "dev", name: "Dev" }),
      ],
      a2aChannels: [{ from: "new-ceo", to: "new-dev", purpose: "下发" }],
    });
    const r = resolveMerge(t, company({ ceoId: "ceo-x" }), existing, {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // new-dev map 到 old-dev(既有员工 id)。
    expect(r.idMap["new-dev"]).toBe("old-dev");
    // 通道 to 经同一 idMap 重写成既有员工 id(不残留模板合成 id new-dev)。
    const chan = r.presetChannels.find((c) => c.to === "old-dev");
    expect(chan).toBeTruthy();
    expect(chan!.from).toBe(r.idMap["new-ceo"]); // from 也经 idMap 重写到落地 id
    expect(r.presetChannels.some((c) => c.from === "new-dev" || c.to === "new-dev")).toBe(false); // 无未重写的模板 id 残留
  });
});
