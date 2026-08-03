import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { register } from "./mcpRoutes.js";
import { maskApiKey } from "./providerRoutes.js";

// MUP B7 · MCP env 泄漏面:API 响应侧掩码 + 掩码往返不回写。存储(mcp_servers.json)始终保留真值,
// 运行时消费(mcpGovernance/引擎 spawn)不经 API,不受影响。

const REAL_TOKEN = "ghp_realtoken1234567890";

function mcpFile(root: string) {
  return path.join(root, ".opc", "mcp_servers.json");
}

function readStored(root: string): any[] {
  return JSON.parse(fs.readFileSync(mcpFile(root), "utf-8"));
}

async function startTestServer(root: string): Promise<{ server: Server; baseUrl: string }> {
  const app = express();
  app.use(express.json());
  register(app, root);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

describe("mcpRoutes — env 值掩码与往返", () => {
  let root: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-routes-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    ({ server, baseUrl } = await startTestServer(root));
  });

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  async function createServerConfig(): Promise<any> {
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "测试MCP", description: "", transport: "stdio", command: "echo", args: [],
        env: { GH_TOKEN: REAL_TOKEN }, enabled: true, assignedAgents: [],
      }),
    });
    expect(res.status).toBe(201);
    return res.json();
  }

  it("POST 回显 env 已掩码,盘上存的是真值", async () => {
    const created = await createServerConfig();
    expect(created.env.GH_TOKEN).toBe(maskApiKey(REAL_TOKEN));
    expect(created.env.GH_TOKEN).not.toContain("realtoken");
    expect(readStored(root)[0].env.GH_TOKEN).toBe(REAL_TOKEN);
  });

  it("GET /api/mcp 与 GET /api/mcp/:id 都不回传 env 明文", async () => {
    const created = await createServerConfig();
    const list = await (await fetch(`${baseUrl}/api/mcp`)).json();
    expect(list[0].env.GH_TOKEN).toBe(maskApiKey(REAL_TOKEN));
    const one = await (await fetch(`${baseUrl}/api/mcp/${created.id}`)).json();
    expect(one.env.GH_TOKEN).toBe(maskApiKey(REAL_TOKEN));
    expect(JSON.stringify([list, one])).not.toContain(REAL_TOKEN);
  });

  it("PATCH 掩码往返不回写:回显的掩码串不覆盖真值;新明文值正常更新", async () => {
    const created = await createServerConfig();
    // 前端表单原样送回 GET 回显的掩码串(用户没碰 env)→ 盘上仍是真值
    let res = await fetch(`${baseUrl}/api/mcp/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "改个名", env: { GH_TOKEN: maskApiKey(REAL_TOKEN) } }),
    });
    expect(res.status).toBe(200);
    expect(readStored(root)[0].env.GH_TOKEN).toBe(REAL_TOKEN);
    expect(readStored(root)[0].name).toBe("改个名");
    // 用户真的换了 token → 新明文值落盘,响应仍掩码
    res = await fetch(`${baseUrl}/api/mcp/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { GH_TOKEN: "ghp_newtoken0987654321" } }),
    });
    const body = await res.json();
    expect(readStored(root)[0].env.GH_TOKEN).toBe("ghp_newtoken0987654321");
    expect(body.env.GH_TOKEN).toBe(maskApiKey("ghp_newtoken0987654321"));
  });

  it("无 env 的 server 响应零改动", async () => {
    const res = await fetch(`${baseUrl}/api/mcp`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "无env", description: "", transport: "http", url: "https://mcp.example.com/sse",
        enabled: true, assignedAgents: [],
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json();
    expect(created.env).toBeUndefined();
  });

  it("MCP approval is one-time, config-bound, and never exposes env secrets", async () => {
    const created = await createServerConfig();
    let res = await fetch(`${baseUrl}/api/mcp/${created.id}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    expect(res.status).toBe(428);
    const first = await res.json() as any;
    expect(first.requiresConfirmation).toBe(true);
    expect(first.approval.command).toBe("echo");
    expect(first.approval.envNames).toEqual(["GH_TOKEN"]);
    expect(JSON.stringify(first)).not.toContain(REAL_TOKEN);

    res = await fetch(`${baseUrl}/api/mcp/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: ["changed"] }),
    });
    expect(res.status).toBe(200);
    res = await fetch(`${baseUrl}/api/mcp/${created.id}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationToken: first.confirmationToken }),
    });
    expect(res.status).toBe(428);
    const rebound = await res.json() as any;
    expect(rebound.confirmationStatus).toBe("mismatch");

    res = await fetch(`${baseUrl}/api/mcp/${created.id}/confirm`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmationToken: rebound.confirmationToken }),
    });
    expect(res.status).toBe(200);
    const persistedApproval = fs.readFileSync(path.join(root, ".opc", "mcp_approvals.json"), "utf8");
    expect(persistedApproval).not.toContain(REAL_TOKEN);

    res = await fetch(`${baseUrl}/api/mcp/${created.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ env: { GH_TOKEN: "ghp_rotated1234567890" } }),
    });
    expect(res.status).toBe(200);
    res = await fetch(`${baseUrl}/api/mcp/${created.id}/test`, { method: "POST" });
    expect(res.status).toBe(428);
    expect(JSON.stringify(await res.json())).not.toContain("ghp_rotated1234567890");
  });
});
