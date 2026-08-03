import { motion, AnimatePresence } from "framer-motion";
import { useT } from "../../i18n.js";

// "New company" creation dialog. Extracted out of OrgPage.tsx (temperate split — state stays owned
// by OrgPage, this component is pure presentation + callbacks).
export default function NewCompanyModal({
  open,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  onCancel,
  onCreate,
}: {
  open: boolean;
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const tr = useT();
  return (
    <AnimatePresence>
      {open && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}
          className="modal-overlay" onClick={onCancel}>
          <motion.div initial={{ opacity: 0, scale: 0.95, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 10 }} transition={{ duration: 0.2 }}
            className="p-6 min-w-[380px]" style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-hairline)", borderRadius: 12, boxShadow: "var(--shadow-lg)" }}
            onClick={e => e.stopPropagation()}>
            <h3 className="m-0 mb-4 text-base font-semibold tracking-tight text-ink">{tr('org.newCompany')}</h3>
            <div className="flex flex-col gap-3">
              <div>
                <label className="block text-[11px] text-ink-muted mb-1">{tr('org.companyName')}</label>
                <input value={name} onChange={e => onNameChange(e.target.value)} autoFocus
                  onKeyDown={e => { if (e.key === "Enter") onCreate(); }}
                  className="border-0 border-b-2 border-border bg-transparent text-sm py-2 w-full outline-none focus:border-accent transition-colors text-ink" placeholder={tr('org.companyNamePlaceholder')} />
              </div>
              <div>
                <label className="block text-[11px] text-ink-muted mb-1">{tr('org.companyDesc')}</label>
                <textarea value={description} onChange={e => onDescriptionChange(e.target.value)} rows={3}
                  className="border border-border rounded-lg bg-transparent text-[13px] p-2 w-full outline-none focus:border-accent transition-colors text-ink resize-none" placeholder={tr('org.companyDescPlaceholder')} />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-5">
              <button onClick={onCancel} className="px-4 py-1.5 rounded-lg border border-hairline text-ink-muted text-[13px] cursor-pointer hover:text-ink">{tr('common.cancel')}</button>
              <button onClick={onCreate} disabled={!name.trim()}
                className="btn-primary px-4 py-1.5 text-[13px] disabled:opacity-50">{tr('org.createCompany')}</button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
