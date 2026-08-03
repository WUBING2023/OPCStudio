// 订阅对话会话池 · worker 侧长驻服务模式。
// 背景:对话模式下每条消息都冷启动(spawn worker → npx adapter → ACP 握手 → prompt),10-30s。
// 架构约束(用户定稿):worker CLI 是全系统唯一 ACP client——server 不得自己直连 adapter。故这里给 worker 加一个
// 长驻模式:启动即经既有 AcpClient/engineRegistry 建**一条** ACP 会话(env 卫生同款),随后循环从 stdin 读 JSONL
// 请求 {id,system?,prompt,maxTokens},经既有会话发 session/prompt,向 stdout 写 JSONL 响应 {id,content,tokens,...};
// 空闲由 server 端(subscriptionChatPool)管;收到 stdin EOF 即优雅退出并按 PID 树杀干净 adapter。
//
// 记账纪律(任务书 3):chat-serve **不设 emit** → AcpClient.prompt 的 model_call_finished 落到 no-op(不进任何总线),
// tokens 随 JSONL 响应上交由 server 侧唯一发射 model_call_finished(避免与引擎路径双记)。
import * as readline from "node:readline";
import type { ReasoningEffort } from "@opc/shared";
import { AcpClient } from "./acpClient.js";
import { buildEngineSpec, type AcpEngineId, type AcpEngineSpec } from "./engineRegistry.js";

/** server → worker:一条对话请求。id 用于响应关联;system 折进本轮 prompt 文本;maxTokens 目前仅记录(ACP text-only)。 */
export interface ChatServeRequest {
  id: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
}

/** worker → server:一条对话响应。error 非空即本轮失败(会话已失效);tokens/promptTokens/completionTokens 供 server 记账。 */
export interface ChatServeResponse {
  id: string;
  content: string;
  tokens: number;
  promptTokens: number;
  completionTokens: number;
  estimated: boolean;
  stopReason?: string;
  error?: string;
}

/** worker 就绪帧:握手 + 建会话成功后先发这一帧,server 据此判 worker 可用(未就绪即退出 → server 降级)。 */
export interface ChatServeReadyFrame {
  type: "ready";
  sessionId: string;
  engine: string;
}

export interface RunChatServeOptions {
  engine: AcpEngineId;
  input?: NodeJS.ReadableStream;   // 缺省 process.stdin
  output?: NodeJS.WritableStream;  // 缺省 process.stdout
  /** 仅供单测注入:替换 spawn 规格,指向假 ACP agent fixture(绝不真调引擎)。 */
  spec?: AcpEngineSpec;
  /** 仅供单测注入:直接换掉 AcpClient(默认按 spec 构造)。 */
  makeClient?: (spec: AcpEngineSpec) => AcpClient;
  handshakeTimeoutMs?: number;
  turnTimeoutMs?: number;
  cwd?: string;
  /** 订阅推理档位(low|medium|high|xhigh),透传给 buildEngineSpec(codex 生效,其余引擎忽略)。缺省时 codex
   *  对话会话回落 low(经 buildEngineSpec 的对话默认,亦读 env.OPC_CODEX_CHAT_EFFORT)。 */
  reasoningEffort?: ReasoningEffort;
}

// system + prompt 折成本轮发给引擎的文本(与一次性路径 acpWorkerBackend 的 foldedGoal 同款:systemPrompt\n\ngoal)。
function foldPrompt(req: ChatServeRequest): string {
  const sys = (req.system ?? "").trim();
  const body = (req.prompt ?? "").trim();
  return sys ? `${sys}\n\n${body}` : body;
}

function errorResponse(id: string, message: string): ChatServeResponse {
  return { id, content: "", tokens: 0, promptTokens: 0, completionTokens: 0, estimated: false, error: message };
}

/**
 * 长驻对话服务主循环。建会话 → 写 ready 帧 → 串行处理 stdin 每行 JSONL 请求 → EOF 清理退出。
 * connect() 失败会抛(worker 入口据此以非零码退出,server 池等待 ready 超时后降级)。
 * 单轮 prompt 失败(传输级)标 fatal:回错误响应后关闭 readline → 走清理退出,server 池冷启动重试。
 * resolve 时机:stdin EOF(或 fatal 关流)且在途请求跑完、会话已清理。
 */
export async function runChatServe(opts: RunChatServeOptions): Promise<void> {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  // 对话常驻会话:codex 降 reasoning effort 至 low(缺省);员工显式选了档位则以其为准(reasoningEffort 透传)。
  const spec = opts.spec ?? buildEngineSpec(opts.engine, { chat: true, reasoningEffort: opts.reasoningEffort });
  const client = opts.makeClient
    ? opts.makeClient(spec)
    : new AcpClient({
        spec,
        cwd: opts.cwd ?? process.cwd(),
        handshakeTimeoutMs: opts.handshakeTimeoutMs,
        turnTimeoutMs: opts.turnTimeoutMs,
        // 刻意不设 emit:model_call_finished 不落任何总线,tokens 随响应上交由 server 侧唯一记账。
      });

  const writeLine = (obj: unknown): void => {
    try { output.write(JSON.stringify(obj) + "\n"); } catch { /* 管道已断,忽略 */ }
  };

  // 建会话(握手 + session/new)。失败向上抛 → 入口以非零码退出。
  const info = await client.connect();
  const ready: ChatServeReadyFrame = { type: "ready", sessionId: info.sessionId, engine: opts.engine };
  writeLine(ready);

  await new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    let chain: Promise<void> = Promise.resolve();
    let fatal = false;
    let closing = false;

    const handleLine = async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: ChatServeRequest;
      try {
        req = JSON.parse(trimmed) as ChatServeRequest;
      } catch {
        writeLine(errorResponse("", "chat-serve: 请求不是合法 JSON"));
        return;
      }
      if (fatal) {
        writeLine(errorResponse(req.id, "chat-serve: 会话已失效"));
        return;
      }
      try {
        const outcome = await client.prompt(foldPrompt(req));
        const resp: ChatServeResponse = {
          id: req.id,
          content: outcome.message,
          tokens: outcome.tokens.total,
          promptTokens: outcome.tokens.prompt,
          completionTokens: outcome.tokens.completion,
          estimated: outcome.estimated,
          stopReason: String(outcome.stopReason),
        };
        writeLine(resp);
      } catch (e) {
        // prompt 失败 = 传输级错误(会话可能已断)。标 fatal 回错误响应,并主动关流走清理退出(池冷启动重试)。
        fatal = true;
        writeLine(errorResponse(req.id, e instanceof Error ? e.message : String(e)));
        if (!closing) { closing = true; rl.close(); }
      }
    };

    rl.on("line", (line) => { chain = chain.then(() => handleLine(line)); });
    rl.on("close", () => {
      // stdin EOF(或 fatal 主动关流):等在途请求跑完 → 清理会话(按 PID 树杀 adapter)→ resolve。
      chain.then(
        () => { client.cleanup(); resolve(); },
        () => { client.cleanup(); resolve(); },
      );
    });
  });
}
