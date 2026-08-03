import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import {
  computeGrowthDelta, computeLevel, applyGrowth, reconcileCitations, collectRunGrowthEvidence,
  XP_PROPOSAL_APPROVED, XP_CITED_SUCCESS, XP_SOP_PROMOTION, XP_REVIEW_PENALTY, XP_RUN_COMPLETED,
  MAX_WEAKNESSES, MAX_RECENT_LESSONS,
  type RunGrowthEvidence,
} from "./agentGrowthStore.js";
import { loadAgents, saveAgents, upsertMemoryProposals } from "./projectStore.js";
import { upsertProceduralSkill } from "./registryStore.js";

const NOW = "2026-07-07T00:00:00.000Z";
let root = "";
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-growth-")); });
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const baseEvidence = (): RunGrowthEvidence => ({
  runId: "r1", runCompleted: false, participantAgentIds: [], proposals: [], reviews: [], citations: [],
});

function mkAgent(id: string, patch: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id, name: id, role: "dev", parentId: undefined, childrenIds: [], model: "m", provider: "hermes",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
    ...patch,
  };
}

describe("computeGrowthDelta · 硬约束五类 XP 事件", () => {
  it("① memory proposal 被批准(approved/committed 都算,pending/rejected 不算)→ +XP_PROPOSAL_APPROVED", () => {
    const ev = baseEvidence();
    ev.proposals = [
      { agentId: "dev-1", status: "approved", source: "run_conclusion" },
      { agentId: "dev-1", status: "committed", source: "run_conclusion" },
      { agentId: "dev-1", status: "pending", source: "run_conclusion" },   // 不算
      { agentId: "dev-2", status: "rejected", source: "run_conclusion" },  // 不算
    ];
    const deltas = computeGrowthDelta(ev);
    const d1 = deltas.find((d) => d.agentId === "dev-1")!;
    expect(d1.xpDelta).toBe(XP_PROPOSAL_APPROVED * 2);
    expect(deltas.find((d) => d.agentId === "dev-2")).toBeUndefined();
  });

  it("① reflection_lesson 来源的批准提案 → 追加进 recentLessons", () => {
    const ev = baseEvidence();
    ev.proposals = [{ agentId: "dev-1", status: "committed", source: "reflection_lesson", content: "下次先检查 API Key 再执行" }];
    const [d] = computeGrowthDelta(ev);
    expect(d.recentLessons).toEqual(["下次先检查 API Key 再执行"]);
  });

  it("② 引用对账 citedDelta>0 → +XP_CITED_SUCCESS × 增量,分给该 role 所有归因 agentId", () => {
    const ev = baseEvidence();
    ev.citations = [{ role: "dev", agentIds: ["dev-1", "dev-2"], citedDelta: 3, promoted: false }];
    const deltas = computeGrowthDelta(ev);
    expect(deltas).toHaveLength(2);
    for (const d of deltas) {
      expect(d.xpDelta).toBe(XP_CITED_SUCCESS * 3);
      expect(d.events[0]).toMatchObject({ kind: "cited_success", xp: XP_CITED_SUCCESS * 3 });
    }
  });

  it("③ 升级 SOP(promoted=true)→ +XP_SOP_PROMOTION(与②可叠加,同一条 citation 两者都命中)", () => {
    const ev = baseEvidence();
    ev.citations = [{ role: "dev", agentIds: ["dev-1"], citedDelta: 1, promoted: true }];
    const [d] = computeGrowthDelta(ev);
    expect(d.xpDelta).toBe(XP_CITED_SUCCESS * 1 + XP_SOP_PROMOTION);
    expect(d.events.map((e) => e.kind)).toEqual(["cited_success", "sop_promotion"]);
  });

  it("④ review needs_revision/failed → XP_REVIEW_PENALTY(负数)+ 记 weakness;accepted/requires_human_review 不扣分", () => {
    const ev = baseEvidence();
    ev.reviews = [
      { agentId: "dev-1", verdict: "needs_revision", reason: "缺少单测" },
      { agentId: "dev-1", verdict: "failed", reason: "重试耗尽" },
      { agentId: "dev-1", verdict: "accepted", reason: "通过" },
      { agentId: "dev-1", verdict: "requires_human_review", reason: "不确定" },
    ];
    const [d] = computeGrowthDelta(ev);
    expect(d.xpDelta).toBe(XP_REVIEW_PENALTY * 2);
    expect(d.weaknesses).toEqual(["重试耗尽", "缺少单测"]); // 最新在前(unshift)
  });

  it("⑤ 纯任务完成数:仅 runCompleted=true 且仅记实际参与者,+XP_RUN_COMPLETED(五类里权重最小,防刷)", () => {
    const ev = baseEvidence();
    ev.runCompleted = true;
    ev.participantAgentIds = ["dev-1", "dev-1", "dev-2"]; // 重复 id 应去重
    const deltas = computeGrowthDelta(ev);
    expect(deltas).toHaveLength(2);
    for (const d of deltas) expect(d.xpDelta).toBe(XP_RUN_COMPLETED);
    // 防刷:run 完成 XP 是五类里数值最小的正向事件
    expect(XP_RUN_COMPLETED).toBeLessThan(XP_PROPOSAL_APPROVED);
    expect(XP_RUN_COMPLETED).toBeLessThan(XP_CITED_SUCCESS);
    expect(XP_RUN_COMPLETED).toBeLessThan(XP_SOP_PROMOTION);
  });

  it("⑤ runCompleted=false(run 失败/未完成)→ 不给任务完成 XP", () => {
    const ev = baseEvidence();
    ev.runCompleted = false;
    ev.participantAgentIds = ["dev-1"];
    expect(computeGrowthDelta(ev)).toEqual([]);
  });

  it("同一 agent 多类事件在同一 run 内可叠加", () => {
    const ev = baseEvidence();
    ev.runCompleted = true;
    ev.participantAgentIds = ["dev-1"];
    ev.proposals = [{ agentId: "dev-1", status: "committed" }];
    ev.reviews = [{ agentId: "dev-1", verdict: "needs_revision" }];
    const [d] = computeGrowthDelta(ev);
    expect(d.xpDelta).toBe(XP_RUN_COMPLETED + XP_PROPOSAL_APPROVED + XP_REVIEW_PENALTY);
    expect(d.events).toHaveLength(3);
  });
});

describe("computeLevel · 阈值曲线(level = 1 + floor(sqrt(xp/100)))", () => {
  it("边界值", () => {
    expect(computeLevel(0)).toBe(1);
    expect(computeLevel(99)).toBe(1);
    expect(computeLevel(100)).toBe(2);
    expect(computeLevel(399)).toBe(2);
    expect(computeLevel(400)).toBe(3);
    expect(computeLevel(900)).toBe(4);
  });
  it("负数 xp 不报错、按 0 处理", () => {
    expect(computeLevel(-50)).toBe(1);
  });
});

describe("applyGrowth · 读改写 agents.json + 旧数据兼容", () => {
  it("无 growth 字段的旧 agent → 首次写入从 0 开始累加", () => {
    saveAgents(root, [mkAgent("dev-1")]);
    applyGrowth(root, [{ agentId: "dev-1", xpDelta: 15, weaknesses: [], recentLessons: [], events: [] }]);
    const agents = loadAgents(root, []);
    expect(agents[0].growth).toEqual({ level: 1, xp: 15 });
  });

  it("已有 growth 的 agent → xp 累加、level 重算,weaknesses/recentLessons 新的在前并截断到上限", () => {
    saveAgents(root, [mkAgent("dev-1", { growth: { level: 2, xp: 120, weaknesses: ["旧1", "旧2"], recentLessons: ["旧教训"] } })]);
    applyGrowth(root, [{
      agentId: "dev-1", xpDelta: 300,
      weaknesses: ["新1"], recentLessons: ["新教训1", "新教训2"],
      events: [],
    }]);
    const agents = loadAgents(root, []);
    const g = agents[0].growth!;
    expect(g.xp).toBe(420);
    expect(g.level).toBe(computeLevel(420));
    expect(g.weaknesses).toEqual(["新1", "旧1", "旧2"]);
    expect(g.weaknesses!.length).toBeLessThanOrEqual(MAX_WEAKNESSES);
    expect(g.recentLessons).toEqual(["新教训1", "新教训2", "旧教训"].slice(0, MAX_RECENT_LESSONS));
  });

  it("xp 扣到负数 → 钳制在 0,不产生负数 XP", () => {
    saveAgents(root, [mkAgent("dev-1", { growth: { level: 1, xp: 5 } })]);
    applyGrowth(root, [{ agentId: "dev-1", xpDelta: -20, weaknesses: [], recentLessons: [], events: [] }]);
    expect(loadAgents(root, [])[0].growth!.xp).toBe(0);
  });

  it("delta 对应的 agentId 在 agents.json 里不存在 → 静默跳过,不报错、不影响其它 agent", () => {
    saveAgents(root, [mkAgent("dev-1")]);
    expect(() => applyGrowth(root, [{ agentId: "ghost", xpDelta: 10, weaknesses: [], recentLessons: [], events: [] }])).not.toThrow();
    expect(loadAgents(root, [])[0].growth).toBeUndefined();
  });

  it("保留其它 agent 不受影响(read-modify-write 覆盖全量 agents.json)", () => {
    saveAgents(root, [mkAgent("dev-1"), mkAgent("dev-2")]);
    applyGrowth(root, [{ agentId: "dev-1", xpDelta: 10, weaknesses: [], recentLessons: [], events: [] }]);
    const agents = loadAgents(root, []);
    expect(agents.find((a) => a.id === "dev-2")!.growth).toBeUndefined();
    expect(agents.find((a) => a.id === "dev-1")!.growth!.xp).toBe(10);
  });

  it("空 deltas 数组 → 不触碰磁盘(不覆写 agents.json)", () => {
    const before = JSON.stringify([mkAgent("dev-1")]);
    saveAgents(root, JSON.parse(before));
    const statBefore = fs.statSync(path.join(root, ".opc", "agents.json")).mtimeMs;
    applyGrowth(root, []);
    const statAfter = fs.statSync(path.join(root, ".opc", "agents.json")).mtimeMs;
    expect(statAfter).toBe(statBefore);
  });
});

describe("reconcileCitations · 跨 run 引用对账(registryStore procedural_skill 快照 diff)", () => {
  const agents: Array<Pick<AgentNodeConfig, "id" | "role" | "enabled">> = [{ id: "dev-1", role: "dev", enabled: true }];

  it("空 registry → 空对账结果", () => {
    expect(reconcileCitations(root, agents)).toEqual([]);
  });

  it("冷启动(该 skill 无快照基线)→ 不追溯记账,只落基线", () => {
    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-a"], status: "candidate",
    }, NOW);
    expect(reconcileCitations(root, agents)).toEqual([]); // 首次对账:落基线,不产出 XP
  });

  it("support 增长(未跨越 verified 阈值)→ citedDelta 命中,promoted=false", () => {
    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-a"], status: "candidate",
    }, NOW);
    reconcileCitations(root, agents); // 落基线(support=1, candidate)

    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-b"], status: "candidate",
    }, NOW); // support: 1→2,仍 candidate

    const result = reconcileCitations(root, agents);
    expect(result).toEqual([{ role: "dev", taskType: "coding", agentIds: ["dev-1"], citedDelta: 1, promoted: false }]);
  });

  it("support 跨越 verified 阈值(→3)→ citedDelta + promoted=true 同时命中", () => {
    const mk = (rid: string) => upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: [rid], status: "candidate",
    }, NOW);
    mk("run-a");
    reconcileCitations(root, agents); // 基线:support=1, candidate
    mk("run-b"); // support=2, candidate
    reconcileCitations(root, agents); // 基线更新:support=2, candidate
    mk("run-c"); // support=3 → registryStore 自动 promotion → verified

    const result = reconcileCitations(root, agents);
    expect(result).toEqual([{ role: "dev", taskType: "coding", agentIds: ["dev-1"], citedDelta: 1, promoted: true }]);
  });

  it("没有在编员工持有该 role → 跳过(不产出条目),但基线仍推进", () => {
    upsertProceduralSkill(root, {
      role: "security", taskType: "audit", preconditions: [], successfulSequence: ["scan"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-a"], status: "candidate",
    }, NOW);
    reconcileCitations(root, agents); // agents 里没有 security 角色
    upsertProceduralSkill(root, {
      role: "security", taskType: "audit", preconditions: [], successfulSequence: ["scan"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-b"], status: "candidate",
    }, NOW);
    expect(reconcileCitations(root, agents)).toEqual([]);
  });

  it("disabled 员工不归因(enabled:false 被排除)", () => {
    const disabledAgents = [{ id: "dev-1", role: "dev", enabled: false }];
    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-a"], status: "candidate",
    }, NOW);
    reconcileCitations(root, disabledAgents);
    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["run-b"], status: "candidate",
    }, NOW);
    expect(reconcileCitations(root, disabledAgents)).toEqual([]);
  });
});

describe("collectRunGrowthEvidence · 组装 orchestrator 收尾单一调用点的输入", () => {
  it("从 memory_proposals.json + traceEvents 里正确抽取 proposals/reviews,runCompleted 按 run.status 判定", () => {
    upsertMemoryProposals(root, "run-1", [{
      proposalId: "prop-1", runId: "run-1", source: "run_conclusion", content: "c", agentId: "lead-1",
      risk: "low", status: "committed", statusHistory: [], createdAt: NOW, updatedAt: NOW,
    }]);
    const ev = collectRunGrowthEvidence(root, {
      runId: "run-1",
      runStatus: "done",
      participantAgentIds: ["lead-1", "dev-1"],
      agents: [{ id: "lead-1", role: "lead", enabled: true }, { id: "dev-1", role: "dev", enabled: true }],
      traceEvents: [
        { type: "review_committed", payload: { agentId: "dev-1", verdict: "needs_revision", proposal: { reason: "缺测试" } } },
        { type: "info", payload: { message: "noise" } },
      ],
    });
    expect(ev.runCompleted).toBe(true);
    expect(ev.proposals).toEqual([{ agentId: "lead-1", status: "committed", source: "run_conclusion", content: "c" }]);
    expect(ev.reviews).toEqual([{ agentId: "dev-1", verdict: "needs_revision", reason: "缺测试" }]);
    expect(ev.participantAgentIds).toEqual(["lead-1", "dev-1"]);
  });

  it("runStatus !== 'done' → runCompleted=false", () => {
    const ev = collectRunGrowthEvidence(root, {
      runId: "run-x", runStatus: "failed", participantAgentIds: [], agents: [], traceEvents: [],
    });
    expect(ev.runCompleted).toBe(false);
  });

  it("C5·artifact mismatch:admission 拒收的 quality_gate_result 记为 failed 审查证据;passed=true / cross_verify / 无 producer 不收", () => {
    const ev = collectRunGrowthEvidence(root, {
      runId: "run-gate", runStatus: "failed", participantAgentIds: [], agents: [],
      traceEvents: [
        { type: "quality_gate_result", payload: { passed: false, stage: "admission", producer: "w-1", overallReason: "产出为空" } },
        { type: "quality_gate_result", payload: { passed: false, stage: "admission", producer: "w-2", overallReason: "测试: FAIL x.test.ts" } },
        { type: "quality_gate_result", payload: { passed: false, stage: "admission", producer: "w-3" } }, // 无 overallReason → 兜底文案
        { type: "quality_gate_result", payload: { passed: true, stage: "admission", producer: "w-ok", overallReason: "三层质量门全部通过" } },
        { type: "quality_gate_result", payload: { passed: false, stage: "cross_verify", producer: "w-cv", overallReason: "拒绝" } }, // 已由 review_committed 记账,不重复计罚
        { type: "quality_gate_result", payload: { passed: false, stage: "admission" } }, // 无 producer → 无人可记
      ],
    });
    expect(ev.reviews).toEqual([
      { agentId: "w-1", verdict: "failed", reason: "产出为空" },
      { agentId: "w-2", verdict: "failed", reason: "测试: FAIL x.test.ts" },
      { agentId: "w-3", verdict: "failed", reason: "产出未通过 admission 质量门" },
    ]);
  });

  it("C5·闭环:admission 拒收证据经 computeGrowthDelta → XP_REVIEW_PENALTY + 记 weakness", () => {
    const ev = collectRunGrowthEvidence(root, {
      runId: "run-gate2", runStatus: "failed", participantAgentIds: [], agents: [],
      traceEvents: [{ type: "quality_gate_result", payload: { passed: false, stage: "admission", producer: "w-1", overallReason: "产出为空" } }],
    });
    const [d] = computeGrowthDelta(ev);
    expect(d.agentId).toBe("w-1");
    expect(d.xpDelta).toBe(XP_REVIEW_PENALTY);
    expect(d.weaknesses).toEqual(["产出为空"]);
  });

  it("review_committed 与 admission 拒收同 run 并存 → 两类证据都收(互不吞并)", () => {
    const ev = collectRunGrowthEvidence(root, {
      runId: "run-mix", runStatus: "done", participantAgentIds: [], agents: [],
      traceEvents: [
        { type: "review_committed", payload: { agentId: "w-a", verdict: "needs_revision", proposal: { reason: "缺测试" } } },
        { type: "quality_gate_result", payload: { passed: false, stage: "admission", producer: "w-b", overallReason: "类型检查: Found 2 errors" } },
      ],
    });
    expect(ev.reviews).toEqual([
      { agentId: "w-a", verdict: "needs_revision", reason: "缺测试" },
      { agentId: "w-b", verdict: "failed", reason: "类型检查: Found 2 errors" },
    ]);
  });
});
