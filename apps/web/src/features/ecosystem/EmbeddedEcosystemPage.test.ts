import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Run } from "@opc/shared";
import {
  ApprovalCards,
  CompanyPlanComparisonCard,
  CompanyPlanPreview,
  EmbeddedRunCard,
  EvidenceSummary,
} from "./EmbeddedEcosystemPage.js";
import type { EmbeddedEcosystemSnapshot } from "./types.js";
import type { BoundCompanyPlanProposal } from "./types.js";

function snapshotFixture(): EmbeddedEcosystemSnapshot {
  const run: Run = {
    id: "run-1",
    userGoal: "Build a verified release",
    companyId: "co-1",
    status: "waiting_review",
    startedAt: "2026-08-02T00:00:00.000Z",
    totalTokens: 1234,
    participatingAgents: ["dev"],
  };
  return {
    runs: [{ id: run.id, goal: run.userGoal, status: run.status, companyId: run.companyId }],
    selectedRun: { run, status: run.status, goal: run.userGoal },
    approvals: [{
      runId: run.id,
      level: "L3",
      reason: ["writes files"],
      decidedAt: run.startedAt,
      approvalRequired: true,
      approval: { status: "pending" },
      inputs: { goalPreview: run.userGoal, companyId: run.companyId },
    }],
    artifacts: { runId: run.id, degraded: false, artifacts: [] },
    evidence: {
      schemaVersion: 1,
      runId: run.id,
      generatedAt: run.startedAt,
      files: [{ path: "result.json", kind: "run-result", sha256: "abc", size: 3 }],
      workspaceChanges: [{ path: "src/a.ts", changeType: "modified" }],
      artifactDownloads: [],
      tests: [{ command: "pnpm test", passed: true, independent: true }],
      evidenceComplete: true,
      permissionPosture: {
        source: "committed-events", completeness: "complete", reasons: [], expectedAgentIds: ["dev"],
        receiptAgentIds: ["dev"], missingReceiptAgentIds: [], fullHostAccess: true, noOsSandbox: true,
        unsupportedConstraints: ["network scope not enforced"], approvalModes: ["run-governance"], workers: [],
      },
    },
    companies: [{ id: "co-1", name: "Product Team", description: "", createdAt: run.startedAt }],
    agents: [],
    selectedCompany: { id: "co-1", name: "Product Team", description: "", createdAt: run.startedAt },
    companyPlan: null,
  };
}

describe("embedded ecosystem cards", () => {
  it("renders canonical state, read-only approval, evidence, and company plan", () => {
    const snapshot = snapshotFixture();
    const open = () => undefined;
    const html = [
      renderToStaticMarkup(createElement(EmbeddedRunCard, { snapshot, onOpenRun: open })),
      renderToStaticMarkup(createElement(ApprovalCards, { approvals: snapshot.approvals, onOpenRun: open })),
      renderToStaticMarkup(createElement(EvidenceSummary, { snapshot })),
      renderToStaticMarkup(createElement(CompanyPlanPreview, { snapshot })),
    ].join("");
    expect(html).toContain("待审核");
    expect(html).toContain("只读");
    expect(html).toContain("Evidence");
    expect(html).toContain("完整宿主权限");
    expect(html).toContain("无 OS sandbox");
    expect(html).toContain("未执行的约束");
    expect(html).toContain("审批方式");
    expect(html).toContain("公司方案");
    expect(html).toContain("打开详情");
    expect(html).not.toContain("批准");
    expect(html).not.toContain("拒绝");
  });

  it("keeps compact surfaces constrained instead of widening the 1280x720 host", () => {
    const snapshot = snapshotFixture();
    const html = renderToStaticMarkup(createElement(EmbeddedRunCard, {
      snapshot,
      onOpenRun: () => undefined,
    }));
    expect(html).toContain("min-w-0");
    expect(html).toContain("truncate");
    expect(html).toContain("break-words");
  });

  it("exposes approval controls only when the host supplies a confirmation handler", () => {
    const snapshot = snapshotFixture();
    const readOnly = renderToStaticMarkup(createElement(ApprovalCards, {
      approvals: snapshot.approvals,
      onOpenRun: () => undefined,
    }));
    const confirmable = renderToStaticMarkup(createElement(ApprovalCards, {
      approvals: snapshot.approvals,
      onOpenRun: () => undefined,
      onDecision: async () => undefined,
    }));
    expect(readOnly).toContain("只读");
    expect(readOnly).not.toContain(">批准<");
    expect(confirmable).toContain("需二次确认");
    expect(confirmable).toContain(">批准<");
    expect(confirmable).toContain(">拒绝<");
    expect(confirmable).not.toContain("确认批准");
  });

  it("renders a bound Company Plan comparison and fails closed for an expired proposal", () => {
    const proposal: BoundCompanyPlanProposal = {
      proposalId: "proposal-1",
      companyId: "co-1",
      summary: "Add independent verification",
      beforeHash: "before-sha",
      actionsHash: "actions-sha",
      expiresAt: "2099-01-01T00:00:00.000Z",
      before: { agentCount: 2, roleCount: 2, verificationEdgeCount: 0, a2aChannelCount: 1, requiredSkillCount: 1 },
      after: { agentCount: 3, roleCount: 3, verificationEdgeCount: 1, a2aChannelCount: 1, requiredSkillCount: 2 },
      risks: ["新增验证者"],
    };
    const valid = renderToStaticMarkup(createElement(CompanyPlanComparisonCard, {
      proposal,
      expectedCompanyId: "co-1",
      onConfirm: async () => undefined,
    }));
    const expired = renderToStaticMarkup(createElement(CompanyPlanComparisonCard, {
      proposal: { ...proposal, expiresAt: "2020-01-01T00:00:00.000Z" },
      expectedCompanyId: "co-1",
      onConfirm: async () => undefined,
    }));
    expect(valid).toContain("公司方案对比");
    expect(valid).toContain("审阅并应用");
    expect(valid).toContain("验证边");
    expect(expired).toContain("提案已过期");
    expect(expired).not.toContain("审阅并应用");
  });
});
