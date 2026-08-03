import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addConclusionSummary, upsertProceduralSkill, purgeCompanyMemory, listConclusionProposals, setReviewMode } from "./registryStore.js";
import { addManualLesson, loadLessons, purgeCompanyLessons } from "./reflectionStore.js";
import { addMemory, listMemory, purgeCompanyMemoryEntries } from "./memoryStore.js";

// 删除公司应级联清理其记忆——否则孤儿(尤其 pending 提案)永久污染审批队列。
describe("删除公司级联清理记忆(防孤儿 pending 提案)", () => {
  let root = "";
  const now = "2026-07-14T00:00:00.000Z";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-"));
    setReviewMode(root, true); // 让 conclusion 落 pending(模拟真实审批队列)
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it("purgeCompanyMemory 清 A 公司 conclusion+skill,B 公司完好", () => {
    addConclusionSummary(root, { companyId: "A", goalSlug: "g", points: ["pa"], createdAt: now });
    addConclusionSummary(root, { companyId: "B", goalSlug: "g", points: ["pb"], createdAt: now });
    upsertProceduralSkill(root, { companyId: "A", role: "dev", taskType: "code", preconditions: [], successfulSequence: ["x"], producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: ["r"], status: "proposed" }, now);
    // 删 A 前:A 的 conclusion 在 pending 队列
    expect(listConclusionProposals(root).some((p) => p.companyId === "A")).toBe(true);
    const r = purgeCompanyMemory(root, "A");
    expect(r.conclusions).toBe(1);
    expect(r.skills).toBe(1);
    // 删 A 后:队列里无 A,B 仍在
    expect(listConclusionProposals(root).some((p) => p.companyId === "A")).toBe(false);
    expect(listConclusionProposals(root).some((p) => p.companyId === "B")).toBe(true);
  });

  it("purgeCompanyLessons 清 A 公司教训,B 公司完好", () => {
    addManualLesson(root, { scope: { companyId: "A" }, content: "A 公司的一条失败教训内容(足够长)" }, now);
    addManualLesson(root, { scope: { companyId: "B" }, content: "B 公司的一条失败教训内容(足够长)" }, now);
    const removed = purgeCompanyLessons(root, "A");
    expect(removed).toBe(1);
    const rest = loadLessons(root);
    expect(rest.every((l) => l.scope.companyId !== "A")).toBe(true);
    expect(rest.some((l) => l.scope.companyId === "B")).toBe(true);
  });

  it("purgeCompanyMemoryEntries 清 A 公司 memory_entry,B 公司完好", () => {
    addMemory(root, { companyId: "A", agentRole: "dev", goalSlug: "g", text: "ma", tags: [], source: { runId: "", agentId: "", type: "manual" } });
    addMemory(root, { companyId: "B", agentRole: "dev", goalSlug: "g", text: "mb", tags: [], source: { runId: "", agentId: "", type: "manual" } });
    const removed = purgeCompanyMemoryEntries(root, "A");
    expect(removed).toBe(1);
    const rest = listMemory(root);
    expect(rest.every((e) => e.companyId !== "A")).toBe(true);
    expect(rest.some((e) => e.companyId === "B")).toBe(true);
  });

  it("删非默认公司不误伤 legacy 无归属记录(=default)", () => {
    // legacy 无 companyId 记录(写侧归一后=default)
    addMemory(root, { agentRole: "dev", goalSlug: "g", text: "legacy", tags: [], source: { runId: "", agentId: "", type: "manual" } });
    addMemory(root, { companyId: "A", agentRole: "dev", goalSlug: "g", text: "ma", tags: [], source: { runId: "", agentId: "", type: "manual" } });
    purgeCompanyMemoryEntries(root, "A");
    // 删 A 不动 legacy/default 记录
    expect(listMemory(root).some((e) => e.text === "legacy")).toBe(true);
  });
});
