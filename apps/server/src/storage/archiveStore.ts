import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentNodeConfig, Company } from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";
import { loadAgents, saveAgents, loadRunIndex, updateRunIndex, type RunIndexEntry } from "./projectStore.js";
import { loadCompanies, saveCompanies, DEFAULT_COMPANY_ID } from "./companyStore.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, deleteDoc } from "./sqlite/docTableBackend.js";

// 归档 store:归档 = **移动**到 .opc/archive/<时间戳>/ 并写 manifest.json,绝不 unlink 任何证据文件。
// 唯一允许删源的场景是跨盘 rename 失败后的 copy → 逐文件字节数校验通过 → 删源(校验不过绝不删)。
// 恢复按 manifest 原样移回,任何冲突(同 id 公司/员工/run 已存在)直接报错中止,不覆盖现有数据。

const OPC_DIR = ".opc";

// 同 routes 的 SAFE_RUN_ID 口径(防路径穿越);公司 id/归档 id 同样只允许安全 token。
const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;

// 这些状态视为"在飞"(进行中/排队待派发/审查流转中),对应的 run/公司拒绝归档。
const ACTIVE_RUN_STATUSES = new Set(["running", "pending", "planned", "waiting_review", "needs_revision"]);

export class ArchiveConflictError extends Error {}
export class ArchiveNotFoundError extends Error {}

export interface ArchiveManifest {
  kind: "company" | "runs";
  archiveId: string;
  id: string; // kind=company → 公司 id;kind=runs → 同 archiveId
  name?: string;
  archivedAt: string;
  company?: Company;
  agents: AgentNodeConfig[];
  runIds: string[];
  originalPaths: Record<string, string>; // 归档内相对路径 → 原相对路径(相对 projectRoot)
  runIndexEntries: Record<string, RunIndexEntry>; // 恢复时原样写回 _index.json
  restoredAt?: string;
}

export interface ArchiveListItem {
  archiveId: string;
  kind: "company" | "runs";
  id: string;
  name?: string;
  archivedAt: string;
  runCount: number;
  agentCount: number;
  restoredAt?: string;
}

function archiveRootDir(projectRoot: string): string {
  return path.join(projectRoot, OPC_DIR, "archive");
}

function runDirOf(projectRoot: string, runId: string): string {
  return path.join(projectRoot, OPC_DIR, "runs", runId);
}

function runIndexFileOf(projectRoot: string): string {
  return path.join(projectRoot, OPC_DIR, "runs", "_index.json");
}

function assertSafeId(id: string, label: string): void {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw new Error(`${label} 非法: ${String(id).slice(0, 80)}`);
}

function newArchiveId(projectRoot: string): string {
  const base = new Date().toISOString().replace(/[:.]/g, "-");
  let id = base;
  let n = 2;
  while (fs.existsSync(path.join(archiveRootDir(projectRoot), id))) { id = `${base}-${n}`; n += 1; }
  return id;
}

// 逐文件字节数校验:源树里的每个文件都必须在目标树里存在且 size 一致,否则抛错(调用方绝不删源)。
export function verifyCopiedBytes(src: string, dest: string): void {
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) { verifyCopiedBytes(s, d); continue; }
    if (!entry.isFile()) continue;
    let destStat: fs.Stats;
    try { destStat = fs.statSync(d); } catch { throw new Error(`副本校验失败(目标缺文件): ${d}`); }
    const srcStat = fs.statSync(s);
    if (srcStat.size !== destStat.size) {
      throw new Error(`副本校验失败(字节数不一致 ${srcStat.size}≠${destStat.size}): ${d}`);
    }
  }
}

// 跨盘移动路径:copy 全树 → 逐文件字节数校验 → 校验通过才删源。校验抛错时源目录原样保留。
export function copyVerifyThenRemove(src: string, dest: string): void {
  fs.cpSync(src, dest, { recursive: true, errorOnExist: false });
  verifyCopiedBytes(src, dest);
  fs.rmSync(src, { recursive: true, force: true });
}

// 移动一个目录:优先原子 rename;EXDEV(跨盘)/EPERM(Windows 杀软占用等)回退 copy+verify+删源。
// 目标已存在一律拒绝(绝不覆盖)。
export function moveDir(src: string, dest: string): void {
  if (fs.existsSync(dest)) throw new ArchiveConflictError(`移动目标已存在,拒绝覆盖: ${dest}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EXDEV" && code !== "EPERM") throw e;
  }
  copyVerifyThenRemove(src, dest);
}

interface MovePlan { src: string; dest: string }

// 批量移动,任一失败则把已移动的逐个移回(best-effort);回滚失败的目录仍完整保留在归档目录里,
// manifest 可追溯,证据不丢。
function moveAllOrRollback(plans: MovePlan[]): void {
  const done: MovePlan[] = [];
  try {
    for (const p of plans) { moveDir(p.src, p.dest); done.push(p); }
  } catch (e) {
    for (const p of done.reverse()) {
      try { moveDir(p.dest, p.src); } catch { /* 回滚失败:文件仍在归档目录,不丢 */ }
    }
    throw e;
  }
}

function hasNonManifestFile(dir: string, top = true): boolean {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (hasNonManifestFile(path.join(dir, entry.name), false)) return true;
      continue;
    }
    if (!(top && entry.name === "manifest.json")) return true;
  }
  return false;
}

// 归档中途失败且回滚成功后,归档条目里只剩 manifest.json(无任何被移动的证据文件)才清掉该条目,
// 避免留下"空归档"。只要还残留任何文件就原样保留。
function cleanupEmptyArchiveEntry(entryDir: string): void {
  try {
    if (fs.existsSync(entryDir) && !hasNonManifestFile(entryDir)) {
      fs.rmSync(entryDir, { recursive: true, force: true });
    }
  } catch { /* 保守起见留下目录 */ }
}

function readRunIndexRaw(projectRoot: string): Record<string, RunIndexEntry> {
  return readJSON<Record<string, RunIndexEntry>>(runIndexFileOf(projectRoot), {});
}

// 战役B·Phase B2b:归档从 run 列表(_index 权威)里摘除对应 run —— sqlite 时即删 runs 表对应行
//(task.json 目录已随归档移走,行删除后 loadRunIndex 自然不再列出,与 json 侧删 _index 条目等价)。
function removeRunIndexEntries(projectRoot: string, runIds: string[]): void {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    for (const id of runIds) deleteDoc(db, "runs", id);
    return;
  }
  const idx = readRunIndexRaw(projectRoot);
  let changed = false;
  for (const id of runIds) {
    if (id in idx) { delete idx[id]; changed = true; }
  }
  if (changed) writeJSON(runIndexFileOf(projectRoot), idx);
}

// 恢复时把归档 manifest 里的索引条目写回。sqlite 复用 updateRunIndex(run 目录此时已移回,updateRunIndex
// 重读 task.json 重建真实 run 行 + 带回 manifest 里的 summary/partial),零重复派生逻辑。
function restoreRunIndexEntries(projectRoot: string, entries: Record<string, RunIndexEntry>): void {
  const ids = Object.keys(entries);
  if (ids.length === 0) return;
  if (isSqliteBackend(projectRoot)) {
    for (const id of ids) updateRunIndex(projectRoot, { ...entries[id], id });
    return;
  }
  const idx = readRunIndexRaw(projectRoot);
  for (const id of ids) idx[id] = entries[id];
  writeJSON(runIndexFileOf(projectRoot), idx);
}

export function archiveCompany(projectRoot: string, companyId: string): ArchiveManifest {
  assertSafeId(companyId, "companyId");
  if (companyId === DEFAULT_COMPANY_ID) throw new ArchiveConflictError("默认公司不可归档");
  const companies = loadCompanies(projectRoot);
  const company = companies.find((c) => c.id === companyId);
  if (!company) throw new ArchiveNotFoundError(`公司不存在: ${companyId}`);

  const index = loadRunIndex(projectRoot);
  const companyRuns = index.filter((e) => e.companyId === companyId);
  const active = companyRuns.filter((e) => ACTIVE_RUN_STATUSES.has(e.status));
  if (active.length > 0) {
    throw new ArchiveConflictError(`该公司还有 ${active.length} 个任务在进行/排队中,等它们结束后再归档`);
  }

  const allAgents = loadAgents(projectRoot, []);
  const companyAgents = allAgents.filter((a) => (a.companyId || DEFAULT_COMPANY_ID) === companyId);
  const remainingAgents = allAgents.filter((a) => (a.companyId || DEFAULT_COMPANY_ID) !== companyId);

  const runIds = companyRuns
    .map((e) => e.id)
    .filter((id) => SAFE_ID.test(id) && fs.existsSync(runDirOf(projectRoot, id)));

  const archiveId = newArchiveId(projectRoot);
  const entryDir = path.join(archiveRootDir(projectRoot), archiveId);
  const payloadDir = path.join(entryDir, `company-${companyId}`);

  const originalPaths: Record<string, string> = {
    [`company-${companyId}/company.json→companies.json 条目`]: `${OPC_DIR}/companies.json`,
    [`company-${companyId}/agents(见 manifest.agents)`]: `${OPC_DIR}/agents.json`,
  };
  const runIndexEntries: Record<string, RunIndexEntry> = {};
  for (const rid of runIds) {
    originalPaths[`company-${companyId}/runs/${rid}`] = `${OPC_DIR}/runs/${rid}`;
    const e = companyRuns.find((x) => x.id === rid);
    if (e) runIndexEntries[rid] = e;
  }

  const manifest: ArchiveManifest = {
    kind: "company",
    archiveId,
    id: companyId,
    name: company.name,
    archivedAt: new Date().toISOString(),
    company,
    agents: companyAgents,
    runIds,
    originalPaths,
    runIndexEntries,
  };

  // 证据链先行:manifest 先落盘,再移动 run 目录,最后才改写 companies/agents/索引状态文件。
  writeJSON(path.join(entryDir, "manifest.json"), manifest);
  try {
    moveAllOrRollback(runIds.map((rid) => ({ src: runDirOf(projectRoot, rid), dest: path.join(payloadDir, "runs", rid) })));
  } catch (e) {
    cleanupEmptyArchiveEntry(entryDir);
    throw e;
  }
  saveCompanies(projectRoot, companies.filter((c) => c.id !== companyId));
  saveAgents(projectRoot, remainingAgents);
  removeRunIndexEntries(projectRoot, runIds);
  return manifest;
}

export function archiveRuns(projectRoot: string, runIds: string[]): ArchiveManifest {
  if (!Array.isArray(runIds) || runIds.length === 0) throw new Error("runIds 不能为空");
  const unique = [...new Set(runIds)];
  for (const id of unique) assertSafeId(id, "runId");

  const missing = unique.filter((id) => !fs.existsSync(runDirOf(projectRoot, id)));
  if (missing.length > 0) throw new ArchiveNotFoundError(`这些 run 不存在: ${missing.join(", ")}`);

  const indexById = new Map(loadRunIndex(projectRoot).map((e) => [e.id, e]));
  const active = unique.filter((id) => {
    const e = indexById.get(id);
    return !!e && ACTIVE_RUN_STATUSES.has(e.status);
  });
  if (active.length > 0) {
    throw new ArchiveConflictError(`这些 run 还在进行/排队中,不能归档: ${active.join(", ")}`);
  }

  const archiveId = newArchiveId(projectRoot);
  const entryDir = path.join(archiveRootDir(projectRoot), archiveId);

  const originalPaths: Record<string, string> = {};
  const runIndexEntries: Record<string, RunIndexEntry> = {};
  for (const rid of unique) {
    originalPaths[`runs/${rid}`] = `${OPC_DIR}/runs/${rid}`;
    const e = indexById.get(rid);
    if (e) runIndexEntries[rid] = e;
  }

  const manifest: ArchiveManifest = {
    kind: "runs",
    archiveId,
    id: archiveId,
    archivedAt: new Date().toISOString(),
    agents: [],
    runIds: unique,
    originalPaths,
    runIndexEntries,
  };

  writeJSON(path.join(entryDir, "manifest.json"), manifest);
  try {
    moveAllOrRollback(unique.map((rid) => ({ src: runDirOf(projectRoot, rid), dest: path.join(entryDir, "runs", rid) })));
  } catch (e) {
    cleanupEmptyArchiveEntry(entryDir);
    throw e;
  }
  removeRunIndexEntries(projectRoot, unique);
  return manifest;
}

export function restoreArchive(projectRoot: string, archiveId: string): ArchiveManifest {
  assertSafeId(archiveId, "archiveId");
  const entryDir = path.join(archiveRootDir(projectRoot), archiveId);
  const manifestPath = path.join(entryDir, "manifest.json");
  const manifest = readJSON<ArchiveManifest | null>(manifestPath, null);
  if (!manifest) throw new ArchiveNotFoundError(`归档不存在: ${archiveId}`);
  if (manifest.restoredAt) throw new ArchiveConflictError(`该归档已于 ${manifest.restoredAt} 恢复过,不能重复恢复`);

  // 冲突预检(报错不覆盖):任何一项撞车都整体中止,不做半恢复。
  const conflicts: string[] = [];
  if (manifest.kind === "company") {
    if (loadCompanies(projectRoot).some((c) => c.id === manifest.id)) conflicts.push(`公司 ${manifest.id} 已存在`);
    const existingAgentIds = new Set(loadAgents(projectRoot, []).map((a) => a.id));
    for (const a of manifest.agents) {
      if (existingAgentIds.has(a.id)) conflicts.push(`员工 ${a.id} 已存在`);
    }
  }
  for (const rid of manifest.runIds) {
    if (fs.existsSync(runDirOf(projectRoot, rid))) conflicts.push(`run ${rid} 已存在`);
  }
  if (conflicts.length > 0) {
    throw new ArchiveConflictError(`恢复冲突,已中止(不覆盖现有数据): ${conflicts.join("; ")}`);
  }

  const payloadRuns = manifest.kind === "company"
    ? path.join(entryDir, `company-${manifest.id}`, "runs")
    : path.join(entryDir, "runs");
  const plans: MovePlan[] = manifest.runIds
    .filter((rid) => fs.existsSync(path.join(payloadRuns, rid)))
    .map((rid) => ({ src: path.join(payloadRuns, rid), dest: runDirOf(projectRoot, rid) }));
  moveAllOrRollback(plans);

  if (manifest.kind === "company" && manifest.company) {
    saveCompanies(projectRoot, [...loadCompanies(projectRoot), manifest.company]);
    saveAgents(projectRoot, [...loadAgents(projectRoot, []), ...manifest.agents]);
  }
  restoreRunIndexEntries(projectRoot, manifest.runIndexEntries ?? {});

  const restored: ArchiveManifest = { ...manifest, restoredAt: new Date().toISOString() };
  writeJSON(manifestPath, restored);
  return restored;
}

export function listArchives(projectRoot: string): ArchiveListItem[] {
  const rootDir = archiveRootDir(projectRoot);
  if (!fs.existsSync(rootDir)) return [];
  const items: ArchiveListItem[] = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readJSON<ArchiveManifest | null>(path.join(rootDir, entry.name, "manifest.json"), null);
    if (!m || (m.kind !== "company" && m.kind !== "runs")) continue;
    items.push({
      archiveId: m.archiveId ?? entry.name,
      kind: m.kind,
      id: m.id,
      name: m.name,
      archivedAt: m.archivedAt ?? "",
      runCount: Array.isArray(m.runIds) ? m.runIds.length : 0,
      agentCount: Array.isArray(m.agents) ? m.agents.length : 0,
      restoredAt: m.restoredAt,
    });
  }
  return items.sort((a, b) => (b.archivedAt || "").localeCompare(a.archivedAt || ""));
}

export function getArchiveManifest(projectRoot: string, archiveId: string): ArchiveManifest | null {
  assertSafeId(archiveId, "archiveId");
  return readJSON<ArchiveManifest | null>(path.join(archiveRootDir(projectRoot), archiveId, "manifest.json"), null);
}
