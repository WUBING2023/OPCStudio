import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildMemoryPack, buildMemorySummary, deriveRunMemoryPackUsage, computeMemoryPackHash, citeMemoriesFromPack, formatCitationLine, type MemoryPackContext, type MemoryPackItem, type MemoryPackResult } from "./memoryPack.js";
import { addConclusionSummary, upsertProceduralSkill, upsertPlanTemplate } from "../storage/registryStore.js";
import { commitLesson } from "../storage/reflectionStore.js";
import { addMemory } from "../storage/memoryStore.js";
import { writeCompanyMd, writeTeamMd, writeProjectMd, appendAgentMemory } from "../storage/mdMemory.js";
import type { CommittedMemory } from "./memoryCommit.js";

const NOW = "2026-07-02T00:00:00.000Z";
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mempack-")); });

function ctx(over: Partial<MemoryPackContext> = {}): MemoryPackContext {
  return { goal: "写一个 python 数据处理脚本", agentId: "dev-1", role: "dev", ...over };
}

function writeCommittedRun(root: string, runId: string, entries: CommittedMemory[]): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "committed-memories.json"), JSON.stringify(entries), "utf-8");
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: runId, status: "done", finalState: "verified" }), "utf-8");
}

describe("buildMemoryPack — 基线", () => {
  it("全新空 root(无任何记忆数据)→ 不抛错,items 为空,countsByScope 全零", () => {
    const pack = buildMemoryPack(root, ctx());
    expect(pack.items).toEqual([]);
    expect(pack.countsByScope).toEqual({ employee: 0, department: 0, company: 0, workspace: 0, run: 0 });
    expect(typeof pack.generatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(pack.generatedAt))).toBe(false);
  });
});

describe("buildMemoryPack — registryStore(conclusion_summary / procedural_skill / plan_template)", () => {
  it("conclusion_summary 命中 → kind=conclusion,溯源 sourceRunId,scope 按 companyId 归类", () => {
    addConclusionSummary(root, {
      runId: "run-concl-1", companyId: "co-1", goalSlug: "py-pipe",
      points: ["用 pandas 处理大文件要分块读", "写完先跑单测再交付"],
      tags: ["python", "pipeline"], createdAt: NOW,
    });
    const pack = buildMemoryPack(root, ctx({ companyId: "co-1", goal: "python pipeline 报告" }));
    const item = pack.items.find((i) => i.kind === "conclusion");
    expect(item).toBeDefined();
    expect(item!.scope).toBe("company");
    expect(item!.sourceRunId).toBe("run-concl-1");
    expect(item!.content.length).toBeLessThanOrEqual(201); // <=200 + 省略号
    expect(item!.whySelected.length).toBeGreaterThan(0);
  });

  it("procedural_skill:support 达 3(verified)才命中,role 硬匹配", () => {
    const mk = (rid: string) => upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["read", "write", "test"],
      producedArtifacts: [], antiPatterns: [], support: 1, successRate: 0.85, sourceRuns: [rid], status: "candidate",
    }, NOW);
    mk("run-a"); mk("run-b"); mk("run-c"); // 3 个不同 run → verified

    const packDev = buildMemoryPack(root, ctx({ role: "dev" }));
    const item = packDev.items.find((i) => i.kind === "procedural_skill");
    expect(item).toBeDefined();
    expect(item!.scope).toBe("workspace");
    expect(item!.confidence).toBe(0.85);
    expect(item!.sourceRunId).toBe("run-c");

    const packOther = buildMemoryPack(root, ctx({ role: "pm" }));
    expect(packOther.items.some((i) => i.kind === "procedural_skill")).toBe(false); // 别的角色不命中
  });

  it("plan_template:company 命中,溯源 sourceRunId=sourceRun", () => {
    upsertPlanTemplate(root, { companyId: "co-1", taskType: "coding", goalSlug: "py-pipe", split: ["拆分1:读取数据", "拆分2:清洗数据"], sourceRun: "run-plan-1" }, NOW);
    const pack = buildMemoryPack(root, ctx({ companyId: "co-1" }));
    const item = pack.items.find((i) => i.kind === "plan_template");
    expect(item).toBeDefined();
    expect(item!.sourceRunId).toBe("run-plan-1");
    expect(item!.scope).toBe("company");
  });
});

describe("buildMemoryPack — reflectionStore(失败教训)", () => {
  it("committed 状态的 lesson 命中,role/team/company 隔离生效,scope 按最细粒度归类", () => {
    const runDir = path.join(root, ".opc", "runs", "run-lesson-1");
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "task.json"), JSON.stringify({ status: "done", finalState: "verified" }), "utf-8");
    commitLesson(root, {
      kind: "failure_lesson",
      scope: { role: "dev", teamId: "lead-1", companyId: "co-1" },
      trigger: { eventTypes: [], failureMode: "timeout", conditionText: "处理大文件超时" },
      diagnosis: "一次性读入整个文件导致内存/时间超限",
      lesson: "大文件应分块处理避免超时",
      recommendedChange: "改用分块读取 + 流式处理，避免一次性加载",
      injection: { strength: "warning", promptText: "处理大文件时改用分块读取，避免一次性加载导致超时" },
      evidence: { runId: "run-lesson-1" },
      confidence: 0.8,
    }, NOW);

    const hit = buildMemoryPack(root, ctx({ role: "dev", teamId: "lead-1", companyId: "co-1" }));
    const item = hit.items.find((i) => i.kind === "lesson");
    expect(item).toBeDefined();
    expect(item!.scope).toBe("department"); // teamId 存在但 agentId 不存在 → department
    expect(item!.sourceRunId).toBe("run-lesson-1");
    expect(item!.confidence).toBe(0.8);

    const missOtherRole = buildMemoryPack(root, ctx({ role: "test", teamId: "lead-1", companyId: "co-1" }));
    expect(missOtherRole.items.some((i) => i.kind === "lesson")).toBe(false); // 角色隔离
  });
});

describe("buildMemoryPack — memoryStore(project 层经验)", () => {
  it("project 层记忆命中(角色匹配 + goal 关键词命中)→ scope=workspace", () => {
    addMemory(root, { agentRole: "dev", goalSlug: "py-pipe", text: "python 脚本记得加异常处理", tags: ["python"], source: { runId: "run-mem-1", agentId: "dev-1" } });
    const pack = buildMemoryPack(root, ctx());
    const item = pack.items.find((i) => i.kind === "memory_entry");
    expect(item).toBeDefined();
    expect(item!.scope).toBe("workspace");
    expect(item!.sourceRunId).toBe("run-mem-1");
  });
});

describe("buildMemoryPack — committedMemoryRetriever(跨 run 已提交)", () => {
  it("跨 run 已提交记忆命中(role 未标注 → 共享可见)→ kind=committed", () => {
    writeCommittedRun(root, "run-committed-1", [{
      memoryId: "mem-abc123", version: 1, parentVersion: 0, scope: "project", type: "run_conclusion",
      content: "python 数据管道要注意编码问题", sourceArtifactRefs: [], approvedBy: "lead", confidence: 0.9,
      revocable: true, createdAt: NOW,
    }]);
    const pack = buildMemoryPack(root, ctx());
    const item = pack.items.find((i) => i.kind === "committed");
    expect(item).toBeDefined();
    expect(item!.scope).toBe("workspace"); // project → workspace
    expect(item!.confidence).toBe(0.9);
  });
});

describe("buildMemoryPack — mdMemory(四份共享 md,各自包装成一条)", () => {
  it("company/team/project/agent 四份 md 各自命中,scope 归类正确", () => {
    writeCompanyMd(root, "# 公司知识\n我们是一家做数据处理工具的公司。");
    writeTeamMd(root, "lead-1", "# 团队\n负责数据管道相关任务。");
    writeProjectMd(root, "lead-1", "# 项目\n目标:做一个 python 数据处理脚本。");
    appendAgentMemory(root, "dev-1", "上次记得先写测试再交付");

    const pack = buildMemoryPack(root, ctx({ teamId: "lead-1", agentId: "dev-1" }));
    const byKind = Object.fromEntries(pack.items.filter((i) => i.kind.startsWith("md_")).map((i) => [i.kind, i]));
    expect(byKind.md_company.scope).toBe("company");
    expect(byKind.md_team.scope).toBe("department");
    expect(byKind.md_project.scope).toBe("department");
    expect(byKind.md_agent.scope).toBe("employee");
    expect(byKind.md_agent.memoryId).toBe("md-agent-dev-1");
  });

  it("teamId 未提供时,team.md/project.md 不产出条目(不抛错)", () => {
    writeCompanyMd(root, "# 公司知识");
    const pack = buildMemoryPack(root, ctx({ teamId: undefined }));
    expect(pack.items.some((i) => i.kind === "md_team")).toBe(false);
    expect(pack.items.some((i) => i.kind === "md_project")).toBe(false);
    expect(pack.items.some((i) => i.kind === "md_company")).toBe(true);
  });
});

describe("buildMemoryPack — 健壮性(某子系统报错只降级该部分,不整体抛错)", () => {
  it("registry.jsonl / lessons.jsonl 被占用成目录(读取必抛)→ 相关 kind 静默为空,其它子系统仍正常产出", () => {
    // 正常数据源(应仍然产出):company.md + 跨 run 已提交记忆
    writeCompanyMd(root, "# 公司知识");
    writeCommittedRun(root, "run-committed-2", [{
      memoryId: "mem-ok", version: 1, parentVersion: 0, scope: "project", type: "run_conclusion",
      content: "python 相关的一条跨 run 记忆", sourceArtifactRefs: [], approvedBy: "lead", confidence: 0.9,
      revocable: true, createdAt: NOW,
    }]);
    // 强制 registryStore.loadRegistry / reflectionStore.loadLessons 读取时抛错(EISDIR)。
    fs.mkdirSync(path.join(root, ".opc", "memory", "registry.jsonl"), { recursive: true });
    fs.mkdirSync(path.join(root, ".opc", "memory", "lessons.jsonl"), { recursive: true });

    expect(() => buildMemoryPack(root, ctx())).not.toThrow();
    const pack = buildMemoryPack(root, ctx());
    expect(pack.items.some((i) => i.kind === "conclusion")).toBe(false);
    expect(pack.items.some((i) => i.kind === "procedural_skill")).toBe(false);
    expect(pack.items.some((i) => i.kind === "plan_template")).toBe(false);
    expect(pack.items.some((i) => i.kind === "lesson")).toBe(false);
    // 未受影响的子系统仍正常工作
    expect(pack.items.some((i) => i.kind === "md_company")).toBe(true);
    expect(pack.items.some((i) => i.kind === "committed")).toBe(true);
  });
});

describe("buildMemorySummary — 全局概览(不分角色)", () => {
  it("跨角色计数:即便 buildMemoryPack 对某角色不可见的条目,summary 里也应计入总量", () => {
    upsertProceduralSkill(root, {
      role: "dev", taskType: "coding", preconditions: [], successfulSequence: ["a", "b"],
      producedArtifacts: [], antiPatterns: [], support: 3, successRate: 1, sourceRuns: ["r1", "r2", "r3"], status: "verified",
    }, NOW);
    commitLesson(root, {
      kind: "failure_lesson",
      scope: { role: "test", agentId: "test-1" },
      trigger: { eventTypes: [], failureMode: "timeout", conditionText: "x" },
      diagnosis: "y",
      lesson: "测试角色专属教训占位文本",
      recommendedChange: "下次先跑冒烟测试再全量跑",
      injection: { strength: "warning", promptText: "先跑冒烟测试再全量跑，避免超时" },
      evidence: { runId: "run-x" },
      confidence: 0.8,
    }, NOW);

    const summary = buildMemorySummary(root);
    expect(summary.countsByKind.procedural_skill).toBe(1);
    expect(summary.countsByKind.lesson).toBe(1);
    expect(summary.countsByScope.employee).toBeGreaterThanOrEqual(1); // lesson 有 agentId → employee
    expect(summary.total).toBeGreaterThanOrEqual(2);

    // 而针对 role=pm 的 buildMemoryPack 看不到这条 dev/test 专属记忆(role 隔离生效)——两者语义不同。
    const packPm = buildMemoryPack(root, ctx({ role: "pm" }));
    expect(packPm.items.some((i) => i.kind === "procedural_skill" || i.kind === "lesson")).toBe(false);
  });
});

describe("deriveRunMemoryPackUsage — 纯派生自 events.jsonl", () => {
  it("找不到 run 目录 → 返回空 usages,不抛错", () => {
    const usage = deriveRunMemoryPackUsage(root, "no-such-run");
    expect(usage.usages).toEqual([]);
    expect(usage.totalByScope).toEqual({ employee: 0, department: 0, company: 0, workspace: 0, run: 0 });
  });

  it("解析 memory_pack_used info 事件,汇总 totalByScope,忽略无关事件", () => {
    const dir = path.join(root, ".opc", "runs", "run-derive-1");
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      JSON.stringify({ id: "e1", runId: "run-derive-1", timestamp: NOW, type: "run_started", payload: { goal: "x" } }),
      JSON.stringify({ id: "e2", runId: "run-derive-1", timestamp: NOW, agentId: "dev-1", type: "info", payload: { kind: "memory_pack_used", role: "dev", message: "本轮 dev 使用了 1 条团队记忆", countsByScope: { department: 1 } } }),
      JSON.stringify({ id: "e3", runId: "run-derive-1", timestamp: NOW, agentId: "lead-1", type: "info", payload: { kind: "memory_pack_used", role: "lead", message: "本轮 lead 使用了 2 条历史经验", countsByScope: { workspace: 2 } } }),
    ];
    fs.writeFileSync(path.join(dir, "events.jsonl"), lines.join("\n") + "\n", "utf-8");

    const usage = deriveRunMemoryPackUsage(root, "run-derive-1");
    expect(usage.usages.length).toBe(2);
    expect(usage.totalByScope.department).toBe(1);
    expect(usage.totalByScope.workspace).toBe(2);
    expect(usage.usages[0].agentId).toBe("dev-1");
    expect(usage.usages[0].message).toBe("本轮 dev 使用了 1 条团队记忆");
  });
});

// ── B5 · packHash(items 身份的稳定 sha256)──────────────────────────────────────

describe("B5 · computeMemoryPackHash / buildMemoryPack.packHash", () => {
  const item = (over: Partial<MemoryPackItem> = {}): MemoryPackItem => ({
    memoryId: "m-1", scope: "company", kind: "conclusion", content: "内容 A", sourceRunId: "run-1", whySelected: "命中", ...over,
  });

  it("同 items 同 hash;顺序无关;memoryId/content/sourceRunId 任一变更即变", () => {
    const a = [item(), item({ memoryId: "m-2", content: "内容 B" })];
    const h1 = computeMemoryPackHash(a);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeMemoryPackHash([...a].reverse())).toBe(h1); // 顺序无关
    expect(computeMemoryPackHash([item()])).not.toBe(h1); // 少一条即变
    expect(computeMemoryPackHash([item({ content: "内容改了" }), a[1]])).not.toBe(h1);
    expect(computeMemoryPackHash([item({ sourceRunId: "run-2" }), a[1]])).not.toBe(h1);
    expect(computeMemoryPackHash([item({ memoryId: "m-99" }), a[1]])).not.toBe(h1);
  });

  it("buildMemoryPack 返回 packHash 且与 items 一致;空 pack 与非空 pack hash 不同", () => {
    const empty = buildMemoryPack(root, ctx());
    expect(empty.packHash).toBe(computeMemoryPackHash([]));
    addConclusionSummary(root, {
      runId: "run-hash-1", companyId: "co-1", goalSlug: "py-pipe",
      points: ["用 pandas 处理大文件要分块读"], tags: ["python", "pipeline"], createdAt: NOW,
    });
    const pack = buildMemoryPack(root, ctx({ companyId: "co-1", goal: "python pipeline 报告" }));
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.packHash).toBe(computeMemoryPackHash(pack.items));
    expect(pack.packHash).not.toBe(empty.packHash);
  });
});

// ── CEO 记忆引用溯源:citeMemoriesFromPack / formatCitationLine ─────────────────────
describe("citeMemoriesFromPack — 注入即引用({id,title},id 真实存在)", () => {
  it("从真实 buildMemoryPack 派生引用:每条 id 都真实存在于 pack.items(可回溯经验页)", () => {
    // 播种真实记忆:结论(company)+ 失败教训(dev/team)+ 个人 md → 三个不同来源子系统
    addConclusionSummary(root, {
      runId: "run-cite-1", companyId: "co-1", goalSlug: "py-pipe",
      points: ["用 pandas 处理大文件要分块读", "写完先跑单测再交付"],
      tags: ["python", "pipeline"], createdAt: NOW,
    });
    commitLesson(root, {
      kind: "failure_lesson",
      scope: { role: "dev", teamId: "lead-1", companyId: "co-1" },
      trigger: { eventTypes: [], failureMode: "timeout", conditionText: "处理大文件超时" },
      diagnosis: "一次性读入整个文件导致超时",
      lesson: "大文件应分块处理避免超时",
      recommendedChange: "改用分块读取 + 流式处理",
      injection: { strength: "warning", promptText: "处理大文件时改用分块读取，避免一次性加载导致超时" },
      evidence: { runId: "run-cite-2" },
      confidence: 0.8,
    }, NOW);
    appendAgentMemory(root, "dev-1", "上次记得先写测试再交付");

    const pack = buildMemoryPack(root, ctx({ companyId: "co-1", teamId: "lead-1", agentId: "dev-1", goal: "python pipeline 报告" }));
    expect(pack.items.length).toBeGreaterThan(0);

    const cited = citeMemoriesFromPack(pack);
    expect(cited.length).toBeGreaterThan(0);
    const realIds = new Set(pack.items.map((i) => i.memoryId));
    for (const c of cited) {
      expect(typeof c.id).toBe("string");
      expect(c.id.length).toBeGreaterThan(0);
      expect(realIds.has(c.id), `引用 id ${c.id} 必须真实存在于 pack.items`).toBe(true);
      expect(typeof c.title).toBe("string");
      expect(c.title.length).toBeGreaterThan(0);
    }
    // 命中的失败教训应被引用,标题来自其内容(可读)
    expect(cited.some((c) => c.title.includes("分块"))).toBe(true);
  });

  it("空 pack / undefined → 空引用,不抛", () => {
    const empty = buildMemoryPack(root, ctx());
    expect(citeMemoriesFromPack(empty)).toEqual([]);
    expect(citeMemoriesFromPack(undefined)).toEqual([]);
  });

  it("按 memoryId 去重,标题裁到 <=33 字(32+省略号),最多 limit 条", () => {
    const longContent = "很长的记忆内容".repeat(20);
    const items: MemoryPackItem[] = [
      { memoryId: "m-1", scope: "company", kind: "conclusion", content: "结论一", whySelected: "" },
      { memoryId: "m-1", scope: "company", kind: "conclusion", content: "结论一(重复 id)", whySelected: "" },
      { memoryId: "m-2", scope: "workspace", kind: "committed", content: longContent, whySelected: "" },
      { memoryId: "m-3", scope: "employee", kind: "md_agent", content: "", whySelected: "" },
    ];
    const pack: MemoryPackResult = { items, countsByScope: {} as any, packHash: "sha256:x", generatedAt: NOW };
    const cited = citeMemoriesFromPack(pack, 2);
    expect(cited.map((c) => c.id)).toEqual(["m-1", "m-2"]); // 去重 + limit=2
    const long = citeMemoriesFromPack(pack).find((c) => c.id === "m-2")!;
    expect(long.title.length).toBeLessThanOrEqual(33);
    expect(long.title.endsWith("…")).toBe(true);
    // content 为空 → 退回 kind 人话标签
    const noContent = citeMemoriesFromPack(pack).find((c) => c.id === "m-3")!;
    expect(noContent.title).toBe("个人记忆");
  });
});

describe("formatCitationLine — 消息正文纯文本兜底行", () => {
  it("空引用 → 空串", () => {
    expect(formatCitationLine([])).toBe("");
  });
  it("依据经验:《标题》…×N(最多展示 3 条标题,×后为总数)", () => {
    expect(formatCitationLine([{ id: "a", title: "甲" }])).toBe("依据经验:《甲》×1");
    const five = ["甲", "乙", "丙", "丁", "戊"].map((t, i) => ({ id: `id-${i}`, title: t }));
    expect(formatCitationLine(five)).toBe("依据经验:《甲》《乙》《丙》×5");
  });
});
