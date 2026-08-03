#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sessionRoot = path.join(repoRoot, "evidence", "ecosystem-live", `plugin-host-${stamp}`);
const reportPath = `${sessionRoot}.json`;
fs.mkdirSync(sessionRoot, { recursive: true });

function sanitizedEnvironment(extra) {
  const env = { ...process.env, ...extra, CI: "1", NO_COLOR: "1" };
  for (const key of Object.keys(env)) {
    if (
      key === "OPC_KEYS_DIR"
      || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)
      || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
    ) delete env[key];
  }
  return env;
}

function resolveHostCommand(host, env) {
  if (process.platform !== "win32") return host;
  const extensions = [".exe", ".cmd", ".bat", ".com"];
  for (const directory of String(env.Path || env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${host}${extension}`);
      if (!fs.existsSync(candidate)) continue;
      if (host === "claude" && extension === ".cmd") {
        const nativeClaude = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (fs.existsSync(nativeClaude)) return nativeClaude;
      }
      return candidate;
    }
  }
  return host;
}

function run(host, args, env) {
  const started = Date.now();
  const executable = resolveHostCommand(host, env);
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    env,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    timeout: 60_000,
  });
  return {
    command: [executable, ...args],
    ok: result.status === 0 && !result.error,
    exitCode: typeof result.status === "number" ? result.status : 1,
    durationMs: Date.now() - started,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: String(result.stdout || "").slice(-20_000),
    stderr: String(result.stderr || "").slice(-20_000),
  };
}

function executeLifecycle(host, env, commands) {
  const results = [];
  for (const args of commands) {
    const result = run(host, args, env);
    results.push(result);
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${host} ${args.join(" ")}\n`);
    if (!result.ok) break;
  }
  return results;
}

const codexHome = path.join(sessionRoot, "codex-home");
const claudeHome = path.join(sessionRoot, "claude-home");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(claudeHome, { recursive: true });

const codex = executeLifecycle("codex", sanitizedEnvironment({ CODEX_HOME: codexHome }), [
  ["plugin", "marketplace", "add", path.join(repoRoot, "integrations", "codex"), "--json"],
  ["plugin", "marketplace", "list", "--json"],
  ["plugin", "add", "opc-studio@opc-studio-codex", "--json"],
  ["plugin", "list", "--json"],
  ["plugin", "remove", "opc-studio@opc-studio-codex", "--json"],
  ["plugin", "marketplace", "remove", "opc-studio-codex", "--json"],
]);

const claude = executeLifecycle("claude", sanitizedEnvironment({ CLAUDE_CONFIG_DIR: claudeHome }), [
  ["plugin", "validate", path.join(repoRoot, "integrations", "claude")],
  ["plugin", "marketplace", "add", path.join(repoRoot, "integrations", "claude"), "--scope", "user"],
  ["plugin", "marketplace", "list", "--json"],
  ["plugin", "install", "opc-studio@opc-studio-claude", "--scope", "user"],
  ["plugin", "list", "--json"],
  ["plugin", "uninstall", "opc-studio@opc-studio-claude", "--scope", "user", "--keep-data"],
  ["plugin", "marketplace", "remove", "opc-studio-claude", "--scope", "user"],
]);

const all = [...codex, ...claude];
const report = {
  schemaVersion: 1,
  gate: "real-host-plugin-lifecycle",
  generatedAt: new Date().toISOString(),
  isolatedHostConfiguration: true,
  existingHostConfigurationTouched: false,
  paidProviderCallsAllowed: false,
  ok: all.length === 13 && all.every((result) => result.ok),
  codex,
  claude,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stdout.write(`Plugin host lifecycle evidence: ${reportPath}\n`);
process.exitCode = report.ok ? 0 : 1;
