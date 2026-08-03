// E4 · L3 人工审批网关端到端(路由层):未批不派发 → 审批端点批准 → 照 pendingDispatch 真派发;
// 拒绝 → run 收尾 cancelled;kill 端点安全 no-op(无登记 pid 时)。mock 姿势镜像 chatRoutes.test.ts。
import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const { mockStartRun, mockRequestStopRun, mockIsRunInFlight } = vi.hoisted(() => ({
  mockStartRun: vi.fn(),
  mockRequestStopRun: vi.fn(() => false),
  mockIsRunInFlight: vi.fn(() => false),
}));

vi.mock("../runtime/orchestrator.js", () => ({
  startRun: mockStartRun,
  requestStopRun: mockRequestStopRun,
  isRunInFlight: mockIsRunInFlight,
  getAgents: () => [],
  getRunChannels: () => ({}),
  getRunMessages: () => [],
  requestRunChannel: () => ({ error: "not implemented" }),
  decideRunChannel: () => ({ error: "not implemented" }),
  openRunChannel: () => ({ error: "not implemented" }),
}));

vi.mock("../runtime/modelGateway.js", () => ({ callModel: vi.fn() }));
vi.mock("../runtime/capabilityReport.js", () => ({
  buildCapabilityReport: vi.fn(async () => ({ canRun: true, blockedBy: [] })),
}));

import { register as registerChatRoutes } from "./chatRoutes.js";
import { register as registerGovernanceRoutes } from "./governanceRoutes.js";
import { getGovernanceRecord } from "../storage/governanceStore.js";
import { listDispatchQueue } from "../storage/dispatchQueueStore.js";

// 判到 L3 的确定性构造:8 人公司(+2)+ >800 字(+3)+ 代码信号(+2)+ 调研信号(+1)→ XL → 估算监督 3。
const L3_GOAL = ("请全面调研分析并重构我们数据管道的 python 代码," + "细化每个模块的接口与验收标准。").repeat(25);

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gov-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  const agents = Array.from({ length: 8 }, (_, i) => ({
    id: `a${i}`, name: `A${i}`, role: i === 0 ? "ceo" : "dev", childrenIds: [],
    model: "m", provider: "deepseek", framework: "hermes", companyId: "default",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
  }));
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents));
  return root;
}

async function startTestServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  registerChatRoutes(app, root);
  registerGovernanceRoutes(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

function readTask(root: string, runId: string): { status: string } {
  return JSON.parse(fs.readFileSync(path.join(root, ".opc", "runs", runId, "task.json"), "utf-8"));
}

async function dispatchL3(baseUrl: string): Promise<{ runId: string; body: any }> {
  const res = await fetch(`${baseUrl}/api/chat/task`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: L3_GOAL, runType: "quick" }),
  });
  const body = await res.json() as any;
  return { runId: body.runId, body };
}

describe("E4 · L3 审批网关(chatRoutes 派发口 + governanceRoutes 审批口)", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    mockStartRun.mockReset();
    mockRequestStopRun.mockReset();
    mockIsRunInFlight.mockReset();
    mockIsRunInFlight.mockReturnValue(false);
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("L3 run:未批不派发——startRun 不被调用,task 落 pending,record 带 pendingDispatch", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startTestServer(root));

    const { runId, body } = await dispatchL3(baseUrl);
    expect(body.approvalRequired).toBe(true);
    expect(body.governanceLevel).toBe("L3");
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(readTask(root, runId).status).toBe("pending");

    const rec = getGovernanceRecord(root, runId)!;
    expect(rec.approval?.status).toBe("pending");
    expect(rec.pendingDispatch?.goal).toBe(L3_GOAL);
    expect(rec.pendingDispatch?.runType).toBe("quick");

    const apiRec = await (await fetch(`${baseUrl}/api/governance/runs/${runId}`)).json() as any;
    expect(apiRec.level).toBe("L3");
  });

  it("批准 → 照 pendingDispatch 真派发(startRun 收到原 goal/runId/参数),record 标 approved", async () => {
    root = setupRoot();
    mockStartRun.mockResolvedValue({ runId: "x", summary: "ok" });
    ({ server, baseUrl } = await startTestServer(root));

    const { runId } = await dispatchL3(baseUrl);
    const res = await fetch(`${baseUrl}/api/governance/runs/${runId}/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ decidedBy: "tester" }),
    });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ approved: true, dispatched: true });
    expect(mockStartRun).toHaveBeenCalledTimes(1);
    expect(mockStartRun).toHaveBeenCalledWith(L3_GOAL, runId, undefined, expect.objectContaining({ runType: "quick" }));

    const rec = getGovernanceRecord(root!, runId)!;
    expect(rec.approval).toMatchObject({ status: "approved", decidedBy: "tester" });
    expect(rec.events.some(e => e.kind === "approved")).toBe(true);

    // 二次批准被拒(状态机不可重入)。真 startRun 派发后 task 即 running(mock 不落盘,这里补写
    // 模拟真实效果);唯一豁免是"撞闸未派发"(task 仍 pending),见下方撞闸专项测试。
    const taskPath = path.join(root!, ".opc", "runs", runId, "task.json");
    fs.writeFileSync(taskPath, JSON.stringify({ ...JSON.parse(fs.readFileSync(taskPath, "utf-8")), status: "running" }));
    const again = await fetch(`${baseUrl}/api/governance/runs/${runId}/approve`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("拒绝 → 不派发,pending run 收尾 cancelled", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startTestServer(root));

    const { runId } = await dispatchL3(baseUrl);
    const res = await fetch(`${baseUrl}/api/governance/runs/${runId}/reject`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(readTask(root, runId).status).toBe("cancelled");
    expect(getGovernanceRecord(root, runId)?.approval?.status).toBe("rejected");

    // 拒绝后不能再批准
    const approveAfter = await fetch(`${baseUrl}/api/governance/runs/${runId}/approve`, { method: "POST" });
    expect(approveAfter.status).toBe(409);
  });

  it("非 L3 run 正常直发(不受网关影响),对其调 approve → 409", async () => {
    root = setupRoot();
    mockStartRun.mockImplementation(() => new Promise(() => undefined));
    ({ server, baseUrl } = await startTestServer(root));

    const res = await fetch(`${baseUrl}/api/chat/task`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "写一首关于春天的诗", runType: "quick" }),
    });
    const body = await res.json() as any;
    expect(body.approvalRequired).toBeUndefined();
    expect(mockStartRun).toHaveBeenCalledTimes(1);
    expect(readTask(root, body.runId).status).toBe("running");

    const approveRes = await fetch(`${baseUrl}/api/governance/runs/${body.runId}/approve`, { method: "POST" });
    expect(approveRes.status).toBe(409);
  });

  it("撞闸不烧审批:批准时已有 run 在飞 → dispatched:false+retryable:true,run 保持 pending;闸开后重打接口补派发", async () => {
    root = setupRoot();
    mockIsRunInFlight.mockReturnValue(true);
    mockStartRun.mockResolvedValue({ runId: "x", summary: "ok" });
    ({ server, baseUrl } = await startTestServer(root));

    const { runId } = await dispatchL3(baseUrl);
    const res = await fetch(`${baseUrl}/api/governance/runs/${runId}/approve`, { method: "POST" });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ approved: true, dispatched: false, retryable: true });
    expect(mockStartRun).not.toHaveBeenCalled();
    expect(readTask(root, runId).status).toBe("pending"); // 审批没被烧掉:run 不标 failed
    expect(getGovernanceRecord(root, runId)?.approval?.status).toBe("approved");
    // 缺口①根治:撞闸不再只"口头可重试"——已入持久化派发队列,run 结束时 drain 自动派发
    expect(listDispatchQueue(root).map(i => i.runId)).toContain(runId);

    // 闸开后重打 approve:已批准 + pendingDispatch + run 仍 pending → 补派发而非 409
    mockIsRunInFlight.mockReturnValue(false);
    const retry = await fetch(`${baseUrl}/api/governance/runs/${runId}/approve`, { method: "POST" });
    const retryBody = await retry.json() as any;
    expect(retry.status).toBe(200);
    expect(retryBody).toMatchObject({ approved: true, dispatched: true });
    expect(mockStartRun).toHaveBeenCalledTimes(1);
    expect(mockStartRun).toHaveBeenCalledWith(L3_GOAL, runId, undefined, expect.objectContaining({ runType: "quick" }));
    // 直派发时清残单:同一 run 不能同时在飞又在队列里等 drain 二次起跑
    expect(listDispatchQueue(root).map(i => i.runId)).not.toContain(runId);
  });

  it("竞态兜底:startRun 抛互斥闸错误 → 不 markPrecreatedRunFailed(run 保持 pending);其他错误维持现状标 failed", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startTestServer(root));

    // 互斥闸错误:审批保留,run 不烧
    const a = await dispatchL3(baseUrl);
    mockStartRun.mockRejectedValueOnce(new Error("已有 run 正在进行(OPC 单 run 约束):请等待当前 run 完成后再发起"));
    const res = await fetch(`${baseUrl}/api/governance/runs/${a.runId}/approve`, { method: "POST" });
    expect(res.status).toBe(200);
    await new Promise(r => setTimeout(r, 30)); // 等 fire-and-forget 的 catch 落定
    expect(readTask(root, a.runId).status).toBe("pending");
    expect(getGovernanceRecord(root, a.runId)?.approval?.status).toBe("approved");
    // 缺口①根治(竞态分支同样入队):不再依赖人工重打接口
    expect(listDispatchQueue(root).map(i => i.runId)).toContain(a.runId);

    // 普通错误:维持现状(markPrecreatedRunFailed → failed)
    const b = await dispatchL3(baseUrl);
    mockStartRun.mockRejectedValueOnce(new Error("boom"));
    await fetch(`${baseUrl}/api/governance/runs/${b.runId}/approve`, { method: "POST" });
    await new Promise(r => setTimeout(r, 30));
    expect(readTask(root, b.runId).status).toBe("failed");
  });

  it("kill 端点:无登记 pid 时安全返回空清单,并请求停止派发 + 落 kill 事件", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startTestServer(root));

    const { runId } = await dispatchL3(baseUrl);
    const res = await fetch(`${baseUrl}/api/governance/runs/${runId}/kill`, { method: "POST" });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    expect(body.killed).toEqual([]);
    expect(mockRequestStopRun).toHaveBeenCalledWith(runId);
    expect(getGovernanceRecord(root, runId)?.events.some(e => e.kind === "kill")).toBe(true);
  });

  it("governance records 列表端点按新旧排序返回", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startTestServer(root));
    const a = await dispatchL3(baseUrl);
    const b = await dispatchL3(baseUrl);
    const list = await (await fetch(`${baseUrl}/api/governance/records`)).json() as any[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].runId).toBe(b.runId);
    expect(list[1].runId).toBe(a.runId);
  });
});
