import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";

type JsonRecord = Record<string, unknown>;

class RpcSession {
  private readonly responses = new Map<number, JsonRecord>();
  private nextId = 1;
  private stderr = "";

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { this.stderr += chunk; });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      try {
        const response = JSON.parse(line) as JsonRecord;
        if (typeof response.id === "number") this.responses.set(response.id, response);
      } catch { /* timeout reports malformed output */ }
    });
  }

  async request(method: string, params: unknown): Promise<JsonRecord> {
    const id = this.nextId++;
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const response = this.responses.get(id);
      if (response) return response;
      if (this.child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("MCP request timed out: " + method + (this.stderr.trim() ? " (" + this.stderr.trim() + ")" : ""));
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, "exit").catch(() => undefined);
    this.child.stdin.end();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    if (this.child.exitCode === null) this.child.kill();
  }
}

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function toolResult(response: JsonRecord): unknown {
  if (response.error) throw new Error("MCP JSON-RPC error");
  return record(response.result).structuredContent;
}

function spawnMcp(entry: string, env: NodeJS.ProcessEnv): RpcSession {
  return new RpcSession(spawn(process.execPath, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  }));
}

async function initialize(session: RpcSession): Promise<void> {
  const response = await session.request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "opc-live-acceptance", version: "1" },
  });
  if (!response.result) throw new Error("MCP initialize failed");
}

async function main(): Promise<void> {
  const runId = process.argv[2];
  const companyId = process.argv[3];
  const serverUrl = process.argv[4] ?? "http://127.0.0.1:3100";
  if (!runId || !companyId) throw new Error("Usage: liveMcpSmoke <runId> <companyId> [serverUrl]");
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const entry = path.join(cliRoot, "dist", "mcp", "index.js");
  if (!fs.existsSync(entry)) throw new Error("Build @opc/cli before running the live MCP smoke");

  const authenticated = spawnMcp(entry, { ...process.env, OPC_SERVER_URL: serverUrl });
  let companyCount = 0;
  let toolCount = 0;
  try {
    await initialize(authenticated);
    const listed = await authenticated.request("tools/list", {});
    const tools = record(listed.result).tools;
    toolCount = Array.isArray(tools) ? tools.length : 0;
    const companies = toolResult(await authenticated.request("tools/call", {
      name: "list_companies", arguments: {},
    }));
    const companiesRecord = record(companies);
    companyCount = Array.isArray(companies) ? companies.length : Array.isArray(companiesRecord.companies) ? companiesRecord.companies.length : 0;
    if (companyCount === 0) throw new Error("MCP list_companies returned no companies");
    const status = record(toolResult(await authenticated.request("tools/call", {
      name: "get_run_status", arguments: { runId },
    })));
    if (String(status.runId ?? status.id ?? "") !== runId) throw new Error("MCP run status identity mismatch");
    const evidence = record(toolResult(await authenticated.request("tools/call", {
      name: "get_evidence", arguments: { runId, verify: true },
    })));
    const verification = record(evidence.verification);
    if (evidence.ok !== true && verification.ok !== true) throw new Error("MCP evidence verification was not ok");
    const trace = record(toolResult(await authenticated.request("tools/call", {
      name: "get_run_trace", arguments: { runId },
    })));
    if (!Array.isArray(trace.events) || trace.events.length === 0) throw new Error("MCP run trace was empty");
  } finally {
    await authenticated.close();
  }

  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "opc-mcp-no-session-"));
  let unauthenticatedCode = "";
  const unauthenticated = spawnMcp(entry, {
    ...process.env,
    OPC_SERVER_URL: serverUrl,
    OPC_SESSION_TOKEN: "",
    USERPROFILE: emptyHome,
    HOME: emptyHome,
  });
  try {
    await initialize(unauthenticated);
    const denied = toolResult(await unauthenticated.request("tools/call", {
      name: "start_run",
      arguments: {
        companyId,
        task: "Authentication boundary acceptance request; this must not create a run.",
        runType: "quick",
        teamMode: "economy",
        confirm: true,
        idempotencyKey: "live-mcp-unauthenticated-denial",
      },
    }));
    const deniedRecord = record(denied);
    unauthenticatedCode = String(record(deniedRecord.error).code ?? "");
    if (deniedRecord.ok !== false || unauthenticatedCode !== "mcp_auth_required") {
      throw new Error("Unauthenticated MCP write was not rejected by the MCP boundary");
    }
  } finally {
    await unauthenticated.close();
    fs.rmSync(emptyHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    toolCount,
    companyCount,
    runStatusRead: true,
    traceRead: true,
    evidenceVerified: true,
    unauthenticatedWriteDenied: true,
    unauthenticatedCode,
  }) + "\n");
}

main().catch((error) => {
  process.stderr.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }) + "\n");
  process.exitCode = 1;
});
