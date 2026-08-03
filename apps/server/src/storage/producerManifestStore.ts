import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { readJSON, writeJSON } from "./jsonFile.js";

// MUP Gate A#1 · ProducerArtifactManifest(冻结规格 schemaVersion "1")。
// producer 变更被接受进 allChanges 记账的【同一时刻】,orchestrator 经本 store 读 workRoot 实文件算
// sha256 追加冻结条目,落 .opc/runs/<runId>/producer-manifest.json —— 取代"收尾从 allChanges 现算"的
// 可变派生值,给验收门一个不可回溯篡改的 hash 基准(重算失配 → artifact_mismatch)。
// 铁律:append-only(同 path 后续轮次追加新条目,消费方取最新);verifier 的变更不进清单(验证者不得
// 创造被验证的交付物);读不到的文件如实跳过,绝不虚构 hash。

export interface ProducerManifestEntry {
  path: string;      // 相对 workRoot,POSIX 分隔,保留大小写
  hash: string;      // 冻结时刻 workRoot 实文件 sha256,全量小写 hex(64 位)
  agentId: string;
  role: string;
  mergedAt: string;  // ISO 时间(该变更被接受/merge 进账的时刻)
}

export interface ProducerArtifactManifest {
  schemaVersion: "1";
  runId: string;
  entries: ProducerManifestEntry[];
}

const manifestPath = (root: string, runId: string) =>
  path.join(root, ".opc", "runs", runId, "producer-manifest.json");

function normPosix(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function sha256FileHex(abs: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return null;
  }
}

export function loadProducerManifest(root: string, runId: string): ProducerArtifactManifest | null {
  const raw = readJSON<ProducerArtifactManifest | null>(manifestPath(root, runId), null);
  if (!raw || raw.schemaVersion !== "1" || !Array.isArray(raw.entries)) return null;
  return raw;
}

// 即时冻结:对每个被接受的 producer 变更读 workRoot 实文件算 sha256,追加为新条目(append-only)。
// delete 型变更由调用方过滤(无内容可指纹);越界路径(../ / 绝对路径)与读不到的文件如实跳过。
// 返回真正追加的条目(空数组 = 无可冻结项,不写盘)。
export function freezeProducerManifestEntries(
  root: string,
  runId: string,
  workRoot: string,
  items: Array<{ path: string; agentId: string; role: string }>,
  nowIso = new Date().toISOString(),
): ProducerManifestEntry[] {
  const appended: ProducerManifestEntry[] = [];
  for (const it of items) {
    const rel = normPosix(it.path);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const hash = sha256FileHex(path.join(workRoot, rel));
    if (!hash) continue;
    appended.push({ path: rel, hash, agentId: it.agentId, role: it.role, mergedAt: nowIso });
  }
  if (appended.length === 0) return [];
  const existing = loadProducerManifest(root, runId);
  const manifest: ProducerArtifactManifest = existing ?? { schemaVersion: "1", runId, entries: [] };
  manifest.entries.push(...appended);
  writeJSON(manifestPath(root, runId), manifest);
  return appended;
}

// 消费方取最新:同 path(POSIX 小写归一后)多条时取最后追加的那条。key = 小写 POSIX 路径。
export function latestProducerEntriesByPath(
  entries: ProducerManifestEntry[],
): Map<string, ProducerManifestEntry> {
  const m = new Map<string, ProducerManifestEntry>();
  for (const e of entries) m.set(normPosix(e.path).toLowerCase(), e);
  return m;
}
