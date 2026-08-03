import { useState } from "react";
import { Wand2, X, Loader2, AlertTriangle, CheckCircle2, Sparkles, ShieldAlert } from "lucide-react";
import type { CompanyEditProposal, CompanyEditValidationReport } from "@opc/shared";
import * as api from "../../api/client.js";
import { useT } from "../../i18n.js";
import { describeCompanyEditOp } from "../../lib/companyEditOps.js";
import { draftToEditTarget, applyEditTargetToDraft } from "./aiEditBridge.js";
import type { WorkshopDraft } from "./workshopTypes.js";

// D7 · TemplateWorkshop 的"AI 辅助编辑"入口(指南 11.11):自然语言 → AI 出 CompanyEditProposal →
// Studio Core 校验 + 生成 diff preview → 用户确认 → apply,四步严格按顺序走,AI 从不直接改草稿
// (每一步都是独立的 HTTP 请求,前端拿到 apply 的结果后才真正调用 onApply 落进 draft state)。
type Stage = "input" | "reviewing" | "applying" | "applied";

// 令三.4· 高危二次确认门:428 解包/文案映射抽到 lib/highRisk.ts(活公司侧 ArchitectChatPanel 共用)。
import { describeHighRisk, extractHighRisk, extractConfirmationToken, type HighRiskFlag } from "../../lib/highRisk.js";

export default function AiEditPanel({
  draft, onApply, onClose,
}: {
  draft: WorkshopDraft;
  onApply: (next: WorkshopDraft) => void;
  onClose: () => void;
}) {
  const tr = useT();
  const [message, setMessage] = useState("");
  const [stage, setStage] = useState<Stage>("input");
  const [proposing, setProposing] = useState(false);
  const [proposal, setProposal] = useState<CompanyEditProposal | null>(null);
  const [validation, setValidation] = useState<CompanyEditValidationReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  // C11 rollback:apply 成功后记住这次的 proposal_id 与撤销所需的"落地前草稿快照",支持一键撤销。
  const [appliedProposalId, setAppliedProposalId] = useState<string | null>(null);
  const [draftBefore, setDraftBefore] = useState<WorkshopDraft | null>(null);
  const [rollingBack, setRollingBack] = useState(false);
  // 令三.4· 高危二次确认:非 null 时弹确认层,列出每条高危 op 明细 + 后端签发的一次性 token,用户确认后
  // 带该 token 重发(替换旧的客户端布尔 confirmHighRisk)。
  const [highRiskFlags, setHighRiskFlags] = useState<HighRiskFlag[] | null>(null);
  const [confirmToken, setConfirmToken] = useState<string | null>(null);
  // 令三.5· rollback 守卫:撤销时携带当前草稿,服务端判定草稿已被后续改过 → 409,提示"目标已被后续修改,
  // 请重新审阅"并终止(无强制撤销绕过路径)。
  const [rollbackConflict, setRollbackConflict] = useState(false);

  const handlePropose = async () => {
    if (!message.trim() || proposing) return;
    setProposing(true); setError(null);
    try {
      const target = draftToEditTarget(draft);
      const proposeRes = await api.post<{ proposal: CompanyEditProposal }>("/company-architect/proposal", { target, message: message.trim() });
      const validateRes = await api.post<CompanyEditValidationReport>("/company-architect/validate", {
        target, operations: proposeRes.proposal.operations,
      });
      setProposal(proposeRes.proposal);
      setValidation(validateRes);
      setStage("reviewing");
    } catch (e) {
      setError((e as Error).message || tr("cae.proposeFail"));
    } finally {
      setProposing(false);
    }
  };

  // 令三.4· confirmation token:首次不带,命中高危 → 428 返回一次性 token,弹二次确认层;用户确认后带该
  // token 重发。重放/过期/换 operations 会 428 重签,直接用新 token 覆盖。
  const handleApply = async (confirmationToken?: string) => {
    if (!proposal || !validation?.apply_allowed || stage === "applying") return;
    setStage("applying"); setError(null);
    try {
      const target = draftToEditTarget(draft);
      const applyRes = await api.post<{ target: typeof target; results: unknown; warnings: string[] }>("/company-architect/apply", {
        target, operations: proposal.operations, proposalId: proposal.proposal_id,
        ...(confirmationToken ? { confirmationToken } : {}),
      });
      setHighRiskFlags(null); setConfirmToken(null);
      setDraftBefore(draft);               // 落地前草稿快照(撤销时原样恢复)
      setAppliedProposalId(proposal.proposal_id);
      onApply(applyEditTargetToDraft(applyRes.target, draft));
      setStage("applied");
    } catch (e) {
      // 高危门:命中 428 → 取出高危清单 + 后端签发的一次性 token 弹二次确认层,回到 reviewing 态等用户拍板。
      if ((e as api.ApiError)?.status === 428) {
        const flags = extractHighRisk(e);
        const token = extractConfirmationToken(e);
        if (flags && token) { setHighRiskFlags(flags); setConfirmToken(token); setStage("reviewing"); return; }
      }
      setError((e as Error).message || tr("cae.applyFail"));
      setStage("reviewing");
    }
  };

  // C11 rollback:撤销本次 AI 修改——调撤销端点标记 rolled_back,并把落地前的草稿快照原样恢复。
  // 令三.5:必带 currentTarget(当前草稿),服务端据 hash 判定草稿是否已被后续改过;不符 → 409,前端提示
  // "目标已被后续修改,请重新审阅"并终止(无 force 绕过路径)。
  const handleRollback = async () => {
    if (!appliedProposalId || rollingBack) return;
    setRollingBack(true); setError(null);
    try {
      await api.post("/company-architect/rollback", {
        proposalId: appliedProposalId,
        currentTarget: draftToEditTarget(draft),
      });
      if (draftBefore) onApply(draftBefore);
      onClose();
    } catch (e) {
      if ((e as api.ApiError)?.status === 409) {
        setRollbackConflict(true);
        return;
      }
      setError((e as Error).message || tr("cae.rollbackFail"));
    } finally {
      setRollingBack(false);
    }
  };

  const reset = () => { setProposal(null); setValidation(null); setError(null); setHighRiskFlags(null); setConfirmToken(null); setStage("input"); };

  // 按下标匹配,不用引用相等:proposal.operations 和 validation.opResults 是两次独立的 HTTP 往返
  // (分别来自 /proposal、/validate 两个请求的 JSON 响应体),同一条 operation 反序列化出来的对象
  // 不是同一个引用——但两边数组顺序严格一致(validate 请求就是原样传回 proposal.operations),
  // 按下标对应是可靠的。
  const opResult = (i: number) => validation?.opResults[i];

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[1500]">
      <div className="bg-bg-primary rounded-2xl w-[92vw] max-w-[640px] max-h-[86vh] flex flex-col overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border bg-bg-card shrink-0">
          <div className="flex items-center gap-2">
            <Wand2 size={17} className="text-accent" />
            <b className="text-[15px] text-text-primary">{tr("cae.title")}</b>
          </div>
          <button onClick={onClose} className="border-none bg-transparent cursor-pointer text-text-muted hover:text-text-primary transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 flex flex-col gap-3.5">
          {stage === "input" && (
            <>
              <p className="text-[13px] text-text-secondary m-0">{tr("cae.hint")}</p>
              <textarea
                value={message} onChange={e => setMessage(e.target.value)}
                rows={4} placeholder={tr("cae.messagePh")}
                className="w-full border border-border rounded-md px-2.5 py-1.5 text-[13px] box-border resize-y outline-none bg-bg-card focus:border-accent"
              />
              {error && <div className="text-[13px] text-red">{error}</div>}
            </>
          )}

          {stage === "applied" && (
            <>
              <div className="rounded-lg border border-green/40 bg-green/10 p-3 flex items-center gap-2">
                <CheckCircle2 size={15} className="text-green shrink-0" />
                <span className="text-[13px] text-text-primary">{tr("cae.appliedOk")}</span>
              </div>
              {rollbackConflict && (
                <div className="rounded-lg border border-amber/40 bg-amber/10 p-3 flex items-start gap-2">
                  <AlertTriangle size={14} className="text-amber shrink-0 mt-0.5" />
                  <span className="text-[13px] text-text-secondary">{tr("cae.rollbackConflict")}</span>
                </div>
              )}
              {error && <div className="text-[13px] text-red">{error}</div>}
            </>
          )}

          {(stage === "reviewing" || stage === "applying") && proposal && validation && (
            <>
              <div className="rounded-lg border border-border bg-bg-card p-3">
                <div className="flex items-center gap-1.5 text-[13px] text-text-primary font-medium mb-1">
                  <Sparkles size={13} className="text-accent" /> {tr("cae.summary")}
                </div>
                <p className="text-[13px] text-text-secondary m-0">{proposal.summary}</p>
              </div>

              {proposal.risks.length > 0 && (
                <div className="rounded-lg border border-amber/40 bg-amber/10 p-3">
                  <div className="flex items-center gap-1.5 text-[13px] text-amber font-medium mb-1">
                    <AlertTriangle size={13} /> {tr("cae.risks")}
                  </div>
                  <ul className="m-0 pl-4 flex flex-col gap-0.5">
                    {proposal.risks.map((r, i) => <li key={i} className="text-[12px] text-text-secondary">{r}</li>)}
                  </ul>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <div className="text-[13px] text-text-primary font-medium">{tr("cae.diffTitle")}</div>
                {proposal.operations.map((op, i) => {
                  const r = opResult(i);
                  return (
                    <div key={i} className={`flex items-start gap-2 px-2.5 py-1.5 rounded-md text-[12px] ${r?.ok ? "bg-bg-card" : "bg-red/10"}`}>
                      {r?.ok ? <CheckCircle2 size={13} className="text-green shrink-0 mt-0.5" /> : <AlertTriangle size={13} className="text-red shrink-0 mt-0.5" />}
                      <span className="text-text-secondary">
                        {describeCompanyEditOp(op, tr)}
                        {r?.reason && <span className={r.ok ? "text-text-muted" : "text-red"}> — {r.reason}</span>}
                      </span>
                    </div>
                  );
                })}
              </div>

              {validation.errors.length > 0 && (
                <div className="rounded-lg border border-red/40 bg-red/10 p-3">
                  <div className="text-[13px] text-red font-medium mb-1">{tr("cae.blockingErrors")}</div>
                  <ul className="m-0 pl-4 flex flex-col gap-0.5">
                    {validation.errors.map((e, i) => <li key={i} className="text-[12px] text-red">{e}</li>)}
                  </ul>
                </div>
              )}
              {validation.warnings.length > 0 && (
                <div className="rounded-lg border border-amber/40 bg-amber/10 p-3">
                  <div className="text-[13px] text-amber font-medium mb-1">{tr("cae.warnings")}</div>
                  <ul className="m-0 pl-4 flex flex-col gap-0.5">
                    {validation.warnings.map((w, i) => <li key={i} className="text-[12px] text-text-secondary">{w}</li>)}
                  </ul>
                </div>
              )}
              {error && <div className="text-[13px] text-red">{error}</div>}
            </>
          )}
        </div>

        <div className="flex items-center gap-3 justify-end px-5 py-3.5 border-t border-border bg-bg-card shrink-0">
          {stage === "input" && (
            <>
              <button onClick={onClose} className="btn-secondary">{tr("common.cancel")}</button>
              <button onClick={handlePropose} disabled={!message.trim() || proposing}
                className="inline-flex items-center gap-1.5 btn-primary">
                {proposing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                {proposing ? tr("cae.proposing") : tr("cae.generate")}
              </button>
            </>
          )}
          {(stage === "reviewing" || stage === "applying") && (
            <>
              <button onClick={reset} disabled={stage === "applying"} className="btn-secondary">{tr("cae.back")}</button>
              <button onClick={() => handleApply()} disabled={!validation?.apply_allowed || stage === "applying"}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 border-none rounded-full text-white text-[13px] font-medium ${!validation?.apply_allowed || stage === "applying" ? "bg-border-light cursor-not-allowed" : "bg-green cursor-pointer hover:opacity-90"}`}>
                {stage === "applying" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
                {stage === "applying" ? tr("cae.applying") : tr("cae.confirmApply")}
              </button>
            </>
          )}
          {stage === "applied" && (
            <>
              {/* 令三.5:目标已被后续修改(409)→ 只提示重新审阅,不再提供强制撤销;否则展示撤销按钮。 */}
              {!rollbackConflict && (
                <button onClick={() => handleRollback()} disabled={rollingBack} className="btn-secondary inline-flex items-center gap-1.5">
                  {rollingBack && <Loader2 size={14} className="animate-spin" />}
                  {tr("cae.rollback")}
                </button>
              )}
              <button onClick={onClose} disabled={rollingBack} className="inline-flex items-center gap-1.5 btn-primary">
                {tr("common.close")}
              </button>
            </>
          )}
        </div>
      </div>

      {/* C(波4)· 高危二次确认层:列出每条高危 op 明细(删除员工 X / 变更 A2A / 权限扩大…),
          用户明确确认后带后端签发的一次性 confirmationToken 重发;取消则回到 reviewing 态(不落地)。 */}
      {highRiskFlags && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1600]">
          <div className="bg-bg-primary rounded-2xl w-[90vw] max-w-[480px] flex flex-col overflow-hidden shadow-2xl border border-red/40">
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-border bg-red/10 shrink-0">
              <ShieldAlert size={17} className="text-red" />
              <b className="text-[15px] text-text-primary">{tr("cae.highRisk.title")}</b>
            </div>
            <div className="p-5 flex flex-col gap-3">
              <p className="text-[13px] text-text-secondary m-0">{tr("cae.highRisk.desc")}</p>
              <ul className="m-0 pl-0 flex flex-col gap-1.5 list-none">
                {highRiskFlags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-red/10 text-[13px] text-text-primary">
                    <AlertTriangle size={13} className="text-red shrink-0 mt-0.5" />
                    <span>
                      {describeHighRisk(f, tr)}
                      {f.kind === "permission_expansion" && f.detail && <span className="text-text-muted"> — {f.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-3 justify-end px-5 py-3.5 border-t border-border bg-bg-card shrink-0">
              <button onClick={() => { setHighRiskFlags(null); setConfirmToken(null); setStage("reviewing"); }} disabled={stage === "applying"} className="btn-secondary">{tr("common.cancel")}</button>
              <button onClick={() => handleApply(confirmToken ?? undefined)} disabled={stage === "applying" || !confirmToken}
                className={`inline-flex items-center gap-1.5 px-4 py-1.5 border-none rounded-full text-white text-[13px] font-medium ${stage === "applying" ? "bg-border-light cursor-not-allowed" : "bg-red cursor-pointer hover:opacity-90"}`}>
                {stage === "applying" ? <Loader2 size={14} className="animate-spin" /> : <ShieldAlert size={14} />}
                {tr("cae.highRisk.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
