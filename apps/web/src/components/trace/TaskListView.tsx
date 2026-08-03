import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, Search } from "lucide-react";
import * as api from "../../api/client.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";
import { cleanText } from "../../lib/text.js";
import TaskCard from "./TaskCard.js";
import { deriveRunExecutors, deriveRunFinalStates, deriveRunMergeConflicts, resolveBadge, type RunListItem, type RunTaskMeta } from "./traceTypes.js";
import { deriveRunSimulated, isSimulatedRun } from "../../lib/executorBadge.js";
import { extractSummarySnippet } from "./traceFormat.js";

// 任务卡流——替代原来的"最近"横条。拉最近 N 条 run,逐个 best-effort 补 task.json(徽章/参与者/tokens)
// 和 report.md 首段摘要;进行中的排最前(带呼吸边框);支持按 goal 关键词过滤 + 按公司过滤(下方)。
// 列表不分页(本工具面向单机/单项目场景,run 数量级不至于需要虚拟滚动),只取最近 LIST_LIMIT 条,
// 避免给服务器/浏览器同时打出几百个补数请求。
const LIST_LIMIT = 40;
const ALL_COMPANIES = "all";
interface CardData extends RunListItem {
  meta?: RunTaskMeta;
  summary?: string; // undefined = 还没拉到
  partial?: boolean;
}

export default function TaskListView({
  onOpen,
  companyFilter,
}: {
  onOpen: (id: string) => void;
  companyFilter: string;
}) {
  const t = useT();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [metaMap, setMetaMap] = useState<Record<string, RunTaskMeta>>({});
  const [summaryMap, setSummaryMap] = useState<Record<string, string>>({});
  const [partialMap, setPartialMap] = useState<Record<string, boolean>>({});
  // P1-5:派发队列(runId → 1 基排队位次)。撞上单 run 互斥闸而入队的 run 以此覆盖徽章为"排队中 #N"。
  const [queueMap, setQueueMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // refreshSeqRef:给每次 refresh() 发号——快速切公司(A→B)时 A 的迟到响应不应该覆盖 B 已经显示的列表。
  const refreshSeqRef = useRef(0);
  const refresh = useCallback(() => {
    const seq = ++refreshSeqRef.current;
    const qs = companyFilter !== ALL_COMPANIES ? `?company=${encodeURIComponent(companyFilter)}` : "";
    // P1-5:同步拉派发队列,给"排队中"的 run 覆盖徽章 + 位次(best-effort,失败不影响列表)。
    api.get<Array<{ runId: string; position: number }>>("/dispatch-queue").then(items => {
      if (seq !== refreshSeqRef.current) return;
      const m: Record<string, number> = {};
      for (const it of items || []) m[it.runId] = it.position;
      setQueueMap(m);
    }).catch(() => { /* best-effort */ });
    api.get<RunListItem[]>(`/runs${qs}`).then(list => {
      if (seq !== refreshSeqRef.current) return; // 已经有更新的刷新在途(比如又切了公司),丢弃这次迟到结果
      const top = (list || []).slice(0, LIST_LIMIT);
      setRuns(top);
      setLoading(false);
      top.forEach(r => {
        // P2#7 集成:GET /runs 走服务端滚动索引,summary/partial/agentIds/tokens 已随列表返回——
        // 富字段齐的行**零补数请求**(原来每卡 2 个,40 卡=80 请求);缺字段(旧格式索引行)才逐卡补拉。
        if (r.summary !== undefined) {
          setMetaMap(m => ({ ...m, [r.id]: { status: r.status, degraded: r.degraded, degradedReason: r.degradedReason, participatingAgents: r.agentIds, totalTokens: r.totalTokens, totalCostUsd: r.totalCostUsd, startedAt: r.startedAt, endedAt: r.endedAt, simulated: r.simulated, finalState: r.finalState } }));
          setSummaryMap(m => ({ ...m, [r.id]: r.summary ?? "" }));
          setPartialMap(m => ({ ...m, [r.id]: !!r.partial }));
          return;
        }
        api.get<RunTaskMeta>(`/runs/${encodeURIComponent(r.id)}`)
          .then(meta => setMetaMap(m => ({ ...m, [r.id]: meta })))
          .catch(() => { /* best-effort */ });
        // report.md 顺带复用来判"部分产物"(⏱️ 超时抢救,见 parallelExecutor.ts)——只有 CEO 合成时
        // 把这个提示带进最终报告文本才能查到,是 best-effort 启发式,不追加额外请求。
        api.get<{ md: string }>(`/runs/${encodeURIComponent(r.id)}/report`)
          .then(rep => {
            setSummaryMap(m => ({ ...m, [r.id]: extractSummarySnippet(rep.md) }));
            setPartialMap(m => ({ ...m, [r.id]: /部分产物/.test(rep.md || "") }));
          })
          .catch(() => setSummaryMap(m => ({ ...m, [r.id]: "" })));
      });
    }).catch(() => { if (seq === refreshSeqRef.current) setLoading(false); });
  }, [companyFilter]);

  useEffect(() => { setLoading(true); refresh(); }, [refresh]);

  // 实时机制保留:run_started/run_finished 落到全局事件流时刷新一次列表,
  // 使"进行中"卡片能及时出现/完成后掉落徽章,不必手动刷新页面。
  const events = useAgentStore(s => s.events);
  // 定稿 2.2:从实时事件流派生 runId → executor(acp/降级),给订阅引擎的 run 卡片打 executor 徽章。
  // 历史 run 的事件不在 store 里 → 无徽章(优雅缺省)。
  const executorMap = useMemo(() => deriveRunExecutors(events), [events]);
  // MUP 波1/2 徽章接线:simulated / finalState / 未决冲突。历史 run 走 task.json meta(/runs/:id 补拉),
  // 进行中/刚结束的 run 从实时事件流兜底(model_call_finished simulated、run_finished finalState、
  // run_requires_review conflicts)——两路都是真实数据源,缺省不显示,绝不虚构。
  const simulatedMap = useMemo(() => deriveRunSimulated(events), [events]);
  const finalStateMap = useMemo(() => deriveRunFinalStates(events), [events]);
  const conflictsMap = useMemo(() => deriveRunMergeConflicts(events), [events]);
  const seenCount = useRef(0);
  useEffect(() => {
    const fresh = events.slice(seenCount.current);
    seenCount.current = events.length;
    if (fresh.some(e => e.type === "run_started" || e.type === "run_finished")) refresh();
  }, [events, refresh]);

  const cards: CardData[] = useMemo(
    () => runs.map(r => ({ ...r, meta: metaMap[r.id], summary: summaryMap[r.id], partial: partialMap[r.id] })),
    [runs, metaMap, summaryMap, partialMap],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? cards.filter(c => cleanText(c.goal).toLowerCase().includes(q)) : cards;
    // 进行中置顶,其余按开始时间倒序(GET /runs 本身已按 startedAt 倒序返回,这里只需把 running 提前)。
    return [...list].sort((a, b) => {
      const aRunning = resolveBadge(a.meta?.status ?? a.status, a.meta?.degraded, a.meta?.degradedReason) === "running";
      const bRunning = resolveBadge(b.meta?.status ?? b.status, b.meta?.degraded, b.meta?.degradedReason) === "running";
      if (aRunning !== bRunning) return aRunning ? -1 : 1;
      return (b.startedAt || "").localeCompare(a.startedAt || "");
    });
  }, [cards, query]);

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="relative max-w-[300px]">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("trace.searchPlaceholder")}
          className="w-full pl-8 pr-11 py-1.5 rounded-md bg-surface-1 border border-hairline text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
        />
        <kbd className="pointer-events-none select-none absolute right-2 top-1/2 -translate-y-1/2 px-1.5 py-0.5 rounded border border-hairline bg-surface-2 text-[10px] text-ink-subtle font-mono leading-none">
          ⌘K
        </kbd>
      </div>

      {loading && (
        <div className="flex flex-col gap-3">
          <div className="skeleton w-full h-20" />
          <div className="skeleton w-full h-20" />
          <div className="skeleton w-full h-20" />
        </div>
      )}

      {!loading && filtered.length === 0 && (
        <div className="h-full min-h-[30vh] flex items-center justify-center bg-mesh rounded-xl">
          <div className="text-center p-8">
            <div className="mx-auto mb-4 text-ink-subtle opacity-40 flex justify-center"><History size={42} /></div>
            <p className="text-ink-muted text-[14px] max-w-md">{query.trim() ? t("trace.noMatch") : t("trace.noRuns")}</p>
          </div>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {filtered.map(c => {
            const queuePos = queueMap[c.id];
            const badge = queuePos ? "queued" : resolveBadge(c.meta?.status ?? c.status, c.meta?.degraded, c.meta?.degradedReason);
            return (
              <TaskCard
                key={c.id}
                goal={c.goal}
                startedAt={c.meta?.startedAt ?? c.startedAt}
                badge={badge}
                hasPartial={c.partial}
                participatingAgents={c.meta?.participatingAgents ?? []}
                summary={c.summary}
                queuePosition={queuePos}
                executor={executorMap[c.id]}
                simulated={isSimulatedRun(c.meta) || simulatedMap[c.id] === true}
                finalState={c.meta?.finalState ?? finalStateMap[c.id]}
                mergeConflicts={c.meta?.mergeConflicts ?? conflictsMap[c.id]}
                onClick={() => onOpen(c.id)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
