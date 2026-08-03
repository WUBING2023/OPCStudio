import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompanyEditOperation } from "@opc/shared";
import {
  saveCompanyEditProposal, getCompanyEditProposal, markCompanyEditProposalApplied,
  markCompanyEditProposalRolledBack, loadCompanyEditProposals,
  issueConfirmationToken, consumeConfirmationToken, __resetConfirmationTokens,
} from "./companyEditProposalStore.js";

describe("companyEditProposalStore(pending/applied 状态机)", () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "company-edit-proposal-store-")); });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const ops: CompanyEditOperation[] = [{ op: "rename_company", name: "新名字" }];

  it("saveCompanyEditProposal:落一条 pending 记录,proposal_id 服务端生成", () => {
    const rec = saveCompanyEditProposal(root, { targetId: "wk-1", summary: "改名", operations: ops, risks: [] }, "2026-07-08T00:00:00.000Z");
    expect(rec.status).toBe("pending");
    expect(rec.proposal_id).toMatch(/^edit_prop_/);
    expect(rec.requires_user_confirmation).toBe(true);
    expect(getCompanyEditProposal(root, rec.proposal_id)).toEqual(rec);
  });

  it("markCompanyEditProposalApplied:pending → applied,补 appliedAt;找不到 id 返回 null", () => {
    const rec = saveCompanyEditProposal(root, { targetId: "wk-1", summary: "改名", operations: ops, risks: [] }, "2026-07-08T00:00:00.000Z");
    const updated = markCompanyEditProposalApplied(root, rec.proposal_id, "2026-07-08T00:05:00.000Z");
    expect(updated?.status).toBe("applied");
    expect(updated?.appliedAt).toBe("2026-07-08T00:05:00.000Z");
    expect(getCompanyEditProposal(root, rec.proposal_id)?.status).toBe("applied");

    expect(markCompanyEditProposalApplied(root, "no-such-id", "2026-07-08T00:05:00.000Z")).toBeNull();
  });

  it("令三.2:saveCompanyEditProposal 落入绑定五元组(companyId/operationsHash/beforeHash/expiresAt),读侧原样返回", () => {
    const rec = saveCompanyEditProposal(root, {
      targetId: "wk-1", summary: "改名", operations: ops, risks: [],
      companyId: "co-1", operationsHash: "ophash", beforeHash: "bhash", expiresAt: "2026-07-08T00:30:00.000Z",
    }, "2026-07-08T00:00:00.000Z");
    expect(rec.companyId).toBe("co-1");
    expect(rec.operationsHash).toBe("ophash");
    expect(rec.beforeHash).toBe("bhash");
    expect(rec.expiresAt).toBe("2026-07-08T00:30:00.000Z");
    const reloaded = getCompanyEditProposal(root, rec.proposal_id)!;
    expect(reloaded.operationsHash).toBe("ophash");
  });

  it("多条记录持久化到同一个 jsonl,重新加载后原样返回", () => {
    saveCompanyEditProposal(root, { targetId: "wk-1", summary: "a", operations: ops, risks: [] }, "2026-07-08T00:00:00.000Z");
    saveCompanyEditProposal(root, { targetId: "wk-1", summary: "b", operations: ops, risks: [] }, "2026-07-08T00:01:00.000Z");
    expect(loadCompanyEditProposals(root)).toHaveLength(2);
  });

  it("C11 rollback:markCompanyEditProposalRolledBack 只允许 applied→rolled_back,pending 返回 null", () => {
    const rec = saveCompanyEditProposal(root, { targetId: "wk-1", summary: "改名", operations: ops, risks: [] }, "2026-07-08T00:00:00.000Z");
    // pending 不能直接 rollback
    expect(markCompanyEditProposalRolledBack(root, rec.proposal_id, "2026-07-08T00:02:00.000Z")).toBeNull();
    markCompanyEditProposalApplied(root, rec.proposal_id, "2026-07-08T00:05:00.000Z", {
      targetBefore: { id: "wk-1", title: "旧名字", description: "", agents: [] },
      ledger: { fieldCount: 8, preserved: 7, intentionally_transformed: 1, lost: 0 },
    });
    const stored = getCompanyEditProposal(root, rec.proposal_id)!;
    expect(stored.targetBefore?.title).toBe("旧名字");
    expect(stored.ledger?.lost).toBe(0);
    const rb = markCompanyEditProposalRolledBack(root, rec.proposal_id, "2026-07-08T00:10:00.000Z");
    expect(rb?.status).toBe("rolled_back");
    expect(rb?.rolledBackAt).toBe("2026-07-08T00:10:00.000Z");
  });

  it("C11 读侧 tolerant:含已移除的六种悬空 op 的存量 JSONL 记录仍能整条解析(不掉进 unknown)", () => {
    // 手写一条含 add_team(写侧已移除)的历史记录,模拟收敛前存量数据。
    const legacy = {
      proposal_id: "edit_prop_legacy1", targetId: "wk-legacy", summary: "旧方案",
      operations: [{ op: "add_team", team: { name: "增长团队" } }, { op: "rename_company", name: "X" }],
      risks: [], requires_user_confirmation: true, status: "applied",
      createdAt: "2026-07-01T00:00:00.000Z", appliedAt: "2026-07-01T00:01:00.000Z",
    };
    const dir = path.join(root, ".opc", "architect");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "company-edit-proposals.jsonl"), JSON.stringify(legacy) + "\n", "utf-8");
    const loaded = loadCompanyEditProposals(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].proposal_id).toBe("edit_prop_legacy1");
    expect(loaded[0].operations).toHaveLength(2);
    expect((loaded[0].operations[0] as { op: string }).op).toBe("add_team");
  });
});

describe("令三.4 · 一次性 confirmation token 内存 store", () => {
  beforeEach(() => __resetConfirmationTokens());

  it("正常流:签发 → 用同一 bindingHash 消费 → ok;二次消费(重放)→ missing", () => {
    const { token } = issueConfirmationToken("company-edit-apply", "bind-A");
    expect(consumeConfirmationToken("company-edit-apply", token, "bind-A")).toBe("ok");
    // 一次性:同一 token 再消费 → missing(已失效)
    expect(consumeConfirmationToken("company-edit-apply", token, "bind-A")).toBe("missing");
  });

  it("绑定不符 → mismatch(不消费,原 token 仍可用正确 binding 消费)", () => {
    const { token } = issueConfirmationToken("company-edit-apply", "bind-A");
    expect(consumeConfirmationToken("company-edit-apply", token, "bind-B")).toBe("mismatch");
    expect(consumeConfirmationToken("company-edit-apply", token, "bind-A")).toBe("ok");
  });

  it("purpose 不符 → missing(草稿侧 token 不能用于活公司侧)", () => {
    const { token } = issueConfirmationToken("company-edit-apply", "bind-A");
    expect(consumeConfirmationToken("architect-apply", token, "bind-A")).toBe("missing");
  });

  it("过期 → expired(过期时间点之后消费)", () => {
    const now = Date.now();
    const { token } = issueConfirmationToken("company-edit-apply", "bind-A", now);
    // 10 分钟 + 1ms 之后
    expect(consumeConfirmationToken("company-edit-apply", token, "bind-A", now + 10 * 60 * 1000 + 1)).toBe("expired");
  });

  it("非字符串 / 空 token → missing", () => {
    expect(consumeConfirmationToken("company-edit-apply", undefined, "bind-A")).toBe("missing");
    expect(consumeConfirmationToken("company-edit-apply", "", "bind-A")).toBe("missing");
  });
});
