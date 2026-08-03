import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TaskGraph } from "@opc/shared";
import type { CompanyEditOperation } from "@opc/shared";
import { closeAllDbs } from "./sqlite/db.js";
import { openBusinessDb, readAllDocs, readDocByPk } from "./sqlite/docTableBackend.js";
import { migrateJsonToSqlite } from "./sqlite/migrateJsonToSqlite.js";
import { readJSON } from "./jsonFile.js";

import { loadTaskGraphs, upsertTaskGraph, getTaskGraph, getTaskGraphByMission } from "./taskGraphStore.js";
import { createMemoryJob, updateMemoryJob, loadMemoryJobs, getMemoryJob } from "./memoryJobStore.js";
import { recordGovernanceDecision, loadGovernanceRecords, appendGovernanceEvent, getGovernanceRecord } from "./governanceStore.js";
import { appendTurns, loadThread, chatThreadId } from "./chatThreadStore.js";
import { saveCompanyEditProposal, markCompanyEditProposalApplied, loadCompanyEditProposals } from "./companyEditProposalStore.js";
import { reconcileCitations } from "./agentGrowthStore.js";
import { upsertProceduralSkill } from "./registryStore.js";
import { ensureStoreMeta, UnsupportedStoreVersionError, CURRENT_STORE_VERSION } from "./metaStore.js";

// 战役B·Phase B2a 总验:8 个中立 store 参数化双后端等价。
// - 「参数化双后端」:同一套确定性场景在 json 与 sqlite 后端各跑一遍,断言结构性结果一致(§一)。
// - 「双写后两读路径等价」:sqlite 后端写一次(双写)后,用 sqlite 读路径与 json 读路径读**同一份**数据,
//   逐字段 deepEqual —— 同一份数据只写一次,规避时间戳/随机 id 的非确定性,直证两条读路径行为等价(§二)。
// - 「构造库迁移后两读路径等价」:预写 canonical JSON → migrateJsonToSqlite → sqlite 读 == json 读(§三)。
// 绝不碰真实 .opc;全部临时目录构造库/副本。

const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "store-parity-"));
  fs.mkdirSync(path.join(r, ".opc"), { recursive: true });
  roots.push(r);
  return r;
}
afterEach(() => {
  closeAllDbs();
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }
  delete process.env.OPC_STORAGE_BACKEND;
});

function withBackend<T>(backend: string, fn: () => T): T {
  const prev = process.env.OPC_STORAGE_BACKEND;
  process.env.OPC_STORAGE_BACKEND = backend;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.OPC_STORAGE_BACKEND; else process.env.OPC_STORAGE_BACKEND = prev; }
}

function makeGraph(over: Partial<TaskGraph> = {}): TaskGraph {
  return {
    id: "tg-1", missionId: "m-1", companyId: "co1", goal: "总目标",
    nodes: [], status: "committed",
    createdAt: "2026-07-07T00:00:00Z", updatedAt: "2026-07-07T00:00:00Z", schemaVersion: "1",
    ...over,
  };
}
const govInputs = { goalPreview: "g", frameworks: [] as string[], writesFiles: true, involvesMcp: false, involvesAcp: false, involvesShell: false };
const ops: CompanyEditOperation[] = [{ op: "rename_company", name: "新名字" }];
const NOW = "2026-07-07T00:00:00.000Z";
function wj(root: string, rel: string, data: unknown): void {
  const abs = path.join(root, ".opc", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(data, null, 2), "utf-8");
}

// ─────────────────────────── §一:参数化双后端行为等价 ───────────────────────────
const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("§一 行为等价 [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("taskGraphStore:upsert(替换非追加)+ 新图入头 + 按 mission 取最新", () => {
    const root = mkRoot();
    run(() => {
      upsertTaskGraph(root, makeGraph({ id: "tg-1", missionId: "m-1" }));
      upsertTaskGraph(root, makeGraph({ id: "tg-2", missionId: "m-1" }));
      upsertTaskGraph(root, makeGraph({ id: "tg-1", status: "running" }));
    });
    run(() => {
      expect(loadTaskGraphs(root).map((g) => g.id)).toEqual(["tg-2", "tg-1"]);
      expect(getTaskGraph(root, "tg-1")!.status).toBe("running");
      expect(getTaskGraphByMission(root, "m-1")!.id).toBe("tg-2");
    });
  });

  it("memoryJobStore:create(queued)→update(completed)+ 新的在前", () => {
    const root = mkRoot();
    run(() => {
      const j1 = createMemoryJob(root, { kind: "export", companyId: "c1" }, NOW);
      createMemoryJob(root, { kind: "import", companyId: "c1" }, NOW);
      const done = updateMemoryJob(root, j1.jobId, { status: "completed", result: { imported: 3 } }, NOW);
      expect(done?.status).toBe("completed");
      expect(getMemoryJob(root, j1.jobId)?.result).toEqual({ imported: 3 });
      expect(loadMemoryJobs(root)[0].kind).toBe("import"); // 后建的在前
      expect(loadMemoryJobs(root)).toHaveLength(2);
    });
  });

  it("governanceStore:record(新在前)+ 幂等 + appendEvent + getRecord", () => {
    const root = mkRoot();
    run(() => {
      recordGovernanceDecision(root, { runId: "run-a", level: "L1", reason: ["r"], inputs: govInputs });
      recordGovernanceDecision(root, { runId: "run-b", level: "L2", reason: ["r"], inputs: govInputs });
      recordGovernanceDecision(root, { runId: "run-a", level: "L3", reason: ["r"], inputs: govInputs }); // 幂等,不改级
      expect(loadGovernanceRecords(root).map((r) => r.runId)).toEqual(["run-b", "run-a"]);
      expect(getGovernanceRecord(root, "run-a")!.level).toBe("L1");
      const upd = appendGovernanceEvent(root, "run-a", { kind: "file_observation", agentId: "w1" });
      expect(upd?.events).toHaveLength(1);
    });
  });

  it("chatThreadStore:append 追加保序 + 按 company/agent 隔离", () => {
    const root = mkRoot();
    run(() => {
      appendTurns(root, "c1", "a1", [{ role: "user", content: "q1" }], NOW);
      appendTurns(root, "c1", "a1", [{ role: "assistant", content: "r1" }], NOW);
      appendTurns(root, "c2", "a1", [{ role: "user", content: "other" }], NOW);
      expect(loadThread(root, "c1", "a1").map((t) => t.content)).toEqual(["q1", "r1"]);
      expect(loadThread(root, "c2", "a1").map((t) => t.content)).toEqual(["other"]);
    });
  });

  it("companyEditProposalStore:save(pending)→markApplied + 多条持久化", () => {
    const root = mkRoot();
    run(() => {
      const rec = saveCompanyEditProposal(root, { targetId: "t1", summary: "改名", operations: ops, risks: [] }, NOW);
      expect(rec.status).toBe("pending");
      saveCompanyEditProposal(root, { targetId: "t2", summary: "b", operations: ops, risks: [] }, NOW);
      const applied = markCompanyEditProposalApplied(root, rec.proposal_id, NOW);
      expect(applied?.status).toBe("applied");
      expect(loadCompanyEditProposals(root)).toHaveLength(2);
      expect(loadCompanyEditProposals(root).find((r) => r.proposal_id === rec.proposal_id)?.status).toBe("applied");
    });
  });

  it("agentGrowthStore:reconcileCitations 冷启动落基线(空)→ support 增长产出 citedDelta", () => {
    const root = mkRoot();
    const agents = [{ id: "dev-1", role: "dev", enabled: true }];
    // 不同 sourceRun 才累加 support(同 run 去重);与 agentGrowthStore.test 一致的对账场景。
    const skill = (runId: string) => upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: [runId], status: "candidate",
    }, NOW);
    run(() => {
      skill("run-a");
      expect(reconcileCitations(root, agents)).toEqual([]); // 冷启动:落基线,不追溯
      skill("run-b"); // support 1→2
      expect(reconcileCitations(root, agents)).toEqual([{ role: "dev", taskType: "coding", agentIds: ["dev-1"], citedDelta: 1, promoted: false }]);
    });
  });

  it("metaStore:后端无关 —— 两后端都从 meta.json 建/读,高版本拒开一致", () => {
    const root = mkRoot();
    run(() => {
      const meta = ensureStoreMeta(root);
      expect(meta.storeVersion).toBe(CURRENT_STORE_VERSION);
      fs.writeFileSync(path.join(root, ".opc", "meta.json"), JSON.stringify({ storeVersion: 999, createdAt: NOW }));
      expect(() => ensureStoreMeta(root)).toThrow(UnsupportedStoreVersionError);
    });
  });
});

// ───────────────── §二:sqlite 双写后 sqlite 读路径 == json 读路径(同一份数据)─────────────────
describe("§二 双写后两读路径等价(同一份数据)", () => {
  it("taskGraphStore", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      upsertTaskGraph(root, makeGraph({ id: "tg-1", missionId: "m1" }));
      upsertTaskGraph(root, makeGraph({ id: "tg-2", missionId: "m1", status: "running" }));
    });
    const viaSqlite = withBackend("sqlite", () => loadTaskGraphs(root));
    const viaJson = withBackend("json", () => loadTaskGraphs(root));
    expect(viaSqlite).toEqual(viaJson);
    // 双写落盘:JSON 文件与 SQLite 表逐条一致
    expect(readJSON(path.join(root, ".opc", "task-graphs.json"), [])).toEqual(readAllDocs(openBusinessDb(root), "task_graphs"));
  });

  it("memoryJobStore", () => {
    const root = mkRoot();
    let jobId = "";
    withBackend("sqlite", () => {
      jobId = createMemoryJob(root, { kind: "export", companyId: "c1" }, NOW).jobId;
      createMemoryJob(root, { kind: "import" }, NOW);
      updateMemoryJob(root, jobId, { status: "completed", result: { imported: 2 } }, NOW);
    });
    expect(withBackend("sqlite", () => loadMemoryJobs(root))).toEqual(withBackend("json", () => loadMemoryJobs(root)));
    expect(withBackend("sqlite", () => getMemoryJob(root, jobId))).toEqual(withBackend("json", () => getMemoryJob(root, jobId)));
  });

  it("governanceStore", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      recordGovernanceDecision(root, { runId: "run-a", level: "L3", reason: ["x"], inputs: govInputs, approvalRequired: true, approval: { status: "pending" } });
      recordGovernanceDecision(root, { runId: "run-b", level: "L1", reason: ["y"], inputs: govInputs });
      appendGovernanceEvent(root, "run-a", { kind: "approval_requested" });
    });
    expect(withBackend("sqlite", () => loadGovernanceRecords(root))).toEqual(withBackend("json", () => loadGovernanceRecords(root)));
    expect(readJSON(path.join(root, ".opc", "governance-records.json"), [])).toEqual(readAllDocs(openBusinessDb(root), "governance_records"));
  });

  it("chatThreadStore", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      appendTurns(root, "c1", "a1", [{ role: "user", content: "你好" }, { role: "assistant", content: "在" }], NOW);
      appendTurns(root, "c1", "a1", [{ role: "user", content: "继续" }], NOW);
    });
    expect(withBackend("sqlite", () => loadThread(root, "c1", "a1"))).toEqual(withBackend("json", () => loadThread(root, "c1", "a1")));
    // 单行 doc 落 SQLite:threadKey = 原始 companyId::agentId
    const doc = readDocByPk(openBusinessDb(root), "chat_threads", chatThreadId("c1", "a1")) as { turns: unknown[] };
    expect(doc.turns).toHaveLength(3);
  });

  it("companyEditProposalStore", () => {
    const root = mkRoot();
    let pid = "";
    withBackend("sqlite", () => {
      pid = saveCompanyEditProposal(root, { targetId: "t1", summary: "s", operations: ops, risks: [] }, NOW).proposal_id;
      saveCompanyEditProposal(root, { targetId: "t2", summary: "s2", operations: ops, risks: ["r"] }, NOW);
      markCompanyEditProposalApplied(root, pid, NOW);
    });
    expect(withBackend("sqlite", () => loadCompanyEditProposals(root))).toEqual(withBackend("json", () => loadCompanyEditProposals(root)));
  });

  it("agentGrowthStore 快照双写一致(growth-snapshot.json == growth_snapshots 表)", () => {
    const root = mkRoot();
    const agents = [{ id: "dev-1", role: "dev", enabled: true }];
    withBackend("sqlite", () => {
      upsertProceduralSkill(root, {
        role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"],
        producedArtifacts: [], antiPatterns: [], support: 2, successRate: 1, sourceRuns: ["r"], status: "candidate",
      }, NOW);
      reconcileCitations(root, agents); // 落基线(双写 snapshot)
    });
    const jsonSnap = readJSON(path.join(root, ".opc", "memory", "growth-snapshot.json"), null);
    const sqliteSnap = readDocByPk(openBusinessDb(root), "growth_snapshots", "growth-snapshot");
    expect(jsonSnap).toEqual(sqliteSnap);
  });
});

// ─────────────── §三:构造 canonical JSON → 迁移 → sqlite 读 == json 读 ───────────────
describe("§三 构造库迁移后两读路径等价", () => {
  it("taskGraphStore", () => {
    const root = mkRoot();
    wj(root, "task-graphs.json", [makeGraph({ id: "a", missionId: "m1" }), makeGraph({ id: "b", missionId: "m2" })]);
    const viaJson = withBackend("json", () => loadTaskGraphs(root));
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadTaskGraphs(root));
    expect(viaSqlite).toEqual(viaJson);
  });

  it("chatThreadStore(读侧有过滤:未知/损坏 turn 剔除)", () => {
    const root = mkRoot();
    wj(root, "chat-threads/c1__a1.json", {
      v: 1, companyId: "c1", agentId: "a1",
      turns: [{ role: "user", content: "hi", at: NOW }, { role: "assistant", content: "yo", at: NOW }],
    });
    const viaJson = withBackend("json", () => loadThread(root, "c1", "a1"));
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadThread(root, "c1", "a1"));
    expect(viaSqlite).toEqual(viaJson);
    expect(viaSqlite).toHaveLength(2);
  });

  it("companyEditProposalStore(读侧 schema 校验)", () => {
    const root = mkRoot();
    const rec = { proposal_id: "edit_prop_x1", targetId: "t1", summary: "s", operations: [], risks: [], requires_user_confirmation: true, status: "pending", createdAt: NOW };
    fs.mkdirSync(path.join(root, ".opc", "architect"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "architect", "company-edit-proposals.jsonl"), JSON.stringify(rec) + "\n", "utf-8");
    const viaJson = withBackend("json", () => loadCompanyEditProposals(root));
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadCompanyEditProposals(root));
    expect(viaSqlite).toEqual(viaJson);
    expect(viaSqlite).toHaveLength(1);
  });

  it("governanceStore", () => {
    const root = mkRoot();
    wj(root, "governance-records.json", [
      { runId: "r1", level: "L2", reason: ["w"], decidedAt: NOW, inputs: govInputs, events: [] },
    ]);
    const viaJson = withBackend("json", () => loadGovernanceRecords(root));
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadGovernanceRecords(root));
    expect(viaSqlite).toEqual(viaJson);
  });
});
