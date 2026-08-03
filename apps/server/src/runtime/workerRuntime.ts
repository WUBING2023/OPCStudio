// B2 · runEngineCore 解耦:执行漏斗的纯函数模块。
// 铁律:模块内零可变全局——所有运行时状态(run id / team mode / callRecords / a2a inbox / agents
// 状态机)一律经 WorkerRuntimeDeps 注入,由调用方(orchestrator)持有。这使 CEO/Lead/worker 共用的
// 执行漏斗可以脱离 orchestrator 的 2400 行模块状态被直接单测(引擎路由/冷却 fallback/apiKeyOverride/
// A2A inbox 注入等分支),也是 B3(opc-worker CLI)复用同一 Runner 的前提。

import type { AgentFramework, AgentMessage, AgentNodeConfig, ExecContext, ExecResult, ExecTask, NativeExecutionPreference } from "@opc/shared";
import type { CallRecord } from "./modelGateway.js";
import type { InjectionContext } from "./contextBuilder.js";
import type { RouteDecision } from "./engineRouter.js";
import type { CooldownEntry } from "./rateLimitCooldown.js";
import { summarizeMemoryPackUsage, citeMemories, formatCitationLine, type InjectedMemoryRef } from "./memoryPack.js";
import { stripThinkBlocks } from "./outputSanitizer.js";
import { buildEffectiveCapabilityManifest } from "./effectiveCapabilities.js";
import { buildWorkerLaunchReceipt, captureWorkerLaunchMetadata, emitWorkerLaunchReceipt } from "./workerLaunchReceipt.js";

// A2A: 执行前 drain 某 agent 的 inbox,渲染成可注入的上下文(限 5 条 / 2000 字,控 token)。
// 跳过与当前 goal 重复的消息(如 lead 派活——它已是 worker 的主任务,避免重复注入)。
// B2 解耦:改为纯函数——drain 动作由调用方经 Deps 完成,这里只做消息→注入文本的确定性渲染。
export function renderInboxForPrompt(msgs: AgentMessage[], currentGoal: string): string {
  if (!msgs.length) return "";
  const MAX_MSGS = 5, MAX_CHARS = 2000;
  let body = "", count = 0;
  for (const m of msgs.slice(-MAX_MSGS)) {
    if (currentGoal.includes(m.text)) continue; // 自己的派活已在 goal 里,跳过
    const perf = m.performative ?? "inform";
    const arts = m.artifactRefs?.length ? ` [附产出物 id: ${m.artifactRefs.join(", ")}]` : "";
    const line = `- [${perf}] 来自 ${m.from}${m.conversationId ? `(会话 ${m.conversationId})` : ""}: ${m.text}${arts}\n`;
    if (body.length + line.length > MAX_CHARS) break;
    body += line; count++;
  }
  return count ? `\n\n## 来自团队成员的消息(请酌情参考或回应)\n${body}` : "";
}

// Stage 2 · Run Type / Team Mode(产品契约)—— 从 orchestrator 迁入(执行漏斗的引擎选择逻辑)。
export type TeamMode = "economy" | "balanced" | "maxQuality";
const _MODE_SONNET = { framework: "claude-code" as const, provider: "anthropic", model: "sonnet" };
const _MODE_DEEPSEEK = { framework: "api" as const, provider: "deepseek", model: "deepseek-v4-pro" };
// 按 Team Mode + 角色返回有效引擎(run 级覆盖,不改 agent 持久配置)。balanced:协调+核查(lead/test)用强模型,执行用便宜。
export function effEngineForMode(role: string | undefined, mode: TeamMode | undefined): { framework: "claude-code" | "api"; provider: string; model: string } | null {
  if (!mode) return null;
  if (mode === "economy") return _MODE_DEEPSEEK;
  if (mode === "maxQuality") return _MODE_SONNET;
  return role === "lead" || role === "test" ? _MODE_SONNET : _MODE_DEEPSEEK; // balanced
}

// 执行漏斗对宿主(orchestrator / 未来的 opc-worker CLI)的全部依赖面——按 runEngineCore 真实读写的
// orchestrator 模块级状态逐项梳理而来。全部经此接口进入,模块内不 import 任何有状态单例。
export interface WorkerRuntimeDeps {
  /** run 元数据落盘根(injCtx/账号解析用;非 workdir——workdir 在 ctx 里) */
  projectRoot: string;
  /** 当前 run id(原 orchestrator 模块级 activeRunId;调用方在漏斗入口一次性快照) */
  runId: string;
  /** Stage 2 · Team Mode 有效引擎的 run 级覆盖(原模块级 activeTeamMode) */
  teamMode: TeamMode | undefined;
  /** 事件总线投影(原 eventBus.emit;类型面放宽为 string 与 parallelExecutor.Deps 同风格) */
  emit: (type: string, agentId: string | undefined, payload: unknown) => void;
  /** agent 状态机推进 + 持久化(原 orchestrator.setAgentStatus:改 agents 数组并 mergeSaveAgents) */
  setAgentStatus: (id: string, status: AgentNodeConfig["status"], currentTask?: string) => void;
  /** Phase 4 差异化大脑:技能/记忆注入(原 contextBuilder.buildSystemPrompt 直调) */
  buildSystemPrompt: (agent: AgentNodeConfig, baseRolePrompt: string, goal: string, projectRoot: string, out: InjectionContext) => string;
  /** D3 · 注入即登记回传:buildSystemPrompt 完成后把"真正拼进该 agent prompt 的记忆清单"
   *  (injCtx.injectedMemories,与 citeMemories 同一诚实来源)回调宿主;未注入任何记忆时不回调。
   *  orchestrator 用它维护 run 级 injectedByAgent(复用验证回路 + 派单消息 citedMemories)。可选、加性。 */
  onInjection?: (agentId: string, refs: InjectedMemoryRef[]) => void;
  /** A2A: drain 该 agent 的 inbox(原 a2aBus.drain——a2aBus 是 run 级重建的模块单例) */
  drainInbox: (agentId: string) => AgentMessage[];
  /** CLI(订阅)框架 CEO/Lead-only 策略门(engineRouter.frameworkPolicy) */
  frameworkPolicy: (node: Pick<AgentNodeConfig, "framework" | "role">) => { allowed: boolean; reason?: string };
  /** capability-aware dispatch(engineRouter.routeEngine)——测试可注入假引擎 */
  routeEngine: (framework?: AgentFramework, role?: string, nativePreference?: NativeExecutionPreference) => RouteDecision;
  /** Agent preference overrides company preference; missing resolves to the existing ACP/API path. */
  resolveNativeExecution: (agent: AgentNodeConfig) => NativeExecutionPreference;
  /** 限流冷却查询/记账(rateLimitCooldown:模块内自持内存态,经此注入而非直 import) */
  makeCooldownKey: (framework: string | undefined, provider: string, model: string | undefined) => string;
  getCooldownEntry: (key: string) => CooldownEntry | undefined;
  pickFallbackEngine: (primaryKey: string) => { framework: AgentFramework; provider: string; model: string } | null;
  recordRateLimit: (key: string, rawText: string) => CooldownEntry;
  /** API Key 模式账号解析(原 resolveApiKeyOverride(loadAccounts(projectRoot), …) 组合;可抛,漏斗内 best-effort 捕获) */
  resolveApiKey: (framework: AgentFramework | undefined, cliConfigDir: string | undefined) => string | undefined;
  /** AsyncLocalStorage 身份包裹(tools.runWithAgent:让 run 内工具知道调用方是谁) */
  runWithAgent: <T>(agentId: string, fn: () => T, role?: string) => T;
  /** 成本记账收集(原 callRecords.push——数组归调用方所有) */
  onCallRecord: (record: CallRecord) => void;
  /** run 级 token/cost 累计 + live progress 持久化(原 runTokens/runCost += 与 persistActiveRunProgress) */
  onUsage: (tokens: number, cost: number) => void;
}

// Core: run a node through its engine with the given task + ctx (ctx.workdir lets a parallel
// worker run in its own worktree), accumulate usage onto the node, set status, record a CallRecord.
// Engines never throw; only a caller's timeout wrapper can reject. Reused by the serial CEO/Lead
// path (runViaEngine) and the parallel worker executor (injected as execFn).
// B2 解耦:从 orchestrator 迁入,逻辑逐行保持;全部宿主状态经 deps 进入。
export async function runEngineCore(agent: AgentNodeConfig, task: ExecTask, ctx: ExecContext, deps: WorkerRuntimeDeps): Promise<ExecResult> {
  // Policy: CLI (subscription) frameworks are CEO/Lead-only. A worker on claude-code/codex is
  // restricted honestly (no engine call, no fake success).
  const policy = deps.frameworkPolicy(agent);
  if (!policy.allowed) {
    deps.setAgentStatus(agent.id, "restricted", policy.reason);
    deps.emit("error", agent.id, { message: policy.reason, restricted: true });
    return {
      content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 },
      cost: 0, latencyMs: 0, status: "restricted", error: policy.reason,
    };
  }

  deps.setAgentStatus(agent.id, "working", task.goal.slice(0, 80));
  const _effEng = effEngineForMode(agent.role, deps.teamMode);
  const _effFramework = _effEng?.framework ?? agent.framework;
  const _execAgent = _effEng ? { ...agent, framework: _effEng.framework, provider: _effEng.provider, model: _effEng.model } : agent;
  deps.emit("model_call_started", agent.id, {
    model: _execAgent.model,
    provider: _execAgent.provider,
    framework: _effFramework,
    ...(deps.teamMode ? {
      teamMode: deps.teamMode,
      configuredEngine: { framework: agent.framework, provider: agent.provider, model: agent.model },
      overridden: _execAgent.provider !== agent.provider || _execAgent.model !== agent.model || _effFramework !== agent.framework,
    } : {}),
  });

  // Phase 4: inject enabled skills + retrieved memories into the system prompt (differentiated
  // brain). Record what was injected into the trace so the learning loop is observable.
  const injCtx: InjectionContext = { projectRoot: deps.projectRoot, runId: deps.runId, injectedSkillIds: [], injectedMemoryIds: [] };
  const finalSystem = deps.buildSystemPrompt(agent, task.systemPrompt, task.goal, deps.projectRoot, injCtx);
  deps.emit("info", agent.id, { injectedSkills: injCtx.injectedSkillIds, injectedMemory: injCtx.injectedMemoryIds });
  // D3 · 注入即登记回传宿主:refs = 真正拼进 prompt 的记忆清单(citeMemories 同一诚实来源)。
  // 未注入不回调(零破坏);回调抛错不影响执行(additive)。
  if (injCtx.injectedMemories?.length) {
    try { deps.onInjection?.(agent.id, injCtx.injectedMemories); } catch { /* additive */ }
  }
  // C1 交接 · bundled 技能因公司归属未决被排除注入:contextBuilder 已在内存态登记
  // (excludedBundledSkillIds),此处补 emit 进 run 事件流(随 eventBus 落 events.jsonl 可审计),
  // 不静默丢弃。kind 不在前端 DOMAIN_KINDS 白名单 → 零 UI 行为变化(展示归 E 泳道)。
  if (injCtx.excludedBundledSkillIds?.length) {
    try { deps.emit("info", agent.id, { kind: "excluded_bundled_skills", skillIds: injCtx.excludedBundledSkillIds, message: `${injCtx.excludedBundledSkillIds.length} 个打包技能因公司归属未决未注入(residual)` }); } catch { /* additive */ }
  }
  // Stage 4:注入记忆升级为专门领域事件(与 info 并存,零破坏),供 /api/runs/:id/memories 精确派生"本次用了哪些记忆"。
  if (injCtx.injectedMemoryIds.length) {
    try { deps.emit("memory_injected", agent.id, { memoryIds: injCtx.injectedMemoryIds, role: agent.role }); } catch { /* additive */ }
  }
  // Memory Pack:contextBuilder 顺手聚合的统一投影(countsByScope 汇总,不塞完整 items——避免事件流过重)。
  // emit 一条 info 事件(kind: "memory_pack_used"),随 eventBus 落 events.jsonl;供 deriveRunMemoryPackUsage
  // 纯派生读取(/api/runs/:id/memory-pack),Run Story / BriefingPanel 既有事件展示机制可直接接。best-effort。
  if (injCtx.memoryPack) {
    try {
      // CEO 记忆引用溯源:引用来源 = **真正拼进 prompt 的记忆清单**(injectedMemories),不是 memoryPack
      // 审计视图——后者含"检索到但未注入"的条目(超预算截断/失败 run 隔离前的 committed/纯展示投影),
      // 拿它当引用来源会让"依据经验《X》"里的 X 从未进过模型输入 = 造假(违反第一条宪法)。
      // citedMemories 随本条 committed info 事件走既有 emit 链路(不旁路,P1-7 教训),web 项目群
      // 消息卡据此渲染可点击的引用条;消息正文再追加一行人话引用作纯文本兜底。
      const cited = citeMemories(injCtx.injectedMemories);
      const citeLine = formatCitationLine(cited);
      deps.emit("info", agent.id, {
        kind: "memory_pack_used",
        role: agent.role,
        message: `本轮 ${agent.role} 使用了 ${summarizeMemoryPackUsage(injCtx.memoryPack)}` + (citeLine ? `\n${citeLine}` : ""),
        countsByScope: injCtx.memoryPack.countsByScope,
        ...(cited.length ? { citedMemories: cited } : {}),
        // B5 · 证据链接线:pack 身份 hash 随事件落 events.jsonl/RunHistory,run 结束由
        // deriveRunDiagnostics 聚合进 diagnostics.json 的 memoryPackHashes(可选字段)。
        packHash: injCtx.memoryPack.packHash,
      });
    } catch { /* additive */ }
  }
  // A2A Phase 3: 注入该 agent inbox 里的同侪消息(drain,限量),让真投递的消息真正进入其执行输入。
  const inboxCtx = renderInboxForPrompt(deps.drainInbox(agent.id), task.goal);
  const injectedTask: ExecTask = { ...task, systemPrompt: finalSystem, goal: inboxCtx ? task.goal + inboxCtx : task.goal };

  const startedAt = new Date().toISOString();
  // Stage 2 · Team Mode 有效引擎(run 级覆盖;原 agent 对象不变 → 不持久化、token 记账仍按 agent)。



  // 引擎路由:capability-aware dispatch(加性,不改实际引擎选择)。
  // route.idealProvider != route.chosenProvider → gap 标志,为未来跨引擎路由铺路。
  const nativePreference = deps.resolveNativeExecution(agent);
  const route = deps.routeEngine(_effFramework, agent.role, nativePreference);
  // Fix B 审计(确认):capabilityMatch:false 之前只落 trace,没人读、没有用户可见警告、不触发任何动作。
  // 刻意选择"可见但不自动切换"——不擅自改用户的引擎选择(可能违背订阅账号限流等基建考量),只把信号做成
  // 简报栏能看见的人话提示。kind: "engine_mismatch" 供 BriefingPanel 的 DOMAIN_KINDS 白名单识别渲染。
  const engineMismatch = !route.capabilityMatch && route.idealProvider
    ? { kind: "engine_mismatch", message: `引擎路由:当前用 ${route.chosenProvider} 执行 ${agent.role} 角色,更适合的是 ${route.idealProvider}(能力更匹配),可在节点设置手动切换` }
    : undefined;
  deps.emit("info", agent.id, {
    engineRoute: {
      chosen: route.chosenProvider,
      ideal: route.idealProvider,
      riskLevel: route.riskLevel,
      capabilityMatch: route.capabilityMatch,
    },
    ...engineMismatch,
  });
  if (route.nativeExecution?.selected === "acp" && route.nativeExecution.requested !== "acp") {
    deps.emit("info", agent.id, {
      kind: "native_adapter_degraded",
      requested: route.nativeExecution.requested,
      fallback: "acp",
      failureKind: route.nativeExecution.failureKind,
      reason: route.nativeExecution.reason,
      message: `Native execution degraded to ACP: ${route.nativeExecution.reason ?? "native route unavailable"}`,
    });
  } else if (route.nativeExecution?.selected === "blocked") {
    deps.emit("info", agent.id, {
      kind: "native_adapter_blocked",
      requested: route.nativeExecution.requested,
      failureKind: route.nativeExecution.failureKind,
      reason: route.nativeExecution.reason,
      message: route.nativeExecution.reason,
    });
  }
  // 限流冷却路由(加性,零热路径开销):无冷却时 getCooldownEntry → undefined → 整段跳过,执行与原来逐字节一致。
  // primary 在冷却期内 → 临时改用备用引擎顶上(过点惰性恢复,自动切回);备用也不可用则照旧跑主模型诚实失败。
  let execAgent = _execAgent;
  let execRoute = route;
  let execFramework = _effFramework;
  const primaryKey = deps.makeCooldownKey(_effFramework, _execAgent.provider, _execAgent.model);
  const preCooldown = deps.getCooldownEntry(primaryKey);
  if (preCooldown) {
    const fb = deps.pickFallbackEngine(primaryKey);
    if (fb) {
      execAgent = { ..._execAgent, framework: fb.framework, provider: fb.provider, model: fb.model };
      execFramework = fb.framework;
      execRoute = deps.routeEngine(fb.framework, agent.role, nativePreference);
      deps.emit("rate_limited", agent.id, {
        originalModel: primaryKey,
        rateLimitedUntil: new Date(preCooldown.rateLimitedUntil).toISOString(),
        resetSource: preCooldown.resetSource,
        fallback: deps.makeCooldownKey(fb.framework, fb.provider, fb.model),
        reason: "pre-call cooldown routing",
        message: `${primaryKey} 限流冷却中,本次改用 ${fb.provider}/${fb.model} 顶上`,
      });
    }
  }

  // API Key 模式(非订阅登录)账号解析:按最终执行(冷却路由/Team Mode 覆盖后)的 framework + cliConfigDir
  // 现查 accounts.json 现算——只活在这一次调用的 ExecContext 里,不进 agent/事件流(见 apiKeyOverride 注释)。
  // CEO/Lead(runViaEngine,无 accountPool 租约)与 worker(parallelExecutor 注入的 execFn)共用这一个
  // 漏斗,两条路径都在此覆盖,无需分别处理。
  let execCtx = ctx;
  try {
    const apiKeyOverride = deps.resolveApiKey(execFramework, execAgent.cliConfigDir);
    if (apiKeyOverride) execCtx = { ...ctx, apiKeyOverride };
  } catch { /* best-effort:账号解析失败不阻塞执行,退回订阅/全局登录路径 */ }

  // AgentStatus 11 态 · thinking/reviewing:引擎(模型)调用真正在飞的窗口。上面的 "working" 覆盖
  // 领任务+上下文组装(记忆/技能/inbox 注入)阶段;从这里到 await 返回是真实的模型调用在飞。
  // 审查类调用(交叉验证 verifier / lead 评审轮)由调用方经 task.statusWhileRunning 传 "reviewing"。
  const capabilityManifest = buildEffectiveCapabilityManifest({
    agent: execAgent,
    framework: execFramework,
    nativeExecutor: execRoute.nativeExecution?.selected === "codex-native" || execRoute.nativeExecution?.selected === "claude-native"
      ? execRoute.nativeExecution.selected
      : undefined,
    task: injectedTask,
    ctx: execCtx,
  });
  execCtx = { ...execCtx, capabilityManifest };
  deps.emit("info", agent.id, { kind: "effective_capability_manifest", manifest: capabilityManifest });

  deps.setAgentStatus(agent.id, task.statusWhileRunning ?? "thinking", task.goal.slice(0, 80));
  // v6 P3b: 包住整个 run，让其内部 request_channel 工具知道申请方是这个 agent。
  // A1-V3: 传 role,让 runShell 按角色 shellMode 档位拦截。
  const result = await deps.runWithAgent(agent.id, () => execRoute.engine.run(execAgent, injectedTask, execCtx), agent.role);

  if (!result.launchReceipt && (result.executor === "api" || execFramework === "api")) {
    const environmentNames = capabilityManifest.effective.environmentNames;
    const metadata = captureWorkerLaunchMetadata({
      file: process.execPath,
      args: ["opc-in-process-api", execAgent.provider, execAgent.model],
      env: Object.fromEntries(environmentNames.map((name) => [name, "<redacted>"])),
      cwd: execCtx.workdir,
    });
    result.launchReceipt = await buildWorkerLaunchReceipt(execAgent, injectedTask, execCtx, metadata, "in-process");
    emitWorkerLaunchReceipt(execCtx, execAgent, result.launchReceipt);
  }

  if (execCtx.abortSignal?.aborted) {
    result.status = "failed";
    result.error = "execution cancelled";
    result.fileChanges = [];
    result.partial = true;
  }

  // MUP B7 · <think> 泄漏统一收口:引擎产出进入 worker 结果前剥离正文内嵌思考块(R1/ollama 类模型
  // 一等公民),干净正文才进 recordMessage/report 合成/交付文本。思考内容不丢——以 agent_output_chunk
  // (thinking:true)emit(与 ACP thought 分流同形态,ephemeral 不落盘)。无标记时零改动。
  const _stripped = stripThinkBlocks(result.content ?? "");
  if (_stripped.clean !== (result.content ?? "")) result.content = _stripped.clean;
  if (_stripped.thinking) {
    try { deps.emit("agent_output_chunk", agent.id, { chunk: _stripped.thinking, thinking: true }); } catch { /* additive */ }
  }

  agent.tokenUsage.prompt += result.tokens.prompt;
  agent.tokenUsage.completion += result.tokens.completion;
  agent.tokenUsage.total += result.tokens.total;
  agent.costUsd = result.cost != null ? ((agent.costUsd ?? 0) + (result.cost ?? 0)) : null;

  deps.onCallRecord({
    // Guard 3:计账用"实际执行"的引擎(冷却路由/Team Mode 覆盖后的 execAgent),让成本看板归属准确。
    agentId: agent.id, provider: execAgent.provider, model: execAgent.model,
    content: result.content, toolCalls: result.toolCalls,
    promptTokens: result.tokens.prompt, completionTokens: result.tokens.completion,
    totalTokens: result.tokens.total, estimatedCostUsd: result.cost ?? undefined,
    latencyMs: result.latencyMs, startedAt, endedAt: new Date().toISOString(),
  });
  // v10 P0-1: this is the single common funnel for CEO/lead/worker calls — accumulate the run-level
  // running totals here so the circuit breaker (checked between teams/rounds) sees every call.
  deps.onUsage(result.tokens.total, result.cost ?? 0);

  // 限流后检测(对抗审查 Guard 1):只认引擎已耗尽自身重试后打的 [overloaded] 标记——单次自愈的 429 到不了这里。
  // 记一条纯内存自过期冷却(绝不写持久健康文件),并在主链路 trace 报出"几点恢复",后续调用自动改走备用。
  if (result.status === "failed" && (result.error ?? "").startsWith("[overloaded]")) {
    try {
      const ranKey = deps.makeCooldownKey(execFramework, execAgent.provider, execAgent.model);
      const entry = deps.recordRateLimit(ranKey, result.error ?? "");
      deps.emit("rate_limited", agent.id, {
        originalModel: ranKey,
        rateLimitedUntil: new Date(entry.rateLimitedUntil).toISOString(),
        resetSource: entry.resetSource,
        reason: "post-call overload detected",
        message: `${ranKey} 触发限流,冷却至约 ${new Date(entry.rateLimitedUntil).toLocaleString()},后续自动用备用模型直到恢复`,
      });
    } catch { /* additive */ }
  }

  if (result.status === "done") {
    agent.lastAction = `engine ${agent.framework ?? "api"}: ${result.tokens.total} tokens`;
    deps.setAgentStatus(agent.id, "idle");
  } else {
    agent.lastAction = `engine ${agent.framework ?? "api"}: ${result.status}`;
    deps.setAgentStatus(agent.id, result.status === "restricted" ? "restricted" : "failed", result.error);
    deps.emit("error", agent.id, { message: result.error, restricted: result.status === "restricted" });
  }
  return result;
}
