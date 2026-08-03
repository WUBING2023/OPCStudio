import type { AgentNodeConfig, AgentFramework } from "./types.js";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface FileChange {
  path: string;                 // 相对 projectRoot
  changeType: "create" | "modify" | "delete";
  before?: string;
  after?: string;
}

export type EffectiveNetworkAccess = "denied" | "restricted" | "unrestricted";
export type EffectiveSandboxBackend =
  | "opc-tool-guard"
  | "codex-workspace-write"
  | "provider-native"
  | "none";

export interface EffectiveCapabilityManifest {
  schemaVersion: "1";
  runId: string;
  taskId: string;
  agentId: string;
    companyId: string;
    framework: AgentFramework;
    generatedAt: string;
    expiresAt: string;
  requested: {
    fileWrite: boolean;
    shell: "none" | "allowlist" | "full";
    network: "off" | "limited" | "on";
  };
  effective: {
    fileRoots: Array<{ path: string; read: boolean; write: boolean }>;
    shell: "none" | "allowlist" | "full" | "workspace-sandbox" | "full-host";
    network: EffectiveNetworkAccess;
    sandboxBackend: EffectiveSandboxBackend;
    fullHostAccess: boolean;
    approvalMode: "not-required" | "run-governance";
    credentialScope: "none" | "provider-call" | "subscription-profile";
    environmentNames: string[];
    mcpSpecs: Array<{
      id: string;
      transport: "stdio" | "http";
      endpointIdentity: string;
      argsHash?: string;
      environmentNames: string[];
    }>;
  };
  unsupportedConstraints: string[];
  manifestHash: string;
}

export interface WorkerLaunchReceipt {
  schemaVersion: "1";
  runId: string;
  taskId: string;
  agentId: string;
  attempt: number;
  launchedAt: string;
  launchKind: "in-process" | "subprocess";
  executable?: { path: string; sha256?: string; version?: string };
  argvHash: string;
  environmentNames: string[];
  cwd: string;
  sandboxBackend: EffectiveSandboxBackend;
  fullHostAccess: boolean;
    approvalMode: "not-required" | "run-governance";
    capabilityManifestHash: string;
    mcpSpecsHash: string;
    completeness: "partial" | "complete";
}

export interface ExecTask {
  taskId: string;               // 子任务唯一 id（卡住预算/deferred 追踪）
  goal: string;
  systemPrompt: string;
  maxTokens: number;
  // AgentStatus 11 态:引擎调用在飞期间该 agent 的状态。缺省 "thinking"(普通执行);
  // 审查类调用(交叉验证 verifier / lead 评审轮)传 "reviewing"——状态来自真实调用分支,不是装饰。
  statusWhileRunning?: "thinking" | "reviewing";
}

export interface ExecContext {
  runId: string;
  projectRoot: string;
  workdir: string;              // 本任务实际工作目录（Phase1 == projectRoot；Phase3 = worktree）
  emit: (type: string, agentId: string | undefined, payload: unknown) => void;
  budget: { maxTokensPerTask: number };
  workspaceQuotaBytes?: number; // P6 真隔离:worker 工作区磁盘配额(字节);超出则物理 kill 子进程。仅 noCode/受限角色设置。
  taskTimeoutMs?: number;       // 该 worker 任务的硬时限(按角色解析)。引擎应在此之前自行收尾(如 hermes 子进程取 timeout-宽限),让"杀死+抢救 stdout"发生在数据所在的层。
  // API Key 模式(非订阅登录)CLI 账号的解析结果,只存在于这一次调用的 ExecContext 里,绝不写回
  // AgentNodeConfig/agents.json,也绝不进 emit() 事件流(防泄漏)。codex:orchestrator 每次执行前按
  // node.cliConfigDir 现查 accounts.json 现算并塞进这里——auth 仍靠 configDir 里手动 `codex login
  // --with-api-key` 持久化的登录态,引擎不用这个字段做认证,只用它把"这次执行按 API Key 计费"的信号
  // 带给成本核算(不再假定 $0)。claude-code(2026-07 简化后):不再依赖 orchestrator 预填这个字段——
  // ClaudeCodeEngine 自己按 node.claudeCodeUseApiKey + node.cliConfigDir 现查现算(见 ClaudeCodeEngine.ts
  // /apiKeyAccount.ts),非空时把结果当 ANTHROPIC_API_KEY 注入子进程 env(每次调用可切换,无需登录态)。
  apiKeyOverride?: string;
  // 多账号自动切换(hermes/API 框架):accountPool 这次租到的具体账号(providerId + 该账号自己的 apiKey),
  // 由 parallelExecutor 在 acquire lease 后塞入(仅非 CLI 框架——claude-code/codex 已有专属的
  // apiKeyOverride 解析路径,见上,不重复接线)。HermesEngine 消费前必须核对 providerId 与当前实际要跑的
  // node.provider 一致才套用——限流冷却路由(rateLimitCooldown.ts)可能在这之后把 execAgent.provider 换成
  // 别的供应商,那时这把(为原 provider 租到的)key 就不再适用,必须诚实跳过、退回该(新)provider 的
  // 环境变量/引擎自身凭据解析,而不是把 A 供应商的 key 错灌进 B 供应商的认证里。只活在这一次调用里,绝不
  // 写回 agents.json,也绝不进 emit() 事件流。
  leasedAccount?: { providerId: string; apiKey: string };
  // 验证批任务标记(P0-3 verifier)。引擎据此仅为 verifier 建 Verifier Snapshot 并 seed 自 ctx.workdir
  // (verifier worktree 刚从 HEAD 建、index==HEAD),让快照能看到 producer 已 merge 的产物再跑真实测试;
  // 缺省 false=producer,走原隔离临时目录(空快照),行为逐字节不变。
  isVerifier?: boolean;
  // P0 · 本 run 交付合同的变更文件相对路径(POSIX,来自 orchestrator 累积的 allChanges + 本批 producer 变更)。
  // verifier 快照据此把独立测试证据【绑定到本 run 产物】:只跑属于合同(或直接测试合同文件)的测试,拒跑共享
  // 工作目录里历次遗留的无关测试(否则一条无关变更 + 遗留测试通过就会被误判为本任务完成)。undefined=未绑定
  // (旧行为/非快照路径),[]=有合同但本 run 零变更 → verifier 无可绑定测试可跑(诚实退回 missing_independent)。
  deliveryContractFiles?: string[];
  /** Immutable, secret-free snapshot of the permissions actually enforceable for this launch. */
  capabilityManifest?: EffectiveCapabilityManifest;
  /** Shared cancellation signal used by scheduler/engines during timeout, kill and shutdown drain. */
  abortSignal?: AbortSignal;
}

export type ExecStatus = "done" | "failed" | "restricted";

// 定稿 2.2(A6a 三值化):执行节点实际走的执行通道。
//   "acp"        —— 自研 worker CLI 经 ACP 协议执行(外部订阅引擎 claude-code/codex 的首选路径)。
//   "legacy_cli" —— 既有 CLI-spawn 路径:ACP spawn/握手失败自动降级(带 degradedReason,UI 标"降级模式"),
//                   或 OPC_ACP_WORKER 显式关闭的逃生门(不带 degradedReason,非降级)。
//   "api"        —— OPC 自建 in-process ApiEngine(apiToolLoop 直连供应商 API,无子进程)。
// 缺省(GenericCli / 未接 executor 语义的路径)不带此字段——不是所有 run 都有 executor 语义。
export type EngineExecutor = "acp" | "legacy_cli" | "api" | "native";

export interface ExecResult {
  content: string;
  toolCalls?: ToolCall[];
  fileChanges: FileChange[];
  tokens: { prompt: number; completion: number; total: number };
  cost: number | null; // null = 订阅制引擎,非 $0
  latencyMs: number;
  status: ExecStatus;
  error?: string;
  partial?: boolean;   // ⏱️ 超时抢救:worker 达到时限被终止,content 是截断前抢救回的部分产出(可用但可能不完整)
  // 定稿 2.2(A6a):本次执行实际走的通道——ACP worker("acp")/ CLI-spawn("legacy_cli",降级或显式
  // 关闭 ACP)/ OPC 自建 in-process ApiEngine("api")。纯加性、只作证据/展示信号——不参与成功判定
  // (success 仍归 Core 验证链)。
  executor?: EngineExecutor;
  // executor==="legacy_cli" 且属**降级**(ACP spawn/握手失败)时的原因摘要,供 UI"降级模式"徽章 title
  // 与诊断;OPC_ACP_WORKER 显式关闭的逃生门路径不带此字段(非降级,不进 executorFallbacks)。
  degradedReason?: string;
  // MUP Gate A#2(矩阵8)· 本次执行由 mock provider 模拟:加性证据信号,不参与成功判定;
  // run 级聚合另走 model_call_finished 事件,此字段供引擎结果直读(mock 短路的 done/failed 兜底都标)。
  simulated?: true;
  /** Structured native-host failure; never inferred from human-readable model output. */
  nativeFailureKind?: import("./nativeExecutionContract.js").NativeExecutionFailureKind;
  launchReceipt?: WorkerLaunchReceipt;
}

// Availability of an execution framework: whether its CLI/daemon is installed and logged in.
// Drives the FrameworkSelector badges (green=ready / gray=not installed / yellow=not logged in)
// and lets the router refuse to run on an unready framework (restricted, never faked).
export interface EngineAvailability {
  framework: AgentFramework;
  installed: boolean;
  loggedIn: boolean;
  version: string;
  detail?: string; // why not ready / guidance
}

export interface ExecutionEngine {
  readonly framework: AgentFramework;
  run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult>;
  probe(): Promise<EngineAvailability>;
}

// 显式不可用错误：触发 restricted 黑灯（替代静默 mock）
export class ProviderUnavailableError extends Error {
  constructor(public readonly provider: string, reason: string) {
    super(`Provider unavailable: ${provider} — ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

export class FrameworkUnavailableError extends Error {
  constructor(public readonly framework: AgentFramework, reason: string) {
    super(`Framework unavailable: ${framework} — ${reason}`);
    this.name = "FrameworkUnavailableError";
  }
}
