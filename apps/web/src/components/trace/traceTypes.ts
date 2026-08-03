import type { TraceEvent } from "@opc/shared";

// 任务档案(原"追踪/历史")共用类型 + 纯派生分类逻辑。从 TracePage.tsx 抽出，
// 供列表卡(TaskListView/TaskCard)与详情三段式(ResultSection/ProcessTimeline/BillingSection)复用。

export interface TimelineItem {
  seq: number;
  type: string;
  at: string;
  agentId?: string;
  summary?: string;
}

export interface RunSummary {
  runId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  participatingAgents: string[];
  totalEvents: number;
  eventTypeCounts: Record<string, number>;
  degraded: boolean;
  deferred: string[];
  rejectedArtifacts: string[];
  stuckModules: string[];
  timeline: TimelineItem[];
}

// run 级元数据(task.json 直接读盘)——GET /api/runs/:id 返回。除了徽章判定所需的
// status/degraded/degradedReason 外，还带 tokens/花费/参与者/结束时间，供列表卡摘要与
// 详情页③账单直接用，不必另开 cost 相关请求。
export interface RunTaskMeta {
  status?: string;
  degraded?: boolean;
  degradedReason?: string;
  userGoal?: string;
  participatingAgents?: string[];
  totalTokens?: number;
  totalCostUsd?: number;
  startedAt?: string;
  endedAt?: string;
  // MUP 波1/2 加性字段(task.json 直读;老 run 缺省=无新语义,绝不虚构):
  simulated?: boolean;
  finalState?: RunFinalState;
  partialDelivery?: boolean;
  mergeConflicts?: RunMergeConflict[];
  deliveryAcceptance?: { status: string; reasons?: string[]; requiresCode?: boolean; requiresTests?: boolean; partialDelivery?: true };
}

// Gate A#3 · 未决合并冲突条目(shared Run.mergeConflicts 同形状;taskId="__finalize"=run 分支回并冲突)。
export interface RunMergeConflict { taskId: string; agentId: string; files: string[] }

// GET /api/runs 走服务端滚动索引(P2#7),富字段直接随列表返回——任务卡零补数请求;
// 旧格式索引行可能缺这些字段(undefined),TaskListView 对缺字段行退回逐卡补拉。
export interface RunListItem {
  id: string; goal: string; status: string; startedAt: string; companyId?: string;
  degraded?: boolean; degradedReason?: string; endedAt?: string;
  totalTokens?: number; totalCostUsd?: number;
  agents?: number; agentIds?: string[]; summary?: string; partial?: boolean;
  // MUP 加性(服务端索引尚未投影这两列时为 undefined——诚实缺省,列表卡回退实时事件流派生):
  simulated?: boolean; finalState?: RunFinalState;
}

// 产物(artifact)展示。
// B5c:status 是后端保留的历史兼容字段(混装"变更类型"与"验收结论"两套语义,见 shared types.ts 注释)。
// changeType/reviewStatus 是新的双字段;老 run(无 artifacts.json 走 Stage 2 派生)可能没有,故都设为可选。
export interface RunArtifact {
  id: string; kind: string; title: string; producer?: string; producerRole?: string;
  status: string; reason?: string; downloadUrl?: string; inFinalDeliverable: boolean;
  changeType?: "added" | "modified" | "deleted";
  reviewStatus?: "pending" | "accepted" | "rejected" | "degraded";
  lineage?: Array<{ sourceId: string; relationship: string; via?: string }>;
}

// B5c:展示态优先由新双字段算出,取不到(老 run 无新字段)兜底旧 status——与后端
// buildRunArtifactCollection 的构造规则等价推导,纯前端展示不变(色值/可下载判定/徽标文案照旧)。
export function artifactDisplayStatus(a: RunArtifact): string {
  if (a.reviewStatus === "rejected") return "rejected";
  if (a.changeType) return a.changeType;
  if (a.reviewStatus === "degraded") return "degraded";
  if (a.reviewStatus === "accepted") return a.kind === "report" ? "final" : "accepted";
  return a.status;
}

// v7 高级感 pass: 事件/徽章/产物状态色统一收敛到 4 个 muted 语义色(success/warning/error/info)+
// accent + 中性灰——不再有 teal/橙/粉/天蓝等散落的第三方色相(以前 module_stuck 单独一个橙、
// artifact_rejected 单独一个粉、memory_* 单独一个 teal，肉眼看像调色盘炸了)。同 index.css 的
// --color-success/warning/error 保持同一套色值。
// 导出给其他 trace/* 组件复用(如 ChangesSection 的 create/modify/delete 徽标),不再各自硬编码色值。
export const SUCCESS = "var(--color-success)";
export const WARNING = "var(--color-warning)";
export const ERROR = "var(--color-error)";
const INFO = "var(--color-info)";

// 按事件类型上色。关键降级/失败类用暖/红色，正常进度用绿/蓝，其余落到中性默认。
export const TYPE_COLORS: Record<string, string> = {
  run_started: SUCCESS,
  run_finished: "var(--color-accent)", // 唯一 accent——"最终产出"是这套配色里少数值得用 accent 强调的语义
  agent_deferred: WARNING,
  worker_timeout: ERROR,
  workspace_quota_exceeded: ERROR,
  artifact_rejected: ERROR,
  deliverable_degraded: ERROR,
  module_stuck: ERROR,
  memory_committed: INFO,
  memory_proposal_rejected: WARNING,
};
export const DEFAULT_TYPE_COLOR = "var(--color-ink-subtle)";

// 领域事件"人话高亮"——服务端把这些发成 type:"info"/"error" + payload.kind（或 lesson_* 直接是 type）。
// 静态历史快照(TIMELINE_TYPES)不含它们，只有实时事件流才看得到；此处统一识别、上色、i18n 文案。
// Bug 修复:这里之前只覆盖了 5 种 kind,漏了后端 TIMELINE_INFO_KINDS(runHistoryStore.ts)里的
// synth_fair_share/conclusion_summary——静态历史快照(/trace)能看到这两种事件(后端按 kind 收进
// timeline),但实时直播视图的 isDomainLiveEvent 只认 KIND_I18N 里有的 kind,导致同一类事件"历史看
// 得到、直播看不到",且历史视图里因为查不到 i18n key 会退化显示原始 kind 字符串(如 "synth_fair_share")。
export const KIND_I18N: Record<string, string> = {
  timeout_salvage: "trace.domain.timeoutSalvage",
  merge_theirs: "trace.domain.mergeTheirs", // 保留:存量 run 的历史强并事件仍要可读
  team_mismatch: "trace.domain.teamMismatch",
  plan_template_injected: "trace.domain.planTemplateInjected",
  plan_template_saved: "trace.domain.planTemplateSaved",
  synth_fair_share: "trace.domain.synthFairShare",
  conclusion_summary: "trace.domain.conclusionSummary",
  // MUP 波1 · Gate A 状态诚实事件(后端 TIMELINE_INFO_KINDS 同步收进历史时间线,前端此处对齐)
  merge_conflict_requires_review: "trace.domain.mergeConflictRequiresReview",
  dirty_workspace_at_start: "trace.domain.dirtyWorkspaceAtStart",
  simulated_run: "trace.domain.simulatedRun",
  run_requires_review: "trace.domain.runRequiresReview",
};
export const KIND_COLOR: Record<string, string> = {
  timeout_salvage: WARNING,
  merge_theirs: ERROR,
  team_mismatch: WARNING,
  plan_template_injected: INFO,
  plan_template_saved: INFO,
  synth_fair_share: WARNING,
  conclusion_summary: INFO,
  merge_conflict_requires_review: ERROR,
  dirty_workspace_at_start: WARNING,
  simulated_run: "#8b6ec4", // 与 SIMULATED_BADGE.color 同色(lib/executorBadge.ts)
  run_requires_review: ERROR,
};
export const LESSON_I18N: Record<string, string> = {
  lesson_proposed: "trace.domain.lessonProposed",
  lesson_committed: "trace.domain.lessonCommitted",
  lesson_repeated: "trace.domain.lessonRepeated",
  lesson_revoked: "trace.domain.lessonRevoked",
  lesson_injected: "trace.domain.lessonInjected",
};
export const LESSON_COLOR: Record<string, string> = {
  lesson_proposed: DEFAULT_TYPE_COLOR, lesson_committed: SUCCESS, lesson_repeated: WARNING,
  lesson_revoked: ERROR, lesson_injected: INFO,
};
export function eventColor(type: string, kind?: string): string {
  if (kind && KIND_COLOR[kind]) return KIND_COLOR[kind];
  if (LESSON_COLOR[type]) return LESSON_COLOR[type];
  return TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR;
}
export function eventLabelKey(type: string, kind?: string): string | undefined {
  if (kind && KIND_I18N[kind]) return KIND_I18N[kind];
  return LESSON_I18N[type];
}

// 服务端历史快照(loadRunSummary)只把这些类型收进 timeline；实时流额外把上面 KIND_I18N 覆盖的
// info/error 领域事件也纳入(静态快照永远看不到它们——这是当前后端的已知缺口，见收尾报告)。
export const DOMAIN_TIMELINE_TYPES = new Set([
  "run_started", "run_finished",
  "agent_deferred", "worker_timeout", "workspace_quota_exceeded",
  "artifact_rejected", "deliverable_degraded", "module_stuck",
  "memory_committed", "memory_proposal_rejected",
  "lesson_proposed", "lesson_committed", "lesson_repeated", "lesson_revoked", "lesson_injected",
]);
export function isDomainLiveEvent(e: TraceEvent): boolean {
  if (DOMAIN_TIMELINE_TYPES.has(e.type)) return true;
  const kind = (e.payload as Record<string, unknown> | null | undefined)?.kind;
  return typeof kind === "string" && kind in KIND_I18N;
}

// 归一化后的时间线行——静态快照(TimelineItem)与实时事件(TraceEvent)统一渲染。
export interface NormEvent { key: string; seq?: number; type: string; kind?: string; at: string; agentId?: string; message?: string; }
export function normalizeStatic(item: TimelineItem): NormEvent {
  return { key: `${item.seq}-${item.type}`, seq: item.seq, type: item.type, at: item.at, agentId: item.agentId, message: item.summary };
}
export function normalizeLive(e: TraceEvent): NormEvent {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const kind = typeof p.kind === "string" ? p.kind : undefined;
  const message = typeof p.message === "string" ? p.message
    : typeof p.lastError === "string" ? p.lastError
      : typeof p.reason === "string" ? p.reason : undefined;
  return { key: e.id, type: e.type, kind, at: e.timestamp, agentId: e.agentId, message };
}
export const LIVE_TAIL = 200; // 性能:进行中 run 只渲染尾部 N 条领域事件，避免长跑任务把 DOM 撑爆。

// 过程回放"故事化"折叠——默认只显示关键节点(派工/产出/异常/交付)，次要的记忆/模板记账类事件
// 折进"显示全部"。判定同时兼顾 type(lesson_* 等在静态快照里就是顶层 type)与 kind(仅实时流才有)。
const FOLDABLE_TYPES = new Set(["memory_committed", "memory_proposal_rejected", "lesson_proposed", "lesson_injected"]);
const FOLDABLE_KINDS = new Set(["plan_template_injected", "plan_template_saved"]);
export function isKeyTimelineEvent(item: NormEvent): boolean {
  if (item.kind && FOLDABLE_KINDS.has(item.kind)) return false;
  return !FOLDABLE_TYPES.has(item.type);
}

// run 状态徽章——"诚实执行"在 UI 上的落点:done/failed/running 之外，
// 降级(task.json degraded)与被中断(degradedReason 含"进程重启")必须能被用户一眼看到，不能被 done/failed 掩盖。
export type BadgeKey = "done" | "failed" | "running" | "degraded" | "interrupted" | "queued" | "cancelled";
// v7: 徽章渲染分散在 3 个组件里(TaskCard/BriefingPanel/ChatReplay),都是"实底 + 硬编码 text-white"
// ——这里够不到那几个组件的 JSX，只能在色值层面落这版设计的退而求其次方案：把"彩色实底"换成
// "同 hue 半透明底"(rgba，而不是纯 hex)。白字落在这层半透明底上(底下透出的还是近黑的画布/卡片色)
// 依然读得清楚，但不再是刺眼的纯色色块——这是"廉价感"消掉的大头。degraded/interrupted 两个"不能被
// done/failed 盖过去"的状态刻意留高一点的不透明度，保持视觉优先级。
export const BADGE_COLOR: Record<BadgeKey, string> = {
  done: "color-mix(in srgb, var(--color-success) 22%, transparent)",
  failed: "color-mix(in srgb, var(--color-error) 22%, transparent)",
  running: "color-mix(in srgb, var(--color-info) 22%, transparent)",
  degraded: "color-mix(in srgb, var(--color-warning) 26%, transparent)",
  interrupted: "color-mix(in srgb, var(--color-error) 34%, transparent)",
  queued: "color-mix(in srgb, var(--color-ink-subtle) 28%, transparent)", // P1-5:排队中——中性灰,区别于"运行中"(蓝),不喧宾夺主
  cancelled: "color-mix(in srgb, var(--color-ink-subtle) 22%, transparent)", // 撤销/驳回的中性终态:用户主动行为,不是红色失败
};
export const BADGE_LABEL_KEY: Record<BadgeKey, string> = {
  done: "trace.status.done", failed: "trace.status.failed", running: "trace.status.running",
  degraded: "trace.status.degraded", interrupted: "trace.status.interrupted", queued: "trace.status.queued",
  cancelled: "trace.status.cancelled",
};
export function resolveBadge(status: string | undefined, degraded: boolean | undefined, degradedReason: string | undefined): BadgeKey {
  // 撤销是用户/治理的主动行为,中性终态优先于 failed/degraded:队列撤单落 failed+reason 含"撤销",
  // 治理驳回落 status=cancelled(且 degraded=true),两条路都不该渲染成红"失败"或琥珀"降级"。
  if (status === "cancelled" || (degradedReason && degradedReason.includes("撤销"))) return "cancelled";
  if (degradedReason && degradedReason.includes("进程重启")) return "interrupted";
  if (status === "failed") return "failed";
  if (degraded || status === "degraded") return "degraded"; // "degraded" 是 GET /runs 列表端点在 status 缺失时拼的兜底字符串
  if (status === "running" || status === "pending") return "running";
  return "done";
}

// 定稿 2.2 · executor 徽章:外部订阅引擎(claude-code/codex)本次 run 实际走的执行后端。
//   "acp"        —— 自研 worker 经 ACP 执行(首选路径),徽章"ACP"(专有名词,不入 i18n)。
//   "legacy_cli" —— ACP spawn/握手失败后降级到既有 CLI-spawn 路径,徽章复用"降级"文案(trace.status.degraded)。
// 数据源:后端在选路点 emit 的 info 事件(payload.kind==="executor_selected", executor)。派生自实时事件流
// (deriveRunExecutors),历史 run 的事件不在 store 里则无徽章(优雅缺省,不虚构)。
export type RunExecutor = "acp" | "legacy_cli";
export const EXECUTOR_BADGE: Record<RunExecutor, { label?: string; labelKey?: string; color: string }> = {
  acp: { label: "ACP", color: INFO },
  legacy_cli: { labelKey: "trace.status.degraded", color: WARNING },
};
// 从事件流派生 runId → executor。同 run 多次选路时"降级(legacy_cli)"粘滞覆盖 acp——只要有一条腿降级,
// 卡片就如实标降级(诚实呈现,不被 acp 盖过)。
export function deriveRunExecutors(events: TraceEvent[]): Record<string, RunExecutor> {
  const map: Record<string, RunExecutor> = {};
  for (const e of events) {
    if (e.type !== "info" || !e.runId) continue;
    const p = e.payload as Record<string, unknown> | null | undefined;
    if (!p || p.kind !== "executor_selected") continue;
    const ex = p.executor;
    if (ex !== "acp" && ex !== "legacy_cli") continue;
    if (map[e.runId] === "legacy_cli") continue; // 降级粘滞:不被后续 acp 覆盖
    map[e.runId] = ex;
  }
  return map;
}

// MUP 波1 · finalState(deriveFinalRunState 唯一收敛出口)徽章。数据源两路:
//   ① task.json 加性字段 run.finalState(GET /runs/:id);② run_finished 事件 payload.finalState(实时流)。
// 老 run 缺省=无徽章(不虚构)。failed/degraded 与 resolveBadge 的状态徽章语义重叠时由消费方去重
// (finalStateBadgeFor),避免同一张卡出现两个"降级/失败"。
// 选1(降级·07-14):tests_passed=独立测试通过的编码交付诚实终态(前端显"独立测试通过",非"已验证生产逻辑")。
// verified 保留供旧 run + 非编码 not_required(文案已改"已完成");执行观测 verified 已退役,新编码 run 收 tests_passed。
export type RunFinalState = "verified" | "tests_passed" | "degraded" | "failed" | "requires_review";
export const FINAL_STATE_BADGE: Record<RunFinalState, { labelKey: string; color: string }> = {
  tests_passed: { labelKey: "trace.status.testsPassed", color: SUCCESS },
  verified: { labelKey: "trace.status.verified", color: SUCCESS },
  degraded: { labelKey: "trace.status.degraded", color: WARNING },
  failed: { labelKey: "trace.status.failed", color: ERROR },
  requires_review: { labelKey: "trace.status.requiresReview", color: ERROR },
};
// DeliveryAcceptanceStatus 的展示键(仅接了文案的子集;其余状态由 reasons 原文兜底展示)。
export const ACCEPTANCE_STATUS_I18N: Record<string, string> = {
  simulated_run: "trace.status.simulated",
  tests_ran_unbound: "trace.acceptance.testsRanUnbound",
};
export function deriveRunFinalStates(events: TraceEvent[]): Record<string, RunFinalState> {
  const map: Record<string, RunFinalState> = {};
  for (const e of events) {
    if (e.type !== "run_finished" || !e.runId) continue;
    const fs = (e.payload as { finalState?: unknown } | null | undefined)?.finalState;
    if (fs === "verified" || fs === "tests_passed" || fs === "degraded" || fs === "failed" || fs === "requires_review") map[e.runId] = fs;
  }
  return map;
}
// 状态徽章已表达 failed;degraded 与状态徽章重复时也略过——只补充状态徽章没说的真相。
export function finalStateBadgeFor(finalState: RunFinalState | undefined, statusBadge: BadgeKey): RunFinalState | undefined {
  if (!finalState || finalState === "failed") return undefined;
  if (finalState === "degraded" && statusBadge === "degraded") return undefined;
  return finalState;
}
// Gate A#3 · 实时流的未决冲突派生:run_requires_review 事件 payload.conflicts(orchestrator 收尾 emit,
// ≤20 条截断)。历史 run 走 task.json 的 mergeConflicts 全量。
export function deriveRunMergeConflicts(events: TraceEvent[]): Record<string, RunMergeConflict[]> {
  const map: Record<string, RunMergeConflict[]> = {};
  for (const e of events) {
    if (e.type !== "info" || !e.runId) continue;
    const p = e.payload as { kind?: unknown; conflicts?: unknown } | null | undefined;
    if (p?.kind !== "run_requires_review" || !Array.isArray(p.conflicts)) continue;
    map[e.runId] = p.conflicts.filter((c): c is RunMergeConflict =>
      !!c && typeof (c as RunMergeConflict).taskId === "string" && Array.isArray((c as RunMergeConflict).files));
  }
  return map;
}

export const ART_STATUS_COLOR: Record<string, string> = {
  final: "var(--color-accent)", accepted: SUCCESS, added: INFO, modified: INFO,
  degraded: WARNING, rejected: ERROR, deleted: DEFAULT_TYPE_COLOR,
};
export const KIND_LABEL_KEY: Record<string, string> = {
  report: "trace.artifactKind.report", file: "trace.artifactKind.file",
  "worker-output": "trace.artifactKind.workerOutput", "review-result": "trace.artifactKind.reviewResult",
};
export const DOWNLOADABLE = new Set(["final", "degraded", "accepted", "added", "modified"]);

// 记忆包(Memory Pack)· run 级使用情况——GET /api/runs/:id/memory-pack 返回形状，纯派生自
// runtime/memoryPack.ts 的 deriveRunMemoryPackUsage(events.jsonl 里的 memory_pack_used info 事件)。
// 本地声明而非跨包引 server 内部类型，同 RunArtifact/RunSummary 等既有约定。
export type MemoryPackScope = "employee" | "department" | "company" | "workspace" | "run";
export interface AgentMemoryPackUsage {
  agentId?: string;
  role?: string;
  timestamp?: string;
  message?: string; // 人话摘要(服务端已生成,如"本轮 dev 使用了 2 条团队记忆"),兼当"内容预览"
  countsByScope: Record<MemoryPackScope, number>;
}
export interface RunMemoryPackUsage {
  runId: string;
  usages: AgentMemoryPackUsage[];
  totalByScope: Record<MemoryPackScope, number>;
}
export const MEMORY_SCOPE_LABEL_KEY: Record<MemoryPackScope, string> = {
  company: "trace.memoryPack.scope.company",
  department: "trace.memoryPack.scope.department",
  employee: "trace.memoryPack.scope.employee",
  workspace: "trace.memoryPack.scope.workspace",
  run: "trace.memoryPack.scope.run",
};
// 展示顺序:公司→部门→个人→跨公司→本次运行——由粗到细，与其余组织维度汇总(BriefingPanel 一眼条等)顺序一致。
export const MEMORY_SCOPE_ORDER: MemoryPackScope[] = ["company", "department", "employee", "workspace", "run"];
