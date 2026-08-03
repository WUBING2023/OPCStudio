import { useMemo, useState } from "react";
import { ChevronDown, Users } from "lucide-react";
import type { Company } from "@opc/shared";
import { useT } from "../../i18n.js";
import { Avatar } from "./Avatar.js";
import { fmtTokens } from "./format.js";
import { agentDisplay } from "../../lib/costAgentMeta.js";
import type { CostSummary, Roster } from "./types.js";

const VISIBLE = 8;

export default function StaffRanking({ summary, roster, companies, roleFilter }: { summary: CostSummary; roster: Roster; companies: Company[]; roleFilter?: string | null }) {
  const tr = useT();
  const [showAll, setShowAll] = useState(false);
  const companyNames = useMemo(() => new Map(companies.map(company => [company.id, company.name])), [companies]);
  const allRows = useMemo(() => [...summary.byAgent].sort((a, b) => b.tokens - a.tokens), [summary.byAgent]);
  const rows = useMemo(() => roleFilter ? allRows.filter(row => agentDisplay(row.agentId, roster).role === roleFilter) : allRows, [allRows, roleFilter, roster]);
  const maximum = rows.length ? Math.max(...rows.map(row => row.tokens), 0) : 0;
  const shown = showAll ? rows : rows.slice(0, VISIBLE);

  return <div className="rounded-lg border border-hairline bg-surface-2/30 overflow-hidden">
    <div className="px-4 py-3 flex items-center gap-2 border-b border-hairline/60"><Users size={14} className="text-ink-muted" /><span className="text-ink font-semibold text-[13px]">{tr("cost.staff.title")}</span>{roleFilter && <span className="text-ink-muted text-[11px]">{tr("cost.staff.filteredOf", { n: rows.length, total: allRows.length })}</span>}</div>
    {!allRows.length ? <div className="px-4 py-8 text-center text-ink-muted text-[13px]">{tr("cost.staff.empty")}</div> :
      !rows.length ? <div className="px-4 py-8 text-center text-ink-muted text-[13px]">{tr("cost.staff.emptyFiltered")}</div> :
      <div className="p-2">{shown.map(row => {
        const meta = agentDisplay(row.agentId, roster);
        const companyName = companyNames.get(roster.get(row.agentId)?.companyId ?? "") || tr("cost.company.unassigned");
        const pct = maximum > 0 ? Math.max(2, Math.round(row.tokens / maximum * 100)) : 0;
        const roleKey = `cost.role.${meta.role}`;
        const translatedRole = tr(roleKey);
        return <div key={row.agentId} className="flex items-center gap-3 px-2 py-2 rounded-md hover:bg-surface-2/60">
          <Avatar agentId={row.agentId} roster={roster} size={28} />
          <div className="min-w-0 w-48 shrink-0">
            <div className="flex items-center gap-1.5"><div className="text-ink text-[13px] font-medium truncate" title={meta.name}>{meta.name}</div><span className="shrink-0 rounded bg-surface-1 px-1.5 py-0.5 text-[9px] text-ink-subtle" title={companyName}>{companyName}</span></div>
            <div className="text-ink-subtle text-[11px]"><span style={{ color: meta.color }}>{translatedRole === roleKey ? meta.role : translatedRole}</span><span className="opacity-50"> · </span><span>{tr("cost.staff.calls", { n: row.calls })}</span></div>
          </div>
          <div className="flex-1 h-1.5 rounded-full bg-surface-1 overflow-hidden min-w-[40px]"><div className="h-full rounded-full opacity-65" style={{ width: `${pct}%`, background: meta.color }} /></div>
          <div className="text-ink font-semibold text-[13px] tabular-nums w-24 text-right shrink-0">{fmtTokens(row.tokens)}</div>
        </div>;
      })}
      {rows.length > VISIBLE && <button onClick={() => setShowAll(value => !value)} className="w-full mt-1 py-2 flex items-center justify-center gap-1 text-ink-subtle hover:text-ink text-[12px] cursor-pointer bg-transparent border-none">{showAll ? tr("cost.staff.collapse") : tr("cost.staff.expand", { n: rows.length })}<ChevronDown size={12} className={showAll ? "rotate-180" : ""} /></button>}
      </div>}
  </div>;
}
