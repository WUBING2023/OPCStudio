import { describe, expect, it } from "vitest";
import { createMcpJsonRpcHandler } from "./server.js";
import { MCP_TOOL_DEFINITIONS } from "./tools.js";

describe("OPC stdio MCP JSON-RPC", () => {
  const runtime = {
    callTool: async (name: string) => ({ called: name }),
  };
  const handle = createMcpJsonRpcHandler(runtime);

  it("negotiates the current protocol and declares tools", async () => {
    const response = await handle({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    });
    expect(response).toMatchObject({
      jsonrpc: "2.0", id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "opc-studio", version: "0.1.0" },
      },
    });
  });

  it("lists tools and returns structured plus text content", async () => {
    const listed = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listedTools = (listed as any).result.tools;
    expect(listedTools).toHaveLength(MCP_TOOL_DEFINITIONS.length);
    expect(listedTools.map((tool: { name: string }) => tool.name)).toEqual(
      MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
    const called = await handle({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "get_run_status", arguments: { runId: "run-12345678" } },
    });
    expect(called).toMatchObject({
      jsonrpc: "2.0", id: 3,
      result: {
        structuredContent: { called: "get_run_status" },
        content: [{ type: "text" }],
      },
    });
  });

  it("does not respond to initialized notifications", async () => {
    await expect(handle({ jsonrpc: "2.0", method: "notifications/initialized" })).resolves.toBeNull();
  });
});
