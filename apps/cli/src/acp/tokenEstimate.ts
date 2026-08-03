// 相1 · ACP 路径 token 估算。部分 ACP 适配器(实测 claude-code ACP)既不发 PromptResponse.usage、也不发
// 携带真实 token 数的 usage_update —— usage 恒缺,tokens.total 会掉成 0。此时按已知的输入/输出**文本**估算,
// 复用检索侧共享分词 textTokenize.tokenize(中文 2-gram 滑窗 + 英文/数字词),给出一个 >0 的合理近似。
//
// 这是**估算**不是精确计量:tokenize 会去重、且丢弃单字英文,故偏低;调用方必须把结果标 estimated:true,
// 成本页据此如实显示“估算”,绝不冒充引擎上报的真实 usage。codex 等能上报真实 usage 的引擎不走这条路径。
import { tokenize } from "@opc/server/src/storage/textTokenize.js";

export function estimateTokensFromText(text: string | undefined | null): number {
  return tokenize(text).length;
}
