import type { Express } from "express";
import { webSearch } from "../runtime/webSearch.js";

// 服务端联网搜索:走 OPC 服务进程(网络正常)请求 DuckDuckGo Lite 并解析结果。供 worker(经服务端注入)及
// 调试使用 —— 绕开 worker 子进程在 Clash TUN 等代理环境下连本机回环都被拦截、无法自行联网的问题。
// 搜索逻辑见 runtime/webSearch.ts(编排器注入复用同一实现)。

export function register(app: Express, _projectRoot: string) {
  app.get("/api/web/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) return res.status(400).json({ error: "q required" });
    try {
      const results = await webSearch(q, 10);
      res.json({ query: q, count: results.length, results });
    } catch (e: any) {
      res.status(502).json({ error: "search failed: " + (e?.message || String(e)) });
    }
  });
}
