import { describe, expect, it } from "vitest";
import { buildWorkbenchOverview } from "./workbenchOverview.js";

describe("workbench overview", () => {
  it("is scoped to the current company and separates active Runs from completed results", () => {
    const data = buildWorkbenchOverview([
      { id: "r1", goal: "active", status: "running", companyId: "c1", startedAt: "2026-08-02T02:00:00Z" },
      { id: "r2", goal: "done", status: "done", companyId: "c1", startedAt: "2026-08-02T01:00:00Z" },
      { id: "r3", goal: "other", status: "running", companyId: "c2", startedAt: "2026-08-02T03:00:00Z" },
    ], [], "c1");
    expect(data.running.map((run) => run.id)).toEqual(["r1"]);
    expect(data.recentSessions.map((run) => run.id)).toEqual(["r1", "r2"]);
    expect(data.recentResults.map((run) => run.id)).toEqual(["r2"]);
  });

  it("keeps only pending approvals for the current company", () => {
    const approvals = [
      { runId: "a", approvalRequired: true, approval: { status: "pending" }, inputs: { companyId: "c1" } },
      { runId: "b", approvalRequired: true, approval: { status: "approved" }, inputs: { companyId: "c1" } },
      { runId: "c", approvalRequired: true, approval: { status: "pending" }, inputs: { companyId: "c2" } },
    ] as any;
    expect(buildWorkbenchOverview([], approvals, "c1").approvals.map((record) => record.runId)).toEqual(["a"]);
  });

  it("uses all companies only for the explicit global view", () => {
    const runs = [
      { id: "r1", goal: "one", status: "done", companyId: "c1" },
      { id: "r2", goal: "two", status: "running", companyId: "c2" },
    ];
    const data = buildWorkbenchOverview(runs, [], "all");
    expect(data.recentSessions.map((run) => run.id)).toEqual(["r1", "r2"]);
    expect(data.running.map((run) => run.id)).toEqual(["r2"]);
  });
});
