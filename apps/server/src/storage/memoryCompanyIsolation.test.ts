import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { addMemory, queryMemory, queryMemoryScored, listMemory } from "./memoryStore.js";

// C12-P0/P1 · memory_entry(project.jsonl)公司硬隔离 + 源 run 终态污染护栏的活体测试。
// 硬指标①(用户追加令):同内容、同角色在不同公司必须可独立存在,且互不覆盖、互不注入。

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-co-iso-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});
afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

const TAGS = ["爬虫", "限速"];
const GOAL = "写一个爬虫并限速";
const TEXT = "抓取时要限速,否则触发反爬"; // A/B 两公司同内容

function seed(companyId: string | undefined, runId: string): void {
  addMemory(root, {
    agentRole: "dev",
    ...(companyId ? { companyId } : {}),
    goalSlug: "写一个爬虫并限速",
    text: TEXT,
    tags: TAGS,
    source: { runId, agentId: "dev-1" },
  });
}

describe("C12-P0 · memory_entry 公司硬隔离(A/B 同内容互不覆盖互不注入)", () => {
  it("A/B 两公司同角色同内容各自成条,检索按公司隔离,互不覆盖", () => {
    seed("co-A", "run-a");
    seed("co-B", "run-b");
    // 互不覆盖:两条实体都在
    expect(listMemory(root).length).toBe(2);

    // co-A 查询只拿到 co-A 的条目;co-B 的不注入
    const forA = queryMemoryScored(root, { agentRole: "dev", companyId: "co-A", goal: GOAL });
    expect(forA.length).toBe(1);
    expect(forA[0].entry.companyId).toBe("co-A");
    expect(forA[0].entry.source.runId).toBe("run-a");

    const forB = queryMemoryScored(root, { agentRole: "dev", companyId: "co-B", goal: GOAL });
    expect(forB.length).toBe(1);
    expect(forB[0].entry.companyId).toBe("co-B");
  });

  it("无归属(legacy 无 companyId)条目:有公司归属的查询硬隔离不注入(缺省拒),但不删除", () => {
    seed(undefined, "run-legacy");
    // 有公司归属查询:legacy 不注入
    expect(queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL }).length).toBe(0);
    // 但条目仍在库(未删除,供手动归属)
    expect(listMemory(root).length).toBe(1);
    // 无公司作用域的调用点(如 /api/memory/query 管理视图):不隔离,legacy 仍可返回(向后兼容)
    expect(queryMemory(root, { agentRole: "dev", goal: GOAL }).length).toBe(1);
  });

  it("公司隔离与既有相关性门共存:相关但跨公司 → 仍不注入", () => {
    seed("co-A", "run-a");
    // co-B 查询,relevance 命中(同 goalSlug+tags)但公司不符 → 0 条
    const res = queryMemoryScored(root, { agentRole: "dev", companyId: "co-B", goal: GOAL });
    expect(res.length).toBe(0);
  });
});

describe("C12-P1 · 成功经验污染护栏(源 run 终态 failed/degraded 的条目不注入)", () => {
  function writeTask(runId: string, task: Record<string, unknown>): void {
    const dir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(task), "utf-8");
  }

  it("源 run failed → 该'成功经验'条目在检索侧被隔离(历史条目也生效)", () => {
    // 先落 task.json,addMemory 探得该 runId 有 run 目录 → source.type=run(真·run 产出),
    // 检索侧才按 run 终态门做隔离(fail-closed 硬化后 manual 记忆免排除,run 记忆才走终态判定)。
    writeTask("run-bad", { id: "run-bad", status: "failed" });
    seed("co-A", "run-bad");
    expect(queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL }).length).toBe(0);
  });

  it("源 run degraded → 同样隔离", () => {
    writeTask("run-deg", { id: "run-deg", status: "done", degraded: true });
    seed("co-A", "run-deg");
    expect(queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL }).length).toBe(0);
  });

  it("源 run 干净(status done、非降级)→ 正常注入", () => {
    writeTask("run-ok", { id: "run-ok", status: "done" });
    seed("co-A", "run-ok");
    expect(queryMemory(root, { agentRole: "dev", companyId: "co-A", goal: GOAL }).length).toBe(1);
  });
});
