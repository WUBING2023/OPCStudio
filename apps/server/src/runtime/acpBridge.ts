// B4 · ACP Bridge:CLI-backed 外部 agent(claude-code/codex/genericCli……)与 OPC runtime 之间的
// 统一桥接层(指南 5.5 的 10 项职责里,1/5/6/7/10 由这里落地——2/3/4"注入 memory pack 摘要/artifact
// contract/A2A 行为规则"复用现成逻辑,不在这里重写:调用方(orchestrator/workerRuntime)已经把这些
// 组装进 task.systemPrompt/task.goal,本桥接层只按 spec.prepare() 拼 spawn 参数,原样把
// task.systemPrompt+task.goal 交给外部 agent,不重新组装 prompt)。
//
// 设计:每个引擎提供一份 AcpEngineSpec(command 组装 / 流解析 / token 提取 / 错误识别),桥接层本身
// 完全不知道具体某个 CLI 的参数语法或输出格式——只跑通用的骨架:
//   prepare → (restricted 早退) → spawnCliWithRetry(+日志 sink +实时 chunk 事件)→ parseOutput
//   → tool_call/tool_result/model_call_finished 事件 → 组装 ExecResult。
//
// 铁律(指南 5.5 末段):"ACP 输出也必须被转换成 OPC Runtime Contract。外部 agent 的文本声明不能
// 直接成为 OPC 的成功状态。"——本桥接层只信 res.code(进程退出码)与 parsed.isError(引擎自身协议里的
// 结构化错误标志,如 claude stream-json 的 is_error 字段),content 原样透传、不做语义判断;
// 验收仍由 Track A 的上层 gate 判(reviewCommit / 统一 gate),不在这里短路。
import type { AgentNodeConfig, ExecTask, ExecContext, ExecResult } from "@opc/shared";
import { spawnCliWithRetry, type RetryOpts } from "./engines/cliEngineBase.js";
import { diffFileChanges } from "./fileChanges.js";
import { createEngineLogSink } from "./engineLogCapture.js";
import { buildWorkerLaunchReceipt, emitWorkerLaunchReceipt } from "./workerLaunchReceipt.js";

// 外部 agent 流里的两类可观测事件,形状与既有 ClaudeCodeEngine 的 StreamEvent 保持逐字节一致——
// 桥接层只是把"谁来解析流"从各引擎里搬出来,事件形状本身不变(下游 ctx.emit 的 payload 不变)。
export type AcpStreamEvent =
  | { kind: "tool_call"; name: string; input: Record<string, unknown> }
  | { kind: "tool_result"; name: string; result: string };

export interface AcpParsedOutput {
  content: string;
  tokens: { prompt: number; completion: number; total: number };
  // 引擎自身上报的原始成本(如 claude stream-json 的 total_cost_usd)。是否计入最终 ExecResult.cost
  // 由 AcpPrepared.billCost 决定——订阅制 CLI 默认不计(flat-rate,虚增会误触预算门)。
  cost: number;
  isError: boolean;
  errorText?: string;
  // B4 二期(GenericCliEngine 迁移新增的可选能力):true = 本次调用的成功判定完全不看 res.code,只信
  // isError——对应 GenericCliConfig.trustExitCode:false 的"退出码不可信"语义(goose #4612 即使 LLM
  // 报错也回 0;opencode/amp 可能在 JSON 写完前提前退出、退出码未文档化)。缺省/false = 维持一期铁律
  // (res.code!==0 也判失败),不影响 claude-code/codex 的既有行为。
  ignoreExitCode?: boolean;
}

export interface AcpPrepared {
  args: string[];
  env: NodeJS.ProcessEnv;
  // 经 stdin 喂给 CLI 的完整 prompt(通常是 task.systemPrompt+task.goal,由各 spec 自行拼)。
  // B4 二期新增:可选——GenericCliEngine 的 9 份预设从不经 stdin 喂 prompt(prompt 全部走 argv,见
  // buildArgs),缺省/undefined 时桥接层完全不碰子进程 stdin(不 write 也不 end),与迁移前一致。
  input?: string;
  timeoutMs: number;
  // true 时最终 ExecResult.cost = parsed.cost(该次调用是真·按量计费);缺省/false → 恒 0。
  billCost?: boolean;
  // 非空 = 该次调用直接判 restricted(如 CLI 未安装/未登录),不 spawn 子进程;值即 error 消息。
  restricted?: string;
}

// 一份 AcpEngineSpec = 一个外部 coding agent CLI"怎么调"的声明式描述,类似 genericCliPresets.ts 的
// GenericCliConfig,但额外覆盖 claude-code/codex 这类结构化流协议需要的 tool_call/tool_result 事件与
// 认证/计费这类更深的引擎专属逻辑(prepare() 把这些全部收口成一份纯数据)。
export interface AcpEngineSpec {
  command: string;  // 可执行文件名(不含路径,走 PATH/resolveCliExe 解析),如 "claude"
  logLabel: string;  // engineLogCapture 的日志归属标签 + 超时错误消息前缀
  retry?: RetryOpts; // 缺省时使用 spawnCliWithRetry 自己的默认重试策略
  // 组装本次调用的 spawn 参数(纯函数,同步——与现状一致,claude-code 的 preflight 探测本身是同步的)。
  prepare(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): AcpPrepared;
  // 解析 spawn 完成后的 stdout → 标准化结果 + 逐条 tool_call/tool_result 事件(通过 onEvent 回调,
  // 由桥接层转发成 ctx.emit,事件形状与迁移前逐字节一致)。
  // 第三参数 extra(B4 二期新增,可选):{ stderr, exitCode } 原样带上 spawn 结果——GenericCliConfig.
  // parseOutput 的既有签名需要这两项(如 gemini-cli 用 exitCode 兜底判 ok、多个预设把 stdout/stderr
  // 一起当兜底 content)才能等价改写;claude-code/codex 的 parseOutput 不声明第三个形参,按 JS 惯例
  // 忽略多传的实参,行为不受影响。
  parseOutput(stdout: string, onEvent?: (ev: AcpStreamEvent) => void, extra?: { stderr: string; exitCode: number | null }): AcpParsedOutput;
}

export async function runAcpEngine(
  spec: AcpEngineSpec,
  node: AgentNodeConfig,
  task: ExecTask,
  ctx: ExecContext,
): Promise<ExecResult> {
  const t0 = Date.now();
  const tokens = { prompt: 0, completion: 0, total: 0 };

  const prepared = spec.prepare(node, task, ctx);

  // Pre-flight 早退:不 spawn 一个已知不可用的 CLI——如实报告 restricted,不假装成功。
  if (prepared.restricted) {
    ctx.emit("error", node.id, { message: prepared.restricted, restricted: true });
    return { content: "", fileChanges: [], tokens, cost: 0, latencyMs: Date.now() - t0, status: "restricted", error: prepared.restricted };
  }

  // B1 遗留件:子进程 stdout/stderr 旁路 tee 进 .opc/runs/<runId>/logs/backend.{stdout,stderr}.log
  // (best-effort,sink 内部绝不抛;无 runId 时整体 no-op)。
  const logSink = createEngineLogSink(ctx.projectRoot, ctx.runId, spec.logLabel, node.id);
  const res = await spawnCliWithRetry(spec.command, prepared.args, {
    cwd: ctx.workdir,
    env: prepared.env,
    timeoutMs: prepared.timeoutMs,
    input: prepared.input,
    signal: ctx.abortSignal,
    // Phase 3:实时把原始 stdout/stderr 分片发到事件流(经 eventBus 持久化+广播),供工作台监视台 tail。
    onChunk: (chunk, stream) => {
      if (stream === "stderr") logSink.onStderr(chunk); else logSink.onStdout(chunk);
      ctx.emit("agent_output_chunk", node.id, { chunk });
    },
  }, spec.retry ?? {});
  logSink.close(); // spawn 已结束(close/error/timeout 均已 resolve),刷掉最后的半行缓冲

  const launchReceipt = await buildWorkerLaunchReceipt(node, task, ctx, res.launch);
  emitWorkerLaunchReceipt(ctx, node, launchReceipt);

  if (res.aborted) {
    const msg = `${spec.logLabel} execution cancelled`;
    ctx.emit("error", node.id, { message: msg, restricted: false, cancelled: true });
    return { content: "", fileChanges: [], tokens, cost: 0, latencyMs: Date.now() - t0, status: "failed", error: msg, launchReceipt };
  }

  if (res.timedOut) {
    const msg = `${spec.logLabel} 执行超时`;
    ctx.emit("error", node.id, { message: msg, restricted: false });
    return { content: "", fileChanges: diffFileChanges(ctx.workdir), tokens, cost: 0, latencyMs: Date.now() - t0, status: "failed", error: msg, launchReceipt };
  }

  const parsed = spec.parseOutput(res.stdout, (ev) => {
    if (ev.kind === "tool_call") ctx.emit("tool_call", node.id, { name: ev.name, args: ev.input });
    else if (ev.kind === "tool_result") ctx.emit("tool_result", node.id, { name: ev.name, result: ev.result });
  }, { stderr: res.stderr, exitCode: res.code });
  tokens.prompt = parsed.tokens.prompt;
  tokens.completion = parsed.tokens.completion;
  tokens.total = parsed.tokens.total;
  ctx.emit("model_call_finished", node.id, { tokens: tokens.total, cost: parsed.cost, provider: node.provider, model: node.model, promptTokens: tokens.prompt, completionTokens: tokens.completion });

  const fileChanges = diffFileChanges(ctx.workdir);
  const cost = prepared.billCost ? parsed.cost : 0;

  // 铁律:res.code/parsed.isError(引擎自身协议的结构化信号)是唯一的成功判定依据——parsed.content
  // 里外部 agent 自称"完成了"/"成功了"这类文本声明,从不参与这个 if 判断。
  // parsed.ignoreExitCode(B4 二期):GenericCliConfig.trustExitCode:false 的工具(goose/opencode/amp)
  // 退出码已知不可信,exitFailed 恒 false——成功判定完全退化成只信 isError,与迁移前 GenericCliEngine
  // 的 `ok = exitOk && parsed.ok`(trustExitCode:false 时 exitOk 恒 true)等价。
  const exitFailed = !parsed.ignoreExitCode && res.code !== 0;
  if (exitFailed || parsed.isError) {
    const base = parsed.errorText || res.stderr.slice(0, 500) || `${spec.command} exited ${res.code}`;
    // Mark overload explicitly so the orchestrator's degradation chain can recognize a transient
    // coordinator failure (vs a hard error) even after retries were exhausted — never silent.
    const msg = res.overloaded ? `[overloaded] ${base}` : base;
    ctx.emit("error", node.id, { message: msg, restricted: false });
    return { content: parsed.content, fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "failed", error: msg, launchReceipt };
  }

  // 铁律延伸(反假成功):退出码 0 且引擎无结构化错误,但实际零输出(parsed.content 空/纯空白)——
  // 不得再包装成 "(no output)" 的 status:"done"。如实判 failed,error 写明引擎零输出,下游报告/成果卡
  // 按失败态呈现(与 exitFailed/isError 分支一样 emit 一条 error,证据链一致、不双记)。
  if (!parsed.content || !parsed.content.trim()) {
    const msg = `${spec.logLabel} 引擎零输出:退出码 0 且无结构化错误,但 stdout 无实质内容`;
    ctx.emit("error", node.id, { message: msg, restricted: false });
    return { content: "", fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "failed", error: msg, launchReceipt };
  }

  return { content: parsed.content, fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "done", launchReceipt };
}
