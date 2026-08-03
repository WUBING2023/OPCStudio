import { SlidersHorizontal } from "lucide-react";
import type { Company } from "@opc/shared";
import { useT } from "../../i18n.js";

export type TimeRange = "all" | "7d" | "30d" | "custom";

const CONTROL = "h-8 min-w-0 rounded-md border border-hairline bg-surface-1 px-2 text-[12px] text-ink outline-none focus:border-accent";

export default function DimensionBar({
  timeRange, onTimeRange, customStart, customEnd, onCustomStart, onCustomEnd,
  companies, companyId, onCompanyId, roles, roleFilter, onRoleFilter, roleLabel,
}: {
  timeRange: TimeRange; onTimeRange: (value: TimeRange) => void;
  customStart: string; customEnd: string; onCustomStart: (value: string) => void; onCustomEnd: (value: string) => void;
  companies: Company[]; companyId: string | null; onCompanyId: (id: string | null) => void;
  roles: string[]; roleFilter: string | null; onRoleFilter: (role: string | null) => void;
  roleLabel: (role: string) => string;
}) {
  const tr = useT();
  return (
    <div data-testid="cost-filter-bar" className="rounded-lg border border-hairline bg-surface-2/40 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-ink-subtle text-[11px] font-medium mb-2">
        <SlidersHorizontal size={12} /> {tr("cost.filter.title")}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <label className="min-w-0 flex flex-col gap-1">
          <span className="text-[10px] text-ink-subtle">{tr("cost.filter.company.label")}</span>
          <select data-testid="cost-filter-company" aria-label={tr("cost.filter.company.label")} value={companyId ?? ""} onChange={event => onCompanyId(event.currentTarget.value || null)} className={CONTROL}>
            <option value="">{tr("cost.filter.all")}</option>
            {companies.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}
          </select>
        </label>
        <label className="min-w-0 flex flex-col gap-1">
          <span className="text-[10px] text-ink-subtle">{tr("cost.filter.time.label")}</span>
          <select data-testid="cost-filter-time" aria-label={tr("cost.filter.time.label")} value={timeRange} onChange={event => onTimeRange(event.currentTarget.value as TimeRange)} className={CONTROL}>
            <option value="all">{tr("memory.filter.time.all")}</option>
            <option value="7d">{tr("memory.filter.time.7d")}</option>
            <option value="30d">{tr("memory.filter.time.30d")}</option>
            <option value="custom">{tr("memory.filter.time.custom")}</option>
          </select>
        </label>
        <label className="min-w-0 flex flex-col gap-1">
          <span className="text-[10px] text-ink-subtle">{tr("cost.filter.role.label")}</span>
          <select data-testid="cost-filter-role" aria-label={tr("cost.filter.role.label")} value={roleFilter ?? ""} onChange={event => onRoleFilter(event.currentTarget.value || null)} className={CONTROL}>
            <option value="">{tr("memory.filter.role.all")}</option>
            {roles.map(role => <option key={role} value={role}>{roleLabel(role)}</option>)}
          </select>
        </label>
      </div>
      {timeRange === "custom" && (
        <div data-testid="cost-filter-custom-range" className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
          <label className="min-w-0 flex items-center gap-2 text-[11px] text-ink-muted">
            <span className="w-10 shrink-0">{tr("memory.filter.time.from")}</span>
            <input type="date" value={customStart} max={customEnd || undefined} onChange={event => onCustomStart(event.currentTarget.value)} aria-label={tr("memory.filter.time.from")} className={CONTROL + " w-full"} />
          </label>
          <label className="min-w-0 flex items-center gap-2 text-[11px] text-ink-muted">
            <span className="w-10 shrink-0">{tr("memory.filter.time.to")}</span>
            <input type="date" value={customEnd} min={customStart || undefined} onChange={event => onCustomEnd(event.currentTarget.value)} aria-label={tr("memory.filter.time.to")} className={CONTROL + " w-full"} />
          </label>
        </div>
      )}
    </div>
  );
}
