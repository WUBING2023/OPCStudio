import { getSessionToken } from "../security/sessionToken.js";

// 令五.6 测试连带 helper。
//
// 现状(重要):既有 ~50 个路由测试各自 `new express()` 且**不挂** sessionAuthMiddleware
// (只 register(app) 具体路由),因此加中间件后它们**不会** 401,无需批量接线。
// 这个 helper 只给"要经真实中间件跑变更型请求"的测试用 —— 携带**真实有效** token 走**真实**
// 校验路径,绝非"测试里关掉校验"的假绕过。
//
// 若将来有测试构造完整 server(挂 sessionAuthMiddleware)并要发 POST/PATCH/PUT/DELETE,
// 在该请求上 `...sessionAuthHeaders()` 即可,一行 setup、不改被测语义。

export function sessionAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  return { "x-opc-session-token": getSessionToken(), ...(extra ?? {}) };
}

export function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = { ...((init.headers as Record<string, string>) ?? {}), ...sessionAuthHeaders() };
  return fetch(input, { ...init, headers });
}

// SSE / 无法设自定义头的客户端:把真实 token 拼进 query。
export function sessionTokenQuery(): string {
  return `opcSessionToken=${encodeURIComponent(getSessionToken())}`;
}
