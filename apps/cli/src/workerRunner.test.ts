// B3 · opc-worker CLI 单测:契约 zod 校验 / 角色解析 / Runner 端到端(mock 引擎路由,不打真模型)。
// mock 手法与 apps/server/src/runtime/workerRuntime.test.ts 一致(直接替换 routeEngine 返回的
// engine.run,让 runEngineCore 走真代码但绝不真正 spawn 引擎子进程/花真钱)。
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, ExecResult } from "@opc/shared";
import { WorkerTaskContractSchema, type WorkerTaskContract } from "@opc/shared";
import type { WorkerRuntimeDeps } from "@opc/server/src/runtime/workerRuntime.js";
import type { RouteDecision } from "@opc/server/src/runtime/engineRouter.js";
import * as providerRegistry from "@opc/server/src/runtime/providerRegistry.js";
import { resolveAgent, runWorkerTask, WorkerTaskAgentResolutionError } from "./workerRunner.js";

function makeAgent(overrides: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "dev-1", name: "Dev One", role: "dev", childrenIds: [],
    model: "m-base", provider: "p-base", framework: "hermes",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...overrides,
  };
}

function setupProjectRoot(agents: AgentNodeConfig[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-worker-test-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents, null, 2), "utf-8");
  return root;
}

function makeMockRouteDeps(engineResult: ExecResult): Partial<WorkerRuntimeDeps> {
  const route: RouteDecision = {
    engine: {
      framework: "hermes",
      run: async () => engineResult,
      probe: async () => ({ framework: "hermes", installed: true, loggedIn: true, version: "test" }),
    },
    chosenProvider: "hermes", idealProvider: "hermes", riskLevel: undefined, capabilityMatch: true,
  };
  return { routeEngine: () => route };
}

function doneResult(overrides: Partial<ExecResult> = {}): ExecResult {
  return {
    content: "done!", fileChanges: [], tokens: { prompt: 10, completion: 20, total: 30 },
    cost: 0.01, latencyMs: 5, status: "done",
    ...overrides,
  };
}

describe("WorkerTaskContractSchema(zod 契约)", () => {
  it("合法:仅 agentId", () => {
    const r = WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "do X", agentId: "dev-1" });
    expect(r.success).toBe(true);
  });

  it("合法:仅 role", () => {
    const r = WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "do X", role: "dev" });
    expect(r.success).toBe(true);
  });

  it("合法:附带 companyId/runId/maxTokens", () => {
    const r = WorkerTaskContractSchema.safeParse({
      taskId: "t1", goal: "do X", agentId: "dev-1", companyId: "acme", runId: "run-xyz", maxTokens: 2048,
    });
    expect(r.success).toBe(true);
  });

  it("缺 taskId 拒绝", () => {
    expect(WorkerTaskContractSchema.safeParse({ goal: "do X", agentId: "dev-1" }).success).toBe(false);
  });

  it("缺 goal 拒绝", () => {
    expect(WorkerTaskContractSchema.safeParse({ taskId: "t1", agentId: "dev-1" }).success).toBe(false);
  });

  it("agentId 与 role 都缺失时拒绝", () => {
    expect(WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "do X" }).success).toBe(false);
  });

  it("maxTokens 非正数拒绝", () => {
    expect(WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "do X", agentId: "dev-1", maxTokens: -1 }).success).toBe(false);
    expect(WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "do X", agentId: "dev-1", maxTokens: 0 }).success).toBe(false);
  });

  it("空字符串 taskId/goal 拒绝", () => {
    expect(WorkerTaskContractSchema.safeParse({ taskId: "", goal: "do X", agentId: "dev-1" }).success).toBe(false);
    expect(WorkerTaskContractSchema.safeParse({ taskId: "t1", goal: "", agentId: "dev-1" }).success).toBe(false);
  });
});

describe("resolveAgent(角色/agentId 解析)", () => {
  const agents = [
    makeAgent({ id: "ceo-1", role: "ceo" }),
    makeAgent({ id: "dev-1", role: "dev", companyId: "acme" }),
    makeAgent({ id: "dev-2", role: "dev", companyId: "other" }),
    makeAgent({ id: "dev-3", role: "dev", enabled: false }),
  ];
  const parse = (t: unknown): WorkerTaskContract => WorkerTaskContractSchema.parse(t);

  it("按 agentId 精确解析", () => {
    expect(resolveAgent(agents, parse({ taskId: "t", goal: "g", agentId: "ceo-1" })).id).toBe("ceo-1");
  });

  it("agentId 与 role 同时给出时 agentId 优先", () => {
    expect(resolveAgent(agents, parse({ taskId: "t", goal: "g", agentId: "ceo-1", role: "dev" })).id).toBe("ceo-1");
  });

  it("agentId 不存在时抛 WorkerTaskAgentResolutionError", () => {
    expect(() => resolveAgent(agents, parse({ taskId: "t", goal: "g", agentId: "nope" })))
      .toThrow(WorkerTaskAgentResolutionError);
  });

  it("按 role 解析,取按 id 排序后的第一个已启用 agent", () => {
    expect(resolveAgent(agents, parse({ taskId: "t", goal: "g", role: "dev" })).id).toBe("dev-1");
  });

  it("按 role + companyId 缩小范围", () => {
    expect(resolveAgent(agents, parse({ taskId: "t", goal: "g", role: "dev", companyId: "other" })).id).toBe("dev-2");
  });

  it("跳过 enabled=false 的 agent", () => {
    const onlyDisabled = [makeAgent({ id: "dev-3", role: "dev", enabled: false })];
    expect(() => resolveAgent(onlyDisabled, parse({ taskId: "t", goal: "g", role: "dev" })))
      .toThrow(WorkerTaskAgentResolutionError);
  });

  it("role 无匹配时抛 WorkerTaskAgentResolutionError", () => {
    expect(() => resolveAgent(agents, parse({ taskId: "t", goal: "g", role: "security" })))
      .toThrow(WorkerTaskAgentResolutionError);
  });
});

describe("runWorkerTask(端到端 · mock 引擎路由,不打真模型)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("产出与 HTTP 路径同构的证据文件集:task.json/result.json/events.jsonl/worker.config.json", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runWorkerTask(
      { taskId: "t-1", goal: "写一个函数", agentId: "dev-1" },
      { projectRoot: root, depsOverride: makeMockRouteDeps(doneResult()) },
    );

    expect(outcome.result.status).toBe("done");
    expect(outcome.agent.id).toBe("dev-1");
    expect(fs.existsSync(outcome.runDir)).toBe(true);

    const files = fs.readdirSync(outcome.runDir);
    for (const f of ["task.json", "result.json", "events.jsonl", "worker.config.json"]) {
      expect(files).toContain(f);
    }

    const taskJson = JSON.parse(fs.readFileSync(path.join(outcome.runDir, "task.json"), "utf-8"));
    expect(taskJson.id).toBe(outcome.runId);
    expect(taskJson.status).toBe("done");
    expect(taskJson.participatingAgents).toEqual(["dev-1"]);
    expect(taskJson.totalTokens).toBe(30);

    const resultJson = JSON.parse(fs.readFileSync(path.join(outcome.runDir, "result.json"), "utf-8"));
    expect(resultJson.runId).toBe(outcome.runId);
    expect(resultJson.status).toBe("done");
    expect(resultJson.agents).toHaveLength(1);
    expect(resultJson.agents[0].agentId).toBe("dev-1");
    expect(resultJson.totalTokens).toBe(30);

    const workerConfig = JSON.parse(fs.readFileSync(path.join(outcome.runDir, "worker.config.json"), "utf-8"));
    expect(workerConfig.runId).toBe(outcome.runId);
    expect(workerConfig.runType).toBe("cli");
    expect(workerConfig.agents).toHaveLength(1);
    expect(workerConfig.agents[0].agentId).toBe("dev-1");

    const eventLines = fs.readFileSync(path.join(outcome.runDir, "events.jsonl"), "utf-8").trim().split("\n");
    const events = eventLines.map((l) => JSON.parse(l));
    expect(events.some((e) => e.type === "run_started")).toBe(true);
    expect(events.some((e) => e.type === "run_finished")).toBe(true);
    expect(events.every((e) => e.runId === outcome.runId)).toBe(true);
  });

  it("CLI 默认路径会按 projectRoot 同步注册 provider handler", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const spy = vi.spyOn(providerRegistry, "syncProvidersFromStore").mockReturnValue([]);
    try {
      await runWorkerTask(
        { taskId: "t-1", goal: "写一个函数", agentId: "dev-1" },
        { projectRoot: root, depsOverride: makeMockRouteDeps(doneResult()) },
      );
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(root);
    } finally {
      spy.mockRestore();
    }
  });

  it("引擎返回 failed 时:run 标记 failed,不崩溃,证据文件照常写出", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      {
        projectRoot: root,
        depsOverride: makeMockRouteDeps(doneResult({ status: "failed", content: "", error: "boom", tokens: { prompt: 1, completion: 0, total: 1 } })),
      },
    );
    expect(outcome.result.status).toBe("failed");
    const taskJson = JSON.parse(fs.readFileSync(path.join(outcome.runDir, "task.json"), "utf-8"));
    expect(taskJson.status).toBe("failed");
    const resultJson = JSON.parse(fs.readFileSync(path.join(outcome.runDir, "result.json"), "utf-8"));
    expect(resultJson.status).toBe("failed");
  });

  it("task.json 提供 runId 时原样复用(不生成新的)", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1", runId: "fixed-run-id" },
      { projectRoot: root, depsOverride: makeMockRouteDeps(doneResult()) },
    );
    expect(outcome.runId).toBe("fixed-run-id");
    expect(fs.existsSync(path.join(root, ".opc", "runs", "fixed-run-id", "result.json"))).toBe(true);
  });

  it("按 role 解析(未给 agentId)也能跑通全流程", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-9", role: "dev" })]);
    const outcome = await runWorkerTask(
      { taskId: "t-1", goal: "g", role: "dev" },
      { projectRoot: root, depsOverride: makeMockRouteDeps(doneResult()) },
    );
    expect(outcome.agent.id).toBe("dev-9");
  });

  it("agent 解析失败时抛错,不静默用空 agent 列表继续", async () => {
    root = setupProjectRoot([]);
    await expect(
      runWorkerTask({ taskId: "t-1", goal: "g", agentId: "nope" }, { projectRoot: root }),
    ).rejects.toThrow(WorkerTaskAgentResolutionError);
  });

  it("非法 task(zod 校验不过)在到达 agent 解析前就抛错", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    await expect(
      runWorkerTask({ taskId: "t-1" /* 缺 goal 和 agentId/role */ }, { projectRoot: root }),
    ).rejects.toThrow();
  });
});
