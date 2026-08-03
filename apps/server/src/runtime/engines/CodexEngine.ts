import type { AgentNodeConfig, ExecutionEngine, ExecTask, ExecContext, ExecResult, EngineAvailability } from "@opc/shared";
import { probeCodex } from "./probes.js";
import { filteredSpawnEnv } from "../../security/redact.js";
import { a2aSpawnEnv } from "../a2aSdk.js";
import { getProfileForRole } from "../roleProfile.js";
import { runAcpEngine, type AcpEngineSpec, type AcpPrepared, type AcpParsedOutput, type AcpStreamEvent } from "../acpBridge.js";
import { acpWorkerEnabled, runViaAcpWorker } from "./acpWorkerBackend.js";

// Codex CLI engine. Runs `codex exec --json` non-interactively in the node's workdir; the CLI
// edits files in place, so file changes are captured from the git working tree. Parses codex's
// JSONL event stream for text/tool/usage. Subscription tier — CEO/Lead only (router policy).
//
// NOTE: codex is not installed on this host (probe → restricted), so the JSON schema below is the
// documented best-known shape and is exercised by a stub test, not a live run. The parser is
// defensive: unknown event shapes fall back to plain text + git-diff file changes (never fakes).
//
// B4 二期:run() 只是 acpBridge.runAcpEngine 的一层薄包装,同 ClaudeCodeEngine 一期的迁移模式——
// spawn/重试/日志 sink/事件转发/成功判定这套通用骨架已经在 acpBridge.ts 里,这里只保留 codex 专属的
// 部分:CODEX_SPEC(参数拼装 + 认证 + 计费口径)与 parseCodexJson(继续导出给 codexTokens.test.ts 用)。
// codex 的鉴权完全靠 configDir 里持久化的登录态(见 apiKeyAccount.ts 顶部"不对称"说明),没有像
// claude-code 那样"每次 spawn 现查现注入 env key"的机制——AcpEngineSpec 现有形状(prepare() 直接把
// CODEX_HOME 塞进返回的 env)已经够用,不需要为此新增专属字段。probe() 不变。
export class CodexEngine implements ExecutionEngine {
  readonly framework = "codex" as const;

  async probe(): Promise<EngineAvailability> {
    return probeCodex();
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    // 定稿 2.2:codex 走自研 worker CLI 的 ACP 路径(唯一执行进程);spawn/握手失败自动降级到既有
    // CLI-spawn(runAcpEngine)。默认门控开启(逃生门 OPC_ACP_WORKER=0/false 关回 legacy,原因见 acpWorkerBackend.ts
    // acpWorkerEnabled 注释),关闭时直接走 legacy,行为逐字节不变。
    if (acpWorkerEnabled()) {
      return runViaAcpWorker(this.framework, node, task, ctx, {
        fallback: () => runAcpEngine(CODEX_SPEC, node, task, ctx),
      });
    }
    // A6a · 逃生门(非降级):显式关闭 ACP,如实标注 legacy_cli 但**不带 degradedReason**——
    // 不进 diagnostics executorFallbacks,不算降级 run,只让执行通道可见(同 ClaudeCodeEngine)。
    ctx.emit("info", node.id, { kind: "executor_selected", executor: "legacy_cli", message: "OPC_ACP_WORKER 显式关闭,本次走 legacy CLI-spawn 路径(用户逃生门,非降级)" });
    const res = await runAcpEngine(CODEX_SPEC, node, task, ctx);
    return { ...res, executor: "legacy_cli" };
  }
}

// exported for acpBridge/direct unit tests, mirrors ClaudeCodeEngine 的 CLAUDE_CODE_SPEC 导出姿势。
export const CODEX_SPEC: AcpEngineSpec = {
  command: "codex",
  logLabel: "codex",
  retry: { overloadRetries: 2, timeoutRetries: 1 }, // P2#2 审计:3→2,同 ClaudeCodeEngine

  prepare(node, task, ctx): AcpPrepared {
    // Pre-flight: don't spawn an unusable CLI — report restricted honestly.
    const avail = probeCodex(node.cliConfigDir);
    if (!avail.installed || !avail.loggedIn) {
      const reason = avail.detail || "codex 不可用";
      return { args: [], env: {}, timeoutMs: 0, restricted: reason };
    }

    // A git worktree is not an OS sandbox. Keep Codex in its native workspace-write sandbox and
    // ignore user config that could silently widen permissions. Network is binary in V0.
    // --ephemeral: don't persist session files to ~/.codex/sessions — keeps OPC's automated agent
    // runs OUT of the user's Codex desktop/CLI history (they're orchestration, not personal chats).
    const profile = getProfileForRole(node.role);
    const networkAccess = profile.networkMode === "on";
    const args = [
      "exec", "--json", "--ephemeral", "--sandbox", "workspace-write", "--ignore-user-config",
      "-c", `sandbox_workspace_write.network_access=${networkAccess ? "true" : "false"}`,
      "--skip-git-repo-check",
    ];
    ctx.emit("info", node.id, {
      kind: "worker_permission_posture",
      sandbox: "codex-workspace-write",
      approvalMode: "non-interactive",
      networkMode: networkAccess ? "on" : "off",
      fullHostAccess: false,
    });
    // Only pass --model for a safe model id (no spaces/shell metachars).
    if (node.model && /^[\w.\/:-]+$/.test(node.model)) args.push("--model", node.model);
    // `-` tells `codex exec` to read the prompt from STDIN (verified: without it codex waits/errs → CEO hang).
    args.push("-");

    // Stage 9:去掉本 agent 用不到的 provider key/secret + A1-V3:按 roleProfile.envAllowlist 收紧
    // (缺省=全放行;下方显式注入的 CODEX_HOME/A2A 身份在过滤之后 assign,不受影响)。
    const env = filteredSpawnEnv(node.provider, getProfileForRole(node.role).envAllowlist);
    if (node.cliConfigDir) env.CODEX_HOME = node.cliConfigDir;
    Object.assign(env, a2aSpawnEnv(ctx.runId, node.id)); // Phase 4:A2A SDK 身份 + OPC API 地址

    // Prompt via stdin (avoids Windows shell arg-splitting of multi-word prompts).
    const input = task.systemPrompt ? `${task.systemPrompt}\n\n${task.goal}` : task.goal;
    // ⏱️ P0#4:内层超时对齐任务时限(时限-20s 宽限),同 ClaudeCodeEngine——防 detached 进程击穿账号并发防线。
    const timeoutMs = ctx.taskTimeoutMs ? Math.max(60_000, ctx.taskTimeoutMs - 20_000) : (ctx.budget.maxTokensPerTask > 0 ? 600_000 : 300_000);

    return {
      args,
      env,
      input,
      timeoutMs,
      // cost:0 — codex 走 ChatGPT 订阅账号是 flat-rate。但一个 codex configDir 也可能是"API Key 模式"
      // 账号(手动 `codex login --with-api-key` 持久化的登录态,见 apiKeyAccount.ts)——那种账号是真·按
      // OpenAI API 用量计费的,不是订阅覆盖。注意:与 ClaudeCodeEngine 不同,这里**不**把 ctx.apiKeyOverride
      // 当 env 注入(codex 的认证完全靠 configDir 里已持久化的登录态,没有"每次 spawn 传 key"这种机制,
      // 见 apiKeyAccount.ts 顶部注释的不对称说明);这个字段在这只当"按量计费"的成本核算信号用——迁移前
      // run() 是在 spawn 完成后才算 `const cost = ctx.apiKeyOverride ? parsed.cost : 0;`,迁移后改用
      // billCost 在 prepare() 阶段先声明同一个判断,acpBridge 收到 parsed.cost 后按 billCost 过滤,结果等价。
      billCost: !!ctx.apiKeyOverride,
    };
  },

  parseOutput(stdout, onEvent): AcpParsedOutput {
    const p = parseCodexJson(stdout, onEvent);
    return {
      content: p.content,
      tokens: { prompt: p.inputTokens, completion: p.outputTokens, total: p.inputTokens + p.outputTokens },
      cost: p.cost,
      isError: p.isError,
      errorText: p.errorText,
    };
  },
};

interface ParsedCodex {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  isError: boolean;
  errorText?: string;
}
type CodexEvent = Extract<AcpStreamEvent, { kind: "tool_call" }>;

// Defensive parser for `codex exec --json` JSONL. Best-known schema:
//   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
//   {"type":"item.completed","item":{"type":"command_execution","command":"...","exit_code":0}}
//   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":M}}
//   {"type":"error","message":"..."}
// Falls back across field names (text/message/content) and tolerates unknown events.
export function parseCodexJson(stdout: string, onEvent?: (ev: CodexEvent) => void): ParsedCodex {
  let content = "";
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

    const item = ev.item ?? ev;
    const itemType = item.type ?? ev.type;

    if (itemType === "agent_message" || itemType === "assistant_message" || itemType === "message") {
      const text = item.text ?? item.message ?? item.content;
      if (typeof text === "string") content = content ? `${content}\n${text}` : text;
    } else if (itemType === "command_execution" || itemType === "function_call" || itemType === "tool_call") {
      onEvent?.({ kind: "tool_call", name: item.command ?? item.name ?? "command", input: item.input ?? { command: item.command } });
    } else if (ev.type === "error" || item.type === "error") {
      isError = true;
      errorText = ev.message ?? item.message ?? "codex error";
    }

    // turn.completed 是按 turn 报告用量(非累计总量)，多轮任务(工具调用往返多次)会出现多条——
    // 须累加，否则只留最后一轮，前面的 token 消耗全部丢失。
    const usage = ev.usage ?? item.usage;
    if (usage) {
      inputTokens += usage.input_tokens ?? usage.prompt_tokens ?? 0;
      outputTokens += usage.output_tokens ?? usage.completion_tokens ?? 0;
    }
    if (typeof ev.total_cost_usd === "number") cost = ev.total_cost_usd;
  }

  return { content, inputTokens, outputTokens, cost, isError, errorText };
}
