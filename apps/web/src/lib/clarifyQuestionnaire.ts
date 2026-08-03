// 澄清问卷的纯状态机——与 React 无关,可独立真值断言。ClarifyQuestionnaire.tsx 只持有 index/answers
// 两个 useState,所有"当前题/能否翻页/能否提交/汇总文本"判定都下沉到这里,让逻辑可测且两个接入点
// (BriefingPanel 日常任务执行、ArchitectChatPanel 架构执行)共享同一份行为。
//
// answers 用"题号→答案文本"的稀疏字典:选项文本或(allowFree 时)自由输入都存同一格,汇总时不区分来源。

export interface ClarifyQuestionInput {
  question: string;
  options: string[];
  allowFree?: boolean;
}

export type ClarifyAnswers = Record<number, string>;

export function questionCount(questions: ClarifyQuestionInput[]): number {
  return questions.length;
}

export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(index, total - 1));
}

// 已答=该题号存了非空白字符串(自由输入清空视为未答)。
export function isAnswered(answers: ClarifyAnswers, index: number): boolean {
  const v = answers[index];
  return typeof v === "string" && v.trim().length > 0;
}

export function answeredCount(questions: ClarifyQuestionInput[], answers: ClarifyAnswers): number {
  let n = 0;
  for (let i = 0; i < questions.length; i++) if (isAnswered(answers, i)) n++;
  return n;
}

export function unansweredIndices(questions: ClarifyQuestionInput[], answers: ClarifyAnswers): number[] {
  const out: number[] = [];
  for (let i = 0; i < questions.length; i++) if (!isAnswered(answers, i)) out.push(i);
  return out;
}

// 全部必答(现状语义):至少一题且每题都已答。
export function allAnswered(questions: ClarifyQuestionInput[], answers: ClarifyAnswers): boolean {
  return questions.length > 0 && unansweredIndices(questions, answers).length === 0;
}

export function canSubmit(questions: ClarifyQuestionInput[], answers: ClarifyAnswers): boolean {
  return allAnswered(questions, answers);
}

export function canGoNext(index: number, total: number): boolean {
  return index < total - 1;
}

export function canGoPrev(index: number): boolean {
  return index > 0;
}

// 汇总成一条用户消息:"1. 问题A → 选项内容\n2. 问题B → …"。提交时一次性发给既有端点,只触发一轮模型调用。
export function formatAnswersSummary(questions: ClarifyQuestionInput[], answers: ClarifyAnswers): string {
  return questions
    .map((q, i) => `${i + 1}. ${q.question} → ${(answers[i] ?? "").trim()}`)
    .join("\n");
}
