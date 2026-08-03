import * as fs from "node:fs";
import * as path from "node:path";
import type { TaskGraph } from "@opc/shared";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadAgents, mergeSaveAgents, updateRunIndex } from "../storage/projectStore.js";
import { loadTaskGraphs, upsertTaskGraph } from "../storage/taskGraphStore.js";
import { listDispatchQueue } from "../storage/dispatchQueueStore.js";
import { drainDispatchQueue } from "./runMutex.js";

// P0#8:服务启动对账。进程重启前若有 run 卡在 status==="running",磁盘上会留下僵尸 run
// (再也不会被任何人置为 done/failed,占用 costSummary/runRoutes 里的"进行中"位)。
// 启动时不可能还有活 run(orchestrator 尚未 initOrchestrator),所以把它们统一改写为
// failed + degradedReason,单文件出错不影响其余文件与启动本身。
export function reconcileRunningTasksOnStartup(projectRoot: string): { reconciled: number } {
  const runsDir = path.join(projectRoot, ".opc", "runs");
  let reconciled = 0;
  const interruptedAgentIds = new Set<string>();
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(runsDir);
  } catch {
    dirs = []; // runs 目录不存在仍继续清理启动前遗留的瞬态 agent 投影
  }
  for (const dir of dirs) {
    const taskPath = path.join(runsDir, dir, "task.json");
    try {
      const task = readJSON<any>(taskPath, null);
      if (task?.status !== "running") continue;
      task.status = "failed";
      task.degradedReason = "进程重启，run 被中断";
      task.degraded = true;
      if (!task.endedAt) task.endedAt = new Date().toISOString();
      writeJSON(taskPath, task); // 原子写(P0#6 同规):对账本身绝不能把 task.json 写坏
      // P2#7:同步滚动索引,否则任务档案页上僵尸 run 状态陈旧
      updateRunIndex(projectRoot, { id: task.id ?? dir, status: "failed", degraded: true, degradedReason: task.degradedReason, endedAt: task.endedAt });
      for (const agentId of Array.isArray(task.participatingAgents) ? task.participatingAgents : []) {
        if (typeof agentId === "string" && agentId) interruptedAgentIds.add(agentId);
      }
      reconciled++;
    } catch {
      // best-effort：单个 run 的 task.json 缺失/损坏不影响其余 run 与服务启动
    }
  }
  // 这是启动期调用,此刻不可能存在本进程的活执行。旧版本可能已把 task 标成 failed 却未清 agent,
  // 因而不能只看本轮刚 reconcile 的参与者；所有瞬态工作状态都属于崩溃遗留。治理终态
  // (disabled/restricted/failed/done)不改，避免把真实能力问题伪装成 idle。
  try {
    const transient = new Set(["working", "waiting", "thinking", "using_tool", "reviewing", "waiting_review"]);
    const affected = loadAgents(projectRoot, []).filter(agent => transient.has(agent.status));
    for (const agent of affected) {
      agent.status = "idle";
      agent.currentTask = undefined;
      agent.lastAction = interruptedAgentIds.has(agent.id)
        ? "进程重启，所属任务已中断"
        : "进程重启，运行状态已复位";
    }
    if (affected.length > 0) mergeSaveAgents(projectRoot, affected);
  } catch {
    // Agent projection recovery is best-effort; run truth has already been made terminal above.
  }
  return { reconciled };
}

function clearLease(node: TaskGraph["nodes"][number]): void {
  delete node.leaseOwner;
  delete node.leaseExpiry;
}

function clearIncompleteAttempt(node: TaskGraph["nodes"][number]): void {
  delete node.runId;
  delete node.resultSummary;
  delete node.error;
  delete node.inputHash;
  delete node.idempotencyKey;
  delete node.startedReceipt;
  delete node.completionReceipt;
  node.artifactRefs = [];
  node.evidenceRefs = [];
  node.uncertain = false;
  clearLease(node);
}

// Recover from durable receipts instead of declaring the whole graph dead.
// Completed receipts are reusable, never-started nodes remain runnable, and a
// started side-effecting attempt without completion is quarantined as uncertain.
export function reconcileRunningTaskGraphsOnStartup(projectRoot: string): { reconciled: number } {
  let graphs: TaskGraph[];
  try {
    graphs = loadTaskGraphs(projectRoot);
  } catch {
    return { reconciled: 0 };
  }
  const now = new Date().toISOString();
  let reconciled = 0;
  for (const g of graphs) {
    if (g?.status !== "running") continue;
    let hasUncertain = false;
    for (const n of g.nodes ?? []) {
      n.schemaVersion = "2";
      n.attempt ??= 0;
      n.visit ??= 0;
      n.artifactRefs ??= [];
      n.evidenceRefs ??= [];

      if (n.completionReceipt) {
        const recovered = n.completionReceipt.status;
        const to = recovered === "accepted" ? "accepted"
          : recovered === "completed" ? "completed"
          : recovered === "cancelled" ? "cancelled"
          : "failed";
        if (n.status !== to) {
          n.status = to;
          n.statusHistory.push({ status: to, at: now, by: "startup-reconcile" });
        }
        n.uncertain = false;
        clearLease(n);
        continue;
      }

      if (n.startedReceipt || n.status === "running") {
        const sideEffectRisk = n.startedReceipt?.sideEffectRisk ?? true;
        if (sideEffectRisk) {
          n.uncertain = true;
          n.status = "blocked";
          n.error = "进程重启:节点已开始但没有完成回执,副作用状态不确定";
          n.statusHistory.push({ status: "blocked", at: now, by: "startup-reconcile" });
          clearLease(n);
          hasUncertain = true;
        } else {
          clearIncompleteAttempt(n);
          n.status = "pending";
          n.statusHistory.push({ status: "pending", at: now, by: "startup-reconcile" });
        }
        continue;
      }

      // planned/pending nodes were never dispatched and remain recoverable.
      if (n.status === "planned" || n.status === "pending") clearLease(n);
    }
    const allCompleted = g.nodes.every(n => n.status === "completed" || n.status === "accepted");
    g.status = hasUncertain ? "failed" : allCompleted ? "completed" : "committed";
    g.schemaVersion = "2";
    g.updatedAt = now;
    try {
      upsertTaskGraph(projectRoot, g);
      reconciled++;
    } catch {
      // A concurrent writer won the revision race; never overwrite newer state.
    }
  }
  return { reconciled };
}

// P1-5 · 派发队列启动恢复。撞忙入队的派发落盘 dispatch-queue.json,进程被杀后队列仍在盘上,但没有
// 任何路径会再派发它们(卡死)。启动时不可能有活 run(run 级对账已把僵尸 running 标 failed),故若队列
// 非空则出队派发队首;该 run 结束会经 orchestrator finally 自动派发下一单,整条队列由此依次恢复。
// 前提:协调器已接线(missionRoutes.register 里 configureDispatchCoordinator 之后调用本函数)。
export function resumeDispatchQueueOnStartup(projectRoot: string): { pending: number; resumed: boolean } {
  let pending = 0;
  try { pending = listDispatchQueue(projectRoot).length; } catch { return { pending: 0, resumed: false }; }
  if (pending === 0) return { pending: 0, resumed: false };
  const started = drainDispatchQueue(projectRoot);
  return { pending, resumed: !!started };
}
