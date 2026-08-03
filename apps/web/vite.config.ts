import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// MUP B5:server 只绑 127.0.0.1(apps/server/src/index.ts),proxy 目标必须写 IPv4 字面量——
// Windows 上 localhost 可能解析成 ::1,代理间歇性连不上就是"实时连接已断开"横幅的来源之一。
// 有源码契约测试锁定(src/viteProxyContract.test.ts),改动需成对更新。
export const API_PROXY_TARGET = "http://127.0.0.1:3100";

// 令五.6:变更型请求带 X-OPC-Session-Token 头,SSE 带 query token。vite dev proxy(基于 http-proxy)
// 默认原样透传所有请求头与 query 到 target,无需额外配置(不设置任何 headers 改写/剥离)。dev 下前端
// 经 GET /api/session/token 兜底取 token(见 apps/web/src/lib/sessionToken.ts)。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy: { "/api": { target: API_PROXY_TARGET, changeOrigin: false } } },
});
