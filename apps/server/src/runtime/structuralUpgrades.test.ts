// 结构提升 A/B(源自通宵实验因果分析)的行为锁:
// A. plan_template 拆分复用(降"每次从零拆解"的方差) B. 合成输入公平配额(不再头部截断丢覆盖面)
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fairShareOutputs } from "./orchestrator.js";
import { upsertPlanTemplate, retrievePlanTemplate } from "../storage/registryStore.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "su-")); });

describe("B · fairShareOutputs 合成公平配额", () => {
  it("总量在预算内 → 原样返回,不压缩", () => {
    const r = fairShareOutputs(["a".repeat(100), "b".repeat(100)], 1000);
    expect(r.compressed).toBe(false);
    expect(r.outputs[0].length).toBe(100);
  });
  it("超预算 → 每人均分配额,头尾都保留(不再把后面 worker 整个丢掉)", () => {
    const w1 = "开头1".repeat(2000) + "结尾1".repeat(500);
    const w2 = "开头2".repeat(2000) + "结尾2".repeat(500);
    const w3 = "短产出很重要";
    const r = fairShareOutputs([w1, w2, w3], 6000);
    expect(r.compressed).toBe(true);
    // 每个超配额的都保留了头和尾
    expect(r.outputs[0]).toContain("开头1");
    expect(r.outputs[0]).toContain("结尾1");
    expect(r.outputs[1]).toContain("开头2");
    expect(r.outputs[1]).toContain("结尾2");
    // 短产出原样保留(旧头部截断会把排后面的它整个丢掉)
    expect(r.outputs[2]).toBe(w3);
    // 压缩后总量接近预算
    expect(r.outputs.join("").length).toBeLessThan(6000 + 600);
  });
});

describe("A · plan_template 拆分复用", () => {
  const NOW = "2026-07-02T12:00:00.000Z";
  it("≥2 个不同子任务才存;单任务/兜底整发不算拆分", () => {
    expect(upsertPlanTemplate(root, { companyId: "c1", taskType: "coding", split: ["同一个任务"], sourceRun: "r1" }, NOW)).toBeNull();
    const saved = upsertPlanTemplate(root, { companyId: "c1", taskType: "coding", split: ["实现模块", "写单元测试"], sourceRun: "r1" }, NOW)!;
    expect(saved.workerCount).toBe(2);
    expect(saved.support).toBe(1);
  });
  it("同 company+taskType 复现 → support+1 且以最新拆分为准", () => {
    upsertPlanTemplate(root, { companyId: "c1", taskType: "coding", split: ["旧拆分A", "旧拆分B"], sourceRun: "r1" }, NOW);
    const v2 = upsertPlanTemplate(root, { companyId: "c1", taskType: "coding", split: ["新拆分A", "新拆分B", "新拆分C"], sourceRun: "r2" }, "2026-07-03T00:00:00.000Z")!;
    expect(v2.support).toBe(2);
    expect(v2.split).toEqual(["新拆分A", "新拆分B", "新拆分C"]);
  });
  it("检索:company 硬隔离,未标 company 的新模板归入 default 而不跨公司注入", () => {
    upsertPlanTemplate(root, { companyId: "company-A", taskType: "research_report", split: ["A1", "A2"], sourceRun: "r1" }, NOW);
    upsertPlanTemplate(root, { taskType: "research_report", split: ["默认1", "默认2"], sourceRun: "r2" }, NOW);
    expect(retrievePlanTemplate(root, { companyId: "company-B", taskType: "research_report" })).toBeNull();
    expect(retrievePlanTemplate(root, { companyId: "default", taskType: "research_report" })?.split).toEqual(["默认1", "默认2"]);
    expect(retrievePlanTemplate(root, { companyId: "company-B", taskType: "coding" })).toBeNull();
  });
});
