import * as fs from "node:fs";
import * as path from "node:path";
import type { RunArtifact, RunArtifactCollection, ArtifactLineageEdge } from "@opc/shared";
import { loadRunReport } from "../storage/projectStore.js";
import { sha256Hex } from "./evidenceManifest.js";

// Stage 3 · 来源链/血缘:给定 artifactId,返回上游来源 + 下游消费者(纯派生自 collection),每条边带 relationship/via。
export interface LineageNeighbor {
  artifact: RunArtifact;
  relationship?: ArtifactLineageEdge["relationship"];
  via?: string;
}
export interface ArtifactLineageResult {
  artifact: RunArtifact;
  upstream: LineageNeighbor[];     // 本产物依据的来源
  downstream: LineageNeighbor[];   // 把本产物当来源的产物(谁用了它)
}

export function artifactLineage(col: RunArtifactCollection, artifactId: string): ArtifactLineageResult | null {
  const art = col.artifacts.find(a => a.id === artifactId);
  if (!art) return null;
  const byId = new Map(col.artifacts.map(a => [a.id, a]));
  const edgeFor = (from: RunArtifact, sourceId: string): ArtifactLineageEdge | undefined =>
    (from.lineage ?? []).find(e => e.sourceId === sourceId);

  const upstream: LineageNeighbor[] = (art.sourceArtifactIds ?? [])
    .map(id => byId.get(id))
    .filter((a): a is RunArtifact => !!a)
    .map(src => { const e = edgeFor(art, src.id); return { artifact: src, relationship: e?.relationship, via: e?.via }; });

  const downstream: LineageNeighbor[] = col.artifacts
    .filter(a => (a.sourceArtifactIds ?? []).includes(artifactId))
    .map(consumer => { const e = edgeFor(consumer, artifactId); return { artifact: consumer, relationship: e?.relationship, via: e?.via }; });

  return { artifact: art, upstream, downstream };
}

// Stage 3 · 下载解析:report → report.md(projectRoot/.opc/runs);file → 该 run 的持久工作根 workRoot 内的文件
// (calc.py 类真实交付物,不再误读 projectRoot);其余(worker-output 等)→ .opc/runs/<id>/artifacts 归档副本(savedPath)。
// report/file 主源缺失(或 workRoot=null 的历史 run)时退回归档副本。全部走词法 + realpath 双重越界守卫。null = 不可下载。
export interface ArtifactDownload {
  body: string;
  contentType: string;
  filename: string;
}

// 成果卡文本预览:与下载同一份来源字节,按 maxBytes 截断(超限标 truncated),完整内容仍走下载端点。
export interface ArtifactPreview {
  content: string;
  contentType: string;
  filename: string;
  truncated: boolean;
  totalBytes: number;    // 完整字节数(截断前)
  previewBytes: number;  // 实际返回字节数
}

// 预览体默认上限 256KB:超出截断,前端提示"完整内容请下载"。
export const PREVIEW_MAX_BYTES = 256 * 1024;

const EXT_CT: Record<string, string> = {
  ".md": "text/markdown; charset=utf-8", ".markdown": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8", ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".ts": "text/plain; charset=utf-8", ".js": "text/plain; charset=utf-8", ".py": "text/plain; charset=utf-8",
};
function ctFor(p: string): string {
  return EXT_CT[path.extname(p).toLowerCase()] ?? "text/plain; charset=utf-8";
}
function asciiSafe(name: string): string {
  return name.replace(/[^\w.-]/g, "_") || "artifact";
}

// 只白名单这些状态可下载(deleted/rejected/未知状态一律拒)。
const DOWNLOADABLE = new Set<RunArtifact["status"]>(["final", "degraded", "accepted", "added", "modified"]);

// 工作区文件读取:词法 + realpath 双重越界守卫(root 也走 realpath,避免 Windows 临时目录短名/大小写误拒)。
// workRoot=null(历史 run 推断不出工作根)或读不到 → null。
// P1(审计)· expectedHash("sha256:<hex>")给定时(有冻结归档不可用、回退 workRoot 的路径)强制内容校验:
// 当前文件 sha256 必须等于 registry run-end 记录的 hash,否则文件 run 后被后续 run / 人工改动 → 返回 null
// (artifact_mismatch:绝不用旧 hash 供漂移内容)。expectedHash 缺省 → 不校验(老 run/无 hash 兼容)。
function readWorkspaceFile(workRoot: string | null, relPath: string, expectedHash?: string): string | null {
  if (!workRoot) return null;
  let root: string;
  try { root = fs.realpathSync(path.resolve(workRoot)); } catch { return null; }
  const lexical = path.resolve(root, relPath);
  if (relEscapes(root, lexical)) return null;
  let real: string;
  try { real = fs.realpathSync(lexical); } catch { return null; }
  if (relEscapes(root, real)) return null;   // 软链逃逸:真实路径必须仍在 projectRoot 内
  let buf: Buffer;
  try { if (!fs.statSync(real).isFile()) return null; buf = fs.readFileSync(real); } catch { return null; }
  if (expectedHash) {
    const want = expectedHash.startsWith("sha256:") ? expectedHash.slice(7) : expectedHash;
    if (sha256Hex(buf) !== want) return null; // 文件 run 后被改 → 不供旧 hash 内容
  }
  return buf.toString("utf-8");
}

// 归档副本读取:savedPath 相对 run 目录(如 "artifacts/xxx"),守卫限定在该 run 目录内。读不到 → null。
function readSavedArchive(projectRoot: string, runId: string, savedPath: string): string | null {
  let runDir: string;
  try { runDir = fs.realpathSync(path.join(projectRoot, ".opc", "runs", runId)); } catch { return null; }
  const lexical = path.resolve(runDir, savedPath);
  if (relEscapes(runDir, lexical)) return null;
  let real: string;
  try { real = fs.realpathSync(lexical); } catch { return null; }
  if (relEscapes(runDir, real)) return null;
  try { if (!fs.statSync(real).isFile()) return null; } catch { return null; }
  try { return fs.readFileSync(real, "utf-8"); } catch { return null; }
}

function archiveFilename(art: RunArtifact, savedPath: string): string {
  if (art.kind === "file" && art.path) return asciiSafe(path.basename(art.path));
  return asciiSafe(path.basename(savedPath));
}

export function resolveArtifactDownload(projectRoot: string, workRoot: string | null, runId: string, art: RunArtifact): ArtifactDownload | null {
  if (!DOWNLOADABLE.has(art.status)) return null;
  if (art.kind === "report") {
    const body = loadRunReport(projectRoot, runId);
    if (body !== null) return { body, contentType: "text/markdown; charset=utf-8", filename: asciiSafe(`report-${runId.slice(0, 8)}.md`) };
    // report.md 已不在盘上 → 退回归档副本(若有)
  } else if (art.kind === "file" && art.path) {
    // P1(审计)· 已完成 run 的文件产物是**不可变交付物**:优先取 run 目录内的冻结归档副本(savedPath 是
    // run-end 快照,与 registry hash 同一份字节),而不是共享 workRoot 的当前文件——后者会被后续 run / 人工
    // 改动导致旧 run 下载内容漂移却仍引用旧 hash。仅当无完整归档(老 run / 超 1MB 截断)才回退 workRoot,且
    // 强制按 registry hash 校验:失配则不供漂移内容(readWorkspaceFile 返 null),继续走下方 savedPath 兜底
    // (截断归档也是冻结快照,比漂移内容可信)。
    if (art.savedPath && !art.savedPathTruncated) {
      const arch = readSavedArchive(projectRoot, runId, art.savedPath);
      if (arch !== null) return { body: arch, contentType: ctFor(art.path), filename: asciiSafe(path.basename(art.path)) };
    }
    const body = readWorkspaceFile(workRoot, art.path, art.hash);
    if (body !== null) return { body, contentType: ctFor(art.path), filename: asciiSafe(path.basename(art.path)) };
  }
  // worker-output(inlineText 归档)或 report/file 主源缺失的兜底:.opc/runs/<id>/artifacts 内实体副本。
  if (art.savedPath) {
    const body = readSavedArchive(projectRoot, runId, art.savedPath);
    if (body !== null) return { body, contentType: ctFor(art.savedPath), filename: archiveFilename(art, art.savedPath) };
  }
  return null;
}

// 预览:复用下载解析拿完整体,按 maxBytes 截断(超限标 truncated)。不可下载 → null(端点回 404)。
export function resolveArtifactPreview(
  projectRoot: string, workRoot: string | null, runId: string, art: RunArtifact, maxBytes: number = PREVIEW_MAX_BYTES,
): ArtifactPreview | null {
  const resolved = resolveArtifactDownload(projectRoot, workRoot, runId, art);
  if (!resolved) return null;
  const buf = Buffer.from(resolved.body, "utf-8");
  const totalBytes = buf.byteLength;
  const limit = Math.max(0, maxBytes);
  const truncated = totalBytes > limit;
  const slice = truncated ? buf.subarray(0, limit) : buf;
  return {
    content: slice.toString("utf-8"),
    contentType: resolved.contentType,
    filename: resolved.filename,
    truncated,
    totalBytes,
    previewBytes: slice.byteLength,
  };
}

function relEscapes(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || rel.startsWith("..") || path.isAbsolute(rel);
}
