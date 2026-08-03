import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AgentNodeConfig, ExecContext, ExecTask } from "@opc/shared";
import { createEngineLogSink, ENGINE_LOG_MAX_BYTES } from "./engineLogCapture.js";
import { GenericCliEngine, type GenericCliConfig } from "./engines/GenericCliEngine.js";
import { __setSpawnForTest } from "./engines/cliEngineBase.js";
import { __setCliInstalledCheckForTest } from "./engines/probes.js";

// B1 遗留件 · 引擎日志捕获:sink 的行缓冲/脱敏/截断/no-op/写失败静默 + 一个引擎级(GenericCliEngine
// mock spawn)真实落盘断言。全部走真实文件系统(临时目录),不 mock fs——writer 的正确性就在 fs 行为里。

let root: string;
const RUN_ID = "run-logcap";
const stdoutLog = () => path.join(root, ".opc", "runs", RUN_ID, "logs", "backend.stdout.log");
const stderrLog = () => path.join(root, ".opc", "runs", RUN_ID, "logs", "backend.stderr.log");
const read = (p: string) => fs.readFileSync(p, "utf-8");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-logcap-"));
});
afterEach(() => {
  __setSpawnForTest(null);
  __setCliInstalledCheckForTest(null);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 偶发句柄滞留,不挡测试 */ }
});

describe("createEngineLogSink — 行缓冲", () => {
  it("chunk 任意切片:凑满整行才落盘,半行留在缓冲,close() 刷出", () => {
    const sink = createEngineLogSink(root, RUN_ID, "claude-code", "agent-1");
    sink.onStdout("hel");
    sink.onStdout("lo\nwor");
    expect(read(stdoutLog())).toMatch(/\] hello\n$/); // 只有第一行完整
    expect(read(stdoutLog())).not.toContain("wor");
    sink.onStdout("ld\n");
    expect(read(stdoutLog())).toMatch(/\] world\n$/);
    sink.onStdout("tail-no-newline");
    sink.close();
    expect(read(stdoutLog())).toMatch(/\] tail-no-newline\n$/);
  });

  it("CRLF 行尾:落盘的行不带 \\r", () => {
    const sink = createEngineLogSink(root, RUN_ID, "codex", "agent-1");
    sink.onStdout("line-a\r\nline-b\r\n");
    sink.close();
    const content = read(stdoutLog());
    expect(content).toContain("] line-a\n");
    expect(content).toContain("] line-b\n");
    expect(content).not.toContain("\r");
  });

  it("行首头是 [engineLabel agentId ISO时间戳],stdout/stderr 分文件", () => {
    const sink = createEngineLogSink(root, RUN_ID, "hermes", "agent-9");
    sink.onStdout("out-line\n");
    sink.onStderr("err-line\n");
    sink.close();
    expect(read(stdoutLog())).toMatch(/^\[hermes agent-9 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] out-line\n$/);
    expect(read(stderrLog())).toMatch(/^\[hermes agent-9 \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] err-line\n$/);
  });
});

describe("createEngineLogSink — 脱敏", () => {
  it("每行过 redactSecrets:sk- 风格 key 不落盘", () => {
    const sink = createEngineLogSink(root, RUN_ID, "claude-code", "agent-1");
    sink.onStdout("using key sk-abcdefghijklmnop to auth\n");
    sink.onStderr("Authorization: Bearer abc123456789 rejected\n");
    sink.close();
    const out = read(stdoutLog());
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-abcdefghijklmnop");
    const err = read(stderrLog());
    expect(err).toContain("[REDACTED]");
    expect(err).not.toContain("Bearer abc123456789");
  });
});

describe("createEngineLogSink — 2MB 截断", () => {
  it("超过上限:写一行截断标记,之后全部丢弃,文件大小有界", () => {
    const sink = createEngineLogSink(root, RUN_ID, "codex", "agent-1");
    const bigLine = "x".repeat(64 * 1024);
    const lines = Math.ceil(ENGINE_LOG_MAX_BYTES / bigLine.length) + 4;
    sink.onStdout((bigLine + "\n").repeat(lines)); // 一个巨型 chunk,内含多行
    const sizeAfterCap = fs.statSync(stdoutLog()).size;
    expect(sizeAfterCap).toBeLessThanOrEqual(ENGINE_LOG_MAX_BYTES + 512); // 标记行允许微越界
    expect(read(stdoutLog())).toMatch(/\[truncated: 单文件超过 \d+ 字节上限,后续输出已丢弃\]\n$/);
    sink.onStdout("after-truncation should be dropped\n");
    sink.close();
    expect(fs.statSync(stdoutLog()).size).toBe(sizeAfterCap); // 截断后不再增长
    expect(read(stdoutLog())).not.toContain("after-truncation");
  });

  it("截断只作用于超限的流:stdout 截断后 stderr 照常写", () => {
    const sink = createEngineLogSink(root, RUN_ID, "codex", "agent-1");
    const bigLine = "y".repeat(64 * 1024);
    sink.onStdout((bigLine + "\n").repeat(Math.ceil(ENGINE_LOG_MAX_BYTES / bigLine.length) + 2));
    sink.onStderr("stderr still alive\n");
    sink.close();
    expect(read(stderrLog())).toContain("stderr still alive");
  });
});

describe("createEngineLogSink — best-effort 边界", () => {
  it("无 runId → 整体 no-op,不建目录不写文件", () => {
    const sink = createEngineLogSink(root, "", "claude-code", "agent-1");
    sink.onStdout("should not land\n");
    sink.onStderr("neither this\n");
    sink.close();
    expect(fs.existsSync(path.join(root, ".opc"))).toBe(false);
  });

  it("写失败(projectRoot 是个文件,mkdir 必败)→ 静默禁用,绝不抛", () => {
    const fileAsRoot = path.join(root, "not-a-dir.txt");
    fs.writeFileSync(fileAsRoot, "occupied", "utf-8");
    const sink = createEngineLogSink(fileAsRoot, RUN_ID, "hermes", "agent-1");
    expect(() => {
      sink.onStdout("line one\n");
      sink.onStdout("line two\n");
      sink.onStderr("err\n");
      sink.close();
    }).not.toThrow();
    expect(fs.readFileSync(fileAsRoot, "utf-8")).toBe("occupied"); // 原文件未被碰
  });

  it("同一 run 两个 sink(两个 agent)追加同一对文件:双方的行都在,靠头部区分", () => {
    const a = createEngineLogSink(root, RUN_ID, "claude-code", "agent-a");
    const b = createEngineLogSink(root, RUN_ID, "codex", "agent-b");
    a.onStdout("from a\n");
    b.onStdout("from b\n");
    a.close();
    b.close();
    const content = read(stdoutLog());
    expect(content).toMatch(/\[claude-code agent-a [^\]]+\] from a/);
    expect(content).toMatch(/\[codex agent-b [^\]]+\] from b/);
  });
});

// ── 引擎级:GenericCliEngine + mock spawn(现有引擎测试的注入姿势)→ 日志真实落盘且带头部 ──────

function fakeSpawn(resp: { code: number; stdout?: string; stderr?: string }) {
  return (_cmd: string, _args: readonly string[], _opts: any) => {
    const handlers: Record<string, (arg?: any) => void> = {};
    const child: any = {
      stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stdout) cb(Buffer.from(resp.stdout)); } },
      stderr: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data" && resp.stderr) cb(Buffer.from(resp.stderr)); } },
      stdin: { write: () => {}, end: () => {} },
      on: (e: string, cb: (arg?: any) => void) => { handlers[e] = cb; },
      kill: () => {},
      pid: 4242,
    };
    setImmediate(() => handlers["close"]?.(resp.code));
    return child;
  };
}

const agent: AgentNodeConfig = {
  id: "worker-log", name: "Worker", role: "worker", childrenIds: [],
  model: "some-model", provider: "testprov",
  status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
  editable: true, deletable: true, enabled: true,
};
const task: ExecTask = { taskId: "t1", goal: "do the thing", systemPrompt: "sys", maxTokens: 100 };
const preset: GenericCliConfig = {
  framework: "gemini-cli",
  command: "faketool",
  buildArgs: (prompt) => ["--prompt", prompt],
  trustExitCode: true,
  parseOutput: (stdout, _stderr, exitCode) => ({ content: stdout.trim(), ok: exitCode === 0 }),
};

describe("引擎级接线 — GenericCliEngine 的子进程输出落盘到 run 日志", () => {
  it("stdout/stderr 分别写入 backend.stdout.log / backend.stderr.log,行首带 [engineLabel agentId ts] 头", async () => {
    __setCliInstalledCheckForTest(() => ({ installed: true, version: "faketool 1.0.0" }));
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "engine says hi\npartial tail", stderr: "warn: something\n" }));
    const ctx: ExecContext = {
      runId: RUN_ID, projectRoot: root, workdir: root,
      emit: () => {},
      budget: { maxTokensPerTask: 4096 },
    };
    const res = await new GenericCliEngine(preset).run(agent, task, ctx);
    expect(res.status).toBe("done");
    const out = read(stdoutLog());
    expect(out).toMatch(/^\[gemini-cli worker-log \d{4}-\d{2}-\d{2}T[^\]]+\] engine says hi\n/);
    expect(out).toContain("] partial tail\n"); // close() 刷出的半行
    const err = read(stderrLog());
    expect(err).toMatch(/^\[gemini-cli worker-log [^\]]+\] warn: something\n$/);
  });

  it("无 runId 的调用(独立/测试场景)不产生任何日志文件", async () => {
    __setCliInstalledCheckForTest(() => ({ installed: true, version: "faketool 1.0.0" }));
    __setSpawnForTest(fakeSpawn({ code: 0, stdout: "hi\n" }));
    const ctx: ExecContext = {
      runId: "", projectRoot: root, workdir: root,
      emit: () => {},
      budget: { maxTokensPerTask: 4096 },
    };
    const res = await new GenericCliEngine(preset).run(agent, task, ctx);
    expect(res.status).toBe("done");
    expect(fs.existsSync(path.join(root, ".opc"))).toBe(false);
  });

  it("设置了 eventBus persistRoot 时日志落 canonical 根,不落传入的工作区根(活体验证抓到的公司文件夹分家坑)", async () => {
    const { setEventPersistRoot, getEventPersistRoot } = await import("./eventBus.js");
    const prev = getEventPersistRoot();
    const canonical = fs.mkdtempSync(path.join(os.tmpdir(), "elc-canon-"));
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "elc-ws-"));
    try {
      setEventPersistRoot(canonical);
      const sink = createEngineLogSink(workspaceRoot, "run-canon", "hermes", "a1");
      sink.onStdout("hello canonical\n");
      sink.close();
      const canonLog = path.join(canonical, ".opc", "runs", "run-canon", "logs", "backend.stdout.log");
      expect(fs.existsSync(canonLog)).toBe(true);
      expect(fs.readFileSync(canonLog, "utf-8")).toContain("hello canonical");
      expect(fs.existsSync(path.join(workspaceRoot, ".opc"))).toBe(false);
    } finally {
      setEventPersistRoot(prev ?? "");
      fs.rmSync(canonical, { recursive: true, force: true });
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
