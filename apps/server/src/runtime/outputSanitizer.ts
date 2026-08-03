// MUP B7 · 泄漏面统一收口的纯文本清洗器(零依赖,纯函数):
// ① stripThinkBlocks:剥离 R1/ollama 类模型正文内嵌的 <think>…</think> 思考块(含跨行/多段/
//    未闭合尾块)。思考内容不丢——调用方以 agent_output_chunk(thinking:true)另行 emit,
//    绝不进交付文本/合成 prompt/报告。无标记时零改动(clean === 输入原文)。
// ② stripDirectAnswerHeader:DIRECT_ANSWER: 协议头的用户可见面剥离。与 orchestrator.parseDirectAnswer
//    同款"全文首标记提取"(实测模型常在标记前带前言,行首锚定会把标记原样漏给用户);区别是本函数
//    永远返回文本(无标记原样返回),不做 parseDirectAnswer 的"是否直答"三态判定。

export interface StrippedThink {
  clean: string;
  thinking?: string;
}

export function stripThinkBlocks(text: string): StrippedThink {
  const s = text ?? "";
  if (!/<think>/i.test(s)) return { clean: s };
  const parts: string[] = [];
  let clean = s.replace(/<think>([\s\S]*?)<\/think>/gi, (_m, body: string) => {
    if (body.trim()) parts.push(body.trim());
    return "";
  });
  // 未闭合尾块(流式截断/模型忘写闭合):首个残余 <think> 起全部视为思考,不让半截思考进正文。
  const openIdx = clean.search(/<think>/i);
  if (openIdx >= 0) {
    const tail = clean.slice(openIdx).replace(/^<think>/i, "").trim();
    if (tail) parts.push(tail);
    clean = clean.slice(0, openIdx);
  }
  clean = clean.replace(/\n{3,}/g, "\n\n").trim();
  const thinking = parts.join("\n\n");
  return thinking ? { clean, thinking } : { clean };
}

export function stripDirectAnswerHeader(text: string): string {
  const r = text ?? "";
  const m = r.match(/DIRECT_ANSWER\s*[:：]\s*([\s\S]+)/i);
  return m ? m[1].trim() : r;
}
