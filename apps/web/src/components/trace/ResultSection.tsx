import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Brain, ChevronDown, Copy, Download, Eye, FileDown, FileText, ListChecks, Package, Printer, ShieldCheck } from "lucide-react";
import type { EvidenceRow, TraceEvent } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { isArtifactOpenable, isMarkdownPreview, type OpenableArtifact } from "../../lib/artifactCard.js";
import { printMarkdownAsPdf } from "../../lib/printExport.js";
import { computeRunQuality } from "../../lib/runQuality.js";
import { exportMarkdownToDocx } from "../../lib/reportExport.js";
import { pushToast } from "../common/Toast.js";
import ConflictResolutionPanel from "./ConflictResolutionPanel.js";
import ExecutionPermissionPosture from "./ExecutionPermissionPosture.js";
import type { ExecutionPermissionPostureDto } from "./evidencePermissionTypes.js";
import {
  ART_STATUS_COLOR, DEFAULT_TYPE_COLOR, ERROR, KIND_LABEL_KEY, MEMORY_SCOPE_LABEL_KEY, MEMORY_SCOPE_ORDER, SUCCESS, WARNING,
  artifactDisplayStatus, type BadgeKey, type RunArtifact, type RunMemoryPackUsage,
} from "./traceTypes.js";

// AI Research Company:证据表置信度 → 颜色,与既有 SUCCESS/WARNING/灰 三档语义对齐(不新引入调色板)。
const EVIDENCE_CONFIDENCE_COLOR: Record<EvidenceRow["confidence"], string> = {
  high: SUCCESS, medium: WARNING, low: DEFAULT_TYPE_COLOR,
};

// ①结果——report.md 渲染 + degraded/partial 横幅(段内置顶)+ 证据表(可选)+ 交付物(artifact)列表。
// "任务→过程→交付"故事视角里的"交付"落点:新用户进详情页第一眼就该看到结果,不用先划过时间线。
export default function ResultSection({
  runId, badge, degradedReason, hasPartial, deferred, rejectedArtifacts, stuckModules,
  reportMd, artifacts, evidenceTable, memoryPackUsage, permissionPosture,
}: {
  runId: string;
  badge: BadgeKey;
  degradedReason?: string;
  hasPartial: boolean;
  deferred: string[];
  rejectedArtifacts: string[];
  stuckModules: string[];
  reportMd: string | null; // null = 加载中
  artifacts: RunArtifact[];
  evidenceTable?: EvidenceRow[]; // best-effort:合成阶段提取不到就不传/传空,不渲染该区块
  memoryPackUsage?: RunMemoryPackUsage; // best-effort:GET /runs/:id/memory-pack,countsByScope 全 0(或未传)不渲染该区块
  permissionPosture?: ExecutionPermissionPostureDto;
}) {
  const t = useT();
  const showReasonBanner = (badge === "degraded" || badge === "interrupted") && degradedReason;
  // 没有报告不该看着像"数据丢了"——按 badge 给个人话原因(失败/降级/被中断),done/running 两种
  // 状态下的空报告维持原有的通用文案(前者是历史遗留的空 run,后者是"还在跑,报告没出来"的正常态)。
  const emptyReportReasonKey = badge === "failed" ? "trace.status.failed"
    : badge === "degraded" ? "trace.status.degraded"
      : badge === "interrupted" ? "trace.status.interrupted" : undefined;

  // P2(质量汇总面板 · 审计发现③):质量信号(验证边通过率/合并冲突/同源审查/超时抢救)散落在聊天消息
  // /事件流里,用户看不到"这次产出可信度多高"的汇总。这里独立拉一次该 run 的完整原始事件(已有端点
  // GET /runs/:id/events,历史/直播 run 都能读,不需要新端点),从中派生一个紧凑的质量摘要——不影响
  // 上面已有的 reportMd/artifacts 等 best-effort 数据流。
  const [qualityEvents, setQualityEvents] = useState<TraceEvent[]>([]);
  useEffect(() => {
    if (!runId) { setQualityEvents([]); return; }
    let cancelled = false;
    api.get<{ runId: string | null; events: TraceEvent[] }>(`/runs/${encodeURIComponent(runId)}/events`)
      .then((r) => { if (!cancelled) setQualityEvents(r.events || []); })
      .catch(() => { if (!cancelled) setQualityEvents([]); });
    return () => { cancelled = true; };
  }, [runId]);

  // C3 抽取:计算体挪到 lib/runQuality.ts 的 computeRunQuality(工作台群成果卡复用同一口径),语义未变。
  const quality = useMemo(() => computeRunQuality(qualityEvents), [qualityEvents]);
  const [mergeDetailOpen, setMergeDetailOpen] = useState(false);
  // 波6 · 合并冲突决裁台入口:只读展示旁边给一个"去处理",展开真正可操作的 ConflictResolutionPanel。
  const [resolvePanelOpen, setResolvePanelOpen] = useState(false);

  // "本次使用的记忆"——纯展示 GET /runs/:id/memory-pack 已聚合好的 totalByScope/usages,不再本地重算。
  // countsByScope 全 0(或未传该 prop)时整块不渲染,与质量摘要面板"hasAnySignal"同一套"没信号就不占地方"原则。
  const memoryTotalCount = useMemo(
    () => (memoryPackUsage ? Object.values(memoryPackUsage.totalByScope).reduce((a, b) => a + b, 0) : 0),
    [memoryPackUsage],
  );
  const memorySummaryText = useMemo(() => {
    if (!memoryPackUsage) return "";
    return MEMORY_SCOPE_ORDER
      .filter((s) => memoryPackUsage.totalByScope[s] > 0)
      .map((s) => t("trace.memoryPack.countItem", { count: memoryPackUsage.totalByScope[s], label: t(MEMORY_SCOPE_LABEL_KEY[s]) }))
      .join(" · ");
  }, [memoryPackUsage, t]);
  const [memoryDetailOpen, setMemoryDetailOpen] = useState(false);

  // 报告导出(PDF/Word)——纯前端转换,见 src/lib/printExport.tsx(PDF,走系统打印)/
  // src/lib/reportExport.ts(Word,docx 包生成真 .docx 二进制)。两条路径都不需要服务端参与。
  const [exportingDocx, setExportingDocx] = useState(false);
  const handleExportPdf = () => {
    if (!reportMd) return;
    try {
      printMarkdownAsPdf(reportMd, `OPC-${runId}`);
    } catch (e: any) {
      pushToast("error", t("trace.export.fail", { reason: e?.message || "" }));
    }
  };
  const handleExportDocx = async () => {
    if (!reportMd || exportingDocx) return;
    setExportingDocx(true);
    try {
      await exportMarkdownToDocx(reportMd, `OPC-${runId}.docx`);
      pushToast("success", t("trace.export.docxDone"));
    } catch (e: any) {
      pushToast("error", t("trace.export.fail", { reason: e?.message || "" }));
    } finally {
      setExportingDocx(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {(showReasonBanner || hasPartial || deferred.length > 0 || rejectedArtifacts.length > 0 || stuckModules.length > 0) && (
        <div className="rounded-lg border px-3.5 py-3 flex flex-col gap-2" style={{ borderColor: "color-mix(in srgb, var(--color-warning) 45%, transparent)", background: "color-mix(in srgb, var(--color-warning) 8%, transparent)" }}>
          {showReasonBanner && (
            <div className="text-[13px] text-amber flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span><b>{t(badge === "interrupted" ? "trace.status.interrupted" : "trace.status.degraded")}</b> · {t("trace.reasonLabel")}: {degradedReason}</span>
            </div>
          )}
          {hasPartial && <div className="text-[13px] text-amber">{t("trace.partialHint")}</div>}
          {deferred.length > 0 && <ChipRow label={t("trace.deferred")} items={deferred} color="var(--color-warning)" />}
          {rejectedArtifacts.length > 0 && <ChipRow label={t("trace.rejected")} items={rejectedArtifacts} color="var(--color-error)" />}
          {/* #b67c5d 不在给定的语义色映射清单里,且和 traceTypes.ts 里其它"卡住/异常"语义色不完全一致——
              保留原样,不擅自判定它该并入 warning 还是 error(留给设计方拍板)。 */}
          {stuckModules.length > 0 && <ChipRow label={t("trace.stuck")} items={stuckModules} color="#b67c5d" />}
        </div>
      )}

      <ExecutionPermissionPosture posture={permissionPosture} />

      {quality.hasAnySignal && (
        <div className="card">
          <h3 className="text-sm font-semibold text-ink m-0 mb-2 flex items-center gap-2">
            <ShieldCheck size={15} className="text-accent" /> {t("trace.quality.heading")}
          </h3>
          {quality.allClear ? (
            <div className="text-[13px]" style={{ color: SUCCESS }}>{t("trace.quality.allClear")}</div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {quality.verifyTotal > 0 && (
                <QualityRow
                  color={quality.verifyPassed === quality.verifyTotal ? SUCCESS : WARNING}
                  text={t("trace.quality.verification", { passed: quality.verifyPassed, total: quality.verifyTotal })}
                />
              )}
              {(quality.mergeFiles.length > 0 || quality.hasUnstructuredMergeConflict) && (
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <QualityRow
                      color={ERROR}
                      text={quality.mergeFiles.length > 0 ? t("trace.quality.mergeConflict", { count: quality.mergeFiles.length }) : t("trace.quality.mergeConflictUnknown")}
                    />
                    {/* 波6 · 去处理:从只读展示进入可操作的冲突决裁台 */}
                    <button onClick={() => setResolvePanelOpen(v => !v)}
                      className="text-[11px] px-2 py-0.5 rounded-full border border-accent/40 text-accent bg-transparent cursor-pointer hover:border-accent transition-colors">
                      {resolvePanelOpen ? "收起决裁台" : "去处理"}
                    </button>
                  </div>
                  {resolvePanelOpen && (
                    <div className="ml-3 mt-2">
                      <ConflictResolutionPanel runId={runId} onResolved={() => { /* 决裁后 run 状态由上层轮询/事件流刷新 */ }} />
                    </div>
                  )}
                  {quality.mergeFiles.length > 0 && (
                    <div className="ml-3 mt-1">
                      <button onClick={() => setMergeDetailOpen(v => !v)}
                        className="flex items-center gap-1 text-[11px] text-ink-subtle bg-transparent border-none cursor-pointer p-0 hover:text-ink">
                        <ChevronDown size={11} className={mergeDetailOpen ? "rotate-180 transition-transform" : "transition-transform"} />
                        {t(mergeDetailOpen ? "trace.quality.mergeConflictHide" : "trace.quality.mergeConflictShow")}
                      </button>
                      {mergeDetailOpen && (
                        <ul className="mt-1 flex flex-col gap-0.5 list-none p-0 m-0">
                          {quality.mergeFiles.map((f, i) => (
                            <li key={i} className="text-[11px] text-ink-muted font-mono break-all">
                              {t("trace.quality.mergeConflictDetail", { discarded: f.discardedWorkerId, path: f.path, kept: f.keptWorkerId })}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>
              )}
              {quality.sameModelCount > 0 && <QualityRow color={WARNING} text={t("trace.quality.sameModelReview", { count: quality.sameModelCount })} />}
              {quality.salvageCount > 0 && <QualityRow color={WARNING} text={t("trace.quality.partialSalvage", { count: quality.salvageCount })} />}
            </div>
          )}
        </div>
      )}

      {memoryPackUsage && memoryTotalCount > 0 && (
        <div className="card">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink m-0 flex items-center gap-2">
              <Brain size={15} className="text-accent" /> {t("trace.memoryPack.heading")}
            </h3>
            <button onClick={() => setMemoryDetailOpen((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-ink-subtle bg-transparent border-none cursor-pointer p-0 hover:text-ink shrink-0">
              <ChevronDown size={11} className={memoryDetailOpen ? "rotate-180 transition-transform" : "transition-transform"} />
              {t(memoryDetailOpen ? "trace.memoryPack.hide" : "trace.memoryPack.show")}
            </button>
          </div>
          <div className="text-[13px] text-ink-muted mt-2">{memorySummaryText}</div>
          {memoryDetailOpen && (
            <ul className="mt-2 flex flex-col gap-1.5 list-none p-0 m-0">
              {memoryPackUsage.usages.map((u, i) => (
                <li key={i} className="text-[12px] text-ink-muted border-t border-hairline pt-1.5 first:border-0 first:pt-0 first:mt-0">
                  {u.role && <span className="font-mono text-ink-subtle mr-1.5">{u.role}</span>}
                  {u.message || t("trace.memoryPack.noDetail")}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-2 flex-wrap">
          <h3 className="text-sm font-semibold text-ink m-0 flex items-center gap-2">
            <FileText size={15} className="text-accent" /> {t("trace.report")}
          </h3>
          {!!reportMd && (
            <div className="ml-auto flex items-center gap-1.5">
              <button
                onClick={handleExportPdf}
                title={t("trace.export.pdfHint")}
                className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border border-hairline bg-surface-1 text-ink-muted hover:text-ink hover:border-hairline-light cursor-pointer transition-colors"
              >
                <Printer size={13} /> {t("trace.export.pdf")}
              </button>
              <button
                onClick={handleExportDocx}
                disabled={exportingDocx}
                className="flex items-center gap-1.5 text-[12px] px-2.5 py-1 rounded-full border border-hairline bg-surface-1 text-ink-muted hover:text-ink hover:border-hairline-light disabled:opacity-60 cursor-pointer transition-colors"
              >
                <FileDown size={13} /> {exportingDocx ? t("trace.export.exporting") : t("trace.export.docx")}
              </button>
            </div>
          )}
        </div>
        <div className="card text-[13px] text-ink-muted overflow-auto max-h-[60vh] leading-relaxed">
          {reportMd === null ? <span className="text-ink-subtle">{t("trace.reportLoading")}</span>
            : reportMd
              ? <div className="markdown-body break-words"><ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMd}</ReactMarkdown></div>
              : <span className="text-ink-subtle">
                  {emptyReportReasonKey ? t("trace.reportEmptyReason", { reason: t(emptyReportReasonKey) }) : t("trace.reportEmpty")}
                </span>}
        </div>
      </div>

      {evidenceTable && evidenceTable.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-ink m-0 mb-2 flex items-center gap-2">
            <ListChecks size={15} className="text-accent" /> {t("trace.evidenceTable.heading")} <span className="text-ink-subtle font-normal">({evidenceTable.length})</span>
          </h3>
          <div className="card overflow-x-auto">
            <table className="w-full text-[13px] border-collapse">
              <thead>
                <tr className="text-left text-ink-subtle">
                  <th className="py-1.5 pr-3 font-medium border-b border-hairline">{t("trace.evidenceTable.claim")}</th>
                  <th className="py-1.5 pr-3 font-medium border-b border-hairline">{t("trace.evidenceTable.source")}</th>
                  <th className="py-1.5 pr-3 font-medium border-b border-hairline">{t("trace.evidenceTable.confidence")}</th>
                </tr>
              </thead>
              <tbody>
                {evidenceTable.map((row, i) => {
                  const cc = EVIDENCE_CONFIDENCE_COLOR[row.confidence] ?? DEFAULT_TYPE_COLOR;
                  const confLabel = row.confidence === "high" ? t("trace.evidenceTable.confidence.high")
                    : row.confidence === "medium" ? t("trace.evidenceTable.confidence.medium")
                      : t("trace.evidenceTable.confidence.low");
                  return (
                    <tr key={i} className="align-top">
                      <td className="py-2 pr-3 text-ink break-words border-b border-hairline last:border-0">{row.claim}</td>
                      <td className="py-2 pr-3 text-ink-muted break-words border-b border-hairline last:border-0">
                        {row.url
                          ? <a href={row.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline break-all">{row.source}</a>
                          : row.source}
                      </td>
                      <td className="py-2 pr-3 border-b border-hairline last:border-0">
                        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color: cc, background: `color-mix(in srgb, ${cc} 16%, transparent)` }}>
                          {confLabel}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h3 className="text-sm font-semibold text-ink m-0 mb-3 flex items-center gap-2">
          <Package size={15} className="text-accent" /> {t("trace.artifactsHeading")} <span className="text-ink-subtle font-normal">({artifacts.length})</span>
        </h3>
        {artifacts.length > 0 ? (
          <div className="flex flex-col gap-2">
            {artifacts.map(a => <ArtifactRow key={a.id} runId={runId} a={a as OpenableArtifact} />)}
          </div>
        ) : (
          // 无 artifact 的 run 如实显示"无交付物",不装样子(不渲染任何假的可打开条目)。
          <div className="card text-[13px] text-ink-subtle">{t("trace.artifactsEmpty")}</div>
        )}
      </div>
    </div>
  );
}

// 单个成果条:可打开(预览/下载/复制)的 artifact 提供三个入口;不可打开的产物(deleted/rejected/无实体)
// 只展示元信息,不给假按钮。预览内容按需拉取(GET /runs/:id/artifacts/preview),超限由服务端标 truncated。
function ArtifactRow({ runId, a }: { runId: string; a: OpenableArtifact }) {
  const t = useT();
  const displayStatus = artifactDisplayStatus(a);
  const c = ART_STATUS_COLOR[displayStatus] ?? DEFAULT_TYPE_COLOR;
  const openable = isArtifactOpenable(a);
  const downloadUrl = `/api/runs/${runId}/artifacts/download?artifactId=${encodeURIComponent(a.id)}`;

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<{ content: string; truncated: boolean; filename: string } | null>(null);
  const [failed, setFailed] = useState(false);

  const loadPreview = async (): Promise<{ content: string; truncated: boolean; filename: string } | null> => {
    if (preview) return preview;
    setLoading(true); setFailed(false);
    try {
      const r = await api.get<{ content: string; truncated: boolean; filename: string }>(
        `/runs/${encodeURIComponent(runId)}/artifacts/preview?artifactId=${encodeURIComponent(a.id)}`,
      );
      const p = { content: r.content, truncated: r.truncated, filename: r.filename };
      setPreview(p);
      return p;
    } catch {
      setFailed(true);
      return null;
    } finally {
      setLoading(false);
    }
  };

  const handlePreview = async () => {
    if (open) { setOpen(false); return; }
    setOpen(true);
    await loadPreview();
  };

  const handleCopy = async () => {
    const p = await loadPreview();
    if (!p) { pushToast("error", t("trace.copyFail")); return; }
    try {
      await navigator.clipboard.writeText(p.content);
      pushToast("success", t("trace.copyDone"));
    } catch {
      pushToast("error", t("trace.copyFail"));
    }
  };

  const markdown = !!preview && isMarkdownPreview(preview.filename);

  return (
    <div className="bg-bg-card border border-hairline rounded-md px-3 py-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-surface-2 text-ink-muted">{KIND_LABEL_KEY[a.kind] ? t(KIND_LABEL_KEY[a.kind]) : a.kind}</span>
        <span className="text-[11px] font-medium px-1.5 py-0.5 rounded" style={{ color: c, background: `color-mix(in srgb, ${c} 16%, transparent)` }}>{displayStatus}</span>
        {a.inFinalDeliverable && <span className="text-[10px] text-success">{t("trace.inFinalDeliverable")}</span>}
        {a.producer && <span className="text-[11px] text-ink-muted font-mono">@{a.producer}{a.producerRole ? `/${a.producerRole}` : ""}</span>}
        {openable && (
          <div className="ml-auto flex items-center gap-2.5">
            <button onClick={handlePreview}
              className="text-[11px] text-accent flex items-center gap-1 hover:underline bg-transparent border-none cursor-pointer p-0">
              <Eye size={12} /> {open ? t("trace.previewClose") : t("trace.preview")}
            </button>
            <button onClick={handleCopy}
              className="text-[11px] text-ink-muted flex items-center gap-1 hover:text-ink bg-transparent border-none cursor-pointer p-0">
              <Copy size={12} /> {t("trace.copy")}
            </button>
            <a href={downloadUrl} download className="text-[11px] text-ink-muted flex items-center gap-1 hover:text-ink">
              <Download size={12} /> {t("trace.download")}
            </a>
          </div>
        )}
      </div>
      <div className="mt-1 text-[12px] text-ink break-words">{a.title}</div>
      {a.reason && <div className="text-[11px] text-amber mt-0.5">{t("trace.reasonLabel")}: {a.reason}</div>}
      {a.lineage && a.lineage.length > 0 && (
        <div className="text-[11px] text-ink-subtle mt-1 font-mono break-all">{t("trace.lineageLabel")}: {a.lineage.map(e => `${e.relationship}→${e.sourceId}`).join(" · ")}</div>
      )}
      {open && (
        <div className="mt-2 border-t border-hairline pt-2">
          {loading ? (
            <div className="text-[12px] text-ink-subtle">{t("trace.previewLoading")}</div>
          ) : failed || !preview ? (
            <div className="text-[12px] text-ink-subtle">{t("trace.previewFail")}</div>
          ) : (
            <>
              {preview.truncated && <div className="text-[11px] text-amber mb-1.5">{t("trace.previewTruncated")}</div>}
              {markdown
                ? <div className="markdown-body break-words text-[13px] text-ink-muted max-h-[50vh] overflow-auto"><ReactMarkdown remarkPlugins={[remarkGfm]}>{preview.content}</ReactMarkdown></div>
                : <pre className="text-[12px] text-ink-muted whitespace-pre-wrap break-words max-h-[50vh] overflow-auto font-mono m-0">{preview.content}</pre>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function QualityRow({ color, text }: { color: string; text: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[13px]" style={{ color }}>
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: color }} />
      {text}
    </div>
  );
}

function ChipRow({ label, items, color }: { label: string; items: string[]; color: string }) {
  return (
    <div className="flex items-start gap-2 flex-wrap">
      <span className="text-[11px] font-semibold text-ink-muted mt-0.5 shrink-0">{label}:</span>
      {items.map((it, i) => (
        <span
          key={`${it}-${i}`}
          className="text-[11px] font-mono px-1.5 py-0.5 rounded"
          style={{ color, background: `color-mix(in srgb, ${color} 16%, transparent)` }}
        >
          {it}
        </span>
      ))}
    </div>
  );
}
