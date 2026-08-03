#!/usr/bin/env node
import { OpcClient, resolveClientConnection } from "../headless/client.js";
import { createFileAuditWriter } from "./audit.js";
import { startStdioMcpServer } from "./server.js";
import { createMcpToolRuntime, type OpcMcpGateway } from "./tools.js";

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

async function main(): Promise<void> {
  const connection = resolveClientConnection();
  const url = new URL(connection.baseUrl);
  if (!isLoopback(url) && url.protocol !== "https:") {
    throw new Error("Remote OPC MCP connections require HTTPS");
  }

  const client = new OpcClient({
    baseUrl: connection.baseUrl,
    sessionToken: connection.sessionToken,
  });
  const gateway: OpcMcpGateway = {
    get: (apiPath) => client.get(apiPath),
    post: (apiPath, body, idempotencyKey) => client.post(apiPath, body, idempotencyKey),
  };
  const runtime = createMcpToolRuntime({
    gateway,
    authenticated: Boolean(connection.sessionToken),
    audit: createFileAuditWriter(),
  });
  await startStdioMcpServer(runtime);
}

main().catch((error) => {
  process.stderr.write("OPC MCP startup failed: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
});
