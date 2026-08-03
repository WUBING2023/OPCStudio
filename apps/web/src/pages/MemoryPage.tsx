import { useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain, Lightbulb, GraduationCap, Layers, Library, ListChecks, ExternalLink, ShieldOff, RefreshCw, AlertTriangle,
  Check, X, ShieldCheck, Download, Copy, UserCheck,
  Building2, Users, User, FileText, Wrench, BookOpen, Workflow, Archive, CircleSlash,
  ChevronDown, ChevronRight,
} from "lucide-react";
import type { Company, AgentNodeConfig } from "@opc/shared";
import * as api from "../api/client.js";
import { useT } from "../i18n.js";
import { pushToast } from "../components/common/Toast.js";
import { confirmDialog } from "../components/common/ConfirmDialog.js";
import { fmtRelativeTime } from "../components/trace/traceFormat.js";
import { ROLE_COLORS } from "../lib/agentMeta.js";
import HelpTip from "../components/HelpTip.js";
import InfoDisclosure from "../components/common/InfoDisclosure.js";
import { openRun, type MemoryNavigationTarget } from "../lib/navigation.js";

// 记忆面板:把 Layer B(结论)/ Layer D(程序技能+拆分模板)/ Layer E(失败教训)三类黑盒记忆可视化。
// 后端只有 GET,无独立 web 类型导出——本地镜像 apps/server/src/storage/{registryStore,reflectionStore}.ts
// 的 zod schema 形状(web 不跨包读 server 内部文件,与 components/cost/types.ts 等既有做法一致)。

interface ConclusionSummary {
  id: string; kind: "conclusion_summary"; runId: string; companyId?: string; teamId?: string;
  goalSlug: string; points: string[]; tags: string[]; createdAt: string;
  status?: "pending" | "approved" | "rejected"; // P2:undefined 视为 approved(老数据/审核模式关闭)
}
interface PendingRunMemoryProposal {
  runId: string;
  proposalId: string;
  companyId: string;
  kind: string;
  content: string;
  risk: "low" | "high";
  status: "pending";
  source: "run_conclusion" | "reflection_lesson";
  createdAt: string;
  updatedAt: string;
  reviewPriority: "key" | "background";
  reviewReason: "verified_high_risk_conclusion" | "repeated_lesson" | "substantive_risk" | "background_candidate";
  support?: number;
}

interface ProceduralSkill {
  id: string; kind: "procedural_skill"; role: string; taskType?: string;
  successfulSequence: string[]; support: number; successRate: number; sourceRuns: string[];
  status: "candidate" | "verified" | "retired"; createdAt: string; updatedAt: string;
}
interface PlanTemplate {
  id: string; kind: "plan_template"; companyId?: string; taskType: string; goalSlug: string;
  split: string[]; workerCount: number; sourceRun: string; support: number; createdAt: string; updatedAt: string;
}
type MemoryRecord = ConclusionSummary | ProceduralSkill | PlanTemplate;

interface ReflectionLesson {
  id: string;
  kind: "failure_lesson" | "risk_warning" | "policy_candidate";
  scope: { companyId?: string; teamId?: string; role?: string; agentId?: string; taskType?: string; workflowStage?: string };
  lesson: string;
  recommendedChange: string;
  evidence: { runId: string; agentId?: string };
  confidence: number;
  status: "proposed" | "committed" | "revoked" | "superseded";
  createdAt: string;
  updatedAt: string;
  boundAgentIds?: string[]; // C6 · 一键应用到员工训练:已强绑定给哪些员工
}

// 记忆层级真实注入资格(契约见 apps/server/src/routes/memoryRoutes.ts 的 /api/memory/layers)——本地镜像。
interface MemoryLayerStat { key: string; count: number; eligibleCount: number; eligibleForPrompt: boolean }
interface MemoryLayersResult { layers: MemoryLayerStat[]; lastContextBuild: { runId: string; at: string } | null; generatedAt: string }
// 跨 run 已审批经验(committed-memories.json,GET /api/memory/committed 返回)——本地镜像。
interface CommittedMemoryItem {
  memoryId: string; version: number; scope: string; type: string; content: string;
  approvedBy: string; confidence: number; createdAt: string; runId: string; role?: string; tags?: string[];
}

type TFunc = (key: string, params?: Record<string, string | number>) => string;
type Tab = "library" | "lessons" | "layers";

function tabForMemoryKind(kind: string): Tab {
  if (kind === "lesson" || kind === "failure_lesson" || kind === "risk_warning" || kind === "policy_candidate") return "lessons";
  if (kind === "committed" || kind === "memory_entry" || kind.startsWith("md_")) return "layers";
  return "library";
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const withinDays = (iso: string, ms: number) => Date.now() - Date.parse(iso) < ms; // 非法日期 → NaN 比较恒 false，安全兜底

// 维度栏 · 时间(纯客户端,按 createdAt 过滤)。
type TimeFilter = "all" | "7d" | "30d" | "custom";
interface MemoryPageSessionState {
  companyId: string | null;
  timeFilter: TimeFilter;
  roleFilter: string | null;
  customStart: string;
  customEnd: string;
  tab: Tab;
  scrollTop: number;
}
const DEFAULT_MEMORY_PAGE_STATE: MemoryPageSessionState = { companyId: null, timeFilter: "all", roleFilter: null, customStart: "", customEnd: "", tab: "library", scrollTop: 0 };
// 仅保留在当前渲染进程中:切换页面再回来可恢复，客户端重启/刷新后自然回到默认。
const memoryPageGlobal = globalThis as typeof globalThis & { __opcMemoryPageSession?: MemoryPageSessionState };
const memoryPageSession = memoryPageGlobal.__opcMemoryPageSession ??= { ...DEFAULT_MEMORY_PAGE_STATE };
const FILTER_CONTROL_CLASS = "h-8 min-w-0 rounded-md border border-hairline bg-surface-1 px-2 text-[12px] text-ink outline-none focus:border-accent";

export function matchesMemoryTime(iso: string, filter: TimeFilter, customStart = "", customEnd = "", now = Date.now()): boolean {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return false;
  if (filter === "all") return true;
  if (filter === "7d") return now - timestamp < SEVEN_DAYS_MS;
  if (filter === "30d") return now - timestamp < THIRTY_DAYS_MS;
  const start = customStart ? new Date(`${customStart}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY;
  const end = customEnd ? new Date(`${customEnd}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY;
  return timestamp >= start && timestamp <= end;
}

// 复用 SkillsPage 同一套角色→i18n key 映射，避免面板间角色文案不一致。
const ROLE_LABEL_KEYS: Record<string, string> = {
  ceo: "skills.role.ceo", lead: "skills.role.lead", architect: "skills.role.architect",
  dev: "skills.role.dev", test: "skills.role.test", ops: "skills.role.ops", security: "skills.role.security",
};
function roleLabel(role: string, tr: TFunc): string {
  const k = ROLE_LABEL_KEYS[role.toLowerCase()];
  return k ? tr(k) : role;
}

function RunLink({ runId, tr }: { runId: string; tr: TFunc }) {
  if (!runId) return null;
  return (
    <button onClick={() => openRun(runId)}
      className="inline-flex items-center gap-1 text-[12px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80 transition-opacity">
      <ExternalLink size={11} /> {tr("memory.viewRun")}
    </button>
  );
}

// total:该指标不受当前维度筛选(公司/时间/角色)影响的全量值。筛选生效时显示"N / 总 M"，不生效时只显示 N
// (维度栏铁律 item 3:计数卡随筛选联动)。
function StatCard({ icon, label, value, total, growth, tr }: { icon: React.ReactNode; label: string; value: number; total?: number; growth: number; tr: TFunc }) {
  const filtered = total != null && total !== value;
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 px-4 py-4 flex items-center gap-3">
      <div className="w-9 h-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-[22px] font-bold text-ink tabular-nums leading-tight" title={filtered ? tr("memory.stat.filteredTooltip", { n: value, total: total ?? 0 }) : undefined}>
          {value}{filtered && <span className="text-ink-subtle text-[13px] font-medium"> / {total}</span>}
        </div>
        <div className="text-[11px] text-ink-muted">
          {label}
          {growth > 0 && <span className="text-green ml-1.5">{tr("memory.stat.growth7d", { n: growth })}</span>}
        </div>
      </div>
    </div>
  );
}

function EmptyGuide({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-dashed border-hairline bg-surface-1/50 py-10 px-6 text-center">
      <div className="mx-auto mb-3 text-ink-subtle opacity-50 flex justify-center">{icon}</div>
      <p className="m-0 mb-1 text-[14px] font-medium text-ink-muted">{title}</p>
      <p className="m-0 text-[12px] text-ink-subtle">{body}</p>
    </div>
  );
}

function ConclusionCard({ rec, tr }: { rec: ConclusionSummary; tr: TFunc }) {
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 text-[14px] font-semibold text-ink leading-snug">{rec.goalSlug || tr("memory.library.untitledGoal")}</h4>
        <span className="text-[11px] text-ink-subtle shrink-0 tabular-nums">{fmtRelativeTime(rec.createdAt, tr)}</span>
      </div>
      {rec.points.length > 0 && (
        <ul className="m-0 pl-4 space-y-1">
          {rec.points.map((p, i) => <li key={i} className="text-[13px] text-ink-muted leading-snug">{p}</li>)}
        </ul>
      )}
      {rec.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {rec.tags.map(tag => <span key={tag} className="text-[10px] bg-accent/10 text-accent rounded-lg px-2 py-0.5">{tag}</span>)}
        </div>
      )}
      <div className="mt-1"><RunLink runId={rec.runId} tr={tr} /></div>
    </div>
  );
}

// P2 · 待审核提案卡:与 ConclusionCard 同一预览布局(内容一致,只是审核态),底部换成批准/拒绝操作。
function ProposalCard({ rec, tr, onApprove, onReject }: { rec: ConclusionSummary; tr: TFunc; onApprove: (id: string) => void; onReject: (id: string) => void }) {
  return (
    <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <h4 className="m-0 text-[14px] font-semibold text-ink leading-snug">{rec.goalSlug || tr("memory.library.untitledGoal")}</h4>
        <span className="text-[11px] text-ink-subtle shrink-0 tabular-nums">{fmtRelativeTime(rec.createdAt, tr)}</span>
      </div>
      {rec.points.length > 0 && (
        <ul className="m-0 pl-4 space-y-1">
          {rec.points.map((p, i) => <li key={i} className="text-[13px] text-ink-muted leading-snug">{p}</li>)}
        </ul>
      )}
      {rec.tags.length > 0 && (
        <div className="flex gap-1 flex-wrap">
          {rec.tags.map(tag => <span key={tag} className="text-[10px] bg-accent/10 text-accent rounded-lg px-2 py-0.5">{tag}</span>)}
        </div>
      )}
      <div className="flex items-center justify-between mt-1">
        <RunLink runId={rec.runId} tr={tr} />
        <div className="flex items-center gap-2">
          <button onClick={() => onReject(rec.id)}
            className="inline-flex items-center gap-1 text-[11px] text-red bg-transparent border border-red/30 rounded-full px-2 py-0.5 cursor-pointer hover:bg-red/10 transition-colors">
            <X size={11} /> {tr("memory.proposals.reject")}
          </button>
          <button onClick={() => onApprove(rec.id)}
            className="btn-primary inline-flex items-center gap-1 text-[11px] px-2 py-0.5">
            <Check size={11} /> {tr("memory.proposals.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunProposalCard({ rec, tr, onApprove, onReject }: {
  rec: PendingRunMemoryProposal;
  tr: TFunc;
  onApprove: (rec: PendingRunMemoryProposal) => void;
  onReject: (rec: PendingRunMemoryProposal) => void;
}) {
  return (
    <div className="rounded-xl border border-amber/30 bg-amber/5 p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] font-semibold text-ink">
            {tr(`memory.proposals.source.${rec.source}`)}
          </span>
          <span className={`badge ${rec.risk === "high" ? "bg-red/15 text-red" : "bg-surface-2 text-ink-muted"}`}>
            {tr(`memory.proposals.risk.${rec.risk}`)}
          </span>
          {rec.reviewReason === "repeated_lesson" && (
            <span className="badge bg-accent/10 text-accent">{tr("memory.proposals.repeated", { n: rec.support ?? 2 })}</span>
          )}
        </div>
        <span className="text-[11px] text-ink-subtle shrink-0 tabular-nums">{fmtRelativeTime(rec.createdAt, tr)}</span>
      </div>
      <p className="m-0 text-[13px] text-ink-muted leading-snug whitespace-pre-wrap">{rec.content}</p>
      <div className="text-[10px] text-ink-subtle">{rec.kind}</div>
      <div className="flex items-center justify-between mt-1">
        <RunLink runId={rec.runId} tr={tr} />
        <div className="flex items-center gap-2">
          <button onClick={() => onReject(rec)}
            className="inline-flex items-center gap-1 text-[11px] text-red bg-transparent border border-red/30 rounded-full px-2 py-0.5 cursor-pointer hover:bg-red/10 transition-colors">
            <X size={11} /> {tr("memory.proposals.reject")}
          </button>
          <button onClick={() => onApprove(rec)}
            className="btn-primary inline-flex items-center gap-1 text-[11px] px-2 py-0.5">
            <Check size={11} /> {tr("memory.proposals.approve")}
          </button>
        </div>
      </div>
    </div>
  );
}

const SKILL_STATUS_CLASS: Record<ProceduralSkill["status"], string> = {
  candidate: "bg-surface-2 text-ink-subtle", verified: "bg-green/15 text-green", retired: "bg-surface-2 text-ink-muted",
};

function SkillCard({ rec, tr }: { rec: ProceduralSkill; tr: TFunc }) {
  const roleColor = ROLE_COLORS[rec.role] || "var(--color-accent)";
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="badge text-white" style={{ background: roleColor }}>{roleLabel(rec.role, tr)}</span>
          {rec.taskType && <span className="text-[11px] text-ink-muted">{rec.taskType}</span>}
        </div>
        <span className={`badge ${SKILL_STATUS_CLASS[rec.status]}`}>
          {tr(`memory.library.skillStatus.${rec.status}`)}
        </span>
      </div>
      {rec.successfulSequence.length > 0 && (
        <ol className="m-0 pl-4 space-y-0.5">
          {rec.successfulSequence.map((s, i) => <li key={i} className="text-[12px] text-ink-muted leading-snug">{s}</li>)}
        </ol>
      )}
      <div className="flex items-center gap-3 text-[11px] text-ink-subtle mt-0.5">
        <span>{tr("memory.library.skillSupport", { n: rec.support })}</span>
        {rec.successRate > 0 && <span>{tr("memory.library.skillSuccessRate", { pct: Math.round(rec.successRate * 100) })}</span>}
      </div>
      {rec.sourceRuns.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {rec.sourceRuns.slice(-5).map(runId => (
            <button key={runId} onClick={() => openRun(runId)} title={runId}
              className="text-[11px] font-mono text-accent bg-accent/10 rounded px-1.5 py-0.5 border-none cursor-pointer hover:bg-accent/20 transition-colors">
              {runId.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PlanTemplateCard({ rec, tr }: { rec: PlanTemplate; tr: TFunc }) {
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="m-0 text-[13px] font-semibold text-ink leading-snug">{rec.goalSlug || rec.taskType}</h4>
        <span className="badge bg-surface-2 text-ink-muted shrink-0">{tr("memory.library.planWorkerCount", { n: rec.workerCount })}</span>
      </div>
      {rec.split.length > 0 && (
        <ol className="m-0 pl-4 space-y-1">
          {rec.split.map((s, i) => <li key={i} className="text-[13px] text-ink-muted leading-snug">{s}</li>)}
        </ol>
      )}
      <div className="flex items-center justify-between mt-1">
        <span className="text-[11px] text-ink-subtle">{tr("memory.library.planSupport", { n: rec.support })}</span>
        <RunLink runId={rec.sourceRun} tr={tr} />
      </div>
    </div>
  );
}

const LESSON_STATUS_CLASS: Record<ReflectionLesson["status"], string> = {
  proposed: "bg-amber/15 text-amber", committed: "bg-green/15 text-green",
  revoked: "bg-surface-2 text-ink-muted", superseded: "bg-surface-2 text-ink-muted",
};

// C6 · 一键应用到员工训练:候选员工 = 与该经验 scope.role 同角色的员工(无 role 字段的经验不筛,全员可选)。
function LessonCard({ l, tr, agents, onRevoke, onApply }: {
  l: ReflectionLesson; tr: TFunc; agents: AgentNodeConfig[]; onRevoke: (id: string) => void; onApply: (lessonId: string, agentId: string) => void;
}) {
  const revocable = l.status === "committed" || l.status === "proposed";
  const candidates = agents.filter((a) => !l.scope.role || a.role === l.scope.role);
  const boundNames = (l.boundAgentIds ?? []).map((id) => agents.find((a) => a.id === id)?.name || id);
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 p-4 flex flex-col gap-2" style={l.status === "revoked" || l.status === "superseded" ? { opacity: 0.55 } : undefined}>
      <div className="flex items-center flex-wrap gap-1.5">
        <span className="badge text-white" style={{ background: l.scope.role ? (ROLE_COLORS[l.scope.role] || "var(--color-accent)") : "var(--color-ink-muted)" }}>
          {l.scope.role ? roleLabel(l.scope.role, tr) : tr("memory.lessons.noRole")}
        </span>
        {l.scope.taskType && <span className="badge bg-surface-2 text-ink-muted">{l.scope.taskType}</span>}
        <span className={`badge ${LESSON_STATUS_CLASS[l.status]}`}>{tr(`memory.lessons.status.${l.status}`)}</span>
        <div className="flex-1" />
        <span className="text-[11px] text-ink-subtle tabular-nums shrink-0">{fmtRelativeTime(l.createdAt, tr)}</span>
      </div>
      <p className="m-0 text-[13px] text-ink leading-snug">{l.lesson}</p>
      {l.recommendedChange && (
        <p className="m-0 text-[12px] text-ink-muted leading-snug">
          <span className="text-ink-subtle">{tr("memory.lessons.recommendedChange")}: </span>{l.recommendedChange}
        </p>
      )}
      <div className="flex items-center justify-between mt-1">
        <div className="flex items-center gap-3">
          <RunLink runId={l.evidence.runId} tr={tr} />
          <span className="text-[11px] text-ink-subtle">{tr("memory.lessons.confidence", { pct: Math.round(l.confidence * 100) })}</span>
        </div>
        {revocable && (
          <button onClick={() => onRevoke(l.id)}
            className="inline-flex items-center gap-1 text-[11px] text-red bg-transparent border border-red/30 rounded-full px-2 py-0.5 cursor-pointer hover:bg-red/10 transition-colors">
            <ShieldOff size={11} /> {tr("memory.lessons.revoke")}
          </button>
        )}
      </div>
      {/* C6 · 只对已生效(committed)的经验有意义——proposed/revoked 从不会被 retrieveLessons 命中,
          绑定了也不会真的被检索到,不给用户一个没有效果的入口。 */}
      {l.status === "committed" && (
        <div className="flex items-center gap-1.5 flex-wrap pt-1 border-t border-hairline/40 mt-0.5">
          <UserCheck size={11} className="text-ink-subtle shrink-0" />
          {boundNames.length > 0 && (
            <span className="text-[11px] text-accent" title={boundNames.join(", ")}>{tr("memory.lessons.boundBadge", { n: boundNames.length })}</span>
          )}
          <select
            value=""
            onChange={(e) => { if (e.target.value) onApply(l.id, e.target.value); }}
            className="text-[11px] bg-surface-0 border border-hairline rounded-md px-1.5 py-0.5 text-ink-muted outline-none cursor-pointer focus:border-accent max-w-[160px]"
          >
            <option value="">{tr("memory.lessons.applyToAgentPick")}</option>
            {candidates.length === 0 && <option value="" disabled>{tr("memory.lessons.noAgentsForRole")}</option>}
            {candidates.map((a) => (
              <option key={a.id} value={a.id} disabled={l.boundAgentIds?.includes(a.id)}>
                {a.name}{l.boundAgentIds?.includes(a.id) ? ` · ${tr("memory.lessons.appliedToAgent")}` : ""}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

function triggerJsonDownload(data: unknown, filename: string): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// P3 · 安全摘要导出弹层:选公司 → 拉 /companies/:id/memory-digest → 展示(已脱敏)practices/lessons →
// 下载 JSON(浏览器原生 Blob,零依赖)或复制到剪贴板。practices 目前服务端恒空(如实展示空态)。
function DigestModal({ companies, defaultCompanyId, tr, onClose }: { companies: Company[]; defaultCompanyId: string | null; tr: TFunc; onClose: () => void }) {
  const [companyId, setCompanyId] = useState<string | null>(defaultCompanyId ?? companies[0]?.id ?? null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<api.MemoryDigestResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchDigest = useCallback(() => {
    if (!companyId) return;
    setLoading(true); setErr(null); setResult(null); setCopied(false);
    api.getMemoryDigest(companyId, 3)
      .then(setResult)
      .catch(e => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, [companyId]);

  const download = () => {
    if (!result || !companyId) return;
    triggerJsonDownload(result, `memory-digest-${companyId}-${Date.now()}.json`);
  };

  const copy = () => {
    if (!result) return;
    navigator.clipboard?.writeText(JSON.stringify(result, null, 2))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
      className="modal-overlay" onClick={onClose}>
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }} transition={{ duration: 0.15 }}
        className="modal-content w-[440px] max-w-[92vw] max-h-[82vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="m-0 text-[14px] font-semibold text-ink flex items-center gap-1.5">
            <ShieldCheck size={16} className="text-accent" />{tr("memory.digest.title")}
            <HelpTip text={tr("memory.digest.subtitle")} />
          </h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg bg-surface-2 text-ink-muted hover:text-ink cursor-pointer border-none shrink-0">
            <X size={14} />
          </button>
        </div>

        <div className="flex items-center gap-2 mb-3">
          <select value={companyId ?? ""} onChange={e => { setCompanyId(e.target.value || null); setResult(null); setErr(null); }}
            className="flex-1 bg-surface-0 border border-hairline rounded text-[13px] text-ink px-2 py-1.5 outline-none cursor-pointer focus:border-accent">
            {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={fetchDigest} disabled={!companyId || loading} className="btn-primary shrink-0">
            {loading ? tr("memory.digest.generating") : tr("memory.digest.generate")}
          </button>
        </div>

        {err && <div className="mb-3 px-3 py-2 rounded-lg bg-red/10 text-red text-[13px] flex items-center gap-2"><AlertTriangle size={14} />{err}</div>}

        {result && (
          <div className="space-y-3">
            <div>
              <div className="text-ink font-semibold text-[13px] mb-1.5">{tr("memory.digest.practices")}</div>
              {result.practices.length === 0 ? (
                <p className="m-0 text-[12px] text-ink-subtle">{tr("memory.digest.practicesEmpty")}</p>
              ) : (
                <ul className="m-0 pl-4 space-y-1">
                  {result.practices.map(p => <li key={p.id} className="text-[13px] text-ink-muted leading-snug">{p.text}</li>)}
                </ul>
              )}
            </div>
            <div>
              <div className="text-ink font-semibold text-[13px] mb-1.5">{tr("memory.digest.lessons")}</div>
              {result.lessons.length === 0 ? (
                <p className="m-0 text-[12px] text-ink-subtle">{tr("memory.digest.lessonsEmpty")}</p>
              ) : (
                <ul className="m-0 pl-4 space-y-1.5">
                  {result.lessons.map(l => (
                    <li key={l.id} className="text-[13px] text-ink-muted leading-snug">
                      {l.text}
                      <span className="text-ink-subtle text-[11px] ml-1.5">{tr("memory.lessons.confidence", { pct: Math.round(l.confidence * 100) })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="text-[11px] text-ink-subtle">{tr("memory.digest.generatedAt", { time: fmtRelativeTime(result.generatedAt, tr) })}</div>
            <div className="flex gap-2 pt-1">
              <button onClick={download} className="btn-secondary inline-flex items-center gap-1.5"><Download size={13} />{tr("memory.digest.download")}</button>
              <button onClick={copy} className="btn-secondary inline-flex items-center gap-1.5">
                {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />}
                {copied ? tr("memory.digest.copied") : tr("memory.digest.copy")}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}

// 记忆层级 · 每层静态元数据(展示名 + 注入位置说明 + 图标)。注入资格布尔值取自服务端 layer.eligibleForPrompt
// (不在前端硬编码,避免 UI 与后端事实脱节),此处只负责"这层叫什么、注入到 prompt 的哪个段落"。
const LAYER_META: Record<string, { icon: React.ReactNode; nameKey: string; sectionKey: string }> = {
  md_company: { icon: <Building2 size={15} />, nameKey: "memory.layers.name.md_company", sectionKey: "memory.layers.section.md_company" },
  md_team: { icon: <Users size={15} />, nameKey: "memory.layers.name.md_team", sectionKey: "memory.layers.section.md_team" },
  md_project: { icon: <FileText size={15} />, nameKey: "memory.layers.name.md_project", sectionKey: "memory.layers.section.md_project" },
  md_agent: { icon: <User size={15} />, nameKey: "memory.layers.name.md_agent", sectionKey: "memory.layers.section.md_agent" },
  skill: { icon: <Wrench size={15} />, nameKey: "memory.layers.name.skill", sectionKey: "memory.layers.section.skill" },
  memory_entry: { icon: <BookOpen size={15} />, nameKey: "memory.layers.name.memory_entry", sectionKey: "memory.layers.section.memory_entry" },
  lesson: { icon: <GraduationCap size={15} />, nameKey: "memory.layers.name.lesson", sectionKey: "memory.layers.section.lesson" },
  conclusion: { icon: <Lightbulb size={15} />, nameKey: "memory.layers.name.conclusion", sectionKey: "memory.layers.section.conclusion" },
  procedural_skill: { icon: <Workflow size={15} />, nameKey: "memory.layers.name.procedural_skill", sectionKey: "memory.layers.section.procedural_skill" },
  plan_template: { icon: <Layers size={15} />, nameKey: "memory.layers.name.plan_template", sectionKey: "memory.layers.section.plan_template" },
  committed: { icon: <Archive size={15} />, nameKey: "memory.layers.name.committed", sectionKey: "memory.layers.section.committed" },
};

function InjectBadge({ injected, tr }: { injected: boolean; tr: TFunc }) {
  return injected ? (
    <span className="badge inline-flex items-center gap-1 bg-green/15 text-green">
      <Check size={10} /> {tr("memory.layers.injected")}
    </span>
  ) : (
    <span className="badge inline-flex items-center gap-1 bg-surface-2 text-ink-subtle">
      <CircleSlash size={10} /> {tr("memory.layers.archived")}
    </span>
  );
}

function LayerRow({ layer, tr }: { layer: MemoryLayerStat; tr: TFunc }) {
  const meta = LAYER_META[layer.key];
  const injected = layer.eligibleForPrompt;
  const partial = injected && layer.eligibleCount !== layer.count;
  return (
    <div className="flex items-center gap-3 rounded-xl border border-hairline/60 bg-surface-1 px-4 py-3" style={injected ? undefined : { opacity: 0.72 }}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${injected ? "bg-accent/10 text-accent" : "bg-surface-2 text-ink-subtle"}`}>
        {meta?.icon ?? <Layers size={15} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[13px] font-semibold text-ink">{tr(meta?.nameKey ?? layer.key)}</span>
          <InjectBadge injected={injected} tr={tr} />
        </div>
        <div className="text-[11px] text-ink-subtle mt-0.5 leading-snug">{tr(meta?.sectionKey ?? "")}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="text-[16px] font-bold text-ink tabular-nums leading-tight">{layer.count}</div>
        {partial && <div className="text-[11px] text-green">{tr("memory.layers.eligibleOf", { n: layer.eligibleCount })}</div>}
        {injected && !partial && layer.count > 0 && <div className="text-[11px] text-ink-subtle">{tr("memory.layers.allEligible")}</div>}
      </div>
    </div>
  );
}

function CommittedCard({ c, tr }: { c: CommittedMemoryItem; tr: TFunc }) {
  return (
    <div className="rounded-xl border border-hairline/60 bg-surface-1 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="badge bg-surface-2 text-ink-muted">{c.type || tr("memory.layers.committedGeneric")}</span>
        <InjectBadge injected={false} tr={tr} />
      </div>
      <p className="m-0 text-[13px] text-ink leading-snug">{c.content}</p>
      <div className="flex items-center justify-between mt-1 gap-2 flex-wrap">
        <RunLink runId={c.runId} tr={tr} />
        <span className="text-[11px] text-ink-subtle">
          {tr("memory.layers.approvedBy", { by: c.approvedBy || "-" })} · {tr("memory.lessons.confidence", { pct: Math.round((c.confidence ?? 0) * 100) })}
        </span>
      </div>
    </div>
  );
}

function LayersView({ data, committed, tr }: { data: MemoryLayersResult | null; committed: CommittedMemoryItem[]; tr: TFunc }) {
  if (!data) return <EmptyGuide icon={<Layers size={32} />} title={tr("memory.layers.emptyTitle")} body={tr("memory.layers.emptyBody")} />;
  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-hairline/60 bg-surface-1/60 px-4 py-3 flex items-start gap-2.5">
        <Brain size={15} className="text-accent shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <InfoDisclosure>{tr("memory.layers.intro")}</InfoDisclosure>
          <p className="m-0 mt-1 text-[11px] text-ink-subtle leading-snug">
            {data.lastContextBuild
              ? <>{tr("memory.layers.lastBuild")}: <RunLink runId={data.lastContextBuild.runId} tr={tr} /> · {fmtRelativeTime(data.lastContextBuild.at, tr)}</>
              : tr("memory.layers.lastBuildNone")}
          </p>
        </div>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {data.layers.map((l) => <LayerRow key={l.key} layer={l} tr={tr} />)}
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-ink font-semibold text-[13px] mb-1">
          <Archive size={14} />{tr("memory.layers.committedTitle")}
          <span className="badge bg-surface-2 text-ink-muted">{committed.length}</span>
        </div>
        <InfoDisclosure className="mb-3">{tr("memory.layers.committedNote")}</InfoDisclosure>
        {committed.length === 0 ? (
          <EmptyGuide icon={<Archive size={30} />} title={tr("memory.layers.committedEmptyTitle")} body={tr("memory.layers.committedEmptyBody")} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
            {committed.map((c) => <CommittedCard key={c.memoryId} c={c} tr={tr} />)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function MemoryPage() {
  const tr = useT();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [companyId, setCompanyId] = useState<string | null>(() => memoryPageSession.companyId);
  const [timeFilter, setTimeFilter] = useState<TimeFilter>(() => memoryPageSession.timeFilter);
  const [roleFilter, setRoleFilter] = useState<string | null>(() => memoryPageSession.roleFilter);
  const [customStart, setCustomStart] = useState(() => memoryPageSession.customStart);
  const [customEnd, setCustomEnd] = useState(() => memoryPageSession.customEnd);
  const [registry, setRegistry] = useState<MemoryRecord[]>([]);
  const [lessons, setLessons] = useState<ReflectionLesson[]>([]);
  const [proposals, setProposals] = useState<ConclusionSummary[]>([]);
  const [runProposals, setRunProposals] = useState<PendingRunMemoryProposal[]>([]);
  const [agents, setAgents] = useState<AgentNodeConfig[]>([]); // C6 · 一键应用到员工训练的候选员工列表
  const [layersData, setLayersData] = useState<MemoryLayersResult | null>(null);
  const [committed, setCommitted] = useState<CommittedMemoryItem[]>([]);
  const [tab, setTab] = useState<Tab>(() => memoryPageSession.tab);
  const [focusedMemory, setFocusedMemory] = useState<MemoryNavigationTarget | null>(null);
  const focusedMemoryRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [proposalsCollapsed, setProposalsCollapsed] = useState(() => {
    try { return sessionStorage.getItem("opc-memory-key-review-open") !== "1"; } catch { return true; }
  });
  const [backgroundProposalsCollapsed, setBackgroundProposalsCollapsed] = useState(true);
  const [digestOpen, setDigestOpen] = useState(false);
  const withinSelectedTime = useCallback((iso: string) => matchesMemoryTime(iso, timeFilter, customStart, customEnd), [timeFilter, customStart, customEnd]);
  const updateCompanyFilter = useCallback((value: string) => { const next = value || null; memoryPageSession.companyId = next; setCompanyId(next); }, []);
  const updateTimeFilter = useCallback((value: string) => { const next = value as TimeFilter; memoryPageSession.timeFilter = next; setTimeFilter(next); }, []);
  const updateRoleFilter = useCallback((value: string) => { const next = value || null; memoryPageSession.roleFilter = next; setRoleFilter(next); }, []);
  const updateCustomStart = useCallback((value: string) => { memoryPageSession.customStart = value; setCustomStart(value); }, []);
  const updateCustomEnd = useCallback((value: string) => { memoryPageSession.customEnd = value; setCustomEnd(value); }, []);

  const load = useCallback(() => {
    setLoading(true); setErr(null);
    const companiesRequest = api.get<Company[]>("/companies");
    Promise.all([
      companiesRequest,
      api.get<MemoryRecord[]>("/memory/registry"),
      api.get<ReflectionLesson[]>("/memory/lessons"),
      api.get<ConclusionSummary[]>("/memory/proposals"),
      api.get<AgentNodeConfig[]>("/agents"),
      // /api/agents 不过滤软删除(enabled:false)员工——同 useAgentStore.load() 的既有口径在此镜像一份,
      // 避免"应用到员工训练"选择器里出现已删除的员工。
      // 记忆层级 + 已审批经验:单独 catch 兜底,任一失败不拖垮整页(退化为空/隐藏对应视图)。
      api.get<MemoryLayersResult>("/memory/layers").catch(() => null),
      api.get<CommittedMemoryItem[]>("/memory/committed").catch(() => [] as CommittedMemoryItem[]),
      api.get<PendingRunMemoryProposal[]>("/memory/run-proposals"),
    ]).then(([cs, reg, ls, props, ags, lys, cm, runProps]) => {
      setCompanies(cs || []); setRegistry(reg || []); setLessons(ls || []); setProposals(props || []);
      setRunProposals(runProps || []);
      setAgents((ags || []).filter(a => a.enabled !== false));
      setLayersData(lys || null); setCommitted(cm || []);
    })
      .catch(e => setErr(String(e?.message || e)))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  useLayoutEffect(() => {
    Object.assign(memoryPageSession, { companyId, timeFilter, roleFilter, customStart, customEnd, tab });
  }, [companyId, timeFilter, roleFilter, customStart, customEnd, tab]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (pageRef.current) pageRef.current.scrollTop = memoryPageSession.scrollTop;
    });
    return () => {
      cancelAnimationFrame(frame);
      if (pageRef.current) memoryPageSession.scrollTop = pageRef.current.scrollTop;
    };
  }, []);

  useEffect(() => {
    if (companyId && companies.length > 0 && !companies.some(company => company.id === companyId)) setCompanyId(null);
  }, [companies, companyId]);

  const focusMemory = useCallback((target: MemoryNavigationTarget) => {
    if (!target.memoryId) return;
    setFocusedMemory(target);
    setTab(tabForMemoryKind(target.kind));
    setTimeFilter("all");
    setRoleFilter(null);
    if (target.companyId) setCompanyId(target.companyId);
  }, []);

  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("opc-open-memory");
      if (pending) {
        sessionStorage.removeItem("opc-open-memory");
        focusMemory(JSON.parse(pending) as MemoryNavigationTarget);
      }
    } catch { /* ignore malformed or unavailable storage */ }

    const onOpenMemory = (event: Event) => {
      const detail = (event as CustomEvent).detail as MemoryNavigationTarget | undefined;
      if (detail?.memoryId) {
        try { sessionStorage.removeItem("opc-open-memory"); } catch { /* ignore */ }
        focusMemory(detail);
      }
    };
    window.addEventListener("open-memory-item", onOpenMemory);
    return () => window.removeEventListener("open-memory-item", onOpenMemory);
  }, [focusMemory]);

  useEffect(() => {
    if (!focusedMemory || loading) return;
    const frame = requestAnimationFrame(() => {
      focusedMemoryRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      focusedMemoryRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedMemory, loading, tab]);

  useEffect(() => {
    try { sessionStorage.setItem("opc-memory-key-review-open", proposalsCollapsed ? "0" : "1"); } catch { /* ignore */ }
  }, [proposalsCollapsed]);

  // 结论没有角色字段——角色筛选对它不生效(诚实边界,不假装过滤;库内小 note 说明,见下方 JSX)。
  // pending/rejected 不进"结论"库(未审核/已拒绝的提案不该当作已生效结论展示;它们在下方"待审核"区块单独处理)。
  const conclusions = useMemo(() => registry
    .filter((r): r is ConclusionSummary => r.kind === "conclusion_summary" && r.status !== "pending" && r.status !== "rejected")
    .filter(r => !companyId || !r.companyId || r.companyId === companyId)
    .filter(r => withinSelectedTime(r.createdAt))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [registry, companyId, withinSelectedTime]);

  // 程序技能不挂公司(role 全局共享),公司过滤不影响这张列表;角色筛选对它生效(role 字段存在)。
  // skillsByTime 是"角色筛选前"的中间态,同时供角色下拉的可选项来源(只列实际出现过的角色)。
  const skillsByTime = useMemo(() => registry
    .filter((r): r is ProceduralSkill => r.kind === "procedural_skill")
    .filter(r => withinSelectedTime(r.createdAt)), [registry, withinSelectedTime]);
  const skills = useMemo(() => skillsByTime
    .filter(r => !roleFilter || r.role === roleFilter)
    .sort((a, b) => b.support - a.support), [skillsByTime, roleFilter]);

  // 方案模板既没有角色字段,也不受角色筛选影响(与结论同理)。
  const plans = useMemo(() => registry
    .filter((r): r is PlanTemplate => r.kind === "plan_template")
    .filter(r => !companyId || !r.companyId || r.companyId === companyId)
    .filter(r => withinSelectedTime(r.createdAt))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")), [registry, companyId, withinSelectedTime]);

  // 教训有 scope.role(可能为空)——角色筛选对它生效。lessonsByTime 同样是角色筛选前的中间态。
  const lessonsByTime = useMemo(() => lessons
    .filter(l => !companyId || !l.scope.companyId || l.scope.companyId === companyId)
    .filter(l => withinSelectedTime(l.createdAt)), [lessons, companyId, withinSelectedTime]);
  const filteredLessons = useMemo(() => lessonsByTime
    .filter(l => !roleFilter || l.scope.role === roleFilter)
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "")), [lessonsByTime, roleFilter]);

  // 角色下拉的可选项:只列当前公司+时间筛选下,技能/教训里实际出现过的角色(不列空桶)。
  const availableRoles = useMemo(() => {
    const set = new Set<string>();
    agents.filter(agent => !companyId || agent.companyId === companyId).forEach(agent => {
      if (agent.role) set.add(agent.role);
    });
    return [...set].sort((a, b) => roleLabel(a, tr).localeCompare(roleLabel(b, tr)));
  }, [agents, companyId, tr]);

  useEffect(() => {
    if (!loading && roleFilter && !availableRoles.includes(roleFilter)) setRoleFilter(null);
  }, [availableRoles, loading, roleFilter]);

  // 待审核提案(P2):/memory/proposals 只返回 status==="pending" 的记录;这里只再按当前公司维度过滤,
  // 不受时间/角色筛选影响(审核队列,不是统计视图)。
  const filteredProposals = useMemo(() => proposals
    .filter(p => !companyId || !p.companyId || p.companyId === companyId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [proposals, companyId]);
  const filteredRunProposals = useMemo(() => runProposals
    .filter(p => !companyId || p.companyId === companyId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [runProposals, companyId]);
  const keyRunProposals = useMemo(
    () => filteredRunProposals.filter((proposal) => proposal.reviewPriority === "key"),
    [filteredRunProposals],
  );
  const backgroundRunProposals = useMemo(
    () => filteredRunProposals.filter((proposal) => proposal.reviewPriority !== "key"),
    [filteredRunProposals],
  );
  const keyProposalCount = filteredProposals.length + keyRunProposals.length;

  const activeLessonsCount = useMemo(() => filteredLessons.filter(l => l.status === "committed").length, [filteredLessons]);
  const conclusionGrowth = useMemo(() => conclusions.filter(r => withinDays(r.createdAt, SEVEN_DAYS_MS)).length, [conclusions]);
  const lessonGrowth = useMemo(() => filteredLessons.filter(l => withinDays(l.createdAt, SEVEN_DAYS_MS)).length, [filteredLessons]);
  const skillTemplateCount = skills.length + plans.length;
  const skillTemplateGrowth = useMemo(
    () => [...skills, ...plans].filter(r => withinDays(r.createdAt, SEVEN_DAYS_MS)).length,
    [skills, plans],
  );

  // 计数卡的"总 M"——完全不受任何维度筛选影响的全量值,供 StatCard 显示"筛选后 N / 总 M"。
  const totalConclusions = useMemo(() => registry.filter(r => r.kind === "conclusion_summary").length, [registry]);
  const totalSkillsTemplates = useMemo(() => registry.filter(r => r.kind === "procedural_skill" || r.kind === "plan_template").length, [registry]);
  const totalActiveLessons = useMemo(() => lessons.filter(l => l.status === "committed").length, [lessons]);

  const handleRevoke = async (id: string) => {
    const ok = await confirmDialog({
      title: tr("memory.lessons.revokeConfirmTitle"),
      body: tr("memory.lessons.revokeConfirmBody"),
      danger: true,
      confirmLabel: tr("memory.lessons.revoke"),
    });
    if (!ok) return;
    try {
      await api.post(`/memory/lessons/${id}/revoke`, {});
      pushToast("success", tr("memory.lessons.revokeSuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.lessons.revokeFailed") + (e?.message || ""));
    }
  };

  // C6 · 一键应用到员工训练:把某条经验强绑定到指定员工。
  const handleApplyToAgent = async (lessonId: string, agentId: string) => {
    try {
      await api.post(`/memory/lessons/${lessonId}/bind-agent`, { agentId });
      pushToast("success", tr("memory.lessons.applySuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.lessons.applyFailed") + (e?.message || ""));
    }
  };

  const handleApproveProposal = async (id: string) => {
    try {
      await api.post(`/memory/proposals/${id}/approve`, {});
      pushToast("success", tr("memory.proposals.approveSuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.proposals.approveFailed") + (e?.message || ""));
    }
  };

  const handleApproveRunProposal = async (proposal: PendingRunMemoryProposal) => {
    try {
      await api.post(`/runs/${encodeURIComponent(proposal.runId)}/memory-proposals/${encodeURIComponent(proposal.proposalId)}/approve`, {});
      pushToast("success", tr("memory.proposals.runApproveSuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.proposals.approveFailed") + (e?.message || ""));
    }
  };

  const handleRejectRunProposal = async (proposal: PendingRunMemoryProposal) => {
    const ok = await confirmDialog({
      title: tr("memory.proposals.rejectConfirmTitle"),
      body: tr("memory.proposals.rejectConfirmBody"),
      danger: true,
      confirmLabel: tr("memory.proposals.reject"),
    });
    if (!ok) return;
    try {
      await api.post(`/runs/${encodeURIComponent(proposal.runId)}/memory-proposals/${encodeURIComponent(proposal.proposalId)}/reject`, {});
      pushToast("success", tr("memory.proposals.runRejectSuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.proposals.rejectFailed") + (e?.message || ""));
    }
  };

  const handleRejectProposal = async (id: string) => {
    const ok = await confirmDialog({
      title: tr("memory.proposals.rejectConfirmTitle"),
      body: tr("memory.proposals.rejectConfirmBody"),
      danger: true,
      confirmLabel: tr("memory.proposals.reject"),
    });
    if (!ok) return;
    try {
      await api.post(`/memory/proposals/${id}/reject`, {});
      pushToast("success", tr("memory.proposals.rejectSuccess"));
      load();
    } catch (e: any) {
      pushToast("error", tr("memory.proposals.rejectFailed") + (e?.message || ""));
    }
  };

  // 层级/已审批经验有内容(md/技能/跨run committed 等)时也不算空——否则纯记忆场景会被空态挡住看不到层级页。
  const layersHaveContent = !!layersData && (committed.length > 0 || layersData.layers.some(l => l.count > 0));
  const isEmpty = registry.length === 0 && lessons.length === 0 && proposals.length === 0 && runProposals.length === 0 && !layersHaveContent;

  return (
    <div ref={pageRef} onScroll={event => { memoryPageSession.scrollTop = event.currentTarget.scrollTop; }} className="h-full overflow-auto p-5">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <Brain size={18} className="text-accent" />
          <h1 className="text-ink font-bold text-[16px] tracking-tight m-0">{tr("memory.title")}</h1>
          <HelpTip text={tr("memory.subtitle")} />
          <div className="flex-1" />
          {companies.length > 0 && (
            <button onClick={() => setDigestOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-2 text-ink-muted hover:text-ink cursor-pointer border-none text-[12px] font-medium">
              <ShieldCheck size={14} /> {tr("memory.digest.entry")}
            </button>
          )}
          <button onClick={load} title={tr("memory.refresh")} className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-2 text-ink-muted hover:text-ink cursor-pointer border-none">
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>

        {err && <div className="mb-4 px-4 py-2 rounded-lg bg-red/10 text-red text-[13px] flex items-center gap-2"><AlertTriangle size={15} />{err}</div>}

        <div data-testid="memory-filter-bar" className="mb-4 rounded-lg border border-hairline bg-surface-1 px-3 py-2.5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <label className="min-w-0 flex flex-col gap-1">
              <span className="text-[10px] text-ink-subtle">{tr("memory.filter.company.label")}</span>
              <select data-testid="memory-filter-company" aria-label={tr("memory.filter.company.label")} value={companyId ?? ""} onInput={event => updateCompanyFilter(event.currentTarget.value)} onChange={event => updateCompanyFilter(event.currentTarget.value)} className={FILTER_CONTROL_CLASS}>
                <option value="">{tr("memory.filter.all")}</option>
                {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
              </select>
            </label>
            <label className="min-w-0 flex flex-col gap-1">
              <span className="text-[10px] text-ink-subtle">{tr("memory.filter.time.label")}</span>
              <select data-testid="memory-filter-time" aria-label={tr("memory.filter.time.label")} value={timeFilter} onInput={event => updateTimeFilter(event.currentTarget.value)} onChange={event => updateTimeFilter(event.currentTarget.value)} className={FILTER_CONTROL_CLASS}>
                <option value="all">{tr("memory.filter.time.all")}</option>
                <option value="7d">{tr("memory.filter.time.7d")}</option>
                <option value="30d">{tr("memory.filter.time.30d")}</option>
                <option value="custom">{tr("memory.filter.time.custom")}</option>
              </select>
            </label>
            <label className="min-w-0 flex flex-col gap-1">
              <span className="text-[10px] text-ink-subtle">{tr("memory.filter.role.label")}</span>
              <select data-testid="memory-filter-role" aria-label={tr("memory.filter.role.label")} value={roleFilter ?? ""} onInput={event => updateRoleFilter(event.currentTarget.value)} onChange={event => updateRoleFilter(event.currentTarget.value)} className={FILTER_CONTROL_CLASS}>
                <option value="">{tr("memory.filter.role.all")}</option>
                {availableRoles.map(role => <option key={role} value={role}>{roleLabel(role, tr)}</option>)}
              </select>
            </label>
          </div>
          {timeFilter === "custom" && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="memory-filter-custom-range">
              <label className="min-w-0 flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="w-10 shrink-0">{tr("memory.filter.time.from")}</span>
                <input type="date" value={customStart} max={customEnd || undefined} onInput={event => updateCustomStart(event.currentTarget.value)} onChange={event => updateCustomStart(event.currentTarget.value)} aria-label={tr("memory.filter.time.from")} className={FILTER_CONTROL_CLASS + " w-full"} />
              </label>
              <label className="min-w-0 flex items-center gap-2 text-[11px] text-ink-muted">
                <span className="w-10 shrink-0">{tr("memory.filter.time.to")}</span>
                <input type="date" value={customEnd} min={customStart || undefined} onInput={event => updateCustomEnd(event.currentTarget.value)} onChange={event => updateCustomEnd(event.currentTarget.value)} aria-label={tr("memory.filter.time.to")} className={FILTER_CONTROL_CLASS + " w-full"} />
              </label>
            </div>
          )}
        </div>

        {focusedMemory && (
          <div
            ref={focusedMemoryRef}
            data-memory-id={focusedMemory.memoryId}
            tabIndex={-1}
            className="mb-4 rounded-xl border border-accent bg-accent/5 px-4 py-3 outline-none ring-2 ring-accent/20"
          >
            <div className="flex items-start gap-2">
              <Brain size={15} className="text-accent shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-semibold text-ink">{tr("memory.title")}</span>
                  <span className="badge bg-accent/10 text-accent">{focusedMemory.kind}</span>
                  <span className="text-[10px] font-mono text-ink-subtle">{focusedMemory.memoryId.slice(0, 12)}</span>
                </div>
                {focusedMemory.content && <p className="m-0 mt-1 text-[13px] text-ink leading-snug whitespace-pre-wrap">{focusedMemory.content}</p>}
                {focusedMemory.whySelected && <p className="m-0 mt-1 text-[11px] text-ink-subtle">{focusedMemory.whySelected}</p>}
                {focusedMemory.sourceRunId && <div className="mt-2"><RunLink runId={focusedMemory.sourceRunId} tr={tr} /></div>}
              </div>
              <button
                type="button"
                onClick={() => setFocusedMemory(null)}
                title={tr("common.close")}
                className="w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-lg border-none bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink cursor-pointer"
              >
                <X size={13} />
              </button>
            </div>
          </div>
        )}

        {/* 人工审核只呈现关键候选:成功后的高风险结论、重复出现的教训或明确策略风险。 */}
        {keyProposalCount > 0 && (
          <div className="mb-3 rounded-xl border border-amber/30 bg-amber/5 p-4">
            <button
              onClick={() => setProposalsCollapsed(v => !v)}
              className="flex items-center gap-1.5 text-ink font-semibold text-[13px] bg-transparent border-none cursor-pointer p-0 w-full text-left"
            >
              {proposalsCollapsed ? <ChevronRight size={14} className="text-amber" /> : <ChevronDown size={14} className="text-amber" />}
              <ListChecks size={14} className="text-amber" />{tr("memory.proposals.keySectionTitle")}
              <span className="badge bg-amber/15 text-amber">{keyProposalCount}</span>
            </button>
            <p className="m-0 mt-1 pl-5 text-[11px] text-ink-subtle">{tr("memory.proposals.keySectionNote")}</p>
            {!proposalsCollapsed && (
              <div className="grid gap-3 mt-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                {filteredProposals.map(rec => (
                  <ProposalCard key={rec.id} rec={rec} tr={tr} onApprove={handleApproveProposal} onReject={handleRejectProposal} />
                ))}
                {keyRunProposals.map(rec => (
                  <RunProposalCard
                    key={`${rec.runId}:${rec.proposalId}`}
                    rec={rec}
                    tr={tr}
                    onApprove={handleApproveRunProposal}
                    onReject={handleRejectRunProposal}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {backgroundRunProposals.length > 0 && (
          <div className="mb-4 rounded-xl border border-hairline bg-surface-1 px-4 py-3">
            <button
              onClick={() => setBackgroundProposalsCollapsed(v => !v)}
              className="flex items-center gap-1.5 text-ink-muted font-medium text-[12px] bg-transparent border-none cursor-pointer p-0 w-full text-left"
            >
              {backgroundProposalsCollapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
              <Archive size={13} />{tr("memory.proposals.backgroundSectionTitle")}
              <span className="badge bg-surface-2 text-ink-subtle">{backgroundRunProposals.length}</span>
            </button>
            <p className="m-0 mt-1 pl-[18px] text-[11px] text-ink-subtle">{tr("memory.proposals.backgroundSectionNote")}</p>
            {!backgroundProposalsCollapsed && (
              <div className="grid gap-3 mt-3 max-h-[440px] overflow-y-auto pr-1" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                {backgroundRunProposals.map(rec => (
                  <RunProposalCard
                    key={`${rec.runId}:${rec.proposalId}`}
                    rec={rec}
                    tr={tr}
                    onApprove={handleApproveRunProposal}
                    onReject={handleRejectRunProposal}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {loading && !registry.length && !lessons.length ? (
          <div className="text-ink-muted text-[13px] py-10 text-center">{tr("memory.loading")}</div>
        ) : isEmpty ? (
          <EmptyGuide icon={<Brain size={40} />} title={tr("memory.emptyTitle")} body={tr("memory.emptyBody")} />
        ) : (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="space-y-4">
            {/* 三数字卡:筛选后 N / 总 M(未筛选时只显示 N) */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <StatCard icon={<Lightbulb size={17} />} label={tr("memory.stat.conclusions")} value={conclusions.length} total={totalConclusions} growth={conclusionGrowth} tr={tr} />
              <StatCard icon={<GraduationCap size={17} />} label={tr("memory.stat.lessons")} value={activeLessonsCount} total={totalActiveLessons} growth={lessonGrowth} tr={tr} />
              <StatCard icon={<Layers size={17} />} label={tr("memory.stat.skillsTemplates")} value={skillTemplateCount} total={totalSkillsTemplates} growth={skillTemplateGrowth} tr={tr} />
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-1 w-fit p-0.5 rounded-full bg-surface-2">
              <button onClick={() => setTab("library")}
                className={`px-2.5 py-1 rounded-full text-[12px] font-medium flex items-center gap-1.5 border-none cursor-pointer transition-colors duration-150 ${tab === "library" ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"}`}>
                <Library size={13} /> {tr("memory.tab.library")}
              </button>
              <button onClick={() => setTab("lessons")}
                className={`px-2.5 py-1 rounded-full text-[12px] font-medium flex items-center gap-1.5 border-none cursor-pointer transition-colors duration-150 ${tab === "lessons" ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"}`}>
                <GraduationCap size={13} /> {tr("memory.tab.lessons")}
              </button>
              <button onClick={() => setTab("layers")}
                className={`px-2.5 py-1 rounded-full text-[12px] font-medium flex items-center gap-1.5 border-none cursor-pointer transition-colors duration-150 ${tab === "layers" ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"}`}>
                <Layers size={13} /> {tr("memory.tab.layers")}
              </button>
            </div>

            {tab === "library" ? (
              <div className="space-y-5">
                <div>
                  <div className="flex items-center gap-1.5 text-ink font-semibold text-[13px] mb-2">
                    <Lightbulb size={14} />{tr("memory.library.conclusionsSectionTitle")}
                    {roleFilter && <HelpTip text={tr("memory.filter.role.notApplicableNote")} />}
                  </div>
                  {conclusions.length === 0 ? (
                    <EmptyGuide icon={<Lightbulb size={32} />} title={tr("memory.library.emptyTitle")} body={tr("memory.library.emptyBody")} />
                  ) : (
                    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                      {conclusions.map(rec => <ConclusionCard key={rec.id} rec={rec} tr={tr} />)}
                    </div>
                  )}
                </div>

                {skills.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 text-ink font-semibold text-[13px] mb-2"><ListChecks size={14} />{tr("memory.library.skillsSectionTitle")}</div>
                    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                      {skills.map(rec => <SkillCard key={rec.id} rec={rec} tr={tr} />)}
                    </div>
                  </div>
                )}

                {plans.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 text-ink font-semibold text-[13px] mb-2">
                      <Layers size={14} />{tr("memory.library.planSectionTitle")}
                      {roleFilter && <HelpTip text={tr("memory.filter.role.notApplicableNote")} />}
                    </div>
                    <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))" }}>
                      {plans.map(rec => <PlanTemplateCard key={rec.id} rec={rec} tr={tr} />)}
                    </div>
                  </div>
                )}
              </div>
            ) : tab === "lessons" ? (
              <div>
                {filteredLessons.length === 0 ? (
                  <EmptyGuide icon={<GraduationCap size={32} />} title={tr("memory.lessons.emptyTitle")} body={tr("memory.lessons.emptyBody")} />
                ) : (
                  <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))" }}>
                    {filteredLessons.map(l => <LessonCard key={l.id} l={l} tr={tr} agents={agents} onRevoke={handleRevoke} onApply={handleApplyToAgent} />)}
                  </div>
                )}
              </div>
            ) : (
              <LayersView data={layersData} committed={committed} tr={tr} />
            )}
          </motion.div>
        )}
      </div>
      <AnimatePresence>
        {digestOpen && (
          <DigestModal companies={companies} defaultCompanyId={companyId} tr={tr} onClose={() => setDigestOpen(false)} />
        )}
      </AnimatePresence>
    </div>
  );
}
