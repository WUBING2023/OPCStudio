import { useEffect, useMemo, useState, useCallback } from "react";
import { motion } from "framer-motion";
import {
  X, Building2, Plus, Trash2, RefreshCw, ArrowRight, ArrowUpRight,
  CheckCircle2, AlertTriangle, XCircle, KeyRound, TerminalSquare, Plug, Sparkles,
} from "lucide-react";
import type { Company, AgentNodeConfig, VerificationEdge, VerificationMethod, CapabilityReport, CapabilityReportItem } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { ROLE_COLORS, ROLE_LABELS, STATUS_COLORS, NEUTRAL_GRAY, statusLabel } from "../../lib/agentMeta.js";
import { pushToast } from "../common/Toast.js";
import HelpTip from "../HelpTip.js";

const METHODS: VerificationMethod[] = ["fact-check", "llm-review", "code-review", "custom"];

function methodLabel(tr: (k: string, p?: Record<string, string | number>) => string, m: string): string {
  if (m === "fact-check") return tr("org.panel.method.factCheck");
  if (m === "llm-review") return tr("org.panel.method.llmReview");
  if (m === "code-review") return tr("org.panel.method.codeReview");
  return tr("org.panel.method.custom");
}

const CAP_ICON: Record<CapabilityReportItem["kind"], typeof KeyRound> = {
  provider: KeyRound, cli: TerminalSquare, mcp: Plug, skill: Sparkles,
};

const ROLE_RANK: Record<string, number> = { ceo: 0, lead: 1 };

interface EdgeRow extends VerificationEdge { _key: string; }
function genKey(): string {
  try { return crypto.randomUUID(); } catch { return `edge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

// 公司管理面板——"活体运营"视图(区别于模板工坊的发布/打包):基本信息 + 成员表(跳组织图编辑,
// 不重实现节点编辑)+ 验证边(交叉验证链增删改)+ 能力边界报告(现成 capability-report 端点消费方)。
// 独立 modal 覆盖层,不与 AgentDetailsPanel/BriefingPanel 抢位置。
export default function CompanyPanel({
  company, agents, onClose, onOpenAgent, onCompanyUpdated,
}: {
  company: Company;
  agents: AgentNodeConfig[];
  onClose: () => void;
  onOpenAgent: (agentId: string) => void;
  onCompanyUpdated: (updated: Company) => void;
}) {
  const tr = useT();

  // ── 基本信息:inline 输入失焦保存 ──
  const [name, setName] = useState(company.name);
  const [description, setDescription] = useState(company.description ?? "");
  useEffect(() => { setName(company.name); setDescription(company.description ?? ""); }, [company.id, company.name, company.description]);

  const patchCompany = useCallback(async (patch: Partial<Company>) => {
    try {
      const updated = await api.patch<Company>(`/companies/${company.id}`, patch);
      onCompanyUpdated(updated);
    } catch (e: any) {
      pushToast("error", tr("org.panel.saveFailed") + (e.message || ""));
    }
  }, [company.id, onCompanyUpdated, tr]);

  // ── 成员表:CEO/Lead 优先,其余按名字排序;点击跳组织图对应节点 ──
  const members = useMemo(
    () => agents
      .filter(a => (a.companyId || "default") === company.id)
      .sort((a, b) => (ROLE_RANK[a.role] ?? 2) - (ROLE_RANK[b.role] ?? 2) || a.name.localeCompare(b.name)),
    [agents, company.id],
  );
  const roleOptions = useMemo(() => {
    const set = new Set<string>(members.map(a => a.role));
    return ["*", ...Array.from(set)];
  }, [members]);

  // ── 验证边:本地草稿 + 显式保存(多字段联动编辑,不做每键 PATCH) ──
  const [edges, setEdges] = useState<EdgeRow[]>(() =>
    (company.workflow?.verificationEdges ?? []).map(e => ({ ...e, _key: genKey() })));
  const [edgesDirty, setEdgesDirty] = useState(false);
  const [savingEdges, setSavingEdges] = useState(false);
  useEffect(() => {
    setEdges((company.workflow?.verificationEdges ?? []).map(e => ({ ...e, _key: genKey() })));
    setEdgesDirty(false);
  }, [company.id]); // eslint-disable-line react-hooks/exhaustive-deps -- 仅切公司时重置草稿,保存回写走 onCompanyUpdated 而非本 effect

  const updateEdge = (key: string, patch: Partial<VerificationEdge>) => {
    setEdges(prev => prev.map(e => (e._key === key ? { ...e, ...patch } : e)));
    setEdgesDirty(true);
  };
  const addEdge = () => {
    const fallback = roleOptions[1] ?? "*";
    setEdges(prev => [...prev, { _key: genKey(), producer: fallback, verifier: fallback, method: "llm-review", onReject: "flag" }]);
    setEdgesDirty(true);
  };
  const removeEdge = (key: string) => {
    setEdges(prev => prev.filter(e => e._key !== key));
    setEdgesDirty(true);
  };
  const saveEdges = async () => {
    setSavingEdges(true);
    try {
      const payload = edges.map(({ _key, ...rest }) => rest);
      const updated = await api.patch<Company>(`/companies/${company.id}`, { workflow: { verificationEdges: payload } });
      onCompanyUpdated(updated);
      setEdgesDirty(false);
      pushToast("success", tr("org.panel.edgesSaved"));
    } catch (e: any) {
      pushToast("error", tr("org.panel.edgesSaveFailed") + (e.message || ""));
    } finally {
      setSavingEdges(false);
    }
  };

  // ── 能力边界报告:async 引擎探针(~1-3s),开面板时自动拉一次 + 手动刷新 ──
  const [report, setReport] = useState<CapabilityReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportNonce, setReportNonce] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setReportLoading(true);
    setReportError(null);
    api.get<CapabilityReport>(`/companies/${company.id}/capability-report`)
      .then(r => { if (!cancelled) setReport(r); })
      .catch(e => { if (!cancelled) setReportError(e.message || "error"); })
      .finally(() => { if (!cancelled) setReportLoading(false); });
    return () => { cancelled = true; };
  }, [company.id, reportNonce]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.2 }}
        className="w-[820px] max-w-[92vw] max-h-[86vh] flex flex-col overflow-hidden"
        style={{ background: "var(--color-surface-1)", border: "1px solid var(--color-hairline)", borderRadius: 14, boxShadow: "var(--shadow-lg)" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-hairline shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Building2 size={16} className="text-accent shrink-0" />
            <span className="text-[15px] font-semibold text-ink truncate">{company.name || tr("org.defaultCompany")}</span>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-ink-muted hover:bg-surface-2 hover:text-ink transition-colors bg-transparent border-none cursor-pointer shrink-0">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-5">
          {/* 1 · 基本信息 */}
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted mb-3">{tr("org.panel.basicInfo")}</div>
            <div className="flex flex-col gap-3">
              <div>
                <label className="input-label">{tr("org.companyName")}</label>
                <input value={name} onChange={e => setName(e.target.value)}
                  onBlur={() => { const v = name.trim(); if (v && v !== company.name) patchCompany({ name: v }); else setName(company.name); }}
                  onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                  className="border-0 border-b-2 border-hairline bg-transparent text-[14px] py-1.5 w-full outline-none focus:border-accent transition-colors text-ink" />
              </div>
              <div>
                <label className="input-label">{tr("org.companyDesc")}</label>
                <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
                  onBlur={() => { if (description !== (company.description ?? "")) patchCompany({ description }); }}
                  className="border border-hairline rounded-lg bg-transparent text-[13px] p-2 w-full outline-none focus:border-accent transition-colors text-ink resize-none" />
              </div>
              <div>
                <label className="input-label">{tr("org.panel.createdAt")}</label>
                <div className="text-[13px] text-ink-muted">{new Date(company.createdAt).toLocaleString()}</div>
              </div>
            </div>
          </div>

          <div className="section-divider" />

          {/* 2 · 成员表 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                {tr("org.panel.members")}
                <HelpTip text={tr("org.panel.openInOrgHint")} />
              </div>
              <span className="text-[11px] text-ink-subtle">{tr("org.memberCount", { n: members.length })}</span>
            </div>
            {members.length === 0 ? (
              <div className="text-[12px] text-ink-muted py-3">{tr("org.panel.noMembers")}</div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {members.map(a => (
                  <button key={a.id} onClick={() => onOpenAgent(a.id)}
                    className="flex items-center gap-3 p-2.5 rounded-lg border border-hairline bg-surface-0 hover:border-accent/40 hover:bg-surface-2 transition-colors text-left cursor-pointer w-full">
                    <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-[12px] font-semibold"
                      style={{
                        background: `color-mix(in srgb, ${ROLE_COLORS[a.role] ?? NEUTRAL_GRAY} 24%, var(--color-surface-1))`,
                        color: ROLE_COLORS[a.role] ?? NEUTRAL_GRAY,
                      }}>
                      {(a.name || "?").trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-ink truncate">{a.name}</div>
                      <div className="text-[11px] text-ink-subtle truncate">{ROLE_LABELS[a.role] || a.role} · {a.provider}/{a.model}</div>
                    </div>
                    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full shrink-0"
                      style={{ background: (STATUS_COLORS[a.status] ?? NEUTRAL_GRAY) + "1a", color: STATUS_COLORS[a.status] ?? NEUTRAL_GRAY }}>
                      {statusLabel(tr, a.status)}
                    </span>
                    <ArrowUpRight size={13} className="text-ink-subtle shrink-0" />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="section-divider" />

          {/* 3 · 验证边 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">
                {tr("org.panel.verificationEdges")}
                <HelpTip text={tr("org.panel.verificationEdgesHint")} />
              </div>
              <div className="flex items-center gap-2">
                {edgesDirty && (
                  <button onClick={saveEdges} disabled={savingEdges}
                    className="btn-primary px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors">
                    {savingEdges ? "…" : tr("common.save")}
                  </button>
                )}
                <button onClick={addEdge}
                  className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink transition-colors bg-transparent border-none cursor-pointer">
                  <Plus size={12} />{tr("org.panel.addEdge")}
                </button>
              </div>
            </div>

            {edges.length === 0 ? (
              <div className="text-[12px] text-ink-muted py-3">{tr("org.panel.noEdges")}</div>
            ) : (
              <div className="flex flex-col gap-2">
                {edges.map(e => (
                  <div key={e._key} className="flex items-center gap-2 p-2 rounded-lg border border-hairline bg-surface-0 flex-wrap">
                    <select value={e.producer} onChange={ev => updateEdge(e._key, { producer: ev.target.value })}
                      className="border border-hairline rounded-lg px-2 py-1 text-[12px] bg-surface-1 text-ink outline-none focus:border-accent cursor-pointer">
                      {roleOptions.map(r => <option key={r} value={r}>{r === "*" ? tr("org.panel.roleAny") : (ROLE_LABELS[r] || r)}</option>)}
                    </select>
                    <ArrowRight size={12} className="text-ink-subtle shrink-0" />
                    <select value={e.verifier} onChange={ev => updateEdge(e._key, { verifier: ev.target.value })}
                      className="border border-hairline rounded-lg px-2 py-1 text-[12px] bg-surface-1 text-ink outline-none focus:border-accent cursor-pointer">
                      {roleOptions.map(r => <option key={r} value={r}>{r === "*" ? tr("org.panel.roleAny") : (ROLE_LABELS[r] || r)}</option>)}
                    </select>
                    <select value={e.method} onChange={ev => updateEdge(e._key, { method: ev.target.value as VerificationMethod })}
                      className="border border-hairline rounded-lg px-2 py-1 text-[12px] bg-surface-1 text-ink outline-none focus:border-accent cursor-pointer">
                      {METHODS.map(m => <option key={m} value={m}>{methodLabel(tr, m)}</option>)}
                    </select>
                    <select value={e.onReject} onChange={ev => updateEdge(e._key, { onReject: ev.target.value as "redo" | "flag" })}
                      className="border border-hairline rounded-lg px-2 py-1 text-[12px] bg-surface-1 text-ink outline-none focus:border-accent cursor-pointer">
                      <option value="redo">{tr("org.panel.onReject.redo")}</option>
                      <option value="flag">{tr("org.panel.onReject.flag")}</option>
                    </select>
                    <button onClick={() => removeEdge(e._key)} title={tr("common.delete")}
                      className="ml-auto w-7 h-7 rounded-lg flex items-center justify-center text-ink-subtle hover:text-red hover:bg-red/10 transition-colors bg-transparent border-none cursor-pointer shrink-0">
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section-divider" />

          {/* 4 · 能力边界报告 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-muted">{tr("org.panel.capabilityReport")}</div>
              <button onClick={() => setReportNonce(n => n + 1)} disabled={reportLoading}
                className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink disabled:opacity-50 transition-colors bg-transparent border-none cursor-pointer">
                <RefreshCw size={12} className={reportLoading ? "animate-spin" : ""} />
                {tr("org.panel.refreshReport")}
              </button>
            </div>

            {reportLoading && !report && (
              <div className="text-[12px] text-ink-muted py-3">{tr("org.panel.reportLoading")}</div>
            )}
            {reportError && (
              <div className="text-[12px] text-red py-2">{tr("org.panel.reportFailed")}: {reportError}</div>
            )}
            {report && (
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium ${report.canRun ? "bg-green/10 text-green" : "bg-red/10 text-red"}`}>
                    {report.canRun ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                    {report.canRun ? tr("org.panel.canRun") : tr("org.panel.cannotRun")}
                  </span>
                  <span className="text-[11px] text-ink-subtle">{tr("org.panel.generatedAt", { time: new Date(report.generatedAt).toLocaleString() })}</span>
                </div>

                {report.ready.length > 0 && (
                  <div>
                    <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.ready")}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {report.ready.map((it, i) => {
                        const Icon = CAP_ICON[it.kind] || CheckCircle2;
                        return (
                          <span key={i} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] bg-green/10 text-green border border-green/20">
                            <Icon size={11} />{it.name}{it.detail ? ` · ${it.detail}` : ""}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {(report.substituted?.length ?? 0) > 0 && (
                  <div>
                    <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.substituted")}</div>
                    <div className="flex flex-col gap-1.5">
                      {report.substituted.map((s, i) => (
                        <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-accent/20 bg-accent/5">
                          <Sparkles size={13} className="text-accent mt-0.5 shrink-0" />
                          <div className="text-[12px] text-ink">{s.note}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {report.needsAuth.length > 0 && (
                  <div>
                    <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.needsAuth")}</div>
                    <div className="flex flex-col gap-1.5">
                      {report.needsAuth.map((n, i) => {
                        const Icon = CAP_ICON[n.item.kind] || AlertTriangle;
                        return (
                          <div key={i} className="flex items-start gap-2 p-2 rounded-lg border border-amber/20 bg-amber/5">
                            <Icon size={13} className="text-amber mt-0.5 shrink-0" />
                            <div className="min-w-0">
                              <div className="text-[12px] text-ink">
                                {n.item.name}
                                <span className={`ml-1.5 text-[10px] px-1 py-[1px] rounded-full ${n.required ? "bg-red/10 text-red" : "bg-surface-2 text-ink-subtle"}`}>
                                  {n.required ? tr("org.panel.required") : tr("org.panel.optional")}
                                </span>
                              </div>
                              <div className="text-[11px] text-ink-muted mt-0.5">{n.howTo}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {report.authorAnnotated && report.notApplicable.length > 0 && (
                  <div>
                    <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.notApplicable")}</div>
                    <ul className="list-none p-0 m-0 flex flex-col gap-1">
                      {report.notApplicable.map((n, i) => (
                        <li key={i} className="text-[11px] text-ink-subtle">· {n.note}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.suggestedTeam.length > 0 && (
                  <div>
                    <div className="text-[11px] text-ink-muted mb-1.5">{tr("org.panel.suggestedTeam")}</div>
                    <div className="flex flex-col gap-1">
                      {report.suggestedTeam.map(m => (
                        <div key={m.agentId} className="flex items-center gap-2 text-[12px] py-1">
                          {m.readyToRun ? <CheckCircle2 size={13} className="text-green shrink-0" /> : <XCircle size={13} className="text-red shrink-0" />}
                          <span className="text-ink truncate">{m.agentName}</span>
                          <span className="text-ink-subtle text-[11px] shrink-0">{ROLE_LABELS[m.role] || m.role} · {m.provider}/{m.framework}</span>
                          {!m.readyToRun && m.blockedReason && <span className="text-red/80 text-[11px] ml-auto truncate">{m.blockedReason}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </div>
  );
}
