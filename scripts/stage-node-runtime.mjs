import * as fs from "node:fs";
import * as path from "node:path";

const bundleRoot = path.resolve(process.env.OPC_SERVER_BUNDLE_DIR || "electron-app/server-bundle");
const runtimeDir = path.join(bundleRoot, "node-runtime");
const executableName = process.platform === "win32" ? "node.exe" : "node";
const destination = path.join(runtimeDir, executableName);

function findNpmRoot() {
  const candidates = [
    process.env.npm_execpath ? path.resolve(path.dirname(process.env.npm_execpath), "..") : "",
    path.join(path.dirname(process.execPath), "node_modules", "npm"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(path.join(candidate, "bin", "npm-cli.js")));
}

if (!fs.existsSync(process.execPath)) {
  throw new Error(`build Node runtime is missing: ${process.execPath}`);
}

fs.rmSync(runtimeDir, { recursive: true, force: true });
fs.mkdirSync(runtimeDir, { recursive: true });
fs.copyFileSync(process.execPath, destination);
if (process.platform !== "win32") fs.chmodSync(destination, 0o755);

const npmRoot = findNpmRoot();
if (!npmRoot) throw new Error("npm runtime is missing; packaged CLI installation would not work");
fs.cpSync(npmRoot, path.join(runtimeDir, "npm"), { recursive: true });

fs.writeFileSync(
  path.join(runtimeDir, "NOTICE.txt"),
  [
    `Bundled Node.js runtime: ${process.version}`,
    "Node.js is distributed under the MIT license and includes third-party software.",
    "Source and license information: https://github.com/nodejs/node",
    "",
  ].join("\n"),
  "utf8",
);
