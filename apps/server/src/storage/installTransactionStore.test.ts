import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadInstallTransactions, recordInstallTransaction, getInstallTransaction, markInstallTransactionRolledBack,
  markInstallTransactionFailed,
  type InstallTransaction,
} from "./installTransactionStore.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "install-tx-store-"));
});

afterEach(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

function draft(over: Partial<Omit<InstallTransaction, "txId" | "at" | "rolledBack" | "rolledBackAt">> = {}) {
  return {
    mode: "new-company" as const,
    source: "tpl-1",
    companyId: "co-1",
    created: { agentIds: ["a-1", "a-2"], companyIds: ["co-1"], presetChannelKeys: ["a-1=>a-2"], skillIds: ["sk-1"] },
    agentSnapshots: [{ id: "a-1", name: "CEO", companyId: "co-1" }, { id: "a-2", name: "Dev", parentId: "a-1", companyId: "co-1" }],
    conflictDecisions: [],
    safeInstallStripped: [],
    ...over,
  };
}

describe("installTransactionStore round-trip", () => {
  it("recordInstallTransaction:落盘形状(D6 指南字段)+ 真实文件落在 .opc/install-transactions.json", () => {
    const tx = recordInstallTransaction(root, draft());
    expect(typeof tx.txId).toBe("string");
    expect(tx.txId.length).toBeGreaterThan(0);
    expect(typeof tx.at).toBe("string");
    expect(tx.mode).toBe("new-company");
    expect(tx.source).toBe("tpl-1");
    expect(tx.companyId).toBe("co-1");
    expect(tx.created).toEqual({ agentIds: ["a-1", "a-2"], companyIds: ["co-1"], presetChannelKeys: ["a-1=>a-2"], skillIds: ["sk-1"] });
    expect(tx.conflictDecisions).toEqual([]);
    expect(tx.safeInstallStripped).toEqual([]);
    expect(tx.rolledBack).toBeUndefined();

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, ".opc", "install-transactions.json"), "utf-8"));
    expect(onDisk).toEqual([tx]);
    expect(getInstallTransaction(root, tx.txId)).toEqual(tx);
  });

  it("多次安装:新的插到数组头部", () => {
    const tx1 = recordInstallTransaction(root, draft({ source: "tpl-1" }));
    const tx2 = recordInstallTransaction(root, draft({ source: "tpl-2" }));
    const all = loadInstallTransactions(root);
    expect(all.map(t => t.txId)).toEqual([tx2.txId, tx1.txId]);
  });

  it("markInstallTransactionRolledBack:标 rolledBack:true + rolledBackAt,其余字段不变;返回 undefined 表示 txId 不存在", () => {
    const tx = recordInstallTransaction(root, draft());
    const updated = markInstallTransactionRolledBack(root, tx.txId);
    expect(updated?.rolledBack).toBe(true);
    expect(typeof updated?.rolledBackAt).toBe("string");
    expect(updated?.source).toBe(tx.source);
    expect(getInstallTransaction(root, tx.txId)?.rolledBack).toBe(true);
    expect(markInstallTransactionRolledBack(root, "no-such-tx")).toBeUndefined();
  });

  it("上限 50 条:第 51 条挤掉最老的", () => {
    for (let i = 0; i < 51; i++) recordInstallTransaction(root, draft({ source: `tpl-${i}` }));
    const all = loadInstallTransactions(root);
    expect(all.length).toBe(50);
    expect(all[0].source).toBe("tpl-50"); // 最新的在头部
    expect(all.some(t => t.source === "tpl-0")).toBe(false); // 最老的被挤掉
  });

  it("文件不存在 → []；损坏 JSON → [] 回退不炸", () => {
    expect(loadInstallTransactions(root)).toEqual([]);
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "install-transactions.json"), "{corrupted");
    expect(loadInstallTransactions(root)).toEqual([]);
  });

  it("merge 模式:conflictDecisions 携带 D3 的 decisions 形状", () => {
    const tx = recordInstallTransaction(root, draft({
      mode: "merge", companyId: "target",
      created: { agentIds: ["dev-0-copy"], companyIds: [], presetChannelKeys: [], skillIds: [] },
      conflictDecisions: [
        { category: "agent_id", conflictCount: 1, strategy: "copy-as-new", summary: "1 个冲突" },
      ],
    }));
    expect(tx.mode).toBe("merge");
    expect(tx.created.companyIds).toEqual([]);
    expect(tx.conflictDecisions).toHaveLength(1);
    expect(tx.conflictDecisions[0].category).toBe("agent_id");
  });

  // 对抗验收缺口①②:preMerge 快照(合并前 manifestMcpRequirements 整份值 / 被覆盖前的完整员工 /
  // 被改写前的完整边)——这里只验证落盘/读回原样,真实的"回滚时如何使用"在 communityRoutes.test.ts
  // /companyRoutes.test.ts 的路由层测试里覆盖。
  it("preMerge 快照:落盘 + 读回原样,字段整体可选(new-company 模式不带这个字段)", () => {
    const tx = recordInstallTransaction(root, draft({
      mode: "merge", companyId: "target",
      created: { agentIds: ["ceo-0"], companyIds: [], presetChannelKeys: [], skillIds: [] },
      preMerge: {
        manifestMcpRequirements: [{ name: "filesystem", optional: true }],
        overwrittenAgents: [{ id: "dev-0", name: "旧版 dev", role: "dev", companyId: "target", childrenIds: [], model: "m", provider: "prov-x", framework: "hermes", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true }],
        modifiedChannels: [{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }],
      },
    }));
    expect(tx.preMerge?.manifestMcpRequirements).toEqual([{ name: "filesystem", optional: true }]);
    expect(tx.preMerge?.overwrittenAgents).toHaveLength(1);
    expect(tx.preMerge?.overwrittenAgents?.[0].name).toBe("旧版 dev");
    expect(tx.preMerge?.modifiedChannels).toEqual([{ from: "ceo-x", to: "dev-x", purpose: "既有同步" }]);

    const reread = getInstallTransaction(root, tx.txId);
    expect(reread?.preMerge).toEqual(tx.preMerge);

    const newCompanyTx = recordInstallTransaction(root, draft());
    expect(newCompanyTx.preMerge).toBeUndefined(); // new-company 模式不带 preMerge
  });

  // status 最小枚举:record 时乐观标 completed(tx-first),安装 catch 标 failed,回滚标 rolled_back。
  describe("status 字段", () => {
    it("recordInstallTransaction → status:completed", () => {
      const tx = recordInstallTransaction(root, draft());
      expect(tx.status).toBe("completed");
      expect(getInstallTransaction(root, tx.txId)?.status).toBe("completed");
    });

    it("markInstallTransactionFailed → status:failed,其余字段不变;txId 不存在返回 undefined", () => {
      const tx = recordInstallTransaction(root, draft());
      const updated = markInstallTransactionFailed(root, tx.txId);
      expect(updated?.status).toBe("failed");
      expect(updated?.source).toBe(tx.source);
      expect(updated?.rolledBack).toBeUndefined();
      expect(getInstallTransaction(root, tx.txId)?.status).toBe("failed");
      expect(markInstallTransactionFailed(root, "no-such-tx")).toBeUndefined();
    });

    it("markInstallTransactionRolledBack → status:rolled_back(与 rolledBack 布尔并存)", () => {
      const tx = recordInstallTransaction(root, draft());
      const updated = markInstallTransactionRolledBack(root, tx.txId);
      expect(updated?.status).toBe("rolled_back");
      expect(updated?.rolledBack).toBe(true);
    });

    it("老 transaction(无 status)读回不炸,status 保持 undefined", () => {
      const tx = recordInstallTransaction(root, draft());
      const file = path.join(root, ".opc", "install-transactions.json");
      const arr = JSON.parse(fs.readFileSync(file, "utf-8"));
      delete arr[0].status;
      fs.writeFileSync(file, JSON.stringify(arr));
      expect(getInstallTransaction(root, tx.txId)?.status).toBeUndefined();
    });
  });
});
