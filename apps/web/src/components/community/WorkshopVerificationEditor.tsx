import { AlertTriangle, Plus, Trash2 } from "lucide-react";
import type { VerificationMethod } from "@opc/shared";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import { genKey, type WorkshopCard, type WorkshopEdge } from "./workshopTypes.js";

const METHODS: VerificationMethod[] = ["llm-review", "code-review", "fact-check"];

function makeEdge(): WorkshopEdge {
  return { key: genKey(), producer: "", verifier: "", method: "llm-review", onReject: "redo", maxRounds: undefined };
}

export default function WorkshopVerificationEditor({
  edges, cards, onChange, errors, showErrors,
}: {
  edges: WorkshopEdge[];
  cards: WorkshopCard[];
  onChange: (edges: WorkshopEdge[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const tr = useT();
  const update = (key: string, patch: Partial<WorkshopEdge>) =>
    onChange(edges.map(e => (e.key === key ? { ...e, ...patch } : e)));
  const remove = (key: string) => onChange(edges.filter(e => e.key !== key));
  const cardLabel = (key: string) => {
    const c = cards.find(x => x.key === key);
    return c ? `${c.name || tr("tw.unnamed")}${c.role ? ` (${c.role})` : ""}` : "";
  };
  // P2(引擎/模型异质性可见性 · 审计发现②):producer/verifier 若配了同一个 provider+model,交叉验证的
  // 独立信号很弱。producer 为通配 "*"(任意)或任一方 provider/model 留空("使用者自配",此处无从判断)时
  // 不判定,避免误报;不阻塞保存,只是提示——与后端 same_model_review 领域事件同一设计哲学。
  const sameModelWarning = (e: WorkshopEdge): boolean => {
    if (e.producer === "*" || !e.producer || !e.verifier) return false;
    const p = cards.find(c => c.key === e.producer);
    const v = cards.find(c => c.key === e.verifier);
    if (!p || !v) return false;
    const pProvider = p.provider.trim(), pModel = p.model.trim();
    const vProvider = v.provider.trim(), vModel = v.model.trim();
    if (!pProvider || !pModel || !vProvider || !vModel) return false;
    return pProvider === vProvider && pModel === vModel;
  };

  if (cards.length === 0) {
    return <div className="text-[13px] text-text-muted">{tr("tw.verifyNeedCards")}</div>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex justify-end">
        <HelpTip text={tr("tw.verifyHint")} />
      </div>
      {edges.length === 0 && <div className="text-[13px] text-text-muted">{tr("tw.verifyEmpty")}</div>}
      {edges.map(e => {
        const err = (field: string) => showErrors ? errors[`edge:${e.key}:${field}`] : undefined;
        const sameModel = sameModelWarning(e);
        return (
          <div key={e.key} className="border border-border rounded-lg p-2.5 bg-bg-hover flex flex-col gap-1.5">
            <div className="grid grid-cols-[1fr_1fr_1fr_auto_auto_auto] gap-2 items-start">
              <div>
                <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.producer")}</label>
                <select value={e.producer} onChange={ev => update(e.key, { producer: ev.target.value })}
                  className={`w-full border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card ${err("producer") ? "border-red" : "border-border"}`}>
                  <option value="">{tr("tw.pickCard")}</option>
                  <option value="*">{tr("tw.anyProducer")}</option>
                  {cards.map(c => <option key={c.key} value={c.key}>{cardLabel(c.key)}</option>)}
                </select>
                {err("producer") && <div className="text-[10px] text-red mt-0.5">{err("producer")}</div>}
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.verifier")}</label>
                <select value={e.verifier} onChange={ev => update(e.key, { verifier: ev.target.value })}
                  className={`w-full border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card ${err("verifier") ? "border-red" : "border-border"}`}>
                  <option value="">{tr("tw.pickCard")}</option>
                  {cards.map(c => <option key={c.key} value={c.key}>{cardLabel(c.key)}</option>)}
                </select>
                {err("verifier") && <div className="text-[10px] text-red mt-0.5">{err("verifier")}</div>}
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.method")}</label>
                <select value={e.method} onChange={ev => update(e.key, { method: ev.target.value as VerificationMethod })}
                  className="w-full border border-border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card">
                  {METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.onReject")}</label>
                <select value={e.onReject} onChange={ev => update(e.key, { onReject: ev.target.value as "redo" | "flag" })}
                  className="w-full border border-border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card">
                  <option value="redo">redo</option>
                  <option value="flag">flag</option>
                </select>
              </div>
              <div>
                <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.maxRounds")}</label>
                <input type="number" min={1} value={e.maxRounds ?? ""} placeholder="1"
                  onChange={ev => update(e.key, { maxRounds: ev.target.value ? Number(ev.target.value) : undefined })}
                  className="w-full border border-border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card" />
              </div>
              <button onClick={() => remove(e.key)} title={tr("tw.removeEdge")}
                className="mt-4 border-none bg-transparent cursor-pointer text-text-muted hover:text-red transition-colors p-0.5">
                <Trash2 size={14} />
              </button>
            </div>
            {sameModel && (
              <div className="flex items-center gap-1.5 text-[11px] text-amber">
                <AlertTriangle size={12} className="shrink-0" />
                {tr("tw.sameModelWarning")}
              </div>
            )}
          </div>
        );
      })}
      <button onClick={() => onChange([...edges, makeEdge()])}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-dashed border-border text-[13px] text-text-secondary bg-transparent cursor-pointer hover:border-accent hover:text-accent transition-colors">
        <Plus size={14} /> {tr("tw.addEdge")}
      </button>
    </div>
  );
}
