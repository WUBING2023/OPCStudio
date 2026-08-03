import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, Gauge, Hash, RefreshCw, Save } from "lucide-react";
import type { AgentNodeConfig, Company } from "@opc/shared";
import * as api from "../api/client.js";
import { useT } from "../i18n.js";
import { pushToast } from "../components/common/Toast.js";
import HeroStats from "../components/cost/HeroStats.js";
import StaffRanking from "../components/cost/StaffRanking.js";
import TaskBillList from "../components/cost/TaskBillList.js";
import StackedChart from "../components/cost/StackedChart.js";
import DimensionBar, { type TimeRange } from "../components/cost/DimensionBar.js";
import { fmtTok } from "../components/cost/format.js";
import { colorForProvider } from "../components/cost/providerColor.js";
import type { BudgetStatus, CostSummary, Roster, RunLedger, Timeseries } from "../components/cost/types.js";

const PAGE_SIZE = 25;

function localDate(daysAgo = 0): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function dateToIso(value: string, end: boolean): string {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day, end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0).toISOString();
}
function timeQuery(range: TimeRange, customStart: string, customEnd: string): string {
  if (range === "all") return "";
  const start = range === "7d" ? localDate(6) : range === "30d" ? localDate(29) : customStart;
  const end = range === "custom" ? customEnd : localDate();
  const params = new URLSearchParams();
  if (start) params.set("since", dateToIso(start, false));
  if (end) params.set("until", dateToIso(end, true));
  return params.toString();
}
function Bar({ pct, over }: { pct: number; over?: boolean }) {
  return <div className="h-1.5 rounded-full bg-surface-2 overflow-hidden"><div className="h-full rounded-full" style={{ width: `${Math.round(Math.min(1, pct) * 100)}%`, background: over ? "var(--color-error)" : pct > 0.8 ? "var(--color-warning)" : "var(--color-accent)" }} /></div>;
}
function Table<T>({ title, rows, cols }: { title: string; rows: T[]; cols: Array<{ key: string; render: (row: T) => React.ReactNode; align?: "right" }> }) {
  if (!rows.length) return null;
  return <div className="rounded-lg border border-hairline/60 bg-surface-1 overflow-hidden">
    <div className="px-4 py-3 text-ink font-semibold text-[13px] border-b border-hairline/60">{title}</div>
    <table className="w-full text-[13px]"><tbody>{rows.map((row, index) => <tr key={index} className="border-b border-hairline/60 last:border-b-0 hover:bg-surface-2/40">{cols.map(column => <td key={column.key} className={`px-4 py-2 ${column.align === "right" ? "text-right tabular-nums text-ink-muted" : "text-ink"}`}>{column.render(row)}</td>)}</tr>)}</tbody></table>
  </div>;
}

export default function CostPage() {
  const tr = useT();
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [timeseries, setTimeseries] = useState<Timeseries | null>(null);
  const [ledger, setLedger] = useState<RunLedger | null>(null);
  const [agents, setAgents] = useState<AgentNodeConfig[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [roster, setRoster] = useState<Roster>(new Map());
  const [page, setPage] = useState(0);
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [limitDrafts, setLimitDrafts] = useState<Record<string, string>>({});
  const [savingCompanyId, setSavingCompanyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dateQuery = useMemo(() => timeQuery(timeRange, customStart, customEnd), [timeRange, customStart, customEnd]);
  const companyQuery = companyId ? `company=${encodeURIComponent(companyId)}` : "";
  const querySuffix = [dateQuery, companyQuery].filter(Boolean).join("&");

  const loadReferenceData = useCallback(async () => {
    const [nextAgents, nextCompanies] = await Promise.all([api.get<AgentNodeConfig[]>("/agents"), api.get<Company[]>("/companies")]);
    const enabledAgents = nextAgents.filter(agent => agent.enabled !== false);
    setAgents(enabledAgents);
    setCompanies(nextCompanies);
    setRoster(new Map(enabledAgents.map(agent => [agent.id, { name: agent.name, role: agent.role, companyId: agent.companyId }])));
  }, []);
  const applyBudget = useCallback((next: BudgetStatus) => {
    setBudget(next);
    setLimitDrafts(Object.fromEntries(next.companyBudgets.map(item => [item.companyId, String(item.maxTokensTotal || "")])));
  }, []);
  const loadBudget = useCallback(async () => applyBudget(await api.get<BudgetStatus>("/budget/status")), [applyBudget]);
  const refresh = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const suffix = querySuffix ? `&${querySuffix}` : "";
      const tsSuffix = timeRange === "all" ? `${suffix}&all=1` : suffix;
      const [nextSummary, nextBudget, nextTimeseries] = await Promise.all([
        api.get<CostSummary>(`/cost/summary?limit=20${suffix}`),
        api.get<BudgetStatus>("/budget/status"),
        api.get<Timeseries>(`/cost/timeseries?metric=tokens${tsSuffix}`),
      ]);
      setSummary(nextSummary); applyBudget(nextBudget); setTimeseries(nextTimeseries);
    } catch (cause: any) { setError(String(cause?.message || cause)); }
    finally { setLoading(false); }
  }, [applyBudget, querySuffix, timeRange]);

  useEffect(() => { loadReferenceData().catch(cause => setError(String(cause?.message || cause))); }, [loadReferenceData]);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { setPage(0); }, [timeRange, customStart, customEnd, companyId]);
  useEffect(() => {
    const suffix = querySuffix ? `&${querySuffix}` : "";
    api.get<RunLedger>(`/cost/runs?offset=${page * PAGE_SIZE}&limit=${PAGE_SIZE}${suffix}`).then(setLedger).catch(() => {});
  }, [page, querySuffix]);

  const availableRoles = useMemo(() => [...new Set(agents.filter(agent => !companyId || agent.companyId === companyId).map(agent => agent.role).filter(Boolean))].sort((a, b) => a.localeCompare(b)), [agents, companyId]);
  useEffect(() => { if (roleFilter && !availableRoles.includes(roleFilter)) setRoleFilter(null); }, [availableRoles, roleFilter]);
  const roleLabel = useCallback((role: string) => { const key = `cost.role.${role}`; const label = tr(key); return label === key ? role : label; }, [tr]);
  const visibleBudgets = useMemo(() => (budget?.companyBudgets ?? []).filter(item => !companyId || item.companyId === companyId), [budget, companyId]);

  const saveCompanyLimit = async (targetCompanyId: string) => {
    const raw = limitDrafts[targetCompanyId]?.trim() ?? "";
    const value = raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 10_000_000_000) { pushToast("error", tr("cost.budget.invalid")); return; }
    setSavingCompanyId(targetCompanyId);
    try {
      const updated = await api.patch<Company>(`/companies/${encodeURIComponent(targetCompanyId)}`, { maxTokensTotal: value });
      setCompanies(current => current.map(company => company.id === updated.id ? updated : company));
      await loadBudget();
      pushToast("success", tr("cost.budget.saved"));
    } catch (cause: any) { pushToast("error", tr("cost.budget.saveFailed", { message: cause?.message || String(cause) })); }
    finally { setSavingCompanyId(null); }
  };

  return <div className="h-full overflow-auto bg-surface-2/20 p-5"><div className="max-w-5xl mx-auto">
    <div className="flex items-center gap-2 mb-4"><h1 className="text-ink font-bold text-[16px] tracking-tight">{tr("cost.page.title")}</h1><div className="flex-1" /><button onClick={refresh} title={tr("cost.page.refresh")} className="w-8 h-8 flex items-center justify-center rounded-lg bg-surface-2 text-ink-muted hover:text-ink cursor-pointer border-none"><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button></div>
    {error && <div className="mb-4 px-4 py-2 rounded-lg bg-red/10 text-red text-[13px] flex items-center gap-2"><AlertTriangle size={15} />{error}</div>}
    {summary && timeseries && <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }} className="space-y-4">
      <DimensionBar timeRange={timeRange} onTimeRange={setTimeRange} customStart={customStart} customEnd={customEnd} onCustomStart={setCustomStart} onCustomEnd={setCustomEnd} companies={companies} companyId={companyId} onCompanyId={setCompanyId} roles={availableRoles} roleFilter={roleFilter} onRoleFilter={setRoleFilter} roleLabel={roleLabel} />
      <HeroStats summary={summary} roster={roster} companies={companies} />
      <div className="rounded-lg border border-hairline/60 bg-surface-1 px-4 py-4"><div className="flex items-center gap-2 text-ink font-semibold text-[13px] mb-3"><Hash size={15} />{tr("cost.chart.sectionTitle", { period: timeseries.period })}</div><StackedChart ts={timeseries} /></div>
      <StaffRanking summary={summary} roster={roster} companies={companies} roleFilter={roleFilter} />
      {budget && <div className="rounded-lg border border-hairline/60 bg-surface-1 overflow-hidden">
        <div className="px-4 py-3 flex items-center gap-2 border-b border-hairline/60"><Gauge size={14} className="text-ink-muted" /><span className="text-ink font-semibold text-[13px]">{tr("cost.budget.companyTitle")}</span></div>
        <div className="divide-y divide-hairline/60">{visibleBudgets.map(item => <div key={item.companyId} className="px-4 py-3 grid grid-cols-1 sm:grid-cols-[minmax(150px,1fr)_minmax(180px,1fr)_190px] gap-3 items-center">
          <div className="min-w-0"><div className="text-ink text-[12px] font-medium truncate">{item.companyName}</div><div className="text-ink-subtle text-[10px] mt-0.5">{item.maxTokensTotal > 0 ? tr("cost.budget.used", { used: fmtTok(item.usedTokens), limit: fmtTok(item.maxTokensTotal) }) : tr("cost.budget.companyUnlimited", { used: fmtTok(item.usedTokens) })}</div></div>
          <Bar pct={item.pctTokens} over={item.overTokensTotal} />
          <div className="flex items-center gap-2"><input type="number" min={0} max={10_000_000_000} step={1000} value={limitDrafts[item.companyId] ?? ""} onChange={event => setLimitDrafts(current => ({ ...current, [item.companyId]: event.currentTarget.value }))} placeholder={tr("cost.budget.companyInput")} aria-label={tr("cost.budget.companyInput")} className="h-8 min-w-0 flex-1 rounded-md border border-hairline bg-surface-2/50 px-2 text-[11px] text-ink outline-none focus:border-accent" /><button onClick={() => saveCompanyLimit(item.companyId)} disabled={savingCompanyId === item.companyId} title={tr("cost.budget.save")} className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-md border border-hairline bg-surface-1 text-ink-muted hover:text-ink cursor-pointer disabled:opacity-50"><Save size={13} /></button></div>
        </div>)}</div>
      </div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Table title={tr("cost.table.byProvider")} rows={summary.byProvider} cols={[{ key: "provider", render: row => <span className="flex items-center gap-2"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: colorForProvider(row.provider) }} />{row.provider}</span> }, { key: "tokens", render: row => fmtTok(row.tokens), align: "right" }, { key: "calls", render: row => tr("cost.table.calls", { n: row.calls }), align: "right" }]} />
        <Table title={tr("cost.table.byModel")} rows={summary.byModel} cols={[{ key: "model", render: row => row.model }, { key: "tokens", render: row => fmtTok(row.tokens), align: "right" }]} />
      </div>
      <TaskBillList ledger={ledger} roster={roster} page={page} pageSize={PAGE_SIZE} onPageChange={setPage} roleFilter={roleFilter} />
      <div className="text-center text-ink-subtle text-[11px] pt-1"><span className="text-ink">{tr("cost.footer.tokenTruth")}</span>{tr("cost.footer.tokenTruthDetail")}</div>
    </motion.div>}
    {loading && !summary && <div className="text-ink-muted text-[13px] py-10 text-center">{tr("cost.page.loading")}</div>}
  </div></div>;
}
