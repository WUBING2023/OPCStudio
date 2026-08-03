#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outputRoot = path.join(repoRoot, "evidence", "ecosystem-live", `host-selection-${stamp}`);
const reportPath = `${outputRoot}.json`;
const syntheticProjectRoot = path.join(outputRoot, "synthetic-project");
const syntheticServerUrl = "http://127.0.0.1:3199";
const runtimeCommand = path.join(repoRoot, "electron-app", "server-bundle", "node-runtime", "node.exe");
const serverEntry = path.join(repoRoot, "electron-app", "server-bundle", "dist", "index.js");
function findSecuredDistribution() {
  const evidenceRoot = path.join(repoRoot, "evidence", "ecosystem-live");
  const reports = fs.readdirSync(evidenceRoot)
    .filter((name) => /^plugin-host-secure-.*\.json$/.test(name))
    .sort()
    .reverse();
  for (const reportName of reports) {
    const report = parseJson(fs.readFileSync(path.join(evidenceRoot, reportName), "utf-8"));
    if (!report?.ok || !report?.allPinned) continue;
    const distribution = path.join(evidenceRoot, reportName.slice(0, -5), "distribution");
    if (fs.existsSync(distribution)) return distribution;
  }
  throw new Error("No passing identity-pinned plugin distribution is available");
}
const prompt = "Use the OPC Studio integration to list the available company names. Do not inspect repository files and do not run shell commands. Return only the company names in JSON.";
fs.mkdirSync(outputRoot, { recursive: true });
fs.mkdirSync(syntheticProjectRoot, { recursive: true });

function safeEnvironment(extra = {}) {
  const env = { ...process.env, ...extra, OPC_SERVER_URL: syntheticServerUrl };
  for (const key of Object.keys(env)) {
    if (key === "OPC_KEYS_DIR" || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)) delete env[key];
  }
  return env;
}

const syntheticServer = spawn(runtimeCommand, ["--conditions=production", serverEntry], {
  cwd: repoRoot,
  env: safeEnvironment({ PORT: "3199", OPC_PROJECT_ROOT: syntheticProjectRoot }),
  stdio: "ignore",
  windowsHide: true,
});
process.on("exit", () => { if (!syntheticServer.killed) syntheticServer.kill(); });

async function waitForSyntheticServer() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${syntheticServerUrl}/api/health`);
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Synthetic OPC Server did not become healthy");
}

await waitForSyntheticServer();

function resolveCommand(name) {
  const envPath = String(process.env.Path || process.env.PATH || "");
  for (const directory of envPath.split(path.delimiter)) {
    for (const extension of process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""]) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${name}${extension}`);
      if (!fs.existsSync(candidate)) continue;
      if (name === "claude" && extension === ".cmd") {
        const native = path.join(path.dirname(candidate), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (fs.existsSync(native)) return native;
      }
      return candidate;
    }
  }
  return name;
}

function run(name, args, timeout = 180_000) {
  const command = resolveCommand(name);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: safeEnvironment({ NO_COLOR: "1" }),
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    input: "",
    timeout,
  });
  return {
    command: [command, ...args],
    ok: result.status === 0 && !result.error,
    exitCode: typeof result.status === "number" ? result.status : 1,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
  };
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

const securedDistribution = findSecuredDistribution();

const codex = { pre: run("codex", ["plugin", "list", "--json"]), steps: [], model: null, post: null };
let codexMarketplaceAdded = false;
let codexPluginInstalled = false;
try {
  const addMarketplace = run("codex", ["plugin", "marketplace", "add", path.join(securedDistribution, "codex"), "--json"]);
  codex.steps.push(addMarketplace);
  if (!addMarketplace.ok) throw new Error("Codex marketplace install failed");
  codexMarketplaceAdded = true;
  const addPlugin = run("codex", ["plugin", "add", "opc-studio@opc-studio-codex", "--json"]);
  codex.steps.push(addPlugin);
  if (!addPlugin.ok) throw new Error("Codex plugin install failed");
  codexPluginInstalled = true;
  codex.model = run("codex", ["exec", "--ephemeral", "--sandbox", "read-only", "--json", prompt]);
  fs.writeFileSync(path.join(outputRoot, "codex-events.jsonl"), codex.model.stdout, "utf-8");
} finally {
  if (codexPluginInstalled) codex.steps.push(run("codex", ["plugin", "remove", "opc-studio@opc-studio-codex", "--json"]));
  if (codexMarketplaceAdded) codex.steps.push(run("codex", ["plugin", "marketplace", "remove", "opc-studio-codex", "--json"]));
  codex.post = run("codex", ["plugin", "list", "--json"]);
}

const claudeRoot = path.join(securedDistribution, "claude");
const claude = {
  prePlugins: run("claude", ["plugin", "list", "--json"]),
  preMarketplaces: run("claude", ["plugin", "marketplace", "list", "--json"]),
  steps: [],
  model: null,
  postPlugins: null,
  postMarketplaces: null,
};
const claudePrePlugins = parseJson(claude.prePlugins.stdout);
const claudePreMarketplaces = parseJson(claude.preMarketplaces.stdout);
if (!Array.isArray(claudePrePlugins) || !Array.isArray(claudePreMarketplaces)) {
  throw new Error("Could not snapshot Claude plugin state");
}
if (claudePrePlugins.some((entry) => String(entry?.id || "").startsWith("opc-studio@")) ||
    claudePreMarketplaces.some((entry) => entry?.name === "opc-studio-claude")) {
  throw new Error("Refusing to replace an existing user OPC Studio Claude plugin");
}
let claudeInstalled = false;
try {
  const install = run("powershell", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(claudeRoot, "scripts", "install.ps1"),
    "-Scope", "user", "-McpCommand", runtimeCommand, "-McpArgs", path.join(repoRoot, "electron-app", "server-bundle", "cli-dist", "mcp", "index.js"),
  ]);
  claude.steps.push(install);
  if (!install.ok) throw new Error("Claude plugin install failed");
  claudeInstalled = true;
  claude.model = run("claude", [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode", "dontAsk",
    "--setting-sources", "user",
    prompt,
  ]);
  fs.writeFileSync(path.join(outputRoot, "claude-events.jsonl"), claude.model.stdout, "utf-8");
} finally {
  if (claudeInstalled) {
    claude.steps.push(run("powershell", [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(claudeRoot, "scripts", "uninstall.ps1"),
      "-Scope", "user", "-RemoveMarketplace",
    ]));
  }
  claude.postPlugins = run("claude", ["plugin", "list", "--json"]);
  claude.postMarketplaces = run("claude", ["plugin", "marketplace", "list", "--json"]);
}

const codexPre = parseJson(codex.pre.stdout);
const codexPost = parseJson(codex.post.stdout);
const codexRestored = JSON.stringify(codexPre) === JSON.stringify(codexPost);
const claudeRestored = JSON.stringify(claudePrePlugins) === JSON.stringify(parseJson(claude.postPlugins.stdout)) &&
  JSON.stringify(claudePreMarketplaces) === JSON.stringify(parseJson(claude.postMarketplaces.stdout));
const result = {
  schemaVersion: 1,
  gate: "real-host-model-tool-selection",
  generatedAt: new Date().toISOString(),
  prompt,
  expectedTool: "list_companies",
  paidProviderCallsAllowed: true,
  syntheticIsolation: {
    projectRoot: syntheticProjectRoot,
    serverUrl: syntheticServerUrl,
    realOpcDataExposed: false,
  },
  codex: {
    ok: Boolean(codex.model?.ok && /list_companies/.test(codex.model.stdout)),
    selectedTool: /list_companies/.test(codex.model?.stdout || ""),
    userPluginStateRestored: codexRestored,
    model: codex.model,
    lifecycle: codex.steps,
  },
  claude: {
    ok: Boolean(claude.model?.ok && /list_companies/.test(claude.model.stdout)),
    selectedTool: /list_companies/.test(claude.model?.stdout || ""),
    userPluginStateRestored: claudeRestored,
    model: claude.model,
    lifecycle: claude.steps,
  },
};
result.ok = result.codex.ok && result.codex.userPluginStateRestored && result.claude.ok && result.claude.userPluginStateRestored;
fs.writeFileSync(reportPath, `${JSON.stringify(result, null, 2)}\n`, "utf-8");
syntheticServer.kill();
process.stdout.write(`${JSON.stringify({ ok: result.ok, codex: result.codex.ok, codexRestored, claude: result.claude.ok, claudeRestored, reportPath })}\n`);
process.exitCode = result.ok ? 0 : 1;
