// A1-V2 · 记忆提案三态审核流:高低风险分流 / 走账完整记录 / memory_proposals.json 台账 / 新旧状态兼容读取。
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  isHighRiskMemoryContent, assessLessonRisk, isAutoApprovable,
  commitLesson, loadLessons, retrieveLessons, approveLesson, rejectLesson,
  type FailureMode,
} from "../storage/reflectionStore.js";
import { loadMemoryProposals, upsertMemoryProposals, type RunMemoryProposalRecord } from "../storage/projectStore.js";

const NOW = "2026-07-07T00:00:00.000Z";
const RUN_ID = "aabf097d";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memflow-"));
  // 提案的 evidence.runId=RUN_ID 是一个干净成功 run:补 task.json(done/verified),否则 fail-closed 硬化后
  // 该 run 无 task.json → 检索侧按 run 证据要求排除,已 committed/approved 的 lesson 也检索不到。
  const runDir = path.join(root, ".opc", "runs", RUN_ID);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "task.json"), JSON.stringify({ id: RUN_ID, status: "done", finalState: "verified" }));
});

// 同 reflectionMemory.test.ts 的 validInput,内容刻意不含高风险关键词。
const validInput = (): Parameters<typeof commitLesson>[1] => ({
  kind: "failure_lesson" as const,
  scope: { companyId: "research-pro", teamId: "rp-lead", role: "test", agentId: "rp-factcheck", taskType: "fact_check" },
  trigger: { eventTypes: ["worker_timeout"], failureMode: "timeout" as FailureMode, conditionText: "多来源核查一次调用超 200s" },
  diagnosis: "核查任务一次吃下全部来源,单次调用过大",
  lesson: "多来源核查应按来源拆分,不要一次核查全部",
  recommendedChange: "每子任务限 3-5 条 claim 或单来源;超时前先写 partial.md",
  injection: { strength: "warning" as const, promptText: "上次多来源核查一次调用超时,这次按来源拆小步并提前写 partial" },
  evidence: { runId: RUN_ID, agentId: "rp-factcheck", metrics: { timeoutMs: 200000, deferredCount: 1 } },
  confidence: 0.7,
});

// ── 高低风险判定(独立可测) ───────────────────────────────────────────────────

describe("isHighRiskMemoryContent — 关键词四类", () => {
  it("权限类命中", () => {
    expect(isHighRiskMemoryContent("给该角色开放文件写权限")).toBe(true);
    expect(isHighRiskMemoryContent("use sudo to install")).toBe(true);
  });
  it("删除类命中", () => {
    expect(isHighRiskMemoryContent("先删除旧目录再重建")).toBe(true);
    expect(isHighRiskMemoryContent("run rm -rf on the workdir")).toBe(true);
  });
  it("shell/命令执行类命中", () => {
    expect(isHighRiskMemoryContent("直接在 shell 里跑脚本更快")).toBe(true);
    expect(isHighRiskMemoryContent("use powershell to batch it")).toBe(true);
  });
  it("密钥凭证类命中", () => {
    expect(isHighRiskMemoryContent("把密钥写进环境变量")).toBe(true);
    expect(isHighRiskMemoryContent("rotate the api key monthly")).toBe(true);
    expect(isHighRiskMemoryContent("cache the bearer token")).toBe(true);
  });
  it("普通内容不命中;英文词界防误伤(confirm/model/token 消耗)", () => {
    expect(isHighRiskMemoryContent("多来源核查应按来源拆分,不要一次核查全部")).toBe(false);
    expect(isHighRiskMemoryContent("please confirm the model output")).toBe(false); // rm/del 不误伤
    expect(isHighRiskMemoryContent("减少单次 token 消耗,拆小批量")).toBe(false);     // 非凭证语境 token 不拦
    expect(isHighRiskMemoryContent("")).toBe(false);
  });
});

describe("assessLessonRisk — lesson 高风险三条件", () => {
  it("kind=policy_candidate → 高风险(维持现状)", () => {
    const l = validInput(); l.kind = "policy_candidate";
    expect(assessLessonRisk(l)).toMatchObject({ high: true, reasons: ["policy_candidate"] });
  });
  it("injection.strength=policy_candidate → 高风险", () => {
    const l = validInput(); l.injection.strength = "policy_candidate";
    expect(assessLessonRisk(l).high).toBe(true);
  });
  it("kind=risk_warning → 高风险(A1-V2 新增)", () => {
    const l = validInput(); l.kind = "risk_warning";
    expect(assessLessonRisk(l)).toMatchObject({ high: true, reasons: ["risk_warning"] });
  });
  it("内容命中关键词 → 高风险(reason=content_keyword)", () => {
    const l = validInput(); l.recommendedChange = "先删除临时产物目录再重跑,避免残留干扰";
    expect(assessLessonRisk(l)).toMatchObject({ high: true, reasons: ["content_keyword"] });
  });
  it("promptText(真正被注入的字段)命中也算", () => {
    const l = validInput(); l.injection.promptText = "下次先在 shell 里验证脚本再交付";
    expect(assessLessonRisk(l).high).toBe(true);
  });
  it("低风险 → isAutoApprovable=true", () => {
    expect(assessLessonRisk(validInput())).toEqual({ high: false, reasons: [] });
    expect(isAutoApprovable(validInput())).toBe(true);
  });
});

// ── commitLesson 分流 + 走账 ─────────────────────────────────────────────────

describe("commitLesson — 高低风险分流与 lifecycle 走账", () => {
  it("低风险:自动批准但完整走账 proposed→approved→committed,approvedBy=auto", () => {
    const r = commitLesson(root, validInput(), NOW)!;
    expect(r.status).toBe("committed");
    expect(r.approvedBy).toBe("auto");
    expect(r.lifecycle?.map((e) => e.status)).toEqual(["proposed", "approved", "committed"]);
    expect(r.lifecycle?.[1]).toMatchObject({ by: "auto", at: NOW });
  });

  it("高风险(risk_warning):停 proposed 等人工审批,不被检索注入", () => {
    const l = validInput(); l.kind = "risk_warning";
    const r = commitLesson(root, l, NOW)!;
    expect(r.status).toBe("proposed");
    expect(r.approvedBy).toBeUndefined();
    expect(r.lifecycle?.map((e) => e.status)).toEqual(["proposed"]);
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
  });

  it("高风险(内容关键词):同样停 proposed", () => {
    const l = validInput(); l.recommendedChange = "重跑前先删除 workdir 里的残留产物";
    expect(commitLesson(root, l, NOW)!.status).toBe("proposed");
  });

  it("版本化更新也走账:低风险复现 → lifecycle 追加 approved/committed", () => {
    commitLesson(root, validInput(), NOW);
    const again = validInput(); again.confidence = 0.9;
    const r2 = commitLesson(root, again, "2026-07-08T00:00:00.000Z")!;
    expect(r2.version).toBe(2);
    const statuses = r2.lifecycle!.map((e) => e.status);
    expect(statuses.slice(0, 3)).toEqual(["proposed", "approved", "committed"]); // v1 的账保留
    expect(statuses.slice(3)).toEqual(["approved", "committed"]);                // v2 追加
  });
});

// ── memory_proposals.json 台账 ────────────────────────────────────────────────

describe("memory_proposals.json — run 目录台账", () => {
  it("commitLesson 按 evidence.runId 落台账:低风险记 committed,高风险记 pending", () => {
    commitLesson(root, validInput(), NOW);
    const high = validInput(); high.kind = "risk_warning"; high.diagnosis = "另一条根因,避免 dedupe 合并";
    commitLesson(root, high, NOW);
    const records = loadMemoryProposals(root, RUN_ID);
    expect(records).toHaveLength(2);
    const low = records.find((r) => r.risk === "low")!;
    expect(low).toMatchObject({ source: "reflection_lesson", status: "committed", kind: "failure_lesson" });
    expect(low.statusHistory.map((h) => h.status)).toEqual(["pending", "approved", "committed"]);
    const hi = records.find((r) => r.risk === "high")!;
    expect(hi).toMatchObject({ status: "pending", kind: "risk_warning", riskReasons: ["risk_warning"] });
  });

  it("upsertMemoryProposals 按 proposalId 合并,不整文件覆盖(异步 lesson 与 run_conclusion 共存)", () => {
    const base = { runId: RUN_ID, source: "run_conclusion" as const, content: "c", risk: "low" as const, status: "committed", statusHistory: [], createdAt: NOW, updatedAt: NOW };
    upsertMemoryProposals(root, RUN_ID, [{ ...base, proposalId: "prop-1" }]);
    upsertMemoryProposals(root, RUN_ID, [{ ...base, proposalId: "prop-2", source: "reflection_lesson", status: "pending" }]);
    upsertMemoryProposals(root, RUN_ID, [{ ...base, proposalId: "prop-2", source: "reflection_lesson", status: "committed" }]); // 状态更新
    const records = loadMemoryProposals(root, RUN_ID);
    expect(records).toHaveLength(2);
    expect(records.find((r) => r.proposalId === "prop-2")?.status).toBe("committed");
    // 显式 utf-8 落盘、合法 JSON
    const raw = fs.readFileSync(path.join(root, ".opc", "runs", RUN_ID, "memory_proposals.json"), "utf-8");
    expect(JSON.parse(raw)).toHaveLength(2);
  });

  it("审批后台账同步:approveLesson 把台账记录推到 committed", () => {
    const l = validInput(); l.kind = "risk_warning";
    const saved = commitLesson(root, l, NOW)!;
    approveLesson(root, saved.id, "human", "2026-07-08T00:00:00.000Z");
    const rec = loadMemoryProposals(root, RUN_ID).find((r) => r.proposalId === saved.id)!;
    expect(rec.status).toBe("committed");
    expect(rec.statusHistory.at(-1)).toMatchObject({ status: "committed", by: "human" });
  });
});

// ── 人工审批(approveLesson / rejectLesson) ──────────────────────────────────

describe("approveLesson / rejectLesson — pending 提案人工裁决", () => {
  const highRisk = () => { const l = validInput(); l.kind = "risk_warning" as const; return l; };

  it("approve:proposed → committed,可被检索注入,lifecycle 记 approved→committed by human", () => {
    const saved = commitLesson(root, highRisk(), NOW)!;
    const approved = approveLesson(root, saved.id, "human", "2026-07-08T00:00:00.000Z")!;
    expect(approved.status).toBe("committed");
    expect(approved.approvedBy).toBe("human");
    expect(approved.lifecycle!.map((e) => e.status)).toEqual(["proposed", "approved", "committed"]);
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(1);
  });

  it("reject:proposed → revoked 终态,不注入;同 dedupeKey 复现不复活", () => {
    const saved = commitLesson(root, highRisk(), NOW)!;
    const rejected = rejectLesson(root, saved.id, "human", "2026-07-08T00:00:00.000Z")!;
    expect(rejected.status).toBe("revoked");
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
    const again = commitLesson(root, highRisk(), "2026-07-09T00:00:00.000Z");
    expect(again?.status).toBe("revoked"); // 终态不复活
  });

  it("非 proposed(已 committed / 不存在)→ null", () => {
    const committed = commitLesson(root, validInput(), NOW)!; // 低风险已自动 committed
    expect(approveLesson(root, committed.id, "human", NOW)).toBeNull();
    expect(rejectLesson(root, committed.id, "human", NOW)).toBeNull();
    expect(approveLesson(root, "lesson-nope", "human", NOW)).toBeNull();
  });
});

// ── 新旧状态兼容读取 ─────────────────────────────────────────────────────────

describe("兼容读取 — 旧四态数据与新六态并存", () => {
  const lessonsFile = () => path.join(root, ".opc", "memory", "lessons.jsonl");

  const rawLesson = (over: Record<string, unknown>) => JSON.stringify({
    id: `lesson-${Math.random().toString(36).slice(2, 10)}`,
    schemaVersion: "reflection_lesson.v1",
    kind: "failure_lesson",
    scope: { role: "test", taskType: "fact_check" },
    trigger: { eventTypes: [], failureMode: "timeout", conditionText: "x" },
    diagnosis: "d", lesson: "按来源拆分核查任务", recommendedChange: "按来源拆分并提前写 partial",
    injection: { strength: "warning", promptText: "按来源拆小步" },
    evidence: { runId: RUN_ID },
    confidence: 0.8, status: "committed", version: 1,
    createdAt: NOW, updatedAt: NOW, hits: 0, ineffective: 0, support: 1,
    ...over,
  });

  it("旧数据(无 lifecycle/approvedBy)照常解析,且 committed 仍可检索", () => {
    fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
    fs.writeFileSync(lessonsFile(), rawLesson({}) + "\n", "utf-8");
    const all = loadLessons(root);
    expect(all).toHaveLength(1);
    expect(all[0].lifecycle).toBeUndefined();
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(1);
  });

  it("新状态 approved / deprecated 的行能读取,但检索(只取 committed)不注入", () => {
    fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
    fs.writeFileSync(lessonsFile(), [
      rawLesson({ status: "approved" }),
      rawLesson({ status: "deprecated", diagnosis: "d2" }),
    ].join("\n") + "\n", "utf-8");
    const all = loadLessons(root);
    expect(all.map((l) => l.status).sort()).toEqual(["approved", "deprecated"]);
    expect(retrieveLessons(root, { role: "test", taskType: "fact_check" }).length).toBe(0);
  });

  it("旧四态全部仍是合法值(proposed/committed/revoked/superseded)", () => {
    fs.mkdirSync(path.dirname(lessonsFile()), { recursive: true });
    fs.writeFileSync(lessonsFile(), [
      rawLesson({ status: "proposed" }),
      rawLesson({ status: "committed", diagnosis: "d2" }),
      rawLesson({ status: "revoked", diagnosis: "d3" }),
      rawLesson({ status: "superseded", diagnosis: "d4" }),
    ].join("\n") + "\n", "utf-8");
    expect(loadLessons(root)).toHaveLength(4);
  });
});

// ── 台账记录类型完整性(给 UI 的磁盘证据字段) ────────────────────────────────

describe("RunMemoryProposalRecord — 台账字段", () => {
  it("lesson 台账记录带 provenance(role/agentId/confidence/memoryId)", () => {
    commitLesson(root, validInput(), NOW);
    const rec: RunMemoryProposalRecord = loadMemoryProposals(root, RUN_ID)[0];
    expect(rec).toMatchObject({
      source: "reflection_lesson",
      role: "test",
      agentId: "rp-factcheck",
      confidence: 0.7,
      runId: RUN_ID,
    });
    expect(rec.memoryId).toBe(rec.proposalId); // lesson 的 memoryId 即 lesson id
    expect(rec.content.length).toBeGreaterThan(0);
  });
});
