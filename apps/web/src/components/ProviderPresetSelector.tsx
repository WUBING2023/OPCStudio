import { PRESET_PROVIDERS, type ApiFormat } from "@opc/shared";

interface Props {
  selectedId: string | null;
  onSelect: (preset: typeof PRESET_PROVIDERS[number]) => void;
}

export default function ProviderPresetSelector({ selectedId, onSelect }: Props) {
  return (
    <div className="flex flex-wrap gap-2">
      {PRESET_PROVIDERS.map(p => {
        const selected = p.id === selectedId;
        return (
          <button
            key={p.id}
            onClick={() => onSelect(p)}
            className={`relative h-8 px-3.5 rounded-full inline-flex items-center gap-1 text-xs cursor-pointer transition-all ${
              selected
                ? "border-2 border-accent bg-accent/10 text-accent font-semibold"
                : "border border-border-light bg-bg-hover text-text-primary hover:bg-border"
            }`}>
            {p.name}
          </button>
        );
      })}
    </div>
  );
}
