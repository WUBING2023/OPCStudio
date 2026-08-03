import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { approveMcpServer, mcpApprovalDescriptor, validMcpApproval } from "./mcpApproval.js";

describe("MCP approval binding", () => {
  let root: string;
  const server = {
    id: "mcp-1", name: "local", description: "", transport: "stdio" as const,
    command: "node", args: ["server.js"], env: { TOKEN: "secret" }, enabled: true,
    assignedAgents: [], createdAt: "2026-08-02T00:00:00.000Z",
  };

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-mcp-approval-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("binds command, args, env value hashes, workspace, and expiry without persisting secrets", () => {
    const descriptor = mcpApprovalDescriptor(root, server);
    expect(descriptor.envNames).toEqual(["TOKEN"]);
    expect(JSON.stringify(descriptor)).not.toContain("secret");
    approveMcpServer(root, server, 1000, 1000);
    expect(validMcpApproval(root, server, 1500)).not.toBeNull();
    expect(validMcpApproval(root, server, 2000)).toBeNull();
  });

  it("invalidates approval after args or env values change", () => {
    approveMcpServer(root, server);
    expect(validMcpApproval(root, { ...server, args: ["changed.js"] })).toBeNull();
    expect(validMcpApproval(root, { ...server, env: { TOKEN: "changed" } })).toBeNull();
  });
});
