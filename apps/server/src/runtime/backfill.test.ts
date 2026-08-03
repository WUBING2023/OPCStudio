import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { backfillLessons } from "./backfill.js";
import { loadLessons } from "../storage/reflectionStore.js";
import { listGovernedMemoryProposals } from "./memoryGovernance.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "bf-")); });

function makeRun(r: string, runId: string, deferred: unknown[], task: unknown) {
  const rd = path.join(r, ".opc", "runs", runId);
  fs.mkdirSync(rd, { recursive: true });
  fs.writeFileSync(path.join(rd, "deferred.json"), JSON.stringify(deferred));
  fs.writeFileSync(path.join(rd, "task.json"), JSON.stringify(task));
}

const LESSON = JSON.stringify([{ role: "test", conditionText: "x", diagnosis: "一次核查全部来源超时", lesson: "按来源拆分核查", recommendedChange: "每子任务限单来源并提前写 partial", promptText: "上次核查超时,这次按来源拆小步", confidence: 0.7 }]);

describe("P4 · backfill(历史回填)", () => {
  it("只处理有失败信号的 run,补出 lesson,并标记已处理(重复调用不再花 deepseek)", async () => {
    makeRun(root, "run-1", [{ agentId: "rp-factcheck", reason: "timeout", attempts: 1, lastError: "timeout after 200000ms" }], { userGoal: "多来源核查报告", degraded: false }); // task.json 用 userGoal
    makeRun(root, "run-2", [], { userGoal: "顺利的 run", degraded: false }); // 无失败信号 → 跳过

    let calls = 0;
    const r = await backfillLessons({ projectRoot: root, callModel: async () => { calls++; return LESSON; }, roleOf: (id) => (id === "rp-factcheck" ? "test" : undefined), nowIso: "2026-07-02T00:00:00.000Z" });
    expect(r.processed).toBe(1); // 只有 run-1 有失败信号
    expect(r.lessons).toBe(1);
    expect(calls).toBe(1);
    expect(loadLessons(root).length).toBe(0);
    expect(listGovernedMemoryProposals(root, "proposed")).toHaveLength(1);

    // 再跑:run-1 已标记 → 不再处理、不再调用模型
    let calls2 = 0;
    const r2 = await backfillLessons({ projectRoot: root, callModel: async () => { calls2++; return LESSON; }, roleOf: () => "test", nowIso: "2026-07-02T00:00:00.000Z" });
    expect(r2.processed).toBe(0);
    expect(calls2).toBe(0);
  });

  it("[fix7] 模型不可用(返回空)→ 不标记 done,下次可重试(教训不丢失)", async () => {
    makeRun(root, "run-1", [{ agentId: "rp-factcheck", reason: "timeout", attempts: 1, lastError: "x" }], { userGoal: "g", degraded: false });
    const r1 = await backfillLessons({ projectRoot: root, callModel: async () => "", roleOf: () => "test", nowIso: "2026-07-02T00:00:00.000Z" });
    expect(r1.lessons).toBe(0);
    let calls = 0;
    const r2 = await backfillLessons({ projectRoot: root, callModel: async () => { calls++; return LESSON; }, roleOf: () => "test", nowIso: "2026-07-02T00:00:00.000Z" });
    expect(calls).toBe(1); // run-1 未被标记 done → 重试
    expect(r2.lessons).toBe(1);
  });

  it("无 runs 目录 → 安全返回空", async () => {
    const r = await backfillLessons({ projectRoot: root, callModel: async () => LESSON, roleOf: () => "test", nowIso: "2026-07-02T00:00:00.000Z" });
    expect(r).toEqual({ processed: 0, lessons: 0, skipped: 0 });
  });
});
