import { Building2, Download, Plug, X } from "lucide-react";
import type { UserIdentity } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { markOnboardingDone } from "../../components/onboarding/onboardingState.js";

export type FirstRunDestination = "community" | "workshop" | "subscription";

export default function FirstRunEntry({ onDone }: { onDone: (destination?: FirstRunDestination) => void }) {
  const tr = useT();
  const finish = (destination?: FirstRunDestination, tutorial = true) => {
    const identity: UserIdentity = "other";
    api.post("/config", { onboarding: { completed: true, identity, tutorial, completedAt: new Date().toISOString() } }).catch(() => undefined);
    markOnboardingDone();
    onDone(destination);
  };
  const actions = [
    { id: "official", Icon: Download, title: tr("firstEntry.official"), desc: tr("firstEntry.official.desc"), destination: "community" as const },
    { id: "create", Icon: Building2, title: tr("firstEntry.create"), desc: tr("firstEntry.create.desc"), destination: "workshop" as const },
    { id: "connect", Icon: Plug, title: tr("firstEntry.connect"), desc: tr("firstEntry.connect.desc"), destination: "subscription" as const },
  ];
  return (
    <div className="fixed inset-0 z-[2000] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-[640px] max-w-full rounded-xl border border-hairline bg-surface-1 shadow-2xl p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="m-0 text-[20px] font-semibold text-ink">{tr("firstEntry.title")}</h1>
            <p className="m-0 mt-1 text-[13px] leading-relaxed text-ink-muted">{tr("firstEntry.subtitle")}</p>
          </div>
          <button onClick={() => finish(undefined, false)} title={tr("ob.skip")}
            className="w-8 h-8 flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink cursor-pointer">
            <X size={15} />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-3 mt-5 max-[720px]:grid-cols-1">
          {actions.map(({ id, Icon, title, desc, destination }) => (
            <button key={id} onClick={() => finish(destination)}
              className="min-h-[132px] p-4 rounded-lg border border-hairline bg-surface-0 hover:border-accent/60 hover:bg-surface-2 text-left cursor-pointer transition-colors">
              <Icon size={20} className="text-accent" />
              <div className="mt-3 text-[14px] font-semibold text-ink">{title}</div>
              <div className="mt-1 text-[12px] leading-relaxed text-ink-muted">{desc}</div>
            </button>
          ))}
        </div>
        <div className="mt-4 pt-3 border-t border-hairline text-[11px] text-ink-subtle">
          {tr("firstEntry.path")}
        </div>
      </div>
    </div>
  );
}
