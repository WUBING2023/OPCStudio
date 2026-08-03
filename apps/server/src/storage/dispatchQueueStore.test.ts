import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  enqueueDispatch, dequeueDispatch, removeDispatchItem, listDispatchQueue, queuePositionOf,
  DISPATCH_QUEUE_VERSION, type DispatchQueueItem,
} from "./dispatchQueueStore.js";
import { readJSON } from "./jsonFile.js";
import { closeAllDbs } from "./sqlite/db.js";
import { openBusinessDb, readAllDocs } from "./sqlite/docTableBackend.js";

// P1-5 dispatchQueueStore 单测(战役B·Phase B2a 补齐 + 参数化双后端)。同一套行为断言在 json 与 sqlite
// 后端各跑一遍验证等价;sqlite 分支另验双写后 JSON 文件与 SQLite 表读全量一致。绝不碰真实 .opc。

const BACKENDS = ["json", "sqlite"] as const;
let root = "";
let prevEnv: string | undefined;

function setBackend(b: string): void {
  prevEnv = process.env.OPC_STORAGE_BACKEND;
  process.env.OPC_STORAGE_BACKEND = b;
}
function restoreEnv(): void {
  if (prevEnv === undefined) delete process.env.OPC_STORAGE_BACKEND;
  else process.env.OPC_STORAGE_BACKEND = prevEnv;
}

function mkItem(id: string, runId: string): DispatchQueueItem {
  return { id, runId, goal: `目标 ${id}`, companyId: "c1", enqueuedAt: `2026-07-10T00:00:0${id.slice(-1)}.000Z` };
}

describe.each(BACKENDS)("dispatchQueueStore [backend=%s]", (backend) => {
  beforeEach(() => {
    setBackend(backend);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => {
    closeAllDbs();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    restoreEnv();
  });

  it("空队列:list=[]、dequeue=null、position=-1", () => {
    expect(listDispatchQueue(root)).toEqual([]);
    expect(dequeueDispatch(root)).toBeNull();
    expect(queuePositionOf(root, "nope")).toBe(-1);
  });

  it("enqueue 尾部 + FIFO 顺序 + 位次", () => {
    enqueueDispatch(root, mkItem("q1", "r1"));
    enqueueDispatch(root, mkItem("q2", "r2"));
    expect(listDispatchQueue(root).map((i) => i.id)).toEqual(["q1", "q2"]);
    expect(queuePositionOf(root, "r1")).toBe(1);
    expect(queuePositionOf(root, "r2")).toBe(2);
  });

  it("enqueue 幂等:同 runId 不重复入队", () => {
    enqueueDispatch(root, mkItem("q1", "r1"));
    enqueueDispatch(root, mkItem("q1b", "r1")); // 同 runId
    expect(listDispatchQueue(root).map((i) => i.id)).toEqual(["q1"]);
  });

  it("dequeue 取队首并落盘", () => {
    enqueueDispatch(root, mkItem("q1", "r1"));
    enqueueDispatch(root, mkItem("q2", "r2"));
    const next = dequeueDispatch(root);
    expect(next?.id).toBe("q1");
    expect(listDispatchQueue(root).map((i) => i.id)).toEqual(["q2"]);
  });

  it("removeDispatchItem 按队列项 id 或 runId 撤单", () => {
    enqueueDispatch(root, mkItem("q1", "r1"));
    enqueueDispatch(root, mkItem("q2", "r2"));
    enqueueDispatch(root, mkItem("q3", "r3"));
    expect(removeDispatchItem(root, "q2")?.id).toBe("q2");     // 按队列项 id
    expect(removeDispatchItem(root, "r3")?.runId).toBe("r3");  // 按 runId
    expect(listDispatchQueue(root).map((i) => i.id)).toEqual(["q1"]);
    expect(removeDispatchItem(root, "nope")).toBeNull();
  });
});

// sqlite 专项:双写后 SQLite 表读 == JSON 文件读(全量一致)。
describe("dispatchQueueStore · 双写一致(sqlite)", () => {
  beforeEach(() => {
    setBackend("sqlite");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-dw-"));
    fs.mkdirSync(path.join(root, ".opc"), { recursive: true });
  });
  afterEach(() => {
    closeAllDbs();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
    restoreEnv();
  });

  it("enqueue/dequeue 后:JSON 文件 items 与 SQLite dispatch_queue 表逐条一致", () => {
    enqueueDispatch(root, mkItem("q1", "r1"));
    enqueueDispatch(root, mkItem("q2", "r2"));
    dequeueDispatch(root);
    enqueueDispatch(root, mkItem("q3", "r3"));

    const jsonFile = readJSON<{ v: number; items: DispatchQueueItem[] }>(path.join(root, ".opc", "dispatch-queue.json"), { v: 0, items: [] });
    const sqliteItems = readAllDocs(openBusinessDb(root), "dispatch_queue") as DispatchQueueItem[];
    expect(jsonFile.v).toBe(DISPATCH_QUEUE_VERSION);
    expect(jsonFile.items).toEqual(sqliteItems);
    expect(sqliteItems.map((i) => i.id)).toEqual(["q2", "q3"]);
  });
});
