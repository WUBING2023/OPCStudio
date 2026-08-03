import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconcileRunningTasksOnStartup, reconcileRunningTaskGraphsOnStartup } from "./startupReconcile.js";
import { executeGraph } from "./taskGraphScheduler.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-")); });

function makeRun(runId: string, task: unknown) {
  const rd = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "task.json"), JSON.stringify(task));
  return path.join(rd, "task.json");
}

describe("P0#8 · reconcileRunningTasksOnStartup(启动对账)", () => {
  it("把 status===running 的 run 改写为 failed + degradedReason，其余 run 不受影响", () => {
    const runningPath = makeRun("run-running", { id: "run-running", status: "running", userGoal: "g" });
    const donePath = makeRun("run-done", { id: "run-done", status: "done", userGoal: "g2" });

    const r = reconcileRunningTasksOnStartup(root);
    expect(r.reconciled).toBe(1);

    const running = JSON.parse(fs.readFileSync(runningPath, "utf-8"));
    expect(running.status).toBe("failed");
    expect(running.degraded).toBe(true);
    expect(running.degradedReason).toBe("进程重启，run 被中断");
    expect(running.endedAt).toBeTruthy();

    const done = JSON.parse(fs.readFileSync(donePath, "utf-8"));
    expect(done.status).toBe("done"); // 未被改动
    expect(done.degradedReason).toBeUndefined();
  });

  it("启动时释放所有瞬态员工,并保留治理终态", () => {
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
      { id: "lead", companyId: "co", name: "Lead", role: "lead", status: "reviewing", currentTask: "旧任务", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, enabled: true },
      { id: "dev", companyId: "co", name: "Dev", role: "dev", status: "waiting_review", currentTask: "等待评审", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, enabled: true },
      { id: "other", companyId: "co", name: "Other", role: "dev", status: "working", currentTask: "另一个任务", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, enabled: true },
      { id: "failed", companyId: "co", name: "Failed", role: "test", status: "failed", currentTask: "保留失败态", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0, enabled: true },
    ]));
    makeRun("run-running", { id: "run-running", status: "running", participatingAgents: ["lead", "dev", "failed"] });

    expect(reconcileRunningTasksOnStartup(root).reconciled).toBe(1);
    const agents = JSON.parse(fs.readFileSync(path.join(root, ".opc", "agents.json"), "utf-8"));
    const byId = (id: string) => agents.find((agent: any) => agent.id === id);
    expect(byId("lead")).toMatchObject({ status: "idle", lastAction: "进程重启，所属任务已中断" });
    expect(byId("lead").currentTask).toBeUndefined();
    expect(byId("dev").status).toBe("idle");
    expect(byId("other")).toMatchObject({ status: "idle", lastAction: "进程重启，运行状态已复位" });
    expect(byId("other").currentTask).toBeUndefined();
    expect(byId("failed")).toMatchObject({ status: "failed", currentTask: "保留失败态" });
  });

  it("单个 task.json 损坏不影响其余 run 的对账，也不影响启动（不抛异常）", () => {
    const brokenDir = path.join(root, ".opc", "runs", "run-broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    fs.writeFileSync(path.join(brokenDir, "task.json"), "{not valid json");
    const runningPath = makeRun("run-running", { id: "run-running", status: "running", userGoal: "g" });

    let r: { reconciled: number } = { reconciled: -1 };
    expect(() => { r = reconcileRunningTasksOnStartup(root); }).not.toThrow();
    expect(r.reconciled).toBe(1);
    const running = JSON.parse(fs.readFileSync(runningPath, "utf-8"));
    expect(running.status).toBe("failed");
  });

  it("runs 目录不存在 → 安全返回 0，不抛异常", () => {
    const r = reconcileRunningTasksOnStartup(path.join(root, "nonexistent"));
    expect(r).toEqual({ reconciled: 0 });
  });
});

describe("任务图启动对账 reconcileRunningTaskGraphsOnStartup(僵尸 running 图收敛)", () => {
  function writeGraphs(graphs: unknown[]) {
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "task-graphs.json"), JSON.stringify(graphs));
  }
  function node(id: string, status: string) {
    return {
      id, title: id, goal: "g", assignedAgentId: "a-1", dependsOn: [], expectedArtifacts: ["x.md"],
      status, statusHistory: [{ status, at: "2026-07-08T00:00:00Z", by: "core" }],
    };
  }
  function graph(id: string, status: string, nodes: unknown[]) {
    return {
      id, missionId: `m-${id}`, companyId: "co1", goal: "总目标", nodes, status,
      createdAt: "2026-07-08T00:00:00Z", updatedAt: "2026-07-08T00:00:00Z", schemaVersion: "1",
    };
  }
  const readGraphs = () => JSON.parse(fs.readFileSync(path.join(root, ".opc", "task-graphs.json"), "utf-8"));

  it("按 receipts 恢复:完成复用、无副作用重排、未开始保持可恢复", () => {
    writeGraphs([
      graph("tg-recoverable", "running", [
        {
          ...node("n1", "running"),
          completionReceipt: {
            receiptId: "done-1", at: "2026-07-08T00:01:00Z", attempt: 1,
            inputHash: "h1", idempotencyKey: "k1", status: "completed",
            artifactRefs: ["a.md"], evidenceRefs: ["e.json"],
          },
          leaseOwner: "dead", leaseExpiry: "2099-01-01T00:00:00Z",
        },
        {
          ...node("n2", "running"),
          startedReceipt: {
            receiptId: "start-2", at: "2026-07-08T00:01:00Z", attempt: 1, visit: 1,
            inputHash: "h2", idempotencyKey: "k2", leaseOwner: "dead", sideEffectRisk: false,
          },
          runId: "stale-run", resultSummary: "stale", artifactRefs: ["stale.md"],
        },
        node("n3", "pending"),
        node("n4", "planned"),
      ]),
      graph("tg-done", "completed", [node("n1", "completed")]),
    ]);
    const r = reconcileRunningTaskGraphsOnStartup(root);
    expect(r.reconciled).toBe(1);

    const [recoverable, doneG] = readGraphs();
    expect(recoverable.status).toBe("committed");
    const byId = (id: string) => recoverable.nodes.find((n: any) => n.id === id);
    expect(byId("n1").status).toBe("completed");
    expect(byId("n1").leaseOwner).toBeUndefined();
    expect(byId("n2").status).toBe("pending");
    expect(byId("n2").runId).toBeUndefined();
    expect(byId("n2").resultSummary).toBeUndefined();
    expect(byId("n2").artifactRefs).toEqual([]);
    expect(byId("n2").startedReceipt).toBeUndefined();
    expect(byId("n3").status).toBe("pending");
    expect(byId("n4").status).toBe("planned");

    expect(doneG.status).toBe("completed");
    expect(doneG.nodes[0].status).toBe("completed");
  });

  it("started 无 completed 且有副作用风险 → uncertain,旧 schema running 也 fail-closed", () => {
    writeGraphs([
      graph("tg-uncertain", "running", [
        {
          ...node("n1", "running"),
          startedReceipt: {
            receiptId: "start-1", at: "2026-07-08T00:01:00Z", attempt: 1, visit: 1,
            inputHash: "h1", idempotencyKey: "k1", leaseOwner: "dead", sideEffectRisk: true,
          },
        },
        node("legacy-running", "running"),
        node("never-started", "planned"),
      ]),
    ]);
    expect(reconcileRunningTaskGraphsOnStartup(root).reconciled).toBe(1);
    const recovered = readGraphs()[0];
    expect(recovered.status).toBe("failed");
    for (const id of ["n1", "legacy-running"]) {
      const n = recovered.nodes.find((item: any) => item.id === id);
      expect(n.status).toBe("blocked");
      expect(n.uncertain).toBe(true);
      expect(n.error).toContain("状态不确定");
      expect(n.leaseOwner).toBeUndefined();
    }
    expect(recovered.nodes.find((n: any) => n.id === "never-started").status).toBe("planned");
  });

  it("release gate: 产物副作用已发生但 completion receipt 未落盘,重启后 uncertain 且不可重复派发", async () => {
    const artifactPath = path.join(root, "workspace", "already-created.txt");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, "side effect from interrupted attempt", "utf-8");
    writeGraphs([
      graph("tg-side-effect", "running", [{
        ...node("producer", "running"),
        runId: "run-interrupted",
        attempt: 1,
        visit: 1,
        inputHash: "input-hash",
        idempotencyKey: "tg-side-effect:producer:1:input-hash",
        artifactRefs: ["file:workspace/already-created.txt"],
        startedReceipt: {
          receiptId: "started-before-crash",
          at: "2026-07-08T00:01:00Z",
          attempt: 1,
          visit: 1,
          inputHash: "input-hash",
          idempotencyKey: "tg-side-effect:producer:1:input-hash",
          leaseOwner: "dead-core",
          sideEffectRisk: true,
          runId: "run-interrupted",
        },
        leaseOwner: "dead-core",
        leaseExpiry: "2099-01-01T00:00:00Z",
      }]),
    ]);

    expect(reconcileRunningTaskGraphsOnStartup(root).reconciled).toBe(1);
    const recovered = readGraphs()[0];
    const recoveredNode = recovered.nodes[0];
    expect(recoveredNode).toMatchObject({ status: "blocked", uncertain: true, runId: "run-interrupted" });
    expect(recoveredNode.completionReceipt).toBeUndefined();
    expect(fs.readFileSync(artifactPath, "utf-8")).toBe("side effect from interrupted attempt");

    const dispatch = vi.fn(async () => {
      throw new Error("release gate violation: uncertain node was dispatched again");
    });
    const resumed = await executeGraph(root, recovered, { dispatch });
    expect(dispatch).not.toHaveBeenCalled();
    expect(resumed.status).toBe("failed");
    expect(resumed.nodes[0]).toMatchObject({ status: "blocked", uncertain: true, attempt: 1, visit: 1 });
    expect(fs.readFileSync(artifactPath, "utf-8")).toBe("side effect from interrupted attempt");
  });

  it("task-graphs.json 不存在 → 安全返回 0,不抛异常", () => {
    const r = reconcileRunningTaskGraphsOnStartup(path.join(root, "nonexistent"));
    expect(r).toEqual({ reconciled: 0 });
  });
});
