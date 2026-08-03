// 订阅会话池 · chat-serve 长驻模式单测:用真 SDK 连"假 ACP agent"fixture(node 子进程,讲正确 ndjson),
// 覆盖 握手就绪帧 / 一条会话上两连问(含 system 折叠) / stdin EOF 优雅退出 / PID 树进程清理。测试内绝无真实模型调用。
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acpClient.js";
import type { AcpEngineSpec } from "./engineRegistry.js";
import { runChatServe } from "./chatServe.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "__fixtures__", "fakeAcpAgent.mjs");

function fixtureSpec(scenario: string): AcpEngineSpec {
  return { id: `fixture:${scenario}`, command: process.execPath, args: [FIXTURE, scenario], env: { ...process.env }, shell: false };
}

// 把一个可写流按行拆成"逐行异步取"通道(读 chat-serve 写出的 JSONL 响应帧)。
function lineChannel() {
  const stream = new PassThrough();
  const buffered: string[] = [];
  const waiters: Array<(l: string) => void> = [];
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  rl.on("line", (l) => {
    const t = l.trim();
    if (!t) return;
    const w = waiters.shift();
    if (w) w(t); else buffered.push(t);
  });
  const next = (): Promise<string> =>
    new Promise((res) => {
      const b = buffered.shift();
      if (b !== undefined) res(b); else waiters.push(res);
    });
  return { stream, next };
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runChatServe · 长驻对话服务(假 ACP agent,不打真模型)", () => {
  it("建会话发 ready 帧 → 一条会话上两连问(含 system 折叠) → EOF 退出 → PID 树清理", async () => {
    const inStream = new PassThrough();
    const out = lineChannel();
    let captured: AcpClient | undefined;

    const done = runChatServe({
      engine: "claude-code",
      input: inStream,
      output: out.stream,
      spec: fixtureSpec("echo-prompt"),
      makeClient: (spec) => {
        captured = new AcpClient({ spec, cwd: os.tmpdir(), handshakeTimeoutMs: 20_000, turnTimeoutMs: 20_000 });
        return captured;
      },
    });

    // 1) ready 帧(握手 + session/new 成功)
    const ready = JSON.parse(await out.next());
    expect(ready.type).toBe("ready");
    expect(ready.engine).toBe("claude-code");
    expect(ready.sessionId).toBeTruthy();

    // 2) 第一问:纯 prompt(echo fixture 原样回显 → 验证经既有会话发 session/prompt)
    inStream.write(JSON.stringify({ id: "q1", prompt: "第一问内容" }) + "\n");
    const r1 = JSON.parse(await out.next());
    expect(r1.id).toBe("q1");
    expect(r1.content).toContain("第一问内容");
    expect(r1.content).not.toContain("第二问"); // 本轮累加器只含本轮文本
    expect(r1.tokens).toBe(7); // echo fixture 上报的真实 usage
    expect(r1.promptTokens).toBe(5);
    expect(r1.completionTokens).toBe(2);
    expect(r1.estimated).toBe(false);

    // 3) 第二问:带 system(验证 system 折进本轮 prompt 文本)——复用同一条会话
    inStream.write(JSON.stringify({ id: "q2", system: "你是某某助手", prompt: "第二问内容" }) + "\n");
    const r2 = JSON.parse(await out.next());
    expect(r2.id).toBe("q2");
    expect(r2.content).toContain("你是某某助手");
    expect(r2.content).toContain("第二问内容");

    // 同一 AcpClient 实例(未重建会话)
    const child = captured!.getChild();
    expect(child).toBeDefined();
    const pid = child!.pid!;

    // 4) stdin EOF → 优雅退出
    inStream.end();
    await done;

    // 5) PID 树清理:fixture 子进程已被杀
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      alive = isAlive(pid);
      if (alive) await sleep(100);
    }
    expect(alive).toBe(false);
  }, 40_000);

  it("对话路径不注入 spec 时,codex 经 buildEngineSpec(chat) 拿到低时延 reasoning effort 默认(CODEX_CONFIG)", async () => {
    const inStream = new PassThrough();
    const out = lineChannel();
    let capturedSpec: AcpEngineSpec | undefined;
    // 假 client:只需 connect/prompt/cleanup 三个方法,绝不 spawn 真 codex,绝不打真模型。
    const stub = {
      connect: async () => ({ protocolVersion: 1, sessionId: "s-codex" }),
      prompt: async () => { throw new Error("unused in this test"); },
      cleanup: () => {},
    } as unknown as AcpClient;

    const done = runChatServe({
      engine: "codex",
      input: inStream,
      output: out.stream,
      // 刻意不传 spec → 强制走 buildEngineSpec(engine, { chat: true })
      makeClient: (spec) => { capturedSpec = spec; return stub; },
    });

    const ready = JSON.parse(await out.next());
    expect(ready.engine).toBe("codex");
    expect(capturedSpec).toBeDefined();
    expect(capturedSpec!.env.CODEX_CONFIG).toBeTruthy();
    const cfg = JSON.parse(capturedSpec!.env.CODEX_CONFIG!);
    expect(["minimal", "low", "medium", "high", "xhigh"]).toContain(cfg.model_reasoning_effort);

    inStream.end();
    await done;
  }, 20_000);

  it("显式 reasoningEffort 透传给 buildEngineSpec:codex 会话按该档注入 CODEX_CONFIG", async () => {
    const inStream = new PassThrough();
    const out = lineChannel();
    let capturedSpec: AcpEngineSpec | undefined;
    const stub = {
      connect: async () => ({ protocolVersion: 1, sessionId: "s-codex" }),
      prompt: async () => { throw new Error("unused in this test"); },
      cleanup: () => {},
    } as unknown as AcpClient;

    const done = runChatServe({
      engine: "codex",
      input: inStream,
      output: out.stream,
      reasoningEffort: "high", // 员工显式选「高」→ 应以此档为准(非对话默认 low)
      makeClient: (spec) => { capturedSpec = spec; return stub; },
    });

    const ready = JSON.parse(await out.next());
    expect(ready.engine).toBe("codex");
    expect(JSON.parse(capturedSpec!.env.CODEX_CONFIG!).model_reasoning_effort).toBe("high");

    inStream.end();
    await done;
  }, 20_000);

  it("引擎不报 usage(no-usage fixture)→ 响应标 estimated 且 tokens 走文本估算", async () => {
    const inStream = new PassThrough();
    const out = lineChannel();
    const done = runChatServe({
      engine: "claude-code",
      input: inStream,
      output: out.stream,
      spec: fixtureSpec("no-usage"),
      makeClient: (spec) => new AcpClient({ spec, cwd: os.tmpdir(), handshakeTimeoutMs: 20_000, turnTimeoutMs: 20_000 }),
    });

    expect(JSON.parse(await out.next()).type).toBe("ready");
    inStream.write(JSON.stringify({ id: "x", prompt: "只输出 OK" }) + "\n");
    const r = JSON.parse(await out.next());
    expect(r.id).toBe("x");
    expect(r.content).toBe("OK");
    expect(r.estimated).toBe(true);
    expect(r.tokens).toBeGreaterThan(0);

    inStream.end();
    await done;
  }, 40_000);
});
