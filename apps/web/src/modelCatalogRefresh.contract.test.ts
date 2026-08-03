import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (file: string) => fs.readFileSync(path.join(ROOT, file), "utf8");

describe("model catalog refresh product surface", () => {
  it("offers live refresh while keeping implementation timestamps out of subscription cards", () => {
    const providers = read("pages/ProviderSettingsPage.tsx");
    const subscriptions = read("pages/SubscriptionPage.tsx");
    expect(providers).toContain('refreshModelCatalog("provider"');
    expect(providers).toContain("refreshProviderModels");
    expect(providers).not.toContain("modelsUpdatedAt");
    expect(subscriptions).toContain('refreshModelCatalog("subscription"');
    expect(subscriptions).toContain("subscription.modelsUpdated");
    expect(subscriptions).toContain("canRefreshSubscriptionCatalog(fw)");
    expect(subscriptions).not.toContain("refreshedAt");
  });

  it("offers the same refresh action directly beside employee model selection", () => {
    const panel = read("components/AgentDetailsPanel.tsx");
    expect(panel).toContain("refreshCurrentModels");
    expect(panel).toContain("api.refreshModels");
    expect(panel).toContain("subscription.refreshModels");
    expect(panel).toContain("currentCatalogEntry?.refreshedAt");
  });
});