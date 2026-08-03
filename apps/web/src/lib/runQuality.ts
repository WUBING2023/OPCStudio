import type { TraceEvent } from "@opc/shared";

// 质量摘要计算——从 ResultSection.tsx 原地 useMemo 抽出的纯函数(C3 群成果卡复用同一份口径,
// 不复制粘贴)。语义不变:验证边通过率 / 合并冲突 / 同源审查 / 超时抢救 四类信号。
export interface RunQualityMergeFile { path: string; discardedWorkerId: string; keptWorkerId: string }

export interface RunQualitySummary {
  verifyTotal: number;
  verifyPassed: number;
  mergeFiles: RunQualityMergeFile[];
  hasUnstructuredMergeConflict: boolean;
  sameModelCount: number;
  salvageCount: number;
  allClear: boolean;
  hasAnySignal: boolean;
}

export function computeRunQuality(events: TraceEvent[]): RunQualitySummary {
  const payloadOf = (e: TraceEvent) => (e.payload ?? {}) as Record<string, unknown>;
  const verifierResults = events.filter((e) => e.type === "verifier_result");
  const verifyTotal = verifierResults.length;
  const verifyPassed = verifierResults.filter((e) => payloadOf(e).accept === true).length;

  const mergeFiles: RunQualityMergeFile[] = [];
  let hasUnstructuredMergeConflict = false;
  for (const e of events) {
    const p = payloadOf(e);
    if (p.kind !== "merge_theirs") continue;
    const f = p.mergeConflictFile as Record<string, unknown> | undefined;
    if (f && typeof f.path === "string" && typeof f.discardedWorkerId === "string") {
      mergeFiles.push({ path: f.path, discardedWorkerId: f.discardedWorkerId, keptWorkerId: typeof f.keptWorkerId === "string" ? f.keptWorkerId : (e.agentId ?? "?") });
    } else {
      hasUnstructuredMergeConflict = true;
    }
  }

  const sameModelCount = events.filter((e) => payloadOf(e).kind === "same_model_review").length;
  const salvageCount = events.filter((e) => payloadOf(e).kind === "timeout_salvage").length;

  const allClear = verifyTotal === verifyPassed && mergeFiles.length === 0 && !hasUnstructuredMergeConflict && sameModelCount === 0 && salvageCount === 0;
  const hasAnySignal = verifyTotal > 0 || mergeFiles.length > 0 || hasUnstructuredMergeConflict || sameModelCount > 0 || salvageCount > 0;
  return { verifyTotal, verifyPassed, mergeFiles, hasUnstructuredMergeConflict, sameModelCount, salvageCount, allClear, hasAnySignal };
}
