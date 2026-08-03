import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// missionRoutes 依赖链里会外呼/重型的模块全部 mock 掉,只验证 E1 estimate 的接线:
// - orchestrator:getAgents 给 missionBrief 的语境块用;startRun 是 approve 的 run 派发点(不真跑)
// - goalRunner:approve 的 harness 派发点(不真跑)
// - modelGateway/systemModel:generateMissionBrief 的模型调用(不真外呼)
// projectStore.loadAgents / runLifecycle.precreateRunTask / missions.json 读写保持真实,走临时目录。
const { mockAgents, mockStartRun, mockStartGoal, mockCallModel, mockIsRunInFlight } = vi.hoisted(() => ({
  mockAgents: [] as any[],
  mockStartRun: vi.fn(),
  mockStartGoal: vi.fn(),
  mockCallModel: vi.fn(),
  mockIsRunInFlight: vi.fn(() => false),
}));
vi.mock("../runtime/orchestrator.js", () => ({ getAgents: () => mockAgents, startRun: mockStartRun, isRunInFlight: mockIsRunInFlight }));
vi.mock("../runtime/goalRunner.js", () => ({ startGoal: mockStartGoal }));
vi.mock("../runtime/modelGateway.js", () => ({ callModel: mockCallModel }));
vi.mock("../runtime/systemModel.js", () => ({
  resolveSystemModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  inferSystemFramework: () => "hermes",
  resolveAutoSubscription: async (choice: unknown) => ({ kind: "keep", choice, reason: "has-key" }),
}));

import { register, dispatchWithMutexRetry, RUN_MUTEX_RETRY_DELAYS_MS } from "./missionRoutes.js";
import type { MissionBrief } from "../runtime/missionBrief.js";

let root: string;
let server: Server;
let baseUrl: string;

function setupRoot(agentCount = 0): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mission-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  if (agentCount > 0) {
    const agents = Array.from({ length: agentCount }, (_, i) => ({ id: `a-${i}`, name: `A${i}`, role: "dev", companyId: "co1" }));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
  }
  return root;
}

async function startTestServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  register(app, root);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

// 旧数据形状:没有 complexityEstimate 字段的历史 mission(E1 之前写入的)。
function legacyMission(over: Partial<MissionBrief> = {}): MissionBrief {
  return {
    id: "m-legacy",
    companyId: "co1",
    createdAt: "2026-07-01T00:00:00Z",
    originalIdea: "做一个待办事项 app",
    interpretedGoal: "开发一个简单的待办事项管理应用",
    successCriteria: ["能增删改查任务"],
    nonGoals: [], assumptions: [], risks: [], requiredDepartments: [],
    expectedArtifacts: [],
    suggestedRunType: "quick",
    permissionNeeds: "write_code",
    approvalStatus: "draft",
    ...over,
  };
}

function writeMissions(missions: MissionBrief[]) {
  fs.writeFileSync(path.join(root, ".opc", "missions.json"), JSON.stringify(missions));
}

function readMissions(): MissionBrief[] {
  return JSON.parse(fs.readFileSync(path.join(root, ".opc", "missions.json"), "utf-8"));
}

beforeEach(() => {
  mockAgents.length = 0;
  mockStartRun.mockReset();
  mockStartRun.mockResolvedValue(undefined);
  mockStartGoal.mockReset();
  mockCallModel.mockReset();
  mockIsRunInFlight.mockReset();
  mockIsRunInFlight.mockReturnValue(false);
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("POST /api/missions — 创建时写入 complexityEstimate", () => {
  it("201 返回体带 complexityEstimate,且 missions.json 持久化同一份;agents.json 的规模进入 reason", async () => {
    setupRoot(5); // co1 下 5 名 agent → 触发"多角色协作"规则
    await startTestServer();
    mockCallModel.mockResolvedValue({
      content: JSON.stringify({
        interpretedGoal: "开发一个简单的待办事项管理应用",
        successCriteria: ["能增删改查"],
        expectedArtifacts: ["todo.html", "readme.md"],
        suggestedRunType: "quick",
        permissionNeeds: "no_code",
      }),
    });

    const res = await fetch(`${baseUrl}/api/missions`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ideaText: "做一个 todo app", companyId: "co1" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.complexityEstimate).toBeDefined();
    expect(["S", "M", "L", "XL"]).toContain(body.complexityEstimate.complexity);
    expect(Array.isArray(body.complexityEstimate.reason)).toBe(true);
    expect(body.complexityEstimate.reason.length).toBeGreaterThan(0);
    expect(body.complexityEstimate.reason.some((r: string) => r.includes("5 名 agent"))).toBe(true);
    expect(body.complexityEstimate.reason.some((r: string) => r.includes("预计产出 2 个 artifact"))).toBe(true);

    const onDisk = readMissions();
    expect(onDisk[0].complexityEstimate).toEqual(body.complexityEstimate);
  });
});

describe("旧 mission 兼容 — 无 complexityEstimate 字段不炸", () => {
  it("GET /api/missions/:id 对旧数据正常返回,无 complexityEstimate 字段", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();
    const res = await fetch(`${baseUrl}/api/missions/m-legacy`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("m-legacy");
    expect(body.complexityEstimate).toBeUndefined();
  });

  it("GET /api/missions 列表对新旧混合数据正常返回", async () => {
    setupRoot();
    writeMissions([legacyMission({ id: "m-old" })]);
    await startTestServer();
    const res = await fetch(`${baseUrl}/api/missions`);
    expect(res.status).toBe(200);
    expect((await res.json()).length).toBe(1);
  });
});

describe("POST /api/missions/:id/approve — 派发前重算 estimate 并落盘", () => {
  it("quick run 派发:mission 补上 estimate、run 目录写 complexity-estimate.json、write_code 抬监督等级", async () => {
    setupRoot();
    writeMissions([legacyMission()]); // 旧 mission 无 estimate,approve 时现算
    await startTestServer();

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(true);
    expect(body.dispatched.kind).toBe("run");
    expect(body.complexityEstimate).toBeDefined();
    // permissionNeeds=write_code → hasCodeSignals=true → 监督等级至少 2
    expect(body.complexityEstimate.recommended_governance_level).toBeGreaterThanOrEqual(2);
    expect(mockStartRun).toHaveBeenCalledTimes(1);

    // mission 持久化了 estimate + approved
    const onDisk = readMissions().find(m => m.id === "m-legacy")!;
    expect(onDisk.approvalStatus).toBe("approved");
    expect(onDisk.complexityEstimate).toEqual(body.complexityEstimate);

    // run 目录快照(独立文件,不动 task.json 结构)
    const snapPath = path.join(root, ".opc", "runs", body.dispatched.id, "complexity-estimate.json");
    expect(fs.existsSync(snapPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapPath, "utf-8"))).toEqual(body.complexityEstimate);
    // precreateRunTask 的 task.json 保持原结构(快照走独立文件)
    const task = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", body.dispatched.id, "task.json"), "utf-8"));
    expect(task.userGoal).toBe("开发一个简单的待办事项管理应用");
  });

  it("teamMode=configured 显式保留公司员工模型,不回退 mission 的 maxQuality 建议", async () => {
    setupRoot();
    writeMissions([legacyMission({ suggestedRunType: "team", suggestedTeamMode: "maxQuality" })]);
    await startTestServer();

    const res = await fetch(baseUrl + "/api/missions/m-legacy/approve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ runType: "team", teamMode: "configured" }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(mockStartRun).toHaveBeenCalledTimes(1));
    expect(mockStartRun.mock.calls[0][3]).toMatchObject({ runType: "team" });
    expect(mockStartRun.mock.calls[0][3].teamMode).toBeUndefined();
  });

  it("非法 teamMode 返回 400,不派发", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();
    const res = await fetch(baseUrl + "/api/missions/m-legacy/approve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ teamMode: "silent-provider-override" }),
    });
    expect(res.status).toBe(400);
    expect(mockStartRun).not.toHaveBeenCalled();
  });

  it("team+多成功标准走 goal 派发,mission 同样补上 estimate", async () => {
    setupRoot();
    writeMissions([legacyMission({ suggestedRunType: "team", successCriteria: ["标准一", "标准二"] })]);
    await startTestServer();
    mockStartGoal.mockReturnValue({ id: "g-9" });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched).toEqual({ kind: "goal", id: "g-9" });
    expect(body.complexityEstimate).toBeDefined();
    expect(mockStartGoal).toHaveBeenCalledTimes(1);

    const onDisk = readMissions().find(m => m.id === "m-legacy")!;
    expect(onDisk.complexityEstimate).toEqual(body.complexityEstimate);
  });
});

// —— A2 · 第三条派发路径:dispatchMode="task-graph" ——

function readGraphs(): any[] {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".opc", "task-graphs.json"), "utf-8")); } catch { return []; }
}

const CEO_PROPOSAL = {
  proposal_type: "task_graph",
  mission_summary: "todo app 拆解",
  tasks: [
    { title: "调研", goal: "调研市场", assigned_role: "dev", expected_artifacts: ["research.md"] },
    { title: "写报告", goal: "基于调研写报告", assigned_role: "dev", depends_on: ["research.md"], expected_artifacts: ["report.md"] },
  ],
};

describe("POST /api/missions/:id/approve — dispatchMode=task-graph(A2 第三分支)", () => {
  it("成功:提案→校验→commit 图→异步串行执行(mock dispatch),旧路径派发点不被触发", async () => {
    setupRoot(2); // co1 下 a-0/a-1(role dev)
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(CEO_PROPOSAL) + "\n```" });
    mockStartRun.mockResolvedValue({ runId: "ignored", summary: "上游产出摘要内容" });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(true);
    expect(body.taskGraphId).toBeTruthy();
    // 响应体是 committed 时刻的快照(执行是响应后异步开始的)
    expect(body.graph.status).toBe("committed");
    expect(body.graph.nodes.length).toBe(2);
    expect(body.graph.nodes[0].assignedAgentId).toBe("a-0");
    expect(body.graph.nodes[1].dependsOn).toEqual(["n1"]);
    expect(body.graph.missionId).toBe("m-legacy");

    // mission 已 approve;旧路径的 goal 派发点未被触发
    expect(readMissions().find(m => m.id === "m-legacy")!.approvalStatus).toBe("approved");
    expect(mockStartGoal).not.toHaveBeenCalled();

    // 异步执行收敛到 completed(dispatch=mock startRun)
    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    const done = readGraphs()[0];
    expect(done.nodes.every((n: any) => n.status === "completed")).toBe(true);
    expect(done.nodes[0].runId).toBeTruthy();

    // 定向派发:quick + targetAgentId;第二个节点的 goal 拼上了上游产出摘要
    expect(mockStartRun).toHaveBeenCalledTimes(2);
    const [goal1, , company1, opts1] = mockStartRun.mock.calls[0];
    expect(goal1).toContain("调研市场");
    expect(company1).toBe("co1");
    expect(opts1).toMatchObject({ runType: "quick", targetAgentId: "a-0" });
    const [goal2] = mockStartRun.mock.calls[1];
    expect(goal2).toContain("基于调研写报告");
    expect(goal2).toContain("上游产出摘要内容");

    // GET /api/missions/:id/task-graph 供 C2 消费
    const getRes = await fetch(`${baseUrl}/api/missions/m-legacy/task-graph`);
    expect(getRes.status).toBe(200);
    expect((await getRes.json()).id).toBe(body.taskGraphId);
  });

  it("节点产出为空((no output)/空白)→ 节点判 failed,图 failed,不喂空摘要给下游", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(CEO_PROPOSAL) + "\n```" });
    mockStartRun.mockResolvedValue({ runId: "ignored", summary: "(no output)" });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("failed");
    }, { timeout: 5000 });
    const g = readGraphs()[0];
    expect(g.nodes[0].status).toBe("failed");
    expect(g.nodes[0].error).toContain("产出为空");
    expect(g.nodes[1].status).toBe("blocked");
    // 第一个节点空产出即失败,第二个节点不应被派发
    expect(mockStartRun).toHaveBeenCalledTimes(1);
  });

  it("校验失败 → 422 返回 errors,mission 停留 draft,不 commit 图、不派发", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({
      content: JSON.stringify({
        mission_summary: "x",
        tasks: [{ title: "神秘任务", goal: "x", assigned_role: "quantum plumber", expected_artifacts: ["x.md"] }],
      }),
    });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.some((e: string) => e.includes("神秘任务"))).toBe(true);

    expect(readMissions().find(m => m.id === "m-legacy")!.approvalStatus).toBe("draft");
    expect(readGraphs().length).toBe(0);
    expect(mockStartRun).not.toHaveBeenCalled();

    const getRes = await fetch(`${baseUrl}/api/missions/m-legacy/task-graph`);
    expect(getRes.status).toBe(404);
  });

  it("CEO 输出无法解析 → 422 + 原因,mission 停留 draft", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "我做不到这个任务。" });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toContain("解析失败");
    expect(readMissions().find(m => m.id === "m-legacy")!.approvalStatus).toBe("draft");
  });

  it("并行分支图 + 互斥型 startRun(复刻 orchestrator 单 run 闸):串行派发,同批第二个节点不再瞬间失败", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    const PARALLEL_PROPOSAL = {
      proposal_type: "task_graph",
      mission_summary: "并行分支",
      tasks: [
        { title: "分支A", goal: "做A", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "分支B", goal: "做B", assigned_role: "dev", expected_artifacts: ["b.md"] },
      ],
    };
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(PARALLEL_PROPOSAL) + "\n```" });
    let inFlight = false;
    mockStartRun.mockImplementation(async (goal: string) => {
      if (inFlight) throw new Error("已有 run 正在进行(OPC 单 run 约束):请等待当前 run 完成后再发起");
      inFlight = true;
      await new Promise(res => setTimeout(res, 10));
      inFlight = false;
      return { runId: "x", summary: `${goal.slice(0, 4)} 的产出` };
    });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    const g = readGraphs()[0];
    expect(g.nodes.every((n: any) => n.status === "completed")).toBe(true);
    expect(g.nodes.every((n: any) => !n.error)).toBe(true);
    expect(mockStartRun).toHaveBeenCalledTimes(2);
  });

  it("不传 dispatchMode → 派发路径不变;令五.4:mission 追加可观测单节点占位图(quick 非拆解目标不打模型)", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dispatched.kind).toBe("run");      // 派发路径(startRun)不变
    expect(body.taskGraphId).toBeUndefined();       // 响应体不带图:图为加性,凭 run.missionId 反查
    expect(mockCallModel).not.toHaveBeenCalled();   // quick 非拆解目标 → 单节点占位,不打 CEO 拆解模型
    // 令五.4:普通 startRun 分支的 mission 也拿到一张可观测任务图(单节点计划视图),
    // 不再"三分支只一条有图"。单节点路径无 await,请求返回时图已同步落盘。
    const graphs = readGraphs();
    expect(graphs.length).toBe(1);
    expect(graphs[0].missionId).toBe("m-legacy");
    expect(graphs[0].nodes.length).toBe(1);
    expect(graphs[0].nodes[0].status).toBe("planned");
  });
});

describe("POST /api/missions/:id/approve — token-first compatibility", () => {
  it("ignores a legacy budgetLimitUsd field and does not persist it", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(CEO_PROPOSAL) + "\n```" });
    mockStartRun.mockResolvedValue({ runId: "ignored", summary: "上游产出摘要内容" });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph", budgetLimitUsd: 0.0001 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.taskGraphId).toBeTruthy();
    expect((readMissions().find(m => m.id === "m-legacy") as any).budgetLimitUsd).toBeUndefined();
    await vi.waitFor(() => { expect(readGraphs()[0]?.status).toBe("completed"); }, { timeout: 5000 });
  });
});
// —— A3 · 审查节点真实接线(missionRoutes 的 dispatch 回调解析 VERDICT → executeGraph 触发返工/放行)——

describe("POST /api/missions/:id/approve — dispatchMode=task-graph 审查节点(A3)", () => {
  const ACCEPTED_REVIEW = JSON.stringify({
    schema_version: "1",
    verdict: "accepted",
    reason: "产物满足目标且证据可复核",
    confidence: 0.95,
    evidence_refs: ["code.md"],
  });
  const PROPOSAL_WITH_REVIEW = {
    proposal_type: "task_graph",
    mission_summary: "带审查的拆解",
    tasks: [
      { title: "写代码", goal: "实现功能", assigned_role: "dev", expected_artifacts: ["code.md"] },
      { title: "代码审查", goal: "审查代码", assigned_role: "dev", kind: "review", review_of: "写代码", expected_artifacts: ["review.md"] },
    ],
  };

  it("审查 accepted:被审节点从 completed 提升为 accepted,图 completed", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(PROPOSAL_WITH_REVIEW) + "\n```" });
    mockStartRun
      .mockResolvedValueOnce({ runId: "r1", summary: "代码写好了" })
      .mockResolvedValueOnce({ runId: "r2", summary: ACCEPTED_REVIEW });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    const g = readGraphs()[0];
    expect(g.nodes[0].kind).toBe("work");
    expect(g.nodes[0].status).toBe("accepted");
    expect(g.nodes[1].kind).toBe("review");
    expect(g.nodes[1].reviewOf).toBe("n1");
    expect(g.nodes[1].status).toBe("completed");
    expect(mockStartRun).toHaveBeenCalledTimes(2);
  });

  it("审查 needs_revision(结构化提案解析不到时保守判 needs_revision):被审节点自动返工重跑,最终 accepted", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(PROPOSAL_WITH_REVIEW) + "\n```" });
    mockStartRun
      .mockResolvedValueOnce({ runId: "r1", summary: "代码写好了 v1" })
      .mockResolvedValueOnce({ runId: "r2", summary: "审查意见不明确,格式没按要求写" }) // 解析不到结构化 proposal → 保守判 needs_revision
      .mockResolvedValueOnce({ runId: "r3", summary: "代码写好了 v2" })
      .mockResolvedValueOnce({ runId: "r4", summary: ACCEPTED_REVIEW });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    const g = readGraphs()[0];
    expect(g.nodes[0].status).toBe("accepted");
    expect(g.nodes[0].revisionCount).toBe(1);
    expect(mockStartRun).toHaveBeenCalledTimes(4);
  });

  it("审查产出超 500 字符(startRun summary 截断切掉末尾结构化裁决):从落盘 report.md 全文解析,不误判返工", async () => {
    setupRoot(2);
    writeMissions([legacyMission()]);
    await startTestServer();
    mockCallModel.mockResolvedValue({ content: "```json\n" + JSON.stringify(PROPOSAL_WITH_REVIEW) + "\n```" });
    mockStartRun.mockImplementation(async (goal: string, runId: string) => {
      if (goal.includes("你现在是审查者")) {
        const full = `${"审查理由。".repeat(120)}\n${ACCEPTED_REVIEW}`; // 结构化裁决在第 500 字符之外
        const dir = path.join(root, ".opc", "runs", runId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "report.md"), full, "utf-8");
        return { runId, summary: full.slice(0, 500) }; // 复刻 orchestrator 的 slice(0, 500) 截断
      }
      return { runId, summary: "代码写好了" };
    });

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ dispatchMode: "task-graph" }),
    });
    expect(res.status).toBe(200);

    await vi.waitFor(() => {
      expect(readGraphs()[0]?.status).toBe("completed");
    }, { timeout: 5000 });
    const g = readGraphs()[0];
    expect(g.nodes[0].status).toBe("accepted");
    expect(g.nodes[0].revisionCount).toBeUndefined(); // ACCEPTED 没有被截断误判成返工
    expect(mockStartRun).toHaveBeenCalledTimes(2);
  });
});

// —— 跨源撞闸缓解:节点派发对"已有 run 正在进行"(orchestrator 单 run 互斥闸)做有限重试+递增退避 ——

describe("dispatchWithMutexRetry — 互斥闸错误的有限重试/退避", () => {
  const MUTEX_ERR = "已有 run 正在进行(OPC 单 run 约束):请等待当前 run 完成后再发起";

  it("撞闸后按递增间隔重试,让路后成功(不判节点失败)", async () => {
    const sleeps: number[] = [];
    const attempt = vi.fn()
      .mockRejectedValueOnce(new Error(MUTEX_ERR))
      .mockRejectedValueOnce(new Error(MUTEX_ERR))
      .mockResolvedValueOnce({ runId: "r1", summary: "ok" });
    const retries: number[] = [];
    const r = await dispatchWithMutexRetry(attempt, {
      delaysMs: [10, 20, 30],
      sleep: async ms => { sleeps.push(ms); },
      onRetry: n => retries.push(n),
    });
    expect(r).toEqual({ runId: "r1", summary: "ok" });
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]); // 递增退避,只睡了需要的两次
    expect(retries).toEqual([1, 2]);
  });

  it("非互斥闸错误立即抛出,不重试不退避", async () => {
    const sleeps: number[] = [];
    const attempt = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(dispatchWithMutexRetry(attempt, { delaysMs: [10], sleep: async ms => { sleeps.push(ms); } }))
      .rejects.toThrow("boom");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("重试次数耗尽仍撞闸 → 如实抛出互斥闸错误(节点按现状 failed)", async () => {
    const sleeps: number[] = [];
    const attempt = vi.fn().mockRejectedValue(new Error(MUTEX_ERR));
    await expect(dispatchWithMutexRetry(attempt, { delaysMs: [10, 20], sleep: async ms => { sleeps.push(ms); } }))
      .rejects.toThrow("已有 run 正在进行");
    expect(attempt).toHaveBeenCalledTimes(3); // 首发 + 2 次重试
    expect(sleeps).toEqual([10, 20]);
  });

  it("默认退避间隔严格递增且为 3 次", () => {
    expect(RUN_MUTEX_RETRY_DELAYS_MS).toHaveLength(3);
    for (let i = 1; i < RUN_MUTEX_RETRY_DELAYS_MS.length; i++) {
      expect(RUN_MUTEX_RETRY_DELAYS_MS[i]).toBeGreaterThan(RUN_MUTEX_RETRY_DELAYS_MS[i - 1]);
    }
  });
});

// —— P1-5 · 派发队列:approve 撞忙入队(不再抛错)+ GET 可查 + DELETE 可撤 ——

function readQueue(): any[] {
  try { return JSON.parse(fs.readFileSync(path.join(root, ".opc", "dispatch-queue.json"), "utf-8")).items; } catch { return []; }
}

describe("POST /api/missions/:id/approve — 单 run 撞忙时入持久化队列(P1-5)", () => {
  it("有活 run:第二单入队而非抛错,返回 queued/queuePosition,预建 run 落 pending 占位,不立即起跑", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();
    mockIsRunInFlight.mockReturnValue(true); // 已有活 run

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.approved).toBe(true);
    expect(body.dispatched.kind).toBe("run");
    expect(body.queued).toBe(true);
    expect(body.queuePosition).toBe(1);
    expect(mockStartRun).not.toHaveBeenCalled(); // 撞忙 → 入队,不立即起跑

    // 预建 run 是 pending 占位(启动对账只降级 running 僵尸,pending 天然幸存)
    const task = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", body.dispatched.id, "task.json"), "utf-8"));
    expect(task.status).toBe("pending");

    // 落盘队列含该项
    const q = readQueue();
    expect(q.length).toBe(1);
    expect(q[0].runId).toBe(body.dispatched.id);

    // GET /api/dispatch-queue 可查(带 1 基位次)
    const getRes = await fetch(`${baseUrl}/api/dispatch-queue`);
    expect(getRes.status).toBe(200);
    const list = await getRes.json();
    expect(list.length).toBe(1);
    expect(list[0].runId).toBe(body.dispatched.id);
    expect(list[0].position).toBe(1);
  });

  it("无活 run:立即起跑,不入队(回归——旧行为不变)", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();
    mockIsRunInFlight.mockReturnValue(false);

    const res = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(false);
    expect(body.queuePosition).toBe(0);
    expect(mockStartRun).toHaveBeenCalledTimes(1);
    expect(readQueue()).toEqual([]);
  });

  it("DELETE /api/dispatch-queue/:id 撤销队中单:移出队列 + 预建 run 标记失败;未命中 404", async () => {
    setupRoot();
    writeMissions([legacyMission()]);
    await startTestServer();
    mockIsRunInFlight.mockReturnValue(true);

    const approveRes = await fetch(`${baseUrl}/api/missions/m-legacy/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    });
    const runId = (await approveRes.json()).dispatched.id;
    expect(readQueue().length).toBe(1);

    // 未命中 → 404
    const miss = await fetch(`${baseUrl}/api/dispatch-queue/does-not-exist`, { method: "DELETE" });
    expect(miss.status).toBe(404);

    // 按 runId 撤单
    const del = await fetch(`${baseUrl}/api/dispatch-queue/${runId}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await del.json()).removed).toBe(true);
    expect(readQueue()).toEqual([]);

    // 预建 run 占位被标记失败(避免留下永久 pending 僵尸)
    const task = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", runId, "task.json"), "utf-8"));
    expect(task.status).toBe("failed");
    expect(task.degradedReason).toContain("撤销");
  });
});
