import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import { frameworkSpec, register } from "./frameworkRoutes.js";
import { saveAccounts } from "../storage/providerStore.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(framework: "gemini-cli" | "kimi-cli" | "grok-build") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-framework-route-"));
  roots.push(root);
  const configDir = path.join(root, ".opc", "cli-accounts", framework);
  fs.mkdirSync(configDir, { recursive: true });
  saveAccounts(root, [{
    id: `${framework}#test`,
    providerId: framework,
    label: framework,
    apiKey: "",
    enabled: true,
    maxConcurrent: 1,
    frameworks: [framework],
    configDir,
  } as any]);

  const app = express();
  app.use(express.json());
  register(app, root);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { configDir, base: `http://127.0.0.1:${address.port}` };
}

describe("native subscription framework login specifications", () => {
  it("uses the documented login commands and isolated account environment variables", () => {
    expect(frameworkSpec("gemini-cli")).toMatchObject({ command: "gemini", args: [], envVar: "GEMINI_CLI_HOME" });
    expect(frameworkSpec("kimi-cli")).toMatchObject({ command: "kimi", args: ["login"], envVar: "KIMI_CODE_HOME" });
    expect(frameworkSpec("grok-build")).toMatchObject({ command: "grok", args: ["login"], envVar: "GROK_HOME" });
  });

  it("Gemini logout deletes only the fixed OAuth credential file", async () => {
    const { base, configDir } = await harness("gemini-cli");
    const geminiDir = path.join(configDir, ".gemini");
    fs.mkdirSync(geminiDir, { recursive: true });
    const credential = path.join(geminiDir, "oauth_creds.json");
    const settings = path.join(geminiDir, "settings.json");
    fs.writeFileSync(credential, "secret");
    fs.writeFileSync(settings, "{}");

    const response = await fetch(`${base}/api/frameworks/gemini-cli/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configDir }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ loggedOut: true, dir: configDir });
    expect(fs.existsSync(credential)).toBe(false);
    expect(fs.existsSync(settings)).toBe(true);
  });

  it.each(["kimi-cli", "grok-build"] as const)("%s logout is unsupported instead of deleting an uncertain config tree", async (framework) => {
    const { base, configDir } = await harness(framework);
    const sentinel = path.join(configDir, "config.toml");
    fs.writeFileSync(sentinel, "keep");

    const response = await fetch(`${base}/api/frameworks/${framework}/logout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ configDir }),
    });
    expect(response.status).toBe(501);
    expect(await response.json()).toMatchObject({ loggedOut: false, unsupported: true });
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });
});