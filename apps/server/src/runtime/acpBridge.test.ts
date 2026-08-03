import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { runAcpEngine, type AcpEngineSpec } from "./acpBridge.js";
import { __setSpawnForTest } from "./engines/cliEngineBase.js";

// B4 · ACP Bridge 单测:mock spawn(镜像 cliEngineBase.test.ts / engineLogCapture.test.ts 的既有注入
// 姿势),覆盖桥接层自己的职责——流解析→事件转发、日志 sink 接线、成功判定铁律(外部 agent 的文本
// 声明不短路结果)、token/成本口径、restricted 早退、超时。具体某个 CLI 的参数语法/输出格式不在这里,
// 那是各 AcpEngineSpec(如 ClaudeCodeEngine 的 CLAUDE_CODE_SPEC)自己的单测覆盖范围。

function fakeSpawn(resp: { code?: number | null; stdout?: string; stderr?: string; neverClose?: boolean }) {
  return (_cmd: string, _args: readonly string[], _opts: any) => {
    const handlers: Record<string, (arg?: any) => void> = {};
    const child: any = {
      stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stdout) cb(Buffer.from(resp.stdout)); } },
      stderr: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stderr) cb(Buffer.from(resp.stderr)); } },
      stdin: { write: () => {}, end: () => {} },
      on: (e: string, cb: (arg?: any) => void) => { handlers[e] = cb; },
      kill: () => {},
      pid: 4321,
    };
    if (!resp.neverClose) setImmediate(() => handlers["close"]?.(resp.code ?? 0));
    return child;
  };
}

const node: AgentNodeConfig = {
  id: "worker-1", name: "Worker", role: "worker", childrenIds: [],
  model: "some-model", provider: "testprov",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  editable: true, deletable: true, enabled: true,
};
const task: ExecTask = { taskId: "t1", goal: "do the thing", systemPrompt: "sys", maxTokens: 100 };

let root: string;
let events: Array<{ type: string; agentId?: string; payload: unknown }>;

function ctxFor(runId: string): ExecContext {
  return {
    runId, projectRoot: root, workdir: root,
    emit: (type, agentId, payload) => { events.push({ type, agentId, payload }); },
    budget: { maxTokensPerTask: 4096 },
  };
}

function basicSpec(overrides?: Partial<AcpEngineSpec>): AcpEngineSpec {
  return {
    command: "faketool",
    logLabel: "test-acp",
    prepare: () => ({ args: ["--x"], env: {}, input: "prompt", timeoutMs: 5000 }),
    parseOutput: (stdout) => ({ content: stdout.trim(), tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, isError: false }),
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-acpbridge-"));
  events = [];
});
afterEach(() => {
  __setSpawnForTest(null);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发句柄滞留,不挡测试 */ }
});

describe("runAcpEngine — 流事件转发", () => {
  it("parseOutput 里 onEvent 抛出的 tool_call/tool_result 逐条转发为 ctx.emit,payload 形状与既有引擎一致", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "irrelevant" }));
    const spec = basicSpec({
      parseOutput: (_stdout, onEvent) => {
        onEvent?.({ kind: "tool_call", name: "Read", input: { path: "a.ts" } });
        onEvent?.({ kind: "tool_result", name: "Read", result: "ok content" });
        return { content: "done", tokens: { prompt: 1, completion: 2, total: 3 }, cost: 0, isError: false };
      },
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-events"));
    expect(res.status).toBe("done");
    expect(events).toContainEqual({ type: "tool_call", agentId: "worker-1", payload: { name: "Read", args: { path: "a.ts" } } });
    expect(events).toContainEqual({ type: "tool_result", agentId: "worker-1", payload: { name: "Read", result: "ok content" } });
  });
});

describe("runAcpEngine — 成功判定铁律", () => {
  it("res.code===0 且 parsed.isError===false → done", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "ok" }));
    const res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-ok"));
    expect(res.status).toBe("done");
    expect(res.content).toBe("ok");
  });

  it("res.code!==0 → failed,消息优先取 parsed.errorText", async () => {
    __setSpawnForTest(fakeSpawn({ code: 1, stdout: "", stderr: "raw stderr" }));
    const spec = basicSpec({
      parseOutput: () => ({ content: "", tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, isError: false, errorText: "structured error text" }),
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-err1"));
    expect(res.status).toBe("failed");
    expect(res.error).toBe("structured error text");
  });

  it("无 errorText 时退回 stderr,再退回 '<command> exited <code>' 兜底文案", async () => {
    __setSpawnForTest(fakeSpawn({ code: 1, stdout: "", stderr: "raw stderr text" }));
    let res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-err2"));
    expect(res.error).toBe("raw stderr text");

    __setSpawnForTest(fakeSpawn({ code: 7, stdout: "", stderr: "" }));
    res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-err3"));
    expect(res.error).toBe("faketool exited 7");
  });

  it("parsed.isError===true 但 res.code===0 → 仍判 failed(引擎自身协议信号优先于退出码)", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "" }));
    const spec = basicSpec({
      parseOutput: () => ({ content: "", tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, isError: true, errorText: "engine reported error" }),
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-err4"));
    expect(res.status).toBe("failed");
    expect(res.error).toBe("engine reported error");
  });

  it("外部 agent 的文本'成功'声明不短路结果:parsed.content 自称已完成,但 isError=true/code!=0 → 仍 failed", async () => {
    __setSpawnForTest(fakeSpawn({ code: 1, stdout: "" }));
    const spec = basicSpec({
      parseOutput: () => ({
        content: "任务已成功完成!Task completed successfully.",
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost: 0,
        isError: true,
        errorText: "hidden structured failure",
      }),
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-claim"));
    expect(res.status).toBe("failed");
    expect(res.error).toBe("hidden structured failure");
    // content 原样透传(验收留给上层 gate),但绝不会因为文本写着"成功"就把 status 判成 done。
    expect(res.content).toContain("成功完成");
  });

  it("overloaded 标记:失败 + 过载文案 → 错误消息带 [overloaded] 前缀", async () => {
    __setSpawnForTest(fakeSpawn({ code: 1, stdout: "", stderr: "529 Overloaded" }));
    const spec = basicSpec({ retry: { overloadRetries: 0, timeoutRetries: 0 } });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-overload"));
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/^\[overloaded\]/);
  });
});

describe("runAcpEngine — token/成本口径", () => {
  it("parsed.tokens 原样计入 ExecResult.tokens,model_call_finished 事件带 promptTokens/completionTokens/cost", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "done" }));
    const spec = basicSpec({
      parseOutput: (stdout) => ({ content: stdout, tokens: { prompt: 10, completion: 5, total: 15 }, cost: 0.03, isError: false }),
      prepare: () => ({ args: [], env: {}, input: "", timeoutMs: 5000, billCost: true }),
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-tokens"));
    expect(res.tokens).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(res.cost).toBe(0.03);
    const finished = events.find((e) => e.type === "model_call_finished");
    expect(finished?.payload).toMatchObject({ tokens: 15, cost: 0.03, promptTokens: 10, completionTokens: 5 });
  });

  it("billCost 缺省/false → 最终 cost 恒 0(不采用 parsed.cost,即使引擎自己报了非零成本)", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "done" }));
    const spec = basicSpec({
      parseOutput: () => ({ content: "done", tokens: { prompt: 1, completion: 1, total: 2 }, cost: 9.99, isError: false }),
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-nocost"));
    expect(res.cost).toBe(0);
  });
});

describe("runAcpEngine — restricted 早退", () => {
  it("prepare() 返回 restricted → 不 spawn 子进程,直接判 restricted,fileChanges 为空", async () => {
    let spawnCalled = false;
    __setSpawnForTest((cmd, args, opts) => { spawnCalled = true; return fakeSpawn({ code: 0 })(cmd, args, opts); });
    const spec = basicSpec({ prepare: () => ({ args: [], env: {}, input: "", timeoutMs: 0, restricted: "cli 未安装" }) });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-restricted"));
    expect(spawnCalled).toBe(false);
    expect(res.status).toBe("restricted");
    expect(res.fileChanges).toEqual([]);
    expect(res.error).toBe("cli 未安装");
    expect(events).toContainEqual({ type: "error", agentId: "worker-1", payload: { message: "cli 未安装", restricted: true } });
  });
});

describe("runAcpEngine — 超时", () => {
  it("spawn 超时 → status failed,消息为 '<logLabel> 执行超时'", async () => {
    __setSpawnForTest(fakeSpawn({ neverClose: true }));
    const spec = basicSpec({
      prepare: () => ({ args: [], env: {}, input: "", timeoutMs: 5 }),
      retry: { timeoutRetries: 0 },
    });
    const res = await runAcpEngine(spec, node, task, ctxFor("run-timeout"));
    expect(res.status).toBe("failed");
    expect(res.error).toBe("test-acp 执行超时");
  }, 10000);
});

describe("runAcpEngine — spawn 接线(prepare 的返回值原样传给子进程)", () => {
  it("args/env/cwd/timeoutMs/input 原样传给 spawnCliWithRetry", async () => {
    let captured: any;
    __setSpawnForTest((cmd, args, opts) => { captured = { cmd, args, opts }; return fakeSpawn({ code: 0 })(cmd, args, opts); });
    const spec = basicSpec({
      prepare: () => ({ args: ["--foo", "bar"], env: { OPC_TEST_VAR: "1" }, input: "hello-stdin", timeoutMs: 999 }),
    });
    await runAcpEngine(spec, node, task, ctxFor("run-spawnargs"));
    expect(captured.cmd).toBe("faketool");
    expect(captured.args).toEqual(["--foo", "bar"]);
    expect(captured.opts.cwd).toBe(root);
    expect(captured.opts.env.OPC_TEST_VAR).toBe("1");
  });
});

describe("runAcpEngine — 日志 sink 接线", () => {
  it("stdout/stderr 落盘到 .opc/runs/<runId>/logs/backend.std{out,err}.log,且 agent_output_chunk 原样转发", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "engine says hi\n", stderr: "warn line\n" }));
    const res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-log"));
    expect(res.status).toBe("done");
    const out = fs.readFileSync(path.join(root, ".opc", "runs", "run-log", "logs", "backend.stdout.log"), "utf-8");
    expect(out).toMatch(/\[test-acp worker-1 [^\]]+\] engine says hi\n/);
    const err = fs.readFileSync(path.join(root, ".opc", "runs", "run-log", "logs", "backend.stderr.log"), "utf-8");
    expect(err).toMatch(/\[test-acp worker-1 [^\]]+\] warn line\n/);
    expect(events.some((e) => e.type === "agent_output_chunk" && (e.payload as any).chunk === "engine says hi\n")).toBe(true);
    expect(events.some((e) => e.type === "agent_output_chunk" && (e.payload as any).chunk === "warn line\n")).toBe(true);
  });
});

// 反假成功(P0 · 空输出降级):退出码 0 且引擎无结构化错误(isError=false),但 parsed.content 为空/纯
// 空白时,此前返回 content:"(no output)" 的 status:"done" 假成功。现在必须如实判 failed 并 emit error。
// 注意判定顺序:exitFailed/isError 分支仍优先(见"成功判定铁律"组),空输出检查只在退出码 0 且非 isError
// 的"看似成功"路径上兜底。
describe("runAcpEngine — 反假成功:引擎零输出判 failed", () => {
  it("退出码 0 + isError false 但 parsed.content 为空 → failed(不再 (no output) done)", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "" })); // basicSpec.parseOutput = stdout.trim() → 空内容
    const res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-empty"));
    expect(res.status).toBe("failed");
    expect(res.content).toBe("");
    expect(res.error).toMatch(/零输出/);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("parsed.content 纯空白 → 同样判 failed", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "   \n  " }));
    const res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-blank"));
    expect(res.status).toBe("failed");
  });

  it("既有真实输出回归:parsed.content 有实质内容 → done、content 原样", async () => {
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "real answer" }));
    const res = await runAcpEngine(basicSpec(), node, task, ctxFor("run-real"));
    expect(res.status).toBe("done");
    expect(res.content).toBe("real answer");
  });
});
