// E3/E4 · governance record store 单测:落盘/幂等/事件追加/审批状态机/滚动上限。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadGovernanceRecords, getGovernanceRecord, recordGovernanceDecision,
  appendGovernanceEvent, setGovernanceApproval, isDispatchAllowed,
  type GovernanceRecord,
} from "./governanceStore.js";
import { closeAllDbs } from "./sqlite/db.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "gov-store-")); });
// closeAllDbs() 释放 sqlite 后端下缓存的连接句柄,否则 Windows 上 WAL 文件被占用会让 rmSync 报 EPERM。
afterEach(() => { closeAllDbs(); try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄残留 */ } });

function makeRecord(runId: string, over: Partial<Parameters<typeof recordGovernanceDecision>[1]> = {}) {
  return recordGovernanceDecision(root, {
    runId, level: "L1", reason: ["测试规则"],
    inputs: { goalPreview: "g", frameworks: ["hermes"], writesFiles: true, involvesMcp: false, involvesAcp: false, involvesShell: false },
    ...over,
  });
}

describe("governanceStore — record 落盘", () => {
  it("recordGovernanceDecision 落 .opc/governance-records.json,新的在前", () => {
    makeRecord("run-a");
    makeRecord("run-b");
    const all = loadGovernanceRecords(root);
    expect(all.map(r => r.runId)).toEqual(["run-b", "run-a"]);
    expect(fs.existsSync(path.join(root, ".opc", "governance-records.json"))).toBe(true);
    expect(all[0].decidedAt).toBeTruthy();
    expect(all[0].events).toEqual([]);
  });

  it("同 runId 幂等:第二次返回已有 record,不重复落", () => {
    const first = makeRecord("run-a");
    const second = makeRecord("run-a", { level: "L3" });
    expect(second.level).toBe(first.level);
    expect(loadGovernanceRecords(root)).toHaveLength(1);
  });

  it("appendGovernanceEvent 追加事件(带时间戳);未知 run 返回 undefined", () => {
    makeRecord("run-a");
    const updated = appendGovernanceEvent(root, "run-a", { kind: "file_observation", agentId: "w1", files: [{ path: "a.md", changeType: "create" }] });
    expect(updated?.events).toHaveLength(1);
    expect(updated?.events[0]).toMatchObject({ kind: "file_observation", agentId: "w1" });
    expect(updated?.events[0].at).toBeTruthy();
    expect(appendGovernanceEvent(root, "nope", { kind: "kill" })).toBeUndefined();
  });

  it("滚动上限:超过 200 条淘汰最旧", () => {
    for (let i = 0; i < 205; i++) makeRecord(`run-${i}`);
    const all = loadGovernanceRecords(root);
    expect(all).toHaveLength(200);
    expect(all[0].runId).toBe("run-204");
    expect(all.some(r => r.runId === "run-0")).toBe(false);
  });
});

describe("governanceStore — L3 审批状态机与派发闸门", () => {
  it("approve 落状态 + 留 approved 事件", () => {
    makeRecord("run-a", { level: "L3", approvalRequired: true, approval: { status: "pending" } });
    const updated = setGovernanceApproval(root, "run-a", "approved", "tester");
    expect(updated?.approval).toMatchObject({ status: "approved", decidedBy: "tester" });
    expect(updated?.events.some(e => e.kind === "approved")).toBe(true);
  });

  it("reject 落状态 + 留 rejected 事件", () => {
    makeRecord("run-a", { level: "L3", approvalRequired: true, approval: { status: "pending" } });
    const updated = setGovernanceApproval(root, "run-a", "rejected", "tester");
    expect(updated?.approval?.status).toBe("rejected");
    expect(updated?.events.some(e => e.kind === "rejected")).toBe(true);
  });

  it("isDispatchAllowed:无 record/非审批 record 放行;pending/rejected 拦;approved 放行", () => {
    expect(isDispatchAllowed(undefined)).toBe(true);
    const l1 = makeRecord("run-l1");
    expect(isDispatchAllowed(l1)).toBe(true);
    const l3 = makeRecord("run-l3", { level: "L3", approvalRequired: true, approval: { status: "pending" } });
    expect(isDispatchAllowed(l3)).toBe(false);
    expect(isDispatchAllowed(setGovernanceApproval(root, "run-l3", "rejected", "t"))).toBe(false);
    const l3b = makeRecord("run-l3b", { level: "L3", approvalRequired: true, approval: { status: "pending" } });
    expect(isDispatchAllowed(l3b)).toBe(false);
    expect(isDispatchAllowed(setGovernanceApproval(root, "run-l3b", "approved", "t"))).toBe(true);
  });

  it("getGovernanceRecord 精确取回", () => {
    makeRecord("run-a");
    expect(getGovernanceRecord(root, "run-a")?.runId).toBe("run-a");
    expect(getGovernanceRecord(root, "run-x")).toBeUndefined();
  });
});

describe("governanceStore — pendingDispatch 随 record 落盘", () => {
  it("批准后派发所需参数完整保留", () => {
    makeRecord("run-a", {
      level: "L3", approvalRequired: true, approval: { status: "pending" },
      pendingDispatch: { goal: "大任务", companyId: "c1", runType: "quick", teamMode: "economy" },
    });
    const rec = getGovernanceRecord(root, "run-a") as GovernanceRecord;
    expect(rec.pendingDispatch).toEqual({ goal: "大任务", companyId: "c1", runType: "quick", teamMode: "economy" });
  });
});
