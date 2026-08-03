import { useCallback, useEffect, useState } from "react";
import { Archive, RotateCcw, Building2, History } from "lucide-react";
import type { Company } from "@opc/shared";
import * as api from "../../api/client.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import { useT } from "../../i18n.js";
import { pushToast } from "../common/Toast.js";
import { confirmDialog } from "../common/ConfirmDialog.js";
import HelpTip from "../HelpTip.js";
import InfoDisclosure from "../common/InfoDisclosure.js";
import { pickDefaultHistoryRunIds, type ArchivableRunRow } from "./archiveUtil.js";

// 归档管理面板(设置页入口):① 归档公司(默认公司不可归档)② 一键归档 default 公司的历史 run
// ③ 已归档条目列表 + 恢复。归档=移动到 .opc/archive/,可恢复,绝不删证据——所有确认弹窗都明示这一点。
export default function ArchiveManager() {
  const t = useT();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [runs, setRuns] = useState<ArchivableRunRow[]>([]);
  const [archives, setArchives] = useState<api.ArchiveListItem[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.get<Company[]>("/companies").then(setCompanies).catch(() => { /* best-effort */ });
    api.get<ArchivableRunRow[]>("/runs").then((list) => setRuns(list || [])).catch(() => { /* best-effort */ });
    api.listArchives().then(setArchives).catch(() => { /* best-effort */ });
    useAgentStore.getState().load(); // 公司归档/恢复会增删员工,组织页的 agent 树同步刷新
  }, []);
  useEffect(() => { reload(); }, [reload]);

  const archivableCompanies = companies.filter((c) => c.id !== "default");
  const defaultHistoryIds = pickDefaultHistoryRunIds(runs);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      pushToast("error", (e as Error).message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const onArchiveCompany = async (c: Company) => {
    const runCount = runs.filter((r) => r.companyId === c.id).length;
    const ok = await confirmDialog({
      title: t("archive.confirm.company.title", { name: c.name }),
      body: t("archive.confirm.company.body", { runs: runCount }),
      danger: true,
      confirmLabel: t("archive.action"),
    });
    if (!ok) return;
    await run(async () => {
      await api.archiveCompany(c.id);
      pushToast("success", t("archive.toast.archived"));
    });
  };

  const onArchiveDefaultRuns = async () => {
    if (defaultHistoryIds.length === 0) {
      pushToast("info", t("archive.runs.none"));
      return;
    }
    const ok = await confirmDialog({
      title: t("archive.confirm.runs.title", { n: defaultHistoryIds.length }),
      body: t("archive.confirm.runs.body"),
      confirmLabel: t("archive.action"),
    });
    if (!ok) return;
    await run(async () => {
      await api.archiveRuns(defaultHistoryIds);
      pushToast("success", t("archive.toast.archived"));
    });
  };

  const onRestore = async (item: api.ArchiveListItem) => {
    const ok = await confirmDialog({
      title: t("archive.confirm.restore.title"),
      body: t("archive.confirm.restore.body"),
      confirmLabel: t("archive.restore"),
    });
    if (!ok) return;
    await run(async () => {
      await api.restoreArchive(item.archiveId);
      pushToast("success", t("archive.toast.restored"));
    });
  };

  return (
    <div className="space-y-8">
      <div>
        <label className="block text-[14px] font-semibold text-ink">{t("archive.title")}</label>
        <InfoDisclosure className="mt-1">{t("archive.desc")}</InfoDisclosure>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-2">
          <Building2 size={14} className="text-ink-subtle" /> {t("archive.companies.title")}
        </div>
        {archivableCompanies.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-subtle">{t("archive.companies.empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {archivableCompanies.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-hairline bg-surface-1">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">{c.name}</div>
                  <div className="text-[12px] text-ink-subtle font-mono">{c.id}</div>
                </div>
                <button onClick={() => onArchiveCompany(c)} disabled={busy}
                  className="btn-secondary shrink-0 flex items-center gap-1.5 disabled:opacity-50">
                  <Archive size={13} /> {t("archive.action")}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-2">
          <History size={14} className="text-ink-subtle" /> {t("archive.runs.title")}
          <HelpTip text={t("archive.runs.desc")} />
        </div>
        <button onClick={onArchiveDefaultRuns} disabled={busy || defaultHistoryIds.length === 0}
          className="btn-secondary flex items-center gap-1.5 disabled:opacity-50">
          <Archive size={13} /> {t("archive.runs.defaultButton", { n: defaultHistoryIds.length })}
        </button>
      </div>

      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink mb-2">
          <Archive size={14} className="text-ink-subtle" /> {t("archive.list.title")}
        </div>
        {archives.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-subtle">{t("archive.list.empty")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {archives.map((item) => (
              <div key={item.archiveId} className="flex items-center justify-between gap-3 px-4 py-2.5 rounded-lg border border-hairline bg-surface-1">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium text-ink truncate">
                    {item.kind === "company" ? `${t("archive.kind.company")} · ${item.name ?? item.id}` : t("archive.kind.runs")}
                  </div>
                  <div className="text-[12px] text-ink-subtle">
                    {new Date(item.archivedAt).toLocaleString()} · {t("archive.meta", { runs: item.runCount, agents: item.agentCount })}
                  </div>
                </div>
                {item.restoredAt ? (
                  <span className="badge shrink-0 bg-surface-2 text-ink-subtle">{t("archive.restored")}</span>
                ) : (
                  <button onClick={() => onRestore(item)} disabled={busy}
                    className="btn-secondary shrink-0 flex items-center gap-1.5 disabled:opacity-50">
                    <RotateCcw size={13} /> {t("archive.restore")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
