// 定稿 2.2 · server 侧 ACP-worker 执行后端。
// 把上一波落地的自研 worker ACP 客户端(apps/cli/src/acp/*)接进 server 派发链:凡 claude-code/codex
// 这类外部订阅引擎执行,不再在 server 进程内直接 spawn CLI(那条 acpBridge.runAcpEngine 的 legacy
// CLI-spawn 路径降为保底 fallback),改为 spawn 自研 worker CLI(node/tsx 直调 apps/cli 入口,不依赖
// PATH 上的 opc)+ --executor acp --engine <映射>。worker 在一个**隔离**的 projectRoot 里执行,产出
// 只作证据(隔离 run 目录内的 result.json/events.jsonl/diagnostics.json/...),本后端读取并回放进真实
// run 的事件流 + 组装成 ExecResult 交给上层入账;worker 绝不直写正式库(隔离根保证这一点)。
//
// 铁律落点:
//  1) success 判定仍归 Core 验证链——本后端据"worker 是否跑通 ACP 会话(result.json.status)"决定
//     ExecResult.status(done/failed),绝不据引擎自称成功;语义验收在上层 gate(与 acpBridge 同纪律)。
//  2) 保底 fallback(用户拍板):ACP spawn/握手失败(spawnError / 超时 / 无 result.json / result.json
//     status=failed=worker 内 AcpTransportError)→ 自动降级到 opts.fallback()(即 runAcpEngine 的 legacy
//     CLI-spawn),run 事件记 executor:"legacy_cli" + degradedReason;正常 ACP 路径事件带 executor:"acp"。
//  3) 订阅模式纪律 + IRON RULE:spawn worker 的 env 必删 CLAUDECODE(探针 #4 嵌套会话自杀守卫),
//     且绝不注入 OPENAI_API_KEY/CODEX_API_KEY(探针 #5,一旦存在 codex 切 api-key 计费;这里主动剥除)。
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import type { AgentFramework, AgentNodeConfig, EngineExecutor, ExecContext, ExecResult, ExecTask, FileChange } from "@opc/shared";
import { gitHeadCommit, seedSnapshotFromWorktree } from "../worktree.js";
import { runVerifierTestsInSnapshot } from "../tools.js";
import { buildCliWorkerEnv, buildCliWorkerLaunch } from "./workerLaunch.js";
import { getProjectRoot } from "../../security/pathGuard.js";
import { listMcpServers } from "../../storage/mcpStore.js";
import { loadAccounts } from "../../storage/providerStore.js";
import { consumeCredentialLease, issueCredentialLease, revokeCredentialLease } from "../../security/credentialBroker.js";
import {
  buildWorkerLaunchReceipt,
  captureWorkerLaunchMetadata,
  emitWorkerLaunchReceipt,
  type WorkerLaunchMetadata,
} from "../workerLaunchReceipt.js";

// P1 · 把非绝对命令(npx/uvx)解析成绝对可执行路径——ACP McpServerStdio.command 要求绝对路径。
function resolveMcpExe(cmd: string): string {
  if (path.isAbsolute(cmd)) return cmd;
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  const dirs = [path.dirname(process.execPath), ...String(process.env.PATH || "").split(path.delimiter)].filter(Boolean);
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, cmd + e);
    try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  return cmd;
}

// P1 · server 端(有真 projectRoot + config)解析要接给 worker 的 ACP McpServer[]:门控 = .opc/config.json 的
// acpMcp(true/"all"=全量 enabled / string[]=白名单 id / 缺省=关);把 mcp_servers.json 里 enabled 的 stdio 服务器
// 映射成 ACP McpServerStdio(command 解析成绝对路径,env 转 {name,value}[])。治"worker projectRoot=隔离沙盒、
// 读不到真 mcp_servers.json"根因——由本函数解析后 seed 进沙盒 acp_mcp.json 供 worker 读。出错返回 [](退回 curl 兜底)。
function resolveAcpMcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  try {
    const root = getProjectRoot();
    let gate: null | "all" | Set<string> = null;
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(root, ".opc", "config.json"), "utf-8"));
      if (cfg.acpMcp === true || cfg.acpMcp === "all") gate = "all";
      else if (Array.isArray(cfg.acpMcp) && cfg.acpMcp.length) gate = new Set(cfg.acpMcp.map(String));
    } catch { /* 无 config → 关 */ }
    if (!gate) return [];
    const allow = gate === "all" ? null : gate;
    return listMcpServers(root)
      .filter((s: any) => s && s.enabled !== false && (s.transport ?? "stdio") === "stdio" && s.command && (!allow || allow.has(s.id) || allow.has(s.name)))
      .map((s: any) => ({
        name: String(s.name || s.id),
        command: resolveMcpExe(String(s.command)),
        args: Array.isArray(s.args) ? s.args.map(String) : [],
        env: Object.entries(s.env || {}).map(([name, value]) => ({ name, value: String(value) })),
      }));
  } catch { return []; }
}

export type AcpWorkerEngineId = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

// framework → ACP 引擎 id 映射。首发两家与 apps/cli 的 ACP engineRegistry(ACP_ENGINE_IDS)一致。
// 其余 framework(hermes/genericCli/…)不走 ACP-worker 路径 → 返回 null。
export function mapFrameworkToAcpEngine(framework: AgentFramework | undefined): AcpWorkerEngineId | null {
  return framework === "claude-code" || framework === "codex" || framework === "gemini-cli" || framework === "kimi-cli" || framework === "grok-build" ? framework : null;
}

// ACP-worker 路径开关。**默认开**(定稿 2.2:订阅=真走自研 worker CLI 经 ACP,已活体验证):未设置该 env
// 即启用;逃生门 OPC_ACP_WORKER=0/false 显式关回 legacy CLI-spawn;其它值(含 1/true/空串)一律走 ACP。
// 交付文本闭环(已落地):apps/cli 的 worker CLI 在 run 收尾把累积的 assistant 文本(agent_message_chunk)
// 写进隔离 run 目录的 report.md,并加性透传进 result.json.content;本后端 readDeliverableContent 按
// content → report.md 优先级读回 → 真实 worker 运行也能拿到交付内容;空输出如实空串(不造假)。
// ACP spawn/握手失败仍自动降级 legacy(见 runFallback),legacy 路径一直捕获 content,不受影响。
export function acpWorkerEnabled(): boolean {
  const v = process.env.OPC_ACP_WORKER;
  return v !== "0" && v !== "false"; // 默认开;仅显式 0/false 关
}

// A6b · ACP 硬门槛(严格模式)。**默认关**(OPC_ACP_REQUIRED 未设/非 1/true 即软模式,现网行为不变:ACP
// spawn/握手失败照常保底降级 legacy CLI)。置 1/true 后进严格模式:任何本该降级的触发点都**不再调用**
// opts.fallback(),而是诚实失败(status=failed),走既有 failed→重试/deferred 链路。仅供验收/CI 用——
// 现网订阅节点若缺 git-bash 等会大面积 defer,误配代价高,文档须写清。
export function acpRequired(): boolean {
  const v = process.env.OPC_ACP_REQUIRED;
  return v === "1" || v === "true";
}

export interface AcpWorkerSpawnInput {
  isolatedRoot: string;
  taskFile: string;
  engineId: AcpWorkerEngineId;
  runId: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  parentRunId: string;
  parentTaskId: string;
  agentId: string;
  credentialLeaseRef?: string;
}
export interface AcpWorkerSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: string; // ENOENT 等 spawn 本身失败
  timedOut?: boolean;
  aborted?: boolean;
  launch?: WorkerLaunchMetadata;
}
export type AcpWorkerSpawnFn = (input: AcpWorkerSpawnInput) => Promise<AcpWorkerSpawnResult>;

export interface RunViaAcpWorkerOptions {
  /** ACP 路径不可用时可选的、已审计 legacy CLI-spawn 路径。没有实现时必须诚实失败。 */
  fallback?: () => Promise<ExecResult>;
  /** 仅供单测注入:替换 spawn(默认 spawn npx tsx apps/cli/src/worker.ts)。 */
  spawnWorker?: AcpWorkerSpawnFn;
  /** 仅供单测注入:直接指定隔离 root(默认 os.tmpdir 下 mkdtemp;注入时不自动清理,由测试自理)。 */
  workerRootOverride?: string;
}

const STDERR_TAIL_MAX = 800;

// spawn worker 的 env:继承 server env,但删掉 CLAUDECODE(探针 #4 + IRON RULE)并剥除订阅禁忌 key
// (探针 #5)。绝不注入任何 *_API_KEY——认证靠 worker 内 ~/.claude / ~/.codex 订阅登录态。
function buildWorkerEnv(
  node: AgentNodeConfig,
  projectRoot: string | undefined,
  framework: AgentFramework,
  scope: { runId: string; taskId: string; agentId: string },
): { env: NodeJS.ProcessEnv; credentialLeaseRef?: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The ACP worker uses an ephemeral Runtime Contract root seeded with JSON files,
  // not a migrated business SQLite database. Force the child to read that contract;
  // otherwise the default SQLite backend opens an empty DB and resolves 0 agents.
  env.OPC_STORAGE_BACKEND = "json";
  delete env.CLAUDECODE;
  for (const name of Object.keys(env)) {
    if (/(_API_KEY|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET|_PASSWORD)$|^(GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|AWS_|AZURE_)/i.test(name)) delete env[name];
  }

  // GLM Coding Plan is a Claude Code authentication backend, not a separate ACP engine. Resolve the
  // selected registered account by its isolated config directory and inject the token only into this
  // child process. It is never written to the worker task, events, or the public account DTO.
  if (framework === "claude-code" && node?.cliConfigDir && projectRoot) {
    try {
      const selected = loadAccounts(projectRoot).find((account) =>
        account.cliBackend === "glm-coding-plan"
        && !!account.configDir
        && path.resolve(account.configDir) === path.resolve(node.cliConfigDir!),
      );
      if (selected?.apiKey) {
        env.ANTHROPIC_BASE_URL = selected.baseUrl || "https://api.z.ai/api/anthropic";
        const lease = issueCredentialLease({
          ...scope,
          environmentName: "ANTHROPIC_AUTH_TOKEN",
          secret: selected.apiKey,
        });
        return { env, credentialLeaseRef: lease.ref };
      }
    } catch { /* account lookup failure falls back to the normal Claude subscription login */ }
  }
  return { env };
}

// best-effort 按 PID 树杀子进程(worker 会起孙进程:tsx→node→ACP adapter→app-server)。win32 taskkill /T。
function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  } catch { /* best-effort */ }
}

// 默认真 spawn:node <tsx cli.mjs> worker.ts run --task <f> --executor acp --engine <id> --project-root <root>。
// shell:true 清零(令五.5):不再 spawn("npx",…,{shell:true})——那条路在 Windows 上把整条命令交给 cmd.exe
// 解析(npx.cmd shim),既有 argv 拼接不转义(DEP0190)风险,又需要 shell。改由 buildCliWorkerLaunch 解析出
// node.exe 绝对路径 + tsx cli.mjs 绝对路径 + worker 入口绝对路径,spawn shell:false + 参数数组直起进程。
// 解析失败(缺 tsx / worker 入口)→ 显式 spawnError,绝不静默回退 shell:true(交由上层 runFallback 按软/严
// 格模式处置)。带硬超时兜底,超时按 PID 树杀 + 标 timedOut,交给上层降级。
const defaultWorkerSpawn: AcpWorkerSpawnFn = (input) =>
  new Promise<AcpWorkerSpawnResult>((resolve) => {
    let launch: { file: string; args: string[] };
    try {
      launch = buildCliWorkerLaunch(import.meta.url, [
        "run", "--task", input.taskFile, "--executor", "acp",
        "--engine", input.engineId, "--project-root", input.isolatedRoot,
      ]);
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: "", spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    const launchEnv = buildCliWorkerEnv(input.env, launch.file);
    if (input.credentialLeaseRef) {
      let credential: { environmentName: string; secret: string };
      try {
        credential = consumeCredentialLease(input.credentialLeaseRef, {
          runId: input.parentRunId,
          taskId: input.parentTaskId,
          agentId: input.agentId,
        });
      } catch (e) {
        resolve({ code: null, stdout: "", stderr: "", spawnError: e instanceof Error ? e.message : String(e) });
        return;
      }
      launchEnv[credential.environmentName] = credential.secret;
    }
    const launchMetadata = captureWorkerLaunchMetadata({ file: launch.file, args: launch.args, env: launchEnv, cwd: input.cwd });
    const child = spawn(
      launch.file,
      launch.args,
      { cwd: input.cwd, env: launchEnv, stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32" },
    );
    let stdout = "", stderr = "", settled = false;
    const done = (r: AcpWorkerSpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.abortSignal?.removeEventListener("abort", onAbort);
      resolve({ ...r, launch: launchMetadata });
    };
    const onAbort = () => { killTree(child.pid); done({ code: null, stdout, stderr, aborted: true }); };
    const timer = setTimeout(() => { killTree(child.pid); done({ code: null, stdout, stderr, timedOut: true }); }, input.timeoutMs);
    if (input.abortSignal?.aborted) onAbort();
    else input.abortSignal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (b: Buffer) => { stdout += b.toString("utf-8"); });
    child.stderr?.on("data", (b: Buffer) => { stderr += b.toString("utf-8"); });
    child.on("error", (e) => done({ code: null, stdout, stderr, spawnError: e instanceof Error ? e.message : String(e) }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

interface ResultJson {
  status?: string;
  totalTokens?: number;
  totalCostUsd?: number;
  agents?: Array<{ agentId: string; tokens?: number; costUsd?: number }>;
  content?: string; // 加性字段:worker CLI(acpWorkerRunner)已透传累积 assistant 交付文本;缺省则走 report.md 兜底
}
interface EvidenceEvent { type?: string; agentId?: string; payload?: Record<string, unknown> }

function readJsonSafe<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")) as T; } catch { return null; }
}
function readEvidenceEvents(runDir: string): EvidenceEvent[] {
  try {
    return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8").trim().split("\n")
      .filter(Boolean).map((l) => { try { return JSON.parse(l) as EvidenceEvent; } catch { return {}; } });
  } catch { return []; }
}

// 从隔离 run 目录的证据里读回交付内容。worker CLI(acpWorkerRunner)已把累积 assistant 文本落进
// result.json.content(加性字段)与 report.md,故按 result.json.content → report.md → "" 优先级读回;
// 内容缺失(空输出/老证据)不影响 tokens/cost/status 入账。
function readDeliverableContent(runDir: string, result: ResultJson | null): string {
  if (result && typeof result.content === "string" && result.content) return result.content;
  try { const md = fs.readFileSync(path.join(runDir, "report.md"), "utf-8"); if (md.trim()) return md; } catch { /* none */ }
  return "";
}

/**
 * 经自研 worker CLI 的 ACP 路径执行一次外部订阅引擎调用;失败自动降级到 opts.fallback()。
 * 返回的 ExecResult 带 executor 证据字段;绝不据引擎自称成功——status 只反映"ACP 会话是否跑通"。
 */
export async function runViaAcpWorker(
  framework: AgentFramework,
  node: AgentNodeConfig,
  task: ExecTask,
  ctx: ExecContext,
  opts: RunViaAcpWorkerOptions,
): Promise<ExecResult> {
  const engineId = mapFrameworkToAcpEngine(framework);
  const t0 = Date.now();
  if (!engineId) return runFallback(node, ctx, opts, `framework ${framework} 非 ACP 引擎`, "acp-worker: 非 ACP 引擎");

  const createdRoot = !opts.workerRootOverride;
  let isolatedRoot = "";
  try {
    isolatedRoot = opts.workerRootOverride ?? fs.mkdtempSync(path.join(os.tmpdir(), "opc-acp-worker-"));
    fs.mkdirSync(path.join(isolatedRoot, ".opc"), { recursive: true });
    // P0-3 · Verifier Snapshot 播种:仅 verifier 且非注入 root 时,把 ctx.workdir(verifier worktree,刚从
    // HEAD 建、index==HEAD)的已跟踪产物拷进隔离快照,让 verifier 看到 producer 已 merge 的实现再跑真实测试。
    // producer 路径不 seed(空快照,行为逐字节不变)。播种失败 → cleanup + 保底降级。checkout-index 只吐已跟踪
    // 文件 → 天然排除 .opc/tester 临时产物,快照绝不 merge 回公司 worktree(下方 fileChanges 恒 []+整树 rmSync)。
    if (ctx.isVerifier && !opts.workerRootOverride) {
      if (!seedSnapshotFromWorktree(ctx.workdir, isolatedRoot)) {
        cleanup(createdRoot, isolatedRoot);
        return runFallback(node, ctx, opts, "Verifier Snapshot 播种失败", "acp-worker: 快照播种失败");
      }
    }
    // 隔离名册:只放当前 agent(worker 按 agentId 精确解析);写进隔离根 → worker 绝不碰正式 .opc 库。
    fs.writeFileSync(path.join(isolatedRoot, ".opc", "agents.json"), JSON.stringify([node], null, 2), "utf-8");
    // P1 · MCP 接线:worker projectRoot=隔离沙盒读不到真 mcp_servers.json。由 server 端解析好要接给本 worker 的
    // McpServer[](门控 config.acpMcp)写进沙盒 acp_mcp.json,worker 读它透传给 session/new,真正拿到 ddg-search/fetch 等 MCP 工具。
    try {
      const acpMcp = resolveAcpMcpServers();
      if (acpMcp.length) fs.writeFileSync(path.join(isolatedRoot, ".opc", "acp_mcp.json"), JSON.stringify(acpMcp), "utf-8");
    } catch { /* MCP 接线 best-effort,失败退回 curl 兜底 */ }
  } catch (e) {
    // anti-pollution(对抗审查):mkdtemp 成功但后续(mkdir/seed/写 agents.json)抛错时,快照 tmpdir 会泄漏在
    // os.tmpdir——补 cleanup(createdRoot=false/注入 root 时 cleanup 自会跳过;isolatedRoot="" 即 mkdtemp 本身
    // 抛错,无可删)。不违反任何隔离约束,仅补齐这条降级出口的磁盘卫生。
    if (isolatedRoot) cleanup(createdRoot, isolatedRoot);
    return runFallback(node, ctx, opts, e instanceof Error ? e.message : String(e), "acp-worker: 隔离工作目录创建失败");
  }

  const runId = randomUUID();
  const runDir = path.join(isolatedRoot, ".opc", "runs", runId);
  // 折进 server 已组装好的 systemPrompt(角色 prompt + 记忆/技能注入)+ goal(已含 inbox),让全部上下文
  // 随 goal 到达模型(worker 会再前置一遍角色 prompt,轻微重复但不丢注入)。
  const foldedGoal = task.systemPrompt ? `${task.systemPrompt}\n\n${task.goal}` : task.goal;
  const taskFile = path.join(isolatedRoot, "task.request.json");
  try {
    fs.writeFileSync(taskFile, JSON.stringify({
      taskId: task.taskId,
      goal: foldedGoal,
      agentId: node.id,
      ...(node.companyId ? { companyId: node.companyId } : {}),
      ...(task.maxTokens ? { maxTokens: task.maxTokens } : {}),
      runId,
    }, null, 2), "utf-8");
  } catch (e) {
    cleanup(createdRoot, isolatedRoot);
    return runFallback(node, ctx, opts, e instanceof Error ? e.message : String(e), "acp-worker: task 请求文件写入失败");
  }

  // G1 · producer 交付回收基线:worker 跑前快照隔离根的交付文件(rel→sha256),供事后算 create/modify/delete delta。
  // 真实 producer(非 override)先把 ctx.workdir 的【可播种(排除敏感)】交付文件有界播种进隔离根(让 coder 看见代码库、
  // 能改/删既有文件);播种后的快照即基线。项目超界(>MAX_RECOVERY_FILES)→ **不静默在空目录假装工作**,而是 capability_blocked
  // (project_too_large)诚实拒绝。override(单测)不播种,基线=测试预置的隔离根内容。verifier 不参与(产出只作证据)。
  let producerBaseline = new Map<string, string>();
  if (!ctx.isVerifier) {
    if (!opts.workerRootOverride) {
      let seedRes = { tooLarge: false };
      try { seedRes = seedDeliverablesToRoot(ctx.workdir, isolatedRoot); } catch { /* 播种整体异常→基线空,退化只回收新建 */ }
      if (seedRes.tooLarge) {
        cleanup(createdRoot, isolatedRoot);
        const reason = `project_too_large:工作区可播种文件数超上限(>${MAX_RECOVERY_FILES}),ACP 隔离无法承载 producer 上下文 → capability_blocked(不在空目录假装工作)`;
        ctx.emit("info", node.id, { kind: "capability_blocked", capability: "acp_seed", reason: "project_too_large", message: `⛔ ${reason}` });
        return { content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: Date.now() - t0, status: "restricted", error: reason };
      }
    }
    producerBaseline = snapshotDeliverables(isolatedRoot) ?? new Map();
  }

  const timeoutMs = ctx.taskTimeoutMs ?? 300_000;
  const spawnWorker = opts.spawnWorker ?? defaultWorkerSpawn;
  const workerEnv = buildWorkerEnv(node, ctx.projectRoot, framework, { runId: ctx.runId, taskId: task.taskId, agentId: node.id });
  let spawnRes: AcpWorkerSpawnResult;
  try {
    spawnRes = await spawnWorker({
      isolatedRoot,
      taskFile,
      engineId,
      runId,
      env: workerEnv.env,
      cwd: isolatedRoot,
      timeoutMs,
      abortSignal: ctx.abortSignal,
      parentRunId: ctx.runId,
      parentTaskId: task.taskId,
      agentId: node.id,
      credentialLeaseRef: workerEnv.credentialLeaseRef,
    });
  } catch (e) {
    cleanup(createdRoot, isolatedRoot);
    return runFallback(node, ctx, opts, e instanceof Error ? e.message : String(e), "acp-worker: spawn 抛错");
  } finally {
    revokeCredentialLease(workerEnv.credentialLeaseRef);
  }

  // ── 降级判定:spawn 失败 / 超时 / 无 result.json / result.json.status=failed(worker 内 AcpTransportError) ──
  const launchReceipt = await buildWorkerLaunchReceipt(node, task, ctx, spawnRes.launch);
  emitWorkerLaunchReceipt(ctx, node, launchReceipt);
  const stderrTail = (spawnRes.stderr || "").slice(-STDERR_TAIL_MAX);
  if (spawnRes.aborted) {
    cleanup(createdRoot, isolatedRoot);
    const reason = "acp-worker: execution cancelled";
    return { content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: Date.now() - t0, status: "failed", error: reason, launchReceipt };
  }
  if (spawnRes.spawnError) { cleanup(createdRoot, isolatedRoot); return runFallback(node, ctx, opts, spawnRes.spawnError, "acp-worker: worker 进程起不来"); }
  if (spawnRes.timedOut) {
    cleanup(createdRoot, isolatedRoot);
    const reason = `acp-worker: worker execution timed out after ${timeoutMs}ms`;
    return { content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: Date.now() - t0, status: "failed", error: reason, launchReceipt };
  }

  const result = readJsonSafe<ResultJson>(path.join(runDir, "result.json"));
  if (!result) {
    const reason = `worker 未产出 result.json 证据${stderrTail ? `;stderr: ${stderrTail}` : ""}`;
    cleanup(createdRoot, isolatedRoot);
    return runFallback(node, ctx, opts, reason, "acp-worker: 无证据产出");
  }
  if (result.status === "failed") {
    // worker 内 status=failed ⟺ AcpClient 抛 AcpTransportError(spawn/握手/协议失败)——正是"ACP 握手失败"降级触发点。
    const diag = readJsonSafe<{ engineFailures?: Array<{ message?: string }> }>(path.join(runDir, "diagnostics.json"));
    const reason = diag?.engineFailures?.[0]?.message || `ACP 会话失败${stderrTail ? `;stderr: ${stderrTail}` : ""}`;
    cleanup(createdRoot, isolatedRoot);
    return runFallback(node, ctx, opts, reason, "acp-worker: ACP 握手/传输失败");
  }

  // ── ACP 路径跑通:回放证据事件进真实 run 事件流(executor:"acp")+ 组装 ExecResult ──
  const events = readEvidenceEvents(runDir);
  ctx.emit("info", node.id, { kind: "executor_selected", executor: "acp", engine: engineId, message: `本次由自研 worker 经 ACP(${engineId})执行` });
  replayEvidenceEvents(events, node.id, ctx);

  const mcf = [...events].reverse().find((e) => e.type === "model_call_finished")?.payload ?? {};
  const promptTokens = numOr(mcf.promptTokens, 0);
  const completionTokens = numOr(mcf.completionTokens, 0);
  const total = numOr(mcf.tokens, result.totalTokens ?? (promptTokens + completionTokens));
  const cost = numOr(result.totalCostUsd, numOr(mcf.cost, 0));
  let content = readDeliverableContent(runDir, result);
  const verifierTestResults = [] as ReturnType<typeof runVerifierTestsInSnapshot>;

  // P0-3 · Verifier Snapshot 权威证据:verifier 在隔离快照里跑真实测试(独立于 producer 自测),同步 emit
  // test_evidence(independent:true,source:quality_gate)进真实 run 事件流——落 RunHistory 发生在 verifier 批
  // 的 await 段,远早于 finalize/manifest,不重蹈已修的证据完整性 P0 时序。快照连同 tester 误写/覆盖率/日志随
  // 下方 cleanup 整树 rmSync 删除,绝不进 changes.json、绝不污染公司 worktree。
  if (ctx.isVerifier) {
    const testedCommit = gitHeadCommit(ctx.workdir);
    // P0 · 合同绑定:把本 run 交付合同(ctx.deliveryContractFiles)传进快照测试运行器,只跑属于合同/直接测试
    // 合同源文件的测试,拒跑共享工作目录里历次遗留的无关测试(否则一条无关变更 + 遗留测试通过 = 假成功窗口)。
    // undefined(旧接线未透传)→ 退回非绑定行为(不回归);[](本 run 零变更)→ 无可绑定测试 → 独立门判 missing。
    const snapshotResults = runVerifierTestsInSnapshot(isolatedRoot, ctx.deliveryContractFiles);
    verifierTestResults.push(...snapshotResults.filter((r) => r.ran));
    for (const r of snapshotResults) {
      if (!r.ran) continue;
      ctx.emit("info", node.id, {
        kind: "test_evidence",
        source: "quality_gate",
        testerAgentId: node.id,
        independent: true,
        ...(testedCommit ? { testedCommit } : {}),
        ...(r.testedFile ? { testedFile: r.testedFile } : {}),
        ...(r.testedFileHash ? { testedFileHash: r.testedFileHash } : {}),
        // MUP 波2 · Node 解析链证据透传:测试实际解析加载的快照内非测试文件(path 相对快照根 POSIX +
        // sha256 全量 hex),verified 强判据据此与 ProducerArtifactManifest 交叉;无解析链(python/记录失败)缺省。
        ...(r.resolvedProducerFiles?.length ? { resolvedProducerFiles: r.resolvedProducerFiles } : {}),
        command: r.command,
        cwd: isolatedRoot,
        exitCode: r.exitCode,
        passed: r.passed,
        output: (r.output ?? "").slice(0, 500),
      });
    }
  }
  if (verifierTestResults.length > 0) {
    const failed = verifierTestResults.filter((r) => !r.passed || r.exitCode !== 0);
    const summary = verifierTestResults
      .map((r) => `${r.command} => exit ${r.exitCode}${r.passed ? " (passed)" : " (failed)"}`)
      .join("; ");
    content = `${content}\n\n[Core independent verification]\n${summary}\n` +
      (failed.length === 0
        ? "The Core snapshot result is authoritative and supersedes contradictory model self-reporting."
        : "The Core snapshot failed; this verifier result is rejected regardless of model self-reporting.");
  }


  // G1 · producer(非 verifier)ACP 交付回收:自研 worker 在隔离根用原生文件工具写出的交付不在 run 的 worktree
  // (ctx.workdir)里 → 上层 git-diff 看不到 → 误判 no_file_changes。此处基于【隔离前基线】算 create/modify/delete
  // delta,只回收合法交付,fail-closed 应用到 ctx.workdir。任一越界/敏感/配额/复制失败 → 拦截、不落任何变更、诚实
  // 判 no_file_changes(绝不伪造、绝不把密钥/越界文件"交付")。verifier 保持 fileChanges:[](产出只作独立测试证据)。
  let producerFileChanges: ExecResult["fileChanges"] = [];
  if (!ctx.isVerifier) {
    const rec = recoverProducerDelta(isolatedRoot, ctx.workdir, producerBaseline);
    if ("blocked" in rec) {
      ctx.emit("info", node.id, { kind: "producer_recovery_blocked", taskId: task.taskId, reason: rec.blocked, message: `⛔ producer 交付回收拦截(fail-closed,不落任何变更):${rec.blocked}` });
      producerFileChanges = [];
    } else {
      producerFileChanges = rec.fileChanges;
    }
  }
  cleanup(createdRoot, isolatedRoot);
  return {
    content,
    fileChanges: producerFileChanges,
    tokens: { prompt: promptTokens, completion: completionTokens, total },
    cost,
    latencyMs: Date.now() - t0,
    status: verifierTestResults.some((r) => !r.passed || r.exitCode !== 0) ? "failed" : "done",
    executor: "acp",
    launchReceipt,
  };
}

// ── G1 · producer ACP 交付回收(delta + fail-closed)────────────────────────────────────────────────
// 任意层跳过的目录名(.opc 隔离库 / vcs / 依赖,含 nested node_modules);顶层跳过的文件(worker task 请求文件)。
const RECOVERY_SKIP_DIRS = new Set([".opc", ".git", "node_modules"]);
const RECOVERY_SKIP_TOP_FILES = new Set(["task.request.json"]);
// 敏感文件:.env* / 私钥 / .ssh / .git 内部——出现在 delta 里一律 fail-closed(绝不把密钥/凭据"交付"回工作区)。
const SENSITIVE_RE = /(^|\/)\.env($|\.)|(^|\/)\.git(\/|$)|(^|\/)\.ssh(\/|$)|(^|\/)(id_rsa|id_ed25519|id_ecdsa)($|\.)|\.(pem|key|p12|pfx)$/i;
const MAX_RECOVERY_FILES = 500;              // 交付文件数上限(超界=异常规模,保守拒绝/退化)
const MAX_RECOVERY_BYTES = 5 * 1024 * 1024;  // 交付总字节上限,超配额 fail-closed

// 遍历目录内交付文件 rel(POSIX)→sha256。任意层跳过 .opc/.git/node_modules,顶层跳过 task.request.json。
// 返回 null = 遍历/读取异常或超 MAX_RECOVERY_FILES(调用方据此 fail-closed 或退化为空基线)。
function snapshotDeliverables(root: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let aborted = false;
  const walk = (dir: string, rel: string) => {
    if (aborted) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { aborted = true; return; }
    for (const e of entries) {
      if (aborted) return;
      if (RECOVERY_SKIP_DIRS.has(e.name)) continue;                 // 任意层跳过 .opc/.git/node_modules
      if (!rel && RECOVERY_SKIP_TOP_FILES.has(e.name)) continue;
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, relPath); continue; }
      if (!e.isFile()) continue;                                    // 符号链接等非普通文件不回收
      if (out.size >= MAX_RECOVERY_FILES) { aborted = true; return; }
      try { out.set(relPath, createHash("sha256").update(fs.readFileSync(abs)).digest("hex")); }
      catch { aborted = true; return; }
    }
  };
  walk(root, "");
  return aborted ? null : out;
}

// 列出 workdir 可播种的交付文件(相对 POSIX)。**默认不泄密**:优先 git-tracked(git ls-files,天然排除 .gitignore 的
// .env/密钥),非 git 退回文件遍历;两条都再排除 .opc/.git/node_modules(nested)与【敏感文件】(.env/.ssh/私钥/.pem——
// 绝不进隔离根,防外部 worker(claude-code/codex)读到密钥)。返回 { files, tooLarge }:文件数超上限 → tooLarge=true
// (调用方 capability_blocked,绝不在空目录假装工作)。
function listSeedableFiles(workdir: string): { files: string[]; tooLarge: boolean } {
  let rels: string[] | null = null;
  try {
    // -c(tracked) + -o(untracked/others) + --exclude-standard(尊重 .gitignore)= tracked + 未被忽略的未跟踪源文件。
    // 【关键】只用 -c 会漏掉"刚建、未提交、也没 .gitignore"的新源文件 → producer 在不完整代码库上工作(审计 P1)。
    const r = spawnSync("git", ["-C", workdir, "ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (r.status === 0 && typeof r.stdout === "string") rels = [...new Set(r.stdout.split("\0").filter(Boolean))];
  } catch { /* 非 git / git 不可用 → 退回文件遍历 */ }
  if (rels === null) {
    const snap = snapshotDeliverables(workdir);
    if (!snap) return { files: [], tooLarge: true }; // 超界/异常 → tooLarge
    rels = [...snap.keys()];
  }
  const seedable = rels.filter((rel) => {
    if (SENSITIVE_RE.test(rel)) return false;                                          // P0:敏感文件绝不进隔离根
    if (rel.split(/[\\/]/).some((seg) => RECOVERY_SKIP_DIRS.has(seg))) return false;   // .opc/.git/node_modules(任意层)
    return true;
  });
  if (seedable.length > MAX_RECOVERY_FILES) return { files: [], tooLarge: true };
  return { files: seedable, tooLarge: false };
}

// 有界播种:把 workdir 的【可播种】交付文件拷进隔离根,让 producer 看见代码库(能改/删既有文件)。敏感文件已在
// listSeedableFiles 排除(绝不进隔离根)。项目超界 → 返回 tooLarge=true(调用方 capability_blocked,不静默降级)。
function seedDeliverablesToRoot(workdir: string, isolatedRoot: string): { tooLarge: boolean } {
  const { files, tooLarge } = listSeedableFiles(workdir);
  if (tooLarge) return { tooLarge: true };
  for (const rel of files) {
    try {
      const src = path.join(workdir, rel);
      if (!fs.statSync(src).isFile()) continue;
      const dest = path.join(isolatedRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    } catch { /* best-effort per-file;个别播种失败只影响该文件基线,不影响安全 */ }
  }
  return { tooLarge: false };
}

function safeAfter(buf: Buffer): string | undefined {
  try { return buf.toString("utf-8").slice(0, 20000); } catch { return undefined; }
}

// 算 create/modify/delete delta(final vs 基线)并【fail-closed】应用到 workdir:任一越界/敏感/配额/读写失败 →
// 不落任何变更、返回 {blocked}(保守拒绝,绝不部分伪装成功)。返回 FileChange[](含 changeType/after)。
export function recoverProducerDelta(isolatedRoot: string, workdir: string, baseline: Map<string, string>):
  { fileChanges: FileChange[] } | { blocked: string } {
  const final = snapshotDeliverables(isolatedRoot);
  if (!final) return { blocked: "隔离根交付快照失败或超规模上限" };
  const workRoot = path.resolve(workdir);
  const insideWork = (rel: string): boolean => {
    const dest = path.resolve(workdir, rel);
    return dest !== workRoot && dest.startsWith(workRoot + path.sep);
  };
  type Delta = { rel: string; type: "create" | "modify" | "delete" };
  const deltas: Delta[] = [];
  for (const [rel, hash] of final) {
    const base = baseline.get(rel);
    if (base === undefined) deltas.push({ rel, type: "create" });
    else if (base !== hash) deltas.push({ rel, type: "modify" });
  }
  for (const rel of baseline.keys()) if (!final.has(rel)) deltas.push({ rel, type: "delete" });
  if (deltas.length === 0) return { fileChanges: [] };
  // 校验(fail-closed):越界 / 敏感 / 配额。任一命中 → 整体拒绝,不落任何变更。
  let bytes = 0;
  for (const d of deltas) {
    if (!insideWork(d.rel)) return { blocked: `路径越界:${d.rel}` };
    if (SENSITIVE_RE.test(d.rel)) return { blocked: `敏感文件:${d.rel}` };
    if (d.type !== "delete") {
      try { bytes += fs.statSync(path.join(isolatedRoot, d.rel)).size; }
      catch { return { blocked: `读取交付文件失败:${d.rel}` }; }
    }
  }
  if (bytes > MAX_RECOVERY_BYTES) return { blocked: `交付超配额 ${bytes}B > ${MAX_RECOVERY_BYTES}B` };
  // 应用:先把所有 create/modify 内容读进内存(任一读失败即 blocked)。
  const writes: Array<{ dest: string; buf: Buffer; rel: string; type: "create" | "modify" }> = [];
  const deletes: Array<{ dest: string; rel: string }> = [];
  for (const d of deltas) {
    const dest = path.join(workdir, d.rel);
    if (d.type === "delete") { deletes.push({ dest, rel: d.rel }); continue; }
    try { writes.push({ dest, buf: fs.readFileSync(path.join(isolatedRoot, d.rel)), rel: d.rel, type: d.type }); }
    catch { return { blocked: `读取交付文件失败:${d.rel}` }; }
  }
  // 先建所有父目录(任一失败即 blocked,尚未写任何文件);父路径是文件这类冲突在此暴露。
  try { for (const w of writes) fs.mkdirSync(path.dirname(w.dest), { recursive: true }); }
  catch (e) { return { blocked: `准备交付目录失败:${e instanceof Error ? e.message : String(e)}` }; }
  // 【真原子事务】:逐个应用前先备份被覆盖/删除的原文件;任一步失败 → 完整回滚(撤新建 / 还原改与删)→ blocked。
  // 删除前读失败(非 ENOENT)或真删失败(权限等)一律【抛→回滚】,绝不吞、绝不把失败当"已不存在"报成功。
  type Applied = { rel: string; dest: string; kind: "create" | "modify" | "delete"; after?: string; backup?: Buffer };
  const applied: Applied[] = [];
  const rollback = () => {
    for (const a of [...applied].reverse()) {
      try {
        if (a.kind === "create") fs.rmSync(a.dest, { force: true });   // 撤销新建
        else fs.writeFileSync(a.dest, a.backup!);                       // modify/delete 还原旧内容
      } catch { /* 尽力回滚,单点还原失败不影响其余 */ }
    }
  };
  try {
    for (const w of writes) {
      const existed = fs.existsSync(w.dest);
      const backup = existed ? fs.readFileSync(w.dest) : undefined;
      fs.writeFileSync(w.dest, w.buf);
      applied.push({ rel: w.rel, dest: w.dest, kind: existed ? "modify" : "create", after: safeAfter(w.buf), backup });
    }
    for (const del of deletes) {
      let backup: Buffer | undefined;
      try { backup = fs.readFileSync(del.dest); }
      catch (e: any) { if (e?.code !== "ENOENT") throw e; }  // 删除前读失败(非不存在)→ 抛 → 回滚
      if (backup === undefined) continue;                    // workdir 本就无该文件 → 无删可做,不报 phantom delete
      fs.rmSync(del.dest);                                   // force:false → 真删失败(权限等)抛 → 回滚(绝不吞)
      applied.push({ rel: del.rel, dest: del.dest, kind: "delete", backup });
    }
  } catch (e) {
    rollback();
    return { blocked: `应用交付失败(已完整回滚,workdir 无残留):${e instanceof Error ? e.message : String(e)}` };
  }
  // fileChanges 严格来自【真正应用成功】的 op(delete 只报确实删掉的),不虚报。
  const fileChanges: FileChange[] = applied.map((a) =>
    a.kind === "delete"
      ? ({ path: a.rel, changeType: "delete" } as FileChange)
      : ({ path: a.rel, changeType: a.kind, after: a.after } as FileChange));
  return { fileChanges };
}

function numOr(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

// 只回放"引擎证据"类事件进真实 run 流;run 生命周期事件(run_started/finished/model_call_started/
// agent_status_changed)归 orchestrator/workerRuntime,不在此重复发。model_call_finished 补 executor 戳。
const REPLAY_TYPES = new Set(["tool_call", "tool_result", "model_call_finished", "error", "info"]);

// CRITICAL-2 修复(对抗验证 CONFIRMED):worker 子进程的 events.jsonl 是【不可信输入】——ACP 引擎(claude-code/
// codex)在 cwd=isolatedRoot 用其原生文件工具(不经 pathGuard)可追加写 .opc/runs/<id>/events.jsonl。若逐字回放
// 其 info{kind:test_evidence},worker 就能自报 resolvedProducerFiles/independent:true 伪造 verified,击穿"测试进程/
// worker 无权自报强证据"不变式。故回放的 test_evidence 一律【剥离强证据+独立性字段】并降为非权威:独立/强证据只认
// Core 在父进程内 runVerifierTestsInSnapshot 直接 ctx.emit 的那一条(下方 ctx.isVerifier 分支),绝不采信任何回放的证据。
export function sanitizeReplayedPayload(type: string, payload: Record<string, any>): Record<string, any> {
  if (type !== "info" || payload?.kind !== "test_evidence") return payload;
  const { resolvedProducerFiles: _rpf, independent: _ind, testerAgentId: _tid, testedCommit: _tc, ...rest } = payload;
  return { ...rest, independent: false, source: "worker_selfreport" };
}

function replayEvidenceEvents(events: EvidenceEvent[], fallbackAgentId: string, ctx: ExecContext): void {
  for (const ev of events) {
    if (!ev.type || !REPLAY_TYPES.has(ev.type)) continue;
    const agentId = ev.agentId ?? fallbackAgentId;
    const payload = sanitizeReplayedPayload(ev.type, ev.payload ?? {});
    if (ev.type === "model_call_finished") ctx.emit(ev.type, agentId, { ...payload, executor: "acp" });
    else ctx.emit(ev.type, agentId, payload);
  }
}

function cleanup(createdRoot: boolean, root: string): void {
  if (!createdRoot) return; // 注入的 root 由测试自理,不删
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// runViaAcpWorker 内所有降级触发点(非 ACP 引擎 / 隔离目录创建失败 / task 写入失败 / spawn 抛错 /
// spawnError / 超时 / 无 result.json / result.json.status=failed)统一收口经此函数——它是唯一的守门口。
// 软模式(默认):emit executor_selected(legacy_cli + degradedReason)并调 opts.fallback() 保底降级。
// 严格模式(acpRequired()):**不调** opts.fallback()、emit error、返回 status=failed(什么都没执行成,
// executor 字段缺省)——走既有 failed→重试/deferred 诚实链路,绝不虚标降级为成功。
async function runFallback(
  node: AgentNodeConfig,
  ctx: ExecContext,
  opts: RunViaAcpWorkerOptions,
  degradedReason: string,
  label: string,
): Promise<ExecResult> {
  if (acpRequired()) {
    const error = `ACP硬门槛:${degradedReason}(OPC_ACP_REQUIRED=1,不降级)`;
    ctx.emit("error", node.id, { message: `${label} → ${error}` });
    return {
      content: "", fileChanges: [],
      tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: 0,
      status: "failed", error,
    };
  }
  if (!opts.fallback) {
    const error = `ACP执行失败:${degradedReason}(该引擎没有经过审计的 legacy 回退路径)`;
    ctx.emit("error", node.id, { message: `${label} → ${error}` });
    return {
      content: "", fileChanges: [],
      tokens: { prompt: 0, completion: 0, total: 0 }, cost: null, latencyMs: 0,
      status: "failed", error,
    };
  }
  ctx.emit("info", node.id, {
    kind: "executor_selected",
    executor: "legacy_cli" as EngineExecutor,
    degradedReason,
    message: `${label} → 降级到 legacy CLI 路径(${degradedReason})`,
  });
  const res = await opts.fallback();
  return { ...res, executor: "legacy_cli", degradedReason };
}
