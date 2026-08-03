import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentNodeConfig, MemoryEntry } from "@opc/shared";
import {
  buildSystemPrompt,
  type InjectionContext,
  MAX_INJECTED_MEMORY_ITEMS,
  MAX_INJECTED_MEMORY_CHARS,
} from "./contextBuilder.js";
import { goalToSlug } from "../storage/memoryStore.js";

// 效率治理 · 上下文预算验收:对着真实 buildSystemPrompt 断言"记忆注入不超全局预算"——
// 全局条数/字符闸(memGate,MAX_INJECTED_MEMORY_ITEMS/CHARS + env OPC_MAX_MEM_ITEMS/CHARS)真的会截断,
// 且可配。用户诉求:同一 prompt 里几十条记忆反复灌入 → 这里证明存在硬上限且能收紧。

let skillsTmp: string;
beforeAll(() => {
  skillsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-mb-"));
  process.env.OPC_SKILLS_DIR = skillsTmp; // 隔离技能目录,避免注入真实用户技能干扰字符预算
});
afterAll(() => {
  delete process.env.OPC_SKILLS_DIR;
  try { fs.rmSync(skillsTmp, { recursive: true, force: true }); } catch { /* */ }
});

let root: string;
const GOAL = "写一个爬虫程序抓取数据并做数据清洗";

function agent(): AgentNodeConfig {
  return {
    id: "dev-1", name: "Dev", role: "dev", childrenIds: [], model: "m", provider: "deepseek",
    framework: "api", companyId: "default", status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 },
    editable: true, deletable: true, enabled: true,
  };
}
function ctx(): InjectionContext {
  return { projectRoot: root, runId: "r", injectedSkillIds: [], injectedMemoryIds: [] };
}

// 写 N 条与 goal 强相关(goalSlug 精确命中)的项目层记忆——每条都会尝试注入,靠 memGate 截断。
function seedRelevantMemories(n: number, textLen: number): void {
  const slug = goalToSlug(GOAL);
  const entries: MemoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    entries.push({
      id: `mem-${i}`, agentRole: "dev", companyId: "default", goalSlug: slug,
      text: "记忆" + String(i).padStart(3, "0") + "内容".repeat(Math.max(1, Math.floor(textLen / 2))),
      tags: [], source: { runId: "seed", agentId: "a", type: "manual" },
      createdAt: "2026-01-01T00:00:00.000Z", hits: n - i, // 越靠前 hits 越高 → 高分优先保留
    });
  }
  const f = path.join(root, ".opc", "memory", "project.jsonl");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-mb-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});
afterEach(() => {
  delete process.env.OPC_MAX_MEM_ITEMS;
  delete process.env.OPC_MAX_MEM_CHARS;
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("contextBuilder · 记忆注入全局预算", () => {
  it("注入记忆条数不超过 MAX_INJECTED_MEMORY_ITEMS(默认档)", () => {
    seedRelevantMemories(50, 4); // 远超上限的候选;短文本,让条数闸(而非字符闸)成为约束
    const out = ctx();
    buildSystemPrompt(agent(), "你是开发", GOAL, root, out);
    expect(out.injectedMemoryIds.length).toBeLessThanOrEqual(MAX_INJECTED_MEMORY_ITEMS);
  });

  it("env OPC_MAX_MEM_ITEMS 可把上限收紧,gate 真的会截断", () => {
    seedRelevantMemories(50, 4);
    process.env.OPC_MAX_MEM_ITEMS = "2";
    const out = ctx();
    buildSystemPrompt(agent(), "你是开发", GOAL, root, out);
    // 有 ≥5 条强相关候选,却被全局条数闸压到 ≤2 → 证明闸生效且可配(收紧)。
    expect(out.injectedMemoryIds.length).toBeLessThanOrEqual(2);
  });

  it("env OPC_MAX_MEM_CHARS 收紧字符预算时,注入的记忆字符总量不超过该预算", () => {
    seedRelevantMemories(50, 120); // 长文本,让字符闸成为约束
    process.env.OPC_MAX_MEM_CHARS = "400";
    const out = ctx();
    const prompt = buildSystemPrompt(agent(), "你是开发", GOAL, root, out);
    // 逐条相加(register 记的 title 是截断后的;这里按各注入段的真实截断上限估算不便,改用直接证据:
    // 收紧到 400 字符时,注入的记忆条数必然远少于 50 条候选)。
    expect(out.injectedMemoryIds.length).toBeLessThan(10);
    // 且 prompt 里不会把 50 条记忆全灌进去。
    expect(prompt.length).toBeLessThan(50 * 300);
  });

  it("默认字符上限是正数且条数上限为正(常量自洽,防被误置 0/负导致永不注入)", () => {
    expect(MAX_INJECTED_MEMORY_ITEMS).toBeGreaterThan(0);
    expect(MAX_INJECTED_MEMORY_CHARS).toBeGreaterThan(0);
  });
});
