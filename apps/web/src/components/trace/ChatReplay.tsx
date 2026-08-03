import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Download, ExternalLink, MessageCircle, Radio, RefreshCw } from "lucide-react";
import * as api from "../../api/client.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useI18n, useT } from "../../i18n.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { extractSummarySnippet, fmtTime } from "./traceFormat.js";
import { BADGE_COLOR, BADGE_LABEL_KEY, type BadgeKey } from "./traceTypes.js";
import {
  buildChatBlocks, buildReportBlock, buildShareHtml, liveEventToTranscriptEntry,
  type ChatBlock, type TranscriptEntry,
} from "./chatScript.js";

// 分享欲 Stage · "对话回放" tab:把这次 run 翻成"群聊剧本"(见 chatScript.ts 的派生规则)——
// 用户指令(右侧气泡)→ CEO/lead/worker 的 agent_message 气泡(连续同人聚合)→ verifier/产物驳回/
// 降级的系统通知 pill → 结尾"交付报告"卡(点开跳①结果段)。可一键导出自包含 HTML(预览新标签
// 或下载文件),供截图/转发。
//
// 与②过程回放(ProcessTimeline,读 run-history.jsonl 的技术时间线,含 agent_deferred/module_stuck
// 等)分工不同:这里的数据源是 GET /runs/:id/transcript(只读 events.jsonl 派生),范围更窄但更"人话"——
// 只讲 events.jsonl 确实记录下来的对话与关键决策,不是完整技术审计视图。
export default function ChatReplay({
  runId, isLive, userGoal, startedAt, badge, reportMd, agentCount,
}: {
  runId: string;
  isLive: boolean;
  userGoal?: string;
  startedAt: string | null;
  badge: BadgeKey;
  reportMd: string | null; // null = 加载中
  agentCount: number;
}) {
  const t = useT();
  const lang = useI18n(s => s.lang);
  const agents = useAgentStore(s => s.agents);
  const liveEvents = useAgentStore(s => s.events);

  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [baseEntries, setBaseEntries] = useState<TranscriptEntry[]>([]);
  const seqRef = useRef(0); // 同 TracePage.loadTrace 的请求序号守卫:runId 快速切换时丢弃迟到响应

  const load = useCallback(() => {
    if (!runId) return;
    const seq = ++seqRef.current;
    setStatus("loading");
    api.get<{ runId: string; entries: TranscriptEntry[] }>(`/runs/${encodeURIComponent(runId)}/transcript`)
      .then(r => { if (seq === seqRef.current) { setBaseEntries(r.entries || []); setStatus("loaded"); } })
      .catch(() => { if (seq === seqRef.current) setStatus("error"); });
  }, [runId]);
  useEffect(() => { load(); }, [load]);

  // 直播中把 useAgentStore 的实时事件也翻成剧本条目,与已拉到的历史快照按 id 去重合并——
  // 与 TracePage 自身的 live 合并模式(normalizeLive/mergeRunHistory)同构。
  const liveEntries = useMemo(() => {
    if (!isLive || !runId) return [] as TranscriptEntry[];
    const out: TranscriptEntry[] = [];
    for (const e of liveEvents) {
      if (e.runId !== runId) continue;
      const entry = liveEventToTranscriptEntry(e);
      if (entry) out.push(entry);
    }
    return out;
  }, [liveEvents, isLive, runId]);

  const entries = useMemo(() => {
    if (liveEntries.length === 0) return baseEntries;
    const byId = new Map(baseEntries.map(e => [e.id, e]));
    for (const e of liveEntries) byId.set(e.id, e);
    return [...byId.values()].sort((a, b) => a.at.localeCompare(b.at));
  }, [baseEntries, liveEntries]);

  const chatBlocks = useMemo(
    () => buildChatBlocks(entries, { agents, t, lang, userGoal, startedAt }),
    [entries, agents, t, lang, userGoal, startedAt],
  );
  const finished = badge !== "running";
  const reportBlock = useMemo(() => buildReportBlock({
    badge, badgeLabel: t(BADGE_LABEL_KEY[badge]), badgeColor: BADGE_COLOR[badge],
    summary: finished ? (extractSummarySnippet(reportMd) || t("trace.summary.placeholder")) : t("trace.chat.reportPending"),
    pending: !finished, t,
  }), [badge, finished, reportMd, t]);
  const blocks: ChatBlock[] = useMemo(() => [...chatBlocks, reportBlock], [chatBlocks, reportBlock]);
  const isChatEmpty = chatBlocks.length === 0;

  const jumpToResult = useCallback(() => {
    document.getElementById("trace-result-anchor")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const shareMeta = useMemo(() => ({
    title: userGoal || t("trace.chat.shareTitle"),
    subtitle: startedAt ? fmtTime(startedAt) : "",
    footer: t("trace.chat.brandFooter", { n: agentCount }),
    lang,
  }), [userGoal, startedAt, t, agentCount, lang]);

  const buildHtml = useCallback(() => buildShareHtml(blocks, shareMeta), [blocks, shareMeta]);

  // window.open(blob URL)——新标签页里打开自包含 HTML,精致深色排版好截图;不立即 revoke,
  // 交给浏览器在标签关闭/GC 时回收(revoke 太早会让已打开的标签页突然空白)。
  const handlePreview = useCallback(() => {
    const blob = new Blob([buildHtml()], { type: "text/html;charset=utf-8" });
    window.open(URL.createObjectURL(blob), "_blank");
  }, [buildHtml]);

  // 下载自包含 HTML 文件——可直接转发这个文件,收件人双击用浏览器打开即所见即所得。
  const handleDownload = useCallback(() => {
    const blob = new Blob([buildHtml()], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `opc-chat-${runId || "replay"}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [buildHtml, runId]);

  return (
    <div>
      <div className="flex items-center gap-2 mb-1 flex-wrap">
        <h3 className="text-sm font-semibold text-ink m-0 flex items-center gap-2">
          <MessageCircle size={15} className="text-accent" /> {t("trace.tab.chat")}
        </h3>
        {isLive && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-success">
            <Radio size={11} className="animate-pulse" /> {t("trace.live")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={handlePreview} disabled={status !== "loaded"} className="btn-sm flex items-center gap-1">
            <ExternalLink size={12} /> {t("trace.chat.exportPreview")}
          </button>
          <button onClick={handleDownload} disabled={status !== "loaded"} className="btn-sm flex items-center gap-1">
            <Download size={12} /> {t("trace.chat.exportDownload")}
          </button>
        </div>
      </div>
      <p className="text-[11px] text-ink-subtle mb-3">{t("trace.chat.exportHint")}</p>

      {status === "loading" && (
        <div className="flex flex-col gap-3">
          <div className="skeleton w-2/3 h-10" />
          <div className="skeleton w-1/2 h-10 ml-auto" />
          <div className="skeleton w-3/4 h-16" />
        </div>
      )}

      {status === "error" && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <AlertTriangle size={28} className="text-error opacity-60" />
          <p className="text-ink-muted text-[13px]">{t("trace.chat.error")}</p>
          <button onClick={load} className="btn-sm flex items-center gap-1"><RefreshCw size={12} /> {t("trace.chat.retry")}</button>
        </div>
      )}

      {status === "loaded" && (
        <div className="flex flex-col gap-2.5 bg-surface-0/40 border border-hairline rounded-lg p-4">
          {isChatEmpty && (
            <p className="text-center text-[13px] text-ink-subtle py-1">
              {isLive ? t("trace.chat.emptyLive") : t("trace.chat.empty")}
            </p>
          )}
          {blocks.map(b => <BlockView key={b.id} block={b} onJumpToResult={jumpToResult} />)}
        </div>
      )}
    </div>
  );
}

function BlockView({ block, onJumpToResult }: { block: ChatBlock; onJumpToResult: () => void }) {
  if (block.kind === "divider") {
    return (
      <div className="flex items-center justify-center my-1">
        <span className="text-[11px] text-ink-subtle bg-surface-2 px-2.5 py-1 rounded-full">{block.label}</span>
      </div>
    );
  }
  if (block.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[78%] rounded-2xl rounded-tr-md px-3.5 py-2 bg-surface-2 text-ink text-[13px] leading-relaxed whitespace-pre-wrap break-words">
          {block.text}
        </div>
      </div>
    );
  }
  if (block.kind === "pill") {
    const tone = block.tone === "warn" ? "var(--color-warning)" : block.tone === "error" ? "var(--color-error)" : "var(--color-info)";
    return (
      <div className="flex justify-center">
        <span className="text-[11px] px-2.5 py-1 rounded-full" style={{ color: tone, background: `color-mix(in srgb, ${tone} 15%, transparent)` }}>{block.text}</span>
      </div>
    );
  }
  if (block.kind === "cluster") {
    return (
      <div className="flex items-start gap-2">
        <AgentAvatar agentId={block.actor.id ?? ""} size={30} />
        <div className="min-w-0 flex flex-col gap-1 max-w-[78%]">
          <div className="text-[11px] font-medium px-0.5" style={{ color: block.actor.color }}>{block.actor.name}</div>
          {block.messages.map(m => <ClusterMessage key={m.id} text={m.text} />)}
        </div>
      </div>
    );
  }
  // block.kind === "report"
  return (
    <div className="mt-2 rounded-xl border border-hairline-light p-3.5" style={{ background: "linear-gradient(155deg, color-mix(in srgb, var(--color-surface-2) 70%, transparent), var(--color-surface-1))" }}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold text-ink">{block.title}</span>
        <span className="badge text-white shrink-0" style={{ background: block.badgeColor }}>{block.badgeLabel}</span>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">{block.summary}</p>
      {!block.pending && (
        <button onClick={onJumpToResult} className="mt-2 text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80">
          {block.viewLabel}
        </button>
      )}
    </div>
  );
}

// 长消息折叠——UX 约定同 MessageBubble(common.expandFull/common.collapse 复用同一对 i18n key),
// 但聚合布局(头像+名字只显示一次、下面挂多条气泡)用不了 MessageBubble 的独立单条外壳,故独立实现。
function ClusterMessage({ text }: { text: string }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 280;
  const shown = isLong && !expanded ? text.slice(0, 280).trimEnd() + "…" : text;
  return (
    <div className="rounded-lg rounded-tl-sm px-3 py-2 bg-surface-2 text-ink text-[13px] leading-relaxed whitespace-pre-wrap break-words">
      {shown}
      {isLong && (
        <button onClick={() => setExpanded(v => !v)} className="block mt-1 text-[11px] font-medium text-accent bg-transparent border-none cursor-pointer p-0 hover:opacity-80">
          {expanded ? t("common.collapse") : t("common.expandFull")}
        </button>
      )}
    </div>
  );
}
