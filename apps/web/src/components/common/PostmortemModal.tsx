import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { AlertTriangle, RotateCcw, Network, BookmarkPlus, BookmarkCheck, ScrollText, X } from "lucide-react";
import { useT } from "../../i18n.js";
import { pushToast } from "./Toast.js";
import * as api from "../../api/client.js";

// Track C · C1 失败复盘卡:run 失败/降级时弹出的结构化复盘 modal。
// 数据契约本地镜像 apps/server/src/runtime/failurePostmortem.ts 的 Postmortem 形状
// (不跨包引入 server 内部类型,与 api/client.ts 的 MissionBrief 等既有做法一致)。
// causes/suggestions 的文本是服务端派生的诊断数据;本组件自己的 UI 文案全部走 i18n。
// #32:服务端同时给结构化 messageKey/params(postmortem.cause.*)与 suggestionItems
// (postmortem.suggestion.*),有键按词典渲染;旧数据/旧服务端没有键 → 回退服务端原文。
export interface PostmortemCause { kind: string; message: string; evidence?: string; messageKey?: string; params?: Record<string, string> }
export interface PostmortemSuggestionItem { key: string; params?: Record<string, string>; text: string }
export interface PostmortemAction { id: "retry" | "replan" | "save_lesson" | "view_logs"; label: string }
export interface PostmortemData {
  runId: string;
  available: boolean;
  title: string;
  goal?: string;
  companyId?: string;
  causes: PostmortemCause[];
  suggestions: string[];
  suggestionItems?: PostmortemSuggestionItem[];
  actions: PostmortemAction[];
}

// 会话级"不再自动弹出"开关(App.tsx 的 run_finished 分支在自动弹之前读它)。
export const POSTMORTEM_MUTE_KEY = "opc-postmortem-muted";
export function isPostmortemMuted(): boolean {
  try { return sessionStorage.getItem(POSTMORTEM_MUTE_KEY) === "1"; } catch { return false; }
}

const KIND_KEYS = new Set([
  "provider_key", "provider_unavailable", "no_account", "timeout",
  "quality_gate_failed", "budget_exhausted", "artifact_rejected", "degraded", "run_failed",
]);

// 词典里实际存在的结构化键(与 i18n.dict.json 的 postmortem.cause.*/postmortem.suggestion.* 同步);
// 服务端给了不认识的键不硬渲染(会露出原始 key),回退原文。
export const CAUSE_MSG_KEYS = new Set([
  "provider_key", "provider_key_likely", "provider_unavailable", "no_account", "timeout",
  "quality_gate_failed", "budget_exhausted", "artifact_rejected", "degraded", "run_failed",
]);
export const SUGGESTION_KEYS = new Set([
  "configure_key", "switch_provider", "provider_unavailable", "no_account", "timeout",
  "quality_gate_failed", "budget_exhausted", "artifact_rejected", "degraded", "run_failed",
]);

export function causeText(c: PostmortemCause, tr: (key: string, params?: Record<string, string | number>) => string): string {
  return c.messageKey && CAUSE_MSG_KEYS.has(c.messageKey) ? tr(`postmortem.cause.${c.messageKey}`, c.params) : c.message;
}

const ACTION_ICONS: Record<PostmortemAction["id"], typeof RotateCcw> = {
  retry: RotateCcw,
  replan: Network,
  save_lesson: BookmarkPlus,
  view_logs: ScrollText,
};

export default function PostmortemModal({ postmortem, onClose }: { postmortem: PostmortemData; onClose: () => void }) {
  const tr = useT();
  const [dispatching, setDispatching] = useState(false);
  const [savingLesson, setSavingLesson] = useState(false);
  const [lessonSaved, setLessonSaved] = useState(false);
  const [muted, setMuted] = useState(isPostmortemMuted());

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggleMuted = (v: boolean) => {
    setMuted(v);
    try { sessionStorage.setItem(POSTMORTEM_MUTE_KEY, v ? "1" : "0"); } catch { /* ignore */ }
  };

  // 重试/重拆都复用现有派发入口 api.chatTask(POST /api/chat/task)——与 BriefingPanel 派发任务同一条路,
  // 不新建派发逻辑。重拆在原目标前加"请重新拆解"前缀,交给 CEO 重新编排。
  const dispatch = async (message: string) => {
    if (dispatching) return;
    setDispatching(true);
    try {
      const r = await api.chatTask(message, postmortem.companyId ? { companyId: postmortem.companyId } : undefined);
      if (r.approvalRequired) {
        // L3 网关拦下:run 是 pending 不是已派发——如实提示待审批,并通知简报栏刷新审批卡。
        pushToast("info", tr("governance.awaitingApproval", { id: r.runId.slice(0, 8) }));
        window.dispatchEvent(new CustomEvent("governance-approval-requested", { detail: { runId: r.runId } }));
      } else {
        pushToast("success", tr("postmortem.retryDispatched", { id: r.runId.slice(0, 8) }));
      }
      onClose();
    } catch (e) {
      pushToast("error", tr("postmortem.dispatchFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setDispatching(false);
    }
  };

  // C1 / P2#7(用户拍板)· 加入经验库:调 POST /api/memory/lessons 创建**提案**(asProposal:true → proposed),
  // 去记忆页审批后才生效——不在失败卡上直写 approved/committed 记忆(基础设施/治理故障的复盘未经审批不该生效)。
  // content = 首条 cause 的 message(+evidence)+ run 上下文;带 runId 使其记进该 run 的记忆提案台账。
  const saveLesson = async () => {
    if (savingLesson || lessonSaved) return;
    setSavingLesson(true);
    try {
      const cause = postmortem.causes[0];
      const content = [
        cause?.message || postmortem.title,
        cause?.evidence,
        tr("postmortem.lessonContext", { goal: postmortem.goal || postmortem.title, id: postmortem.runId.slice(0, 8) }),
      ].filter(Boolean).join("\n");
      const saved = await api.post<{ status?: string }>("/memory/lessons", {
        content,
        runId: postmortem.runId,
        ...(postmortem.companyId ? { scope: { companyId: postmortem.companyId } } : {}),
        tags: ["postmortem", ...(cause?.kind ? [cause.kind] : [])],
        asProposal: true, // P2#7:失败复盘只建 proposed 提案,去记忆页审批(不直写 approved)
      });
      setLessonSaved(true);
      // P2#5(用户审计)· 提示按【真实返回状态】:同 dedupe key 已存在 committed 经验时 store 保持 committed
      // (不降级,见 addManualLesson),此时并未新建提案——文案必须说"已更新既有经验",不能谎报"已提交提案"。
      pushToast("success", tr(saved?.status === "committed" ? "postmortem.lessonUpdatedExisting" : "postmortem.lessonProposed"));
    } catch (e) {
      pushToast("error", tr("postmortem.lessonSaveFailed", { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingLesson(false);
    }
  };

  const runAction = (id: PostmortemAction["id"]) => {
    switch (id) {
      case "retry":
        if (postmortem.goal) void dispatch(postmortem.goal);
        break;
      case "replan":
        if (postmortem.goal) void dispatch(`${tr("postmortem.replanPrefix")}${postmortem.goal}`);
        break;
      case "view_logs":
        window.dispatchEvent(new CustomEvent("open-task-run", { detail: { runId: postmortem.runId } }));
        onClose();
        break;
      case "save_lesson":
        void saveLesson();
        break;
    }
  };

  const actionLabel: Record<PostmortemAction["id"], string> = {
    retry: tr("postmortem.retry"),
    replan: tr("postmortem.replan"),
    save_lesson: tr("postmortem.saveLesson"),
    view_logs: tr("postmortem.viewLogs"),
  };

  const actions = postmortem.actions.length
    ? postmortem.actions
    : (["retry", "replan", "save_lesson", "view_logs"] as const).map((id) => ({ id, label: actionLabel[id] }));

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="modal-overlay z-[10005]"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.2 }}
        className="p-5 w-[520px] max-w-[92vw] max-h-[80vh] overflow-y-auto"
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
          <AlertTriangle size={22} style={{ color: "#dc2626", marginTop: 2 }} className="shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="m-0 text-[15px] font-semibold tracking-tight text-ink">{tr("postmortem.header")}</p>
            <p className="m-0 mt-0.5 text-[12px] text-ink-subtle">
              {postmortem.title} · run {postmortem.runId.slice(0, 8)}
            </p>
          </div>
          <button onClick={onClose} title={tr("common.close")}
            className="w-7 h-7 flex items-center justify-center rounded-md border-none bg-transparent text-ink-muted cursor-pointer hover:bg-surface-2 hover:text-ink transition-colors shrink-0">
            <X size={15} />
          </button>
        </div>

        {/* 原因清单 */}
        {postmortem.causes.length > 0 && (
          <div className="mb-3">
            <p className="m-0 mb-1.5 text-[12px] font-medium text-ink-muted">{tr("postmortem.causes")}</p>
            <div className="flex flex-col gap-1.5">
              {postmortem.causes.map((c, i) => (
                <div key={i} className="px-3 py-2 rounded-lg" style={{ background: "var(--color-surface-2)" }}>
                  <div className="flex items-center gap-2">
                    <span className="px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0"
                      style={{ background: "rgba(220,38,38,0.12)", color: "#dc2626" }}>
                      {KIND_KEYS.has(c.kind) ? tr(`postmortem.kind.${c.kind}`) : c.kind}
                    </span>
                    <span className="text-[13px] text-ink">{causeText(c, tr)}</span>
                  </div>
                  {c.evidence && (
                    <p className="m-0 mt-1 text-[11px] font-mono text-ink-subtle break-all">{c.evidence}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 系统建议(#32:优先按 suggestionItems 的词典键渲染,旧数据回退 suggestions 原文) */}
        {(() => {
          const texts = postmortem.suggestionItems?.length
            ? postmortem.suggestionItems.map(s => (SUGGESTION_KEYS.has(s.key) ? tr(`postmortem.suggestion.${s.key}`, s.params) : s.text))
            : postmortem.suggestions;
          return texts.length > 0 && (
            <div className="mb-4">
              <p className="m-0 mb-1.5 text-[12px] font-medium text-ink-muted">{tr("postmortem.suggestions")}</p>
              <ul className="m-0 pl-4 flex flex-col gap-1">
                {texts.map((s, i) => (
                  <li key={i} className="text-[13px] text-ink-muted">{s}</li>
                ))}
              </ul>
            </div>
          );
        })()}

        {/* 四个操作 */}
        <div className="flex flex-wrap gap-2 mb-3">
          {actions.map((a) => {
            const saved = a.id === "save_lesson" && lessonSaved;
            const Icon = saved ? BookmarkCheck : (ACTION_ICONS[a.id] ?? RotateCcw);
            const needsGoal = a.id === "retry" || a.id === "replan";
            const disabled = (a.id === "save_lesson" && (savingLesson || lessonSaved))
              || (needsGoal && (!postmortem.goal || dispatching));
            return (
              <button
                key={a.id}
                onClick={() => runAction(a.id)}
                disabled={disabled}
                className={a.id === "retry" ? "btn-primary" : "btn-secondary"}
                style={disabled ? { opacity: saved ? 0.7 : 0.45, cursor: saved ? "default" : "not-allowed" } : undefined}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Icon size={13} />
                  {saved ? tr("postmortem.lessonSaved") : (actionLabel[a.id] ?? a.label)}
                </span>
              </button>
            );
          })}
        </div>

        {/* 会话级"不再自动弹出"开关 */}
        <label className="flex items-center gap-1.5 text-[12px] text-ink-subtle cursor-pointer select-none">
          <input type="checkbox" checked={muted} onChange={(e) => toggleMuted(e.target.checked)} />
          {tr("postmortem.noAutoShow")}
        </label>
      </motion.div>
    </motion.div>
  );
}
