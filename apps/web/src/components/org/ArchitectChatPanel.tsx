import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Bot, Send, MessageCircle, Rocket, ShieldAlert, AlertTriangle } from "lucide-react";
import type { Company } from "@opc/shared";
import * as api from "../../api/client.js";
import type { ArchitectAction, ConversationTurn, TaskDecomposeQuestion, TaskDecomposer } from "../../api/client.js";
import { useT } from "../../i18n.js";
import { useAgentStore } from "../../store/useAgentStore.js";
import MessageBubble, { type MessageBubbleVariant } from "../common/MessageBubble.js";
import DecomposerLine from "../common/DecomposerLine.js";
import ClarifyQuestionnaire from "../common/ClarifyQuestionnaire.js";
import AutoGrowTextarea from "../common/AutoGrowTextarea.js";
import { describeArchitectAction } from "../../lib/architectActions.js";
// C(波4)· 活公司高危二次确认门:/architect-apply 命中删员工/A2A/权限扩大 → 428+{highRisk},
// 与草稿侧 AiEditPanel 共用 lib/highRisk 的形状/文案映射/428 解包。
import { describeHighRisk, extractHighRisk, extractConfirmationToken, type HighRiskFlag } from "../../lib/highRisk.js";

function genId(): string {
  try { return crypto.randomUUID(); } catch { return `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
}

type ApplyState = "pending" | "applying" | "applied" | "dismissed";

// 公司架构模式右侧固定面板(2026-07 第四版·最终定调):对话/执行 两个模式,形式与日常简报栏
// (BriefingPanel)完全一致——用户来回纠正过三次(先合并成单一连续对话→拆成三段式又被打回→
// 现在两边都要),这是最终方向,不要再自作主张调整。
//
// - 对话模式:纯问答,永远不产出/不渲染 actions(architectChat 响应类型本身就不带 actions 字段,
//   端点级硬保证,不是这里拿到后自己选择不渲染)。
// - 执行模式:三段式,完全复用 BriefingPanel 同一套状态管理模式——①一句话需求 ②调
//   architectDecompose,该公司 Leader(没有则 CEO 兜底)判断是否存在需要用户决定的分歧点,有就出
//   选择题、没有就给一份结构性修改方案(actions[],可以是空数组——"想清楚了不用改"本身是合法结果)
//   ③用户确认后调现有的、完全不变的 architectApply 落地。
//
// 两种模式共用同一条消息流(按时间排序合并渲染),气泡身份统一显示真实 CEO(即便执行模式这一轮
// 实际是 Leader 在推理),执行模式的卡片下方用小字如实注明"由 Leader「X」拆解"——体验连续、机制
// 诚实披露。
interface ChatTurn {
  id: string;
  ts: string;
  role: "user" | "assistant" | "system";
  text: string;
}

// 执行模式一轮:assistant 回复要么带 questions(情况A·选择题,此时没有 actions),要么带 actions
// (情况B·方案预览,此时没有 questions)——两者互斥,后端 parseDecomposeReply 已经强制保证这一点,
// 前端只是如实渲染。actions 可能是空数组(合法结果:不需要任何改动),此时不显示"确认执行"按钮。
interface ExecEntry {
  id: string;
  ts: string;
  kind: "user" | "assistant" | "system";
  text: string;
  decomposer?: TaskDecomposer;
  questions?: TaskDecomposeQuestion[];
  /** 选择题一次性提交后置 true → 问卷卡收起,汇总答案已作为一条用户消息进入消息流。 */
  questionsAnswered?: boolean;
  actions?: ArchitectAction[];
  proposalId?: string;
  expiresAt?: string;
  applyState?: ApplyState;
}

// 执行模式预览卡——和 BriefingPanel 的 ExecPreviewCard 同一形式,只是最终产出从"一段任务描述文本"
// 换成"一批 action",落地也换成 architectApply 而不是派发任务。
function ArchExecPreviewCard({ decomposer, questions, questionsAnswered, actions, applyState, onSubmitAnswers, onApply, onDismiss, isRealAgent, tr }: {
  decomposer?: TaskDecomposer;
  questions?: TaskDecomposeQuestion[];
  questionsAnswered?: boolean;
  actions?: ArchitectAction[];
  proposalId?: string;
  expiresAt?: string;
  applyState?: ApplyState;
  onSubmitAnswers: (summary: string) => void;
  onApply: () => void;
  onDismiss: () => void;
  isRealAgent: (id: string) => boolean;
  tr: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="flex flex-col gap-1.5 min-w-[200px] max-w-[380px]">
      {decomposer && (
        <DecomposerLine
          decomposer={decomposer}
          leadKey="arch.exec.byLead"
          fallbackKey="arch.exec.byCeoFallback"
          isRealAgent={isRealAgent}
          tr={tr}
        />
      )}
      {questions && questions.length > 0 && (
        <ClarifyQuestionnaire questions={questions} submitted={!!questionsAnswered} onSubmit={onSubmitAnswers} tr={tr} />
      )}
      {actions !== undefined && (
        actions.length === 0 ? (
          <div className="text-[11px] text-ink-subtle">{tr("arch.exec.noActionsNote")}</div>
        ) : (
          <div className="flex flex-col gap-1.5 rounded-lg border border-hairline bg-surface-0 p-2.5">
            <div className="text-[11px] font-medium text-ink-subtle">{tr("arch.exec.summaryLabel")}</div>
            <div className="flex flex-col gap-1">
              {actions.map((a, i) => (
                <div key={i} className="text-[12px] text-ink leading-snug">{describeArchitectAction(a, tr)}</div>
              ))}
            </div>
            {applyState === "dismissed" ? (
              <div className="text-[11px] text-ink-subtle">{tr("arch.exec.dismissedTag")}</div>
            ) : applyState === "applied" ? (
              <div className="text-[11px] text-green">{tr("arch.exec.executedTag")}</div>
            ) : (
              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  onClick={onApply}
                  disabled={applyState === "applying"}
                  className="btn-primary px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 transition-colors"
                >
                  {applyState === "applying" ? tr("arch.exec.executing") : tr("arch.exec.confirmBtn")}
                </button>
                <button onClick={onDismiss} disabled={applyState === "applying"} className="btn-sm">
                  {tr("arch.exec.dismissBtn")}
                </button>
              </div>
            )}
          </div>
        )
      )}
    </div>
  );
}

const MODE_OPTIONS: { key: "chat" | "exec"; icon: typeof MessageCircle; labelKey: string }[] = [
  { key: "chat", icon: MessageCircle, labelKey: "arch.panel.mode.chat" },
  { key: "exec", icon: Rocket, labelKey: "arch.panel.mode.exec" },
];

// 合并后的消息流条目——对话模式(ChatTurn)与执行模式(ExecEntry)按 ts 统一排序渲染,同一处
// MessageBubble 渲染路径,不另开两块区域(与 BriefingPanel 的 allEntries 同一形式)。
interface FeedEntry {
  key: string;
  ts: string;
  variant: MessageBubbleVariant;
  name: string;
  role?: string;
  content: string;
  card?: ReactNode;
}

export default function ArchitectChatPanel({
  companyId, onApplied,
}: {
  companyId: string;
  onApplied: (company: Company) => void;
}) {
  const tr = useT();
  const agents = useAgentStore(s => s.agents);
  // 该公司真实 CEO——和 BriefingPanel 头部显示同一个人(agents 全局 store,加载时机也相同)。
  // 找不到时(极端边缘:公司还没有 CEO)退化到通用兜底标签,发送消息会被后端用同样的人话错误拒绝。
  const ceo = useMemo(
    () => agents.find(a => (a.companyId || "default") === companyId && a.role === "ceo"),
    [agents, companyId],
  );
  const assistantName = ceo?.name ?? tr("arch.chat.assistantName");
  const panelTitle = ceo?.name ? tr("arch.panel.titleNamed", { name: ceo.name }) : tr("arch.panel.title");

  const [mode, setMode] = useState<"chat" | "exec">("chat");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [execEntries, setExecEntries] = useState<ExecEntry[]>([]);
  // 令三.4· 高危二次确认:非 null 时弹确认层(记住待重发的 entryId + 后端签发的一次性 token),确认后带
  // confirmationToken 重发。
  const [highRiskConfirm, setHighRiskConfirm] = useState<{ entryId: string; flags: HighRiskFlag[]; token: string } | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [execPending, setExecPending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const busy = sending || execPending;

  useEffect(() => { setTurns([]); setExecEntries([]); setInput(""); }, [companyId]);

  // ── 对话模式:纯问答,不产出 actions ──────────────────────────────────────────────
  const send = useCallback(async (msg: string) => {
    const history: ConversationTurn[] = turns
      .filter((t): t is ChatTurn & { role: "user" | "assistant" } => t.role !== "system")
      .map(t => ({ role: t.role, content: t.text }));
    setTurns(prev => [...prev, { id: genId(), ts: new Date().toISOString(), role: "user", text: msg }]);
    setSending(true);
    try {
      const res = await api.architectChat(companyId, msg, history);
      setTurns(prev => [...prev, { id: genId(), ts: new Date().toISOString(), role: "assistant", text: res.reply }]);
    } catch (e: any) {
      setTurns(prev => [...prev, { id: genId(), ts: new Date().toISOString(), role: "system", text: tr("arch.chat.sendFailedPrefix") + (e?.message || "") }]);
    } finally {
      setSending(false);
    }
  }, [turns, companyId, tr]);

  // ── 执行模式:三段式(①一句话需求 ②Leader/CEO 拆解:选择题或方案预览 ③确认后真正落地)──────
  const sendExec = useCallback(async (msg: string) => {
    const t = msg.trim();
    if (!t) return;
    const history: ConversationTurn[] = execEntries
      .filter((e): e is ExecEntry & { kind: "user" | "assistant" } => e.kind !== "system")
      .map(e => ({ role: e.kind, content: e.text }));
    setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "user", text: t }]);
    setExecPending(true);
    try {
      const res = await api.architectDecompose(companyId, t, history);
      setExecEntries(prev => [...prev, {
        id: genId(), ts: new Date().toISOString(), kind: "assistant", text: res.summary,
        decomposer: res.decomposer,
        questions: res.needsChoice ? res.questions : undefined,
        actions: res.needsChoice ? undefined : res.actions,
        proposalId: res.needsChoice ? undefined : res.proposalId,
        expiresAt: res.needsChoice ? undefined : res.expiresAt,
        applyState: (!res.needsChoice && res.actions.length > 0 && res.proposalId) ? "pending" : undefined,
      }]);
    } catch (e: any) {
      setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "system", text: tr("arch.exec.decomposeFailedPrefix") + (e?.message ?? String(e)) }]);
    } finally {
      setExecPending(false);
    }
  }, [execEntries, companyId, tr]);

  // 澄清问卷提交(用户纠正:旧实现"点一个选项即发送、逐题往返"是错的)——全部题目一次答完,提交时
  // 把 {question, answer} 汇总成一条用户消息走同一条 sendExec 路径,只触发一轮模型调用;并把该题条目
  // 标记 answered 让问卷卡收起(汇总答案由 sendExec 追加的用户气泡承载,用户仍看得见自己答了什么)。
  const submitExecAnswers = useCallback((entryId: string, summary: string) => {
    if (execPending) return;
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, questionsAnswered: true } : e)));
    void sendExec(summary);
  }, [execPending, sendExec]);

  // 令三.4· confirmation token:首次不带,服务端命中高危(删员工/A2A/权限扩大)→ 428 返回一次性 token,
  // 弹二次确认层;用户确认后带该 token 重发。取消则回 pending 态(不落地、不当报错死路)。
  const applyExecEntry = useCallback(async (entryId: string, confirmationToken?: string) => {
    const entry = execEntries.find(e => e.id === entryId);
    if (!entry?.actions?.length || !entry.proposalId) return;
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, applyState: "applying" } : e)));
    try {
      const res = await api.architectApply(companyId, entry.proposalId, confirmationToken);
      setHighRiskConfirm(null);
      setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, applyState: "applied" } : e)));
      const okCount = res.results.filter(r => r.ok).length;
      const failed = res.results.filter(r => !r.ok);
      let summary = tr("arch.exec.executedSummary", { n: okCount });
      if (failed.length) {
        summary += "\n" + failed
          .map(f => tr("arch.action.failedLine", { desc: describeArchitectAction(f.action, tr), reason: f.reason || tr("arch.exec.unknownReason") }))
          .join("\n");
      }
      setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "system", text: summary }]);
      await useAgentStore.getState().load();
      onApplied(res.company);
    } catch (e: any) {
      setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, applyState: "pending" } : e)));
      // 高危门:命中 428 → 取出高危清单 + 后端签发的一次性 token 弹二次确认层,不落系统报错气泡。
      // (重放/过期/换 actions 也会 428 重签,直接用新 token 覆盖旧的。)
      if (e?.status === 428) {
        const flags = extractHighRisk(e);
        const token = extractConfirmationToken(e);
        if (flags && token) { setHighRiskConfirm({ entryId, flags, token }); return; }
      }
      setExecEntries(prev => [...prev, { id: genId(), ts: new Date().toISOString(), kind: "system", text: tr("arch.exec.executeFailedPrefix") + (e?.message || "") }]);
    }
  }, [execEntries, companyId, tr, onApplied]);

  const dismissExecEntry = useCallback((entryId: string) => {
    setExecEntries(prev => prev.map(e => (e.id === entryId ? { ...e, applyState: "dismissed" } : e)));
  }, []);

  const handleSend = useCallback(() => {
    const msg = input.trim();
    if (!msg || busy) return;
    setInput("");
    if (mode === "chat") void send(msg); else void sendExec(msg);
  }, [input, busy, mode, send, sendExec]);

  // 两个模式的消息流合并成一份按时间排序的列表,统一走 MessageBubble 渲染——切换模式不丢失另一边
  // 的历史,和 BriefingPanel 的 allEntries 同一形式。
  const chatFeed = useMemo<FeedEntry[]>(() => turns.map(t => (
    t.role === "system"
      ? { key: t.id, ts: t.ts, variant: "system" as MessageBubbleVariant, name: tr("org.brief.systemName"), content: t.text }
      : t.role === "user"
        ? { key: t.id, ts: t.ts, variant: "user" as MessageBubbleVariant, name: tr("arch.chat.you"), content: t.text }
        : { key: t.id, ts: t.ts, variant: "agent" as MessageBubbleVariant, name: assistantName, role: "ceo", content: t.text }
  )), [turns, tr, assistantName]);

  const isRealAgent = useCallback((id: string) => agents.some(a => a.id === id), [agents]);
  const execFeed = useMemo<FeedEntry[]>(() => execEntries.map(e => {
    if (e.kind === "system") return { key: e.id, ts: e.ts, variant: "system" as MessageBubbleVariant, name: tr("org.brief.systemName"), content: e.text };
    if (e.kind === "user") return { key: e.id, ts: e.ts, variant: "user" as MessageBubbleVariant, name: tr("arch.chat.you"), content: e.text };
    return {
      key: e.id, ts: e.ts, variant: "agent" as MessageBubbleVariant, name: assistantName, role: "ceo", content: e.text,
      card: (
        <ArchExecPreviewCard
          decomposer={e.decomposer} questions={e.questions} questionsAnswered={e.questionsAnswered} actions={e.actions} applyState={e.applyState}
          onSubmitAnswers={summary => submitExecAnswers(e.id, summary)}
          onApply={() => void applyExecEntry(e.id)}
          onDismiss={() => dismissExecEntry(e.id)}
          isRealAgent={isRealAgent}
          tr={tr}
        />
      ),
    };
  }), [execEntries, tr, assistantName, submitExecAnswers, applyExecEntry, dismissExecEntry, isRealAgent]);

  const allEntries = useMemo(
    () => [...chatFeed, ...execFeed].sort((a, b) => (a.ts || "").localeCompare(b.ts || "")),
    [chatFeed, execFeed],
  );

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [allEntries.length, busy]);

  const placeholder = mode === "chat" ? tr("arch.chat.placeholder") : tr("arch.exec.placeholder");
  const emptyHint = mode === "chat" ? tr("arch.chat.empty") : tr("arch.exec.empty");
  const thinkingHint = sending ? tr("arch.chat.thinking") : execPending ? tr("arch.exec.thinking") : "";

  return (
    <div className="w-[340px] shrink-0 border-l border-hairline bg-surface-1 flex flex-col">
      <div className="h-10 px-3 flex items-center gap-2 border-b border-hairline shrink-0">
        <Bot size={14} className="text-accent shrink-0" />
        <span className="text-[13px] font-semibold text-ink truncate">{panelTitle}</span>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-3">
        {allEntries.length === 0 && (
          <div className="text-[12px] text-ink-subtle text-center mt-8 px-4">{emptyHint}</div>
        )}

        {allEntries.map(en => (
          <MessageBubble key={en.key} variant={en.variant} name={en.name} role={en.role} content={en.content} card={en.card} />
        ))}

        {busy && <div className="text-[11px] text-ink-subtle text-center">{thinkingHint}</div>}
        <div ref={endRef} />
      </div>

      <div className="p-2.5 border-t border-hairline shrink-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1 rounded-full bg-surface-2 p-0.5">
          {MODE_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setMode(opt.key)}
              className={`flex-1 flex items-center justify-center gap-1 h-6 rounded-full text-[11px] font-medium cursor-pointer transition-colors border-none ${
                mode === opt.key ? "bg-surface-1 text-ink shadow-sm" : "bg-transparent text-ink-muted hover:text-ink"
              }`}
            >
              <opt.icon size={11} />{tr(opt.labelKey)}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <AutoGrowTextarea
            value={input}
            maxRows={6}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            disabled={busy}
            placeholder={placeholder}
            className="flex-1 resize-none rounded-lg bg-surface-0 border border-hairline px-2.5 py-1.5 text-[13px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
          />
          <button
            onClick={handleSend}
            disabled={busy || !input.trim()}
            title={tr("arch.chat.send")}
            className="btn-primary self-end flex items-center justify-center w-9 h-8 disabled:cursor-not-allowed shrink-0 transition-colors duration-150"
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      {/* C(波4)· 活公司高危二次确认层:列出每条高危 op 明细(删除员工 X / 变更 A2A / 权限扩大…),
          用户明确确认后带后端签发的一次性 confirmationToken 重发;取消回 pending(不落地)——与草稿侧 AiEditPanel 同款。 */}
      {highRiskConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-[1600]">
          <div className="bg-surface-1 rounded-2xl w-[90vw] max-w-[480px] flex flex-col overflow-hidden shadow-2xl border border-red/40">
            <div className="flex items-center gap-2 px-5 py-3.5 border-b border-hairline bg-red/10 shrink-0">
              <ShieldAlert size={17} className="text-red" />
              <b className="text-[15px] text-ink">{tr("cae.highRisk.title")}</b>
            </div>
            <div className="p-5 flex flex-col gap-3">
              <p className="text-[13px] text-ink-muted m-0">{tr("cae.highRisk.desc")}</p>
              <ul className="m-0 pl-0 flex flex-col gap-1.5 list-none">
                {highRiskConfirm.flags.map((f, i) => (
                  <li key={i} className="flex items-start gap-2 px-2.5 py-1.5 rounded-md bg-red/10 text-[13px] text-ink">
                    <AlertTriangle size={13} className="text-red shrink-0 mt-0.5" />
                    <span>
                      {describeHighRisk(f, tr)}
                      {f.kind === "permission_expansion" && f.detail && <span className="text-ink-subtle"> — {f.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center gap-3 justify-end px-5 py-3.5 border-t border-hairline bg-surface-0 shrink-0">
              <button onClick={() => setHighRiskConfirm(null)} className="btn-secondary">{tr("common.cancel")}</button>
              <button
                onClick={() => { const { entryId, token } = highRiskConfirm; setHighRiskConfirm(null); void applyExecEntry(entryId, token); }}
                className="inline-flex items-center gap-1.5 px-4 py-1.5 border-none rounded-full text-white text-[13px] font-medium bg-red cursor-pointer hover:opacity-90"
              >
                <ShieldAlert size={14} />
                {tr("cae.highRisk.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
