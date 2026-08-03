import { describe, it, expect, vi, beforeEach } from "vitest";
import type { BundleMemoryRecord } from "@opc/shared";

const governance = vi.hoisted(() => ({
  proposeMemory: vi.fn(),
  removeGovernedMemoryProposalsByIds: vi.fn(),
}));

vi.mock("./memoryGovernance.js", () => governance);

import { importMemoryRecords } from "./memoryBundle.js";

const rec = (over: Partial<BundleMemoryRecord>): BundleMemoryRecord => ({
  memory_id: "mem-cs-1", scope: "general", owner_type: "company", owner_id: "c1",
  content: "内容", source: { type: "run", run_id: "r1", task_id: "", agent_id: undefined },
  level: "verified", score: 60, status: "active", tags: [],
  metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
  created_at: "", updated_at: "", last_used_at: "",
  ...over,
});

describe("令四.4 · importMemoryRecords 逐项失败与原子回滚", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let sequence = 0;
    governance.proposeMemory.mockImplementation((_root: string, input: { text: string }) => {
      if (input.text.includes("BOOM")) throw new Error("模拟治理提案写盘失败");
      if (input.text.includes("REJECT")) {
        return { proposalId: `rejected-${++sequence}`, status: "rejected", reasons: ["policy_rejected"] };
      }
      return { proposalId: `proposal-${++sequence}`, status: "proposed", reasons: [] };
    });
    governance.removeGovernedMemoryProposalsByIds.mockReturnValue(1);
  });

  it("任一写入抛错 → 整批回滚并逐项报告", () => {
    const res = importMemoryRecords("/tmp/x", [
      rec({ memory_id: "mem-cs-ok", content: "正常结论" }),
      rec({ memory_id: "mem-cs-bad", content: "BOOM 结论" }),
      rec({ memory_id: "mem-ps-bad", content: "BOOM 经验", owner_type: "agent", owner_id: "dev" }),
    ]);
    expect(res).toMatchObject({ imported: 0, skipped: 3, rolledBack: true });
    expect(res.failures).toHaveLength(3);
    const byId = Object.fromEntries(res.failures.map((failure) => [failure.memory_id, failure]));
    expect(byId["mem-cs-ok"].reason).toContain("本条成功写入已回滚");
    expect(byId["mem-cs-bad"]).toMatchObject({ kind: "conclusion_summary", reason: "模拟治理提案写盘失败" });
    expect(byId["mem-ps-bad"]).toMatchObject({ kind: "procedural_skill", reason: "模拟治理提案写盘失败" });
    expect(governance.removeGovernedMemoryProposalsByIds).toHaveBeenCalledWith("/tmp/x", ["proposal-1"]);
  });

  it("治理规则拒收 → 整批失败,不计 imported", () => {
    const res = importMemoryRecords("/tmp/x", [
      rec({ memory_id: "mem-ls-reject", content: "REJECT", owner_type: "agent", owner_id: "dev" }),
    ]);
    expect(res).toMatchObject({ imported: 0, skipped: 1, rolledBack: true });
    expect(res.failures).toEqual([{ memory_id: "mem-ls-reject", kind: "lesson", reason: "policy_rejected" }]);
    expect(governance.removeGovernedMemoryProposalsByIds).toHaveBeenCalledWith("/tmp/x", []);
  });

  it("全部成功 → 返回真实 proposal ids 且不触发回滚", () => {
    const res = importMemoryRecords("/tmp/x", [rec({ memory_id: "mem-cs-ok", content: "好结论" })]);
    expect(res.failures).toEqual([]);
    expect(res.imported).toBe(1);
    expect(res.recordIds.governedProposalIds).toEqual(["proposal-1"]);
    expect(governance.removeGovernedMemoryProposalsByIds).not.toHaveBeenCalled();
  });
});
