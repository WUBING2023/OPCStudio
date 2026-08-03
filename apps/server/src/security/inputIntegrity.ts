// U+FFFD(替换字符 �)输入完整性校验:一旦字符串里出现"连续/大量"的 U+FFFD,几乎不可能是用户
// 真实想表达的内容——现实中唯一常见成因是上游(输入法故障,更常见的是构造请求的脚本/终端编码环境
// 不是 UTF-8)在文本离开发送方之前就已经把无法解码的多字节字符不可逆地替换成了 U+FFFD。这种输入
// 一旦放行:①白白花 token/费用去调用模型处理一段没有意义的乱码 ②永久固化进 report.md,进而污染
// 这次和以后所有依赖这份报告的记忆/摘要机制。
//
// 真实事故(2026-07):run cd96a096 的 goal 与公司名(经由 CEO agent 名字带进报告页脚 contributions)
// 到达 orchestrator 之前就已经是这种坏字节——报告页脚出现 `opc������ʱ��˾-0704b`,CEO 自己在报告
// 正文里也回复"你的消息出现了乱码,我看到的是一串问号和方块"。OPC 自身的读写链路(projectStore.ts
// 的 saveRunReport / harness.ts 的 readReport / runRoutes.ts 的 GET .../report 均用 "utf-8" 编解码)
// 均已核实无误——损坏发生在请求体构造/发送阶段,不是 OPC 的编解码 bug。这道校验是"以后不再发生"的
// 输入侧防线,不是修复某次已损坏的历史数据。
//
// 阈值刻意保守,不对偶发的单个 U+FFFD 一律拒绝——真实用户输入里极端情况下也可能恰好用到这个字符
// (复制粘贴来的、已经在别处损坏过的片段等),只有"一段文本里成堆出现"才判定为损坏:
// - 连续出现 ≥3 个:同一次解码失败通常会连续产出多个 U+FFFD(每个丢失的多字节字符对应 1 个占位),
//   连续 3 个以上几乎不可能是真实文本里恰好紧挨着打了 3 次这个符号。
// - 非连续但总次数 ≥3 且占比 >5%:兜底损坏字符分散在文本各处(不连续)时的漏判。
const REPLACEMENT_CHAR = "�";
const CONSECUTIVE_THRESHOLD = 3;
const MIN_COUNT_FOR_RATIO_CHECK = 3;
const RATIO_THRESHOLD = 0.05;

export interface TextIntegrityResult {
  corrupted: boolean;
  /** 判定为损坏时的具体理由(人话,可直接拼进 400 响应给用户看)。未损坏时为 undefined。 */
  reason?: string;
}

/**
 * 校验一段文本是否已经是"不可逆编码损坏"的乱码(而不是编码不一致但仍可挽救的情况——那种情况这里
 * 不处理,也处理不了,因为信息已经丢失)。非字符串/空字符串一律视为未损坏,交给上层各自的
 * "required" 校验去处理"没内容"这件事,这里只管"有内容但内容本身已经废了"。
 */
export function checkTextIntegrity(text: string): TextIntegrityResult {
  if (typeof text !== "string" || text.length === 0) return { corrupted: false };

  const runRe = new RegExp(`${REPLACEMENT_CHAR}{${CONSECUTIVE_THRESHOLD},}`);
  const runMatch = text.match(runRe);
  if (runMatch) {
    return {
      corrupted: true,
      reason: `文本中出现连续 ${runMatch[0].length} 个无法识别的替换字符(�),疑似编码损坏`,
    };
  }

  const count = (text.match(new RegExp(REPLACEMENT_CHAR, "g")) || []).length;
  if (count === 0) return { corrupted: false };

  const ratio = count / text.length;
  if (count >= MIN_COUNT_FOR_RATIO_CHECK && ratio > RATIO_THRESHOLD) {
    return {
      corrupted: true,
      reason: `文本中出现 ${count} 个无法识别的替换字符(�),占比 ${(ratio * 100).toFixed(1)}%,疑似编码损坏`,
    };
  }

  return { corrupted: false };
}

/** 面向用户的固定错误文案(路由里 400 响应的 error 字段);具体判定理由放 detail 字段单独给出。 */
export const CORRUPTED_INPUT_ERROR = "检测到输入内容包含无法识别的字符,可能是编码问题导致的乱码,请检查发送方式后重试";
