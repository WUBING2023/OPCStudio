import type { FileChange } from "./engine.js"; // A2A Artifact 复用 FileChange(import type,无运行时循环)
import type { BundleMemoryRecord, BundleAgentMemory } from "./companyBundle.schema.js"; // D5:CompanyTemplate.seedMemories 复用 Bundle 的记忆记录形状(import type,无运行时循环——companyBundle.schema.ts 反向 import type 本文件的 AgentNodeConfig 属同款安全的双向 type-only 引用);① agentMemories 复用 Bundle 的员工记忆形状

// E 里程碑(7月6日重构)· AgentStatus 7→11 态:旧 7 态语义不变,新 4 态是"working 窗口内"的更细粒度,
// 且每个新态都有真实代码分支 emit(铁律:动画可以精彩,但不能假——严禁前端模拟/装饰性 emit):
//   thinking       模型/引擎调用在飞(workerRuntime.runEngineCore 引擎调用前设置)
//   using_tool     工具执行中(orchestrator 按引擎发出的 tool_call/tool_result 真事件推进)
//   reviewing      审查节点执行中(交叉验证 verifier / lead 评审轮的评审调用,经 ExecTask.statusWhileRunning)
//   waiting_review 产出等待审查(交叉验证期间的 producer / lead 评审轮等待裁决的 worker)
export type AgentStatus =
  | "idle"
  | "working"
  | "waiting"
  | "disabled"
  | "failed"
  | "done"
  | "restricted"
  | "thinking"
  | "using_tool"
  | "reviewing"
  | "waiting_review";

// "正在干活"的状态子集(working 及其细粒度新态)。前端动画(节点脉冲/飞线)与"工作中人数"统计共用,
// 保证新态不把既有"working 才亮"的动画/统计断掉。
export const BUSY_AGENT_STATUSES: readonly AgentStatus[] = ["working", "thinking", "using_tool", "reviewing"];
export function isBusyAgentStatus(status: string | undefined): boolean {
  return BUSY_AGENT_STATUSES.includes(status as AgentStatus);
}

// Execution backend per node. API 模式(非 Claude/GPT 订阅)= "api":OPC 内部 in-process tool-loop
// 引擎(apps/server/runtime/engines/ApiEngine.ts),Claude→claude-code、GPT→codex。
// "hermes" 是历史执行器的遗留 id,作为**读侧永久 alias**保留:契约冻结 fixture(__fixtures__/*.json)
// 与存量 .opc/agents.json 不改写,schema 读到 "hermes" 即归一为 "api"(schemas.ts preprocess),
// 写侧(新建/导出)只出 "api"。绝不从此联合类型删除 "hermes"——删了旧数据/旧 bundle 直接非法。
// 2026-07 扩展(12+1 CLI 框架):新增 9 个通过 GenericCliEngine(见 apps/server/runtime/engines/
// GenericCliEngine.ts + genericCliPresets.ts)驱动的第三方 agentic CLI 预设(gemini-cli/qwen-code/
// opencode/aider/goose/openhands/amp/plandex/open-interpreter),外加 "generic-cli" 本身(同一引擎的
// "裸"配置——用户在节点设置里自填 command/参数模板,见 AgentNodeConfig.genericCli)。这批新框架均为
// API Key 认证(非订阅登录),风险/局限见各 preset 注释:opencode 稳定性较弱(已知 JSON 流可能不完整/
// 退出码不可信)、plandex 首次使用需手动 `plandex sign-in`、open-interpreter 会真实执行本机代码且 CLI
// 接口未完全确认(尽力而为的保守实现)。
export type AgentFramework =
  | "api" | "hermes" | "claude-code" | "codex"
  | "gemini-cli" | "kimi-cli" | "grok-build"
  | "qwen-code" | "opencode" | "aider" | "goose" | "openhands"
  | "amp" | "plandex" | "open-interpreter" | "generic-cli";

// 订阅执行推理档位(用户可调,四档:低/中/高/超高)。纯加性可选——只对支持的订阅引擎生效:
// codex 经 CODEX_CONFIG.model_reasoning_effort 在建会话时注入(low/medium/high/xhigh 一一对应,codex 原生的
// minimal 档不对外暴露);claude-code / gemini / API(hermes)面不支持该档,忽略之(UI 如实标注)。
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

// A2A: agent 能力自描述(Google A2A Agent Card + FIPA DF 黄页语义的内存版)。喂 discover_agents 选人。
export interface AgentSkillDesc {
  id: string;
  name: string;
  description: string;
  inputModes?: string[];
  outputModes?: string[];
}
export interface AgentCapabilityCard {
  summary: string;          // 一句话"我能干什么"
  skills: AgentSkillDesc[];
  produces?: string[];      // 能产出的 artifact 类型标签
  consumes?: string[];      // 能消费/能回答的问询类型
  acceptsQuery?: boolean;   // 是否可被 ask(默认 true)
  tools?: string[];         // 实际可用工具子集(默认全局 ALL_TOOLS)
}

// C5 · 员工成长(与记忆生命周期强绑定,见 storage/agentGrowthStore.ts):level/xp 由 XP 事件驱动
// (memory proposal 批准 / 经验被引用 / 升级 SOP / 审查退回),不是任务数统计。全部可选,旧 agents.json
// 无此字段时前端按 "Lv.1 0XP" 展示(不虚构历史)。successRate/specialties 当前只透传保留旧值,
// 本批未接入自动计算(见 agentGrowthStore.ts 顶部注释)。
export interface AgentGrowth {
  level: number;
  xp: number;
  successRate?: number;      // 0-1,预留字段(本批不自动计算,见 agentGrowthStore.ts)
  specialties?: string[];    // 预留字段(本批不自动计算)
  weaknesses?: string[];     // 最近踩坑(review 否决/需返工 的原因摘要),最新在前
  recentLessons?: string[];  // 该员工提出且被批准的反思教训(reflection_lesson 提案 content),最新在前
}

export interface AgentNodeConfig {
  id: string;
  name: string;
  role: string;
  parentId?: string;
  childrenIds: string[];
  model: string;
  provider: string;
  framework?: AgentFramework;
  cliConfigDir?: string; // claude-code/codex: per-node CLI config/credentials dir (Phase 3 account pool)
  // claude-code 简化(2026-07):显式选择"用 Anthropic API Key(而非订阅登录)"执行 claude-code。只是
  // 一个开关——不再需要一个专属 configDir 绑定的"Claude Code API Key 账号",生效时直接复用任意一个
  // providerId==="anthropic" 且持有 apiKey 的账号(哪怕是 Hermes 在用的那个),见 engines/apiKeyAccount.ts。
  // 必须显式为 true 才生效,默认(未设置/false)保持订阅登录路径不变——避免静默把免费订阅切成按量计费。
  claudeCodeUseApiKey?: boolean;
  // generic-cli 框架专属(仅 framework==="generic-cli" 时生效):用户自填的"裸"CLI 配置——GenericCliEngine
  // 没有内置 preset 时用它现拼一份 GenericCliConfig。args 里的元素若含字面量 "{{PROMPT}}" 会被替换成实际
  // prompt 文本;若没有任何元素含这个占位符,prompt 会作为最后一个参数追加。9 个具名预设(gemini-cli 等)
  // 不读这个字段,它们的 command/args 固定编译在 genericCliPresets.ts 里。
  genericCli?: { command: string; args: string[]; authEnvVar?: string };
  companyId?: string;    // v2: which company this agent belongs to (default "default")
  // V0 · 声明式可移植配置字段,**尚未接入 worker 执行路径**(不决定任何 run 的实际工作目录——run 的真实
  // 工作根是公司 workRoot activeWorkRoot + 每 worker 的 git worktree,见 parallelExecutor.createWorktree)。
  // 保留它仅为:①CompanyBundle 可移植字段登记(sensitive/local-path,导出脱敏、导入 reroot 清空);
  // ②未来"员工个人工作目录"能力的占位。**V0 不承诺其生效**——真要做员工级目录需在 parallelExecutor 接线。
  workspaceDir?: string;
  // MUP Gate A#4 · 员工级相对工作子目录(可移植设计字段,区别于上面的本机绝对路径 workspaceDir):
  // 相对公司 workRoot/worker worktree 的 POSIX 相对路径("apps/web")。runtime 生效点在
  // parallelExecutor(ctx.workdir = worktreeRoot/workingDirectory,resolveSafe 校验 + 不存在则 mkdir);
  // 写入前用 validateAgentWorkingDirectory 校验(非绝对路径、normalize 后不得以 .. 逃逸)。
  // verifier 不生效(必须以 worktree 根为视野验证合同);git/fileChanges/testedFile 口径仍相对 worktree 根。
  workingDirectory?: string;
  uiPosition?: { x: number; y: number } | null; // v2: manual drag position (else default radial layout); null = "自动排列"清空回默认布局
  visibilityPolicy?: VisibilityPolicy; // v2: on a lead, overrides the company policy for its team
  status: AgentStatus;
  currentTask?: string;
  tokenUsage: { prompt: number; completion: number; total: number };
  costUsd?: number | null; // null = 订阅制引擎(Codex/Claude ACP),非 $0
  lastAction?: string;
  editable: boolean;
  deletable: boolean;
  enabled: boolean;
  card?: AgentCapabilityCard; // A2A: 能力自描述(发现/选人);缺省由 orchestrator 合成降级卡
  // C8 · 一等公民 systemPrompt(MUP Gate C#8 组织模型清单要求 prompt 成为 canonical 字段):
  // 可选、加性——设置后 dispatch 用它作为 worker 执行 systemPrompt 的基底(替代硬编码 ROLE_PROMPTS[role]),
  // 未设置则保持 getRolePrompt(role) 兜底。可移植设计字段(随导出/导入往返),写侧不含本机信息。
  // ROLE_PROMPTS 的格式指令段(## PLAN / dispatch 行等机器解析契约)由 dispatch 处在基底之后仍拼接,
  // 不因自定义 systemPrompt 而丢失——见 prompts.ts composeSystemPrompt。
  systemPrompt?: string;
  growth?: AgentGrowth; // C5: 员工成长(见上方 AgentGrowth 注释)
  // 订阅执行推理档位(可选,纯加性):low|medium|high|xhigh。仅对支持的订阅引擎(当前 codex)生效——建会话时
  // 经 CODEX_CONFIG.model_reasoning_effort 注入;claude-code/gemini/API 面忽略。未设置=保留引擎默认(对话链默认
  // low、任务链保留引擎深推理默认)。见 apps/cli/src/acp/engineRegistry.buildEngineSpec。
  reasoningEffort?: ReasoningEffort;
  /** Optional execution adapter preference. Missing means the existing ACP/API route. */
  nativeExecution?: import("./nativeExecutionContract.js").NativeExecutionPreference;
}

// MUP Gate A#4 · AgentNodeConfig.workingDirectory 校验(server 写侧/runtime/web 表单共用同一口径):
// 必须是相对 POSIX 路径——拒绝绝对路径(/x、C:\x、\\server\x),normalize(消 "."/".." 段)后不得
// 以 .. 逃逸;反斜杠输入归一为正斜杠。纯字符串逻辑(无 node:path 依赖,web 可直接用)。
// ok=true 时 normalized 为规范化后的 POSIX 相对路径(非空);空输入/等价于根("."、"a/..")→ 拒绝
// (等价于根就该留空不设,不接受歧义值)。
export function validateAgentWorkingDirectory(raw: string):
  { ok: true; normalized: string } | { ok: false; code: "empty" | "absolute" | "escape" | "root"; error: string } {
  const input = (raw ?? "").trim();
  if (!input) return { ok: false, code: "empty", error: "workingDirectory 不能为空(不设置请留空)" };
  const posix = input.replace(/\\/g, "/");
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix) || posix.startsWith("//")) {
    return { ok: false, code: "absolute", error: "workingDirectory 必须是相对路径(不允许绝对路径/盘符)" };
  }
  const parts: string[] = [];
  for (const seg of posix.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return { ok: false, code: "escape", error: "workingDirectory 不允许以 .. 逃逸出工作区" };
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) return { ok: false, code: "root", error: "workingDirectory 等价于工作区根目录——不设置请留空" };
  return { ok: true, normalized: parts.join("/") };
}

// v2: a company = one CEO + its tree, optionally bound to a workspace folder. Multiple companies
// live in one studio; the org view shows one at a time (top company switcher).
export interface Company {
  id: string;
  name: string;
  description: string;
  folder?: string;       // bound workspace folder (absolute); else default .opc-studio/<slug>
  ceoId?: string;        // root CEO agent id of this company
  visibilityPolicy?: VisibilityPolicy; // default message-visibility rule for this company's teams
  createdAt: string;
  // Stage 5:从 manifest 安装时保留的作者标注元数据(手动建的公司则 undefined)。
  // 能力边界报告第③段「本团队不适用」**只**读这两个字段,绝不运行时自我推断。
  manifestTemplateId?: string;
  manifestUseCases?: string[];
  manifestRiskNotes?: string[];
  manifestToolRequirements?: {
    requiredEngines: string[];
    requiredProviders: string[];
    requiredMcpServers: string[];
    requiredSkills: string[];
    optionalTools: string[];
  };
  workflow?: WorkflowConfig;  // Stage 6:交叉验证链(install 时从 template.workflow 保留)。
  // Stage 8+:从 template.mcpRequirements 保留(供能力边界报告交叉核对本机 MCP 配置;install 时也据此算 missing 清单返回前端)。
  manifestMcpRequirements?: McpRequirementSpec[];
  // Stage 8+:template.a2aChannels 换算成真实 agent id 后落盘(见 runtime/install.ts 的 resolveTemplateAgentRef),
  // orchestrator 起 run 时读它自动 grant 常驻通道(见 orchestrator.ts startRun)。运行时 channel 本身只在 run 内存在
  // (无持久通道概念),这是"每次开场重新 grant"的落盘依据,不是长期通道状态本身。
  presetChannels?: A2AChannelSpec[];
  // 记忆导出开关:导出/备份该公司时是否也导出其记忆相关内容。可选,缺省(未设置)按 true 处理——
  // 不设置不改变现有行为(companyToTemplate 目前本就不导出记忆,这个开关是给后续记忆导出功能预留的地基)。
  memoryExportEnabled?: boolean;
  maxTokensTotal?: number; // company-scoped lifetime token ceiling; 0/undefined means unlimited
  // P0-B③:安装模板时保留的示例任务(作者手填的 defaultTasks 持久落点)。此前 defaultTasks 只在导出侧
  // 从"成功完结 run"临时采集,导入后不落公司 → 作者手填的示例任务导入即丢、再导出也不在。这里落成公司
  // 持久字段:导入写入、导出优先读它(再并上历史成功 run 采集的),做到"导入后再导出仍在"。可选、加性。
  defaultTasks?: Array<{ title: string; goal: string; suggestedRole?: string }>;
  // 公司级建议配置只描述可移植执行偏好；不包含密钥或本机路径。
  recommendedConfig?: {
    defaultModel?: string;
    // Legacy bundle compatibility only. The product uses token limits, but old bundles
    // must round-trip without silently changing their shape.
    budget?: {
      totalUsd: number;
      maxTokensPerTask: number;
      maxAttemptsPerTask?: number;
      taskTimeoutMs?: number;
      maxTokensPerRun?: number;
      maxTokensTotal?: number;
    };
    maxTokensPerTask?: number;
    permissions?: { allowShell: boolean; allowFileWrite: boolean; allowWebAccess: boolean };
  };
  requiredPermissions?: {
    allowShell?: boolean;
    allowFileWrite?: boolean;
    allowWebAccess?: boolean;
    mcpServers?: string[];
  };
  /** Company default; an agent-level value overrides it. Native adapters remain feature-gated. */
  nativeExecution?: import("./nativeExecutionContract.js").NativeExecutionPreference;
}

// Stage 5 · 能力边界报告(执行前 Capability Scan → Boundary Report → 用户确认 → 执行)。
export interface CapabilityReportItem {
  kind: "provider" | "cli" | "mcp" | "skill";
  name: string;
  detail?: string;
}
export interface CapabilityNeedsAuth {
  item: CapabilityReportItem;
  required: boolean;   // true → 缺此项硬阻塞运行(非警告)
  howTo: string;
}
// 第③段:严格来自 manifest 作者标注(source 把 provenance 编码进数据,非注释)。
export interface ManifestBoundaryNote {
  note: string;
  source: "manifest-riskNote" | "manifest-useCase";
}
export interface SuggestedTeamMember {
  agentId: string;
  agentName: string;
  role: string;
  framework: string;
  provider: string;
  readyToRun: boolean;
  blockedReason?: string;
}
// provider 无 API key 但本机已装对应订阅引擎 → 平替执行(不阻塞 canRun,与 globalDoctor/systemModelInvoke 同口径)。
export interface CapabilitySubstitution {
  item: CapabilityReportItem;  // 被平替的 provider(kind:"provider")
  via: string;                 // 平替订阅引擎(如 "claude-code")
  note: string;                // 人话说明(如 "anthropic 无 API key,将走 claude-code 订阅执行")
}
export interface CapabilityReport {
  companyId: string;
  generatedAt: string;
  ready: CapabilityReportItem[];          // ① 已就绪(静态客观事实)
  needsAuth: CapabilityNeedsAuth[];       // ② 需授权(缺 CLI/key/权限,带指引)
  substituted: CapabilitySubstitution[];  // ②′ 无 key 但有订阅可平替(记录但不阻塞 canRun)
  notApplicable: ManifestBoundaryNote[];  // ③ 本团队不适用(仅 manifest 作者标注)
  authorAnnotated: boolean;               // false → 作者未标注不适用场景
  suggestedTeam: SuggestedTeamMember[];
  canRun: boolean;                        // false → 缺 required → 硬拦
  blockedBy: string[];
}

// A3:Run.status 十态——旧四态(pending/running/failed/done)不变,增量补齐任务图/审查场景可能出现的六个值
// (planned/blocked/waiting_review/needs_revision/accepted/cancelled),与 TaskNodeStatus(taskGraph.ts)对齐。
// 目前没有生产者往这六个新值写(orchestrator.ts 的 run.status 写入点未改动,一律仍是旧四态);
// 这里先把类型补齐是为未来任务图节点与其派生 run 状态打通做准备。读 Run.status 的旧代码路径必须对
// 未知值安全降级(switch/白名单走 default 分支,不崩),见各消费点审计:
//   - apps/server/src/runtime/runLifecycle.ts:42 的 !== 比较对任何新值都天然成立,不会抛错
//   - apps/web/src/components/AgentDetailsPanel.tsx:628 的三元表达式对新值落到默认分支(琥珀色)
//   - apps/web/src/components/org/commands.ts 等前端消费点用的是本地 `status: string` 弱类型,非强绑定
export type RunStatus =
  | "pending" | "running" | "failed" | "done"
  | "planned" | "blocked" | "waiting_review" | "needs_revision" | "accepted" | "cancelled";

export interface Run {
  id: string;
  userGoal: string;
  companyId?: string;               // 该 run 所属公司(组织页/任务档案按公司过滤的地基;旧 run 无此字段=归入"全部")
  workRoot?: string;                // 该 run 的持久工作根(公司工作区绝对路径),起跑时确立、不可变。产物下载/diff/approve 的权威解析源;历史 run 无此字段=回退事件文本推断,再无=null(绝不兜底 projectRoot)
  baseCommit?: string;              // P0 · run 级基线:起跑时 workRoot 的 HEAD sha。本 run 交付合同的 git-truthful 边界(base→HEAD diff = 本 run 真实改动),区分前序遗留产物;非 git/无 commit=缺省
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  totalTokens: number;
  totalCostUsd?: number | null; // null = 订阅制引擎,非 $0
  participatingAgents: string[];
  reportMdPath?: string;
  reportHtmlPath?: string;
  worktreeDir?: string;                    // this run's isolated git worktree (Phase 3)
  deferredTasks?: DeferredTask[];          // stuck tasks summarized at run end
  accountUsage?: Record<string, number>;   // accountId -> times leased (trace/observability)
  degraded?: boolean;                      // ③: synthesis fell back (coordinator overload/unavailable) → output is NOT a valid synthesized deliverable, must not be scored as success
  degradedReason?: string;                 // human-readable cause of the degradation
  evidenceIntegrity?: "ok" | "degraded";   // A6/终验:关键证据(result.json/changes/artifact registry/report/账本)写盘失败 → "degraded",run 不得纯净成功
  legacyReclassified?: boolean;            // 启动期历史数据重分类打标:输出为失败文本/内容乱码却 status 成功的旧 run,由 legacyRunReclassify 补 degraded 时置真(纯标注,status 不变)
  // A6b · ACP 硬门槛:本 run 至少发生过一次 ACP→legacy CLI **降级**执行(executor_selected 带 degradedReason)。
  // 刻意**不复用** run.degraded ——orchestrator 的 `run.status = run.degraded ? "failed" : "done"` 会把合法保底降级
  // 整体误杀成 failed;这是独立的加性标注:降级 run 仍是 done,但不虚标纯净成功(allClean=false + result.json 带出)。
  executorDegraded?: boolean;
  // D4 · A2A resolved 闭环审计:本 run 收尾时统计「必需闭环集」(delegate_task/revision_request/
  // artifact_handoff 且有显式 to)的 resolved/未 resolved。加性可选,历史 run 无此字段=不判定(向后兼容)。
  // unresolvedIds 截断(≤20)防膨胀;required===0(旧 run/纯广播)时不代表未闭环。
  a2aClosure?: { required: number; resolved: number; unresolvedIds: string[] };
  // P0 · DeliveryAcceptance:交付验收的唯一最终门槛(deliveryAcceptance.ts evaluateDeliveryAcceptance)。
  // 编码任务的文件必须真实落 workRoot + 有真 fileChanges +(要求测试则)TestEvidence exit0,否则非 verified。
  // run.status / A2A resolved / final report / memory auto-commit 全部只消费 verified(或研究型的 not_required)。
  // 波2 冻结接口 · 加性 partialDelivery:验收结论本身携带"含部分产物"标记(与 Run.partialDelivery 同源,
  // orchestrator 收尾置入;result.json 经 buildRunResultContract 透传)。旧 run 缺省=无标记。
  deliveryAcceptance?: { status: string; requiresCode: boolean; requiresTests: boolean; reasons: string[]; partialDelivery?: true };
  // ── MUP Gate A · 加性终态收敛(status 四态与 RunResultContract 冻结不动,新语义全走以下 optional 字段;
  // 旧 run 缺省 = 安全降级,消费方按无字段处理)──
  // run-end 唯一收敛出口 deriveFinalRunState(deliveryAcceptance.ts)的输出。
  // 优先级:requires_review > failed > degraded > tests_passed/verified。simulated run 永不通过。
  // 选1(降级·07-14):独立测试通过的编码交付收敛为 tests_passed(诚实=独立测试通过,不声称"验证了 producer 逻辑");
  // verified 保留供旧 run/非编码 not_required 兼容(执行观测 verified 已退役,新编码 run 不再产 verified)。
  finalState?: "verified" | "tests_passed" | "degraded" | "failed" | "requires_review";
  // Gate A#2 · 本 run 含 mock/simulated 模型调用:引擎层 status 可仍 done(E2E 冒烟),但永不形成
  // 真实成功/记忆/复用/公司知识正向效应,finalState 至少 degraded。
  simulated?: true;
  // D2 · 含超时抢救的 partial 产物:文本保留为部分结果,但 run 绝不纯净 done(finalState 至少 degraded)。
  partialDelivery?: true;
  // D3 · 起跑时绑定 git 工作树有未提交改动(只读检测,不拒跑;全链绝不自动 add -A / 自动提交用户文件)。
  dirtyWorkspaceAtStart?: true;
  // 五.2(收口作战令)· 脏树预检结果(加性,仅绑定工作目录生成;managed 沙箱豁免不设)。编码团队任务遇脏树
  // 会在起跑前干净失败(不创建 run);此字段记录"proceed 了但起跑时工作目录是脏的"(非编码任务)。files 截 ≤10。
  dirtyPreflight?: { dirty: boolean; fileCount: number; files: string[] };
  // 五.1(收口作战令)· 工作根隔离级别:非 git 工作根(单写者模式,无 worktree 隔离)如实标注 "none";
  // 正常 git 工作根不设(默认视为 git 隔离)。多写者非 git 已在起跑前干净失败(non_git_multi_writer)。
  workspaceIsolation?: "none";
  // Gate A#3 · 未决合并冲突清单(不 -X theirs 强并;worker 分支/worktree 保留待人工决裁)。
  // taskId="__finalize" 表示 run 分支 merge 回用户分支时的冲突(opc-run-* 分支保留)。
  mergeConflicts?: Array<{ taskId: string; agentId: string; files: string[] }>;
  // 令五.4 · Chat 英雄回路可观测:任何顶层 run(Chat 发起 / mission 派发)绑定一个最小 Mission +
  // 观测任务图,让详情页能反查依赖/角色/拆解,不再黑箱。加性可选,旧 run 缺省 = 无关联(不渲染任务图)。
  // 任务图节点子 run(mission task-graph 逐节点派发)不绑定这两个字段(它们本身就是某张图的一个节点)。
  missionId?: string;
  taskGraphId?: string;
}

export interface TraceEvent {
  id: string;
  runId: string;
  timestamp: string;
  /** Durable, run-scoped sequence. Ephemeral stream chunks intentionally omit it. */
  seq?: number;
  schemaVersion?: "1";
  attempt?: number;
  visit?: number;
  causalParentId?: string;
  type:
    | "run_started"
    | "run_finished"
    | "agent_status_changed"
    | "agent_message"
    | "model_call_started"
    | "model_call_finished"
    | "tool_call"
    | "tool_result"
    | "agent_output_chunk"
    | "error"
    | "info"
    // 领域事件(runHistoryStore/TracePage 消费;Stage 2 接上生产者,之前断链)
    | "agent_deferred"
    | "worker_timeout"
    | "workspace_quota_exceeded"
    | "artifact_rejected"
    | "deliverable_degraded"
    // A6/终验:关键证据写盘失败(payload: { evidenceKind, critical, error });run.evidenceIntegrity 同步置 degraded
    | "evidence_write_failed"
    | "module_stuck"
    | "memory_committed"
    | "memory_injected"
    | "memory_proposal_rejected"
    | "verifier_result"
    // A1-V1:Core 对 review proposal 的四态裁决(accepted/needs_revision/failed/requires_human_review)。
    // verifier_result 是 verifier 的"提议"记录;review_committed 是 Core 的"提交"记录(decidedBy:"core")。
    | "review_committed"
    // A5:Quality Gate 三层(机械/结构/语义)统一聚合结果——替代此前"压成一句文本塞进 lastError"，
    // payload 见 runtime/qualityGateOrchestrator.ts 的 QualityGateResultEventPayload。
    | "quality_gate_result"
    | "rate_limited"
    // Layer E 失败反思记忆 telemetry
    | "lesson_proposed"
    | "lesson_committed"
    | "lesson_repeated"
    | "lesson_revoked"
    | "lesson_injected"
    // A2 · Task Graph:调度器节点级事件(串行拓扑执行的开工/收工;C2 拆解树/时间线消费)
    | "task_node_started"
    | "task_node_finished";
  agentId?: string;
  payload: unknown;
}

// v2 visibility model (information-isolation engine). Every inter-agent message carries an
// audience; when assembling an agent's context the orchestrator feeds only messages visible to it.
// Powers team in/out visibility plus games (狼人杀 night-wolf-only, 辩论 phase scoping).
export type MessageAudience =
  | "all"          // everyone in the run
  | "team"         // author's team (nearest-lead subtree) + the chain of leads above
  | "lead-only"    // only the author's lead(s)/CEO up the chain (worker → up report)
  | "private"      // only the author (scratch / secret)
  | `role:${string}`    // every agent whose role === X (e.g. role:judge)
  | `agents:${string}`; // explicit comma-separated agent ids (e.g. agents:w1,w2)

export interface MessageVisibility {
  audience: MessageAudience;
  phase?: string; // optional game/debate phase tag (e.g. "night", "day", "rebuttal")
}

// v5 通信编排：一条 agent 间的通道。lead-worker=lead 协调；peer-worker=同队 worker 间（lead 批准）；
// peer-lead=lead 间（CEO 协调）；learn=团队向团队学习（CEO 批准）。
export type ChannelKind = "lead-worker" | "peer-worker" | "peer-lead" | "learn" | "a2a";
// requested=已申请待批；open=已开通可通信；active=正在交流；closed=已关闭/拒绝。
export type ChannelStatus = "requested" | "open" | "active" | "closed";

export interface Channel {
  id: string;
  runId?: string;
  a: string;              // 一端 agentId（申请方/发起方）
  b: string;              // 另一端 agentId（目标）
  kind: ChannelKind;
  direction?: "oneway" | "bidirectional"; // absent on legacy channels = bidirectional
  status: ChannelStatus;
  coordinatedBy?: string; // 协调/批准者（lead 或 CEO）
  requestedBy?: string;   // 主动申请方（worker 申请与某 worker 交流时）
  reason?: string;        // 申请/开通理由
  openedAt?: string;
  lastActiveAt?: string;  // 最近一条经此通道的消息时刻（status 置 active 时刷新）——UI「正在交流」按它的新鲜度判定，status="active" 本身不衰减
}

export interface ChannelRequest {
  id: string;
  runId?: string;
  from: string;           // 申请方 agentId
  to: string;             // 想交流的目标 agentId
  kind: ChannelKind;
  direction?: "oneway" | "bidirectional";
  authPolicy?: "gated" | "manual";
  reason: string;
  status: "pending" | "granted" | "denied";
  decidedBy?: string;     // 协调者裁决
  createdAt: string;
}

// A2A/FIPA 言语行为(performative)子集。缺省视为 inform(现有 recordMessage 语义)。
export type Performative =
  | "inform"   // 通知/产出回报
  | "request"  // 同侪间请求做事
  | "ask"      // 问询,需 reply(阻塞,带 correlationId)
  | "reply"    // 对 ask 的回应(同 correlationId)
  | "share"    // 主动把 artifact 发给某人
  | "propose" | "accept" | "reject"; // 协商类(本期不强制)

// A2A 多模态内容块;text 始终保留为 parts 的纯文本投影,兼容 visibility/UI。
export type A2APart =
  | { kind: "text"; text: string }
  | { kind: "data"; data: Record<string, unknown> }
  | { kind: "artifact"; ref: string }; // artifactId,不内联大文档

// A2A 产出物 claim-check 引用(传 id 不传全文,控 token)。
export interface ArtifactRef { id: string; name: string; type: string; summary?: string }
export interface Artifact {
  id: string;
  runId?: string;
  producedBy: string;
  kind: "file-change" | "report" | "text";
  name: string;
  type: string;                  // "code-diff" | "design-doc" | "test-report" | "file" ...
  fileChanges?: FileChange[];     // 复用 engine.ts FileChange
  workdirPath?: string;           // 指向 worktree/activeWorkRoot 相对路径
  inlineText?: string;            // 仅 <4KB 才内联
  summary?: string;
  createdAt: string;
}

// A4 · A2A 升级:15 种业务语义消息类型(指南 4.5),叠加在 Performative 之上。
// 全部增量可选:旧消息不带 messageType 依然合法;推断不出语义时留空,不硬编。
export type A2AMessageType =
  | "delegate_task"          // 派工(CEO/lead → 下级)
  | "accept_task"            // 接受任务
  | "worker_report"          // worker 完成汇报
  | "lead_report"            // lead 团队汇报
  | "review_request"         // 请求审查
  | "review_approved"        // 审查通过
  | "review_rejected"        // 审查退回
  | "artifact_handoff"       // 产物交接
  | "dependency_blocked"     // 依赖阻塞
  | "revision_request"       // 返工要求
  | "memory_proposal"        // 经验提案
  | "decision_record"        // 决策记录
  | "human_approval_request" // 请求人工审批
  | "budget_escalation"      // 预算升级
  | "run_summary";           // run 总结

// A4 · 消息生命周期七态(指南 4.5:Agent can propose, Studio Core commits)。
// 硬规则:committed 是消息进入「正式 timeline」的唯一门槛——下游一切消费方
// (UI 协作动画/项目群消息卡/run story/a2a_messages.jsonl 落盘)只认 committed 及之后的状态。
export type A2ALifecycleState =
  | "proposed"      // agent 提出
  | "validated"     // Core 确定性校验通过(canCommunicate/收件人存在等)
  | "committed"     // Core 收进正式 timeline
  | "rejected"      // 校验失败,永不进入 timeline
  | "delivered"     // 已投进收件人 inbox
  | "acknowledged"  // 收件人已消费(drain)或显式 ack
  | "resolved";     // 该消息代表的协作事项已闭环

// A4 · 生命周期推进历史条目。
export interface A2AStatusEntry {
  state: A2ALifecycleState;
  at: string;   // ISO 时间
  by?: string;  // 推进者(agentId 或 "core")
  note?: string;
}

export interface AgentMessage {
  id: string;
  runId?: string;
  channelId?: string; // v5: 该消息走的通道（无则为旧式按 audience 广播）
  from: string;     // author agentId
  text: string;
  timestamp: string;
  visibility: MessageVisibility;
  // —— A2A/FIPA 叠加层(全部可选,旧消息合法) ——
  to?: string[];               // 显式收件人(真投递);缺省回退 visibility.audience
  performative?: Performative;  // 缺省视为 inform
  parts?: A2APart[];            // text 是 parts 的纯文本投影
  conversationId?: string;      // 一次协作/问答串关联(A2A contextId / FIPA conversation-id)
  correlationId?: string;       // ask/reply 配对(FIPA reply-with/in-reply-to)
  taskRef?: string;             // 关联 A2ATask id(本期可选)
  artifactRefs?: string[];      // claim-check 引用,只放 artifactId
  // —— A4 生命周期叠加层(全部可选,旧消息合法) ——
  messageType?: A2AMessageType;      // 业务语义类型(缺省 = 旧消息/语义未知)
  lifecycle?: A2ALifecycleState;     // 当前生命周期状态(缺省 = 旧消息,未纳入生命周期)
  statusHistory?: A2AStatusEntry[];  // 生命周期推进历史
  // —— D3 · 派单可观测(加性可选,旧消息合法) ——
  // 发送方(如 lead 派单时)决策上下文里**真正注入过的记忆**引用(id+短标题)。唯一诚实来源 =
  // InjectionContext.injectedMemories → citeMemories 派生(绝不从审计视图伪造);随 a2aBus 落
  // a2a_messages.jsonl,让"这次派单参考了哪些经验"可审计。
  citedMemories?: Array<{ id: string; title: string }>;
}

// Per-company / per-team rule for how messages without an explicit audience default, and how
// strictly isolation is enforced. game = honor explicit audience only (host stays omniscient).
export type VisibilityPolicy = "default" | "isolated" | "game";

export interface ModelCallRecord {
  agentId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  latencyMs: number;
  startedAt: string;
  endedAt: string;
}

// A single executable account: one credential under a provider + an isolated CLI config dir.
// Multiple accounts per provider enable same-vendor parallelism (scheduler picks least-busy).
export interface ProviderAccount {
  id: string;                 // stable id, e.g. "deepseek#0"
  providerId: string;         // ProviderConfig.id, e.g. "deepseek"
  label: string;              // UI display name
  apiKey: string;             // for the API framework; CLI frameworks may leave empty
  baseUrl?: string;           // override ProviderConfig.baseUrl (same-vendor multi-endpoint)
  allowLocalNetwork?: boolean; // explicit authorization for a local/private baseUrl
  configDir?: string;         // CLI frameworks: isolated config/credentials dir (absolute)
  frameworks?: AgentFramework[]; // frameworks this account may carry; empty = any
  enabled: boolean;
  preferred?: boolean;        // preferred within the same provider/framework pool; unhealthy/full falls back
  maxConcurrent: number;      // soft per-account concurrency cap (CLI usually 1, API larger)
  acceptBanRisk?: boolean;    // 订阅 CLI:开启后并发钳从默认 5 放宽到 10(用户显式承担封号风险)
  // Claude Code 的认证后端。GLM Coding Plan 仍经 Claude Code ACP 执行，不伪造新的 ACP 协议。
  // token 继续复用 apiKey 字段并由 public DTO 脱敏。
  cliBackend?: "native" | "glm-coding-plan";
}

export interface PublicProviderAccount {
  id: string;
  providerId: string;
  label: string;
  baseUrl?: string;
  allowLocalNetwork?: boolean;
  configDir?: string;
  frameworks?: AgentFramework[];
  enabled: boolean;
  preferred?: boolean;
  maxConcurrent: number;
  acceptBanRisk?: boolean;
  cliBackend?: "native" | "glm-coding-plan";
  hasApiKey: boolean;
  apiKeyPreview?: string;
  authMode: "apiKey" | "subscription" | "codingPlan";
}

// Parallel-execution config (lives under ProjectConfig.parallel).
export interface ParallelConfig {
  maxConcurrentWorkers: number; // global concurrency cap (default 8)
  perAccountDefault: number;    // default maxConcurrent when an account omits it
  taskMaxAttempts: number;      // per-task attempt budget (default 2)
  taskTimeoutMs: number;        // per-task time limit (default 180000)
  useWorktree: boolean;         // enable git worktree isolation (default true)
}

export interface ProjectConfig {
  version: string;
  projectName: string;
  apiKeys: Record<string, string>;
  defaultModel: string;
  budget: { totalUsd: number /* deprecated compatibility field; not enforced */; maxTokensPerTask: number; maxAttemptsPerTask?: number; taskTimeoutMs?: number; maxTokensPerRun?: number; maxTokensTotal?: number; maxCostPerRun?: number /* deprecated compatibility field; not enforced */ };
  permissions: { allowShell: boolean; allowFileWrite: boolean; allowWebAccess: boolean };
  // Stage 10 · 商业化标记位:schema 占位,当前**零 enforcement**(只供 manifest/能力报告/UI 读),为将来 Pro 功能闸预留语义。
  edition?: "personal" | "pro" | "enterprise";
  parallel?: ParallelConfig;
  github?: {
    oauth?: { clientId: string; clientSecret: string; accessToken?: string };
    /** @deprecated 社区已锁定官方仓库(WUBING2023/opc-studio-community),服务端不再读取此字段覆盖。
     * 仅保留结构以兼容历史 config.json,不再有任何写入 UI。 */
    communityRepo?: { owner: string; name: string; branch: string };
  };
  // v4: 首次登录引导状态。completed=false/缺失 → 前端弹引导。
  onboarding?: {
    completed: boolean;
    identity?: UserIdentity;   // 用户身份，用于裁剪体验/文案
    tutorial?: boolean;        // 是否想要新手教程
    completedAt?: string;
  };
  // 默认 AI 模型:新员工、未指定模型的任务及系统内部能力统一使用同一配置。
  // creative/judge 仅用于读取旧 config.json；新代码只写 default。
  systemModel?: {
    // framework 可选:订阅(claude-code/codex/gemini-cli)或 API 面("api";历史值 "hermes" 读侧兼容);旧值无此字段仍合法(读旧写新)。
    // reasoningEffort(可选,纯加性):同 AgentNodeConfig.reasoningEffort——仅 codex 订阅执行时经 CODEX_CONFIG 生效。
    default?: { framework?: string; provider: string; model: string; reasoningEffort?: ReasoningEffort };
    /** @deprecated 旧版创意档，仅作迁移读取。 */
    creative?: { framework?: string; provider: string; model: string; reasoningEffort?: ReasoningEffort };
    /** @deprecated 旧版判定档，仅作迁移读取。 */
    judge?: { framework?: string; provider: string; model: string; reasoningEffort?: ReasoningEffort };
  };
}

// v4: 用户身份（首次引导选择）。
export type UserIdentity = "developer" | "product" | "founder" | "researcher" | "student" | "other";

// Real quality-gate result (replaces keyword scanning) — used by the orchestrator to
// accept or discard a worker's diff. Failure is never softened.
export interface QualityGateResult {
  passed: boolean;
  // A8 · command/cwd/exitCode/durationMs 为加性可选字段:真实执行过(ran=true)才有值,
  // 判定逻辑(qualityGate.ts)零改动纯透传——供 test_evidence 事件如实记账,绝不参与 pass/fail。
  typeCheck: { ran: boolean; passed: boolean; output: string; command?: string; cwd?: string; exitCode?: number; durationMs?: number };
  tests: { ran: boolean; passed: boolean; output: string; command?: string; cwd?: string; exitCode?: number; durationMs?: number };
}

// A task skipped after exhausting its attempt/timeout budget — collected and reported
// at run end instead of blocking the whole orchestration.
export interface DeferredTask {
  taskId: string;
  agentId: string;
  goal: string;
  // 五.3(收口作战令):agent.workingDirectory 非法时该 worker 干净失败的类别——绝不静默退回工作根执行。
  reason: "retry_budget_exhausted" | "timeout" | "quality_gate_failed" | "provider_unavailable" | "no_account" | "run_budget_exhausted" | "run_sla_exceeded" | "cancelled" | "no_progress" | "workspace_quota_exceeded" | "no_file_changes" | "invalid_working_directory" | "no_producer_output";
  attempts: number;
  lastError?: string;
}

export type ModelProvider = "openai" | "anthropic" | "deepseek" | "openrouter" | "ollama" | "minimax" | "doubao" | "mock";

export type ApiFormat = "openai" | "anthropic" | "gemini" | "ollama" | "custom";

export interface ProviderConfig {
  id: string;
  name: string; note?: string; website?: string;
  kind: "claude" | "unified" | "local" | "custom";
  apiFormat: ApiFormat; baseUrl: string; apiKey: string;
  allowLocalNetwork?: boolean;
  defaultModel?: string; models: string[];
  headers: Record<string, string>; env: Record<string, string>;
  options: {
    hideAISignature: boolean; enableTeammatesMode: boolean;
    enableToolSearch: boolean; enableMaxThinking: boolean;
    disableAutoUpgrade: boolean; allowPromptCaching: boolean; allowStreaming: boolean;
  };
  permissions: { allow: string[]; deny: string[] };
  pricing?: { currency: "USD"|"CNY"; inputPer1MTokens?: number; outputPer1MTokens?: number; cacheReadPer1MTokens?: number; cacheWritePer1MTokens?: number };
  test?: { useSeparateConfig: boolean; model?: string; prompt?: string; timeoutMs?: number };
  createdAt: string; updatedAt: string;
}

export const PRESET_PROVIDERS = [
  { id: "openai", name: "OpenAI", website: "https://platform.openai.com", baseUrl: "https://api.openai.com/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "anthropic", name: "Anthropic", website: "https://console.anthropic.com", baseUrl: "https://api.anthropic.com/v1", apiFormat: "anthropic" as ApiFormat, kind: "claude" as const, popular: true, allowLocalNetwork: false },
  { id: "openrouter", name: "OpenRouter", website: "https://openrouter.ai", baseUrl: "https://openrouter.ai/api/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "deepseek", name: "DeepSeek", website: "https://platform.deepseek.com", baseUrl: "https://api.deepseek.com/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "minimax", name: "MiniMax", website: "https://platform.minimaxi.com", baseUrl: "https://api.minimaxi.com/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "doubao", name: "豆包", website: "https://console.volcengine.com/ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "ollama", name: "Ollama", website: "https://ollama.com", baseUrl: "http://localhost:11434/v1", apiFormat: "ollama" as ApiFormat, kind: "local" as const, popular: true, allowLocalNetwork: true },
  { id: "gemini", name: "Gemini", website: "https://aistudio.google.com", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiFormat: "gemini" as ApiFormat, kind: "unified" as const, popular: true, allowLocalNetwork: false },
  { id: "groq", name: "Groq", website: "https://console.groq.com", baseUrl: "https://api.groq.com/openai/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "together", name: "Together", website: "https://api.together.xyz", baseUrl: "https://api.together.xyz/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "siliconflow", name: "硅基流动", website: "https://siliconflow.cn", baseUrl: "https://api.siliconflow.cn/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "zhipu", name: "智谱", website: "https://open.bigmodel.cn", baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "bailian", name: "百炼", website: "https://bailian.console.aliyun.com", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "kimi", name: "Kimi", website: "https://platform.moonshot.cn", baseUrl: "https://api.moonshot.cn/v1", apiFormat: "openai" as ApiFormat, kind: "unified" as const, popular: false, allowLocalNetwork: false },
  { id: "custom", name: "自定义", baseUrl: "", website: "", apiFormat: "custom" as ApiFormat, kind: "custom" as const, popular: false },
];

export interface ToolConfigEntry {
  name: string;
  enabled: boolean;
  description?: string;
}

export interface AgentCard {
  id: string;
  title: string;
  description: string;
  role: string;
  author: string;
  authorGitHub?: string;
  createdAt: string;
  tags: string[];
  downloads: number;
  stars: number;
  license?: string;       // v3: 来源 License（OPC-Original / 第三方 SPDX）
  sourceUrl?: string;     // v11: 真实来源 URL（第三方 GitHub skill；OPC 原创可省）
  agent: {
    suggestedId: string;
    name: string;
    recommendedProvider: string;
    recommendedModel: string;
    systemPrompt: string;
    tools: ToolConfigEntry[];
    expectedRole: string;
    recommendedParents: string[];
  };
}

export interface CompanyTemplate {
  id: string;
  title: string;
  description: string;
  author: string;
  authorGitHub?: string;
  // D8(指南 11.17 Template Signature / Verified Author 预留字段):由社区侧的人工/审查流程标记
  // (本地无法验证一个 GitHub 账号"是否权威"这件事本身,不能自我声明)。绝大多数模板此字段缺失——
  // 缺失时 verifyAndAssignTrust 判不出,降级到 community,不假定 undefined === 已验证。
  verifiedAuthor?: boolean;
  createdAt: string;
  tags: string[];
  downloads: number;
  stars: number;
  readme: string;
  license?: string;       // v3: 来源 License
  agents: AgentNodeConfig[];
  recommendedConfig?: {
    defaultModel?: string;
    budget?: {
      totalUsd: number;
      maxTokensPerTask: number;
      maxAttemptsPerTask?: number;
      taskTimeoutMs?: number;
      maxTokensPerRun?: number;
      maxTokensTotal?: number;
    }; // legacy read compatibility
    maxTokensPerTask?: number;
    permissions?: { allowShell: boolean; allowFileWrite: boolean; allowWebAccess: boolean };
  };
  // ── Manifest v1.5(可加性扩展;schema 设计完整、实现渐进)──
  // 这些字段由 companyToTemplate 导出时尽量填充,供 Capability Report(Stage 5)与生态(Stage 8)用。
  useCases?: string[];          // 适用场景(作者标注;也供"本团队适用/不适用")
  compatibility?: string;       // 兼容性说明(如需要的 OPC 版本)
  riskNotes?: string[];         // 作者标注的"本团队不适用/需谨慎"(Stage 5 能力边界用,非运行时自我推断)
  toolRequirements?: {          // 导出时从 agents 派生,导入时做 requirements check
    requiredEngines: string[];
    requiredProviders: string[];
    requiredMcpServers: string[];
    requiredSkills: string[];
    optionalTools: string[];
  };
  // workflow / memoryPolicy / safety / examples 等更深结构在各自 Stage(6/4/9/8)加入(可选,additive)。
  workflow?: WorkflowConfig;     // Stage 6:交叉验证链(producer→verifier→method),安装时 propagate 到 Company。
  // P0-B①:公司级消息可见性/信息隔离策略(调度语义,非本机路径)。导出侧从 Company.visibilityPolicy
  // 采集、导入侧落回 Company——full 档必保真(这是可移植的执行语义,不含隐私/密钥,share 档同样保留)。
  visibilityPolicy?: VisibilityPolicy;
  // ── Stage 8 · 模板供应链(全部可选,additive)──
  version?: string;              // semver,默认 "1.0.0";fork 重置
  // D8(指南 11.17 Trust Level):5 级——official(官方,代码永不自动赋,留给 Stage 9 真签名)/
  // verified_community(保留级,当前代码同样永不赋出:verifiedAuthor 是模板内容自带、参与 hash 的
  // 自声明,hash-only 校验路径一律封顶 community,见 templateTrust.verifyAndAssignTrust;等 Stage 9
  // 服务端持可信信号(真签名/白名单)后才可能被赋出)/ community(hash 校验通过)/
  // local_import(本地导入,无社区来源,无 hash 但明确来自本地文件)/ untrusted(无 hash 或校验失败)。
  // 旧枚举值(仅 official/community/untrusted 三级)向后兼容——都仍是本联合类型的合法取值。
  trustLevel?: "official" | "verified_community" | "community" | "local_import" | "untrusted"; // 导入时服务端赋值(不信客户端):hash 校验决定
  hash?: string;                // sha256(canonical_json),完整性指纹(防篡改,非防伪)
  signature?: string;           // D5:= hash 占位;Stage 9 升 HMAC/Ed25519
  forkedFrom?: string;          // 来源 template id(供应链溯源)
  requiredPermissions?: {       // 导入前透明展示(危险权限 → UI consent)
    allowShell?: boolean;
    allowFileWrite?: boolean;
    allowWebAccess?: boolean;
    mcpServers?: string[];
  };
  exampleTrace?: { goal: string; steps: string[]; outcome: string }; // 可运行性证明(作者手填)
  exampleArtifacts?: Array<{ name: string; type: string; description: string; previewUrl?: string }>;
  // ── Stage 8+ · 生态深化(全部可选,additive)──
  bundledSkills?: BundledSkillSpec[];       // 打包的 skill(内容内联),install 时逐条 upsert 进 skill store
  mcpRequirements?: McpRequirementSpec[];   // 声明本模板依赖的 MCP 服务器(不打包),install 时对照本机配置报 missing
  a2aChannels?: A2AChannelSpec[];           // 预置 A2A 通道(角色卡引用),install 时换算成真实 agent id
  // D5 · 记忆导出(指南 11.6):company/team/agent/project 分层的五级(draft/noted/verified/sop/doctrine)
  // 记忆记录,companyToBundle 导出时从 registryStore/reflectionStore 映射填充(runtime/memoryBundle.ts);
  // install 时按 memoryImportMode 过滤后写回 registryStore/reflectionStore。
  seedMemories?: BundleMemoryRecord[];
  // C3 · 示例任务(安装预览 newDefaultTasks 的真数据源,指南 11.8):作者手填的示例任务,或导出侧
  // (companyToTemplate)从该公司真实历史采集——runs 索引里成功完结 run 的 goal,去重取最近 ≤3 条。
  // 可选、加性:旧模板/旧 bundle 无此字段照常运作,预览计数按缺省 0。
  defaultTasks?: Array<{ title: string; goal: string; suggestedRole?: string }>;
  // ① 员工个人记忆(agent-memory.md)在扁平 CompanyTemplate 形状里的落点。CompanyBundle 用
  // agentMemories 承载;桥回扁平模板(bundleToTemplateShape)、工坊导出(workshopTypes.buildPayload)、
  // 再打回 Bundle(templateToBundle 默认从此字段回填)都要带,否则"公司→工坊→社区模板"主路径会把员工
  // 个人记忆静默丢掉。可选、加性;旧模板无此字段照常。
  agentMemories?: BundleAgentMemory[];
}

// Stage 6 · 交叉验证(verification_edge:producer 产出由 verifier 核查;否决则真影响交付)。
export type VerificationMethod = "fact-check" | "llm-review" | "code-review" | "custom";
export interface VerificationEdge {
  id?: string;
  producer: string;   // agentId 或 role 名(如 "researcher")或 "*" 通配
  verifier: string;   // agentId 或 role 名(如 "fact_checker");程序化方法可缺
  method: VerificationMethod;
  onReject: "redo" | "flag";   // redo=打回返工;flag=直接剔除出交付(标注原因)
  maxRounds?: number;          // 默认 1
}
export interface WorkflowConfig {
  verificationEdges?: VerificationEdge[];
}

// ── Stage 8+ · 生态深化(全部可选,additive;老模板/老公司无这些字段照常运作)──
// 内容内联自包含 —— 打包进模板的 skill 正文随模板走,不依赖发布方本地文件系统。
export interface BundledSkillSpec {
  name: string;
  description?: string;
  content: string;
  roles?: string[]; // 缺省 = install 时绑定到本模板出现过的全部角色(非全局 "*",防串染)
}
// 声明而非打包 —— MCP 是本机服务,模板只声明"需要哪个",install 时对照本机已配 MCP 报 missing 清单。
export interface McpRequirementSpec {
  name: string;
  purpose?: string;
  optional?: boolean;
}
// 角色卡引用(同 VerificationEdge.producer/verifier 惯例:模板内 agentId 或 role 名;"*" 不适用于 A2A 通道)。
// P0-2 · 正式 A2A 编辑:单向/双向 + 授权策略 + 启用开关。
// 新字段可选(向后兼容),zod parse 时补 default(oneway/trusted/true)。
export interface A2AChannelSpec {
  from: string;
  to: string;
  direction?: "oneway" | "bidirectional";
  purpose?: string;
  authPolicy?: "trusted" | "gated" | "manual";
  enabled?: boolean;
}

export interface PromptTemplate {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  author: string;
  authorGitHub?: string;
  tags: string[];
  downloads: number;
  stars: number;
  createdAt: string;
}

// A portable team = a lead node + its descendant subtree, self-contained so it can be re-rooted
// under a chosen CEO/Lead on import (the team/worker import flow, Phase 11).
export interface TeamTemplate {
  id: string;
  title: string;
  description: string;
  author: string;
  authorGitHub?: string;
  createdAt: string;
  tags: string[];
  downloads: number;
  stars: number;
  license?: string;          // v3: 来源 License
  readme: string;
  leadId: string;            // which agent in `agents` is the team's root lead
  agents: AgentNodeConfig[]; // the lead + its descendants (a self-contained subtree)
}

// v2 community taxonomy: three content types × two shelves (market / favorites).
export type CommunityContentType = "company" | "team" | "worker";

// Favorited item ids per content type, persisted to .opc/community/favorites.json.
export interface CommunityFavorites {
  company: string[];
  team: string[];
  worker: string[];
}

export interface CommunityIndexEntry {
  id: string; title: string; author: string; authorGitHub?: string;
  role?: string; tags: string[]; downloads: number; stars: number; createdAt: string;
  agentCount?: number;
  license?: string;     // v3: 来源 License（OPC-Original / MIT / ...），列表即可见出处
  sourceUrl?: string;   // v11: 真实来源 URL（列表/卡片可点开出处）
  // D8(指南 11.17 Community Report / Unlist):"下架"是标记,不是物理删除——GitHub 历史本就不可能
  // 被真正抹掉,UI 措辞统一用"下架"。缺省(undefined)= listed(照常展示);unlisted = 默认列表过滤掉,
  // 记录本体(文件/条目)依旧完整保留,可按 id 直接读到。
  visibility?: "listed" | "unlisted";
  unlistedAt?: string;
}

export interface CommunityIndex {
  templates: CommunityIndexEntry[]; // companies
  teams: CommunityIndexEntry[];     // teams (lead + subtree)
  agents: CommunityIndexEntry[];    // workers
  prompts: CommunityIndexEntry[];
}

export interface ProviderHealthRecord {
  provider: string;
  consecutiveFailures: number;
  lastSuccess: string | null;
  lastFailure: string | null;
  lastError: string | null;
}

export interface PriceEntry {
  input: number;
  output: number;
}

export type PricingMap = Record<string, PriceEntry>;

export interface GitHubRepoSource {
  owner: string;
  name: string;
  branch: string;
  label?: string;
  addedAt?: string;
  lastSyncedAt?: string;
  // v3: License 合规白名单（仅这些 License 的 skill 允许下载/导入）；未设则用 DEFAULT_ALLOWED_LICENSES。
  allowedLicenses?: string[];
  licenseCheckEnabled?: boolean; // 默认 true
}

// v3 默认 License 白名单：宽松开源 + OPC 自有内容标记。
export const DEFAULT_ALLOWED_LICENSES = [
  "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC",
  "Unlicense", "CC0-1.0", "CC-BY-4.0", "CC-BY-SA-4.0", "MPL-2.0",
  "OPC-Original", // OPC 官方原创内容（含人物原创演绎）
];

// Stage 3 · 产物来源链的有向边。sourceId 指向另一 RunArtifact.id;relationship 描述变换语义;via=执行该变换的 agentId。
export interface ArtifactLineageEdge {
  sourceId: string;
  relationship: "synthesized-from" | "accepted-from" | "revised-from" | "derived-from" | "reviewed-by";
  via?: string;
}

// B5c:status 双字段拆分——旧 status 混装的两套语义。
export type RunArtifactChangeType = "added" | "modified" | "deleted";
export type RunArtifactReviewStatus = "pending" | "accepted" | "rejected" | "degraded";

// Stage 2 · Artifact 最小归集(一个 run 的可见产物清单)。Stage 3 加 producer/status 生命周期/lineage 来源链。
export interface RunArtifact {
  id: string;
  kind: "report" | "file" | "worker-output" | "review-result";
  title: string;
  producer?: string;                 // 产出 agent id
  producerRole?: string;             // Stage 3:产出 agent 角色(ceo/lead/dev…)
  /**
   * @deprecated B5c:历史遗留字段,混装了两套语义——kind=file 时表示「变更类型」(added/modified/deleted),
   * kind=report/worker-output/review-result 时表示「验收结论」(final/degraded/accepted/rejected)。
   * 继续按原规则填充(向后兼容,不删不改);新消费方请改读 changeType(变更类型)/ reviewStatus(验收结论)。
   */
  status: "final" | "degraded" | "accepted" | "added" | "modified" | "deleted" | "rejected";
  changeType?: RunArtifactChangeType;      // B5c:变更类型,仅 kind=file 有意义
  reviewStatus?: RunArtifactReviewStatus;  // B5c:验收结论——report/worker-output/review-result 的裁决态,file 被否决时也置 rejected
  reason?: string;                   // rejected/degraded 的原因(来自断链领域事件)
  path?: string;                     // 工作区文件相对路径(kind=file)
  downloadUrl?: string;              // 可下载产物
  inFinalDeliverable: boolean;       // 是否进入最终交付
  sourceArtifactIds?: string[];      // Stage 3:上游来源 artifact id(final report → 它依据的 worker 产物)
  lineage?: ArtifactLineageEdge[];   // Stage 3:带语义的来源边
  createdAt?: string;
  hash?: string;                     // B5:sha256:<hex>——事后对能定位到磁盘文件的产物计算;读不到诚实留空
  size?: number;                     // B5:字节数,与 hash 同一次读取得出;读不到留空
  acceptedBy?: string;               // B5:验收人 agentId,从 review/verification 通过记录派生;派生不出留空
  savedPath?: string;                // B5c:实体副本相对 run 目录的路径(如 "artifacts/xxx");无可归档实体则缺省
  savedPathTruncated?: boolean;      // B5c:实体超 1MB 被截断归档时为 true;未截断/未归档则缺省
}

export interface RunArtifactCollection {
  runId: string;
  degraded: boolean;
  degradedReason?: string;
  artifacts: RunArtifact[];
}

// AI Research Company:证据表条目,让报告不止是散文,而是可验证的证据条目。
export interface EvidenceRow {
  claim: string;       // 一条结论/论点
  source: string;      // 证据来源(文献/网页标题等)
  url?: string;        // 来源链接(如有)
  confidence: "high" | "medium" | "low"; // 该证据支撑该论点的置信度
}

// Structured run report (Phase 5 report-center). Persisted to .opc/runs/<id>/structured-report.json.
export interface StructuredReport {
  goal: string;
  summary: string;
  filesChanged: { path: string; changeType: "added" | "modified" | "deleted" }[];
  tests: { ran: boolean; passed: boolean; command: string; output: string };
  cost: { totalTokens: number; totalCostUsd: number | null };
  risks: string[];
  nextSteps: string[];
  evidenceTable?: EvidenceRow[]; // AI Research Company:可验证的证据条目(claim→source→confidence)
}

// v3: 一个 skill 的来源（从 GitHub 下载时记录，本地原创则为 undefined）。
export interface SkillSource {
  owner: string;
  repo: string;
  branch: string;
  path: string;  // 文件在仓库内的路径
  url: string;   // 下载用的 raw url
}

export interface SkillMeta {
  id: string;
  title: string;
  role: string;
  enabled: boolean;
  lastModified: string;
  // P0-3 · 诚实名词:现有 Skill 是 Markdown 指令而非可执行包。
  // "instruction" = 指令型 Playbook(当前实现);"skill_package_v1" = 可执行 SkillPackage(未来)。
  kind?: "instruction" | "skill_package_v1"; // 缺省="instruction"(向后兼容)
  description?: string;
  source?: SkillSource;
  license?: string;
  licenseUrl?: string;
  author?: string;
  authorGitHub?: string;
  checksum?: string;
  // P0-3 · origin 不再允许新创建 "memory"——记忆应通过显式"提升为 Playbook"进入 skill store。
  // "memory" 保留仅用于读兼容(legacy 数据),代码中所有写入路径应拒绝 origin:"memory"。
  origin?: "user" | "persona" | "bundled" | "memory";
  companyId?: string;
}

/** P0-3 · 可执行 SkillPackage v1 契约。仅 kind==="skill_package_v1" 时使用此结构。
 * 运行链(entrypoint 执行/hash 校验/Doctor 依赖安装/运行证据)落地前,UI 不应消费此类型——
 * 当前所有 Skill 均为 kind==="instruction" 的指令型 Playbook,不应向用户暴露"执行 Skill"入口。 */
export interface SkillPackageV1 extends SkillMeta {
  kind: "skill_package_v1";
  version: string;
  entrypoint?: string;
  files?: Array<{ path: string; content: string }>;
  resources?: Array<{ path: string; hash: string }>;
  mcpDependencies?: string[];
  cliDependencies?: string[];
  permissions?: { allowShell?: boolean; allowFileWrite?: boolean; allowWebAccess?: boolean };
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  tests?: Array<{ name: string; command: string; expectedExitCode: number }>;
  hash: string;
  trustLevel?: "signed" | "community" | "local" | "unknown";
}

// P0-1 · 导入能力映射。安装公司模板时,对每个缺失/不兼容的能力生成一条绑定计划。
// 计划由 AI 推荐 + 用户确认,不经由静默替换。
export interface ImportBindingPlan {
  originalBinding: { kind: "provider" | "model" | "engine" | "mcp" | "tool"; name: string };
  status: "available" | "missing" | "incompatible";
  action: "keep" | "map" | "configure" | "disable";
  targetBinding?: { kind: string; name: string };
  reason?: string;
  userApproved: boolean;
}

/** 指令型 Playbook:kind="instruction" 的 Skill(当前实现)。content 是 Markdown 指令文本。
 *  kind 允许 skill_package_v1 以便与 SkillPackageV1 并列(联合类型判别用),但 InstructionPlaybook 总是 content-based。 */
export interface InstructionPlaybook extends SkillMeta {
  kind?: "instruction" | "skill_package_v1";
  content: string;
}

/** Skill 别名:P0-3 后为 InstructionPlaybook(向后兼容现有代码)。 */
export type Skill = InstructionPlaybook;

// Track E E1:任务复杂度预估(runtime/taskComplexityEstimator.ts 纯规则输出)。
// mission 创建/approve 时计算并快照到 mission(missions.json)、goal 记录(goals.json)
// 与 run 目录(.opc/runs/<id>/complexity-estimate.json);旧数据无此字段=未估算,前端按缺省处理。
export type ComplexityTier = "S" | "M" | "L" | "XL";
export type ComplexityRiskLevel = "low" | "standard" | "elevated" | "high";
export interface TaskComplexityEstimate {
  complexity: ComplexityTier;
  risk_level: ComplexityRiskLevel;
  estimated_duration: { min_minutes: number; max_minutes: number; confidence: "low" | "medium" | "high" };
  recommended_governance_level: 0 | 1 | 2 | 3;
  reason: string[];
}

// v6 交互模型重构:Idea → MissionBrief(Plan 阶段可编辑) → approve → 派发到已有 run/goal/loop 入口。
// runType/teamMode 字面量与 orchestrator.ts 的 RunType / TeamMode 保持一致(不重复定义,仅镜像字面量)。
export interface MissionBrief {
  id: string;
  companyId?: string;
  createdAt: string;
  originalIdea: string;
  interpretedGoal: string;
  targetUser?: string;
  problemStatement?: string;
  proposedDirection?: string;
  successCriteria: string[];
  nonGoals: string[];
  assumptions: string[];
  risks: string[];
  requiredDepartments: string[];
  expectedArtifacts: string[];
  suggestedRunType: "quick" | "team";
  suggestedTeamMode?: "economy" | "balanced" | "maxQuality";
  permissionNeeds: "no_code" | "propose_only" | "write_code" | "external_actions";
  approvalStatus: "draft" | "approved" | "stopped";
  complexityEstimate?: TaskComplexityEstimate; // E1:创建/approve 时的复杂度预估快照(旧 mission 无此字段)
}

// Plan 阶段用户手改简报:可编辑字段 = MissionBrief 去掉系统管理字段(id/createdAt/approvalStatus)。
export type MissionBriefPatch = Partial<Omit<MissionBrief, "id" | "createdAt" | "approvalStatus">>;

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  enabled: boolean;
  allowLocalNetwork?: boolean;
  assignedAgents: string[];
  createdAt: string;
}
