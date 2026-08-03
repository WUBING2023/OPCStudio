// 订阅对话会话池 · server 侧。背景:对话模式下问订阅员工每条消息都冷启动(spawn worker → npx adapter →
// ACP 握手 → prompt),10-30s。架构约束(用户定稿):worker CLI 是全系统唯一 ACP client——server 不得自己直连
// adapter。故这里池化 worker 进程:每引擎至多 1 个常驻 chat-serve worker(订阅并发锁语义天然不变:1 worker +
// 请求串行 = 并发 1),get-or-spawn + 请求排队串行;空闲 5 分钟 TTL 杀树回收;进程死亡自动从池摘除,下次请求
// 冷启动一次。逃生门 OPC_ACP_CHAT_POOL=0 关池(调用方回退一次性引擎链)。
//
// 记账纪律(任务书 3):worker chat-serve 侧**不**发 model_call_finished(它无 run 上下文);tokens 随 JSONL
// 响应上交,由 systemModelInvoke 订阅分支在池路径成功后**唯一**发一条 model_call_finished 入账(勿双记)。
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import type { ReasoningEffort } from "@opc/shared";
import { buildCliWorkerEnv, buildCliWorkerLaunch } from "./engines/workerLaunch.js";

export type ChatEngineId = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

/** systemModelInvoke → 池:一条对话/一次性文本请求。 */
export interface ChatPoolRequest {
  id: string;
  system?: string;
  prompt: string;
  maxTokens: number;
}

/** worker → 池:一条响应(经 chat-serve JSONL 帧解析)。error 非空即本轮失败。 */
export interface ChatWorkerResponse {
  id: string;
  content: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  stopReason?: string;
  error?: string;
}

/** 池对外的成功结果(失败以 throw 表示 → 调用方降级到一次性引擎链)。 */
export interface ChatPoolResult {
  content: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
}

/** 一个常驻 chat worker 句柄。默认实现 spawn 真进程;单测注入假实现(不 spawn、可控)。 */
export interface ChatWorkerHandle {
  /** 发一条请求,按 id 关联响应(worker 侧串行,一次一条在途)。 */
  send(req: ChatPoolRequest): Promise<ChatWorkerResponse>;
  /** 按 PID 树杀掉 worker + adapter。幂等。 */
  kill(): void;
  /** worker 进程退出/死亡时 resolve(池据此把它从 lane 摘除)。 */
  readonly exited: Promise<void>;
}

/** spawn 一个已就绪(收到 ready 帧)的 chat worker;resolve 前即已握手成功。失败 reject → 调用方降级。
 *  effort:该会话的订阅推理档位(codex 经 env OPC_CODEX_CHAT_EFFORT → buildEngineSpec 生效;其余引擎忽略)。 */
export type SpawnChatWorkerFn = (engine: ChatEngineId, effort?: ReasoningEffort) => Promise<ChatWorkerHandle>;

// 逃生门:OPC_ACP_CHAT_POOL=0/false 关池。单测环境(VITEST)默认关池——池自身经注入 spawn 直测,绝不误 spawn
// 真 worker/真调模型;走 systemModelInvoke 的消费点在单测里因此照旧走一次性引擎链(行为不变)。
export function chatPoolEnabled(): boolean {
  const v = process.env.OPC_ACP_CHAT_POOL;
  if (v === "0" || v === "false") return false;
  if (process.env.VITEST) return false;
  return true;
}

const DEFAULT_IDLE_TTL_MS = 5 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;

export interface SubscriptionChatPoolOptions {
  /** 仅供单测注入:替换 spawn(默认 spawn npx tsx worker.ts chat-serve)。 */
  spawnWorker?: SpawnChatWorkerFn;
  idleTtlMs?: number;
  readyTimeoutMs?: number;
  requestTimeoutMs?: number;
}

interface Lane {
  /** spawn 中/已就绪的 worker;串行链上的任务 await 这个 promise 拿到 worker。 */
  spawning: Promise<ChatWorkerHandle>;
  worker?: ChatWorkerHandle;
  /** 每引擎串行链:所有 invoke 顺次接在这后面(swallow 掉错误以免一次失败断链)。 */
  chain: Promise<unknown>;
  idleTimer?: ReturnType<typeof setTimeout>;
  /** 该常驻 worker 建会话时的推理档位。档位变更 → 摘除旧 worker 冷启动新档(守每引擎至多 1 常驻,订阅并发 1)。 */
  effort?: ReasoningEffort;
}

export class SubscriptionChatPool {
  private lanes = new Map<ChatEngineId, Lane>();
  private readonly spawnWorker: SpawnChatWorkerFn;
  private readonly idleTtlMs: number;
  private readonly requestTimeoutMs: number;

  constructor(opts: SubscriptionChatPoolOptions = {}) {
    this.spawnWorker = opts.spawnWorker ?? defaultSpawnChatWorker(opts);
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * 经该引擎的常驻 worker 发一轮请求。get-or-spawn(至多 1 worker)+ 串行排队 + 空闲 TTL。
   * spawn/send/超时失败或 worker 回错误 → 杀掉并从池摘除,throw(调用方回退一次性引擎链)。
   * effort:本轮请求的推理档位;与常驻 worker 当前档位不一致时,先摘除旧 worker 再按新档冷启动一次
   * (每引擎仍至多 1 个常驻 worker,守住订阅并发 1)。
   */
  async invoke(engine: ChatEngineId, req: ChatPoolRequest, effort?: ReasoningEffort): Promise<ChatPoolResult> {
    const lane = this.ensureLane(engine, effort);
    return this.runSerial(lane, async () => {
      let worker: ChatWorkerHandle;
      try {
        worker = await lane.spawning; // spawn 失败在这里抛(lane 已在 ensureLane 的 catch 里摘除)
      } catch (e) {
        throw wrapError(e, "订阅会话池 spawn worker 失败");
      }
      this.clearIdle(lane);
      let resp: ChatWorkerResponse;
      try {
        resp = await withTimeout(worker.send(req), this.requestTimeoutMs, `订阅会话池请求超时(${this.requestTimeoutMs}ms)`);
      } catch (e) {
        this.dropLane(engine, lane); // send 失败/超时 → worker 不可信,杀掉重置
        throw wrapError(e, "订阅会话池请求失败");
      }
      if (resp.error) {
        this.dropLane(engine, lane); // worker 侧会话失效 → 杀掉重置
        throw new Error(`订阅会话池 worker 回错误: ${resp.error}`);
      }
      this.armIdle(engine, lane); // 本轮成功 → 重置空闲计时
      return {
        content: resp.content,
        tokens: resp.tokens,
        promptTokens: resp.promptTokens,
        completionTokens: resp.completionTokens,
        estimated: resp.estimated,
      };
    });
  }

  /** 杀掉所有常驻 worker(server 关停/测试收尾)。 */
  shutdown(): void {
    for (const [engine, lane] of [...this.lanes]) this.dropLane(engine, lane);
  }

  /** get-or-spawn:同步取回(或新建)lane,把 worker 死亡/spawn 失败的摘除挂上。并发 invoke 复用同一 spawning。
   *  档位一致 → 复用暖 worker;档位变更 → 摘除旧 worker 冷启动新档(每引擎至多 1 常驻,守订阅并发 1)。 */
  private ensureLane(engine: ChatEngineId, effort?: ReasoningEffort): Lane {
    const existing = this.lanes.get(engine);
    if (existing) {
      if (existing.effort === effort) return existing;
      this.dropLane(engine, existing); // 档位变更:摘除旧 worker,下面按新档冷启动
    }
    const lane: Lane = { spawning: undefined as unknown as Promise<ChatWorkerHandle>, chain: Promise.resolve(), effort };
    lane.spawning = this.spawnWorker(engine, effort).then(
      (w) => {
        lane.worker = w;
        // worker 进程死亡 → 若仍是当前 lane,摘除(下次请求冷启动一次)。
        w.exited.then(() => { if (this.lanes.get(engine) === lane) this.dropLane(engine, lane); }, () => {});
        return w;
      },
      (e) => {
        if (this.lanes.get(engine) === lane) this.lanes.delete(engine); // spawn 失败:摘除,下次重试
        throw e;
      },
    );
    // 防止 spawn 失败时 spawning 变成 unhandled rejection(runSerial 里会真正消费它)。
    lane.spawning.catch(() => {});
    this.lanes.set(engine, lane);
    return lane;
  }

  // 每引擎串行:把 fn 接到 lane.chain 尾部;chain 本身 swallow 错误以免一次失败断掉后续。
  private runSerial<T>(lane: Lane, fn: () => Promise<T>): Promise<T> {
    const result = lane.chain.then(fn, fn);
    lane.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  private dropLane(engine: ChatEngineId, lane: Lane): void {
    if (this.lanes.get(engine) === lane) this.lanes.delete(engine);
    this.clearIdle(lane);
    try { lane.worker?.kill(); } catch { /* best-effort */ }
  }

  private armIdle(engine: ChatEngineId, lane: Lane): void {
    this.clearIdle(lane);
    const timer = setTimeout(() => { this.dropLane(engine, lane); }, this.idleTtlMs);
    (timer as { unref?: () => void }).unref?.(); // 空闲计时不该拖住进程退出
    lane.idleTimer = timer;
  }

  private clearIdle(lane: Lane): void {
    if (lane.idleTimer) { clearTimeout(lane.idleTimer); lane.idleTimer = undefined; }
  }
}

function wrapError(e: unknown, prefix: string): Error {
  const msg = e instanceof Error ? e.message : String(e);
  return new Error(`${prefix}: ${msg}`);
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── 默认 spawn:真起 chat-serve worker 子进程,做 ready 握手 + JSONL 帧收发 ──────────────────────

// spawn worker 的 env:继承 server env,删 CLAUDECODE(探针 #4 嵌套会话自杀守卫)、剥订阅禁忌 key(探针 #5)。
// 绝不注入任何 *_API_KEY——认证靠 worker 内 ~/.claude / ~/.codex 订阅登录态。
// effort:订阅推理档位——经 env OPC_CODEX_CHAT_EFFORT 透传给 worker 内 buildEngineSpec 的对话路径(codex 生效,
// 其余引擎忽略)。worker CLI 入口(worker.ts,域外)未加 --effort 参数,故这里走 env 通道(buildEngineSpec 本就读它)。
function buildWorkerEnv(effort?: ReasoningEffort): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDECODE;
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  if (effort) env.OPC_CODEX_CHAT_EFFORT = effort;
  return env;
}

// best-effort 按 PID 树杀子进程(worker 起孙进程:tsx→node→ACP adapter→app-server)。win32 taskkill /T。
function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  } catch { /* best-effort */ }
}

function defaultSpawnChatWorker(opts: SubscriptionChatPoolOptions): SpawnChatWorkerFn {
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  return (engine, effort) =>
    new Promise<ChatWorkerHandle>((resolve, reject) => {
      // shell:true 清零(令五.5):不再 spawn("npx",…,{shell:true})。改由 buildCliWorkerLaunch 解析出 node.exe
      // 绝对路径 + tsx cli.mjs 绝对路径 + worker 入口绝对路径,spawn shell:false + 参数数组直起进程。解析失败
      // (缺 tsx / worker 入口)→ 显式 reject,绝不静默回退 shell:true(调用方据此降级一次性引擎链)。
      let child: ChildProcess;
      try {
        const launch = buildCliWorkerLaunch(import.meta.url, ["chat-serve", "--engine", engine]);
        child = spawn(
          launch.file,
          launch.args,
          { env: buildCliWorkerEnv(buildWorkerEnv(effort), launch.file), stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32" },
        );
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const pending = new Map<string, { resolve: (r: ChatWorkerResponse) => void; reject: (e: Error) => void }>();
      let ready = false;
      let gone = false;
      let stderrTail = "";
      let resolveExited!: () => void;
      const exitedPromise = new Promise<void>((res) => { resolveExited = res; });

      const handle: ChatWorkerHandle = {
        send(req) {
          if (gone) return Promise.reject(new Error("chat worker 已退出"));
          return new Promise<ChatWorkerResponse>((res, rej) => {
            pending.set(req.id, { resolve: res, reject: rej });
            try {
              child.stdin?.write(JSON.stringify(req) + "\n");
            } catch (e) {
              pending.delete(req.id);
              rej(e instanceof Error ? e : new Error(String(e)));
            }
          });
        },
        kill() { killTree(child.pid); },
        exited: exitedPromise,
      };

      const readyTimer = setTimeout(() => {
        if (!ready) { killTree(child.pid); reject(new Error(`chat worker ready 超时(${readyTimeoutMs}ms)${stderrTail ? ": " + stderrTail : ""}`)); }
      }, readyTimeoutMs);
      (readyTimer as { unref?: () => void }).unref?.();

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const t = line.trim();
        if (!t) return;
        let obj: Record<string, unknown>;
        try { obj = JSON.parse(t) as Record<string, unknown>; } catch { return; }
        if (!ready && obj.type === "ready") {
          ready = true;
          clearTimeout(readyTimer);
          resolve(handle);
          return;
        }
        const id = obj.id;
        if (typeof id === "string" && pending.has(id)) {
          const p = pending.get(id)!;
          pending.delete(id);
          p.resolve(obj as unknown as ChatWorkerResponse);
        }
      });
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("data", (b: Buffer) => { stderrTail = (stderrTail + b.toString("utf-8")).slice(-2000); });
      child.stderr?.on("error", () => {});

      const onGone = (): void => {
        if (gone) return;
        gone = true;
        clearTimeout(readyTimer);
        for (const p of pending.values()) p.reject(new Error("chat worker 退出,请求未完成"));
        pending.clear();
        resolveExited();
        if (!ready) reject(new Error(`chat worker 未就绪即退出${stderrTail ? ": " + stderrTail : ""}`));
      };
      child.on("error", (e) => { if (!ready) { clearTimeout(readyTimer); reject(e); } onGone(); });
      child.on("close", onGone);
    });
}

// ── server 侧单例(systemModelInvoke 订阅分支消费)。测试用 __setSubscriptionChatPoolForTest 换成注入 spawn 的实例。 ──
let singleton: SubscriptionChatPool | undefined;

export function getSubscriptionChatPool(): SubscriptionChatPool {
  if (!singleton) singleton = new SubscriptionChatPool();
  return singleton;
}

export function __setSubscriptionChatPoolForTest(pool: SubscriptionChatPool | undefined): void {
  singleton = pool;
}
