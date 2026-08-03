// 相1 · AcpClient 核心单测:用真 SDK 连一个"假 ACP agent"fixture(node 子进程,讲正确 ndjson),
// 覆盖 握手 / 建会话 / 流事件映射 / permission deny governance / PID 树进程清理。测试内绝无真实模型调用。
import { describe, it, expect } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpClient } from "./acpClient.js";
import type { AcpEngineSpec } from "./engineRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "__fixtures__", "fakeAcpAgent.mjs");

// fixture spec:node 直起(shell:false),不经 npx、不碰真引擎。
function fixtureSpec(scenario: string): AcpEngineSpec {
  return {
    id: `fixture:${scenario}`,
    command: process.execPath,
    args: [FIXTURE, scenario],
    env: { ...process.env },
    shell: false,
  };
}

interface Captured { type: string; agentId?: string; payload: Record<string, unknown> }

function makeClient(scenario: string, captured: Captured[], permissionPolicy?: "deny" | "allow") {
  return new AcpClient({
    spec: fixtureSpec(scenario),
    cwd: os.tmpdir(),
    agentId: "agent-x",
    provider: "prov-x",
    model: "model-x",
    emit: (type, agentId, payload) => captured.push({ type, agentId, payload: payload as Record<string, unknown> }),
    handshakeTimeoutMs: 20_000,
    turnTimeoutMs: 20_000,
    ...(permissionPolicy ? { permissionPolicy } : {}),
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AcpClient · basic 场景(握手 + 建会话 + 流事件映射)", () => {
  it("跑通并把 ACP 通知映射到 Runtime Contract 词表", async () => {
    const captured: Captured[] = [];
    const client = makeClient("basic", captured);
    const outcome = await client.run("请做点事");

    // 握手 + 会话
    expect(outcome.protocolVersion).toBe(1);
    expect(outcome.sessionId).toBeTruthy();
    expect(outcome.agentInfo?.name).toBe("fake-acp-agent");

    // 外部完成信号:只记录,不据此标成功
    expect(outcome.stopReason).toBe("end_turn");

    // 文本证据
    expect(outcome.message).toBe("Hello world");
    expect(outcome.thinking).toBe("thinking about it...");

    // usage_update/PromptResponse.usage 折进 tokens
    expect(outcome.tokens).toEqual({ prompt: 12, completion: 18, total: 30 });
    expect(outcome.cost).toBe(0);
    expect(outcome.toolCallCount).toBe(1);
    expect(outcome.governanceEvents).toHaveLength(0);

    // agent_message_chunk → agent_output_chunk(输出流事件)
    const msgChunks = captured.filter((e) => e.type === "agent_output_chunk" && !e.payload.thinking);
    expect(msgChunks.map((e) => e.payload.chunk)).toEqual(["Hello ", "world"]);

    // agent_thought_chunk → thinking(同为输出流事件,payload.thinking 标记以区分)
    const thoughtChunks = captured.filter((e) => e.type === "agent_output_chunk" && e.payload.thinking === true);
    expect(thoughtChunks.map((e) => e.payload.chunk)).toEqual(["thinking about it..."]);

    // tool_call → tool_call
    const toolCalls = captured.filter((e) => e.type === "tool_call");
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].payload.name).toBe("Read README");
    expect(toolCalls[0].agentId).toBe("agent-x");

    // tool_call_update(completed) → tool_result
    const toolResults = captured.filter((e) => e.type === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(String(toolResults[0].payload.result)).toContain("file contents here");
    expect(toolResults[0].payload.status).toBe("completed");

    // usage_update/PromptResponse.usage → 单条 model_call_finished(带 provider/model + stopReason)
    const mcf = captured.filter((e) => e.type === "model_call_finished");
    expect(mcf).toHaveLength(1);
    expect(mcf[0].payload.tokens).toBe(30);
    expect(mcf[0].payload.provider).toBe("prov-x");
    expect(mcf[0].payload.model).toBe("model-x");
    expect(mcf[0].payload.stopReason).toBe("end_turn");
  }, 40_000);
});

describe("AcpClient · usage 缺失时按文本估算(claude-code ACP 场景)", () => {
  it("引擎不报 usage → tokens 由输出文本估算且标 estimated:true", async () => {
    const captured: Captured[] = [];
    const client = makeClient("no-usage", captured);
    const outcome = await client.run("请只输出 OK");

    expect(outcome.message).toBe("OK");
    expect(outcome.estimated).toBe(true);
    expect(outcome.tokens.total).toBeGreaterThan(0);

    const mcf = captured.filter((e) => e.type === "model_call_finished");
    expect(mcf).toHaveLength(1);
    expect(mcf[0].payload.estimated).toBe(true);
    expect(mcf[0].payload.tokens as number).toBeGreaterThan(0);
  }, 40_000);

  it("引擎上报真实 usage(basic)→ 不估算,estimated:false", async () => {
    const captured: Captured[] = [];
    const client = makeClient("basic", captured);
    const outcome = await client.run("请做点事");
    expect(outcome.estimated).toBe(false);
    expect(outcome.tokens).toEqual({ prompt: 12, completion: 18, total: 30 });
    const mcf = captured.filter((e) => e.type === "model_call_finished");
    expect(mcf[0].payload.estimated).toBe(false);
  }, 40_000);
});

describe("AcpClient · permission deny(反向请求应答 + governance)", () => {
  it("提供 reject 选项时选中 reject 并记录 governance,绝不挂死", async () => {
    const captured: Captured[] = [];
    const client = makeClient("permission", captured);
    const outcome = await client.run("改配置");

    expect(outcome.stopReason).toBe("end_turn"); // 未挂死,正常收尾
    expect(outcome.governanceEvents).toHaveLength(1);
    const gov = outcome.governanceEvents[0];
    expect(gov.kind).toBe("permission_denied_by_policy");
    expect(gov.policy).toBe("deny");
    expect(gov.respondedWith).toBe("reject_option");
    expect(gov.selectedOptionId).toBe("reject");
    expect(gov.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);

    // 同时 emit 一条结构化 governance 事件(含 options 摘要)
    const govEvents = captured.filter((e) => e.type === "info" && e.payload.kind === "permission_denied_by_policy");
    expect(govEvents).toHaveLength(1);
    expect(Array.isArray(govEvents[0].payload.options)).toBe(true);
  }, 40_000);

  it("无 reject 选项时回 cancelled(仍不挂死)", async () => {
    const captured: Captured[] = [];
    const client = makeClient("permission-noreject", captured);
    const outcome = await client.run("改配置");

    expect(outcome.governanceEvents).toHaveLength(1);
    expect(outcome.governanceEvents[0].respondedWith).toBe("cancelled");
    expect(outcome.governanceEvents[0].selectedOptionId).toBeUndefined();
  }, 40_000);
});

// 根因修复(2026-07-15):worker 执行路径 permissionPolicy:"allow" —— claude-code 原生 Write 的 permission 请求
// 必须被批准,否则 producer 恒产 0 交付(全平台,非 Windows 缺陷)。沙盒 cwd + G1 回收侧校验是安全边界。
describe("AcpClient · permission allow(sandbox worker 路径:批准 producer 写交付)", () => {
  it("policy=allow + 引擎给 allow 选项 → 选中 allow_once 并记 granted governance", async () => {
    const captured: Captured[] = [];
    const client = makeClient("permission", captured, "allow");
    const outcome = await client.run("写交付文件");

    expect(outcome.stopReason).toBe("end_turn");
    // fixture 收到 selected:allow 后会回显 ` [permission selected:allow]`——即引擎确实拿到了"批准"
    expect(outcome.message).toContain("permission selected:allow");
    expect(outcome.governanceEvents).toHaveLength(1);
    const gov = outcome.governanceEvents[0];
    expect(gov.kind).toBe("permission_granted_by_policy");
    expect(gov.policy).toBe("allow");
    expect(gov.respondedWith).toBe("allow_option");
    expect(gov.selectedOptionId).toBe("allow");

    const grantEvents = captured.filter((e) => e.type === "info" && e.payload.kind === "permission_granted_by_policy");
    expect(grantEvents).toHaveLength(1);
    expect(Array.isArray(grantEvents[0].payload.options)).toBe(true);
  }, 40_000);

  it("policy=allow 但引擎只给 reject(无 allow 选项)→ 回退拒绝,绝不静默放行未知选项", async () => {
    const captured: Captured[] = [];
    // reject-only 场景:构造一个只给 reject 选项的权限请求(用 permission 的镜像——这里复用 deny 语义验回退)。
    const client = makeClient("permission-rejectonly", captured, "allow");
    const outcome = await client.run("写交付文件");

    expect(outcome.governanceEvents).toHaveLength(1);
    expect(outcome.governanceEvents[0].kind).toBe("permission_denied_by_policy");
    expect(outcome.governanceEvents[0].respondedWith).toBe("reject_option");
  }, 40_000);
});

describe("AcpClient · stopReason 只作外部信号", () => {
  it("refusal 也正常返回(不因 stopReason 判失败/成功)", async () => {
    const captured: Captured[] = [];
    const client = makeClient("refusal", captured);
    const outcome = await client.run("做坏事");
    expect(outcome.stopReason).toBe("refusal");
    expect(outcome.message).toContain("cannot");
  }, 40_000);
});

describe("AcpClient · 进程清理(PID 树)", () => {
  it("常驻子进程(linger)在 run 收尾后被杀掉", async () => {
    const captured: Captured[] = [];
    const client = makeClient("linger", captured);
    await client.run("干活");

    const child = client.getChild();
    expect(child).toBeDefined();
    const pid = child!.pid!;
    // 轮询确认进程已死(taskkill /T 已在 cleanup 里跑过)。
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      alive = isAlive(pid);
      if (alive) await sleep(100);
    }
    expect(alive).toBe(false);
  }, 40_000);
});

import { isAcpTransportNoise, stripAcpTransportNoise, AcpTransportError } from "./acpClient.js";

describe("P0 · ACP 传输噪声隔离(isAcpTransportNoise + run 行为)", () => {
  it("整块传输横幅判为噪声;混入真实 prose 的块不误判", () => {
    expect(isAcpTransportNoise("Reconnecting... 2/5")).toBe(true);
    expect(isAcpTransportNoise("Reconnecting... 2/5\n\nrequest timed out")).toBe(true);
    expect(isAcpTransportNoise("Warning: Falling back from WebSockets to HTTPS transport. request timed out")).toBe(true);
    expect(isAcpTransportNoise("connection lost")).toBe(true);
    expect(isAcpTransportNoise("")).toBe(false);
    // 合法正文即便提到 timeout 也不误杀(存在非噪声行)
    expect(isAcpTransportNoise("我实现了重试逻辑,超时后 request timed out 会返回错误码。")).toBe(false);
    expect(isAcpTransportNoise("Reconnecting the database pool in my code as designed.")).toBe(false);
  });

  it("整轮只有传输噪声、无真实输出 → run() 抛 AcpTransportError,不把噪声当交付", async () => {
    const captured: Captured[] = [];
    const client = makeClient("reconnect-noise", captured);
    await expect(client.run("做点事")).rejects.toBeInstanceOf(AcpTransportError);
    // 噪声只进诊断事件,不进 agent_output_chunk(交付流)
    expect(captured.some((e) => e.type === "info" && (e.payload).kind === "acp_transport_notice")).toBe(true);
    expect(captured.some((e) => e.type === "agent_output_chunk")).toBe(false);
  }, 30_000);

  it("先噪声后真实内容 → 剥离噪声,只返回真实交付(不判失败)", async () => {
    const captured: Captured[] = [];
    const client = makeClient("reconnect-then-content", captured);
    const outcome = await client.run("做点事");
    expect(outcome.message).toBe("真实交付:已实现 isPrime 函数并通过测试。");
    expect(outcome.message).not.toMatch(/Reconnecting|timed out/);
  }, 30_000);

  it("P0(用户审计)· 噪声与真实输出混在【同一 chunk】→ 逐行剥离,保真实、丢横幅,不污染交付", async () => {
    const captured: Captured[] = [];
    const client = makeClient("mixed-chunk-noise", captured);
    const outcome = await client.run("做点事");
    // 真实两行保留、拼接;横幅两行(Reconnecting/timed out)绝不进 message
    expect(outcome.message).toBe("真实交付:已实现 lcm 函数。\n并通过 node lcm.test.js(exit 0)。");
    expect(outcome.message).not.toMatch(/Reconnecting|timed out|request timed/i);
    // 横幅进诊断事件;真实内容进交付流
    expect(captured.some((e) => e.type === "info" && (e.payload).kind === "acp_transport_notice")).toBe(true);
    const outChunks = captured.filter((e) => e.type === "agent_output_chunk");
    expect(outChunks.length).toBeGreaterThan(0);
    expect(outChunks.every((e) => !/Reconnecting|timed out/i.test(String(e.payload.chunk)))).toBe(true);
  }, 30_000);

  it("stripAcpTransportNoise 纯函数:同块混合逐行剥离 / 无噪声原样返回 / 纯噪声 clean 空", () => {
    const mixed = stripAcpTransportNoise("Reconnecting... 2/5\n真实A\nrequest timed out\n真实B");
    expect(mixed.clean).toBe("真实A\n真实B");
    expect(mixed.stripped).toEqual(["Reconnecting... 2/5", "request timed out"]);
    const pure = stripAcpTransportNoise("我在正文里提到了 request timed out 的处理逻辑。");
    expect(pure.clean).toBe("我在正文里提到了 request timed out 的处理逻辑。");
    expect(pure.stripped).toEqual([]);
    const allNoise = stripAcpTransportNoise("Reconnecting... 2/5\nconnection lost");
    expect(allNoise.clean).toBe("");
    expect(allNoise.stripped.length).toBe(2);
  });
});

// #4 · 握手瞬时失败重试:多 worker 并发冷启动挤兑导致 initialize 超时时,connect() 应重新 spawn 重试而非
// 一次超时就抛。用"spawn 成功但从不讲 ndjson"的挂起命令模拟握手超时,小 handshakeTimeoutMs + handshakeRetries。
describe("#4 · ACP 握手瞬时失败重试", () => {
  function hangingSpec(): AcpEngineSpec {
    // 起一个 node 进程,永不输出 ndjson(setInterval 挂住)→ initialize 必超时。
    return { id: "fixture:hang", command: process.execPath, args: ["-e", "setInterval(()=>{}, 1000)"], env: { ...process.env }, shell: false };
  }
  it("initialize 超时 → 重试 handshakeRetries 次后才抛(共 retries+1 次尝试,发 acp_handshake_retry 事件)", async () => {
    const captured: Captured[] = [];
    const client = new AcpClient({
      spec: hangingSpec(), cwd: os.tmpdir(), agentId: "agent-retry",
      emit: (type, agentId, payload) => captured.push({ type, agentId, payload: payload as Record<string, unknown> }),
      handshakeTimeoutMs: 150, handshakeRetries: 2,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(AcpTransportError);
    // retries=2 → 前 2 次失败后各发一次重试事件(第 3 次是最后一次,失败即抛,不再发重试)
    const retryEvents = captured.filter((e) => (e.payload as any)?.kind === "acp_handshake_retry");
    expect(retryEvents.length).toBe(2);
    expect((retryEvents[0].payload as any).attempt).toBe(1);
    expect((retryEvents[1].payload as any).attempt).toBe(2);
  }, 20_000);

  it("handshakeRetries=0 → 不重试,一次超时即抛(无重试事件)", async () => {
    const captured: Captured[] = [];
    const client = new AcpClient({
      spec: hangingSpec(), cwd: os.tmpdir(), agentId: "agent-noretry",
      emit: (type, agentId, payload) => captured.push({ type, agentId, payload: payload as Record<string, unknown> }),
      handshakeTimeoutMs: 150, handshakeRetries: 0,
    });
    await expect(client.connect()).rejects.toBeInstanceOf(AcpTransportError);
    expect(captured.filter((e) => (e.payload as any)?.kind === "acp_handshake_retry").length).toBe(0);
  }, 20_000);
});
