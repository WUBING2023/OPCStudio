import { killProcessTree } from "./processUtils.js";

// E4 · L3 最小集之 pid registry:L3 run 的引擎子进程 pid 登记,run 结束清理,支持按 runId kill
// (复用 processUtils.killProcessTree,杀整进程树)。
//
// 设计:纯内存(pid 跨进程重启本就失效,持久化只会积累脏数据)。orchestrator 在 startRun 判到
// L3 时 setPidRegistryRun(runId) 打开登记窗口,run 结束(finally)关闭并清理;非 L3 run 全程
// activeRunId=null → registerPid 是 no-op,零开销零行为变化。spawn 点(hermesBridge/cliEngineBase)
// 只管无脑上报 register/unregister,是否入册由这里的开关决定。

const pidsByRun = new Map<string, Set<number>>();
let activeRunId: string | null = null;

export function setPidRegistryRun(runId: string | null): void {
  if (runId && activeRunId && activeRunId !== runId) {
    // 防御断言:单 activeRunId 与"单 run 互斥"强耦合——上一窗口未关就切新 run 意味着互斥被打破
    // 或 finally 清理缺失。不吞状态(旧 run 的登记仍可按 runId kill),留警告可追查。
    console.warn(`[pidRegistry] run ${activeRunId} 的 pid 登记窗口未关闭就切换到 ${runId}(残留 ${pidsByRun.get(activeRunId)?.size ?? 0} 个已登记 pid)`);
  }
  activeRunId = runId;
  if (runId && !pidsByRun.has(runId)) pidsByRun.set(runId, new Set());
}

export function registerPid(pid: number | undefined): void {
  if (!activeRunId || pid == null) return;
  pidsByRun.get(activeRunId)?.add(pid);
}

export function unregisterPid(pid: number | undefined): void {
  if (!activeRunId || pid == null) return;
  pidsByRun.get(activeRunId)?.delete(pid);
}

export function listRunPids(runId: string): number[] {
  return [...(pidsByRun.get(runId) ?? [])];
}

export function clearRunPids(runId: string): void {
  pidsByRun.delete(runId);
  if (activeRunId === runId) activeRunId = null;
}

/** 按 runId 杀掉全部已登记子进程(整进程树)。返回实际尝试 kill 的 pid 清单。 */
export function killRunPids(runId: string): number[] {
  const pids = listRunPids(runId);
  for (const pid of pids) {
    killProcessTree(pid, () => { /* 无 ChildProcess 句柄可 prod;taskkill /T /F 已覆盖整树 */ });
  }
  pidsByRun.get(runId)?.clear();
  return pids;
}
