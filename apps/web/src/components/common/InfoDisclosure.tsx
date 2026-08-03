import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { useT } from "../../i18n.js";

// 信息密度瘦身标准件之二:行内「说明 ▸」折叠。默认只占一行的淡色小字入口,点开才展开
// 完整说明段落。用于删不掉但不必常驻的长说明(短提示用 HelpTip 问号)。
export default function InfoDisclosure({
  label,
  children,
  className = "",
}: {
  label?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const tr = useT();
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-0.5 bg-transparent border-none p-0 cursor-pointer text-[12px] text-ink-subtle hover:text-ink-muted transition-colors"
      >
        <ChevronRight size={12} className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`} />
        <span>{label ?? tr("common.explain")}</span>
      </button>
      {open && (
        <div className="mt-1.5 text-[12px] text-ink-muted leading-relaxed">
          {children}
        </div>
      )}
    </div>
  );
}
