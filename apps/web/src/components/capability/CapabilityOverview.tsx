import { useState, useEffect, useMemo, type ReactNode } from "react";
import { Network, Zap, Brain, Store, ArrowRight, Loader2, type LucideIcon } from "lucide-react";
import type { TraceEvent } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { deriveRunExecutors, EXECUTOR_BADGE, type RunExecutor } from "../trace/traceTypes.js";
import HelpTip from "../HelpTip.js";
import InfoDisclosure from "../common/InfoDisclosure.js";

// E4 · 四能力一等呈现(P2-58):A2A 协作 / ACP 执行 / 经验记忆 / 公司模板 四张能力卡。
// 数据纪律(宪法:不虚标):每张卡只显示真实可得的数——
//   · A2A:近 N 个 run 的 events.jsonl 里真实记录的 agent_message 计数;resolved 闭环走
//     GET /api/runs/:id/a2a-messages(B6 读侧端点,a2a_messages.jsonl last-wins 合并)真实计数,
//     端点取数失败 → 诚实占位「待接入」(events 计数与 a2a_messages 是两个数据源,不混算)。
//   · ACP:复用 traceTypes 的 deriveRunExecutors(payload.kind==="executor_selected" 契约),
//     无记录的 run 不计入,绝不推断;战役A A6 落 executor 持久化后此处自动升级为历史真值。
//   · 记忆:GET /memory/committed + /memory/proposals(服务端只回 pending)的真实条数。
//   · 模板:GET /community/templates(本地模板库)+ /companies(本地公司)的真实条数。
// 任何一路取数失败 → 该卡显示「待接入」占位,不显示 0 冒充真值。

const RECENT_RUNS = 8;

export interface RunCapabilitySample {
  runId: string;
  a2aMessages: number;
  executor: RunExecutor | null;
}

// 单 run 事件流 → 能力样本(纯函数,供单测)。executor 判定完全复用 deriveRunExecutors,不另起判定。
export function summarizeRunEvents(runId: string, events: TraceEvent[]): RunCapabilitySample {
  let msgs = 0;
  for (const e of events) {
    if (e.type === "agent_message" && e.runId === runId) msgs++;
  }
  return { runId, a2aMessages: msgs, executor: deriveRunExecutors(events)[runId] ?? null };
}

// B6 · a2a_messages 快照 → resolved 闭环计数(纯函数,供单测)。lifecycle==="resolved" 是终态
// (orchestrator 只在真实消费点打 resolve),total 是该 run 落盘的 A2A 消息总数(last-wins 合并后)。
const REQUIRED_A2A_TYPES = new Set(["delegate_task", "revision_request", "artifact_handoff"]);

export function countA2AResolved(messages: Array<{ lifecycle?: string; messageType?: string; to?: string[] }>): { resolved: number; total: number } {
  const required = messages.filter((m) => REQUIRED_A2A_TYPES.has(m?.messageType ?? "") && (m?.to?.length ?? 0) > 0);
  return { resolved: required.filter((m) => m.lifecycle === "resolved").length, total: required.length };
}

type TFn = (key: string, params?: Record<string, string | number>) => string;
// undefined = 加载中;null = 取数失败(诚实占位,不冒充 0)。
type Loadable<T> = T | null | undefined;

function Metric({ value, label, dotColor }: { value: number | string; label: string; dotColor?: string }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[17px] font-semibold text-ink tabular-nums leading-none flex items-center gap-1.5">
        {dotColor && <span className="w-2 h-2 rounded-full shrink-0" style={{ background: dotColor }} />}
        {value}
      </span>
      <span className="text-[11px] text-ink-subtle leading-snug">{label}</span>
    </div>
  );
}

function PendingBadge({ t }: { t: TFn }) {
  return (
    <span className="inline-flex w-fit items-center px-2 py-0.5 rounded-md text-[11px] font-medium bg-surface-2 text-ink-muted border border-hairline">
      {t("capability.card.pending")}
    </span>
  );
}

// 整卡取数失败时的诚实占位块:徽章 + 一句「为什么是占位」。
function PendingBlock({ t }: { t: TFn }) {
  return (
    <div className="flex flex-col gap-1.5">
      <PendingBadge t={t} />
      <span className="text-[11px] text-ink-subtle leading-snug">{t("capability.card.pendingNote")}</span>
    </div>
  );
}

function Loading() {
  return <Loader2 size={14} className="animate-spin text-ink-subtle" />;
}

function SampleNote({ t, n }: { t: TFn; n: number }) {
  return <span className="text-[11px] text-ink-subtle">{t("capability.card.sample", { n })}</span>;
}

function Card({ Icon, title, desc, children }: { Icon: LucideIcon; title: string; desc: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-hairline bg-surface-1 p-4 flex flex-col gap-2 min-h-[150px]">
      <div className="flex items-center gap-2">
        <span className="w-7 h-7 rounded-lg bg-surface-2 flex items-center justify-center text-accent shrink-0">
          <Icon size={15} />
        </span>
        <span className="text-[14px] font-semibold text-ink">{title}</span>
        <HelpTip text={desc} />
      </div>
      <div className="flex-1 flex flex-col justify-end gap-1.5 pt-1">{children}</div>
    </div>
  );
}

function JumpButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="self-start flex items-center gap-1 text-[12px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:underline"
    >
      {label} <ArrowRight size={12} />
    </button>
  );
}

export default function CapabilityOverview() {
  const t = useT();
  const [samples, setSamples] = useState<Loadable<RunCapabilitySample[]>>(undefined);
  // B6 · resolved 闭环(近 N run 聚合):null = 读侧端点全部取数失败 → 维持「待接入」诚实占位。
  const [a2aClosure, setA2aClosure] = useState<Loadable<{ resolved: number; total: number }>>(undefined);
  const [mem, setMem] = useState<Loadable<{ committed: number; pending: number }>>(undefined);
  const [tpl, setTpl] = useState<Loadable<{ templates: number; companies: number }>>(undefined);
  const liveEvents = useAgentStore(s => s.events);

  useEffect(() => {
    let alive = true;
    // 近 N run 的事件快照(与任务档案同一事实来源:.opc/runs/<id>/events.jsonl)。
    api.get<Array<{ id: string }>>("/runs")
      .then(async list => {
        const ids = (Array.isArray(list) ? list : []).slice(0, RECENT_RUNS).map(r => r?.id).filter(Boolean);
        const perRun = await Promise.all(ids.map(id =>
          api.get<{ events: TraceEvent[] }>(`/runs/${encodeURIComponent(id)}/events`)
            .then(r => summarizeRunEvents(id, Array.isArray(r.events) ? r.events : []))
            .catch(() => null), // 单 run 读失败:剔出统计口径,不虚构
        ));
        if (alive) setSamples(perRun.filter((s): s is RunCapabilitySample => s !== null));
        // resolved 闭环:另一数据源(a2a_messages.jsonl 读侧),与 events 的 agent_message 计数不混算。
        const perRunClosure = await Promise.all(ids.map(id =>
          api.getRunA2AMessages(id)
            .then(r => countA2AResolved(Array.isArray(r.messages) ? r.messages : []))
            .catch(() => null),
        ));
        const ok = perRunClosure.filter((c): c is { resolved: number; total: number } => c !== null);
        if (alive) {
          setA2aClosure(ids.length > 0 && ok.length === 0
            ? null
            : ok.reduce((acc, c) => ({ resolved: acc.resolved + c.resolved, total: acc.total + c.total }), { resolved: 0, total: 0 }));
        }
      })
      .catch(() => { if (alive) { setSamples(null); setA2aClosure(null); } });
    Promise.all([
      api.get<unknown[]>("/memory/committed"),
      api.get<unknown[]>("/memory/proposals"), // 服务端只返回 status==="pending"(同 MemoryPage 口径)
    ])
      .then(([c, p]) => { if (alive) setMem({ committed: Array.isArray(c) ? c.length : 0, pending: Array.isArray(p) ? p.length : 0 }); })
      .catch(() => { if (alive) setMem(null); });
    Promise.all([
      api.get<unknown[]>("/community/templates"),
      api.get<unknown[]>("/companies"),
    ])
      .then(([tp, co]) => { if (alive) setTpl({ templates: Array.isArray(tp) ? tp.length : 0, companies: Array.isArray(co) ? co.length : 0 }); })
      .catch(() => { if (alive) setTpl(null); });
    return () => { alive = false; };
  }, []);

  // 磁盘快照 + 实时流合并:快照之后才开始的新 run(不在样本里)从实时事件流补上;
  // 已在样本里的 run 以磁盘快照为准(events.jsonl 与实时流同源,避免重复计数)。
  const combined = useMemo(() => {
    if (samples === undefined || samples === null) return samples;
    const known = new Set(samples.map(s => s.runId));
    const liveByRun = new Map<string, TraceEvent[]>();
    for (const e of liveEvents) {
      if (!e.runId || known.has(e.runId)) continue;
      const arr = liveByRun.get(e.runId);
      if (arr) arr.push(e); else liveByRun.set(e.runId, [e]);
    }
    const extra = [...liveByRun.entries()].map(([id, evs]) => summarizeRunEvents(id, evs));
    return extra.length ? [...extra, ...samples] : samples;
  }, [samples, liveEvents]);

  const stats = useMemo(() => {
    if (!combined) return null;
    let msgs = 0, a2aRuns = 0, acp = 0, degraded = 0;
    for (const s of combined) {
      msgs += s.a2aMessages;
      if (s.a2aMessages > 0) a2aRuns++;
      if (s.executor === "acp") acp++;
      else if (s.executor === "legacy_cli") degraded++;
    }
    return { sampled: combined.length, msgs, a2aRuns, acp, degraded, tracked: acp + degraded };
  }, [combined]);

  const navigate = (page: "memory" | "community") =>
    window.dispatchEvent(new CustomEvent("opc-navigate", { detail: { page } }));

  return (
    <div className="p-6 max-w-3xl">
      <InfoDisclosure className="mb-4">{t("capability.overview.intro")}</InfoDisclosure>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* A2A 协作:消息数是 events.jsonl 真实计数;resolved 闭环是 /runs/:id/a2a-messages 真实计数
            (B6 读侧端点)——取数失败才回退「待接入」占位,绝不显示 0 冒充真值 */}
        <Card Icon={Network} title={t("capability.card.a2a.title")} desc={t("capability.card.a2a.desc")}>
          {combined === undefined ? <Loading /> : combined === null || !stats ? <PendingBlock t={t} /> : (
            <>
              <div className="flex items-end gap-6 flex-wrap">
                <Metric value={stats.msgs} label={t("capability.card.a2a.msgs")} />
                <Metric value={stats.a2aRuns} label={t("capability.card.a2a.runsWith")} />
                {a2aClosure ? (
                  <Metric value={`${a2aClosure.resolved}/${a2aClosure.total}`} label={t("capability.card.a2a.resolved")} />
                ) : (
                  <div className="flex flex-col gap-0.5">
                    <PendingBadge t={t} />
                    <span className="text-[11px] text-ink-subtle leading-snug">{t("capability.card.a2a.resolved")}</span>
                  </div>
                )}
              </div>
              <SampleNote t={t} n={stats.sampled} />
            </>
          )}
        </Card>

        {/* ACP 执行:executor_selected 事件派生;无记录 → 诚实空态,不虚构历史 */}
        <Card Icon={Zap} title={t("capability.card.acp.title")} desc={t("capability.card.acp.desc")}>
          {combined === undefined ? <Loading /> : combined === null || !stats ? <PendingBlock t={t} /> : stats.tracked === 0 ? (
            <>
              <span className="text-[12px] text-ink-subtle leading-snug">{t("capability.card.acp.empty")}</span>
              <SampleNote t={t} n={stats.sampled} />
            </>
          ) : (
            <>
              <div className="flex items-end gap-6 flex-wrap">
                <Metric value={stats.acp} label={EXECUTOR_BADGE.acp.label ?? "ACP"} dotColor={EXECUTOR_BADGE.acp.color} />
                <Metric
                  value={stats.degraded}
                  label={EXECUTOR_BADGE.legacy_cli.labelKey ? t(EXECUTOR_BADGE.legacy_cli.labelKey) : ""}
                  dotColor={EXECUTOR_BADGE.legacy_cli.color}
                />
                <Metric value={`${stats.tracked}/${stats.sampled}`} label={t("capability.card.acp.tracked")} />
              </div>
              <SampleNote t={t} n={stats.sampled} />
            </>
          )}
        </Card>

        {/* 经验记忆:committed / 待审核 真实条数 + 跳经验页 */}
        <Card Icon={Brain} title={t("capability.card.memory.title")} desc={t("capability.card.memory.desc")}>
          {mem === undefined ? <Loading /> : mem === null ? <PendingBlock t={t} /> : (
            <div className="flex items-end gap-6 flex-wrap">
              <Metric value={mem.committed} label={t("capability.card.memory.committed")} />
              <Metric value={mem.pending} label={t("capability.card.memory.pending")} />
            </div>
          )}
          <JumpButton label={t("capability.card.memory.action")} onClick={() => navigate("memory")} />
        </Card>

        {/* 公司模板:本地模板 / 本地公司 真实条数 + 跳社区页 */}
        <Card Icon={Store} title={t("capability.card.template.title")} desc={t("capability.card.template.desc")}>
          {tpl === undefined ? <Loading /> : tpl === null ? <PendingBlock t={t} /> : (
            <div className="flex items-end gap-6 flex-wrap">
              <Metric value={tpl.templates} label={t("capability.card.template.local")} />
              <Metric value={tpl.companies} label={t("capability.card.template.companies")} />
            </div>
          )}
          <JumpButton label={t("capability.card.template.action")} onClick={() => navigate("community")} />
        </Card>
      </div>
    </div>
  );
}
