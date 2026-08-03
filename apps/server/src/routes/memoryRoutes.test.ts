// A1-V2 · 记忆提案审批端点:pending 提案的 approve/reject(run 级 memory_proposals.json + proposed lesson)。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// memoryRoutes 只从 orchestrator 读 getAgents(agent 列表)——mock 成纯内存实现,
// 避免 import 整个 orchestrator(模块级副作用/重依赖),与 taskRoutes.test.ts 同一做法。
// C6 · bind-agent 端点需要校验 agentId 真实存在,固定一份最小 agent 列表供其测试使用。
vi.mock("../runtime/orchestrator.js", () => ({ getAgents: () => [{ id: "w1", role: "test" }, { id: "w2", role: "test" }] }));

import { classifyPendingMemoryReview, register } from "./memoryRoutes.js";
import { upsertMemoryProposals, loadMemoryProposals } from "../storage/projectStore.js";
import { commitLesson, loadLessons, type FailureMode } from "../storage/reflectionStore.js";
import { appendReuseOutcomes } from "../storage/memoryReuseStore.js";
import { listGovernedMemoryProposals } from "../runtime/memoryGovernance.js";

const NOW = "2026-07-07T00:00:00.000Z";
const RUN_ID = "run-a1v2-test";

let root: string;
let server: Server;
let baseUrl: string;

async function startServer(r: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, r);
  const srv = createServer(app);
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server: srv, baseUrl: `http://127.0.0.1:${port}` };
}

// MUP B7:run-scoped GET 现在要求 run 真实存在(task.json 落盘,与 runRoutes.runExists 同源判据)。
function seedRunTask(runId = RUN_ID) {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: runId, goal: "test run", status: "done", startedAt: NOW }), "utf-8");
}

function seedCompanyRun(runId: string, companyId: string) {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
    id: runId, goal: "company run", status: "done", startedAt: NOW, companyId,
  }), "utf-8");
}

function seedCompanyProposal(runId: string, companyId: string, overrides: Record<string, unknown> = {}) {
  seedCompanyRun(runId, companyId);
  upsertMemoryProposals(root, runId, [{
    proposalId: `prop-${runId}`,
    runId,
    companyId,
    source: "run_conclusion",
    scope: "project",
    type: "run_conclusion",
    content: `memory for ${companyId}`,
    risk: "low",
    status: "pending",
    statusHistory: [{ status: "pending", at: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as any]);
}

function seedPendingConclusion(proposalId = "prop-hi") {
  seedRunTask();
  upsertMemoryProposals(root, RUN_ID, [{
    proposalId, runId: RUN_ID, source: "run_conclusion",
    scope: "project", type: "run_conclusion",
    content: "结论提到需要开放写权限,命中高风险关键词", proposedBy: "lead-1", role: "lead", agentId: "lead-1",
    confidence: 1, tags: ["部署"],
    sourceArtifactRefs: ["art-abc-1", "art-abc-2"], taskType: "coding", // D2:溯源 + 任务类型
    risk: "high", riskReasons: ["content_keyword"],
    status: "pending", statusHistory: [{ status: "pending", at: NOW }],
    createdAt: NOW, updatedAt: NOW,
  }]);
}

const highRiskLesson = (): Parameters<typeof commitLesson>[1] => ({
  kind: "risk_warning" as const,
  scope: { companyId: "co1", teamId: "lead-1", role: "test", agentId: "w1", taskType: "fact_check" },
  trigger: { eventTypes: [], failureMode: "timeout" as FailureMode, conditionText: "多来源核查一次调用超 200s" },
  diagnosis: "核查任务一次吃下全部来源,单次调用过大",
  lesson: "多来源核查应按来源拆分,不要一次核查全部",
  recommendedChange: "每子任务限单来源;超时前先写 partial.md",
  injection: { strength: "warning" as const, promptText: "上次核查超时,这次按来源拆小步并提前写 partial" },
  evidence: { runId: RUN_ID, agentId: "w1" },
  confidence: 0.7,
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memroutes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  ({ server, baseUrl } = await startServer(root));
});
afterEach(() => { server.close(); });

describe("GET /api/runs/:id/memory-proposals", () => {
  it("返回 run 台账数组 + X-Pending-Count 头;非法 runId → 400", async () => {
    seedPendingConclusion();
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals`);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown[];
    expect(body).toHaveLength(1);
    expect(res.headers.get("X-Pending-Count")).toBe("1"); // D2:pending 计数走响应头(body 仍是数组)
    const bad = await fetch(`${baseUrl}/api/runs/..%2F..%2Fetc/memory-proposals`);
    expect(bad.status).toBe(400);
  });

  it("run 存在但无台账 → 200 空数组(不因数据少而 404)", async () => {
    seedRunTask();
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(res.headers.get("X-Pending-Count")).toBe("0");
  });
});

// MUP B7 · 契约:不存在的 run(task.json 未落盘)一律 404 {error:"run not found"};
// 非法 id 仍 400 先于 404(口径同 runRoutes.test.ts 参数化套件)。
describe("memory review triage", () => {
  const proposal = (overrides: Record<string, unknown> = {}) => ({
    proposalId: "prop-triage", runId: "run-triage", source: "run_conclusion",
    content: "candidate", risk: "low", status: "pending", statusHistory: [],
    createdAt: NOW, updatedAt: NOW, ...overrides,
  } as any);

  it("only queues successful high-risk conclusions as key decisions", () => {
    expect(classifyPendingMemoryReview(proposal({ risk: "high" }), { status: "done" }).reviewPriority).toBe("key");
    expect(classifyPendingMemoryReview(proposal({ risk: "high" }), { status: "failed" }).reviewPriority).toBe("background");
    expect(classifyPendingMemoryReview(proposal(), { status: "done" }).reviewPriority).toBe("background");
  });

  it("queues repeated or substantive lessons but keeps one-off system failures in the background", () => {
    const repeated = proposal({ source: "reflection_lesson", kind: "failure_lesson" });
    expect(classifyPendingMemoryReview(repeated, { status: "failed" }, 2)).toMatchObject({ reviewPriority: "key", reviewReason: "repeated_lesson" });
    const systemNoise = proposal({ source: "reflection_lesson", kind: "failure_lesson", risk: "high", riskReasons: ["system_failure_mode"] });
    expect(classifyPendingMemoryReview(systemNoise, { status: "failed" }, 1).reviewPriority).toBe("background");
    const policy = proposal({ source: "reflection_lesson", kind: "policy_candidate", risk: "high", riskReasons: ["content_keyword"] });
    expect(classifyPendingMemoryReview(policy, { status: "failed" }, 1).reviewPriority).toBe("key");
  });
});
describe("GET /api/memory/run-proposals", () => {
  it("returns all pending proposals when companyId is omitted (batch mode)", async () => {
    seedCompanyProposal("run-batch-a-0001", "co-a", { proposalId: "prop-batch-a" });
    seedCompanyProposal("run-batch-b-0001", "co-b", { proposalId: "prop-batch-b" });

    const res = await fetch(`${baseUrl}/api/memory/run-proposals`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    const ids = body.map((r: any) => r.proposalId);
    expect(ids).toContain("prop-batch-a");
    expect(ids).toContain("prop-batch-b");
  });

  it("deduplicates the same lesson proposal recorded by multiple runs", async () => {
    seedCompanyProposal("run-dedupe-a-0001", "co-a", { proposalId: "lesson-shared", source: "reflection_lesson" });
    seedCompanyProposal("run-dedupe-a-0002", "co-a", { proposalId: "lesson-shared", source: "reflection_lesson" });

    const res = await fetch(`${baseUrl}/api/memory/run-proposals?companyId=co-a`);
    const body = await res.json() as Array<{ proposalId: string }>;
    expect(body.filter((proposal) => proposal.proposalId === "lesson-shared")).toHaveLength(1);
  });
  it("lists only pending proposals owned by the requested company", async () => {
    seedCompanyProposal("run-company-a-0001", "co-a", { proposalId: "prop-a" });
    seedCompanyProposal("run-company-b-0001", "co-b", { proposalId: "prop-b" });
    seedCompanyProposal("run-company-a-0002", "co-a", { proposalId: "prop-committed", status: "committed" });
    seedCompanyProposal("run-company-a-0003", "co-a", { proposalId: "prop-spoofed", companyId: "co-b" });
    seedCompanyProposal("run-company-a-0004", "co-a", { proposalId: "prop-wrong-run", runId: "run-company-b-0001" });

    const res = await fetch(`${baseUrl}/api/memory/run-proposals?companyId=co-a`);
    expect(res.status).toBe(200);
    const body = await res.json() as Array<Record<string, unknown>>;
    expect(body).toEqual([expect.objectContaining({
      runId: "run-company-a-0001",
      proposalId: "prop-a",
      companyId: "co-a",
      kind: "run_conclusion",
      content: "memory for co-a",
      risk: "low",
      status: "pending",
      source: "run_conclusion",
    })]);
    expect(JSON.stringify(body)).not.toContain("co-b");
  });

  it("disappears from the queue after approval and enters committed memory", async () => {
    const runId = "run-company-a-0005";
    seedCompanyProposal(runId, "co-a", { proposalId: "prop-approve" });

    const approve = await fetch(`${baseUrl}/api/runs/${runId}/memory-proposals/prop-approve/approve`, { method: "POST" });
    expect(approve.status).toBe(200);

    const listed = await fetch(`${baseUrl}/api/memory/run-proposals?companyId=co-a`);
    expect(await listed.json()).toEqual([]);
    const committed = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", runId, "committed-memories.json"), "utf-8"));
    expect(committed).toEqual([expect.objectContaining({
      companyId: "co-a", content: "memory for co-a", approvedBy: "human",
    })]);
  });
});

describe("MUP B7 · memoryRoutes run-scoped GET 404 收口", () => {
  const MISSING_RUN = "run-does-not-exist-404";
  it.each(["memory-proposals", "memory-pack"])("GET /api/runs/<missing>/%s → 404", async (suffix) => {
    const res = await fetch(`${baseUrl}/api/runs/${MISSING_RUN}/${suffix}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "run not found" });
  });
  it.each(["memory-proposals", "memory-pack"])("GET /api/runs/<非法id>/%s → 400(先于 404)", async (suffix) => {
    const res = await fetch(`${baseUrl}/api/runs/..%2F..%2Fetc/${suffix}`);
    expect(res.status).toBe(400);
  });
  it("run 存在 → memory-pack 200(零使用也不 404)", async () => {
    seedRunTask();
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-pack`);
    expect(res.status).toBe(200);
  });
});

describe("POST /api/runs/:id/memory-proposals/:pid/approve", () => {
  it("pending run_conclusion → committed:台账更新 + committed-memories.json 追加入库", async () => {
    seedPendingConclusion();
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-hi/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; memoryId: string; statusHistory: Array<{ status: string; by?: string }> };
    expect(body.status).toBe("committed");
    expect(body.statusHistory.map((h) => h.status)).toEqual(["pending", "approved", "committed"]);
    expect(body.statusHistory.at(-1)?.by).toBe("human");
    // 入库:committed-memories.json 出现同 memoryId 条目(跨 run 检索即刻可见)
    const cm = JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", RUN_ID, "committed-memories.json"), "utf-8"));
    expect(cm).toHaveLength(1);
    expect(cm[0]).toMatchObject({ memoryId: body.memoryId, type: "run_conclusion", approvedBy: "human", content: expect.stringContaining("写权限") });
    // D2:sourceArtifactRefs/taskType 完整透传进 committed-memories.json(不再硬编码 [])
    expect(cm[0].sourceArtifactRefs).toEqual(["art-abc-1", "art-abc-2"]);
    expect(cm[0].taskType).toBe("coding");
    // 台账同步
    expect(loadMemoryProposals(root, RUN_ID)[0].status).toBe("committed");
  });

  it("重复 approve / 不存在的 proposal → 404", async () => {
    seedPendingConclusion();
    await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-hi/approve`, { method: "POST" });
    const again = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-hi/approve`, { method: "POST" });
    expect(again.status).toBe(404);
    const nope = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-nope/approve`, { method: "POST" });
    expect(nope.status).toBe(404);
  });
});

describe("POST /api/runs/:id/memory-proposals/:pid/reject", () => {
  it("pending → rejected:不入库(committed-memories.json 不产生)", async () => {
    seedPendingConclusion();
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-hi/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe("rejected");
    expect(fs.existsSync(path.join(root, ".opc", "runs", RUN_ID, "committed-memories.json"))).toBe(false);
    // 拒绝后不可再 approve
    const after = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/prop-hi/approve`, { method: "POST" });
    expect(after.status).toBe(404);
  });
});

describe("POST /api/memory/lessons/:id/approve|reject — proposed lesson 人工审批", () => {
  it("approve:proposed → committed(approvedBy=human)", async () => {
    const saved = commitLesson(root, highRiskLesson(), NOW)!;
    expect(saved.status).toBe("proposed"); // risk_warning 停 pending 人审
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; approvedBy: string };
    expect(body.status).toBe("committed");
    expect(body.approvedBy).toBe("human");
    expect(loadLessons(root)[0].status).toBe("committed");
  });

  it("reject:proposed → revoked 终态", async () => {
    const saved = commitLesson(root, highRiskLesson(), NOW)!;
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(loadLessons(root)[0].status).toBe("revoked");
  });

  it("非 proposed(已生效)或不存在 → 404", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const;
    const saved = commitLesson(root, low, NOW)!; // 低风险自动 committed
    expect(saved.status).toBe("committed");
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/approve`, { method: "POST" });
    expect(res.status).toBe(404);
    const nope = await fetch(`${baseUrl}/api/memory/lessons/lesson-nope/approve`, { method: "POST" });
    expect(nope.status).toBe(404);
  });

  it("run 级端点也能审批 lesson 提案(source=reflection_lesson 转交 reflectionStore)", async () => {
    const saved = commitLesson(root, highRiskLesson(), NOW)!; // 落台账 status=pending
    const res = await fetch(`${baseUrl}/api/runs/${RUN_ID}/memory-proposals/${saved.id}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; source: string };
    expect(body.status).toBe("committed");
    expect(body.source).toBe("reflection_lesson");
    expect(loadLessons(root)[0].status).toBe("committed"); // 正主 lessons.jsonl 同步生效
  });
});

describe("POST /api/memory/lessons — 手工输入统一进入受治理记忆", () => {
  const post = (body: unknown) => fetch(`${baseUrl}/api/memory/lessons`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });

  it("默认只建 governed proposal,不再双写 reflectionStore/run 旧台账", async () => {
    const res = await post({
      content: "多来源核查一次调用超时:应按来源拆分子任务,超时前先写 partial.md",
      runId: RUN_ID, scope: { companyId: "co1" }, tags: ["postmortem", "timeout"],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { proposalId: string; status: string; objectType: string; scope: string; scopeId: string; content: string };
    expect(body).toMatchObject({ status: "proposed", objectType: "failure_lesson", scope: "company", scopeId: "co1" });
    expect(body.content).toContain("按来源拆分");
    expect(listGovernedMemoryProposals(root)).toMatchObject([{ proposalId: body.proposalId, status: "proposed" }]);
    expect(loadLessons(root)).toHaveLength(0);
    expect(loadMemoryProposals(root, RUN_ID)).toHaveLength(0);
  });

  it("asProposal:false 只请求自动专家审核,失败教训缺根因/反例时仍不能自动批准", async () => {
    const res = await post({
      content: "多来源核查一次调用超时:应按来源拆分子任务,超时前先写 partial.md",
      runId: RUN_ID, scope: { companyId: "co1" }, tags: ["postmortem", "timeout"], asProposal: false,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { proposalId: string; status: string; reasons: string[]; memoryId?: string };
    expect(body.status).toBe("proposed");
    expect(body.memoryId).toBeUndefined();
    expect(body.reasons).toContain("failure_lesson_requires_confirmed_root_cause_and_run_evidence");
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);
    expect(loadLessons(root)).toHaveLength(0);
  });

  it("P2#7 asProposal:true(失败复盘卡)→ 只建 proposed 提案", async () => {
    const res = await post({
      content: "基础设施故障复盘:ACP WebSocket 传输超时致辅助 worker deferred,应改用 API 直连或重试",
      runId: RUN_ID, scope: { companyId: "co1" }, tags: ["postmortem", "provider_unavailable"], asProposal: true,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { proposalId: string; status: string; objectType: string; memoryId?: string };
    expect(body).toMatchObject({ status: "proposed", objectType: "failure_lesson" });
    expect(body.memoryId).toBeUndefined();
    expect(listGovernedMemoryProposals(root)).toMatchObject([{ proposalId: body.proposalId, status: "proposed" }]);
    expect(loadLessons(root)).toHaveLength(0);
  });

  it("空/缺 content → 400,不入库", async () => {
    const blank = await post({ content: "   ", runId: RUN_ID });
    expect(blank.status).toBe(400);
    const missing = await post({ runId: RUN_ID });
    expect(missing.status).toBe(400);
    expect(loadLessons(root)).toHaveLength(0);
    expect(listGovernedMemoryProposals(root)).toHaveLength(0);
    expect(loadMemoryProposals(root, RUN_ID)).toHaveLength(0);
  });

  it("非法 runId → 400;不带 runId 也能建(不落任何 run 台账)", async () => {
    const bad = await post({ content: "多来源核查应按来源拆分子任务并提前写 partial", runId: "../etc" });
    expect(bad.status).toBe(400);
    const ok = await post({ content: "多来源核查应按来源拆分子任务并提前写 partial" });
    expect(ok.status).toBe(200);
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);
    expect(loadLessons(root)).toHaveLength(0);
    expect(fs.existsSync(path.join(root, ".opc", "runs"))).toBe(false);
  });

  it("完全重复输入幂等返回原提案,不堆第二条审核项", async () => {
    const content = "多来源核查一次调用超时:应按来源拆分子任务,超时前先写 partial.md";
    const first = await post({ content, asProposal: true });
    expect(first.status).toBe(200);
    const v1 = await first.json() as { proposalId: string; status: string };
    const second = await post({ content, asProposal: true });
    expect(second.status).toBe(200);
    const v2 = await second.json() as { proposalId: string; status: string; reasons: string[] };
    expect(v1.status).toBe("proposed");
    expect(v2.status).toBe("proposed");
    expect(v2.reasons).toContain("idempotent_existing");
    expect(v2.proposalId).toBe(v1.proposalId);
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);
  });

  it("仅描述未配置凭据的运维建议可进入待审,不误判为密钥泄露", async () => {
    const res = await post({ content: "任务「注意核对财报数字」失败:DeepSeek API Key 未配置,应在 API 页配置或切换供应商" });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; reasons: string[] };
    expect(body.status).toBe("proposed");
    expect(body.reasons).not.toContain("sensitive_content");
    expect(listGovernedMemoryProposals(root)).toHaveLength(1);
  });
});

// C6 · 记忆页/员工详情"应用到员工训练":把经验强绑定到指定员工的写接口。
describe("POST /api/memory/lessons/:id/bind-agent — C6 一键应用到员工训练", () => {
  it("绑定成功:boundAgentIds 追加 + lifecycle 留痕", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const; // 低风险自动 committed
    const saved = commitLesson(root, low, NOW)!;
    expect(saved.status).toBe("committed");
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { boundAgentIds: string[]; lifecycle: Array<{ status: string; by?: string }> };
    expect(body.boundAgentIds).toEqual(["w1"]);
    expect(body.lifecycle.at(-1)).toMatchObject({ status: "bound:w1", by: "human" });
    // 落盘同步
    expect(loadLessons(root)[0].boundAgentIds).toEqual(["w1"]);
  });

  it("重复绑定同一员工 → 幂等(不重复追加)", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const;
    const saved = commitLesson(root, low, NOW)!;
    const bind = () => fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w1" }),
    });
    await bind();
    const res = await bind();
    const body = await res.json() as { boundAgentIds: string[] };
    expect(body.boundAgentIds).toEqual(["w1"]);
  });

  it("可绑定给多个员工", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const;
    const saved = commitLesson(root, low, NOW)!;
    await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w1" }),
    });
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w2" }),
    });
    const body = await res.json() as { boundAgentIds: string[] };
    expect(body.boundAgentIds.sort()).toEqual(["w1", "w2"]);
  });

  it("agentId 缺失/为空 → 400", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const;
    const saved = commitLesson(root, low, NOW)!;
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("agentId 不是真实存在的员工 → 400,不写入", async () => {
    const low = highRiskLesson(); low.kind = "failure_lesson" as const;
    const saved = commitLesson(root, low, NOW)!;
    const res = await fetch(`${baseUrl}/api/memory/lessons/${saved.id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "ghost" }),
    });
    expect(res.status).toBe(400);
    expect(loadLessons(root)[0].boundAgentIds).toBeUndefined();
  });

  it("lesson 不存在 → 404", async () => {
    const res = await fetch(`${baseUrl}/api/memory/lessons/lesson-nope/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w1" }),
    });
    expect(res.status).toBe(404);
  });

  it("revoked(终态)经验不可再绑定 → 404", async () => {
    const content = "单文件任务必须限制输出文件名,禁止生成额外文件";
    const post = await fetch(`${baseUrl}/api/memory/lessons`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }),
    });
    const { id } = await post.json() as { id: string };
    await fetch(`${baseUrl}/api/memory/lessons/${id}/revoke`, { method: "POST" });
    const res = await fetch(`${baseUrl}/api/memory/lessons/${id}/bind-agent`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: "w1" }),
    });
    expect(res.status).toBe(404);
  });
});


// D3 · 复用验证回路只读聚合端点(reuse-log.jsonl → 每条记忆的 injected/cleanRuns/failedRuns)。
describe("GET /api/memory/reuse-stats", () => {
  it("无日志 → 空 stats;有日志 → run 粒度聚合", async () => {
    const empty = await fetch(`${baseUrl}/api/memory/reuse-stats`);
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { stats: unknown[] }).stats).toEqual([]);

    appendReuseOutcomes(root, [
      { runId: "r1", agentId: "lead-1", role: "lead", memoryId: "mem-a", kind: "committed", taskType: "coding", runStatus: "done", degraded: false, at: NOW },
      { runId: "r2", agentId: "lead-1", role: "lead", memoryId: "mem-a", kind: "committed", taskType: "coding", runStatus: "failed", degraded: false, at: NOW },
    ]);
    const res = await fetch(`${baseUrl}/api/memory/reuse-stats`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: Array<{ memoryId: string; injected: number; cleanRuns: number; failedRuns: number }>; generatedAt: string };
    expect(body.stats).toEqual([{ memoryId: "mem-a", injected: 2, cleanRuns: 1, failedRuns: 1 }]);
    expect(typeof body.generatedAt).toBe("string");
  });
});
// Memory architecture v2: natural-language capture, policy caps, layered Markdown and FTS.
describe("memory governance v2 routes", () => {
  it("creates a scoped proposal, approves it, and exposes its Markdown index and search result", async () => {
    const policyRes = await fetch(`${baseUrl}/api/memory/policy`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoApprove: false, autoModelMerge: true, maxCandidates: 999, maxPromptItems: 999, maxPromptChars: 999999 }),
    });
    expect(policyRes.status).toBe(200);
    expect(await policyRes.json()).toMatchObject({ autoApprove: false, autoModelMerge: true, maxCandidates: 100, maxPromptItems: 20, maxPromptChars: 8000 });

    const remember = await fetch(`${baseUrl}/api/memory/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "remember that my reports put conclusions before evidence", objectType: "user_preference", autoApprove: false }),
    });
    expect(remember.status).toBe(202);
    const proposal = await remember.json() as { proposalId: string; status: string; scope: string; scopeId: string };
    expect(proposal).toMatchObject({ status: "proposed", scope: "user", scopeId: "local-user" });

    const approve = await fetch(`${baseUrl}/api/memory/proposals-v2/${proposal.proposalId}/approve`, { method: "POST" });
    expect(approve.status).toBe(200);
    const approved = await approve.json() as { status: string; memoryId: string };
    expect(approved.status).toBe("approved");
    expect(approved.memoryId).toMatch(/^mem-/);

    const index = await fetch(`${baseUrl}/api/memory/layer-index/user/local-user`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain(approved.memoryId);
    const search = await fetch(`${baseUrl}/api/memory/search-v2?goal=${encodeURIComponent("reports conclusions evidence")}&scope=user&scopeId=local-user`);
    expect(search.status).toBe(200);
    expect((await search.json()) as Array<{ memoryId: string }>).toEqual(expect.arrayContaining([expect.objectContaining({ memoryId: approved.memoryId })]));
  });

  it("rejects secret-bearing memory without persisting the plaintext proposal", async () => {
    const secret = "remember API key sk-this-must-never-reach-memory-storage";
    const remember = await fetch(`${baseUrl}/api/memory/remember`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: secret, autoApprove: false }),
    });
    expect(remember.status).toBe(202);
    expect(await remember.json()).toMatchObject({ status: "rejected", reasons: expect.arrayContaining(["sensitive_content"]) });
    const proposals = await fetch(`${baseUrl}/api/memory/proposals-v2`);
    expect(JSON.stringify(await proposals.json())).not.toContain("sk-this-must-never");
  });

  it("exposes Memory Doctor and validates paired scope parameters", async () => {
    const response = await fetch(`${baseUrl}/api/memory/doctor`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      promptPolicy: { maxCandidates: 100, maxInjectedItems: 20, maxInjectedChars: 8000 },
    });
    const bad = await fetch(`${baseUrl}/api/memory/doctor?scope=company`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "scope and scopeId must be supplied together" });
  });

  it("audits and idempotently migrates legacy records as proposed memories", async () => {
    const legacyFile = path.join(root, ".opc", "memory", "project.jsonl");
    fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
    fs.writeFileSync(legacyFile, JSON.stringify({
      id: "legacy-route-1",
      agentRole: "dev",
      companyId: "co-route",
      goalSlug: "route-migration",
      text: "Keep parser retries bounded and validate every delimiter.",
      tags: ["parser"],
      source: { runId: "run-route-legacy", agentId: "dev-1", type: "run" },
      createdAt: NOW,
      hits: 0,
    }) + "\n", "utf-8");

    const audit = await fetch(`${baseUrl}/api/memory/migration-report`);
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({
      mode: "legacy_read_only",
      state: "migration_pending",
      pendingMigrationCount: 1,
    });

    const first = await fetch(`${baseUrl}/api/memory/migrate-legacy`, { method: "POST" });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "completed",
      proposedCount: 1,
      failedCount: 0,
    });

    const second = await fetch(`${baseUrl}/api/memory/migrate-legacy`, { method: "POST" });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({
      status: "no_op",
      proposedCount: 0,
      skippedDuplicateCount: 1,
    });

    const proposals = await fetch(`${baseUrl}/api/memory/proposals-v2`);
    expect(proposals.status).toBe(200);
    expect(await proposals.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: "proposed",
        sourceType: "import",
        scope: "company",
        scopeId: "co-route",
      }),
    ]));
  });
});
