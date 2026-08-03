import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import type { MemoryImportMode } from "../runtime/memoryBundle.js";

// D4(要求 4)· import/export job 状态机(轻量)。指南要求 queued→validating→...→completed 的过程可
// 追踪,V0 阶段实际执行仍是**同步**的(不引入队列/worker 进程)——这里只是把"这次导出/导入经过了哪些
// 阶段、结果如何"记下来,供后续 UI 展示进度/历史(UI 接线本次不做,见 memoryJobStore.test.ts 顶注与
// 报告里的"诚实未做清单")。落盘姿势与 storage/installTransactionStore.ts 同款:整文件读写 + jsonFile
// 的原子写 + 数组新的在前、上限滚动淘汰。

const MAX_JOBS = 50;

export type MemoryJobKind = "export" | "import";
// queued:已创建,尚未开始;validating:正在做 schema/隐私/权限一类的前置校验;processing:正在实际
// 读写记忆数据;completed:成功结束;failed:中途出错(error 字段记原因)。
export type MemoryJobStatus = "queued" | "validating" | "processing" | "completed" | "failed";

export interface MemoryJobResult {
  recordCount?: number;        // export:导出的 memory.records 条数
  redactedFieldCount?: number; // export:脱敏命中的记录条数
  requiredSecretCount?: number;// export:推导出的 required_secrets 条数
  totalRecords?: number;       // import:过滤前的记录总数
  filteredRecords?: number;    // import:按 memoryImportMode 过滤后参与导入的条数
  imported?: number;           // import:实际写回成功的条数
  skipped?: number;            // import:写回失败/被跳过的条数
}

export interface MemoryJobRecord {
  jobId: string;
  kind: MemoryJobKind;
  companyId?: string;
  bundleId?: string;
  memoryImportMode?: MemoryImportMode; // import only
  status: MemoryJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: MemoryJobResult;
  error?: string;
}

const jobsPath = (root: string) => path.join(root, ".opc", "memory-jobs.json");

// 战役B·Phase B2a:接后端开关。默认 json 逐字节不变;sqlite 时读走 memory_jobs 表(权威)、
// 写【双写】(JSON 照写 + 全量重写),整数组覆盖 + 上限 50 语义与 JSON 一致。
export function loadMemoryJobs(root: string): MemoryJobRecord[] {
  if (isSqliteBackend(root)) {
    return readAllDocs(openBusinessDb(root), "memory_jobs") as MemoryJobRecord[];
  }
  const arr = readJSON<MemoryJobRecord[]>(jobsPath(root), []);
  return Array.isArray(arr) ? arr : [];
}

function saveMemoryJobs(root: string, jobs: MemoryJobRecord[]): void {
  const capped = jobs.slice(0, MAX_JOBS);
  writeJSON(jobsPath(root), capped);
  if (isSqliteBackend(root)) {
    replaceAllDocs(openBusinessDb(root), "memory_jobs", capped);
  }
}

export function createMemoryJob(
  root: string,
  input: { kind: MemoryJobKind; companyId?: string; bundleId?: string; memoryImportMode?: MemoryImportMode },
  nowIso: string = new Date().toISOString(),
): MemoryJobRecord {
  const job: MemoryJobRecord = { jobId: randomUUID(), status: "queued", createdAt: nowIso, updatedAt: nowIso, ...input };
  const all = loadMemoryJobs(root);
  all.unshift(job);
  saveMemoryJobs(root, all);
  return job;
}

export function updateMemoryJob(
  root: string,
  jobId: string,
  patch: Partial<Pick<MemoryJobRecord, "status" | "result" | "error">>,
  nowIso: string = new Date().toISOString(),
): MemoryJobRecord | undefined {
  const all = loadMemoryJobs(root);
  const idx = all.findIndex((j) => j.jobId === jobId);
  if (idx === -1) return undefined;
  all[idx] = { ...all[idx], ...patch, updatedAt: nowIso };
  saveMemoryJobs(root, all);
  return all[idx];
}

export function getMemoryJob(root: string, jobId: string): MemoryJobRecord | undefined {
  return loadMemoryJobs(root).find((j) => j.jobId === jobId);
}

// 状态机的合法后继(供调用方/单测校验,不在 updateMemoryJob 里强制——V0 允许调用方按需跳过
// validating 直接 processing,保持宽松,不为了"状态机严谨"而挡住简单场景)。
export const MEMORY_JOB_TRANSITIONS: Record<MemoryJobStatus, MemoryJobStatus[]> = {
  queued: ["validating", "processing", "completed", "failed"],
  validating: ["processing", "completed", "failed"],
  processing: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function isValidMemoryJobTransition(from: MemoryJobStatus, to: MemoryJobStatus): boolean {
  return MEMORY_JOB_TRANSITIONS[from]?.includes(to) ?? false;
}
