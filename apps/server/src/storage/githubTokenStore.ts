import * as fs from "node:fs";
import * as path from "node:path";

// per-user GitHub OAuth token(设备流拿到的、用户自己账号的 token)。独立文件,不进 config.json 明文。
// 应被 gitignore(.opc/ 下)。scope 走 public_repo,够 fork/PR/reaction。
export interface GithubAuth {
  accessToken: string;
  login?: string;
  scope?: string;
  connectedAt: string;
}

function file(projectRoot: string): string { return path.join(projectRoot, ".opc", "github_oauth.json"); }

export function loadGithubAuth(projectRoot: string): GithubAuth | null {
  try { return JSON.parse(fs.readFileSync(file(projectRoot), "utf-8")) as GithubAuth; } catch { return null; }
}
export function saveGithubAuth(projectRoot: string, auth: GithubAuth): void {
  const p = file(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(auth, null, 2));
}
export function clearGithubAuth(projectRoot: string): void {
  try { fs.unlinkSync(file(projectRoot)); } catch { /* not present */ }
}

// share/贡献流程用:解析当前可用的 GitHub token。
// 优先级:**交互式登录(OAuth 存储)> env > config 旧字段**。
// 桌面应用主认证是"用 GitHub 登录"按钮——用户点过登录就该用那个账号;env 仅作无登录时(headless/CI)的兜底。
// (也避免"环境里残留一个无 scope 的旧 PAT"盖过用户刚登录拿到的可写 token。)
export function resolveGithubToken(projectRoot: string, configToken?: string): string | undefined {
  return loadGithubAuth(projectRoot)?.accessToken || process.env.OPC_GITHUB_TOKEN || process.env.OPC_GITHUB_ACCESS_TOKEN || configToken || undefined;
}
