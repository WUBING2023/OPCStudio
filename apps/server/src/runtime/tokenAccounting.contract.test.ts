import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR = fs.readFileSync(path.join(HERE, "orchestrator.ts"), "utf-8");
const PROJECT_STORE = fs.readFileSync(path.join(HERE, "..", "storage", "projectStore.ts"), "utf-8");
const TASK_GRAPH = fs.readFileSync(path.join(HERE, "taskGraphScheduler.ts"), "utf-8");
const MISSION_ROUTES = fs.readFileSync(path.join(HERE, "..", "routes", "missionRoutes.ts"), "utf-8");

describe("token-first execution accounting", () => {
  it("does not enforce cumulative or per-run monetary limits", () => {
    expect(ORCHESTRATOR).not.toContain("getCumulativeCost");
    expect(ORCHESTRATOR).not.toMatch(/runBudgetHit[\s\S]{0,500}maxCostPerRun/);
    expect(ORCHESTRATOR).not.toMatch(/cumulativeCost\s*>?=/);
  });

  it("keeps monetary config disabled by default for compatibility", () => {
    expect(PROJECT_STORE).toContain("budget: { totalUsd: 0, maxTokensPerTask: 200_000 }");
    expect(PROJECT_STORE).toContain("maxCostPerRun: b.maxCostPerRun ?? 0");
  });
  it("does not apply monetary gates while approving task graphs", () => {
    expect(TASK_GRAPH).not.toContain("budgetLimitUsd");
    expect(TASK_GRAPH).not.toContain("estimatedCostPerNodeUsd");
    expect(MISSION_ROUTES).not.toContain("computeCostSummary");
    expect(MISSION_ROUTES).not.toContain("budgetLimitUsd");
  });
});
