// 相1 · runAcpWorkerTask 端到端单测:走完整 ACP 执行路径(对接假 ACP agent fixture,绝无真模型),
// 断言产出与 HTTP 路径同构的 Runtime Contract 证据文件,且 run 事件带 executor:"acp"。
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentNodeConfig } from "@opc/shared";
import { AcpClient } from "./acpClient.js";
import type { AcpEngineSpec } from "./engineRegistry.js";
import { runAcpWorkerTask } from "./acpWorkerRunner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "__fixtures__", "fakeAcpAgent.mjs");

function fixtureSpec(scenario: string): AcpEngineSpec {
  return { id: `fixture:${scenario}`, command: process.execPath, args: [FIXTURE, scenario], env: { ...process.env }, shell: false };
}

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-acp-runner-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "agents.json"), JSON.stringify(agents, null, 2), "utf-8");
  return root;
}

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function readEvents(runDir: string): Array<Record<string, unknown>> {
  return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
}

describe("runAcpWorkerTask(端到端 · 假 ACP agent,不打真模型)", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it("跑通 ACP 路径并落齐 Runtime Contract 证据,run 事件带 executor:acp", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "写点东西", agentId: "dev-1" },
      { projectRoot: root, engine: "claude-code", buildSpec: () => fixtureSpec("basic") },
    );

    expect(outcome.result.status).toBe("done");
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.agent.id).toBe("dev-1");

    const files = fs.readdirSync(outcome.runDir);
    for (const f of ["task.json", "result.json", "events.jsonl", "worker.config.json", "diagnostics.json", "tool_calls.jsonl"]) {
      expect(files).toContain(f);
    }

    const taskJson = readJson(path.join(outcome.runDir, "task.json"));
    expect(taskJson.id).toBe(outcome.runId);
    expect(taskJson.status).toBe("done");
    expect(taskJson.totalTokens).toBe(30);

    const resultJson = readJson(path.join(outcome.runDir, "result.json"));
    expect(resultJson.status).toBe("done");
    expect(resultJson.totalTokens).toBe(30);
    expect((resultJson.agents as Array<{ agentId: string }>)[0].agentId).toBe("dev-1");

    const workerConfig = readJson(path.join(outcome.runDir, "worker.config.json"));
    expect(workerConfig.runType).toBe("cli-acp");

    // run 事件带 executor:"acp"
    const events = readEvents(outcome.runDir);
    const started = events.find((e) => e.type === "run_started");
    const finished = events.find((e) => e.type === "run_finished");
    expect((started!.payload as Record<string, unknown>).executor).toBe("acp");
    expect((finished!.payload as Record<string, unknown>).executor).toBe("acp");
    expect((finished!.payload as Record<string, unknown>).stopReason).toBe("end_turn");

    // tool_call/tool_result → tool_calls.jsonl 派生
    const toolCalls = fs.readFileSync(path.join(outcome.runDir, "tool_calls.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0].tool).toBe("Read README");
  }, 40_000);

  it("refusal:引擎跑通即落证据判 done——stopReason 只记录,不据它判成功/失败", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      { projectRoot: root, engine: "codex", buildSpec: () => fixtureSpec("refusal") },
    );
    // stopReason=refusal 但会话跑通 → 证据落盘,run 判 done(语义验收归 Core,非本层据 stopReason 定成功)
    expect(outcome.stopReason).toBe("refusal");
    expect(outcome.result.status).toBe("done");
    const finished = readEvents(outcome.runDir).find((e) => e.type === "run_finished");
    expect((finished!.payload as Record<string, unknown>).stopReason).toBe("refusal");
  }, 40_000);

  it("传输失败(引擎起不来):run 判 failed,error 事件落 diagnostics,证据照常写出", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const badSpec: AcpEngineSpec = { id: "bad", command: process.execPath, args: ["-e", "process.exit(1)"], env: { ...process.env }, shell: false };
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      {
        projectRoot: root,
        engine: "claude-code",
        makeClient: (_spec, _prompt) => new AcpClient({ spec: badSpec, cwd: root!, handshakeTimeoutMs: 3000, turnTimeoutMs: 3000 }),
      },
    );
    expect(outcome.result.status).toBe("failed");
    const resultJson = readJson(path.join(outcome.runDir, "result.json"));
    expect(resultJson.status).toBe("failed");
    const diag = readJson(path.join(outcome.runDir, "diagnostics.json"));
    expect((diag.engineFailures as unknown[]).length).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it("ACP 路径发出的 prompt = 工整任务简报,不夹带 hermes 写文件指令(echo fixture 回显实证)", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const goal = "写一个把摄氏温度转成华氏的函数";
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal, agentId: "dev-1" },
      { projectRoot: root, engine: "claude-code", buildSpec: () => fixtureSpec("echo-prompt") },
    );
    // echo-prompt 把收到的 prompt 原样回显为输出 → result.content 即实际发给引擎的 prompt。
    const sent = outcome.result.content;
    expect(sent).toContain(goal);
    expect(sent).toContain("## 目标");
    expect(sent).toContain("## 期望产出");
    // hermes dev prompt 的写文件强制指令必须彻底缺席(否则又会诱发 text-only 会话空输出)。
    expect(sent).not.toContain("writeFile");
    expect(sent).not.toContain("DIRECT_ANSWER");
  }, 40_000);

  it("引擎不报 usage 时 tokens 走文本估算,outcome.estimated 与事件 estimated:true 都成立", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "只输出 OK", agentId: "dev-1" },
      { projectRoot: root, engine: "claude-code", buildSpec: () => fixtureSpec("no-usage") },
    );
    expect(outcome.result.status).toBe("done");
    expect(outcome.result.content).toBe("OK");
    expect(outcome.estimated).toBe(true);
    expect(outcome.result.tokens.total).toBeGreaterThan(0);

    const mcf = readEvents(outcome.runDir).find((e) => e.type === "model_call_finished");
    expect((mcf!.payload as Record<string, unknown>).estimated).toBe(true);

    const resultJson = readJson(path.join(outcome.runDir, "result.json"));
    expect(resultJson.totalTokens as number).toBeGreaterThan(0);
  }, 40_000);

  it("交付文本持久化:report.md 与 result.json.content 均为累积 assistant 文本", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "写点东西", agentId: "dev-1" },
      { projectRoot: root, engine: "claude-code", buildSpec: () => fixtureSpec("basic") },
    );
    // basic fixture 回两段 agent_message_chunk("Hello " + "world")→ 累积交付文本 "Hello world"。
    expect(outcome.result.content).toBe("Hello world");
    const reportMd = fs.readFileSync(path.join(outcome.runDir, "report.md"), "utf-8");
    expect(reportMd).toBe("Hello world");
    const resultJson = readJson(path.join(outcome.runDir, "result.json"));
    expect(resultJson.content).toBe("Hello world");
  }, 40_000);

  it("空输出如实落空串,不造假(report.md 与 result.json.content 均为空)", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev" })]);
    const outcome = await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      { projectRoot: root, engine: "claude-code", buildSpec: () => fixtureSpec("empty") },
    );
    expect(outcome.result.status).toBe("done");
    const resultJson = readJson(path.join(outcome.runDir, "result.json"));
    expect(resultJson.content).toBe("");
    const reportMd = fs.readFileSync(path.join(outcome.runDir, "report.md"), "utf-8");
    expect(reportMd).toBe("");
  }, 40_000);

  it("员工 reasoningEffort 透传给 buildSpec(任务执行链据此设 codex 推理档位)", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev", framework: "codex", reasoningEffort: "xhigh" })]);
    let seenEffort: string | undefined = "UNSET";
    await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      {
        projectRoot: root,
        engine: "codex",
        buildSpec: (_engine, eff) => { seenEffort = eff; return fixtureSpec("basic"); },
      },
    );
    expect(seenEffort).toBe("xhigh");
  }, 40_000);

  it("员工未设 reasoningEffort → 透传 undefined(保留引擎默认)", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev", framework: "codex" })]);
    let seenEffort: string | undefined = "UNSET";
    await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      {
        projectRoot: root,
        engine: "codex",
        buildSpec: (_engine, eff) => { seenEffort = eff; return fixtureSpec("basic"); },
      },
    );
    expect(seenEffort).toBeUndefined();
  }, 40_000);

  it("员工 cliConfigDir(选定订阅账号)透传给 buildSpec——ACP 路径真用该账号凭证,不落回全局登录", async () => {
    root = setupProjectRoot([makeAgent({ id: "dev-1", role: "dev", framework: "claude-code", cliConfigDir: "/opc/.opc/cli-accounts/acct12" })]);
    let seenDir: string | undefined = "UNSET";
    await runAcpWorkerTask(
      { taskId: "t-1", goal: "g", agentId: "dev-1" },
      {
        projectRoot: root,
        engine: "claude-code",
        buildSpec: (_engine, _eff, dir) => { seenDir = dir; return fixtureSpec("basic"); },
      },
    );
    expect(seenDir).toBe("/opc/.opc/cli-accounts/acct12");
  }, 40_000);

  it("agent 解析失败即抛错,不静默空跑", async () => {
    root = setupProjectRoot([]);
    await expect(
      runAcpWorkerTask({ taskId: "t-1", goal: "g", agentId: "nope" }, { projectRoot: root!, engine: "codex", buildSpec: () => fixtureSpec("basic") }),
    ).rejects.toThrow();
  }, 40_000);
});
