import type { Express } from "express";
import { loadConfig } from "../storage/projectStore.js";
import { loadGithubAuth, saveGithubAuth, clearGithubAuth } from "../storage/githubTokenStore.js";

// per-user GitHub 登录(Device Flow,不需 client_secret,可分发)。每个用户用自己账号 → 拿自己的 token。
// client_id 非密钥,可公开内置:env OPC_GITHUB_CLIENT_ID > config.github.oauth.clientId > 内置默认(OPC Studio OAuth App)。
const DEFAULT_GITHUB_CLIENT_ID = "Ov23lirXBQYzwYAUyjIY"; // OPC Studio OAuth App(已开 Device Flow)
const GH = "https://github.com";
const API = "https://api.github.com";
const SCOPE = "public_repo"; // fork / PR / issue reaction 都够;public_repo 也能调 /user

const GH_HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "OPC-Studio", "X-GitHub-Api-Version": "2022-11-28" };

async function ghLogin(token: string): Promise<string | undefined> {
  try {
    const r = await fetch(`${API}/user`, { headers: { ...GH_HEADERS, Authorization: `Bearer ${token}` } });
    if (!r.ok) return undefined;
    return (await r.json() as { login?: string })?.login;
  } catch { return undefined; }
}

export function register(app: Express, projectRoot: string) {
  const clientId = (): string => process.env.OPC_GITHUB_CLIENT_ID || loadConfig(projectRoot).github?.oauth?.clientId || DEFAULT_GITHUB_CLIENT_ID;

  // 当前登录状态(连了谁;env PAT 也算已连)。
  app.get("/api/github/status", (_req, res) => {
    const a = loadGithubAuth(projectRoot);
    const envTok = process.env.OPC_GITHUB_TOKEN || process.env.OPC_GITHUB_ACCESS_TOKEN;
    res.json({
      connected: !!(a?.accessToken || envTok),
      login: a?.login,
      source: a?.accessToken ? "oauth" : envTok ? "env" : null,
      clientIdConfigured: !!clientId(),
    });
  });

  // 设备流第一步:取 user_code + 验证地址,前端展示给用户去 github.com/login/device 输码。
  app.post("/api/github/device/start", async (_req, res) => {
    const cid = clientId();
    try {
      const r = await fetch(`${GH}/login/device/code`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cid, scope: SCOPE }),
      });
      const d = await r.json() as any;
      if (d.error) {
        return res.status(400).json({ error: d.error_description || d.error, hint: d.error === "device_flow_disabled" ? "该 OAuth App 未开启 Device Flow:去 App 设置勾选 Enable Device Flow" : undefined });
      }
      res.json({ deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, verificationUriComplete: d.verification_uri_complete, interval: d.interval || 5, expiresIn: d.expires_in });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // 设备流轮询:用 device_code 换 token;未授权返回 pending,授权后存 token + 取 login。
  app.post("/api/github/device/poll", async (req, res) => {
    const cid = clientId();
    const deviceCode = req.body?.deviceCode;
    if (!deviceCode) return res.status(400).json({ error: "deviceCode required" });
    try {
      const r = await fetch(`${GH}/login/oauth/access_token`, {
        method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: cid, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
      });
      const d = await r.json() as any;
      if (d.access_token) {
        const login = await ghLogin(d.access_token);
        saveGithubAuth(projectRoot, { accessToken: d.access_token, login, scope: d.scope, connectedAt: new Date().toISOString() });
        return res.json({ connected: true, login });
      }
      if (d.error === "authorization_pending" || d.error === "slow_down") return res.json({ pending: true, slowDown: d.error === "slow_down" });
      return res.status(400).json({ error: d.error_description || d.error || "授权失败" });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  app.post("/api/github/logout", (_req, res) => { clearGithubAuth(projectRoot); res.json({ ok: true }); });
}
