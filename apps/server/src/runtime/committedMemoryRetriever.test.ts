import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retrieveCommittedMemories } from "./committedMemoryRetriever.js";
import type { CommittedMemory } from "./memoryCommit.js";
import type { MemoryReuseStat } from "../storage/memoryReuseStore.js";

function mkEntry(over: Partial<CommittedMemory>): CommittedMemory {
  return {
    memoryId: over.memoryId ?? "m1", version: 1, parentVersion: 0, scope: "project", type: "lesson",
    content: "", sourceArtifactRefs: [], approvedBy: "lead", confidence: 0.7, revocable: true,
    createdAt: "2026-01-01T00:00:00.000Z", ...over,
  };
}

function writeRun(root: string, runId: string, entries: CommittedMemory[]): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "committed-memories.json"), JSON.stringify(entries), "utf-8");
  fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify({ id: runId, status: "done", finalState: "verified" }), "utf-8");
}

// P1#7:检索侧过去按空格/标点切分 goal,中文整句(无空格)被切成一个巨大 token,再用
// content.includes(整句) 判定相关性 —— 几乎恒为 false,相关性打分退化成"恒等于 confidence",
// 排序进而退化成纯 recency。修复后按 tokenize()(CJK 2-gram)双向匹配,主题相关的条目应该
// 能盖过更新但不相关的条目。
describe("retrieveCommittedMemories — CJK 分词修复(P1#7)", () => {
  it("主题相关但更旧的记忆,排到主题不相关但更新的记忆前面", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    writeRun(root, "run-old", [
      mkEntry({ memoryId: "old-relevant", content: "写爬虫抓取新闻网站数据时要注意反爬限速", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    writeRun(root, "run-new", [
      mkEntry({ memoryId: "new-irrelevant", content: "画一张公司季度收入的柱状图", createdAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-cur"), { recursive: true });

    const results = retrieveCommittedMemories(root, "帮我写一个爬虫抓取新闻网站的数据", "run-cur");
    expect(results.map((r) => r.memoryId)).toContain("old-relevant");
    expect(results.map((r) => r.memoryId)).toContain("new-irrelevant");
    expect(results[0].memoryId).toBe("old-relevant"); // 相关性应该压过纯 recency
  });

  it("完全不相关且置信度相同 → 仍回退到 recency(不破坏原有兜底排序)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    writeRun(root, "run-a", [mkEntry({ memoryId: "a", content: "关于烹饪的经验", createdAt: "2026-01-01T00:00:00.000Z" })]);
    writeRun(root, "run-b", [mkEntry({ memoryId: "b", content: "关于烹饪的经验", createdAt: "2026-02-01T00:00:00.000Z" })]);
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-cur"), { recursive: true });

    const results = retrieveCommittedMemories(root, "完全不搭嘎的话题词组合", "run-cur");
    expect(results[0].memoryId).toBe("b"); // 两条都不相关(同分)→ 更新的排前面
  });
});

// D3 · 复用结果加权:reuse-log 的验证回路反馈进排序。比率制:加成 = 0.2*cleanRuns/(injected+1)
// 恒 < +0.2(天然封顶,不像 raw hits 单调自增强);failedRuns 占优 → -0.2 沉底但不硬排除。
describe("retrieveCommittedMemories — 复用结果加权(D3,比率制封顶)", () => {
  function seed(root: string): void {
    writeRun(root, "run-a", [mkEntry({ memoryId: "clean-hist", content: "关于烹饪的经验", createdAt: "2026-01-01T00:00:00.000Z" })]);
    writeRun(root, "run-b", [mkEntry({ memoryId: "no-hist", content: "关于烹饪的经验", createdAt: "2026-02-01T00:00:00.000Z" })]);
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-cur"), { recursive: true });
  }

  it("干净复用历史的条目盖过零历史条目(同 confidence、同 overlap、对方更新)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seed(root);
    const stats = new Map<string, MemoryReuseStat>([["clean-hist", { injected: 3, cleanRuns: 3, failedRuns: 0 }]]);
    const results = retrieveCommittedMemories(root, "完全不搭嘎的话题词组合", "run-cur", 800, undefined, stats);
    expect(results[0].memoryId).toBe("clean-hist"); // +0.2*3/4=+0.15 > recency 兜底
  });

  it("failedRuns 占优 → -0.2 沉底;但不被硬排除(保守,防误杀)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seed(root);
    const stats = new Map<string, MemoryReuseStat>([["no-hist", { injected: 3, cleanRuns: 0, failedRuns: 3 }]]);
    const results = retrieveCommittedMemories(root, "完全不搭嘎的话题词组合", "run-cur", 800, undefined, stats);
    expect(results[0].memoryId).toBe("clean-hist"); // 失败历史沉底,尽管它更新
    expect(results.map((r) => r.memoryId)).toContain("no-hist"); // 仍在结果里(confidence 底分够 → 不误杀)
  });

  it("加成天然封顶:cleanRuns 再多也 < +0.2,压不过真实相关性(overlap 0.3/词)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    writeRun(root, "run-a", [mkEntry({ memoryId: "relevant", content: "写爬虫抓取新闻网站数据时要注意反爬限速", createdAt: "2026-01-01T00:00:00.000Z" })]);
    writeRun(root, "run-b", [mkEntry({ memoryId: "farmed", content: "画一张公司季度收入的柱状图", createdAt: "2026-06-01T00:00:00.000Z" })]);
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-cur"), { recursive: true });
    // farmed 有 1000 次干净复用(旧 raw-hits 自增强下必然霸榜)——比率制封顶后压不过主题相关的条目。
    const stats = new Map<string, MemoryReuseStat>([["farmed", { injected: 1000, cleanRuns: 1000, failedRuns: 0 }]]);
    const results = retrieveCommittedMemories(root, "帮我写一个爬虫抓取新闻网站的数据", "run-cur", 800, undefined, stats);
    expect(results[0].memoryId).toBe("relevant");
  });

  it("不传 stats → 从 reuse-log.jsonl 现读;无日志文件 → 行为与引入前一致(recency 兜底)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seed(root);
    const results = retrieveCommittedMemories(root, "完全不搭嘎的话题词组合", "run-cur");
    expect(results[0].memoryId).toBe("no-hist"); // 无任何复用历史 → 原兜底(更新的排前面)
  });
});

// D1 · taskType 相关性闸(codex 问题6):conf=1.0 的快排结论零重叠也被注进不相关任务的老 bug。
// 保守设计:仅"overlap===0 且双方 taskType 明确且不同"才硬排除;overlap>0 一律保留;taskType 匹配 +0.5 救回;
// 老条目无 taskType / 调用方不传 taskType → 跳过判定,行为与引入前一致(向后兼容)。
describe("retrieveCommittedMemories — D1 taskType 相关性闸(codex 问题6)", () => {
  // 与"快排"内容零 token 重叠的 goal(经 tokenize 的 CJK 2-gram 校验:无共享 token)。
  const IRRELEVANT_GOAL = "帮我发一个 HTTP 请求到后端接口";
  // 与内容有 token 重叠("排序")的 goal → overlap>0。
  const OVERLAP_GOAL = "写一个排序相关的东西";
  const SORT_CONTENT = "快速排序最坏情况是 O(n^2),枢轴选择很关键";

  function seedSort(root: string, over: Partial<CommittedMemory> = {}): void {
    writeRun(root, "run-sort", [mkEntry({ memoryId: "sort-mem", content: SORT_CONTENT, confidence: 1.0, ...over })]);
    fs.mkdirSync(path.join(root, ".opc", "runs", "run-cur"), { recursive: true });
  }

  it("conf=1.0 + overlap=0 + taskType 不匹配 → 被硬排除(不注入)——正是 codex 场景", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seedSort(root, { taskType: "coding" });
    const results = retrieveCommittedMemories(root, IRRELEVANT_GOAL, "run-cur", 800, undefined, undefined, { taskType: "web_research" });
    expect(results.map((r) => r.memoryId)).not.toContain("sort-mem");
  });

  it("taskType 匹配 → 即便零重叠也救回(+0.5)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seedSort(root, { taskType: "coding" });
    const results = retrieveCommittedMemories(root, IRRELEVANT_GOAL, "run-cur", 800, undefined, undefined, { taskType: "coding" });
    expect(results.map((r) => r.memoryId)).toContain("sort-mem");
  });

  it("overlap>0 的通用记忆:即便 taskType 不匹配也一律保留(防误杀)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seedSort(root, { taskType: "coding" });
    const results = retrieveCommittedMemories(root, OVERLAP_GOAL, "run-cur", 800, undefined, undefined, { taskType: "web_research" });
    expect(results.map((r) => r.memoryId)).toContain("sort-mem");
  });

  it("老条目无 taskType:不硬排除,仅靠 overlap 闸(向后兼容,零重叠仍按 confidence 保留)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seedSort(root); // 无 taskType
    const results = retrieveCommittedMemories(root, IRRELEVANT_GOAL, "run-cur", 800, undefined, undefined, { taskType: "web_research" });
    expect(results.map((r) => r.memoryId)).toContain("sort-mem");
  });

  it("调用方不传 taskType(opts 省略)→ 完全退回旧行为,零重叠仍按 confidence 保留", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cmr-"));
    seedSort(root, { taskType: "coding" });
    const results = retrieveCommittedMemories(root, IRRELEVANT_GOAL, "run-cur");
    expect(results.map((r) => r.memoryId)).toContain("sort-mem");
  });
});
