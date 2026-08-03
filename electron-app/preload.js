const { contextBridge, shell } = require("electron");

// 令五.6:把本机 API session token 从主进程 env(main.js 生成并经 spawn env 下发给 server)桥接到
// 渲染层 window.opc.sessionToken,供前端注入变更型请求(见 apps/web/src/lib/sessionToken.ts)。
// 只读字符串,不泄露任何 Node 能力;server 首页也内联同一 token 的 <meta> 作为冗余下发路径。
let sessionToken = "";
try {
  sessionToken = (process && process.env && process.env.OPC_SESSION_TOKEN) || "";
} catch {
  sessionToken = "";
}

// Minimal, safe bridge (contextIsolation: true). Exposes only a version string, the session
// token, and an open-external helper — no Node APIs leak to the renderer.
contextBridge.exposeInMainWorld("opc", {
  version: "0.1.0",
  sessionToken,
  openExternal: (url) => {
    if (typeof url === "string" && /^https?:\/\//.test(url)) shell.openExternal(url);
  },
});
