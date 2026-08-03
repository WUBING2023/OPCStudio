import { describe, it, expect, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import {
  getSessionToken,
  validateSessionToken,
  extractRequestToken,
  sessionAuthMiddleware,
  sessionTokenMetaTag,
  injectSessionTokenMeta,
} from "./sessionToken.js";
import { sessionAuthHeaders } from "../testutil/sessionTokenTestHelper.js";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

// 挂真实中间件的最小 server:GET 只读 + POST/PATCH/PUT/DELETE 变更 + 一个 SSE 形状 GET。
async function boot(): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use(sessionAuthMiddleware);
  app.get("/api/thing", (_req, res) => res.json({ ok: true, read: true }));
  app.post("/api/thing", (_req, res) => res.json({ ok: true, wrote: true }));
  app.patch("/api/thing", (_req, res) => res.json({ ok: true, patched: true }));
  app.put("/api/thing", (_req, res) => res.json({ ok: true, put: true }));
  app.delete("/api/thing", (_req, res) => res.json({ ok: true, deleted: true }));
  app.get("/api/events", (_req, res) => res.json({ ok: true, stream: true }));
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server!.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("sessionAuthMiddleware(变更型请求真实校验)", () => {
  it("POST 无 token → 401", async () => {
    const base = await boot();
    const r = await fetch(base + "/api/thing", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("session_token_required");
  });

  it("POST 错误 token → 403", async () => {
    const base = await boot();
    const r = await fetch(base + "/api/thing", {
      method: "POST",
      headers: { "content-type": "application/json", "x-opc-session-token": "definitely-not-the-real-token" },
      body: "{}",
    });
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("session_token_invalid");
  });

  it("POST 正确 header token → 200", async () => {
    const base = await boot();
    const r = await fetch(base + "/api/thing", {
      method: "POST", headers: { "content-type": "application/json", ...sessionAuthHeaders() }, body: "{}",
    });
    expect(r.status).toBe(200);
    expect((await r.json()).wrote).toBe(true);
  });

  it("POST 正确 query token → 200(SSE/无法设头的客户端可用)", async () => {
    const base = await boot();
    const r = await fetch(base + `/api/thing?opcSessionToken=${encodeURIComponent(getSessionToken())}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(r.status).toBe(200);
  });

  it("GET 只读放行(无 token 也 200,含 SSE /api/events)", async () => {
    const base = await boot();
    const r = await fetch(base + "/api/thing");
    expect(r.status).toBe(200);
    // SSE(GET)带任意 query token 也直接放行(只读无副作用)。
    const r2 = await fetch(base + "/api/events?opcSessionToken=whatever");
    expect(r2.status).toBe(200);
  });

  it("PATCH/PUT/DELETE 同受保护(无 token 401,带真实 token 200)", async () => {
    const base = await boot();
    for (const m of ["PATCH", "PUT", "DELETE"] as const) {
      const denied = await fetch(base + "/api/thing", { method: m });
      expect(denied.status).toBe(401);
      const allowed = await fetch(base + "/api/thing", { method: m, headers: { ...sessionAuthHeaders() } });
      expect(allowed.status).toBe(200);
    }
  });
});

describe("validateSessionToken / extractRequestToken", () => {
  it("接受 header token", () => {
    const req = { header: (n: string) => (n === "x-opc-session-token" ? getSessionToken() : undefined), query: {} };
    expect(validateSessionToken(req)).toBe(true);
    expect(extractRequestToken(req)).toBe(getSessionToken());
  });

  it("接受 query token(SSE 兜底,opcSessionToken 与 token 两个键)", () => {
    expect(validateSessionToken({ headers: {}, query: { opcSessionToken: getSessionToken() } })).toBe(true);
    expect(validateSessionToken({ headers: {}, query: { token: getSessionToken() } })).toBe(true);
  });

  it("缺失/错误 token → false", () => {
    expect(validateSessionToken({ headers: {}, query: {} })).toBe(false);
    expect(validateSessionToken({ headers: {}, query: { opcSessionToken: "wrong" } })).toBe(false);
  });
});

describe("token 进程内稳定 + 下发物", () => {
  it("同进程多次 getSessionToken 稳定且足够长", () => {
    expect(getSessionToken()).toBe(getSessionToken());
    expect(getSessionToken().length).toBeGreaterThanOrEqual(32);
  });

  it("meta tag 携带当前 token 且可幂等注入 HTML", () => {
    const tag = sessionTokenMetaTag();
    expect(tag).toContain(getSessionToken());
    expect(tag).toContain('name="opc-session-token"');
    const html = "<html><head><title>x</title></head><body></body></html>";
    const injected = injectSessionTokenMeta(html);
    expect(injected).toContain(getSessionToken());
    expect(injected.indexOf("</head>")).toBeGreaterThan(injected.indexOf("opc-session-token"));
    // 幂等:再注入不重复。
    expect(injectSessionTokenMeta(injected)).toBe(injected);
  });
});
