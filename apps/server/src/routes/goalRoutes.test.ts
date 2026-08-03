import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// goalRunner 的 startGoal 会真起 harness 多轮推进(模型外呼)——mock 成"只写 goals.json 并返回记录",
// loadGoals 保持与真实实现同款的文件读取(路由的 attachGoalEstimate 靠它做读-改-写),
// 这样测试验证的是 E1 estimate 在 goals.json 上的真实落盘行为,而不是纯内存假象。
const { mockStartGoal } = vi.hoisted(() => ({ mockStartGoal: vi.fn() }));
vi.mock("../runtime/goalRunner.js", async () => {
  const fsm = await import("node:fs");
  const pathm = await import("node:path");
  return {
    loadGoals: (root: string) => {
      try { return JSON.parse(fsm.readFileSync(pathm.join(root, ".opc", "goals.json"), "utf-8")); } catch { return []; }
    },
    startGoal: mockStartGoal,
    requestStopGoal: vi.fn(),
    isGoalInFlight: () => false,
    signalContinueGoal: vi.fn(),
    pushGoalFeedback: vi.fn(),
  };
});

import { registerGoalRoutes } from "./goalRoutes.js";

let root: string;
let server: Server;
let baseUrl: string;

const goalsFile = () => path.join(root, ".opc", "goals.json");

// 旧数据形状:E1 之前的 goal 记录,无 complexityEstimate 字段。
function legacyGoal(id: string, over: Record<string, unknown> = {}) {
  return {
    id, goal: "老目标", status: "achieved", maxRounds: 3, rounds: [],
    createdAt: "2026-07-01T00:00:00Z", ...over,
  };
}

function setupRoot(agentCount = 0): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "goal-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  if (agentCount > 0) {
    const agents = Array.from({ length: agentCount }, (_, i) => ({ id: `a-${i}`, name: `A${i}`, role: "dev", companyId: "co1" }));
    fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
  }
}

async function startTestServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  registerGoalRoutes(app, root);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  mockStartGoal.mockReset();
  // 默认实现:与真实 startGoal 一致地把新记录 unshift 进 goals.json 再返回(不起 harness)。
  mockStartGoal.mockImplementation((r: string, goal: string, opts?: { companyId?: string }) => {
    const rec = {
      id: "g-new", goal, companyId: opts?.companyId, status: "running",
      maxRounds: 3, rounds: [], createdAt: new Date().toISOString(),
    };
    let all: unknown[] = [];
    try { all = JSON.parse(fs.readFileSync(path.join(r, ".opc", "goals.json"), "utf-8")); } catch { /* */ }
    fs.writeFileSync(path.join(r, ".opc", "goals.json"), JSON.stringify([rec, ...all]));
    return rec;
  });
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("POST /api/goals — 创建即写入 complexityEstimate", () => {
  it("返回体带 estimate,goals.json 里新记录持久化同一份,旧记录保持无字段", async () => {
    setupRoot(4); // co1 下 4 名 agent → 触发多角色协作规则
    fs.writeFileSync(goalsFile(), JSON.stringify([legacyGoal("g-old")]));
    await startTestServer();

    const res = await fetch(`${baseUrl}/api/goals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "调研三家竞品并输出对比报告", companyId: "co1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("g-new");
    expect(body.complexityEstimate).toBeDefined();
    expect(["S", "M", "L", "XL"]).toContain(body.complexityEstimate.complexity);
    expect(body.complexityEstimate.reason.some((r: string) => r.includes("调研/分析类关键词"))).toBe(true);
    expect(body.complexityEstimate.reason.some((r: string) => r.includes("4 名 agent"))).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(goalsFile(), "utf-8"));
    const rec = onDisk.find((g: any) => g.id === "g-new");
    expect(rec.complexityEstimate).toEqual(body.complexityEstimate);
    // 旧记录不被改写,依旧没有 complexityEstimate 字段(向后兼容)
    const old = onDisk.find((g: any) => g.id === "g-old");
    expect(old).toBeDefined();
    expect("complexityEstimate" in old).toBe(false);
  });

  it("startGoal 未落盘时 attach 静默跳过,响应仍带 estimate 不报错", async () => {
    setupRoot();
    await startTestServer();
    mockStartGoal.mockImplementation((_r: string, goal: string) => ({
      id: "g-mem", goal, status: "running", maxRounds: 3, rounds: [], createdAt: new Date().toISOString(),
    }));

    const res = await fetch(`${baseUrl}/api/goals`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ goal: "写一首诗" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.complexityEstimate).toBeDefined();
    expect(body.complexityEstimate.complexity).toBe("S");
  });
});

describe("GET /api/goals — 新旧混合数据兼容", () => {
  it("旧 goal(无 estimate 字段)与新 goal 混在一起正常返回", async () => {
    setupRoot();
    fs.writeFileSync(goalsFile(), JSON.stringify([
      { ...legacyGoal("g-new2"), complexityEstimate: { complexity: "S", risk_level: "low", estimated_duration: { min_minutes: 1, max_minutes: 2, confidence: "medium" }, recommended_governance_level: 0, reason: ["目标描述较短(4 字),范围有限"] } },
      legacyGoal("g-old"),
    ]));
    await startTestServer();
    const res = await fetch(`${baseUrl}/api/goals`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.goals.length).toBe(2);
    expect(body.goals[0].complexityEstimate.complexity).toBe("S");
    expect(body.goals[1].complexityEstimate).toBeUndefined();
  });
});
