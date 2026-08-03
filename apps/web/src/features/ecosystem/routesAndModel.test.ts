import { describe, expect, it } from "vitest";
import { canonicalRunStatus, companyPlanBindingError, compareCompanyPlan, selectRunId } from "./model.js";
import { formatEmbeddedEcosystemRoute, parseEmbeddedEcosystemRoute } from "./routes.js";

describe("embedded ecosystem route", () => {
  it("round-trips safe run and company ids", () => {
    const hash = formatEmbeddedEcosystemRoute({ runId: "run-123", companyId: "company.one", proposalId: "plan-1" });
    expect(parseEmbeddedEcosystemRoute(hash)).toEqual({ runId: "run-123", companyId: "company.one", proposalId: "plan-1" });
  });

  it("rejects unsafe identifiers and unrelated routes", () => {
    expect(parseEmbeddedEcosystemRoute("#/runs/one")).toBeNull();
    expect(parseEmbeddedEcosystemRoute("#/ecosystem?run=../../keys&company=ok")).toEqual({
      runId: undefined,
      companyId: "ok",
      proposalId: undefined,
    });
  });
});

describe("canonical embedded run status", () => {
  it("preserves canonical states and never promotes unknown states to success", () => {
    expect(canonicalRunStatus("done")).toBe("done");
    expect(canonicalRunStatus("waiting_review")).toBe("waiting_review");
    expect(canonicalRunStatus("degraded", true)).toBe("failed");
    expect(canonicalRunStatus("future-success-like-value")).toBe("blocked");
  });

  it("selects only an existing requested run", () => {
    const rows = [{ id: "newest" }, { id: "older" }];
    expect(selectRunId(rows, "older")).toBe("older");
    expect(selectRunId(rows, "missing")).toBe("newest");
  });

  it("requires complete, unexpired Company Plan bindings", () => {
    const proposal = {
      proposalId: "p-1",
      companyId: "co-1",
      summary: "verify",
      beforeHash: "before",
      actionsHash: "actions",
      expiresAt: "2099-01-01T00:00:00.000Z",
      before: { agentCount: 1, roleCount: 1, verificationEdgeCount: 0, a2aChannelCount: 0, requiredSkillCount: 0 },
      after: { agentCount: 2, roleCount: 2, verificationEdgeCount: 1, a2aChannelCount: 1, requiredSkillCount: 1 },
    };
    expect(companyPlanBindingError(proposal, "co-1", Date.parse("2026-08-02T00:00:00.000Z"))).toBeNull();
    expect(companyPlanBindingError({ ...proposal, actionsHash: "" }, "co-1")).toBe("提案绑定信息不完整");
    expect(companyPlanBindingError(proposal, "co-2")).toBe("提案不属于当前公司");
    expect(companyPlanBindingError({ ...proposal, expiresAt: "2020-01-01T00:00:00.000Z" }, "co-1")).toContain("已过期");
    expect(companyPlanBindingError({ ...proposal, status: "applied" }, "co-1")).toContain("不能再次应用");
    expect(compareCompanyPlan(proposal).find((row) => row.key === "verificationEdgeCount")).toMatchObject({ before: 0, after: 1 });
  });
});
