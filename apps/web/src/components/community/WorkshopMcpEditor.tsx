import { Plus, Trash2 } from "lucide-react";
import { useT } from "../../i18n.js";
import HelpTip from "../HelpTip.js";
import { genKey, type WorkshopMcpReq } from "./workshopTypes.js";

// MCP 需求声明区:MCP 是本机服务,模板只声明"需要哪个/干什么用/是否可选",不打包。
// install 时对照本机已配 MCP 报 missing 清单,由前端弹层引导用户去 MCP 页配置。
export default function WorkshopMcpEditor({
  requirements, onChange, errors, showErrors,
}: {
  requirements: WorkshopMcpReq[];
  onChange: (reqs: WorkshopMcpReq[]) => void;
  errors: Record<string, string>;
  showErrors: boolean;
}) {
  const tr = useT();
  const update = (key: string, patch: Partial<WorkshopMcpReq>) =>
    onChange(requirements.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const remove = (key: string) => onChange(requirements.filter(r => r.key !== key));
  const add = () => onChange([...requirements, { key: genKey(), name: "", purpose: "", optional: false }]);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex justify-end">
        <HelpTip text={tr("tw.mcpHint")} />
      </div>
      {requirements.length === 0 && <div className="text-[13px] text-text-muted">{tr("tw.mcpEmpty")}</div>}
      {requirements.map(r => {
        const err = (field: string) => showErrors ? errors[`mcp:${r.key}:${field}`] : undefined;
        return (
          <div key={r.key} className="border border-border rounded-lg p-2.5 bg-bg-hover grid grid-cols-[1fr_1.6fr_auto_auto] gap-2 items-start">
            <div>
              <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.mcpName")}</label>
              <input value={r.name} onChange={e => update(r.key, { name: e.target.value })}
                placeholder={tr("tw.mcpNamePh")}
                className={`w-full border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card ${err("name") ? "border-red" : "border-border focus:border-accent"}`} />
              {err("name") && <div className="text-[10px] text-red mt-0.5">{err("name")}</div>}
            </div>
            <div>
              <label className="text-[11px] text-text-secondary block mb-0.5">{tr("tw.mcpPurpose")}</label>
              <input value={r.purpose} onChange={e => update(r.key, { purpose: e.target.value })}
                placeholder={tr("tw.mcpPurposePh")}
                className="w-full border border-border rounded-md px-1.5 py-1 text-[13px] outline-none bg-bg-card focus:border-accent" />
            </div>
            <div className="pt-4">
              <label className="inline-flex items-center gap-1.5 text-[12px] text-text-secondary cursor-pointer">
                <input type="checkbox" checked={r.optional} onChange={e => update(r.key, { optional: e.target.checked })} />
                {tr("tw.mcpOptional")}
              </label>
            </div>
            <button onClick={() => remove(r.key)} title={tr("tw.removeEdge")}
              className="mt-4 border-none bg-transparent cursor-pointer text-text-muted hover:text-red transition-colors p-0.5">
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      <button onClick={add}
        className="self-start inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-dashed border-border text-[13px] text-text-secondary bg-transparent cursor-pointer hover:border-accent hover:text-accent transition-colors">
        <Plus size={14} /> {tr("tw.mcpAdd")}
      </button>
    </div>
  );
}
