import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { closeAllDbs } from "./sqlite/db.js";
import { openBusinessDb, readAllDocs } from "./sqlite/docTableBackend.js";
import { readUnknownLines } from "./sqlite/sqliteToJson.js";
import { migrateJsonToSqlite } from "./sqlite/migrateJsonToSqlite.js";

import {
  addConclusionSummary, retrieveConclusionPoints, loadRegistry, removeMemoryRecordsByIds,
  upsertProceduralSkill, retrieveProceduralSkills, setReviewMode, listConclusionProposals,
  approveConclusionSummary, rejectConclusionSummary, upsertPlanTemplate, retrievePlanTemplate,
} from "./registryStore.js";
import {
  commitLesson, retrieveLessons, loadLessons, approveLesson, removeLessonsByIds, addManualLesson,
} from "./reflectionStore.js";
import { addMemory, queryMemory, bumpHitsByIds, listMemory, deleteMemory } from "./memoryStore.js";
import {
  loadInstallTransactions, recordInstallTransaction, getInstallTransaction,
  markInstallTransactionRolledBack, markInstallTransactionFailed, type InstallTransaction,
} from "./installTransactionStore.js";

// 战役B·Phase B2c 总验:冲突簇四 store(registry/reflection/memory/installTransaction)双后端等价。
// 目标 = 证明「只换底层 IO 原语,检索(D 已冻结)/结论/rollback(C 已冻结)业务逻辑零改」:
//   §一 参数化双后端:D 的检索/结论治理 + C 的 rollback 在 json 与 sqlite 各跑一遍,结果结构一致。
//   §二 双写后两读路径等价:sqlite 写一次(双写)后 sqlite 读 == json 读(同一份数据,规避随机 id/时间戳)。
//   §三 unknown 行保全:构造带损坏/未知 kind 的 JSONL → 迁移 → sqlite 读只回 valid(与 json 等价);
//        损坏/未知行进 unknown_lines 原样保全,写一次后仍在(registry/reflection 还 re-append 回 JSONL = 读回并回)。
// 绝不碰真实 .opc;全部临时目录构造库/副本。

const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "b2c-"));
  fs.mkdirSync(path.join(r, ".opc", "memory"), { recursive: true });
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
function wjsonl(root: string, rel: string, lines: string[]): void {
  const abs = path.join(root, ".opc", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
}
function unknownCount(root: string, source: string): number {
  return readUnknownLines(openBusinessDb(root), source).length;
}

const NOW = "2026-07-11T00:00:00.000Z";
const skillInput = (rid: string) => ({
  role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"],
  producedArtifacts: [".ts"], antiPatterns: [], support: 1, successRate: 1, sourceRuns: [rid], status: "candidate" as const,
});
const lessonInput = (over: Record<string, unknown> = {}) => ({
  kind: "failure_lesson" as const,
  scope: { role: "dev", companyId: "co1" },
  trigger: { eventTypes: [] as string[], failureMode: "timeout" as const, conditionText: "worker 单批过大超时" },
  diagnosis: "worker 单批任务过大导致超时",
  lesson: "把大任务拆成多个小批次分派",
  recommendedChange: "lead 拆分时单批不超过三个子任务",
  injection: { strength: "hint" as const, promptText: "拆分时单批不超过三个子任务,避免 worker 超时" },
  evidence: { runId: "run-b2c" },
  confidence: 0.9,
  ...over,
});
const mem = (over: Record<string, unknown> = {}) => ({
  agentRole: "dev", goalSlug: "", text: "用稳定库抓取", tags: ["爬虫"], source: { runId: "r1", agentId: "a1" }, ...over,
});
function txDraft(over: Partial<Omit<InstallTransaction, "txId" | "at" | "rolledBack" | "rolledBackAt" | "status">> = {}) {
  return {
    mode: "new-company" as const, source: "tpl-1", companyId: "co-1",
    created: { agentIds: ["a-1"], companyIds: ["co-1"], presetChannelKeys: [], skillIds: [] },
    agentSnapshots: [{ id: "a-1", name: "CEO", companyId: "co-1" }],
    conflictDecisions: [], safeInstallStripped: [], ...over,
  };
}

// ─────────────────────────── §一 参数化双后端行为等价 ───────────────────────────
const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("§一 冲突簇业务等价 [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("registryStore · D 检索:company 硬隔离 + minScore 过滤零相关(检索逻辑零改)", () => {
    const root = mkRoot();
    run(() => {
      addConclusionSummary(root, { runId: "r1", companyId: "company-A", goalSlug: "sort", points: ["A 的结论"], tags: ["sort"], createdAt: NOW });
      addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["通用结论"], tags: ["sort"], createdAt: NOW });
      addConclusionSummary(root, { runId: "r3", goalSlug: "http", points: ["最新但不相关"], tags: [], createdAt: "2026-07-05T00:00:00.000Z" });
      const isolated = retrieveConclusionPoints(root, { companyId: "company-B", goal: "写个 sort 报告" });
      expect(isolated).not.toContain("A 的结论");
      expect(isolated).not.toContain("通用结论"); // C12 gap#7:公司硬隔离后无归属通用结论也不注入(两后端同)
      // 无 companyId 调用点不隔离,通用结论仍返回(两后端等价的对照)。
      expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "写个 sort 报告" })).toContain("通用结论");
      const gated = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "写个排序报告", limit: 5, minScore: 1 });
      expect(gated).not.toContain("最新但不相关"); // D1:零相关不再靠 recency 兜底
    });
  });

  it("registryStore · procedural_skill support→verified + retrieve 只注入 verified(零改)", () => {
    const root = mkRoot();
    run(() => {
      upsertProceduralSkill(root, skillInput("r1"), NOW);
      upsertProceduralSkill(root, skillInput("r2"), NOW);
      expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding" }).length).toBe(0); // support=2 未 verified
      const s3 = upsertProceduralSkill(root, skillInput("r3"), NOW);
      expect(s3.support).toBe(3);
      expect(s3.status).toBe("verified");
      expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding" }).length).toBe(1);
      expect(loadRegistry(root).filter((r) => r.kind === "procedural_skill").length).toBe(1);
    });
  });

  it("registryStore · plan_template 按 company+taskType 隔离取用", () => {
    const root = mkRoot();
    run(() => {
      upsertPlanTemplate(root, { companyId: "c1", taskType: "report", split: ["调研", "撰写", "校对"], sourceRun: "r1" }, NOW);
      const t = retrievePlanTemplate(root, { companyId: "c1", taskType: "report" });
      expect(t?.workerCount).toBe(3);
      expect(retrievePlanTemplate(root, { companyId: "c2", taskType: "report" })).toBeNull(); // 他公司隔离
    });
  });

  it("registryStore · review-mode:pending→approve/reject 检索门(零改)", () => {
    const root = mkRoot();
    run(() => {
      setReviewMode(root, true);
      const r = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["待审核要点"], createdAt: NOW });
      expect(r!.status).toBe("pending");
      expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).not.toContain("待审核要点");
      expect(listConclusionProposals(root).length).toBe(1);
      approveConclusionSummary(root, r!.id);
      expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).toContain("待审核要点");
      const r2 = addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["会被拒"], createdAt: NOW });
      rejectConclusionSummary(root, r2!.id);
      expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).not.toContain("会被拒");
    });
  });

  it("registryStore · C rollback:removeMemoryRecordsByIds 硬删本次导入记录(零残留)", () => {
    const root = mkRoot();
    run(() => {
      const a = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["保留"], createdAt: NOW })!;
      const b = addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["回滚删除"], createdAt: NOW })!;
      expect(removeMemoryRecordsByIds(root, [b.id])).toBe(1);
      expect(loadRegistry(root).map((r) => r.id)).toEqual([a.id]);
      expect(removeMemoryRecordsByIds(root, ["no-such"])).toBe(0);
    });
  });

  it("reflectionStore · D 检索:低风险自动 committed + role 硬匹配/company 隔离(六态零改)", () => {
    const root = mkRoot();
    // lessonInput().evidence.runId=run-b2c 是干净成功 run:补 task.json(done/verified)。fail-closed 硬化后
    // 自动 committed 的 lesson(未标 sourceType、无 user/import lifecycle)按 run 证据要求判定,缺 task.json 会被排除;
    // 本用例测的是 role 硬匹配/company 隔离,不是 run 终态门。
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-b2c"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "runs", "run-b2c", "task.json"), JSON.stringify({ id: "run-b2c", status: "done", finalState: "verified" }));
    run(() => {
      const l = commitLesson(root, lessonInput(), NOW);
      expect(l?.status).toBe("committed");
      expect(retrieveLessons(root, { role: "dev", companyId: "co1" }).map((x) => x.id)).toEqual([l!.id]);
      expect(retrieveLessons(root, { role: "pm", companyId: "co1" })).toEqual([]);       // role 硬匹配
      expect(retrieveLessons(root, { role: "dev", companyId: "co2" })).toEqual([]);       // company 硬隔离
    });
  });

  it("reflectionStore · 高风险停 proposed → approveLesson 后可检索(生命周期零改)", () => {
    const root = mkRoot();
    run(() => {
      const l = commitLesson(root, lessonInput({ kind: "risk_warning" }), NOW); // 高风险 → proposed
      expect(l?.status).toBe("proposed");
      expect(retrieveLessons(root, { role: "dev", companyId: "co1" })).toEqual([]);
      approveLesson(root, l!.id, "user", NOW);
      expect(retrieveLessons(root, { role: "dev", companyId: "co1" }).map((x) => x.id)).toEqual([l!.id]);
    });
  });

  it("reflectionStore · C rollback:removeLessonsByIds 硬删(零改)", () => {
    const root = mkRoot();
    run(() => {
      const a = addManualLesson(root, { content: "手动经验一条足够长的内容", scope: { role: "dev" } }, NOW)!;
      const b = commitLesson(root, lessonInput({ evidence: { runId: "run-x" } }), NOW)!;
      expect(removeLessonsByIds(root, [b.id])).toBe(1);
      expect(loadLessons(root).map((l) => l.id)).toEqual([a.id]);
    });
  });

  it("memoryStore · D3 检索不 bump + bumpHitsByIds 验证后回写(自增强治理零回退)", () => {
    const root = mkRoot();
    run(() => {
      const e = addMemory(root, mem());
      const hit = queryMemory(root, { agentRole: "dev", goal: "帮我写爬虫抓取数据" });
      expect(hit.map((x) => x.id)).toEqual([e.id]);
      expect(listMemory(root, "dev").find((x) => x.id === e.id)!.hits).toBe(0); // 纯检索不 bump
      expect(bumpHitsByIds(root, [e.id])).toBe(1);
      expect(listMemory(root, "dev").find((x) => x.id === e.id)!.hits).toBe(1); // 验证后才 +1
      expect(bumpHitsByIds(root, ["no-such"])).toBe(0);
    });
  });

  it("memoryStore · role 不匹配排除 + deleteMemory", () => {
    const root = mkRoot();
    run(() => {
      addMemory(root, mem({ agentRole: "pm", text: "pm 记忆" }));
      const e = addMemory(root, mem({ text: "dev 记忆" }));
      expect(queryMemory(root, { agentRole: "dev", goal: "写爬虫" }).map((x) => x.id)).toEqual([e.id]);
      expect(deleteMemory(root, e.id)).toBe(true);
      expect(listMemory(root, "dev").some((x) => x.id === e.id)).toBe(false);
    });
  });

  it("installTransactionStore · 新在前 + status 机 + C rollback 标记(引用检查逻辑零改)", () => {
    const root = mkRoot();
    run(() => {
      const tx1 = recordInstallTransaction(root, txDraft({ source: "tpl-1" }));
      const tx2 = recordInstallTransaction(root, txDraft({ source: "tpl-2" }));
      expect(loadInstallTransactions(root).map((t) => t.txId)).toEqual([tx2.txId, tx1.txId]);
      expect(tx1.status).toBe("completed");
      expect(markInstallTransactionRolledBack(root, tx1.txId)?.status).toBe("rolled_back");
      expect(getInstallTransaction(root, tx1.txId)?.rolledBack).toBe(true);
      expect(markInstallTransactionFailed(root, tx2.txId)?.status).toBe("failed");
      expect(markInstallTransactionRolledBack(root, "no-such")).toBeUndefined();
    });
  });

  it("installTransactionStore · 上限 50 滚动淘汰", () => {
    const root = mkRoot();
    run(() => {
      for (let i = 0; i < 51; i++) recordInstallTransaction(root, txDraft({ source: `tpl-${i}` }));
      const all = loadInstallTransactions(root);
      expect(all.length).toBe(50);
      expect(all[0].source).toBe("tpl-50");
      expect(all.some((t) => t.source === "tpl-0")).toBe(false);
    });
  });
});

// ───────────────── §二 sqlite 双写后 sqlite 读 == json 读(同一份数据)─────────────────
describe("§二 双写后两读路径等价(同一份数据)", () => {
  it("registryStore(含 D 默认值归一)", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      addConclusionSummary(root, { runId: "r1", companyId: "c1", goalSlug: "sort", points: ["p1", "p2"], tags: ["排序"], createdAt: NOW });
      upsertProceduralSkill(root, skillInput("r1"), NOW);
      upsertPlanTemplate(root, { companyId: "c1", taskType: "report", split: ["a", "b"], sourceRun: "r1" }, NOW);
    });
    expect(withBackend("sqlite", () => loadRegistry(root))).toEqual(withBackend("json", () => loadRegistry(root)));
  });

  it("reflectionStore", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      commitLesson(root, lessonInput(), NOW);
      commitLesson(root, lessonInput({ scope: { role: "pm", companyId: "co2" }, evidence: { runId: "run-2" } }), NOW);
    });
    expect(withBackend("sqlite", () => loadLessons(root))).toEqual(withBackend("json", () => loadLessons(root)));
  });

  it("memoryStore(append + 全量重写两路径)", () => {
    const root = mkRoot();
    let id = "";
    withBackend("sqlite", () => {
      id = addMemory(root, mem()).id;
      addMemory(root, mem({ text: "第二条" }));
      bumpHitsByIds(root, [id]); // 全量重写
    });
    expect(withBackend("sqlite", () => listMemory(root))).toEqual(withBackend("json", () => listMemory(root)));
    // 落盘双写一致:project.jsonl 逐行 == memory_entries 表
    const fileEntries = fs.readFileSync(path.join(root, ".opc", "memory", "project.jsonl"), "utf-8")
      .trim().split("\n").map((l) => JSON.parse(l));
    expect(fileEntries).toEqual(readAllDocs(openBusinessDb(root), "memory_entries"));
  });

  it("installTransactionStore(install-transactions.json == install_transactions 表)", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      recordInstallTransaction(root, txDraft({ source: "tpl-1" }));
      recordInstallTransaction(root, txDraft({ source: "tpl-2" }));
    });
    expect(withBackend("sqlite", () => loadInstallTransactions(root))).toEqual(withBackend("json", () => loadInstallTransactions(root)));
    expect(JSON.parse(fs.readFileSync(path.join(root, ".opc", "install-transactions.json"), "utf-8")))
      .toEqual(readAllDocs(openBusinessDb(root), "install_transactions"));
  });
});

// ─────────────── §三 unknown 行保全(构造带损坏行的 JSONL 迁移后读回并回)───────────────
describe("§三 unknown 行原样保全 + 读回并回", () => {
  it("registryStore:损坏行 + 未知 kind → 迁移隔离进 unknown_lines;sqlite 读==json valid;写一次后保全且 re-append", () => {
    const root = mkRoot();
    const valid = { id: "concl-keep", kind: "conclusion_summary", runId: "r1", goalSlug: "sort", points: ["保留要点"], tags: ["sort"], createdAt: NOW, status: "approved" };
    const unknownKind = { id: "mystery-1", kind: "mystery_kind", note: "未来才有的 kind" };
    wjsonl(root, "memory/registry.jsonl", [JSON.stringify(valid), "{损坏行 not json", JSON.stringify(unknownKind)]);

    const viaJson = withBackend("json", () => loadRegistry(root)).map((r) => r.id);
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadRegistry(root)).map((r) => r.id);
    expect(viaSqlite).toEqual(viaJson);      // 两后端读 valid 一致(只 concl-keep)
    expect(viaSqlite).toEqual(["concl-keep"]);
    expect(unknownCount(root, "memory/registry.jsonl")).toBe(2); // 损坏 + 未知 kind 都进 unknown_lines

    withBackend("sqlite", () => addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["新增"], createdAt: NOW }));
    expect(unknownCount(root, "memory/registry.jsonl")).toBe(2); // 写后 unknown_lines 原样保全
    expect(readAllDocs(openBusinessDb(root), "memory_records").length).toBe(2); // 两条 valid 入表
    const fileRaw = fs.readFileSync(path.join(root, ".opc", "memory", "registry.jsonl"), "utf-8");
    expect(fileRaw).toContain("{损坏行 not json"); // 读回并回:未知行 re-append 进 JSONL
    expect(fileRaw).toContain("mystery-1");
  });

  it("reflectionStore:损坏行 + 未知 kind → 保全;sqlite 读==json valid;写一次后仍在", () => {
    const root = mkRoot();
    const valid = {
      id: "lesson-keep", schemaVersion: "reflection_lesson.v1", kind: "failure_lesson",
      scope: { role: "dev", companyId: "co1" }, trigger: { eventTypes: [], failureMode: "timeout", conditionText: "超时" },
      diagnosis: "d", lesson: "把大任务拆小批", recommendedChange: "单批不超三个", antiPattern: undefined,
      injection: { strength: "hint", promptText: "单批不超三个,避免超时" }, evidence: { runId: "run-1" },
      confidence: 0.9, status: "committed", version: 1, createdAt: NOW, updatedAt: NOW, hits: 0, ineffective: 0, support: 1,
    };
    const unknownKind = { id: "x-1", kind: "future_kind", foo: 1 };
    wjsonl(root, "memory/lessons.jsonl", [JSON.stringify(valid), "坏行}}}", JSON.stringify(unknownKind)]);

    const viaJson = withBackend("json", () => loadLessons(root)).map((l) => l.id);
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadLessons(root)).map((l) => l.id);
    expect(viaSqlite).toEqual(viaJson);
    expect(viaSqlite).toEqual(["lesson-keep"]);
    expect(unknownCount(root, "memory/lessons.jsonl")).toBe(2);

    withBackend("sqlite", () => commitLesson(root, lessonInput({ evidence: { runId: "run-9" } }), NOW));
    expect(unknownCount(root, "memory/lessons.jsonl")).toBe(2); // 保全
    const fileRaw = fs.readFileSync(path.join(root, ".opc", "memory", "lessons.jsonl"), "utf-8");
    expect(fileRaw).toContain("坏行}}}");   // 读回并回
    expect(fileRaw).toContain("future_kind");
  });

  it("memoryStore:损坏行 → 迁移进 unknown_lines 原样保全;sqlite 读全量不含损坏行(与 json 丢弃等价);全量重写后仍保全", () => {
    const root = mkRoot();
    const valid = { id: "m-keep", agentRole: "dev", goalSlug: "", text: "有效记忆", tags: ["爬虫"], source: { runId: "r1", agentId: "a1" }, createdAt: NOW, hits: 0 };
    wjsonl(root, "memory/project.jsonl", [JSON.stringify(valid), "{损坏 memory 行"]);

    const viaJson = withBackend("json", () => listMemory(root)).map((e) => e.id);
    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => listMemory(root)).map((e) => e.id);
    expect(viaSqlite).toEqual(viaJson); // json readJsonl 静默丢损坏行;sqlite 表只有 valid → 等价
    expect(viaSqlite).toEqual(["m-keep"]);
    expect(unknownCount(root, "memory/project.jsonl")).toBe(1); // 损坏行进 unknown_lines(比 json 更强的保全)

    withBackend("sqlite", () => bumpHitsByIds(root, ["m-keep"])); // 全量重写 memory_entries
    expect(unknownCount(root, "memory/project.jsonl")).toBe(1); // 全量重写不动 unknown_lines → 保全
    expect(readAllDocs(openBusinessDb(root), "memory_entries").length).toBe(1);
  });
});
