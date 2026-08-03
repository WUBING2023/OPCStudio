import { Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import { genKey, type WorkshopCard, type WorkshopA2AChannel } from "./workshopTypes.js";

// A2A 预置通道区:两张角色卡之间常驻的协作通道,install 后由 orchestrator 在每次 run 开场自动 grant
// (见 orchestrator.ts startRun),worker 不需要再对这些常驻同事 request_channel 走审批。
export default function WorkshopA2AEditor({
  channels, cards, onChange, errors, showErrors,
}: {
  channels: WorkshopA2AChannel[];
  cards: WorkshopCard[];
  onChange: (channels: WorkshopA2AChannel[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const tr = useT();
  const update = (key: string, patch: Partial<WorkshopA2AChannel>) =>
    onChange(channels.map(c => (c.key === key ? { ...c, ...patch } : c)));
  const remove = (key: string) => onChange(channels.filter(c => c.key !== key));
  const cardLabel = (key: string) => {
    const c = cards.find(x => x.key === key);
    return c ? `${c.name || tr("tw.unnamed")}${c.role ? ` (${c.role})` : ""}` : "";
  };

  if (cards.length < 2) {
    return <div className="text-[13px] text-text-muted">{tr("tw.a2aNeedCards")}</div>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex justify-end">
        <HelpTip text={tr("tw.a2aHint")} />
      </div>
      {channels.length === 0 && <div className="text-[13px] text-text-muted">{tr("tw.a2aEmpty")}</div>}
      {channels.map(c => {
        const err = (field: string) => showErrors ? errors[`a2a:${c.key}:${field}`] : undefined;
        return (
          <div key={c.key} className="border border-border rounded-lg p-2.5 bg-bg-hover grid grid-cols-[1fr_1fr_1.4fr_auto] gap-2 items-start">
            <div>
              <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.a2aFrom")}</label>
              <select value={c.from} onChange={e => update(c.key, { from: e.target.value })}
                className={`w-full border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card ${err("from") ? "border-red" : "border-border"}`}>
                <option value="">{tr("tw.pickCard")}</option>
                {cards.map(x => <option key={x.key} value={x.key}>{cardLabel(x.key)}</option>)}
              </select>
              {err("from") && <div className="text-[10px] text-red mt-0.5">{err("from")}</div>}
            </div>
            <div>
              <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.a2aTo")}</label>
              <select value={c.to} onChange={e => update(c.key, { to: e.target.value })}
                className={`w-full border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card ${err("to") ? "border-red" : "border-border"}`}>
                <option value="">{tr("tw.pickCard")}</option>
                {cards.map(x => <option key={x.key} value={x.key}>{cardLabel(x.key)}</option>)}
              </select>
              {err("to") && <div className="text-[10px] text-red mt-0.5">{err("to")}</div>}
            </div>
            <div>
              <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.a2aPurpose")}</label>
              <input value={c.purpose} onChange={e => update(c.key, { purpose: e.target.value })}
                placeholder={tr("tw.a2aPurposePh")}
                className="w-full border border-border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card focus:border-accent" />
            </div>
            <button onClick={() => remove(c.key)} title={tr("tw.removeEdge")}
              className="mt-4 border-none bg-transparent cursor-pointer text-text-muted hover:text-red transition-colors p-0.5">
              <Trash2 size={14} />
            </button>
            {/* direction / authPolicy / enabled — 折叠在 purpose 下方一行 */}
            <div className="col-span-4 flex items-center gap-3 text-[11px] text-text-secondary">
              <label className="flex items-center gap-1">
                <span>{tr("tw.a2aDirection")}</span>
                <select value={c.direction ?? "oneway"} onChange={e => update(c.key, { direction: e.target.value as "oneway" | "bidirectional" })}
                  className="border border-border rounded-md px-1 py-0.5 text-[11px] outline-none bg-bg-card">
                  <option value="oneway">{tr("tw.a2aDirOneway")}</option>
                  <option value="bidirectional">{tr("tw.a2aDirBidir")}</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <span>{tr("tw.a2aAuth")}</span>
                <select value={c.authPolicy ?? "trusted"} onChange={e => update(c.key, { authPolicy: e.target.value as "trusted" | "gated" | "manual" })}
                  className="border border-border rounded-md px-1 py-0.5 text-[11px] outline-none bg-bg-card">
                  <option value="trusted">{tr("tw.a2aAuthTrusted")}</option>
                  <option value="gated">{tr("tw.a2aAuthGated")}</option>
                  <option value="manual">{tr("tw.a2aAuthManual")}</option>
                </select>
              </label>
              <label className="flex items-center gap-1">
                <input type="checkbox" checked={c.enabled !== false} onChange={e => update(c.key, { enabled: e.target.checked })} />
                <span>{tr("tw.a2aEnabled")}</span>
              </label>
            </div>
          </div>
        );
      })}
      <button onClick={() => onChange([...channels, { key: genKey(), from: "", to: "", purpose: "" }])}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border text-[13px] text-text-secondary bg-transparent cursor-pointer hover:border-accent hover:text-accent transition-colors">
        <Plus size={14} /> {tr("tw.a2aAdd")}
      </button>
    </div>
  );
}
