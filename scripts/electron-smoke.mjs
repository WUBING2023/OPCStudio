#!/usr/bin/env node
// Clean-environment Electron acceptance automation.
//
// This drives the *packaged desktop contract* as far as it can be driven
// headlessly. The OPC desktop app (electron-app/main.js) boots a self-contained
// server bundle by launching the Electron binary as a bare Node runtime
// (ELECTRON_RUN_AS_NODE=1 + --conditions=production) and then loads the web UI
// into a BrowserWindow. This smoke reproduces the *server half* of that contract
// byte-for-byte — same bundle, same Electron-as-Node launch, same session-token
// env handshake — and exercises the real HTTP surface an operator would hit:
//
//   boot #1 (Electron-as-Node) → GET /api/health 200
//     → POST /api/companies (create, token-gated)
//     → GET  /api/companies (the company is listed)
//     → [optional, opt-in] POST /api/runs (dispatch one minimal task)
//     → GET  /api/runs (history) + GET /api/runs/:id/artifacts + download
//     → kill the whole process tree → assert the port is released
//   boot #2 (restart) → GET /api/health 200 again (proves a clean restart and
//     that boot #1 fully released the tree/port), same project root so any
//     dispatched run persists and is queryable after restart → kill → cleanup.
//
// What this does NOT cover (reported honestly as a known tension, not hidden):
//   * A real Electron *BrowserWindow* + renderer round-trip (clicking through the
//     GUI). That needs a display server / Spectron-class driver and a full NSIS
//     install; it stays in the Windows-only live matrix.
//   * The NSIS installer artifact itself (electron-builder --win nsis).
//
// Flags:
//   --dispatch   Actually POST /api/runs (a REAL task; may incur cost if provider
//                keys are configured). Default OFF — the run steps are skipped and
//                marked accordingly. When on, we first assert no run is in flight.
//   --node       Force plain-Node boot instead of the Electron binary (fallback
//                for machines without electron installed). Default: use Electron
//                as Node when the binary resolves.
//
// Emits a JSON report to stdout and exits non-zero on any hard failure.

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.ELECTRON_SMOKE_PORT || "3198";
const pnpmExecPath = process.env.npm_execpath;
const SESSION_TOKEN = process.env.OPC_SESSION_TOKEN?.trim() || crypto.randomBytes(32).toString("hex");

const args = new Set(process.argv.slice(2));
const DO_DISPATCH = args.has("--dispatch");
const FORCE_NODE = args.has("--node");

// Resolve the Electron binary path. Outside Electron, `require("electron")`
// returns the absolute path to the executable — the exact binary main.js runs as
// `process.execPath` inside the packaged app.
let electronBinary = null;
if (!FORCE_NODE) {
  try {
    const resolved = require("electron");
    if (typeof resolved === "string" && existsSync(resolved)) electronBinary = resolved;
  } catch { /* electron not installed → fall back to node */ }
}
const bootRuntime = electronBinary ? "electron-as-node" : "node";

const report = {
  ok: false,
  port: PORT,
  bootRuntime,
  dispatch: DO_DISPATCH,
  steps: [],
  knownTensions: [],
  startedAt: new Date().toISOString(),
};

function step(name, fn) {
  const t0 = Date.now();
  try {
    const detail = fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
    return detail;
  } catch (err) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(err && err.message || err) });
    throw err;
  }
}

async function stepAsync(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    report.steps.push({ name, ok: true, ms: Date.now() - t0, ...(detail ? { detail } : {}) });
    return detail;
  } catch (err) {
    report.steps.push({ name, ok: false, ms: Date.now() - t0, error: String(err && err.message || err) });
    throw err;
  }
}

function runPnpm(cmdArgs, opts = {}) {
  // Preferred: pnpm's JS CLI via npm_execpath (set when launched under pnpm) —
  // keeps argv structured, no shell interpolation. Fallback for a bare `node
  // scripts/electron-smoke.mjs` invocation: the `pnpm` command on PATH (needs a
  // shell on Windows, where it's pnpm.cmd).
  const res = pnpmExecPath
    ? spawnSync(process.execPath, [pnpmExecPath, ...cmdArgs], { cwd: repoRoot, stdio: "inherit", shell: false, ...opts })
    : spawnSync("pnpm", cmdArgs, { cwd: repoRoot, stdio: "inherit", shell: true, ...opts });
  if (res.error) throw new Error(`pnpm ${cmdArgs.join(" ")} failed to spawn: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`pnpm ${cmdArgs.join(" ")} exited with code ${res.status}`);
}

// Kill a process *tree*. On Windows taskkill /T reaches the server's Worker
// children (a bare kill does not); on POSIX we signal the process group (the
// server is spawned detached below so the group id == pid).
function killTree(pid) {
  if (pid == null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch {} }
    }
  } catch { /* best effort */ }
}

function request(method, apiPath, { body, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(payload.length);
    }
    if (method !== "GET" && method !== "HEAD") headers["x-opc-session-token"] = SESSION_TOKEN;
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: apiPath, method, headers, timeout },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(raw); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode, body: raw, json });
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(timeout, () => req.destroy(new Error(`${method} ${apiPath} timeout`)));
    if (payload) req.write(payload);
    req.end();
  });
}

function getHealth() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${PORT}/api/health`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("health request timeout")));
  });
}

async function waitForHealth(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await getHealth();
      if (r.status === 200) return { attempt: i + 1, body: r.body };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`server did not return health 200 within ${retries}s`);
}

// Boot the deployed server bundle as the packaged app would: the Electron binary
// in ELECTRON_RUN_AS_NODE mode (or plain node as a fallback), with the same
// --conditions=production flag and OPC_SESSION_TOKEN handshake main.js uses.
function bootServer(bundle, projectRoot) {
  const runtimeExe = electronBinary || process.execPath;
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(PORT),
    OPC_PROJECT_ROOT: projectRoot,
    OPC_WEB_DIST: path.join(repoRoot, "apps", "web", "dist"),
    OPC_SESSION_TOKEN: SESSION_TOKEN,
  };
  const opts = { cwd: bundle, env, stdio: ["ignore", "pipe", "pipe"], shell: false };
  if (process.platform !== "win32") opts.detached = true;
  const proc = spawn(runtimeExe, ["--conditions=production", path.join(bundle, "dist", "index.js")], opts);
  proc.stdout.on("data", () => {});
  proc.stderr.on("data", () => {});
  return proc;
}

async function assertPortReleased() {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    await getHealth();
    throw new Error("server still responding after kill — tree not fully torn down");
  } catch (e) {
    if (String(e.message).includes("still responding")) throw e;
    return "released";
  }
}

let stageDir;
let projectRoot;
let serverProc;

async function main() {
  step("build:server-chain", () => {
    runPnpm(["--filter", "@opc/shared", "build"]);
    runPnpm(["--filter", "@opc/server", "build"]);
  });

  stageDir = step("mkdtemp+deploy", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opc-electron-smoke-"));
    const bundle = path.join(dir, "server-bundle");
    // Same self-contained deploy electron-app/server-bundle is staged from.
    runPnpm(["--filter", "@opc/server", "--legacy", "deploy", "--prod", bundle]);
    const entry = path.join(bundle, "dist", "index.js");
    if (!existsSync(entry)) throw new Error(`deploy produced no ${entry}`);
    if (!existsSync(path.join(bundle, "node_modules", "@opc", "shared", "dist", "index.js"))) {
      throw new Error("deployed bundle is missing @opc/shared/dist");
    }
    return { dir, bundle, entry, electronBinary: electronBinary || "(none — plain node fallback)" };
  });

  projectRoot = mkdtempSync(path.join(tmpdir(), "opc-electron-smoke-proj-"));

  // ---- boot #1 ----
  step("boot#1", () => {
    serverProc = bootServer(stageDir.bundle, projectRoot);
    return { pid: serverProc.pid, runtime: bootRuntime };
  });

  report.health1 = await step("health#1", () => waitForHealth());

  const companyId = await stepAsync("create-company", async () => {
    const created = await request("POST", "/api/companies", {
      body: { name: "Electron Smoke Co", description: "electron-smoke automated round-trip" },
    });
    if (created.status !== 200 || !created.json?.id) {
      throw new Error(`create company failed: HTTP ${created.status} ${created.body.slice(0, 160)}`);
    }
    const list = await request("GET", "/api/companies");
    if (list.status !== 200 || !Array.isArray(list.json) || !list.json.some((c) => c?.id === created.json.id)) {
      throw new Error(`created company ${created.json.id} not present in GET /api/companies (HTTP ${list.status})`);
    }
    return created.json.id;
  });

  // ---- optional real dispatch (opt-in only) ----
  let dispatchedRunId = null;
  if (DO_DISPATCH) {
    dispatchedRunId = await stepAsync("dispatch-task", async () => {
      // Guard: refuse if a run appears to already be in flight (best-effort — the
      // runs index is the only signal available over HTTP).
      const before = await request("GET", "/api/runs");
      const inFlight = Array.isArray(before.json) && before.json.some((r) => r?.status === "running");
      if (inFlight) throw new Error("a run is already in flight; refusing to dispatch a second (铁律 4)");
      const res = await request("POST", "/api/runs", {
        body: { goal: "Create a file named smoke.txt containing the single word OK." },
        timeout: 180000,
      });
      if (res.status !== 200 || !res.json?.runId) {
        throw new Error(`dispatch failed: HTTP ${res.status} ${res.body.slice(0, 200)}`);
      }
      return res.json.runId;
    });
  } else {
    report.steps.push({ name: "dispatch-task", ok: true, skipped: true, detail: "--dispatch not passed; no real task dispatched (default, avoids cost)" });
    report.knownTensions.push("Task dispatch skipped by default (--dispatch to opt into a real, possibly paid run).");
  }

  // ---- history + artifacts ----
  await stepAsync("history+artifacts", async () => {
    const runs = await request("GET", "/api/runs");
    if (runs.status !== 200 || !Array.isArray(runs.json)) throw new Error(`GET /api/runs failed: HTTP ${runs.status}`);
    if (runs.json.length === 0) {
      report.knownTensions.push("No historical runs on the fresh project root → artifact download not exercised (dispatch a run with --dispatch to cover it).");
      return { runs: 0, artifacts: "n/a (no runs on clean project)" };
    }
    const rid = dispatchedRunId && runs.json.some((r) => r?.id === dispatchedRunId) ? dispatchedRunId : runs.json[0].id;
    const task = await request("GET", `/api/runs/${encodeURIComponent(rid)}`);
    if (task.status !== 200 || !task.json) throw new Error(`GET run ${rid} failed: HTTP ${task.status}`);
    if (task.json.status !== "done") {
      throw new Error(`dispatched run ${rid} did not finish successfully: ${task.json.status ?? "unknown"}`);
    }

    const changes = await request("GET", `/api/runs/${encodeURIComponent(rid)}/changes`);
    if (changes.status !== 200 || !Array.isArray(changes.json?.changes)) {
      throw new Error(`GET changes for ${rid} failed: HTTP ${changes.status}`);
    }
    const smokeChange = changes.json.changes.find((change) =>
      String(change?.path ?? "").replaceAll("\\", "/") === "smoke.txt"
      && (change?.changeType === "create" || change?.changeType === "modify")
    );
    if (!smokeChange) throw new Error(`run ${rid} did not commit the required smoke.txt file`);

    const arts = await request("GET", `/api/runs/${encodeURIComponent(rid)}/artifacts`);
    if (arts.status !== 200) throw new Error(`GET artifacts for ${rid} failed: HTTP ${arts.status}`);
    const list = Array.isArray(arts.json?.artifacts) ? arts.json.artifacts : [];
    const smokeArtifact = list.find((artifact) =>
      artifact?.id === "file:smoke.txt"
      || artifact?.name === "smoke.txt"
      || artifact?.fileChanges?.some((change) => String(change?.path ?? "").replaceAll("\\", "/") === "smoke.txt")
    );
    if (!smokeArtifact?.id) throw new Error(`run ${rid} has no downloadable smoke.txt artifact`);

    const dl = await request("GET", `/api/runs/${encodeURIComponent(rid)}/artifacts/download?artifactId=${encodeURIComponent(smokeArtifact.id)}`);
    if (dl.status !== 200) throw new Error(`smoke.txt download failed: HTTP ${dl.status}`);
    if (dl.body.trim() !== "OK") throw new Error(`smoke.txt content mismatch: ${JSON.stringify(dl.body.slice(0, 80))}`);

    const evidence = await request("GET", `/api/runs/${encodeURIComponent(rid)}/evidence?verify=1`);
    if (evidence.status !== 200 || evidence.json?.ok !== true) {
      throw new Error(`evidence verification failed for ${rid}: HTTP ${evidence.status} ${evidence.body.slice(0, 200)}`);
    }

    return {
      runs: runs.json.length,
      runId: rid,
      status: task.json.status,
      deliveryAcceptance: task.json.deliveryAcceptance?.status ?? null,
      changes: changes.json.changes.length,
      artifacts: list.length,
      download: { artifactId: smokeArtifact.id, bytes: dl.body.length, content: dl.body.trim() },
      evidence: { ok: true, checked: evidence.json.checked ?? null, mismatches: evidence.json.mismatches ?? [] },
    };
  });

  // ---- kill tree + assert release ----
  step("kill#1", () => killTree(serverProc.pid));
  serverProc = null;
  await step("port-released#1", () => assertPortReleased());

  // ---- restart (proves clean restart + boot#1 fully released; same project root
  //      so any dispatched run persists and remains queryable) ----
  step("boot#2-restart", () => {
    serverProc = bootServer(stageDir.bundle, projectRoot);
    return { pid: serverProc.pid };
  });
  report.health2 = await step("health#2", () => waitForHealth());

  await stepAsync("history-after-restart", async () => {
    const runs = await request("GET", "/api/runs");
    if (runs.status !== 200 || !Array.isArray(runs.json)) throw new Error(`GET /api/runs after restart failed: HTTP ${runs.status}`);
    if (dispatchedRunId && !runs.json.some((r) => r?.id === dispatchedRunId)) {
      throw new Error(`dispatched run ${dispatchedRunId} did not survive restart`);
    }
    return { runsAfterRestart: runs.json.length };
  });

  step("kill#2", () => killTree(serverProc.pid));
  serverProc = null;
  await step("port-released#2", () => assertPortReleased());

  step("cleanup", () => {
    if (stageDir?.dir) rmSync(stageDir.dir, { recursive: true, force: true });
    if (projectRoot) rmSync(projectRoot, { recursive: true, force: true });
  });

  report.knownTensions.push("GUI round-trip (real Electron BrowserWindow + renderer clicks) and the NSIS installer are not driven here — Windows-only live matrix. This covers the server half of the packaged ELECTRON_RUN_AS_NODE contract end to end.");
  report.ok = true;
}

main()
  .then(() => {
    report.finishedAt = new Date().toISOString();
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    report.finishedAt = new Date().toISOString();
    report.fatal = String(err && err.message || err);
    if (serverProc) killTree(serverProc.pid);
    if (projectRoot) {
      try {
        const failureDir = path.join(repoRoot, "evidence", "release-matrix", "electron-smoke-failures", new Date().toISOString().replace(/[:.]/g, "-"));
        mkdirSync(failureDir, { recursive: true });
        const runEvidence = path.join(projectRoot, ".opc", "runs");
        if (existsSync(runEvidence)) cpSync(runEvidence, path.join(failureDir, "runs"), { recursive: true });
        report.failureEvidenceDir = failureDir;
        writeFileSync(path.join(failureDir, "report.json"), JSON.stringify(report, null, 2));
      } catch (evidenceError) {
        report.failureEvidenceError = String(evidenceError?.message || evidenceError);
      }
    }
    if (stageDir?.dir) { try { rmSync(stageDir.dir, { recursive: true, force: true }); } catch {} }
    if (projectRoot) { try { rmSync(projectRoot, { recursive: true, force: true }); } catch {} }
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  });
