import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Server } from "node:http";
import type { ProviderAccount } from "@opc/shared";
import { register } from "./accountRoutes.js";
import { loadAccounts, saveAccounts } from "../storage/providerStore.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function harness(accounts: ProviderAccount[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-account-route-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  fs.writeFileSync(path.join(root, ".opc", "config.json"), JSON.stringify({ version: "0.1.0", projectName: "test", apiKeys: {} }));
  saveAccounts(root, accounts);
  const app = express();
  app.use(express.json());
  register(app, root);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test address");
  return { root, base: `http://127.0.0.1:${address.port}/api` };
}

function account(id: string, patch: Partial<ProviderAccount> = {}): ProviderAccount {
  return { id, providerId: "deepseek", label: id, apiKey: "sk-test", enabled: true, maxConcurrent: 2, ...patch };
}

describe("account management routes", () => {
  it("sets one preferred account atomically inside the same pool", async () => {
    const { root, base } = await harness([
      account("deepseek#a", { preferred: true }),
      account("deepseek#b"),
      account("openai#codex", { providerId: "openai", apiKey: "", frameworks: ["codex"], preferred: true }),
    ]);
    const response = await fetch(`${base}/accounts/deepseek%23b/preferred`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    const publicAccount = await response.json() as Record<string, unknown>;
    expect(publicAccount.preferred).toBe(true);
    expect(publicAccount).not.toHaveProperty("apiKey");
    const stored = loadAccounts(root);
    expect(stored.find(item => item.id === "deepseek#a")?.preferred).toBe(false);
    expect(stored.find(item => item.id === "deepseek#b")?.preferred).toBe(true);
    expect(stored.find(item => item.id === "openai#codex")?.preferred).toBe(true);
  });

  it("renames a subscription account without exposing its credentials", async () => {
    const { root, base } = await harness([
      account("anthropic#claude-code", { providerId: "anthropic", apiKey: "", frameworks: ["claude-code"], label: "anthropic claude-code" }),
    ]);

    const response = await fetch(`${base}/accounts/anthropic%23claude-code`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "  我的 Claude 主账号  " }),
    });
    expect(response.status).toBe(200);
    const publicAccount = await response.json() as Record<string, unknown>;
    expect(publicAccount.label).toBe("我的 Claude 主账号");
    expect(publicAccount).not.toHaveProperty("apiKey");
    expect(loadAccounts(root)[0]?.label).toBe("我的 Claude 主账号");

    const invalid = await fetch(`${base}/accounts/anthropic%23claude-code`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "   " }),
    });
    expect(invalid.status).toBe(400);
    expect(loadAccounts(root)[0]?.label).toBe("我的 Claude 主账号");
  });
  it("deletes the account and its managed CLI directory, then returns 404 on a repeated delete", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-account-delete-seed-"));
    fs.rmSync(root, { recursive: true, force: true });
    const managedDir = path.join(root, ".opc", "cli-accounts", "openai#one");
    const setup = await harness([account("openai#one", { providerId: "openai", apiKey: "", frameworks: ["codex"], configDir: managedDir })]);
    const actualDir = path.join(setup.root, ".opc", "cli-accounts", "openai#one");
    const stored = loadAccounts(setup.root);
    stored[0].configDir = actualDir;
    saveAccounts(setup.root, stored);
    fs.mkdirSync(actualDir, { recursive: true });
    fs.writeFileSync(path.join(actualDir, "auth.json"), "test");

    const first = await fetch(`${setup.base}/accounts/openai%23one`, { method: "DELETE" });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ deleted: true });
    expect(loadAccounts(setup.root)).toHaveLength(0);
    expect(fs.existsSync(actualDir)).toBe(false);

    const second = await fetch(`${setup.base}/accounts/openai%23one`, { method: "DELETE" });
    expect(second.status).toBe(404);
  });
});
