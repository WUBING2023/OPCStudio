import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  type ClarifyQuestionInput,
  type ClarifyAnswers,
  clampIndex,
  canGoNext,
  canGoPrev,
  canSubmit,
  unansweredIndices,
  formatAnswersSummary,
} from "../../lib/clarifyQuestionnaire.js";

// 共享澄清问卷卡片(用户实测纠正:旧实现"点一个选项就立刻发送、逐题往返多轮"是错的)。
// 现在一次性收下全部题目,分页单选(点击=选中,不发送),可上一题/下一题回退改答,全部答完后
// "提交"按钮一次性把所有答案汇总成一条用户消息发给既有端点——只触发一轮模型调用。
// 提交后由调用方把该题条目标记 submitted,此处收起为一行"已提交"小字(答案本身作为一条用户气泡
// 留在消息流里,用户可见自己答了什么)。两个接入点(BriefingPanel 日常执行 / ArchitectChatPanel
// 架构执行)共用本组件,状态判定全部下沉到 lib/clarifyQuestionnaire.ts 的纯函数。
export default function ClarifyQuestionnaire({
  questions,
  submitted = false,
  onSubmit,
  tr,
}: {
  questions: ClarifyQuestionInput[];
  /** 调用方在提交后置 true → 收起为"已提交"小字;答案汇总由消息流里的用户气泡承载。 */
  submitted?: boolean;
  /** 提交:全量 {question, answer} 汇总文本,调用方拿去当作用户这一轮的消息发送(只一轮)。 */
  onSubmit: (summary: string) => void;
  tr: (key: string, params?: Record<string, string | number>) => string;
}) {
  const total = questions.length;
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ClarifyAnswers>({});

  if (submitted) {
    return <div className="text-[11px] text-ink-subtle">{tr("clarify.submittedTag")}</div>;
  }

  const cur = clampIndex(index, total);
  const q = questions[cur];
  const done = canSubmit(questions, answers);
  const remaining = unansweredIndices(questions, answers).length;
  const freeValue = q.options.includes(answers[cur] ?? "") ? "" : (answers[cur] ?? "");

  const setAnswer = (value: string) => setAnswers(a => ({ ...a, [cur]: value }));
  const goPrev = () => setIndex(i => clampIndex(i - 1, total));
  const goNext = () => setIndex(i => clampIndex(i + 1, total));
  const submit = () => { if (done) onSubmit(formatAnswersSummary(questions, answers)); };

  return (
    <div className="flex flex-col gap-2 min-w-[220px]">
      <div className="text-[10px] text-ink-subtle tabular-nums">
        {tr("clarify.progress", { n: cur + 1, m: total })}
      </div>
      <div className="text-[12px] font-medium text-ink">{q.question}</div>

      <div className="flex flex-col gap-1">
        {q.options.map((opt, oi) => {
          const active = answers[cur] === opt;
          return (
            <button
              key={oi}
              onClick={() => setAnswer(opt)}
              aria-pressed={active}
              className={`text-left px-2 py-1.5 rounded-md text-[11px] border cursor-pointer transition-colors ${
                active
                  ? "bg-accent/10 text-accent border-accent"
                  : "bg-surface-2 hover:bg-surface-3 text-ink border-transparent"
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>

      {q.allowFree && (
        <input
          type="text"
          value={freeValue}
          onChange={e => setAnswer(e.target.value)}
          placeholder={tr("clarify.freePlaceholder")}
          className="rounded-md bg-surface-0 border border-hairline px-2 py-1 text-[11px] text-ink outline-none focus:border-accent transition-colors placeholder:text-ink-subtle"
        />
      )}

      <div className="flex items-center gap-1.5 pt-0.5">
        <button onClick={goPrev} disabled={!canGoPrev(cur)} className="btn-sm inline-flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed">
          <ChevronLeft size={11} />{tr("clarify.prev")}
        </button>
        <button onClick={goNext} disabled={!canGoNext(cur, total)} className="btn-sm inline-flex items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed">
          {tr("clarify.next")}<ChevronRight size={11} />
        </button>
        <div className="flex-1" />
        <button
          onClick={submit}
          disabled={!done}
          className="btn-primary px-2.5 py-1 text-[11px] font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {tr("clarify.submit")}
        </button>
      </div>

      {!done && (
        <div className="text-[10px] text-ink-subtle">{tr("clarify.unanswered", { n: remaining })}</div>
      )}
    </div>
  );
}
