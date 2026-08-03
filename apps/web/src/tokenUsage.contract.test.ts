import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf-8");

describe("token-first product surface", () => {
  it("does not expose monetary controls in mission or provider settings", () => {
    expect(read("components/org/MissionBriefCard.tsx")).not.toContain("budgetLimitUsd");
    expect(read("pages/ProviderSettingsPage.tsx")).not.toContain("ProviderPricingConfig");
  });

  it("shows token usage without dollar formatting in core usage views", () => {
    for (const file of [
      "pages/CostPage.tsx",
      "components/cost/HeroStats.tsx",
      "components/cost/StaffRanking.tsx",
      "components/cost/TaskBillList.tsx",
      "components/trace/BillingSection.tsx",
      "components/common/CeoCockpit.tsx",
    ]) {
      const source = read(file);
      expect(source, file).not.toContain("fmtUsd");
      expect(source, file).not.toContain("Wallet");
    }
  });

  it("keeps template recommendations token-only", () => {
    const workshop = read("components/community/workshopTypes.ts");
    expect(workshop).not.toContain("recommendedBudgetUsd");
    expect(workshop).not.toContain("totalUsd: 0, maxTokensPerTask");
    expect(workshop).toContain("recommendedLegacyBudget");
    expect(workshop).toContain("hasTokenLimit ? { maxTokensPerTask }");
  });

  it("requests token timeseries for both CEO overview surfaces", () => {
    expect(read("components/org/BriefingPanel.tsx")).toContain("metric=tokens");
    expect(read("components/common/CeoCockpit.tsx")).toContain("todayTokens");
  });

  it("uses compact company/time/role filters and company-scoped token limits", () => {
    const page = read("pages/CostPage.tsx");
    const filters = read("components/cost/DimensionBar.tsx");
    expect(filters).toContain('data-testid="cost-filter-bar"');
    expect(filters).toContain('value="custom"');
    expect(page).not.toContain("monthOptions");
    expect(page).not.toContain("budget.edition");
    expect(page).toContain("maxTokensTotal: value");
    expect(page).toContain("companyBudgets");
  });

  it("opens a concrete run from each task ledger row", () => {
    const ledger = read("components/cost/TaskBillList.tsx");
    expect(ledger).toContain('import { openRun } from "../../lib/navigation.js"');
    expect(ledger).toContain("openRun(row.runId)");
  });
});
