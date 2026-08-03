import { useState } from "react";
import { Archive } from "lucide-react";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { pushToast } from "../common/Toast.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import { pickDefaultHistoryRunIds, type ArchivableRunRow } from "./archiveUtil.js";

// 任务档案页头部的"一键归档 default 公司历史 run"入口(批量 run 归档的最小实现)。
// 点击时现拉一次 /runs 计算可归档集合,二次确认(明示可恢复、证据不删)后调 /api/archive/runs。
export default function ArchiveDefaultRunsButton({ onArchived }: { onArchived?: () => void }) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    setBusy(true);
    try {
      const rows = await api.get<ArchivableRunRow[]>("/runs");
      const ids = pickDefaultHistoryRunIds(rows);
      if (ids.length === 0) {
        pushToast("info", t("archive.runs.none"));
        return;
      }
      const ok = await confirmDialog({
        title: t("archive.confirm.runs.title", { n: ids.length }),
        body: t("archive.confirm.runs.body"),
        confirmLabel: t("archive.action"),
      });
      if (!ok) return;
      await api.archiveRuns(ids);
      pushToast("success", t("archive.toast.archived"));
      onArchived?.();
    } catch (e) {
      pushToast("error", (e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button onClick={onClick} disabled={busy} title={t("archive.runs.desc")}
      className="flex items-center gap-1.5 px-2.5 h-7 rounded-md border border-hairline bg-surface-1 text-[12px] text-ink-muted cursor-pointer hover:text-ink hover:border-hairline-light transition-colors disabled:opacity-50">
      <Archive size={13} /> {t("archive.runs.entry")}
    </button>
  );
}
