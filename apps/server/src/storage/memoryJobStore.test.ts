import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createMemoryJob, updateMemoryJob, getMemoryJob, loadMemoryJobs, isValidMemoryJobTransition,
} from "./memoryJobStore.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mem-job-"));
  fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
});

describe("D4 · memoryJobStore(import/export job 状态机,轻量)", () => {
  it("createMemoryJob:落盘,初始态 queued", () => {
    const job = createMemoryJob(root, { kind: "export", companyId: "c1" });
    expect(job.status).toBe("queued");
    expect(loadMemoryJobs(root)).toHaveLength(1);
    expect(getMemoryJob(root, job.jobId)?.jobId).toBe(job.jobId);
  });

  it("updateMemoryJob:queued → validating → processing → completed,依次落盘且 updatedAt 刷新", () => {
    const job = createMemoryJob(root, { kind: "import", companyId: "c1", memoryImportMode: "structure-sop" }, "2026-07-08T00:00:00.000Z");
    updateMemoryJob(root, job.jobId, { status: "validating" }, "2026-07-08T00:00:01.000Z");
    updateMemoryJob(root, job.jobId, { status: "processing" }, "2026-07-08T00:00:02.000Z");
    const done = updateMemoryJob(root, job.jobId, { status: "completed", result: { imported: 3, skipped: 0 } }, "2026-07-08T00:00:03.000Z");
    expect(done?.status).toBe("completed");
    expect(done?.result).toEqual({ imported: 3, skipped: 0 });
    expect(done?.updatedAt).toBe("2026-07-08T00:00:03.000Z");
    expect(done?.createdAt).toBe("2026-07-08T00:00:00.000Z"); // createdAt 不随 update 变
  });

  it("失败路径:落 failed + error 原因", () => {
    const job = createMemoryJob(root, { kind: "import" });
    const failed = updateMemoryJob(root, job.jobId, { status: "failed", error: "bundle 校验失败" });
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("bundle 校验失败");
  });

  it("updateMemoryJob:不存在的 jobId → 返回 undefined,不抛异常", () => {
    expect(updateMemoryJob(root, "no-such-job", { status: "completed" })).toBeUndefined();
  });

  it("isValidMemoryJobTransition:合法后继 true;非法(如 completed→processing)false", () => {
    expect(isValidMemoryJobTransition("queued", "validating")).toBe(true);
    expect(isValidMemoryJobTransition("validating", "processing")).toBe(true);
    expect(isValidMemoryJobTransition("processing", "completed")).toBe(true);
    expect(isValidMemoryJobTransition("completed", "processing")).toBe(false);
    expect(isValidMemoryJobTransition("failed", "completed")).toBe(false);
  });

  it("新的 job 排在最前(loadMemoryJobs 倒序,同 installTransactionStore 惯例)", () => {
    createMemoryJob(root, { kind: "export" }, "2026-07-08T00:00:00.000Z");
    const second = createMemoryJob(root, { kind: "import" }, "2026-07-08T00:00:01.000Z");
    expect(loadMemoryJobs(root)[0].jobId).toBe(second.jobId);
  });
});
