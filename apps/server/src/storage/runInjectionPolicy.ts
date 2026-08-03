import * as fs from "node:fs";
import * as path from "node:path";

// ── 收口作战令一.2 · excluded-run 注入策略(无状态共享 policy 模块)──────────────────────
//
// 判定"某条记忆的源 run 是否被排除在 prompt 注入之外"的唯一真相源。此前该逻辑住在
// runtime/committedMemoryRetriever.ts,storage/memoryStore.ts 反向 import runtime 层——依赖方向
// 违例(storage 应是最底层)。提取到 storage 层无状态模块后:runtime 与 storage 都从这里取,
// committedMemoryRetriever 保留同名 re-export(既有 import 面不破)。
//
// 语义(与提取前逐字一致,勿漂移):
// - 失败/降级 run 产出的记忆绝不自动注入下一个 run 的 prompt(不造假宪法:没干成的 run 的"经验"
//   未经人审不得复用)。判定源 = 该 run 目录 task.json 的 status/degraded。
// - simulated run:mock 引擎 run 的 task.json 由波1 statusa 语义落 simulated 标记;其记忆同样不可注入
//   (structured 标记见 runtimeContract;这里按 task.json 的 simulated===true 判)。
// - 向后兼容:无 task.json / 解析失败 → 不隔离(返回 false),既有仅有 committed-memories.json 的
//   run/测试不受影响。runId 缺失 → 无法判定 → 按"不隔离"处理。
// - 注入路径才隔离;展示/待批路径(listAll*)不隔离——失败结论仍可见可审。
export function runExcludedFromInjection(runsDir: string, runId: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(runsDir, runId, "task.json"), "utf-8");
    const t = JSON.parse(raw) as {
      status?: unknown;
      degraded?: unknown;
      simulated?: unknown;
      executorDegraded?: unknown;
      partialDelivery?: unknown;
      evidenceIntegrity?: unknown;
      finalState?: unknown;
    };
    if (t?.status !== "done") return true;
    if (t.degraded === true || t.simulated === true || t.executorDegraded === true || t.partialDelivery === true) return true;
    if (t.evidenceIntegrity === "degraded") return true;
    if (t.finalState !== undefined && t.finalState !== "verified") return true;
    return false;
  } catch {
    // A missing or malformed task cannot prove a durable, clean completion.
    return true;
  }
}

// projectRoot 口径包装:记忆页/检索侧统一用它,保证"这条会不会进 prompt"的标注与注入侧一致。
export function isFromExcludedRun(projectRoot: string, runId: string | undefined): boolean {
  if (!runId) return false;
  return runExcludedFromInjection(path.join(projectRoot, ".opc", "runs"), runId);
}
