// 相1 · ACP 客户端核心。自研 worker CLI 是唯一 ACP client(定稿 2.2)。本类:
//   spawn 引擎子进程 → ndJsonStream + ClientSideConnection(SDK v1.2.1,不手搓帧)→ initialize/
//   session·new/session·prompt → 把 session/update 通知映射到 Runtime Contract 词表事件 → 收工按
//   PID 树清理进程。
//
// 关键约束(任务书 + 2026-07-15 修订):
//  1) clientCapabilities 声明 fs/terminal 一律 false——引擎(claude-code/codex)用自身原生文件工具直接读写其
//     cwd,不经 Client 的 fs 反向方法,故本 Client 不实现 readTextFile/writeTextFile/terminal(留缺 = 不支持);
//  2) 反向请求 session/request_permission 必须应答(绝不挂死)+ 结构化 governance 记录(含 options 摘要)。
//     应答由 permissionPolicy 决定:缺省 "deny"(选 reject/cancelled);worker 执行路径传 "allow"(选引擎的
//     allow 选项)——因为该路径 cwd 是隔离临时沙盒、producer 必须在其中写交付(经 G1 recoverProducerDelta 带
//     越界/敏感/配额校验回收)。【纠正原任务书假设】原以为"fs 声明 false → agent 不发 permission 请求"故一律
//     deny;实测 claude-code 仍用原生 Write 并发 permission 请求,被 deny 即产 0 交付(全平台,非 Windows 缺陷);
//  3) 事件映射:agent_message_chunk→输出流事件(agent_output_chunk);agent_thought_chunk→thinking
//     (同为输出流事件,payload 带 thinking:true 以区分,不新造 TraceEvent 类型);tool_call→tool_call;
//     tool_call_update(completed/failed)→tool_result;usage_update/PromptResponse.usage→单条
//     model_call_finished(tokens/provider/model);
//  4) stopReason 只作"外部完成信号"记录,success 判定权归 Studio Core——本类绝不据 stopReason 标成功
//     (不返回任何 done/success 字段,只给原始证据)。
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type McpServer,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { killProcessTree, type AcpEngineSpec } from "./engineRegistry.js";
import { estimateTokensFromText } from "./tokenEstimate.js";

/** 与 ExecContext.emit 同形状——AcpClient 只依赖这个最小接口,便于单测注入假 sink。 */
export type AcpEmit = (type: string, agentId: string | undefined, payload: unknown) => void;

export interface AcpGovernanceEvent {
  kind: "permission_denied_by_policy" | "permission_granted_by_policy";
  sessionId?: string;
  toolCallId?: string;
  toolTitle?: string;
  /** 实际做出的决定(非配置项):granted→"allow";denied→"deny"。 */
  policy: "deny" | "allow";
  /** 应答方式:allow_option=按 allow 策略选中引擎 allow 选项;reject_option=选中 reject;cancelled=无对应选项时回取消。三者都不挂死。 */
  respondedWith: "allow_option" | "reject_option" | "cancelled";
  selectedOptionId?: string;
  /** 引擎提供的全部选项摘要(供审计/L3 审批闸对齐)。 */
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface AcpClientOptions {
  spec: AcpEngineSpec;
  /** 会话工作目录(session/new 的 cwd,须绝对路径)。 */
  cwd: string;
  /** 事件 sink(缺省 no-op)。生产:传 eventBus.emit;测试:传收集器。 */
  emit?: AcpEmit;
  agentId?: string;
  /** 只用于 model_call_finished 的证据字段——ACP 订阅引擎的 OPC 侧 provider/model 标识。 */
  provider?: string;
  model?: string;
  protocolVersion?: number;
  clientName?: string;
  clientVersion?: string;
  /** 握手(initialize+session/new)硬时限;超时判 restricted 而非挂死。缺省 30s。 */
  handshakeTimeoutMs?: number;
  /**
   * P1 · session/new 时声明给引擎的 MCP 服务器(stdio,command 绝对路径)。缺省空——OPC 把 .opc/mcp_servers.json
   * 里 enabled 的服务器映射成 ACP McpServer 后经此透传,让 claude-code worker 真正拿到 ddg-search/fetch 等 MCP 工具,
   * 不再退回 Terminal+curl。env OPC_ACP_MCP 门控加载(见 acpWorkerRunner)。
   */
  mcpServers?: McpServer[];
  /**
   * #4 · 握手瞬时失败重试次数(spawn/initialize/session/new 超时或传输错)。缺省 2。多 worker 并发冷启动时
   * 3 个 adapter+claude.exe 同时握手是超时高发窗口——重试(重新 spawn + 指数退避)能 self-heal 这类瞬时超时,
   * 把"3员工同时冷启动→30s超时→全体降级 legacy"这条链在降级前挡下。git-bash 缺失=确定性失败,短路不重试。
   * env OPC_ACP_HANDSHAKE_RETRIES 可覆盖。
   */
  handshakeRetries?: number;
  /** 单轮 prompt 硬时限;超时 cancel + 清理,绝不挂死。缺省 10 分钟。 */
  turnTimeoutMs?: number;
  /**
   * session/request_permission 应答策略:
   *  - "deny"(缺省):选 reject 选项(优先 reject_once,退 reject_always),否则 cancelled——text-only 会话 / chat
   *    等无写需求的调用方。
   *  - "allow":选引擎的 allow 选项(优先 allow_once,退 allow_always)。仅用于【隔离沙盒里必须写交付】的 worker
   *    执行路径(cwd=隔离临时根,交付经 G1 recoverProducerDelta 带越界/敏感/配额校验回收)。无 allow 选项时回退
   *    拒绝,绝不静默放行未知选项、绝不挂死。
   */
  permissionPolicy?: "deny" | "allow";
}

export interface AcpRunOutcome {
  protocolVersion: number;
  sessionId: string;
  /** 外部完成信号,仅作记录。"no_response" = 握手前进程就死了/无回。success 判定不看这个。 */
  stopReason: StopReason | "no_response";
  /** agent_message_chunk 累积文本(→ ExecResult.content 的证据来源)。 */
  message: string;
  /** agent_thought_chunk 累积文本(thinking 证据)。 */
  thinking: string;
  tokens: { prompt: number; completion: number; total: number };
  /** true = 引擎未上报 usage,tokens 由输出文本估算得来(如 claude-code ACP);成本页应标“估算”。 */
  estimated: boolean;
  /** 订阅引擎恒 0(flat-rate);仅 usage_update.cost 存在(api-key 模式)时透传。 */
  cost: number;
  toolCallCount: number;
  governanceEvents: AcpGovernanceEvent[];
  agentInfo?: { name?: string; version?: string };
}

/** AcpClient 无法建立到引擎的会话(spawn 失败/握手超时/协议错)。区别于"引擎跑完但产出需 Core 验收"。 */
export class AcpTransportError extends Error {
  constructor(message: string, public readonly stderrTail?: string) {
    super(message);
    this.name = "AcpTransportError";
  }
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
const DEFAULT_HANDSHAKE_RETRIES = 2; // #4:握手瞬时失败重试次数(可被 opts.handshakeRetries / env 覆盖)
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const STDERR_TAIL_MAX = 4096;

// #4 · git-bash 缺失是 Windows 上的确定性握手失败(不是瞬时超时)——重试无用,短路快速降级。
function isDeterministicHandshakeError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)) + (e instanceof AcpTransportError ? (e.stderrTail ?? "") : "");
  return /git[-\s]?bash|requires git-bash|CLAUDE_CODE_GIT_BASH_PATH/i.test(msg);
}

// P0(活体抓出)· ACP 适配器/底层 SDK 的【传输层横幅】——重连/超时/回退连接——会以 assistant text 身份经
// agent_message_chunk 到达,协议层无法与真实模型输出区分。绝不能进 turnMessage(否则被当交付内容 → 经 teamDesign
// 注入全体 worker,控制面错误污染工作内容,还伪造成"done")。
// 单行判定:严格锚定"传输横幅"形态,避免误杀提到 reconnect/timeout 的合法正文:重连必须带 `...` 或 N/M 计数;
// 超时/断连必须行首;回退连接横幅按其固定措辞。
function isTransportNoiseLine(l: string): boolean {
  return /^reconnecting(?:\.{2,}|\s*\(?\d+\s*\/\s*\d+)/i.test(l) ||   // Reconnecting... 2/5 / Reconnecting (2/5)
    /^(?:request timed out|connection lost|connection reset)\b/i.test(l) ||
    /falling back from websockets|websockets? to https transport/i.test(l);
}

// P0(用户审计抓出)· 逐行剥离传输横幅,保留真实模型输出。整块判定不够:适配器会把重连横幅与真实输出
// 塞进【同一个】chunk(lcm 活体里 `Reconnecting...`+`request timed out`+后续正文同块到达),整块要么全丢
// (吞掉真实交付)要么全进(污染 prompt)。按行清洗:噪声行进诊断、真实行进 turnMessage。返回 { clean, stripped };
// 无任何噪声行时 clean===原文(逐字不动,不改正常输出的换行/空白)。
export function stripAcpTransportNoise(text: string): { clean: string; stripped: string[] } {
  if (!text.includes("\n") && !isTransportNoiseLine(text.trim())) return { clean: text, stripped: [] };
  const stripped: string[] = [];
  const kept: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    if (t && isTransportNoiseLine(t)) stripped.push(t);
    else kept.push(raw);
  }
  if (stripped.length === 0) return { clean: text, stripped };
  return { clean: kept.join("\n").replace(/^\s+|\s+$/g, ""), stripped };
}

// 整块噪声判定(保留:握手前/纯横幅块的快速路径,以及既有测试面)。等价于"剥离后无真实内容"。
export function isAcpTransportNoise(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  return lines.every(isTransportNoiseLine);
}

function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let t: NodeJS.Timeout;
  const promise = new Promise<void>((resolve) => { t = setTimeout(resolve, ms); });
  return { promise, cancel: () => clearTimeout(t) };
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  const d = delay(ms);
  try {
    const race = await Promise.race([
      p.then((v) => ({ ok: true as const, v })),
      d.promise.then(() => ({ ok: false as const })),
    ]);
    if (!race.ok) throw onTimeout();
    return race.v;
  } finally {
    d.cancel();
  }
}

// 从 tool_call_update 提炼可读结果文本(优先 content 里的 text,退回 rawOutput 的 JSON,再退回 status)。
function summarizeToolResult(u: {
  content?: unknown;
  rawOutput?: unknown;
  status?: string | null;
}): string {
  if (Array.isArray(u.content)) {
    const parts: string[] = [];
    for (const c of u.content as Array<Record<string, unknown>>) {
      if (c && c.type === "content") {
        const inner = c.content as Record<string, unknown> | undefined;
        if (inner && inner.type === "text" && typeof inner.text === "string") parts.push(inner.text);
      }
    }
    if (parts.length) return parts.join("");
  }
  if (u.rawOutput !== undefined) {
    try { return JSON.stringify(u.rawOutput); } catch { return "[unserializable]"; }
  }
  return u.status ?? "";
}

export class AcpClient {
  private child?: ChildProcess;
  private stderrTail = "";
  private cleaned = false;
  private conn?: ClientSideConnection;
  private sessionId = "";
  private connected = false;
  private spawnError?: Error;
  private exited: Promise<void> = Promise.resolve();
  private pv: number = PROTOCOL_VERSION;
  private agentInfo?: { name?: string; version?: string };

  // 每轮累加器:prompt() 开头重置,连接期间由 clientHandler 写入(单会话同一时刻只有一轮在途,server 串行保证)。
  private turnMessage = "";
  private turnTransportError?: string; // P0:本轮命中的传输噪声(重连/超时横幅);整轮无真实输出时据此判传输失败
  private turnThinking = "";
  private turnToolCalls = 0;
  private turnUsageUpdate?: { used: number; size: number; cost?: number };
  private turnGovernance: AcpGovernanceEvent[] = [];

  constructor(private readonly opts: AcpClientOptions) {}

  /**
   * 建立会话:spawn 引擎 → ndjson 双向流 → initialize → session/new。成功后 connected=true,可反复 prompt()
   * (chat-serve 长驻模式)。spawn/握手失败按 PID 树清理并抛 AcpTransportError。幂等:已连接直接回既有会话信息。
   * #4:外层握手重试——瞬时握手超时(多 worker 并发冷启动挤兑)会自愈;git-bash 缺失等确定性失败短路不重试。
   */
  async connect(): Promise<{ protocolVersion: number; sessionId: string; agentInfo?: { name?: string; version?: string } }> {
    if (this.connected) return { protocolVersion: this.pv, sessionId: this.sessionId, agentInfo: this.agentInfo };
    const envRetries = Number(process.env.OPC_ACP_HANDSHAKE_RETRIES);
    const retries = Number.isFinite(envRetries) && envRetries >= 0
      ? Math.floor(envRetries)
      : (this.opts.handshakeRetries ?? DEFAULT_HANDSHAKE_RETRIES);
    const emit = this.opts.emit ?? (() => {});
    const agentId = this.opts.agentId;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      this.spawnError = undefined; // #4:每次尝试前清掉上一次的 spawn 错(在此重置不影响 connectOnce 的 CFA)
      try {
        return await this.connectOnce();
      } catch (e) {
        lastErr = e;
        // connectOnce 失败时已 cleanup()+等旧子进程退出;这里只判是否值得重试。
        if (isDeterministicHandshakeError(e)) throw e;   // git-bash 缺失=确定性,重试无用,快速降级
        if (attempt < retries) {
          const backoffMs = Math.min(4000, 400 * 2 ** attempt); // 400/800/1600…
          emit("info", agentId, { kind: "acp_handshake_retry", attempt: attempt + 1, of: retries, backoffMs, reason: (e instanceof Error ? e.message : String(e)).slice(0, 120) });
          await delay(backoffMs).promise;
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new AcpTransportError("ACP 握手失败(重试耗尽)");
  }

  /** 单次握手尝试:spawn → ndjson 流 → initialize → session/new。失败按 PID 树清理并抛 AcpTransportError。 */
  private async connectOnce(): Promise<{ protocolVersion: number; sessionId: string; agentInfo?: { name?: string; version?: string } }> {
    const emit = this.opts.emit ?? (() => {});
    const agentId = this.opts.agentId;
    this.pv = this.opts.protocolVersion ?? PROTOCOL_VERSION;
    const handshakeTimeoutMs = this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    // #4:每次尝试重置 stderr 尾(spawnError 由 connect() 在每次 connectOnce 前重置,避免 CFA 把它收窄成 undefined)。
    this.stderrTail = "";

    const child = spawn(this.opts.spec.command, this.opts.spec.args, {
      cwd: this.opts.cwd,
      env: this.opts.spec.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", // POSIX:自成进程组,便于按组杀
      shell: this.opts.spec.shell,
      windowsHide: true,
    });
    this.child = child;

    // 防止子进程/管道的 'error'(EPIPE、spawn ENOENT 等)冒泡成 unhandled 崩掉本进程。
    child.on("error", (e) => { this.spawnError = e; });
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("data", (buf: Buffer) => {
      this.stderrTail = (this.stderrTail + buf.toString("utf-8")).slice(-STDERR_TAIL_MAX);
    });
    child.stderr?.on("error", () => {});
    this.exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    // ndJsonStream(写向 agent 的流, 从 agent 读的流)。Writable.toWeb(stdin) = 我们发给 agent;
    // Readable.toWeb(stdout) = agent 发给我们。与 SDK 官方 client 示例一致。
    const toAgent = Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>;
    const fromAgent = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;

    const clientHandler: Client = {
      sessionUpdate: (params: SessionNotification): void => {
        const u = params.update;
        switch (u.sessionUpdate) {
          case "agent_message_chunk": {
            const text = u.content?.type === "text" ? u.content.text : "";
            if (text) {
              // P0(用户审计):逐行剥离传输横幅——同一 chunk 里混着噪声与真实输出时,只丢噪声行、保真实行。
              const { clean, stripped } = stripAcpTransportNoise(text);
              if (stripped.length) {
                // 传输层重连/超时/回退横幅——绝不进 turnMessage(否则被当交付内容/teamDesign 注入)。只进诊断事件 + 标 turnTransportError。
                this.turnTransportError = stripped.join(" | ").slice(0, 200);
                emit("info", agentId, { kind: "acp_transport_notice", text: stripped.join("\n").slice(0, 300) });
              }
              if (clean) {
                this.turnMessage += clean; emit("agent_output_chunk", agentId, { chunk: clean });
              }
            }
            break;
          }
          case "agent_thought_chunk": {
            const text = u.content?.type === "text" ? u.content.text : "";
            if (text) { this.turnThinking += text; emit("agent_output_chunk", agentId, { chunk: text, thinking: true }); }
            break;
          }
          case "tool_call": {
            this.turnToolCalls++;
            emit("tool_call", agentId, {
              name: u.title || u.toolCallId,
              args: u.rawInput ?? {},
              toolCallId: u.toolCallId,
              toolKind: u.kind,
              status: u.status,
            });
            break;
          }
          case "tool_call_update": {
            if (u.status === "completed" || u.status === "failed") {
              const result = summarizeToolResult(u);
              emit("tool_result", agentId, {
                name: u.toolCallId,
                result: u.status === "failed" ? `error: ${result}` : result,
                status: u.status,
              });
            }
            break;
          }
          case "usage_update": {
            this.turnUsageUpdate = { used: u.used, size: u.size, cost: u.cost?.amount };
            break;
          }
          default:
            break; // plan / mode / config 等 text-only MVP 暂不消费
        }
      },
      requestPermission: (params: RequestPermissionRequest): RequestPermissionResponse => {
        // 永远给出应答(绝不挂死)+ 结构化 governance 记录。策略见 AcpClientOptions.permissionPolicy:
        //  - allow:选引擎的 allow 选项(优先 allow_once,退 allow_always)→ granted;仅隔离沙盒 worker 路径启用
        //    (producer 必须写交付,回收侧再做越界/敏感/配额校验)。无 allow 选项则回退到 deny 分支。
        //  - deny(缺省)/allow 无 allow 选项:选 reject(优先 reject_once,退 reject_always),否则 cancelled。
        const rawOptions = params.options ?? [];
        const options = rawOptions.map((o) => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
        const base = {
          sessionId: params.sessionId,
          toolCallId: params.toolCall?.toolCallId,
          toolTitle: params.toolCall?.title ?? undefined,
          options,
        };
        const record = (gov: AcpGovernanceEvent) => {
          this.turnGovernance.push(gov);
          emit("info", agentId, {
            kind: gov.kind,
            sessionId: gov.sessionId,
            toolCallId: gov.toolCallId,
            toolTitle: gov.toolTitle,
            respondedWith: gov.respondedWith,
            selectedOptionId: gov.selectedOptionId,
            options,
          });
        };
        if ((this.opts.permissionPolicy ?? "deny") === "allow") {
          const allow =
            rawOptions.find((o) => o.kind === "allow_once") ??
            rawOptions.find((o) => o.kind === "allow_always");
          if (allow) {
            record({ ...base, kind: "permission_granted_by_policy", policy: "allow", respondedWith: "allow_option", selectedOptionId: allow.optionId });
            return { outcome: { outcome: "selected", optionId: allow.optionId } };
          }
          // allow 策略但引擎只给了 reject/无 allow 选项 → 回退拒绝(不静默放行未知选项,也不挂死)。
        }
        const reject =
          rawOptions.find((o) => o.kind === "reject_once") ??
          rawOptions.find((o) => o.kind === "reject_always");
        record({ ...base, kind: "permission_denied_by_policy", policy: "deny", respondedWith: reject ? "reject_option" : "cancelled", selectedOptionId: reject?.optionId });
        if (reject) return { outcome: { outcome: "selected", optionId: reject.optionId } };
        return { outcome: { outcome: "cancelled" } };
      },
      // fs/terminal 能力声明为 false → 不实现对应反向请求方法(留缺即"不支持")。
    };

    const stream = ndJsonStream(toAgent, fromAgent);
    this.conn = new ClientSideConnection(() => clientHandler, stream);

    try {
      const initResult = await withTimeout(
        this.conn.initialize({
          protocolVersion: this.pv,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: this.opts.clientName ?? "opc-worker", version: this.opts.clientVersion ?? "0.1.0" },
        }),
        handshakeTimeoutMs,
        () => new AcpTransportError(`ACP initialize 超时(${handshakeTimeoutMs}ms)`, this.stderrTail),
      );
      if (initResult.agentInfo) {
        this.agentInfo = { name: initResult.agentInfo.name, version: initResult.agentInfo.version };
      }

      const session = await withTimeout(
        this.conn.newSession({ cwd: this.opts.cwd, mcpServers: this.opts.mcpServers ?? [] }),
        handshakeTimeoutMs,
        () => new AcpTransportError(`ACP session/new 超时(${handshakeTimeoutMs}ms)`, this.stderrTail),
      );
      this.sessionId = session.sessionId;
      this.connected = true;
    } catch (e) {
      this.cleanup();
      await Promise.race([this.exited, delay(2000).promise]);
      if (e instanceof AcpTransportError) throw e;
      const detail = this.spawnError ? `${this.spawnError.message}` : ((e as Error | undefined)?.message ?? String(e));
      throw new AcpTransportError(`ACP 会话失败: ${detail}`, this.stderrTail);
    }

    return { protocolVersion: this.pv, sessionId: this.sessionId, agentInfo: this.agentInfo };
  }

  /**
   * 在已建会话上发一轮 prompt,收流,返回本轮原始证据(不清理会话——可继续 prompt())。未连接会先 connect()。
   * prompt 完成(含 refusal/max_tokens)正常返回,stopReason 只记录;超时 cancel 本轮并抛 AcpTransportError。
   * 每轮恰一条 model_call_finished 经 opts.emit 发出;chat-serve 不设 emit → 不落任何总线,tokens 随返回值上交
   * 由 server 侧唯一记账(避免与引擎路径双记)。
   */
  async prompt(promptText: string): Promise<AcpRunOutcome> {
    if (!this.connected) await this.connect();
    const emit = this.opts.emit ?? (() => {});
    const agentId = this.opts.agentId;
    const turnTimeoutMs = this.opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    const conn = this.conn!;

    // 每轮清零:message/thinking/toolCalls/usage_update/governance 都是本轮独立证据。
    // 经方法清零(而非就地赋值 undefined),避免 TS 把随后异步由 clientHandler 回填的字段错误收窄成 never。
    this.resetTurnAccumulators();

    let stopReason: StopReason | "no_response" = "no_response";
    let promptUsage: { totalTokens: number; inputTokens: number; outputTokens: number } | undefined;

    try {
      const promptResult = await withTimeout(
        conn.prompt({ sessionId: this.sessionId, prompt: [{ type: "text", text: promptText }] }),
        turnTimeoutMs,
        () => new AcpTransportError(`ACP session/prompt 超时(${turnTimeoutMs}ms)`, this.stderrTail),
      ).catch(async (e) => {
        // 超时:通知 agent 取消(best-effort),再把错误抛出去。
        if (e instanceof AcpTransportError && this.sessionId) {
          try { await conn.cancel({ sessionId: this.sessionId }); } catch { /* best-effort */ }
        }
        throw e;
      });
      stopReason = promptResult.stopReason;
      if (promptResult.usage) {
        promptUsage = {
          totalTokens: promptResult.usage.totalTokens ?? 0,
          inputTokens: promptResult.usage.inputTokens ?? 0,
          outputTokens: promptResult.usage.outputTokens ?? 0,
        };
      }
    } catch (e) {
      if (e instanceof AcpTransportError) throw e;
      const detail = this.spawnError ? `${this.spawnError.message}` : ((e as Error | undefined)?.message ?? String(e));
      throw new AcpTransportError(`ACP 会话失败: ${detail}`, this.stderrTail);
    }

    // P0:整轮只收到传输噪声(重连/超时)、无任何真实模型输出 → 判**传输失败**,绝不把噪声当交付内容返回。
    // 下游(acpWorkerRunner→acpWorkerBackend)据 AcpTransportError/status=failed 走保底降级,不消费噪声、不伪造 done。
    if (this.turnTransportError && !this.turnMessage.trim()) {
      throw new AcpTransportError(`ACP 传输中断(重连/超时),本轮无有效模型输出: ${this.turnTransportError}`, this.stderrTail);
    }
    const message = this.turnMessage;
    const thinking = this.turnThinking;
    // usage 优先级:PromptResponse.usage(真实) > usage_update.used(真实上下文用量) > 文本估算(标 estimated)。
    let tokens: { prompt: number; completion: number; total: number };
    let estimated = false;
    if (promptUsage) {
      tokens = { prompt: promptUsage.inputTokens, completion: promptUsage.outputTokens, total: promptUsage.totalTokens };
    } else if (this.turnUsageUpdate && this.turnUsageUpdate.used > 0) {
      tokens = { prompt: 0, completion: 0, total: this.turnUsageUpdate.used };
    } else {
      // 适配器未上报任何 usage(如 claude-code ACP):按已知的输入 prompt 与输出文本估算,标 estimated。
      const promptTok = estimateTokensFromText(promptText);
      const completion = estimateTokensFromText(message) + estimateTokensFromText(thinking);
      tokens = { prompt: promptTok, completion, total: promptTok + completion };
      estimated = tokens.total > 0;
    }
    const cost = this.turnUsageUpdate?.cost ?? 0;

    // 每轮恰一条 model_call_finished(与 acpBridge 的一次调用一条同款),usage_update/PromptResponse.usage
    // 折进这一条;stopReason 只作为附带的外部完成信号写进 payload,不参与任何成功判定。
    emit("model_call_finished", agentId, {
      tokens: tokens.total,
      cost,
      provider: this.opts.provider,
      model: this.opts.model,
      promptTokens: tokens.prompt,
      completionTokens: tokens.completion,
      estimated,
      stopReason,
    });

    return {
      protocolVersion: this.pv,
      sessionId: this.sessionId,
      stopReason,
      message,
      thinking,
      tokens,
      estimated,
      cost,
      toolCallCount: this.turnToolCalls,
      governanceEvents: this.turnGovernance,
      agentInfo: this.agentInfo,
    };
  }

  /**
   * 跑一整轮:握手 → 建会话 → 发 prompt → 收流 → 清理。返回原始证据(不含成功判定)。
   * 与既有单轮契约完全一致(= connect + prompt + 收尾清理)。
   * spawn/握手失败抛 AcpTransportError;prompt 完成(含 refusal/max_tokens)正常返回,stopReason 只记录。
   */
  async run(promptText: string): Promise<AcpRunOutcome> {
    try {
      await this.connect();
      return await this.prompt(promptText);
    } finally {
      this.cleanup();
      // 给进程一点收尾时间;不无限等(清理已按 PID 树杀过)。
      await Promise.race([this.exited, delay(2000).promise]);
    }
  }

  private resetTurnAccumulators(): void {
    this.turnMessage = "";
    this.turnTransportError = undefined;
    this.turnThinking = "";
    this.turnToolCalls = 0;
    this.turnUsageUpdate = undefined;
    this.turnGovernance = [];
  }

  /** 供测试观测 spawn 出的子进程(断言 PID 树清理确实杀掉了它)。 */
  getChild(): ChildProcess | undefined {
    return this.child;
  }

  /** true = 已建会话且未清理(chat-serve 判活)。 */
  isConnected(): boolean {
    return this.connected && !this.cleaned;
  }

  /** 幂等清理:关 stdin、按 PID 树杀子进程。 */
  cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;
    this.connected = false;
    const child = this.child;
    if (!child) return;
    try { child.stdin?.end(); } catch { /* ignore */ }
    killProcessTree(child);
  }
}
