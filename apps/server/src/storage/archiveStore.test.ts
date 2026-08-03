import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  archiveCompany, archiveRuns, restoreArchive, listArchives, getArchiveManifest,
  copyVerifyThenRemove, verifyCopiedBytes,
  ArchiveConflictError, ArchiveNotFoundError,
} from "./archiveStore.js";
import { loadAgents, loadRunIndex, mergeSaveAgents, saveAgents, createRun } from "./projectStore.js";
import { loadCompanies, saveCompanies } from "./companyStore.js";
import { closeAllDbs } from "./sqlite/db.js";
import type { Run } from "@opc/shared";

// 战役B·Phase B2b:参数化双后端各跑一遍。setup/writeRun 经 store 函数写(双写填充 sqlite 表);
// 全部用 mkdtemp 临时根,绝不触碰真实 .opc。

let root: string;

function writeRun(runId: string, status: string, companyId?: string, extraFiles: Record<string, string> = {}): void {
  createRun(root, {
    id: runId, userGoal: `goal of ${runId}`, status,
    startedAt: "2026-07-01T00:00:00.000Z", participatingAgents: [],
    totalTokens: 0, ...(companyId ? { companyId } : {}),
  } as unknown as Run);
  const dir = path.join(root, ".opc", "runs", runId);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
  }
}

function setup(): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "archive-store-"));
  fs.mkdirSync(path.join(root, ".opc", "runs"), { recursive: true });
  saveCompanies(root, [
    { id: "default", name: "默认公司", createdAt: "2026-01-01" },
    { id: "c1", name: "测试公司甲", createdAt: "2026-01-02", ceoId: "c1-ceo" },
  ] as any);
  saveAgents(root, [
    { id: "ceo-1", name: "老板", role: "ceo", companyId: "default", provider: "deepseek", model: "x", framework: "hermes", childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
    { id: "c1-ceo", name: "甲CEO", role: "ceo", companyId: "c1", provider: "deepseek", model: "x", framework: "hermes", childrenIds: ["c1-dev"], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
    { id: "c1-dev", name: "甲开发", role: "dev", companyId: "c1", parentId: "c1-ceo", provider: "deepseek", model: "x", framework: "hermes", childrenIds: [], status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0 },
  ] as any);
}

const BACKENDS = ["json", "sqlite"] as const;

describe.each(BACKENDS)("archiveStore [backend=%s]", (backend) => {
  beforeEach(() => { process.env.OPC_STORAGE_BACKEND = backend; setup(); });
  afterEach(() => {
    closeAllDbs();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    delete process.env.OPC_STORAGE_BACKEND;
  });

  describe("archiveCompany", () => {
    it("公司条目/agents/关联 run 一并移入归档,manifest 完整,状态文件同步", () => {
      writeRun("run-c1-000000000001", "done", "c1", { "report.md": "# 甲的报告" });
      writeRun("run-def-00000000001", "done", "default");

      const manifest = archiveCompany(root, "c1");

      expect(manifest.kind).toBe("company");
      expect(manifest.id).toBe("c1");
      expect(manifest.name).toBe("测试公司甲");
      expect(manifest.agents.map((a) => a.id).sort()).toEqual(["c1-ceo", "c1-dev"]);
      expect(manifest.runIds).toEqual(["run-c1-000000000001"]);
      expect(manifest.company?.id).toBe("c1");
      expect(manifest.originalPaths["company-c1/runs/run-c1-000000000001"]).toBe(".opc/runs/run-c1-000000000001");
      expect(manifest.runIndexEntries["run-c1-000000000001"]?.status).toBe("done");

      const archivedRun = path.join(root, ".opc", "archive", manifest.archiveId, "company-c1", "runs", "run-c1-000000000001");
      expect(fs.existsSync(archivedRun)).toBe(true);
      expect(fs.readFileSync(path.join(archivedRun, "report.md"), "utf-8")).toBe("# 甲的报告");
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-c1-000000000001"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-def-00000000001"))).toBe(true);

      expect(loadCompanies(root).map((c) => c.id)).toEqual(["default"]);
      expect(loadAgents(root, []).map((a) => a.id)).toEqual(["ceo-1"]);
      expect(loadRunIndex(root).map((e) => e.id)).toEqual(["run-def-00000000001"]);

      const onDisk = getArchiveManifest(root, manifest.archiveId);
      expect(onDisk?.id).toBe("c1");
    });

    it("mergeSaveAgents 的合并语义本身不会救场——归档后拿过期全量内存直接 merge 会复活(这正是路由必须同步内存的原因)", () => {
      const staleInMemory = loadAgents(root, []); // 归档前的全量内存快照
      archiveCompany(root, "c1");
      expect(loadAgents(root, []).map((a) => a.id)).toEqual(["ceo-1"]);
      mergeSaveAgents(root, staleInMemory); // 模拟 orchestrator 内存未同步时的下一次存盘
      expect(loadAgents(root, []).map((a) => a.id).sort()).toEqual(["c1-ceo", "c1-dev", "ceo-1"]);
    });

    it("默认公司不可归档;不存在的公司 404 语义", () => {
      expect(() => archiveCompany(root, "default")).toThrow(ArchiveConflictError);
      expect(() => archiveCompany(root, "nope")).toThrow(ArchiveNotFoundError);
    });

    it("公司有在飞 run(running/pending)时拒绝归档,文件原样不动", () => {
      writeRun("run-c1-000000000009", "running", "c1");
      expect(() => archiveCompany(root, "c1")).toThrow(ArchiveConflictError);
      expect(loadCompanies(root).map((c) => c.id)).toContain("c1");
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-c1-000000000009"))).toBe(true);
    });
  });

  describe("archiveRuns", () => {
    it("run 目录移入归档,索引同步移除,manifest 记录索引条目", () => {
      writeRun("run-a-000000000001", "done", "default");
      writeRun("run-b-000000000002", "failed", "default");
      writeRun("run-keep-0000000003", "done", "default");
      loadRunIndex(root);

      const manifest = archiveRuns(root, ["run-a-000000000001", "run-b-000000000002"]);

      expect(manifest.kind).toBe("runs");
      expect(manifest.runIds.sort()).toEqual(["run-a-000000000001", "run-b-000000000002"]);
      expect(fs.existsSync(path.join(root, ".opc", "archive", manifest.archiveId, "runs", "run-a-000000000001", "task.json"))).toBe(true);
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-a-000000000001"))).toBe(false);
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-keep-0000000003"))).toBe(true);
      expect(loadRunIndex(root).map((e) => e.id)).toEqual(["run-keep-0000000003"]);
    });

    it("目标含 running run → 409 语义拒绝;不存在的 run → 404 语义;空数组报错", () => {
      writeRun("run-live-0000000001", "running", "default");
      writeRun("run-done-0000000002", "done", "default");
      expect(() => archiveRuns(root, ["run-live-0000000001", "run-done-0000000002"])).toThrow(ArchiveConflictError);
      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-done-0000000002"))).toBe(true);
      expect(() => archiveRuns(root, ["run-missing-0000001"])).toThrow(ArchiveNotFoundError);
      expect(() => archiveRuns(root, [])).toThrow();
    });

    it("无 task.json 的破损 run 目录也能归档(索引里没有它,状态不阻塞)", () => {
      const broken = path.join(root, ".opc", "runs", "broken-dir-0000001");
      fs.mkdirSync(broken, { recursive: true });
      fs.writeFileSync(path.join(broken, "events.jsonl"), "{}", "utf-8");
      const manifest = archiveRuns(root, ["broken-dir-0000001"]);
      expect(fs.existsSync(path.join(root, ".opc", "archive", manifest.archiveId, "runs", "broken-dir-0000001", "events.jsonl"))).toBe(true);
      expect(fs.existsSync(broken)).toBe(false);
    });
  });

  describe("restoreArchive", () => {
    it("公司归档按 manifest 原样移回:公司/员工/run 目录/索引全部还原", () => {
      writeRun("run-c1-000000000001", "done", "c1", { "report.md": "证据" });
      const { archiveId } = archiveCompany(root, "c1");

      const restored = restoreArchive(root, archiveId);

      expect(restored.restoredAt).toBeTruthy();
      expect(loadCompanies(root).map((c) => c.id).sort()).toEqual(["c1", "default"]);
      expect(loadAgents(root, []).map((a) => a.id).sort()).toEqual(["c1-ceo", "c1-dev", "ceo-1"]);
      const runDir = path.join(root, ".opc", "runs", "run-c1-000000000001");
      expect(fs.readFileSync(path.join(runDir, "report.md"), "utf-8")).toBe("证据");
      expect(loadRunIndex(root).some((e) => e.id === "run-c1-000000000001" && e.companyId === "c1")).toBe(true);
      expect(getArchiveManifest(root, archiveId)?.restoredAt).toBeTruthy();
      expect(() => restoreArchive(root, archiveId)).toThrow(ArchiveConflictError);
    });

    it("run 归档恢复:目录移回 + 索引条目写回", () => {
      writeRun("run-a-000000000001", "done", "default");
      loadRunIndex(root);
      const { archiveId } = archiveRuns(root, ["run-a-000000000001"]);
      expect(loadRunIndex(root).some((e) => e.id === "run-a-000000000001")).toBe(false);

      restoreArchive(root, archiveId);

      expect(fs.existsSync(path.join(root, ".opc", "runs", "run-a-000000000001", "task.json"))).toBe(true);
      expect(loadRunIndex(root).some((e) => e.id === "run-a-000000000001")).toBe(true);
    });

    it("冲突时报错不覆盖:同 id run 已重建 → 整体中止,现有数据原样", () => {
      writeRun("run-a-000000000001", "done", "default");
      const { archiveId } = archiveRuns(root, ["run-a-000000000001"]);
      writeRun("run-a-000000000001", "done", "default", { "report.md": "新数据" });

      expect(() => restoreArchive(root, archiveId)).toThrow(ArchiveConflictError);
      expect(fs.readFileSync(path.join(root, ".opc", "runs", "run-a-000000000001", "report.md"), "utf-8")).toBe("新数据");
      expect(fs.existsSync(path.join(root, ".opc", "archive", archiveId, "runs", "run-a-000000000001", "task.json"))).toBe(true);
    });

    it("不存在的归档 → 404 语义", () => {
      expect(() => restoreArchive(root, "no-such-archive")).toThrow(ArchiveNotFoundError);
    });
  });

  describe("listArchives", () => {
    it("按归档时间倒序列出,含条目计数与恢复标记", () => {
      writeRun("run-a-000000000001", "done", "default");
      writeRun("run-c1-000000000002", "done", "c1");
      const first = archiveRuns(root, ["run-a-000000000001"]);
      const second = archiveCompany(root, "c1");

      let items = listArchives(root);
      expect(items.length).toBe(2);
      expect(items.map((i) => i.archiveId)).toContain(first.archiveId);
      const companyItem = items.find((i) => i.archiveId === second.archiveId);
      expect(companyItem?.kind).toBe("company");
      expect(companyItem?.name).toBe("测试公司甲");
      expect(companyItem?.agentCount).toBe(2);
      expect(companyItem?.runCount).toBe(1);

      restoreArchive(root, first.archiveId);
      items = listArchives(root);
      expect(items.find((i) => i.archiveId === first.archiveId)?.restoredAt).toBeTruthy();
    });

    it("无归档目录时返回空数组", () => {
      expect(listArchives(root)).toEqual([]);
    });
  });
});

// 跨盘 fallback:纯 fs 逻辑,后端无关,单跑一遍。
describe("跨盘 fallback(copy → 字节校验 → 删源)", () => {
  let r: string;
  beforeEach(() => { r = fs.mkdtempSync(path.join(os.tmpdir(), "archive-xdev-")); });
  afterEach(() => { try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* */ } });

  it("copyVerifyThenRemove:内容逐字节数搬运,校验通过后源才消失", () => {
    const src = path.join(r, "xdev-src");
    fs.mkdirSync(path.join(src, "sub"), { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "hello", "utf-8");
    fs.writeFileSync(path.join(src, "sub", "b.json"), "{\"k\":1}", "utf-8");
    const dest = path.join(r, "xdev-dest");

    copyVerifyThenRemove(src, dest);

    expect(fs.readFileSync(path.join(dest, "a.txt"), "utf-8")).toBe("hello");
    expect(fs.readFileSync(path.join(dest, "sub", "b.json"), "utf-8")).toBe("{\"k\":1}");
    expect(fs.existsSync(src)).toBe(false);
  });

  it("verifyCopiedBytes:目标缺文件/字节数不一致时抛错(调用方绝不删源)", () => {
    const src = path.join(r, "v-src");
    const dest = path.join(r, "v-dest");
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(src, "a.txt"), "hello", "utf-8");
    expect(() => verifyCopiedBytes(src, dest)).toThrow(/副本校验失败/);
    fs.writeFileSync(path.join(dest, "a.txt"), "hell", "utf-8"); // 少一个字节
    expect(() => verifyCopiedBytes(src, dest)).toThrow(/字节数不一致/);
  });
});
