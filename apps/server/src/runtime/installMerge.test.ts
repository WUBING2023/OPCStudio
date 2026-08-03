import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, BundleMemoryRecord, Company, CompanyTemplate } from "@opc/shared";
import {
  detectMergeConflicts, resolveMerge, sanitizeMergeStrategies, buildInstallPreviewSummary,
  detectMemoryScopeConflicts, resolveMemoryScopeConflicts, type SeedMemoryRecord,
  mergeCompanyLevelFields, planMergeAgentMemories, finalizeMergeReport,
} from "./installMerge.js";

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "prov-x",
    framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true, ...over,
  };
}

function tpl(over: Partial<CompanyTemplate> = {}): CompanyTemplate {
  return {
    id: "t-merge", title: "合并测试模板", description: "d", author: "alice",
    createdAt: "2026-07-01T00:00:00Z", tags: [], downloads: 0, stars: 0, readme: "r",
    agents: [
      agent({ id: "ceo-t", role: "ceo", childrenIds: ["dev-t"] }),
      agent({ id: "dev-t", role: "dev", parentId: "ceo-t" }),
    ],
    ...over,
  };
}

function company(over: Partial<Company> = {}): Company {
  return { id: "target", name: "目标公司", description: "", createdAt: "2026-01-01T00:00:00Z", ceoId: "ceo-x", ...over };
}

describe("D3 · installMerge — agent_id 冲突", () => {
  it("检测:模板 agent id 与现有员工 id 相同", () => {
    const t = tpl({ agents: [agent({ id: "dev-x", role: "dev", name: "模板里的 dev" })] });
    const existing = [agent({ id: "dev-x", companyId: "target", name: "现有的 dev" })];
    const report = detectMergeConflicts(t, company(), existing);
    expect(report.agentId).toEqual([{ type: "agent_id", agentId: "dev-x", existingName: "现有的 dev", incomingName: "模板里的 dev" }]);
  });

  it("P1 · 语义团队重复:reroot 换新 id 后靠 role+name 抓出(合并克隆会静默新增第二套团队)", () => {
    const t = tpl({ agents: [agent({ id: "new-alice", role: "dev", name: "Alice" })] });
    const existing = [agent({ id: "old-alice", companyId: "target", role: "dev", name: "Alice" })];
    const report = detectMergeConflicts(t, company(), existing);
    expect(report.agentId).toEqual([]); // id 不同 → 不是 id 碰撞,旧检测漏掉
    expect(report.teamDuplication).toHaveLength(1);
    expect(report.teamDuplication[0]).toMatchObject({ type: "team_duplication", role: "dev", incomingName: "Alice", existingAgentId: "old-alice", existingName: "Alice" });
  });

  it("P1 · id 碰撞不重复报进 team_duplication(已按 agent_id 报过)", () => {
    const t = tpl({ agents: [agent({ id: "dev-x", role: "dev", name: "Bob" })] });
    const existing = [agent({ id: "dev-x", companyId: "target", role: "dev", name: "Bob" })];
    const report = detectMergeConflicts(t, company(), existing);
    expect(report.agentId).toHaveLength(1);
    expect(report.teamDuplication).toEqual([]);
  });

  it("P1 · 他公司同名同角色不算重复(只看目标公司)", () => {
    const t = tpl({ agents: [agent({ id: "new-carol", role: "dev", name: "Carol" })] });
    const existing = [agent({ id: "old-carol", companyId: "other-co", role: "dev", name: "Carol" })];
    const report = detectMergeConflicts(t, company(), existing);
    expect(report.teamDuplication).toEqual([]); // Carol 属他公司,不在目标公司范围
  });

  it("默认 copy-as-new:冲突员工改 id 加后缀,parentId/childrenIds/A2A 引用同步重写、不悬空", () => {
    const t = tpl({
      agents: [
        agent({ id: "root-t", role: "lead", childrenIds: ["dev-t"] }), // 无冲突,保留原 id
        agent({ id: "dev-t", role: "dev", parentId: "root-t" }), // 与现有 dev-t 冲突
      ],
      a2aChannels: [{ from: "root-t", to: "dev-t", purpose: "日常同步" }],
    });
    const existing = [agent({ id: "dev-t", companyId: "target", name: "现有 dev" })];
    const targetCompany = company({ ceoId: "existing-ceo" });
    const result = resolveMerge(t, targetCompany, existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.agents.map(a => a.id);
    expect(ids).toContain("root-t");
    expect(ids).not.toContain("dev-t"); // 冲突的原 id 不再使用
    const devCopy = result.agents.find(a => a.id !== "root-t")!;
    expect(devCopy.id).toBe("dev-t-copy");

    const root = result.agents.find(a => a.id === "root-t")!;
    expect(root.parentId).toBe("existing-ceo"); // 模板内的根 → 挂到目标公司挂载点
    expect(root.childrenIds).toEqual([devCopy.id]); // childrenIds 同步重写成新 id
    expect(devCopy.parentId).toBe("root-t"); // parentId 同步重写,双向一致、不悬空

    expect(result.presetChannels).toContainEqual({ from: "root-t", to: devCopy.id, purpose: "日常同步" }); // A2A 引用同步重写
  });

  it("keep-current:跳过冲突员工,其子节点重新挂到挂载点,不留悬空引用", () => {
    const t = tpl({
      agents: [
        agent({ id: "root-t", role: "lead", childrenIds: ["dev-t"] }),
        agent({ id: "dev-t", role: "dev", parentId: "root-t", childrenIds: ["worker-t"] }), // 冲突,将被跳过
        agent({ id: "worker-t", role: "dev", parentId: "dev-t" }), // dev-t 的子节点
      ],
    });
    const existing = [agent({ id: "dev-t", companyId: "target" })];
    const targetCompany = company({ ceoId: "existing-ceo" });
    const result = resolveMerge(t, targetCompany, existing, { agentId: "keep-current" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.agents.map(a => a.id);
    expect(ids).toEqual(["root-t", "worker-t"]);
    const worker = result.agents.find(a => a.id === "worker-t")!;
    expect(worker.parentId).toBe("existing-ceo"); // 父节点被跳过 → 重新挂载,不悬空
  });

  it("manual:与 keep-current 同机制——不自动化处理,跳过该员工", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev" })] });
    const existing = [agent({ id: "dev-t", companyId: "target" })];
    const result = resolveMerge(t, company(), existing, { agentId: "manual" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agents).toEqual([]);
  });

  it("overwrite:无 confirmOverwrite 时拒绝(高风险二次确认)", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev" })] });
    const existing = [agent({ id: "dev-t", companyId: "target" })];
    const result = resolveMerge(t, company(), existing, { agentId: "overwrite" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
  });

  it("overwrite:confirmOverwrite:true 后原地覆盖,保留原挂载位置与既有子节点", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev", name: "新版 dev" })] });
    const existing = [agent({ id: "dev-t", companyId: "target", name: "旧版 dev", parentId: "lead-x", childrenIds: ["sub-x"] })];
    const result = resolveMerge(t, company(), existing, { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overwriteAgentIds).toEqual(["dev-t"]);
    const merged = result.agents.find(a => a.id === "dev-t")!;
    expect(merged.name).toBe("新版 dev");
    expect(merged.parentId).toBe("lead-x"); // 挂载位置不因覆盖而改变
    expect(merged.childrenIds).toContain("sub-x");
  });

  // 发现②(对抗验收缺口):overwrite 高风险路径没有安全网——resolveMerge 现在需要把"被覆盖前的完整
  // 既有对象"也吐出来,供调用方(路由层)存进 install transaction 的 preMerge 快照,回滚才能真正整对象还原。
  it("overwrite:result.overwrittenAgents 携带覆盖前的完整既有对象(而不只是 id)", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev", name: "新版 dev", model: "new-model" })] });
    const before = agent({ id: "dev-t", companyId: "target", name: "旧版 dev", model: "old-model", parentId: "lead-x", childrenIds: ["sub-x"] });
    const result = resolveMerge(t, company(), [before], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overwrittenAgents).toEqual([before]);
  });

  it("非 overwrite 场景:result.overwrittenAgents 恒为空数组", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev" })] });
    const existing = [agent({ id: "dev-t", companyId: "target" })];
    const result = resolveMerge(t, company(), existing); // 默认 copy-as-new
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overwrittenAgents).toEqual([]);
  });

  // #24:冲突检测按全局花名册比 id,但 overwrite 只能作用于目标公司内的同 id 员工——撞上其它公司的
  // 同 id 员工时若照样覆盖,该员工会被改写 companyId 掳进目标公司,还带着指向原公司上级的 parentId,
  // 两家公司的组织树同时坏掉。
  it("#24:overwrite 撞上其它公司的同 id 员工 → 降级 copy-as-new,不跨公司掳人", () => {
    const t = tpl({ agents: [agent({ id: "dev-a", role: "dev", name: "模板 dev" })] });
    const otherCompanyDev = agent({ id: "dev-a", companyId: "company-b", parentId: "ceo-of-b", name: "别家公司的 dev" });
    const result = resolveMerge(t, company(), [otherCompanyDev], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overwriteAgentIds).toEqual([]); // 没有任何覆盖发生
    expect(result.overwrittenAgents).toEqual([]);
    expect(result.agents).toHaveLength(1);
    const copied = result.agents[0];
    expect(copied.id).toBe("dev-a-copy"); // 降级 copy-as-new
    expect(copied.companyId).toBe("target");
    expect(copied.parentId).toBe("ceo-x"); // 挂到目标公司挂载点,不指向别家公司的父节点
  });

  it("#24:目标公司内的同 id 员工仍正常覆盖(降级只针对跨公司)", () => {
    const t = tpl({ agents: [agent({ id: "dev-a", role: "dev", name: "新版" })] });
    const inTarget = agent({ id: "dev-a", companyId: "target", parentId: "ceo-x", name: "旧版" });
    const result = resolveMerge(t, company(), [inTarget], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overwriteAgentIds).toEqual(["dev-a"]);
  });

  // decisions 的 agent_id 策略如实标注:跨公司降级发生时不再对外宣称 overwrite。
  it("全部冲突都跨公司降级 → decisions.strategy 标 copy-as-new + summary 带降级数", () => {
    const t = tpl({ agents: [agent({ id: "dev-a", role: "dev", name: "模板 dev" })] });
    const otherCompanyDev = agent({ id: "dev-a", companyId: "company-b", parentId: "ceo-of-b", name: "别家公司的 dev" });
    const result = resolveMerge(t, company(), [otherCompanyDev], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.decisions.find(x => x.category === "agent_id")!;
    expect(d.strategy).toBe("copy-as-new");
    expect(d.summary).toContain("跨公司降级 copy-as-new 1");
  });

  it("部分覆盖 + 部分跨公司降级 → decisions.strategy 标混合值 overwrite+copy-as-new", () => {
    const t = tpl({
      agents: [
        agent({ id: "dev-in", role: "dev", name: "新版" }),   // 目标公司内冲突 → 真覆盖
        agent({ id: "dev-out", role: "dev", name: "模板 dev" }), // 跨公司冲突 → 降级 copy-as-new
      ],
    });
    const existing = [
      agent({ id: "dev-in", companyId: "target", parentId: "ceo-x", name: "旧版" }),
      agent({ id: "dev-out", companyId: "company-b", parentId: "ceo-of-b", name: "别家公司的 dev" }),
    ];
    const result = resolveMerge(t, company(), existing, { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.decisions.find(x => x.category === "agent_id")!;
    expect(d.strategy).toBe("overwrite+copy-as-new");
    expect(d.summary).toContain("覆盖 1");
    expect(d.summary).toContain("跨公司降级 copy-as-new 1");
  });

  it("目标公司内正常覆盖(无降级)→ decisions.strategy 保持 overwrite", () => {
    const t = tpl({ agents: [agent({ id: "dev-a", role: "dev", name: "新版" })] });
    const inTarget = agent({ id: "dev-a", companyId: "target", parentId: "ceo-x", name: "旧版" });
    const result = resolveMerge(t, company(), [inTarget], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.decisions.find(x => x.category === "agent_id")!;
    expect(d.strategy).toBe("overwrite");
    expect(d.summary).not.toContain("跨公司降级");
  });

  // #25:copy-as-new 的后缀 id 之前只避开现有员工,不避开模板自身其它 agent id——`${oldId}-copy` 与
  // 模板自带的另一个(无冲突、原样保留 id 的)agent 撞车时,newAgents 出现两个同 id 节点,
  // addAgents 按 id 去重会把后到的员工静默吞掉。
  it("#25:copy-as-new 的后缀 id 避开模板自身其它 agent id,不产生重复 id", () => {
    const t = tpl({
      agents: [
        agent({ id: "dev", role: "dev" }),        // 与现有员工冲突 → copy-as-new
        agent({ id: "dev-copy", role: "dev" }),   // 模板自带、无冲突 → 原样保留 id
      ],
    });
    const existing = [agent({ id: "dev", companyId: "target" })];
    const result = resolveMerge(t, company(), existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = result.agents.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length); // 无重复 id
    expect(ids).toContain("dev-copy");  // 模板自带的,原样保留
    expect(ids).toContain("dev-copy2"); // 冲突的 dev 避开模板自身的 dev-copy,取下一个后缀
  });

  // #8(配套):overwrittenAgents 必须是深拷贝——existingAgents 通常是 getAgents() 的活引用,路由层
  // 随后 updateAgent(Object.assign)会原地改写既有对象;浅存引用会让"覆盖前快照"在落盘时已经变成
  // 覆盖后的值,回滚形同空转。
  it("#8:overwrittenAgents 是深拷贝快照,事后对既有对象的原地改写(模拟 updateAgent 的 Object.assign)不污染快照", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev", name: "新版 dev" })] });
    const live = agent({ id: "dev-t", companyId: "target", name: "旧版 dev", model: "old-model", childrenIds: ["sub-x"] });
    const result = resolveMerge(t, company(), [live], { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const snapshotBefore = structuredClone(live);
    Object.assign(live, { name: "新版 dev", model: "new-model", claudeCodeUseApiKey: true }); // 模拟安装落地的原地合并
    live.childrenIds.push("polluted-child"); // 嵌套数组的原地污染
    expect(result.overwrittenAgents[0]).toEqual(snapshotBefore); // toEqual 整对象:快照与覆盖前完全一致、零污染
  });
});

describe("D3 · installMerge — 组织边(team_id/parentId)冲突", () => {
  it("检测:父子边与现有组织重复", () => {
    const existing = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target", childrenIds: ["dev-t"] }),
      agent({ id: "dev-t", role: "dev", companyId: "target", parentId: "ceo-x" }),
    ];
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev", parentId: "ceo-x" })] });
    const report = detectMergeConflicts(t, company({ ceoId: "ceo-x" }), existing);
    expect(report.orgEdge.some(c => c.kind === "duplicate" && c.parentId === "ceo-x" && c.childId === "dev-t")).toBe(true);
  });

  it("检测:按原始 id 直接合入会成环(would_cycle 预警)", () => {
    const existing = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target", childrenIds: ["dev-y"] }),
      agent({ id: "dev-y", role: "dev", companyId: "target", parentId: "ceo-x" }),
    ];
    // 模板里同 id 的 ceo-x,但把父指向 dev-y —— 与现有的 dev-y→ceo-x 边一起构成环。
    const t = tpl({ agents: [agent({ id: "ceo-x", role: "ceo", parentId: "dev-y" })] });
    const report = detectMergeConflicts(t, company({ ceoId: "ceo-x" }), existing);
    expect(report.orgEdge.some(c => c.kind === "would_cycle")).toBe(true);
  });

  it("默认 merge / keep-current / manual:V0 组织边模型下(每节点一个 parentId)重复边天然幂等,三者均可正常合并", () => {
    const existing = [agent({ id: "ceo-x", role: "ceo", companyId: "target" })];
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev" })] });
    const targetCompany = company({ ceoId: "ceo-x" });
    for (const orgEdge of ["merge", "keep-current", "manual"] as const) {
      const result = resolveMerge(t, targetCompany, existing, { orgEdge });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.decisions.find(d => d.category === "org_edge")?.strategy).toBe(orgEdge);
    }
  });

  it("合并后组织成环 → 拒绝(422),不产出任何 agents", () => {
    const t = tpl({
      agents: [
        agent({ id: "a", role: "lead", parentId: "b" }),
        agent({ id: "b", role: "dev", parentId: "a" }),
      ],
    });
    const result = resolveMerge(t, company(), []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(422);
  });
});

describe("D3 · installMerge — memory scope 冲突(结构预留:V0 无真实数据源,纯函数直测)", () => {
  const existing: SeedMemoryRecord[] = [{ scope: "company", sourceId: "m1", content: "标准做法A" }];

  it("检测:incoming 与 existing 同 scope 同内容 → 冲突", () => {
    const incoming: SeedMemoryRecord[] = [
      { scope: "company", sourceId: "m2", content: "标准做法A" },
      { scope: "company", sourceId: "m3", content: "新内容" },
    ];
    const conflicts = detectMemoryScopeConflicts(incoming, existing);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sourceId).toBe("m2");
  });

  it("默认 skip-duplicate:跳过重复,只保留新内容", () => {
    const incoming: SeedMemoryRecord[] = [
      { scope: "company", sourceId: "m2", content: "标准做法A" },
      { scope: "company", sourceId: "m3", content: "新内容" },
    ];
    const resolved = resolveMemoryScopeConflicts(incoming, existing);
    expect(resolved.map(m => m.sourceId)).toEqual(["m3"]);
  });

  it("coexist:重复项并存,标注来源", () => {
    const incoming: SeedMemoryRecord[] = [{ scope: "company", sourceId: "m2", content: "标准做法A" }];
    const resolved = resolveMemoryScopeConflicts(incoming, existing, "coexist");
    expect(resolved).toEqual([{ scope: "company", sourceId: "m2(imported)", content: "标准做法A" }]);
  });

  it("overwrite:高风险——全部按 incoming 覆盖", () => {
    const incoming: SeedMemoryRecord[] = [{ scope: "company", sourceId: "m2", content: "标准做法A" }];
    const resolved = resolveMemoryScopeConflicts(incoming, existing, "overwrite");
    expect(resolved).toEqual(incoming);
  });

  it("resolveMerge 生产路径:CompanyTemplate 尚无记忆导出字段,恒传空数组,conflicts.memoryScope 恒为 []", () => {
    const result = resolveMerge(tpl(), company(), []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.conflicts.memoryScope).toEqual([]);
  });
});

describe("D3 · installMerge — A2A rule 冲突", () => {
  // overwrite 是唯一能让"模板内 id"最终解析成"目标公司已存在 id"的路径(copy-as-new/keep-current/manual
  // 都不会产出与既有 id 相同的最终 id),因此用 overwrite 场景构造 from/to 对完全重合的真实碰撞。
  function overwriteSetup() {
    const existing = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", role: "dev", companyId: "target", parentId: "ceo-x" }),
    ];
    const targetCompany = company({ ceoId: "ceo-x", presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "日常同步" }] });
    const t = tpl({
      agents: [
        agent({ id: "ceo-x", role: "ceo" }),
        agent({ id: "dev-x", role: "dev", parentId: "ceo-x" }),
      ],
      a2aChannels: [{ from: "ceo-x", to: "dev-x", purpose: "新目的" }],
    });
    return { existing, targetCompany, t };
  }

  it("检测:同 from/to 对已有规则", () => {
    const { existing, targetCompany, t } = overwriteSetup();
    const report = detectMergeConflicts(t, targetCompany, existing);
    expect(report.a2aRule).toEqual([{ type: "a2a_rule", from: "ceo-x", to: "dev-x", existingPurpose: "日常同步", incomingPurpose: "新目的" }]);
  });

  // 发现③(对抗验收缺口):模板作者也可以用 role 名(而非模板内 agentId)引用 a2aChannels.from/to——
  // 之前直接原始字符串比对,role 名引用永远比不出冲突,漏检。
  it("检测:模板用角色名(而非 agentId)引用 a2a,也能正确解析后比对出冲突", () => {
    const existing = [
      agent({ id: "ceo-x", role: "ceo", companyId: "target" }),
      agent({ id: "dev-x", role: "dev", companyId: "target", parentId: "ceo-x" }),
    ];
    const targetCompany = company({ ceoId: "ceo-x", presetChannels: [{ from: "ceo-x", to: "dev-x", purpose: "日常同步" }] });
    const t = tpl({
      agents: [
        agent({ id: "ceo-x", role: "ceo" }),
        agent({ id: "dev-x", role: "dev", parentId: "ceo-x" }),
      ],
      a2aChannels: [{ from: "ceo", to: "dev", purpose: "新目的" }], // 用角色名引用,不是 agentId
    });
    const report = detectMergeConflicts(t, targetCompany, existing);
    expect(report.a2aRule).toEqual([{ type: "a2a_rule", from: "ceo-x", to: "dev-x", existingPurpose: "日常同步", incomingPurpose: "新目的" }]);
  });

  it("默认 union:两边 purpose 都保留(拼接),不丢信息;modifiedChannels 记下改写前的边(回滚快照用)", () => {
    const { existing, targetCompany, t } = overwriteSetup();
    const result = resolveMerge(t, targetCompany, existing, { agentId: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "日常同步; 新目的" }]);
    expect(result.modifiedChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "日常同步" }]); // 改写前的原值
  });

  it("keep-current:保留现有版本,丢弃 incoming;没有真的改写,modifiedChannels 为空", () => {
    const { existing, targetCompany, t } = overwriteSetup();
    const result = resolveMerge(t, targetCompany, existing, { agentId: "overwrite", a2aRule: "keep-current" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "日常同步" }]);
    expect(result.modifiedChannels).toEqual([]);
  });

  it("overwrite:用 incoming 覆盖现有版本;modifiedChannels 记下改写前的边", () => {
    const { existing, targetCompany, t } = overwriteSetup();
    const result = resolveMerge(t, targetCompany, existing, { agentId: "overwrite", a2aRule: "overwrite" }, { confirmOverwrite: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presetChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "新目的" }]);
    expect(result.modifiedChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "日常同步" }]);
  });

  it("新增通道(existing 里原本没有这条边)不算改写,modifiedChannels 不含它", () => {
    const existing = [agent({ id: "ceo-x", role: "ceo", companyId: "target" })];
    const targetCompany = company({ ceoId: "ceo-x", presetChannels: [] }); // 无既有通道
    const t = tpl({ a2aChannels: [{ from: "ceo-t", to: "dev-t", purpose: "新通道" }] }); // tpl() 缺省 agents 就是 ceo-t/dev-t
    const result = resolveMerge(t, targetCompany, existing);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.presetChannels).toEqual([{ from: "ceo-t", to: "dev-t", purpose: "新通道" }]);
    expect(result.modifiedChannels).toEqual([]);
  });
});

describe("D3 · installMerge — capability requirement 冲突", () => {
  it("检测:同名能力但 optional 声明不一致", () => {
    const targetCompany = company({ manifestMcpRequirements: [{ name: "filesystem", optional: true }] });
    const t = tpl({ mcpRequirements: [{ name: "filesystem", optional: false }] });
    const report = detectMergeConflicts(t, targetCompany, []);
    expect(report.capability).toEqual([{ type: "capability", name: "filesystem", existingOptional: true, incomingOptional: false }]);
  });

  it("默认 strictest:取并集且较严格者(必需)胜出", () => {
    const targetCompany = company({ manifestMcpRequirements: [{ name: "filesystem", optional: true }] });
    const t = tpl({ mcpRequirements: [{ name: "filesystem", optional: false }, { name: "web-search", optional: true }] });
    const result = resolveMerge(t, targetCompany, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mcpRequirements.find(m => m.name === "filesystem")?.optional).toBe(false);
    expect(result.mcpRequirements.map(m => m.name).sort()).toEqual(["filesystem", "web-search"]);
  });

  it("manual:不自动合并,保留目标现状", () => {
    const targetCompany = company({ manifestMcpRequirements: [{ name: "filesystem", optional: true }] });
    const t = tpl({ mcpRequirements: [{ name: "filesystem", optional: false }] });
    const result = resolveMerge(t, targetCompany, [], { capability: "manual" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mcpRequirements).toEqual([{ name: "filesystem", optional: true }]);
  });
});

describe("D3 · installMerge — sanitizeMergeStrategies / buildInstallPreviewSummary", () => {
  it("非法/缺省字段一律回退默认值,不让坏输入改变安装行为", () => {
    expect(sanitizeMergeStrategies({ agentId: "yolo", orgEdge: "keep-current" })).toEqual({
      agentId: "copy-as-new", orgEdge: "keep-current", memoryScope: "skip-duplicate", a2aRule: "union", capability: "strictest",
    });
    expect(sanitizeMergeStrategies(undefined)).toEqual({
      agentId: "copy-as-new", orgEdge: "merge", memoryScope: "skip-duplicate", a2aRule: "union", capability: "strictest",
    });
    expect(sanitizeMergeStrategies(null)).toEqual(sanitizeMergeStrategies(undefined));
  });

  it("安装预览摘要:员工/组织边/A2A 通道数真实统计;旧模板(无 seedMemories/defaultTasks)计数如实为 0", () => {
    const t = tpl({ a2aChannels: [{ from: "ceo-t", to: "dev-t" }], mcpRequirements: [{ name: "filesystem" }] });
    const summary = buildInstallPreviewSummary(t);
    expect(summary).toEqual({
      newAgents: 2, newOrgEdges: 1, newA2AChannels: 1,
      newCompanyExperiences: 0, newTeamExperiences: 0, newAgentExperiences: 0,
      newDefaultTasks: 0, newArtifactContracts: 0, requiredCapabilities: ["filesystem"],
    });
  });

  it("C3 · 经验计数按 seedMemories.owner_type 真数(project 归入 company 口径),defaultTasks 真数;artifact contract 无数据源恒 0", () => {
    const mem = (owner_type: BundleMemoryRecord["owner_type"], id: string): BundleMemoryRecord => ({
      memory_id: id, scope: "", owner_type, owner_id: "", content: "经验内容",
      source: { type: "run", run_id: "", task_id: "" },
      level: "sop", score: 0, status: "active", tags: [],
      metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
      created_at: "", updated_at: "", last_used_at: "",
    });
    const t = tpl({
      seedMemories: [mem("company", "m1"), mem("company", "m2"), mem("project", "m3"), mem("team", "m4"), mem("agent", "m5")],
      defaultTasks: [
        { title: "示例任务一", goal: "写一份调研报告" },
        { title: "示例任务二", goal: "做一次竞品分析", suggestedRole: "lead" },
      ],
    });
    const summary = buildInstallPreviewSummary(t);
    expect(summary.newCompanyExperiences).toBe(3); // company×2 + project×1(归入 company 口径)
    expect(summary.newTeamExperiences).toBe(1);
    expect(summary.newAgentExperiences).toBe(1);
    expect(summary.newDefaultTasks).toBe(2);
    expect(summary.newArtifactContracts).toBe(0);
  });
});

// ══ 收口② · 公司级字段保守合并合同(两条 merge 路径共用的同一组 helper)══
describe("收口② · mergeCompanyLevelFields — 公司级四字段保守合并", () => {
  const TOOL_REQ_EMPTY = { requiredEngines: [], requiredProviders: [], requiredMcpServers: [], requiredSkills: [], optionalTools: [] };

  it("defaultTasks:按规范化 goal 去重 union——目标已有项优先且排前,来源只补新项(含 trim 归一)", () => {
    const target = company({ defaultTasks: [{ title: "已有", goal: "做 A" }] });
    const t = tpl({ defaultTasks: [
      { title: "来源重复", goal: " 做 A " }, // trim 后与目标重复 → 保留目标版本
      { title: "来源新增", goal: "做 B" },
    ] });
    const out = mergeCompanyLevelFields(target, t);
    expect(out.patch.defaultTasks).toEqual([
      { title: "已有", goal: "做 A" },
      { title: "来源新增", goal: "做 B" },
    ]);
    expect(out.report.added.some(i => i.field === "defaultTasks")).toBe(true);
    expect(out.report.preserved.some(i => i.field === "defaultTasks")).toBe(true); // 重复项如实报告,不静默消失
  });

  it("defaultTasks:来源全部与目标重复 → 不产生 patch(目标原值不动)", () => {
    const target = company({ defaultTasks: [{ title: "已有", goal: "做 A" }] });
    const t = tpl({ defaultTasks: [{ title: "重复", goal: "做 A" }] });
    const out = mergeCompanyLevelFields(target, t);
    expect(out.patch.defaultTasks).toBeUndefined();
  });

  it("manifestToolRequirements:五数组稳定 union(目标顺序在前);新增必需项进 requires_local_setup,optionalTools 不进", () => {
    const target = company({ manifestToolRequirements: { ...TOOL_REQ_EMPTY, requiredEngines: ["claude-code"], requiredMcpServers: ["filesystem"] } });
    const t = tpl({ toolRequirements: {
      requiredEngines: ["codex", "claude-code"], requiredProviders: [],
      requiredMcpServers: ["web-search"], requiredSkills: [], optionalTools: ["browser"],
    } });
    const out = mergeCompanyLevelFields(target, t);
    expect(out.patch.manifestToolRequirements).toEqual({
      requiredEngines: ["claude-code", "codex"], // 目标在前,来源只追加新项
      requiredProviders: [],
      requiredMcpServers: ["filesystem", "web-search"],
      requiredSkills: [],
      optionalTools: ["browser"],
    });
    const setupFields = out.report.requires_local_setup.map(i => i.field);
    expect(setupFields).toContain("manifestToolRequirements.requiredEngines");
    expect(setupFields).toContain("manifestToolRequirements.requiredMcpServers");
    expect(setupFields).not.toContain("manifestToolRequirements.optionalTools");
    // 只声明不启用的红线写进报告文案,对抗验证可逐条查
    expect(out.report.added.find(i => i.field === "manifestToolRequirements")?.detail).toContain("不自动启用");
  });

  it("manifestToolRequirements:来源与目标完全重合 → 不产生 patch,preserved 如实报告", () => {
    const target = company({ manifestToolRequirements: { ...TOOL_REQ_EMPTY, requiredEngines: ["claude-code"] } });
    const t = tpl({ toolRequirements: { ...TOOL_REQ_EMPTY, requiredEngines: ["claude-code"] } });
    const out = mergeCompanyLevelFields(target, t);
    expect(out.patch.manifestToolRequirements).toBeUndefined();
    expect(out.report.preserved.some(i => i.field === "manifestToolRequirements")).toBe(true);
  });

  it("visibilityPolicy:目标已有 → 永远保留目标(不因导入放宽隔离),preserved 报告;目标未设置 → 采用来源", () => {
    const kept = mergeCompanyLevelFields(company({ visibilityPolicy: "isolated" }), tpl({ visibilityPolicy: "default" }));
    expect(kept.patch.visibilityPolicy).toBeUndefined();
    expect(kept.report.preserved.some(i => i.field === "visibilityPolicy")).toBe(true);

    const adopted = mergeCompanyLevelFields(company(), tpl({ visibilityPolicy: "isolated" }));
    expect(adopted.patch.visibilityPolicy).toBe("isolated");
    expect(adopted.report.added.some(i => i.field === "visibilityPolicy")).toBe(true);
  });

  it("workflow:目标已有且来源也带 → 保留目标 + requires_review(不静默合并/覆盖/丢弃);目标无 → 采纳来源", () => {
    const targetWf = { verificationEdges: [{ producer: "dev", verifier: "ceo", method: "llm-review" as const, onReject: "flag" as const }] };
    const sourceWf = { verificationEdges: [{ producer: "researcher", verifier: "lead", method: "fact-check" as const, onReject: "redo" as const }] };
    const review = mergeCompanyLevelFields(company({ workflow: targetWf }), tpl({ workflow: sourceWf }));
    expect(review.patch.workflow).toBeUndefined();
    expect(review.report.requires_review.some(i => i.field === "workflow")).toBe(true);

    const adopted = mergeCompanyLevelFields(company(), tpl({ workflow: sourceWf }));
    expect(adopted.patch.workflow).toEqual(sourceWf);
    expect(adopted.report.added.some(i => i.field === "workflow")).toBe(true);
  });

  it("preMergeCompanyFields:恒为合并前四字段整值快照(目标本无的字段快照为 undefined,回滚据此恢复为「无」)", () => {
    const targetWf = { verificationEdges: [] };
    const target = company({ visibilityPolicy: "isolated", workflow: targetWf });
    const out = mergeCompanyLevelFields(target, tpl({ visibilityPolicy: "default", defaultTasks: [{ title: "t", goal: "g" }] }));
    expect(out.preMergeCompanyFields).toEqual({
      visibilityPolicy: "isolated", defaultTasks: undefined, manifestToolRequirements: undefined, workflow: targetWf,
    });
  });
});

describe("收口② · planMergeAgentMemories — 只导新建员工,覆盖/跳过进 requires_review", () => {
  const memories = [
    { agent_id: "ceo-t", role: "ceo", content: "CEO 记忆" },
    { agent_id: "dev-t", role: "dev", content: "dev 记忆" },
    { agent_id: "ghost", content: "映射不上的记忆" },
  ];

  it("新建员工(idMap 有映射且非 overwrite)→ 进 importIdMap;overwrite 覆盖/映射不上 → requires_review,不导入", () => {
    const plan = planMergeAgentMemories(memories, {
      idMap: { "ceo-t": "ceo-t-copy", "dev-t": "dev-t" },
      overwriteAgentIds: ["dev-t"], skippedAgentIds: [],
    });
    expect(plan.importIdMap).toEqual({ "ceo-t": "ceo-t-copy" }); // 只有真正新建的
    expect(plan.reviewItems).toHaveLength(2);
    expect(plan.reviewItems[0].detail).toContain("dev-t");
    expect(plan.reviewItems[0].detail).toContain("保留目标员工记忆");
    expect(plan.reviewItems[1].detail).toContain("ghost");
  });

  it("keep-current/manual 跳过的员工 → 记忆不导入,requires_review 注明原因", () => {
    const plan = planMergeAgentMemories([{ agent_id: "dev-t", content: "x" }], {
      idMap: {}, overwriteAgentIds: [], skippedAgentIds: ["dev-t"],
    });
    expect(plan.importIdMap).toEqual({});
    expect(plan.reviewItems[0].detail).toContain("keep-current/manual");
  });

  it("resolveMerge 暴露 idMap/skippedAgentIds(agentMemories 过滤的数据源):copy-as-new 后缀映射、keep-current 进 skipped", () => {
    const t = tpl({ agents: [agent({ id: "dev-t", role: "dev" })] });
    const existing = [agent({ id: "dev-t", companyId: "target" })];
    const copied = resolveMerge(t, company(), existing);
    expect(copied.ok).toBe(true);
    if (copied.ok) {
      expect(copied.idMap).toEqual({ "dev-t": "dev-t-copy" });
      expect(copied.skippedAgentIds).toEqual([]);
    }
    const kept = resolveMerge(t, company(), existing, { agentId: "keep-current" });
    expect(kept.ok).toBe(true);
    if (kept.ok) {
      expect(kept.idMap).toEqual({});
      expect(kept.skippedAgentIds).toEqual(["dev-t"]);
    }
  });
});

describe("收口② · finalizeMergeReport — 四类清单装配", () => {
  it("agentMemories 导入数进 added;memory review 进 requires_review;missingMcp 进 requires_local_setup", () => {
    const base = { preserved: [], added: [{ field: "defaultTasks", detail: "d" }], requires_review: [], requires_local_setup: [] };
    const report = finalizeMergeReport(base, {
      memoryReviewItems: [{ field: "agentMemories", detail: "覆盖既有员工" }],
      missingMcp: [{ name: "web-search", purpose: "查资料", optional: true }],
      agentMemoriesImported: 2,
    });
    expect(report.added.map(i => i.field)).toEqual(["defaultTasks", "agentMemories"]);
    expect(report.requires_review).toEqual([{ field: "agentMemories", detail: "覆盖既有员工" }]);
    expect(report.requires_local_setup[0].field).toBe("mcpServers");
    expect(report.requires_local_setup[0].detail).toContain("web-search");
  });

  it("零导入/零缺失时不虚增条目", () => {
    const base = { preserved: [], added: [], requires_review: [], requires_local_setup: [] };
    const report = finalizeMergeReport(base, { memoryReviewItems: [], missingMcp: [], agentMemoriesImported: 0 });
    expect(report).toEqual(base);
  });
});

describe("P1#5 · resolveMerge 语义团队重复必须显式选择,否则 409 不执行", () => {
  const tplDup = () => tpl({ agents: [agent({ id: "new-alice", role: "dev", name: "Alice" })] });
  const existingDup = () => [agent({ id: "old-alice", companyId: "target", role: "dev", name: "Alice" })];

  it("检出 teamDuplication 但未选处置 → ok:false status 409(不执行)", () => {
    const r = resolveMerge(tplDup(), company(), existingDup(), {}, {});
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.status).toBe(409); expect(r.conflicts?.teamDuplication.length).toBe(1); }
  });
  it("add-department → copy-as-new 新 id 并存(两套 Alice)", () => {
    const r = resolveMerge(tplDup(), company(), existingDup(), {}, { teamDuplicationResolution: "add-department" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.idMap["new-alice"]).not.toBe("old-alice"); expect(r.idMap["new-alice"]).toMatch(/new-alice/); }
  });
  it("map → incoming 跳过不新增,但 idMap 映射到现有(P1 用户审计:不映射会丢引用)", () => {
    const r = resolveMerge(tplDup(), company(), existingDup(), {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.skippedAgentIds).toContain("new-alice");
      expect(r.agents.some((a) => a.id === "new-alice")).toBe(false);
      expect(r.idMap["new-alice"]).toBe("old-alice"); // ← 修复核心:incoming→现有映射,供父子/A2A 引用解析
    }
  });
  it("overwrite → incoming 落到现有 id + overwriteAgentIds 含现有 id", () => {
    const r = resolveMerge(tplDup(), company(), existingDup(), {}, { teamDuplicationResolution: "overwrite" });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.idMap["new-alice"]).toBe("old-alice"); expect(r.overwriteAgentIds).toContain("old-alice"); }
  });

  it("P1(用户审计)· map 保留组织与 A2A 语义:通道/父/子引用全映射到现有,不丢边(对抗验证抓出的三处)", () => {
    // 目标公司已有 Lead+Dev;模板:重复 Lead+Dev(map)、mapped Lead 下的新 Dev2、一个引用 mapped Dev 作为下属的新经理。
    const existing = [
      agent({ id: "old-lead", companyId: "target", role: "lead", name: "Lead", parentId: "ceo-x", childrenIds: ["old-dev"] }),
      agent({ id: "old-dev", companyId: "target", role: "dev", name: "Dev", parentId: "old-lead" }),
    ];
    const t = tpl({
      agents: [
        agent({ id: "new-lead", role: "lead", name: "Lead", childrenIds: ["new-dev", "new-dev2"] }), // 重复 → map
        agent({ id: "new-dev", role: "dev", name: "Dev", parentId: "new-lead" }),                     // 重复 → map
        agent({ id: "new-dev2", role: "dev", name: "Dev2", parentId: "new-lead" }),                    // 非重复 → 真安装,父是 mapped Lead
        agent({ id: "new-mgr", role: "lead", name: "NewMgr", childrenIds: ["new-dev"] }),              // 非重复 → 真安装,子是 mapped Dev
      ],
      a2aChannels: [{ from: "new-lead", to: "new-dev", purpose: "日常同步" }],
    });
    const r = resolveMerge(t, company(), existing, {}, { teamDuplicationResolution: "map" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // ① A2A 通道映射到现有 Lead↔现有 Dev(修复前:两端指向不存在的 incoming id → 被静默丢弃)
    expect(r.presetChannels).toContainEqual({ from: "old-lead", to: "old-dev", purpose: "日常同步" });
    // ② mapped Lead 下真安装的新 Dev2 的父 → 映射后的现有 Lead(而非错误重挂到 CEO)
    const dev2 = r.agents.find((a) => r.idMap["new-dev2"] === a.id);
    expect(dev2?.parentId).toBe("old-lead");
    // ③ 新经理引用 mapped Dev 作为子 → childrenIds 映射到现有 Dev(修复前:被 !skippedIds 过滤丢边)
    const mgr = r.agents.find((a) => r.idMap["new-mgr"] === a.id);
    expect(mgr?.childrenIds).toContain("old-dev");
    // ④ 重复的 Lead/Dev 本身不新增
    expect(r.agents.some((a) => a.id === "new-lead" || a.id === "new-dev")).toBe(false);
  });
});
