import type { AgentNodeConfig, AgentFramework, ExecutionEngine, ExecTask, ExecContext, ExecResult, EngineAvailability } from "@opc/shared";
import { callModel } from "../modelGateway.js";
import { diffFileChanges } from "../fileChanges.js";
import { getActiveTools } from "../tools.js";
import { createEngineLogSink } from "../engineLogCapture.js";
import { runApiToolLoop, resolveLoopTimeoutMs } from "./apiToolLoop.js";

// API 执行引擎 —— OPC 内部 in-process tool-loop(apiToolLoop),替代外部 Hermes CLI:
// callModel 直连供应商 API(不 spawn 任何子进程),工具环用 OPC 自己的 tools.ts(ALL_TOOLS+MCP),
// 文件变更从 git 工作树捕获。行为契约与 HermesEngine 等价:mock 短路 / 反假成功(零输出判 failed)/
// 超时抢救 partial / restricted 分类 / 日志 tee。租约账号 key(ctx.leasedAccount)原生直进 HTTP
// header(ModelInput.apiKey → provider handler),根治 Hermes credential_pool 抢占 P0。
// Phase 3 才把 "api" 加进 AgentFramework 枚举并接入 engineRouter;本阶段引擎只被单测直接调用,
// 故此处以类型断言过渡,不动 shared schema/types。
const API_FRAMEWORK = "api" as AgentFramework;

// MUP Gate A#2 · simulated 加性透传:mock provider 的引擎结果带 simulated:true(结构化标记,非 [MOCK]
// 文本约定)。ExecResult 本体定义在 packages/shared/engine.ts(泳道1 属地),此处用交叉类型先行——
// shared 侧补上 simulated?: true 后这个别名自然收敛,行为零变。
type ApiExecResult = ExecResult & { simulated?: true };

export class ApiEngine implements ExecutionEngine {
  readonly framework = API_FRAMEWORK;

  async probe(): Promise<EngineAvailability> {
    // in-process 引擎无 CLI/登录态可探;可用性的诚实闸门是 provider key 维度(capabilityReport)。
    return { framework: API_FRAMEWORK, installed: true, loggedIn: true, version: "in-process" };
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    const t0 = Date.now();
    // mock provider 走 callModel 注册的 mock handler,零外呼零密钥——orchestrator E2E(npm run e2e)
    // 全链可跑通(与 HermesEngine mock 短路同款)。
    if (node.provider === "mock") {
      try {
        const out = await callModel({ agentId: node.id, provider: "mock", model: node.model, system: task.systemPrompt, messages: [{ role: "user", content: task.goal }], maxTokens: task.maxTokens, agentRole: node.role });
        // simulated 透传两路:①model_call_finished payload(index.ts 订阅者原样落 ledger payload +
        // usage 分列)②引擎结果(→ parallelExecutor WorkerResult → run 级聚合,泳道1 接手)。
        ctx.emit("model_call_finished", node.id, { tokens: out.totalTokens, cost: out.estimatedCostUsd ?? 0, provider: "mock", model: node.model, simulated: true });
        const res: ApiExecResult = { content: out.content, toolCalls: out.toolCalls, fileChanges: diffFileChanges(ctx.workdir), tokens: { prompt: out.promptTokens, completion: out.completionTokens, total: out.totalTokens }, cost: out.estimatedCostUsd ?? 0, latencyMs: Date.now() - t0, status: "done", executor: "api" };
        res.simulated = true; // provider===mock 是结构化事实(callModel 也已在 CallRecord 补戳)
        return res;
      } catch (e: any) {
        const res: ApiExecResult = { content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: Date.now() - t0, status: "failed", error: e?.message || String(e), executor: "api" };
        res.simulated = true; // mock 路径的失败同样是模拟的,不形成真实失败经验
        return res;
      }
    }

    const tokens = { prompt: 0, completion: 0, total: 0 };
    let spentCost = 0;
    // 多账号自动切换:accountPool 租到的账号 key 直进这次调用的 HTTP header。providerId 必须与当前
    // 实际要跑的 node.provider 一致才套用——限流冷却路由可能已把 provider 换成备用供应商,那时这把
    // (为原 provider 租到的)key 不再适用,诚实跳过、退回该 provider 注册时的 key。与 Hermes 的
    // env var + credential_pool 探测不同,这里是 per-call 原生覆写,租约 100% 生效,无竞争可言。
    let apiKey: string | undefined;
    if (ctx.leasedAccount && ctx.leasedAccount.providerId === node.provider && node.provider) {
      apiKey = ctx.leasedAccount.apiKey;
    } else if (ctx.apiKeyOverride) {
      apiKey = ctx.apiKeyOverride;
    }

    const logSink = createEngineLogSink(ctx.projectRoot, ctx.runId, "api", node.id);
    // A6a · executor 三值标注:与 acpWorkerBackend 的 executor_selected 同款事件,不带 degradedReason
    // (非降级)——diagnostics executorFallbacks 不吃它,per-agent executor 派生(runtimeContract)吃它。
    ctx.emit("info", node.id, { kind: "executor_selected", executor: "api", engine: node.provider, message: "本次由 OPC 自建 ApiEngine(in-process)执行" });
    try {
      const out = await runApiToolLoop({
        agentId: node.id,
        provider: node.provider,
        model: node.model,
        agentRole: node.role,
        system: task.systemPrompt,
        goal: task.goal,
        maxTokens: task.maxTokens,
        tools: getActiveTools(),
        workdir: ctx.workdir,
        projectRoot: ctx.projectRoot,
        apiKey,
        timeoutMs: resolveLoopTimeoutMs(ctx.taskTimeoutMs),
        // A7 · 预算接线:parallelExecutor 早已在 ctx 里传这两项(budget.maxTokensPerTask / noCode 角色的
        // workspaceQuotaBytes),此前被完全忽略——今起真被消费。0 沿用"0=禁用"惯例,归一成 undefined。
        maxBudgetTokens: ctx.budget?.maxTokensPerTask || undefined,
        abortSignal: ctx.abortSignal,
        workspaceQuotaBytes: ctx.workspaceQuotaBytes || undefined,
        emit: ctx.emit,
        onUsage: (promptTokens, completionTokens, costUsd) => {
          tokens.prompt += promptTokens;
          tokens.completion += completionTokens;
          tokens.total += promptTokens + completionTokens;
          spentCost += costUsd;
        },
        onChunk: (chunk, stream) => { if (stream === "stderr") logSink.onStderr(chunk); else logSink.onStdout(chunk); },
      });
      tokens.prompt = out.promptTokens;
      tokens.completion = out.completionTokens;
      tokens.total = out.totalTokens;
      const cost = out.costUsd;

      const fileChanges = diffFileChanges(ctx.workdir);
      // 反假成功:循环正常收尾/超时抢救但零产出——不得包装成 status:"done"。如实判 failed。
      if (!out.content || !out.content.trim()) {
        const msg = out.timedOutPartial
          ? "API 引擎达到时间上限被终止且零产出(无可抢救内容)"
          : "API 引擎零输出:模型调用完成但无实质内容";
        ctx.emit("error", node.id, { message: msg, restricted: false });
        return { content: "", toolCalls: out.toolCalls, fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "failed", error: msg, executor: "api" };
      }
      // ⏱️ 超时抢救:达到引擎级 deadline 但已有实质产出 → 正常返回但标 partial,下游按"部分产物"诚实使用。
      if (out.timedOutPartial) {
        ctx.emit("info", node.id, { kind: "timeout_salvage", message: `⏱️ 达到时间上限被终止;已抢救 ${out.content.length} 字部分产出(标记为 partial)` });
        return { content: out.content, toolCalls: out.toolCalls, fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "done", partial: true, executor: "api" };
      }
      return { content: out.content, toolCalls: out.toolCalls, fileChanges, tokens, cost, latencyMs: Date.now() - t0, status: "done", executor: "api" };
    } catch (e: any) {
      // 并发稳定性硬化:undici 的裸网络错("fetch failed")真错在 e.cause.code(ECONN…),旧正则只看 message
      // 会漏判 → 归 failed → 在【同一 lease】上零退避重试烧光 maxAttempts → retry_budget_exhausted + 账号熔断,
      // 整队坍塌。改为把 cause.code 并入判据 + 补网络关键词,使网络故障判 restricted → 立即 defer(provider_unavailable)
      // 释放 lease、不烧预算、不误记账号熔断(经 modelGateway 层 fetchWithBackoff 退避后仍失败才会到这)。
      const msg = `${e?.message || String(e)} ${e?.cause?.code ?? ""}`.trim();
      // no handler(缺 key)/model not found/连接级故障/网络错 → restricted(框架/供应商不可用,不进重试循环);
      // 任务级超时不算 restricted("timed out" 刻意排除,归 failed→deferred timeout,与 Hermes 契约一致)。
      const restricted = /unavailable|spawn failed|not found|no such|command not found|ENOENT|ECONN|ETIMEDOUT|exited null|fetch failed|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg) && !/timed out/i.test(msg);
      ctx.emit("error", node.id, { message: msg, restricted });
      const fileChanges = diffFileChanges(ctx.workdir);
      // Tool calls may have persisted useful files before a later model request
      // times out. Preserve that evidence instead of reporting an empty worker.
      // The parallel executor still runs file guards, quality gates and independent
      // verification, so partial files can never manufacture a verified success.
      if (!restricted && /timed out|timeout|token budget exhausted|tool loop made no progress/i.test(msg) && fileChanges.length > 0) {
        return {
          content: `Recovered ${fileChanges.length} file change(s) before the API tool loop stopped: ${msg}.`,
          fileChanges,
          tokens,
          cost: spentCost,
          latencyMs: Date.now() - t0,
          status: "done",
          partial: true,
          error: msg,
          executor: "api",
        };
      }
      return {
        content: "", fileChanges, tokens, cost: spentCost, latencyMs: Date.now() - t0,
        status: restricted ? "restricted" : "failed", error: msg, executor: "api",
      };
    } finally {
      logSink.close();
    }
  }
}
