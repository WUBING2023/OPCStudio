// P3 · 记忆安全摘要导出的脱敏层。与 redact.ts(密钥/token 模式匹配)是并列关注点:
// 这里处理的是"具体公司名/员工名/本机绝对路径/联系方式"——即便内容本身(方法论/教训)适合对外分享,
// 这些身份/路径信息也不该带出去。策略是"已知名称列表替换"(不是实体识别),外加一层保守正则兜底。
//
// 已知简化(如实说明,不假装完备):
// - 公司名/员工名替换是**大小写敏感的精确子串替换**,不做模糊匹配/分词识别;不在传入名单里的名字不会被认出。
// - 绝对路径/邮箱/手机号用正则识别,覆盖常见形态,不追求 100% 召回(例如中间被换行打断的路径可能漏检)。
// - safeToShare 是保守判定:只要脱敏后仍能看到"像路径/像邮箱/像手机号"的残留,或任一已知名称仍原样出现,
//   就判 false——宁可多拦一次要求人工复核,不做"看起来还行就放行"的乐观判断。

export interface SanitizeMemoryTextInput {
  text: string;
  companyNames?: string[];
  memberNames?: string[];
}

export interface SanitizeMemoryTextResult {
  text: string;
  safeToShare: boolean;
}

// 绝对路径:Windows 盘符路径 / UNC 共享路径 / 2 段以上反斜杠路径(盘符前缀被截断后的残留兜底)/ 类 Unix 多段路径。
const WIN_DRIVE_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'<>]*/g;
const UNC_PATH_RE = /\\\\[^\s"'<>]+/g;
const BACKSLASH_SEGMENTS_RE = /(?:[^\s\\]+\\){2,}[^\s\\]+/g;
const UNIX_ABS_PATH_RE = /\/(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+/g;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 中国大陆手机号:1[3-9]开头 11 位,前后不能紧跟数字(防止匹配到更长数字串里的子串)。
const CN_MOBILE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

const PATTERNS: Array<{ re: RegExp; placeholder: string }> = [
  { re: WIN_DRIVE_PATH_RE, placeholder: "[路径已隐去]" },
  { re: UNC_PATH_RE, placeholder: "[路径已隐去]" },
  { re: UNIX_ABS_PATH_RE, placeholder: "[路径已隐去]" },
  { re: BACKSLASH_SEGMENTS_RE, placeholder: "[路径已隐去]" },
  { re: EMAIL_RE, placeholder: "[邮箱已隐去]" },
  { re: CN_MOBILE_RE, placeholder: "[手机号已隐去]" },
];

function scrubPatterns(text: string): string {
  let out = text;
  for (const { re, placeholder } of PATTERNS) out = out.replace(re, placeholder);
  return out;
}

// 去重 + 去空白/过短(<2 字符的名字误伤面太大,不参与替换)+ 按长度降序(长名字先替换,防止短名字是长名字子串时替换错位)。
function normalizeNames(names: string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const n = (raw ?? "").trim();
    if (n.length < 2 || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
  }
  return out.sort((a, b) => b.length - a.length);
}

// 已知名称列表替换:纯字符串 split/join(不是正则),避免名字里含正则特殊字符时出错或误匹配。
function replaceKnownNames(text: string, companyNames: string[], memberNames: string[]): string {
  const entities = [
    ...normalizeNames(companyNames).map((name) => ({ name, placeholder: "某公司" })),
    ...normalizeNames(memberNames).map((name) => ({ name, placeholder: "某成员" })),
  ].sort((a, b) => b.name.length - a.name.length);
  let out = text;
  for (const { name, placeholder } of entities) out = out.split(name).join(placeholder);
  return out;
}

// safeToShare 判定逻辑:独立导出,可直接对任意文本判断(不依赖是否先跑过 sanitizeMemoryText)——
// 供 sanitizeMemoryText 内部复用,也供上层/测试单独校验"这段文本现在能不能安全对外"。
export function isSafeToShare(text: string, knownNames: string[] = []): boolean {
  for (const { re } of PATTERNS) {
    if ([...text.matchAll(re)].length > 0) return false;
  }
  for (const n of normalizeNames(knownNames)) {
    if (text.includes(n)) return false;
  }
  return true;
}

// 主入口:脱敏一段文本,返回替换后的文本 + safeToShare。全程 best-effort、纯字符串处理,不抛错
// (输入非字符串时按空串处理,不影响调用方)。
export function sanitizeMemoryText(input: SanitizeMemoryTextInput): SanitizeMemoryTextResult {
  const raw = typeof input.text === "string" ? input.text : String(input.text ?? "");
  const companyNames = normalizeNames(input.companyNames);
  const memberNames = normalizeNames(input.memberNames);
  let out = scrubPatterns(raw);
  out = replaceKnownNames(out, companyNames, memberNames);
  const safeToShare = isSafeToShare(out, [...companyNames, ...memberNames]);
  return { text: out, safeToShare };
}
