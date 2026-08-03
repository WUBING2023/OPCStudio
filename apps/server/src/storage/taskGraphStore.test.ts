import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskGraph } from "@opc/shared";
import {
  claimTaskNodeLease,
  loadTaskGraphs,
  saveTaskGraphs,
  getTaskGraph,
  getTaskGraphByMission,
  TaskGraphRevisionConflictError,
  upsertTaskGraph,
} from "./taskGraphStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-store-"));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function makeGraph(over: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "tg-1",
    missionId: "m-1",
    companyId: "co1",
    goal: "总目标",
    nodes: [{
      id: "n1", title: "任务一", goal: "做点事", assignedAgentId: "w1",
      dependsOn: [], expectedArtifacts: ["out.md"],
      status: "planned",
      statusHistory: [{ status: "planned", at: "2026-07-07T00:00:00Z", by: "core" }],
    }],
    status: "committed",
    createdAt: "2026-07-07T00:00:00Z",
    updatedAt: "2026-07-07T00:00:00Z",
    schemaVersion: "1",
    ...over,
  };
}

describe("taskGraphStore round-trip", () => {
  it("upsert → load/get 取回同一份;文件真实落在 .opc/task-graphs.json", () => {
    const g = upsertTaskGraph(root, makeGraph());
    expect(loadTaskGraphs(root)).toEqual([g]);
    expect(getTaskGraph(root, "tg-1")).toEqual(g);
    expect(getTaskGraphByMission(root, "m-1")).toEqual(g);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opc", "task-graphs.json"), "utf-8"));
    expect(onDisk).toEqual([g]);
  });

  it("同 id 再 upsert 是替换不是追加;新图插到头部(按 mission 查返回最新)", () => {
    upsertTaskGraph(root, makeGraph());
    upsertTaskGraph(root, makeGraph({ status: "running" }));
    expect(loadTaskGraphs(root).length).toBe(1);
    expect(getTaskGraph(root, "tg-1")!.status).toBe("running");

    upsertTaskGraph(root, makeGraph({ id: "tg-2", missionId: "m-1" }));
    const all = loadTaskGraphs(root);
    expect(all.length).toBe(2);
    expect(all[0].id).toBe("tg-2");
    expect(getTaskGraphByMission(root, "m-1")!.id).toBe("tg-2");
  });

  it("上限 100:第 101 份挤掉最老的", () => {
    for (let i = 0; i < 101; i++) upsertTaskGraph(root, makeGraph({ id: `tg-${i}`, missionId: `m-${i}` }));
    const all = loadTaskGraphs(root);
    expect(all.length).toBe(100);
    expect(all[0].id).toBe("tg-100");
    expect(all.some(g => g.id === "tg-0")).toBe(false);
  });

  it("文件不存在 → [];损坏 JSON → [] 回退不炸", () => {
    expect(loadTaskGraphs(root)).toEqual([]);
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "task-graphs.json"), "{corrupted");
    expect(loadTaskGraphs(root)).toEqual([]);
  });

  it("saveTaskGraphs 直接保存数组也遵守上限", () => {
    const graphs = Array.from({ length: 120 }, (_, i) => makeGraph({ id: `tg-${i}` }));
    saveTaskGraphs(root, graphs);
    expect(loadTaskGraphs(root).length).toBe(100);
  });

  it("兼容 v1:读取时升级 schema/revision/节点恢复字段", () => {
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ storageBackend: "json" }));
    fs.writeFileSync(path.join(root, ".opc", "task-graphs.json"), JSON.stringify([makeGraph()]));
    const graph = loadTaskGraphs(root)[0];
    expect(graph.schemaVersion).toBe("2");
    expect(graph.revision).toBe(0);
    expect(graph.nodes[0]).toMatchObject({
      schemaVersion: "2", attempt: 0, visit: 0, artifactRefs: [], evidenceRefs: [], uncertain: false,
    });
  });

  it("release gate: 两个不同 task graph 并发更新不丢失", async () => {
    upsertTaskGraph(root, makeGraph({ id: "tg-a", missionId: "m-a" }));
    upsertTaskGraph(root, makeGraph({ id: "tg-b", missionId: "m-b" }));
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const concurrentUpdate = async (id: string, goal: string) => {
      const staleSnapshot = getTaskGraph(root, id)!;
      await gate;
      staleSnapshot.goal = goal;
      return upsertTaskGraph(root, staleSnapshot);
    };
    const updateA = concurrentUpdate("tg-a", "A-new");
    const updateB = concurrentUpdate("tg-b", "B-new");
    release();
    await Promise.all([updateA, updateB]);

    expect(getTaskGraph(root, "tg-a")!.goal).toBe("A-new");
    expect(getTaskGraph(root, "tg-b")!.goal).toBe("B-new");
    expect(loadTaskGraphs(root).map(graph => graph.id).sort()).toEqual(["tg-a", "tg-b"]);
  });

  it("同一图的 stale revision 被 CAS 拒绝", () => {
    upsertTaskGraph(root, makeGraph());
    const first = getTaskGraph(root, "tg-1")!;
    const stale = getTaskGraph(root, "tg-1")!;
    first.goal = "winner";
    upsertTaskGraph(root, first);
    stale.goal = "must-not-win";
    expect(() => upsertTaskGraph(root, stale)).toThrow(TaskGraphRevisionConflictError);
    expect(getTaskGraph(root, "tg-1")!.goal).toBe("winner");
  });

  it("release gate: 同节点并发 claim 只有一个 owner 获得 lease", async () => {
    upsertTaskGraph(root, makeGraph());
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const claim = async (owner: string, inputHash: string) => {
      await gate;
      return claimTaskNodeLease(root, "tg-1", "n1", {
        owner, inputHash, now: "2026-07-07T00:00:00Z", leaseMs: 60_000,
      });
    };
    const contenders = [claim("worker-a", "hash-a"), claim("worker-b", "hash-b")];
    release();
    const results = await Promise.all(contenders);

    const winners = results.filter(result => result.claimed);
    const losers = results.filter(result => !result.claimed);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].node?.leaseOwner).toBe(winners[0].node?.leaseOwner);
    expect(losers[0].node?.startedReceipt?.idempotencyKey).toBe(winners[0].node?.idempotencyKey);
    expect(getTaskGraph(root, "tg-1")!.nodes[0].leaseOwner).toBe(winners[0].node?.leaseOwner);
  });
});
