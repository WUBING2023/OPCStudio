import * as path from "node:path";
import type { McpServerConfig } from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";

const OPC_DIR = ".opc";
const MCP_FILE = "mcp_servers.json";

function mcpPath(projectRoot: string) {
  return path.join(projectRoot, OPC_DIR, MCP_FILE);
}

export function listMcpServers(projectRoot: string): McpServerConfig[] {
  return readJSON<McpServerConfig[]>(mcpPath(projectRoot), []);
}

export function saveMcpServers(projectRoot: string, servers: McpServerConfig[]) {
  writeJSON(mcpPath(projectRoot), servers);
}

export function getMcpServer(projectRoot: string, id: string): McpServerConfig | undefined {
  return listMcpServers(projectRoot).find(s => s.id === id);
}

export function addMcpServer(projectRoot: string, server: McpServerConfig): McpServerConfig {
  const servers = listMcpServers(projectRoot);
  servers.push(server);
  saveMcpServers(projectRoot, servers);
  return server;
}

export function updateMcpServer(projectRoot: string, id: string, patch: Partial<McpServerConfig>): McpServerConfig | undefined {
  const servers = listMcpServers(projectRoot);
  const idx = servers.findIndex(s => s.id === id);
  if (idx === -1) return undefined;
  servers[idx] = { ...servers[idx], ...patch };
  saveMcpServers(projectRoot, servers);
  return servers[idx];
}

export function deleteMcpServer(projectRoot: string, id: string): boolean {
  const servers = listMcpServers(projectRoot);
  const idx = servers.findIndex(s => s.id === id);
  if (idx === -1) return false;
  servers.splice(idx, 1);
  saveMcpServers(projectRoot, servers);
  return true;
}
