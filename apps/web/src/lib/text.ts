// 乱码健壮化:含 U+FFFD(�)的文本多为 GBK/UTF-8 错编码的历史数据。
// cleanText:若含 U+FFFD,丢掉最后一个 � 之前的乱码前缀,保留后面干净内容;否则原样返回。
export function cleanText(s: string | null | undefined): string {
  if (!s) return "";
  if (!s.includes("�")) return s;
  const last = s.lastIndexOf("�");
  let tail = s.slice(last + 1).replace(/^[^一-龥a-zA-Z0-9#]+/, "").trim();
  if (tail) return tail;
  // 全是乱码 → 去掉 � 后看还剩什么
  const stripped = s.replace(/[�]+/g, "").replace(/^[^一-龥a-zA-Z0-9#]+/, "").trim();
  return stripped || "(历史内容编码异常)";
}

export const hasGarble = (s: string | null | undefined): boolean => !!s && s.includes("�");
