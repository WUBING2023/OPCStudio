import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 澄清问卷重做的前端契约(纯 node vitest,无 DOM 基建 —— 沿用 governanceApprovalContract 的源码契约做法)。
// 用户实测纠正:旧实现"点一个选项就立刻发送、3 道题分 3 轮往返"是错的,应一次答完全部题、可回退改答、
// 再一次性提交(只触发一轮模型调用)。本契约锁住:
//   1) 每个渲染选择题的接入点都改用共享 ClarifyQuestionnaire 组件;
//   2) "点击选项直接 send"的旧代码路径(chooseExecOption / onChoose / q.options.map / sendExec(option))
//      在两个接入点里彻底消失;
//   3) 提交走"汇总成一条消息、单轮 sendExec"的新路径,并把该题条目标记 questionsAnswered 令问卷收起;
//   4) 共享组件本身是纯展示(不直接调 api,不触发发送),单选靠本地 answers state;
//   5) 新增 clarify.* 文案在 en + zh-CN 齐全且保留占位符。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(HERE, rel), "utf-8");

const BRIEFING = read("BriefingPanel.tsx");
const ARCH = read("ArchitectChatPanel.tsx");
const COMPONENT = read("../common/ClarifyQuestionnaire.tsx");
const LIB = read("../../lib/clarifyQuestionnaire.ts");
const DICTS = JSON.parse(read("../../i18n.dict.json")) as Record<string, Record<string, string>>;

// 澄清问卷选择题的全部接入点 —— 新增/改造接入点时必须同步登记在此,否则"漏改一处"会被下面的断言抓到。
const ACCESS_POINTS = [
  ["BriefingPanel · 日常任务执行模式", BRIEFING],
  ["ArchitectChatPanel · 架构执行模式", ARCH],
] as const;

describe("澄清问卷 · 每个接入点都改用共享 ClarifyQuestionnaire", () => {
  it("两个接入点都 import 并渲染 ClarifyQuestionnaire", () => {
    for (const [name, src] of ACCESS_POINTS) {
      expect(src, `${name} 未 import ClarifyQuestionnaire`).toContain('from "../common/ClarifyQuestionnaire.js"');
      expect(src, `${name} 未渲染 <ClarifyQuestionnaire`).toContain("<ClarifyQuestionnaire");
    }
  });

  it("接入点把 questions 整份交给组件,并接 onSubmit / submitted(questionsAnswered)", () => {
    for (const [name, src] of ACCESS_POINTS) {
      expect(src, `${name} 未把 questions 传给组件`).toMatch(/<ClarifyQuestionnaire[^>]*questions=\{questions\}/);
      expect(src, `${name} 未接 onSubmit`).toMatch(/<ClarifyQuestionnaire[^>]*onSubmit=/);
      expect(src, `${name} 未把提交态接到 submitted`).toMatch(/<ClarifyQuestionnaire[^>]*submitted=\{!!questionsAnswered\}/);
    }
  });
});

describe("澄清问卷 · 旧「点选项即发送」路径彻底移除", () => {
  it("两个接入点不再有 chooseExecOption / onChoose / q.options.map / sendExec(选项)", () => {
    for (const [name, src] of ACCESS_POINTS) {
      expect(src, `${name} 残留 chooseExecOption`).not.toContain("chooseExecOption");
      expect(src, `${name} 残留 onChoose`).not.toContain("onChoose");
      expect(src, `${name} 残留逐题 options.map 渲染`).not.toMatch(/\.options\.map\(/);
      expect(src, `${name} 残留点选项即发送`).not.toMatch(/sendExec\(\s*(option|opt)\s*\)/);
      // 旧的"或输入你自己的答案"卡内提示(引导用户去主输入框逐题回答)也应随之移除
      expect(src, `${name} 残留旧自由作答提示`).not.toContain("questionFreeAnswerPlaceholder");
    }
  });
});

describe("澄清问卷 · 提交走单轮汇总路径 + 提交后收起", () => {
  it("两个接入点都有 submitExecAnswers:标记 questionsAnswered 后单次 sendExec(汇总)", () => {
    for (const [name, src] of ACCESS_POINTS) {
      expect(src, `${name} 缺 submitExecAnswers`).toContain("const submitExecAnswers = useCallback");
      // 提交处理器体内:先置 questionsAnswered:true,再 sendExec(summary)
      const body = src.slice(src.indexOf("const submitExecAnswers = useCallback"));
      expect(body, `${name} submitExecAnswers 未标记 questionsAnswered`).toMatch(/questionsAnswered: true/);
      expect(body, `${name} submitExecAnswers 未单轮 sendExec(summary)`).toMatch(/void sendExec\(summary\)/);
    }
  });

  it("接入点用 onSubmit=summary => submitExecAnswers(entryId, summary) 连线", () => {
    for (const [name, src] of ACCESS_POINTS) {
      expect(src, `${name} 未把 onSubmit 连到 submitExecAnswers`).toMatch(/onSubmit(Answers)?=\{summary => submitExecAnswers\(e\.id, summary\)\}/);
    }
  });
});

describe("澄清问卷 · 共享组件是纯展示(不自行发送/不调 api)", () => {
  it("组件从 lib/clarifyQuestionnaire 取纯状态机,渲染 options,提交只走 onSubmit(formatAnswersSummary)", () => {
    expect(COMPONENT).toContain('from "../../lib/clarifyQuestionnaire.js"');
    expect(COMPONENT).toMatch(/\.options\.map\(/);                       // 单选选项在组件内渲染
    expect(COMPONENT).toContain("onSubmit(formatAnswersSummary(questions, answers))");
    expect(COMPONENT).toMatch(/canGoPrev/);                              // 上一题
    expect(COMPONENT).toMatch(/canGoNext/);                              // 下一题
    expect(COMPONENT).toMatch(/clarify\.progress/);                      // 第 N / 共 M 题
  });

  it("组件不直接 import api/client,也不引用 sendExec —— 只经 onSubmit 回调把控制权交回接入点", () => {
    expect(COMPONENT).not.toMatch(/api\/client/);
    expect(COMPONENT).not.toContain("sendExec");
    // 选项点击只改本地 answers(setAnswer),绝不在 onClick 里直接 onSubmit
    expect(COMPONENT).toMatch(/onClick=\{\(\) => setAnswer\(opt\)\}/);
  });

  it("纯状态机导出关键判定函数", () => {
    for (const fn of [
      "clampIndex", "isAnswered", "unansweredIndices", "allAnswered",
      "canSubmit", "canGoNext", "canGoPrev", "formatAnswersSummary",
    ]) {
      expect(LIB, `lib 缺导出 ${fn}`).toMatch(new RegExp(`export function ${fn}\\b`));
    }
  });
});

describe("澄清问卷 · i18n(en + zh-CN)", () => {
  const KEYS = [
    "clarify.progress", "clarify.prev", "clarify.next", "clarify.submit",
    "clarify.freePlaceholder", "clarify.unanswered", "clarify.submittedTag",
  ];
  it("clarify.* 在 en / zh-CN 均有非空文案", () => {
    for (const lang of ["en", "zh-CN"]) {
      for (const key of KEYS) {
        expect(DICTS[lang]?.[key], `${lang} 缺 ${key}`).toBeTruthy();
      }
    }
  });

  it("带参数的键保留占位符", () => {
    for (const lang of ["en", "zh-CN"]) {
      expect(DICTS[lang]["clarify.progress"], `${lang} progress 缺 {n}`).toContain("{n}");
      expect(DICTS[lang]["clarify.progress"], `${lang} progress 缺 {m}`).toContain("{m}");
      expect(DICTS[lang]["clarify.unanswered"], `${lang} unanswered 缺 {n}`).toContain("{n}");
    }
  });
});
