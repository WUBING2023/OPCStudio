import { describe, expect, it } from "vitest";
import type { Company } from "@opc/shared";
import { groupCompanyTasks, isActiveCompanyTask, taskStatusTone, type CompanyTaskRun } from "./companyTaskNav.js";

const companies: Company[] = [
  { id: "a", name: "A", description: "", createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "b", name: "B", description: "", createdAt: "2026-01-02T00:00:00.000Z" },
];

const runs: CompanyTaskRun[] = [
  { id: "old", companyId: "a", goal: "old", status: "done", startedAt: "2026-01-01T00:00:00.000Z" },
  { id: "new", companyId: "a", goal: "new", status: "done", startedAt: "2026-01-03T00:00:00.000Z" },
  { id: "live", companyId: "a", goal: "live", status: "running", startedAt: "2025-12-01T00:00:00.000Z" },
  { id: "other", companyId: "b", goal: "other", status: "failed", startedAt: "2026-01-04T00:00:00.000Z" },
  { id: "legacy", goal: "legacy", status: "done", startedAt: "2026-01-05T00:00:00.000Z" },
];

describe("company task navigation", () => {
  it("groups real runs by company, prioritizes active work, and excludes unassigned history", () => {
    const groups = groupCompanyTasks(companies, runs, 2);
    expect(groups[0].total).toBe(3);
    expect(groups[0].runs.map((run) => run.id)).toEqual(["live", "new"]);
    expect(groups[1].runs.map((run) => run.id)).toEqual(["other"]);
    expect(groups.flatMap((group) => group.runs).some((run) => run.id === "legacy")).toBe(false);
  });

  it("honors a larger limit so the sidebar can reveal older projects", () => {
    const manyRuns = Array.from({ length: 12 }, (_, index): CompanyTaskRun => ({
      id: `run-${index}`, companyId: "a", goal: `project ${index}`, status: "done",
      startedAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    expect(groupCompanyTasks(companies, manyRuns, 12)[0].runs).toHaveLength(12);
    expect(groupCompanyTasks(companies, manyRuns, 4)[0].runs).toHaveLength(4);
  });

  it("derives honest status tones", () => {
    expect(isActiveCompanyTask("queued")).toBe(true);
    expect(taskStatusTone({ status: "done" })).toBe("success");
    expect(taskStatusTone({ status: "done", degraded: true })).toBe("warning");
    expect(taskStatusTone({ status: "failed" })).toBe("error");
  });
});
