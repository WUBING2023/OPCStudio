import { HelpCircle } from "lucide-react";
import { useState } from "react";
import { useT } from "../i18n.js";

// 小问号:悬停或点击弹出说明,替代占地方的整段说明文字(信息密度瘦身的标准件之一,
// 长说明用 InfoDisclosure)。
export default function HelpTip({ text, className = "" }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const tr = useT();
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o); }}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-ink-subtle hover:text-ink cursor-help bg-transparent border-none p-0"
        aria-label={tr("common.explain")}
        aria-expanded={open}
      >
        <HelpCircle size={13} />
      </button>
      {open && (
        <span className="absolute z-[1300] left-0 top-full mt-1.5 w-64 max-w-[260px] px-3 py-2.5 rounded-xl bg-surface-1 border border-hairline shadow-lg text-[12px] text-ink-muted leading-relaxed whitespace-normal text-left font-normal">
          {text}
        </span>
      )}
    </span>
  );
}
