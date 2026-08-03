import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import {
  initOrchestrator, getAgents, addAgents, updateAgent, removeAgentsByIds, restoreAgentsInPlace,
} from "./orchestrator.js";
import { loadAgents } from "../storage/projectStore.js";

// 泳道O·P0(wave4-live-acceptance)· 用【真实 orchestrator】(非 mock)验证两条活体不变量:
//   任务4:addAgents 后 rebuildChildrenIdsInPlace 只在同公司内建父子边——跨公司 parentId 不塞外公司父的
//          childrenIds(merge id 全局碰撞把员工挂到外公司 agent 下的跨公司父子污染)。
//   任务5:回滚保序——restoreAgentsInPlace 原地整值恢复被覆盖/改挂员工,公司 agents 切片顺序与合并前逐一致,
//          导出物(loadAgents 过滤序)顺序一致;对照 removeAgentsByIds+addAgents 会把被恢复员工挪到尾部。

let root: string;
function mk(id: string, companyId: string, parentId?: string, over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id, name: id, role: "dev", parentId, childrenIds: [], model: "m", provider: "prov-x",
    framework: "api", companyId, status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    costUsd: 0, editable: true, deletable: true, enabled: true, ...over,
  };
}
const sliceIds = (companyId: string) => getAgents().filter((a) => a.companyId === companyId).map((a) => a.id);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "org-xco-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), "[]");
  fs.writeFileSync(path.join(root, ".opc", "companies.json"), "[]");
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ apiKeys: { "prov-x": "k" } }));
  initOrchestrator(root);
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("任务4 · addAgents 后 childrenIds 公司作用域(跨公司 parentId 不建边)", () => {
  it("B 公司员工 parentId 指向 A 公司 lead → A.lead 的 childrenIds 不含它", () => {
    addAgents([mk("lead-1", "co-a", undefined, { role: "lead" })]);
    // b-dev 的 parentId 指向 co-a 的 lead-1(模拟全局 id 碰撞导致的跨公司挂载)。
    addAgents([mk("b-dev", "co-b", "lead-1")]);
    const all = getAgents();
    const aLead = all.find((a) => a.id === "lead-1")!;
    expect(aLead.childrenIds).toEqual([]); // 跨公司子不塞进外公司父
    expect(all.some((a) => a.childrenIds?.includes("b-dev"))).toBe(false);
  });

  it("同公司父子边正常建立(不误伤同公司)", () => {
    addAgents([mk("ceo", "co-t", undefined, { role: "ceo" }), mk("dev", "co-t", "ceo")]);
    expect(getAgents().find((a) => a.id === "ceo")!.childrenIds).toEqual(["dev"]);
  });
});

describe("任务5 · 回滚保序:restoreAgentsInPlace 原地整值恢复不挪位", () => {
  it("被覆盖员工非末位时:原地恢复保序,导出序一致(对照 remove+append 会漂移)", () => {
    // 公司切片初始顺序 ceo, dev, qa(dev 非末位——这是暴露漂移的关键)。
    addAgents([
      mk("ceo", "co-t", undefined, { role: "ceo" }),
      mk("dev", "co-t", "ceo"),
      mk("qa", "co-t", "ceo"),
    ]);
    const before = sliceIds("co-t");
    expect(before).toEqual(["ceo", "dev", "qa"]);
    const devSnap = structuredClone(getAgents().find((a) => a.id === "dev")!);

    // 模拟 merge overwrite:原地改 dev 字段(位置不变)。
    updateAgent("dev", { model: "new-model", name: "新版 dev" });
    // 回滚:原地整值恢复。
    const restored = restoreAgentsInPlace([devSnap]);
    expect(restored).toBe(1);

    // 内存切片顺序与合并前逐一致。
    expect(sliceIds("co-t")).toEqual(before);
    // 整值恢复(name/model 回到快照)。
    const dev = getAgents().find((a) => a.id === "dev")!;
    expect(dev.model).toBe(devSnap.model);
    expect(dev.name).toBe(devSnap.name);
    // 导出物(磁盘 loadAgents 过滤序)顺序一致。
    expect(loadAgents(root, []).filter((a) => a.companyId === "co-t").map((a) => a.id)).toEqual(before);
  });

  it("对照:remove+append 把被恢复员工挪到尾部(证明 restore-in-place 的必要性)", () => {
    addAgents([
      mk("ceo", "co-t", undefined, { role: "ceo" }),
      mk("dev", "co-t", "ceo"),
      mk("qa", "co-t", "ceo"),
    ]);
    const devSnap = structuredClone(getAgents().find((a) => a.id === "dev")!);
    removeAgentsByIds(["dev"]);
    addAgents([devSnap]);
    // 漂移:dev 被挪到 qa 之后。
    expect(sliceIds("co-t")).toEqual(["ceo", "qa", "dev"]);
  });

  it("恢复未命中的 id → 追加(不抛),返回条数", () => {
    addAgents([mk("ceo", "co-t", undefined, { role: "ceo" })]);
    const n = restoreAgentsInPlace([mk("ghost", "co-t")]);
    expect(n).toBe(1);
    expect(getAgents().some((a) => a.id === "ghost")).toBe(true);
  });
});
