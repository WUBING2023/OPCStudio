// D3 · 复用验证回路存储 — append-only .opc/memory/reuse-log.jsonl。
// 记录「哪条记忆被注入进哪个 run 的哪个 agent 的 prompt × 该 run 的终态」——把"注入"与"结果"
// 关联成可观测事实(codex 修复方向2:记忆复用不可证)。只记录关联,不虚标 A/B 因果。
// 写入方:orchestrator run 收尾(injectedByAgent × run 终态);读取方:committedMemoryRetriever
// 的 outcome 加权 + GET /api/memory/reuse-stats(前端展示归 E 泳道)。
// Contract: NEVER throws——写失败静默放弃(best-effort),读失败/缺文件返回空。

import * as fs from "node:fs";
import * as path from "node:path";

export interface MemoryReuseEntry {
  runId: string;
  agentId: string;
  role?: string;
  memoryId: string;
  kind: string;       // InjectedMemoryRef.kind 同集:md_* / memory_entry / lesson / conclusion / procedural_skill / committed
  taskType?: string;
  runStatus: string;  // run 终态(done / failed)
  degraded: boolean;  // run.degraded || run.executorDegraded(非纯净成功)
  at: string;         // ISO 时间
}

// 聚合统计(run 粒度去重:同一 run 里多个 agent 注入同一条记忆只计一次,三个计数单位一致)。
export interface MemoryReuseStat {
  injected: number;   // 被注入过的 run 数(distinct runId)
  cleanRuns: number;  // 其中干净成功的 run 数(runStatus==="done" 且非 degraded;同 run 冲突时失败优先)
  failedRuns: number; // 其中失败/降级的 run 数(runStatus==="failed" 或 degraded)
}

function reuseLogFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "memory", "reuse-log.jsonl");
}

export function appendReuseOutcomes(projectRoot: string, entries: MemoryReuseEntry[]): void {
  try {
    if (!projectRoot || entries.length === 0) return;
    const file = reuseLogFile(projectRoot);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
  } catch { /* best-effort:复用日志写失败绝不影响 run 收尾 */ }
}

export function loadReuseStats(projectRoot: string): Map<string, MemoryReuseStat> {
  const out = new Map<string, MemoryReuseStat>();
  try {
    if (!projectRoot) return out;
    const file = reuseLogFile(projectRoot);
    if (!fs.existsSync(file)) return out;
    const agg = new Map<string, { runs: Set<string>; clean: Set<string>; failed: Set<string> }>();
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let e: MemoryReuseEntry;
      try { e = JSON.parse(t) as MemoryReuseEntry; } catch { continue; } // 坏行跳过,不拖垮整读
      if (typeof e?.memoryId !== "string" || !e.memoryId || typeof e?.runId !== "string" || !e.runId) continue;
      let a = agg.get(e.memoryId);
      if (!a) { a = { runs: new Set(), clean: new Set(), failed: new Set() }; agg.set(e.memoryId, a); }
      a.runs.add(e.runId);
      if (e.degraded === true || e.runStatus === "failed") a.failed.add(e.runId);
      else if (e.runStatus === "done") a.clean.add(e.runId);
    }
    for (const [id, a] of agg) {
      // 同一 run 出现冲突快照时失败优先(保守,不虚标干净)。
      const clean = [...a.clean].filter((r) => !a.failed.has(r)).length;
      out.set(id, { injected: a.runs.size, cleanRuns: clean, failedRuns: a.failed.size });
    }
  } catch { /* NEVER throws → 返回空/部分结果 */ }
  return out;
}
