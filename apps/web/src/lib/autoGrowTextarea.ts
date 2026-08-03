export interface AutoGrowMetrics {
  scrollHeight: number;
  lineHeight: number;
  paddingTop: number;
  paddingBottom: number;
  borderTop: number;
  borderBottom: number;
  boxSizing: string;
  maxRows: number;
}

export interface AutoGrowResult {
  height: number;
  overflowY: "auto" | "hidden";
}

// 自适应 textarea 高度:随内容增高,达到 maxRows 行封顶后内部滚动。纯函数(不碰 DOM),供
// AutoGrowTextarea 用真实几何量调用,并可单测。border-box / content-box 两种盒模型都算对:
// scrollHeight 始终是 content+padding;border-box 的 CSS height 含 border,content-box 只含 content。
export function computeAutoGrowHeight(m: AutoGrowMetrics): AutoGrowResult {
  const padY = m.paddingTop + m.paddingBottom;
  const borderY = m.borderTop + m.borderBottom;
  const borderBox = m.boxSizing === "border-box";
  const contentFit = borderBox ? m.scrollHeight + borderY : Math.max(0, m.scrollHeight - padY);
  const maxH = borderBox
    ? m.maxRows * m.lineHeight + padY + borderY
    : m.maxRows * m.lineHeight;
  const height = Math.min(contentFit, maxH);
  return { height, overflowY: contentFit > maxH ? "auto" : "hidden" };
}
