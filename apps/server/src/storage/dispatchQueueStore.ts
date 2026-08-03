import * as path from "node:path";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";

// P1-5 · 派发队列(单 run 互斥不再直接抛错,撞忙则入此持久化队列)。落盘 .opc/dispatch-queue.json,
// 经 jsonFile 原子写。带 v 字段:未来结构演进时可据此迁移(现仅 v=1)。FIFO:先入先出,run 结束
// 自动出队派发下一单;进程重启后队列仍在盘上,由 startupReconcile 恢复派发。
//
// 战役B·Phase B2a:接后端开关(仅内部 load/save 原语切换,全部公开函数经它俩自动生效)。默认 json
// 逐字节不变;sqlite 时读走 dispatch_queue 表(items 拆行,v 由常量兜回),写【双写】(JSON 照写 + 全量重写)。

export const DISPATCH_QUEUE_VERSION = 1;

export interface DispatchQueueItem {
  id: string;              // 队列项 id(DELETE 撤单用,与 runId 区分:一个队列项唯一对应一个待派 run)
  runId: string;           // 预建 run 的 id(入队时已 precreateRunTask,故任务列表能看到"排队中"占位)
  goal: string;
  companyId?: string;
  runType?: "quick" | "team";
  teamMode?: "economy" | "balanced" | "maxQuality";
  targetAgentId?: string;
  enqueuedAt: string;
}

interface DispatchQueueFile {
  v: number;
  items: DispatchQueueItem[];
}

function queuePath(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "dispatch-queue.json");
}

function load(projectRoot: string): DispatchQueueFile {
  if (isSqliteBackend(projectRoot)) {
    const items = readAllDocs(openBusinessDb(projectRoot), "dispatch_queue") as DispatchQueueItem[];
    return { v: DISPATCH_QUEUE_VERSION, items };
  }
  const raw = readJSON<DispatchQueueFile>(queuePath(projectRoot), { v: DISPATCH_QUEUE_VERSION, items: [] });
  if (!raw || !Array.isArray(raw.items)) return { v: DISPATCH_QUEUE_VERSION, items: [] };
  return { v: typeof raw.v === "number" ? raw.v : DISPATCH_QUEUE_VERSION, items: raw.items };
}

function save(projectRoot: string, items: DispatchQueueItem[]): void {
  writeJSON(queuePath(projectRoot), { v: DISPATCH_QUEUE_VERSION, items } satisfies DispatchQueueFile);
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "dispatch_queue", items);
  }
}

/** 当前队列快照(FIFO 顺序;下标 0 是队首)。 */
export function listDispatchQueue(projectRoot: string): DispatchQueueItem[] {
  return load(projectRoot).items;
}

/** 入队(尾部)。幂等:同 runId 已在队列则不重复入队(重复 approve / 重试不制造重复项)。返回入队后的完整队列。 */
export function enqueueDispatch(projectRoot: string, item: DispatchQueueItem): DispatchQueueItem[] {
  const items = load(projectRoot).items;
  if (items.some((i) => i.runId === item.runId)) return items;
  items.push(item);
  save(projectRoot, items);
  return items;
}

/** 出队队首(移除并返回);空队列返回 null(不写盘)。 */
export function dequeueDispatch(projectRoot: string): DispatchQueueItem | null {
  const items = load(projectRoot).items;
  const next = items.shift();
  if (!next) return null;
  save(projectRoot, items);
  return next;
}

/** 按队列项 id(或 runId)撤单;命中返回被移除项,否则 null。 */
export function removeDispatchItem(projectRoot: string, idOrRunId: string): DispatchQueueItem | null {
  const items = load(projectRoot).items;
  const idx = items.findIndex((i) => i.id === idOrRunId || i.runId === idOrRunId);
  if (idx < 0) return null;
  const [removed] = items.splice(idx, 1);
  save(projectRoot, items);
  return removed;
}

/** runId 在队列中的位次(1 基;队首=1);不在队列返回 -1。 */
export function queuePositionOf(projectRoot: string, runId: string): number {
  const idx = load(projectRoot).items.findIndex((i) => i.runId === runId);
  return idx < 0 ? -1 : idx + 1;
}
