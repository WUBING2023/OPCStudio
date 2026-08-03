import * as fs from "node:fs";
import * as path from "node:path";
import type { RunArtifact, RunArtifactCollection, TraceEvent } from "@opc/shared";
import { loadArtifactRegistry } from "./artifactRegistry.js";
import { loadRunEventsRaw, loadChanges } from "../storage/projectStore.js";

// Stage 3 · 统一入口:优先读 Stage 3 注册表(artifacts.json,含 producer/lineage),
// 不存在(旧 run / DIRECT 短路前)则回退 Stage 2 纯派生 collectRunArtifacts。
export function loadRunArtifacts(projectRoot: string, runId: string): RunArtifactCollection {
  const reg = loadArtifactRegistry(projectRoot, runId);
  if (reg) return reg;
  return collectRunArtifacts(projectRoot, runId);
}

// Stage 2 · Artifact 最小归集:从一个 run 的落盘产物(report.md / changes.json)
// + 断链领域事件(artifact_rejected / deliverable_degraded)派生「可见产物清单」。
// 不引入新存储——纯派生,Stage 3 再上 registry/lineage。
export function collectRunArtifacts(projectRoot: string, runId: string): RunArtifactCollection {
  const runDir = path.join(projectRoot, ".opc", "runs", runId);
  const artifacts: RunArtifact[] = [];

  // 断链事件:被拒产物的原因、整体降级状态。
  let degraded = false;
  let degradedReason: string | undefined;
  const rejected = new Map<string, { reason: string; agentId?: string }>(); // artifactId -> {reason, 真实 producer agentId}
  const eventsRaw = loadRunEventsRaw(projectRoot, runId);
  if (eventsRaw !== null) {
    for (const line of eventsRaw.split("\n")) {
      if (!line.trim()) continue;
      let ev: TraceEvent;
      try { ev = JSON.parse(line) as TraceEvent; } catch { continue; }
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "artifact_rejected") {
        const aid = typeof p.artifactId === "string" ? p.artifactId : (ev.agentId ?? "unknown");
        rejected.set(aid, { reason: typeof p.reason === "string" ? p.reason : "未通过产物契约", agentId: ev.agentId });
      } else if (ev.type === "deliverable_degraded") {
        degraded = true;
        if (typeof p.reason === "string") degradedReason = p.reason;
      }
    }
  }

  // 最终报告(进入最终交付,可下载)。
  if (fs.existsSync(path.join(runDir, "report.md"))) {
    artifacts.push({
      id: "report",
      kind: "report",
      title: "最终报告",
      status: degraded ? "degraded" : "final",
      reason: degraded ? degradedReason : undefined,
      downloadUrl: `/api/runs/${runId}/artifacts/download?artifactId=report`,
      inFinalDeliverable: true,
    });
  }

  // 工作区文件变更(每个变更 = 一个产物)。注:Stage 2 纯派生从 changes.json 读,FileChange 无 agentId,
  // 故 producer best-effort(常为 undefined);完整 producer/来源链走 Stage 3 registry(artifacts.json)。
  const changes = loadChanges(projectRoot, runId) as Array<{ path?: string; changeType?: string; agentId?: string }>;
  for (const c of changes) {
    if (!c || typeof c.path !== "string") continue;
    const status: RunArtifact["status"] =
      c.changeType === "create" ? "added" : c.changeType === "delete" ? "deleted" : "modified";
    artifacts.push({
      id: `file:${c.path}`,
      kind: "file",
      title: c.path,
      producer: typeof c.agentId === "string" ? c.agentId : undefined,
      status,
      path: c.path,
      inFinalDeliverable: true,
      downloadUrl: c.changeType === "delete" ? undefined : `/api/runs/${runId}/artifacts/download?artifactId=${encodeURIComponent(`file:${c.path}`)}`,
    });
  }

  // 被拒产物(未进最终交付,带原因)。producer 用事件里的真实 agentId(非 artifactId/taskId)。
  let _rejIdx = 0;
  for (const [aid, info] of rejected) {
    artifacts.push({
      id: `rejected:${aid}:${_rejIdx++}`,
      kind: "worker-output",
      title: aid,
      producer: info.agentId,
      producerRole: undefined,
      status: "rejected",
      reason: info.reason,
      inFinalDeliverable: false,
    });
  }

  return { runId, degraded, degradedReason, artifacts };
}
