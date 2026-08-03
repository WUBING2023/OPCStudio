import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exportMemoryRecordsForCompany } from "./memoryBundle.js";
import { addConclusionSummary, upsertProceduralSkill } from "../storage/registryStore.js";
import { addManualLesson } from "../storage/reflectionStore.js";

// ════════════════════════════════════════════════════════════════════════════
// 波4b·泳道B·gap①(用户令)· 无归属记忆不随公司导出。
//   memoryBundle.exportMemoryRecordsForCompany 导出侧核查:无 companyId 的历史记录(conclusion /
//   procedural_skill / lesson 各层)绝不打进公司包(隔离 legacy_global,默认不外泄);只带
//   companyId===本公司 的记录。读侧兼容两态(有/无 companyId 字段)——无字段 = undefined ≠ 本公司 id → 跳过。
//   与泳道A并行:泳道A在记忆 schema 加 companyId 归属;本测试只锁导出过滤逻辑的隔离行为。
// ════════════════════════════════════════════════════════════════════════════
describe("gap① · exportMemoryRecordsForCompany 只带本公司归属记忆,无归属记录一律跳过", () => {
  let root: string;
  const NOW = "2026-07-13T00:00:00.000Z";
  const CO = "co-owned";

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "gap1-mem-export-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  it("conclusion_summary:归属本公司的导出,无 companyId 的历史记录被跳过", () => {
    addConclusionSummary(root, { runId: "r1", companyId: CO, points: ["本公司结论"], createdAt: NOW });
    addConclusionSummary(root, { runId: "r2", points: ["无归属历史结论(不得外泄)"], createdAt: NOW }); // 无 companyId
    addConclusionSummary(root, { runId: "r3", companyId: "co-other", points: ["别家公司结论"], createdAt: NOW });

    const out = exportMemoryRecordsForCompany(root, CO, ["dev"]);
    const contents = out.map((r) => r.content);
    expect(contents).toContain("本公司结论");
    expect(contents.some((c) => c.includes("无归属历史结论"))).toBe(false); // gap① 核心:无归属跳过
    expect(contents.some((c) => c.includes("别家公司"))).toBe(false);
  });

  it("procedural_skill:无 companyId 的历史技能(即便 role 匹配)不随公司导出", () => {
    // 达 sop/verified 才会映射进 bundle(support>=3 且 verified)——喂足 3 个不同 run。
    for (const co of [CO, undefined]) {
      for (const rid of ["a", "b", "c"]) {
        upsertProceduralSkill(root, {
          companyId: co, role: "dev", taskType: "build",
          preconditions: [], successfulSequence: [co ? "本公司技能步骤" : "无归属技能步骤"],
          producedArtifacts: [], antiPatterns: [],
          support: 1, successRate: 1, sourceRuns: [`${co ?? "none"}-${rid}`], status: "verified",
        } as any, NOW);
      }
    }
    const out = exportMemoryRecordsForCompany(root, CO, ["dev"]);
    const contents = out.map((r) => r.content).join(" | ");
    expect(contents).toContain("本公司技能步骤");
    expect(contents).not.toContain("无归属技能步骤"); // gap① 核心:role 匹配但无归属 → 不导出
  });

  it("lesson:无 companyId 的历史教训不随公司导出(去掉旧「无归属→按 role 回退」的泄漏口)", () => {
    addManualLesson(root, { content: "本公司的教训记录条目", scope: { companyId: CO, role: "dev" }, tags: [], savedBy: "import" }, NOW);
    addManualLesson(root, { content: "无归属历史教训(不得外泄)", scope: { role: "dev" }, tags: [], savedBy: "import" }, NOW);

    const out = exportMemoryRecordsForCompany(root, CO, ["dev"]);
    const contents = out.map((r) => r.content);
    expect(contents).toContain("本公司的教训记录条目");
    expect(contents.some((c) => c.includes("无归属历史教训"))).toBe(false);
  });

  it("三层合并:导出包只含本公司归属记录,零无归属混入", () => {
    addConclusionSummary(root, { runId: "r1", companyId: CO, points: ["c-owned"], createdAt: NOW });
    addConclusionSummary(root, { runId: "r2", points: ["c-unowned"], createdAt: NOW });
    addManualLesson(root, { content: "l-owned", scope: { companyId: CO, role: "dev" }, tags: [], savedBy: "import" }, NOW);
    addManualLesson(root, { content: "l-unowned", scope: { role: "dev" }, tags: [], savedBy: "import" }, NOW);

    const out = exportMemoryRecordsForCompany(root, CO, ["dev"]);
    const contents = out.map((r) => r.content);
    expect(contents.sort()).toEqual(["c-owned", "l-owned"]);
    expect(contents.some((c) => c.endsWith("unowned"))).toBe(false);
  });
});
