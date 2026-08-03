import * as fs from "node:fs";
import * as path from "node:path";

const source = path.resolve("apps/cli/dist");
const bundleRoot = path.resolve(process.env.OPC_SERVER_BUNDLE_DIR || "electron-app/server-bundle");
const destination = path.join(bundleRoot, "cli-dist");

if (!fs.existsSync(path.join(source, "worker.js"))) {
  throw new Error("compiled CLI worker is missing; run @opc/cli build first");
}
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(source, destination, { recursive: true });
