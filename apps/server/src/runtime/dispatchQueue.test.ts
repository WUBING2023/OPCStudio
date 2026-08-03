import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureDispatchCoordinator, resetDispatchCoordinator, dispatchOrEnqueue, drainDispatchQueue,
  type DispatchQueueItem,
} from "./runMutex.js";
import {
  listDispatchQueue, enqueueDispatch, dequeueDispatch, removeDispatchItem, queuePositionOf,
} from "../storage/dispatchQueueStore.js";
import { resumeDispatchQueueOnStartup } from "./startupReconcile.js";

let root: string;

function mkitem(n: number): DispatchQueueItem {
  return { id: `q${n}`, runId: `r${n}`, goal: `目标 ${n}`, runType: "quick", enqueuedAt: new Date(2026, 0, n).toISOString() };
}

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-queue-")); });
afterEach(() => {
  resetDispatchCoordinator();
  if (root) try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ }
});

describe("dispatchQueueStore — FIFO 持久化队列", () => {
  it("入队/出队/位次/幂等/撤单,落盘带 v 字段", () => {
    enqueueDispatch(root, mkitem(1));
    enqueueDispatch(root, mkitem(2));
    enqueueDispatch(root, mkitem(1)); // 幂等:同 runId 不重复入队
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r1", "r2"]);
    expect(queuePositionOf(root, "r2")).toBe(2);
    expect(queuePositionOf(root, "nope")).toBe(-1);

    // 落盘经 jsonFile,带 v 字段
    const raw = JSON.parse(fs.readFileSync(path.join(root, ".opc", "dispatch-queue.json"), "utf-8"));
    expect(raw.v).toBe(1);
    expect(raw.items.length).toBe(2);

    // 出队队首(FIFO)
    expect(dequeueDispatch(root)?.runId).toBe("r1");
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r2"]);

    // 撤单:队列项 id 或 runId 都能命中;未命中返回 null
    enqueueDispatch(root, mkitem(3));
    expect(removeDispatchItem(root, "q3")?.runId).toBe("r3"); // 按队列项 id
    enqueueDispatch(root, mkitem(4));
    expect(removeDispatchItem(root, "r4")?.runId).toBe("r4"); // 按 runId
    expect(removeDispatchItem(root, "missing")).toBeNull();
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r2"]);

    // 空队列出队不写坏
    dequeueDispatch(root);
    expect(dequeueDispatch(root)).toBeNull();
    expect(listDispatchQueue(root)).toEqual([]);
  });
});

describe("派发协调器 — 连派3单→1跑2排队→run 结束依次自动派发", () => {
  it("撞忙入队,不再抛错;drain 逐单让路派发,有活 run 时 fail-safe 不丢单", () => {
    let inFlight = false;
    const started: string[] = [];
    configureDispatchCoordinator({
      isInFlight: () => inFlight,
      start: (item) => { inFlight = true; started.push(item.runId); }, // 起 run 即抢占单 run 互斥闸
    });

    const d1 = dispatchOrEnqueue(root, mkitem(1));
    const d2 = dispatchOrEnqueue(root, mkitem(2));
    const d3 = dispatchOrEnqueue(root, mkitem(3));
    expect(d1).toMatchObject({ started: true, queued: false, position: 0 });
    expect(d2).toMatchObject({ started: false, queued: true, position: 1 });
    expect(d3).toMatchObject({ started: false, queued: true, position: 2 });
    expect(started).toEqual(["r1"]);
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r2", "r3"]);

    // 有活 run 时 drain 不动队列(fail-safe:绝不在无人接手/仍占闸时 shift 掉队首丢单)
    expect(drainDispatchQueue(root)).toBeNull();
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r2", "r3"]);

    // r1 结束 → 释放互斥闸 → drain 派 r2
    inFlight = false;
    expect(drainDispatchQueue(root)?.runId).toBe("r2");
    expect(started).toEqual(["r1", "r2"]);
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r3"]);

    // r2 结束 → drain 派 r3,队列清空
    inFlight = false;
    expect(drainDispatchQueue(root)?.runId).toBe("r3");
    expect(started).toEqual(["r1", "r2", "r3"]);
    expect(listDispatchQueue(root)).toEqual([]);

    // 空队列 drain → no-op
    inFlight = false;
    expect(drainDispatchQueue(root)).toBeNull();
  });

  it("撤销队中单:移出队列,后续 drain 跳过它", () => {
    let inFlight = true; // 有活 run,三单全部入队
    const started: string[] = [];
    configureDispatchCoordinator({ isInFlight: () => inFlight, start: (i) => { inFlight = true; started.push(i.runId); } });

    dispatchOrEnqueue(root, mkitem(1));
    dispatchOrEnqueue(root, mkitem(2));
    dispatchOrEnqueue(root, mkitem(3));
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r1", "r2", "r3"]);

    expect(removeDispatchItem(root, "r2")?.runId).toBe("r2"); // 撤销队中的 r2
    inFlight = false; drainDispatchQueue(root); // 派 r1
    inFlight = false; drainDispatchQueue(root); // 派 r3(r2 已撤,直接跳过)
    inFlight = false; expect(drainDispatchQueue(root)).toBeNull();
    expect(started).toEqual(["r1", "r3"]);
  });
});

describe("resumeDispatchQueueOnStartup — 进程重启后恢复派发", () => {
  it("盘上遗留队列且无活 run → 出队派发队首,后续由 run 结束自动串起", () => {
    // 重启前:盘上已有排队(上个进程被杀,没有活 run)
    enqueueDispatch(root, mkitem(1));
    enqueueDispatch(root, mkitem(2));

    // 重启后:新进程重新接线协调器 + 恢复
    let inFlight = false;
    const started: string[] = [];
    configureDispatchCoordinator({ isInFlight: () => inFlight, start: (i) => { inFlight = true; started.push(i.runId); } });

    expect(resumeDispatchQueueOnStartup(root)).toMatchObject({ pending: 2, resumed: true });
    expect(started).toEqual(["r1"]);
    expect(listDispatchQueue(root).map(i => i.runId)).toEqual(["r2"]);

    // r1 结束 → drain 派 r2(串起整条队列)
    inFlight = false;
    drainDispatchQueue(root);
    expect(started).toEqual(["r1", "r2"]);
    expect(listDispatchQueue(root)).toEqual([]);
  });

  it("空队列恢复 → no-op", () => {
    configureDispatchCoordinator({ isInFlight: () => false, start: () => { /* */ } });
    expect(resumeDispatchQueueOnStartup(root)).toMatchObject({ pending: 0, resumed: false });
  });
});
