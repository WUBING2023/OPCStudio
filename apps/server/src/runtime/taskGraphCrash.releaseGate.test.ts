import { afterAll, afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type CrashScenario =
  | "before_dispatch"
  | "after_spawn"
  | "after_artifact_commit"
  | "after_test"
  | "after_node_persist"
  | "after_run_finished";

interface FixtureResult {
  reconciled?: number;
  dispatchCount?: number;
  graphStatus?: string;
  nodeStatus?: string;
  uncertain?: boolean;
  attempt?: number;
  startedReceipt?: boolean;
  completionReceipt?: boolean;
  artifactHashes?: Record<string, string>;
}

interface ScenarioEvidence {
  scenario: CrashScenario;
  childPid: number;
  forcedTermination: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  crashPoint: FixtureResult;
  reconciled: FixtureResult;
  resumed: FixtureResult;
  artifactHashesBefore: Record<string, string>;
  artifactHashesAfter: Record<string, string>;
  ok: boolean;
}

const fixture = fileURLToPath(new URL("./taskGraphCrashFixture.ts", import.meta.url));
const repoRoot = path.resolve(path.dirname(fixture), "../../../..");
const pnpmModules = path.join(repoRoot, "node_modules", ".pnpm");
const tsxPackage = fs.readdirSync(pnpmModules).find(name => name.startsWith("tsx@"));
if (!tsxPackage) throw new Error(`Local tsx runtime not found under ${pnpmModules}`);
const tsxLoader = pathToFileURL(path.join(pnpmModules, tsxPackage, "node_modules", "tsx", "dist", "loader.mjs")).href;
const roots: string[] = [];
const evidence: ScenarioEvidence[] = [];
const supported = process.platform === "win32" || process.platform === "linux" || process.platform === "darwin";
const processCrashDescribe = supported ? describe : describe.skip;

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, OPC_STORAGE_BACKEND: "json", CI: "1" };
  for (const key of Object.keys(env)) {
    if (
      key === "OPC_KEYS_DIR"
      || /(?:^|_)(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/.test(key)
      || /^(?:OPENAI|ANTHROPIC|DEEPSEEK|MINIMAX|DOUBAO|GEMINI|GOOGLE|GROK|XAI|KIMI|MOONSHOT|GLM|ZHIPU)_/.test(key)
    ) delete env[key];
  }
  return env;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function workspaceHashes(root: string): Record<string, string> {
  const workspace = path.join(root, "workspace");
  if (!fs.existsSync(workspace)) return {};
  return Object.fromEntries(
    fs.readdirSync(workspace, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => [entry.name, hashFile(path.join(workspace, entry.name))]),
  );
}

async function waitForCrashPoint(
  child: ChildProcess,
  readyFile: string,
  stderr: () => string,
): Promise<FixtureResult> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyFile)) return readJson<FixtureResult>(readyFile);
    if (child.exitCode !== null) {
      throw new Error(`Crash fixture exited before reaching its crash point (${child.exitCode}): ${stderr()}`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for crash fixture ${child.pid}: ${stderr()}`);
}

async function forceTerminate(child: ChildProcess): Promise<{
  requested: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}> {
  const exited = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const requested = child.kill("SIGKILL");
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Failed to terminate fixture ${child.pid}`)), 10_000)),
  ]);
  return { requested, ...result };
}

function runFixture(command: "reconcile" | "resume", root: string): FixtureResult {
  const resultFile = path.join(root, `${command}-result.json`);
  const result = spawnSync(process.execPath, ["--import", tsxLoader, fixture, command, root, resultFile], {
    cwd: repoRoot,
    env: sanitizedEnvironment(),
    encoding: "utf-8",
    shell: false,
    windowsHide: true,
    timeout: 30_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} fixture failed (${result.status}): ${result.error?.message ?? result.stderr}`);
  }
  return readJson<FixtureResult>(resultFile);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows handle release */ }
  }
});

afterAll(() => {
  const output = process.env.OPC_TASK_GRAPH_CRASH_EVIDENCE;
  if (!output) return;
  const expected = 6;
  const report = {
    schemaVersion: 1,
    gate: "task-graph-process-crash-recovery",
    generatedAt: new Date().toISOString(),
    generatedBy: "taskGraphCrash.releaseGate.test.ts",
    platform: process.platform,
    nodeVersion: process.version,
    trueProcessTermination: true,
    paidProviderCallsAllowed: false,
    expectedScenarios: expected,
    completedScenarios: evidence.length,
    ok: evidence.length === expected && evidence.every(row => row.ok),
    scenarios: evidence,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
});

processCrashDescribe("release gate: true process Task Graph crash recovery", () => {
  const cases: CrashScenario[] = [
    "before_dispatch",
    "after_spawn",
    "after_artifact_commit",
    "after_test",
    "after_node_persist",
    "after_run_finished",
  ];

  it.each(cases)("release gate: %s survives forced process termination", async scenario => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `opc-crash-${scenario}-`));
    roots.push(root);
    const readyFile = path.join(root, "crash-ready.json");
    let stderr = "";
    const child = spawn(process.execPath, ["--import", tsxLoader, fixture, "crash", root, scenario], {
      cwd: repoRoot,
      env: sanitizedEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stderr.on("data", chunk => { stderr += String(chunk); });

    const crashPoint = await waitForCrashPoint(child, readyFile, () => stderr);
    const artifactHashesBefore = workspaceHashes(root);
    const terminated = await forceTerminate(child);
    const reconciled = runFixture("reconcile", root);
    const resumed = runFixture("resume", root);
    const artifactHashesAfter = workspaceHashes(root);

    const preDispatch = scenario === "before_dispatch";
    const incompleteSideEffect = scenario === "after_spawn"
      || scenario === "after_artifact_commit"
      || scenario === "after_test";
    const completionPersisted = scenario === "after_node_persist" || scenario === "after_run_finished";
    const artifactsStable = preDispatch
      ? resumed.dispatchCount === 1
      : JSON.stringify(artifactHashesAfter) === JSON.stringify(artifactHashesBefore);
    const stateCorrect = preDispatch
      ? reconciled.graphStatus === "committed" && reconciled.nodeStatus === "planned" && resumed.dispatchCount === 1
      : incompleteSideEffect
        ? reconciled.graphStatus === "failed" && reconciled.nodeStatus === "blocked"
          && reconciled.uncertain === true && resumed.dispatchCount === 0
        : completionPersisted
          ? reconciled.graphStatus === "completed" && reconciled.nodeStatus === "completed"
            && reconciled.uncertain === false && resumed.dispatchCount === 0
          : false;
    const row: ScenarioEvidence = {
      scenario,
      childPid: child.pid!,
      forcedTermination: terminated.requested,
      exitCode: terminated.exitCode,
      exitSignal: terminated.signal,
      crashPoint,
      reconciled,
      resumed,
      artifactHashesBefore,
      artifactHashesAfter,
      ok: terminated.requested && stateCorrect && artifactsStable,
    };
    evidence.push(row);

    expect(terminated.requested).toBe(true);
    expect(terminated.exitCode === null || terminated.exitCode !== 0).toBe(true);
    expect(stateCorrect).toBe(true);
    expect(artifactsStable).toBe(true);
    if (incompleteSideEffect) {
      expect(crashPoint.startedReceipt).toBe(true);
      expect(crashPoint.completionReceipt).toBe(false);
      expect(reconciled.attempt).toBe(1);
      expect(resumed.attempt).toBe(1);
    }
    if (completionPersisted) {
      expect(crashPoint.completionReceipt).toBe(true);
      expect(resumed.completionReceipt).toBe(true);
    }
  }, 60_000);
});
