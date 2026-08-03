import { describe, it, expect, beforeEach } from "vitest";
import {
  commitProposal,
  rejectProposal,
  approveProposal,
  MemoryLedger,
} from "./memoryCommit.js";
import type { MemoryProposal, CommittedMemory } from "./memoryCommit.js";

// ── 测试夹具 ─────────────────────────────────────────────────────────────────

function makeProposal(overrides?: Partial<MemoryProposal>): MemoryProposal {
  return {
    proposalId: "prop-001",
    runId: "run-abc123",
    scope: "project",
    type: "finding",
    content: "量子纠缠可在室温下维持 1ms",
    sourceArtifactRefs: ["art-1", "art-2"],
    proposedBy: "worker-research-1",
    confidence: 0.85,
    tags: ["quantum", "research"],
    status: "pending",
    ...overrides,
  };
}

const APPROVED_BY = "lead-001";
const CREATED_AT = "2026-06-28T10:00:00.000Z";
const MEMORY_ID = "mem-qe-001";

// ── commitProposal（纯函数） ───────────────────────────────────────────────────

describe("commitProposal — 首次提交", () => {
  it("pending proposal 返回 version=1, parentVersion=0", () => {
    const proposal = makeProposal();
    const result = commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(result.version).toBe(1);
    expect(result.parentVersion).toBe(0);
    expect(result.memoryId).toBe(MEMORY_ID);
    expect(result.approvedBy).toBe(APPROVED_BY);
    expect(result.createdAt).toBe(CREATED_AT);
  });

  it("字段从 proposal 正确映射", () => {
    const proposal = makeProposal();
    const result = commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(result.scope).toBe("project");
    expect(result.type).toBe("finding");
    expect(result.content).toBe("量子纠缠可在室温下维持 1ms");
    expect(result.sourceArtifactRefs).toEqual(["art-1", "art-2"]);
    expect(result.confidence).toBe(0.85);
    expect(result.revocable).toBe(true);
  });

  it("sourceArtifactRefs 为深拷贝，修改原 proposal 不影响结果", () => {
    const proposal = makeProposal();
    const result = commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID);
    proposal.sourceArtifactRefs.push("art-3");
    expect(result.sourceArtifactRefs).toHaveLength(2);
  });

  it("revocable=false 时正确传递", () => {
    const proposal = makeProposal();
    const result = commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID, undefined, false);
    expect(result.revocable).toBe(false);
  });
});

describe("commitProposal — 有 prev 时版本递增", () => {
  it("prev.version=1 时返回 version=2, parentVersion=1", () => {
    const prev: CommittedMemory = {
      memoryId: MEMORY_ID, version: 1, parentVersion: 0,
      scope: "project", type: "finding",
      content: "旧内容", sourceArtifactRefs: [],
      approvedBy: APPROVED_BY, confidence: 0.7, revocable: true,
      createdAt: "2026-06-27T00:00:00.000Z",
    };
    const proposal = makeProposal({ content: "新内容" });
    const result = commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID, prev);
    expect(result.version).toBe(2);
    expect(result.parentVersion).toBe(1);
    expect(result.content).toBe("新内容");
  });

  it("多次递增：v3 在 v2 基础上 +1", () => {
    const prev: CommittedMemory = {
      memoryId: MEMORY_ID, version: 2, parentVersion: 1,
      scope: "project", type: "finding",
      content: "v2", sourceArtifactRefs: [],
      approvedBy: APPROVED_BY, confidence: 0.8, revocable: true,
      createdAt: CREATED_AT,
    };
    const result = commitProposal(makeProposal(), APPROVED_BY, CREATED_AT, MEMORY_ID, prev);
    expect(result.version).toBe(3);
    expect(result.parentVersion).toBe(2);
  });
});

describe("commitProposal — 非 pending 状态抛出", () => {
  it("status=committed 时抛出", () => {
    const proposal = makeProposal({ status: "committed" });
    expect(() => commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID)).toThrow(
      /committed/,
    );
  });

  it("status=rejected 时抛出", () => {
    const proposal = makeProposal({ status: "rejected" });
    expect(() => commitProposal(proposal, APPROVED_BY, CREATED_AT, MEMORY_ID)).toThrow(
      /rejected/,
    );
  });
});

// ── rejectProposal（纯函数） ──────────────────────────────────────────────────

describe("rejectProposal — 纯函数", () => {
  it("pending → rejected，返回新对象", () => {
    const proposal = makeProposal();
    const result = rejectProposal(proposal);
    expect(result.status).toBe("rejected");
    expect(proposal.status).toBe("pending"); // 原对象不变
    expect(result).not.toBe(proposal);       // 新引用
  });

  it("其余字段保持不变", () => {
    const proposal = makeProposal();
    const result = rejectProposal(proposal);
    expect(result.proposalId).toBe(proposal.proposalId);
    expect(result.content).toBe(proposal.content);
    expect(result.confidence).toBe(proposal.confidence);
  });

  it("status=committed 时抛出", () => {
    expect(() => rejectProposal(makeProposal({ status: "committed" }))).toThrow();
  });

  it("status=rejected 时抛出", () => {
    expect(() => rejectProposal(makeProposal({ status: "rejected" }))).toThrow();
  });
});

// ── MemoryLedger ──────────────────────────────────────────────────────────────

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

describe("MemoryLedger.add", () => {
  it("正常注册 pending proposal 后可查询", () => {
    const p = makeProposal();
    ledger.add(p);
    expect(ledger.getProposal("prop-001")).toMatchObject({ proposalId: "prop-001", status: "pending" });
  });

  it("proposalId 重复时抛出", () => {
    ledger.add(makeProposal());
    expect(() => ledger.add(makeProposal())).toThrow(/已存在/);
  });

  it("非 pending 状态 proposal 不允许注册", () => {
    expect(() => ledger.add(makeProposal({ status: "committed" }))).toThrow(/pending/);
    expect(() => ledger.add(makeProposal({ status: "rejected" }))).toThrow(/pending/);
  });
});

describe("MemoryLedger.commit", () => {
  it("首次提交产生 version=1 的 CommittedMemory", () => {
    ledger.add(makeProposal());
    const mem = ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(mem.version).toBe(1);
    expect(mem.parentVersion).toBe(0);
    expect(mem.memoryId).toBe(MEMORY_ID);
    expect(mem.approvedBy).toBe(APPROVED_BY);
  });

  it("同 memoryId 第二次 commit 版本递增", () => {
    ledger.add(makeProposal({ proposalId: "prop-001" }));
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);

    ledger.add(makeProposal({ proposalId: "prop-002" }));
    const mem2 = ledger.commit("prop-002", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(mem2.version).toBe(2);
    expect(mem2.parentVersion).toBe(1);
  });

  it("提交后 proposal.status 变为 committed", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(ledger.getProposal("prop-001")?.status).toBe("committed");
  });

  it("proposalId 不存在时抛出", () => {
    expect(() => ledger.commit("nonexistent", APPROVED_BY, CREATED_AT, MEMORY_ID)).toThrow(
      /不存在/,
    );
  });

  it("已撤销的 memoryId 默认拒绝提交", () => {
    ledger.add(makeProposal({ proposalId: "prop-001" }));
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    ledger.revoke(MEMORY_ID);

    ledger.add(makeProposal({ proposalId: "prop-002" }));
    expect(() => ledger.commit("prop-002", APPROVED_BY, CREATED_AT, MEMORY_ID)).toThrow(/已被撤销/);
  });

  it("force=true 可以向已撤销的 memoryId 提交（解除撤销标记）", () => {
    ledger.add(makeProposal({ proposalId: "prop-001" }));
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    ledger.revoke(MEMORY_ID);

    ledger.add(makeProposal({ proposalId: "prop-002" }));
    const mem = ledger.commit("prop-002", APPROVED_BY, CREATED_AT, MEMORY_ID, true, true);
    expect(mem.version).toBe(2);
    expect(ledger.isRevoked(MEMORY_ID)).toBe(false);
  });
});

describe("MemoryLedger.reject", () => {
  it("pending → rejected", () => {
    ledger.add(makeProposal());
    const r = ledger.reject("prop-001");
    expect(r.status).toBe("rejected");
    expect(ledger.getProposal("prop-001")?.status).toBe("rejected");
  });

  it("proposalId 不存在时抛出", () => {
    expect(() => ledger.reject("nonexistent")).toThrow(/不存在/);
  });

  it("已提交的 proposal 再次 reject 时抛出", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(() => ledger.reject("prop-001")).toThrow();
  });
});

describe("MemoryLedger.revoke", () => {
  it("revocable=true 的条目可以撤销", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, true);
    const entry = ledger.revoke(MEMORY_ID);
    expect(entry.memoryId).toBe(MEMORY_ID);
    expect(ledger.isRevoked(MEMORY_ID)).toBe(true);
  });

  it("revocable=false 的条目撤销时抛出", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, false);
    expect(() => ledger.revoke(MEMORY_ID)).toThrow(/不可撤销/);
  });

  it("memoryId 不存在时抛出", () => {
    expect(() => ledger.revoke("nonexistent")).toThrow(/不存在/);
  });

  it("撤销后 list() 默认不返回该条目", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, true);
    ledger.revoke(MEMORY_ID);
    expect(ledger.list()).toHaveLength(0);
  });

  it("includeRevoked=true 可查到撤销条目", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, true);
    ledger.revoke(MEMORY_ID);
    const all = ledger.list({ includeRevoked: true });
    expect(all).toHaveLength(1);
    expect(all[0].memoryId).toBe(MEMORY_ID);
  });
});

describe("MemoryLedger.list — 过滤", () => {
  beforeEach(() => {
    // 准备 3 条 committed memory
    ledger.add(makeProposal({ proposalId: "p1", scope: "project", type: "finding", confidence: 0.9, tags: ["quantum"] }));
    ledger.commit("p1", APPROVED_BY, CREATED_AT, "mem-1");

    ledger.add(makeProposal({ proposalId: "p2", scope: "team", type: "lesson", confidence: 0.5, tags: ["process"] }));
    ledger.commit("p2", APPROVED_BY, CREATED_AT, "mem-2");

    ledger.add(makeProposal({ proposalId: "p3", scope: "project", type: "finding", confidence: 0.6, tags: ["quantum", "process"] }));
    ledger.commit("p3", APPROVED_BY, CREATED_AT, "mem-3");
  });

  it("不加过滤返回全部 3 条", () => {
    expect(ledger.list()).toHaveLength(3);
  });

  it("scope=project 过滤出 2 条", () => {
    const r = ledger.list({ scope: "project" });
    expect(r).toHaveLength(2);
    expect(r.every(m => m.scope === "project")).toBe(true);
  });

  it("type=lesson 过滤出 1 条", () => {
    const r = ledger.list({ type: "lesson" });
    expect(r).toHaveLength(1);
    expect(r[0].memoryId).toBe("mem-2");
  });

  it("minConfidence=0.7 过滤出 confidence>=0.7 的条目", () => {
    const r = ledger.list({ minConfidence: 0.7 });
    expect(r).toHaveLength(1);
    expect(r[0].memoryId).toBe("mem-1");
  });

  it("minConfidence 边界：0.9 包含等于 0.9 的条目", () => {
    const r = ledger.list({ minConfidence: 0.9 });
    expect(r).toHaveLength(1);
    expect(r[0].confidence).toBe(0.9);
  });

  it("tags=quantum AND process 只匹配同时含有两个 tag 的条目", () => {
    const r = ledger.list({ tags: ["quantum", "process"] });
    expect(r).toHaveLength(1);
    expect(r[0].memoryId).toBe("mem-3");
  });

  it("tags=quantum 匹配 mem-1 和 mem-3", () => {
    const r = ledger.list({ tags: ["quantum"] });
    expect(r).toHaveLength(2);
    expect(r.map(m => m.memoryId).sort()).toEqual(["mem-1", "mem-3"]);
  });

  it("scope + minConfidence 组合过滤", () => {
    const r = ledger.list({ scope: "project", minConfidence: 0.8 });
    expect(r).toHaveLength(1);
    expect(r[0].memoryId).toBe("mem-1");
  });
});

describe("MemoryLedger.listProposals — 状态过滤", () => {
  it("不传 status 返回所有 proposal", () => {
    ledger.add(makeProposal({ proposalId: "p1" }));
    ledger.add(makeProposal({ proposalId: "p2" }));
    ledger.commit("p1", APPROVED_BY, CREATED_AT, "mem-1");
    ledger.reject("p2");
    expect(ledger.listProposals()).toHaveLength(2);
  });

  it("status=pending 只返回未处理的", () => {
    ledger.add(makeProposal({ proposalId: "p1" }));
    ledger.add(makeProposal({ proposalId: "p2" }));
    ledger.commit("p1", APPROVED_BY, CREATED_AT, "mem-1");
    expect(ledger.listProposals("pending")).toHaveLength(1);
    expect(ledger.listProposals("pending")[0].proposalId).toBe("p2");
  });

  it("status=committed 只返回已提交的", () => {
    ledger.add(makeProposal({ proposalId: "p1" }));
    ledger.add(makeProposal({ proposalId: "p2" }));
    ledger.commit("p1", APPROVED_BY, CREATED_AT, "mem-1");
    ledger.reject("p2");
    expect(ledger.listProposals("committed")).toHaveLength(1);
    expect(ledger.listProposals("rejected")).toHaveLength(1);
  });
});

describe("MemoryLedger.get — 单条查询", () => {
  it("存在时返回最新版本", () => {
    ledger.add(makeProposal({ proposalId: "p1" }));
    ledger.commit("p1", APPROVED_BY, CREATED_AT, MEMORY_ID);
    ledger.add(makeProposal({ proposalId: "p2", content: "更新内容" }));
    ledger.commit("p2", APPROVED_BY, CREATED_AT, MEMORY_ID);
    const m = ledger.get(MEMORY_ID);
    expect(m?.version).toBe(2);
    expect(m?.content).toBe("更新内容");
  });

  it("不存在时返回 undefined", () => {
    expect(ledger.get("nonexistent")).toBeUndefined();
  });

  it("已撤销条目仍可通过 get() 查到（历史保留）", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, true);
    ledger.revoke(MEMORY_ID);
    expect(ledger.get(MEMORY_ID)).toBeDefined();
  });
});

describe("边界与不变式", () => {
  it("confidence=0 和 confidence=1 均合法通过", () => {
    ledger.add(makeProposal({ proposalId: "p-low", confidence: 0 }));
    ledger.add(makeProposal({ proposalId: "p-high", confidence: 1 }));
    const low = ledger.commit("p-low", APPROVED_BY, CREATED_AT, "mem-low");
    const high = ledger.commit("p-high", APPROVED_BY, CREATED_AT, "mem-high");
    expect(low.confidence).toBe(0);
    expect(high.confidence).toBe(1);
  });

  it("空 sourceArtifactRefs 合法", () => {
    ledger.add(makeProposal({ sourceArtifactRefs: [] }));
    const mem = ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(mem.sourceArtifactRefs).toEqual([]);
  });

  it("空 tags 的 proposal 可正常 commit 和 list", () => {
    ledger.add(makeProposal({ tags: [] }));
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(ledger.list({ tags: [] })).toHaveLength(1);
  });

  it("多个 memoryId 并行版本化互不干扰", () => {
    ledger.add(makeProposal({ proposalId: "p1" }));
    ledger.add(makeProposal({ proposalId: "p2" }));
    const m1 = ledger.commit("p1", APPROVED_BY, CREATED_AT, "mem-A");
    const m2 = ledger.commit("p2", APPROVED_BY, CREATED_AT, "mem-B");
    expect(m1.version).toBe(1);
    expect(m2.version).toBe(1);

    ledger.add(makeProposal({ proposalId: "p3" }));
    const m1v2 = ledger.commit("p3", APPROVED_BY, CREATED_AT, "mem-A");
    expect(m1v2.version).toBe(2);
    expect(ledger.get("mem-B")?.version).toBe(1); // mem-B 未受影响
  });

  it("isRevoked 在撤销前为 false，撤销后为 true", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID, true);
    expect(ledger.isRevoked(MEMORY_ID)).toBe(false);
    ledger.revoke(MEMORY_ID);
    expect(ledger.isRevoked(MEMORY_ID)).toBe(true);
  });
});

// ── A1-V2 · approve 三态流(pending → approved → committed 完整走账) ─────────────

const APPROVED_AT = "2026-07-07T00:00:00.000Z";

describe("approveProposal — 纯函数", () => {
  it("pending → approved,记录 approvedBy/approvedAt 与 statusHistory,原对象不变", () => {
    const proposal = makeProposal();
    const r = approveProposal(proposal, APPROVED_BY, APPROVED_AT);
    expect(r.status).toBe("approved");
    expect(r.approvedBy).toBe(APPROVED_BY);
    expect(r.approvedAt).toBe(APPROVED_AT);
    expect(r.statusHistory?.map((h) => h.status)).toEqual(["pending", "approved"]);
    expect(proposal.status).toBe("pending"); // 原对象不变(纯函数)
  });

  it("非 pending(committed/rejected/approved)抛出", () => {
    expect(() => approveProposal(makeProposal({ status: "committed" }), APPROVED_BY, APPROVED_AT)).toThrow();
    expect(() => approveProposal(makeProposal({ status: "rejected" }), APPROVED_BY, APPROVED_AT)).toThrow();
    const approved = approveProposal(makeProposal(), APPROVED_BY, APPROVED_AT);
    expect(() => approveProposal(approved, APPROVED_BY, APPROVED_AT)).toThrow(); // 不可重复批准
  });
});

describe("commitProposal — 接受 approved 状态(A1-V2 完整流)", () => {
  it("approved proposal 可 commit", () => {
    const approved = approveProposal(makeProposal(), APPROVED_BY, APPROVED_AT);
    const mem = commitProposal(approved, APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(mem.version).toBe(1);
    expect(mem.approvedBy).toBe(APPROVED_BY);
  });
});

describe("MemoryLedger.approve — 完整走账", () => {
  it("add → approve → commit:statusHistory 完整记录 pending→approved→committed", () => {
    ledger.add(makeProposal());
    ledger.approve("prop-001", APPROVED_BY, APPROVED_AT);
    expect(ledger.getProposal("prop-001")?.status).toBe("approved");
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    const p = ledger.getProposal("prop-001");
    expect(p?.status).toBe("committed");
    expect(p?.statusHistory?.map((h) => h.status)).toEqual(["pending", "approved", "committed"]);
    expect(p?.statusHistory?.[1]).toMatchObject({ by: APPROVED_BY, at: APPROVED_AT });
  });

  it("proposalId 不存在时抛出", () => {
    expect(() => ledger.approve("nonexistent", APPROVED_BY, APPROVED_AT)).toThrow(/不存在/);
  });

  it("已 committed 的 proposal 再 approve 抛出", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    expect(() => ledger.approve("prop-001", APPROVED_BY, APPROVED_AT)).toThrow();
  });

  it("旧路径兼容:pending 直接 commit(隐式批准)仍可用,statusHistory 记 pending→committed", () => {
    ledger.add(makeProposal());
    ledger.commit("prop-001", APPROVED_BY, CREATED_AT, MEMORY_ID);
    const p = ledger.getProposal("prop-001");
    expect(p?.statusHistory?.map((h) => h.status)).toEqual(["pending", "committed"]);
  });

  it("高风险停 pending:不 approve 不 commit,listProposals('pending') 可查到待审提案", () => {
    ledger.add(makeProposal({ risk: "high" }));
    const pendings = ledger.listProposals("pending");
    expect(pendings).toHaveLength(1);
    expect(pendings[0].risk).toBe("high");
    expect(ledger.list()).toHaveLength(0); // 未生效,不进 committed memory
  });
});
