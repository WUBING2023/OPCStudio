import CollapsibleSection from "./CollapsibleSection.js";
import type { ProviderConfig } from "@opc/shared";

interface Props {
  pricing: ProviderConfig["pricing"];
  onChange: (p: ProviderConfig["pricing"]) => void;
}

const FIELDS: { key: keyof NonNullable<ProviderConfig["pricing"]>; label: string }[] = [
  { key: "inputPer1MTokens", label: "输入 ($/1M tokens)" },
  { key: "outputPer1MTokens", label: "输出 ($/1M tokens)" },
  { key: "cacheReadPer1MTokens", label: "缓存读取 ($/1M tokens)" },
  { key: "cacheWritePer1MTokens", label: "缓存写入 ($/1M tokens)" },
];

const inputClass = "w-full border border-border-light rounded-md px-2.5 py-2 text-[13px] outline-none box-border focus:border-accent focus:ring-1 focus:ring-accent";

export default function ProviderPricingConfig({ pricing, onChange }: Props) {
  const p = pricing || { currency: "USD" as const };

  return (
    <CollapsibleSection title="定价配置" subtitle="用于成本估算（可选）">
      <div className="flex flex-col gap-3">
        <div>
          <label className="text-[13px] text-text-primary block mb-1">货币</label>
          <select className={`${inputClass} bg-bg-card cursor-pointer`}
            value={p.currency} onChange={e => onChange({ ...p, currency: e.target.value as "USD" | "CNY" })}>
            <option value="USD">USD</option>
            <option value="CNY">CNY</option>
          </select>
        </div>
        {FIELDS.map(({ key, label }) => (
          <div key={key}>
            <label className="text-[13px] text-text-primary block mb-1">{label}</label>
            <input className={inputClass} type="number" step="0.01" min="0"
              value={p[key] ?? ""}
              onChange={e => onChange({ ...p, [key]: e.target.value ? parseFloat(e.target.value) : undefined })} />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}
