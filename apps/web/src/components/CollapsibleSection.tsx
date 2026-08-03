import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useT } from "../i18n.js";

interface Props {
  title: string;
  subtitle?: string;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

export default function CollapsibleSection({ title, subtitle, defaultExpanded = false, children }: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tr = useT();

  return (
    <div className="border border-hairline rounded-xl overflow-hidden mb-4">
      <button
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={expanded ? tr("common.collapse") : tr("common.expand")}
        className="w-full flex items-center justify-between px-4 py-3 bg-surface-0 border-none cursor-pointer text-[13px] font-semibold text-ink hover:bg-surface-2 transition-colors">
        <div>
          <span>{title}</span>
          {subtitle && <span className="ml-2 text-[12px] text-ink-subtle font-normal">{subtitle}</span>}
        </div>
        <ChevronDown size={15} className={`text-ink-subtle transition-transform duration-150 ${expanded ? "rotate-180" : ""}`} />
      </button>
      {expanded && <div className="p-4">{children}</div>}
    </div>
  );
}
