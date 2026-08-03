import { useState, useRef, useEffect, type MouseEvent } from "react";
import { Copy, Check } from "lucide-react";
import { useT } from "../../i18n.js";

// 消息气泡右下角的复制按钮:hover 才显现(依赖父级 group),点击复制原文,给 1.5s「已复制」反馈。
// 复制期间强制保持可见,反馈结束后回到 hover 显现。颜色/定位由调用方经 className 传入(紫气泡用浅色,
// 灰气泡用 ink 色)。
export default function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  const tr = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    navigator.clipboard?.writeText(text).catch(() => { /* 无剪贴板权限时静默,仍给视觉反馈 */ });
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const label = copied ? tr("chat.copied") : tr("chat.copy");
  return (
    <button
      type="button"
      onClick={copy}
      title={label}
      aria-label={label}
      className={`inline-flex items-center justify-center w-6 h-6 rounded-md border-none cursor-pointer transition-opacity duration-150 ${
        copied ? "opacity-100" : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto"
      } ${className}`}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}
