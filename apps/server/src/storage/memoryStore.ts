import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryEntry, MemoryQuery } from "@opc/shared";
import { normalizeCompanyId } from "@opc/shared";
import { tokenize, matchingTagCount } from "./textTokenize.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs, upsertDoc } from "./sqlite/docTableBackend.js";
// 收口作战令一.2:excluded-run 判定从 runtime/committedMemoryRetriever 提取到 storage 层无状态
// policy 模块,修复 storage→runtime 反向依赖。
import { isFromExcludedRun } from "./runInjectionPolicy.js";

const OPC_DIR = ".opc";

// Shared goal-slug convention (mirrors projectStore.goalToSlug) for project-memory retrieval.
export function goalToSlug(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 40);
}

function projectFile(projectRoot: string): string {
  return path.join(projectRoot, OPC_DIR, "memory", "project.jsonl");
}

// 战役B·Phase B2c:project.jsonl 的三个 IO 原语接后端开关。检索/评分/hits 语义(score/queryMemory/
// bumpHitsByIds,D 已改的自增强治理)全部只经这三个原语,一字不改;只在此处按开关切 SQLite。
// - 默认 json:逐字节不变(append 单行 / 读全量丢损坏行 / 整文件重写),行为与切换前完全一致。
// - sqlite:memory_entries 表为读权威,JSONL 照写(双写)。append=upsert 单行(rowid 递增=追加序);
//   整文件重写=replaceAllDocs(rowid 序=数组序,与 json 全量覆盖等价)。损坏/无 id 行由 B1 迁移隔离进
//   unknown_lines 原样保全(json 读路径本就静默丢弃,sqlite 读全量同样不返回它们 → 两后端读结果等价),
//   全量重写只重建 memory_entries、不动 unknown_lines(保全)。
function appendJsonl(projectRoot: string, entry: MemoryEntry): void {
  const file = projectFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
  if (isSqliteBackend(projectRoot)) {
    upsertDoc(openBusinessDb(projectRoot), "memory_entries", entry.id, entry);
  }
}

function readJsonl(projectRoot: string): MemoryEntry[] {
  if (isSqliteBackend(projectRoot)) {
    return readAllDocs(openBusinessDb(projectRoot), "memory_entries") as MemoryEntry[];
  }
  const file = projectFile(projectRoot);
  if (!fs.existsSync(file)) return [];
  const out: MemoryEntry[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function writeJsonl(projectRoot: string, entries: MemoryEntry[]): void {
  const file = projectFile(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""), "utf-8");
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "memory_entries", entries);
  }
}

export function addMemory(
  projectRoot: string | undefined,
  input: Omit<MemoryEntry, "id" | "createdAt" | "hits"> & Partial<Pick<MemoryEntry, "id" | "createdAt" | "hits">>,
): MemoryEntry {
  const sourceType = input.source.type ?? (
    projectRoot && input.source.runId
      && fs.existsSync(path.join(projectRoot, OPC_DIR, "runs", input.source.runId, "task.json"))
      ? "run"
      : "manual"
  );
  const entry: MemoryEntry = {
    id: input.id ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    hits: input.hits ?? 0,
    agentRole: input.agentRole,
    // 收口作战令二.2 · 写侧强制归一化公司归属:缺省 = DEFAULT_COMPANY_ID(不再产生"无归属"新记录)。
    // 历史无字段记录留在盘上不迁移,仍为 legacy 隔离区(令二.3);此处只保证新写入必带归属。
    companyId: normalizeCompanyId(input.companyId),
    goalSlug: input.goalSlug,
    text: input.text,
    tags: input.tags ?? [],
    source: { ...input.source, type: sourceType },
  };
  if (projectRoot) appendJsonl(projectRoot, entry);
  return entry;
}

// P1#7: tag/goal matching goes through the shared tokenize() (CJK-aware 2-gram + word tokens)
// instead of a raw substring check — a plain goal.includes(tag) degenerates for Chinese goals
// once tags themselves are un-spaced CJK phrases (relevance never hit → sort fell back to hits).
//
// P1(审计修复)· 把打分拆成【角色分】与【任务语义相关分】两截。旧实现只要同角色(+2)就 s>0 → 与
// 当前任务毫不相关的跨 run 记忆也被注入(实测:求和任务被灌 HTTP/1/2/3 记忆)。相关分只来自 goalSlug
// 精确命中(+3)或 tag 与目标分词重叠(每个 +2);注入门槛改为【相关分 > 0】——仅同角色不足以注入。
export interface MemoryScore { total: number; relevance: number; reason: string }
function score(entry: MemoryEntry, q: MemoryQuery, slug: string, goalTokens: Set<string>): MemoryScore {
  // C12-P0 · 公司硬隔离(注入侧):query 设了 companyId → 只注入同公司条目;不同公司 **及无归属(legacy)**
  // 条目一律不注入(与 reflectionStore.retrieveLessons:474 硬隔离口径一致)。query 未设 companyId(无公司作用域
  // 的调用点,如 /api/memory/query 管理视图)→ 不隔离,零回归。
  // 令二.3:query.companyId 归一化后比对**记录自身原始 companyId**(不归一记录侧)——历史无字段(undefined)
  // 记录一律不等于任何归一化公司 → 不注入(legacy 隔离,防 normalize 误伤)。q.companyId 未设 → 不隔离。
  if (q.companyId && entry.companyId !== normalizeCompanyId(q.companyId)) return { total: -1, relevance: -1, reason: "company-isolated" };
  let roleScore = 0;
  if (entry.agentRole === q.agentRole) roleScore = 2;
  else if (entry.agentRole === "*") roleScore = 1;
  else return { total: -1, relevance: -1, reason: "role-mismatch" }; // wrong role → exclude
  let relevance = 0;
  const reasons: string[] = [];
  if (entry.goalSlug && entry.goalSlug === slug) { relevance += 3; reasons.push("goal-slug"); }
  const tagHits = matchingTagCount(entry.tags, goalTokens);
  if (tagHits > 0) { relevance += tagHits * 2; reasons.push(`tag-overlap×${tagHits}`); }
  const reason = `role=${roleScore}${reasons.length ? "+" + reasons.join("+") : "(no-task-hit)"}`;
  return { total: roleScore + relevance, relevance, reason };
}

// 效率闸 · 检索 Top-K 硬顶(只收紧不改语义):防调用方误传/未来放大 limit 把整库记忆拉进热路径(上下文
// 膨胀 + 相关性稀释)。默认档(callers 传 5 / 未传)完全不变;仅对最终生效的 limit 再套一层 ceiling——
// 排序、公司硬隔离、excluded-run 排除、relevance>0 注入门槛全部一字不动。可经 env OPC_MEMORY_TOPK_MAX
// 调整(仍是上限,只能收紧语义门槛之外的取数条数,永不放松隔离/相关性)。
const DEFAULT_QUERY_LIMIT = 5;
const MAX_QUERY_LIMIT = 10;
function resolveQueryLimit(requested: number | undefined): number {
  const envCap = Number(process.env.OPC_MEMORY_TOPK_MAX);
  const cap = Number.isFinite(envCap) && envCap > 0 ? Math.floor(envCap) : MAX_QUERY_LIMIT;
  const want = requested ?? DEFAULT_QUERY_LIMIT;
  return Math.max(1, Math.min(want, cap));
}

// Retrieve top-N relevant memories from the project layer, each carrying its score/reason (审计:可观测)。
// 注入门槛 = 任务语义相关分 > 0(仅同角色不足)。sort 先按总分,tie-break 按 hits(被验证复用次数)。
export function queryMemoryScored(projectRoot: string | undefined, q: MemoryQuery): Array<{ entry: MemoryEntry; score: MemoryScore }> {
  const limit = resolveQueryLimit(q.limit);
  const slug = goalToSlug(q.goal);
  const goalTokens = new Set(tokenize(q.goal));
  const pool: MemoryEntry[] = projectRoot ? readJsonl(projectRoot) : [];
  // C12-P1 · 成功经验污染护栏(检索侧,对历史条目也生效):源 run 终态为 failed/degraded 的"成功经验"
  // 不注入下一个 run 的 prompt(与 committedMemoryRetriever.runExcludedFromInjection 同一真相源:源 run
  // 目录 task.json 的 status/degraded)。写盘早于 DeliveryAcceptance 判定的假成功条目由此在注入侧被拦。
  // NEVER throws;projectRoot 缺失/无源 runId → 不隔离(向后兼容)。
  // 按 runId memo(同一 run 产出的 N 条记忆只读一次 task.json——本函数在每次派发的热路径上)。
  const excludedByRun = new Map<string, boolean>();
  const fromExcludedRun = (runId: string | undefined): boolean => {
    if (!projectRoot || !runId) return false;
    const hit = excludedByRun.get(runId);
    if (hit !== undefined) return hit;
    const v = isFromExcludedRun(projectRoot, runId);
    excludedByRun.set(runId, v);
    return v;
  };
  return pool
    .filter((e) => e.source?.type === "manual" || e.source?.type === "import" || !fromExcludedRun(e.source?.runId))
    .map((e) => ({ entry: e, score: score(e, q, slug, goalTokens) }))
    .filter((x) => x.score.relevance > 0) // 必须有任务语义命中(goalSlug/tag);仅同角色一律不注入
    .sort((a, b) => (b.score.total - a.score.total) || (b.entry.hits - a.entry.hits))
    .slice(0, limit);
}

// Retrieve top-N relevant memories from the project layer.
// D3(codex 问题6·自增强治理):检索**不再 bump hits**——旧行为"每次检索给 winner hits+1 且以 hits
// 做 tie-break"= 注入越多越容易再被注入的自增强回路。hits 语义改为「被验证复用次数」:run 干净收尾
// (allClean 且非降级)后由 orchestrator 对本 run 真正注入过的条目调 bumpHitsByIds 回写(复用验证回路)。
export function queryMemory(projectRoot: string | undefined, q: MemoryQuery): MemoryEntry[] {
  return queryMemoryScored(projectRoot, q).map((x) => x.entry);
}

// D3 · 验证后 bump(从 queryMemory 检索时拆出):run 干净收尾时对"本 run 真正注入过 prompt 的条目"
// hits+1。返回实际 bump 的条数;NEVER throws,只在计数真变时写盘(保持 P2#6 的写盘纪律)。
export function bumpHitsByIds(projectRoot: string | undefined, ids: string[]): number {
  try {
    if (!projectRoot || ids.length === 0) return 0;
    const idSet = new Set(ids);
    const entries = readJsonl(projectRoot);
    let bumped = 0;
    for (const e of entries) if (idSet.has(e.id)) { e.hits++; bumped++; }
    if (bumped > 0) writeJsonl(projectRoot, entries);
    return bumped;
  } catch {
    return 0;
  }
}

export function listMemory(projectRoot: string | undefined, role?: string): MemoryEntry[] {
  const all: MemoryEntry[] = projectRoot ? readJsonl(projectRoot) : [];
  return all.filter((e) => !role || e.agentRole === role || e.agentRole === "*");
}

export function deleteMemory(projectRoot: string | undefined, id: string): boolean {
  if (!projectRoot) return false;
  const entries = readJsonl(projectRoot);
  const filtered = entries.filter((e) => e.id !== id);
  if (filtered.length === entries.length) return false;
  writeJsonl(projectRoot, filtered);
  return true;
}

// 删除公司时级联清理该公司的 memory_entry。按归一化 companyId 匹配(与写侧一致)。
export function purgeCompanyMemoryEntries(projectRoot: string | undefined, companyId: string): number {
  if (!projectRoot) return 0;
  const norm = normalizeCompanyId(companyId);
  const pool = readJsonl(projectRoot);
  const remaining = pool.filter((e) => normalizeCompanyId(e.companyId) !== norm);
  const removed = pool.length - remaining.length;
  if (removed > 0) writeJsonl(projectRoot, remaining);
  return removed;
}
