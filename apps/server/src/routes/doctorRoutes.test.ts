import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";

// doctorRoutes 是薄透传层:latest 有就读、没有才跑 basic、POST 按 level 重跑。
// globalDoctor 内部逻辑(各 check/落盘)已由 globalDoctor.test.ts 覆盖,这里 mock 掉——
// 否则默认探针会真探本机引擎/读 env key,机器相关且慢(同 ceoRoutes.test.ts 的 mock 姿势)。
const { mockRun, mockReadLatest } = vi.hoisted(() => ({
  mockRun: vi.fn(),
  mockReadLatest: vi.fn(),
}));
vi.mock("../runtime/globalDoctor.js", () => ({
  runGlobalDoctor: mockRun,
  readLatestDoctorReport: mockReadLatest,
}));

import { register } from "./doctorRoutes.js";

let server: Server;
let baseUrl: string;

async function startTestServer(): Promise<void> {
  const app = express();
  app.use(express.json());
  register(app, "/fake/project-root");
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
}

// 路由固定注入真实 provider tool canary(审计 P1-4),故 runGlobalDoctor 第三参恒为含 providerToolCanary 的 deps。
const DOCTOR_DEPS_MATCH = expect.objectContaining({ providerToolCanary: expect.any(Function) });

const REPORT = {
  status: "ok" as const,
  checked_at: "2026-07-07T00:00:00.000Z",
  level: "basic" as const,
  checks: [{ id: "store.json_rw", name: "JSON 存储可读写", status: "ok", severity: "error", message: "正常" }],
};

beforeEach(async () => {
  mockRun.mockReset();
  mockReadLatest.mockReset();
  await startTestServer();
});

afterEach(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

describe("GET /api/doctor", () => {
  it("latest.json 存在 → 直接返回,不重跑", async () => {
    mockReadLatest.mockReturnValue(REPORT);
    const res = await fetch(`${baseUrl}/api/doctor`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(REPORT);
    expect(mockReadLatest).toHaveBeenCalledWith("/fake/project-root");
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("latest 不存在 → 现跑一次 basic 并返回", async () => {
    mockReadLatest.mockReturnValue(null);
    const fresh = { ...REPORT, checked_at: "2026-07-07T01:00:00.000Z" };
    mockRun.mockResolvedValue(fresh);
    const res = await fetch(`${baseUrl}/api/doctor`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(fresh);
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(mockRun).toHaveBeenCalledWith("/fake/project-root", { level: "basic" }, DOCTOR_DEPS_MATCH);
  });

  it("体检执行抛错 → 500 + error 消息,不裸崩", async () => {
    mockReadLatest.mockReturnValue(null);
    mockRun.mockRejectedValue(new Error("disk on fire"));
    const res = await fetch(`${baseUrl}/api/doctor`);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("disk on fire");
  });
});

describe("POST /api/doctor/run", () => {
  it("level=capability → 按该层重跑并返回报告", async () => {
    const cap = { ...REPORT, level: "capability" as const, status: "warning" as const };
    mockRun.mockResolvedValue(cap);
    const res = await fetch(`${baseUrl}/api/doctor/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "capability" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(cap);
    expect(mockRun).toHaveBeenCalledWith("/fake/project-root", { level: "capability" }, DOCTOR_DEPS_MATCH);
  });

  // E5:deep 层——同一条路由,新增第三个合法 level 值。
  it("level=deep → 按该层重跑并返回报告(含 E5 新探针)", async () => {
    const deep = { ...REPORT, level: "deep" as const, status: "warning" as const };
    mockRun.mockResolvedValue(deep);
    const res = await fetch(`${baseUrl}/api/doctor/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "deep" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(deep);
    expect(mockRun).toHaveBeenCalledWith("/fake/project-root", { level: "deep" }, DOCTOR_DEPS_MATCH);
  });

  it("body 缺 level → 默认 basic", async () => {
    mockRun.mockResolvedValue(REPORT);
    const res = await fetch(`${baseUrl}/api/doctor/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(mockRun).toHaveBeenCalledWith("/fake/project-root", { level: "basic" }, DOCTOR_DEPS_MATCH);
  });

  it("非法 level → 400,且不发起体检", async () => {
    const res = await fetch(`${baseUrl}/api/doctor/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "ultra" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/basic.*capability.*deep/);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("体检执行抛错 → 500 + error 消息", async () => {
    mockRun.mockRejectedValue(new Error("probe exploded"));
    const res = await fetch(`${baseUrl}/api/doctor/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "basic" }),
    });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("probe exploded");
  });
});
