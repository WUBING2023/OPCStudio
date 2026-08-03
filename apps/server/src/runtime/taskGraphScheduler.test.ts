import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskGraph, TaskGraphProposal, TaskNode } from "@opc/shared";

// generateTaskGraphProposal 的模型调用 mock 掉(全套测试不打真模型);
// validateProposal/executeGraph 本身不依赖这两个模块。
const { mockCallModel } = vi.hoisted(() => ({ mockCallModel: vi.fn() }));
vi.mock("./modelGateway.js", () => ({ callModel: mockCallModel }));
vi.mock("./systemModel.js", () => ({
  resolveSystemModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  inferSystemFramework: () => "hermes",
  resolveAutoSubscription: async (choice: unknown) => ({ kind: "keep", choice, reason: "has-key" }),
}));

import {
  validateProposal, executeGraph, generateTaskGraphProposal, parseReviewVerdict,
  MAX_GRAPH_NODES, type SchedulableAgent,
} from "./taskGraphScheduler.js";
import { getTaskGraph, loadTaskGraphs, upsertTaskGraph } from "../storage/taskGraphStore.js";

const AGENTS: SchedulableAgent[] = [
  { id: "ceo-1", name: "老板", role: "ceo", companyId: "co1" },
  { id: "w1", name: "小明", role: "dev", companyId: "co1" },
  { id: "w2", name: "小红", role: "test", companyId: "co1" },
  { id: "w-other", name: "外人", role: "dev", companyId: "co2" },
];
const CTX = { companyId: "co1", missionId: "m-1", goal: "总目标" };

function proposal(over: Partial<TaskGraphProposal> = {}): TaskGraphProposal {
  return {
    mission_summary: "test",
    tasks: [
      { title: "调研", goal: "调研市场", assigned_role: "dev", expected_artifacts: ["research.md"] },
      { title: "写报告", goal: "基于调研写报告", assigned_role: "test", depends_on: ["research.md"], expected_artifacts: ["report.md"] },
    ],
    ...over,
  };
}

describe("validateProposal — Core 六项校验", () => {
  it("① 结构非法:tasks 空数组 → 拒", () => {
    const r = validateProposal(proposal({ tasks: [] }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("结构非法"))).toBe(true);
  });

  it("① 结构非法:task 缺 title → 拒", () => {
    const r = validateProposal({ mission_summary: "x", tasks: [{ goal: "没标题" }] } as unknown as TaskGraphProposal, AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("结构非法"))).toBe(true);
  });

  it("② 依赖引用不存在 → 拒,错误点名任务与依赖", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "任务A", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "任务B", goal: "b", assigned_role: "dev", depends_on: ["不存在的产物.md"], expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("任务B") && e.includes("不存在的产物.md"))).toBe(true);
  });

  it("② 依赖成环(A→B→A) → 拒", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "任务A", goal: "a", assigned_role: "dev", depends_on: ["任务B"], expected_artifacts: ["a.md"] },
        { title: "任务B", goal: "b", assigned_role: "dev", depends_on: ["任务A"], expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("环"))).toBe(true);
  });

  it("② 依赖自身 → 拒", () => {
    const r = validateProposal(proposal({
      tasks: [{ title: "自恋任务", goal: "a", assigned_role: "dev", depends_on: ["自恋任务"], expected_artifacts: ["a.md"] }],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("自恋任务") && e.includes("环"))).toBe(true);
  });

  it("③ assigned_role 解析不到任何 agent → 拒,点名任务", () => {
    const r = validateProposal(proposal({
      tasks: [{ title: "神秘任务", goal: "x", assigned_role: "quantum plumber", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("神秘任务") && e.includes("quantum plumber"))).toBe(true);
  });

  it("③ 指名 CEO(assigned_agent_id / assigned_role)→ 拒:校验名册与生成名册同口径排除 ceo", () => {
    const r1 = validateProposal(proposal({
      tasks: [{ title: "任务A", goal: "x", assigned_agent_id: "ceo-1", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(r1.ok).toBe(false);
    expect(r1.errors.some(e => e.includes("ceo-1"))).toBe(true);

    const r2 = validateProposal(proposal({
      tasks: [{ title: "任务B", goal: "x", assigned_role: "ceo", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(r2.ok).toBe(false);
    expect(r2.errors.some(e => e.includes("任务B") && e.includes("ceo"))).toBe(true);
  });

  it("③ assigned_agent_id 不在该公司(跨公司/不存在) → 拒", () => {
    const r1 = validateProposal(proposal({
      tasks: [{ title: "任务A", goal: "x", assigned_agent_id: "w-other", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(r1.ok).toBe(false);
    expect(r1.errors.some(e => e.includes("w-other"))).toBe(true);
    const r2 = validateProposal(proposal({
      tasks: [{ title: "任务A", goal: "x", assigned_role: "dev", assigned_agent_id: "ghost", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(r2.ok).toBe(false);
  });

  it("④ expected_artifacts 显式给了空文件名 → 拒;完全没给 → 兜默认值通过", () => {
    const bad = validateProposal(proposal({
      tasks: [{ title: "任务A", goal: "x", assigned_role: "dev", expected_artifacts: ["   "] }],
    }), AGENTS, CTX);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some(e => e.includes("空文件名"))).toBe(true);

    const ok = validateProposal(proposal({
      tasks: [{ title: "任务A", goal: "x", assigned_role: "dev" }],
    }), AGENTS, CTX);
    expect(ok.ok).toBe(true);
    expect(ok.graph!.nodes[0].expectedArtifacts).toEqual(["task-1-output.md"]);
  });

  it("⑤ 节点数超上限(13) → 拒;12 个通过", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({
      title: `任务${i}`, goal: `g${i}`, assigned_role: "dev", expected_artifacts: [`t${i}.md`],
    }));
    const bad = validateProposal(proposal({ tasks: many(MAX_GRAPH_NODES + 1) }), AGENTS, CTX);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some(e => e.includes("上限"))).toBe(true);
    const ok = validateProposal(proposal({ tasks: many(MAX_GRAPH_NODES) }), AGENTS, CTX);
    expect(ok.ok).toBe(true);
  });

  it("⑥ goal 与 title 均空白 → 拒;goal 缺省回退 title 通过", () => {
    const bad = validateProposal(proposal({
      tasks: [{ title: "   ", goal: "  ", assigned_role: "dev", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(bad.ok).toBe(false);
    expect(bad.errors.some(e => e.includes("goal 为空"))).toBe(true);

    const ok = validateProposal(proposal({
      tasks: [{ title: "只有标题", assigned_role: "dev", expected_artifacts: ["x.md"] }],
    }), AGENTS, CTX);
    expect(ok.ok).toBe(true);
    expect(ok.graph!.nodes[0].goal).toBe("只有标题");
  });

  it("全部通过 → committed 图:节点 planned、依赖解析成节点 id、agent 解析成真实 id", () => {
    const r = validateProposal(proposal(), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    const g = r.graph!;
    expect(g.status).toBe("committed");
    expect(g.missionId).toBe("m-1");
    expect(g.companyId).toBe("co1");
    expect(g.goal).toBe("总目标");
    expect(g.schemaVersion).toBe("2");
    expect(g.revision).toBe(0);
    expect(g.nodes.length).toBe(2);
    expect(g.nodes[0]).toMatchObject({ id: "n1", assignedAgentId: "w1", dependsOn: [], status: "planned" });
    expect(g.nodes[1]).toMatchObject({ id: "n2", assignedAgentId: "w2", dependsOn: ["n1"], status: "planned" });
    expect(g.nodes[0].statusHistory).toEqual([expect.objectContaining({ status: "planned", by: "core" })]);
  });

  it("depends_on 用任务 title 引用同样能解析", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "写报告", goal: "b", assigned_role: "dev", depends_on: ["调研"], expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[1].dependsOn).toEqual(["n1"]);
  });

  it("普通任务(kind 省略)默认 kind='work',reviewOf 缺省", () => {
    const r = validateProposal(proposal(), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[0].kind).toBe("work");
    expect(r.graph!.nodes[0].reviewOf).toBeUndefined();
  });
});

describe("validateProposal — token-first accounting", () => {
  it("validates graph structure without an unreliable monetary estimate", () => {
    const r = validateProposal(proposal(), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.graph!.status).toBe("committed");
  });
});
describe("validateProposal — A3 审查节点声明(kind/review_of)", () => {
  it("kind=review + review_of 解析成功:reviewOf 落到节点 id,自动并入 dependsOn", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "调研市场", assigned_role: "dev", expected_artifacts: ["research.md"] },
        { title: "审查调研", goal: "审查产出", assigned_role: "test", kind: "review", review_of: "调研", expected_artifacts: ["review.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[1].kind).toBe("review");
    expect(r.graph!.nodes[1].reviewOf).toBe("n1");
    expect(r.graph!.nodes[1].dependsOn).toEqual(["n1"]);
  });

  it("review_of 也能引用 expected_artifacts 文件名(与 depends_on 同款解析)", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "a", assigned_role: "dev", expected_artifacts: ["research.md"] },
        { title: "审查", goal: "b", assigned_role: "test", kind: "review", review_of: "research.md", expected_artifacts: ["review.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(true);
    expect(r.graph!.nodes[1].reviewOf).toBe("n1");
  });

  it("kind=review 缺 review_of → 拒", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "审查", goal: "b", assigned_role: "test", kind: "review", expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("审查") && e.includes("缺少 review_of"))).toBe(true);
  });

  it("review_of 解析不到任何任务 → 拒", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "审查", goal: "b", assigned_role: "test", kind: "review", review_of: "不存在的任务", expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("review_of") && e.includes("不存在的任务"))).toBe(true);
  });

  it("review_of 指向自己 → 拒", () => {
    const r = validateProposal(proposal({
      tasks: [{ title: "自审", goal: "a", assigned_role: "dev", kind: "review", review_of: "自审", expected_artifacts: ["a.md"] }],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("不能审查自己"))).toBe(true);
  });

  it("非 review 任务却带 review_of → 拒(半配置状态,不静默当普通任务跑)", () => {
    const r = validateProposal(proposal({
      tasks: [
        { title: "调研", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "普通任务", goal: "b", assigned_role: "test", review_of: "调研", expected_artifacts: ["b.md"] },
      ],
    }), AGENTS, CTX);
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes("review_of 只能配合"))).toBe(true);
  });
});

describe("parseReviewVerdict — schema-validated review proposal", () => {
  it("accepts a complete structured proposal", () => {
    expect(parseReviewVerdict(
      '{"schema_version":"1","verdict":"accepted","reason":"tests and artifact hashes match","confidence":0.9,"evidence_refs":["test-1"]}',
    )).toBe("accepted");
  });

  it("accepts a structured revision proposal", () => {
    expect(parseReviewVerdict(
      '{"schema_version":"1","verdict":"needs_revision","reason":"missing tests","evidence_refs":[]}',
    )).toBe("needs_revision");
  });

  it("fails closed for prose, legacy tail markers and invalid schema", () => {
    expect(parseReviewVerdict("我看完了,大概还行吧。")).toBe("needs_revision");
    expect(parseReviewVerdict("VERDICT: ACCEPTED")).toBe("needs_revision");
    expect(parseReviewVerdict('{"schema_version":"2","verdict":"accepted","reason":"ok"}')).toBe("needs_revision");
    expect(parseReviewVerdict('{"schema_version":"1","verdict":"accepted","reason":""}')).toBe("needs_revision");
    expect(parseReviewVerdict("")).toBe("needs_revision");
  });
});

// —— executeGraph ——

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-graph-exec-"));
  mockCallModel.mockReset();
});
afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function committedChain(): TaskGraph {
  const r = validateProposal({
    mission_summary: "chain",
    tasks: [
      { title: "任务一", goal: "第一步", assigned_role: "dev", expected_artifacts: ["one.md"] },
      { title: "任务二", goal: "第二步", assigned_role: "test", depends_on: ["one.md"], expected_artifacts: ["two.md"] },
      { title: "任务三", goal: "第三步", assigned_role: "dev", depends_on: ["two.md"], expected_artifacts: ["three.md"] },
    ],
  }, AGENTS, CTX);
  expect(r.ok).toBe(true);
  return r.graph!;
}

describe("executeGraph — V0 串行拓扑执行", () => {
  it("3 节点线性链 happy path:顺序执行、状态/statusHistory 正确、落盘、事件成对", async () => {
    const graph = committedChain();
    const order: string[] = [];
    const events: Array<{ type: string; nodeId: string; status?: string }> = [];
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      order.push(node.id);
      return { ok: true, runId: `run-${node.id}`, summary: `${node.title} 的产出摘要` };
    });

    const result = await executeGraph(root, graph, {
      dispatch,
      emit: (type, _agentId, payload) => events.push({ type, nodeId: payload.nodeId as string, status: payload.status as string | undefined }),
    });

    expect(order).toEqual(["n1", "n2", "n3"]);
    expect(result.status).toBe("completed");
    for (const n of result.nodes) {
      expect(n.status).toBe("completed");
      expect(n.runId).toBe(`run-${n.id}`);
      expect(n.statusHistory.map(h => h.status)).toEqual(["planned", "running", "completed"]);
    }
    // 落盘:最终状态在 .opc/task-graphs.json
    const onDisk = loadTaskGraphs(root);
    expect(onDisk.length).toBe(1);
    expect(onDisk[0].status).toBe("completed");
    expect(onDisk[0].nodes.every(n => n.status === "completed")).toBe(true);
    // 事件:每节点 started+finished 成对,finished 带最终状态
    expect(events.filter(e => e.type === "task_node_started").map(e => e.nodeId)).toEqual(["n1", "n2", "n3"]);
    expect(events.filter(e => e.type === "task_node_finished").map(e => e.status)).toEqual(["completed", "completed", "completed"]);
  });

  it("依赖上下文传递:下游节点的 goal 拼上游产出摘要", async () => {
    const graph = committedChain();
    const goals: Record<string, string> = {};
    await executeGraph(root, graph, {
      dispatch: async ({ node, goal }) => {
        goals[node.id] = goal;
        return { ok: true, summary: `${node.title} 的产出摘要` };
      },
    });
    expect(goals.n1).toBe("第一步"); // 无依赖 → 原样
    expect(goals.n2).toContain("第二步");
    expect(goals.n2).toContain("任务一 的产出摘要");
    expect(goals.n2).toContain("one.md");
    expect(goals.n3).toContain("任务二 的产出摘要");
    expect(goals.n3).not.toContain("任务一 的产出摘要"); // n3 只依赖 n2
  });

  it("中间节点失败:后续依赖节点 blocked、图 failed、不再派发", async () => {
    const graph = committedChain();
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.id === "n2") return { ok: false, error: "引擎爆炸了" };
      return { ok: true, summary: "ok" };
    });
    const result = await executeGraph(root, graph, { dispatch });

    expect(dispatch).toHaveBeenCalledTimes(2); // n1 + n2,n3 不再派发
    expect(result.status).toBe("failed");
    const [n1, n2, n3] = result.nodes;
    expect(n1.status).toBe("completed");
    expect(n2.status).toBe("failed");
    expect(n2.error).toContain("引擎爆炸了");
    expect(n2.statusHistory.map(h => h.status)).toEqual(["planned", "running", "failed"]);
    expect(n3.status).toBe("blocked");
    expect(n3.statusHistory.map(h => h.status)).toEqual(["planned", "blocked"]);
    expect(loadTaskGraphs(root)[0].status).toBe("failed");
  });

  it("dispatch 抛异常 → 视为该节点失败,不炸调度器", async () => {
    const graph = committedChain();
    const result = await executeGraph(root, graph, {
      dispatch: async () => { throw new Error("同步炸了"); },
    });
    expect(result.status).toBe("failed");
    expect(result.nodes[0].status).toBe("failed");
    expect(result.nodes[0].error).toContain("同步炸了");
    expect(result.nodes[1].status).toBe("blocked");
    expect(result.nodes[2].status).toBe("blocked");
  });
});

// —— A3:并行就绪调度 ——

function committedParallelPair(): TaskGraph {
  const r = validateProposal({
    mission_summary: "parallel",
    tasks: [
      { title: "分支A", goal: "做A", assigned_role: "dev", expected_artifacts: ["a.md"] },
      { title: "分支B", goal: "做B", assigned_role: "test", expected_artifacts: ["b.md"] },
    ],
  }, AGENTS, CTX);
  expect(r.ok).toBe(true);
  return r.graph!;
}

describe("executeGraph — A3 并行就绪调度", () => {
  it("两个无依赖节点在同一轮并发派发:都在对方完成前就已被调用(真 Promise.all,不是排队)", async () => {
    const graph = committedParallelPair();
    let aStarted = false;
    let bStarted = false;
    let resolveA!: () => void;
    let resolveB!: () => void;
    const gateA = new Promise<void>(res => { resolveA = res; });
    const gateB = new Promise<void>(res => { resolveB = res; });
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.title === "分支A") { aStarted = true; await gateA; return { ok: true, summary: "A done" }; }
      bStarted = true; await gateB; return { ok: true, summary: "B done" };
    });

    const pending = executeGraph(root, graph, { dispatch });
    // 让事件循环跑一轮微任务:若调度器是"逐个 await",此时 bStarted 应仍为 false(A 卡在 gateA 没让出)。
    await new Promise(res => setTimeout(res, 10));
    expect(aStarted).toBe(true);
    expect(bStarted).toBe(true); // 真并发的关键断言
    expect(dispatch).toHaveBeenCalledTimes(2);

    resolveA(); resolveB();
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(result.nodes.every(n => n.status === "completed")).toBe(true);
  });

  it("maxConcurrency=1:同批就绪节点串行派发(前一个 resolve 后才派发下一个),互斥型 dispatch 不撞闸", async () => {
    const graph = committedParallelPair();
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(res => setTimeout(res, 10));
      inFlight--;
      return { ok: true, summary: `${node.title} done` };
    });
    const result = await executeGraph(root, graph, { dispatch, maxConcurrency: 1 });
    expect(maxInFlight).toBe(1); // 从未同时在飞 2 个
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(result.status).toBe("completed");
    expect(result.nodes.every(n => n.status === "completed")).toBe(true);
  });

  it("已有外部 owner 的活跃节点租约时拒绝第二个调度器", async () => {
    const graph = committedSingleWork();
    graph.status = "running";
    graph.nodes[0].status = "running";
    graph.nodes[0].leaseOwner = "other-scheduler";
    graph.nodes[0].leaseExpiry = new Date(Date.now() + 60_000).toISOString();
    upsertTaskGraph(root, graph);
    const dispatch = vi.fn(async () => ({ ok: true }));
    await expect(executeGraph(root, structuredClone(graph), { dispatch })).rejects.toThrow("already executing");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("长时间 dispatch 会在租期内续租,完成后清除租约并落 completion receipt", async () => {
    const graph = committedSingleWork();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const pending = executeGraph(root, graph, {
      leaseMs: 1_000,
      dispatch: async () => {
        await gate;
        return { ok: true, runId: "run-heartbeat", summary: "done", artifactRefs: ["file:x.md"], evidenceRefs: ["run:run-heartbeat:evidence-manifest.json"] };
      },
    });
    for (let i = 0; i < 20 && getTaskGraph(root, graph.id)?.nodes[0].status !== "running"; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const firstExpiry = Date.parse(getTaskGraph(root, graph.id)!.nodes[0].leaseExpiry!);
    await new Promise(resolve => setTimeout(resolve, 450));
    const renewedExpiry = Date.parse(getTaskGraph(root, graph.id)!.nodes[0].leaseExpiry!);
    expect(renewedExpiry).toBeGreaterThan(firstExpiry);
    release();
    const result = await pending;
    expect(result.nodes[0].leaseOwner).toBeUndefined();
    expect(result.nodes[0].leaseExpiry).toBeUndefined();
    expect(result.nodes[0].completionReceipt).toMatchObject({
      runId: "run-heartbeat",
      artifactRefs: ["file:x.md"],
      evidenceRefs: ["run:run-heartbeat:evidence-manifest.json"],
    });
  });

  it("下游收到带 run、产物、证据和 hash 的依赖合同,而不是只有摘要", async () => {
    const graph = validateProposal(proposal(), AGENTS, CTX).graph!;
    let downstreamGoal = "";
    const result = await executeGraph(root, graph, {
      dispatch: async ({ node, goal }) => {
        if (node.id === "n1") {
          return {
            ok: true,
            runId: "run-upstream",
            summary: "research complete",
            artifactRefs: ["file:research.md"],
            evidenceRefs: ["run:run-upstream:evidence-manifest.json"],
          };
        }
        downstreamGoal = goal;
        return { ok: true, summary: "report complete" };
      },
    });
    expect(result.status).toBe("completed");
    expect(downstreamGoal).toContain("依赖任务合同");
    expect(downstreamGoal).toContain("run-upstream");
    expect(downstreamGoal).toContain("file:research.md");
    expect(downstreamGoal).toContain("evidence-manifest.json");
    expect(downstreamGoal).toContain("resultHash");
  });

  it("失败传染只污染相关下游,独立分支不受影响", async () => {
    const r = validateProposal({
      mission_summary: "x",
      tasks: [
        { title: "A1", goal: "a1", assigned_role: "dev", expected_artifacts: ["a1.md"] },
        { title: "A2", goal: "a2", assigned_role: "dev", depends_on: ["a1.md"], expected_artifacts: ["a2.md"] },
        { title: "B1", goal: "b1", assigned_role: "test", expected_artifacts: ["b1.md"] },
      ],
    }, AGENTS, CTX);
    const graph = r.graph!;
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.title === "A1") return { ok: false, error: "A1 挂了" };
      return { ok: true, summary: `${node.title} ok` };
    });
    const result = await executeGraph(root, graph, { dispatch });
    const byTitle = (t: string) => result.nodes.find(n => n.title === t)!;
    expect(byTitle("A1").status).toBe("failed");
    expect(byTitle("A2").status).toBe("blocked");
    expect(byTitle("B1").status).toBe("completed"); // 独立分支不受 A 链失败影响
    expect(result.status).toBe("failed"); // 整图仍因 A 链未收敛而判失败
    expect(dispatch).toHaveBeenCalledTimes(2); // A1 + B1;A2 被 block,不派发
  });

  it("completion-driven: A 完成即解锁 C,不等待同层慢分支 B", async () => {
    const r = validateProposal({
      mission_summary: "completion-driven",
      tasks: [
        { title: "A", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "B", goal: "b", assigned_role: "test", expected_artifacts: ["b.md"] },
        { title: "C", goal: "c", assigned_role: "dev", depends_on: ["a.md"], expected_artifacts: ["c.md"] },
      ],
    }, AGENTS, CTX);
    const graph = r.graph!;
    let resolveB!: () => void;
    const gateB = new Promise<void>(resolve => { resolveB = resolve; });
    let cStarted = false;
    const pending = executeGraph(root, graph, {
      maxConcurrency: 2,
      dispatch: async ({ node }) => {
        if (node.title === "B") await gateB;
        if (node.title === "C") cStarted = true;
        return { ok: true, summary: `${node.title} done` };
      },
    });
    for (let i = 0; i < 20 && !cStarted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(cStarted).toBe(true);
    expect(graph.nodes.find(n => n.title === "B")!.status).toBe("running");
    resolveB();
    expect((await pending).status).toBe("completed");
  });
});

// —— A3:失败返工(needs_revision 回边)——

function committedSingleWork(): TaskGraph {
  const r = validateProposal({
    mission_summary: "x",
    tasks: [{ title: "任务", goal: "做点事", assigned_role: "dev", expected_artifacts: ["x.md"] }],
  }, AGENTS, CTX);
  expect(r.ok).toBe(true);
  return r.graph!;
}

describe("executeGraph — A3 失败返工(needs_revision 回边)", () => {
  it("needsRevision 且未超预算 → 回到 pending 重跑一次后成功;revisionCount=1,history 记录 needs_revision→running", async () => {
    const graph = committedSingleWork();
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls++;
      if (calls === 1) return { ok: true, summary: "草稿", needsRevision: true };
      return { ok: true, summary: "定稿" };
    });
    const result = await executeGraph(root, graph, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const n = result.nodes[0];
    expect(n.status).toBe("completed");
    expect(n.revisionCount).toBe(1);
    expect(n.statusHistory.map(h => h.status)).toEqual(["planned", "running", "needs_revision", "running", "completed"]);
    expect(result.status).toBe("completed");
  });

  it("needsRevision 持续判定 → 超过默认 maxRounds(2)后 failed,不会无限重跑", async () => {
    const graph = committedSingleWork();
    const dispatch = vi.fn(async () => ({ ok: true, summary: "草稿", needsRevision: true }));
    const result = await executeGraph(root, graph, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2); // maxRounds 默认 2 = 总共最多 2 次执行
    const n = result.nodes[0];
    expect(n.status).toBe("failed");
    expect(n.revisionCount).toBe(2);
    expect(n.error).toContain("最大返工轮次");
    expect(n.statusHistory.map(h => h.status)).toEqual(["planned", "running", "needs_revision", "running", "failed"]);
    expect(result.status).toBe("failed");
  });

  it("maxRevisionRounds 可覆盖:注入 3 轮预算,第 3 次成功", async () => {
    const graph = committedSingleWork();
    let calls = 0;
    const dispatch = vi.fn(async () => {
      calls++;
      return calls < 3 ? { ok: true, summary: "草稿", needsRevision: true } : { ok: true, summary: "定稿" };
    });
    const result = await executeGraph(root, graph, { dispatch, maxRevisionRounds: 3 });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(result.nodes[0].status).toBe("completed");
    expect(result.nodes[0].revisionCount).toBe(2);
    expect(result.status).toBe("completed");
  });

  it("返工超限 failed 仍触发下游 blocked(失败传染对返工失败同样生效)", async () => {
    const r = validateProposal({
      mission_summary: "x",
      tasks: [
        { title: "上游", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "下游", goal: "b", assigned_role: "dev", depends_on: ["a.md"], expected_artifacts: ["b.md"] },
      ],
    }, AGENTS, CTX);
    const graph = r.graph!;
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.title === "上游") return { ok: true, summary: "草稿", needsRevision: true };
      return { ok: true, summary: "ok" };
    });
    const result = await executeGraph(root, graph, { dispatch });
    const up = result.nodes.find(n => n.title === "上游")!;
    const down = result.nodes.find(n => n.title === "下游")!;
    expect(up.status).toBe("failed");
    expect(down.status).toBe("blocked");
    expect(dispatch).toHaveBeenCalledTimes(2); // 上游两次(首次+返工),下游从未被派发
  });

  it("返工开始前彻底清理上一轮 run/result/error/refs/receipts", async () => {
    const graph = committedSingleWork();
    const seen: TaskNode[] = [];
    const result = await executeGraph(root, graph, {
      dispatch: async ({ node }) => {
        seen.push(structuredClone(node));
        if (seen.length === 1) {
          return {
            ok: true, runId: "old-run", summary: "old-result", needsRevision: true,
            artifactRefs: ["old-artifact"], evidenceRefs: ["old-evidence"],
          };
        }
        return { ok: true, runId: "new-run", summary: "new-result", artifactRefs: ["new-artifact"] };
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ attempt: 2, artifactRefs: [], evidenceRefs: [] });
    expect(seen[1].runId).toBeUndefined();
    expect(seen[1].resultSummary).toBeUndefined();
    expect(seen[1].error).toBeUndefined();
    expect(seen[1].completionReceipt).toBeUndefined();
    expect(result.nodes[0]).toMatchObject({
      runId: "new-run", resultSummary: "new-result", artifactRefs: ["new-artifact"], evidenceRefs: [],
    });
    expect(result.nodes[0].completionReceipt?.status).toBe("completed");
  });
});

describe("executeGraph — Abort/drain", () => {
  it("release gate: 取消停止新派发,先 drain 在飞节点,终态写入后不再持久化", async () => {
    const r = validateProposal({
      mission_summary: "abort",
      tasks: [
        { title: "A", goal: "a", assigned_role: "dev", expected_artifacts: ["a.md"] },
        { title: "B", goal: "b", assigned_role: "test", expected_artifacts: ["b.md"] },
        { title: "C", goal: "c", assigned_role: "dev", depends_on: ["a.md"], expected_artifacts: ["c.md"] },
      ],
    }, AGENTS, CTX);
    const controller = new AbortController();
    const releases = new Map<string, () => void>();
    const writes: string[] = [];
    const pending = executeGraph(root, r.graph!, {
      signal: controller.signal,
      maxConcurrency: 2,
      persist: (_root, graph) => writes.push(`${graph.status}:${graph.updatedAt}:${graph.nodes.map(n => n.status).join(",")}`),
      dispatch: ({ node }) => new Promise(resolve => {
        releases.set(node.id, () => resolve({ ok: true, summary: `${node.id} done` }));
      }),
    });
    for (let i = 0; i < 20 && releases.size < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
    controller.abort();
    releases.get("n1")!();
    releases.get("n2")!();
    const result = await pending;
    expect(result.status).toBe("cancelled");
    expect(result.nodes.find(n => n.id === "n3")!.status).toBe("cancelled");
    expect(releases.has("n3")).toBe(false);
    const writesAtTerminal = writes.length;
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(writes).toHaveLength(writesAtTerminal);
  });
});

// —— A3:审查节点 ——

function committedReviewGraph(): TaskGraph {
  const r = validateProposal({
    mission_summary: "x",
    tasks: [
      { title: "写代码", goal: "写个功能", assigned_role: "dev", expected_artifacts: ["code.md"] },
      { title: "代码审查", goal: "审查代码", assigned_role: "test", kind: "review", review_of: "写代码", expected_artifacts: ["review.md"] },
    ],
  }, AGENTS, CTX);
  expect(r.ok).toBe(true);
  expect(r.graph!.nodes[1].kind).toBe("review");
  expect(r.graph!.nodes[1].reviewOf).toBe("n1");
  return r.graph!;
}

describe("executeGraph — A3 审查节点", () => {
  it("accepted → 被审节点从 completed 提升为 accepted(十态),图 completed", async () => {
    const graph = committedReviewGraph();
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.kind === "review") return { ok: true, summary: "看起来不错\nVERDICT: ACCEPTED", verdict: "accepted" as const };
      return { ok: true, summary: "代码产出" };
    });
    const result = await executeGraph(root, graph, { dispatch });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const work = result.nodes.find(n => n.id === "n1")!;
    const review = result.nodes.find(n => n.id === "n2")!;
    expect(work.status).toBe("accepted");
    expect(review.status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("needs_revision → 被审节点返工重跑,复审再次通过后图 completed;revisionCount=1", async () => {
    const graph = committedReviewGraph();
    let workCalls = 0;
    let reviewCalls = 0;
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.kind === "review") {
        reviewCalls++;
        return reviewCalls === 1
          ? { ok: true, summary: "有问题\nVERDICT: NEEDS_REVISION", verdict: "needs_revision" as const }
          : { ok: true, summary: "改好了\nVERDICT: ACCEPTED", verdict: "accepted" as const };
      }
      workCalls++;
      return { ok: true, summary: `代码产出 v${workCalls}` };
    });
    const result = await executeGraph(root, graph, { dispatch });
    expect(workCalls).toBe(2);   // 首次执行 + 1 次返工重跑
    expect(reviewCalls).toBe(2); // 首次复审 + 返工后再复审一次
    const work = result.nodes.find(n => n.id === "n1")!;
    const review = result.nodes.find(n => n.id === "n2")!;
    expect(work.status).toBe("accepted");
    expect(work.revisionCount).toBe(1);
    // 被审节点自己也会先跑到 completed(第一稿交付),复审判 needs_revision 才把它打回去重跑;
    // 第二稿再次 completed 后,复审 accepted 才把它从 completed 提升为 accepted。
    expect(work.statusHistory.map(h => h.status)).toEqual(["planned", "running", "completed", "needs_revision", "running", "completed", "accepted"]);
    expect(review.status).toBe("completed");
    expect(result.status).toBe("completed");
  });

  it("needs_revision 且被审节点返工超限 → 被审 failed,复审节点本身仍 completed,图 failed", async () => {
    const graph = committedReviewGraph();
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.kind === "review") return { ok: true, summary: "还是不行\nVERDICT: NEEDS_REVISION", verdict: "needs_revision" as const };
      return { ok: true, summary: "代码产出" };
    });
    const result = await executeGraph(root, graph, { dispatch });
    const work = result.nodes.find(n => n.id === "n1")!;
    const review = result.nodes.find(n => n.id === "n2")!;
    expect(work.status).toBe("failed");
    expect(work.revisionCount).toBe(2); // 默认 maxRounds=2,第 2 次判定超限
    expect(review.status).toBe("completed"); // 复审节点自己确实完成了裁决工作
    expect(result.status).toBe("failed");
  });

  it("否决理由注入返工 prompt:目标节点重跑的 goal 带上一轮审查否决理由,首跑不带", async () => {
    const graph = committedReviewGraph();
    const workGoals: string[] = [];
    let reviewCalls = 0;
    const dispatch = vi.fn(async ({ node, goal }: { node: TaskNode; goal: string }) => {
      if (node.kind === "review") {
        reviewCalls++;
        return reviewCalls === 1
          ? { ok: true, summary: "缺少性能对比章节\nVERDICT: NEEDS_REVISION", verdict: "needs_revision" as const }
          : { ok: true, summary: "补上了\nVERDICT: ACCEPTED", verdict: "accepted" as const };
      }
      workGoals.push(goal);
      return { ok: true, summary: `代码产出 v${workGoals.length}` };
    });
    const result = await executeGraph(root, graph, { dispatch });
    expect(workGoals.length).toBe(2);
    expect(workGoals[0]).not.toContain("上一轮审查否决理由");
    expect(workGoals[1]).toContain("上一轮审查否决理由");
    expect(workGoals[1]).toContain("缺少性能对比章节");
    expect(result.status).toBe("completed");
    expect(result.nodes.find(n => n.id === "n1")!.status).toBe("accepted");
  });

  it("回卷旁下游:同批已消费被拒产出跑完的下游节点被吊销重跑,拿到返工后的新产出(不扣它的返工预算)", async () => {
    const r = validateProposal({
      mission_summary: "x",
      tasks: [
        { title: "实现", goal: "写实现", assigned_role: "dev", expected_artifacts: ["impl.md"] },
        { title: "审查实现", goal: "审查", assigned_role: "test", kind: "review", review_of: "实现", expected_artifacts: ["review.md"] },
        { title: "写文档", goal: "基于实现写文档", assigned_role: "dev", depends_on: ["impl.md"], expected_artifacts: ["docs.md"] },
      ],
    }, AGENTS, CTX);
    expect(r.ok).toBe(true);
    const graph = r.graph!;
    let workCalls = 0;
    let reviewCalls = 0;
    const docGoals: string[] = [];
    const dispatch = vi.fn(async ({ node, goal }: { node: TaskNode; goal: string }) => {
      if (node.kind === "review") {
        reviewCalls++;
        return reviewCalls === 1
          ? { ok: true, summary: "有缺陷\nVERDICT: NEEDS_REVISION", verdict: "needs_revision" as const }
          : { ok: true, summary: "可以了\nVERDICT: ACCEPTED", verdict: "accepted" as const };
      }
      if (node.title === "写文档") {
        docGoals.push(goal);
        return { ok: true, summary: "文档完成" };
      }
      workCalls++;
      return { ok: true, summary: `实现产出 v${workCalls}` };
    });
    const result = await executeGraph(root, graph, { dispatch });
    // 文档节点第一次基于 v1 跑完,审查否决 v1 后被吊销,重跑时拿到 v2
    expect(docGoals.length).toBe(2);
    expect(docGoals[0]).toContain("实现产出 v1");
    expect(docGoals[1]).toContain("实现产出 v2");
    const doc = result.nodes.find(n => n.title === "写文档")!;
    expect(doc.status).toBe("completed");
    expect(doc.revisionCount).toBeUndefined(); // 吊销不是返工,不扣它的预算
    expect(result.nodes.find(n => n.title === "实现")!.status).toBe("accepted");
    expect(result.status).toBe("completed");
  });

  it("多审查者同批否决同一目标:返工预算只扣一次(revisionCount=1),重跑后两个审查者都复审", async () => {
    const r = validateProposal({
      mission_summary: "x",
      tasks: [
        { title: "任务", goal: "做事", assigned_role: "dev", expected_artifacts: ["t.md"] },
        { title: "审查一", goal: "审1", assigned_role: "test", kind: "review", review_of: "任务", expected_artifacts: ["r1.md"] },
        { title: "审查二", goal: "审2", assigned_role: "test", kind: "review", review_of: "任务", expected_artifacts: ["r2.md"] },
      ],
    }, AGENTS, CTX);
    expect(r.ok).toBe(true);
    const graph = r.graph!;
    let workCalls = 0;
    const reviewCallsById = new Map<string, number>();
    const dispatch = vi.fn(async ({ node }: { node: TaskNode }) => {
      if (node.kind === "review") {
        const c = (reviewCallsById.get(node.id) ?? 0) + 1;
        reviewCallsById.set(node.id, c);
        return c === 1
          ? { ok: true, summary: "不行\nVERDICT: NEEDS_REVISION", verdict: "needs_revision" as const }
          : { ok: true, summary: "行了\nVERDICT: ACCEPTED", verdict: "accepted" as const };
      }
      workCalls++;
      return { ok: true, summary: `产出 v${workCalls}` };
    });
    const result = await executeGraph(root, graph, { dispatch });
    const work = result.nodes.find(n => n.title === "任务")!;
    // 同一次执行被两个审查者否决只算一轮返工:目标拿到它应有的重跑机会,而不是当场烧光预算 failed
    expect(work.revisionCount).toBe(1);
    expect(workCalls).toBe(2);
    expect(reviewCallsById.get("n2")).toBe(2);
    expect(reviewCallsById.get("n3")).toBe(2);
    expect(work.status).toBe("accepted");
    expect(result.status).toBe("completed");
  });
});

describe("generateTaskGraphProposal — mock 模型", () => {
  it("prompt 注入名册(排除 ceo)与 mission;返回解析后的提案", async () => {
    mockCallModel.mockResolvedValue({
      content: "```json\n" + JSON.stringify({
        proposal_type: "task_graph", mission_summary: "x",
        tasks: [{ title: "调研", assigned_role: "dev", expected_artifacts: ["r.md"] }],
      }) + "\n```",
    });
    const r = await generateTaskGraphProposal(root, { id: "m-1", companyId: "co1", interpretedGoal: "做个 todo app" }, AGENTS);
    expect(r.proposal).not.toBeNull();
    expect(r.proposal!.tasks[0].title).toBe("调研");
    const prompt = mockCallModel.mock.calls[0][0].messages[0].content as string;
    expect(prompt).toContain("做个 todo app");
    expect(prompt).toContain("id: w1");
    expect(prompt).toContain("id: w2");
    expect(prompt).not.toContain("id: ceo-1"); // CEO 不进派发名册
    expect(prompt).not.toContain("w-other");   // 其他公司不进名册
  });

  it("模型输出无法解析 → proposal null + reason(不抛错)", async () => {
    mockCallModel.mockResolvedValue({ content: "我做不到。" });
    const r = await generateTaskGraphProposal(root, { id: "m-1", companyId: "co1", interpretedGoal: "x" }, AGENTS);
    expect(r.proposal).toBeNull();
    expect(r.reason).toBeTruthy();
    expect(r.raw).toBe("我做不到。");
  });
});
