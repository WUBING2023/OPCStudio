import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import {
  Send, Radio, ChevronRight, ChevronLeft, ChevronDown, ChevronUp, Timer,
  PanelBottom, PanelRight, Sparkles, X, MessageCircle, Rocket,
  ShieldAlert,
} from "lucide-react";
import type { TraceEvent, AgentNodeConfig, SkillMeta } from "@opc/shared";
import * as api from "../../api/client.js";
import type { GovernanceRecordLite, TaskDecomposeQuestion, TaskDecomposer } from "../../api/client.js";
import PostmortemModal, { type PostmortemData } from "../common/PostmortemModal.js";
import CeoCockpit, { useCeoStatus } from "../common/CeoCockpit.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useCockpitStore, type LocalMsg } from "../../store/useCockpitStore.js";
import { useRunStore } from "../../store/useRunStore.js";
import { useT } from "../../i18n.js";
import { cleanText } from "../../lib/text.js";
import MessageBubble, { type MessageBubbleVariant } from "../common/MessageBubble.js";
import DecomposerLine from "../common/DecomposerLine.js";
import ClarifyQuestionnaire from "../common/ClarifyQuestionnaire.js";
import AutoGrowTextarea from "../common/AutoGrowTextarea.js";
import { resolveBubbleIdentity, attributionFromDecomposer, type MessageAttribution } from "../../lib/messageAttribution.js";
import { BADGE_COLOR, BADGE_LABEL_KEY, resolveBadge, type BadgeKey } from "../trace/traceTypes.js";
import { pushToast } from "../common/Toast.js";
import AutomationPanel from "./AutomationPanel.js";
import { DEFAULT_COMPANY, type GoalRecord, type LoopRecord } from "./automationTypes.js";
import { isBusyStatus } from "../../lib/agentMeta.js";
import {
  isComposingSlash, slashQuery, parseSlash, matchCommands, findCommand, fetchEnabledSkills, matchSkills,
  type Command, type CommandContext,
} from "./commands.js";

// 技能角色徽标(同 SkillsPage.tsx 的本地小配色表——各处按自己需要各存一份，不为这几行抽公共模块)。
const SKILL_ROLE_KEY: Record<string, string> = {
  ceo: "skills.role.ceo", lead: "skills.role.lead", architect: "skills.role.architect",
  dev: "skills.role.dev", test: "skills.role.test", ops: "skills.role.ops", security: "skills.role.security",
};
const SKILL_ROLE_COLOR: Record<string, string> = {
  ceo: "#2563eb", lead: "#7c3aed", architect: "#0d9488", dev: "#3fae67", test: "#c99a52", ops: "#ca8a04", security: "#c9615c",
};

// 简报栏(OrgPage 常驻、可折叠、可拖拽调整宽/高、可停靠右侧栏或底部横栏):把 SSE 事件流译成人话气泡
// ("派工/产出/降级/交付…"),命令与汇报同一处——输入框走这里的 handleSend——这是组织页唯一的命令行。
//
// 模块边界(已定):组织页=指挥室(现在时直播),任务页/档案馆=报告唯一真源。简报栏因此绝不铺报告全文,
// run_finished 只渲染一张"报告卡片"(goal+徽章+一句话摘要+"查看报告→"),点击派发 open-task-run,
// 由 App/TracePage 已挂好的跨页契约切到任务页——真正的报告正文永远只活在任务档案。
//
// 2026-07 第二版修正(用户纠正:"对话/执行两模式 + 三段式流程"这套机制本该属于这里,上一轮误加在了
// 公司架构对话上):顶部只保留「对话」/「执行」两个模式按钮——
// - 对话:纯聊天(sendChatOnly,不派任务),不变。
// - 执行:三段式——①一句话需求 ②该公司 Leader(没有则 CEO 兜底)拆解,有真正分歧点就出选择题
//   确认,没有就直接给最终任务描述预览 ③用户确认后真正派发(复用既有的 POST /api/chat/task,不新建
//   一套派发逻辑),默认尊重公司各节点已经配置的模型,不再静默把整家公司覆盖成某个固定供应商。
// Harness/Loop 仍可通过 /harness /loop 斜杠命令触发(见 commands.ts),只是不再有专门的按钮式 setup
// 面板;技能附加("/" 面板 或 /skill 命令)同样不受这两个模式影响,两条路都还在。
const DOMAIN_KINDS = new Set([
  "timeout_salvage", "merge_theirs", "team_mismatch", "plan_template_injected", "plan_template_saved",
  "engine_mismatch", "memory_pack_used",
  "merge_conflict_requires_review", "dirty_workspace_at_start", "simulated_run", "run_requires_review",
]);

const MODE_OPTIONS: { key: "chat" | "exec"; icon: typeof MessageCircle; labelKey: string }[] = [
  { key: "chat", icon: MessageCircle, labelKey: "org.brief.intent.chat" },
  { key: "exec", icon: Rocket, labelKey: "org.brief.intent.execute" },
];

// GET /api/runs 索引行的最小子集(服务端 RunIndexEntry 的超集,这里只取简报卡需要的字段)——
// 本地声明而非从 traceTypes.ts 的 RunListItem 借用,因为那个类型缺 companyId(公司过滤的地基)。
interface RunRow {
  id: string; goal: string; status: string;
  degraded?: boolean; degradedReason?: string;
  summary?: string; partial?: boolean; companyId?: string;
}

interface FeedEntry {
  key: string;
  ts: string;
  variant: MessageBubbleVariant;
  name: string;
  role?: string;
  /** 发送者对应的真实 agent id(agent 类消息据此让名字/头像可点进单聊)。 */
  agentId?: string;
  /** 溯源:带产出者归属的系统消息(如"由 Leader 拆解的方案派发失败")。 */
  attributedTo?: MessageAttribution;
  content: string;
  card?: ReactNode;
}

// 规则化截断(不调 LLM):cleanText 去乱码前缀后按字符裁剪,裁了才补省略号。
function truncate(s: string, n: number): string {
  const c = cleanText(s);
  return c.length > n ? c.slice(0, n).trimEnd() + "…" : c;
}

// 报告卡片——run_finished 的唯一渲染形态(不放报告全文,只放"去哪看"的入口)。徽章配色/文案复用
// 任务档案同一套(BADGE_COLOR/BADGE_LABEL_KEY/trace.status.*),保持"同一个 run 在两个页面长得一样"。
function RunReportCard({ runId, goal, badge, hasPartial, summary }: {
  runId: string; goal: string; badge: BadgeKey; hasPartial: boolean; summary: string | undefined;
}) {
  const tr = useT();
  return (
    <div className="flex flex-col gap-1.5 min-w-[180px]">
      <div className="flex items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-ink leading-snug">{goal}</span>
        <span className="badge shrink-0 text-white" style={{ background: BADGE_COLOR[badge] }}>{tr(BADGE_LABEL_KEY[badge])}</span>
      </div>
      {hasPartial && (
        <span className="inline-flex items-center gap-1 text-[11px] w-fit text-amber">
          <Timer size={10} />{tr("trace.status.partial")}
        </span>
      )}
      <div className="text-[12px] text-ink-muted line-clamp-2">
        {summary === undefined ? tr("trace.summary.loading") : (summary || tr("trace.summary.placeholder"))}
      </div>
      <button
        onClick={() => window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId } }))}
        className="self-start text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity duration-150"
      >
        {tr("org.brief.card.viewReport")}
      </button>
    </div>
  );
}

// 执行模式预览卡——task-decompose 的渲染形态:决策拆解人披露 → 选择题(needsChoice)或最终任务预览
// (dispatchState),二选一。和 ArchitectChatPanel 里同款卡片同源(那边的三段式已经搬到这里),只是
// 最终产出从"一批 action"换成"一段任务描述文本",落地也换成真正派发任务而不是改架构。
function ExecPreviewCard({ decomposer, questions, questionsAnswered, finalTask, dispatchState, onSubmitAnswers, onDispatch, onDismiss, isRealAgent, tr }: {
  decomposer?: TaskDecomposer;
  questions?: TaskDecomposeQuestion[];
  questionsAnswered?: boolean;
  finalTask?: string;
  dispatchState?: "pending" | "dispatching" | "dispatched" | "dismissed" | "awaitingApproval";
  onSubmitAnswers: (summary: string) => void;
  onDispatch: () => void;
  onDismiss: () => void;
  isRealAgent: (id: string) => boolean;
  tr: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[200px] max-w-[380px]">
      {decomposer && (
        <DecomposerLine
          decomposer={decomposer}
          leadKey="org.brief.exec.byLead"
          fallbackKey="org.brief.exec.byCeoFallback"
          isRealAgent={isRealAgent}
          tr={tr}
        />
      )}
      {questions && questions.length > 0 && (
        <ClarifyQuestionnaire questions={questions} submitted={!!questionsAnswered} onSubmit={onSubmitAnswers} tr={tr} />
      )}
      {finalTask !== undefined && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface-0 p-2.5">
          <div className="text-[11px] font-medium text-ink-subtle">{tr("org.brief.exec.summaryLabel")}</div>
          <div className="text-[12px] text-ink leading-snug whitespace-pre-line">{finalTask}</div>
          {dispatchState === "dismissed" ? (
            <div className="text-[11px] text-ink-subtle">{tr("org.brief.exec.dismissedTag")}</div>
          ) : dispatchState === "dispatched" ? (
            <div className="text-[11px] text-green">{tr("org.brief.exec.dispatchedTag")}</div>
          ) : dispatchState === "awaitingApproval" ? (
            <div className="text-[11px] text-amber">{tr("org.brief.exec.awaitingApprovalTag")}</div>
          ) : (
            <div className="flex items-center gap-1.5 pt-0.5">
              <button
                onClick={onDispatch}
                disabled={dispatchState === "dispatching"}
                className="btn-primary px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors"
              >
                {dispatchState === "dispatching" ? tr("org.brief.exec.dispatching") : tr("org.brief.exec.confirmBtn")}
              </button>
              <button onClick={onDismiss} disabled={dispatchState === "dispatching"} className="btn-sm">
                {tr("org.brief.exec.dismissBtn")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// 该事件归哪家公司——null = 无法判定(无 agentId 绑定的纯系统事件,或 run 索引还没取到),一律保留;
// 取到确定归属后才可能被公司过滤器剔除。agent 类事件按 agentsById 查该 agent 的 companyId;
// run_started/run_finished 按事件自带的 runId 查 /api/runs 索引缓存的 companyId。
function companyIdOfEvent(e: TraceEvent, agentsById: Map<string, AgentNodeConfig>, runsIndex: Record<string, RunRow>): string | null {
  if (e.agentId) {
    const a = agentsById.get(e.agentId);
    return a ? (a.companyId || DEFAULT_COMPANY) : null;
  }
  if (e.type === "run_started" || e.type === "run_finished") {
    const row = e.runId ? runsIndex[e.runId] : undefined;
    return row ? (row.companyId || DEFAULT_COMPANY) : null;
  }
  return null;
}

// 只挑"关键事件"人话化;model_call_*/tool_call/agent_output_chunk 等高频噪声一律不进简报栏
// (它们驱动画布节点头顶的"当前在做什么"气泡,见 OrgPage 的 useAgentActivityLabel)。
// lastMsgByAgent:该 agent 本次产出的最近一句话(由调用方单趟扫 events 预先算好,agent_status_changed
// done 时带上,让"完成了"这句从纯噪声变成"完成了,产出是…"——一眼看出价值)。
function eventToEntry(
  e: TraceEvent,
  agentsById: Map<string, AgentNodeConfig>,
  runsIndex: Record<string, RunRow>,
  lastMsgByAgent: Map<string, string>,
  tr: (key: string, params?: Record<string, string | number>) => string,
): FeedEntry | null {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const agent = e.agentId ? agentsById.get(e.agentId) : undefined;
  const agentName = agent?.name ?? e.agentId ?? "";
  const systemName = tr("org.brief.systemName");

  switch (e.type) {
    case "run_started": {
      const goal = truncate(String(p.goal ?? ""), 100);
      return { key: e.id, ts: e.timestamp, variant: "system", name: systemName, content: tr("org.brief.msg.runStarted", { goal }) };
    }
    case "run_finished": {
      const row = runsIndex[e.runId];
      const goalFull = cleanText(row?.goal ?? "");
      const goal = goalFull ? truncate(goalFull, 60) : tr("trace.untitledGoal");
      const failed = !!p.failed;
      const badge: BadgeKey = row ? resolveBadge(row.status, row.degraded, row.degradedReason) : (failed ? "failed" : "done");
      const hasPartial = row ? !!row.partial : (p.allClean === false || Number(p.deferredCount ?? 0) > 0);
      const summary = row ? (row.summary ?? "") : undefined;
      const content = failed ? tr("org.brief.msg.runFailed") : tr("org.brief.msg.runFinished");
      const card = <RunReportCard runId={e.runId} goal={goal} badge={badge} hasPartial={hasPartial} summary={summary} />;
      return { key: e.id, ts: e.timestamp, variant: "system", name: systemName, content, card };
    }
    case "agent_status_changed": {
      const status = (p as { status?: string }).status;
      if (status !== "working" && status !== "done") return null; // 开始干活 / 完成——其余状态转换留给画布节点自己表达,简报栏不添噪声
      let content: string;
      if (status === "working") {
        content = tr("org.brief.msg.agentStarted", { name: agentName });
      } else {
        const snippet = e.agentId ? lastMsgByAgent.get(e.agentId) : undefined;
        content = snippet
          ? tr("org.brief.msg.agentDoneWithOutput", { name: agentName, output: truncate(snippet, 80) })
          : tr("org.brief.msg.agentDone", { name: agentName });
      }
      return { key: e.id, ts: e.timestamp, variant: "agent", name: agentName || systemName, role: agent?.role, agentId: e.agentId, content };
    }
    case "error": {
      // 用户反馈"错误能不能显示得更明显":从一行灰字升级为红色警示卡(标题+错误正文+超时类的人话解释)。
      const msg = typeof p.message === "string" && p.message ? p.message : tr("org.brief.msg.errorGeneric");
      const hint = /timed out|timeout|超时/i.test(msg) ? tr("org.brief.error.timeoutHint") : undefined;
      const card = (
        <div className="flex flex-col gap-1 rounded-lg px-2.5 py-2 bg-red/10 border border-red/40">
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-red">
            ⚠ {agent ? tr("org.brief.error.agentTitle", { name: agentName }) : tr("org.brief.error.systemTitle")}
          </div>
          <div className="text-[12px] leading-snug break-all text-ink">{truncate(msg, 200)}</div>
          {hint && <div className="text-[11px] leading-snug text-ink-muted">{hint}</div>}
        </div>
      );
      return { key: e.id, ts: e.timestamp, variant: agent ? "agent" : "system", name: agent ? agentName : systemName, role: agent?.role, agentId: agent ? e.agentId : undefined, content: msg, card };
    }
    case "verifier_result": {
      const producer = agentsById.get(String(p.producer ?? ""))?.name ?? String(p.producer ?? "");
      const reason = truncate(String(p.reason ?? ""), 80);
      const content = p.accept
        ? tr("org.brief.msg.verifierPass", { name: producer })
        : tr("org.brief.msg.verifierFail", { name: producer, reason });
      return { key: e.id, ts: e.timestamp, variant: "agent", name: agentName || systemName, role: agent?.role, agentId: e.agentId, content };
    }
    case "info": {
      const kind = typeof p.kind === "string" ? p.kind : undefined;
      if (kind && DOMAIN_KINDS.has(kind) && typeof p.message === "string" && p.message) {
        return { key: e.id, ts: e.timestamp, variant: agent ? "agent" : "system", name: agent ? agentName : systemName, role: agent?.role, agentId: agent ? e.agentId : undefined, content: p.message };
      }
      return null;
    }
    default:
      return null;
  }
}

function localToEntry(m: LocalMsg, tr: (key: string) => string): FeedEntry {
  const variant: MessageBubbleVariant = m.role === "user" ? "user" : m.role === "assistant" ? "agent" : "system";
  const name = m.role === "user" ? tr("org.brief.youName") : m.role === "assistant" ? tr("org.brief.ceoName") : tr("org.brief.systemName");
  return { key: m.id, ts: m.ts, variant, name, role: m.role === "assistant" ? "ceo" : undefined, content: m.text };
}

const FEED_TAIL = 80;

type Dock = "side" | "bottom";

// 拖拽调整简报栏尺寸:侧栏模式拖左边缘改宽度,底部模式拖上边缘改高度——都是"往面板内部拖=变大",
// 用同一个"起点位置 - 当前指针位置"的增量公式即可,不必按 dock 分两套符号逻辑。size/onResize 的
// clamp(280-560 / 240-400)交给调用方(OrgPage,localStorage 落盘也在那一层),这里只管拖拽算术。
function useDockResizeHandle(dock: Dock, size: number, onResize: (v: number) => void) {
  return useCallback((e: ReactPointerEvent) => {
    e.preventDefault();
    const startPos = dock === "side" ? e.clientX : e.clientY;
    const startSize = size;
    const onMove = (ev: PointerEvent) => {
      const cur = dock === "side" ? ev.clientX : ev.clientY;
      onResize(startSize + (startPos - cur));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [dock, size, onResize]);
}

function genId(): string {
  try { return crypto.randomUUID(); } catch { return `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

// 执行模式的一轮本地记录:assistant 回复要么带 questions(情况A·选择题,此时没有 finalTask),要么
// 带 finalTask(情况B·最终任务预览,此时没有 questions)——两者互斥,后端 parseDecomposeReply 已经
// 强制保证这一点,前端只是如实渲染。
interface ExecEntry {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "system";
  text: string;
  decomposer?: TaskDecomposer;
  /** 溯源:system 类条目(派发失败/成功/待审批)带上该轮拆解产出者(decomposer)的归属。 */
  attributedTo?: MessageAttribution;
  questions?: TaskDecomposeQuestion[];
  /** 选择题一次性提交后置 true → 问卷卡收起,汇总答案已作为一条用户消息进入消息流。 */
  questionsAnswered?: boolean;
  finalTask?: string;
  dispatchState?: "pending" | "dispatching" | "dispatched" | "dismissed" | "awaitingApproval";
}

export default function BriefingPanel({
  collapsed, onToggleCollapse, activeCompanyId = DEFAULT_COMPANY, ceoId,
  dock, onDockChange, size, onResize,
}: {
  collapsed: boolean; onToggleCollapse: () => void;
  /** 简报只看这家公司(OrgPage 的公司切换器状态);缺省 = 默认公司,向后兼容未传该 prop 的调用方。 */
  activeCompanyId?: string;
  /** 该公司 CEO 的 agent id(company.ceoId)——对话历史按它隔离,任务/对话发给它;缺省全局 "ceo"。 */
  ceoId?: string;
  /** 停靠位置:右侧栏(拖左边缘改宽) / 底部横栏(拖上边缘改高)——受控于 OrgPage,决定外层 flex 方向。 */
  dock: Dock;
  onDockChange: (d: Dock) => void;
  /** 当前尺寸:dock==="side" 时是宽度(px),dock==="bottom" 时是高度(px)——由 OrgPage 按各自 range clamp。 */
  size: number;
  onResize: (v: number) => void;
}) {
  const tr = useT();
  const events = useAgentStore(s => s.events);
  const agents = useAgentStore(s => s.agents);
  const localMessages = useCockpitStore(s => s.localMessages);
  const hydrateThread = useCockpitStore(s => s.hydrateThread);
  // 用户指令"简报改成和 CEO 对话,每个公司的简报独立":消息键=本公司 CEO id,任务带 companyId 下发。
  const chatCeoId = ceoId || "ceo";
  const [text, setText] = useState("");

  // 老板一眼条:N 人在忙(按当前公司)· 进行中任务/今日 Token(保持全局,
  // label 标"全部"标注清楚口径)。忙人数直接来自 agents 状态;进行中任务/Token 低频拉取
  // (挂载 + run 开始/结束时刷新),不追实时。
  const companyAgents = useMemo(() => agents.filter(a => (a.companyId || DEFAULT_COMPANY) === activeCompanyId), [agents, activeCompanyId]);
  // 驾驶舱"正在等待谁"与一眼条"在忙"同源:agents store 实时状态(SSE 直推),名单和计数永远一致。
  const workingAgents = useMemo(() => companyAgents.filter(a => isBusyStatus(a.status)), [companyAgents]); // 11 态:细分忙碌态也计入"在忙"
  const workingCount = workingAgents.length;
  const [glance, setGlance] = useState<{ running: number; todayTokens: number | null }>({ running: 0, todayTokens: null });
  // id→run 索引行缓存(含 companyId)——喂报告卡片(goal/徽章/摘要)与事件流的公司过滤。同一次 GET /api/runs
  // 顺带把"进行中任务数"也算了,不必为公司过滤再开一个请求。合并(非替换)写入:老条目不因不在最新 200
  // 条窗口内而丢失,run_started 触发的这次拉取就是"增量补"新 runId→companyId 映射的时机。
  const [runsIndex, setRunsIndex] = useState<Record<string, RunRow>>({});
  // CEO 驾驶舱:聚合状态(mission/预估/最近失败/进行中 run/今日成本)由共享 useCeoStatus 钩子自足管理
  // (挂载拉取 + run 开始/结束刷新 + 切公司清零),这里只留折叠开关 + 本地复盘弹层。
  const ceo = useCeoStatus(activeCompanyId);
  const [ceoOpen, setCeoOpen] = useState(true);
  const [pmModal, setPmModal] = useState<PostmortemData | null>(null);
  // E4 · L3 审批卡:本公司待审批的 governance record(数据源 GET /api/governance/records;
  // inputs.companyId 缺省视为默认公司,与 agents/mission 的既有口径一致)。
  const [pendingApprovals, setPendingApprovals] = useState<GovernanceRecordLite[]>([]);
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const refreshApprovals = useCallback(() => {
    api.listGovernanceRecords()
      .then(records => setPendingApprovals(records.filter(r =>
        r.approvalRequired && (r.approval?.status ?? "pending") === "pending"
        && (r.inputs?.companyId || DEFAULT_COMPANY) === activeCompanyId,
      )))
      .catch(() => { /* best-effort */ });
  }, [activeCompanyId]);
  const refreshGlance = useCallback(() => {
    api.get<RunRow[]>("/runs")
      .then(list => {
        const rows = list || [];
        setGlance(g => ({ ...g, running: rows.filter(r => r.status === "running").length }));
        setRunsIndex(idx => {
          const next = { ...idx };
          for (const r of rows) next[r.id] = r;
          return next;
        });
      })
      .catch(() => { /* best-effort */ });
    const period = new Date().toISOString().slice(0, 7);
    api.get<{ days?: Array<{ date: string; total: number }> }>(`/cost/timeseries?metric=tokens&period=${period}`)
      .then(ts => {
        const today = new Date().toISOString().slice(0, 10);
        const hit = (ts.days || []).find(d => d.date === today);
        setGlance(g => ({ ...g, todayTokens: hit ? hit.total : 0 }));
      })
      .catch(() => { /* best-effort */ });
    refreshApprovals();
  }, [activeCompanyId, refreshApprovals]);
  const glanceSeen = useRef(0);
  useEffect(() => { refreshGlance(); }, [refreshGlance]);
  useEffect(() => {
    const fresh = events.slice(glanceSeen.current);
    glanceSeen.current = events.length;
    if (fresh.some(e => e.type === "run_started" || e.type === "run_finished")) refreshGlance();
  }, [events, refreshGlance]);
  // 其它派发入口(LaunchPad/工作台/复盘卡)拿到 approvalRequired 响应时广播该事件——简报栏立即
  // 拉出审批卡,不等下一次 glance 刷新(跨组件契约,同 open-task-run 的既有做法)。
  useEffect(() => {
    const onRequested = () => refreshApprovals();
    window.addEventListener("governance-approval-requested", onRequested);
    return () => window.removeEventListener("governance-approval-requested", onRequested);
  }, [refreshApprovals]);

  // agentsById 故意来自全量 agents(不按公司过滤)——公司过滤要用它反查"这个 agentId 属于哪家公司",
  // 过滤本身在下面 entries 里做,不能先把跨公司 agent 的名字都丢了。
  const agentsById = useMemo(() => new Map(agents.map(a => [a.id, a])), [agents]);
  const entries = useMemo(() => {
    // 单趟扫描:边走边记"每个 agent 最近一句 agent_message"(agentId → text),done 气泡据此带上
    // 该 agent 本次产出的一句话摘要,而不是再对全量历史做一次 O(n²) 反查。
    const lastMsgByAgent = new Map<string, string>();
    const ev: FeedEntry[] = [];
    for (const e of events) {
      if (e.type === "agent_message" && e.agentId) {
        const text = (e.payload as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text) lastMsgByAgent.set(e.agentId, text);
      }
      const cid = companyIdOfEvent(e, agentsById, runsIndex);
      if (cid !== null && cid !== activeCompanyId) continue; // 判定得出、且不属于当前公司 → 跳过;判定不了则保留
      const entry = eventToEntry(e, agentsById, runsIndex, lastMsgByAgent, tr);
      if (entry) ev.push(entry);
    }
    // 公司独立:只合并**本公司 CEO** 的对话历史(chatCeoId 键),切公司即切上下文。
    const loc = localMessages.filter(m => m.agentId === chatCeoId).map(m => localToEntry(m, tr));
    return [...ev, ...loc].sort((a, b) => (a.ts || "").localeCompare(b.ts || "")).slice(-FEED_TAIL);
  }, [events, localMessages, agentsById, runsIndex, activeCompanyId, chatCeoId, tr]);

  const endRef = useRef<HTMLDivElement | null>(null);

  // ── 对话/执行 两模式 ─────────────────────────────────────────────────────────────────
  const addLocalMessage = useCockpitStore(s => s.addLocalMessage);
  const loadRuns = useRunStore(s => s.load);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [mode, setMode] = useState<"chat" | "exec">("chat");
  useEffect(() => {
    const focusTaskComposer = () => {
      setMode("exec");
      setTimeout(() => textareaRef.current?.focus(), 0);
    };
    window.addEventListener("opc-focus-task-composer", focusTaskComposer);
    return () => window.removeEventListener("opc-focus-task-composer", focusTaskComposer);
  }, []);

  const [chatPending, setChatPending] = useState(false);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationBump, setAutomationBump] = useState(0); // 触发 AutomationPanel 立即重拉,不必等 15s 轮询
  const [menuIndex, setMenuIndex] = useState(0);
  // "/" 面板选中的技能(菜单选中后进入"待输入任务文本"态,不再是命令补全);发送/清空后归 null。
  const [selectedSkill, setSelectedSkill] = useState<SkillMeta | null>(null);

  // ── 执行模式:三段式(①一句话需求 ②Leader/CEO 拆解:选择题或最终任务预览 ③确认后真正派发)──
  const [execEntries, setExecEntries] = useState<ExecEntry[]>([]);
  const [execPending, setExecPending] = useState(false);
  // 切公司:执行模式会话清零(驾驶舱聚合态由 useCeoStatus 钩子在 companyId 变更时自行清零重拉)。
  useEffect(() => { setExecEntries([]); }, [activeCompanyId]);

  // 打开/切换公司简报时拉取该公司 CEO 的持久对话线程注水本地(刷新页面上下文连续)。按 companyId 让
  // 服务端解析真实 CEO,注水键统一用 chatCeoId(本地渲染键)。hydrateThread 幂等,不与在途消息打架。
  useEffect(() => {
    let gone = false;
    api.getChatThread({ companyId: activeCompanyId, agentId: chatCeoId })
      .then(r => { if (!gone && Array.isArray(r.turns) && r.turns.length) hydrateThread(chatCeoId, r.turns); })
      .catch(() => { /* 拉不到 → 退回纯本地渲染,不阻断 */ });
    return () => { gone = true; };
  }, [activeCompanyId, chatCeoId, hydrateThread]);

  // C2 最近失败卡"查看复盘":复用 C1 的既有入口,不重造——postmortem 可用则拉现有端点弹同一个
  // PostmortemModal;不可用/拉取失败则走既有 open-task-run 跨页契约跳任务档案。
  const viewFailure = useCallback((f: { runId: string; postmortemAvailable: boolean }) => {
    const openRun = () => window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId: f.runId } }));
    if (!f.postmortemAvailable) { openRun(); return; }
    api.get<PostmortemData>(`/runs/${f.runId}/postmortem`)
      .then(pm => { if (pm?.available) setPmModal(pm); else openRun(); })
      .catch(openRun);
  }, []);

  // E4 · 审批卡的批准/拒绝:直调 governanceRoutes 的 approve/reject。批准即派发(record 带
  // pendingDispatch);dispatched:false + retryable = 撞上单 run 互斥闸,run 保持 pending,提示稍后
  // 重新批准即可重试派发。结果以系统气泡落进简报流,与其它派发反馈同一形态。
  const decideApproval = useCallback(async (runId: string, action: "approve" | "reject") => {
    if (approvalBusy) return;
    setApprovalBusy(runId);
    try {
      if (action === "approve") {
        const r = await api.approveGovernanceRun(runId);
        const key = r.dispatched ? "org.governance.approvedDispatched"
          : r.retryable ? "org.governance.approvedRetryLater" : "org.governance.approvedNoDispatch";
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr(key, { id: runId.slice(0, 8) }) });
        if (r.dispatched) loadRuns();
      } else {
        await api.rejectGovernanceRun(runId);
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.governance.rejected", { id: runId.slice(0, 8) }) });
        loadRuns();
      }
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.governance.actionFailed", { message: e?.message ?? String(e) }) });
    } finally {
      setApprovalBusy(null);
      refreshApprovals();
    }
  }, [approvalBusy, chatCeoId, addLocalMessage, tr, loadRuns, refreshApprovals]);

  const busy = chatPending || automationPending || execPending;

  const sendExec = useCallback(async (msg: string) => {
    const t = msg.trim();
    if (!t) return;
    const history = execEntries
      .filter((e): e is ExecEntry & { kind: "user" | "assistant" } => e.kind !== "system")
      .map(e => ({ role: e.kind, content: e.text }));
    setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "user", text: t }]);
    setText("");
    setExecPending(true);
    try {
      const res = await api.taskDecompose(activeCompanyId, t, history);
      setExecEntries(prev => [...prev, {
        id: genId(), ts: new Date().toISOString(), kind: "assistant", text: res.summary,
        decomposer: res.decomposer,
        questions: res.needsChoice ? res.questions : undefined,
        finalTask: res.needsChoice ? undefined : res.finalTask,
        dispatchState: res.needsChoice ? undefined : "pending",
      }]);
    } catch (e: any) {
      setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) }]);
    } finally {
      setExecPending(false);
    }
  }, [execEntries, activeCompanyId, tr]);

  // 澄清问卷提交(用户纠正:旧实现"点一个选项即发送、逐题往返"是错的)——全部题目一次答完,提交时
  // 把 {question, answer} 汇总成一条用户消息走同一条 sendExec 路径,只触发一轮模型调用;并把该题条目
  // 标记 answered 让问卷卡收起(汇总答案由 sendExec 追加的用户气泡承载,用户仍看得见自己答了什么)。
  const submitExecAnswers = useCallback((entryId: string, summary: string) => {
    if (execPending) return;
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, questionsAnswered: true } : e)));
    void sendExec(summary);
  }, [execPending, sendExec]);

  // 确认派发:默认使用公司节点已配置的模型。质量档位属于显式覆盖能力,不能在这里静默把员工模型
  // 全部替换成 Claude/DeepSeek;需要覆盖时由 Mission 卡或 LaunchPad 的可见控件选择。
  const dispatchExecEntry = useCallback(async (entryId: string) => {
    const entry = execEntries.find(e => e.id === entryId);
    if (!entry?.finalTask) return;
    // 溯源:这轮方案的派发结果(成功/待审批/失败)都归属到当初拆解出该方案的产出者(decomposer)。
    const attributedTo = attributionFromDecomposer(entry.decomposer);
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, dispatchState: "dispatching" } : e)));
    try {
      const r = await api.chatTask(entry.finalTask, { companyId: activeCompanyId, runType: "team" });
      if (r.approvalRequired) {
        // E4 · L3 网关拦下:run 只是 pending,绝不能宣称"已派发"——标待审批态并拉出审批卡。
        setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, dispatchState: "awaitingApproval" } : e)));
        setExecEntries(prev => [...prev, {
          id: genId(), ts: new Date().toISOString(), kind: "system", attributedTo,
          text: tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }),
        }]);
        refreshApprovals();
      } else {
        setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, dispatchState: "dispatched" } : e)));
        setExecEntries(prev => [...prev, {
          id: genId(), ts: new Date().toISOString(), kind: "system", attributedTo,
          text: tr("org.brief.mission.dispatchedRun", { runId: r.runId.slice(0, 8) }),
        }]);
      }
      loadRuns();
    } catch (e: any) {
      setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, dispatchState: "pending" } : e)));
      setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "system", attributedTo, text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) }]);
    }
  }, [execEntries, activeCompanyId, tr, loadRuns, refreshApprovals]);

  const dismissExecEntry = useCallback((entryId: string) => {
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, dispatchState: "dismissed" } : e)));
  }, []);

  // execEntries → FeedEntry[],和消息流其余来源(SSE 事件 + 本地对话)按时间统一排序合并,同一处
  // MessageBubble 渲染路径,不另开一块单独区域。
  const isRealAgent = useCallback((id: string) => agentsById.has(id), [agentsById]);
  const execFeedEntries = useMemo<FeedEntry[]>(() => {
    const ceoName = agentsById.get(chatCeoId)?.name ?? tr("org.brief.ceoName");
    return execEntries.map(e => {
      // system 类:带上溯源归属(派发失败/成功/待审批 → 归属到该轮拆解产出者);无归属则保持真·系统。
      if (e.kind === "system") return { key: e.id, ts: e.ts, variant: "system" as MessageBubbleVariant, name: tr("org.brief.systemName"), attributedTo: e.attributedTo, content: e.text };
      if (e.kind === "user") return { key: e.id, ts: e.ts, variant: "user" as MessageBubbleVariant, name: tr("org.brief.youName"), content: e.text };
      return {
        key: e.id, ts: e.ts, variant: "agent" as MessageBubbleVariant, name: ceoName, role: "ceo", content: e.text,
        card: (
          <ExecPreviewCard
            decomposer={e.decomposer} questions={e.questions} questionsAnswered={e.questionsAnswered} finalTask={e.finalTask} dispatchState={e.dispatchState}
            onSubmitAnswers={summary => submitExecAnswers(e.id, summary)}
            onDispatch={() => void dispatchExecEntry(e.id)}
            onDismiss={() => dismissExecEntry(e.id)}
            isRealAgent={isRealAgent}
            tr={tr}
          />
        ),
      };
    });
  }, [execEntries, agentsById, chatCeoId, tr, submitExecAnswers, dispatchExecEntry, dismissExecEntry, isRealAgent]);

  const allEntries = useMemo(() => {
    return [...entries, ...execFeedEntries].sort((a, b) => (a.ts || "").localeCompare(b.ts || "")).slice(-FEED_TAIL);
  }, [entries, execFeedEntries]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [allEntries.length, busy]);

  // "/" 命令面板:还在打命令名(没出现空格)时显示,输入过滤 + ↑↓ 选择。内置命令之下再挂一组"技能"
  // (GET /api/skills，commands.ts 的 fetchEnabledSkills 已做 enabled 过滤+≤20+5 分钟缓存)——
  // 两组合并成一份 menuEntries 供键盘 ↑↓/Tab/Enter 统一导航，渲染时再按 kind 分组展示。
  const composing = isComposingSlash(text);
  const [skillPool, setSkillPool] = useState<SkillMeta[]>([]);
  useEffect(() => { if (composing) fetchEnabledSkills().then(setSkillPool).catch(() => { /* best-effort */ }); }, [composing]);
  const menuCommands = useMemo(() => (composing ? matchCommands(slashQuery(text)) : []), [composing, text]);
  const menuSkills = useMemo(() => (composing ? matchSkills(slashQuery(text), skillPool) : []), [composing, text, skillPool]);
  type MenuEntry = { kind: "command"; command: Command } | { kind: "skill"; skill: SkillMeta };
  const menuEntries = useMemo<MenuEntry[]>(() => [
    ...menuCommands.map(c => ({ kind: "command" as const, command: c })),
    ...menuSkills.map(s => ({ kind: "skill" as const, skill: s })),
  ], [menuCommands, menuSkills]);
  const menuOpen = composing;
  useEffect(() => { setMenuIndex(0); }, [text]);

  // 菜单选中一项:命令 → 补全 "/name " 交给参数输入；技能 → 记入 selectedSkill 并清空输入框，
  // 退出 "/" 态，让用户接着打自由任务文本(发送走 sendSkillTask，不是 /skill 手打路径)。
  const chooseMenuEntry = useCallback((entry: MenuEntry) => {
    if (entry.kind === "command") { setText(`/${entry.command.name} `); } else { setSelectedSkill(entry.skill); setText(""); }
    setMenuIndex(0);
  }, []);

  // startGoal/startLoop:仍是 /harness(含别名 /goal)、/loop 斜杠命令的真正落地(commands.ts 的
  // COMMANDS 通过 cmdCtx 调这两个函数)——这两个执行范式不再有专门的按钮式 setup 面板,但斜杠命令
  // 这条"熟手直接打"的路径原样保留,用默认轮数/无验收标准/不逐轮确认快速起跑。
  const startGoal = useCallback(async (goal: string) => {
    const g = goal.trim();
    if (!g) return;
    setAutomationPending(true);
    try {
      const rec = await api.post<GoalRecord>("/goals", { goal: g, companyId: activeCompanyId });
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.goalStarted", { rounds: rec.maxRounds }) });
      setAutomationBump(b => b + 1);
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) });
    } finally {
      setAutomationPending(false);
    }
  }, [activeCompanyId, chatCeoId, addLocalMessage, tr]);

  const startLoop = useCallback(async (prompt: string) => {
    const p = prompt.trim();
    if (!p) return;
    setAutomationPending(true);
    try {
      const rec = await api.post<LoopRecord>("/loops", { prompt: p, companyId: activeCompanyId });
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.loopStarted", { rounds: rec.maxRuns }) });
      setAutomationBump(b => b + 1);
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) });
    } finally {
      setAutomationPending(false);
    }
  }, [activeCompanyId, chatCeoId, addLocalMessage, tr]);

  // 附加技能下发:api.chatTask(task, {companyId, skills:[skill.id]})——"/" 面板选中技能 与 手打
  // "/skill <名字> <任务>" 两条路都落到这一个函数，气泡统一注明"已附加技能:{title}"。
  const sendSkillTask = useCallback(async (task: string, skill: { id: string; title: string }) => {
    const t = task.trim();
    if (!t) return;
    setAutomationPending(true);
    try {
      const r = await api.chatTask(t, { companyId: activeCompanyId, skills: [skill.id] });
      if (r.approvalRequired) {
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }) });
        refreshApprovals();
      } else {
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.skillMenu.attached", { title: skill.title, runId: r.runId.slice(0, 8) }) });
      }
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) });
    } finally {
      setAutomationPending(false);
      setSelectedSkill(null);
    }
  }, [activeCompanyId, chatCeoId, addLocalMessage, tr, refreshApprovals]);

  // 把用户刚才打的内容(原样,含斜杠前缀)记一条"我说的"气泡,再清空输入框——斜杠命令/技能路径共用。
  const emitUserBubble = useCallback((raw: string) => {
    addLocalMessage({ agentId: chatCeoId, role: "user", text: raw.trim(), source: "chat" });
    setText("");
  }, [addLocalMessage, chatCeoId]);

  // ── 对话模式:纯对话,不派任务 ──────────────────────────────────────────────────────
  const sendChatOnly = useCallback(async (raw: string) => {
    const t = raw.trim();
    if (!t) return;
    addLocalMessage({ agentId: chatCeoId, role: "user", text: t, source: "chat" });
    setText("");
    setChatPending(true);
    try {
      const r = chatCeoId !== "ceo" ? await api.chatAgent(chatCeoId, t) : await api.chat(t, activeCompanyId);
      addLocalMessage({ agentId: chatCeoId, role: "assistant", text: r.reply });
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) });
    } finally {
      setChatPending(false);
    }
  }, [chatCeoId, activeCompanyId, addLocalMessage, tr]);

  // 命令注册表的执行上下文——命令本身(commands.ts)不碰 useCockpitStore,只经这几个出口。
  const cmdCtx: CommandContext = useMemo(() => ({
    activeCompanyId,
    workingCount,
    runningCount: glance.running,
    startGoal: (g: string) => startGoal(g),
    startLoop: (p: string) => startLoop(p),
    sendSkillTask: (task: string, skill: { id: string; title: string }) => sendSkillTask(task, skill),
    dispatch: (event, detail) => window.dispatchEvent(new CustomEvent(event, { detail })),
    systemMessage: (t: string) => addLocalMessage({ agentId: chatCeoId, role: "system", text: t }),
    toast: (t: string) => pushToast("info", t),
    tr,
  }), [activeCompanyId, workingCount, glance.running, startGoal, startLoop, sendSkillTask, addLocalMessage, chatCeoId, tr]);

  const runCommand = useCallback(async (cmd: Command, args: string) => {
    setAutomationPending(true);
    try {
      await cmd.run(args, cmdCtx);
    } catch (e: any) {
      addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.automation.error", { message: e?.message ?? String(e) }) });
    } finally {
      setAutomationPending(false);
    }
  }, [cmdCtx, addLocalMessage, chatCeoId, tr]);

  const handleSend = useCallback(() => {
    if (busy || !text.trim()) return;
    const slash = parseSlash(text.trim());
    if (slash) {
      const cmd = findCommand(slash.name);
      if (cmd) {
        emitUserBubble(text);
        void runCommand(cmd, slash.args);
      } else {
        // 未注册的命令:不静默吞掉——原样(含 "/xxx" 前缀)按当前模式(对话/执行)当普通输入发出去,
        // 并如实注明。
        const raw = text;
        if (mode === "chat") void sendChatOnly(raw); else void sendExec(raw);
        addLocalMessage({ agentId: chatCeoId, role: "system", text: tr("org.brief.cmd.unknown") });
      }
      return;
    }
    if (selectedSkill) { const t = text; const sk = selectedSkill; emitUserBubble(t); void sendSkillTask(t, sk); return; }
    if (mode === "chat") { void sendChatOnly(text); return; }
    void sendExec(text);
  }, [busy, text, selectedSkill, mode, tr, addLocalMessage, chatCeoId, emitUserBubble, runCommand, sendSkillTask, sendChatOnly, sendExec]);

  const handleTextareaKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && menuEntries.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setMenuIndex(i => (i + 1) % menuEntries.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setMenuIndex(i => (i - 1 + menuEntries.length) % menuEntries.length); return; }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        chooseMenuEntry(menuEntries[Math.min(menuIndex, menuEntries.length - 1)]);
        return;
      }
    }
    if (menuOpen && e.key === "Escape") { e.preventDefault(); setText(""); setMenuIndex(0); return; }
    if (e.key === "Enter" && !e.shiftKey && !menuOpen) { e.preventDefault(); handleSend(); }
  }, [menuOpen, menuEntries, menuIndex, handleSend, chooseMenuEntry]);

  const placeholder = busy
    ? tr("org.brief.pending")
    : selectedSkill ? tr("org.brief.skillMenu.placeholder", { title: selectedSkill.title })
      : mode === "chat" ? tr("org.brief.placeholder.chat")
        : tr("org.brief.exec.placeholder");

  const onResizeStart = useDockResizeHandle(dock, size, onResize);

  if (collapsed) {
    // 折叠态两种朝向:侧栏收成竖条(靠右边缘),底部收成横条(靠下边缘)——展开箭头方向跟随朝哪边展开。
    if (dock === "bottom") {
      return (
        <div className="shrink-0 w-full h-11 border-t border-hairline bg-surface-1 flex items-center px-3 gap-2">
          <Radio size={13} className="text-ink-subtle" />
          <span className="text-[12px] text-ink-subtle">{tr("org.brief.title")}</span>
          <div className="flex-1" />
          <button
            onClick={onToggleCollapse}
            title={tr("org.brief.expand")}
            className="w-8 h-8 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-2 cursor-pointer border-none bg-transparent transition-colors duration-150"
          >
            <ChevronUp size={15} />
          </button>
        </div>
      );
    }
    return (
      <div className="shrink-0 w-11 border-l border-hairline bg-surface-1 flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggleCollapse}
          title={tr("org.brief.expand")}
          className="w-8 h-8 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-2 cursor-pointer border-none bg-transparent transition-colors duration-150"
        >
          <ChevronLeft size={15} />
        </button>
        <Radio size={13} className="text-ink-subtle" />
      </div>
    );
  }

  // ── 展开态共享内容块:一眼条 / 自动化卡 / 消息流 / 输入区——两种朝向(侧栏纵列 vs 底部横排)
  // 只是把同一批内容拼进不同的容器,内容与交互逻辑不重复一份。

  // 拖拽手柄:侧栏在左边缘(改宽)、底部在上边缘(改高)——常态隐形,hover 面板或手柄本身才浮现。
  const resizeHandle = (
    <div
      onPointerDown={onResizeStart}
      title={tr("org.brief.resizeHandle")}
      className="absolute z-30 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
      style={dock === "side"
        ? { left: -3, top: 0, bottom: 0, width: 6, cursor: "ew-resize" }
        : { top: -3, left: 0, right: 0, height: 6, cursor: "ns-resize" }}
    >
      <div className="bg-accent" style={dock === "side" ? { width: 2, height: "100%", margin: "0 auto" } : { height: 2, width: "100%", margin: "auto 0" }} />
    </div>
  );

  const dockToggleButton = (
    <button
      onClick={() => onDockChange(dock === "side" ? "bottom" : "side")}
      title={dock === "side" ? tr("org.brief.dock.toBottom") : tr("org.brief.dock.toSide")}
      className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-2 cursor-pointer border-none bg-transparent transition-colors duration-150"
    >
      {dock === "side" ? <PanelBottom size={14} /> : <PanelRight size={14} />}
    </button>
  );

  const header = (
    <div className="h-11 shrink-0 flex items-center gap-2 px-3 border-b border-hairline">
      <Radio size={14} className="text-accent" />
      {/* 用户定调:简报=与本公司 CEO 的对话。有具名 CEO 显示其名,否则通用标题。 */}
      <span className="text-[13px] font-semibold text-ink">
        {(() => { const ceo = agentsById.get(chatCeoId); return ceo?.name ? tr("org.brief.ceoTitleNamed", { name: ceo.name }) : tr("org.brief.ceoTitle"); })()}
      </span>
      <div className="flex-1" />
      {dockToggleButton}
      <button
        onClick={onToggleCollapse}
        title={tr("org.brief.collapse")}
        className="w-7 h-7 rounded-md flex items-center justify-center text-ink-muted hover:text-ink hover:bg-surface-2 cursor-pointer border-none bg-transparent transition-colors duration-150"
      >
        {dock === "side" ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
      </button>
    </div>
  );

  // 老板一眼条:在忙/进行中/今日 Token——挂在简报流之上,一眼掌握全局
  const glanceBar = (
    <div className="shrink-0 grid grid-cols-3 divide-x divide-hairline border-b border-hairline bg-surface-2/40">
      {[
        { v: String(workingCount), l: tr("org.glance.working") },
        { v: String(glance.running), l: `${tr("org.glance.runs")} (${tr("org.glance.allScope")})` },
        { v: glance.todayTokens == null ? "—" : glance.todayTokens >= 1000 ? `${(glance.todayTokens / 1000).toFixed(1)}k` : String(glance.todayTokens), l: `${tr("org.glance.todayCost")} (${tr("org.glance.allScope")})` },
      ].map((s, i) => (
        <div key={i} className="px-2 py-2 text-center">
          <div className="text-[15px] font-semibold text-ink tabular-nums leading-tight">{s.v}</div>
          <div className="text-[10px] text-ink-subtle mt-0.5">{s.l}</div>
        </div>
      ))}
    </div>
  );

  const feedList = (
    <>
      {allEntries.length === 0 ? (
        <div className="text-ink-subtle text-[12px] text-center mt-6">{tr("org.brief.empty")}</div>
      ) : (
        allEntries.map(en => {
          // 溯源 + 可交互:归属系统消息显示产出者身份,发送者/产出者能对应到真实成员即可点进其单聊。
          const id = resolveBubbleIdentity(en, isRealAgent);
          const onActivate = id.linkAgentId
            ? (ev: ReactMouseEvent<HTMLElement>) => {
                ev.preventDefault(); ev.stopPropagation();
                window.dispatchEvent(new CustomEvent("cockpit-open-agent", { detail: { agentId: id.linkAgentId } }));
              }
            : undefined;
          return (
            <MessageBubble
              key={en.key} variant={en.variant} name={en.name} role={en.role}
              attributedTo={en.attributedTo} onAvatarActivate={onActivate}
              content={en.content} timestamp={en.ts} card={en.card}
            />
          );
        })
      )}
      <div ref={endRef} />
    </>
  );

  const slashMenu = menuOpen && (
    <div className="absolute bottom-full left-2.5 right-2.5 mb-1.5 max-h-[240px] overflow-y-auto rounded-lg border border-hairline bg-surface-2 shadow-lg z-20 py-1">
      {menuEntries.length === 0 ? (
        <div className="px-3 py-2 text-[12px] text-ink-subtle">{tr("org.brief.cmd.noMatch")}</div>
      ) : (
        menuEntries.map((entry, i) => {
          const active = i === Math.min(menuIndex, menuEntries.length - 1);
          const showSkillDivider = entry.kind === "skill" && (i === 0 || menuEntries[i - 1].kind === "command");
          const key = entry.kind === "command" ? `c-${entry.command.name}` : `s-${entry.skill.id}`;
          return (
            <div key={key}>
              {showSkillDivider && (
                <div className="px-3 pt-1.5 pb-1 text-[10px] font-medium text-ink-subtle uppercase tracking-wide">
                  {tr("org.brief.skillMenu.groupLabel")}
                </div>
              )}
              <button
                onMouseDown={e => { e.preventDefault(); chooseMenuEntry(entry); }}
                onMouseEnter={() => setMenuIndex(i)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left border-none cursor-pointer transition-colors ${active ? "bg-accent/15" : "bg-transparent hover:bg-surface-1"}`}
              >
                {entry.kind === "command" ? (
                  <>
                    <entry.command.icon size={13} className="shrink-0 text-accent" />
                    <span className="text-[12px] font-medium text-ink shrink-0">/{entry.command.name}</span>
                    {entry.command.argsHintKey && <span className="text-[11px] text-ink-subtle shrink-0">{tr(entry.command.argsHintKey)}</span>}
                    <span className="text-[11px] text-ink-subtle truncate">{tr(entry.command.descKey)}</span>
                  </>
                ) : (
                  <>
                    <Sparkles size={13} className="shrink-0 text-accent" />
                    <span className="text-[12px] font-medium text-ink truncate">{entry.skill.title}</span>
                    <span
                      className="text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ml-auto"
                      style={{ backgroundColor: (SKILL_ROLE_COLOR[entry.skill.role] || "#6b7280") + "18", color: SKILL_ROLE_COLOR[entry.skill.role] || "#6b7280" }}
                    >
                      {SKILL_ROLE_KEY[entry.skill.role] ? tr(SKILL_ROLE_KEY[entry.skill.role]) : tr("skills.role.other")}
                    </span>
                  </>
                )}
              </button>
            </div>
          );
        })
      )}
    </div>
  );

  // 已选技能的小提示条(输入区上方)——展示已附加的技能 + 一键清除。
  const skillChip = selectedSkill && (
    <div className="flex items-center gap-1.5 text-[11px] text-ink-subtle">
      <Sparkles size={11} className="text-accent shrink-0" />
      <span className="truncate">{tr("org.brief.skillMenu.attachedChip", { title: selectedSkill.title })}</span>
      <button
        onClick={() => setSelectedSkill(null)}
        title={tr("common.close")}
        className="ml-auto text-ink-subtle hover:text-ink bg-transparent border-none cursor-pointer p-0 shrink-0"
      >
        <X size={11} />
      </button>
    </div>
  );

  // 模式条:对话 / 执行 二选一,持久选中态是 mode。
  const modeBar = (
    <div className="flex items-center gap-1 rounded-full bg-surface-2 p-0.5">
      {MODE_OPTIONS.map(opt => (
        <button
          key={opt.key}
          onClick={() => setMode(opt.key)}
          className={`flex-1 flex items-center justify-center gap-1 h-6 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none ${
            mode === opt.key ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
          }`}
        >
          <opt.icon size={11} />{tr(opt.labelKey)}
        </button>
      ))}
    </div>
  );

  const inputRow = (
    <div className="flex gap-2">
      <AutoGrowTextarea
        ref={textareaRef}
        value={text}
        maxRows={6}
        onChange={e => setText(e.target.value)}
        onKeyDown={handleTextareaKeyDown}
        disabled={busy}
        placeholder={placeholder}
        className="flex-1 resize-none rounded-lg bg-surface-0 border border-hairline px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
      />
      <button
        onClick={handleSend}
        disabled={busy || !text.trim()}
        title={tr("org.brief.send")}
        className="btn-primary self-end flex items-center justify-center w-9 h-8 disabled:cursor-not-allowed shrink-0 transition-colors duration-150"
      >
        <Send size={14} />
      </button>
    </div>
  );

  const automationPanelEl = <AutomationPanel activeCompanyId={activeCompanyId} refreshSignal={automationBump} />;

  // C2 CEO 驾驶舱区块(一眼条之下、自动化卡之上)+ 本地复盘弹层(复用 C1 的 PostmortemModal 组件)。
  const ceoCockpitEl = (
    <CeoCockpit companyId={activeCompanyId} ceo={ceo} workingAgents={workingAgents} open={ceoOpen} onToggle={() => setCeoOpen(o => !o)} onViewFailure={viewFailure} tr={tr} />
  );
  const pmModalEl = pmModal && <PostmortemModal postmortem={pmModal} onClose={() => setPmModal(null)} />;

  // E4 · L3 审批卡(驾驶舱之下、自动化卡之上):待审批 run 一张一卡——runId/目标预览/判级理由 +
  // 批准/拒绝按钮。批准即派发(governanceRoutes 的 approve 端点自带派发),结果气泡见 decideApproval。
  const approvalCardsEl = pendingApprovals.length > 0 && (
    <div className="shrink-0 border-b border-hairline px-3 py-2 flex flex-col gap-1.5 max-h-[200px] overflow-y-auto">
      {pendingApprovals.map(rec => (
        <div key={rec.runId} className="rounded-lg border border-amber/50 bg-amber/10 p-2.5 flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <ShieldAlert size={11} className="shrink-0 text-amber" />
            <span className="text-[11px] font-medium text-amber">{tr("org.governance.pendingTitle")}</span>
            <span className="ml-auto text-[10px] text-ink-subtle tabular-nums shrink-0">run {rec.runId.slice(0, 8)}</span>
          </div>
          {rec.inputs?.goalPreview && <div className="text-[12px] text-ink leading-snug line-clamp-2">{rec.inputs.goalPreview}</div>}
          {Array.isArray(rec.reason) && rec.reason.length > 0 && (
            <div className="text-[11px] text-ink-muted leading-snug">
              {tr("org.governance.reasonLabel")}: {rec.reason.join(" · ")}
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-0.5">
            <button
              onClick={() => void decideApproval(rec.runId, "approve")}
              disabled={!!approvalBusy}
              className="btn-primary px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors"
            >
              {tr("org.governance.approve")}
            </button>
            <button onClick={() => void decideApproval(rec.runId, "reject")} disabled={!!approvalBusy} className="btn-sm">
              {tr("org.governance.reject")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );

  // 底部横栏:消息流横向占满(左,吃掉大部分宽度)+ 输入区在右(固定窄列,模式按钮/输入框纵向堆叠)。
  // 消息流(占满剩余高度,滚动)与 控制条(命令菜单/模式条/输入行)——两种朝向(侧栏纵列 vs 底部横栏)
  // 结构完全相同,唯一区别在外层容器的 flex 方向与尺寸维度,故只写一份。
  const feedScroll = (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
      {feedList}
    </div>
  );
  const controlBar = (
    <div className="shrink-0 border-t border-hairline p-2.5 flex flex-col gap-1.5 relative">
      {slashMenu}
      {modeBar}
      {skillChip}
      {inputRow}
    </div>
  );

  if (dock === "bottom") {
    return (
      <div className="shrink-0 relative group w-full border-t border-hairline bg-surface-1 flex flex-col" style={{ height: size }}>
        {resizeHandle}
        {header}
        {glanceBar}
        {ceoCockpitEl}
        {approvalCardsEl}
        {automationPanelEl}
        {feedScroll}
        {controlBar}
        {pmModalEl}
      </div>
    );
  }

  // 右侧栏(现状):纵向堆叠——一眼条 → CEO 驾驶舱 → 自动化卡 → 消息流(占满剩余高度)→ 控制条。
  return (
    <div className="shrink-0 relative group border-l border-hairline bg-surface-1 flex flex-col h-full" style={{ width: size }}>
      {resizeHandle}
      {header}
      {glanceBar}
      {ceoCockpitEl}
      {approvalCardsEl}
      {automationPanelEl}
      {feedScroll}
      {controlBar}
      {pmModalEl}
    </div>
  );
}
