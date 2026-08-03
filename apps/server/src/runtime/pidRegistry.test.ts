// E4 · pid registry 单测:登记窗口开关(非 L3 run 全程 no-op)/按 runId kill/run 结束清理。
// 镜像 processUtils.test.ts 的姿势 mock node:child_process,绝不真的 taskkill。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

import { spawnSync } from "node:child_process";
import { setPidRegistryRun, registerPid, unregisterPid, listRunPids, clearRunPids, killRunPids } from "./pidRegistry.js";

beforeEach(() => {
  setPidRegistryRun(null);
});
afterEach(() => {
  clearRunPids("run-a");
  clearRunPids("run-b");
  vi.resetAllMocks();
});

describe("pidRegistry — 登记窗口", () => {
  it("窗口关闭(非 L3 run)时 registerPid 是 no-op", () => {
    registerPid(111);
    expect(listRunPids("run-a")).toEqual([]);
  });

  it("窗口打开后登记归属该 run;unregister 移除;undefined pid 忽略", () => {
    setPidRegistryRun("run-a");
    registerPid(111);
    registerPid(222);
    registerPid(undefined);
    expect(listRunPids("run-a").sort()).toEqual([111, 222]);
    unregisterPid(111);
    expect(listRunPids("run-a")).toEqual([222]);
  });

  it("窗口切换后新登记归属新 run,旧 run 不再增长", () => {
    setPidRegistryRun("run-a");
    registerPid(111);
    setPidRegistryRun("run-b");
    registerPid(222);
    expect(listRunPids("run-a")).toEqual([111]);
    expect(listRunPids("run-b")).toEqual([222]);
  });

  it("clearRunPids 清空该 run 并关闭其窗口", () => {
    setPidRegistryRun("run-a");
    registerPid(111);
    clearRunPids("run-a");
    expect(listRunPids("run-a")).toEqual([]);
    registerPid(333); // 窗口已随 clear 关闭 → no-op
    expect(listRunPids("run-a")).toEqual([]);
  });
});

describe("pidRegistry — 窗口未关切换的防御断言(单 activeRunId 与单 run 互斥强耦合)", () => {
  it("上一 run 窗口未关就切新 run → console.warn 警告(含新旧 runId 与残留 pid 数),状态不吞", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setPidRegistryRun("run-a");
      registerPid(111);
      setPidRegistryRun("run-b");
      expect(warn).toHaveBeenCalledTimes(1);
      const msg = String(warn.mock.calls[0][0]);
      expect(msg).toContain("run-a");
      expect(msg).toContain("run-b");
      expect(msg).toContain("1 个已登记 pid");
      // 不吞状态:旧 run 的登记仍可按 runId 查/杀,新窗口正常工作
      expect(listRunPids("run-a")).toEqual([111]);
      registerPid(222);
      expect(listRunPids("run-b")).toEqual([222]);
    } finally {
      warn.mockRestore();
    }
  });

  it("正常生命周期(clearRunPids/置 null 关窗后再开、同 runId 重设)不告警", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      setPidRegistryRun("run-a");
      setPidRegistryRun("run-a");   // 同 runId 重设
      clearRunPids("run-a");        // 关窗
      setPidRegistryRun("run-b");   // 关窗后再开
      setPidRegistryRun(null);      // 显式关窗
      setPidRegistryRun("run-a");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("pidRegistry — killRunPids(复用 killProcessTree 杀整树)", () => {
  it("对每个登记 pid 走 taskkill /T /F(win32),返回清单并清空登记", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (spawnSync as ReturnType<typeof vi.fn>).mockReturnValue({ status: 0 });
    try {
      setPidRegistryRun("run-a");
      registerPid(111);
      registerPid(222);
      const killed = killRunPids("run-a");
      expect(killed.sort()).toEqual([111, 222]);
      expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "111", "/T", "/F"], expect.anything());
      expect(spawnSync).toHaveBeenCalledWith("taskkill", ["/PID", "222", "/T", "/F"], expect.anything());
      expect(listRunPids("run-a")).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
    }
  });

  it("无登记 pid 的 run → 返回空清单,不 spawn", () => {
    expect(killRunPids("run-b")).toEqual([]);
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
