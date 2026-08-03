import { useMemo, useState } from "react";
import { ChevronDown, Radio } from "lucide-react";
import { AgentAvatar, SystemAvatar } from "./AgentAvatar.js";
import { eventColor, eventLabelKey, isKeyTimelineEvent, LIVE_TAIL, type NormEvent } from "./traceTypes.js";
import { fmtTime } from "./traceFormat.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";

// ②过程回放——"故事化"排版:头像 +「谁 做了什么」+ 时间,领域事件(抢救/强并/错配/模板/教训)保留高亮色。
// 折叠默认只显示关键节点(派工/产出/异常/交付,见 traceTypes.isKeyTimelineEvent),"显示全部"展开记忆记账类细节。
export default function ProcessTimeline({ items, isLive, liveTotal }: { items: NormEvent[]; isLive: boolean; liveTotal: number }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const agents = useAgentStore(s => s.agents);

  const foldedCount = useMemo(() => items.filter(i => !isKeyTimelineEvent(i)).length, [items]);
  const visible = expanded ? items : items.filter(isKeyTimelineEvent);

  const actorName = (agentId: string) => agents.find(a => a.id === agentId)?.name ?? agentId;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink m-0 mb-3 flex items-center gap-2 flex-wrap">
        {t("trace.timeline")} <span className="text-ink-subtle font-normal">({items.length})</span>
        {isLive && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-success">
            <Radio size={11} className="animate-pulse" /> {t("trace.live")}
          </span>
        )}
        {foldedCount > 0 && (
          <button
            onClick={() => setExpanded(v => !v)}
            className="ml-auto text-[11px] text-accent bg-transparent border-none cursor-pointer flex items-center gap-1 hover:underline"
          >
            {expanded ? t("trace.timelineCollapse") : t("trace.timelineExpand", { n: foldedCount })}
            <ChevronDown size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </h3>
      {isLive && liveTotal > LIVE_TAIL && (
        <p className="text-[11px] text-ink-subtle -mt-2 mb-3">{t("trace.eventsTruncated", { n: LIVE_TAIL })}</p>
      )}

      {items.length === 0 ? (
        <p className="text-ink-muted text-[13px]">{isLive ? t("trace.timelineEmptyLive") : t("trace.timelineEmpty")}</p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {visible.map(item => {
            const c = eventColor(item.type, item.kind);
            const lk = eventLabelKey(item.type, item.kind);
            const label = lk ? t(lk) : item.type;
            return (
              <div key={item.key} className="flex items-start gap-2.5">
                {item.agentId ? <AgentAvatar agentId={item.agentId} size={26} /> : <SystemAvatar size={26} />}
                <div className="flex-1 min-w-0 bg-bg-card border border-hairline rounded-md px-3 py-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-medium text-ink truncate">
                      {item.agentId ? actorName(item.agentId) : t("trace.systemActor")}
                    </span>
                    <span
                      className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${lk ? "" : "font-mono"}`}
                      style={{ color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` }}
                    >
                      {label}
                    </span>
                    {item.seq !== undefined && (
                      <span className="text-[10px] font-mono text-ink-subtle tabular-nums">#{item.seq}</span>
                    )}
                    <span className="ml-auto text-[11px] text-ink-subtle tabular-nums shrink-0">{fmtTime(item.at)}</span>
                  </div>
                  {item.message && (
                    <div className="mt-1 text-[12px] text-ink-muted break-words">{item.message}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
