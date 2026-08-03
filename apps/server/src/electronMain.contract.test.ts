import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = fs.readFileSync(path.join(HERE, "../../../electron-app/main.js"), "utf8");

describe("Electron desktop single-instance contract", () => {
  it("acquires the lock before starting the embedded server", () => {
    expect(MAIN).toContain("app.requestSingleInstanceLock()");
    expect(MAIN.indexOf("app.requestSingleInstanceLock()")).toBeLessThan(MAIN.indexOf("app.whenReady()"));
    expect(MAIN).toMatch(/if \(!hasSingleInstanceLock\)\s*\{\s*app\.quit\(\)/);
  });

  it("restores and focuses the existing BrowserWindow on a second launch", () => {
    expect(MAIN).toContain('app.on("second-instance"');
    expect(MAIN).toMatch(/mainWindow\.isMinimized\(\).*mainWindow\.restore\(\)/s);
    expect(MAIN).toContain("mainWindow.show()");
    expect(MAIN).toContain("mainWindow.focus()");
    expect(MAIN).toContain('mainWindow.on("closed", () => { mainWindow = null; })');
  });
});

describe("Electron packaged worker contract", () => {
  it("points the embedded server at the staged compiled CLI worker", () => {
    expect(MAIN).toContain("OPC_NODE_EXECUTABLE:");
    expect(MAIN).toContain('const nodeRuntimeDir = path.join(serverDir, "node-runtime")');
    expect(MAIN).toContain("OPC_NPM_CLI:");
    expect(MAIN).toContain("OPC_NPX_CLI:");
    expect(MAIN).toContain("OPC_MANAGED_CLI_PREFIX:");
    expect(MAIN).toContain('OPC_CLI_WORKER_ENTRY: path.join(serverDir, "cli-dist", "worker.js")');
  });
});
