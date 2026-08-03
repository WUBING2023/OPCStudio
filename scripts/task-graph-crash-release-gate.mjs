#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.resolve(
  repoRoot,
  process.env.OPC_TASK_GRAPH_CRASH_REPORT
    || "evidence/release-matrix/task-graph-crash-recovery-result.json",
);
const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
const testFile = "apps/server/src/runtime/taskGraphCrash.releaseGate.test.ts";

if (!fs.existsSync(vitestCli)) throw new Error(`Local Vitest CLI not found: ${vitestCli}`);

const env = {
  ...process.env,
  CI: "1",
  OPC_STORAGE_BACKEND: "json",
  OPC_PAID_PROVIDER_DISABLED: "1",
  OPC_TASK_GRAPH_CRASH_EVIDENCE: reportPath,
};
for (const key of Object.keys(env)) {
  if (
    key === "OPC_KEYS_DIR"
    || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)
    || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
  ) delete env[key];
}

const startedAt = Date.now();
const result = spawnSync(process.execPath, [vitestCli, "run", testFile, "-t", "release gate"], {
  cwd: repoRoot,
  env,
  encoding: "utf-8",
  shell: false,
  windowsHide: true,
  timeout: 180_000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
} catch (error) {
  process.stderr.write(`Crash recovery evidence was not generated: ${error instanceof Error ? error.message : String(error)}\n`);
}

const generatedAt = Date.parse(report?.generatedAt ?? "");
const reportIsFresh = Number.isFinite(generatedAt) && generatedAt >= startedAt;
const ok = result.status === 0
  && !result.error
  && report?.ok === true
  && report?.trueProcessTermination === true
  && report?.completedScenarios === report?.expectedScenarios
  && reportIsFresh;

process.stdout.write(`\nTask Graph crash recovery evidence: ${reportPath}\n`);
process.stdout.write(`Result: ${ok ? "PASS" : "FAIL"}\n`);
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exitCode = ok ? 0 : 1;
