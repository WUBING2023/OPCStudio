import { useEffect, useState } from "react";
import { Star, ExternalLink, Trash2, Pencil, Download, Loader2, RefreshCw } from "lucide-react";
import { useCommunityStore, type RemoteEntry, type RemoteType } from "../store/useCommunityStore.js";
import { confirmDialog } from "./common/ConfirmDialog.js";
import { useT } from "../i18n.js";

const TYPE_BADGE: Record<RemoteType, string> = {
  template: "bg-accent/10 text-accent border-accent/20",
  agent: "bg-green/10 text-green border-green/20",
};
const FILTERS: Array<{ key: "all" | RemoteType }> = [{ key: "all" }, { key: "template" }, { key: "agent" }];
const STAR_KEY = "opc.remoteStarred"; // 星 = 收藏 + 点赞:点过的记这里 → 决定金黄 + 进「收藏」范围

type Scope = "all" | "mine" | "favorites";
const loadSet = (k: string) => { try { return new Set<string>(JSON.parse(localStorage.getItem(k) || "[]")); } catch { return new Set<string>(); } };

// GitHub-backed 社区(合并后的唯一社区视图):免登录浏览 + ⭐reaction + 作者主页链 + 安装到组织 + 自己内容的改/删 + 个人收藏。
// 排行/排名职能已迁到独立的「排行榜」栏目(见 components/community/Leaderboard.tsx)——这里只做纯浏览 + 管理。
export default function RemoteCommunity({ myLogin, scope, onEdit, onInstall }: {
  myLogin?: string; scope: Scope; onEdit: (e: RemoteEntry) => void; onInstall: (e: RemoteEntry) => void | Promise<void>;
}) {
  const t = useT();
  const typeLabel = (ty: "all" | RemoteType) => ty === "template" ? t("c.typeTemplate") : ty === "all" ? t("c.all") : t("c.worker");
  const store = useCommunityStore();
  const [typeFilter, setTypeFilter] = useState<"all" | RemoteType>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [starred, setStarred] = useState<Set<string>>(() => loadSet(STAR_KEY)); // 我点过星的(=收藏)

  useEffect(() => { store.loadRemote(); }, []);

  const flash = (m: string) => { setNotice(m); setTimeout(() => setNotice(null), 4500); };
  const isMine = (e: RemoteEntry) => !!myLogin && !!e.authorLogin && e.authorLogin.toLowerCase() === myLogin.toLowerCase();
  const key = (e: RemoteEntry) => `${e.type}:${e.id}`;
  const persist = (k: string, s: Set<string>) => localStorage.setItem(k, JSON.stringify([...s]));

  // 纯浏览列表:不再按 star 排序、不显示名次徽标(排行榜职能在独立栏目)。
  const entries = store.remoteEntries
    .filter(e => typeFilter === "all" || e.type === typeFilter)
    .filter(e => scope === "all" || (scope === "mine" ? isMine(e) : starred.has(key(e))))
    .filter(e => { const q = store.search.trim().toLowerCase(); return !q || e.title.toLowerCase().includes(q) || (e.author || "").toLowerCase().includes(q); });

  const run = async (e: RemoteEntry, fn: () => Promise<void>) => { setBusy(key(e)); try { await fn(); } finally { setBusy(null); } };

  const star = (e: RemoteEntry) => run(e, async () => {
    const currently = starred.has(key(e)); // 已收藏 → 再点 = 取消
    try {
      const n = await store.starRemote(e.type, e.id, currently);
      setStarred(prev => { const s = new Set(prev); currently ? s.delete(key(e)) : s.add(key(e)); persist(STAR_KEY, s); return s; });
      flash(currently ? t('c.unstarred') : (n != null ? t('c.starredWithCount', { n }) : t('c.starred')));
    } catch (err) { flash((err as { status?: number })?.status === 401 ? t('c.needLoginToStar') : ((err as Error)?.message || t('c.actionFailed'))); }
  });
  const install = (e: RemoteEntry) => run(e, async () => {
    try { await onInstall(e); } catch (err) { flash((err as Error)?.message || t('c.installFailed')); }
  });
  const del = async (e: RemoteEntry) => {
    if (!await confirmDialog({ title: t('c.confirmDeleteYours', { title: e.title }), body: t('c.deleteBody'), danger: true, confirmLabel: t('common.delete'), cancelLabel: t('common.cancel') })) return;
    run(e, async () => { const r = await store.deleteRemote(e.type, e.id); flash(r.prUrl ? t('c.deletePrSubmitted') : (r.error || t('c.deleteFailed'))); });
  };

  const scopeEmpty = scope === "favorites" ? t('c.emptyFavRemote') : scope === "mine" ? t('c.emptyMineRemote') : t('c.emptyAllRemote');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-1 pb-2 flex-wrap">
        <div className="inline-flex items-center gap-0.5 rounded-full bg-surface-2 p-0.5">
          {FILTERS.map(f => (
            <button key={f.key} onClick={() => setTypeFilter(f.key)}
              className={`px-2.5 py-1 rounded-full text-[12px] cursor-pointer border-none transition-colors ${
                typeFilter === f.key ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
              }`}>{typeLabel(f.key)}</button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={() => store.loadRemote()} title={t('c.refresh')} className="w-7 h-7 flex items-center justify-center rounded-lg bg-bg-card border border-border text-text-muted hover:text-text-primary cursor-pointer">
          <RefreshCw size={13} className={store.remoteLoading ? "animate-spin" : ""} />
        </button>
        <span className="text-[12px] text-text-muted">{t('c.entriesCount', { n: entries.length })}</span>
      </div>

      <div className="flex-1 overflow-auto">
        {(store.remoteLoading && store.remoteEntries.length === 0) ? (
          <div className="text-text-muted text-[13px] flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t('c.loadingRemote')}</div>
        ) : entries.length === 0 ? (
          <div className="text-text-muted text-[13px]">{scopeEmpty}</div>
        ) : (
          <div className="flex flex-wrap gap-3">
            {entries.map(e => {
              const mine = isMine(e);
              const b = busy === key(e);
              const isStarred = starred.has(key(e));
              return (
                <div key={key(e)} className="w-[264px] rounded-xl border border-border hover:border-accent/40 bg-bg-card p-3.5 flex flex-col gap-2 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${TYPE_BADGE[e.type]}`}>{typeLabel(e.type)}</span>
                    {mine && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-bg-hover text-text-muted border border-border">{t('c.mine')}</span>}
                    <div className="flex-1" />
                    <span title={t('c.downloadsTooltip')} className="inline-flex items-center gap-0.5 text-[12px] text-text-muted">
                      <Download size={11} /> {e.downloads}
                    </span>
                    <button onClick={() => star(e)} disabled={b} title={isStarred ? t('c.starredTooltip') : t('c.starTooltip')}
                      className="inline-flex items-center gap-1 text-[12px] text-text-secondary cursor-pointer bg-transparent border-none disabled:opacity-50">
                      <Star size={13} className={isStarred ? "fill-amber text-amber" : "text-text-muted"} /> {e.stars}
                    </button>
                  </div>
                  <div className="text-[14px] font-semibold text-text-primary leading-snug line-clamp-2" title={e.title}>{e.title}</div>
                  {e.description && <div className="text-[12px] text-text-secondary line-clamp-2">{e.description}</div>}
                  <div className="flex items-center gap-1 text-[12px] text-text-muted">
                    <span>by</span>
                    {e.authorUrl ? (
                      <a href={e.authorUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline inline-flex items-center gap-0.5">
                        {e.author || e.authorLogin}<ExternalLink size={10} />
                      </a>
                    ) : <span>{e.author || "?"}</span>}
                  </div>
                  <div className="flex items-center gap-1.5 pt-1 mt-auto">
                    <button onClick={() => install(e)} disabled={b}
                      className="flex-1 inline-flex items-center justify-center gap-1 text-[12px] btn-primary">
                      {b ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />} {t('c.installToOrg')}
                    </button>
                    {mine && (
                      <>
                        <button onClick={() => onEdit(e)} disabled={b} title={t('c.editResubmit')}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-hover text-text-secondary hover:text-text-primary cursor-pointer border border-border disabled:opacity-50"><Pencil size={13} /></button>
                        <button onClick={() => del(e)} disabled={b} title={t('common.delete')}
                          className="w-8 h-8 flex items-center justify-center rounded-lg bg-bg-hover text-text-muted hover:text-red cursor-pointer border border-border disabled:opacity-50"><Trash2 size={13} /></button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {notice && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[1200] px-4 py-2.5 rounded-xl bg-bg-card border border-border shadow-lg text-[13px] text-text-primary">{notice}</div>
      )}
    </div>
  );
}
