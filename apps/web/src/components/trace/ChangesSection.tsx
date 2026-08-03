import { useEffect, useState } from "react";
import { Files, FolderOpen, ExternalLink, FileDown, Printer } from "lucide-react";
import type { FileChange } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { printMarkdownAsPdf } from "../../lib/printExport.js";
import { exportMarkdownToDocx } from "../../lib/reportExport.js";
import { pushToast } from "../common/Toast.js";
import { SUCCESS, WARNING, ERROR, type RunTaskMeta } from "./traceTypes.js";

// "产出文件"区块——修产品级信任缺口:任务实际把文件写到了公司工作区(workRoot,见 GET
// /runs/:id/changes 的 resolveRunWorkRoot),但用户在任务详情里只看到 report.md 的文字总结,
// 以为"没有产出"。这里把 changes.json 的结构化清单(create/modify/delete)摊开显示 + 提供
// 一键在系统资源管理器里打开该目录的入口,让"文件真实存在"这件事眼见为实。
//
// workRoot 是该 run 所属**公司**的共享工作区根(不是逐 run 隔离的目录),changes[].path 相对它。

const TYPE_META: Record<FileChange["changeType"], { labelKey: string; color: string; sign: string }> = {
  create: { labelKey: "trace.changes.type.create", color: SUCCESS, sign: "+" },
  modify: { labelKey: "trace.changes.type.modify", color: WARNING, sign: "~" },
  delete: { labelKey: "trace.changes.type.delete", color: ERROR, sign: "-" },
};

const HTML_RE = /\.html?$/i;
const MD_RE = /\.mdx?$/i;

// file:// URL 只是 best-effort(浏览器安全策略下可能被拦,Electron 壳里通常能用)——拼接时把
// Windows 反斜杠转正斜杠,对整段做 encodeURI 再手动补上它不转义的 # / ? (URL 里有特殊含义)。
function toFileUrl(root: string, relPath: string): string {
  const abs = `${root}/${relPath}`.replace(/\\/g, "/").replace(/\/+/g, "/");
  return "file:///" + encodeURI(abs).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

// 相对路径取文件名(不含扩展名)——导出文件名/打印标题用。
function baseNameNoExt(relPath: string): string {
  const seg = relPath.replace(/\\/g, "/").split("/").pop() || relPath;
  return seg.replace(/\.[^.]+$/, "");
}

export function emptyChangesMessageKey(taskMeta?: RunTaskMeta | null): string {
  const acceptance = taskMeta?.deliveryAcceptance;
  const failed = taskMeta?.status === "failed"
    || taskMeta?.finalState === "failed"
    || acceptance?.status === "no_delivery";
  const expectedCode = acceptance?.requiresCode !== false;
  return failed && expectedCode ? "trace.changes.emptyFailedCode" : "trace.changes.empty";
}

export default function ChangesSection({ runId, taskMeta }: { runId: string; taskMeta?: RunTaskMeta | null }) {
  const t = useT();
  const [workRoot, setWorkRoot] = useState("");
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [exportingDocxPath, setExportingDocxPath] = useState<string | null>(null);

  useEffect(() => {
    if (!runId) { setLoading(false); return; }
    setLoading(true);
    api.get<{ workRoot: string; changes: FileChange[] }>(`/runs/${encodeURIComponent(runId)}/changes`)
      .then((d) => { setWorkRoot(d.workRoot || ""); setChanges(Array.isArray(d.changes) ? d.changes : []); })
      .catch(() => { setWorkRoot(""); setChanges([]); })
      .finally(() => setLoading(false));
  }, [runId]);

  const openFolder = async () => {
    setOpening(true);
    try {
      await api.post<{ ok: boolean; opened: string }>(`/runs/${encodeURIComponent(runId)}/open-folder`, {});
      pushToast("success", t("trace.changes.openFolderOk"));
    } catch (e: any) {
      pushToast("error", t("trace.changes.openFolderFail", { reason: e?.message || "" }));
    } finally {
      setOpening(false);
    }
  };

  // 产出物列表里 markdown 文件的"导出为 PDF/Word"——内容来自 changes.json 里该条记录的 `after`
  // 字段(diffFileChanges 写入时截到 20000 字符;超长报告可能不是全文,这是既有截断行为,不在本次改动
  // 范围内)。没有 after(binary/超大文件读取失败/delete 类型)就不出这两个按钮,和本文件其它"没数据
  // 就不占地方"的 best-effort 模式一致。
  const exportChangePdf = (c: FileChange) => {
    if (!c.after) return;
    try {
      printMarkdownAsPdf(c.after, baseNameNoExt(c.path));
    } catch (e: any) {
      pushToast("error", t("trace.export.fail", { reason: e?.message || "" }));
    }
  };
  const exportChangeDocx = async (c: FileChange) => {
    if (!c.after || exportingDocxPath) return;
    setExportingDocxPath(c.path);
    try {
      await exportMarkdownToDocx(c.after, `${baseNameNoExt(c.path)}.docx`);
      pushToast("success", t("trace.export.docxDone"));
    } catch (e: any) {
      pushToast("error", t("trace.export.fail", { reason: e?.message || "" }));
    } finally {
      setExportingDocxPath(null);
    }
  };

  if (loading) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        <h3 className="text-sm font-semibold text-ink m-0 flex items-center gap-2">
          <Files size={15} className="text-accent" /> {t("trace.changes.heading")}
          {changes.length > 0 && <span className="text-ink-subtle font-normal">({changes.length})</span>}
        </h3>
        {!!workRoot && (
          <button
            onClick={openFolder}
            disabled={opening}
            className="ml-auto flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border border-hairline bg-surface-1 text-ink-muted hover:text-ink hover:border-hairline-light disabled:opacity-60 cursor-pointer transition-colors"
          >
            <FolderOpen size={13} /> {opening ? t("trace.changes.opening") : t("trace.changes.openFolder")}
          </button>
        )}
      </div>

      {!!workRoot && (
        <div className="text-[11px] text-ink-subtle font-mono mb-2 break-all">{workRoot}</div>
      )}

      {changes.length === 0 ? (
        <div className="card text-[13px] text-ink-subtle">{t(emptyChangesMessageKey(taskMeta))}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {changes.map((c, i) => {
            const meta = TYPE_META[c.changeType] ?? TYPE_META.modify;
            const isHtml = c.changeType !== "delete" && HTML_RE.test(c.path);
            const isMd = c.changeType !== "delete" && MD_RE.test(c.path) && !!c.after;
            const exportingThis = exportingDocxPath === c.path;
            return (
              <div key={`${c.path}-${i}`} className="flex items-center gap-2 bg-bg-card border border-hairline rounded-md px-3 py-1.5">
                <span
                  className="text-[11px] font-mono font-semibold w-4 text-center shrink-0"
                  style={{ color: meta.color }}
                  title={t(meta.labelKey)}
                >
                  {meta.sign}
                </span>
                <span className="text-[13px] font-mono text-ink truncate min-w-0 flex-1" title={c.path}>{c.path}</span>
                {isHtml && (
                  <a
                    href={toFileUrl(workRoot, c.path)}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-[11px] text-accent flex items-center gap-1 hover:underline"
                  >
                    <ExternalLink size={11} /> {t("trace.changes.openInBrowser")}
                  </a>
                )}
                {isMd && (
                  <>
                    <button
                      onClick={() => exportChangePdf(c)}
                      title={t("trace.export.pdfHint")}
                      className="shrink-0 text-[11px] text-ink-subtle flex items-center gap-1 hover:text-ink bg-transparent border-none cursor-pointer p-0"
                    >
                      <Printer size={11} /> {t("trace.changes.exportPdf")}
                    </button>
                    <button
                      onClick={() => exportChangeDocx(c)}
                      disabled={exportingThis}
                      className="shrink-0 text-[11px] text-ink-subtle flex items-center gap-1 hover:text-ink bg-transparent border-none cursor-pointer p-0 disabled:opacity-60"
                    >
                      <FileDown size={11} /> {exportingThis ? t("trace.export.exporting") : t("trace.changes.exportDocx")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
