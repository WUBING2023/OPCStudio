import * as fs from "node:fs";
import * as path from "node:path";
import type { ProviderHealthRecord } from "@opc/shared";

const CONSECUTIVE_FAILURE_THRESHOLD = 3;
// Even after the breaker trips, allow a retry once the last failure is old enough.
// Without this, a provider (esp. a single account) that hit the threshold stays
// unhealthy forever — health persists to disk and only recordSuccess clears it, but
// recordSuccess can never run while it's being skipped as unhealthy.
const RECOVERY_WINDOW_MS = 60_000;

const health = new Map<string, ProviderHealthRecord>();

let projectRoot = process.cwd();

export function initProviderHealth(root: string) {
  projectRoot = root;
  const p = healthPath(root);
  if (fs.existsSync(p)) {
    try {
      const data: ProviderHealthRecord[] = JSON.parse(fs.readFileSync(p, "utf-8"));
      for (const rec of data) {
        health.set(rec.provider, rec);
      }
    } catch { /* ignore corrupt health file */ }
  }
}

function healthPath(root: string) {
  return path.join(root, ".opc", "provider_health.json");
}

function persistHealth() {
  const records = Array.from(health.values());
  const dir = path.dirname(healthPath(projectRoot));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(healthPath(projectRoot), JSON.stringify(records, null, 2), "utf-8");
}

function getRecord(provider: string): ProviderHealthRecord {
  let rec = health.get(provider);
  if (!rec) {
    rec = { provider, consecutiveFailures: 0, lastSuccess: null, lastFailure: null, lastError: null };
    health.set(provider, rec);
  }
  return rec;
}

export function recordSuccess(provider: string, latencyMs: number) {
  const rec = getRecord(provider);
  rec.consecutiveFailures = 0;
  rec.lastSuccess = new Date().toISOString();
  health.set(provider, rec);
  persistHealth();
}

export function recordFailure(provider: string, error: string) {
  const rec = getRecord(provider);
  rec.consecutiveFailures++;
  rec.lastFailure = new Date().toISOString();
  rec.lastError = error.slice(0, 500);
  health.set(provider, rec);
  persistHealth();
}

export function isHealthy(provider: string): boolean {
  const rec = health.get(provider);
  if (!rec) return true;
  if (rec.consecutiveFailures < CONSECUTIVE_FAILURE_THRESHOLD) return true;
  // Time-based half-recovery: a tripped breaker still allows a retry once the last
  // failure is RECOVERY_WINDOW_MS old. A subsequent success calls recordSuccess and
  // resets consecutiveFailures to 0; another failure refreshes lastFailure.
  if (rec.lastFailure && Date.now() - Date.parse(rec.lastFailure) > RECOVERY_WINDOW_MS) return true;
  return false;
}

export function getHealthStats(provider: string): ProviderHealthRecord | null {
  return health.get(provider) ?? null;
}

export function getAllHealthStats(): ProviderHealthRecord[] {
  return Array.from(health.values());
}

export function suggestBackupProvider(provider: string, availableProviders: string[]): string | undefined {
  if (isHealthy(provider)) return undefined;
  for (const p of availableProviders) {
    // G4:自动切换只在【用户已配置(availableProviders 即已注册/可计费的真 provider)】里挑健康的;
    // 【绝不回退 mock】——缺 key/环境坏时宁可诚实失败,也绝不用 mock 伪装成功。
    if (p !== provider && p !== "mock" && isHealthy(p)) return p;
  }
  return undefined;
}
