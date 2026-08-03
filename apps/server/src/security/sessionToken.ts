import type { Request, Response, NextFunction } from "express";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// 令五.6 / 契约 Gate D#15:本机 API session token。
//
// 威胁模型:OPC server 绑 127.0.0.1,但浏览器里的**恶意外部网页**可以驱动用户浏览器向
// http://127.0.0.1:<port> 发副作用请求(经典 CSRF)。仅靠 CORS 挡不住 —— CORS 只限制跨源
// **读响应**,不阻止请求本身**触发副作用**(index.ts 的 CORS 注释已自认这一点)。
//
// 防线:所有变更型请求(POST/PATCH/PUT/DELETE)必须携带 server 启动时生成的随机 token
// (X-OPC-Session-Token 头;SSE 等无法设自定义头的客户端可用 query token 兜底)。
// 外部网页拿不到该 token:
//   - 服务端把 token 注入首页 HTML 的 <meta>;跨源网页受同源策略限制,读不到我们的 HTML。
//   - GET /api/session/token 交出 token,但受 CORS 保护:非 loopback 源读不到响应体。
//   - 简单表单/图片等 CSRF 载体本就无法设置自定义请求头,发不出带 header token 的变更请求。
// 三者叠加 → 外部页面无法伪造带合法 token 的变更请求,CSRF 被根断。
//
// 加性/兼容:GET/HEAD/OPTIONS 只读放行(REST 语义下无副作用),既有 GET 端点零改动。

const HEADER_NAME = "x-opc-session-token";
// SSE(EventSource 不能设自定义 header)与其它无法设头的客户端用 query token 兜底。
const QUERY_KEYS = ["opcSessionToken", "token"] as const;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

let token: string | null = null;

// 进程内单例 token。优先取 env OPC_SESSION_TOKEN(父进程 —— Electron main / CLI —— 可预置并经
// env 下发给 server 和 worker 子进程,让三者共用同一 token);否则本进程随机生成。
export function getSessionToken(): string {
  if (token) return token;
  const fromEnv = process.env.OPC_SESSION_TOKEN?.trim();
  token = fromEnv && fromEnv.length >= 16 ? fromEnv : crypto.randomBytes(32).toString("hex");
  // 回填 env:此后 spawn 的 worker 子进程继承同一 token(a2aSdk 经 env 取用回调本机 API)。
  process.env.OPC_SESSION_TOKEN = token;
  return token;
}

// 最小请求形状,便于在无完整 express Request 的单测里直接调用。
interface TokenCarrier {
  header?: (name: string) => string | undefined;
  headers?: Record<string, unknown> | undefined;
  query?: Record<string, unknown> | undefined;
}

export function extractRequestToken(req: TokenCarrier): string | null {
  let h: unknown;
  if (typeof req.header === "function") h = req.header(HEADER_NAME);
  else if (req.headers) h = req.headers[HEADER_NAME];
  if (typeof h === "string" && h.trim()) return h.trim();
  const q = req.query;
  if (q) {
    for (const k of QUERY_KEYS) {
      const v = q[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// 供 SSE/非中间件路径显式校验(真实携带 token 走真实比对,无任何测试旁路)。
export function validateSessionToken(req: TokenCarrier): boolean {
  const provided = extractRequestToken(req);
  if (!provided) return false;
  return safeEqual(provided, getSessionToken());
}

// CORS 之后、路由注册之前挂载。变更型请求缺 token → 401;有 token 但不匹配 → 403;只读放行。
export function sessionAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  const provided = extractRequestToken(req as unknown as TokenCarrier);
  if (!provided) {
    res.status(401).json({ error: "missing session token", code: "session_token_required" });
    return;
  }
  if (!safeEqual(provided, getSessionToken())) {
    res.status(403).json({ error: "invalid session token", code: "session_token_invalid" });
    return;
  }
  next();
}

// 注入首页 HTML 的 <meta>(前端 lib/sessionToken.ts 读取)。跨源网页读不到我们的 HTML → 拿不到它。
export function sessionTokenMetaTag(): string {
  return `<meta name="opc-session-token" content="${getSessionToken()}">`;
}

// 把 token 注入 HTML <head>(有 </head> 则插在其前,否则前置一行),供 index.ts 的 "/" 首页处理器复用。
export function injectSessionTokenMeta(html: string): string {
  const tag = sessionTokenMetaTag();
  if (html.includes('name="opc-session-token"')) return html; // 幂等
  const headClose = html.indexOf("</head>");
  if (headClose >= 0) return html.slice(0, headClose) + tag + html.slice(headClose);
  return tag + html;
}

// 可选:把 token 写到用户级只读文件(**绝不**写仓库 .opc 提交区),供 CLI/Electron 兜底读取。
export function sessionTokenFilePath(): string {
  return path.join(os.homedir(), ".opc-studio", "session.json");
}

export function persistSessionTokenFile(port: number): void {
  try {
    const p = sessionTokenFilePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ token: getSessionToken(), port, pid: process.pid, updatedAt: new Date().toISOString() }),
      { encoding: "utf-8", mode: 0o600 },
    );
    try { fs.chmodSync(p, 0o600); } catch { /* Windows 无 POSIX 权限位,忽略 */ }
  } catch {
    /* best-effort:写不成也不影响 env/meta 两条主下发路径 */
  }
}
