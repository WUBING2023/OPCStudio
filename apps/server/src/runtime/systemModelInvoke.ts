import { randomUUID } from "node:crypto";
import type { AgentNodeConfig, AgentFramework, ReasoningEffort, ExecTask, ExecContext, ExecResult } from "@opc/shared";
import { callModel, type ChatMessage, type FunctionToolDef, type ToolCall } from "./modelGateway.js";
import { resolveSystemModel, resolveAutoSubscription, inferSystemFramework, type SystemModelKind, type SystemModelChoice } from "./systemModel.js";
import { getEngine } from "./engineRouter.js";
import { emit, getRunId } from "./eventBus.js";
import { mapFrameworkToAcpEngine } from "./engines/acpWorkerBackend.js";
import { chatPoolEnabled, getSubscriptionChatPool } from "./subscriptionChatPool.js";

// 系统级模型调用的统一入口。背景:系统默认模型选了订阅(codex/claude-code/gemini-cli)后,各系统消费点
// (CEO 提案 / 澄清对话 / 意图分类 / mission 简报 / loop·goal 复盘 / 技能孵化 / 架构草稿)若仍直走
// callModel(API 面)去拿 openai/anthropic 的 key,就会撞上 "Provider unavailable: openai — no handler
// registered"。这里按 systemModel.framework 分流:
//   · api(API 面)        —— 照旧 callModel(三级模型解析 + 供应商 handler)。
//   · 订阅/CLI 引擎(其余)—— 构造最小单节点任务,经既有引擎执行链(getEngine → ExecutionEngine.run,
//     内建 ACP 优先 + legacy CLI-spawn fallback)跑一次性文本任务,取回文本 + tokens。
// tokens 入账:订阅路径由引擎自身经 ctx.emit("model_call_finished") 汇入 usageStore(index.ts 订阅者),
// 本模块不重复记账;API 路径沿用 callModel 既有口径。

export interface SystemInvokeInput {
  agentId: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  agentRole?: string;
  tools?: FunctionToolDef[];
  // 订阅推理档位(low|medium|high|xhigh)——透传给订阅对话会话池(codex 生效,其余引擎忽略)。
  // invokeAgentModel 从员工 agent.reasoningEffort 注入;未设置=保留引擎默认(对话链 low)。
  reasoningEffort?: ReasoningEffort;
}

// 返回口径与 callModel 的 CallRecord 消费子集对齐(各消费点只读 content / totalTokens / estimatedCostUsd)。
export interface SystemInvokeResult {
  content: string;
  toolCalls?: ToolCall[];
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | undefined;
  provider: string;
  model: string;
  framework: AgentFramework;
}

// 订阅引擎一次性文本任务的硬时限(默认 3 分钟,足够 CEO 提案 / mission 简报这类 1-3k token 的系统调用)。
const SUBSCRIPTION_TIMEOUT_MS = Number(process.env.OPC_SYSTEM_INVOKE_TIMEOUT_MS) || 180_000;

// framework 是否为"订阅/CLI 引擎面"(需经引擎执行链跑,而非 API 面 callModel)。
// api = API 面("hermes" 是其历史 id,读侧 alias 同 API 面);缺省/空(未标 framework 的旧配置或
// 测试桩)也保守走 API 面,保持 callModel 旧行为不变;
// 其余具名 framework(claude-code/codex/gemini-cli 等 CLI 引擎)才经引擎执行链。
export function isSubscriptionFramework(framework?: string): boolean {
  return !!framework && framework !== "api" && framework !== "hermes";
}

export async function invokeSystemModel(
  projectRoot: string,
  kind: SystemModelKind,
  input: SystemInvokeInput,
): Promise<SystemInvokeResult> {
  // 无 key 自动订阅替换(在"角色→choice"这一层):某角色解析成 API 面 provider 却没有可用 key 时,
  //   · 本机已装对应订阅 → 改走订阅执行,并 emit 一条 info 事件(kind:system_model_auto_subscription)如实可见;
  //   · 既无 key 也无订阅 → 抛人话错误(而不是让 callModel 撞 "no handler registered")。
  // invokeSystemModelWithChoice(显式指定 choice 的活体验证/单测入口)刻意不做此替换,保持"给什么跑什么"。
  const choice = resolveSystemModel(projectRoot, kind);
  const outcome = await resolveAutoSubscription(choice);
  if (outcome.kind === "unavailable") {
    throw new Error(autoSubscriptionUnavailableMessage(kind, outcome.provider, outcome.subscription));
  }
  if (outcome.kind === "substituted") {
    emit("info", input.agentId, { kind: "system_model_auto_subscription", role: kind, from: outcome.from, to: outcome.to });
  }
  return invokeSystemModelWithChoice(projectRoot, outcome.choice, input);
}

function autoSubscriptionUnavailableMessage(role: string, provider: string, subscription: string): string {
  return `系统模型「${role}」指向的供应商 ${provider} 没有可用的 API key,本机也未检测到可替代的 ${subscription} 订阅。请为 ${provider} 配置 API key,或安装并登录 ${subscription} 订阅 CLI 后重试。`;
}

// 员工人格面的统一调用入口。用户实测第三击:CEO 对话/任务澄清/架构对话/一次性问答直接拿员工的
// provider 走 callModel,订阅员工(framework=claude-code + provider=anthropic 等)没 key 就撞
// "Provider unavailable: anthropic"。与系统模型同款分流:订阅 framework → 引擎执行链;API 面 →
// callModel;API 面无 key 但本机有对应订阅 → 自动替换并 emit 事件(agent_model_auto_subscription)。
export async function invokeAgentModel(
  projectRoot: string,
  agent: { id: string; framework?: AgentFramework; provider: string; model: string; reasoningEffort?: ReasoningEffort },
  input: SystemInvokeInput,
): Promise<SystemInvokeResult> {
  const framework = (agent.framework ?? inferSystemFramework(agent.provider, agent.model)) as AgentFramework;
  const outcome = await resolveAutoSubscription({ framework, provider: agent.provider, model: agent.model });
  if (outcome.kind === "unavailable") {
    throw new Error(
      `员工「${agent.id}」的供应商 ${outcome.provider} 没有可用的 API key,本机也未检测到可替代的 ${outcome.subscription} 订阅。` +
      `请配置 API key、安装并登录订阅 CLI,或在员工设置里改选其他执行方式。`,
    );
  }
  if (outcome.kind === "substituted") {
    emit("info", agent.id, { kind: "agent_model_auto_subscription", agentId: agent.id, from: outcome.from, to: outcome.to });
  }
  // 员工显式选定的推理档位透传给订阅路径(codex 生效);input 已带则尊重 input,否则用员工设置。
  return invokeSystemModelWithChoice(projectRoot, outcome.choice, { ...input, reasoningEffort: input.reasoningEffort ?? agent.reasoningEffort });
}

// 与 invokeSystemModel 同一逻辑,但接受已解析好的 SystemModelChoice(供活体验证 / 单测直接指定执行方式)。
export async function invokeSystemModelWithChoice(
  projectRoot: string,
  sys: SystemModelChoice,
  input: SystemInvokeInput,
): Promise<SystemInvokeResult> {
  if (!isSubscriptionFramework(sys.framework)) {
    const record = await callModel({
      agentId: input.agentId,
      provider: sys.provider,
      model: sys.model,
      system: input.system,
      messages: input.messages,
      maxTokens: input.maxTokens,
      tools: input.tools,
      agentRole: input.agentRole,
    });
    return {
      content: record.content,
      toolCalls: record.toolCalls,
      promptTokens: record.promptTokens,
      completionTokens: record.completionTokens,
      totalTokens: record.totalTokens,
      estimatedCostUsd: record.estimatedCostUsd,
      provider: sys.provider,
      model: sys.model,
      framework: sys.framework as AgentFramework,
    };
  }

  const framework = sys.framework as AgentFramework;

  // 订阅对话会话池:claude-code/codex 的对话/一次性文本任务默认走常驻 worker 池(暖响应 <5s),规避每条消息
  // 冷启动。池路径成功 → 由本处**唯一**发一条 model_call_finished 入账(worker chat-serve 侧不发,避免双记);
  // 池路径失败(spawn/握手/超时/worker 错)自动回退下方既有一次性引擎链(不叠加超时,各自计时)。带 tools 的
  // 调用不入池(ACP text-only 无函数调用;与既有订阅路径同样丢弃 tools,行为不变)。逃生门 OPC_ACP_CHAT_POOL=0。
  const chatEngine = mapFrameworkToAcpEngine(framework);
  if (chatEngine && chatPoolEnabled() && !(input.tools && input.tools.length > 0)) {
    try {
      const resp = await getSubscriptionChatPool().invoke(chatEngine, {
        id: randomUUID(),
        system: input.system,
        prompt: messagesToGoal(input.messages),
        maxTokens: input.maxTokens,
      }, input.reasoningEffort); // 推理档位透传(codex 生效);档位变更时池会按新档冷启动一个常驻 worker
      emit("model_call_finished", input.agentId, {
        tokens: resp.tokens,
        cost: 0, // 订阅 flat-rate
        provider: sys.provider,
        model: sys.model,
        promptTokens: resp.promptTokens,
        completionTokens: resp.completionTokens,
        estimated: resp.estimated,
        executor: "acp",
      });
      return {
        content: resp.content,
        promptTokens: resp.promptTokens,
        completionTokens: resp.completionTokens,
        totalTokens: resp.tokens,
        estimatedCostUsd: 0,
        provider: sys.provider,
        model: sys.model,
        framework,
      };
    } catch (e: any) {
      // 池不可用(未装/未登录/首启失败/超时)→ 落一条 info 后回退一次性引擎链,记账在回退路径里发生恰一次。
      emit("info", input.agentId, { kind: "chat_pool_fallback", framework, message: e?.message || String(e) });
    }
  }

  const engine = getEngine(framework);
  const node: AgentNodeConfig = {
    id: input.agentId,
    name: input.agentId,
    role: input.agentRole ?? "advisor",
    childrenIds: [],
    model: sys.model,
    provider: sys.provider,
    framework,
    reasoningEffort: input.reasoningEffort, // 一次性引擎链(池不可用回退)也带上推理档位:acpWorkerBackend 把整个 node 写进隔离 agents.json,worker 侧 resolveAgent 读回 → buildEngineSpec 注入(codex 生效)
    status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: false,
    deletable: false,
    enabled: true,
  };
  const task: ExecTask = {
    taskId: randomUUID(),
    goal: messagesToGoal(input.messages),
    systemPrompt: input.system ?? "",
    maxTokens: input.maxTokens,
  };
  const ctx: ExecContext = {
    runId: getRunId() || `system-${node.id}-${task.taskId}`,
    projectRoot,
    workdir: projectRoot,
    // 复用全局 eventBus.emit:引擎发出的 model_call_finished 由 index.ts 的订阅者汇入 usageStore,
    // 与普通 run 的记账链路完全一致(见 index.ts 顶部订阅 + acpBridge/HermesEngine 的 emit)。
    // 薄适配:eventBus.emit 的首参是收敛的 TraceEvent["type"] 联合,ExecContext.emit 声明为 string。
    emit: (type, agentId, payload) => emit(type as Parameters<typeof emit>[0], agentId, payload),
    budget: { maxTokensPerTask: input.maxTokens },
    taskTimeoutMs: SUBSCRIPTION_TIMEOUT_MS,
  };

  let result: ExecResult;
  try {
    result = await engine.run(node, task, ctx);
  } catch (e: any) {
    throw new Error(subscriptionFailureMessage(framework, e?.message || String(e)));
  }
  if (result.status !== "done") {
    throw new Error(subscriptionFailureMessage(framework, result.error || `引擎返回状态 ${result.status}`));
  }
  return {
    content: result.content,
    toolCalls: result.toolCalls,
    promptTokens: result.tokens.prompt,
    completionTokens: result.tokens.completion,
    totalTokens: result.tokens.total,
    estimatedCostUsd: result.cost ?? undefined,
    provider: sys.provider,
    model: sys.model,
    framework,
  };
}

function subscriptionFailureMessage(framework: string, detail: string): string {
  return `订阅引擎 ${framework} 执行失败:${detail}。可改用 API 模式(把系统模型执行方式设为 API),或检查该 CLI 是否已登录订阅账号。`;
}

// 把消息序列压平成 CLI 引擎需要的单段 goal 文本:单条 user 直接取内容;多轮(带历史)按角色标注拼成
// 文本抄本(system 已单独经 task.systemPrompt 传入,这里剔除)。
function messagesToGoal(messages: ChatMessage[]): string {
  const turns = messages.filter((m) => m.role !== "system");
  if (turns.length === 0) return "";
  if (turns.length === 1) return turns[0].content ?? "";
  return turns.map((m) => `${m.role === "assistant" ? "助手" : "用户"}:${m.content ?? ""}`).join("\n\n");
}
