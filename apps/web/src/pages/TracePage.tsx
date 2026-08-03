import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { motion } from "framer-motion";
import { History, Search, AlertTriangle, ArrowLeft, ListTree, MessageCircle, MoreHorizontal, GitBranch, ChevronRight } from "lucide-react";
import type { TraceEvent, EvidenceRow } from "@opc/shared";
import * as api from "../api/client.js";
import type { ApiError } from "../api/client.js";
import { useAgentStore } from "../store/useAgentStore.js";
import { useT } from "../i18n.js";
import { cleanText } from "../lib/text.js";
import HelpTip from "../components/HelpTip.js";
import TaskListView from "../components/trace/TaskListView.js";
import ArchiveDefaultRunsButton from "../components/archive/ArchiveDefaultRunsButton.js";
import ResultSection from "../components/trace/ResultSection.js";
import TaskGraphTree from "../components/common/TaskGraphTree.js";
import ChangesSection from "../components/trace/ChangesSection.js";
import ProcessTimeline from "../components/trace/ProcessTimeline.js";
import ChatReplay from "../components/trace/ChatReplay.js";
import BillingSection from "../components/trace/BillingSection.js";
import type { ExecutionPermissionPostureDto, RunEvidenceManifestDto } from "../components/trace/evidencePermissionTypes.js";
import CompanyTaskSidebar from "../components/navigation/CompanyTaskSidebar.js";
import { navigateApp } from "../lib/navigation.js";
import RunDetailHeader from "../features/results/components/RunDetailHeader.js";
import {
  isDomainLiveEvent, normalizeLive, normalizeStatic, resolveBadge, LIVE_TAIL,
  type NormEvent, type RunArtifact, type RunMemoryPackUsage, type RunSummary, type RunTaskMeta,
} from "../components/trace/traceTypes.js";

// 任务档案(原"运行历史/追踪回放"):列表(任务卡流,见 components/trace/TaskListView) + 点卡进入的
// 详情三段式(①结果 ②过程回放 ③账单,见 components/trace/{Result,ProcessTimeline,Billing}Section)。
// 本文件只保留"详情"这一侧的数据编排(拉 /trace 快照 + 实时增量合并 + 产物/task元数据/报告),
// 纯展示逻辑都下沉到 components/trace/*，避免这个文件继续膨胀成单体。
//
// 实时化(昨天已做,原样保留):进行中的 run(effectiveStatus 为 running/pending,见下方 isLive)订阅
// useAgentStore 的 events(App.tsx 的 EventSource 全量写入),按当前 runId 过滤,增量渲染新事件;
// run_finished 时刷新一次终态快照(拿到 artifacts/degraded/report.md 等收尾字段)。
// 历史(已结束)run 按需拉一次静态快照。

type DetailStatus = "loading" | "loaded" | "notFound" | "error";

const ALL_COMPANIES = "all";
const COMPANY_FILTER_KEY = "opc-trace-company-filter";
const PROJECT_SIDEBAR_COLLAPSED_KEY = "opc-project-sidebar-collapsed";

function readCompanyFilter(): string {
  try { return localStorage.getItem(COMPANY_FILTER_KEY) || ALL_COMPANIES; } catch { return ALL_COMPANIES; }
}

function readProjectSidebarCollapsed(): boolean {
  try { return localStorage.getItem(PROJECT_SIDEBAR_COLLAPSED_KEY) === "true"; } catch { return false; }
}

export default function TracePage({ routeCompanyId, routeRunId }: { routeCompanyId?: string; routeRunId?: string }) {
  const t = useT();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null); // null = 显示 Run 卡流列表
  const [companyFilter, setCompanyFilter] = useState(() => routeCompanyId || readCompanyFilter());
  const [projectSidebarCollapsed, setProjectSidebarCollapsed] = useState(readProjectSidebarCollapsed);
  const [runIdInput, setRunIdInput] = useState("");
  // Run ID 直查是小众操作(裸 ID 输入门面显得不高级)——收进头部一个"…"弹出菜单,不占主视觉。
  const [runIdMenuOpen, setRunIdMenuOpen] = useState(false);
  const runIdMenuRef = useRef<HTMLDivElement | null>(null);

  const [status, setStatus] = useState<DetailStatus>("loading");
  // 归档成功后 bump 一次 key,强制任务卡流(TaskListView)重挂载刷新,已归档的 run 立即从列表消失。
  const [listReloadKey, setListReloadKey] = useState(0);
  const [summary, setSummary] = useState<RunSummary | null>(null);
  const [artifacts, setArtifacts] = useState<RunArtifact[]>([]);
  const [taskMeta, setTaskMeta] = useState<RunTaskMeta | null>(null);
  const [reportMd, setReportMd] = useState<string | null>(null); // null = 加载中
  // AI Research Company:证据表——best-effort,来自 structured-report.json 的 evidenceTable(可能没有)。
  const [evidenceTable, setEvidenceTable] = useState<EvidenceRow[]>([]);
  const [permissionPosture, setPermissionPosture] = useState<ExecutionPermissionPostureDto | undefined>(undefined);
  // Run Story:本次 run 实际用过的记忆——best-effort,来自 GET /runs/:id/memory-pack(纯派生自 events.jsonl,
  // 可能没有 memory_pack_used 事件/该端点尚未产出数据),缺省时 ResultSection 整块不渲染。
  const [memoryPackUsage, setMemoryPackUsage] = useState<RunMemoryPackUsage | undefined>(undefined);
  // Bug 修复:详情页"这个 run 到底是谁"曾经完全绑死 summary.runId(/trace 的产物)——trace 一旦缺失
  // (下面 loadTrace 的大注释),连 runId 本身都拿不到，ResultSection/ChatReplay/头部全部失去落点。
  // 现在两路证据(task.json / trace)只要任一成立就落定 resolvedRunId，下游组件统一认它。
  const [resolvedRunId, setResolvedRunId] = useState<string | null>(null);
  // 分享欲 Stage:②过程回放(既有技术时间线) / 对话回放(新,群聊剧本)——并列 tab,默认过程回放,
  // 不改变任何既有用户的默认视图。
  const [replayTab, setReplayTab] = useState<"process" | "chat">("process");
  // 令五.4 · Chat 英雄回路展示真实 task graph:详情页"查看任务图"入口的展开态(默认收起,不打扰旧视图)。
  const [showTaskGraph, setShowTaskGraph] = useState(false);

  // Bug 修复:loadTrace 之前对同一 run 的多个 fetch(trace/artifacts/taskMeta/report)全无请求序号守卫——
  // 列表页快速连点(点开 A → 还没加载完就点回列表点开 B)时,A 的迟到响应会用 A 的数据/notFound 状态覆盖
  // 掉正在显示的 B(状态残留:详情页显示旧 run 的报告,或明明 B 存在却被 A 的 404 打成"未找到")。
  // 用单调递增的 loadSeqRef 给每次 loadTrace 调用发号,异步回调落地前先核对自己是否仍是"最新一次"。
  const loadSeqRef = useRef(0);
  // Bug 修复(用户实测复现):以前"这个 run 是否存在"只看一路证据——/trace(events 重放)。可
  // GET /runs/:id/trace 只要 totalEvents===0 就整体 404(eventRoutes.ts),而"events.jsonl/
  // run-history.jsonl 缺失或为空"在真实数据里大量存在(较早批次的 run、迁移前的旧格式归档等)——
  // task.json 本身完好(goal/状态/参与者/账单俱全),不少甚至已经有 report.md，却被这一路 404 打成
  // "未找到"。用户看到的"任务在列表里，点开却卡住"多半就是这个:列表读的是另一份滚动索引，详情页
  // 却单靠 /trace 判活。
  //
  // 修复:task.json(/runs/:id)与 trace(/runs/:id/trace)并发拉、独立判定——任一路证明 run 存在
  // (200)就落定 loaded 态；报告/时间线/产物各自降级为 best-effort 补充，缺了就显示"没有"而不是拖累
  // 整个详情页。只有两路都没证据时才是真的"未找到"；两路都失败但明显是服务端/网络故障(非 404)时
  // 走 error 态而不是误报"未找到"。notFound 从此只留给"id 真不存在"这一种情况。
  const loadTrace = useCallback(async (rawId: string) => {
    const id = rawId.trim() || "latest";
    const seq = ++loadSeqRef.current;
    const stale = () => seq !== loadSeqRef.current;
    setStatus("loading");
    setSummary(null); setArtifacts([]); setTaskMeta(null); setReportMd(null); setResolvedRunId(null); setEvidenceTable([]);
    setMemoryPackUsage(undefined);
    setPermissionPosture(undefined);

    // /runs/:id 是直接读 <projectRoot>/.opc/runs/<id>/task.json，不认识字面量 "latest"（那是
    // /trace、/events 自己的候选文件夹扫描逻辑）——"latest" 场景没法先拿 task.json，沿用旧路径，
    // 交给下面的 /trace 解析出真实 runId 后再补一次 task.json（best-effort，见下方 loaded 分支）。
    const metaReq = id !== "latest"
      ? api.get<RunTaskMeta>(`/runs/${encodeURIComponent(id)}`)
          .then((m) => ({ ok: true as const, m }))
          .catch((e) => ({ ok: false as const, status: (e as ApiError)?.status }))
      : Promise.resolve({ ok: false as const, status: undefined as number | undefined });
    const traceReq = api.get<RunSummary>(`/runs/${encodeURIComponent(id)}/trace`)
      .then((d) => ({ ok: true as const, d }))
      .catch((e) => ({ ok: false as const, status: (e as ApiError)?.status }));

    const [metaRes, traceRes] = await Promise.all([metaReq, traceReq]);
    if (stale()) return; // 用户已经切到别的 run,这条迟到的响应不再适用,丢弃。

    const traceHasRun = traceRes.ok && !!traceRes.d.runId;
    if (metaRes.ok) setTaskMeta(metaRes.m);
    if (traceHasRun) setSummary((traceRes as { ok: true; d: RunSummary }).d);

    if (!metaRes.ok && !traceHasRun) {
      // 两路都没拿到:404(id 不存在)判"未找到";其余非 404 故障(网络中断、400 格式非法、服务端 500)
      // 判"加载失败",不能因为一时故障就告诉用户"这任务不存在"。id==="latest" 时 metaReq 压根没发起,
      // 不参与判定,只看 trace 一路。
      const metaFailedNon404 = id !== "latest" && !metaRes.ok && metaRes.status !== 404;
      const traceFailedNon404 = !traceRes.ok && traceRes.status !== 404;
      setStatus(metaFailedNon404 || traceFailedNon404 ? "error" : "notFound");
      return;
    }

    // 落定这次详情页对应的真实 runId:非 "latest" 时就是入参本身(两个端点都按字面 runId 找文件夹，
    // 能拿到数据即证明该 id 真实存在)；"latest" 时只有 trace 能解析出实际 id。
    const finalId = id !== "latest" ? id : (traceRes.ok ? traceRes.d.runId! : id);
    setResolvedRunId(finalId);
    setStatus("loaded");

    // 报告 + 产物,best-effort,不阻塞"能打开"这件事;同样受 stale() 守卫。
    api.get<{ artifacts: RunArtifact[] }>(`/runs/${encodeURIComponent(finalId)}/artifacts`)
      .then(a => { if (!stale()) setArtifacts(a.artifacts || []); }).catch(() => { if (!stale()) setArtifacts([]); });
    api.get<{ md: string }>(`/runs/${encodeURIComponent(finalId)}/report`)
      .then(r => { if (!stale()) setReportMd(r.md || ""); }).catch(() => { if (!stale()) setReportMd(""); });
    // 证据表:结构化报告可能不存在(旧 run / 未走合成路径)或没有 evidenceTable 字段——404/缺字段都静默为空,不当错误处理。
    api.get<{ evidenceTable?: EvidenceRow[] }>(`/runs/${encodeURIComponent(finalId)}/structured-report`)
      .then(r => { if (!stale()) setEvidenceTable(r.evidenceTable ?? []); }).catch(() => { if (!stale()) setEvidenceTable([]); });
    api.get<RunEvidenceManifestDto>(`/runs/${encodeURIComponent(finalId)}/evidence`)
      .then(r => { if (!stale()) setPermissionPosture(r.permissionPosture); }).catch(() => { if (!stale()) setPermissionPosture(undefined); });
    // 本次用了哪些记忆——纯派生,同样 best-effort:没有 memory_pack_used 事件时端点返回空 usages,
    // ResultSection 按 countsByScope 全 0 自行判断是否渲染,这里不做特殊处理。
    api.get<RunMemoryPackUsage>(`/runs/${encodeURIComponent(finalId)}/memory-pack`)
      .then(r => { if (!stale()) setMemoryPackUsage(r); }).catch(() => { if (!stale()) setMemoryPackUsage(undefined); });
    // "latest" 分支且 task.json 还没试过(上面 metaReq 直接跳过了)——现在已知真实 id,补一次,best-effort。
    if (id === "latest" && !metaRes.ok) {
      api.get<RunTaskMeta>(`/runs/${encodeURIComponent(finalId)}`)
        .then(m => { if (!stale()) setTaskMeta(m); }).catch(() => { /* best-effort:没有就没有 */ });
    }
  }, []);

  const loadRunFromRoute = useCallback((id: string) => {
    setRunIdInput(id);
    setSelectedRunId(id);
    loadTrace(id);
  }, [loadTrace]);
  const openRun = useCallback((id: string, companyId?: string) => {
    const selectedCompany = companyId || (companyFilter !== ALL_COMPANIES ? companyFilter : undefined);
    loadRunFromRoute(id);
    navigateApp({ page: "results", runId: id, companyId: selectedCompany });
  }, [companyFilter, loadRunFromRoute]);
  const backToList = useCallback(() => {
    setSelectedRunId(null);
    navigateApp({ page: "results", companyId: companyFilter !== ALL_COMPANIES ? companyFilter : undefined });
  }, [companyFilter]);
  const selectCompanyProjects = useCallback((companyId: string) => {
    setCompanyFilter(companyId);
    setSelectedRunId(null);
    try { localStorage.setItem(COMPANY_FILTER_KEY, companyId); } catch { /* ignore */ }
    navigateApp({ page: "results", companyId: companyId !== ALL_COMPANIES ? companyId : undefined });
  }, []);
  const openCompanyProject = useCallback((runId: string, companyId: string) => {
    setCompanyFilter(companyId);
    try { localStorage.setItem(COMPANY_FILTER_KEY, companyId); } catch { /* ignore */ }
    openRun(runId, companyId);
  }, [openRun]);
  const startCompanyProject = useCallback((companyId: string) => {
    try {
      localStorage.setItem("opc-org-company", companyId);
      sessionStorage.setItem("opc-new-task-company", companyId);
    } catch { /* ignore */ }
    navigateApp({ page: "org", companyId });
    setTimeout(() => window.dispatchEvent(new CustomEvent("opc-new-task", { detail: { companyId } })), 0);
  }, []);
  const toggleProjectSidebar = useCallback(() => {
    setProjectSidebarCollapsed((current) => {
      const next = !current;
      try { localStorage.setItem(PROJECT_SIDEBAR_COLLAPSED_KEY, String(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  useEffect(() => {
    const nextCompany = routeCompanyId || ALL_COMPANIES;
    if (nextCompany !== companyFilter) {
      setCompanyFilter(nextCompany);
      try { localStorage.setItem(COMPANY_FILTER_KEY, nextCompany); } catch { /* ignore */ }
    }
  }, [routeCompanyId]);

  useEffect(() => {
    if (routeRunId) {
      if (routeRunId !== selectedRunId) loadRunFromRoute(routeRunId);
    } else if (selectedRunId !== null) {
      setSelectedRunId(null);
    }
  }, [routeRunId, selectedRunId, loadRunFromRoute]);

  useEffect(() => {
    if (!runIdMenuOpen) return;
    const onDown = (e: MouseEvent) => { if (runIdMenuRef.current && !runIdMenuRef.current.contains(e.target as Node)) setRunIdMenuOpen(false); };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [runIdMenuOpen]);

  // 跨页契约(open-task-run):简报报告卡片/通知点击 → App 切到本页;已挂载时直接消费事件,
  // 首次挂载(lazy)时从 sessionStorage 补取 pending runId。
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem("opc-open-run");
      if (pending) { sessionStorage.removeItem("opc-open-run"); openRun(pending); }
    } catch { /* */ }
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent).detail?.runId;
      if (id) { try { sessionStorage.removeItem("opc-open-run"); } catch { /* */ } openRun(String(id), (e as CustomEvent).detail?.companyId); }
    };
    window.addEventListener("open-task-run", onOpen);
    return () => window.removeEventListener("open-task-run", onOpen);
  }, [openRun]);

  // ── 实时化(原样保留)──────────────────────────────────────────────────
  const events = useAgentStore(s => s.events);

  // Bug 修复:实测 130 条历史 run 里 106 条 summary.finishedAt 恒为 null——run-history.jsonl(/trace
  // 走的数据源)落盘早于 orchestrator 收尾时追加的 run_finished 事件,导致该文件几乎总是缺最后一条
  // run_finished,即便 task.json 已经是 done/failed。之前 isLive 只看 summary.finishedAt,于是绝大多数
  // 已完成任务的详情页会一直显示"直播中"徽章 + 头部漏掉"完成于"时间 + 账单永远卡在"完成后结算"(明明
  // task.json 里 totalTokens/totalCostUsd/endedAt 都已经有了)。taskMeta(task.json 直读)更权威,优先信任它;
  // summary 只在 taskMeta 还没 best-effort 拉到时兜底,不改变"进行中 run"应有的实时行为。
  const effectiveFinishedAt = taskMeta?.endedAt ?? summary?.finishedAt ?? null;
  const effectiveStartedAt = taskMeta?.startedAt ?? summary?.startedAt ?? null;
  const effectiveStatus = taskMeta?.status ?? (effectiveFinishedAt ? "done" : "running");
  // Bug 修复:isLive 以前绑死 summary?.runId——trace 缺失(totalEvents===0)的运行中 run(理论上罕见但
  // 存在:比如刚起步、事件还没来得及落盘)会因此拿不到"直播"资格,永远看不到实时合并的事件。现在改认
  // resolvedRunId(task.json 或 trace 任一路落定的真实 id),不再要求 trace 快照本身必须成功。
  const isLive = status === "loaded" && !!resolvedRunId && (effectiveStatus === "running" || effectiveStatus === "pending");

  useEffect(() => {
    if (!isLive || !resolvedRunId) return;
    const runId = resolvedRunId;
    api.get<{ runId: string | null; events: TraceEvent[] }>(`/runs/${encodeURIComponent(runId)}/events`)
      .then(r => { if (r.runId) useAgentStore.getState().mergeRunHistory(r.runId, r.events); })
      .catch(() => { /* best-effort */ });
  }, [isLive, resolvedRunId]);

  useEffect(() => {
    if (!isLive || !resolvedRunId) return;
    const runId = resolvedRunId;
    if (events.some(e => e.runId === runId && e.type === "run_finished")) loadTrace(runId);
  }, [events, isLive, resolvedRunId, loadTrace]);

  const liveFilteredAll = useMemo(() => {
    if (!isLive || !resolvedRunId) return [] as TraceEvent[];
    const runId = resolvedRunId;
    return events.filter(e => e.runId === runId && isDomainLiveEvent(e));
  }, [events, isLive, resolvedRunId]);
  const liveNormEvents = useMemo(() => liveFilteredAll.slice(-LIVE_TAIL).map(normalizeLive), [liveFilteredAll]);

  const hasPartialFromEvents = useMemo(() => {
    if (!resolvedRunId) return false;
    return events.some(e => e.runId === resolvedRunId && (e.payload as Record<string, unknown> | null | undefined)?.kind === "timeout_salvage");
  }, [events, resolvedRunId]);
  const hasPartialFromArtifacts = useMemo(
    () => artifacts.some(a => (a.title ?? "").includes("部分产物") || (a.reason ?? "").includes("部分产物")),
    [artifacts],
  );
  const hasPartial = hasPartialFromEvents || hasPartialFromArtifacts;

  const sortedTimeline = summary ? [...summary.timeline].sort((a, b) => a.seq - b.seq) : [];
  const displayedTimeline: NormEvent[] = isLive ? liveNormEvents : sortedTimeline.map(normalizeStatic);

  const mainBadgeKey = resolveBadge(effectiveStatus, taskMeta?.degraded ?? summary?.degraded, taskMeta?.degradedReason);
  const participants = taskMeta?.participatingAgents ?? summary?.participatingAgents ?? [];

  return (
    <div className="h-full flex bg-bg-primary">
      <CompanyTaskSidebar
        collapsed={projectSidebarCollapsed}
        activeCompanyId={companyFilter}
        selectedRunId={selectedRunId}
        onToggle={toggleProjectSidebar}
        onSelectCompany={selectCompanyProjects}
        onOpenRun={openCompanyProject}
        onViewAll={selectCompanyProjects}
        onNewProject={startCompanyProject}
      />
      <div className="min-w-0 flex-1 flex flex-col">
      <div className="px-6 py-3 bg-bg-card border-b border-hairline flex items-center justify-between gap-4 shrink-0">
        <div className="min-w-0 flex items-center gap-2.5">
          {selectedRunId !== null && (
            <button onClick={backToList} title={t("trace.backToList")}
              className="w-7 h-7 shrink-0 flex items-center justify-center rounded-lg border border-hairline bg-surface-1 text-ink-muted hover:text-ink hover:border-hairline-light cursor-pointer">
              <ArrowLeft size={14} />
            </button>
          )}
          <div className="min-w-0 flex items-baseline gap-2">
            <h2 className="m-0 text-[15px] font-semibold text-ink flex items-center gap-1.5 shrink-0">
              <History size={16} className="text-accent" /> {t("trace.title")}
            </h2>
            <HelpTip text={t("trace.subtitle")} />
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {selectedRunId === null && <ArchiveDefaultRunsButton onArchived={() => setListReloadKey((k) => k + 1)} />}
          <div className="relative" ref={runIdMenuRef}>
            <button
              onClick={() => setRunIdMenuOpen((v) => !v)}
              title={t("trace.runIdPlaceholder")}
              className={`w-7 h-7 flex items-center justify-center rounded-lg border cursor-pointer transition-colors ${
                runIdMenuOpen ? "border-accent text-accent bg-accent/10" : "border-hairline bg-surface-1 text-ink-muted hover:text-ink hover:border-hairline-light"
              }`}
            >
              <MoreHorizontal size={15} />
            </button>
            {runIdMenuOpen && (
              <div className="absolute right-0 top-[calc(100%+6px)] z-20 w-[260px] p-2.5 rounded-lg border border-hairline bg-surface-1 shadow-lg flex flex-col gap-2">
                <label className="text-[11px] text-ink-subtle">{t("trace.runIdMenuLabel")}</label>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
                  <input
                    type="text"
                    autoFocus
                    value={runIdInput}
                    onChange={(e) => setRunIdInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && runIdInput.trim()) { openRun(runIdInput); setRunIdMenuOpen(false); } }}
                    placeholder={t("trace.runIdPlaceholder")}
                    className="w-full pl-8 pr-2.5 py-1.5 rounded-md bg-surface-0 border border-hairline text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle font-mono"
                  />
                </div>
                <button
                  onClick={() => { if (runIdInput.trim()) { openRun(runIdInput); setRunIdMenuOpen(false); } }}
                  disabled={status === "loading" && selectedRunId !== null}
                  className="btn-primary w-full justify-center flex items-center gap-1.5"
                >
                  <Search size={12} /> {t("trace.load")}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        {selectedRunId === null ? (
          <TaskListView key={listReloadKey} onOpen={openRun} companyFilter={companyFilter} />
        ) : (
          <>
            {status === "loading" && (
              <div className="flex flex-col gap-3 max-w-3xl">
                <div className="skeleton w-full h-24" />
                <div className="skeleton w-2/3 h-5" />
                <div className="skeleton w-full h-40" />
              </div>
            )}
            {status === "notFound" && <EmptyState icon={<AlertTriangle size={42} />} text={t("trace.notFound")} />}
            {status === "error" && <EmptyState icon={<AlertTriangle size={42} />} text={t("trace.loadFailed")} tone="error" />}

            {/* Bug 修复:门槛从 "status==='loaded' && summary" 改成只看 status——summary(/trace 派生)
                现在是 best-effort 补充,不再是"能否打开详情页"的必要条件(见上方 loadTrace 大注释)。
                只要 loaded 就一定至少有 taskMeta 或 summary 之一 + resolvedRunId,下面各处已经把
                summary 相关读取都改成了可选链 + 兜底空值。 */}
            {status === "loaded" && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col gap-6 max-w-3xl"
              >
                <RunDetailHeader
                  goal={cleanText(taskMeta?.userGoal ?? "") || t("trace.untitledGoal")}
                  badge={mainBadgeKey}
                  participants={participants}
                  runId={resolvedRunId ?? ""}
                  startedAt={effectiveStartedAt}
                  finishedAt={effectiveFinishedAt}
                  hasPartial={hasPartial}
                  isLive={isLive}
                />

                {resolvedRunId && <ChangesSection runId={resolvedRunId} taskMeta={taskMeta} />}

                {/* 令五.4 · Chat 英雄回路展示真实 task graph:run 绑定了 missionId(Chat 发起 / mission 派发)
                    才出"查看任务图"入口;展开后拉真实拆解树(依赖/角色/状态/重试/失败原因/产物/跳转 run)。
                    图尚未生成/该任务未拆解 → TaskGraphTree 的 showWhenEmpty 显示诚实占位而非整块消失。 */}
                {resolvedRunId && (taskMeta as (RunTaskMeta & { missionId?: string }) | null)?.missionId && (
                  <div className="flex flex-col gap-2">
                    <button
                      onClick={() => setShowTaskGraph((v) => !v)}
                      className="flex items-center gap-1.5 w-fit text-[12px] font-medium text-ink-muted hover:text-ink bg-transparent border-none cursor-pointer p-0"
                    >
                      <ChevronRight size={14} className={`transition-transform duration-150 ${showTaskGraph ? "rotate-90" : ""}`} />
                      <GitBranch size={13} className="text-accent" />
                      {t("org.ceo.tree.title")}
                    </button>
                    {showTaskGraph && (
                      <TaskGraphTree missionId={(taskMeta as RunTaskMeta & { missionId?: string }).missionId!} tr={t} showWhenEmpty />
                    )}
                  </div>
                )}

                <div id="trace-result-anchor">
                  <ResultSection
                    runId={resolvedRunId ?? ""}
                    badge={mainBadgeKey}
                    degradedReason={taskMeta?.degradedReason}
                    hasPartial={hasPartial}
                    deferred={summary?.deferred ?? []}
                    rejectedArtifacts={summary?.rejectedArtifacts ?? []}
                    stuckModules={summary?.stuckModules ?? []}
                    reportMd={reportMd}
                    artifacts={artifacts}
                    evidenceTable={evidenceTable}
                    memoryPackUsage={memoryPackUsage}
                    permissionPosture={permissionPosture}
                  />
                </div>

                <div>
                  <div className="flex items-center gap-1 mb-3 w-fit p-0.5 rounded-full bg-surface-2">
                    <button
                      onClick={() => setReplayTab("process")}
                      className={`px-2.5 py-1 rounded-full text-[12px] font-medium flex items-center gap-1.5 border-none cursor-pointer transition-colors duration-150 ${
                        replayTab === "process" ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                      }`}
                    >
                      <ListTree size={13} /> {t("trace.tab.process")}
                    </button>
                    <button
                      onClick={() => setReplayTab("chat")}
                      className={`px-2.5 py-1 rounded-full text-[12px] font-medium flex items-center gap-1.5 border-none cursor-pointer transition-colors duration-150 ${
                        replayTab === "chat" ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                      }`}
                    >
                      <MessageCircle size={13} /> {t("trace.tab.chat")}
                    </button>
                  </div>
                  {replayTab === "process" ? (
                    <ProcessTimeline items={displayedTimeline} isLive={isLive} liveTotal={liveFilteredAll.length} />
                  ) : (
                    <ChatReplay
                      runId={resolvedRunId ?? ""}
                      isLive={isLive}
                      userGoal={taskMeta ? cleanText(taskMeta.userGoal) || undefined : undefined}
                      startedAt={effectiveStartedAt}
                      badge={mainBadgeKey}
                      reportMd={reportMd}
                      agentCount={participants.length}
                    />
                  )}
                </div>

                <BillingSection
                  totalTokens={taskMeta?.totalTokens}
                  startedAt={effectiveStartedAt}
                  finishedAt={effectiveFinishedAt}
                />
              </motion.div>
            )}
          </>
        )}
      </div>
    </div>
    </div>
  );
}

function EmptyState({ icon, text, tone }: { icon: React.ReactNode; text: string; tone?: "error" }) {
  return (
    <div className="h-full min-h-[40vh] flex items-center justify-center bg-mesh">
      <div className="text-center p-8">
        <div className={`mx-auto mb-4 ${tone === "error" ? "text-error" : "text-ink-subtle"} opacity-40 flex justify-center`}>{icon}</div>
        <p className="text-ink-muted text-[14px] max-w-md">{text}</p>
      </div>
    </div>
  );
}
