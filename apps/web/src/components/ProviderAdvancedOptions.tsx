import { useState } from "react";
import CollapsibleSection from "./CollapsibleSection.js";
import type { ProviderConfig, ApiFormat } from "@opc/shared";

interface Props {
  form: Partial<ProviderConfig>;
  onChange: (patch: Partial<ProviderConfig>) => void;
}

const API_FORMATS: ApiFormat[] = ["openai", "anthropic", "gemini", "ollama", "custom"];

const CHECKBOX_ITEMS: { key: keyof ProviderConfig["options"]; label: string }[] = [
  { key: "hideAISignature", label: "隐藏 AI 签名" },
  { key: "enableTeammatesMode", label: "启用 Teammates 模式" },
  { key: "enableToolSearch", label: "启用工具搜索" },
  { key: "enableMaxThinking", label: "启用最大思考" },
  { key: "disableAutoUpgrade", label: "禁用自动升级" },
  { key: "allowPromptCaching", label: "允许 Prompt 缓存" },
  { key: "allowStreaming", label: "允许流式传输" },
];

export default function ProviderAdvancedOptions({ form, onChange }: Props) {
  const opts = form.options || ({} as ProviderConfig["options"]);

  const inputClass = "w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent";

  return (
    <CollapsibleSection title="高级选项">
      <div className="flex flex-col gap-3.5">
        <div>
          <label className="text-[13px] text-text-primary block mb-1">API 格式</label>
          <select className={`${inputClass} bg-bg-card cursor-pointer`}
            value={form.apiFormat || "openai"}
            onChange={e => onChange({ apiFormat: e.target.value as ApiFormat })}>
            {API_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className="text-[13px] text-text-primary block mb-1">默认模型</label>
          <input className={inputClass} value={form.defaultModel || ""}
            onChange={e => onChange({ defaultModel: e.target.value })}
            placeholder="例如: gpt-5.1" />
        </div>        <label className="flex items-center gap-2 text-[13px] text-text-primary cursor-pointer">
          <input type="checkbox" checked={form.allowLocalNetwork === true}
            onChange={e => onChange({ allowLocalNetwork: e.target.checked })} />
          Allow local network access
        </label>
        <div>
          <label className="text-[13px] text-text-primary block mb-1">模型列表（每行一个）</label>
          <textarea
            className={`${inputClass} resize-y font-mono text-xs min-h-[80px]`}
            value={(form.models || []).join("\n")}
            onChange={e => onChange({ models: e.target.value.split("\n").filter(Boolean) })}
            placeholder={"model-a\nmodel-b\nmodel-c"}
            rows={4} />
        </div>

        <div className="border-t border-border pt-3.5">
          <div className="text-[13px] font-semibold text-text-primary mb-2.5">选项开关</div>
          {CHECKBOX_ITEMS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 mb-1.5 text-[13px] cursor-pointer">
              <input type="checkbox" checked={opts[key] ?? false}
                onChange={e => onChange({ options: { ...opts, [key]: e.target.checked } } as any)} />
              {label}
            </label>
          ))}
        </div>

        <div className="border-t border-border pt-3.5">
          <div className="text-[13px] font-semibold text-text-primary mb-1">权限 Allowlist / Denylist</div>
          <div className="flex gap-2.5">
            <div className="flex-1">
              <label className="text-[13px] text-text-primary block mb-1">允许</label>
              <textarea
                className={`${inputClass} resize-y font-mono text-xs min-h-[60px]`}
                value={(form.permissions?.allow || []).join("\n")}
                onChange={e => onChange({ permissions: { ...(form.permissions || { allow: [], deny: [] }), allow: e.target.value.split("\n").filter(Boolean) } })}
                rows={3} />
            </div>
            <div className="flex-1">
              <label className="text-[13px] text-text-primary block mb-1">拒绝</label>
              <textarea
                className={`${inputClass} resize-y font-mono text-xs min-h-[60px]`}
                value={(form.permissions?.deny || []).join("\n")}
                onChange={e => onChange({ permissions: { ...(form.permissions || { allow: [], deny: [] }), deny: e.target.value.split("\n").filter(Boolean) } })}
                rows={3} />
            </div>
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
}
