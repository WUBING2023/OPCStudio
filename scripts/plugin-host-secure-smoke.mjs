#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const sessionRoot = path.join(repoRoot, "evidence", "ecosystem-live", `plugin-host-secure-${stamp}`);
const distributionRoot = path.join(sessionRoot, "distribution");
const reportPath = `${sessionRoot}.json`;
const runtimeCommand = path.resolve(repoRoot, "electron-app", "server-bundle", "node-runtime", "node.exe");
const runtimeEntry = path.resolve(repoRoot, "electron-app", "server-bundle", "cli-dist", "mcp", "index.js");
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

for (const required of [runtimeCommand, runtimeEntry, powershell]) {
  if (!fs.existsSync(required)) throw new Error(`Required secure smoke runtime is missing: ${required}`);
}
fs.mkdirSync(sessionRoot, { recursive: true });
fs.cpSync(path.join(repoRoot, "integrations"), distributionRoot, { recursive: true });

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
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
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

function run(executable, args, env, cwd = repoRoot) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    timeout: 90_000,
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

function runHost(host, args, env) {
  return run(resolveHostCommand(host, env), args, env);
}

function runPowerShell(script, args, env) {
  return run(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...args], env);
}

function normalize(value) {
  return path.resolve(String(value)).toLowerCase();
}

function inspectPinnedDistribution(platform) {
  const pluginRoot = path.join(distributionRoot, platform, "plugins", "opc-studio");
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf-8"));
  const policy = JSON.parse(fs.readFileSync(path.join(pluginRoot, "opc-plugin.manifest.json"), "utf-8"));
  const server = mcp.mcpServers["opc-studio"];
  const expectedArgs = [runtimeEntry];
  return {
    platform,
    command: server.command,
    args: server.args,
    absolute: path.isAbsolute(server.command),
    commandMatches: normalize(server.command) === normalize(runtimeCommand),
    argsMatch: JSON.stringify(server.args.map(normalize)) === JSON.stringify(expectedArgs.map(normalize)),
    policyCommandMatches: normalize(policy.commandEntrypoint.command) === normalize(runtimeCommand),
    policyArgsMatch: JSON.stringify(policy.commandEntrypoint.args.map(normalize)) === JSON.stringify(expectedArgs.map(normalize)),
    delegatedCommandMatches: normalize(policy.permissions.delegated.command) === normalize(runtimeCommand),
  };
}

function runPlatform(platform) {
  const host = platform === "codex" ? "codex" : "claude";
  const hostHome = path.join(sessionRoot, `${platform}-home`);
  fs.mkdirSync(hostHome, { recursive: true });
  const env = sanitizedEnvironment(platform === "codex" ? { CODEX_HOME: hostHome } : { CLAUDE_CONFIG_DIR: hostHome });
  const root = path.join(distributionRoot, platform);
  const scripts = path.join(root, "scripts");
  const results = [];

  if (platform === "claude") results.push(runHost(host, ["plugin", "validate", root], env));
  const installArgs = ["-McpCommand", runtimeCommand, "-McpArgs", runtimeEntry];
  if (platform === "claude") installArgs.unshift("-Scope", "user");
  results.push(runPowerShell(path.join(scripts, "install.ps1"), installArgs, env));
  results.push(runHost(host, ["plugin", "list", "--json"], env));
  results.push(runPowerShell(path.join(scripts, "smoke.ps1"), [], env));
  const pinned = inspectPinnedDistribution(platform);
  const uninstallArgs = platform === "claude" ? ["-Scope", "user", "-RemoveMarketplace"] : ["-RemoveMarketplace"];
  results.push(runPowerShell(path.join(scripts, "uninstall.ps1"), uninstallArgs, env));
  return { platform, isolatedHostHome: hostHome, pinned, results };
}

const platforms = [runPlatform("codex"), runPlatform("claude")];
for (const platform of platforms) {
  for (const result of platform.results) {
    process.stdout.write(`${result.ok ? "PASS" : "FAIL"} ${platform.platform} ${result.command.slice(1).join(" ")}\n`);
  }
}
const allPinned = platforms.every(({ pinned }) => pinned.absolute
  && pinned.commandMatches
  && pinned.argsMatch
  && pinned.policyCommandMatches
  && pinned.policyArgsMatch
  && pinned.delegatedCommandMatches);
const report = {
  schemaVersion: 1,
  gate: "identity-pinned-real-host-plugin-lifecycle",
  generatedAt: new Date().toISOString(),
  isolatedHostConfiguration: true,
  existingHostConfigurationTouched: false,
  paidProviderCallsAllowed: false,
  runtimeCommand,
  runtimeEntry,
  allPinned,
  ok: allPinned && platforms.every(({ results }) => results.every((result) => result.ok)),
  platforms,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stdout.write(`Secure plugin host lifecycle evidence: ${reportPath}\n`);
process.exitCode = report.ok ? 0 : 1;
