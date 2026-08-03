import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const bundle = path.resolve(process.env.OPC_SERVER_BUNDLE_DIR || "electron-app/server-bundle");
const worker = path.join(bundle, "cli-dist", "worker.js");
const nodeRuntime = path.join(bundle, "node-runtime", process.platform === "win32" ? "node.exe" : "node");
const errors = [];

if (!fs.existsSync(worker)) errors.push("cli-dist/worker.js is missing");
if (!fs.existsSync(nodeRuntime)) errors.push("node-runtime executable is missing");
if (!fs.existsSync(path.join(bundle, "dist", "runtime", "workerRuntime.js"))) {
  errors.push("compiled server runtime is missing");
}
if (fs.existsSync(worker)) {
  const source = fs.readFileSync(worker, "utf8");
  if (source.includes("@opc/server/src/")) errors.push("worker still references TypeScript server sources");
  if (!source.includes("../dist/")) errors.push("worker does not reference the staged compiled server runtime");
}
if (errors.length === 0) {
  const smoke = spawnSync(nodeRuntime, ["--conditions=production", worker, "--help"], {
    cwd: bundle, encoding: "utf8", shell: false,
  });
  if (smoke.status !== 0 || !smoke.stdout.includes("opc-worker")) {
    errors.push(`compiled worker smoke failed: ${smoke.stderr || smoke.stdout || `exit ${smoke.status}`}`);
  }
}

if (errors.length) {
  console.error(`CLI runtime bundle verification failed (${errors.length}):`);
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log("CLI runtime bundle verification passed");
