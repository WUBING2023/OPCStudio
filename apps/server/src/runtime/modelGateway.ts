import { estimateCostFromPricing } from "../storage/pricingStore.js";
import { estimateTokensFromText } from "./tokenEstimate.js";
import { recordSuccess, recordFailure } from "./providerHealth.js";
import { ProviderUnavailableError } from "@opc/shared";
import { resolveModelId, ModelNotFoundError, isModelNotFoundResponse } from "./modelResolve.js";
import { safeFetch, type SafeFetchOptions } from "../security/localGuards.js";

export interface FunctionToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, any>; required?: string[] };
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ModelInput {
  agentId: string;
  provider: string;
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  tools?: FunctionToolDef[];
  agentRole?: string;
  // per-call key 覆写(accountPool 租约账号 / ExecContext.apiKeyOverride):非空时 provider handler
  // 用它替代注册时绑定的 key 进 HTTP header——多账号切换按次生效。只活在这一次调用里,绝不落日志/事件。
  apiKey?: string;
  // Optional per-call deadline supplied by the enclosing tool loop. The provider
  // clamps this to its own HTTP ceiling so an abandoned request cannot outlive
  // the worker deadline and keep an account lease busy in the background.
  requestTimeoutMs?: number;
  abortSignal?: AbortSignal;
}

export interface ModelOutput {
  content: string;
  toolCalls?: ToolCall[];
  finishReason?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | undefined;
  latencyMs: number;
  timedOutPartial?: boolean; // ⏱️ 子进程超时被杀,content 是截断前抢救回的 stdout(部分产出,非完整交付)
  // B3:true = 本次 usage 由 length/4 估算(API 未回报),供 model_call_finished → ledger 判 costSource=estimated_len4
  usageEstimated?: boolean;
  // MUP Gate A#2 · 结构化模拟标记(不只 [MOCK] 文本前缀):mock provider 的响应恒带 true,且 callModel
  // 对 provider==="mock" 强制补戳(handler 被测试覆写也逃不掉)。真实供应商永不设此字段。
  // 消费链:CallRecord → ApiEngine ExecResult.simulated → model_call_finished payload → ledger/usage 分列。
  simulated?: true;
}

export interface CallRecord extends ModelOutput {
  agentId: string;
  provider: string;
  model: string;
  startedAt: string;
  endedAt: string;
}

type CallHandler = (input: ModelInput) => Promise<ModelOutput>;

const registry = new Map<string, CallHandler>();
let projectRoot = process.cwd();

export function setModelGatewayRoot(root: string) {
  projectRoot = root;
}

export function registerProvider(name: string, handler: CallHandler) {
  registry.set(name, handler);
}

// Hard HTTP-level ceiling for model calls. Complex code tool calls can legitimately
// take more than 90s, but the caller-provided remaining deadline always wins.
const HTTP_TIMEOUT_MS = Number(process.env.OPC_HTTP_TIMEOUT_MS) || 180_000;

// Transient/infra errors (rate-limit, timeout, 5xx, conn reset) are load/network blips,
// NOT the provider being down — they must NOT count toward the provider-health circuit
// breaker, otherwise a single overloaded account gets falsely marked unhealthy and its
// workers get deferred no_account. Mirrors ApiEngine's isRestricted classification.
export function isTransientError(msg: string): boolean {
  return msg.includes("429") || msg.includes("402") || msg.includes("quota")
    || msg.includes("rate") || msg.includes("limit") || msg.includes("billing")
    || msg.includes("insufficient") || msg.includes("ECONNREFUSED") || msg.includes("ECONNRESET")
    || msg.includes("ETIMEDOUT") || msg.includes("timeout") || msg.includes("aborted")
    // 并发稳定性硬化(纠错):裸网络错(undici "fetch failed" 真错在 e.cause,DNS/连接重置/socket)也是
    // load/network blip,绝不能记 provider 健康熔断(否则一次网络抖动→provider unhealthy→全队 no_account 坍塌)。
    || /fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg)
    || /5\d\d/.test(msg);
}

// 从 error 提取 message + e.cause.code(undici 把真网络错藏在 cause.code,如 ECONNRESET/ENOTFOUND)。
function errText(e: any): string { return `${e?.message ?? String(e)} ${e?.cause?.code ?? ""}`; }

// 并发稳定性硬化 · fetch 退避重试:仅对【快失败网络错】(fetch failed/DNS/连接重置)与【即时 429/5xx】做
// 指数退避+抖动重试,让一次网络抖动在 provider 层自愈,不冒泡耗尽上层 attempt 预算。**不重试 ETIMEDOUT**
// (那是 90s 慢失败,重试会叠乘超时)。次数/基数 env 门控;默认 2 次/1000ms(纠错性默认开)。
const HTTP_MAX_RETRIES = Math.max(0, Number(process.env.OPC_MODEL_HTTP_MAX_RETRIES) || 2);
const HTTP_BACKOFF_MS = Math.max(100, Number(process.env.OPC_MODEL_HTTP_BACKOFF_MS) || 1000);
// 超时分类(用户复核)· 结构化瞬时网络错码:undici 把真错藏在 e.cause.code(非 undici 客户端在 e.code)。
// 含 socket 级 ETIMEDOUT——它是【瞬时连接超时】,应有限重试;必须与【本地 90s HTTP 死线】(慢失败,归一化为
// "model HTTP request exceeded" 文本、无 cause.code)和【AbortError】(显式取消/run 死线,立即终止)分开,绝不混为一类。
const TRANSIENT_NET_CODES = /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR)/i;
function netCode(e: any): string { return String(e?.cause?.code ?? e?.code ?? ""); }
function isFastNetworkThrow(e: any): boolean {
  if (e?.name === "AbortError") return false;                          // 显式取消/run 死线 → 立即终止,绝不当瞬时错重试
  if (TRANSIENT_NET_CODES.test(netCode(e))) return true;               // 结构化:真 socket 瞬时错(含 socket ETIMEDOUT)→ 有限重试
  // 退回文本判据(裸网络错无 cause.code 时);排除本地 90s HTTP 死线(慢失败,重试会叠乘超时,不重试)。
  return /fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR|ECONNRESET|ECONNREFUSED/i.test(errText(e))
    && !/model HTTP request exceeded/i.test(errText(e));
}
export async function fetchWithBackoff(doFetch: () => Promise<Response>): Promise<Response> {
  let lastErr: any;
  for (let attempt = 0; ; attempt++) {
    try {
      const resp = await doFetch();
      if (resp.ok || attempt >= HTTP_MAX_RETRIES) return resp;
      if (resp.status !== 429 && resp.status < 500) return resp; // 非瞬时状态(4xx≠429)原样返回,不退避
    } catch (e: any) {
      lastErr = e;
      if (!isFastNetworkThrow(e) || attempt >= HTTP_MAX_RETRIES) throw e; // 慢失败(ETIMEDOUT)/非网络错/次数用尽 → 冒泡
    }
    await new Promise((r) => setTimeout(r, HTTP_BACKOFF_MS * (2 ** attempt) + Math.random() * HTTP_BACKOFF_MS));
  }
}

// fetch with a hard timeout. AbortSignal.timeout rejects with a TimeoutError/AbortError
// whose message ApiEngine's isRestricted regex would miss → it would be classed "failed"
// and retried on the SAME lease (piling load onto an overloaded account). Normalize the
// timeout to an ETIMEDOUT Error so it's classed "restricted" → lease released immediately.
async function fetchWithTimeout(url: string, init: RequestInit, options: SafeFetchOptions, requestTimeoutMs?: number, abortSignal?: AbortSignal): Promise<Response> {
  const timeoutMs = Math.max(1_000, Math.min(HTTP_TIMEOUT_MS, requestTimeoutMs ?? HTTP_TIMEOUT_MS));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = abortSignal ? AbortSignal.any([timeoutSignal, abortSignal]) : timeoutSignal;
  try {
    return await safeFetch(url, { ...init, signal }, options);
  } catch (e: any) {
    if (abortSignal?.aborted) throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("execution cancelled");
    // 超时分类(用户复核)· 本地 HTTP 90s 死线(AbortSignal.timeout 抛 TimeoutError):有界【慢失败】→ 归一化,
    // ApiEngine 归 restricted 立即释放租约、不重试(重试会叠乘 90s)。【AbortError】=显式取消/run 死线,语义不同:
    // 不归一化为超时、不当瞬时错重试(isFastNetworkThrow 已排除 AbortError → 立即终止),保持原样冒泡,绝不混为一类。
    if (e?.name === "TimeoutError") {
      throw new Error(`ETIMEDOUT: model HTTP request exceeded ${timeoutMs}ms`);
    }
    throw e;
  }
}

export async function callModel(input: ModelInput): Promise<CallRecord> {
  // 三级模型解析(执行面 = API):把裸别名(如 sonnet → claude-sonnet-5)映射为 canonical;
  // 跨族误配/未知别名在**打 API 之前**拒绝(ModelNotFoundError,不可重试),绝不带裸别名去打 API →
  // 根治用户实测 "API call failed after 3 retries: HTTP 404: model: sonnet"。mock 例外(E2E 零外呼)。
  if (input.provider !== "mock") {
    const r = resolveModelId(input.provider, input.model);
    if (r.status === "rejected") throw new ModelNotFoundError(input.provider, input.model, r.reason);
    if (r.status === "aliased") {
      console.log(`[modelResolve] alias "${r.from}" → "${r.model}" (provider ${input.provider}, agent ${input.agentId})`);
      input = { ...input, model: r.model };
    }
  }

  const handler = registry.get(input.provider);
  if (!handler) {
    // No silent mock fallback — a missing handler (no API key / unknown provider) is an
    // explicit failure so the node goes restricted instead of faking success.
    throw new ProviderUnavailableError(input.provider, "no handler registered — missing API key or unknown provider");
  }

  console.log(`[modelGateway] using registered provider "${input.provider}" for agent ${input.agentId}`);
  const startedAt = new Date().toISOString();
  try {
    const result = await handler(input);
    recordSuccess(input.provider, result.latencyMs);
    // provider==="mock" 无条件补戳 simulated:标记是 provider 身份的结构化事实,不依赖 handler 自觉。
    if (input.provider === "mock") result.simulated = true;
    return { ...input, ...result, startedAt, endedAt: new Date().toISOString() };
  } catch (e: any) {
    const msg = errText(e); // 含 e.cause.code:让网络错(fetch failed 的真错在 cause)也被 isTransientError 认出
    // ModelNotFoundError = 模型配置错误(供应商在线,只是型号选错):不可重试、不记熔断。
    if (!(e instanceof ModelNotFoundError) && !isTransientError(msg)) recordFailure(input.provider, msg);
    throw e;
  }
}

// Lookup for the provider registry / availability checks (used by providerRegistry).
export function getHandler(provider: string): CallHandler | undefined {
  return registry.get(provider);
}

// 公共定价函数(apiToolLoop 的成本核算用同一张定价表,见 engines/apiToolLoop.ts):对已知单价模型给出
// 真实非零成本、对未知模型诚实返回 undefined(不是悄悄 0)。provider 暂不参与查价(DEFAULT_PRICES 按
// model 名已全局唯一,见 pricingStore.ts),留作接口位以便未来同名跨 provider 型号需要区分单价时无需再
// 改调用方签名。
export function estimateCostForTokens(_provider: string, model: string, promptTokens: number, completionTokens: number): number | undefined {
  return estimateCostFromPricing(projectRoot, model, promptTokens, completionTokens);
}

// Built-in: OpenAI-compatible provider (works for DeepSeek, MiniMax, Doubao, OpenRouter)
export function createOpenAICompatProvider(baseUrl: string, apiKey: string, options: Pick<SafeFetchOptions, "allowLocalNetwork" | "allowSyntheticProxyAddress"> = {}): CallHandler {
  return async (input: ModelInput): Promise<ModelOutput> => {
    const t0 = Date.now();
    const effectiveKey = input.apiKey || apiKey;
    const body: any = {
      model: input.model,
      messages: [
        ...(input.system ? [{ role: "system", content: input.system }] : []),
        ...input.messages,
      ],
      max_tokens: input.maxTokens,
    };
    if (input.tools && input.tools.length > 0) {
      body.tools = input.tools;
      body.tool_choice = "auto";
    }
    // 并发稳定性硬化:整个 fetch(含【网络抛错】路径,不再只 429/5xx 响应)走统一指数退避+抖动重试
    // (fetchWithBackoff)——此前网络错在 fetch 抛出阶段就冒泡、根本进不到旧的单次 2500ms 重试,一次抖动
    // 即耗尽上层 attempt 预算导致整队坍塌。现在网络 blip 在 provider 层自愈。
    const endpoint = baseUrl.replace(/\/+$/, "") + "/chat/completions";
    const resp = await fetchWithBackoff(async () => fetchWithTimeout(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${effectiveKey}` },
      body: JSON.stringify(body),
    }, options, input.requestTimeoutMs, input.abortSignal));
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      // 404 / model-not-found = 不可重试的配置错误(型号选错),归 ModelNotFoundError:上层 attempt 循环
      // 不重试、provider 健康熔断不记账(供应商在线)。其余非 2xx 仍走普通 Error(可能瞬时,允许重试/记账)。
      if (isModelNotFoundResponse(resp.status, err)) {
        throw new ModelNotFoundError(input.provider, input.model, `供应商 ${input.provider} 不认识模型 "${input.model}"(HTTP ${resp.status})。请在节点配置里改选目录内的模型。`);
      }
      throw new Error(`API ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json() as any;
    const usage = data.usage ?? {};
    const choice = data.choices?.[0];
    const msg = choice?.message;
    let promptTokens = usage.prompt_tokens ?? 0;
    let completionTokens = usage.completion_tokens ?? 0;
    let usageEstimated = false; // B3:诚实标注——true 表示下面走了 length/4 估算,非 API 回报 usage
    if (promptTokens === 0 && completionTokens === 0) {
      // P1-7: provider returned no usage — estimate from text so the call isn't counted as 0 tokens.
      // Include tool_calls: assistant turns carry their payload in tool_calls (e.g. writeFile's full
      // file content), not content — omitting it underestimates multi-tool-round prompts badly.
      usageEstimated = true;
      promptTokens = estimateTokensFromText((input.system ?? "") + input.messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")) + (m.tool_calls ? JSON.stringify(m.tool_calls) : "")).join(""));
      completionTokens = estimateTokensFromText((msg?.content ?? "") + (msg?.tool_calls ? JSON.stringify(msg.tool_calls) : ""));
    }
    return {
      content: msg?.content ?? "",
      toolCalls: msg?.tool_calls ?? undefined,
      finishReason: choice?.finish_reason ?? "stop",
      promptTokens, completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimateCostFromPricing(projectRoot, input.model, promptTokens, completionTokens),
      latencyMs: Date.now() - t0,
      usageEstimated,
    };
  };
}

// Built-in: Anthropic provider
export function createAnthropicProvider(apiKey: string): CallHandler {
  return async (input: ModelInput): Promise<ModelOutput> => {
    const t0 = Date.now();
    const body: any = {
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages: input.messages.filter(m => m.role !== "system"),
    };
    const resp = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": input.apiKey || apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }, {
      allowLocalNetwork: false,
      // This endpoint is an immutable built-in HTTPS vendor URL. Some local
      // TUN proxies intentionally resolve it into RFC 2544 (198.18/15); allow
      // only that synthetic proxy range while every real private/metadata
      // range remains blocked by safeFetch.
      allowSyntheticProxyAddress: true,
    }, input.requestTimeoutMs, input.abortSignal);
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      if (isModelNotFoundResponse(resp.status, err)) {
        throw new ModelNotFoundError(input.provider, input.model, `Anthropic 不认识模型 "${input.model}"(HTTP ${resp.status})。CLI 别名(sonnet/opus/haiku)只属于 Claude Code 订阅,API 直连请用 claude-sonnet-5 等完整 id。`);
      }
      throw new Error(`Anthropic ${resp.status}: ${err.slice(0, 200)}`);
    }
    const data = await resp.json() as any;
    const u = data.usage ?? {};
    // P1-8: include cache tokens — claude processes/bills the full prompt (input + cache_read + cache_creation).
    let promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    let completionTokens = u.output_tokens ?? 0;
    const text = data.content?.[0]?.text ?? "";
    let usageEstimated = false; // B3:诚实标注——true 表示下面走了 length/4 估算,非 API 回报 usage
    if (promptTokens === 0 && completionTokens === 0) {
      // P1-7: no usage → estimate from text (include tool_calls payload, see OpenAI path above).
      usageEstimated = true;
      promptTokens = estimateTokensFromText((input.system ?? "") + input.messages.map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")) + (m.tool_calls ? JSON.stringify(m.tool_calls) : "")).join(""));
      completionTokens = estimateTokensFromText(text);
    }
    return {
      content: text,
      promptTokens, completionTokens,
      totalTokens: promptTokens + completionTokens,
      estimatedCostUsd: estimateCostFromPricing(projectRoot, input.model, promptTokens, completionTokens),
      latencyMs: Date.now() - t0,
      usageEstimated,
    };
  };
}

// Mock provider for development
const mockProvider: CallHandler = async (input) => {
  const lastMsg = input.messages[input.messages.length - 1]?.content ?? "";
  const toolsAvailable = input.tools ?? [];

  if (toolsAvailable.length > 0 && /create.*file|write.*file|writeFile|hello/i.test(lastMsg)) {
    const writeTool = toolsAvailable.find(t => t.function.name === "writeFile");
    if (writeTool) {
      const fileArgs = { path: "hello.txt", content: "hello world" };
      return {
        content: "",
        toolCalls: [{
          id: "mock_call_001",
          type: "function" as const,
          function: {
            name: "writeFile",
            arguments: JSON.stringify(fileArgs),
          },
        }],
        finishReason: "tool_calls",
        promptTokens: 80, completionTokens: 40, totalTokens: 120,
        estimatedCostUsd: 0, latencyMs: 5,
        simulated: true,
      };
    }
  }

  return {
    content: `[MOCK ${input.provider}/${input.model}] Task received. Agent ${input.agentId} would process: "${lastMsg.slice(0, 80)}..."`,
    promptTokens: 50, completionTokens: 30, totalTokens: 80,
    estimatedCostUsd: 0, latencyMs: 5,
    simulated: true,
  };
};
registerProvider("mock", mockProvider);
