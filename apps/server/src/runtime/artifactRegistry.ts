import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./evidenceManifest.js";
import type { Artifact, RunArtifact, RunArtifactCollection, ArtifactLineageEdge, FileChange } from "@opc/shared";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { resolveRunWorkRoot } from "../routes/runRoutes.js";

// Stage 3 · Artifact-first registry。在 run-end(run.degraded 已定稿、artifactStore.list() 已完整)
// 纯事后构建「带 producer/状态/是否进交付/来源链」的产物清单,写 .opc/runs/:id/artifacts.json。
// 不改 orchestrator 主循环、不发新事件、不读 in-loop token —— 规避主链路风险。

export interface RegistryDeferred {
  agentId?: string;
  taskId?: string;
  goal?: string;
  reason?: string;
  lastError?: string;
}

export interface RegistryVerification {
  reviewArtifactId: string;
  reviewedArtifactId: string;   // 被审 producer 的 agentId
  producerId: string;
  verifierId: string;
  verifierRole?: string;
  method: string;
  accept: boolean;
  summary: string;
  createdAt: string;
}

export interface BuildRegistryInput {
  runId: string;
  artifacts: Artifact[];               // artifactStore.list() 快照
  deferred?: RegistryDeferred[];       // 被拒/延后(含 quality_gate_failed)
  degraded: boolean;
  degradedReason?: string;
  hasReport: boolean;                  // report.md 是否存在(决定是否登记 final report)
  reportProducer?: string;             // directAnswer → "ceo";否则 leadId
  roleOf?: Record<string, string>;     // agentId → role(producerRole 用)
  verificationResults?: RegistryVerification[]; // Stage 6:交叉验证结果(产 review-result artifact + 否决回标)
  orphanChanges?: FileChange[];        // changes.json 里但没被任何 worker 产出覆盖的文件(典型:lead 合成阶段直写工作区的交付文件)——也生成可下载 file artifact,否则账本有、artifact 无、不可下载
}

// B5c:file 的「变更类型」——单一权威来源,changeStatus(旧 status 字段)与 changeType(新字段)都从这里派生。
function fileChangeType(ct: string): RunArtifact["changeType"] {
  return ct === "create" ? "added" : ct === "delete" ? "deleted" : "modified";
}

function changeStatus(ct: string): RunArtifact["status"] {
  return fileChangeType(ct)!;
}

// 从 artifactStore 的 Artifact[] + deferred + 降级状态,构建 RunArtifactCollection(含 lineage)。
export function buildRunArtifactCollection(input: BuildRegistryInput): RunArtifactCollection {
  const { runId, artifacts, deferred = [], degraded, degradedReason, hasReport, reportProducer, roleOf = {}, verificationResults = [], orphanChanges = [] } = input;
  const out: RunArtifact[] = [];
  const fileById = new Map<string, RunArtifact>();
  const usedIds = new Set<string>();
  const dl = (fid: string) => `/api/runs/${runId}/artifacts/download?artifactId=${encodeURIComponent(fid)}`;
  const workerInFinal = !degraded;
  const uniqueId = (base: string): string => {
    const stem = base || `artifact:${usedIds.size}`;
    if (!usedIds.has(stem)) { usedIds.add(stem); return stem; }
    for (let i = 1; ; i++) {
      const next = `${stem}:${i}`;
      if (!usedIds.has(next)) { usedIds.add(next); return next; }
    }
  };

  for (const a of artifacts) {
    const workerId = uniqueId(a.id);
    const producerRole = roleOf[a.producedBy];
    out.push({
      id: workerId,
      kind: "worker-output",
      title: a.name || `${a.producedBy} 的产出`,
      producer: a.producedBy,
      producerRole,
      status: "accepted",
      reviewStatus: "accepted", // B5c:乐观初值,verificationResults 否决时下方回标为 rejected
      inFinalDeliverable: workerInFinal,
      createdAt: a.createdAt,
    });

    for (const fc of a.fileChanges ?? []) {
      const fid = `file:${fc.path}`;
      const existing = fileById.get(fid);
      if (existing) {
        existing.sourceArtifactIds = [...(existing.sourceArtifactIds ?? []), workerId];
        existing.lineage = [...(existing.lineage ?? []), { sourceId: workerId, relationship: "accepted-from", via: a.producedBy }];
        continue;
      }
      const fileId = uniqueId(fid);
      const fileArt: RunArtifact = {
        id: fileId,
        kind: "file",
        title: fc.path,
        producer: a.producedBy,
        producerRole,
        status: changeStatus(fc.changeType),
        changeType: fileChangeType(fc.changeType),
        reviewStatus: "accepted", // B5c:乐观初值(该文件所依据的 worker 产出尚未被否决);全部来源被否决时下方回标为 rejected
        path: fc.path,
        inFinalDeliverable: workerInFinal,
        downloadUrl: fc.changeType === "delete" ? undefined : dl(fileId),
        sourceArtifactIds: [workerId],
        lineage: [{ sourceId: workerId, relationship: "accepted-from", via: a.producedBy }],
        createdAt: a.createdAt,
      };
      fileById.set(fid, fileArt);
      out.push(fileArt);
    }
  }

  // changes.json 里但没被任何 worker 产出覆盖的文件(典型:lead 合成阶段直写工作区的交付文件,如
  // report.md 或最终答案文件)——也生成可下载 file artifact。否则文件在 changes.json 账本里却无 artifact、
  // 不可下载(证据链断裂:worker 纯文本产出的编码 run 曾出现 changes.json 有文件但 0 file artifact)。
  for (const fc of orphanChanges) {
    const fid = `file:${fc.path}`;
    if (fileById.has(fid)) continue; // 已有 worker 来源的 file artifact,不重复登记
    const fileId = uniqueId(fid);
    const fileArt: RunArtifact = {
      id: fileId,
      kind: "file",
      title: fc.path,
      producer: "synthesis",
      status: changeStatus(fc.changeType),
      changeType: fileChangeType(fc.changeType),
      reviewStatus: "accepted",
      path: fc.path,
      inFinalDeliverable: workerInFinal,
      downloadUrl: fc.changeType === "delete" ? undefined : dl(fileId),
    };
    fileById.set(fid, fileArt);
    out.push(fileArt);
  }

  deferred.forEach((d, i) => {
    const aid = d.agentId ?? d.taskId ?? `unknown-${i}`;
    out.push({
      id: uniqueId(`rejected:${aid}:${i}`),
      kind: "worker-output",
      title: d.taskId || d.goal || aid,
      producer: d.agentId,
      producerRole: d.agentId ? roleOf[d.agentId] : undefined,
      status: "rejected",
      reviewStatus: "rejected",
      reason: d.lastError || d.reason || "未通过产物契约/延后",
      inFinalDeliverable: false,
    });
  });

  verificationResults.forEach((vr, i) => {
    const reviewedAll = out.filter(a => a.kind === "worker-output" && a.producer === vr.reviewedArtifactId);
    const reviewedId = reviewedAll[0]?.id ?? vr.reviewedArtifactId;
    out.push({
      id: uniqueId(vr.reviewArtifactId || `review:${vr.producerId}:${i}`),
      kind: "review-result",
      title: `核查结果(${vr.verifierId} -> ${vr.producerId})`,
      producer: vr.verifierId,
      producerRole: vr.verifierRole,
      status: vr.accept ? "accepted" : "rejected",
      reviewStatus: vr.accept ? "accepted" : "rejected",
      reason: vr.accept ? undefined : vr.summary,
      inFinalDeliverable: false,
      sourceArtifactIds: [reviewedId],
      lineage: [{ sourceId: reviewedId, relationship: "reviewed-by", via: vr.verifierId }],
      createdAt: vr.createdAt,
    });
    // B5 · acceptedBy:从现有验收数据(verification 通过记录)派生——谁核查通过就是谁验收;派生不出留空。
    if (vr.accept) {
      for (const r of reviewedAll) {
        if (r.status !== "rejected" && !r.acceptedBy) r.acceptedBy = vr.verifierId;
      }
    }
    if (!vr.accept) {
      for (const r of reviewedAll) {
        r.status = "rejected";
        r.reviewStatus = "rejected";
        r.inFinalDeliverable = false;
        r.reason = vr.summary;
        r.acceptedBy = undefined; // 后到的否决推翻先前验收(JSON.stringify 会丢掉 undefined 键)
      }
      for (const f of out.filter(a => a.kind === "file" && (a.sourceArtifactIds ?? []).some(id => reviewedAll.some(r => r.id === id)))) {
        const rejectedIds = new Set(reviewedAll.map(r => r.id));
        f.sourceArtifactIds = (f.sourceArtifactIds ?? []).filter(id => !rejectedIds.has(id));
        f.lineage = (f.lineage ?? []).filter(e => !rejectedIds.has(e.sourceId));
        if ((f.sourceArtifactIds ?? []).length === 0) {
          f.status = "rejected"; // 旧字段:覆盖为"验收结论"语义(与 changeType 的"变更类型"语义分离,changeType 保持不变)
          f.reviewStatus = "rejected";
          f.inFinalDeliverable = false;
          f.reason = vr.summary;
          f.downloadUrl = undefined;
        }
      }
    }
  });

  if (hasReport) {
    const rel = degraded ? "derived-from" as const : "synthesized-from" as const;
    const sourceWorkerIds = out
      .filter(a => a.kind === "worker-output" && a.status === "accepted")
      .map(a => a.id);
    const lineage: ArtifactLineageEdge[] = sourceWorkerIds.map(sid => ({ sourceId: sid, relationship: rel, via: reportProducer }));
    out.push({
      id: uniqueId("report"),
      kind: "report",
      title: "最终报告",
      producer: reportProducer,
      producerRole: reportProducer ? roleOf[reportProducer] ?? (reportProducer === "ceo" ? "ceo" : "lead") : undefined,
      status: degraded ? "degraded" : "final",
      reviewStatus: degraded ? "degraded" : "accepted",
      reason: degraded ? degradedReason : undefined,
      downloadUrl: `/api/runs/${runId}/artifacts/download?artifactId=report`,
      inFinalDeliverable: !degraded,
      sourceArtifactIds: sourceWorkerIds.length ? sourceWorkerIds : undefined,
      lineage: lineage.length ? lineage : undefined,
    });
  }

  return { runId, degraded, degradedReason, artifacts: out };
}

// ── B5 · 证据链:事后 hash/size 补齐 ─────────────────────────────────────────────
// 只对能定位到磁盘文件的 artifact 计算 sha256+字节数;读不到(缺文件/越界/符号链接逃逸)诚实留空,不虚构。
// 词法 + realpath 双重越界守卫,与 artifactLineage.resolveArtifactDownload 同规。绝不抛。

function relEscapes(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  // 按路径分段判断(".." 必须是完整的首段),而不是字符串前缀:
  // 前缀判断会把净化后恰好以字面 ".." 开头的合法文件名(如 ".._.._evil")误判为逃逸而误杀归档。
  return rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

// 该 run 的持久工作根解析:复用 runRoutes 的三态解析导出(① task.json.workRoot ② events "工作目录:" 文本
// ③ null,绝不兜底 projectRoot)。绝不抛 —— 推断不出即 null,file 产物如实跳过证据补齐/归档。
function resolveWorkRootSafe(projectRoot: string, runId: string): string | null {
  try { return resolveRunWorkRoot(projectRoot, runId); } catch { return null; }
}

function readArtifactBytes(projectRoot: string, workRoot: string | null, runId: string, art: RunArtifact): Buffer | null {
  try {
    if (art.kind === "report" && art.status !== "rejected") {
      // status 守卫与下面 file 类同口径:被否决的产物不补证据指纹(验收报告问题#2)。
      const f = path.join(projectRoot, ".opc", "runs", runId, "report.md");
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    }
    if (art.kind === "file" && art.path && art.status !== "deleted" && art.status !== "rejected") {
      // kind=file 的真实交付物落在该 run 的持久工作根 workRoot(公司工作区),不在 projectRoot——
      // 旧实现以 projectRoot 解析 art.path → 恒读不到 → hash/size 恒空、B5c 归档副本从不生成。
      // 改经 workRoot 解析,恢复证据/归档语义;workRoot=null 的历史 run 如实跳过,不猜。
      if (!workRoot) return null;
      const root = fs.realpathSync(path.resolve(workRoot));
      const lexical = path.resolve(root, art.path);
      if (relEscapes(root, lexical)) return null;
      const real = fs.realpathSync(lexical);
      if (relEscapes(root, real)) return null;
      if (!fs.statSync(real).isFile()) return null;
      return fs.readFileSync(real);
    }
  } catch { /* 读不到 → 留空 */ }
  return null;
}

// 就地补 hash/size(可单独调用,saveArtifactRegistry 落盘前自动执行)。绝不抛。
export function enrichArtifactEvidence(projectRoot: string, runId: string, col: RunArtifactCollection): void {
  const workRoot = resolveWorkRootSafe(projectRoot, runId);
  for (const art of col.artifacts) {
    try {
      const buf = readArtifactBytes(projectRoot, workRoot, runId, art);
      if (!buf) continue;
      art.size = buf.byteLength;
      art.hash = "sha256:" + sha256Hex(buf); // B4:hash util 统一(evidenceManifest.sha256Hex),行为不变(仍带 sha256: 前缀)
    } catch { /* 单个失败不影响其它 artifact */ }
  }
}

// ── B5c · artifacts/ 实体目录:把有内容实体的 artifact 归档一份副本 ─────────────────────
// "有内容实体"=能拿到字节的两类来源:①kind=report/file——复用上面的 readArtifactBytes(磁盘文件,
// 已有 relEscapes+realpath 双重越界守卫);②kind=worker-output——a2aBus ArtifactStore 里对应
// Artifact 的 inlineText(仅 <4KB 才内联,workdirPath 当前未被任何调用点填充,不虚构去读)。
// review-result 等无实体的 kind 直接跳过。副本落 .opc/runs/<runId>/artifacts/<安全文件名>,
// 是"归档副本"——worktree/项目里的原文件不动。best-effort,单条失败不影响其它/不影响主链路。

const ARCHIVE_MAX_BYTES = 1024 * 1024; // 1MB,超出截断并在 savedPathTruncated 标记

// 把任意字符串收窄成单一安全文件名片段:非 [a-zA-Z0-9._-] 一律替换为 "_"。替换后不再含路径分隔符,
// 因此不可能穿越出目标目录(即便原串含 "../"),relEscapes 仍在写入前兜底复核一次。
function safeArtifactFileNameStem(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return cleaned || "artifact";
}

function archiveExtFor(art: RunArtifact): string {
  if (art.kind === "file" && art.path) {
    const ext = path.extname(art.path);
    if (ext && ext.length <= 10) return ext;
  }
  if (art.kind === "report") return ".md";
  if (art.kind === "worker-output") return ".txt";
  return "";
}

function readEntityBytes(projectRoot: string, workRoot: string | null, runId: string, art: RunArtifact, sourceById: Map<string, Artifact>): Buffer | null {
  if (art.kind === "report" || art.kind === "file") return readArtifactBytes(projectRoot, workRoot, runId, art);
  if (art.kind === "worker-output") {
    const src = sourceById.get(art.id);
    if (src?.inlineText) return Buffer.from(src.inlineText, "utf-8");
    return null;
  }
  return null; // review-result 等:无可归档实体
}

// 就地归档(可单独调用,saveArtifactRegistry 落盘前自动执行)。绝不抛。
export function archiveArtifactEntities(
  projectRoot: string,
  runId: string,
  col: RunArtifactCollection,
  sourceArtifacts: Artifact[] = [],
): void {
  const sourceById = new Map(sourceArtifacts.map((a) => [a.id, a] as const));
  const workRoot = resolveWorkRootSafe(projectRoot, runId);
  const dir = path.join(projectRoot, ".opc", "runs", runId, "artifacts");
  const usedStems = new Set<string>();
  let dirEnsured = false;
  for (const art of col.artifacts) {
    try {
      const buf = readEntityBytes(projectRoot, workRoot, runId, art, sourceById);
      if (!buf) continue;
      const ext = archiveExtFor(art);
      let stem = safeArtifactFileNameStem(art.id);
      if (usedStems.has(stem)) {
        let i = 1;
        while (usedStems.has(`${stem}-${i}`)) i++;
        stem = `${stem}-${i}`;
      }
      usedStems.add(stem);
      const fileName = `${stem}${ext}`;
      const target = path.resolve(dir, fileName);
      if (relEscapes(dir, target)) continue; // 防御性复核:理论上 sanitize 后不可能触发
      if (!dirEnsured) { fs.mkdirSync(dir, { recursive: true }); dirEnsured = true; }
      const truncated = buf.byteLength > ARCHIVE_MAX_BYTES;
      fs.writeFileSync(target, truncated ? buf.subarray(0, ARCHIVE_MAX_BYTES) : buf);
      art.savedPath = `artifacts/${fileName}`;
      if (truncated) art.savedPathTruncated = true;
    } catch { /* 单条归档失败不影响其它 artifact / 不影响 run */ }
  }
}

export function saveArtifactRegistry(
  projectRoot: string,
  runId: string,
  col: RunArtifactCollection,
  sourceArtifacts: Artifact[] = [],
): void {
  try { enrichArtifactEvidence(projectRoot, runId, col); } catch { /* 补齐失败不影响落盘 */ }
  try { archiveArtifactEntities(projectRoot, runId, col, sourceArtifacts); } catch { /* 归档失败不影响落盘 */ }
  const dir = path.join(projectRoot, ".opc", "runs", runId);
  writeJSON(path.join(dir, "artifacts.json"), col);
}

export function loadArtifactRegistry(projectRoot: string, runId: string): RunArtifactCollection | null {
  const f = path.join(projectRoot, ".opc", "runs", runId, "artifacts.json");
  return readJSON<RunArtifactCollection | null>(f, null);
}
