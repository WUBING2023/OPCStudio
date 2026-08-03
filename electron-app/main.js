const { app, BrowserWindow, dialog, shell, Menu, nativeTheme } = require("electron");
const { spawn, spawnSync } = require("child_process");
const path = require("path");
const http = require("http");
const net = require("net");
const crypto = require("crypto");

let serverProcess = null;
let serverStartError = null;
let quitting = false;
let mainWindow = null;
const HOST = "127.0.0.1";

// All desktop windows share the same userData stores and embedded server. A
// second app instance would start another server and let two renderers mutate
// those stores concurrently, so keep one process and focus its existing window.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

// 令五.6:主进程生成本机 API session token,经 env 下发给 spawn 的 server 子进程(以及后续 worker),
// 并暴露给 preload(process.env,同一环境)。三方共用同一 token → 变更型请求可通过鉴权中间件。
const SESSION_TOKEN = (process.env.OPC_SESSION_TOKEN && process.env.OPC_SESSION_TOKEN.trim())
  || crypto.randomBytes(32).toString("hex");
process.env.OPC_SESSION_TOKEN = SESSION_TOKEN;

// Best-effort kill of the server process *tree*. The server spawns Worker
// children; a plain SIGTERM to the parent leaves those orphaned. On Windows a
// bare kill() also does not reach the tree, so use `taskkill /T /F`. POSIX gets
// SIGKILL to the process group (server is spawned detached below on POSIX).
function killServerTree() {
  const proc = serverProcess;
  serverProcess = null;
  if (!proc || proc.killed || proc.pid == null) return;
  try {
    if (process.platform === "win32") {
      // /T = tree, /F = force. Synchronous so it completes before app exit.
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      // Negative pid targets the whole group (server is spawned with detached:true).
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    }
  } catch {
    /* already gone — best effort */
  }
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: HOST, port: 0, exclusive: true }, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : null;
      if (!port) {
        probe.close();
        reject(new Error("Failed to allocate a local API port"));
        return;
      }
      probe.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

// Production = packaged app (app.isPackaged) runs the compiled server (dist/index.js)
// as a plain Node process via Electron-as-node. Dev = tsx over TS source from the repo.
function startServer(port) {
  serverStartError = null;
  if (app.isPackaged) {
    // Packaged layout (see electron-app/package.json extraResources):
    //   resources/server-bundle/  -> self-contained `pnpm deploy` output (dist + node_modules, incl. @opc/shared/dist)
    //   resources/web/            -> apps/web/dist
    const serverDir = path.join(process.resourcesPath, "server-bundle");
    const serverEntry = path.join(serverDir, "dist", "index.js");
    const webDist = path.join(process.resourcesPath, "web");
    // Per-user project root so a packaged install writes to userData, not Program Files.
    const projectRoot = app.getPath("userData");
    const nodeRuntimeDir = path.join(serverDir, "node-runtime");
    const managedCliPrefix = path.join(projectRoot, "cli");
    const managedCliBin = process.platform === "win32" ? managedCliPrefix : path.join(managedCliPrefix, "bin");
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1", // run process.execPath (Electron) as a bare Node runtime
      PORT: String(port),
      OPC_PROJECT_ROOT: projectRoot,
      OPC_WEB_DIST: webDist,
      OPC_CLI_WORKER_ENTRY: path.join(serverDir, "cli-dist", "worker.js"),
      OPC_NODE_EXECUTABLE: path.join(nodeRuntimeDir, process.platform === "win32" ? "node.exe" : "node"),
      OPC_NPM_CLI: path.join(nodeRuntimeDir, "npm", "bin", "npm-cli.js"),
      OPC_NPX_CLI: path.join(nodeRuntimeDir, "npm", "bin", "npx-cli.js"),
      OPC_MANAGED_CLI_PREFIX: managedCliPrefix,
      PATH: managedCliBin + path.delimiter + (process.env.PATH || process.env.Path || ""),
      OPC_SESSION_TOKEN: SESSION_TOKEN, // 令五.6:server 与 preload 共用同一 token
    };
    // --conditions=production selects @opc/shared's compiled ./dist/index.js export
    // (its default/dev condition points at TS source, which plain Node cannot load).
    const opts = { cwd: serverDir, env, stdio: "pipe", shell: false };
    // POSIX: detached so the server is its own process-group leader and
    // killServerTree() can signal the whole group (server + Worker children) via
    // process.kill(-pid). Without this the group-kill fails and the fallback only
    // reaches the server, orphaning workers. Windows uses taskkill /T instead.
    if (process.platform !== "win32") opts.detached = true;
    serverProcess = spawn(
      process.execPath,
      ["--conditions=production", serverEntry],
      opts
    );
  } else {
    // Dev: run TS source directly via tsx from the repo root.
    const repoRoot = path.join(__dirname, "..");
    const serverPackageDir = path.join(repoRoot, "apps", "server");
    const serverTs = path.join(repoRoot, "apps", "server", "src", "index.ts");
    const tsxCli = require.resolve("tsx/cli", { paths: [serverPackageDir] });
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PORT: String(port),
      OPC_PROJECT_ROOT: repoRoot,
      OPC_WEB_DIST: path.join(repoRoot, "apps", "web", "dist"),
      OPC_SESSION_TOKEN: SESSION_TOKEN, // 令五.6:server 与 preload 共用同一 token
    };
    const opts = { cwd: repoRoot, env, stdio: "pipe", shell: false };
    // POSIX: detached so we can signal the whole group on quit. Windows: taskkill /T
    // handles the tree, so keep it attached.
    if (process.platform !== "win32") opts.detached = true;
    serverProcess = spawn(process.execPath, [tsxCli, serverTs], opts);
  }
  serverProcess.stdout.on("data", (d) => process.stdout.write("[server] " + d));
  serverProcess.stderr.on("data", (d) => process.stderr.write("[server] " + d));
  serverProcess.on("error", (error) => {
    serverStartError = error;
    console.error("[server] spawn error", error);
  });
}

function requestHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: HOST, port, path: "/api/health", timeout: 2000 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) {
            req.destroy(new Error("Health response exceeded 64 KiB"));
          }
        });
        res.on("end", () => {
          let payload = null;
          try {
            payload = JSON.parse(body);
          } catch {
            // A response from another local process is not OPC readiness.
          }
          resolve({ statusCode: res.statusCode, payload });
        });
      }
    );
    req.once("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("Health request timed out")));
  });
}

async function waitForServer(port, retries = 40) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (serverStartError) throw serverStartError;
    if (!serverProcess || serverProcess.exitCode !== null) {
      throw new Error(`Server process exited before readiness (code ${serverProcess?.exitCode ?? "unknown"})`);
    }
    try {
      const result = await requestHealth(port);
      if (result.statusCode === 200 && result.payload?.status === "ok") return result;
      lastError = new Error(`Unexpected health response: HTTP ${result.statusCode ?? "unknown"}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Server did not become ready in time: ${lastError?.message ?? "unknown error"}`);
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  let port;
  try {
    port = await findAvailablePort();
    startServer(port);
    await waitForServer(port);
  } catch (e) {
    dialog.showErrorBox("OPC Studio", `后端启动失败：${e.message}\n\n请确认 server-bundle 已随发行包一起构建。`);
    killServerTree();
    app.quit();
    return;
  }

  // 用户反馈的两处观感问题:①顶部白色原生标题条(与暗色 UI 撕裂)——nativeTheme 钉 dark,
  // Windows 原生标题栏跟随变暗;②标题栏下的 File/Edit 默认菜单条(Electron 缺省菜单,与产品
  // 无关且不吃主题)——整支移除(快捷键损失面:刷新/DevTools,发行版本就不该暴露)。
  nativeTheme.themeSource = "dark";
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "OPC Studio",
    autoHideMenuBar: true,
    backgroundColor: "#0c0f14", // 首帧即暗色,不闪白
    icon: path.join(__dirname, "build", "icon.ico"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.loadURL(`http://${HOST}:${port}`);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  mainWindow.on("closed", () => { mainWindow = null; });
});

// Tear the server down on both paths: before-quit (covers app.quit / menu quit)
// and window-all-closed (covers closing the last window). Guarded so the tree is
// killed exactly once.
app.on("before-quit", () => {
  quitting = true;
  killServerTree();
});

app.on("window-all-closed", () => {
  killServerTree();
  if (!quitting) app.quit();
});
