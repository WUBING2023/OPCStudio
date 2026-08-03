import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const SECURITY_TESTS = [
  "apps/server/src/security/pathGuard.test.ts",
  "apps/server/src/security/localGuards.test.ts",
  "apps/server/src/security/credentialBroker.test.ts",
  "apps/server/src/security/redact.test.ts",
  "apps/server/src/routes/mcpRoutes.test.ts",
  "apps/server/src/runtime/mcpToolBridge.test.ts",
  "apps/server/src/runtime/mcpApproval.test.ts",
  "apps/server/src/runtime/parallelExecutor.workingDirectory.test.ts",
  "apps/server/src/runtime/evidenceManifest.test.ts",
  "apps/server/src/runtime/evidenceManifest.permissions.test.ts",
  "apps/server/src/runtime/evidenceReceipts.test.ts",
  "apps/server/src/runtime/effectiveCapabilities.test.ts",
  "apps/server/src/runtime/workerLaunchReceipt.test.ts",
  "apps/server/src/runtime/taskGraphScheduler.test.ts",
  "apps/server/src/storage/taskGraphStore.test.ts",
  "apps/server/src/runtime/startupReconcile.test.ts",
  "apps/server/src/runtime/eventBus.persist.test.ts",
  "apps/server/src/storage/jsonFile.releaseGate.test.ts",
  "apps/server/src/storage/wave5PersistenceFaultInjection.releaseGate.test.ts",
  "apps/server/src/runtime/engines/CodexEngine.acp.test.ts",
  "apps/server/src/runtime/engines/acpWorkerBackend.test.ts",
  "apps/server/src/runtime/engines/CodexNativeEngine.test.ts",
  "apps/server/src/runtime/engines/ClaudeNativeEngine.test.ts",
  "apps/cli/src/plugins/distribution.test.ts",
  "apps/cli/src/plugins/distribution.lifecycle.test.ts",
  "apps/web/src/components/trace/ExecutionPermissionPosture.test.ts",
];

const reportPath = path.resolve(
  process.cwd(),
  process.env.OPC_SECURITY_GATE_REPORT || "evidence/release-matrix/security-release-gate-result.json",
);

function sanitizedEnvironment() {
  const env = { ...process.env, OPC_STORAGE_BACKEND: "json", CI: "1" };
  for (const key of Object.keys(env)) {
    if (
      key === "OPC_KEYS_DIR" ||
      /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key) ||
      /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
    ) {
      delete env[key];
    }
  }
  return env;
}

const packageManagerEntry = process.env.npm_execpath;
const command = packageManagerEntry ? process.execPath : "pnpm";
const args = packageManagerEntry
  ? [packageManagerEntry, "exec", "vitest", "run", ...SECURITY_TESTS]
  : ["exec", "vitest", "run", ...SECURITY_TESTS];
const startedAt = new Date().toISOString();
const started = Date.now();
const result = spawnSync(command, args, {
  cwd: process.cwd(),
  env: sanitizedEnvironment(),
  encoding: "utf-8",
  shell: false,
});

const exitCode = typeof result.status === "number" ? result.status : 1;
const ok = exitCode === 0 && !result.error;
const report = {
  schemaVersion: 1,
  gate: "security-release-gate",
  startedAt,
  completedAt: new Date().toISOString(),
  durationMs: Date.now() - started,
  providerCredentialsRemoved: true,
  testFiles: SECURITY_TESTS,
  command: [command, ...args],
  exitCode,
  ok,
  error: result.error ? String(result.error.message || result.error) : null,
  stdoutTail: String(result.stdout || "").slice(-20_000),
  stderrTail: String(result.stderr || "").slice(-20_000),
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

if (result.error) {
  console.error(`security release gate could not start: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`security release gate failed with exit code ${result.status ?? "unknown"}`);
  process.exit(result.status ?? 1);
}

console.log(`security release gate passed (${SECURITY_TESTS.length} files)`);
console.log(`security release gate evidence: ${reportPath}`);
