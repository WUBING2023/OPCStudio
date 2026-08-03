import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig } from "@opc/shared";
import { buildSystemPrompt, type InjectionContext } from "./contextBuilder.js";
import { citeMemories, citeMemoriesFromPack } from "./memoryPack.js";

// 宪法条款(不造假)的执法测试:UI 引用条里的"依据经验《X》",X 必须真的进过 prompt。
// 背景:committed-memories.json(审批入库的 run 结论)此前从不进 prompt,却被 memoryPack 审计视图
// 捞进 citedMemories → 展示层引用了执行层没用过的东西。本文件锁死修复后的三条不变量。

let root: string;

function writeCommitted(runId: string, entries: Array<Record<string, unknown>>, taskJson?: Record<string, unknown>): void {
  const dir = path.join(root, ".opc", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "committed-memories.json"), JSON.stringify(entries), "utf-8");
  if (taskJson) fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(taskJson), "utf-8");
}

function committedEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memoryId: "cm-1", version: 1, parentVersion: 0, scope: "project", type: "lesson",
    content: "爬虫抓取新闻站点要限速,否则触发反爬", sourceArtifactRefs: [], approvedBy: "lead",
    confidence: 0.9, revocable: true, createdAt: "2026-07-01T00:00:00.000Z",
    companyId: "co1", // C12-P0:与 agent() 的 co1 一致 → 公司硬隔离下正常注入(无归属条目见跨公司隔离专测)
    ...over,
  };
}

function agent(over: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return {
    id: "dev-1", name: "Dev", role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    framework: "hermes", companyId: "co1", status: "idle",
    tokenUsage: { prompt: 0, completion: 0, total: 0 }, editable: true, deletable: true, enabled: true,
    ...over,
  };
}

function ctx(): InjectionContext {
  return { projectRoot: root, runId: "run-current", injectedSkillIds: [], injectedMemoryIds: [] };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-honesty-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

describe("宪法·不造假 —— 引用条只列真正注入 prompt 的记忆", () => {
  it("已审批的 committed 记忆真的进 prompt(审批不再等于没批)", () => {
    writeCommitted("run-old", [committedEntry()], { id: "run-old", status: "done" });
    const out = ctx();
    const prompt = buildSystemPrompt(agent(), "你是开发", "帮我写一个爬虫抓取新闻网站", root, out);
    expect(prompt).toContain("## Legacy memory compatibility fallback");
    expect(prompt).toContain("触发反爬");
    expect(out.injectedMemoryIds).toContain("cm-1");
    expect((out.injectedMemories ?? []).some(r => r.id === "cm-1" && r.kind === "committed")).toBe(true);
  });

  it("【核心】入库但未注入的记忆,绝不出现在引用条里", () => {
    // 真注入的:一条 committed;未注入的:一条只存在于审计视图(pack)里的伪条目。
    writeCommitted("run-old", [committedEntry()], { id: "run-old", status: "done" });
    const out = ctx();
    buildSystemPrompt(agent(), "你是开发", "帮我写一个爬虫抓取新闻网站", root, out);

    const honest = citeMemories(out.injectedMemories);
    expect(honest.map(c => c.id)).toContain("cm-1");

    // 反面:memoryPack 视图里塞一条从未注入的记忆,诚实引用源必须不认它。
    const fakePack = {
      items: [
        { memoryId: "cm-1", scope: "workspace", kind: "committed", content: "真注入的" },
        { memoryId: "ghost-99", scope: "workspace", kind: "committed", content: "从未进过 prompt 的幽灵记忆" },
      ],
      countsByScope: {}, packHash: "x",
    } as never;
    expect(citeMemoriesFromPack(fakePack).map(c => c.id)).toContain("ghost-99"); // 审计视图会包含它
    expect(citeMemories(out.injectedMemories).map(c => c.id)).not.toContain("ghost-99"); // 引用条不会
  });

  it("失败 run 产出的结论只存档、不注入(护栏:错误经验不被反复学习)", () => {
    writeCommitted("run-bad", [committedEntry({ memoryId: "cm-bad", content: "失败run里得出的错误结论:爬虫无需限速" })],
      { id: "run-bad", status: "failed" });
    const out = ctx();
    const prompt = buildSystemPrompt(agent(), "你是开发", "帮我写一个爬虫抓取新闻网站", root, out);
    expect(prompt).not.toContain("无需限速");
    expect(out.injectedMemoryIds).not.toContain("cm-bad");
    expect(citeMemories(out.injectedMemories).map(c => c.id)).not.toContain("cm-bad");
  });

  it("degraded run 的结论同样被隔离", () => {
    writeCommitted("run-deg", [committedEntry({ memoryId: "cm-deg", content: "降级run的可疑结论" })],
      { id: "run-deg", status: "done", degraded: true });
    const out = ctx();
    const prompt = buildSystemPrompt(agent(), "你是开发", "帮我写一个爬虫抓取新闻网站", root, out);
    expect(prompt).not.toContain("可疑结论");
    expect(out.injectedMemoryIds).not.toContain("cm-deg");
  });

  it("committed 段有独立预算,超限截断且不挤占其它注入", () => {
    const long = "x".repeat(600);
    writeCommitted("run-a", [
      committedEntry({ memoryId: "cm-a", content: long }),
      committedEntry({ memoryId: "cm-b", content: long }),
      committedEntry({ memoryId: "cm-c", content: long }),
    ], { id: "run-a", status: "done" });
    const out = ctx();
    buildSystemPrompt(agent(), "你是开发", "x 相关任务", root, out);
    const injectedCommitted = (out.injectedMemories ?? []).filter(r => r.kind === "committed");
    expect(injectedCommitted.length).toBeLessThanOrEqual(2); // 800 字预算装不下三条 600 字
  });

  it("C12-P0 · 已审批 committed 经验按公司硬隔离:A 公司经验不注入 B 公司同角色 agent,且无归属旧条目对有公司归属的 agent 也不注入", () => {
    // co1 的经验 + 无归属(legacy)经验各一条,写在同一成功 run 目录。
    writeCommitted("run-old", [
      committedEntry({ memoryId: "cm-co1", content: "co1 专属:限速阈值设为每秒 1 次", companyId: "co1" }),
      committedEntry({ memoryId: "cm-legacy", content: "无公司归属的历史结论:直接全速抓取", companyId: undefined }),
    ], { id: "run-old", status: "done" });

    // B 公司(co2)同角色 dev:co1 经验与无归属经验都不得进 prompt(硬隔离,缺省拒)。
    const outB = ctx();
    const promptB = buildSystemPrompt(agent({ id: "dev-2", companyId: "co2" }), "你是开发", "帮我写一个爬虫抓取新闻网站", root, outB);
    expect(promptB).not.toContain("co1 专属");
    expect(promptB).not.toContain("全速抓取");
    expect(outB.injectedMemoryIds).not.toContain("cm-co1");
    expect(outB.injectedMemoryIds).not.toContain("cm-legacy");

    // A 公司(co1)同角色 dev:只注入本公司经验;无归属经验仍被硬隔离拦下(不删、不注入)。
    const outA = ctx();
    const promptA = buildSystemPrompt(agent({ id: "dev-1", companyId: "co1" }), "你是开发", "帮我写一个爬虫抓取新闻网站", root, outA);
    expect(promptA).toContain("co1 专属");
    expect(outA.injectedMemoryIds).toContain("cm-co1");
    expect(outA.injectedMemoryIds).not.toContain("cm-legacy"); // 无归属旧条目:停止注入
  });

  it("md 记忆与失败教训等既有注入层照旧登记(引用条覆盖全部真实注入)", () => {
    fs.mkdirSync(path.join(root, ".opc", "memory"), { recursive: true });
    fs.writeFileSync(path.join(root, ".opc", "memory", "company.md"), "公司的共享事实:我们只用 Python", "utf-8");
    const out = ctx();
    const prompt = buildSystemPrompt(agent(), "你是开发", "随便什么任务", root, out);
    if (prompt.includes("## 公司知识")) {
      expect(out.injectedMemoryIds).toContain("md-company");
      expect(citeMemories(out.injectedMemories).some(c => c.id === "md-company")).toBe(true);
    }
  });
});
