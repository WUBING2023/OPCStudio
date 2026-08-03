// 服务端联网搜索(DuckDuckGo Lite,无需 key)。OPC 服务进程网络正常,故由它代为检索 —— worker 子进程
// 在某些环境(如 Clash TUN 代理)下连本机回环都被拦截,无法自行联网;服务端搜好再注入其提示词即可绕开。

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export interface WebResult { title: string; url: string; snippet: string; }

function strip(s: string): string {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x2F;/g, "/")
    .replace(/\s+/g, " ").trim();
}
function decodeDuckUrl(href: string): string {
  const m = href.match(/uddg=([^&]+)/);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return href; } }
  return href.startsWith("//") ? "https:" + href : href;
}

export async function webSearch(query: string, limit = 10): Promise<WebResult[]> {
  const r = await fetch("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), {
    headers: { "user-agent": UA, "accept-language": "en;q=0.9,zh-CN;q=0.8" },
    signal: AbortSignal.timeout(15000),
  });
  const html = await r.text();
  const linkRe = /<a\s+([^>]*?class=['"]result-link['"][^>]*?)>([\s\S]*?)<\/a>/g;
  const snipRe = /<td\s+class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g;
  const links: { url: string; title: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null && links.length < limit) {
    const hm = m[1].match(/href=['"]([^'"]+)['"]/);
    if (hm) links.push({ url: decodeDuckUrl(hm[1]), title: strip(m[2]) });
  }
  const snips: string[] = [];
  let s: RegExpExecArray | null;
  while ((s = snipRe.exec(html)) !== null) snips.push(strip(s[1]));
  return links.map((l, i) => ({ title: l.title, url: l.url, snippet: (snips[i] || "").slice(0, 400) }));
}

// 把搜索结果格式化为注入 worker 提示词的 Markdown 简报;失败/无结果返回空串(绝不打断运行)。
// 从可能带「元指令前缀」的任务文本里提炼真正的检索 query。研究任务常被包成
// "深度研究任务(请联网多源检索…不要凭记忆作答):\n\n<真问题>" —— 直接拿整段当 query 会让 DDG 搜到
// "深度研究/SKILL.md" 之类垃圾(W2 实测)。这里:按空行切段,丢掉含元指令关键词的前导段,取真问题。
export function extractQuery(raw: string): string {
  const parts = (raw || "").split(/\n\n+/).map((s) => s.trim()).filter(Boolean);
  const META = /(深度研究任务|请联网|多源检索|不要凭记忆|派给研究团队|标注来源|research team|do not fabricate)/;
  const substantive = parts.filter((p) => !META.test(p));
  const pick = (substantive.length ? substantive : parts).sort((a, b) => b.length - a.length)[0] || raw;
  return pick.replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function buildWebBrief(query: string, limit = 6): Promise<string> {
  // 实验用加性开关:统一检索 Broker 接管时关闭 OPC 内部检索,让各配置只用注入的同一证据包(去混淆)。
  // 默认未设 = 原行为,零回归。
  if (process.env.OPC_DISABLE_WEBBRIEF === "1") return "";
  const q = extractQuery(query);
  if (!q) return "";
  try {
    const results = await webSearch(q, limit);
    if (!results.length) return "";
    const body = results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n");
    return `\n\n## 联网检索结果(服务端已替你联网搜好,基于这些真实网页写结论并标注来源 URL;不要编造)\n查询:${q}\n${body}\n`;
  } catch {
    return "";
  }
}
