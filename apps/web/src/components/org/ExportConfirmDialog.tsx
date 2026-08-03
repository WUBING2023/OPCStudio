import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ShieldCheck, X, AlertTriangle } from "lucide-react";
import { useT } from "../../i18n.js";

export type ExportProfile = "full" | "share";

// P1-18 最小版:导出前确认弹窗——挂在「导出公司为模板」按钮之前,只有确认后才真正发起导出。
// 说明服务端(companyTemplate.ts/memoryBundle.ts)会自动移除密钥等敏感信息(不在这里重新实现脱敏,
// 只做导出前的透明告知);并把「导出时一并带上记忆」开关(company.memoryExportEnabled)就地放进弹窗
// ——确认时若与公司当前设置不同,由调用方先落盘再导出。
// 分场景导出:档位选择 full(自己备份/迁移,保真:留本机命令/权限/个人记忆)| share(社区分享,缺省,
// 全脱敏 + 导入侧 Safe Install)。full 档给出显式"勿分享"警示。
export default function ExportConfirmDialog({
  open,
  companyName,
  initialMemoryEnabled,
  exporting,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  companyName: string;
  initialMemoryEnabled: boolean;
  exporting?: boolean;
  onConfirm: (memoryExportEnabled: boolean, profile: ExportProfile) => void;
  onCancel: () => void;
}) {
  const tr = useT();
  const [memoryEnabled, setMemoryEnabled] = useState(initialMemoryEnabled);
  const [profile, setProfile] = useState<ExportProfile>("share");

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="modal-overlay"
          onClick={onCancel}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.15 }}
            className="modal-content w-[420px] max-w-[92vw]"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <h3 className="m-0 text-[14px] font-semibold text-ink flex items-center gap-1.5">
                <ShieldCheck size={16} className="text-accent" />
                {tr("cmp.export.confirmTitle", { name: companyName })}
              </h3>
              <button onClick={onCancel} className="w-7 h-7 flex items-center justify-center rounded-md bg-surface-2 text-ink-muted hover:text-ink cursor-pointer border-none shrink-0">
                <X size={14} />
              </button>
            </div>
            <p className="m-0 mt-2 mb-3 text-[13px] text-ink-muted">{tr("cmp.export.autoRemoveHint")}</p>

            {/* 档位选择:share(缺省,社区分享)/ full(自己备份,保真) */}
            <div className="mb-3">
              <div className="text-[12px] font-semibold text-ink mb-1.5">{tr("cmp.export.profileLabel")}</div>
              <div className="flex gap-1.5 rounded-full bg-surface-2 p-0.5">
                {(["share", "full"] as ExportProfile[]).map(p => (
                  <button key={p} type="button" onClick={() => setProfile(p)}
                    className={`flex-1 text-[12px] px-2 py-1.5 rounded-full border-none transition-colors ${
                      profile === p ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
                    }`}>
                    {tr(p === "full" ? "cmp.export.profileFull" : "cmp.export.profileShare")}
                  </button>
                ))}
              </div>
              {profile === "full" ? (
                <div className="mt-2 flex items-start gap-2 text-[12px] text-amber bg-amber/10 border border-amber/25 rounded-md px-2.5 py-2">
                  <AlertTriangle size={13} className="shrink-0 mt-0.5" />
                  <span>{tr("cmp.export.profileFullHint")}</span>
                </div>
              ) : (
                <p className="m-0 mt-2 text-[12px] text-ink-subtle">{tr("cmp.export.profileShareHint")}</p>
              )}
            </div>

            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input type="checkbox" checked={memoryEnabled} onChange={e => setMemoryEnabled(e.target.checked)} />
              <span className="text-[13px] text-ink">{tr("cmp.memoryExportEnabled")}</span>
            </label>
            <p className="m-0 mt-1 mb-4 text-[12px] text-ink-subtle ms-6">{tr("cmp.memoryExportEnabledHint")}</p>

            <div className="flex gap-2 justify-end">
              <button onClick={onCancel} disabled={exporting} className="btn-secondary">{tr("common.cancel")}</button>
              <button onClick={() => onConfirm(memoryEnabled, profile)} disabled={exporting} className="btn-primary">
                {exporting ? "…" : tr("cmp.export.confirmButton")}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
