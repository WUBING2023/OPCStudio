// 统一 Memory Registry(P2 起):A 保留台账,B/C/E 逐步收编成不同 kind 的 record。
// 本文件承载 **非-lesson** 的 kind:P2 的 conclusion_summary(结构化结论要点,替代"整份报告"的高优先级注入)、
// P4 的 procedural_skill。lesson 仍在 reflectionStore(schema 复杂、生命周期独立)。存 .opc/memory/registry.jsonl(append)。
// 全程 best-effort:任何失败静默,绝不影响 run。
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { normalizeCompanyId } from "@opc/shared";
import { tokenize, matchingTagCount } from "./textTokenize.js";
import { readJSON, writeJSON } from "./jsonFile.js";
import { isFromExcludedRun } from "./runInjectionPolicy.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import { readUnknownLines } from "./sqlite/sqliteToJson.js";

// P2 · 提案审核状态机(参照 reflectionStore.ts 的 committed/revoked 命名习惯)。
// 可选字段、无 default:老数据/未显式传入的记录 status 为 undefined,一律按 "approved" 对待(不改变现有自动生效行为)。
export const ConclusionSummaryStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ConclusionSummaryStatus = z.infer<typeof ConclusionSummaryStatusSchema>;
export const MemorySourceTypeSchema = z.enum(["run", "manual", "import", "mixed"]);
export type MemorySourceType = z.infer<typeof MemorySourceTypeSchema>;

export const ConclusionSummarySchema = z.object({
  id: z.string(),
  kind: z.literal("conclusion_summary"),
  runId: z.string().optional(),
  sourceRunId: z.string().optional(),
  sourceType: MemorySourceTypeSchema.optional(),
  companyId: z.string().optional(),
  teamId: z.string().optional(),
  goalSlug: z.string().default(""),
  points: z.array(z.string()).default([]), // 3–8 条结构化结论要点(非整份报告)
  tags: z.array(z.string()).default([]),
  createdAt: z.string(),
  status: ConclusionSummaryStatusSchema.optional(), // P2:undefined/"approved" 都视为已生效;"pending" 待审核不参与检索注入
});
export type ConclusionSummary = z.infer<typeof ConclusionSummarySchema>;

// 程序技能(P4 写入;P2 先留类型,检索层统一)。
export const ProceduralSkillSchema = z.object({
  id: z.string(),
  kind: z.literal("procedural_skill"),
  // P0(并行审计抓出)· 公司归属:此前 procedural_skill 只按 role 归属、无 companyId → 导出/去重跨公司同名角色混入。
  // 加 companyId(可选,向后兼容:旧记录/无归属 = undefined,去重仍按 role+taskType,导出仍按角色扇出不丢历史)。
  // 新记录由创建侧(orchestrator run / 导入)强制写入本公司 id;去重键与导出隔离据此按公司硬分区。
  companyId: z.string().optional(),
  role: z.string(),
  taskType: z.string().optional(),
  preconditions: z.array(z.string()).default([]),
  successfulSequence: z.array(z.string()).default([]),
  producedArtifacts: z.array(z.string()).default([]),
  antiPatterns: z.array(z.string()).default([]),
  support: z.number().int().min(0).default(0),
  successRate: z.number().min(0).max(1).default(0),
  sourceRuns: z.array(z.string()).default([]),
  externalSourceRuns: z.array(z.string()).optional(),
  sourceType: MemorySourceTypeSchema.optional(),
  // 令二.5 · 统一 proposal/approval 状态机:加性扩展 "proposed"(旧值 candidate/verified/retired 照常解析)。
  // proposed = 待人工审批的自动反思/导入技能(与 conclusion pending / lesson proposed 同一家族):不注入、不导出,
  // 经 approveProceduralSkill → verified(可注入/导出)或 rejectProceduralSkill → retired(终态)。
  status: z.enum(["proposed", "candidate", "verified", "retired"]).default("candidate"),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProceduralSkill = z.infer<typeof ProceduralSkillSchema>;

// 任务拆分模板(结构提升 A):通宵实验同题三轮 67→13→50 的方差根因之一是 lead **每次从零拆解**——
// 拆得好坏全凭运气。不降级且零延后的 run,其有效拆分存为模板,下次同类任务注入给 lead 参考(不强制照抄)。
export const PlanTemplateSchema = z.object({
  id: z.string(),
  kind: z.literal("plan_template"),
  companyId: z.string().optional(),
  taskType: z.string().default("general"),
  goalSlug: z.string().default(""),
  split: z.array(z.string()).default([]),   // 各 worker 子任务描述(不绑 workerId,跨成员可迁移)
  workerCount: z.number().int().min(1),
  sourceRun: z.string(),
  sourceType: MemorySourceTypeSchema.optional(),
  support: z.number().int().min(0).default(1), // 被多少个干净 run 验证过
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlanTemplate = z.infer<typeof PlanTemplateSchema>;

export const MemoryRecordSchema = z.discriminatedUnion("kind", [ConclusionSummarySchema, ProceduralSkillSchema, PlanTemplateSchema]);
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

function registryFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "memory", "registry.jsonl");
}

// 效率闸 · registry 检索 Top-K 硬顶(只收紧不改语义):conclusion/procedural 检索按分数/support 排序后取前 N,
// 这里对最终取数条数再套一层 ceiling,防调用方误传超大 limit 把大量记录拉进注入热路径。默认档(callers 传 1/2)
// 完全不变;公司硬隔离、excluded-run 排除、status 过滤、相关性打分全部一字不动。
const MAX_CONCLUSION_RECORDS = 4;   // 取多少条结论**记录**参与要点扁平化(要点再经下面的扁平上限二次收敛)
const MAX_CONCLUSION_POINTS = 6;    // 扁平后注入的**要点**条数上限(既有行为,提为具名常量)
const MAX_PROCEDURAL_SKILLS = 3;    // 取多少条 procedural_skill(既有默认 1;此为上限,防误传放大)
function clampTopK(requested: number | undefined, fallback: number, cap: number): number {
  const want = requested ?? fallback;
  return Math.max(1, Math.min(want, cap));
}

function localRunTaskExists(projectRoot: string, runId: string | undefined): boolean {
  return !!runId && fs.existsSync(path.join(projectRoot, ".opc", "runs", runId, "task.json"));
}

function inferMemorySourceType(
  projectRoot: string,
  explicit: MemorySourceType | undefined,
  runIds: Array<string | undefined>,
): MemorySourceType {
  if (explicit) return explicit;
  return runIds.some((runId) => localRunTaskExists(projectRoot, runId)) ? "run" : "manual";
}

function requiresLocalRunEvidence(sourceType: MemorySourceType | undefined): boolean {
  // Legacy records predate provenance and are conservatively treated as run-backed.
  return sourceType === undefined || sourceType === "run";
}

function mergeMemorySourceType(a: MemorySourceType | undefined, b: MemorySourceType): MemorySourceType {
  const left = a ?? "run";
  return left === b ? left : "mixed";
}

// 令二.4 · 注入侧护栏 memo:源 run 终态 failed/degraded/simulated 的记忆绝不注入(与 memoryStore/committed/lessons
// 同一真相源 runInjectionPolicy.isFromExcludedRun)。按 runId memo,一次检索只读一次 task.json;NEVER throws。
function makeExcludedRunMemo(projectRoot: string): (runId: string | undefined) => boolean {
  const cache = new Map<string, boolean>();
  return (runId: string | undefined): boolean => {
    if (!runId) return false;
    const hit = cache.get(runId);
    if (hit !== undefined) return hit;
    let v = true;
    try { v = isFromExcludedRun(projectRoot, runId); } catch { v = true; }
    cache.set(runId, v);
    return v;
  };
}

// migrateJsonToSqlite 的源 key(= unknown_lines.source);sqlite 分支据此并回被隔离的未知行。
const REGISTRY_SOURCE = "memory/registry.jsonl";

// 战役B·Phase B2c:最底层 JSONL IO 原语接后端开关。检索/结论/plan_template 等业务(D 已冻结:
// retrieveConclusionPoints / retrieveProceduralSkills / retrievePlanTemplate / listConclusionProposals 等)
// 全部只经 loadRegistry(→loadRaw.valid)与 writeRegistry,一字不改;只在此二原语内按开关切 SQLite。
// - 默认 json:逐字节不变(读 registry.jsonl、safeParse 分 valid/unknown;认不得的行保留原文,写回带上)。
// - sqlite:memory_records 表为读权威(readAllDocs 经同一 MemoryRecordSchema.safeParse 归一 → 与 json 的
//   valid 完全一致,含 schema 默认值填充);B1 迁移把认不得的行隔离进 unknown_lines,读时并回(unknown)、
//   写时原样保全(replaceAllDocs 只重写 memory_records、不动 unknown_lines,行号由迁移保留)。
function loadRaw(projectRoot: string): { valid: MemoryRecord[]; unknown: string[] } {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    const valid: MemoryRecord[] = [], unknown: string[] = [...readUnknownLines(db, REGISTRY_SOURCE)];
    for (const doc of readAllDocs(db, "memory_records")) {
      const p = MemoryRecordSchema.safeParse(doc);
      if (p.success) valid.push(p.data);
      else unknown.push(JSON.stringify(doc)); // 罕见:入表后 schema 演进不再认 → 退回 unknown,照写进 JSONL 不丢
    }
    return { valid, unknown };
  }
  const f = registryFile(projectRoot);
  if (!fs.existsSync(f)) return { valid: [], unknown: [] };
  const valid: MemoryRecord[] = [], unknown: string[] = [];
  for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ok = false;
    try { const p = MemoryRecordSchema.safeParse(JSON.parse(t)); if (p.success) { valid.push(p.data); ok = true; } } catch { /* */ }
    if (!ok) unknown.push(t);
  }
  return { valid, unknown };
}

export function loadRegistry(projectRoot: string): MemoryRecord[] { return loadRaw(projectRoot).valid; }

// P2 · 人工审核模式开关(默认关闭 = 保持现有"自动生效"行为不变)。开启后,新写入的 conclusion_summary
// 默认落 pending,须经 /api/memory/proposals 人工 approve/reject 才会被 retrieveConclusionPoints 检索注入。
function reviewModeFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "memory", "review-mode.json");
}
// review-mode.json:审核相关开关的单一落盘点。字段全部可选,旧文件缺字段 = 默认行为(向后兼容)。
interface ReviewModeConfig { enabled?: boolean; autoCommitRunConclusion?: boolean }
function readReviewMode(projectRoot: string): ReviewModeConfig {
  return readJSON<ReviewModeConfig>(reviewModeFile(projectRoot), {});
}
export function isReviewModeEnabled(projectRoot: string): boolean {
  return readReviewMode(projectRoot).enabled === true;
}
// merge 写入(不整文件覆盖):setReviewMode 只动 enabled,保留 autoCommitRunConclusion,反之亦然。
export function setReviewMode(projectRoot: string, enabled: boolean): void {
  writeJSON(reviewModeFile(projectRoot), { ...readReviewMode(projectRoot), enabled: !!enabled });
}

// run_conclusion 自动 commit 策略:默认只让低风险、clean、证据完整的结论自动生效；高风险和重复失败教训
// 才进入人工审核。这样日常使用不会把每个 run 都变成待办。优先级:env OPC_MEMORY_AUTOCOMMIT(on/off)>
// review-mode.json 的显式 autoCommitRunConclusion 字段 > 默认 true。用户仍可显式关闭进入“全部人工审核”模式。
export function isRunConclusionAutoCommitEnabled(projectRoot: string): boolean {
  const env = (process.env.OPC_MEMORY_AUTOCOMMIT ?? "").trim().toLowerCase();
  if (["on", "1", "true", "yes"].includes(env)) return true;
  if (["off", "0", "false", "no"].includes(env)) return false;
  return readReviewMode(projectRoot).autoCommitRunConclusion !== false;
}
export function setRunConclusionAutoCommit(projectRoot: string, on: boolean): void {
  writeJSON(reviewModeFile(projectRoot), { ...readReviewMode(projectRoot), autoCommitRunConclusion: !!on });
}

function writeRegistry(projectRoot: string, records: MemoryRecord[]): void {
  const f = registryFile(projectRoot);
  const { unknown } = loadRaw(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [...records.map((r) => JSON.stringify(r)), ...unknown];
  fs.writeFileSync(f, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8"); // JSONL 照写(两后端一致)
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "memory_records", records); // 全量重写=整数组覆盖等价;unknown_lines 不动
  }
}

export function restoreRegistrySnapshot(projectRoot: string, records: MemoryRecord[]): void {
  writeRegistry(projectRoot, records);
}

// 写一条结论摘要(空 points 不写,避免垃圾)。
// P2:status 不显式传入时,按项目的人工审核开关(isReviewModeEnabled)决定 —— 开关关闭(默认)时仍是
// "approved" 自动生效,不打断现有调用方(orchestrator.ts 的既有调用点未传 status,行为不变)。
export function addConclusionSummary(projectRoot: string, input: { runId?: string; sourceRunId?: string; sourceType?: MemorySourceType; companyId?: string; teamId?: string; goalSlug?: string; points: string[]; tags?: string[]; createdAt: string; status?: ConclusionSummaryStatus }): ConclusionSummary | null {
  const points = (input.points || []).map((p) => p.trim()).filter(Boolean).slice(0, 8);
  if (points.length === 0) return null;
  const status: ConclusionSummaryStatus = input.status ?? (isReviewModeEnabled(projectRoot) ? "pending" : "approved");
  const sourceType = inferMemorySourceType(projectRoot, input.sourceType, [input.runId]);
  // 令二.2 · 写侧归一化公司归属(缺省 = DEFAULT_COMPANY_ID)。
  const rec: ConclusionSummary = { id: `concl-${randomUUID().slice(0, 8)}`, kind: "conclusion_summary", runId: input.runId, sourceRunId: input.sourceRunId, sourceType, companyId: normalizeCompanyId(input.companyId), teamId: input.teamId, goalSlug: input.goalSlug || "", points, tags: input.tags || [], createdAt: input.createdAt, status };
  const all = loadRegistry(projectRoot);
  all.push(rec);
  writeRegistry(projectRoot, all);
  return rec;
}

// P2 · 待审核提案列表(仅 conclusion_summary 有审核态;procedural_skill/plan_template 保持自动生效,见文件顶注)。
export function listConclusionProposals(projectRoot: string, q: { preloaded?: MemoryRecord[] } = {}): ConclusionSummary[] {
  return (q.preloaded ?? loadRegistry(projectRoot))
    .filter((r): r is ConclusionSummary => r.kind === "conclusion_summary" && r.status === "pending")
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function setConclusionStatus(projectRoot: string, id: string, status: "approved" | "rejected"): ConclusionSummary | null {
  const all = loadRegistry(projectRoot);
  const idx = all.findIndex((r) => r.kind === "conclusion_summary" && r.id === id);
  if (idx === -1) return null;
  const updated: ConclusionSummary = { ...(all[idx] as ConclusionSummary), status };
  all[idx] = updated;
  writeRegistry(projectRoot, all);
  return updated;
}

// D6/#9 · install rollback:按 id 硬删本次安装导入的记录(conclusion_summary / 新建的 procedural_skill)。
// 与 reject/retire 不同,回滚语义是"这次导入从未发生过"——零残留,重装同一模板也不会被终态挡住。
export function removeMemoryRecordsByIds(projectRoot: string, ids: string[]): number {
  if (!ids.length) return 0;
  const idSet = new Set(ids);
  const all = loadRegistry(projectRoot);
  const remaining = all.filter((r) => !idSet.has(r.id));
  const removed = all.length - remaining.length;
  if (removed > 0) writeRegistry(projectRoot, remaining);
  return removed;
}

export function approveConclusionSummary(projectRoot: string, id: string): ConclusionSummary | null {
  return setConclusionStatus(projectRoot, id, "approved");
}
export function rejectConclusionSummary(projectRoot: string, id: string): ConclusionSummary | null {
  return setConclusionStatus(projectRoot, id, "rejected");
}

// 删除公司时级联清理该公司的 registry 记忆记录(conclusion_summary + procedural_skill),
// 防孤儿(尤其 pending 提案)污染审批队列/检索。按归一化 companyId 匹配(与写侧口径一致;
// legacy 无归属记录=default,删非 default 公司时不误伤)。
export function purgeCompanyMemory(projectRoot: string, companyId: string): { conclusions: number; skills: number } {
  const norm = normalizeCompanyId(companyId);
  const all = loadRegistry(projectRoot);
  let conclusions = 0, skills = 0;
  const remaining = all.filter((r) => {
    if ((r.kind === "conclusion_summary" || r.kind === "procedural_skill")
      && normalizeCompanyId((r as { companyId?: string }).companyId) === norm) {
      if (r.kind === "conclusion_summary") conclusions++; else skills++;
      return false;
    }
    return true;
  });
  if (conclusions + skills > 0) writeRegistry(projectRoot, remaining);
  return { conclusions, skills };
}

// tool_call 事件的 name 对 CLI 框架 agent 可能是**整条命令**(含 powershell.exe 路径 + 参数 + 绝对路径),
// 直接存进 skill 既没法泛化、又会把本地绝对路径/用户名泄漏进注入。归一成干净的工具/命令动词(去路径/参数/引号)。
export function normalizeToolName(raw: unknown): string {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  if (!/[\s\\/]/.test(s)) return s.slice(0, 24);              // 已是干净工具名(如 Read/Bash/Grep)→ 原样
  const cmd = /-Command\s+["']?\s*([A-Za-z][\w-]*)/.exec(s);  // powershell.exe -Command '<cmdlet> ...' → 取 cmdlet
  if (cmd) return cmd[1].slice(0, 24);
  const first = (s.split(/\s+/)[0] || "").replace(/^["']|["']$/g, "");
  return ((first.split(/[\\/]/).pop() || first).replace(/\.(exe|cmd|ps1)$/i, "") || "cmd").slice(0, 24);
}

// 升级/去重 procedural_skill(按 role+taskType 合并;P4 用)。
export function upsertProceduralSkill(projectRoot: string, input: Omit<ProceduralSkill, "id" | "kind" | "createdAt" | "updatedAt">, nowIso: string): ProceduralSkill {
  const all = loadRegistry(projectRoot);
  // 令二.2 · 写侧归一化公司归属(缺省 = DEFAULT_COMPANY_ID)。
  const companyId = normalizeCompanyId(input.companyId);
  const sourceType = inferMemorySourceType(projectRoot, input.sourceType, input.sourceRuns);
  const externalSourceRuns = input.externalSourceRuns ?? [];
  input = { ...input, companyId, sourceType, externalSourceRuns };
  // P0 · 去重键含 companyId:不同公司同角色同任务类型的技能各自成条,绝不合并(收口跨公司来源漂移)。
  const idx = all.findIndex((r) => r.kind === "procedural_skill" && r.role === input.role && (r.taskType || "") === (input.taskType || "") && (r.companyId || "") === companyId && !(input.status === "proposed" && r.status !== "proposed"));
  if (idx >= 0) {
    const prev = all[idx] as ProceduralSkill;
    // support 只按**不同 run** 计:同一 run 里多个同角色 worker 都会各调一次,不能重复累加(否则单 run 就 verified)。
    const isNewRun = input.sourceRuns.some((r) => !prev.sourceRuns.includes(r))
      || externalSourceRuns.some((r) => !(prev.externalSourceRuns ?? []).includes(r));
    const support = prev.support + (isNewRun ? 1 : 0);
    // support 达 3(3 个不同 run 都成功过该序列)才 promotion candidate → verified;仅 verified 会被注入。
    // 令二.5:proposed 是**待人工审批**态——绝不因 support 达标自动晋升(须 approveProceduralSkill 显式放行);
    // retired 是终态。二者都黏住,只有 candidate 会随 support 自动晋升 verified。
    const status: ProceduralSkill["status"] =
      prev.status === "retired" ? "retired"
      : prev.status === "proposed" ? "proposed"
      : support >= 3 ? "verified" : prev.status;
    const merged: ProceduralSkill = {
      ...prev,
      ...input,
      id: prev.id,
      kind: "procedural_skill",
      createdAt: prev.createdAt,
      updatedAt: nowIso,
      support,
      status,
      sourceType: mergeMemorySourceType(prev.sourceType, sourceType),
      sourceRuns: [...new Set([...prev.sourceRuns, ...input.sourceRuns])].slice(-20),
      externalSourceRuns: [...new Set([...(prev.externalSourceRuns ?? []), ...externalSourceRuns])].slice(-20),
    };
    all[idx] = merged;
    writeRegistry(projectRoot, all);
    return merged;
  }
  const rec: ProceduralSkill = { ...input, id: `skill-${randomUUID().slice(0, 8)}`, kind: "procedural_skill", createdAt: nowIso, updatedAt: nowIso };
  all.push(rec);
  writeRegistry(projectRoot, all);
  return rec;
}

// 令二.5 · 程序技能人工审批(镜像 lessons approve/reject 风格):
//   approve:proposed → verified(即刻可注入/可导出),记 updatedAt;非 proposed(candidate/verified/retired/不存在)→ null。
//   reject :proposed → retired(终态,不注入不导出);非 proposed → null。
function setProceduralSkillStatus(projectRoot: string, id: string, from: ProceduralSkill["status"], to: ProceduralSkill["status"], nowIso: string): ProceduralSkill | null {
  const all = loadRegistry(projectRoot);
  const idx = all.findIndex((r) => r.kind === "procedural_skill" && r.id === id);
  if (idx === -1) return null;
  const prev = all[idx] as ProceduralSkill;
  if (prev.status !== from) return null;
  const updated: ProceduralSkill = { ...prev, status: to, updatedAt: nowIso };
  all[idx] = updated;
  writeRegistry(projectRoot, all);
  return updated;
}
export function approveProceduralSkill(projectRoot: string, id: string, nowIso: string): ProceduralSkill | null {
  return setProceduralSkillStatus(projectRoot, id, "proposed", "verified", nowIso);
}
export function rejectProceduralSkill(projectRoot: string, id: string, nowIso: string): ProceduralSkill | null {
  return setProceduralSkillStatus(projectRoot, id, "proposed", "retired", nowIso);
}

// 检索可注入的 procedural_skill:**只注入 verified**(≥3 个不同 run 都成功过该序列 → 挡住"单次偶然")+ role 硬匹配 + taskType 相关。
// preloaded 传入则复用(避免热路径对同一 registry.jsonl 重复读+parse)。
export function retrieveProceduralSkills(projectRoot: string, q: { role: string; companyId?: string; taskType?: string; limit?: number; minSupport?: number; preloaded?: MemoryRecord[] }): ProceduralSkill[] {
  const role = q.role.toLowerCase();
  const minSup = q.minSupport ?? 0;
  const qCompany = q.companyId ? normalizeCompanyId(q.companyId) : undefined; // 令二.3:查询侧归一;记录侧不归一
  const excluded = makeExcludedRunMemo(projectRoot); // 令二.4:所有来源 run 都是 failed/degraded/simulated → 不注入
  return (q.preloaded ?? loadRegistry(projectRoot))
    .filter((r): r is ProceduralSkill => r.kind === "procedural_skill" && r.status === "verified") // 令二.5:proposed/candidate/retired 不注入
    .filter((r) => r.role.toLowerCase() === role && r.support >= minSup)
    // P0/令二.3:company 设了 → 硬隔离(不同公司/无公司归属的历史技能都不注入)。未传 companyId 保持旧口径不筛,零回归。
    .filter((r) => !qCompany || r.companyId === qCompany)
    .filter((r) => !q.taskType || !r.taskType || r.taskType === q.taskType)
    // 令二.4:若该技能的**全部**来源 run 都被排除(failed/degraded/simulated),则其"成功序列"无干净证据 → 不注入。
    .filter((r) => !requiresLocalRunEvidence(r.sourceType)
      || (r.sourceRuns.length > 0 && r.sourceRuns.some((rid) => !excluded(rid))))
    .sort((a, b) => b.support - a.support)
    .slice(0, clampTopK(q.limit, 1, MAX_PROCEDURAL_SKILLS));
}

// 检索结论摘要:按 company 硬隔离(设了才隔离)+ goalSlug/tags 相关性打分,返回最相关的 N 条的**要点扁平列表**。
// 平局按 createdAt 倒序兜底(无相关信号时回退到**最新**而非最旧)。preloaded 传入则复用。
// P1#7: tag↔goal 匹配过共享 tokenize()(CJK 2-gram + 原词),不再是"goal 整句是否包含 tag 原样子串"——
// 写入端(orchestrator 里按空格/标点切 tags)对中文 goal 常切不出多个 tag,导致相关性打分失真。
// D1 · minScore(默认 0 = 旧行为):注入侧传 1 时,相关性得分为 0(零 goalSlug/tag 命中)的结论被过滤,
//   不再靠 recency 兜底顶替相关结论进 prompt(codex 问题6:"最新"顶替"相关");展示投影侧不传,记忆页不受影响。
/** Canonical runtime name. The legacy storage discriminator is read-only compatibility data. */
export const retrieveSuccessExperiences = retrieveProceduralSkills;
export function retrieveConclusionPoints(projectRoot: string, q: { companyId?: string; goalSlug?: string; goal?: string; limit?: number; minScore?: number; preloaded?: MemoryRecord[] }): string[] {
  const goalTokens = new Set(tokenize(q.goal));
  const minScore = q.minScore ?? 0;
  const qCompany = q.companyId ? normalizeCompanyId(q.companyId) : undefined; // 令二.3:查询侧归一;记录侧不归一
  const excluded = makeExcludedRunMemo(projectRoot); // 令二.4:源 run 终态 failed/degraded/simulated 的结论不注入
  const scored = (q.preloaded ?? loadRegistry(projectRoot))
    .filter((r): r is ConclusionSummary => r.kind === "conclusion_summary")
    .filter((r) => r.status !== "pending" && r.status !== "rejected") // P2:待审核/已拒绝的提案不参与检索注入
    // C12-P1/gap#7/令二.3:公司硬隔离(注入侧)——companyId 设了 → 不同公司 **及无归属** 结论都不注入,与 lessons/committed
    // 口径一致。未传 companyId 的调用点不筛,零回归。
    .filter((r) => !qCompany || r.companyId === qCompany)
    .filter((r) => !requiresLocalRunEvidence(r.sourceType) || (!!r.runId && !excluded(r.runId))) // run-backed records need durable clean evidence
    .map((r) => {
      let s = 0;
      if (q.goalSlug && r.goalSlug && r.goalSlug === q.goalSlug) s += 3;
      s += matchingTagCount(r.tags, goalTokens);
      return { r, s };
    })
    .filter((x) => x.s >= minScore) // D1:minScore>0 时,零相关(s=0)结论被过滤,不再按最新兜底注入
    .sort((a, b) => b.s - a.s || Date.parse(b.r.createdAt || "") - Date.parse(a.r.createdAt || ""));
  const points: string[] = [];
  for (const { r } of scored.slice(0, clampTopK(q.limit, 2, MAX_CONCLUSION_RECORDS))) for (const p of r.points) points.push(p);
  return points.slice(0, MAX_CONCLUSION_POINTS);
}

// ── plan_template(结构提升 A · 拆分复用降方差)──────────────────────────────────

// 存/更新一个公司+任务类型的有效拆分:同 key 已有 → support+1 且以最新干净拆分为准(任务演化,旧拆分让位)。
export function upsertPlanTemplate(projectRoot: string, input: { companyId?: string; taskType: string; goalSlug?: string; split: string[]; sourceRun: string; sourceType?: MemorySourceType }, nowIso: string): PlanTemplate | null {
  const split = (input.split || []).map((s) => s.trim().slice(0, 300)).filter(Boolean).slice(0, 8); // 单项截长,防超长子任务撑爆 lead 提示词
  if (split.length < 2) return null; // 单任务/兜底整发不算"拆分",不存
  // Plans are company-owned memory. Legacy company-less plans remain quarantined.
  const companyId = normalizeCompanyId(input.companyId);
  const sourceType = inferMemorySourceType(projectRoot, input.sourceType, [input.sourceRun]);
  const all = loadRegistry(projectRoot);
  const idx = all.findIndex((r) => r.kind === "plan_template" && r.companyId === companyId && r.taskType === input.taskType);
  if (idx >= 0) {
    const prev = all[idx] as PlanTemplate;
    // support 只按不同 run 计(同 run 多 lead 同公司不重复+1,对齐 procedural_skill 的 isNewRun 语义)
    const support = prev.sourceRun === input.sourceRun ? prev.support : prev.support + 1;
    const merged: PlanTemplate = { ...prev, companyId, split, workerCount: split.length, goalSlug: input.goalSlug || prev.goalSlug, sourceRun: input.sourceRun, sourceType: mergeMemorySourceType(prev.sourceType, sourceType), support, updatedAt: nowIso };
    all[idx] = merged;
    writeRegistry(projectRoot, all);
    return merged;
  }
  const rec: PlanTemplate = { id: `plan-${randomUUID().slice(0, 8)}`, kind: "plan_template", companyId, taskType: input.taskType, goalSlug: input.goalSlug || "", split, workerCount: split.length, sourceRun: input.sourceRun, sourceType, support: 1, createdAt: nowIso, updatedAt: nowIso };
  all.push(rec);
  writeRegistry(projectRoot, all);
  return rec;
}

// 取该公司+任务类型的拆分模板(company 硬隔离,与其它 kind 同规)。
export function retrievePlanTemplate(projectRoot: string, q: { companyId?: string; taskType: string; preloaded?: MemoryRecord[] }): PlanTemplate | null {
  const qCompany = normalizeCompanyId(q.companyId);
  const excluded = makeExcludedRunMemo(projectRoot);
  const cands = (q.preloaded ?? loadRegistry(projectRoot))
    .filter((r): r is PlanTemplate => r.kind === "plan_template")
    .filter((r) => r.companyId === qCompany)
    .filter((r) => r.taskType === q.taskType)
    .filter((r) => !requiresLocalRunEvidence(r.sourceType) || !excluded(r.sourceRun))
    .sort((a, b) => b.support - a.support || Date.parse(b.updatedAt || "") - Date.parse(a.updatedAt || ""));
  return cands[0] ?? null;
}
