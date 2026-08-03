// 检索端共享分词(P1#7):中文书写不带空格,按空格/标点切分整句会把一整句中文当成**一个** token,
// 导致 "整句是否整体作为子串出现在另一段文本里" 恒为假 → 相关性打分恒 0、排序退化成纯 recency。
// 对含 CJK(连续中文片段)的切分结果额外产出 2-gram 滑窗 token(配合原词一起保留),英文/数字词按原样保留。
// 只用于**检索侧打分**;写入端(memoryStore/registryStore/orchestrator 落盘的 tags 原始格式)不受影响。
const DELIM = /[\s　，。、？！：；""''（）【】…—\-()[\]"'/\\]+/;
const CJK = /[一-鿿]/;

export function tokenize(text: string | undefined | null): string[] {
  if (!text) return [];
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(DELIM)) {
    if (!raw) continue;
    if (CJK.test(raw)) {
      if (raw.length >= 2) tokens.add(raw);
      for (let i = 0; i + 1 < raw.length; i++) tokens.add(raw.slice(i, i + 2));
    } else if (raw.length >= 2) {
      tokens.add(raw);
    }
  }
  return [...tokens];
}

// text 过 tokenize 后与 tokenSet 的重叠 token 数(0 = 无相关信号)。
export function tokenOverlap(text: string, tokenSet: ReadonlySet<string>): number {
  let n = 0;
  for (const t of tokenize(text)) if (tokenSet.has(t)) n++;
  return n;
}

// tags 数组里有多少个 tag 与 tokenSet 有重叠(tag 本身也过 tokenize,兼容 CJK 整词 tag)。
// 保留"每命中一个 tag 记一次"的原语义,调用方按自己的权重相乘;只是把子串匹配换成 token 重叠匹配。
export function matchingTagCount(tags: readonly string[] | undefined, tokenSet: ReadonlySet<string>): number {
  if (!tags) return 0;
  let n = 0;
  for (const tag of tags) {
    if (tag && tokenize(tag).some((t) => tokenSet.has(t))) n++;
  }
  return n;
}
