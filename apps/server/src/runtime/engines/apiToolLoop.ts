import { callModel, estimateCostForTokens, type ChatMessage, type FunctionToolDef, type ToolCall } from "../modelGateway.js";
import { runTool, type ToolDef } from "../tools.js";
import { dirSizeExceeds } from "../diskQuota.js";
import { stripThinkBlocks } from "../outputSanitizer.js";
import { estimateTokensFromText } from "../tokenEstimate.js";

// API 模式的纯 tool-loop 驱动器(ApiEngine 内核):callModel(带 tools)→ 解析 tool_calls → runTool
// 执行 → 结果回灌 → 循环,直到模型不再要工具或达轮数上限。原生 function calling 不可用的模型
// (deepseek-reasoner 等)回退文本工具协议:prompt 里描述工具、从回复文本解析调用。

// 每条工具结果回灌给模型前的长度上限(readFile 可能返回整文件;runShell 等自身已有 2000 字上限)。
const TOOL_RESULT_MAX_CHARS = 12_000;

export function defaultMaxToolRounds(): number {
  return Number(process.env.OPC_API_MAX_TOOL_ROUNDS) || 16;
}

// 引擎级 deadline:任务硬时限减 20s 宽限(让"截止+抢救部分产出"发生在数据所在的这一层,先于
// parallelExecutor 的外层 Promise.race);无任务时限时用 OPC_API_TIMEOUT_MS(缺省 4min,对齐旧
// Hermes 引擎缺省)。in-process HTTP 轮次是秒级的,不需要旧 Hermes 60s 子进程下限;1s 下限只防御
// 退化输入(taskTimeoutMs ≤ 宽限本身)。
export function resolveLoopTimeoutMs(taskTimeoutMs?: number): number {
  if (taskTimeoutMs) return Math.max(1_000, taskTimeoutMs - 20_000);
  return Number(process.env.OPC_API_TIMEOUT_MS) || 240_000;
}

// createAnthropicProvider 不发 body.tools 也不解析 tool_use(anthropic-key 直连走文本协议);
// deepseek-reasoner / r1 系推理特化模型官方不支持 function calling。
export function supportsNativeFunctionCalling(provider: string, model: string): boolean {
  if ((provider || "").toLowerCase() === "anthropic") return false;
  const m = (model || "").toLowerCase();
  if (/reasoner/.test(m)) return false;
  if (/(^|[^a-z0-9])r1(?![a-z0-9])/.test(m)) return false;
  return true;
}

// 内建工具的 paramSchema 大多缺省,但描述遵循 "Args: path, content" / "No args." 约定——按约定
// 推断参数名;带 "(default …)" 的视为可选。MCP 工具自带 paramSchema,原样使用。
function inferParamsFromDescription(description: string): FunctionToolDef["function"]["parameters"] {
  const m = /Args:\s*([^.]+)/.exec(description || "");
  if (!m) return { type: "object", properties: {}, required: [] };
  const properties: Record<string, { type: string; description?: string }> = {};
  const required: string[] = [];
  for (const part of m[1].split(",")) {
    const nm = /([A-Za-z_][A-Za-z0-9_]*)/.exec(part.trim());
    if (!nm) continue;
    properties[nm[1]] = { type: "string" };
    if (!/\(default/i.test(part)) required.push(nm[1]);
  }
  return { type: "object", properties, required };
}

export function toFunctionTools(tools: ToolDef[]): FunctionToolDef[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.paramSchema
        ? { type: "object" as const, properties: t.paramSchema.properties, required: t.paramSchema.required }
        : inferParamsFromDescription(t.description),
    },
  }));
}

export function textToolProtocolPrompt(tools: ToolDef[]): string {
  return [
    "## 可用工具(文本协议)",
    "当前模型不支持原生 function calling。需要调用工具时,在回复中输出如下格式的代码块(每块一个调用,可多块):",
    "```tool_call",
    '{"name": "<工具名>", "arguments": {"<参数名>": "<值>"}}',
    "```",
    "工具执行结果会以 <tool_result> 消息回传,然后你继续。不需要工具时直接给出最终答复,不要输出 tool_call 代码块。",
    "工具列表:",
    ...tools.map((t) => `- ${t.name}: ${t.description}`),
  ].join("\n");
}

const FENCE_RE = /```tool_call\s*\n([\s\S]*?)```/g;
const TAG_RE = /<tool_call>([\s\S]*?)<\/tool_call>/g;

export function parseTextToolCalls(content: string): ToolCall[] {
  const bodies: string[] = [];
  for (const re of [FENCE_RE, TAG_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content || ""))) bodies.push(m[1]);
  }
  const out: ToolCall[] = [];
  for (const body of bodies) {
    try {
      const parsed = JSON.parse(body.trim());
      if (!parsed || typeof parsed.name !== "string" || !parsed.name) continue;
      const args = parsed.arguments ?? parsed.args ?? {};
      out.push({
        id: `text_call_${out.length + 1}`,
        type: "function",
        function: { name: parsed.name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
      });
    } catch { continue; }
  }
  return out;
}

export interface ApiToolLoopInput {
  agentId: string;
  provider: string;
  model: string;
  agentRole?: string;
  system: string;
  goal: string;
  maxTokens: number;
  tools: ToolDef[];
  workdir?: string;
  // 配置根与 workdir 分离：worker worktree 通常没有 .opc/config.json，权限必须读真实项目配置。
  projectRoot?: string;
  // per-call key 覆写(accountPool 租约 / apiKeyOverride),经 ModelInput.apiKey 直达 provider handler
  // 的 HTTP header——绝不进事件流。
  apiKey?: string;
  timeoutMs: number;
  maxRounds?: number;
  // A7 · token 预算(等价旧 hermes 三闸之一):累计 prompt+completion 达到即走"轮数上限"同款收尾
  // (注入收尾指令 + 一次禁工具调用),不再烧满 timeout。0/undefined = 不启用(缺省行为不变)。
  maxBudgetTokens?: number;
  /** Shared run cancellation; checked before model calls and every tool execution. */
  abortSignal?: AbortSignal;
  // A7 · workspace 磁盘配额:每轮工具执行完检查 workdir 总字节,超限 emit workspace_quota_exceeded
  // 并 throw(ApiEngine catch 判 failed;restricted 正则刻意不吃)。0/undefined = 不启用。
  workspaceQuotaBytes?: number;
  emit: (type: string, agentId: string | undefined, payload: unknown) => void;
  onUsage?: (promptTokens: number, completionTokens: number, costUsd: number) => void;
  onChunk?: (chunk: string, stream: "stdout" | "stderr") => void;
}

export interface ApiToolLoopResult {
  content: string;
  toolCalls: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  rounds: number;
  timedOutPartial?: boolean;
}

const DEADLINE = Symbol("deadline");

// deadline 赢后被放弃的在飞调用若 reject,提前挂 catch 防 unhandled rejection;race 未定胜负时
// 调用本身的 reject 仍照常向上抛(错误分类交给 ApiEngine 的 restricted 正则)。
async function raceDeadline<T>(p: Promise<T>, remainingMs: number): Promise<T | typeof DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<typeof DEADLINE>((res) => { timer = setTimeout(() => res(DEADLINE), remainingMs); });
  try {
    p.catch(() => {});
    return await Promise.race([p, gate]);
  } finally { clearTimeout(timer); }
}

export async function runApiToolLoop(input: ApiToolLoopInput): Promise<ApiToolLoopResult> {
  const deadlineAt = Date.now() + input.timeoutMs;
  const native = supportsNativeFunctionCalling(input.provider, input.model);
  const functionTools = native ? toFunctionTools(input.tools) : undefined;
  const system = native
    ? input.system
    : [input.system, textToolProtocolPrompt(input.tools)].filter(Boolean).join("\n\n");
  const messages: ChatMessage[] = [{ role: "user", content: input.goal }];
  const executed: ToolCall[] = [];
  const textParts: string[] = [];
  const totals = { prompt: 0, completion: 0, cost: 0 };
  const maxRounds = input.maxRounds ?? defaultMaxToolRounds();
  let rounds = 0;

  const throwIfAborted = () => {
    if (!input.abortSignal?.aborted) return;
    throw input.abortSignal.reason instanceof Error ? input.abortSignal.reason : new Error("execution cancelled");
  };

  const result = (content: string, timedOutPartial?: boolean): ApiToolLoopResult => ({
    content,
    toolCalls: executed,
    promptTokens: totals.prompt,
    completionTokens: totals.completion,
    totalTokens: totals.prompt + totals.completion,
    costUsd: totals.cost,
    rounds,
    ...(timedOutPartial ? { timedOutPartial: true } : {}),
  });

  // ⏱️ 超时抢救(语义对齐旧 executeViaHermes):截止时已累计的模型文本 ≥200 字 → 作为 partial 返回;
  // 太薄 → 维持 timeout 失败语义(消息含 "timed out":restricted 正则刻意不吃它,deferred 归因 timeout)。
  const salvageOrThrow = (): ApiToolLoopResult => {
    const salvaged = textParts.join("\n\n").trim();
    if (salvaged.length >= 200) return result(salvaged, true);
    throw new Error(`API tool loop timed out after ${input.timeoutMs}ms`);
  };

  const callOnce = async (withTools: boolean) => {
    throwIfAborted();
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return DEADLINE;
    const spentTokens = totals.prompt + totals.completion;
    const promptTokensEstimate = estimateTokensFromText(system + messages.map((m) => m.role + ":" + m.content + (m.tool_calls ? JSON.stringify(m.tool_calls) : "")).join("\n"));
    const budgetRemaining = input.maxBudgetTokens ? input.maxBudgetTokens - spentTokens : Number.POSITIVE_INFINITY;
    if (budgetRemaining <= promptTokensEstimate) {
      input.emit("info", input.agentId, { kind: "budget_limit", message: "token budget exhausted before next model call" });
      throw new Error("token budget exhausted before next model call; estimated prompt=" + promptTokensEstimate + ", remaining=" + Math.max(0, budgetRemaining));
    }
    const responseMaxTokens = Number.isFinite(budgetRemaining)
      ? Math.max(1, Math.min(input.maxTokens, budgetRemaining - promptTokensEstimate))
      : input.maxTokens;
    const out = await raceDeadline(
      callModel({
        agentId: input.agentId,
        provider: input.provider,
        model: input.model,
        system,
        messages,
        maxTokens: responseMaxTokens,
        agentRole: input.agentRole,
        abortSignal: input.abortSignal,
        ...(withTools && functionTools?.length ? { tools: functionTools } : {}),
        ...(input.apiKey ? { apiKey: input.apiKey } : {}),
        requestTimeoutMs: remaining,
      }),
      remaining,
    );
    if (out === DEADLINE) return DEADLINE;
    rounds++;
    totals.prompt += out.promptTokens;
    totals.completion += out.completionTokens;
    const cost = out.estimatedCostUsd ?? estimateCostForTokens(input.provider, input.model, out.promptTokens, out.completionTokens) ?? 0;
    totals.cost += cost;
    input.onUsage?.(out.promptTokens, out.completionTokens, cost);
    input.emit("model_call_finished", input.agentId, {
      tokens: out.totalTokens, cost, provider: input.provider, model: input.model,
      promptTokens: out.promptTokens, completionTokens: out.completionTokens,
      // B3:透传估算标注,index.ts 订阅据此判 ledger costSource(estimated_len4 vs api_reported)
      usageEstimated: out.usageEstimated,
    });
    // MUP B7 · <think> 剥离(每轮收口):干净正文进 textParts(抢救/最终 content)/消息历史/live 面;
    // 思考块单独以 thinking:true chunk emit(ephemeral,不落盘),绝不混入交付文本。无标记时零改动。
    const { clean, thinking } = stripThinkBlocks(out.content ?? "");
    if (thinking) input.emit("agent_output_chunk", input.agentId, { chunk: thinking, thinking: true });
    if (clean !== (out.content ?? "")) out.content = clean;
    if (clean.trim()) {
      textParts.push(clean);
      input.onChunk?.(clean.endsWith("\n") ? clean : clean + "\n", "stdout");
      input.emit("agent_output_chunk", input.agentId, { chunk: clean });
    }
    return out;
  };

  // 共用收尾路径(轮数上限 / token 预算 / 空转守卫):注入收尾指令 + 一次禁工具调用拿最终答复,
  // 而不是把中间态包装成完成。
  const finishWithoutTools = async (notice: string): Promise<ApiToolLoopResult> => {
    messages.push({ role: "user", content: notice });
    const out = await callOnce(false);
    if (out === DEADLINE) return salvageOrThrow();
    return result(out.content ?? "");
  };

  // A7 空转守卫状态:连续相同 (name+arguments) 的工具调用计数;达 3 次注入警告,警告后再犯强制收尾。
  let stallSig = "";
  let stallCount = 0;
  let stallWarned = false;
  const noProgressResults = new Map<string, number>();

  for (let round = 0; round < maxRounds; round++) {
    throwIfAborted();
    const out = await callOnce(true);
    if (out === DEADLINE) return salvageOrThrow();
    const content = out.content ?? "";
    const nativeCalls = native ? (out.toolCalls ?? []) : [];
    // 原生模式下 toolCalls 为空时也扫一遍文本协议——个别 OpenAI-compat 模型会把调用写进正文。
    const calls: ToolCall[] = nativeCalls.length ? nativeCalls : parseTextToolCalls(content);
    if (!calls.length) return result(content);

    // A7 token 预算约束下一次模型推理,不能丢弃当前响应里已经生成的工具调用。
    // 工具调用本身仍受权限、路径和 workspace 配额约束;执行完后再禁工具收尾。
    const budgetReached = !!input.maxBudgetTokens
      && totals.prompt + totals.completion >= input.maxBudgetTokens;
    if (budgetReached) {
      input.emit("info", input.agentId, { kind: "budget_limit", message: `token 预算 ${input.maxBudgetTokens} 已用尽(已计 ${totals.prompt + totals.completion}),提前收尾拿最终答复` });
    }

    const asNativeTurn = nativeCalls.length > 0;
    messages.push(asNativeTurn ? { role: "assistant", content, tool_calls: nativeCalls } : { role: "assistant", content });
    for (const tc of calls) {
      const name = tc.function.name;
      let args: Record<string, any> = {};
      let argsValid = true;
      if (tc.function.arguments) {
        try { args = JSON.parse(tc.function.arguments); } catch { argsValid = false; }
      }
      throwIfAborted();
      input.emit("tool_call", input.agentId, { name, args });
      // A response that stops at max_tokens can truncate function.arguments. Calling
      // the tool with {} turns a transport truncation into a misleading tool failure
      // (and can be dangerous for tools with optional parameters). Feed a precise
      // repair instruction back to the model instead, so it can retry with a smaller
      // payload or split the work across calls.
      const raw = argsValid
        ? await runTool(name, args, input.workdir, input.projectRoot) // runTool never throws; errors are strings
        : `Error: ${name} arguments were truncated or invalid JSON. Retry this tool call with valid JSON and a smaller payload; split large files into concise writes when necessary.`;
      throwIfAborted();
      const bounded = raw.length > TOOL_RESULT_MAX_CHARS ? raw.slice(0, TOOL_RESULT_MAX_CHARS) + "\n…(工具结果过长已截断)" : raw;
      executed.push({ id: tc.id, type: "function", function: { name, arguments: tc.function.arguments } });
      input.emit("tool_result", input.agentId, { name, result: bounded.slice(0, 500) });
      input.onChunk?.(`[tool ${name}] ${bounded.slice(0, 200)}\n`, "stdout");
      messages.push(asNativeTurn
        ? { role: "tool", content: bounded, tool_call_id: tc.id }
        : { role: "user", content: `<tool_result name="${name}">\n${bounded}\n</tool_result>` });
      // A7 空转守卫计数:签名 = 工具名 + 原始 arguments 字符串等值比较(零成本)。
      const mutatesFiles = (name === "writeFile" || name === "deleteFile") && !/^Error:/i.test(raw);
      if (mutatesFiles) noProgressResults.clear();
      else {
        const outcomeSig = name + String.fromCharCode(0) + (tc.function.arguments ?? "") + String.fromCharCode(0) + bounded;
        const outcomeCount = (noProgressResults.get(outcomeSig) ?? 0) + 1;
        noProgressResults.set(outcomeSig, outcomeCount);
        if (outcomeCount >= 3) {
          input.emit("info", input.agentId, { kind: "tool_loop_no_progress", message: name + " returned the same result " + outcomeCount + " times without a file change" });
          throw new Error("tool loop made no progress: " + name + " repeated the same result " + outcomeCount + " times");
        }
      }
      const sig = `${name}\0${tc.function.arguments ?? ""}`;
      if (sig === stallSig) stallCount++; else { stallSig = sig; stallCount = 1; }
    }

    // A7 磁盘配额:本轮工具可能写盘,超限立即终止(throw → ApiEngine catch 判 failed;错误文案刻意
    // 含 "quota exceeded" 供 defer 归因,且不含 restricted 正则/timed out 关键词,归因不被误吃)。
    if (input.workspaceQuotaBytes && input.workdir && dirSizeExceeds(input.workdir, input.workspaceQuotaBytes)) {
      input.emit("workspace_quota_exceeded", input.agentId, {
        message: `工作区超过磁盘配额 ${input.workspaceQuotaBytes} 字节,已终止该任务`,
        workdir: input.workdir, quotaBytes: input.workspaceQuotaBytes,
      });
      throw new Error(`workspace quota exceeded: 工作区超过磁盘配额 ${input.workspaceQuotaBytes} 字节`);
    }

    if (budgetReached) {
      throw new Error("token budget exhausted after model/tool round");
    }

    // A7 空转守卫落点:连续 3 次相同调用 → 注入一次警告;警告后再犯 → 强制收尾,不再烧轮数/时间。
    if (stallCount >= 3) {
      const stallName = stallSig.split("\0")[0];
      if (!stallWarned) {
        stallWarned = true;
        input.emit("info", input.agentId, { kind: "tool_loop_stall", message: `连续 ${stallCount} 次以相同参数调用 ${stallName},已注入警告` });
        messages.push({ role: "user", content: "警告:你已连续多次以完全相同的参数调用同一个工具,重复调用无进展。请改变策略,或基于已有结果直接给出最终答复。" });
      } else {
        input.emit("info", input.agentId, { kind: "tool_loop_stall", message: `警告后仍重复调用 ${stallName},强制收尾` });
        throw new Error(`tool loop made no progress: ${stallName} repeated after warning`);
      }
    }
  }

  // 达轮数上限:追加一次禁工具的收尾调用拿最终答复,而不是把中间态包装成完成。
  return finishWithoutTools("已达到工具调用轮数上限。请基于以上工具结果直接给出最终答复,不要再调用任何工具。");
}
