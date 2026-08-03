import { AlertTriangle } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { useT } from "../../i18n.js";

// Confirm-delete dialog for a single agent (+ its children). Extracted out of OrgPage.tsx.
export default function DeleteAgentDialog({
  open,
  agentName,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  agentName: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const tr = useT();
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
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="p-6 min-w-[360px] text-center"
            style={{
              background: "var(--color-surface-1)",
              border: "1px solid var(--color-hairline)",
              borderRadius: 12,
              boxShadow: "var(--shadow-lg)",
            }}
            onClick={e => e.stopPropagation()}
          >
            <div className="mb-3 flex justify-center">
              <AlertTriangle size={40} className="text-amber" />
            </div>
            <p className="m-0 mb-2 text-[15px] font-semibold tracking-tight text-ink">{tr('org.deleteAgentConfirmTitle')}</p>
            <p className="m-0 mb-4 text-[13px] text-ink-muted">
              {tr('org.deleteAgentConfirmBody', { name: agentName })}
            </p>
            <div className="flex gap-2 justify-center">
              <button onClick={onConfirm} className="btn-danger">{tr('org.confirmDelete')}</button>
              <button onClick={onCancel} className="btn-secondary">{tr('common.cancel')}</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
