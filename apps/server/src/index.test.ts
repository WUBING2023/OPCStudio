import { describe, expect, it, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "node:http";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveCliProjectRoot } from "./index.js";
import { register as registerConfigRoutes } from "./routes/configRoutes.js";

function makeWorkspace(): { root: string; serverDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-root-"));
  const serverDir = path.join(root, "apps", "server");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "opc-studio" }), "utf-8");
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n", "utf-8");
  fs.writeFileSync(path.join(serverDir, "package.json"), JSON.stringify({ name: "@opc/server" }), "utf-8");
  return { root, serverDir };
}

describe("resolveCliProjectRoot", () => {
  it("uses explicit OPC_PROJECT_ROOT when provided", () => {
    const { root, serverDir } = makeWorkspace();
    const explicit = path.join(root, "custom-root");

    expect(resolveCliProjectRoot(serverDir, explicit)).toBe(path.resolve(explicit));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("auto-resolves apps/server cwd back to the workspace root", () => {
    const { root, serverDir } = makeWorkspace();

    expect(resolveCliProjectRoot(serverDir, undefined)).toBe(path.resolve(root));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps unrelated package dirs unchanged so validation can reject them", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-standalone-"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@opc/server" }), "utf-8");

    expect(resolveCliProjectRoot(root, undefined)).toBe(path.resolve(root));

    fs.rmSync(root, { recursive: true, force: true });
  });
});

// index.ts 的 app.use(express.json()) 显式 limit("20mb")——回归默认 100kb 限制会让正常大小的
// 配置/记忆类请求体(如带较长历史的 patch)被 body-parser 在到达路由前就 413 拒绝。
describe("express.json() body size limit(index.ts 生产接线)", () => {
  let root: string;
  let server: Server;

  afterEach(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
  });

  async function startWithLimit(limit: string | undefined): Promise<string> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-json-limit-"));
    const app = express();
    app.use(limit ? express.json({ limit }) : express.json());
    registerConfigRoutes(app, root);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  it("与 index.ts 一致的 limit(\"20mb\")下，> 100KB 的请求体能正常过 route(不被 413 拦在 body-parser)", async () => {
    const baseUrl = await startWithLimit("20mb");
    const padding = "x".repeat(150_000); // > 100KB(默认 express.json 上限),< 20MB
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKeys: { padding } }),
    });
    expect(res.status).not.toBe(413);
    expect(res.status).toBe(200);
  });

  it("对照:不设 limit(退回默认 100kb)时，同样的 > 100KB 请求体会被 413 拒绝——证明这个 limit 配置确实是必需的", async () => {
    const baseUrl = await startWithLimit(undefined);
    const padding = "x".repeat(150_000);
    const res = await fetch(`${baseUrl}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKeys: { padding } }),
    });
    expect(res.status).toBe(413);
  });
});
