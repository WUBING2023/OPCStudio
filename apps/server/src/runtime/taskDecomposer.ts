import type { AgentNodeConfig } from "@opc/shared";

// 决策拆解骨架(2026-07 从架构助手 architectAssistant.ts 挪出并去架构语义化)——"用户一句话需求 →
// 该团队的 Leader(没有则 CEO 兜底)判断这里是否存在真正需要用户决定的分歧点:有就出选择题,没有就
// 直接给出最终产出"这套流程,原本只服务"公司架构调整",现在同一套骨架也要服务"日常任务派发"
// (taskRoutes.ts)。两个场景的差异只在"最终产出长什么样"(架构场景是 action[],任务场景是一段任务
// 描述文本)——resolve-decomposer(谁来拆解)和 JSON 信封解析(needsChoice 分支 + 降级纠偏)这两块
// 完全没有场景耦合,因此提炼成通用模块,而不是在两个路由文件里各自维护一份几乎相同、且都带着
// "needsChoice 声称 true 但没解析出问题就降级为 false"这类细节纠正逻辑的解析代码。
// 谁负责拆解(组织语义)与拆解成什么(领域语义)分离:前者在这里,后者由调用方通过 extractResult
// 回调给出。

export interface Decomposer {
  agent: AgentNodeConfig;
  role: "lead" | "ceo";
  fallbackToCeo: boolean;
}

// 找该团队的 Leader(没有则 CEO 兜底)——不绑定任何领域,架构调整/日常任务都是"这件事该由团队里
// 谁来做决策拆解"这同一个组织问题。
export function resolveDecomposer(roster: AgentNodeConfig[]): Decomposer | undefined {
  const lead = roster.find(a => a.role === "lead" && a.enabled !== false);
  if (lead) return { agent: lead, role: "lead", fallbackToCeo: false };
  const ceo = roster.find(a => a.role === "ceo" && a.enabled !== false);
  if (ceo) return { agent: ceo, role: "ceo", fallbackToCeo: true };
  return undefined;
}

export interface DecomposeQuestion {
  question: string;
  options: string[];
}

function toQuestionArray(raw: unknown): DecomposeQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: DecomposeQuestion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const question = typeof (item as any).question === "string" ? (item as any).question.trim().slice(0, 400) : "";
    const options = Array.isArray((item as any).options)
      ? (item as any).options
          .filter((o: unknown): o is string => typeof o === "string" && !!o.trim())
          .map((o: string) => o.trim().slice(0, 200))
          .slice(0, 6)
      : [];
    if (question && options.length >= 2) out.push({ question, options });
  }
  return out.slice(0, 3);
}

export interface DecomposeReply<T> {
  summary: string;
  needsChoice: boolean;
  questions: DecomposeQuestion[];
  result: T;
}

// 弯引号规整:模型常在字符串值里用中文弯引号“”做强调/引用。它们本身不是 JSON 结构字符、不会破坏
// JSON.parse,但规整成书名号「」既与系统提示词那条硬规则一致,存进产出里也更干净统一。
function normalizeCurlyQuotes(text: string): string {
  return text.replace(/“/g, "「").replace(/”/g, "」");
}

// 字符串内裸双引号修复(仅在首次 JSON.parse 失败后作为补救重试)。模型最常见的破坏方式是在字符串
// 值内部写了没转义的英文直双引号(如 …用户设定一个"目标响度"…),让解析器在半路把字符串提前闭合而
// 整个 JSON 碎掉。用一个小状态机扫描:只在"字符串字面量内部"遇到未转义的 " 时才做判断——它究竟是
// 真正的闭合引号(其后紧跟 : ] } 或结束,或紧跟一个后面接着合法下一 token 的逗号),还是裸内引号
// (其后跟的是普通内容字符);是裸内引号就转义为 \"。逗号有歧义(既可能是数组/对象分隔符,也可能是
// 字符串内容里的顿号),因此额外窥视逗号之后的字符:只有当其后是合法的下一 token 起始(下一个键/元素
// 的引号,或 { [ 数字 - true/false/null 的起始字母)才判定为真闭合,否则连同逗号一起并入字符串内容。
function repairBareQuotes(text: string): string {
  const n = text.length;
  const out: string[] = [];
  let inString = false;

  const nextNonWs = (from: number): { ch: string; idx: number } => {
    let i = from;
    while (i < n && /\s/.test(text[i]!)) i++;
    return { ch: i < n ? text[i]! : "", idx: i };
  };
  const startsValidToken = (ch: string): boolean =>
    ch === "" || ch === '"' || ch === "{" || ch === "[" || ch === "-" ||
    (ch >= "0" && ch <= "9") || ch === "t" || ch === "f" || ch === "n";

  for (let i = 0; i < n; i++) {
    const c = text[i]!;
    if (!inString) {
      out.push(c);
      if (c === '"') inString = true;
      continue;
    }
    if (c === "\\") {
      out.push(c);
      if (i + 1 < n) {
        out.push(text[i + 1]!);
        i++;
      }
      continue;
    }
    if (c === '"') {
      const peek = nextNonWs(i + 1);
      let isClosing: boolean;
      if (peek.ch === "" || peek.ch === ":" || peek.ch === "]" || peek.ch === "}") {
        isClosing = true;
      } else if (peek.ch === ",") {
        isClosing = startsValidToken(nextNonWs(peek.idx + 1).ch);
      } else {
        isClosing = false;
      }
      if (isClosing) {
        out.push('"');
        inString = false;
      } else {
        out.push('\\', '"');
      }
      continue;
    }
    out.push(c);
  }
  return out.join("");
}

// 解析拆解回复(情况 A 选择题 / 情况 B 最终产出 二选一)。与"活体聊天不能报错"的姿势不同:这里是
// 结构化产出,解析失败就是真的失败,诚实抛错(调用方转 400 + 原文截断),不编造兜底数据。
//
// needsChoice/result 互斥这条不变量在代码里强制,不只靠 prompt 自觉:needsChoice=true 时 result
// 恒为调用方给的 emptyResult;needsChoice=true 但没能解析出至少一条像样的问题时,降级为
// needsChoice=false 并改用 extractResult 从原始 parsed 里取最终产出(避免卡在一个空白"选择题"
// 界面出不来)。
export function parseDecomposeReply<T>(
  raw: string,
  extractResult: (parsed: any) => T,
  emptyResult: T,
): DecomposeReply<T> {
  // 规整管道:①先剥离协议头并把中文弯引号“”规整成「」;②再提取最外层 {} 块(优先 ```json 围栏)。
  const stripped = normalizeCurlyQuotes((raw ?? "").replace(/^\s*DIRECT_ANSWER:\s*/, "").trim());
  const fenced = stripped.match(/```json\s*([\s\S]*?)```/i);
  const bare = stripped.match(/\{[\s\S]*\}/);
  const jsonText = fenced ? fenced[1] : bare?.[0];
  if (!jsonText) throw new Error(`拆解输出无法解析为 JSON:${stripped.slice(0, 400)}`);

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    // ③首次失败:字符串内裸双引号是模型最常见的破坏方式,做一次状态机修复后重试。
    try {
      parsed = JSON.parse(repairBareQuotes(jsonText));
    } catch {
      // ④修复后仍失败才诚实报错,错误信息标注已尝试过弯引号规整与裸引号修复。
      throw new Error(`拆解输出 JSON 解析失败(已尝试弯引号规整与裸引号修复):${stripped.slice(0, 400)}`);
    }
  }

  const summary = typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 800) : "";
  if (!summary) throw new Error(`拆解输出缺少 summary:${stripped.slice(0, 400)}`);

  const requestedChoice = parsed?.needsChoice === true;
  const questions = requestedChoice ? toQuestionArray(parsed?.questions) : [];
  const needsChoice = requestedChoice && questions.length > 0;
  const result = needsChoice ? emptyResult : extractResult(parsed);

  return { summary, needsChoice, questions: needsChoice ? questions : [], result };
}
