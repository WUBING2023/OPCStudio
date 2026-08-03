import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

export interface StandaloneMcpSmokeResult {
  initialize: boolean;
  toolsList: boolean;
  toolCount: number;
}

export async function smokeStandaloneMcp(cliRoot: string): Promise<StandaloneMcpSmokeResult> {
  const sourceDist = path.join(cliRoot, "dist");
  if (!fs.existsSync(path.join(sourceDist, "mcp", "index.js"))) throw new Error("Build the CLI before running the MCP release smoke");
  const temporaryRoot = fs.mkdtempSync(path.join(cliRoot, ".opc-mcp-smoke-"));
  const releaseRoot = path.join(temporaryRoot, "release");
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    fs.cpSync(sourceDist, releaseRoot, { recursive: true });
    fs.writeFileSync(path.join(releaseRoot, "package.json"), '{"type":"module"}\n', "utf8");
    const launched = spawn(process.execPath, [path.join(releaseRoot, "mcp", "index.js")], {
      cwd: releaseRoot,
      env: { ...process.env, OPC_SERVER_URL: "http://127.0.0.1:9" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    child = launched;
    const responses = new Map<number, Record<string, unknown>>();
    let stderr = "";
    launched.stderr.setEncoding("utf8");
    launched.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const lines = readline.createInterface({ input: launched.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as Record<string, unknown>;
        if (typeof response.id === "number") responses.set(response.id, response);
      } catch { /* missing responses are reported below */ }
    });
    launched.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "opc-release-smoke", version: "1" } } })}\n`);
    launched.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
    launched.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline && (!responses.has(1) || !responses.has(2))) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    launched.stdin.end();
    const initialize = responses.get(1);
    const toolsList = responses.get(2);
    if (!initialize || !toolsList) throw new Error(`Standalone MCP handshake failed${stderr ? `: ${stderr.trim()}` : ""}`);
    const toolsResult = toolsList.result as { tools?: unknown[] } | undefined;
    return {
      initialize: Boolean(initialize.result),
      toolsList: Array.isArray(toolsResult?.tools),
      toolCount: Array.isArray(toolsResult?.tools) ? toolsResult.tools.length : 0,
    };
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit").catch(() => undefined);
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    fs.rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  smokeStandaloneMcp(cliRoot).then(
    (result) => process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`),
    (error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      process.exitCode = 1;
    },
  );
}
