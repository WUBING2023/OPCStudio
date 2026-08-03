// Stage 9 安全:统一密钥脱敏。用于 ① 落盘/事件内容(events.jsonl/trace/report——会经 Stage 8 分享出去)
// ② API 响应(config 的 apiKeys 不回明文)。本地单用户 D5 也要,因为这些数据会流出本机。

// 常见密钥/令牌模式 → [REDACTED]。
const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,            // openai/deepseek/anthropic 风格
  /\bark-[A-Za-z0-9_-]{8,}\b/g,          // doubao/volc
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,     // Authorization: Bearer ...
  /(["']?(?:api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|access[_-]?token|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
];

export function redactSecrets(input: unknown): string {
  let s = typeof input === "string" ? input : String(input ?? "");
  for (const re of PATTERNS) {
    s = s.replace(re, (m, p1) => (p1 ? `${p1}[REDACTED]` : "[REDACTED]"));
  }
  return s;
}

// Stage 9 安全:给 CLI 引擎子进程的 env —— 去掉本 agent 用不到的 provider key / secret / token,
// 只保留它自己 provider 的 key(引擎确实需要)。缩小爆炸半径:worker 内置 shell 即便 printenv,
// 也读不到其他 provider 的 key / github clientSecret 等。保留所有非密钥系统 env(PATH/HOME/…)避免破坏引擎。
const SECRET_ENV_RE = /(_API_KEY|_SECRET|_TOKEN|CLIENT_SECRET|ACCESS_TOKEN|PASSWORD)$/i;

// A1-V3 运行时护栏:roleProfile.envAllowlist 之外仍然放行的"进程运行基线"。profile 的 allowlist 以
// POSIX 常见变量为主(HOME/PATH/TMPDIR/…),照单全砍会让 Windows 子进程根本跑不起来(SystemRoot/
// ComSpec/PATHEXT)或全员断网(代理/CA 变量)。envAllowlist 的设计意图是防凭据泄漏(见 roleProfile.ts
// 字段注释),不是搞坏进程运行时——断网是 networkMode 的职责,不借 env 过滤实现。
// 注意:基线只含"指针/基础设施"类变量,凭据类变量(*_API_KEY/*_TOKEN/…)仍先被 SECRET_ENV_RE 剥除。
const ESSENTIAL_SPAWN_ENV = new Set([
  // Windows 进程基础
  "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "PATHEXT", "OS",
  "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS",
  "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA",
  "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
  "ALLUSERSPROFILE", "PUBLIC", "USERNAME", "COMPUTERNAME", "TMP", "TEMP",
  // POSIX 对应
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "LC_ALL",
  // 出网基础:代理与 CA(经代理出网的机器砍了 = 全员断网)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  // 引擎 home/config 目录指针(路径而非凭据本体;凭据仍受 SECRET_ENV_RE 约束)
  "CLAUDE_CONFIG_DIR", "CODEX_HOME",
]);

// envAllowlist(A1-V3):allowlist 非空时,在 SECRET_ENV_RE 之上叠加角色白名单——
// 只放行 ① 自己 provider 的 key ② 白名单命中(大小写不敏感,Windows env 名不区分大小写)
// ③ ESSENTIAL_SPAWN_ENV 基线。缺省(undefined/空数组)= 未启用白名单,行为与旧版完全一致(全放行)。
// 白名单不能"复活"被 SECRET_ENV_RE 剥除的其他密钥(deny 优先)。
export function filteredSpawnEnv(provider?: string, envAllowlist?: string[]): NodeJS.ProcessEnv {
  const keep = provider ? `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY` : "";
  const allow = envAllowlist && envAllowlist.length > 0
    ? new Set(envAllowlist.map((n) => n.toUpperCase()))
    : null;
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    const upper = k.toUpperCase();
    if (SECRET_ENV_RE.test(k) && upper !== keep) continue; // 移除其他密钥,保留自己 provider 的
    if (allow && upper !== keep && !allow.has(upper) && !ESSENTIAL_SPAWN_ENV.has(upper)) continue;
    out[k] = v;
  }
  return out;
}

// 配置里的 apiKeys 不向 API 回传明文:只告诉前端"哪些 provider 已配 key"(true),不给原文。
export function maskConfigSecrets<T extends Record<string, any>>(config: T): T {
  const c: any = { ...config };
  if (c.apiKeys && typeof c.apiKeys === "object") {
    c.apiKeys = Object.fromEntries(Object.entries(c.apiKeys).map(([k, v]) => [k, v ? "***" : ""]));
  }
  if (c.github?.oauth && typeof c.github.oauth === "object") {
    c.github = { ...c.github, oauth: { ...c.github.oauth } };
    if (c.github.oauth.clientSecret) c.github.oauth.clientSecret = "***";
    if (c.github.oauth.accessToken) c.github.oauth.accessToken = "***";
  }
  if (Array.isArray(c.providers)) {
    c.providers = c.providers.map((p: any) => (p && p.apiKey ? { ...p, apiKey: "***" } : p));
  }
  return c as T;
}
