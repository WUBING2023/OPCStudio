// 相1 · ACP 执行路径的 worker Runner。与旧 spawn 路径(../workerRunner.ts 的 runWorkerTask)并列、
// 互不影响——旧路径原封不动(保底 fallback)。本 Runner 用 AcpClient 起自研 ACP 客户端会话,产出照旧落
// 与 HTTP 路径同构的 Runtime Contract 证据(task.json/result.json/events.jsonl/worker.config.json/
// diagnostics.json/tool_calls.jsonl),run 事件带 executor:"acp"。
//
// 成功判定纪律(任务书 4):AcpClient 只回原始证据(含 stopReason 外部完成信号),这里据"会话是否跑通"
// 决定 run 的 done/failed(跑通=引擎产出已作为证据落盘),绝不据 stopReason 值标成功——语义验收归 Core。
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentNodeConfig, ExecResult, ReasoningEffort, Run, RunResultContract } from "@opc/shared";
import { WorkerTaskContractSchema } from "@opc/shared";
import { loadAgents, loadConfig, mergeSaveAgents, createRun, saveRunTask } from "@opc/server/src/storage/projectStore.js";
import { setEventPersistRoot, setRunId, emit, getRunHistory } from "@opc/server/src/runtime/eventBus.js";
import {
  writeRunResult, writeDiagnostics, appendToolCalls, writeWorkerConfig,
  buildRunResultContract, deriveRunDiagnostics, deriveToolCallRecords,
} from "@opc/server/src/runtime/runtimeContract.js";
import { resolveAgent } from "../workerRunner.js";
import { AcpClient, AcpTransportError } from "./acpClient.js";
import { buildEngineSpec, type AcpEngineId, type AcpEngineSpec } from "./engineRegistry.js";
import { buildAcpTaskBrief } from "./acpPrompt.js";
import type { McpServer } from "@agentclientprotocol/sdk";

// P1 · worker 的 projectRoot 是隔离沙盒(--project-root <isolatedRoot>),读不到真项目的 mcp_servers.json/acpMcp。
// 故由 server 端(acpWorkerBackend,有真 root+config)解析好要接给本 worker 的 McpServer[],写进沙盒 .opc/acp_mcp.json;
// worker 只负责读它、透传给 session/new。读失败/无文件 → 空数组(退回既有 curl 兜底路径,不中断)。
function loadOpcMcpServers(projectRoot: string): McpServer[] {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(projectRoot, ".opc", "acp_mcp.json"), "utf-8"));
    return Array.isArray(arr) ? (arr as McpServer[]) : [];
  } catch { return []; }
}

// 交付文本落盘上限:result.json.content / report.md 各自最多 200KB(超出截断并标注,防证据文件写爆)。
const DELIVERABLE_MAX_BYTES = 200 * 1024;

// 把累积的 assistant 交付文本按 200KB 上限截断(标注);未超限原样返回。空串原样返回(不造假)。
function clampDeliverable(text: string): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.byteLength <= DELIVERABLE_MAX_BYTES) return text;
  const head = buf.subarray(0, DELIVERABLE_MAX_BYTES).toString("utf-8");
  return `${head}\n\n[truncated: 交付文本超过 200KB,已截断]`;
}

// report.md:把交付文本(agent_message_chunk 累积文本)原样落进 run 目录,供 server 端读回。
// best-effort——写失败绝不影响 run;空输出如实写空文件(server 端 trim 后不采用,反映"无输出")。
function writeReportMd(runDir: string, content: string): void {
  try {
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "report.md"), content, "utf-8");
  } catch { /* best-effort */ }
}

export interface RunAcpWorkerTaskOptions {
  projectRoot: string;
  engine: AcpEngineId;
  /** 仅供单测注入:替换 spawn 规格,让测试指向假 ACP agent fixture(绝不真调引擎/真花钱)。第二参为该员工
   *  显式选定的推理档位(reasoningEffort),第三参为选定订阅账号的隔离登录目录(cliConfigDir),便于断言透传。 */
  buildSpec?: (engine: AcpEngineId, reasoningEffort?: ReasoningEffort, cliConfigDir?: string) => AcpEngineSpec;
  /** 仅供单测注入:直接换掉 AcpClient(默认按 spec 构造)。 */
  makeClient?: (spec: AcpEngineSpec, prompt: string) => AcpClient;
}

export interface AcpWorkerRunOutcome {
  runId: string;
  agent: AgentNodeConfig;
  result: ExecResult;
  runDir: string;
  stopReason: string;
  /** true = tokens 由输出文本估算(引擎未上报 usage,如 claude-code ACP);成本页应标“估算”。 */
  estimated: boolean;
}

export async function runAcpWorkerTask(rawTask: unknown, opts: RunAcpWorkerTaskOptions): Promise<AcpWorkerRunOutcome> {
  const task = WorkerTaskContractSchema.parse(rawTask);
  const { projectRoot, engine } = opts;

  const agents = loadAgents(projectRoot, []);
  const agent = resolveAgent(agents, task);
  const runId = task.runId ?? randomUUID();
  const runDir = path.join(projectRoot, ".opc", "runs", runId);

  setEventPersistRoot(projectRoot);
  setRunId(runId);

  const startedAt = new Date().toISOString();
  const run: Run = {
    id: runId,
    userGoal: task.goal,
    companyId: task.companyId ?? agent.companyId ?? "default",
    status: "running",
    startedAt,
    totalTokens: 0,
    totalCostUsd: 0,
    participatingAgents: [agent.id],
  };
  createRun(projectRoot, run);

  writeWorkerConfig(projectRoot, {
    schemaVersion: "1",
    runId,
    companyId: run.companyId,
    runType: "cli-acp",
    agents: [{
      agentId: agent.id, name: agent.name, role: agent.role,
      framework: agent.framework ?? "hermes", provider: agent.provider, model: agent.model,
    }],
    createdAt: startedAt,
  });

  loadConfig(projectRoot); // 触发 .opc 校验/默认写入,与旧路径一致(结果暂不用于 ACP text-only)

  const acpEmit = (t: string, a: string | undefined, p: unknown) => emit(t as Parameters<typeof emit>[0], a, p);

  emit("run_started", undefined, { goal: task.goal, executor: "acp", engine });

  // ACP 路径的 prompt = 工整任务简报(不带 hermes 内核指令);text-only 会话下强制“以文本给出结果”,
  // 规避上一波空输出根因(hermes prompt 逼 agent 写文件、在无写工具时误判无法产出)。
  const promptText = buildAcpTaskBrief({ goal: task.goal, role: task.role ?? agent.role });

  // 任务执行链:该员工显式选定的推理档位(agent.reasoningEffort)与订阅账号隔离登录目录(agent.cliConfigDir,
  // 节点显式指定或 parallelExecutor 从账号池租约灌入)一并透传给 buildEngineSpec——后者注入 CLAUDE_CONFIG_DIR/
  // CODEX_HOME,确保 ACP 路径真用选定账号执行(此前只有 legacy CLI-spawn 注入,ACP 会静默落回全局登录)。
  const spec = (opts.buildSpec ?? ((e, eff, dir) => buildEngineSpec(e, { reasoningEffort: eff, cliConfigDir: dir })))(engine, agent.reasoningEffort, agent.cliConfigDir);
  // permissionPolicy:"allow"——worker 执行路径的 cwd=隔离沙盒根(acpWorkerBackend mkdtemp + 播种 producer 文件),
  // 引擎必须能在其中写交付(claude-code/codex 原生工具会发 session/request_permission;deny 即产 0 交付=根因)。
  // 交付经 server 端 G1 recoverProducerDelta 带越界/敏感/配额校验回收;沙盒随 run 结束整树清理。
  const mcpServers = loadOpcMcpServers(projectRoot); // P1:enabled 的 MCP 透传给 session/new(env OPC_ACP_MCP 门控)
  if (mcpServers.length) emit("info", agent.id, { kind: "acp_mcp_wired", count: mcpServers.length, servers: mcpServers.map((m) => m.name) });
  const client = opts.makeClient
    ? opts.makeClient(spec, promptText)
    : new AcpClient({ spec, cwd: projectRoot, emit: acpEmit, agentId: agent.id, provider: agent.provider, model: agent.model, permissionPolicy: "allow", mcpServers });

  const t0 = Date.now();
  let result: ExecResult;
  let stopReason = "no_response";
  let estimated = false;
  let deliverableText = ""; // 累积 assistant 交付文本(→ report.md + result.json.content);失败/空输出为空串
  const callRecords: Array<{ agentId: string; totalTokens?: number; estimatedCostUsd?: number }> = [];

  try {
    const outcome = await client.run(promptText);
    stopReason = outcome.stopReason;
    estimated = outcome.estimated;
    deliverableText = outcome.message; // 空则空串,不造假(ExecResult.content 的 "(no output)" 仅供本地展示)
    // ACP 订阅引擎(Codex/Claude)无按量计费,成本用 null 而非 $0 误导。
    result = {
      content: outcome.message || "(no output)",
      fileChanges: [],
      tokens: outcome.tokens,
      cost: null,
      latencyMs: Date.now() - t0,
      status: "done", // 会话跑通 = 引擎产出已成证据;语义成功由 Core 验收,不看 stopReason
    };
    // 单条聚合调用记录(供 result.json 的 per-agent tokens/cost 派生)。
    callRecords.push({
      agentId: agent.id,
      totalTokens: outcome.tokens.total,
      estimatedCostUsd: outcome.cost,
    });
  } catch (e) {
    const msg = e instanceof AcpTransportError
      ? (e.stderrTail ? `${e.message}\n${e.stderrTail}` : e.message)
      : e instanceof Error ? e.message : String(e);
    // 明确诊断:Windows 缺 git-bash 是 claude-code 会话 init 的高发失败(原始错误含 "git-bash")→ 归类为
    // git_bash_missing 并给出可操作补救,不让它淹没成模糊的 no_response(Fix3:自动注入仍失败时的兜底可见性)。
    if (/git-?bash|CLAUDE_CODE_GIT_BASH_PATH/i.test(msg)) {
      stopReason = "git_bash_missing";
      emit("info", agent.id, {
        kind: "engine_init_failure",
        category: "git_bash_missing",
        framework: "claude-code",
        message: "claude-code 会话 init 失败:Windows 需要 git-bash。自动探测未命中——请安装 Git for Windows,或设 CLAUDE_CODE_GIT_BASH_PATH 指向 <Git>\\bin\\bash.exe。",
      });
    }
    emit("error", agent.id, { message: msg, restricted: false });
    result = {
      content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 },
      cost: null, latencyMs: Date.now() - t0, status: "failed", error: msg,
    };
  }

  run.status = result.status === "done" ? "done" : "failed";
  run.endedAt = new Date().toISOString();
  run.totalTokens = result.tokens.total;
  run.totalCostUsd = result.cost;
  run.participatingAgents = [agent.id];
  agent.tokenUsage = {
    prompt: result.tokens.prompt,
    completion: result.tokens.completion,
    total: result.tokens.total,
  };
  agent.costUsd = result.cost;
  saveRunTask(projectRoot, run);
  mergeSaveAgents(projectRoot, agents);
  emit("run_finished", undefined, { status: run.status, executor: "acp", stopReason });

  const events = getRunHistory().getEvents();
  // 交付文本落盘:report.md + result.json.content(标准 RunResultContract 无 content 字段,这里加性透传;
  // server 端 acpWorkerBackend.readDeliverableContent 优先读 content、其次 report.md)。空输出如实空串。
  const deliverable = clampDeliverable(deliverableText);
  const contract: RunResultContract & { content: string } = {
    ...buildRunResultContract({
      run: {
        id: run.id,
        status: run.status === "done" ? "done" : "failed",
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        totalTokens: run.totalTokens,
        totalCostUsd: run.totalCostUsd,
        participatingAgents: run.participatingAgents,
      },
      agents: [agent], callRecords, artifacts: [], deferred: [],
    }),
    content: deliverable,
  };
  writeRunResult(projectRoot, contract);
  writeReportMd(runDir, deliverable);
  writeDiagnostics(projectRoot, deriveRunDiagnostics(runId, events));
  appendToolCalls(projectRoot, runId, deriveToolCallRecords(events));

  return { runId, agent, result, runDir, stopReason, estimated };
}
