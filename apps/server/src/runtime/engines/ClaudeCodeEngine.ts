import type { AgentNodeConfig, ExecutionEngine, ExecTask, ExecContext, ExecResult, EngineAvailability } from "@opc/shared";
import { probeClaudeCode } from "./probes.js";
import { filteredSpawnEnv } from "../../security/redact.js";
import { a2aSpawnEnv } from "../a2aSdk.js";
import { resolveApiKeyOverride } from "./apiKeyAccount.js";
import { loadAccounts } from "../../storage/providerStore.js";
import { getProfileForRole } from "../roleProfile.js";
import { runAcpEngine, type AcpEngineSpec, type AcpPrepared, type AcpParsedOutput, type AcpStreamEvent } from "../acpBridge.js";
import { acpWorkerEnabled, runViaAcpWorker } from "./acpWorkerBackend.js";

// Claude Code CLI engine. Runs `claude -p <goal> --output-format stream-json --verbose
// --permission-mode acceptEdits` non-interactively in the node's workdir; the CLI edits files in
// place (acceptEdits), so file changes are captured from the git working tree. Parses the
// stream-json event log for token usage, cost, tool calls, and the final result text. Subscription
// tier, open to all roles (D2); ban risk is bounded by the account pool (CLI maxConcurrent=1 + backoff).
//
// B4:run() 只是 acpBridge.runAcpEngine 的一层薄包装——spawn/重试/日志 sink/事件转发/成功判定这套
// 通用骨架已经搬进 acpBridge.ts,这里只保留 claude-code 专属的部分:CLAUDE_CODE_SPEC(参数拼装 + 认证 +
// 计费口径)与 parseStreamJson(stream-json 流解析,继续导出给 claudeCodeTokens.test.ts 用)。
// probe() 不变。
export class ClaudeCodeEngine implements ExecutionEngine {
  readonly framework = "claude-code" as const;

  async probe(): Promise<EngineAvailability> {
    return probeClaudeCode();
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    // 定稿 2.2:claude-code 走自研 worker CLI 的 ACP 路径(唯一执行进程);spawn/握手失败自动降级到
    // 既有 CLI-spawn(runAcpEngine)。默认门控开启(逃生门 OPC_ACP_WORKER=0/false 关回 legacy,原因见
    // acpWorkerBackend.ts acpWorkerEnabled 注释),关闭时直接走 legacy,行为逐字节不变。
    if (acpWorkerEnabled()) {
      return runViaAcpWorker(this.framework, node, task, ctx, {
        fallback: () => runAcpEngine(CLAUDE_CODE_SPEC, node, task, ctx),
      });
    }
    // A6a · 逃生门(非降级):显式关闭 ACP,如实标注 legacy_cli 但**不带 degradedReason**——
    // 不进 diagnostics executorFallbacks,不算降级 run,只让执行通道可见。
    ctx.emit("info", node.id, { kind: "executor_selected", executor: "legacy_cli", message: "OPC_ACP_WORKER 显式关闭,本次走 legacy CLI-spawn 路径(用户逃生门,非降级)" });
    const res = await runAcpEngine(CLAUDE_CODE_SPEC, node, task, ctx);
    return { ...res, executor: "legacy_cli" };
  }
}

// exported for acpBridge.test.ts-style direct unit tests (bypasses the real probeClaudeCode()
// machine check, which the full ClaudeCodeEngine.run() path cannot easily mock — see
// ClaudeCodeEngine.acp.test.ts).
export const CLAUDE_CODE_SPEC: AcpEngineSpec = {
  command: "claude",
  logLabel: "claude-code",
  retry: { overloadRetries: 2, timeoutRetries: 1 }, // P2#2 审计:3→2,过载时更快让位给 orchestrator 的冷却路由

  prepare(node, task, ctx): AcpPrepared {
    // API Key 模式简化(2026-07):引擎自己现查现算,不再依赖 orchestrator 预先解析好塞进
    // ctx.apiKeyOverride(orchestrator.ts 由另一条并行工作线在改,这次改动刻意不碰它)。node.claudeCodeUseApiKey
    // 是节点设置面板里的显式开关(默认 false,不静默改变计费方式);为 true 时复用"供应商与账号"里任意一个
    // providerId===anthropic 且持有 apiKey 的账号(见 apiKeyAccount.ts)。claude 官方文档明确"Anthropic
    // auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never
    // read)"——只要 spawn 时设了这个 env var,claude 就用它认证,完全不看 configDir 里有没有订阅登录态。
    // 所以这里跳过 loggedIn(credentials.json)门,只要求 CLI 本身已装。
    let apiKeyOverride: string | undefined;
    try {
      apiKeyOverride = resolveApiKeyOverride(loadAccounts(ctx.projectRoot), "claude-code", node.cliConfigDir, node.claudeCodeUseApiKey);
    } catch { /* best-effort:账号解析失败不阻塞执行,退回订阅/全局登录路径 */ }
    const apiKeyMode = !!apiKeyOverride;

    // Pre-flight: don't spawn an unusable CLI — report restricted honestly.
    const avail = probeClaudeCode(node.cliConfigDir);
    if (!avail.installed || (!apiKeyMode && !avail.loggedIn)) {
      const reason = avail.detail || "claude-code 不可用";
      return { args: [], env: {}, input: "", timeoutMs: 0, restricted: reason };
    }

    // IMPORTANT: pass the prompt via stdin, not as an argv. On Windows, .cmd shims require
    // shell:true, under which Node concatenates args WITHOUT escaping (DEP0190) — a multi-word
    // prompt arg would be split into garbage. So keep every arg single-token and feed the full
    // prompt (system + goal) on stdin, which `claude -p` reads.
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", "acceptEdits",
      // Keep OPC's automated agent runs OUT of the user's Claude desktop/CLI history (they're
      // orchestration, not personal chats) — equivalent to codex's --ephemeral.
      "--no-session-persistence",
    ];
    // Only pass --model for a safe model id (no spaces/shell metachars) — spawnCli uses shell:true
    // on Windows (.cmd shim), so an unsanitized free-text model could inject (DEP0190).
    if (node.model && /^[\w.\/:-]+$/.test(node.model)) args.push("--model", node.model);
    // 推理档:claude CLI 2.1.x+ 原生支持 --effort low|medium|high|xhigh(与 OPC ReasoningEffort 1:1)。
    // ACP 默认路径经 CLAUDE_CODE_EFFORT_LEVEL 注入;此 legacy 直接 spawn 路径用等价的 --effort 旗标。
    // 白名单校验:spawnCli 在 Windows 走 shell:true,只放已知枚举值(防 DEP0190 注入)。
    if (node.reasoningEffort && /^(low|medium|high|xhigh)$/.test(node.reasoningEffort)) {
      args.push("--effort", node.reasoningEffort);
    }

    // Stage 9:去掉本 agent 用不到的 provider key/secret(防内置 shell printenv 外泄)
    // + A1-V3:按 roleProfile.envAllowlist 收紧(缺省=全放行;下方显式注入的 CLAUDE_CONFIG_DIR/
    //   ANTHROPIC_API_KEY/A2A 身份在过滤之后 assign,不受影响——只加过滤,不改注入逻辑)。
    const env = filteredSpawnEnv(node.provider, getProfileForRole(node.role).envAllowlist);
    if (node.cliConfigDir) env.CLAUDE_CONFIG_DIR = node.cliConfigDir;
    // API Key 模式:每次 spawn 现注入,不落盘、不进 filteredSpawnEnv 的白名单逻辑(那是给"agent 自己
    // provider 的 key"用的,与此处"CLI 引擎认证"是两回事)——绝不 emit/log 这个值。
    if (apiKeyOverride) env.ANTHROPIC_API_KEY = apiKeyOverride;
    Object.assign(env, a2aSpawnEnv(ctx.runId, node.id)); // Phase 4:让该 worker 的 A2A SDK 知道自己是谁 + OPC API 地址

    const input = task.systemPrompt ? `${task.systemPrompt}\n\n${task.goal}` : task.goal;
    // ⏱️ P0#4:内层超时对齐任务时限(时限-20s 宽限)——子进程先于外层 race 被杀,不再有 detached 进程
    // 拿着订阅账号继续跑满 10min(击穿 per-account=1 防封号并发防线)。无任务时限时保留旧挡位。
    const timeoutMs = ctx.taskTimeoutMs ? Math.max(60_000, ctx.taskTimeoutMs - 20_000) : (ctx.budget.maxTokensPerTask > 0 ? 600_000 : 300_000);

    return {
      args,
      env,
      input,
      timeoutMs,
      // cost:0 — claude-code 走订阅账号是 flat-rate,不按 token 计费,把 stream-json 里本该算的 API 成本
      // 计入 run/budget 会虚增 cumulativeCost,可能过早触发 totalUsd 预算门(订阅 run 实际 $0 消耗)。
      // 但 API Key 模式(apiKeyMode)是真·按量计费的 Anthropic API 调用——继续报 0 会让预算刹车形同虚设,
      // 这里改用 parsed.cost(来自 stream-json 的 total_cost_usd,同一份数据,只是不再丢弃)。
      billCost: apiKeyMode,
    };
  },

  parseOutput(stdout, onEvent): AcpParsedOutput {
    const p = parseStreamJson(stdout, onEvent);
    return {
      content: p.content,
      tokens: { prompt: p.inputTokens, completion: p.outputTokens, total: p.inputTokens + p.outputTokens },
      cost: p.cost,
      isError: p.isError,
      errorText: p.errorText,
    };
  },
};

interface ParsedStream {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  isError: boolean;
  errorText?: string;
}

// Parse claude's stream-json JSONL: assistant events carry text + tool_use blocks; the final
// `result` event carries cost/usage/result text. Defensive — skips unparseable lines and tolerates
// schema drift across CLI versions (missing fields default to 0 / accumulated text).
export function parseStreamJson(stdout: string, onEvent?: (ev: AcpStreamEvent) => void): ParsedStream {
  let content = "";
  let textAccum = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let cost = 0;
  let isError = false;
  let errorText: string | undefined;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== "{") continue;
    let ev: any;
    try { ev = JSON.parse(trimmed); } catch { continue; }

    if (ev.type === "assistant" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "text" && typeof block.text === "string") textAccum += block.text;
        else if (block.type === "tool_use") onEvent?.({ kind: "tool_call", name: block.name, input: block.input ?? {} });
      }
      if (ev.message.usage) {
        // Count the FULL prompt: input_tokens excludes cached tokens, which claude still processes
        // (and bills). Omitting cache_read/cache_creation undercounts huge prompts (e.g. 4 vs 26k).
        const u = ev.message.usage;
        inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        outputTokens += u.output_tokens ?? 0;
      }
    } else if (ev.type === "user" && ev.message?.content) {
      for (const block of ev.message.content) {
        if (block.type === "tool_result") {
          const r = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
          onEvent?.({ kind: "tool_result", name: block.tool_use_id ?? "tool", result: r.slice(0, 500) });
        }
      }
    } else if (ev.type === "result") {
      if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
      if (ev.usage) {
        // result usage is authoritative — OVERWRITE (not +=) the assistant accumulation, but include
        // cache tokens so the full prompt is counted (the result event reports the per-run total).
        const ri = ev.usage.input_tokens;
        if (ri != null) inputTokens = ri + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0);
        outputTokens = ev.usage.output_tokens ?? outputTokens;
      }
      if (ev.is_error) { isError = true; errorText = typeof ev.result === "string" ? ev.result : "claude reported error"; }
      else if (typeof ev.result === "string") content = ev.result;
    }
  }

  return { content: content || textAccum, inputTokens, outputTokens, cost, isError, errorText };
}
