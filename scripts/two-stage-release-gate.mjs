#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.resolve(
  repoRoot,
  process.env.OPC_TWO_STAGE_GATE_REPORT
    || "evidence/release-matrix/two-stage-release-gate-result.json",
);
const packageManagerEntry = process.env.npm_execpath;

function sanitizedEnvironment() {
  const env = {
    ...process.env,
    CI: "1",
    OPC_PAID_PROVIDER_DISABLED: "1",
    OPC_TWO_STAGE_RELEASE_GATE: "1",
  };
  for (const key of Object.keys(env)) {
    if (
      key === "OPC_KEYS_DIR"
      || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)
      || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
    ) delete env[key];
  }
  return env;
}

function tail(value, max = 20_000) {
  const content = String(value || "");
  return content.length <= max ? content : content.slice(content.length - max);
}

function packageManagerCommand(args) {
  return packageManagerEntry
    ? { command: process.execPath, args: [packageManagerEntry, ...args] }
    : { command: "pnpm", args };
}

function runStep(step) {
  const started = Date.now();
  const invocation = step.kind === "pnpm"
    ? packageManagerCommand(step.args)
    : { command: process.execPath, args: [path.resolve(repoRoot, step.script)] };
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: sanitizedEnvironment(),
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    timeout: step.timeoutMs,
  });
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const ok = exitCode === 0 && !result.error;
  const record = {
    description: step.description,
    ok,
    exitCode,
    durationMs: Date.now() - started,
    command: [invocation.command, ...invocation.args],
    error: result.error ? String(result.error.message || result.error) : null,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${step.name} (${record.durationMs}ms)\n`);
  if (!ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return record;
}

function gitValue(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  return result.status === 0 ? String(result.stdout || "").trim() : null;
}

const steps = [
  {
    name: "typecheck",
    kind: "pnpm",
    args: ["-r", "typecheck"],
    timeoutMs: 10 * 60_000,
    description: "All workspace packages pass TypeScript checking",
  },
  {
    name: "fullTests",
    kind: "pnpm",
    args: ["test"],
    timeoutMs: 30 * 60_000,
    description: "The complete Vitest suite passes in a credential-free environment",
  },
  {
    name: "securityGate",
    kind: "pnpm",
    args: ["run", "test:security-gate"],
    timeoutMs: 15 * 60_000,
    description: "Security-critical path, credential, MCP, Evidence, and recovery tests pass",
  },
  {
    name: "processCrashRecovery",
    kind: "node",
    script: "scripts/task-graph-crash-release-gate.mjs",
    timeoutMs: 10 * 60_000,
    description: "A force-terminated child Core recovers without duplicate side effects",
  },
  {
    name: "deterministicMupMatrix",
    kind: "node",
    script: "scripts/phase6-release-matrix.mjs",
    timeoutMs: 15 * 60_000,
    description: "Deterministic evidence, cancellation, recovery, concurrency, bundle, and memory gates pass",
  },
  {
    name: "productionBuild",
    kind: "pnpm",
    args: ["run", "build"],
    timeoutMs: 15 * 60_000,
    description: "Shared, Server, CLI, and Web production builds complete",
  },
];

const startedAt = new Date().toISOString();
const results = {};
for (const step of steps) results[step.name] = runStep(step);

const report = {
  schemaVersion: 1,
  gate: "opc-two-stage-release-gate",
  startedAt,
  completedAt: new Date().toISOString(),
  git: {
    commit: gitValue(["rev-parse", "HEAD"]),
    branch: gitValue(["branch", "--show-current"]),
    dirty: Boolean(gitValue(["status", "--porcelain"])),
  },
  environment: {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    paidProviderCallsAllowed: false,
    credentialsRemoved: true,
  },
  ok: Object.values(results).every((result) => result.ok),
  results,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stdout.write(`\nTwo-stage release gate report: ${reportPath}\n`);
process.exitCode = report.ok ? 0 : 1;
