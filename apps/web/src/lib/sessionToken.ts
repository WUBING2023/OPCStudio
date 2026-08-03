// 令五.6 前端侧:读取本机 API session token,注入所有变更型请求(见 api/client.ts)。
//
// 取值优先级(全部同源/进程内,外部网页拿不到):
//   1) 已缓存值(拿过一次就复用,进程内 token 稳定)。
//   2) 首页 HTML 的 <meta name="opc-session-token">(server 生产环境注入;跨源网页读不到我们的 HTML)。
//   3) Electron preload 经 contextBridge 暴露的 window.opc.sessionToken(env 下发)。
//   4) 兜底:GET /api/session/token(dev 下 vite 提供 HTML、无 meta 时用;受 CORS 保护,跨源读不到)。
//
// GET/HEAD 只读请求本不需要 token(服务端放行),但四个 client 函数统一注入以保持一致、并覆盖
// 未来可能收紧的端点;拿不到 token 时静默不加 header(不阻断请求,由服务端按需 401)。

let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

function fromMeta(): string | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector('meta[name="opc-session-token"]');
  const c = el?.getAttribute("content");
  return c && c.trim() ? c.trim() : null;
}

function fromBridge(): string | null {
  const w = globalThis as unknown as { opc?: { sessionToken?: unknown } };
  const t = w?.opc?.sessionToken;
  return typeof t === "string" && t.trim() ? t.trim() : null;
}

// 同步快照:不触发网络。meta/bridge 命中即缓存。
export function peekSessionToken(): string | null {
  if (cached) return cached;
  const sync = fromMeta() ?? fromBridge();
  if (sync) cached = sync;
  return cached;
}

function fetchSessionToken(): Promise<string | null> {
  return fetch("/api/session/token", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { token?: unknown } | null) => {
      const t = j && typeof j.token === "string" ? j.token : null;
      if (t) cached = t;
      return t;
    })
    .catch(() => null)
    .finally(() => { inflight = null; });
}

export function invalidateSessionToken(): void {
  cached = null;
  inflight = null;
}

// Server may restart inside the same browser/Electron process. A 401 means the
// cached meta/bridge value can be stale, so force a same-origin network refresh.
export function refreshSessionToken(): Promise<string | null> {
  invalidateSessionToken();
  inflight = fetchSessionToken();
  return inflight;
}

// 异步解析:同步拿不到时,兜底 GET /api/session/token(只发一次,inflight 去重)。
export async function getSessionToken(): Promise<string | null> {
  const sync = peekSessionToken();
  if (sync) return sync;
  if (inflight) return inflight;
  inflight = fetchSessionToken();
  return inflight;
}
