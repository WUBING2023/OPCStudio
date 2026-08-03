import { useRef, useLayoutEffect, forwardRef, type TextareaHTMLAttributes } from "react";
import { computeAutoGrowHeight } from "../../lib/autoGrowTextarea.js";

// 统一的自适应输入框:随内容自动增高,达到 maxRows 行(默认 6)后封顶并内部滚动。工作台对话框与
// 架构/任务对话框共用同一份逻辑(rows=1 起步,受控 value 驱动重算)。高度计算是纯函数
// (lib/autoGrowTextarea),这里只负责读取真实几何量并写回 style。
interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  maxRows?: number;
}

const AutoGrowTextarea = forwardRef<HTMLTextAreaElement, Props>(function AutoGrowTextarea(
  { maxRows = 6, value, rows = 1, className, ...rest }, forwardedRef,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const setRefs = (el: HTMLTextAreaElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === "function") forwardedRef(el);
    else if (forwardedRef) (forwardedRef as { current: HTMLTextAreaElement | null }).current = el;
  };

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    el.style.height = "auto"; // 先塌回内容高度,scrollHeight 才反映真实所需高度
    const cs = window.getComputedStyle(el);
    const num = (v: string) => parseFloat(v) || 0;
    const lineHeight = num(cs.lineHeight) || num(cs.fontSize) * 1.4;
    const { height, overflowY } = computeAutoGrowHeight({
      scrollHeight: el.scrollHeight,
      lineHeight,
      paddingTop: num(cs.paddingTop),
      paddingBottom: num(cs.paddingBottom),
      borderTop: num(cs.borderTopWidth),
      borderBottom: num(cs.borderBottomWidth),
      boxSizing: cs.boxSizing,
      maxRows,
    });
    el.style.height = `${height}px`;
    el.style.overflowY = overflowY;
  }, [value, maxRows]);

  return <textarea ref={setRefs} value={value} rows={rows} className={className} {...rest} />;
});

export default AutoGrowTextarea;
