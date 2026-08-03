import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const distRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "apps", "cli", "dist");

function rewriteDirectory(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      rewriteDirectory(absolute);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const before = fs.readFileSync(absolute, "utf8");
    const relativeFile = path.relative(distRoot, absolute);
    const directoryDepth = path.dirname(relativeFile)
      .split(path.sep)
      .filter((segment) => segment && segment !== ".").length;
    const serverDistPrefix = "../".repeat(directoryDepth + 1) + "dist/";
    const after = before.replaceAll("@opc/server/src/", serverDistPrefix);
    if (after !== before) fs.writeFileSync(absolute, after, "utf8");
  }
}

if (!fs.existsSync(distRoot)) {
  throw new Error(`CLI runtime output is missing: ${distRoot}`);
}
rewriteDirectory(distRoot);
