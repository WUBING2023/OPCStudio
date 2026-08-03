import { describe, expect, it } from "vitest";
import { formatAppRoute, parseAppRoute } from "./navigation.js";

describe("Phase 1 app routing", () => {
  it("round-trips company, workbench and run deep links", () => {
    expect(parseAppRoute(formatAppRoute({ page: "org", companyId: "company a" }))).toEqual({ page: "org", companyId: "company a" });
    expect(parseAppRoute(formatAppRoute({ page: "cockpit", companyId: "c1", runId: "r1", agentId: "dev-1" }))).toEqual({
      page: "cockpit", companyId: "c1", runId: "r1", agentId: "dev-1",
    });
    expect(parseAppRoute(formatAppRoute({ page: "results", companyId: "c1", runId: "r1" }))).toEqual({ page: "results", companyId: "c1", runId: "r1" });
  });

  it("keeps assets and integrations independently addressable", () => {
    expect(parseAppRoute("#/assets/memory/m-1?company=c1")).toEqual({ page: "memory", memoryId: "m-1", companyId: "c1" });
    expect(parseAppRoute("#/assets/skills")).toEqual({ page: "skills" });
    expect(parseAppRoute("#/integrations/api")).toEqual({ page: "api" });
    expect(parseAppRoute("#/integrations/mcp")).toEqual({ page: "mcp" });
    expect(parseAppRoute("#/settings")).toEqual({ page: "settings" });
  });

  it("maps legacy project URLs to run results without calling a Run a Project", () => {
    expect(parseAppRoute("#/projects")).toEqual({ page: "results" });
    expect(parseAppRoute("#/trace")).toEqual({ page: "results" });
  });
});
