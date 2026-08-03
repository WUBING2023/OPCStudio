import { useState } from "react";
import SecretInput from "./SecretInput.js";
import HelpTip from "./HelpTip.js";
import type { ProviderConfig } from "@opc/shared";

interface Props {
  form: Partial<ProviderConfig>;
  onChange: (patch: Partial<ProviderConfig>) => void;
}

export default function ProviderForm({ form, onChange }: Props) {
  const [newModel, setNewModel] = useState("");
  const models = form.models || [];
  const addModel = () => {
    const m = newModel.trim();
    if (m && !models.includes(m)) { onChange({ models: [...models, m], defaultModel: form.defaultModel || m }); setNewModel(""); }
  };
  const removeModel = (m: string) => {
    const next = models.filter(x => x !== m);
    onChange({ models: next, defaultModel: form.defaultModel === m ? (next[0] || undefined) : form.defaultModel });
  };
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <label className="text-[13px] text-text-primary block mb-1">名称</label>
        <input
          className="w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent"
          value={form.name || ""}
          onChange={e => onChange({ name: e.target.value })}
          placeholder="例如: My DeepSeek" />
      </div>
      <div>
        <label className="text-[13px] text-text-primary block mb-1">备注</label>
        <input
          className="w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent"
          value={form.note || ""}
          onChange={e => onChange({ note: e.target.value })}
          placeholder="可选备注" />
      </div>
      <div>
        <label className="text-[13px] text-text-primary block mb-1">官网</label>
        <input
          className="w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent"
          value={form.website || ""}
          onChange={e => onChange({ website: e.target.value })}
          placeholder="https://example.com" />
      </div>
      <SecretInput
        label="API Key"
        value={form.apiKey || ""}
        onChange={v => onChange({ apiKey: v })}
        placeholder="sk-..."
      />
      <div>
        <label className="text-[13px] text-text-primary block mb-1">Base URL</label>
        <input
          className="w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent"
          value={form.baseUrl || ""}
          onChange={e => onChange({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1" />
      </div>
      {/* 模型(cc-switch 风格):自由添加这个 API 可调用的几个模型;点模型设为默认(高亮),× 移除 */}
      <div>
        <label className="text-[13px] text-text-primary mb-1 flex items-center gap-1">模型 <HelpTip text="自由添加几个可调用的;点选设默认,第一个默认为默认" /></label>
        <div className="flex flex-wrap gap-1.5 mb-2">
          {models.map(m => (
            <span key={m} className={`inline-flex items-center gap-1.5 pl-2.5 pr-1.5 py-1 rounded-full text-[12px] border ${form.defaultModel === m ? "border-accent bg-accent/10 text-accent" : "border-border-light bg-bg-hover text-text-secondary"}`}>
              <button type="button" onClick={() => onChange({ defaultModel: m })} title="设为默认" className="bg-transparent border-none cursor-pointer p-0 text-inherit font-medium">{m}{form.defaultModel === m ? " ★" : ""}</button>
              <button type="button" onClick={() => removeModel(m)} title="移除" className="bg-transparent border-none cursor-pointer p-0 text-text-muted hover:text-red leading-none text-[14px]">×</button>
            </span>
          ))}
          {models.length === 0 && <span className="text-[11px] text-text-muted">还没添加模型(可留空走内置列表)</span>}
        </div>
        <div className="flex gap-2">
          <input value={newModel} onChange={e => setNewModel(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addModel(); } }}
            placeholder="如 deepseek-chat / gpt-5.1 …,回车添加"
            className="flex-1 border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent" />
          <button type="button" onClick={addModel} disabled={!newModel.trim()}
            className="btn-primary px-3.5">添加</button>
        </div>
      </div>
    </div>
  );
}
