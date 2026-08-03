import type { McpServerConfig } from "@opc/shared";
import * as fs from "node:fs";
import * as path from "node:path";
import { listMcpServers, saveMcpServers } from "../storage/mcpStore.js";

// 默认 MCP 服务器：随产品自带、所有 agent 可用、用户可删可加。全部**免费、无需 API key**。
// 各项标注真实上游来源；缺 npx/uvx 运行时 mcpToolBridge 会优雅降级(该项工具不加载,不影响其它)。
function defaults(): McpServerConfig[] {
  const now = "2026-06-21T00:00:00Z";
  const mk = (o: Partial<McpServerConfig> & { id: string; name: string; description: string; command: string; args: string[] }): McpServerConfig => ({
    transport: "stdio", env: {}, enabled: true, assignedAgents: [], createdAt: now, ...o,
  });
  return [
    mk({ id: "filesystem-mcp", name: "Filesystem", description: "受限目录内的文件读写（来源: @modelcontextprotocol/server-filesystem, MIT）",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }),
    mk({ id: "memory-mcp", name: "Memory", description: "知识图谱式长期记忆（来源: @modelcontextprotocol/server-memory, MIT）",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] }),
    mk({ id: "sequential-thinking-mcp", name: "Sequential Thinking", description: "结构化分步推理工具（来源: @modelcontextprotocol/server-sequential-thinking, MIT）",
      command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] }),
    mk({ id: "fetch-mcp", name: "Fetch", description: "抓取网页并转 Markdown 喂给模型（来源: mcp-server-fetch, MIT；需 uvx/Python）",
      command: "uvx", args: ["mcp-server-fetch"] }),
    mk({ id: "ddg-search-mcp", name: "DuckDuckGo 搜索", description: "免费网页搜索，无需 API key（来源: nickclyde/duckduckgo-mcp-server, MIT；需 uvx/Python）",
      command: "uvx", args: ["duckduckgo-mcp-server"] }),
    mk({ id: "git-mcp", name: "Git", description: "本地 Git 仓库读取/提交/历史（来源: mcp-server-git, MIT；需 uvx/Python）",
      command: "uvx", args: ["mcp-server-git", "--repository", "."] }),
  ];
}

// 首次启动 seed：用 marker 文件保证只 seed 一次；之后**尊重用户的删改,不复活**。
export function seedDefaultMcpServers(projectRoot: string): number {
  const marker = path.join(projectRoot, ".opc", ".mcp-seeded");
  if (fs.existsSync(marker)) return 0;            // 已 seed 过 → 永不复活用户删掉的默认项
  try { fs.mkdirSync(path.dirname(marker), { recursive: true }); } catch { /* ignore */ }
  let added = 0;
  if (listMcpServers(projectRoot).length === 0) { // 不覆盖用户已有配置
    const def = defaults();
    saveMcpServers(projectRoot, def);
    added = def.length;
    console.log(`[mcpSeed] seeded ${added} default MCP servers (free, deletable)`);
  }
  try { fs.writeFileSync(marker, new Date().toISOString()); } catch { /* ignore */ }
  return added;
}
