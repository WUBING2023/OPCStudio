import { Component, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";

// 页面级错误边界:lazy 页面运行时崩溃之前是整页白屏(无任何线索)——这里兜住,显示错误详情 + 重试。
// resetKey(通常传当前页名):变化时自动清除 error——否则一个页面崩了会把所有页面都卡在错误态
// (深度体验 QA 实锤:组织页崩,记忆/成本页全黑)。
export default class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: unknown) { console.error("[ErrorBoundary]", error, info); }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="h-full flex flex-col items-center justify-center gap-3 text-center px-8">
          <AlertTriangle size={40} className="text-red" />
          <div className="text-[14px] font-semibold text-ink">页面渲染出错</div>
          <div className="text-[12px] text-ink-muted font-mono max-w-xl break-all">{String(this.state.error?.message || this.state.error)}</div>
          <button className="btn-primary mt-2" onClick={() => this.setState({ error: null })}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
