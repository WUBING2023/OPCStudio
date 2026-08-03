// P2#7 · run 滚动索引:增量登记/摘要提取/懒重建 的行为锁。
// 战役B·Phase B2b:参数化双后端(json / sqlite)各跑一遍;后端相关断言(_index.json 存在性)按后端分支。
import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRun, saveRunTask, saveRunReport, loadRunIndex, extractRunSummaryLine, updateRunIndex, loadRunTask } from "./projectStore.js";
import { closeAllDbs } from "./sqlite/db.js";
import type { Run } from "@opc/shared";

const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "ridx-"));
  fs.mkdirSync(path.join(r, ".opc"), { recursive: true });
  roots.push(r);
  return r;
}
afterEach(() => {
  closeAllDbs();
  for (const r of roots.splice(0)) { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* Windows 句柄 */ } }
  delete process.env.OPC_STORAGE_BACKEND;
});
function withBackend<T>(backend: string, fn: () => T): T {
  const prev = process.env.OPC_STORAGE_BACKEND;
  process.env.OPC_STORAGE_BACKEND = backend;
  try { return fn(); }
  finally { if (prev === undefined) delete process.env.OPC_STORAGE_BACKEND; else process.env.OPC_STORAGE_BACKEND = prev; }
}

const mkRun = (id: string, goal: string): Run => ({ id, userGoal: goal, status: "running", startedAt: "2026-07-03T01:00:00.000Z", totalTokens: 0, totalCostUsd: 0, participatingAgents: [] } as unknown as Run);

const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("run 滚动索引 [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("createRun/saveRunTask/saveRunReport 增量维护索引(状态、摘要)+ task.json 永远照写", () => {
    const root = mkRoot();
    const r = mkRun("run-a", "研究一下快排");
    run(() => {
      createRun(root, r);
      expect(loadRunIndex(root)).toHaveLength(1);
      expect(loadRunIndex(root)[0].status).toBe("running");

      r.status = "done"; (r as any).endedAt = "2026-07-03T01:10:00.000Z"; r.totalTokens = 1234;
      saveRunTask(root, r);
      saveRunReport(root, "run-a", "> ⚠️ 横幅\n\n# 标题\n\n快排平均 O(n log n),最坏 O(n^2),可随机化规避。\n\n更多内容", "<html/>");
      const idx = loadRunIndex(root);
      expect(idx[0].status).toBe("done");
      expect(idx[0].totalTokens).toBe(1234);
      expect(idx[0].summary).toContain("快排平均");
    });
    // task.json 照写(证据契约):两后端都必须磁盘落 task.json 且内容正确(committedMemoryRetriever 直读)。
    const taskPath = path.join(root, ".opc", "runs", "run-a", "task.json");
    expect(fs.existsSync(taskPath)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(taskPath, "utf-8"));
    expect(onDisk.status).toBe("done");
    expect(onDisk.totalTokens).toBe(1234);
    // loadRunTask(读 task.json)两后端一致
    expect(run(() => loadRunTask(root, "run-a"))?.status).toBe("done");
  });

  it("懒重建:列表权威缺失/空但盘上有 task.json 时,从 task.json 全量重建一次", () => {
    const root = mkRoot();
    // 直接写 task.json(绕开列表权威):json 侧无 _index.json、sqlite 侧 runs 表空 —— 两后端都应懒重建。
    const dir = path.join(root, ".opc", "runs", "run-b");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "task.json"), JSON.stringify(mkRun("run-b", "目标 B")), "utf-8");
    run(() => {
      const idx = loadRunIndex(root);
      expect(idx).toHaveLength(1);
      expect(idx[0].goal).toBe("目标 B");
    });
    if (backend === "json") {
      // json 懒重建会把索引回写 _index.json(sqlite 侧懒重建落 runs 表,不写 _index.json)
      expect(fs.existsSync(path.join(root, ".opc", "runs", "_index.json"))).toBe(true);
    }
  });

  it("排序按 startedAt 倒序;extractRunSummaryLine 跳过横幅/标题/表格", () => {
    const root = mkRoot();
    run(() => {
      updateRunIndex(root, { id: "r1", goal: "g1", status: "done", startedAt: "2026-07-01T00:00:00Z" });
      updateRunIndex(root, { id: "r2", goal: "g2", status: "done", startedAt: "2026-07-02T00:00:00Z" });
      expect(loadRunIndex(root)[0].id).toBe("r2");
      expect(loadRunIndex(root).find((e) => e.id === "r1")?.goal).toBe("g1"); // 纯索引条目 goal 保留
    });
    // extractRunSummaryLine 纯函数,后端无关
    expect(extractRunSummaryLine("# T\n\n> 引用\n\n| a | b |\n\n**正文**开始了")).toBe("正文开始了");
    expect(extractRunSummaryLine("")).toBe("");
    // 活体验证回归:代码围栏整块跳过(否则 ```python 的语言标记被当首段)
    expect(extractRunSummaryLine("# T\n\n```python\ndef fib(n): ...\n```\n\n迭代实现,O(n) 时间。")).toBe("迭代实现,O(n) 时间。");
  });
});
