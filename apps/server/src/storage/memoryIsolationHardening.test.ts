import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_COMPANY_ID } from "@opc/shared";
import { addMemory, queryMemory, listMemory } from "./memoryStore.js";
import {
  addConclusionSummary, retrieveConclusionPoints, upsertProceduralSkill, retrieveProceduralSkills, loadRegistry,
} from "./registryStore.js";
import { commitLesson, retrieveLessons, type FailureMode } from "./reflectionStore.js";

// 收口作战令二 · 记忆隔离彻底:legacy 隔离(令二.3)+ 失败/降级/simulated 源 run 不注入(令二.4)+
// 默认公司↔真实公司互不注入(令二.6)。全部用 store 原语活体驱动,不 mock。

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-iso-hard-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

function writeTask(runId: string, task: Record<string, unknown>): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task), "utf-8");
}
function writeRawJsonl(rel: string, objs: Record<string, unknown>[]): void {
  const f = path.join(root, ".opc", "memory", rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf-8");
}
function legacyLesson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `lesson-legacy-${Math.random().toString(36).slice(2, 8)}`,
    schemaVersion: "reflection_lesson.v1", kind: "failure_lesson",
    scope: { role: "dev", taskType: "coding" }, // 无 companyId 字段 = legacy
    trigger: { eventTypes: [], failureMode: "timeout", conditionText: "x" },
    diagnosis: "历史根因", lesson: "历史教训按来源拆分", recommendedChange: "按来源拆分并提前写盘",
    injection: { strength: "warning", promptText: "历史无归属教训:按来源拆小步" },
    evidence: { runId: "r-legacy" }, confidence: 0.9, status: "committed", version: 1,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", hits: 0, ineffective: 0, support: 1,
    ...over,
  };
}
const NOW = "2026-07-02T00:00:00.000Z";
const GOAL = "写一个爬虫并限速";

describe("令二.1 · 唯一 normalizeCompanyId 纯函数契约", () => {
  it("非空 trim;缺省(undefined/null/空白)→ DEFAULT_COMPANY_ID('default')", async () => {
    const { normalizeCompanyId } = await import("@opc/shared");
    expect(normalizeCompanyId("co-A")).toBe("co-A");
    expect(normalizeCompanyId("  co-B  ")).toBe("co-B");
    expect(normalizeCompanyId(undefined)).toBe(DEFAULT_COMPANY_ID);
    expect(normalizeCompanyId(null)).toBe(DEFAULT_COMPANY_ID);
    expect(normalizeCompanyId("")).toBe(DEFAULT_COMPANY_ID);
    expect(normalizeCompanyId("   ")).toBe(DEFAULT_COMPANY_ID);
    expect(DEFAULT_COMPANY_ID).toBe("default");
  });
});

describe("令二.2/二.3 · 写侧默认归属 + legacy 隔离(DEFAULT 公司 query 不返回 legacy)", () => {
  it("memory_entry:新写入缺省落 default;raw-file legacy(无字段)对 DEFAULT 公司 query 不返回,对无作用域 query 返回", () => {
    // 新写入无 companyId → 落 default
    addMemory(root, { agentRole: "dev", goalSlug: "写一个爬虫并限速", text: "限速否则触发反爬", tags: ["爬虫", "限速"], source: { runId: "r1", agentId: "a1" } });
    const stored = listMemory(root)[0] as { companyId?: string };
    expect(stored.companyId).toBe(DEFAULT_COMPANY_ID);
    // DEFAULT 公司 query 命中新写入(它就是 default)
    expect(queryMemory(root, { agentRole: "dev", companyId: DEFAULT_COMPANY_ID, goal: GOAL }).length).toBe(1);

    // 追加一条 raw-file legacy(无 companyId 字段)
    writeRawJsonl("project.jsonl", [
      { id: "leg", agentRole: "dev", goalSlug: "写一个爬虫并限速", text: "legacy 无归属经验", tags: ["爬虫", "限速"], source: { runId: "r-leg", agentId: "a1" }, createdAt: NOW, hits: 0 },
    ]);
    // 关键:DEFAULT 公司 query 绝不返回 legacy(防 normalize 误伤把无字段记录归为默认公司)
    const forDefault = queryMemory(root, { agentRole: "dev", companyId: DEFAULT_COMPANY_ID, goal: GOAL });
    expect(forDefault.some((m) => m.id === "leg")).toBe(false);
    // Injection queries fail closed for unproven legacy run records; list view remains auditable.
    expect(queryMemory(root, { agentRole: "dev", goal: GOAL }).some((m) => m.id === "leg")).toBe(false);
    expect(listMemory(root).some((m) => m.id === "leg")).toBe(true);
  });

  it("conclusion_summary:新写入缺省落 default;legacy 对 DEFAULT 公司 query 不注入", () => {
    addConclusionSummary(root, { runId: "r-clean", goalSlug: "sort", points: ["default 结论"], tags: ["sort"], createdAt: NOW });
    expect((loadRegistry(root)[0] as { companyId?: string }).companyId).toBe(DEFAULT_COMPANY_ID);
    writeRawJsonl("registry.jsonl", [
      { id: "concl-leg", kind: "conclusion_summary", runId: "r-leg", goalSlug: "sort", points: ["legacy 结论"], tags: ["sort"], createdAt: NOW, status: "approved" }, // 无 companyId
    ]);
    const forDefault = retrieveConclusionPoints(root, { companyId: DEFAULT_COMPANY_ID, goal: "写个 sort 报告" });
    expect(forDefault).not.toContain("legacy 结论");
    // Missing local run evidence is quarantined even without a company filter.
    expect(retrieveConclusionPoints(root, { goal: "写个 sort 报告" })).not.toContain("legacy 结论");
  });

  it("lesson:新写入缺省落 default;legacy(scope 无 companyId)对 DEFAULT 公司 query 不注入", () => {
    writeRawJsonl("lessons.jsonl", [legacyLesson()]);
    const forDefault = retrieveLessons(root, { role: "dev", taskType: "coding", companyId: DEFAULT_COMPANY_ID });
    expect(forDefault.length).toBe(0); // legacy 不注入 default 公司
    const forNone = retrieveLessons(root, { role: "dev", taskType: "coding" });
    expect(forNone.length).toBe(0); // unproven legacy run evidence stays quarantined
  });

  it("procedural_skill:legacy(无 companyId)对 DEFAULT 公司 query 不注入", () => {
    writeRawJsonl("registry.jsonl", [
      { id: "skill-leg", kind: "procedural_skill", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r-leg"], status: "verified", createdAt: NOW, updatedAt: NOW }, // 无 companyId
    ]);
    expect(retrieveProceduralSkills(root, { role: "dev", companyId: DEFAULT_COMPANY_ID, taskType: "coding", limit: 5 }).length).toBe(0);
    expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding", limit: 5 }).length).toBe(0); // missing local evidence fails closed
  });
});

describe("令二.4 · 失败/降级/simulated 源 run 的记忆永不注入(全注入路径负向)", () => {
  for (const bad of [{ status: "failed" }, { status: "done", degraded: true }, { simulated: true }] as Record<string, unknown>[]) {
    const label = JSON.stringify(bad);
    it(`lesson:源 run ${label} → 不注入`, () => {
      writeTask("r-bad", { id: "r-bad", ...bad });
      commitLesson(root, {
        kind: "failure_lesson", scope: { companyId: "co-A", role: "dev", taskType: "coding" },
        trigger: { eventTypes: [], failureMode: "timeout" as FailureMode, conditionText: "核查超时了一次" },
        diagnosis: "一次吃全部来源导致超时", lesson: "按来源拆分核查", recommendedChange: "每子任务限单来源写盘",
        injection: { strength: "warning", promptText: "上次超时这次按来源拆小步" }, evidence: { runId: "r-bad", agentId: "w1" }, confidence: 0.9,
      }, NOW);
      // 即便被人工/自动 committed,注入侧仍按源 run 终态兜底隔离
      const got = retrieveLessons(root, { role: "dev", companyId: "co-A", taskType: "coding" });
      expect(got.length).toBe(0);
    });
    it(`conclusion:源 run ${label} → 不注入`, () => {
      writeTask("r-bad", { id: "r-bad", ...bad });
      addConclusionSummary(root, { runId: "r-bad", companyId: "co-A", goalSlug: "sort", points: ["失败run结论"], tags: ["sort"], createdAt: NOW, status: "approved" });
      writeTask("r-ok", { id: "r-ok", status: "done" });
      addConclusionSummary(root, { runId: "r-ok", companyId: "co-A", goalSlug: "sort", points: ["干净run结论"], tags: ["sort"], createdAt: NOW, status: "approved" });
      const pts = retrieveConclusionPoints(root, { companyId: "co-A", goal: "写个 sort 报告" });
      expect(pts).not.toContain("失败run结论");
      expect(pts).toContain("干净run结论");
    });
    it(`procedural_skill:全部来源 run ${label} → 不注入;有干净来源 → 注入`, () => {
      writeTask("rb1", { id: "rb1", ...bad });
      writeTask("rb2", { id: "rb2", ...bad });
      writeTask("rb3", { id: "rb3", ...bad });
      upsertProceduralSkill(root, { companyId: "co-A", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["rb1", "rb2", "rb3"], status: "verified" }, NOW);
      expect(retrieveProceduralSkills(root, { role: "dev", companyId: "co-A", taskType: "coding", limit: 5 }).length).toBe(0);
      // 有一个干净来源就应保留(clean run 验证过该序列)
      writeTask("rok", { id: "rok", status: "done" });
      upsertProceduralSkill(root, { companyId: "co-B", role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["rb1", "rok"], status: "verified" }, NOW);
      expect(retrieveProceduralSkills(root, { role: "dev", companyId: "co-B", taskType: "coding", limit: 5 }).length).toBe(1);
    });
  }
});

describe("令二.6 · 默认公司↔真实公司互不注入(负向矩阵)", () => {
  it("memory_entry:default 与真实公司互不注入;A/B 各自成条", () => {
    addMemory(root, { agentRole: "dev", companyId: "co-A", goalSlug: "写一个爬虫并限速", text: "A 经验", tags: ["爬虫", "限速"], source: { runId: "ra", agentId: "a1" } });
    addMemory(root, { agentRole: "dev", companyId: "co-B", goalSlug: "写一个爬虫并限速", text: "B 经验", tags: ["爬虫", "限速"], source: { runId: "rb", agentId: "a1" } });
    addMemory(root, { agentRole: "dev", goalSlug: "写一个爬虫并限速", text: "default 经验", tags: ["爬虫", "限速"], source: { runId: "rd", agentId: "a1" } });
    expect(listMemory(root).length).toBe(3);
    const a = queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL });
    expect(a.map((m) => m.text)).toEqual(["A 经验"]);
    const d = queryMemory(root, { agentRole: "dev", companyId: DEFAULT_COMPANY_ID, goal: GOAL });
    expect(d.map((m) => m.text)).toEqual(["default 经验"]);
    writeTask("ra", { id: "ra", status: "done" });
    writeTask("rb", { id: "rb", status: "done" });
    writeTask("rd", { id: "rd", status: "done" });
    // 真实公司查询绝不含 default 经验;default 查询绝不含真实公司经验
    expect(queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL }).some((m) => m.text === "default 经验")).toBe(false);
    expect(queryMemory(root, { agentRole: "dev", companyId: DEFAULT_COMPANY_ID, goal: GOAL }).some((m) => m.text === "A 经验")).toBe(false);
  });
});
