// B3 · opc-worker CLI 的执行 Runner:复用 B2 的 workerRuntime.runEngineCore 纯函数,组装一份最小
// WorkerRuntimeDeps,把结果落进与 HTTP 路径同构的 Runtime Contract 证据文件(task.json/result.json/
// events.jsonl/worker.config.json)。CEO/Lead/Worker/Reviewer 四种角色共用这一个 Runner——差别只在
// resolveAgent() 解析出哪个 agent、以及 systemPrompt 取哪个角色的 prompt(prompts.getRolePrompt)。
//
// 铁律(已知陷阱 · 见 apps/server/src/index.ts 的 validateProjectRoot 同类防御):projectRoot 只能由
// 调用方(worker.ts 的 CLI 入口)显式解析并传入这里的 opts.projectRoot;本文件内部绝不读 process.cwd()。
// 同理,多个 server 模块自身有 `let projectRoot = process.cwd()` 的模块级默认值(modelGateway.ts /
// pathGuard.ts),不显式调用对应 setter 就会静默用启动 CLI 时的 cwd 而不是这里解析出的 projectRoot——
// 下面显式调用 setToolsProjectRoot / setModelGatewayRoot 堵掉这个口子。
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentNodeConfig, ExecContext, ExecResult, ExecTask, Run } from "@opc/shared";
import { WorkerTaskContractSchema, type WorkerTaskContract } from "@opc/shared";
import { runEngineCore, type WorkerRuntimeDeps } from "@opc/server/src/runtime/workerRuntime.js";
import { buildSystemPrompt } from "@opc/server/src/runtime/contextBuilder.js";
import { frameworkPolicy, routeEngine, pickFallbackEngine } from "@opc/server/src/runtime/engineRouter.js";
import { makeCooldownKey, getCooldownEntry, recordRateLimit } from "@opc/server/src/runtime/rateLimitCooldown.js";
import { resolveApiKeyOverride } from "@opc/server/src/runtime/engines/apiKeyAccount.js";
import { runWithAgent, setToolsProjectRoot } from "@opc/server/src/runtime/tools.js";
import { getRolePrompt } from "@opc/server/src/runtime/prompts.js";
import { setModelGatewayRoot } from "@opc/server/src/runtime/modelGateway.js";
import type { CallRecord } from "@opc/server/src/runtime/modelGateway.js";
import { loadAccounts } from "@opc/server/src/storage/providerStore.js";
import { syncProvidersFromStore } from "@opc/server/src/runtime/providerRegistry.js";
import { loadAgents, loadConfig, mergeSaveAgents, createRun, saveRunTask } from "@opc/server/src/storage/projectStore.js";
import { setEventPersistRoot, setRunId, emit, getRunHistory } from "@opc/server/src/runtime/eventBus.js";
import {
  writeRunResult, writeDiagnostics, appendToolCalls, writeWorkerConfig,
  buildRunResultContract, deriveRunDiagnostics, deriveToolCallRecords,
} from "@opc/server/src/runtime/runtimeContract.js";

// 契约校验失败/agent 解析失败都走这个类型,便于 CLI 入口区分"用户输入问题"与"内部执行异常"。
export class WorkerTaskAgentResolutionError extends Error {}

/**
 * 按 task.agentId(精确)或 task.role(+可选 task.companyId 限定范围)在 agents.json 名册里解析出
 * 唯一执行者。agentId 缺省时按 role 找第一个已启用(enabled)的匹配 agent(按 id 排序取第一个,
 * 结果确定性、可重现)。找不到时抛错——不静默回退到"随便挑一个"或"假装成功"。
 */
export function resolveAgent(agents: AgentNodeConfig[], task: WorkerTaskContract): AgentNodeConfig {
  if (task.agentId) {
    const byId = agents.find((a) => a.id === task.agentId);
    if (!byId) {
      throw new WorkerTaskAgentResolutionError(
        `agentId "${task.agentId}" 在 .opc/agents.json 中不存在(名册共 ${agents.length} 个 agent)`,
      );
    }
    return byId;
  }
  const candidates = agents
    .filter((a) => a.enabled && a.role === task.role && (!task.companyId || a.companyId === task.companyId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const picked = candidates[0];
  if (!picked) {
    throw new WorkerTaskAgentResolutionError(
      `没有 role="${task.role}"${task.companyId ? ` companyId="${task.companyId}"` : ""} 的已启用 agent`
      + `(.opc/agents.json 名册共 ${agents.length} 个 agent)`,
    );
  }
  return picked;
}

export interface RunWorkerTaskOptions {
  /** 唯一允许的 projectRoot 来源——调用方(worker.ts)显式解析后传入,这里绝不再猜。 */
  projectRoot: string;
  /**
   * 仅供单测注入:覆盖任意 WorkerRuntimeDeps 字段(典型用法是替换 routeEngine,让单测走 mock 引擎、
   * 不打真模型/不花真钱)。生产 CLI 入口(worker.ts)从不传这个字段。
   */
  depsOverride?: Partial<WorkerRuntimeDeps>;
}

export interface WorkerRunOutcome {
  runId: string;
  agent: AgentNodeConfig;
  result: ExecResult;
  runDir: string;
}

export async function runWorkerTask(rawTask: unknown, opts: RunWorkerTaskOptions): Promise<WorkerRunOutcome> {
  const task = WorkerTaskContractSchema.parse(rawTask);
  const { projectRoot } = opts;

  // 堵住已知的"模块级默认 process.cwd()"陷阱(见文件头注释)。
  setToolsProjectRoot(projectRoot);
  setModelGatewayRoot(projectRoot);
  // B3-fix:CLI worker 默认路径(非 ACP)要真调供应商 API,必须先按 projectRoot 的 config/keys/accounts
  // 把 provider handler 注册进 modelGateway。server 启动时会做这件事(index.ts),但 CLI 独立入口没做,
  // 导致 provider=deepseek 等 API 节点报 "no handler registered"。
  syncProvidersFromStore(projectRoot);

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

  // B1 · Runtime Contract:执行配置快照,run 一开工就落盘(崩溃也有据可查),与 HTTP 路径同构。
  writeWorkerConfig(projectRoot, {
    schemaVersion: "1",
    runId,
    companyId: run.companyId,
    runType: "cli",
    agents: [{
      agentId: agent.id, name: agent.name, role: agent.role,
      framework: agent.framework ?? "api", provider: agent.provider, model: agent.model,
    }],
    createdAt: startedAt,
  });

  const cfg = loadConfig(projectRoot);
  const callRecords: CallRecord[] = [];
  let runTokens = 0;
  let runCost = 0;

  const defaultDeps: WorkerRuntimeDeps = {
    projectRoot,
    runId,
    teamMode: undefined,
    emit: (t, a, p) => emit(t as Parameters<typeof emit>[0], a, p),
    setAgentStatus: (id, status, currentTask) => {
      const a = agents.find((x) => x.id === id);
      if (a) {
        a.status = status;
        if (currentTask !== undefined) a.currentTask = currentTask;
        mergeSaveAgents(projectRoot, agents);
      }
      emit("agent_status_changed", id, { status, currentTask });
    },
    buildSystemPrompt,
    // B3 最小骨架:CLI 单任务执行没有 run 级 A2A bus(orchestrator 的 a2aBus 是整 run 生命周期的模块单例,
    // 单任务 Runner 不重建这套机制)——如实降级为空 inbox,不假装收到消息。
    drainInbox: () => [],
    frameworkPolicy,
    routeEngine,
    resolveNativeExecution: (currentAgent) => currentAgent.nativeExecution ?? { preference: "acp", fallback: "acp" },
    makeCooldownKey,
    getCooldownEntry,
    pickFallbackEngine,
    recordRateLimit,
    resolveApiKey: (framework, cliConfigDir) => resolveApiKeyOverride(loadAccounts(projectRoot), framework, cliConfigDir),
    runWithAgent,
    onCallRecord: (record) => { callRecords.push(record); },
    onUsage: (tokens, cost) => { runTokens += tokens; runCost += cost; },
  };
  const deps: WorkerRuntimeDeps = { ...defaultDeps, ...opts.depsOverride };

  const execTask: ExecTask = {
    taskId: task.taskId,
    goal: task.goal,
    systemPrompt: getRolePrompt(task.role ?? agent.role),
    maxTokens: task.maxTokens ?? 4096, // 与 orchestrator.runViaEngine 的默认值一致
  };
  const ctx: ExecContext = {
    runId,
    projectRoot,
    workdir: projectRoot,
    emit: (t, a, p) => emit(t as Parameters<typeof emit>[0], a, p),
    budget: { maxTokensPerTask: cfg.budget.maxTokensPerTask },
  };

  emit("run_started", undefined, { goal: task.goal });
  const result = await runEngineCore(agent, execTask, ctx, deps);

  run.status = result.status === "done" ? "done" : "failed";
  run.endedAt = new Date().toISOString();
  run.totalTokens = runTokens;
  run.totalCostUsd = runCost;
  run.participatingAgents = [agent.id];
  saveRunTask(projectRoot, run);
  mergeSaveAgents(projectRoot, agents); // 落盘 agent 最终 tokenUsage/costUsd/lastAction(runEngineCore 就地改了 agent 对象)
  emit("run_finished", undefined, { status: run.status });

  // B1 · Runtime Contract:result.json + diagnostics.json + tool_calls.jsonl,run 结束时从 RunHistory
  // 事件流一次性派生——与 orchestrator.ts 收尾段完全同款(同一批 writer/deriver 函数)。
  const events = getRunHistory().getEvents();
  writeRunResult(projectRoot, buildRunResultContract({
    run, agents: [agent], callRecords, artifacts: [], deferred: [],
  }));
  writeDiagnostics(projectRoot, deriveRunDiagnostics(runId, events));
  appendToolCalls(projectRoot, runId, deriveToolCallRecords(events));

  return { runId, agent, result, runDir };
}
