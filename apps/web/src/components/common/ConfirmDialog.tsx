import { useEffect } from "react";
import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, HelpCircle } from "lucide-react";
import { useT } from "../../i18n.js";

// 全局 ConfirmDialog:替代原生 confirm()。Promise 风格——await confirmDialog({...}) => boolean。
// 文案(title/body/confirmLabel/cancelLabel)由调用方 tr()/t() 翻译好再传入;本组件只负责呈现 + 交互
// (Esc/点遮罩=取消,danger=红色主按钮)。同一时刻只支持一个 pending 请求——若旧请求未resolve就来了
// 新请求,旧请求直接按"取消"处理,避免 promise 悬空。
export interface ConfirmOptions {
  title: string;
  body?: string;
  danger?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
}

interface PendingRequest extends ConfirmOptions {
  resolve: (v: boolean) => void;
}

interface ConfirmStore {
  request: PendingRequest | null;
  ask: (r: PendingRequest) => void;
  settle: (v: boolean) => void;
}

const useConfirmStore = create<ConfirmStore>((set, get) => ({
  request: null,
  ask: (r) => {
    const prev = get().request;
    if (prev) prev.resolve(false); // 旧请求未处理就来新请求——旧的按取消处理，不留悬空 promise
    set({ request: r });
  },
  settle: (v) => {
    const req = get().request;
    if (!req) return;
    set({ request: null });
    req.resolve(v);
  },
}));

// 模块级函数——组件外也能直接发起确认，返回 Promise<boolean>(true=确认，false=取消)。
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().ask({ ...options, resolve });
  });
}

// 挂载一次于 App 根部。
export function ConfirmHost() {
  const request = useConfirmStore((s) => s.request);
  const settle = useConfirmStore((s) => s.settle);
  const tr = useT();

  useEffect(() => {
    if (!request) return;
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") settle(false); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [request, settle]);

  return (
    <AnimatePresence>
      {request && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="modal-overlay z-[10010]"
          onClick={() => settle(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="p-6 min-w-[360px] max-w-[420px] text-center"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-hairline)",
              borderRadius: 12,
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex justify-center">
              {request.danger
                ? <AlertTriangle size={40} className="text-amber" />
                : <HelpCircle size={40} style={{ color: "var(--color-accent)" }} />}
            </div>
            <p className="m-0 mb-2 text-[15px] font-semibold tracking-tight text-ink">{request.title}</p>
            {request.body && <p className="m-0 mb-4 text-[13px] text-ink-muted">{request.body}</p>}
            <div className={`flex gap-2 justify-center ${request.body ? "" : "mt-4"}`}>
              <button onClick={() => settle(true)} className={request.danger ? "btn-danger" : "btn-primary"}>
                {request.confirmLabel || tr("common.confirm")}
              </button>
              <button onClick={() => settle(false)} className="btn-secondary">
                {request.cancelLabel || tr("common.cancel")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
