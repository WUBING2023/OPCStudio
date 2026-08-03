import { create } from "zustand";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { useT } from "../../i18n.js";

// 全局 Toast:替代原生 alert()(廉价感来源)。右下角堆叠、深色卡+左侧色条、4s 自动消失、可手动关。
// 用法:任意模块(含非组件代码)直接 import { pushToast } from "…/Toast.js" 调用即可,
// 文案由调用方自行 tr()/t() 翻译好再传入——本组件不解释业务文案,只负责呈现。
export type ToastType = "error" | "success" | "info";

interface ToastItem { id: string; type: ToastType; text: string }

interface ToastStore {
  toasts: ToastItem[];
  push: (t: ToastItem) => void;
  dismiss: (id: string) => void;
}

const useToastStore = create<ToastStore>((set) => ({
  toasts: [],
  push: (t) => set((s) => ({ toasts: [...s.toasts, t] })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

const AUTO_DISMISS_MS = 4000;

function genId(): string {
  try { return crypto.randomUUID(); } catch { return `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

// 模块级函数——组件外(store/api 层)也能直接弹 toast,不依赖 hook。
export function pushToast(type: ToastType, text: string): void {
  const id = genId();
  useToastStore.getState().push({ id, type, text });
  setTimeout(() => useToastStore.getState().dismiss(id), AUTO_DISMISS_MS);
}

const TYPE_META: Record<ToastType, { Icon: typeof Info; bar: string; iconColor: string }> = {
  // #dc2626 保留:与 --color-error 亮色值相同,规则里明确列为豁免不改。
  error: { Icon: XCircle, bar: "#dc2626", iconColor: "var(--color-error)" },
  success: { Icon: CheckCircle2, bar: "var(--color-success)", iconColor: "var(--color-success)" },
  // 旧值 #5e6ad2/#818cf8 是迁移前的靛蓝强调色,语义上这里是"info"提示条,改用专门的
  // --color-info token(暗色下 #7ab7ff,与 accent 不同色,比套用 accent 更贴合语义)。
  info: { Icon: Info, bar: "var(--color-info)", iconColor: "var(--color-info)" },
};

// 挂载一次于 App 根部;渲染全部当前 toast,右下角纵向堆叠。
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  const tr = useT();

  return (
    <div className="fixed bottom-6 right-6 z-[10000] flex flex-col gap-2 items-end pointer-events-none">
      <AnimatePresence>
        {toasts.map((toast) => {
          const { Icon, bar, iconColor } = TYPE_META[toast.type];
          return (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: 16 }}
              transition={{ duration: 0.15 }}
              className="pointer-events-auto flex items-start gap-2.5 w-[340px] max-w-[calc(100vw-48px)] pl-3 pr-2.5 py-2.5 bg-surface-1 border border-hairline rounded-lg shadow-lg"
              style={{ borderLeft: `3px solid ${bar}` }}
            >
              <Icon size={16} className="shrink-0 mt-0.5" style={{ color: iconColor }} />
              <div className="flex-1 min-w-0 text-[13px] text-ink leading-snug break-words">{toast.text}</div>
              <button
                onClick={() => dismiss(toast.id)}
                title={tr("common.close")}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded border-none bg-transparent text-ink-subtle cursor-pointer hover:text-ink hover:bg-surface-2 transition-colors"
              >
                <X size={13} />
              </button>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
