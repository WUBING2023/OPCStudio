import { describe, it, expect } from "vitest";
import { rebuildChildrenIds } from "./installMerge.js";

// C12/childrenIds 活公司同步的不变量测试。orchestrator.addAgents/updateAgent 在插入/换父后以
// **parentId 为唯一真源**就地重建 childrenIds(rebuildChildrenIdsInPlace,与此处 rebuildChildrenIds 同语义:
// 前者原地改对象保身份,后者返回新对象);二者据同一份纯逻辑。此文件锁死该纯逻辑的三条不变量:
//   ① 子先于父(数组顺序无关)也能挂上;② 换父后旧父移除、新父加入;③ 无双重/悬空关系。

type Node = { id: string; parentId?: string; childrenIds?: string[]; companyId?: string };
const byId = (list: Node[], id: string) => list.find((a) => a.id === id)!;

describe("childrenIds 重建 · 以 parentId 为唯一真源", () => {
  it("① 子先于父批量插入(childrenIds 全空/漏挂)→ 重建后父侧正确挂上,顺序无关", () => {
    // 故意把子排在父之前,且所有 childrenIds 都留空(模拟 addAgents 漏挂)。
    const input: Node[] = [
      { id: "w1", parentId: "lead", childrenIds: [] },
      { id: "w2", parentId: "lead", childrenIds: [] },
      { id: "lead", parentId: "ceo", childrenIds: [] },
      { id: "ceo", childrenIds: [] },
    ];
    const out = rebuildChildrenIds(input);
    expect(byId(out, "lead").childrenIds).toEqual(["w1", "w2"]);
    expect(byId(out, "ceo").childrenIds).toEqual(["lead"]);
    expect(byId(out, "w1").childrenIds).toEqual([]);
  });

  it("② 换父:把 w1 的 parentId 从 leadA 改到 leadB → 旧父移除、新父加入,无双重关系", () => {
    const input: Node[] = [
      { id: "ceo", childrenIds: ["leadA", "leadB"] },
      { id: "leadA", parentId: "ceo", childrenIds: ["w1"] },
      { id: "leadB", parentId: "ceo", childrenIds: [] },
      { id: "w1", parentId: "leadB", childrenIds: [] }, // 已改指向 leadB,但旧父 leadA.childrenIds 仍残留 w1
    ];
    const out = rebuildChildrenIds(input);
    expect(byId(out, "leadA").childrenIds).toEqual([]);        // 旧父摘除
    expect(byId(out, "leadB").childrenIds).toEqual(["w1"]);    // 新父加入
    // 无双重:w1 只出现在一个父的 childrenIds 里
    const parentsOfW1 = out.filter((a) => a.childrenIds?.includes("w1")).map((a) => a.id);
    expect(parentsOfW1).toEqual(["leadB"]);
  });

  it("③ 悬空 parentId(指向不存在的 id)不挂到任何父下;stale childrenIds 被清理", () => {
    const input: Node[] = [
      { id: "ceo", childrenIds: ["ghost", "lead"] }, // ghost 不存在 → 应被清理
      { id: "lead", parentId: "ceo", childrenIds: [] },
      { id: "orphan", parentId: "no-such-parent", childrenIds: [] }, // 父不存在 → 不挂
    ];
    const out = rebuildChildrenIds(input);
    expect(byId(out, "ceo").childrenIds).toEqual(["lead"]); // ghost 清除,只留真实子
    // orphan 不出现在任何 childrenIds 里
    expect(out.some((a) => a.childrenIds?.includes("orphan"))).toBe(false);
  });

  // 泳道O·P0(wave4-live-acceptance)· 跨公司父子边:parentId 指向【外公司】agent → 视为悬空,不建边、
  // 不塞外公司父的 childrenIds,并清除既有跨公司残边(merge id 全局碰撞把员工挂到外公司 agent 下的污染)。
  it("④ 跨公司 parentId 不建边;外公司父的既有跨公司残边被清除;同公司边正常", () => {
    const input: Node[] = [
      { id: "A-lead", companyId: "co-a", childrenIds: ["B-dev"] }, // 残留的跨公司子(污染),应被清除
      { id: "B-dev", companyId: "co-b", parentId: "A-lead", childrenIds: [] }, // parentId 指向外公司父
      { id: "B-lead", companyId: "co-b", childrenIds: [] },
      { id: "B-w", companyId: "co-b", parentId: "B-lead", childrenIds: [] }, // 同公司边
    ];
    const out = rebuildChildrenIds(input);
    expect(byId(out, "A-lead").childrenIds).toEqual([]);      // 跨公司残边清除,不塞 B-dev
    expect(out.some((a) => a.childrenIds?.includes("B-dev"))).toBe(false); // B-dev 不进任何外公司父
    expect(byId(out, "B-lead").childrenIds).toEqual(["B-w"]); // 同公司父子边正常建立
  });

  it("⑤ 归一化:空/undefined companyId 视为同一 default 公司,边正常建立(既有无 companyId 用例不破)", () => {
    const input: Node[] = [
      { id: "p", childrenIds: [] },                       // 无 companyId
      { id: "c", parentId: "p", companyId: "", childrenIds: [] }, // 空字符串 companyId
    ];
    const out = rebuildChildrenIds(input);
    expect(byId(out, "p").childrenIds).toEqual(["c"]); // undefined 与 "" 都归一为 default → 同公司
  });
});
