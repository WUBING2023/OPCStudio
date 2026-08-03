import { useEffect, useState } from "react";
import { Trophy, Star, Building2, User, Loader2 } from "lucide-react";
import * as api from "../../api/client.js";
import { useCommunityStore, type RemoteEntry, type RemoteType } from "../../store/useCommunityStore.js";
import { useT } from "../../i18n.js";

// 独立的「排行榜」栏目——排名职能从 RemoteCommunity 迁出到这里(总榜/日榜/周榜/月榜/年榜,按 star)。
// 日/周/月/年数据来自服务端历史快照(/community/remote/history),契约与 RemoteCommunity 之前用的一致。
type Period = "all" | "day" | "week" | "month" | "year";
const PERIODS: Period[] = ["all", "day", "week", "month", "year"];
const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = { day: 1, week: 7, month: 30, year: 365 };
interface PeriodStars { ready: boolean; daysAvailable: number; daysNeeded: number; deltas: Record<string, number> }
interface HistoryResp { day: PeriodStars; week: PeriodStars; month: PeriodStars; year: PeriodStars }

// 领奖台配色:低饱和暖金/银灰/铜棕,只用描边 + 小徽标,不做大面积色块填充。
const PODIUM_STYLE = [
  { ring: "border-amber/40", badge: "bg-amber/10 text-amber border-amber/30", iconBg: "bg-amber/10", icon: "text-amber" },
  { ring: "border-border-light", badge: "bg-bg-hover text-text-secondary border-border-light", iconBg: "bg-bg-hover", icon: "text-text-secondary" },
  { ring: "border-orange/30", badge: "bg-orange/10 text-orange border-orange/30", iconBg: "bg-orange/5", icon: "text-orange" },
];

const typeIcon = (ty: RemoteType) => (ty === "template" ? Building2 : User);

export default function Leaderboard({ onOpenEntry }: { onOpenEntry: (e: RemoteEntry) => void }) {
  const t = useT();
  const store = useCommunityStore();
  const [period, setPeriod] = useState<Period>("all");
  // 用户指令:排行榜分「团队」(模板)和「员工」两个榜单
  const [category, setCategory] = useState<RemoteType>("template");
  const [history, setHistory] = useState<HistoryResp | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  useEffect(() => { store.loadRemote(); }, []);
  useEffect(() => {
    setHistoryLoading(true);
    api.get<HistoryResp>("/community/remote/history").then(setHistory).catch(() => setHistory(null)).finally(() => setHistoryLoading(false));
  }, []);

  const typeLabel = (ty: RemoteType) => (ty === "template" ? t("c.typeTemplate") : t("c.worker"));
  const periodLabel = (p: Period) => (
    p === "all" ? t("c.periodAll") :
    p === "day" ? t("c.periodDay") :
    p === "week" ? t("c.periodWeek") :
    p === "month" ? t("c.periodMonth") : t("c.periodYear")
  );

  const periodInfo = period === "all" ? null : history?.[period] ?? null;
  const periodReady = period === "all" || !!periodInfo?.ready;
  const scoreOf = (e: RemoteEntry): number => (period === "all" ? e.stars : (periodInfo?.deltas[`${e.type}:${e.id}`] ?? 0));

  const ranked = periodReady ? [...store.remoteEntries].filter(e => e.type === category).sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, 20) : [];
  const top3 = ranked.slice(0, 3);
  const rest = ranked.slice(3);
  // 领奖台展示顺序:2 名(左,略低)/ 1 名(中,同尺寸但位置略高)/ 3 名(右,略低)。
  const podiumSlots: Array<{ e: RemoteEntry; rank: number } | null> = [
    top3[1] ? { e: top3[1], rank: 1 } : null,
    top3[0] ? { e: top3[0], rank: 0 } : null,
    top3[2] ? { e: top3[2], rank: 2 } : null,
  ];

  const waitingHistory = period !== "all" && historyLoading && !history;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1.5">
        <Trophy size={16} className="text-amber" />
        <h3 className="m-0 text-[14px] font-semibold text-text-primary">{t("c.leaderboard")}</h3>
      </div>
      <p className="mt-1 mb-3 text-[12px] text-text-muted">{t("c.leaderboardHelp")}</p>

      <div className="flex items-center gap-1.5 pb-2 flex-wrap">
        {/* 类别榜:团队(模板)/ 员工 */}
        <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5">
          {(["template", "agent"] as RemoteType[]).map(ty => {
            const Icon = typeIcon(ty);
            return (
              <button key={ty} onClick={() => setCategory(ty)}
                className={`px-3 py-1 rounded-full text-[12px] font-semibold cursor-pointer border-none transition-colors inline-flex items-center gap-1.5 ${
                  category === ty ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                }`}><Icon size={12} />{ty === "template" ? t("c.lbTeams") : t("c.lbAgents")}</button>
            );
          })}
        </div>
        <span className="w-px h-4 bg-border mx-1" />
        <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5">
          {PERIODS.map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1 rounded-full text-[12px] font-medium cursor-pointer border-none transition-colors ${
                period === p ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
              }`}>{periodLabel(p)}</button>
          ))}
        </div>
      </div>
      <div className="pb-3" />

      <div className="flex-1 overflow-auto">
        {(store.remoteLoading && store.remoteEntries.length === 0) || waitingHistory ? (
          <div className="text-text-muted text-[13px] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t("c.loadingRemote")}</div>
        ) : period !== "all" && !periodReady ? (
          <div className="text-text-muted text-[13px]">
            {t("c.historyAccumulating", { n: periodInfo?.daysNeeded ?? PERIOD_DAYS[period as Exclude<Period, "all">] })}
          </div>
        ) : ranked.length === 0 ? (
          <div className="text-text-muted text-[13px]">{t("c.leaderboardEmpty")}</div>
        ) : (
          <>
            {/* 领奖台:三张卡片同宽同高,榜一仅位置略高(靠底边距上提),二三名平齐略低。 */}
            <div className="flex items-end justify-center gap-3 pb-6 pt-3">
              {podiumSlots.map((slot, i) => {
                if (!slot) return <div key={i} className="w-[156px]" />;
                const { e, rank } = slot;
                const style = PODIUM_STYLE[rank];
                const Icon = typeIcon(e.type);
                const isFirst = rank === 0;
                const score = scoreOf(e);
                return (
                  <button key={`${e.type}:${e.id}`} onClick={() => onOpenEntry(e)} title={t("c.leaderboardOpenHint")}
                    className={`relative flex flex-col items-center gap-1.5 rounded-xl border bg-bg-card px-3.5 pt-5 pb-4 w-[156px] text-left cursor-pointer transition-transform hover:-translate-y-0.5 ${style.ring} ${
                      isFirst ? "mb-3" : ""
                    }`}>
                    <span title={t("c.rankTooltip", { n: rank + 1 })}
                      className={`absolute -top-3 w-6 h-6 flex items-center justify-center rounded-full border text-[11px] font-semibold ${style.badge}`}>
                      {rank + 1}
                    </span>
                    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${style.iconBg}`}>
                      <Icon size={16} className={style.icon} />
                    </div>
                    <div className="text-[13px] font-semibold text-text-primary leading-snug line-clamp-2 text-center w-full" title={e.title}>{e.title}</div>
                    <div className="text-[11px] text-text-muted truncate w-full text-center">{e.author || e.authorLogin || "?"}</div>
                    <div className="inline-flex items-center gap-1 text-[12px] text-text-secondary font-medium">
                      <Star size={12} className="fill-amber text-amber" /> {period !== "all" ? `+${score}` : score}
                    </div>
                  </button>
                );
              })}
            </div>

            {rest.length > 0 && (
              <div className="flex flex-col gap-0.5">
                <div className="px-2.5 pb-1 text-[11px] font-medium text-text-muted">{t("c.leaderboardRest")}</div>
                {rest.map((e, i) => {
                  const Icon = typeIcon(e.type);
                  const score = scoreOf(e);
                  return (
                    <button key={`${e.type}:${e.id}`} onClick={() => onOpenEntry(e)} title={t("c.leaderboardOpenHint")}
                      className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-transparent hover:border-border hover:bg-bg-hover text-left cursor-pointer transition-colors">
                      <span className="w-5 shrink-0 text-[12px] text-text-muted text-right tabular-nums">{i + 4}</span>
                      <Icon size={13} className="text-text-muted shrink-0" />
                      <span className="flex-1 min-w-0 text-[13px] text-text-primary truncate" title={e.title}>{e.title}</span>
                      <span title={typeLabel(e.type)} className="hidden sm:inline text-[11px] text-text-muted shrink-0">{typeLabel(e.type)}</span>
                      <span className="text-[12px] text-text-muted shrink-0 max-w-[110px] truncate">{e.author || e.authorLogin || "?"}</span>
                      <span className="inline-flex items-center gap-1 text-[12px] text-text-secondary shrink-0 w-12 justify-end">
                        <Star size={11} className="text-amber" /> {period !== "all" ? `+${score}` : score}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
