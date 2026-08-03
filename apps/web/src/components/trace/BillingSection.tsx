import { Clock, Hash } from "lucide-react";
import { useT } from "../../i18n.js";
import { fmtDuration, fmtTokens } from "./traceFormat.js";

// Token usage comes directly from task.json and settles when the run finishes.
export default function BillingSection({
  totalTokens, startedAt, finishedAt,
}: {
  totalTokens?: number;
  startedAt: string | null;
  finishedAt: string | null;
}) {
  const t = useT();
  const settled = !!finishedAt;
  const durationMs = startedAt && finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : null;

  return (
    <div>
      <h3 className="text-sm font-semibold text-ink m-0 mb-3">{t("trace.billing.title")}</h3>
      {!settled ? (
        <p className="text-ink-muted text-[13px]">{t("trace.billing.pending")}</p>
      ) : (
        <div className="flex flex-wrap gap-3">
          <BillCard icon={<Hash size={13} />} label={t("trace.billing.tokens")} value={fmtTokens(totalTokens)} />
          {durationMs !== null && <BillCard icon={<Clock size={13} />} label={t("trace.billing.duration")} value={fmtDuration(durationMs)} />}
        </div>
      )}
    </div>
  );
}

function BillCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex-1 min-w-[140px] rounded-lg border border-hairline bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2 text-ink-muted text-[12px]">{icon}<span>{label}</span></div>
      <div className="mt-1 text-ink font-semibold text-[18px] tracking-tight tabular-nums">{value}</div>
    </div>
  );
}
