import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// agentRoutes 顶层 import 了 runtime/orchestrator.js——模块级、跨全项目共享的单例(同
// companyRoutes.test.ts 顶部说明),mock 成内存实现,不碰真实项目数据。resolveDefaultFramework
// 会探测本机 CLI(异步 probe),同样 mock 掉(本文件只测 export-card,不测 PATCH 的新建路径)。
vi.mock("../runtime/orchestrator.js", () => ({
  getAgents: vi.fn(() => []),
  // echo 回合并后的 patch,让 PATCH 用例能审计写侧规范化后的 workingDirectory 落盘值。
  updateAgent: vi.fn((id: string, patch: any) => ({ id, ...patch })),
}));
vi.mock("../runtime/defaultFramework.js", () => ({
  resolveDefaultFramework: vi.fn(async () => "api"),
}));

import { register } from "./agentRoutes.js";

let root: string;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-routes-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify([
    {
      id: "a1", name: "顾问", role: "advisor", companyId: "c1", framework: "hermes",
      provider: "deepseek", model: "m", childrenIds: [],
      tokenUsage: { prompt: 0, completion: 0, total: 0 }, status: "idle",
      editable: true, deletable: true, enabled: true,
      card: {
        summary: "用 key sk-abcdefgh12345678 调 API,产物放 C:\\Users\\wubin\\out",
        skills: [], produces: [], consumes: [], acceptsQuery: false,
        tools: ["读 /home/wubin/notes.md"],
      },
    },
  ]), "utf-8");
  const app = express();
  app.use(express.json());
  register(app, root);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

describe("Phase 6 native execution preference", () => {
  const patch = async (nativeExecution: unknown) =>
    fetch(`${baseUrl}/api/agents/a1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nativeExecution }),
    });

  it("normalizes a valid preference and strips undeclared auth fields", async () => {
    const response = await patch({ preference: "codex-native", apiKey: "must-not-persist" });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).nativeExecution).toEqual({
      preference: "codex-native",
      fallback: "acp",
    });
  });

  it("rejects unsupported native preferences", async () => {
    const response = await patch({ preference: "unknown-native", fallback: "acp" });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).code).toBe("invalid_native_execution");
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

// C2 · 员工卡导出此前完全裸奔(card.summary → description/systemPrompt 原文外发)。现在产物
// 过 redactShareContent 深扫:密钥/本机路径占位化(与公司 bundle 导出的脱敏先例同口径)。
describe("C2 · GET /api/agents/:id/export-card — 员工卡导出脱敏", () => {
  it("card.summary/tools 里的密钥与本机路径被占位化,不再裸奔", async () => {
    const r = await fetch(`${baseUrl}/api/agents/a1/export-card`);
    expect(r.status).toBe(200);
    const card = await r.json() as any;
    const s = JSON.stringify(card);
    expect(s).not.toContain("sk-abcdefgh12345678");
    expect(s).not.toContain("wubin");
    expect(card.agent.systemPrompt).toContain("[REDACTED_SECRET]");
    expect(card.agent.systemPrompt).toContain("[REDACTED_PATH]");
    expect(card.agent.tools[0].name).toContain("[REDACTED_PATH]");
    expect(card.description).toContain("[REDACTED_SECRET]"); // description 与 systemPrompt 同源 card.summary
    expect(card.id).toBe("local-agent-a1"); // 干净字段原样保留
    expect(card.role).toBe("advisor");
  });

  it("不存在的员工 → 404,error 如实", async () => {
    const r = await fetch(`${baseUrl}/api/agents/nope/export-card`);
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).error).toContain("nope");
  });
});

// 收口令五.3(保存侧)· PATCH /api/agents/:id 的 workingDirectory 写侧强校验。
describe("收口令五.3 · PATCH /api/agents/:id — workingDirectory 保存侧校验", () => {
  const patch = async (body: unknown) =>
    fetch(`${baseUrl}/api/agents/a1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("绝对路径 → 400 invalid_working_directory(不落盘)", async () => {
    const r = await patch({ workingDirectory: "/abs/path" });
    expect(r.status).toBe(400);
    const j = (await r.json()) as any;
    expect(j.code).toBe("invalid_working_directory");
    expect(j.error).toBeTruthy();
  });

  it("盘符绝对路径 → 400 invalid_working_directory", async () => {
    const r = await patch({ workingDirectory: "C:\\abs" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).code).toBe("invalid_working_directory");
  });

  it(".. 逃逸 → 400 invalid_working_directory", async () => {
    const r = await patch({ workingDirectory: "a/../../up" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).code).toBe("invalid_working_directory");
  });

  it("合法子目录 → 200,规范化后落盘", async () => {
    const r = await patch({ workingDirectory: "svc/alpha" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).workingDirectory).toBe("svc/alpha");
  });

  it("等价路径规范化(./svc//alpha/ 反斜杠混用)→ 200,归一为 POSIX 相对", async () => {
    const r = await patch({ workingDirectory: "./svc//alpha/" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).workingDirectory).toBe("svc/alpha");
    const r2 = await patch({ workingDirectory: "svc\\alpha\\deep" });
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as any).workingDirectory).toBe("svc/alpha/deep");
  });

  it("空串 = 清空回 worktree 根(合法操作,放行不校验)→ 200,落空串", async () => {
    const r = await patch({ workingDirectory: "" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).workingDirectory).toBe("");
  });

  it("等价于根(a/..)→ 400(歧义值不接受,应留空)", async () => {
    const r = await patch({ workingDirectory: "a/.." });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).code).toBe("invalid_working_directory");
  });
});
