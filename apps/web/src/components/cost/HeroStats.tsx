import { Building2, TrendingUp, UserRound } from "lucide-react";
import type { Company } from "@opc/shared";
import { useT } from "../../i18n.js";
import { Avatar } from "./Avatar.js";
import { fmtTokens } from "./format.js";
import type { CostSummary, Roster } from "./types.js";

function HeroCard({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return <div className="flex-1 min-w-[220px] rounded-lg border border-hairline/60 bg-surface-1 p-5">
    <div className="flex items-center gap-1.5 text-ink-subtle text-[11px] uppercase tracking-wide font-medium">{icon}<span>{label}</span></div>
    <div className="mt-3">{children}</div>
  </div>;
}

export default function HeroStats({ summary, roster, companies }: { summary: CostSummary; roster: Roster; companies: Company[] }) {
  const tr = useT();
  const topAgent = summary.byAgent[0];
  const topCompany = summary.byCompany?.[0];
  const companyNames = new Map(companies.map(company => [company.id, company.name]));
  const topAgentMeta = topAgent ? roster.get(topAgent.agentId) : undefined;

  return <div className="flex flex-wrap gap-4">
    <HeroCard icon={<TrendingUp size={13} />} label={tr("cost.hero.total.label")}>
      {summary.runCount > 0 ? <>
        <div className="text-ink font-bold text-[28px] tabular-nums leading-none">{fmtTokens(summary.totalTokens)}</div>
        <div className="text-ink-muted text-[11px] mt-1.5">{tr("cost.hero.total.sub", { n: summary.runCount })}</div>
      </> : <div className="text-ink-subtle text-[11px]">{tr("cost.hero.empty.total")}</div>}
    </HeroCard>
    <HeroCard icon={<UserRound size={13} />} label={tr("cost.hero.topAgent.label")}>
      {topAgent ? <div className="flex items-center gap-3">
        <Avatar agentId={topAgent.agentId} roster={roster} size={36} />
        <div className="min-w-0">
          <div className="text-ink font-semibold text-[14px] truncate">{topAgentMeta?.name || topAgent.agentId}</div>
          <div className="text-ink-subtle text-[10px] truncate">{companyNames.get(topAgentMeta?.companyId ?? "") || tr("cost.company.unassigned")}</div>
          <div className="text-ink font-bold text-[20px] tabular-nums">{fmtTokens(topAgent.tokens)}</div>
        </div>
      </div> : <div className="text-ink-subtle text-[11px]">{tr("cost.hero.empty.topAgent")}</div>}
    </HeroCard>
    <HeroCard icon={<Building2 size={13} />} label={tr("cost.hero.topCompany.label")}>
      {topCompany ? <>
        <div className="text-ink font-semibold text-[14px] truncate">{companyNames.get(topCompany.companyId) || tr("cost.company.unassigned")}</div>
        <div className="text-ink font-bold text-[24px] tabular-nums leading-tight mt-1">{fmtTokens(topCompany.tokens)}</div>
        <div className="text-ink-muted text-[11px] mt-1">{tr("cost.hero.topCompany.sub", { n: topCompany.runs })}</div>
      </> : <div className="text-ink-subtle text-[11px]">{tr("cost.hero.empty.topCompany")}</div>}
    </HeroCard>
  </div>;
}
