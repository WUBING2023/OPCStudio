import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { EffectiveCapabilityManifest, RunTestEvidence, WorkerLaunchReceipt } from "@opc/shared";

// 战役B · EvidenceManifest 单一证据清单(codex 修正:A8+B4 合并——run 目录 22 类证据的唯一索引)。
// B0 立骨架(纯只读扫描),B4 合入相接上:run-end 构建、A8 testEvidence 填 tests、manifest.json 双落
// (writeEvidenceManifest + storage/sqlite/evidenceStore 表)、verify 模式重算检篡改、hash util 与
// artifactRegistry 统一(artifactRegistry 现调本文件 sha256Hex)。
//
// 设计纪律(与产品宪法对齐):
// 1. runDir 由调用方给定(orchestrator 传 .opc/runs/<id>),本模块绝不自行拼存储库路径 —— 读侧纯函数;
//    写侧 writeEvidenceManifest 也只往 runDir 落 manifest.json,不构造 ".opc" 字面量(缝隙守卫语义不变)。
// 2. 缺失文件跳过:不报错、不虚构条目;读不到字节就没有 hash,绝不编造。
// 3. tests 来自 A8 deriveTestEvidence(worker 真实执行过的测试);无真实执行证据 → null,绝不硬编码假值。
// 4. files[].sha256 为纯 hex(字段名已标明算法);artifactDownloads 里照抄 artifacts.json 的
//    hash 字段则保留其原有 "sha256:<hex>" 前缀风格,不重算、不改写。

// ── 证据文件 23 类全集(施工计划 §0.2 的 22 类 + MUP 波2 的 producer-manifest.json)──────
// 21 个单文件 + 2 个目录(artifacts/*、logs/*)= 23 类。

export type EvidenceKind =
  | "receipt_ledger"
  | "task"                // task.json
  | "report_md"           // report.md
  | "report_html"         // report.html
  | "events"              // events.jsonl
  | "trace"               // trace.json
  | "cost"                // cost.json
  | "changes"             // changes.json
  | "deferred"            // deferred.json
  | "structured_report"   // structured-report.json
  | "memory_proposals"    // memory_proposals.json
  | "committed_memories"  // committed-memories.json
  | "failure_report"      // failure-report.json
  | "run_history"         // run-history.jsonl
  | "run_summary"         // run-summary.json
  | "result"              // result.json
  | "diagnostics"         // diagnostics.json
  | "tool_calls"          // tool_calls.jsonl
  | "a2a_messages"        // a2a_messages.jsonl
  | "artifact_registry"   // artifacts.json
  | "worker_config"       // worker.config.json
  | "producer_manifest"   // producer-manifest.json(MUP 波2:ProducerArtifactManifest 冻结产物指纹)
  | "artifact_entity"     // artifacts/**(实体副本目录)
  | "log";                // logs/**(引擎/进程日志目录)

const RUN_EVIDENCE_FILES: ReadonlyArray<{ readonly name: string; readonly kind: EvidenceKind }> = [
  { name: "task.json", kind: "task" },
  { name: "report.md", kind: "report_md" },
  { name: "report.html", kind: "report_html" },
  { name: "events.jsonl", kind: "events" },
  { name: "trace.json", kind: "trace" },
  { name: "cost.json", kind: "cost" },
  { name: "changes.json", kind: "changes" },
  { name: "deferred.json", kind: "deferred" },
  { name: "structured-report.json", kind: "structured_report" },
  { name: "memory_proposals.json", kind: "memory_proposals" },
  { name: "committed-memories.json", kind: "committed_memories" },
  { name: "failure-report.json", kind: "failure_report" },
  { name: "run-history.jsonl", kind: "run_history" },
  { name: "run-summary.json", kind: "run_summary" },
  { name: "result.json", kind: "result" },
  { name: "diagnostics.json", kind: "diagnostics" },
  { name: "tool_calls.jsonl", kind: "tool_calls" },
  { name: "a2a_messages.jsonl", kind: "a2a_messages" },
  { name: "artifacts.json", kind: "artifact_registry" },
  { name: "worker.config.json", kind: "worker_config" },
  { name: "producer-manifest.json", kind: "producer_manifest" },
];

const RUN_EVIDENCE_DIRS: ReadonlyArray<{ readonly name: string; readonly kind: EvidenceKind }> = [
  { name: "artifacts", kind: "artifact_entity" },
  { name: "logs", kind: "log" },
];

const EVIDENCE_RECEIPTS_FILE = "evidence-receipts.json";
const REQUIRED_RECEIPT_PATHS = new Set([
  "task.json", "report.md", "report.html", "events.jsonl", "trace.json", "cost.json",
  "changes.json", "deferred.json", "structured-report.json", "result.json", "artifacts.json",
]);

// ── 类型 ─────────────────────────────────────────────────────────────────────────

export interface EvidenceFileEntry {
  path: string;      // 相对 run 目录,posix 分隔(如 "artifacts/report.md")
  sha256: string;    // 内容指纹,纯 hex(不带 "sha256:" 前缀)
  size: number;      // 字节数,与 hash 同一次读取得出
  kind: EvidenceKind;
  createdAt: string; // ISO 时间。取文件 mtime:证据文件都是 run 内一次性写定,mtime≈定稿时间;
                     // 不用 birthtime(Windows 文件名隧道效应会给出误导性旧值)。
}

// changes.json(FileChange[])的索引化摘要:只保留 path+changeType。
// before/after 全文不进 manifest —— changes.json 本体已作为 files[] 条目被整体 hash,
// manifest 是索引不是 blob 仓库。changeType 原样透传(缺失记 null,不虚构)。
export interface WorkspaceChangeEntry {
  path: string;
  changeType: string | null;
}

// artifacts.json 的下载映射:哪些 artifact 可下载/有实体副本。字段全部照抄原文件,
// 不在此重算 hash/size(重算与统一校验归 B4 合入相的 verify 模式)。
export interface ArtifactDownloadEntry {
  artifactId: string;
  kind?: string;        // artifacts.json 的 RunArtifact.kind(report/file/worker-output/review-result)
  path?: string;        // 工作区相对路径(kind=file 才有)
  downloadUrl?: string; // 下载端点
  savedPath?: string;   // run 目录内实体副本相对路径(如 "artifacts/report.md")
  hash?: string;        // 照抄,保留 "sha256:<hex>" 前缀风格
  size?: number;        // 照抄
}

export type PermissionEvidenceSource =
  | "committed-events"
  | "uncommitted-events"
  | "invalid-committed-events"
  | "missing-events";

export interface WorkerPermissionPosture {
  agentId: string;
  taskId: string;
  attempt: number;
  engine: string;
  adapter: string;
  launchKind: WorkerLaunchReceipt["launchKind"];
  sandboxBackend: WorkerLaunchReceipt["sandboxBackend"];
  fullHostAccess: boolean;
  network: { requested: string; effective: string };
  shell: { requested: string; effective: string };
  file: { requestedWrite: boolean | null; effective: "full-host" | "workspace-write" | "read-only" | "unknown"; rootCount: number };
  unsupportedConstraints: string[];
  approvalMode: WorkerLaunchReceipt["approvalMode"];
  receiptCompleteness: WorkerLaunchReceipt["completeness"];
}

export interface ExecutionPermissionPosture {
  source: PermissionEvidenceSource;
  completeness: "complete" | "incomplete" | "not_applicable";
  reasons: string[];
  expectedAgentIds: string[];
  receiptAgentIds: string[];
  missingReceiptAgentIds: string[];
  fullHostAccess: boolean;
  noOsSandbox: boolean;
  unsupportedConstraints: string[];
  approvalModes: string[];
  workers: WorkerPermissionPosture[];
}

export interface EvidenceManifest {
  schemaVersion: 1;
  runId: string;       // 取 runDir 目录名(run 目录即以 runId 命名)
  generatedAt: string; // 本 manifest 构建时刻(ISO)
  files: EvidenceFileEntry[];
  // null = 对应源文件缺失/损坏(与"存在但为空数组"严格区分,不虚构空账本)
  workspaceChanges: WorkspaceChangeEntry[] | null;
  artifactDownloads: ArtifactDownloadEntry[] | null;
  receiptLedgerSha256?: string;
  /** Optional in the persisted type so pre-permission historical manifests remain readable. New manifests always write both fields. */
  permissionPosture?: ExecutionPermissionPosture;
  evidenceComplete?: boolean;
  // A8 TestEvidence:worker 在其 workdir 真实执行过的测试(deriveTestEvidence 派生,零推断);
  // 无真实执行证据 → null(严格区分"没测过"与"测了但空",绝不硬编码假值)。
  tests: RunTestEvidence[] | null;
}

export interface EvidenceReceiptLedger {
  schemaVersion: 1;
  runId: string;
  committedAt: string;
  files: EvidenceFileEntry[];
  workspaceChanges: WorkspaceChangeEntry[] | null;
  artifactDownloads: ArtifactDownloadEntry[] | null;
  tests: RunTestEvidence[] | null;
}

// ── 纯 hash util(自带,不依赖 artifactRegistry;B4 合入相再统一抽公共 util)──────────

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── 内部工具(全部绝不抛:证据构建失败不该让任何调用方崩溃)──────────────────────────

function hashFileEntry(abs: string, relPosix: string, kind: EvidenceKind): EvidenceFileEntry | null {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    const buf = fs.readFileSync(abs);
    return {
      path: relPosix,
      sha256: sha256Hex(buf),
      size: buf.byteLength,
      kind,
      createdAt: st.mtime.toISOString(),
    };
  } catch {
    return null; // 读不到(权限/竞态删除/损坏)→ 如实跳过,不虚构
  }
}

// 递归列出目录下全部文件的相对路径(posix 分隔),排序保证 manifest 确定性;目录缺失返回 []。
function listFilesRecursive(dirAbs: string, prefix = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesRecursive(path.join(dirAbs, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

// 无副作用的 JSON 读取:parse 失败/文件缺失一律返回 null。
// 刻意不用 storage/jsonFile.readJSON —— 那个在损坏时会写 .corrupt 存证副本(写副作用),
// 而本模块承诺纯只读;损坏存证是读写链路的职责,不是证据索引器的。
function readJsonSafe(abs: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(abs, "utf-8"));
  } catch {
    return null;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

interface EvidenceEventRecord {
  index: number;
  type?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function readEvidenceEvents(runDir: string): EvidenceEventRecord[] {
  try {
    return fs.readFileSync(path.join(runDir, "events.jsonl"), "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line, index) => {
        try {
          const raw = JSON.parse(line) as unknown;
          if (!isRecord(raw)) return [];
          return [{
            index,
            ...(typeof raw.type === "string" ? { type: raw.type } : {}),
            ...(typeof raw.agentId === "string" ? { agentId: raw.agentId } : {}),
            ...(isRecord(raw.payload) ? { payload: raw.payload } : {}),
          }];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function validCapabilityManifest(value: unknown): value is EffectiveCapabilityManifest {
  if (!isRecord(value) || value.schemaVersion !== "1" || typeof value.manifestHash !== "string") return false;
  if (!isRecord(value.requested) || !isRecord(value.effective) || !Array.isArray(value.unsupportedConstraints)) return false;
  const effective = value.effective;
  return typeof value.agentId === "string"
    && typeof value.taskId === "string"
    && typeof value.framework === "string"
    && typeof value.requested.fileWrite === "boolean"
    && typeof value.requested.shell === "string"
    && typeof value.requested.network === "string"
    && Array.isArray(effective.fileRoots)
    && typeof effective.shell === "string"
    && typeof effective.network === "string"
    && typeof effective.sandboxBackend === "string"
    && typeof effective.fullHostAccess === "boolean"
    && typeof effective.approvalMode === "string";
}

function validLaunchReceipt(value: unknown): value is WorkerLaunchReceipt {
  if (!isRecord(value) || value.schemaVersion !== "1") return false;
  return typeof value.runId === "string"
    && typeof value.taskId === "string"
    && typeof value.agentId === "string"
    && typeof value.attempt === "number"
    && (value.launchKind === "in-process" || value.launchKind === "subprocess")
    && typeof value.sandboxBackend === "string"
    && typeof value.fullHostAccess === "boolean"
    && typeof value.approvalMode === "string"
    && typeof value.capabilityManifestHash === "string"
    && (value.completeness === "partial" || value.completeness === "complete");
}

function committedFileMatches(runDir: string, ledger: EvidenceReceiptLedger | null, relativePath: string): boolean {
  if (!ledger) return false;
  const receipt = ledger.files.find((entry) => entry.path === relativePath);
  if (!receipt) return false;
  try {
    return sha256Hex(fs.readFileSync(path.join(runDir, relativePath))) === receipt.sha256;
  } catch {
    return false;
  }
}

function expectedPermissionAgents(runDir: string, events: EvidenceEventRecord[], taskTrusted: boolean): string[] {
  const expected = new Set<string>();
  for (const event of events) {
    if (event.type === "model_call_started" && event.agentId) expected.add(event.agentId);
  }
  if (taskTrusted) {
    const task = readJsonSafe(path.join(runDir, "task.json"));
    if (isRecord(task) && Array.isArray(task.participatingAgents)) {
      for (const id of task.participatingAgents) if (typeof id === "string" && id) expected.add(id);
    }
  }
  return uniqueSorted(expected);
}

function nearestExecutorEvent(events: EvidenceEventRecord[], receiptEvent: EvidenceEventRecord): Record<string, unknown> | undefined {
  return events
    .filter((event) => event.agentId === receiptEvent.agentId && event.payload?.kind === "executor_selected")
    .sort((a, b) => Math.abs(a.index - receiptEvent.index) - Math.abs(b.index - receiptEvent.index))[0]?.payload;
}

export function summarizeExecutionPermissionPosture(
  runDir: string,
  ledger: EvidenceReceiptLedger | null = loadEvidenceReceiptLedger(runDir),
): ExecutionPermissionPosture {
  const eventsPath = path.join(runDir, "events.jsonl");
  const eventsExist = fs.existsSync(eventsPath);
  const eventsCommitted = committedFileMatches(runDir, ledger, "events.jsonl");
  const source: PermissionEvidenceSource = !eventsExist
    ? "missing-events"
    : ledger && !eventsCommitted
      ? "invalid-committed-events"
      : eventsCommitted
        ? "committed-events"
        : "uncommitted-events";
  const events = source === "invalid-committed-events" || source === "missing-events" ? [] : readEvidenceEvents(runDir);
  const taskTrusted = ledger ? committedFileMatches(runDir, ledger, "task.json") : fs.existsSync(path.join(runDir, "task.json"));
  const expectedAgentIds = expectedPermissionAgents(runDir, events, taskTrusted);
  const capabilityByHash = new Map<string, EffectiveCapabilityManifest>();
  for (const event of events) {
    if (event.payload?.kind !== "effective_capability_manifest") continue;
    const candidate = event.payload.manifest;
    if (validCapabilityManifest(candidate)) capabilityByHash.set(candidate.manifestHash, candidate);
  }

  const reasons: string[] = [];
  if (source !== "committed-events") reasons.push(source === "invalid-committed-events" ? "committed_events_hash_mismatch" : source);
  let malformedReceipts = 0;
  const workers: WorkerPermissionPosture[] = [];
  for (const event of events) {
    if (event.payload?.kind !== "worker_launch_receipt") continue;
    const receipt = event.payload.receipt;
    if (!validLaunchReceipt(receipt) || receipt.runId !== path.basename(runDir)) {
      malformedReceipts += 1;
      continue;
    }
    const capability = capabilityByHash.get(receipt.capabilityManifestHash);
    const executor = nearestExecutorEvent(events, event);
    const engine = typeof executor?.engine === "string"
      ? executor.engine
      : capability?.framework ?? "unknown";
    const adapter = typeof executor?.executor === "string"
      ? executor.executor
      : receipt.launchKind === "in-process" ? "api" : "unknown";
    const fileRoots = capability?.effective.fileRoots ?? [];
    const writableRootCount = fileRoots.filter((root) => root.write).length;
    const fileEffective: WorkerPermissionPosture["file"]["effective"] = !capability
      ? "unknown"
      : receipt.fullHostAccess
        ? "full-host"
        : writableRootCount > 0 ? "workspace-write" : "read-only";
    const unsupportedConstraints = capability?.unsupportedConstraints.filter((item): item is string => typeof item === "string") ?? [];
    workers.push({
      agentId: receipt.agentId,
      taskId: receipt.taskId,
      attempt: receipt.attempt,
      engine,
      adapter,
      launchKind: receipt.launchKind,
      sandboxBackend: receipt.sandboxBackend,
      fullHostAccess: receipt.fullHostAccess,
      network: {
        requested: capability?.requested.network ?? "unknown",
        effective: capability?.effective.network ?? "unknown",
      },
      shell: {
        requested: capability?.requested.shell ?? "unknown",
        effective: capability?.effective.shell ?? "unknown",
      },
      file: {
        requestedWrite: capability?.requested.fileWrite ?? null,
        effective: fileEffective,
        rootCount: fileRoots.length,
      },
      unsupportedConstraints,
      approvalMode: receipt.approvalMode,
      receiptCompleteness: receipt.completeness,
    });
    if (!capability) reasons.push(`missing_capability_manifest:${receipt.agentId}:${receipt.taskId}`);
    if (receipt.completeness !== "complete") reasons.push(`partial_launch_receipt:${receipt.agentId}:${receipt.taskId}`);
    if (engine === "unknown") reasons.push(`missing_engine:${receipt.agentId}:${receipt.taskId}`);
    if (adapter === "unknown") reasons.push(`missing_adapter:${receipt.agentId}:${receipt.taskId}`);
    if (capability && (
      capability.agentId !== receipt.agentId
      || capability.taskId !== receipt.taskId
      || capability.effective.sandboxBackend !== receipt.sandboxBackend
      || capability.effective.fullHostAccess !== receipt.fullHostAccess
      || capability.effective.approvalMode !== receipt.approvalMode
    )) reasons.push(`receipt_capability_mismatch:${receipt.agentId}:${receipt.taskId}`);
  }
  if (malformedReceipts > 0) reasons.push(`malformed_launch_receipts:${malformedReceipts}`);

  const receiptAgentIds = uniqueSorted(workers.map((worker) => worker.agentId));
  const received = new Set(receiptAgentIds);
  const missingReceiptAgentIds = expectedAgentIds.filter((id) => !received.has(id));
  for (const id of missingReceiptAgentIds) reasons.push(`missing_launch_receipt:${id}`);
  const normalizedReasons = uniqueSorted(reasons);
  const noExecutionExpected = expectedAgentIds.length === 0 && workers.length === 0;
  const completeness: ExecutionPermissionPosture["completeness"] = source === "committed-events" && noExecutionExpected
    ? "not_applicable"
    : source === "committed-events" && normalizedReasons.length === 0
      ? "complete"
      : "incomplete";
  return {
    source,
    completeness,
    reasons: normalizedReasons,
    expectedAgentIds,
    receiptAgentIds,
    missingReceiptAgentIds,
    fullHostAccess: workers.some((worker) => worker.fullHostAccess),
    noOsSandbox: workers.some((worker) => worker.sandboxBackend === "none"),
    unsupportedConstraints: uniqueSorted(workers.flatMap((worker) => worker.unsupportedConstraints)),
    approvalModes: uniqueSorted(workers.map((worker) => worker.approvalMode)),
    workers,
  };
}

function readWorkspaceChanges(runDir: string): WorkspaceChangeEntry[] | null {
  const raw = readJsonSafe(path.join(runDir, "changes.json"));
  if (!Array.isArray(raw)) return null;
  const out: WorkspaceChangeEntry[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.path !== "string") continue; // 无 path 的条目不可索引,跳过
    out.push({
      path: item.path,
      changeType: typeof item.changeType === "string" ? item.changeType : null,
    });
  }
  return out;
}

function readArtifactDownloads(runDir: string): ArtifactDownloadEntry[] | null {
  const raw = readJsonSafe(path.join(runDir, "artifacts.json"));
  if (!isRecord(raw) || !Array.isArray(raw.artifacts)) return null;
  const out: ArtifactDownloadEntry[] = [];
  for (const item of raw.artifacts) {
    if (!isRecord(item) || typeof item.id !== "string") continue;
    const downloadUrl = typeof item.downloadUrl === "string" ? item.downloadUrl : undefined;
    const savedPath = typeof item.savedPath === "string" ? item.savedPath : undefined;
    if (!downloadUrl && !savedPath) continue; // 没有任何可取回入口的 artifact 不属于"下载映射"
    const entry: ArtifactDownloadEntry = { artifactId: item.id };
    if (typeof item.kind === "string") entry.kind = item.kind;
    if (typeof item.path === "string") entry.path = item.path;
    if (downloadUrl) entry.downloadUrl = downloadUrl;
    if (savedPath) entry.savedPath = savedPath;
    if (typeof item.hash === "string") entry.hash = item.hash;
    if (typeof item.size === "number") entry.size = item.size;
    out.push(entry);
  }
  return out;
}

// ── 主入口 ───────────────────────────────────────────────────────────────────────

// 扫描一个 run 目录,构建单一证据清单。纯函数(仅读 fs):
// - 覆盖全部 23 类证据文件(§0.2 的 22 类 + producer-manifest.json);存在的算 sha256+size+kind+createdAt,缺失的跳过。
// - files 顺序确定:21 个单文件按声明序,artifacts/**、logs/** 各自按路径字典序。
// - runDir 不存在 → 返回空清单(files=[]、两个汇入源=null),不抛错。
function writeJsonAtomic(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: "utf-8", flag: "wx" });
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}

function safeReceiptPath(runDir: string, relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
    throw new Error(`invalid evidence receipt path: ${relativePath}`);
  }
  const absolute = path.resolve(runDir, normalized);
  const base = path.resolve(runDir);
  const cmpBase = process.platform === "win32" ? base.toLowerCase() : base;
  const cmpAbsolute = process.platform === "win32" ? absolute.toLowerCase() : absolute;
  if (cmpAbsolute !== cmpBase && !cmpAbsolute.startsWith(cmpBase + path.sep)) {
    throw new Error(`evidence receipt escapes run directory: ${relativePath}`);
  }
  return absolute;
}

export function loadEvidenceReceiptLedger(runDir: string): EvidenceReceiptLedger | null {
  const raw = readJsonSafe(path.join(runDir, EVIDENCE_RECEIPTS_FILE));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.runId !== path.basename(runDir) || !Array.isArray(raw.files)) return null;
  if (raw.files.length === 0) return null;
  return raw as unknown as EvidenceReceiptLedger;
}

export function commitEvidenceReceipts(runDir: string, testEvidence?: RunTestEvidence[] | null): EvidenceReceiptLedger {
  const files: EvidenceFileEntry[] = [];
  for (const spec of RUN_EVIDENCE_FILES) {
    const entry = hashFileEntry(safeReceiptPath(runDir, spec.name), spec.name, spec.kind);
    if (!entry && REQUIRED_RECEIPT_PATHS.has(spec.name)) throw new Error(`required evidence was not committed: ${spec.name}`);
    if (entry) files.push(entry);
  }

  const artifactDownloads = readArtifactDownloads(runDir);
  for (const artifact of artifactDownloads ?? []) {
    if (!artifact.savedPath) continue;
    const relativePath = artifact.savedPath.replace(/\\/g, "/");
    const entry = hashFileEntry(safeReceiptPath(runDir, relativePath), relativePath, "artifact_entity");
    if (!entry) throw new Error(`artifact registry references an uncommitted file: ${relativePath}`);
    if (artifact.hash) {
      const expected = artifact.hash.replace(/^sha256:/, "");
      if (expected !== entry.sha256) throw new Error(`artifact receipt hash mismatch: ${relativePath}`);
    }
    files.push(entry);
  }

  const ledger: EvidenceReceiptLedger = {
    schemaVersion: 1,
    runId: path.basename(runDir),
    committedAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    workspaceChanges: readWorkspaceChanges(runDir),
    artifactDownloads,
    tests: testEvidence && testEvidence.length > 0 ? testEvidence : null,
  };
  writeJsonAtomic(path.join(runDir, EVIDENCE_RECEIPTS_FILE), ledger);
  return ledger;
}

export function buildEvidenceManifest(runDir: string, testEvidence?: RunTestEvidence[] | null): EvidenceManifest {
  const receipts = loadEvidenceReceiptLedger(runDir);
  if (receipts) {
    const permissionPosture = summarizeExecutionPermissionPosture(runDir, receipts);
    const receiptEntry = hashFileEntry(path.join(runDir, EVIDENCE_RECEIPTS_FILE), EVIDENCE_RECEIPTS_FILE, "receipt_ledger");
    if (!receiptEntry) throw new Error("evidence receipt ledger disappeared before manifest projection");
    return {
      schemaVersion: 1,
      runId: receipts.runId,
      generatedAt: new Date().toISOString(),
      files: [...receipts.files, receiptEntry],
      workspaceChanges: receipts.workspaceChanges,
      artifactDownloads: receipts.artifactDownloads,
      tests: receipts.tests,
      receiptLedgerSha256: receiptEntry.sha256,
      permissionPosture,
      evidenceComplete: permissionPosture.completeness !== "incomplete",
    };
  }
  const permissionPosture = summarizeExecutionPermissionPosture(runDir, null);
  const files: EvidenceFileEntry[] = [];

  for (const spec of RUN_EVIDENCE_FILES) {
    const entry = hashFileEntry(path.join(runDir, spec.name), spec.name, spec.kind);
    if (entry) files.push(entry);
  }

  for (const dirSpec of RUN_EVIDENCE_DIRS) {
    const dirAbs = path.join(runDir, dirSpec.name);
    for (const rel of listFilesRecursive(dirAbs)) {
      const entry = hashFileEntry(path.join(dirAbs, rel), `${dirSpec.name}/${rel}`, dirSpec.kind);
      if (entry) files.push(entry);
    }
  }

  return {
    schemaVersion: 1,
    runId: path.basename(runDir),
    generatedAt: new Date().toISOString(),
    files,
    workspaceChanges: readWorkspaceChanges(runDir),
    artifactDownloads: readArtifactDownloads(runDir),
    permissionPosture,
    evidenceComplete: false,
    // A8 合入:有真实测试证据才带出,空数组/未传 → null(不虚构"测了但空")
    tests: testEvidence && testEvidence.length > 0 ? testEvidence : null,
  };
}

// ── B4 合入相:写侧 + verify(证据链的写盘与自证)──────────────────────────────────────

// 把 manifest 原子写进 run 目录。证据清单是成功声明的一部分,写失败必须抛给调用方。
export function writeEvidenceManifest(runDir: string, manifest: EvidenceManifest): void {
  const target = path.join(runDir, "manifest.json");
  writeJsonAtomic(target, manifest);
}

// 读回已落盘的 manifest.json;缺失/损坏返回 null。
export function loadEvidenceManifest(runDir: string): EvidenceManifest | null {
  const raw = readJsonSafe(path.join(runDir, "manifest.json"));
  if (!isRecord(raw) || raw.schemaVersion !== 1 || raw.runId !== path.basename(runDir)) return null;
  const files = (raw as { files?: unknown }).files;
  if (!Array.isArray(files) || files.length === 0) return null;
  const permissionPosture = summarizeExecutionPermissionPosture(runDir);
  return {
    ...(raw as unknown as EvidenceManifest),
    permissionPosture,
    evidenceComplete: permissionPosture.completeness !== "incomplete",
  };
}

export interface EvidenceVerifyResult {
  ok: boolean;
  checked: number;
  evidenceComplete: boolean;
  permissionPosture: ExecutionPermissionPosture;
  // actual=null 表示该证据文件已被删除/读不到(比 hash 不一致更严重的篡改信号)
  mismatches: Array<{ path: string; expected: string; actual: string | null }>;
}

// verify 模式:对 manifest.files 逐条重算磁盘现字节 sha256,与 manifest 存的比对。任一不一致/文件消失
// → ok=false。用途:证据链防篡改自证(改 report.md 一个字节即可检出)。manifest 不传则从 manifest.json 读回。
export function verifyEvidenceManifest(runDir: string, manifest?: EvidenceManifest | null): EvidenceVerifyResult {
  void manifest;
  const m = loadEvidenceManifest(runDir);
  if (!m) {
    const permissionPosture = summarizeExecutionPermissionPosture(runDir);
    return {
      ok: false,
      checked: 0,
      evidenceComplete: false,
      permissionPosture,
      mismatches: [{ path: "manifest.json", expected: "<present>", actual: null }],
    };
  }
  const mismatches: EvidenceVerifyResult["mismatches"] = [];
  if (m.receiptLedgerSha256) {
    const ledgerPath = path.join(runDir, EVIDENCE_RECEIPTS_FILE);
    let actualLedgerHash: string | null = null;
    try { actualLedgerHash = sha256Hex(fs.readFileSync(ledgerPath)); } catch { actualLedgerHash = null; }
    if (actualLedgerHash !== m.receiptLedgerSha256) {
      mismatches.push({ path: EVIDENCE_RECEIPTS_FILE, expected: m.receiptLedgerSha256, actual: actualLedgerHash });
    }
    const ledger = loadEvidenceReceiptLedger(runDir);
    if (!ledger) {
      mismatches.push({ path: EVIDENCE_RECEIPTS_FILE, expected: "<valid receipt ledger>", actual: actualLedgerHash });
    } else {
      const receiptMap = new Map(ledger.files.map((entry) => [entry.path, entry]));
      for (const file of m.files) {
        if (file.kind === "receipt_ledger") continue;
        const receipt = receiptMap.get(file.path);
        if (!receipt || receipt.sha256 !== file.sha256 || receipt.size !== file.size || receipt.kind !== file.kind) {
          mismatches.push({ path: file.path, expected: file.sha256, actual: receipt?.sha256 ?? null });
        }
      }
    }
  }
  for (const f of m.files) {
    let actual: string | null = null;
    try { actual = sha256Hex(fs.readFileSync(path.join(runDir, f.path))); } catch { actual = null; }
    if (actual !== f.sha256) mismatches.push({ path: f.path, expected: f.sha256, actual });
  }
  const ok = mismatches.length === 0;
  const permissionPosture = m.permissionPosture ?? summarizeExecutionPermissionPosture(runDir);
  return {
    ok,
    checked: m.files.length,
    evidenceComplete: ok && permissionPosture.completeness !== "incomplete",
    permissionPosture,
    mismatches,
  };
}
