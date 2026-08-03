import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("../runtime/orchestrator.js", () => ({
  startRun: vi.fn(async () => ({ runId: "mock-run" })),
  getRunChannels: () => ({}),
  getRunMessages: () => [],
  requestRunChannel: () => ({ error: "not implemented" }),
  decideRunChannel: () => ({ error: "not implemented" }),
  openRunChannel: () => ({ error: "not implemented" }),
  requestStopRun: () => false,
  getAgents: () => [{ id: "dev-1", name: "小李", role: "dev" }],
}));

vi.mock("../runtime/benchmark.js", () => ({
  runBenchmark: vi.fn(),
  runBenchmarkComparison: vi.fn(),
  benchmarkComparisonTable: vi.fn(),
}));

vi.mock("../runtime/contextBuilder.js", () => ({
  setInjectionEnabled: vi.fn(),
  isInjectionEnabled: () => false,
}));

import { register, resolveRunWorkRoot } from "./runRoutes.js";
import { commitEvidenceReceipts, writeEvidenceManifest, buildEvidenceManifest } from "../runtime/evidenceManifest.js";

function setupRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "run-routes-"));
  fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
  return root;
}

function writeTask(root: string, runId: string, workRoot?: string): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({
    id: runId,
    goal: "test run",
    status: "done",
    startedAt: "2026-07-05T00:00:00.000Z",
    ...(workRoot ? { workRoot } : {}),
  }), "utf-8");
}

function writeEvents(root: string, runId: string, lines: object[]): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), lines.map(l => JSON.stringify(l)).join("\n"), "utf-8");
}

function writeChanges(root: string, runId: string, changes: unknown[]): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "changes.json"), JSON.stringify(changes), "utf-8");
}

async function startServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("runRoutes /api/runs/:id/changes", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  it("returns 404 when the run task does not exist", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/not-a-real-run-000000000000/changes`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "run not found" });
  });

  it("keeps invalid run ids as 400", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/bad/changes`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid run id" });
  });

  it("returns an empty changes list for an existing run without changes.json", async () => {
    root = setupRoot();
    const runId = "existing-run-000000000001";
    writeTask(root, runId);
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/${runId}/changes`);
    const body = await res.json();

    expect(res.status).toBe(200);
    // 无持久 workRoot 且无事件推断 → workRoot=null(绝不兜底 projectRoot),changes 仍如实返回
    expect(body).toEqual({ workRoot: null, changes: [] });
  });

  it("returns recorded changes for an existing run", async () => {
    root = setupRoot();
    const runId = "existing-run-000000000002";
    const changes = [{ path: "src/app.ts", changeType: "modify" }];
    writeTask(root, runId);
    writeChanges(root, runId, changes);
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/${runId}/changes`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ workRoot: null, changes });
  });
});

describe("runRoutes workRoot 持久化 + 兜底语义(P0 RunEnvelope)", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  it("持久字段:task.json.workRoot 被 resolveRunWorkRoot 采纳并由 /changes 原样回传", async () => {
    root = setupRoot();
    const runId = "wr-persist-00000000001";
    const workRootDir = path.join(root, "company-workspace");
    fs.mkdirSync(workRootDir, { recursive: true });
    writeTask(root, runId, workRootDir);
    expect(resolveRunWorkRoot(root, runId)).toBe(workRootDir);

    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/${runId}/changes`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.workRoot).toBe(workRootDir);
  });

  it("resolveRunWorkRoot 永不兜底 projectRoot:无 workRoot 字段且无事件 → null", () => {
    root = setupRoot();
    const runId = "wr-none-000000000002";
    writeTask(root, runId); // 无 workRoot 字段、无 events.jsonl
    const resolved = resolveRunWorkRoot(root, runId);
    expect(resolved).toBeNull();
    expect(resolved).not.toBe(root); // 专门断言:绝不回退 projectRoot
  });

  it("历史 run 回退:events.jsonl 的 “工作目录:” info 事件被采纳(路径需真实存在)", () => {
    root = setupRoot();
    const runId = "wr-legacy-00000000003";
    const legacyWork = path.join(root, "legacy-workspace");
    fs.mkdirSync(legacyWork, { recursive: true });
    writeTask(root, runId); // 无持久字段
    writeEvents(root, runId, [
      { id: "e1", runId, timestamp: "2026-07-05T00:00:00.000Z", type: "info", payload: { message: `工作目录: ${legacyWork}` } },
    ]);
    expect(resolveRunWorkRoot(root, runId)).toBe(legacyWork);
  });

  it("无 workRoot 历史 run 的 diff → 404(绝不 diff 项目仓库自身)", async () => {
    root = setupRoot();
    const runId = "wr-diff404-0000000004";
    writeTask(root, runId); // run 存在但无 workRoot、无事件
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/${runId}/diff`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toContain("未记录工作区");
  });
});

describe("runRoutes /api/runs/:id/postmortem", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  it("keeps invalid run ids as 400", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/bad/postmortem`);

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid run id" });
  });

  it("returns 404 when the run task does not exist", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/not-a-real-run-000000000000/postmortem`);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "run not found" });
  });

  it("returns available:false for a successful run without deferred tasks", async () => {
    root = setupRoot();
    const runId = "existing-run-000000000003";
    writeTask(root, runId);
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/${runId}/postmortem`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(false);
  });

  it("builds a provider-key postmortem from deferred.json and resolves the agent display name", async () => {
    root = setupRoot();
    const runId = "existing-run-000000000004";
    writeTask(root, runId);
    const dir = path.join(root, ".opc", "runs", runId);
    fs.writeFileSync(path.join(dir, "deferred.json"), JSON.stringify([{
      taskId: "t1", agentId: "dev-1", goal: "g", reason: "provider_unavailable", attempts: 1,
      lastError: "Provider unavailable: deepseek — no handler registered — missing API key or unknown provider",
    }]), "utf-8");
    ({ server, baseUrl } = await startServer(root));

    const res = await fetch(`${baseUrl}/api/runs/${runId}/postmortem`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.causes[0].kind).toBe("provider_key");
    expect(body.causes[0].message).toContain("DeepSeek");
    expect(body.causes[0].message).toContain("小李");
    expect(body.actions.map((a: { id: string }) => a.id)).toEqual(["retry", "replan", "save_lesson", "view_logs"]);
  });
});

describe("runRoutes /api/runs/:id/artifacts/preview", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  function writeReport(r: string, runId: string, body: string): void {
    writeTask(r, runId); // run 存在性守卫(requireRunExists)要求 task.json 落盘
    const dir = path.join(r, ".opc", "runs", runId);
    fs.writeFileSync(path.join(dir, "report.md"), body, "utf-8");
  }

  it("keeps invalid run ids as 400", async () => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/bad/artifacts/preview?artifactId=report`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid run id" });
  });

  it("requires artifactId", async () => {
    root = setupRoot();
    const runId = "preview-run-00000000001";
    writeReport(root, runId, "# body");
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/preview`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "artifactId required" });
  });

  it("404 for an unknown artifactId", async () => {
    root = setupRoot();
    const runId = "preview-run-00000000002";
    writeReport(root, runId, "# body");
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/preview?artifactId=does-not-exist`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "artifact not found" });
  });

  it("previews report.md text with truncation metadata", async () => {
    root = setupRoot();
    const runId = "preview-run-00000000003";
    writeReport(root, runId, "# Report body");
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/${runId}/artifacts/preview?artifactId=report`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toBe("# Report body");
    expect(body.truncated).toBe(false);
    expect(body.filename).toContain("report-");
  });
});

// 任务A · 参数化全清单:register() 注册的所有 run-scoped GET,对不存在的 run 一律 404
// {error:"run not found"},对非法 id 一律 400 {error:"invalid run id"}——统一经 requireRunExists 守卫,
// 语义不可再被伪造(此前 /diff、/deferred、/artifacts、/story、/memories 等对不存在的 run 返回 200 空)。
describe("runRoutes run-scoped GET · 不存在的 run 一律 404 / 非法 id 400", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  // artifact 子路由带 artifactId,证明存在性守卫先于 artifactId 校验触发(仍是 404 run not found)。
  const RUN_SCOPED_GET_SUFFIXES = [
    "",
    "/report",
    "/diff",
    "/changes",
    "/evidence",
    "/postmortem",
    "/deferred",
    "/structured-report",
    "/artifacts",
    "/artifacts/detail?artifactId=x",
    "/artifacts/lineage?artifactId=x",
    "/artifacts/download?artifactId=x",
    "/artifacts/preview?artifactId=x",
    "/story",
    "/memories",
    "/transcript",
  ];

  it.each(RUN_SCOPED_GET_SUFFIXES)("404 run not found for missing run: '%s'", async (suffix) => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/missing-run-000000000000${suffix}`);
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "run not found" });
  });

  it.each(RUN_SCOPED_GET_SUFFIXES)("400 invalid run id for bad id: '%s'", async (suffix) => {
    root = setupRoot();
    ({ server, baseUrl } = await startServer(root));
    const res = await fetch(`${baseUrl}/api/runs/bad${suffix}`);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid run id" });
  });
});

describe("runRoutes evidence permission posture API", () => {
  let root: string | undefined;
  let server: Server | undefined;
  let baseUrl = "";

  afterEach(async () => {
    if (server) await new Promise(resolve => server?.close(resolve));
    server = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
    baseUrl = "";
  });

  it("returns fail-closed permission completeness in manifest and verify responses", async () => {
    root = setupRoot();
    const runId = "permission-run-000000000001";
    const runDir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(runDir, { recursive: true });
    const required = [
      "task.json", "report.md", "report.html", "events.jsonl", "trace.json", "cost.json",
      "changes.json", "deferred.json", "structured-report.json", "result.json", "artifacts.json",
    ];
    for (const file of required) {
      let body = file.endsWith(".json") ? "{}" : "evidence\n";
      if (["changes.json", "deferred.json", "trace.json"].includes(file)) body = "[]";
      if (file === "artifacts.json") body = JSON.stringify({ artifacts: [] });
      if (file === "task.json") body = JSON.stringify({ id: runId, participatingAgents: ["dev-1"] });
      if (file === "events.jsonl") {
        body = JSON.stringify({
          type: "model_call_started",
          agentId: "dev-1",
          payload: { model: "model-1", provider: "provider-1" },
        });
      }
      fs.writeFileSync(path.join(runDir, file), body, "utf-8");
    }
    commitEvidenceReceipts(runDir);
    writeEvidenceManifest(runDir, buildEvidenceManifest(runDir));
    ({ server, baseUrl } = await startServer(root));

    const manifestRes = await fetch(`${baseUrl}/api/runs/${runId}/evidence`);
    const manifest = await manifestRes.json() as any;
    expect(manifestRes.status).toBe(200);
    expect(manifest.evidenceComplete).toBe(false);
    expect(manifest.permissionPosture).toMatchObject({
      source: "committed-events",
      completeness: "incomplete",
      missingReceiptAgentIds: ["dev-1"],
    });

    const verifyRes = await fetch(`${baseUrl}/api/runs/${runId}/evidence?verify=1`);
    const verified = await verifyRes.json() as any;
    expect(verifyRes.status).toBe(200);
    expect(verified.ok).toBe(true);
    expect(verified.evidenceComplete).toBe(false);
    expect(verified.permissionPosture.reasons).toContain("missing_launch_receipt:dev-1");
  });
});
