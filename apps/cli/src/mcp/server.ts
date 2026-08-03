import * as readline from "node:readline";
import { MCP_TOOL_DEFINITIONS, McpToolError, type McpToolRuntime } from "./tools.js";

type JsonRpcId = string | number | null;
type JsonRecord = Record<string, unknown>;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const MCP_PROTOCOL_VERSION = "2025-11-25";
export const MCP_SERVER_INFO = { name: "opc-studio", version: "0.1.0" };
const MAX_REQUEST_BYTES = 1024 * 1024;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function success(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

export function createMcpJsonRpcHandler(runtime: McpToolRuntime) {
  return async (request: JsonRpcRequest): Promise<JsonRpcResponse | null> => {
    const id = request.id ?? null;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
      return failure(id, -32600, "Invalid Request");
    }

    if (request.method.startsWith("notifications/") || request.id === undefined) return null;

    switch (request.method) {
      case "initialize":
        return success(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: "Use OPC high-level tools only. Write tools require explicit confirmation, an authenticated session, and an idempotency key.",
        });
      case "ping":
        return success(id, {});
      case "tools/list":
        return success(id, { tools: MCP_TOOL_DEFINITIONS });
      case "tools/call": {
        const params = asRecord(request.params);
        if (typeof params.name !== "string") return failure(id, -32602, "tools/call requires a tool name");
        try {
          const data = await runtime.callTool(params.name, params.arguments ?? {});
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(data) }],
            structuredContent: data,
            isError: false,
          });
        } catch (error) {
          const normalized = error instanceof McpToolError
            ? error
            : new McpToolError("internal_error", error instanceof Error ? error.message : "Tool failed");
          const body = {
            ok: false,
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details,
              retryable: normalized.retryable,
            },
          };
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(body) }],
            structuredContent: body,
            isError: true,
          });
        }
      }
      default:
        return failure(id, -32601, "Method not found");
    }
  };
}

export async function startStdioMcpServer(
  runtime: McpToolRuntime,
  io: {
    stdin?: NodeJS.ReadableStream;
    stdout?: NodeJS.WritableStream;
    stderr?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const input = io.stdin ?? process.stdin;
  const output = io.stdout ?? process.stdout;
  const errors = io.stderr ?? process.stderr;
  const handle = createMcpJsonRpcHandler(runtime);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line, "utf-8") > MAX_REQUEST_BYTES) {
      output.write(JSON.stringify(failure(null, -32600, "Request exceeds 1 MiB")) + "\n");
      continue;
    }
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      output.write(JSON.stringify(failure(null, -32700, "Parse error")) + "\n");
      continue;
    }
    try {
      const response = await handle(request);
      if (response) output.write(JSON.stringify(response) + "\n");
    } catch (error) {
      errors.write("OPC MCP internal error: " + (error instanceof Error ? error.message : String(error)) + "\n");
      if (request.id !== undefined) {
        output.write(JSON.stringify(failure(request.id, -32603, "Internal error")) + "\n");
      }
    }
  }
}
