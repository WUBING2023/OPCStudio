import type { Company, AgentNodeConfig, TaskComplexityEstimate, TaskGraph } from "@opc/shared";
import { getSessionToken, refreshSessionToken } from "../lib/sessionToken";

// 令五.6:所有请求统一注入本机 API session token(变更型请求服务端强校验;只读放行但一并带上保持一致)。
// 拿不到 token 时不加 header,不阻断请求(由服务端按需 401),避免鸡生蛋卡死首屏。
async function authHeaders(base?: Record<string, string>): Promise<Record<string, string>> {
  const h: Record<string, string> = { ...(base ?? {}) };
  const token = await getSessionToken();
  if (token) h["X-OPC-Session-Token"] = token;
  return h;
}

/** Install confirmation tokens are one-time and bound to the previewed danger surface. */
export function requiresInstallRepreview(error: unknown): error is ApiError {
  if (!error || typeof error !== "object") return false;
  const body = (error as ApiError).body;
  return !!body && typeof body === "object"
    && (body as { requiresRepreview?: unknown }).requiresRepreview === true;
}

const BASE = "/api";

// errors:服务端结构化校验失败清单(如 task-graph approve 422 的 { errors: string[] })——如实透出,
// 不折叠成一句笼统 message(缺省 = 该端点没有逐条错误)。
// body:非 2xx 响应的完整 JSON 体(原样带上)——供需要读结构化字段的调用方(如 428 高危确认门要读
// { highRisk } 明细、409 冲突要读 { currentHash } 等)在 catch 里取用,不必为此绕开 api client 直接 fetch。
export interface ApiError extends Error { status: number; errors?: string[]; body?: unknown; }

async function requestWithSessionRetry(
  path: string,
  init: Omit<RequestInit, "headers"> = {},
  baseHeaders?: Record<string, string>,
): Promise<Response> {
  const send = async () => fetch(BASE + path, { ...init, headers: await authHeaders(baseHeaders) });
  let response = await send();
  const sessionExpired = response.status === 401 || (response.status === 403 && await response.clone().json()
    .then((body: { code?: unknown }) => body?.code === "session_token_invalid")
    .catch(() => false));
  if (sessionExpired) {
    await refreshSessionToken();
    response = await send();
  }
  return response;
}

// 非 2xx → 抛出带**服务端 {error} 文案**和 status 的 Error(之前只抛状态码,真实原因被吞)。
async function httpError(r: Response): Promise<ApiError> {
  let msg = `${r.status}`;
  let errors: string[] | undefined;
  let body: unknown;
  try {
    const b = await r.json() as { error?: string; errors?: unknown };
    body = b;
    if (b?.error) msg = b.error;
    if (Array.isArray(b?.errors)) errors = b.errors.filter((x): x is string => typeof x === "string");
  } catch { /* 无 JSON body */ }
  const e = new Error(msg) as ApiError;
  e.status = r.status;
  if (errors?.length) e.errors = errors;
  if (body !== undefined) e.body = body;
  return e;
}

export async function get<T>(path: string): Promise<T> {
  const r = await requestWithSessionRetry(path);
  if (!r.ok) throw await httpError(r);
  return r.json();
}

export async function post<T>(path: string, body: unknown, opts?: { signal?: AbortSignal }): Promise<T> {
  const r = await requestWithSessionRetry(path, {
    method: "POST",
    body: JSON.stringify(body),
    signal: opts?.signal,
  }, { "Content-Type": "application/json" });
  if (!r.ok) throw await httpError(r);
  return r.json();
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const r = await requestWithSessionRetry(path, {
    method: "PATCH",
    body: JSON.stringify(body),
  }, { "Content-Type": "application/json" });
  if (!r.ok) throw await httpError(r);
  return r.json();
}

export async function del<T>(path: string): Promise<T> {
  const r = await requestWithSessionRetry(path, { method: "DELETE" });
  if (!r.ok) throw await httpError(r);
  return r.json();
}

// 三级模型选择的单一事实源(契约见 apps/server/src/routes/modelCatalogRoutes.ts）。节点配置的模型下拉
// 只认这一个端点:订阅段带 installed 状态 + 静态/ACP 模型表,API 供应商段带 hasKey + builtin 模型。
export interface CatalogModel { id: string; label: string; isDefault?: boolean }
export interface SubscriptionCatalogEntry {
  engine: "claude-code" | "codex" | "gemini" | "kimi" | "grok";
  installed: boolean;
  models: CatalogModel[];
  source: "acp" | "static";
  refreshedAt?: string;
}
export interface ApiProviderCatalogEntry {
  provider: string;
  label: string;
  hasKey: boolean;
  models: CatalogModel[];
  source: "live" | "builtin";
  refreshedAt?: string;
}
export interface ModelCatalog {
  subscriptions: SubscriptionCatalogEntry[];
  apiProviders: ApiProviderCatalogEntry[];
}
export async function getModelCatalog(): Promise<ModelCatalog> {
  return get("/model-catalog");
}

export async function refreshModelCatalog(kind: "provider" | "subscription", id: string): Promise<{
  kind: "provider" | "subscription";
  id: string;
  models: CatalogModel[];
  source: "live" | "acp";
  refreshedAt: string;
}> {
  return post("/model-catalog/refresh", { kind, id });
}

export interface ShareRequest {
  type: "template" | "agent" | "prompt";
  data: unknown;
  author: string;
  message: string;
}

export interface ShareResponse {
  prUrl?: string;
  needAuth?: boolean;
  authUrl?: string;
}

// 对话线程持久化(契约见 apps/server/src/storage/chatThreadStore.ts）:一条 turn = role + 文本 + 落库时间。
export interface ChatThreadTurn { role: "user" | "assistant"; content: string; at: string }

export interface ChatResponse {
  reply: string;
  tokens: number;
  // 服务端持久化对话后回附:线程标识 + 最近历史(前端对齐/兜底渲染用,主渲染仍走 getChatThread 拉取)。
  threadId?: string;
  history?: ChatThreadTurn[];
}

// 打开会话时拉取服务端线程(不再只靠本地易失 state,刷新/换设备都能看回历史)。传真实 agentId
// (含真实 CEO)→ 该 agent 线程;只传 companyId 或缺省 → 该公司 CEO 线程。无 CEO 时 threadId=null。
export interface ChatThreadResponse { threadId: string | null; agentId: string | null; turns: ChatThreadTurn[] }
export async function getChatThread(opts?: { companyId?: string; agentId?: string }): Promise<ChatThreadResponse> {
  const qs = new URLSearchParams();
  if (opts?.companyId) qs.set("companyId", opts.companyId);
  if (opts?.agentId) qs.set("agentId", opts.agentId);
  const q = qs.toString();
  return get(`/chat/thread${q ? `?${q}` : ""}`);
}

export interface ChatTaskResponse {
  runId: string;
  message: string;
  // E4 · L3 审批网关(chatRoutes.ts):true = run 已预建为 pending,未派发,批准后才开工。
  approvalRequired?: boolean;
  governanceLevel?: string;
  governanceReason?: string[];
  // P1-5 派发队列:撞上单 run 互斥闸(已有活 run)时 run 入持久化队列而非直接烧掉,queued=true;
  // queuePosition 为 1 基排队序号(队首=1)。前端据此在聊天流回一条"已排队#N"系统消息。
  queued?: boolean;
  queuePosition?: number;
}

export async function chat(message: string, companyId?: string): Promise<ChatResponse> {
  return post("/chat", { message, companyId });
}

export type RunType = "quick" | "team";
export type TeamMode = "economy" | "balanced" | "maxQuality";
export type MissionTeamModeOverride = TeamMode | "configured";

// 显式 Run Type / Team Mode(终结"靠 TASK_RE 猜"的入口分裂)。companyId 缺省 → 服务端用默认公司。
// skills:命令面板"/"选中或手打 /skill 附加的技能 id(≤3,服务端 chatRoutes.ts 按 id/标题匹配后强制注入全员)。
export async function chatTask(
  message: string,
  opts?: { runType?: RunType; teamMode?: TeamMode; companyId?: string; skills?: string[] },
): Promise<ChatTaskResponse> {
  return post("/chat/task", { message, ...opts });
}

// Phase 2:直聊单个员工(对话语义,非任务执行)。
export async function chatAgent(agentId: string, message: string): Promise<ChatResponse> {
  return post(`/agents/${agentId}/chat`, { message });
}

// 反馈回路(harness/loop 共用契约,见 goalRoutes.ts/loopRoutes.ts):kind 决定打 /goals 还是 /loops,
// AutomationPanel 的 HarnessCard/LoopCard 共用这两个函数,不必各写一份 fetch。
export async function continueAutomation(kind: "goal" | "loop", id: string, feedback?: string): Promise<{ ok: boolean }> {
  return post(`/${kind}s/${id}/continue`, feedback ? { feedback } : {});
}

export async function sendAutomationFeedback(kind: "goal" | "loop", id: string, text: string): Promise<{ ok: boolean; note?: string }> {
  return post(`/${kind}s/${id}/feedback`, { text });
}

// 澄清模式(头脑风暴):CEO 顾问口吻分析粗略目标,回一批澄清问题(带选项 + 允许填空)+ 验收标准建议 +
// 一句话理解——BriefingPanel 渲染成"澄清卡",用户答完组装成增强目标文本回填输入框。
export interface ClarifyQuestion { q: string; options: string[]; allowFree: boolean }
export interface ClarifyResponse { questions: ClarifyQuestion[]; draftCriteria: string[]; summary: string }
export async function clarify(goal: string, companyId?: string): Promise<ClarifyResponse> {
  return post("/clarify", { goal, companyId });
}

// Mission(Plan 模式产出的简报)——用户意图三层(Chat/Plan/Execute)改造契约,见 BriefingPanel/
// MissionBriefCard。字段结构与后端 apps/server/src/routes/missionRoutes.ts 的 MissionBrief 保持同步
// (前后端并行开发,这里手动镜像,不跨包引入 server 类型,与 automationTypes.ts 的既有做法一致)。
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
  suggestedRunType: RunType;
  suggestedTeamMode?: TeamMode;
  permissionNeeds: "no_code" | "propose_only" | "write_code" | "external_actions";
  approvalStatus: "draft" | "approved" | "stopped";
  complexityEstimate?: TaskComplexityEstimate | null; // E1:服务端创建/approve 时置入(旧 mission 缺省)
}

export interface MissionDispatch { kind: "run" | "goal" | "loop"; id: string }
// dispatched:经典 run/goal 派发路径;taskGraphId/graph:dispatchMode="task-graph" 路径
// (missionRoutes A2 分支,响应体是 commit 时刻的图快照)——两条路径互斥,各自 optional。
export interface MissionApproveResponse {
  approved: boolean;
  dispatched?: MissionDispatch;
  taskGraphId?: string;
  graph?: TaskGraph;
  queued?: boolean;
  queuePosition?: number;
}

export async function createMission(ideaText: string, companyId?: string): Promise<MissionBrief> {
  return post("/missions", { ideaText, companyId });
}

export async function updateMission(id: string, patchBody: Partial<MissionBrief>): Promise<MissionBrief> {
  return patch(`/missions/${id}`, patchBody);
}

export async function approveMission(id: string, overrides?: { runType?: RunType; teamMode?: MissionTeamModeOverride; dispatchMode?: "task-graph" }): Promise<MissionApproveResponse> {
  return post(`/missions/${id}/approve`, overrides ?? {});
}

// B6 · 任务图查询(拆解树消费):404 = 该 mission 未走任务图派发路径(调用方整卡不渲染,绝不空态假装有图)。
export async function getMissionTaskGraph(id: string): Promise<TaskGraph> {
  return get(`/missions/${encodeURIComponent(id)}/task-graph`);
}

export async function stopMission(id: string): Promise<{ stopped: boolean }> {
  return post(`/missions/${id}/stop`, {});
}

export async function getMission(id: string): Promise<MissionBrief> {
  return get(`/missions/${id}`);
}

export async function listMissions(companyId?: string): Promise<MissionBrief[]> {
  return get(`/missions${companyId ? `?companyId=${encodeURIComponent(companyId)}` : ""}`);
}

// Track C · C2 CEO 驾驶舱聚合状态(契约见 apps/server/src/routes/ceoRoutes.ts 的 CeoStatusResponse,
// 本地镜像形状,不跨包引入 server 内部类型——与 MissionBrief 等既有做法一致;complexityEstimate 是
// @opc/shared 的 E1 类型,直接复用)。BriefingPanel 的 CEO 驾驶舱区块消费它。
export interface CeoStatusMission {
  id: string;
  goal: string;
  approvalStatus: "draft" | "approved" | "stopped";
  createdAt: string;
  complexityEstimate: TaskComplexityEstimate | null;
}
export interface CeoStatusWaitingAgent { id: string; name: string; role: string; currentActivity?: string }
export interface CeoStatus {
  schemaVersion: string;
  companyId: string;
  mission: CeoStatusMission | null;
  waitingOn: CeoStatusWaitingAgent[];
  activeRun: { runId: string; startedAt: string; goal: string } | null;
  lastFailure: {
    runId: string; endedAt?: string; postmortemAvailable: boolean;
    topCause?: string; topSuggestion?: string;
    // #32 · 结构化 i18n:有键则按 postmortem.cause.*/postmortem.suggestion.* 词典渲染,无键回退原文。
    topCauseKey?: string; topCauseParams?: Record<string, string>;
    topSuggestionKey?: string; topSuggestionParams?: Record<string, string>;
  } | null;
  todayTokens: number;
}
export async function getCeoStatus(companyId: string): Promise<CeoStatus> {
  return get(`/ceo/status?companyId=${encodeURIComponent(companyId)}`);
}

// E3/E4 · Run Governance(契约见 apps/server/src/storage/governanceStore.ts 的 GovernanceRecord 与
// apps/server/src/routes/governanceRoutes.ts,本地镜像最小子集,不跨包引入 server 内部类型)。
export interface GovernanceRecordLite {
  runId: string;
  level: string;
  reason: string[];
  decidedAt: string;
  inputs?: { goalPreview?: string; companyId?: string };
  approvalRequired?: boolean;
  approval?: { status: "pending" | "approved" | "rejected"; decidedAt?: string; decidedBy?: string };
}
export async function listGovernanceRecords(limit = 50): Promise<GovernanceRecordLite[]> {
  return get(`/governance/records?limit=${limit}`);
}
// approve:批准即派发(record 带 pendingDispatch 时);dispatched:false + retryable:true = 撞上单 run
// 互斥闸,run 保持 pending,稍后重打 approve 即重试派发。
export async function approveGovernanceRun(runId: string): Promise<{ approved: boolean; dispatched: boolean; retryable?: boolean; record: GovernanceRecordLite }> {
  return post(`/governance/runs/${encodeURIComponent(runId)}/approve`, {});
}
export async function rejectGovernanceRun(runId: string): Promise<{ rejected: boolean; record: GovernanceRecordLite }> {
  return post(`/governance/runs/${encodeURIComponent(runId)}/reject`, {});
}

// Memory Pack(统一记忆投影,契约见 apps/server/src/runtime/memoryPack.ts)——本地镜像 server 内部类型
// 形状,不跨包引入(与 MissionBrief 等既有做法一致)。scope 是组织架构维度(非子系统原生 scope 术语)。
export type MemoryPackScope = "employee" | "department" | "company" | "workspace" | "run";

export interface MemoryPackItem {
  memoryId: string;
  scope: MemoryPackScope;
  kind: string;
  content: string;
  sourceRunId?: string;
  confidence?: number;
  whySelected: string;
}

export interface MemoryPackResult {
  items: MemoryPackItem[];
  countsByScope: Record<MemoryPackScope, number>;
  generatedAt: string;
}

// 某个 agent(按其 role/companyId/所属团队)当前能检索到的完整记忆投影——员工页"记忆"面板用。
export async function getAgentMemories(agentId: string): Promise<MemoryPackResult> {
  return get(`/agents/${agentId}/memories`);
}

// P3 · 公司级安全摘要导出(契约见 apps/server/src/routes/memoryRoutes.ts 的 /api/companies/:id/memory-digest):
// 只取 committed 教训,按 confidence+recency 打分取 top N,已脱敏(sanitizeMemoryText)。practices 服务端
// 恒返回空数组(procedural_skill 暂无可对外描述字段,如实留空,未来有数据源再补),前端按空态渲染即可。
export interface MemoryDigestPractice { id: string; text: string }
export interface MemoryDigestLesson { id: string; text: string; confidence: number; safeToShare: boolean }
export interface MemoryDigestResult {
  practices: MemoryDigestPractice[];
  lessons: MemoryDigestLesson[];
  generatedAt: string;
}
export async function getMemoryDigest(companyId: string, limit = 3): Promise<MemoryDigestResult> {
  return get(`/companies/${encodeURIComponent(companyId)}/memory-digest?limit=${limit}`);
}

// 意图分类(Auto 模式发送前调用):短超时(默认 3s)+ AbortController——超时/失败都由调用方 catch
// 后静默当 chat 处理,不拿网络问题打断用户(见 BriefingPanel handleSend 的 auto 分支)。
export interface IntentClassifyResponse { mode: "chat" | "plan" | "execute"; confidence: number }
export async function classifyIntent(text: string, timeoutMs = 3000): Promise<IntentClassifyResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + "/intent/classify", {
      method: "POST", headers: await authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text }), signal: ctrl.signal,
    });
    if (!r.ok) throw await httpError(r);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// 归档(契约见 apps/server/src/routes/archiveRoutes.ts):归档=把公司/run 记录**移动**到
// .opc/archive/<ts>/ 并写 manifest,可随时恢复,绝不删除任何证据文件。有在飞 run 时服务端 409。
export interface ArchiveListItem {
  archiveId: string;
  kind: "company" | "runs";
  id: string;
  name?: string;
  archivedAt: string;
  runCount: number;
  agentCount: number;
  restoredAt?: string;
}
export async function listArchives(): Promise<ArchiveListItem[]> {
  return get("/archive");
}
export async function archiveCompany(companyId: string): Promise<{ archived: boolean; archiveId: string; runCount: number; agentCount: number }> {
  return post(`/archive/company/${encodeURIComponent(companyId)}`, {});
}
export async function archiveRuns(runIds: string[]): Promise<{ archived: boolean; archiveId: string; runCount: number }> {
  return post("/archive/runs", { runIds });
}
export async function restoreArchive(archiveId: string): Promise<{ restored: boolean; archiveId: string; kind: string; runCount: number; agentCount: number }> {
  return post(`/archive/${encodeURIComponent(archiveId)}/restore`, {});
}

// 会话历史的最小形状(role: user/assistant + 文本)——架构对话、日常任务拆解两处都用同一个形状发
// history,不绑定任何领域语义,不为这两行结构体分两份几乎相同的类型。
export interface ConversationTurn { role: "user" | "assistant"; content: string }

// 架构助手(公司架构模式,2026-07 第四版·最终定调):对话模式(architectChat,纯问答)+ 执行模式
// (architectDecompose + architectApply,见下方,与日常任务对话共用 taskDecompose 同一份骨架)两个
// 模式都有。ArchitectAction 判别式联合本地镜像 server 内部类型形状(与 MissionBrief 等既有做法一致,
// 不跨包引入 apps/server 内部模块),字段需与 apps/server/src/runtime/architectAssistant.ts 的
// ArchitectActionSchema 保持同步。全部 action 都用公司内唯一的 agent「名字」而非 id 做人类可读引用。
export type ArchitectAction =
  | { type: "add_agent"; role: string; name: string; reportsToName?: string; provider?: string; model?: string }
  | { type: "remove_agent"; name: string }
  | { type: "update_agent"; name: string; newName?: string; role?: string; provider?: string; model?: string; framework?: string; reportsToName?: string; workingDirectory?: string | null; systemPrompt?: string | null; visibilityPolicy?: "default" | "isolated" | "game" | null; reasoningEffort?: "low" | "medium" | "high" | "xhigh" | null; enabled?: boolean }
  | { type: "add_verification_edge"; producerName: string; verifierName: string; method: "llm-review" | "code-review" | "fact-check" | "custom"; onReject?: "redo" | "flag"; maxRounds?: number }
  | { type: "remove_verification_edge"; producerName: string; verifierName: string }
  | { type: "add_a2a_channel"; fromName: string; toName: string; purpose?: string }
  | { type: "remove_a2a_channel"; fromName: string; toName: string }
  | { type: "upsert_bundled_skill"; skillName: string; description?: string; content: string; roles: string[] }
  | { type: "remove_bundled_skill"; skillName: string }
  | { type: "update_company_governance"; visibilityPolicy?: "default" | "isolated" | "game" | null; recommendedConfig?: { defaultModel?: string; budget?: { totalUsd: number; maxTokensPerTask: number; maxAttemptsPerTask?: number; taskTimeoutMs?: number; maxTokensPerRun?: number; maxTokensTotal?: number }; maxTokensPerTask?: number; permissions?: { allowShell: boolean; allowFileWrite: boolean; allowWebAccess: boolean } } | null; requiredPermissions?: { allowShell?: boolean; allowFileWrite?: boolean; allowWebAccess?: boolean; mcpServers?: string[] } | null; toolRequirements?: { requiredEngines: string[]; requiredProviders: string[]; requiredMcpServers: string[]; requiredSkills: string[]; optionalTools: string[] } | null; mcpRequirements?: Array<{ name: string; purpose?: string; optional?: boolean }> | null };

// 对话模式,纯问答——响应类型本身就不带 actions 字段(端点级硬保证:这个对话框绝不产出可执行的
// 变更,不是前端拿到 actions 后自己选择不渲染那种软保证)。
// ceoName:这场架构对话背后真实 CEO 的名字(和 /api/chat 同一身份解析,见 chatRoutes.ts 的
// resolveCeoForChat)——前端用它把气泡显示成"和 CEO 对话"而不是一个和 CEO 无关的通用身份。
export interface ArchitectChatResponse { reply: string; ceoName?: string }
export async function architectChat(companyId: string, message: string, history?: ConversationTurn[]): Promise<ArchitectChatResponse> {
  return post(`/companies/${encodeURIComponent(companyId)}/architect-chat`, { message, history });
}

// 用户确认后真正落地。令三.4·高危一次性 confirmation token 门(替换旧的客户端布尔 confirmHighRisk):
// 首次不带 token,服务端命中高危(删员工/A2A/权限扩大)返回 428 + {highRisk, confirmationToken};前端弹
// 确认层后把该后端签发的一次性 token 原样带回重发。重放/过期/换 actions → 428 重新签发。
export interface ArchitectApplyResult { action: ArchitectAction; ok: boolean; reason?: string }
export interface ArchitectApplyResponse { results: ArchitectApplyResult[]; company: Company; agents: AgentNodeConfig[]; proposalId: string; txId: string }
export async function architectApply(companyId: string, proposalId: string, confirmationToken?: string): Promise<ArchitectApplyResponse> {
  return post(`/companies/${encodeURIComponent(companyId)}/architect-apply`, { proposalId, ...(confirmationToken ? { confirmationToken } : {}) });
}

// 日常任务对话的"执行模式"三段式,stage①②(简报栏 BriefingPanel 使用):一句话需求 → 该公司
// Leader(没有则 CEO 兜底)拆解成"选择题"(needsChoice=true,finalTask 为空)或"直接给出最终任务
// 描述"(needsChoice=false,finalTask 是待确认后派发的任务文本)。stage③不在这里——前端拿到
// finalTask 后直接调已有的 chatTask(/api/chat/task),不新建一套派发逻辑。
export interface TaskDecomposeQuestion { question: string; options: string[] }
export interface TaskDecomposer { agentId: string; name: string; role: "lead" | "ceo"; fallbackToCeo: boolean }
export interface TaskDecomposeResponse {
  summary: string;
  needsChoice: boolean;
  questions: TaskDecomposeQuestion[];
  finalTask: string;
  decomposer: TaskDecomposer;
}
export async function taskDecompose(companyId: string, message: string, history?: ConversationTurn[]): Promise<TaskDecomposeResponse> {
  return post(`/companies/${encodeURIComponent(companyId)}/task-decompose`, { message, history });
}

// 架构对话的执行模式 stage①②——同一份 TaskDecomposeQuestion/TaskDecomposer 类型复用(骨架不分领域,
// 见 apps/server/src/runtime/taskDecomposer.ts 的注释),只是"最终产出"换成 actions(结构性修改
// 方案)而不是 finalTask(任务描述文本)。与日常任务不同:actions 为空数组本身就是合法结果("想清楚
// 了,不需要做任何改动"),不代表拆解失败。stage③不在这里——前端拿到 actions 后直接调已有的
// architectApply,不新建一套落地逻辑。
export interface ArchitectDecomposeResponse {
  summary: string;
  needsChoice: boolean;
  questions: TaskDecomposeQuestion[];
  actions: ArchitectAction[];
  proposalId?: string;
  actionsHash?: string;
  beforeHash?: string;
  expiresAt?: string;
  architectSkill?: { id: string; version: string };
  decomposer: TaskDecomposer;
}
export async function architectDecompose(companyId: string, message: string, history?: ConversationTurn[]): Promise<ArchitectDecomposeResponse> {
  return post(`/companies/${encodeURIComponent(companyId)}/architect-decompose`, { message, history });
}

// B6 · A2A 消息读侧(a2a_messages.jsonl 的 last-wins 合并快照,契约见 apps/server/src/routes/a2aRoutes.ts
// GET /api/runs/:id/a2a-messages)。本地镜像最小子集(同 MissionBrief 等做法,不跨包引 server 内部类型);
// lifecycle 终态 "resolved" = 该协作事项已闭环。CapabilityOverview 的 resolved 闭环指标消费它。
export interface A2AMessageLite {
  id: string;
  runId?: string;
  from: string;
  to?: string[];
  messageType?: string;
  lifecycle: string;
  text: string;
  timestamp: string;
}
export async function getRunA2AMessages(runId: string): Promise<{ runId: string; messages: A2AMessageLite[] }> {
  return get(`/runs/${encodeURIComponent(runId)}/a2a-messages`);
}
