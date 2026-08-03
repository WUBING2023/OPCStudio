import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, Run } from "@opc/shared";
import type { MissionBrief } from "../runtime/missionBrief.js";

// 令五.4 · Chat 英雄回路可观测性契约:让 Chat 发起的 run 也拥有可反查的真实 task graph。
// 只 mock 最底层的系统模型调用(与全仓 taskGraphScheduler.test.ts 同款"不打真模型"约定);
// generateRunTaskGraph → generateTaskGraphProposal → Core 校验 → 落盘 → 反查,全链走真实代码,不 mock 冒充。
const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));
vi.mock("../runtime/systemModelInvoke.js", () => ({
  invokeSystemModel: mockInvoke,
  invokeAgentModel: vi.fn(),
  invokeSystemModelWithChoice: vi.fn(),
  isSubscriptionFramework: () => false,
}));

import { generateRunTaskGraph } from "./missionRoutes.js";
import { reconcileObservabilityGraph } from "../runtime/orchestrator.js";
import { bindRunObservability, createRun, loadRunTask } from "../storage/projectStore.js";
import { getTaskGraphByMission } from "../storage/taskGraphStore.js";

const AGENTS: AgentNodeConfig[] = [
  { id: "ceo-1", name: "老板", role: "ceo", companyId: "co1" } as AgentNodeConfig,
  { id: "dev-1", name: "小明", role: "dev", companyId: "co1" } as AgentNodeConfig,
  { id: "test-1", name: "小红", role: "test", companyId: "co1" } as AgentNodeConfig,
];

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-obs-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(AGENTS), "utf-8");
  mockInvoke.mockReset();
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function mission(over: Partial<MissionBrief> = {}): MissionBrief {
  return {
    id: "m-abc123",
    companyId: "co1",
    createdAt: new Date().toISOString(),
    originalIdea: "写一个问候页面",
    interpretedGoal: "写一个问候页面",
    successCriteria: [], nonGoals: [], assumptions: [], risks: [],
    requiredDepartments: [], expectedArtifacts: [],
    suggestedRunType: "team",
    permissionNeeds: "propose_only",
    approvalStatus: "approved",
    ...over,
  };
}

function precreatedRun(id: string, companyId = "co1"): Run {
  const run: Run = {
    id, userGoal: "写一个问候页面", status: "running", companyId,
    startedAt: new Date().toISOString(), totalTokens: 0, totalCostUsd: 0, participatingAgents: [],
  };
  createRun(root, run);
  return run;
}

describe("令五.4 · team/编码 chat run → 真实拆解图(节点含角色/状态/依赖)", () => {
  it("generateRunTaskGraph(team) 产出真实多节点拆解图并落盘,可按 missionId 反查", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        proposal_type: "task_graph", mission_summary: "问候页面",
        tasks: [
          { title: "写页面", goal: "实现 HTML", assigned_role: "dev", expected_artifacts: ["index.html"] },
          { title: "测试页面", goal: "验证渲染", assigned_role: "test", depends_on: ["index.html"], expected_artifacts: ["test.md"] },
        ],
      }),
    });

    const m = mission();
    const graph = await generateRunTaskGraph(root, m, "team");
    expect(graph).not.toBeNull();
    expect(graph!.missionId).toBe(m.id);

    // 反查(前端 getMissionTaskGraph 走的同一存储层):真实拆解,节点带角色/状态/依赖。
    const looked = getTaskGraphByMission(root, m.id);
    expect(looked).toBeTruthy();
    expect(looked!.nodes.length).toBe(2);
    const dev = looked!.nodes.find(n => n.assignedAgentId === "dev-1");
    const tester = looked!.nodes.find(n => n.assignedAgentId === "test-1");
    expect(dev, "dev 节点解析到真实 agent id").toBeTruthy();
    expect(tester, "test 节点解析到真实 agent id").toBeTruthy();
    expect(dev!.assignedRole).toBe("dev");
    expect(dev!.status).toBe("planned");
    // 依赖:测试节点依赖写页面节点(校验阶段从 index.html artifact 解析)
    expect(tester!.dependsOn).toContain(dev!.id);
  });

  it("编码目标即便标 quick 也走真实拆解(taskRequiresCode 强制 team 口径)", async () => {
    mockInvoke.mockResolvedValue({
      content: JSON.stringify({
        mission_summary: "x",
        tasks: [{ title: "实现", goal: "写 TypeScript 函数并加测试", assigned_role: "dev", expected_artifacts: ["a.ts"] }],
      }),
    });
    const m = mission({ interpretedGoal: "实现一个 TypeScript 函数 foo.ts 并写单元测试" });
    const graph = await generateRunTaskGraph(root, m, "quick");
    expect(graph).not.toBeNull();
    // 走了 CEO 拆解(而非单节点占位)→ 模型被调用过
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    expect(graph!.nodes[0].assignedAgentId).toBe("dev-1");
  });
});

describe("令五.4 · quick 直答 / 拆解失败 → 单节点占位图(诚实,不黑箱)", () => {
  it("quick 非编码目标 → 不打模型,落单节点图,承接到真实非 CEO 成员", async () => {
    const m = mission({ interpretedGoal: "介绍一下你们团队" });
    const graph = await generateRunTaskGraph(root, m, "quick");
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(graph!.nodes.length).toBe(1);
    expect(graph!.nodes[0].status).toBe("planned");
    // 承接者优先非 CEO(实际动手的人)
    expect(graph!.nodes[0].assignedAgentId).toBe("dev-1");
    expect(graph!.nodes[0].assignedRole).toBe("dev");
    expect(getTaskGraphByMission(root, m.id)).toBeTruthy();
  });

  it("team 但模型输出无法解析 → 回退单节点占位(绝不因可观测性抛错拦 run)", async () => {
    mockInvoke.mockResolvedValue({ content: "我做不到。" });
    const m = mission();
    const graph = await generateRunTaskGraph(root, m, "team");
    expect(graph).not.toBeNull();
    expect(graph!.nodes.length).toBe(1);
    expect(graph!.status).toBe("committed");
  });
});

describe("令五.4 · run 反查绑定 + 磁盘保留", () => {
  it("bindRunObservability 把 missionId/taskGraphId 加性写到 run.task.json,可反查任务图", async () => {
    const m = mission({ interpretedGoal: "介绍一下你们团队" });
    const graph = await generateRunTaskGraph(root, m, "quick");
    const run = precreatedRun("run-xyz");
    expect(run.missionId).toBeUndefined(); // precreate 阶段还没绑

    bindRunObservability(root, "run-xyz", { missionId: m.id, taskGraphId: graph!.id });
    const reloaded = loadRunTask(root, "run-xyz");
    expect(reloaded!.missionId).toBe(m.id);
    expect(reloaded!.taskGraphId).toBe(graph!.id);
    // 前端反查链:run.missionId → getTaskGraphByMission → 真实图
    expect(getTaskGraphByMission(root, reloaded!.missionId!)).toBeTruthy();
  });
});

describe("令五.4 · reconcileObservabilityGraph 终态收敛(真实 orchestrator 函数,诚实不伪造)", () => {
  it("run 成功 → 图 completed,未终结节点标 completed", async () => {
    const m = mission({ interpretedGoal: "介绍一下你们团队" });
    const graph = await generateRunTaskGraph(root, m, "quick");
    const run = precreatedRun("run-ok");
    bindRunObservability(root, "run-ok", { missionId: m.id, taskGraphId: graph!.id });
    const bound = loadRunTask(root, "run-ok")!;
    bound.status = "done";
    bound.finalState = "verified";

    reconcileObservabilityGraph(root, bound);
    const g = getTaskGraphByMission(root, m.id)!;
    expect(g.status).toBe("completed");
    expect(g.nodes.every(n => n.status === "completed")).toBe(true);
  });

  it("run 失败 → 图 failed,未终结节点标 failed 并带原因", async () => {
    const m = mission({ interpretedGoal: "介绍一下你们团队" });
    const graph = await generateRunTaskGraph(root, m, "quick");
    const run = precreatedRun("run-bad");
    bindRunObservability(root, "run-bad", { missionId: m.id, taskGraphId: graph!.id });
    const bound = loadRunTask(root, "run-bad")!;
    bound.status = "failed";
    bound.finalState = "failed";
    bound.degradedReason = "引擎超时";

    reconcileObservabilityGraph(root, bound);
    const g = getTaskGraphByMission(root, m.id)!;
    expect(g.status).toBe("failed");
    expect(g.nodes.every(n => n.status === "failed")).toBe(true);
    expect(g.nodes[0].error).toBeTruthy();
  });

  it("run 无 mission/taskGraph 关联(如任务图节点子 run)→ reconcile 无副作用", () => {
    const run = precreatedRun("run-node-child");
    // 不抛错、不建图
    expect(() => reconcileObservabilityGraph(root, loadRunTask(root, "run-node-child")!)).not.toThrow();
  });
});
