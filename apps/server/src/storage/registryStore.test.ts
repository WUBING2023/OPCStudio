import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addConclusionSummary, retrieveConclusionPoints, upsertProceduralSkill, retrieveProceduralSkills, loadRegistry, normalizeToolName,
  isReviewModeEnabled, setReviewMode, listConclusionProposals, approveConclusionSummary, rejectConclusionSummary,
  isRunConclusionAutoCommitEnabled, setRunConclusionAutoCommit,
} from "./registryStore.js";
import { summarizeConclusion } from "../runtime/runCritic.js";
import { closeDb } from "./sqlite/db.js";

const NOW = "2026-07-02T00:00:00.000Z";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-")); });

describe("P2 · registryStore · conclusion_summary", () => {
  it("addConclusionSummary:有要点 → 写入;空要点 → null 不写", () => {
    const r = addConclusionSummary(root, { runId: "r1", companyId: "c1", goalSlug: "sort", points: ["快排最坏 O(n^2)", "归并稳定但需 O(n) 辅助空间"], tags: ["排序", "sort"], createdAt: NOW });
    expect(r).not.toBeNull();
    expect(r!.kind).toBe("conclusion_summary");
    expect(loadRegistry(root).length).toBe(1);
    expect(addConclusionSummary(root, { runId: "r2", points: [], tags: [], createdAt: NOW })).toBeNull();
    expect(loadRegistry(root).length).toBe(1);
  });

  it("retrieveConclusionPoints:company 硬隔离(gap#7 对齐 lessons:别的 company 及无归属通用条目都不注入)", () => {
    addConclusionSummary(root, { runId: "r1", companyId: "company-A", goalSlug: "sort", points: ["A 的结论"], tags: ["sort"], createdAt: NOW });
    addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["通用结论"], tags: ["sort"], createdAt: NOW }); // 无 companyId
    // company-B 查询:别的 company 结论被隔离,无归属(legacy)通用结论同样不再注入(硬隔离,缺省拒)。
    const ptsB = retrieveConclusionPoints(root, { companyId: "company-B", goal: "写个 sort 报告" });
    expect(ptsB).not.toContain("A 的结论");
    expect(ptsB).not.toContain("通用结论"); // 无归属条目:公司硬隔离下不注入
    // company-A 查询:只拿到本公司结论;无归属通用结论仍被隔离。
    const ptsA = retrieveConclusionPoints(root, { companyId: "company-A", goal: "写个 sort 报告" });
    expect(ptsA).toContain("A 的结论");
    expect(ptsA).not.toContain("通用结论");
    // 无 companyId 查询(无公司作用域的调用点):不隔离,通用结论仍可返回(零回归)。
    const ptsNone = retrieveConclusionPoints(root, { goal: "写个 sort 报告" });
    expect(ptsNone).toContain("通用结论");
  });

  it("retrieveConclusionPoints:goalSlug 命中排前,返回扁平要点", () => {
    addConclusionSummary(root, { runId: "r1", goalSlug: "other", points: ["无关"], tags: [], createdAt: NOW });
    addConclusionSummary(root, { runId: "r2", goalSlug: "sort", points: ["相关1", "相关2"], tags: [], createdAt: NOW });
    const pts = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort", limit: 1 });
    expect(pts).toEqual(["相关1", "相关2"]);
  });

  // D1 · minScore:注入侧传 1 时,零相关(goalSlug/tag 都不命中,s=0)的结论不再靠 recency 兜底顶替注入。
  it("retrieveConclusionPoints:minScore=1 过滤零相关结论(不再按最新兜底);默认 0 保持旧兜底", () => {
    // 更新但零相关(不同 goalSlug、无 tag 命中)vs 更旧但相关(goalSlug/tag 命中)。
    addConclusionSummary(root, { runId: "r-fresh", goalSlug: "http", points: ["最新但不相关"], tags: [], createdAt: "2026-07-05T00:00:00.000Z" });
    addConclusionSummary(root, { runId: "r-rel", goalSlug: "sort", points: ["相关结论"], tags: ["排序"], createdAt: "2026-01-01T00:00:00.000Z" });
    // 默认(无 minScore):零相关的"最新但不相关"因 recency 兜底可能被取到(旧行为)。
    const dflt = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "写个排序报告", limit: 1 });
    expect(dflt).toContain("相关结论"); // goalSlug 命中 s=3 排最前
    // minScore=1:相关结论仍在(s>=1);把 limit 放大到 5,零相关的"最新但不相关"(s=0)被过滤掉。
    const gated = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "写个排序报告", limit: 5, minScore: 1 });
    expect(gated).toContain("相关结论");
    expect(gated).not.toContain("最新但不相关");
    // 对照:同参不带 minScore(默认 0),零相关的也会被纳入(s=0 >= 0)。
    const ungated = retrieveConclusionPoints(root, { goalSlug: "sort", goal: "写个排序报告", limit: 5 });
    expect(ungated).toContain("最新但不相关");
  });
});

describe("P2 · 提案审核(review-mode 开关 + pending/approve/reject)", () => {
  it("review-mode 默认关闭:新写入的 conclusion_summary 无需人工审核,直接可被检索", () => {
    expect(isReviewModeEnabled(root)).toBe(false);
    const r = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["默认自动生效"], createdAt: NOW });
    expect(r!.status).toBe("approved");
    expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).toContain("默认自动生效");
  });

  it("开启 review-mode 后新写入落 pending,不会被 retrieveConclusionPoints 检索注入,直到 approve", () => {
    setReviewMode(root, true);
    expect(isReviewModeEnabled(root)).toBe(true);
    const r = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["待审核要点"], createdAt: NOW });
    expect(r!.status).toBe("pending");
    expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).not.toContain("待审核要点");

    const proposals = listConclusionProposals(root);
    expect(proposals.length).toBe(1);
    expect(proposals[0].id).toBe(r!.id);

    const approved = approveConclusionSummary(root, r!.id);
    expect(approved!.status).toBe("approved");
    expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).toContain("待审核要点");
    expect(listConclusionProposals(root).length).toBe(0); // 审核完不再是 pending
  });

  it("reject 后的提案不参与检索注入,且不再出现在 proposals 列表", () => {
    setReviewMode(root, true);
    const r = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["会被拒绝的要点"], createdAt: NOW });
    const rejected = rejectConclusionSummary(root, r!.id);
    expect(rejected!.status).toBe("rejected");
    expect(retrieveConclusionPoints(root, { goalSlug: "sort", goal: "sort" })).not.toContain("会被拒绝的要点");
    expect(listConclusionProposals(root).length).toBe(0);
  });

  it("approve/reject 对不存在的 id 返回 null", () => {
    expect(approveConclusionSummary(root, "concl-不存在")).toBeNull();
    expect(rejectConclusionSummary(root, "concl-不存在")).toBeNull();
  });

  it("显式传入 status 覆盖 review-mode 默认值", () => {
    const r = addConclusionSummary(root, { runId: "r1", goalSlug: "sort", points: ["显式 approved"], createdAt: NOW, status: "approved" });
    expect(r!.status).toBe("approved"); // review-mode 默认关闭本就是 approved,这里验证显式传参路径可用
  });
});

describe("D2 · run_conclusion 自动 commit 开关(autoCommitRunConclusion + env)", () => {
  const ENV = "OPC_MEMORY_AUTOCOMMIT";
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
  // 恢复 env(vitest 每个 it 后)
  const restore = () => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; };

  it("默认只自动提交 clean 低风险结论,避免每个 run 都产生人工待办", () => {
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(true);
    restore();
  });

  it("review-mode.json 显式 true → 开启;false → 关闭;字段独立于 enabled", () => {
    setReviewMode(root, true); // conclusion_summary 审核模式与 run conclusion 自动提交字段相互独立
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(true);
    setRunConclusionAutoCommit(root, true);
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(true);
    expect(isReviewModeEnabled(root)).toBe(true); // merge 写入未抹掉 enabled
    setRunConclusionAutoCommit(root, false);
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(false);
    restore();
  });

  it("env OPC_MEMORY_AUTOCOMMIT 优先级高于文件(off 覆盖文件 true;on 覆盖文件 false)", () => {
    setRunConclusionAutoCommit(root, true);
    process.env[ENV] = "off";
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(false);
    setRunConclusionAutoCommit(root, false);
    process.env[ENV] = "on";
    expect(isRunConclusionAutoCommitEnabled(root)).toBe(true);
    restore();
  });
});

describe("P4(预置)· upsertProceduralSkill", () => {
  it("新建 → created;同 role+taskType → 合并 support+1", () => {
    upsertProceduralSkill(root, { role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"], producedArtifacts: [".ts"], antiPatterns: [], support: 1, successRate: 0.8, sourceRuns: ["r1"], status: "candidate" }, NOW);
    const s2 = upsertProceduralSkill(root, { role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"], producedArtifacts: [".ts"], antiPatterns: [], support: 1, successRate: 0.9, sourceRuns: ["r2"], status: "candidate" }, "2026-07-03T00:00:00.000Z");
    expect(s2.support).toBe(2);
    expect(loadRegistry(root).filter((r) => r.kind === "procedural_skill").length).toBe(1);
    expect((s2 as any).sourceRuns).toEqual(expect.arrayContaining(["r1", "r2"]));
  });

  it("[P4] support 达 3 自动 promotion → verified;retrieveProceduralSkills 按 role+minSupport 过滤", () => {
    const mk = (rid: string) => upsertProceduralSkill(root, { role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"], producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: [rid], status: "candidate" }, NOW);
    mk("r1"); mk("r2");
    const s3 = mk("r3");
    expect(s3.support).toBe(3);
    expect(s3.status).toBe("verified");
    expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding", minSupport: 2 }).length).toBe(1);
    expect(retrieveProceduralSkills(root, { role: "pm", taskType: "coding" }).length).toBe(0); // 别的角色不命中
  });

  const mk = (rid: string) => upsertProceduralSkill(root, { role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"], producedArtifacts: [], antiPatterns: [], support: 1, successRate: 1, sourceRuns: [rid], status: "candidate" }, NOW);
  it("[fix4] 同一 run 多次 upsert 不重复累加 support(按不同 run 计)", () => {
    mk("r1");
    expect(mk("r1").support).toBe(1); // 同一 run 再来 → 不涨
  });
  it("[fix6] 只注入 verified:support<3 的 candidate 不被检索注入", () => {
    mk("r1"); mk("r2"); // support=2 candidate
    expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding" }).length).toBe(0);
    mk("r3"); // support=3 → verified
    expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding" }).length).toBe(1);
  });
});

describe("normalizeToolName(防路径泄漏 + 归一)", () => {
  it("干净工具名原样;powershell 取 cmdlet;路径命令取 basename;绝不含绝对路径/用户名", () => {
    expect(normalizeToolName("Read")).toBe("Read");
    expect(normalizeToolName("Bash")).toBe("Bash");
    expect(normalizeToolName(`"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem -Force'`)).toBe("Get-ChildItem");
    expect(normalizeToolName(`"C:\\x\\powershell.exe" -Command 'rg --files'`)).toBe("rg");
    expect(normalizeToolName("Get-Content -Raw C:\\Users\\Wubin\\x.py")).toBe("Get-Content");
    expect(normalizeToolName(`"C:\\Users\\Wubin\\opcwt\\x.py"`)).not.toContain("Wubin");
  });
});

describe("P2 · summarizeConclusion(mock 模型)", () => {
  it("模型返回 JSON 字符串数组 → 解析出要点", async () => {
    const model = async () => '```json\n["快排最坏 O(n^2),随机化 pivot 规避","归并稳定但需 O(n) 辅助空间"]\n```';
    const pts = await summarizeConclusion({ goal: "快排 vs 归并", reportMd: "长报告".repeat(50), callModel: model });
    expect(pts.length).toBe(2);
    expect(pts[0]).toContain("快排");
  });
  it("模型畸形输出 → 返回空", async () => {
    const pts = await summarizeConclusion({ goal: "g", reportMd: "r", callModel: async () => "不是 json" });
    expect(pts).toEqual([]);
  });
  it("[fix2] 数组含对象/数字项 → 只保留字符串(不把对象 String 成 [object Object])", async () => {
    const model = async () => '["有效要点", {"x":1}, 123, "另一条"]';
    const pts = await summarizeConclusion({ goal: "g", reportMd: "r", callModel: model });
    expect(pts).toEqual(["有效要点", "另一条"]);
  });
});

describe("P0 · retrieveProceduralSkills 按 companyId 硬隔离(历史无归属技能不注入)", () => {
  const T = "2026-07-01T00:00:00.000Z";
  const mk = (over: Record<string, unknown>) => ({ role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a"], producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1"], status: "verified" as const, ...over });
  it("传 companyId → 只注入本公司技能;他公司/无归属历史技能都不注入", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-ci-"));
    upsertProceduralSkill(root, mk({ companyId: "c1", sourceRuns: ["r1", "r2", "r3"] }) as any, T);
    upsertProceduralSkill(root, mk({ companyId: "c2", sourceRuns: ["r4", "r5", "r6"] }) as any, T);
    upsertProceduralSkill(root, mk({ sourceRuns: ["r7", "r8", "r9"] }) as any, T); // 无 companyId 历史
    const got = retrieveProceduralSkills(root, { role: "dev", companyId: "c1", taskType: "coding", limit: 5 });
    expect(got.length).toBe(1);
    expect((got[0] as any).companyId).toBe("c1");
    closeDb(root); fs.rmSync(root, { recursive: true, force: true });
  });
  it("不传 companyId(无公司作用域注入点)→ 旧口径不筛,零回归", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "reg-noci-"));
    upsertProceduralSkill(root, mk({ sourceRuns: ["r1", "r2", "r3"] }) as any, T);
    expect(retrieveProceduralSkills(root, { role: "dev", taskType: "coding" }).length).toBe(1);
    closeDb(root); fs.rmSync(root, { recursive: true, force: true });
  });
});
