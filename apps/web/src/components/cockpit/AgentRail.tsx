import { useMemo, useEffect, useState } from "react";
import { Star, Users, Code2, FlaskConical, Shield, Server, Compass, Bot, Pin, PinOff, MessageSquare, FileText, Wrench, Megaphone, UsersRound, type LucideIcon } from "lucide-react";
import type { AgentNodeConfig, Company, TraceEvent } from "@opc/shared";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useCockpitStore } from "../../store/useCockpitStore.js";
import { useT } from "../../i18n.js";
import * as api from "../../api/client.js";
import { STATUS_COLORS, ROLE_LABELS, statusLabel } from "../../lib/agentMeta.js";
import { DEFAULT_COMPANY, groupAgentsByTeam, sameGroup, type GroupSelection } from "../../lib/cockpitGroups.js";
import { navigateApp } from "../../lib/navigation.js";

const ROLE_ICONS: Record<string, LucideIcon> = {
  ceo: Star, lead: Users, dev: Code2, test: FlaskConical,
  security: Shield, ops: Server, architect: Compass,
};
// 公司分组配色(按公司顺序分配;default 用中性灰)。
const COMPANY_COLORS = ["#5e6ad2", "#d97757", "#0d9488", "#957bc1", "#6b9fc4", "#c99a52", "#b87a96", "#3fae67"];

function rank(a: AgentNodeConfig): number { return a.role === "ceo" ? 0 : a.role === "lead" ? 1 : 2; }
type TFn = (key: string, params?: Record<string, string | number>) => string;
function relTime(iso: string | undefined, tr: TFn): string {
  if (!iso) return "";
  const ts = new Date(iso).getTime(); if (isNaN(ts)) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return tr("cockpit.timeJustNow");
  if (s < 3600) return tr("cockpit.timeMinAgo", { n: Math.floor(s / 60) });
  if (s < 86400) return tr("cockpit.timeHourAgo", { n: Math.floor(s / 3600) });
  return tr("cockpit.timeDayAgo", { n: Math.floor(s / 86400) });
}
type ActKind = "message" | "output" | "work";
const ACT_ICON: Record<ActKind, LucideIcon> = { message: MessageSquare, output: FileText, work: Wrench };

// C3 项目群:activeGroup/onSelectGroup 由 CockpitPage 持有(不进 useCockpitStore,群选中态是
// 工作台页面内的临时视图状态);选群与选人互斥——选群清空选人,选人清空选群。
export default function AgentRail({ activeGroup = null, onSelectGroup, initialCompanyId }: {
  activeGroup?: GroupSelection | null;
  onSelectGroup?: (g: GroupSelection | null) => void;
  initialCompanyId?: string;
}) {
  const tr = useT();
  const agents = useAgentStore((s) => s.agents);
  const events = useAgentStore((s) => s.events);
  const activeAgentId = useCockpitStore((s) => s.activeAgentId);
  const setActiveAgent = useCockpitStore((s) => s.setActiveAgent);
  const companyFilter = useCockpitStore((s) => s.companyFilter);
  const setCompanyFilter = useCockpitStore((s) => s.setCompanyFilter);
  const pinnedIds = useCockpitStore((s) => s.pinnedIds);
  const togglePin = useCockpitStore((s) => s.togglePin);
  const localMessages = useCockpitStore((s) => s.localMessages);
  const [companies, setCompanies] = useState<Company[]>([]);

  useEffect(() => { api.get<Company[]>("/companies").then(setCompanies).catch(() => { /* ignore */ }); }, [agents.length]);
  useEffect(() => {
    if (initialCompanyId) setCompanyFilter(initialCompanyId);
  }, [initialCompanyId, setCompanyFilter]);

  const companyColor = useMemo(() => {
    const m = new Map<string, string>();
    companies.forEach((c, i) => m.set(c.id, COMPANY_COLORS[i % COMPANY_COLORS.length]));
    m.set("default", "var(--color-ink-subtle)");
    return m;
  }, [companies]);
  const companyName = useMemo(() => {
    const m = new Map<string, string>(); companies.forEach((c) => m.set(c.id, c.name)); m.set("default", tr("cockpit.defaultCompany")); return m;
  }, [companies, tr]);

  // 每个 agent 的最近活动(谁刚产出消息 / 产出 / 在干活)——让"谁产出了报告/消息"可见 + 最近置顶。
  const activity = useMemo(() => {
    const m = new Map<string, { ts: string; kind: ActKind }>();
    const bump = (id: string, ts: string, kind: ActKind) => { const c = m.get(id); if (ts && (!c || ts > c.ts)) m.set(id, { ts, kind }); };
    for (const lm of localMessages) bump(lm.agentId, lm.ts, "message");
    for (const e of events as TraceEvent[]) {
      if (!e.agentId) continue;
      if (e.type === "agent_message") bump(e.agentId, e.timestamp, "message");
      else if (e.type === "model_call_finished") bump(e.agentId, e.timestamp, "output");
      else if (e.type === "agent_status_changed" || e.type === "tool_result") bump(e.agentId, e.timestamp, "work");
    }
    return m;
  }, [localMessages, events]);

  const groups = useMemo(() => {
    const pin = new Set(pinnedIds);
    const tsOf = (id: string) => activity.get(id)?.ts ?? "";
    const cmp = (a: AgentNodeConfig, b: AgentNodeConfig) => {
      const pa = pin.has(a.id) ? 0 : 1, pb = pin.has(b.id) ? 0 : 1;
      if (pa !== pb) return pa - pb;                  // 置顶优先
      const ta = tsOf(a.id), tb = tsOf(b.id);
      if (ta !== tb) return tb.localeCompare(ta);      // 最近活动在前
      return (rank(a) - rank(b)) || a.name.localeCompare(b.name);
    };
    if (companyFilter !== "all") {
      const list = agents.filter((a) => (a.companyId || "default") === companyFilter);
      return [{ id: companyFilter, agents: [...list].sort(cmp) }];
    }
    const byCo = new Map<string, AgentNodeConfig[]>();
    for (const a of agents) { const c = a.companyId || "default"; if (!byCo.has(c)) byCo.set(c, []); byCo.get(c)!.push(a); }
    const arr = [...byCo.entries()].map(([id, ags]) => ({ id, agents: ags.sort(cmp) }));
    const groupTs = (g: { agents: AgentNodeConfig[] }) => g.agents.reduce((mx, a) => { const t = tsOf(a.id); return t > mx ? t : mx; }, "");
    arr.sort((x, y) => groupTs(y).localeCompare(groupTs(x)));  // 最活跃公司在上
    return arr;
  }, [agents, companyFilter, pinnedIds, activity]);

  const total = groups.reduce((n, g) => n + g.agents.length, 0);
  const grouped = companyFilter === "all" && groups.length > 1;

  // ── C3 群组入口:全公司群(每公司一个)+ 部门群(lead 子树推导),随公司筛选联动。──
  const teams = useMemo(() => groupAgentsByTeam(agents), [agents]);
  const groupEntries = useMemo<{ sel: GroupSelection; count: number }[]>(() => {
    const companyIds: string[] = [];
    for (const a of agents) {
      const c = a.companyId || DEFAULT_COMPANY;
      if (!companyIds.includes(c)) companyIds.push(c);
    }
    const visible = companyFilter === "all" ? companyIds : companyIds.filter((c) => c === companyFilter);
    const multi = visible.length > 1;
    const out: { sel: GroupSelection; count: number }[] = [];
    for (const c of visible) {
      const name = companyName.get(c) ?? c;
      const label = multi ? `${name} · ${tr("cockpit.allCompanyGroup")}` : tr("cockpit.allCompanyGroup");
      out.push({ sel: { kind: "company", companyId: c, label }, count: agents.filter((a) => (a.companyId || DEFAULT_COMPANY) === c).length });
      for (const t of teams.filter((t) => t.companyId === c)) {
        out.push({ sel: { kind: "team", companyId: c, leadId: t.leadId, label: tr("cockpit.deptGroup", { name: t.leadName }) }, count: t.memberIds.length });
      }
    }
    return out;
  }, [agents, teams, companyFilter, companyName, tr]);

  const selectGroup = (sel: GroupSelection) => {
    onSelectGroup?.(sel);
    setActiveAgent(null); // 选群与选人互斥
    setCompanyFilter(sel.companyId);
    navigateApp({ page: "cockpit", companyId: sel.companyId });
  };
  const selectAgent = (id: string) => {
    setActiveAgent(id);
    onSelectGroup?.(null);
    const companyId = agents.find((agent) => agent.id === id)?.companyId || DEFAULT_COMPANY;
    setCompanyFilter(companyId);
    navigateApp({ page: "cockpit", companyId, agentId: id });
  };

  const selectCompany = (companyId: string) => {
    setCompanyFilter(companyId);
    setActiveAgent(null);
    onSelectGroup?.(null);
    navigateApp({ page: "cockpit", companyId });
  };

  return (
    <div className="h-full flex flex-col bg-surface-1 overflow-hidden">
      <div className="px-2 py-2 border-b border-hairline shrink-0">
        <select value={companyFilter} onChange={(e) => selectCompany(e.target.value)}
          className="w-full bg-surface-0 border border-hairline rounded text-[12px] text-ink px-2 py-1.5 outline-none cursor-pointer focus:border-accent">
          <option value="all">{tr("cockpit.allCompaniesGrouped")}</option>
          {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="px-3 h-7 flex items-center text-[11px] text-ink-subtle shrink-0">{tr("cockpit.staffCount", { n: total })}{grouped ? tr("cockpit.companiesSuffix", { n: groups.length }) : ""}</div>
      <div className="flex-1 overflow-y-auto">
        {groupEntries.length > 0 && (
          <div className="pb-1 border-b border-hairline">
            <div className="px-3 pt-1 pb-0.5 text-[11px] font-semibold text-ink-subtle uppercase tracking-wide">{tr("cockpit.groupsSection")}</div>
            {groupEntries.map(({ sel, count }) => {
              const active = sameGroup(activeGroup, sel);
              const isCompany = sel.kind === "company";
              const Icon = isCompany ? Megaphone : UsersRound;
              const key = isCompany ? `co:${sel.companyId}` : `team:${sel.companyId}:${sel.leadId}`;
              return (
                <div key={key} onClick={() => selectGroup(sel)} title={sel.label}
                  className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors ${active ? "bg-surface-2" : "hover:bg-surface-2"}`}>
                  <div className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-surface-0 border border-hairline">
                    <Icon size={15} className={isCompany ? "text-accent" : "text-ink-muted"} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-ink truncate">{sel.label}</div>
                    <div className="text-[11px] text-ink-subtle truncate">{tr("cockpit.groupMembers", { n: count })}</div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {groups.map((g) => {
          const ccolor = companyColor.get(g.id) ?? "var(--color-ink-subtle)";
          return (
            <div key={g.id}>
              {grouped && (
                <div className="px-3 pt-2 pb-1 flex items-center gap-1.5 sticky top-0 bg-surface-1 z-10">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: ccolor }} />
                  <span className="text-[11px] font-semibold text-ink-muted truncate">{companyName.get(g.id) ?? g.id}</span>
                  <span className="text-[10px] text-ink-subtle">· {g.agents.length}</span>
                </div>
              )}
              {g.agents.map((a) => {
                const Icon = ROLE_ICONS[a.role] || Bot;
                const color = STATUS_COLORS[a.status] ?? "#888";
                const active = !activeGroup && a.id === activeAgentId;
                const pinned = pinnedIds.includes(a.id);
                const act = activity.get(a.id);
                const ActIcon = act ? ACT_ICON[act.kind] : null;
                const isNew = act ? (Date.now() - new Date(act.ts).getTime() < 120000) : false;
                return (
                  <div key={a.id} onClick={() => selectAgent(a.id)}
                    title={`${a.name} · ${ROLE_LABELS[a.role] || a.role}`}
                    className={`group flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors shrink-0 ${active ? "bg-surface-2" : "hover:bg-surface-2"}`}
                    style={grouped ? { borderLeft: `2px solid ${ccolor}`, paddingLeft: 10 } : undefined}>
                    <div className="relative shrink-0 w-8 h-8 rounded-full flex items-center justify-center bg-surface-0" style={{ border: `1.5px solid ${color}` }}>
                      <Icon size={15} className="text-ink-muted" strokeWidth={1.75} />
                      <span className="absolute rounded-full" style={{ top: -1, right: -1, width: 8, height: 8, background: color, boxShadow: "0 0 0 2px var(--color-surface-1)" }} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate flex items-center gap-1">
                        {pinned && <Pin size={10} className="text-accent shrink-0" />}{a.name}
                        {isNew && <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" title={tr("cockpit.recentActivity")} />}
                      </div>
                      <div className="text-[11px] text-ink-subtle truncate flex items-center gap-1.5">
                        <span className="truncate">{(ROLE_LABELS[a.role] || a.role)} · {statusLabel(tr, a.status)}</span>
                        {act && ActIcon && (
                          <span className="flex items-center gap-0.5 shrink-0" style={{ color: isNew ? "var(--color-accent)" : undefined }}>
                            <ActIcon size={9} /> {relTime(act.ts, tr)}
                          </span>
                        )}
                      </div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); togglePin(a.id); }} title={pinned ? tr("cockpit.unpin") : tr("cockpit.pinConversation")}
                      className={`shrink-0 w-6 h-6 flex items-center justify-center rounded border-none bg-transparent cursor-pointer hover:bg-surface-0 transition-opacity ${pinned ? "text-accent" : "text-ink-subtle opacity-0 group-hover:opacity-100"}`}>
                      {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                    </button>
                  </div>
                );
              })}
            </div>
          );
        })}
        {total === 0 && <div className="px-3 py-3 text-[12px] text-ink-subtle">{tr("cockpit.noStaffYet")}</div>}
      </div>
    </div>
  );
}
