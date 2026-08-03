// B1 · Runtime Contract:每次 run 结束后额外写出的标准化证据文件 schema。
// 四件套:result.json(标准化结果)/ diagnostics.json(诊断)/ tool_calls.jsonl(工具调用流水)/
// worker.config.json(执行配置快照)。消费方(Track A 验收、Track C 展示、外部工具)只依赖
// 这里的类型,不依赖 orchestrator 内部结构。字段全部来自现有真实可得数据,不虚构。

export const RUNTIME_CONTRACT_SCHEMA_VERSION = "1" as const;

// ── result.json ───────────────────────────────────────────────────────────────

export interface RunResultAgentSummary {
  agentId: string;
  role: string;
  framework: string;
  status: string;       // run 结束时该 agent 的最终状态(idle/failed/restricted/…)
  tokens: number;       // 该 agent 本 run 的 token 总量(从 callRecords 汇总)
  costUsd: number | null;      // 该 agent 本 run 的估算成本(null = 订阅制);从 callRecords 汇总
  // A6a · 该 agent 本 run 实际走的执行通道("acp" | "legacy_cli" | "api"),从 executor_selected 事件
  // 派生(last-wins;含 degradedReason 的 legacy_cli 粘滞)。无事件(老 run/崩溃路径)缺省,不虚构。
  executor?: string;
  // 该 agent 发生过 ACP→legacy CLI **降级**执行(executor_selected 带 degradedReason)。
  // 显式关闭 ACP 的逃生门(legacy_cli 无 degradedReason)不算降级,不设此字段。
  executorDegraded?: true;
  // MUP Gate A#2 · 该 agent 本 run 至少一次 mock provider 调用(CallRecord/ExecResult.simulated 透传)。
  // 加性字段:老 run 缺省 = 非 simulated,不虚构。
  simulated?: true;
}

export interface RunResultArtifactSummary {
  id: string;
  producedBy: string;
  kind: string;         // "file-change" | "report" | "text"
  type: string;         // "code-diff" | "design-doc" | ...
  name: string;
  summary?: string;
}

export interface RunResultDeferredSummary {
  taskId: string;
  agentId: string;
  reason: string;
  attempts: number;
}

// A8 · 单次真实测试执行证据(战役B EvidenceManifest.tests 的唯一数据源)。语义铁律:只记 worker
// 在其 workdir 真实执行过的命令——零推断,绝不从 OPC Studio 仓库自身推断产品测试;无真实执行则
// result.json 整个 testEvidence 字段缺省。source 两来源:
// - "quality_gate":parallelExecutor 质量门后 emit 的 info{kind:"test_evidence"} 事件(权威,含 cwd/exitCode);
// - "tool":runTests LLM 工具的 tool_call/tool_result 配对解析(首行机器头;头缺失的老格式降精度
//   记 command:"runTests(auto)",exitCode/cwd 缺省)。
export interface RunTestEvidence {
  at: string;
  agentId?: string;
  command: string;
  cwd?: string;
  exitCode?: number;
  passed: boolean;
  output?: string;      // 截断后的测试输出(≤500 字)
  source: "quality_gate" | "tool";
  // P0-3 独立验证:执行该测试的 agent id(通常等于 agentId,快照权威证据里显式带出);deriveTestEvidence 透传。
  testerAgentId?: string;
  // 该条证据是否为**独立验证**(verifier 在 Verifier Snapshot 里跑,与 producer 自测隔离)。快照证据显式 true;
  // 缺省时由 DeliveryAcceptance 靠 agentId∈verifierAgentIds 兜底判独立。全 optional,老证据/老 run 缺此字段兼容。
  independent?: boolean;
  // 被测代码的 git commit(verifier 快照 seed 自 ctx.workdir 的 HEAD);非 git 时缺省。
  testedCommit?: string;
  // P0 · 交付合同绑定:该测试实际执行的测试文件(相对工作根,POSIX)+ 其快照内容 hash。verifier 快照只跑
  // 绑定到本 run 交付合同的测试,这两字段把「这条独立证据来自哪个测试文件、测的是哪份字节」钉死可审计,
  // 杜绝把共享工作目录里遗留的无关测试通过当作本任务完成。非绑定路径(旧证据/框架整套跑)缺省。
  testedFile?: string;
  testedFileHash?: string;
  // MUP 波2 · Node 模块解析链证据:该测试执行时**实际解析加载**的、位于快照根内的非测试文件。
  // path=相对快照根 POSIX;hash=文件内容 sha256 全量小写 hex(64 位,与 ProducerArtifactManifest 同算法)。
  // verified 强判据据此与 producer manifest 交叉比对(∃条目 path∈manifest 且 hash 一致)。
  // 非 node 族(python 等)/记录失败/runShell 文本头通道无解析链 → 字段缺省(诚实,不虚构)。
  resolvedProducerFiles?: Array<{ path: string; hash: string }>;
}

export interface RunResultContract {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION;
  runId: string;
  status: "pending" | "running" | "failed" | "done";
  startedAt: string;
  endedAt?: string;
  agents: RunResultAgentSummary[];
  artifacts: RunResultArtifactSummary[];
  deferred: RunResultDeferredSummary[];
  totalTokens: number;
  totalCostUsd: number | null; // null = 订阅制引擎,非 $0
  degraded?: boolean;
  degradedReason?: string;
  // A6b · ACP 硬门槛:本 run 至少一次 ACP→legacy CLI 降级执行(run.executorDegraded 透传)。降级 run 仍是
  // done(合法保底),但 result.json 如实带出此标记——不虚标纯净成功;无降级则字段缺省(与老 run 不可区分是有意的)。
  executorDegraded?: boolean;
  // B5c:run 级重试计数,从 events 流已有信号派生(来源见 apps/server runtimeContract.ts 的 deriveRetryCount 注释);
  // 无可用信号(如崩溃路径没走到事件派生)时缺省,不虚构为 0。
  retryCount?: number;
  // A8:真实测试执行证据清单(deriveTestEvidence 从事件流派生;LIST_CAP 封顶)。
  // 无任何真实测试执行 → 字段缺省(不写空数组占位,与"没提供 events 的老 run"不可区分是有意的:两者都是"无证据")。
  testEvidence?: RunTestEvidence[];
  // MUP Gate A#2 · 本 run 含 mock provider 调用(矩阵8:mock run 永远显示 simulated)。加性字段,
  // status 四态冻结不动;老 run 无此字段 = 非 simulated(安全降级)。true 时该 run 的"成功"是模拟的:
  // 消费点(A2A resolve / memory commit / 复用加分 / 公司知识)必须以此短路,账本/用量分列不混真实口径。
  simulated?: true;
  // MUP 波1 · run 终态单一收敛(deriveFinalRunState):status 四态冻结不动,用户可见真相走此加性字段;
  // 老 run 缺省(消费端安全降级到 status+degraded 旧口径)。
  finalState?: "verified" | "tests_passed" | "degraded" | "failed" | "requires_review";
  // D2 · 本 run 含超时抢救 partial 产物:文本保留为部分结果,但绝不纯净 done(finalState 至少 degraded)。
  partialDelivery?: true;
  // MUP 波2 · 交付验收结论透传(orchestrator 收尾把 DeliveryAcceptance 结果置入 Run.deliveryAcceptance,
  // buildRunResultContract 如实带出)。加性字段:老 run/未走验收门缺省,不虚构。
  // status 语义(DeliveryAcceptanceStatus):仅 "verified" 与非编码 "not_required" 算已验证交付
  // (isDeliveryVerified=true);其余(含收口令五.3 的 "tests_ran_unbound"——测试已运行但无运行时解析链
  // 强绑定证据,python 等非 Node 族封顶于此)一律【非】已验证,消费方绝不当作成功。
  deliveryAcceptance?: { status: string; reasons?: string[] };
}

// ── diagnostics.json ──────────────────────────────────────────────────────────
// 全部从现有事件流(error / rate_limited / deliverable_degraded / module_stuck)派生。

export interface RunDiagnosticsFailure {
  at: string;
  agentId?: string;
  message: string;
}

export interface RunDiagnosticsFallback {
  at: string;
  agentId?: string;
  from: string;         // 原引擎 key(framework/provider/model)
  to: string;           // 顶上的备用引擎 key
  reason?: string;
}

export interface RunDiagnosticsRateLimit {
  at: string;
  agentId?: string;
  model: string;        // 被限流的引擎 key
  rateLimitedUntil?: string;
  reason?: string;
}

export interface RunDiagnosticsPermissionBlock {
  at: string;
  agentId?: string;
  message: string;      // framework policy / role profile 拦截原因(error 事件 restricted:true)
}

export interface RunDiagnosticsExecutorFallback {
  at: string;
  agentId?: string;
  from: string;         // 降级前执行通道(目前恒为 "acp")
  to: string;           // 降级后执行通道(目前恒为 "legacy_cli")
  reason: string;
}

export type WorkerStartupFailureClassification =
  | 'transport'
  | 'trust_prompt'
  | 'tool_permission'
  | 'prompt_acceptance_timeout'
  | 'prompt_misdelivery'
  | 'provider_unavailable'
  | 'configuration'
  | 'worker_crash';

export interface WorkerStartupDiagnostic {
  at: string;
  runId: string;
  agentId: string;
  taskId: string;
  attempt: number;
  framework: string;
  phase: 'launch' | 'handshake' | 'prompt';
  classification: WorkerStartupFailureClassification;
  message: string;
  suggestedAction: string;
  activityObserved: false;
}

export interface RunDiagnostics {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION;
  runId: string;
  engineFailures: RunDiagnosticsFailure[];
  providerFallbacks: RunDiagnosticsFallback[];
  rateLimitHits: RunDiagnosticsRateLimit[];
  permissionBlocks: RunDiagnosticsPermissionBlock[];
  notes: string[];
  // B5 · 证据链(可选加性字段,老文件/崩溃路径缺省):
  /** 本 run 各 agent 注入的 Memory Pack packHash(去重;从 memory_pack_used 事件派生,无则缺省) */
  memoryPackHashes?: string[];
  /** executor 降级(ACP → legacy CLI;从 executor_selected+degradedReason 事件派生,无降级则缺省) */
  executorFallbacks?: RunDiagnosticsExecutorFallback[];
  /** MCP 能力版本摘要(serverId → version+descriptorHash;无 MCP 配置时为空对象) */
  mcpCapabilityVersions?: Record<string, string>;
  /** Worker 尚未产生模型/工具活动时的结构化启动失败；与普通执行失败分开诊断。 */
  workerStartupFailures?: WorkerStartupDiagnostic[];
}

// ── tool_calls.jsonl(每行一条) ─────────────────────────────────────────────────

export interface ToolCallRecord {
  ts: string;           // tool_call 事件时间戳
  agentId?: string;
  tool: string;
  argsSummary: string;  // JSON.stringify(args) 截断;不含完整大参数
  ok: boolean;          // 配对到的 tool_result 以 error 开头 → false;无失败信号 → true
  durationMs?: number;  // 配对到同 agent 的下一条 tool_result 时才有
}

// ── worker.config.json ────────────────────────────────────────────────────────

export interface WorkerConfigAgentEntry {
  agentId: string;
  name: string;
  role: string;
  framework: string;
  provider: string;
  model: string;
}

export interface WorkerConfigSnapshot {
  schemaVersion: typeof RUNTIME_CONTRACT_SCHEMA_VERSION;
  runId: string;
  companyId?: string;
  teamMode?: string;    // "economy" | "balanced" | "maxQuality"(未选则缺省)
  runType?: string;     // "quick" | "team"
  agents: WorkerConfigAgentEntry[]; // 本 run 加载的公司 agent 名册(实际参与者见 result.json)
  createdAt: string;
}

export const RUNTIME_TASK_CONTRACT_VERSION = '1' as const;

export interface RuntimeTaskContract {
  schemaVersion: typeof RUNTIME_TASK_CONTRACT_VERSION;
  runId: string;
  revision: number;
  contractHash: string;
  createdAt: string;
  updatedAt: string;
  objective: string;
  scope: {
    companyId?: string;
    missionId?: string;
    taskGraphId?: string;
    runType: string;
    teamMode?: string;
  };
  workspace: {
    workRoot: string;
    baseCommit?: string;
    isolation: 'git-worktree' | 'none';
  };
  acceptance: {
    requiresCode: boolean;
    requiresTests: boolean;
    forbidsCode: boolean;
    expectedArtifacts: string[];
    requiresIndependentVerification: boolean;
  };
  resources: {
    maxTokens?: number;
    maxRetries?: number;
    deadlineMs?: number;
  };
  permissions: {
    fileAccess: 'workspace';
    networkAccess: 'guarded';
    shellAccess: 'role-policy';
    mcpAccess: 'registered-only';
  };
  reporting: {
    resultFile: 'result.json';
    diagnosticsFile: 'diagnostics.json';
    changesFile: 'changes.json';
    evidenceManifestFile: 'evidence-manifest.json';
  };
  escalation: {
    failClosedOnMissingCapability: true;
    failClosedOnMissingVerifier: boolean;
  };
  recovery: {
    preservePartialArtifacts: true;
    allowResume: boolean;
  };
  verification: {
    producerManifestRequired: boolean;
    testEvidenceRequired: boolean;
    artifactHashRequired: boolean;
  };
}
