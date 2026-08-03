import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, XCircle, Info, MinusCircle, RefreshCw, Globe, X, ChevronRight, Wrench } from "lucide-react";
import { useT } from "../../i18n.js";
import * as api from "../../api/client.js";

// Track E · E2 Global Doctor 前端:顶栏体检徽标(✅/⚠️/❌,依 latest 报告 status)+ 点击弹 checks 明细。
// 数据契约本地镜像 apps/server/src/runtime/globalDoctor.ts 的 DoctorReport 形状
// (不跨包引入 server 内部类型,同 PostmortemModal 的既有做法)。checks 的 message 是服务端诊断文本
// 原样展示;本组件自己的 UI 文案全部走 i18n。大陆网络合规提示按指南 8.3 原文措辞作为固定 info 条目。
export interface DoctorCheck {
  id: string;
  name: string;
  status: "ok" | "failed" | "skipped";
  severity: "info" | "warning" | "error";
  message: string;
}
export interface DoctorReport {
  status: "ok" | "warning" | "error";
  checked_at: string;
  level?: "basic" | "capability" | "deep";
  checks: DoctorCheck[];
}

const STATUS_EMOJI: Record<DoctorReport["status"], string> = { ok: "✅", warning: "⚠️", error: "❌" };

// 已知 check id → i18n 键(未知 id 回退服务端 name,同 PostmortemModal 的 KIND_KEYS 姿势)。
const CHECK_NAME_KEYS = new Set([
  "store.json_rw", "fs.workdir_writable", "fs.runs_writable",
  "provider.keys", "mcp.config", "system_model_provider_registered",
]);

// E5:deep 层专属 check id——从主列表里摘出来,归入下方可折叠的"深度体检"区,不与 basic/capability
// 的结果混排(deep 层每次都会把 basic+capability 的 check 一并带回,这里只挑 deep 独有的 9 个)。
const DEEP_CHECK_IDS = new Set([
  "port.occupancy", "process.orphan_worktree", "toolchain.node", "toolchain.tsx", "toolchain.esbuild",
  "fs.file_lock", "store.deep_parse", "fs.worktree_root_writable", "network.community_registry",
]);
const DEEP_CHECK_NAME_KEYS = DEEP_CHECK_IDS;

function CheckIcon({ check }: { check: DoctorCheck }) {
  if (check.status === "ok") return <CheckCircle2 size={14} className="shrink-0 text-green" />;
  if (check.status === "skipped") return <MinusCircle size={14} style={{ color: "var(--color-ink-subtle)" }} className="shrink-0" />;
  // #dc2626/#d97706 保留:分别与 --color-error/--color-warning 亮色值相同,规则明确豁免不改
  if (check.severity === "error") return <XCircle size={14} style={{ color: "#dc2626" }} className="shrink-0" />;
  return <AlertTriangle size={14} style={{ color: "#d97706" }} className="shrink-0" />;
}

// 单条 check 的展示行,主列表和 deep 折叠区共用(避免两份重复 JSX)。
function CheckRow({ c, nameKeys, tr }: { c: DoctorCheck; nameKeys: Set<string>; tr: ReturnType<typeof useT> }) {
  return (
    <div className="px-3 py-2 rounded-lg" style={{ background: "var(--color-surface-2)" }}>
      <div className="flex items-center gap-2">
        <CheckIcon check={c} />
        <span className="text-[13px] font-medium text-ink">
          {nameKeys.has(c.id) ? tr(`doctor.check.${c.id}`) : c.name}
        </span>
        <span className="ml-auto text-[11px] text-ink-subtle font-mono shrink-0">{c.id}</span>
      </div>
      {c.message && <p className="m-0 mt-1 text-[12px] text-ink-muted break-words">{c.message}</p>}
    </div>
  );
}

export default function DoctorPanel() {
  const tr = useT();
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deepOpen, setDeepOpen] = useState(false); // E5:深度体检折叠区展开态

  useEffect(() => {
    api.get<DoctorReport>("/doctor")
      .then(setReport)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => {
    const openPanel = () => setOpen(true);
    window.addEventListener("opc-open-doctor", openPanel);
    return () => window.removeEventListener("opc-open-doctor", openPanel);
  }, []);

  const rerun = async (level: "basic" | "capability" | "deep") => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setReport(await api.post<DoctorReport>("/doctor/run", { level }));
      window.dispatchEvent(new CustomEvent("opc-doctor-updated"));
      if (level === "deep") setDeepOpen(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  const badge = report ? STATUS_EMOJI[report.status] ?? "⚠️" : "…";
  const badgeLabel = report ? tr(`doctor.status.${report.status}`) : tr("doctor.running");

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title={`${tr("doctor.badgeTitle")} — ${badgeLabel}`}
        className="h-7 px-2 flex items-center gap-1.5 rounded-md border-none bg-transparent text-ink-muted cursor-pointer hover:bg-surface-2 hover:text-ink transition-colors select-none"
      >
        <span className="text-[13px] leading-none">{badge}</span>
        <span className="text-[12px] font-medium hidden sm:inline">{tr("doctor.badgeTitle")}</span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="modal-overlay z-[10005]"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.2 }}
              className="p-5 w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto"
              style={{
                background: "var(--color-surface-1)",
                border: "1px solid var(--color-hairline)",
                borderRadius: 12,
                boxShadow: "var(--shadow-lg)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div className="flex items-start gap-3 mb-3">
                <span className="text-[20px] leading-none mt-0.5 shrink-0">{report ? STATUS_EMOJI[report.status] : "…"}</span>
                <div className="flex-1 min-w-0">
                  <p className="m-0 text-[15px] font-semibold tracking-tight text-ink">{tr("doctor.header")}</p>
                  <p className="m-0 mt-0.5 text-[12px] text-ink-subtle">
                    {report
                      ? `${tr(`doctor.status.${report.status}`)} · ${tr("doctor.checkedAt", { time: new Date(report.checked_at).toLocaleString() })}`
                      : tr("doctor.running")}
                  </p>
                </div>
                <button onClick={() => setOpen(false)} title={tr("common.close")}
                  className="w-7 h-7 flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted cursor-pointer hover:bg-surface-2 hover:text-ink transition-colors shrink-0">
                  <X size={15} />
                </button>
              </div>

              {error && (
                <p className="m-0 mb-3 text-[12px]" style={{ color: "#dc2626" }}>{tr("doctor.loadFailed", { message: error })}</p>
              )}

              {/* 固定 info 条目:大陆网络合规提示(指南 8.3 原文措辞) */}
              <div className="px-3 py-2 mb-3 rounded-lg flex items-start gap-2" style={{ background: "var(--color-surface-2)" }}>
                <Info size={14} className="shrink-0" style={{ color: "var(--color-ink-subtle)", marginTop: 2 }} />
                <p className="m-0 text-[12px] text-ink-subtle">{tr("doctor.networkNotice")}</p>
              </div>

              {/* checks 明细(deep 层专属的 9 项摘到下方折叠区,这里只展示 basic/capability) */}
              {(() => {
                const mainChecks = report ? report.checks.filter((c) => !DEEP_CHECK_IDS.has(c.id)) : [];
                if (!report || mainChecks.length === 0) {
                  return <p className="m-0 mb-4 text-[12px] text-ink-subtle">{tr("doctor.empty")}</p>;
                }
                return (
                  <div className="flex flex-col gap-1.5 mb-4">
                    {mainChecks.map((c) => <CheckRow key={c.id} c={c} nameKeys={CHECK_NAME_KEYS} tr={tr} />)}
                  </div>
                );
              })()}

              {/* E5:深度体检——可折叠区,点击"运行深度体检"才真正触发 deep run(联网+探测,更慢)。 */}
              <div className="mb-4 rounded-lg overflow-hidden" style={{ border: "1px solid var(--color-hairline)" }}>
                <button
                  onClick={() => setDeepOpen((v) => !v)}
                  className="w-full px-3 py-2 flex items-center gap-2 border-none cursor-pointer text-left"
                  style={{ background: "var(--color-surface-2)" }}
                >
                  <ChevronRight size={13} className="shrink-0 text-ink-subtle transition-transform" style={{ transform: deepOpen ? "rotate(90deg)" : undefined }} />
                  <Wrench size={13} className="shrink-0 text-ink-subtle" />
                  <span className="text-[13px] font-medium text-ink">{tr("doctor.deep.title")}</span>
                  {report?.level === "deep" && (
                    <span className="ml-auto text-[11px] text-ink-subtle">
                      {tr("doctor.checkedAt", { time: new Date(report.checked_at).toLocaleString() })}
                    </span>
                  )}
                </button>
                {deepOpen && (
                  <div className="px-3 py-2.5" style={{ background: "var(--color-surface-1)" }}>
                    <p className="m-0 mb-2.5 text-[12px] text-ink-subtle">{tr("doctor.deep.description")}</p>
                    {report?.level === "deep" ? (
                      <div className="flex flex-col gap-1.5 mb-2.5">
                        {report.checks.filter((c) => DEEP_CHECK_IDS.has(c.id)).map((c) => (
                          <CheckRow key={c.id} c={c} nameKeys={DEEP_CHECK_NAME_KEYS} tr={tr} />
                        ))}
                      </div>
                    ) : null}
                    <button onClick={() => void rerun("deep")} disabled={running} className="btn-secondary"
                      style={running ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
                      <span className="inline-flex items-center gap-1.5">
                        <Wrench size={13} className={running ? "animate-spin" : undefined} />
                        {running ? tr("doctor.running") : (report?.level === "deep" ? tr("doctor.deep.rerun") : tr("doctor.deep.run"))}
                      </span>
                    </button>
                  </div>
                )}
              </div>

              {/* 操作:重跑 basic / capability(联网,慢) */}
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void rerun("basic")} disabled={running} className="btn-primary"
                  style={running ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
                  <span className="inline-flex items-center gap-1.5">
                    <RefreshCw size={13} className={running ? "animate-spin" : undefined} />
                    {running ? tr("doctor.running") : tr("doctor.rerun")}
                  </span>
                </button>
                <button onClick={() => void rerun("capability")} disabled={running} className="btn-secondary"
                  style={running ? { opacity: 0.45, cursor: "not-allowed" } : undefined}>
                  <span className="inline-flex items-center gap-1.5">
                    <Globe size={13} />
                    {tr("doctor.rerunCapability")}
                  </span>
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
