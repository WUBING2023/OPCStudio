#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.resolve(
  repoRoot,
  process.env.OPC_MUP_REPORT ||
    process.env.OPC_PHASE6_REPORT ||
    "evidence/release-matrix/mup-deterministic-result.json",
);

const scenarioSpecs = {
  evidenceFailClosed: {
    description: "Evidence manifest rejects missing, empty, mismatched, and unwritable targets",
    testFile: "apps/server/src/runtime/evidenceManifest.test.ts",
  },
  cancellation: {
    description: "Abort stops new dispatch, drains in-flight nodes, and forbids writes after terminal state",
    testFile: "apps/server/src/runtime/taskGraphScheduler.test.ts",
  },
  restartRecovery: {
    description: "Started-without-completion side effects become uncertain and are not redispatched",
    testFile: "apps/server/src/runtime/startupReconcile.test.ts",
  },
  processCrashRecovery: {
    description: "A real child Core is force-terminated at durable Task Graph crash points and recovers without duplicate side effects",
    testFile: "apps/server/src/runtime/taskGraphCrash.releaseGate.test.ts",
  },
  concurrentGraphs: {
    description: "Different graph updates are preserved and a node lease has only one owner",
    testFile: "apps/server/src/storage/taskGraphStore.test.ts",
  },
  bundleRoundTrip: {
    description: "Full company bundle survives export/import with only allowlisted identity changes",
    testFile: "apps/server/src/runtime/roundTripFidelity.test.ts",
  },
  memoryReuse: {
    description: "Committed memory reaches prompt, clean reuse is recorded, uncertain reuse cannot strengthen it",
    testFile: "apps/server/src/runtime/memoryReuseReleaseGate.test.ts",
  },
};

function sanitizedEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === "OPC_KEYS_DIR" ||
      /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key) ||
      /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
    ) {
      delete env[key];
    }
  }
  env.CI = "1";
  env.OPC_PHASE6_DETERMINISTIC = "1";
  env.OPC_PAID_PROVIDER_DISABLED = "1";
  return env;
}

function tail(value, max = 12_000) {
  const content = String(value || "");
  return content.length <= max ? content : content.slice(content.length - max);
}

const startedAt = new Date().toISOString();
const vitestCli = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs");
if (!fs.existsSync(vitestCli)) throw new Error(`Local Vitest CLI not found: ${vitestCli}`);
const scenarioResults = {};
for (const [name, spec] of Object.entries(scenarioSpecs)) {
  const args = [vitestCli, "run", spec.testFile, "-t", "release gate"];
  const command = [process.execPath, ...args];
  const started = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: sanitizedEnvironment(),
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
  });
  const exitCode = typeof result.status === "number" ? result.status : 1;
  const ok = exitCode === 0 && !result.error;
  scenarioResults[name] = {
    ...spec,
    ok,
    exitCode,
    durationMs: Date.now() - started,
    command,
    error: result.error ? String(result.error.message || result.error) : null,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
  };
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} (${scenarioResults[name].durationMs}ms)\n`);
  if (!ok) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
}
const ok = Object.values(scenarioResults).every((scenario) => scenario.ok);
const report = {
  schemaVersion: 1,
  matrix: "mup-deterministic-release-gates",
  startedAt,
  completedAt: new Date().toISOString(),
  paidProviderCallsAllowed: false,
  providerCredentialsRemoved: true,
  ok,
  scenarios: scenarioResults,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
process.stdout.write(`\nMUP deterministic report: ${reportPath}\n`);
process.exitCode = report.ok ? 0 : 1;
