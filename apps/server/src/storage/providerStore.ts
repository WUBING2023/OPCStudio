import * as path from "node:path";
import type { AgentFramework, ProviderConfig, ProviderAccount } from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";

const OPC_DIR = ".opc";

export function loadProviders(projectRoot: string): ProviderConfig[] {
  return readJSON<ProviderConfig[]>(path.join(projectRoot, OPC_DIR, "providers.json"), []);
}

export function saveProviders(projectRoot: string, providers: ProviderConfig[]) {
  writeJSON(path.join(projectRoot, OPC_DIR, "providers.json"), providers);
}

export function getProvider(projectRoot: string, id: string): ProviderConfig | undefined {
  const providers = loadProviders(projectRoot);
  return providers.find(p => p.id === id);
}

export function addProvider(projectRoot: string, provider: ProviderConfig): ProviderConfig {
  const providers = loadProviders(projectRoot);
  providers.push(provider);
  saveProviders(projectRoot, providers);
  return provider;
}

export function updateProvider(projectRoot: string, id: string, patch: Partial<ProviderConfig>): ProviderConfig | undefined {
  const providers = loadProviders(projectRoot);
  const idx = providers.findIndex(p => p.id === id);
  if (idx === -1) return undefined;
  providers[idx] = { ...providers[idx], ...patch, updatedAt: new Date().toISOString() };
  saveProviders(projectRoot, providers);
  return providers[idx];
}

export function deleteProvider(projectRoot: string, id: string): boolean {
  const providers = loadProviders(projectRoot);
  const idx = providers.findIndex(p => p.id === id);
  if (idx === -1) return false;
  providers.splice(idx, 1);
  saveProviders(projectRoot, providers);
  return true;
}

// ── Accounts (Phase 3 multi-account pool) ──────────────────────────────────

export function loadAccounts(projectRoot: string): ProviderAccount[] {
  return readJSON<ProviderAccount[]>(path.join(projectRoot, OPC_DIR, "accounts.json"), []);
}

export function saveAccounts(projectRoot: string, accounts: ProviderAccount[]) {
  writeJSON(path.join(projectRoot, OPC_DIR, "accounts.json"), accounts);
}

export function addAccount(projectRoot: string, acc: ProviderAccount): ProviderAccount {
  const accounts = loadAccounts(projectRoot);
  accounts.push(acc);
  saveAccounts(projectRoot, accounts);
  return acc;
}

export function updateAccount(projectRoot: string, id: string, patch: Partial<ProviderAccount>): ProviderAccount | undefined {
  const accounts = loadAccounts(projectRoot);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return undefined;
  accounts[idx] = { ...accounts[idx], ...patch, id: accounts[idx].id };
  saveAccounts(projectRoot, accounts);
  return accounts[idx];
}

export function deleteAccount(projectRoot: string, id: string): boolean {
  const accounts = loadAccounts(projectRoot);
  const idx = accounts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  accounts.splice(idx, 1);
  saveAccounts(projectRoot, accounts);
  return true;
}

// Compatibility backfill: an older project with no accounts.json gets one synthesized account
// per keyed preset provider (config.apiKeys) + per custom provider (providers.json) with a key.
export function ensureAccountsFromProviders(projectRoot: string): ProviderAccount[] {
  const existing = loadAccounts(projectRoot);
  const accounts: ProviderAccount[] = [...existing];

  // Backfill API accounts only when none exist yet (unchanged compatibility behavior).
  if (existing.length === 0) {
    const cfg = readJSON<{ apiKeys?: Record<string, string> }>(path.join(projectRoot, OPC_DIR, "config.json"), {});
    for (const [providerId, key] of Object.entries(cfg.apiKeys ?? {})) {
      if (!key) continue;
      accounts.push({ id: `${providerId}#0`, providerId, label: `${providerId} 主号`, apiKey: key, enabled: true, maxConcurrent: 6 });
    }
    for (const p of loadProviders(projectRoot)) {
      if (!p.apiKey || accounts.some(a => a.providerId === p.id)) continue;
      accounts.push({ id: `${p.id}#0`, providerId: p.id, label: p.name ?? p.id, apiKey: p.apiKey, baseUrl: p.baseUrl, enabled: true, maxConcurrent: 6 });
    }
  }

  // ALWAYS ensure a CLI subscription account per (provider, framework) used by any agent. Without
  // this, a node set to claude-code/codex whose provider has no matching account defers no_account.
  // No apiKey (the CLI uses its subscription login); maxConcurrent 3 (a CEO/Lead + 2-worker team
  // needs ≥3 concurrent slots against the shared subscription account, else a worker starves with
  // "no account"; subscriptions tolerate a few concurrent CLI calls); `frameworks` pinned so API
  // workers never lease it.
  const nodes = readJSON<Array<{ provider?: string; framework?: string; cliConfigDir?: string }>>(path.join(projectRoot, OPC_DIR, "agents.json"), []);
  let added = false;
  const subscriptionFrameworks = new Set<AgentFramework>([
    "claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build",
  ]);
  for (const n of nodes) {
    const fw = n.framework;
    if (!fw || !subscriptionFrameworks.has(fw as AgentFramework)) continue;
    const framework = fw as AgentFramework;
    const providerId = n.provider || fw;
    const id = `${providerId}#${fw}`;
    if (accounts.some(a => a.id === id)) continue;
    accounts.push({ id, providerId, label: `${providerId} ${fw}`, apiKey: "", configDir: n.cliConfigDir, frameworks: [framework], enabled: true, maxConcurrent: 3 });
    added = true;
  }

  if (added || (existing.length === 0 && accounts.length > 0)) saveAccounts(projectRoot, accounts);
  return accounts;
}
