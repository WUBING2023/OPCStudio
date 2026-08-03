import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ceoRoutes 是纯只读聚合,依赖链里唯一的内存态来源是 orchestrator.getAgents —— mock 掉;
// missionBrief(经由 loadMissions 引入)的重型依赖(modelGateway/systemModel)也一并 mock
// (与 missionRoutes.test.ts 同一姿势)。missions.json / 运行索引 _index.json / run 目录证据文件 /
// cost.json 全部走临时目录真实读盘,验证的就是"聚合真数据"这条路。
const { mockAgents, mockCallModel } = vi.hoisted(() => ({
  mockAgents: [] as any[],
  mockCallModel: vi.fn(),
}));
vi.mock("../runtime/orchestrator.js", () => ({ getAgents: () => mockAgents }));
vi.mock("../runtime/modelGateway.js", () => ({ callModel: mockCallModel }));
vi.mock("../runtime/systemModel.js", () => ({
  resolveSystemModel: () => ({ provider: "deepseek", model: "deepseek-chat" }),
  inferSystemFramework: () => "hermes",
  resolveAutoSubscription: async (choice: unknown) => ({ kind: "keep", choice, reason: "has-key" }),
}));

import { register } from "./ceoRoutes.js";
import type { MissionBrief } from "../runtime/missionBrief.js";

let root: string;
let server: Server;
let baseUrl: string;

function setupRoot(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ceo-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
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

const ESTIMATE = {
  complexity: "M" as const,
  risk_level: "elevated" as const,
  estimated_duration: { min_minutes: 3, max_minutes: 8, confidence: "medium" as const },
  recommended_governance_level: 2 as const,
  reason: ["涉及代码/文件改动(调用方标记)"],
};

function mission(over: Partial<MissionBrief> = {}): MissionBrief {
  return {
    id: "m-1",
    companyId: "co1",
    createdAt: "2026-07-06T00:00:00Z",
    originalIdea: "做一个 todo app",
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

// 运行索引直接落 _index.json(Record<id, entry>,loadRunIndex 非空即不触发懒重建扫描)。
function writeRunIndex(entries: Array<Record<string, unknown> & { id: string }>) {
  const idx: Record<string, unknown> = {};
  for (const e of entries) idx[e.id] = e;
  fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "runs", "_index.json"), JSON.stringify(idx));
}

function writeRunDir(runId: string, files: Record<string, unknown>) {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
}

async function getStatus(query: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}/api/ceo/status${query}`);
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  mockAgents.length = 0;
  mockCallModel.mockReset();
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("GET /api/ceo/status — 参数校验", () => {
  it("缺 companyId → 400", async () => {
    setupRoot();
    await startTestServer();
    const { status, body } = await getStatus("");
    expect(status).toBe(400);
    expect(body.error).toMatch(/companyId/);
  });
});

describe("GET /api/ceo/status — 空公司返回空骨架,不 500", () => {
  it("无 mission/无 run/无 agent → 200 + 全空字段 + schemaVersion", async () => {
    setupRoot();
    await startTestServer();
    const { status, body } = await getStatus("?companyId=co-empty");
    expect(status).toBe(200);
    expect(body).toEqual({
      schemaVersion: "1",
      companyId: "co-empty",
      mission: null,
      waitingOn: [],
      activeRun: null,
      lastFailure: null,
      todayTokens: 0,
    });
  });
});

describe("GET /api/ceo/status — 聚合形状", () => {
  it("mission(E1 estimate 透传)+ waitingOn 按公司/状态过滤 + activeRun + lastFailure 带复盘摘要 + todayTokens", async () => {
    setupRoot();
    // 最新一条是 stopped(应跳过),其后是带 E1 estimate 的 draft(应命中);别家公司的不见。
    writeMissions([
      mission({ id: "m-stopped", approvalStatus: "stopped", createdAt: "2026-07-07T00:00:00Z" }),
      mission({ id: "m-live", complexityEstimate: ESTIMATE }),
      mission({ id: "m-other", companyId: "co2" }),
    ]);
    // 索引:co1 一个 running + 一个 failed;co2 的 failed 不该被看到。
    writeRunIndex([
      { id: "run-active-1", goal: "正在跑的任务", status: "running", startedAt: "2026-07-07T02:00:00Z", companyId: "co1" },
      { id: "run-failed-1", goal: "挂了的任务", status: "failed", startedAt: "2026-07-07T01:00:00Z", endedAt: "2026-07-07T01:05:00Z", companyId: "co1" },
      { id: "run-failed-2", goal: "别家公司的失败", status: "failed", startedAt: "2026-07-07T01:30:00Z", companyId: "co2" },
    ]);
    // failed run 的证据文件 → buildPostmortem 可派生出 provider_key 原因(C1 验收样例同款)。
    writeRunDir("run-failed-1", {
      "task.json": { id: "run-failed-1", userGoal: "挂了的任务", status: "failed", companyId: "co1", startedAt: "2026-07-07T01:00:00Z" },
      "deferred.json": [{ agentId: "a-dev", taskId: "t1", reason: "provider_unavailable", lastError: "Provider unavailable: deepseek — missing API key" }],
    });
    // 今日成本:cost.json 一条今天的调用记录(computeCostTimeseries 按 call.startedAt 归日)。
    writeRunDir("run-active-1", {
      "task.json": { id: "run-active-1", userGoal: "正在跑的任务", status: "running", companyId: "co1", startedAt: "2026-07-07T02:00:00Z" },
      "cost.json": [{ agentId: "a-dev", provider: "deepseek", model: "deepseek-chat", totalTokens: 1000, estimatedCostUsd: 0.5, startedAt: new Date().toISOString() }],
    });
    mockAgents.push(
      { id: "a-dev", name: "小王", role: "dev", status: "working", companyId: "co1", currentTask: "写代码" },
      { id: "a-idle", name: "小李", role: "test", status: "idle", companyId: "co1" },
      { id: "a-else", name: "外人", role: "dev", status: "working", companyId: "co2" },
    );
    await startTestServer();

    const { status, body } = await getStatus("?companyId=co1");
    expect(status).toBe(200);
    expect(body.schemaVersion).toBe("1");

    // mission:跳过 stopped,取 m-live,E1 字段原样透传
    expect(body.mission.id).toBe("m-live");
    expect(body.mission.goal).toBe("开发一个简单的待办事项管理应用");
    expect(body.mission.approvalStatus).toBe("draft");
    expect(body.mission.complexityEstimate).toEqual(ESTIMATE);

    // waitingOn:只有本公司 working 的 agent,带 currentActivity
    expect(body.waitingOn).toEqual([{ id: "a-dev", name: "小王", role: "dev", currentActivity: "写代码" }]);

    // activeRun:索引里的 running run
    expect(body.activeRun).toEqual({ runId: "run-active-1", startedAt: "2026-07-07T02:00:00Z", goal: "正在跑的任务" });

    // lastFailure:本公司最近 failed run + buildPostmortem 派生的首要原因/建议
    expect(body.lastFailure.runId).toBe("run-failed-1");
    expect(body.lastFailure.endedAt).toBe("2026-07-07T01:05:00Z");
    expect(body.lastFailure.postmortemAvailable).toBe(true);
    expect(body.lastFailure.topCause).toContain("DeepSeek");
    expect(body.lastFailure.topCause).toContain("小王");
    expect(typeof body.lastFailure.topSuggestion).toBe("string");
    expect(body.lastFailure.topSuggestion.length).toBeGreaterThan(0);
    // #32:结构化键随聚合透传,前端按 postmortem.cause.*/postmortem.suggestion.* 词典渲染
    expect(body.lastFailure.topCauseKey).toBe("provider_key");
    expect(body.lastFailure.topCauseParams).toEqual({ who: "小王", provider: "DeepSeek" });
    expect(body.lastFailure.topSuggestionKey).toBe("configure_key");
    expect(body.lastFailure.topSuggestionParams).toEqual({ provider: "DeepSeek" });

    // todayTokens:今天那条 1000 token 计入
    expect(body.todayTokens).toBe(1000);
  });

  it("旧 mission 无 complexityEstimate → mission.complexityEstimate 为 null;failed run 无证据文件 → postmortemAvailable:false 不 500", async () => {
    setupRoot();
    writeMissions([mission({ id: "m-legacy" })]);
    // 索引里有 failed run,但 run 目录不存在(task.json 缺失 → buildPostmortem 返回 null)。
    writeRunIndex([
      { id: "run-gone-12", goal: "索引残留", status: "failed", startedAt: "2026-07-01T00:00:00Z", companyId: "co1" },
    ]);
    await startTestServer();

    const { status, body } = await getStatus("?companyId=co1");
    expect(status).toBe(200);
    expect(body.mission.id).toBe("m-legacy");
    expect(body.mission.complexityEstimate).toBeNull();
    expect(body.lastFailure).toEqual({ runId: "run-gone-12", endedAt: undefined, postmortemAvailable: false });
    expect(body.activeRun).toBeNull();
  });
});
