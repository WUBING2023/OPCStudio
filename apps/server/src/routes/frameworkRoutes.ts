import type { Express } from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { probeAll } from "../runtime/engineRouter.js";
import { loadAccounts } from "../storage/providerStore.js";

export type CliFramework = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

export interface CliFrameworkSpec {
  fw: CliFramework;
  command: string;
  args: string[];
  envVar: "CLAUDE_CONFIG_DIR" | "CODEX_HOME" | "GEMINI_CLI_HOME" | "KIMI_CODE_HOME" | "GROK_HOME";
  defaultDir: string;
  credentialFiles?: string[];
  logoutUnsupportedReason?: string;
}

export function frameworkSpec(fw: string): CliFrameworkSpec | null {
  if (fw === "claude-code") {
    return { fw, command: "claude", args: ["auth", "login"], envVar: "CLAUDE_CONFIG_DIR", defaultDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), credentialFiles: [".credentials.json", "credentials.json"] };
  }
  if (fw === "codex") {
    return { fw, command: "codex", args: ["login"], envVar: "CODEX_HOME", defaultDir: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), credentialFiles: ["auth.json"] };
  }
  if (fw === "gemini-cli") {
    return { fw, command: "gemini", args: [], envVar: "GEMINI_CLI_HOME", defaultDir: process.env.GEMINI_CLI_HOME || os.homedir(), credentialFiles: [path.join(".gemini", "oauth_creds.json")] };
  }
  if (fw === "kimi-cli") {
    return { fw, command: "kimi", args: ["login"], envVar: "KIMI_CODE_HOME", defaultDir: process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code"), logoutUnsupportedReason: "Kimi 凭据文件位置未形成稳定公开契约；请在 Kimi 中执行 /logout，OPC 不会删除整个配置目录。" };
  }
  if (fw === "grok-build") {
    return { fw, command: "grok", args: ["login"], envVar: "GROK_HOME", defaultDir: process.env.GROK_HOME || path.join(os.homedir(), ".grok"), logoutUnsupportedReason: "Grok 登录态可能来自 OAuth、企业身份或 API Key；请运行 grok logout，OPC 不会猜测并删除配置文件。" };
  }
  return null;
}

function resolveRegisteredConfigDir(projectRoot: string, fw: CliFramework, requested?: string): string {
  if (!requested) return frameworkSpec(fw)!.defaultDir;
  const resolved = path.resolve(requested);
  const accounts = loadAccounts(projectRoot);
  const registered = accounts.some((a) => {
    if (!a.configDir) return false;
    if ((a.frameworks ?? []).length && !((a.frameworks ?? []) as readonly string[]).includes(fw)) return false;
    return path.resolve(a.configDir) === resolved;
  });
  if (!registered) throw new Error("configDir is not a registered account directory");
  return resolved;
}

function launchLoginTerminal(command: string, args: string[], env: NodeJS.ProcessEnv): boolean {
  try {
    if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "cmd.exe", "/k", command, ...args], { detached: true, stdio: "ignore", shell: false, windowsHide: false, env });
    } else if (process.platform === "darwin") {
      spawn("osascript", ["-e", `tell application "Terminal" to do script "${[command, ...args].join(" ").replace(/"/g, "\\\"")}"`], { detached: true, stdio: "ignore", shell: false, env });
    } else {
      spawn("x-terminal-emulator", ["-e", command, ...args], { detached: true, stdio: "ignore", shell: false, env });
    }
    return true;
  } catch {
    return false;
  }
}

export function register(app: Express, projectRoot: string) {
  app.get("/api/frameworks", async (_req, res) => {
    try {
      const frameworks = await probeAll();
      res.json({ frameworks });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "probe failed" });
    }
  });

  app.post("/api/frameworks/:fw/login", (req, res) => {
    const spec = frameworkSpec(req.params.fw);
    if (!spec) return res.status(400).json({ error: `framework ${req.params.fw} has no login flow` });
    const requestedConfigDir: string | undefined = typeof req.body?.configDir === "string" && req.body.configDir ? req.body.configDir : undefined;
    let configDir: string | undefined;
    try { configDir = requestedConfigDir ? resolveRegisteredConfigDir(projectRoot, spec.fw, requestedConfigDir) : undefined; }
    catch (e: any) { return res.status(403).json({ error: e?.message || "configDir is not allowed" }); }

    const env = { ...process.env };
    if (configDir) env[spec.envVar] = configDir;
    const launched = launchLoginTerminal(spec.command, spec.args, env);
    const command = [spec.command, ...spec.args].join(" ");
    const hint = configDir
      ? `Run ${command} with ${spec.envVar} set to the registered account directory, then refresh status.`
      : `Run ${command}, then refresh status.`;
    res.json({ launched, command, configDir, hint });
  });

  app.post("/api/frameworks/:fw/logout", (req, res) => {
    const spec = frameworkSpec(req.params.fw);
    if (!spec) return res.status(400).json({ error: `framework ${req.params.fw} has no logout flow` });
    if (!spec.credentialFiles) {
      return res.status(501).json({
        loggedOut: false,
        unsupported: true,
        error: spec.logoutUnsupportedReason || "无法安全确定该 CLI 的固定凭据文件，未执行删除。",
      });
    }
    const requestedConfigDir: string | undefined = typeof req.body?.configDir === "string" && req.body.configDir ? req.body.configDir : undefined;
    let dir: string;
    try { dir = resolveRegisteredConfigDir(projectRoot, spec.fw, requestedConfigDir); }
    catch (e: any) { return res.status(403).json({ error: e?.message || "configDir is not allowed" }); }

    let removed = 0;
    for (const f of spec.credentialFiles) {
      const p = path.join(dir, f);
      try { if (fs.existsSync(p) && fs.statSync(p).isFile()) { fs.unlinkSync(p); removed++; } } catch { /* best-effort */ }
    }
    res.json({ loggedOut: removed > 0, dir });
  });
}
