import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Run } from "@opc/shared";
import { closeAllDbs } from "./sqlite/db.js";
import { openBusinessDb, readAllDocs } from "./sqlite/docTableBackend.js";
import { migrateJsonToSqlite } from "./sqlite/migrateJsonToSqlite.js";
import { readJSON } from "./jsonFile.js";
import {
  loadAgents, saveAgents, mergeSaveAgents,
  createRun, saveRunTask, saveRunReport, loadRunIndex, updateRunIndex, loadRunTask,
} from "./projectStore.js";

// 战役B·Phase B2b 总验:核心域(agents / runs)双后端等价 + task.json 照写(证据契约)+ runs 表 vs _index 全量等价。
// 绝不碰真实 .opc;全部临时目录构造库/副本。

const roots: string[] = [];
function mkRoot(): string {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "core-b2b-"));
  fs.mkdirSync(path.join(r, ".opc", "runs"), { recursive: true });
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
const A = (id: string, companyId: string, over: Record<string, unknown> = {}) =>
  ({ id, name: id, role: "dev", companyId, status: "idle", ...over } as any);
const mkRun = (id: string, goal: string, companyId?: string): Run =>
  ({ id, userGoal: goal, status: "running", startedAt: "2026-07-03T01:00:00.000Z", totalTokens: 0, totalCostUsd: 0, participatingAgents: [], ...(companyId ? { companyId } : {}) } as unknown as Run);

const BACKENDS = ["json", "sqlite"] as const;

// ───────────────── §一 agents 参数化双后端行为等价 ─────────────────
describe.each(BACKENDS)("§一 agents 行为等价 [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("saveAgents 全量覆盖 + loadAgents 读回", () => {
    const root = mkRoot();
    run(() => {
      saveAgents(root, [A("dev-1", "co1"), A("dev-2", "co2")]);
      expect(loadAgents(root, []).map((a) => a.id).sort()).toEqual(["dev-1", "dev-2"]);
      saveAgents(root, [A("dev-3", "co1")]); // 全量覆盖:旧的被抹掉
      expect(loadAgents(root, []).map((a) => a.id)).toEqual(["dev-3"]);
    });
  });

  it("mergeSaveAgents:保留他公司 agent(按 id upsert),只改传入子集", () => {
    const root = mkRoot();
    run(() => {
      saveAgents(root, [A("dev-1", "co1"), A("dev-2", "co2")]);
      mergeSaveAgents(root, [A("dev-1", "co1", { status: "busy" })]); // 只持有 co1 的 dev-1
      const all = loadAgents(root, []);
      expect(all.map((a) => a.id).sort()).toEqual(["dev-1", "dev-2"]); // dev-2(他公司)保留
      expect(all.find((a) => a.id === "dev-1")?.status).toBe("busy");  // dev-1 被更新
      expect(all.find((a) => a.id === "dev-2")?.status).toBe("idle");  // dev-2 未动
    });
  });
});

// ───────────────── §二 sqlite 双写后 sqlite 读 == json 读(同一份数据)─────────────────
describe("§二 双写后两读路径等价(同一份数据)", () => {
  it("agents:saveAgents + mergeSaveAgents 后 agents.json == agents 表", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      saveAgents(root, [A("dev-1", "co1"), A("dev-2", "co2")]);
      mergeSaveAgents(root, [A("dev-1", "co1", { status: "busy" })]);
    });
    expect(withBackend("sqlite", () => loadAgents(root, []))).toEqual(withBackend("json", () => loadAgents(root, [])));
    expect(readJSON(path.join(root, ".opc", "agents.json"), [])).toEqual(readAllDocs(openBusinessDb(root), "agents"));
  });

  it("runs:createRun/saveRunTask/saveRunReport 后 loadRunIndex 两读路径等价", () => {
    const root = mkRoot();
    withBackend("sqlite", () => {
      const r = mkRun("run-1", "目标一", "c1");
      createRun(root, r);
      r.status = "done"; r.totalTokens = 500; saveRunTask(root, r);
      saveRunReport(root, "run-1", "# 标题\n\n干净的一句话结论。", "<html/>");
    });
    const viaSqlite = withBackend("sqlite", () => loadRunIndex(root));
    // json 读路径需要 _index.json;sqlite 模式停写 _index —— 故用「同一份数据」口径:sqlite 读回自洽 +
    // 派生列正确(status/totalTokens/summary),再与迁移器重建交叉验证(见 §三)。
    expect(viaSqlite).toHaveLength(1);
    expect(viaSqlite[0].status).toBe("done");
    expect(viaSqlite[0].totalTokens).toBe(500);
    expect(viaSqlite[0].summary).toContain("干净的一句话结论");
    expect(viaSqlite[0].companyId).toBe("c1");
  });
});

// ───────────── §三 构造库(canonical .opc)→ 迁移 → sqlite loadRunIndex == json loadRunIndex ─────────────
describe("§三 runs 表 vs _index.json 读全量一致(构造库经迁移)", () => {
  it("task 行 + report 派生 summary/partial + 纯索引孤儿条目,双后端 loadRunIndex 全量 deepEqual", () => {
    const root = mkRoot();
    // 用 json 后端自然生成一致的 _index.json + task.json + report.md
    withBackend("json", () => {
      const r1 = mkRun("run-1", "目标一", "c1");
      createRun(root, r1);
      r1.status = "done"; r1.totalTokens = 500; (r1 as any).participatingAgents = ["dev-1", "dev-1", "dev-2"];
      saveRunTask(root, r1);
      saveRunReport(root, "run-1", "# 标题\n\n干净的一句话结论。\n\n(含部分产物 提示)", "<html/>");
      const r2 = mkRun("run-2", "目标二"); // 无 companyId、无 report
      createRun(root, r2);
      // 纯索引孤儿条目(_index 有、task.json 无):模拟归档残留/历史
      updateRunIndex(root, { id: "orphan-1", goal: "孤儿", status: "done", startedAt: "2026-07-05T00:00:00.000Z", summary: "孤儿摘要" });
    });
    const viaJson = withBackend("json", () => loadRunIndex(root));

    migrateJsonToSqlite(root);
    const viaSqlite = withBackend("sqlite", () => loadRunIndex(root));

    expect(viaSqlite).toEqual(viaJson);
    // 派生列抽查:run-1 的 summary 来自 report、partial=true(命中"部分产物")、agentIds 去重截断
    const s1 = viaSqlite.find((e) => e.id === "run-1")!;
    expect(s1.summary).toContain("干净的一句话结论");
    expect(s1.partial).toBe(true);
    expect(s1.agentIds).toEqual(["dev-1", "dev-2"]);
    expect(viaSqlite.find((e) => e.id === "orphan-1")?.goal).toBe("孤儿");
  });
});

// ───────────── §四 task.json 照写(证据契约:committedMemoryRetriever 直读 task.json)─────────────
describe.each(BACKENDS)("§四 task.json 永远照写 [backend=%s]", (backend) => {
  const run = <T>(fn: () => T): T => withBackend(backend, fn);

  it("saveRunTask 后磁盘 task.json 存在且内容正确;loadRunTask 读回一致", () => {
    const root = mkRoot();
    const r = mkRun("run-e", "证据目标");
    run(() => {
      createRun(root, r);
      r.status = "done"; r.totalTokens = 77; saveRunTask(root, r);
    });
    const tp = path.join(root, ".opc", "runs", "run-e", "task.json");
    expect(fs.existsSync(tp)).toBe(true); // 两后端都必须照写(证据契约)
    const onDisk = JSON.parse(fs.readFileSync(tp, "utf-8"));
    expect(onDisk.userGoal).toBe("证据目标");
    expect(onDisk.status).toBe("done");
    expect(onDisk.totalTokens).toBe(77);
    expect(run(() => loadRunTask(root, "run-e"))?.status).toBe("done");
  });
});
describe("agents first-run initialization [backend=sqlite]", () => {
  it("uses caller defaults only when the SQLite store has never been initialized", () => {
    const root = mkRoot();
    const fallback = [A("default-ceo", "default", { role: "ceo" })];
    expect(withBackend("sqlite", () => loadAgents(root, fallback))).toEqual(fallback);
  });

  it("does not resurrect defaults after an explicit empty organization was saved", () => {
    const root = mkRoot();
    const fallback = [A("default-ceo", "default", { role: "ceo" })];
    withBackend("sqlite", () => saveAgents(root, []));
    expect(withBackend("sqlite", () => loadAgents(root, fallback))).toEqual([]);
  });
});
