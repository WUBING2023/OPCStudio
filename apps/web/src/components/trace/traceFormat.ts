// 任务档案的纯格式化函数——绝对时间/相对时间/时长/token/金额/report.md 摘要截断。
// 不依赖组件状态，方便在 TaskCard / ResultSection / BillingSection 间复用。

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false });
}

// 相对时间("3 小时前")——超过 30 天回退绝对日期，避免"3 个月前"这类粗粒度还要处理闰年/月份长度。
export function fmtRelativeTime(iso: string | null | undefined, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return fmtTime(iso); // 时钟漂移等异常，回退绝对时间
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return t("trace.time.justNow");
  const m = Math.floor(s / 60);
  if (m < 60) return t("trace.time.minutesAgo", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("trace.time.hoursAgo", { n: h });
  const days = Math.floor(h / 24);
  if (days < 30) return t("trace.time.daysAgo", { n: days });
  return fmtTime(iso);
}

// 时长("2h 14m" / "6m 3s" / "42s")。
export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function fmtTokens(n: number | undefined): string {
  return ((n ?? 0)).toLocaleString("en-US");
}

// 群聊剧本(ChatReplay/chatScript.ts)用:把 markdown 装饰"抹平"成纯聊天文本——聊天气泡不是文档
// 渲染器，粗体/代码块/表格挤在一个小气泡里反而难读，不如去装饰后当自然语言呈现。规则与下面
// extractSummarySnippet 的"去装饰"部分同源，但这里保留全文（多段落/换行），不做摘要截断。
export function stripMd(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/^```\w*\n?/, "").replace(/```\s*$/, "").trim())
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .trim();
}

// 从 report.md 里截"一句话结果摘要"——取首个非标题/非分隔线/非表格行的自然段，
// 去掉 markdown 装饰后截断到 maxLen 字。取不到有意义的内容时返回空串(调用方兜底显示"点击查看")。
export function extractSummarySnippet(md: string | null | undefined, maxLen = 80): string {
  if (!md) return "";
  let paragraph = "";
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line) || /^\|.*\|$/.test(line)) {
      if (paragraph) break; // 已经收集到内容，遇到空行/分隔线即该段落结束
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (paragraph) break;
      continue; // 标题行本身不算摘要内容，跳过继续找下一段
    }
    paragraph += (paragraph ? " " : "") + line;
  }
  const cleaned = paragraph
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#*_>]/g, "")
    .trim();
  if (!cleaned) return "";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen).trim()}…` : cleaned;
}
