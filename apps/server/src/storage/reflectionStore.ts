// Layer E · Reflection Lessons —— failure-first 反思型记忆(纠错记忆)。
// 与现有 4 类记忆(mdMemory 历史台账 / committed-memory 结论 / skillEvolution 技能 / memoryStore 检索)并列,
// 不替换它们。只从**失败信号**里提炼结构化、按角色/团队/任务类型作用域、可注入为"避免重复犯错"约束的教训。
// 存 .opc/memory/lessons.jsonl(每行一条最新版本;版本化更新而非无限堆叠)。全程失败静默,绝不影响 run。
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { normalizeCompanyId } from "@opc/shared";
import { upsertMemoryProposals, type RunMemoryProposalRecord } from "./projectStore.js";
import { isFromExcludedRun } from "./runInjectionPolicy.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";
import { readUnknownLines } from "./sqlite/sqliteToJson.js";

export const FAILURE_MODES = ["timeout", "degraded", "artifact_rejected", "verifier_reject", "quality_gate_failed", "quota_exceeded", "rate_limited", "provider_unavailable", "no_account", "retry_budget_exhausted"] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const ReflectionLessonSchema = z.object({
  id: z.string(),
  schemaVersion: z.string().default("reflection_lesson.v1"),
  kind: z.enum(["failure_lesson", "risk_warning", "policy_candidate"]),
  scope: z.object({
    companyId: z.string().optional(),
    teamId: z.string().optional(),
    role: z.string().optional(),
    agentId: z.string().optional(),
    taskType: z.string().optional(),
    workflowStage: z.string().optional(),
  }),
  trigger: z.object({
    eventTypes: z.array(z.string()).default([]),
    failureMode: z.enum(FAILURE_MODES),
    conditionText: z.string(),
  }),
  diagnosis: z.string(),
  lesson: z.string(),
  recommendedChange: z.string(),
  antiPattern: z.string().optional(),          // 明确禁止重复的做法(可选)
  injection: z.object({
    strength: z.enum(["hint", "warning", "policy_candidate"]),
    promptText: z.string(),
  }),
  evidence: z.object({
    runId: z.string(),
    agentId: z.string().optional(),
    metrics: z.object({
      timeoutMs: z.number().optional(),
      durationMs: z.number().optional(),
      deferredCount: z.number().optional(),
      retryCount: z.number().optional(),
    }).optional(),
  }),
  sourceType: z.enum(["run", "manual", "import"]).optional(),
  confidence: z.number().min(0).max(1),
  // A1-V2 · 生命周期六态(旧四态 → 新六态迁移映射):
  //   旧 "proposed"   → 新 "proposed"(= pending 人审,含义不变;高风险 lesson 默认停在这)
  //   旧 "committed"  → 新 "committed"(已生效可注入;自动批准的会带 lifecycle proposed→approved→committed 的走账记录)
  //   旧 "revoked"    → 新 "revoked"(终态:不再注入、同 dedupeKey 不复活;人工 reject 也落此态)
  //   旧 "superseded" → 新 "superseded"(被新版本替代,含义不变)
  //   新 "approved":已批准、待生效的中间态。当前实现里批准后立即 commit(approveLesson 一步走完
  //                approved→committed,过程记进 lifecycle),此态是给外部工具写入/未来两段式审批预留的合法落盘值。
  //   新 "deprecated":软下线(不再注入但保留;区别于 revoked=错误教训的撤销终态)。
  // 检索侧 retrieveLessons 只取 committed → approved/deprecated/proposed 天然不注入。
  // 旧代码读新文件:不认识的新状态行会 safeParse 失败进 unknown,写回时原样保留、不丢数据(见 loadRaw)。
  status: z.enum(["proposed", "approved", "committed", "revoked", "superseded", "deprecated"]),
  version: z.number().int().min(1),
  supersedes: z.string().optional(),                  // 若替代了旧条目,记其 id
  createdAt: z.string(),
  updatedAt: z.string(),
  hits: z.number().int().min(0).default(0),           // 被注入过几次
  ineffective: z.number().int().min(0).default(0),    // 注入后同类失败仍复现几次 → 触发降权
  support: z.number().int().min(0).default(0),        // 被多少条相似失败信号支持过(复现即 +1)
  // C6 · 一键应用到员工训练:用户手动把这条经验"强绑定"给某个/某些员工(不隔离检索——原有的
  // role/team/company 命中规则不变,这里只在 retrieveLessons 命中该员工时额外加权,让绑定过的经验
  // 优先浮出)。可选、增量字段,旧数据没有此字段视为未绑定,不影响任何既有行为。见 bindLessonToAgent。
  boundAgentIds: z.array(z.string()).optional(),
  // A1-V2 · 走账记录(可选,旧数据无此字段照常解析):谁在什么时候把这条 lesson 推进到什么状态。
  approvedBy: z.string().optional(),                  // "auto"(低风险自动批准)或人工审批者
  lifecycle: z.array(z.object({ status: z.string(), at: z.string().optional(), by: z.string().optional() })).optional(),
});
export type ReflectionLesson = z.infer<typeof ReflectionLessonSchema>;

// 泛泛而谈黑名单:纯口号型 lesson 无价值、污染 context,直接拒。
const VAGUE = /(要|请|应)?(更加?)?(认真|仔细|严谨|小心|注意|细心|谨慎|规范)|be (more )?(careful|rigorous|thorough|diligent)|pay attention|注意时间|保持.*清晰|确保.*质量/i;

// 硬过滤:只接受"有证据 + 有角色 + 有失败模式 + 有可执行改法 + 不空泛"的教训(GPT 设计的质量线)。
export function isValidLesson(l: Partial<ReflectionLesson>): boolean {
  if (!l.evidence?.runId) return false;
  if (!l.scope?.role) return false;                       // 必须落到某个角色,否则会污染全体
  if (!l.trigger?.failureMode) return false;
  const change = (l.recommendedChange || "").trim();
  if (change.length < 6) return false;                    // 太短 = 没有可执行改法(中文信息密度高,6 字起)
  const lesson = (l.lesson || "").trim();
  if (lesson.length < 6) return false;
  // promptText 是**真正被注入进未来 prompt 的字段**,必须和 lesson/change 一样过质量线(之前漏检了)。
  const promptText = (l.injection?.promptText || "").trim();
  if (promptText.length < 6) return false;
  if (VAGUE.test(change) || VAGUE.test(lesson) || VAGUE.test(promptText)) return false; // 纯口号 → 拒
  return true;
}

// A1-V2 · 高风险记忆内容关键词(保守起步):权限 / 删除 / shell·命令执行 / 密钥凭证 四类。
// 命中即视为高风险 → 不自动生效,停 proposed 等人工审批。英文词带 \b 词界防误伤(如 confirm 里的 rm、model 里的 del);
// "token" 只匹配凭证语境(api/access/auth/bearer token),避免把"减少 token 消耗"这类普通优化教训误拦。
const HIGH_RISK_CONTENT_RE = new RegExp([
  "权限", "提权", "越权",
  "删除", "删库", "清空", "格式化",
  "密钥", "秘钥", "凭证", "口令", "密码",
  "命令执行", "执行命令", "终端命令",
  "\\b(?:permission|privilege|sudo|chmod|chown|icacls|setfacl)\\b",
  "\\b(?:delete|erase|rm|rmdir|del|drop\\s+table|truncate|wipe)\\b",
  "\\b(?:shell|bash|powershell|cmd(?:\\.exe)?|exec)\\b",
  "\\b(?:secret|credential|password|passwd|api[-_ ]?key|apikey|access[-_ ]?key|private[-_ ]?key|(?:api|access|auth|bearer)[-_ ]?token)\\b",
].join("|"), "i");

export function isHighRiskMemoryContent(text: string): boolean {
  return HIGH_RISK_CONTENT_RE.test(text || "");
}

// A1-V2 · lesson 高风险判定(独立可测):任一命中 → 高风险,默认停 proposed 等人工审批:
//   1) kind === "policy_candidate" / injection.strength === "policy_candidate"(维持现状:会改系统策略)
//   2) kind === "risk_warning"(新增:风险警示类必须人审)
//   3) 内容(lesson/recommendedChange/diagnosis/antiPattern/promptText)命中权限/删除/shell/密钥类关键词
type LessonRiskInput = Pick<ReflectionLesson, "kind" | "injection"> &
  Partial<Pick<ReflectionLesson, "lesson" | "recommendedChange" | "diagnosis" | "antiPattern" | "trigger">>;

// P0(并行审计抓出):系统自责 + 纯基础设施类失败模式——质量门故障(系统自己的门挂了)、run 被降级、供应商
// 不可用/限流/配额/无账号。据其自动生成的"教训"是在指责系统自身故障或外部设施抖动,绝不能自动 committed 注入/
// 导出/影响员工;一律判高风险 → 停 proposed 等人工批准。刻意**不含** timeout / retry_budget_exhausted(那是
// 真实任务执行失败,"该任务需要更多时间/拆得更细"可为合法可自动生效的教训)与内容质量类(artifact_rejected/
// verifier_reject,agent 产出确有问题),后两类仍走既有低风险自动路径。
const SYSTEM_FAILURE_MODES: ReadonlySet<string> = new Set([
  "quality_gate_failed", "degraded", "quota_exceeded",
  "rate_limited", "provider_unavailable", "no_account",
]);

export function assessLessonRisk(l: LessonRiskInput): { high: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (l.kind === "policy_candidate" || l.injection.strength === "policy_candidate") reasons.push("policy_candidate");
  if (l.kind === "risk_warning") reasons.push("risk_warning");
  if (l.trigger?.failureMode && SYSTEM_FAILURE_MODES.has(l.trigger.failureMode)) reasons.push("system_failure_mode");
  const joined = [l.lesson, l.recommendedChange, l.diagnosis, l.antiPattern, l.injection?.promptText].filter(Boolean).join("\n");
  if (isHighRiskMemoryContent(joined)) reasons.push("content_keyword");
  return { high: reasons.length > 0, reasons };
}

// P1 → A1-V2 · 审批门槛:过了硬过滤(isValidLesson)且**低风险**的才自动生效(自动批准仍走
// proposed→approved→committed 完整走账,见 commitLesson 的 lifecycle);高风险一律停 proposed 留人工批准。
export function isAutoApprovable(l: LessonRiskInput): boolean {
  return !assessLessonRisk(l).high;
}

function lessonsFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "memory", "lessons.jsonl");
}

// 令二.4 · 注入侧护栏:源 run 终态为 failed/degraded/simulated 的教训绝不注入下一个 run 的 prompt。
// 真相源与 memoryStore/committed 一致(storage/runInjectionPolicy.isFromExcludedRun 读源 run task.json)。
// 按 runId memo(一次检索里多条同源教训只读一次 task.json);NEVER throws;无 runId/无 task.json → 不隔离。
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
function requiresLessonRunEvidence(lesson: ReflectionLesson): boolean {
  if (lesson.sourceType) return lesson.sourceType === "run";
  if (lesson.evidence.runId === "manual") return false;
  if (lesson.lifecycle?.some((step) => step.by === "user" || step.by === "import")) return false;
  return true;
}

const LESSONS_SOURCE = "memory/lessons.jsonl";

// 读文件,分出 schema 认得的 + 认不得的原始行。认不得的**不物理删除**——写回时原样带上,
// 防 schema 演进(如改 FAILURE_MODES 枚举)或部分损坏时把 read-modify-write-all 变成静默永久丢数据。
// 战役B·Phase B2c:最底层 IO 原语接后端开关。检索/生命周期业务(D 已冻结:retrieveLessons /
// retrieveLessonsForAgent / commitLesson 六态机等)全部只经 loadLessons(→loadRaw.valid)与 writeLessons,
// 一字不改;只在此二原语内按开关切 SQLite。
// - 默认 json:逐字节不变(读 lessons.jsonl、safeParse 分 valid/unknown、写回带上未知行)。
// - sqlite:lessons 表为读权威(readAllDocs 经同一 ReflectionLessonSchema.safeParse 归一 → 与 json 的 valid
//   完全一致,含默认值);B1 迁移把认不得的行(如六态外的未知 status)隔离进 unknown_lines,读时并回、
//   写时原样保全(replaceAllDocs 只重写 lessons、不动 unknown_lines)。
function loadRaw(projectRoot: string): { valid: ReflectionLesson[]; unknown: string[] } {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    const valid: ReflectionLesson[] = [], unknown: string[] = [...readUnknownLines(db, LESSONS_SOURCE)];
    for (const doc of readAllDocs(db, "lessons")) {
      const p = ReflectionLessonSchema.safeParse(doc);
      if (p.success) valid.push(p.data);
      else unknown.push(JSON.stringify(doc)); // 罕见:入表后 schema 演进不再认 → 退回 unknown,照写进 JSONL 不丢
    }
    return { valid, unknown };
  }
  const f = lessonsFile(projectRoot);
  if (!fs.existsSync(f)) return { valid: [], unknown: [] };
  const valid: ReflectionLesson[] = [], unknown: string[] = [];
  for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ok = false;
    try { const p = ReflectionLessonSchema.safeParse(JSON.parse(t)); if (p.success) { valid.push(p.data); ok = true; } } catch { /* */ }
    if (!ok) unknown.push(t);
  }
  return { valid, unknown };
}

export function loadLessons(projectRoot: string): ReflectionLesson[] { return loadRaw(projectRoot).valid; }

function writeLessons(projectRoot: string, lessons: ReflectionLesson[]): void {
  const f = lessonsFile(projectRoot);
  const { unknown } = loadRaw(projectRoot); // 保留当前 schema 不认的行,不丢
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [...lessons.map((l) => JSON.stringify(l)), ...unknown];
  fs.writeFileSync(f, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8"); // JSONL 照写(两后端一致)
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "lessons", lessons); // 全量重写=整数组覆盖等价;unknown_lines 不动
  }
}

export function restoreLessonsSnapshot(projectRoot: string, lessons: ReflectionLesson[]): void {
  writeLessons(projectRoot, lessons);
}

// 删除公司时级联清理该公司的失败教训(含 proposed 待审)。按归一化 scope.companyId 匹配。
export function purgeCompanyLessons(projectRoot: string, companyId: string): number {
  const norm = normalizeCompanyId(companyId);
  const lessons = loadLessons(projectRoot);
  const remaining = lessons.filter((l) => normalizeCompanyId(l.scope.companyId) !== norm);
  const removed = lessons.length - remaining.length;
  if (removed > 0) writeLessons(projectRoot, remaining);
  return removed;
}

// diagnosis 规范化:抹掉数字/时长噪声(如 200000ms、3 批),让"同一类根因"的不同措辞归并、"不同根因"不误并。
export function normalizeDiagnosis(s: string): string {
  return (s || "").toLowerCase().replace(/\d+\s*ms/g, "<t>").replace(/\d+/g, "<n>").replace(/\s+/g, " ").trim();
}

// 同一"知识点"的去重键:角色 + 任务类型 + 团队 + 失败模式 + **规范化根因(diagnosis)哈希**。
// 加 diagnosis 维度是为修复对抗审查指出的"同 role/taskType/failureMode 但不同根因的两条被误并覆盖"。
function dedupeKey(l: Pick<ReflectionLesson, "scope" | "trigger" | "diagnosis">): string {
  const dHash = createHash("sha256").update(normalizeDiagnosis(l.diagnosis)).digest("hex").slice(0, 12);
  return [l.scope.role || "*", l.scope.taskType || "*", l.scope.teamId || "*", l.trigger.failureMode, dHash].join("|").toLowerCase();
}

// A1-V2 · 把 lesson 提案与状态补记进其来源 run 的 memory_proposals.json 台账。
// 反思是 run 结束后异步到达的(fire-and-forget deepseek 调用),故由这里按 evidence.runId 追加,
// 与 orchestrator run 末写入的 run_conclusion 提案共用同一文件(upsert 按 proposalId 合并)。
// best-effort:台账失败绝不影响 lesson 主流程。
function recordLessonProposal(projectRoot: string, l: ReflectionLesson, risk: { high: boolean; reasons: string[] }, tags?: string[]): void {
  try {
    const runId = l.evidence?.runId;
    if (!runId || !/^[A-Za-z0-9_-]{1,64}$/.test(runId)) return; // 防路径穿越,同 routes 的 SAFE_RUN_ID 口径
    const record: RunMemoryProposalRecord = {
      proposalId: l.id,
      runId,
      source: "reflection_lesson",
      kind: l.kind,
      type: "lesson",
      content: l.injection.promptText || l.lesson,
      ...(tags && tags.length ? { tags } : {}),
      proposedBy: l.evidence.agentId,
      role: l.scope.role,
      agentId: l.evidence.agentId,
      confidence: l.confidence,
      risk: risk.high ? "high" : "low",
      riskReasons: risk.reasons.length ? risk.reasons : undefined,
      // 台账统一词表:lesson 的 "proposed" 即 pending 人审
      status: l.status === "proposed" ? "pending" : l.status,
      statusHistory: (l.lifecycle ?? []).map((e) => ({ status: e.status === "proposed" ? "pending" : e.status, at: e.at, by: e.by })),
      memoryId: l.id,
      createdAt: l.createdAt,
      updatedAt: l.updatedAt,
    };
    upsertMemoryProposals(projectRoot, runId, [record]);
  } catch { /* best-effort */ }
}

// 提交一条教训:校验 + 硬过滤 + 去重版本化。返回 committed 条目或 null(被过滤)。
// P0(用户要求)· runOutcome:本 run 的最终结局。**失败/降级 run 的任何反思一律只 proposed**(不自动 committed
// 注入/导出),只有 clean+verified run 的低风险教训才允许策略性自动生效——收口"ACP 超时等基础设施故障自动
// 提交错误经验"。缺省(undefined)= 旧行为(仅按风险),向后兼容既有调用/单测零回归。
export function commitLesson(
  projectRoot: string,
  input: Omit<ReflectionLesson, "id" | "schemaVersion" | "status" | "version" | "supersedes" | "createdAt" | "updatedAt" | "hits" | "ineffective" | "support" | "approvedBy" | "lifecycle">,
  nowIso: string,
  runOutcome?: "clean_verified" | "failed_or_degraded",
): ReflectionLesson | null {
  if (!isValidLesson(input)) return null;
  // 令二.2 · 写侧归一化公司归属:缺省 = DEFAULT_COMPANY_ID(dedupeKey 不含 companyId,归一不改去重)。
  const nInput = { ...input, scope: { ...input.scope, companyId: normalizeCompanyId(input.scope.companyId) } };
  input = nInput;
  const lessons = loadLessons(projectRoot);
  const key = dedupeKey(input);
  const risk = assessLessonRisk(input);
  const auto = !risk.high && runOutcome !== "failed_or_degraded"; // 失败/降级 run → 绝不自动生效

  // 注意:这里**包含 revoked** 一起匹配 —— revoked(自动连续无效 / 用户手动)是**终态**,同一知识点再复现
  // 也不能作为全新 committed 重建(否则撤销被绕过、无效教训无限复活)。命中 revoked 直接返回不变。
  const existingIdx = lessons.findIndex((l) => dedupeKey(l) === key);
  if (existingIdx >= 0) {
    const prev = lessons[existingIdx];
    if (prev.status === "revoked") return prev; // 终态:不复活、不再注入

    // 版本化更新:同一知识点复现 → version+1、覆盖内容,而不是堆一条新的。
    // **纠错反馈闭环**:若这条已被注入过(hits>0)却又发生同类失败 → 说明它没挡住 → ineffective+1 且**衰减**置信度;
    // 还没注入过的复现只是首次细化 → 取高。连续无效 ≥3 次 → 自动撤销(不再注入,避免陈旧无效教训长期污染)。
    const wasInjected = prev.hits > 0;
    const ineffective = prev.ineffective + (wasInjected ? 1 : 0);
    const confidence = wasInjected ? Math.max(0.2, prev.confidence - 0.2) : Math.max(prev.confidence, input.confidence);
    // P0:失败 run 的复现更新绝不把**已 committed**(clean run 批准过)的教训降级回 proposed——只有原本就非
    // committed 的才随 auto 决定;connected 语义:clean run 立的教训稳定,后续 failed run 的反思不动它的生效态。
    const status: ReflectionLesson["status"] = ineffective >= 3 ? "revoked" : (prev.status === "committed" ? "committed" : (auto ? "committed" : "proposed"));
    const updated: ReflectionLesson = {
      ...prev,
      ...input,
      id: prev.id,
      status,
      version: prev.version + 1,
      createdAt: prev.createdAt,
      updatedAt: nowIso,
      confidence,
      hits: prev.hits,
      ineffective,
      support: prev.support + 1,   // 又被一条相似失败信号支持
      // A1-V2 · 走账:自动生效的复现更新补记 approved→committed;高风险/自动撤销只记结果态。
      approvedBy: status === "committed" ? (prev.approvedBy ?? "auto") : prev.approvedBy,
      lifecycle: [
        ...(prev.lifecycle ?? []),
        ...(status === "committed"
          ? [{ status: "approved", at: nowIso, by: "auto" }, { status: "committed", at: nowIso, by: "auto" }]
          : [{ status, at: nowIso }]),
      ],
    };
    lessons[existingIdx] = updated;
    writeLessons(projectRoot, lessons);
    recordLessonProposal(projectRoot, updated, risk);
    return updated;
  }
  const freshStatus: ReflectionLesson["status"] = auto ? "committed" : "proposed";
  const fresh: ReflectionLesson = {
    ...input,
    id: `lesson-${randomUUID().slice(0, 8)}`,
    schemaVersion: "reflection_lesson.v1",
    status: freshStatus,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    hits: 0,
    ineffective: 0,
    support: 1,
    // A1-V2 · 走账:低风险自动批准也要有 proposed→approved→committed 的完整记录(不再是"直接 committed"无账可查);
    // 高风险只落 proposed,等 approveLesson/rejectLesson 人工裁决。
    approvedBy: auto ? "auto" : undefined,
    lifecycle: auto
      ? [{ status: "proposed", at: nowIso }, { status: "approved", at: nowIso, by: "auto" }, { status: "committed", at: nowIso, by: "auto" }]
      : [{ status: "proposed", at: nowIso }],
  };
  lessons.push(fresh);
  writeLessons(projectRoot, lessons);
  recordLessonProposal(projectRoot, fresh, risk);
  return fresh;
}

// A1-V2 · 人工批准一条 pending(proposed)lesson:proposed → approved → committed 一步走完,
// 过程记进 lifecycle;之后 retrieveLessons 可检索注入。非 proposed(已生效/已撤销/不存在)返回 null。
export function approveLesson(projectRoot: string, id: string, approvedBy: string, nowIso: string): ReflectionLesson | null {
  const lessons = loadLessons(projectRoot);
  const l = lessons.find((x) => x.id === id);
  if (!l || l.status !== "proposed") return null;
  l.status = "committed";
  l.approvedBy = approvedBy;
  l.updatedAt = nowIso;
  l.lifecycle = [...(l.lifecycle ?? []), { status: "approved", at: nowIso, by: approvedBy }, { status: "committed", at: nowIso, by: approvedBy }];
  writeLessons(projectRoot, lessons);
  recordLessonProposal(projectRoot, l, assessLessonRisk(l));
  return l;
}

// A1-V2 · 人工拒绝一条 pending(proposed)lesson:落 revoked 终态(沿用现有状态机语义:
// 不再注入、同 dedupeKey 复现不复活)。非 proposed 返回 null(区别于 revokeLesson 的任意态强制撤销)。
export function rejectLesson(projectRoot: string, id: string, rejectedBy: string, nowIso: string): ReflectionLesson | null {
  const lessons = loadLessons(projectRoot);
  const l = lessons.find((x) => x.id === id);
  if (!l || l.status !== "proposed") return null;
  l.status = "revoked";
  l.updatedAt = nowIso;
  l.lifecycle = [...(l.lifecycle ?? []), { status: "revoked", at: nowIso, by: rejectedBy }];
  writeLessons(projectRoot, lessons);
  recordLessonProposal(projectRoot, l, assessLessonRisk(l));
  return l;
}

// C1 · 手动新建经验(失败复盘卡「加入经验库」等人工入口)。用户主动保存即人工批准——
// 与 approveLesson 同风格完整走账:lifecycle 记 proposed→approved(by)→committed(by),approvedBy 落人工来源(默认 "user")。
// 不走 isValidLesson 的自动提炼质量线(手动条目没有 role/failureMode 的结构化字段),但 content 仍过既有
// 口号黑名单(VAGUE)+ 最短长度校验并截断。同 dedupeKey(= 同 scope 同内容的重复保存)版本化更新而非堆重复条;
// revoked 仍是终态不复活(口径同 commitLesson,调用方按返回的 status 区分)。带合法 runId 时同步记台账。
export const MANUAL_LESSON_CONTENT_MAX = 2000;

export interface ManualLessonInput {
  content: string;
  scope?: ReflectionLesson["scope"];
  runId?: string;   // 提供时作为 evidence.runId,并记进该 run 的 memory_proposals.json 台账
  tags?: string[];  // 只进台账记录(lesson schema 无 tags 字段,不硬塞)
  savedBy?: string; // 默认 "user"
  // P2#7(用户拍板)· 失败复盘卡"加入经验库"应创建**提案**(proposed,去记忆页审批),而非在失败卡上直写
  // approved/committed 记忆——基础设施/治理故障的复盘不该未经审批就生效。缺省 false=旧行为(手动保存即批准)。
  asProposal?: boolean;
}

export function addManualLesson(projectRoot: string, input: ManualLessonInput, nowIso: string): ReflectionLesson | null {
  const content = (input.content || "").trim().slice(0, MANUAL_LESSON_CONTENT_MAX);
  // VAGUE 黑名单是给自动提取的教训防口号用的;手动保存=用户已判断有价值,且复盘卡会把 run 目标
  // 拼进 content,目标里带"注意/认真"等常见词会整条误伤——手动通道只保最小长度线。
  if (content.length < 6) return null;
  const by = (input.savedBy || "user").slice(0, 64);
  const draft = {
    kind: "failure_lesson" as const,
    sourceType: by === "import" ? "import" as const : "manual" as const,
    // 令二.2 · 写侧归一化公司归属(缺省 = DEFAULT_COMPANY_ID)。
    scope: { ...(input.scope ?? {}), companyId: normalizeCompanyId(input.scope?.companyId) },
    // 手动条目没有自动失败分类:统一落最中性的 "degraded";conditionText 用 content 开头(dedupe 走 diagnosis)。
    trigger: { eventTypes: [] as string[], failureMode: "degraded" as FailureMode, conditionText: content.slice(0, 160) },
    diagnosis: content,
    lesson: content,
    recommendedChange: content,
    injection: { strength: "hint" as const, promptText: content },
    evidence: { runId: input.runId || "manual" },
    confidence: 0.8,
  };
  const lessons = loadLessons(projectRoot);
  const key = dedupeKey(draft);
  const existingIdx = lessons.findIndex((l) => dedupeKey(l) === key);
  let saved: ReflectionLesson;
  if (existingIdx >= 0) {
    const prev = lessons[existingIdx];
    if (prev.status === "revoked") return prev; // 终态:不复活(调用方据 status 报 409)
    // P2#7:asProposal 时只落 proposed(去记忆页审批);但已 committed 的不降级(此前已人工批准过)。
    const status: ReflectionLesson["status"] = input.asProposal ? (prev.status === "committed" ? "committed" : "proposed") : "committed";
    saved = {
      ...prev,
      ...draft,
      id: prev.id,
      status,
      version: prev.version + 1,
      createdAt: prev.createdAt,
      updatedAt: nowIso,
      confidence: Math.max(prev.confidence, draft.confidence),
      hits: prev.hits,
      ineffective: prev.ineffective,
      support: prev.support + 1,
      approvedBy: status === "committed" ? by : prev.approvedBy,
      lifecycle: status === "committed"
        ? [...(prev.lifecycle ?? []), { status: "approved" as const, at: nowIso, by }, { status: "committed" as const, at: nowIso, by }]
        : [...(prev.lifecycle ?? []), { status: "proposed" as const, at: nowIso, by }],
    };
    lessons[existingIdx] = saved;
  } else {
    // P2#7:asProposal 时新条目只落 proposed(去记忆页审批,不在失败卡直写 approved)。
    saved = input.asProposal
      ? {
          ...draft,
          id: `lesson-${randomUUID().slice(0, 8)}`,
          schemaVersion: "reflection_lesson.v1",
          status: "proposed",
          version: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          hits: 0,
          ineffective: 0,
          support: 1,
          lifecycle: [{ status: "proposed", at: nowIso, by }],
        }
      : {
          ...draft,
          id: `lesson-${randomUUID().slice(0, 8)}`,
          schemaVersion: "reflection_lesson.v1",
          status: "committed",
          version: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          hits: 0,
          ineffective: 0,
          support: 1,
          approvedBy: by,
          lifecycle: [{ status: "proposed", at: nowIso, by }, { status: "approved", at: nowIso, by }, { status: "committed", at: nowIso, by }],
        };
    lessons.push(saved);
  }
  writeLessons(projectRoot, lessons);
  if (input.runId) recordLessonProposal(projectRoot, saved, assessLessonRisk(saved), input.tags);
  return saved;
}

export interface LessonQuery { role?: string; agentId?: string; teamId?: string; companyId?: string; taskType?: string; limit?: number; minConfidence?: number; bumpHits?: boolean; nowMs?: number; }

// 检索:**role 硬匹配**(核心保证"角色记忆纯粹")+ **team/company 设了就硬隔离**(不跨团队/公司泄漏;未标注 scope 的
// 通用角色教训仍可注入)。taskType/team/company 命中再加分排序。bumpHits=true 时在**同一次 load** 里给命中项 hits+1
// (热路径只读写一次,避免第二次全量读+重写)。
export function retrieveLessons(projectRoot: string, q: LessonQuery): ReflectionLesson[] {
  const role = (q.role || "").toLowerCase();
  const minConf = q.minConfidence ?? 0.5;
  const qCompany = q.companyId ? normalizeCompanyId(q.companyId) : undefined; // 令二.3:查询侧归一;记录侧不归一(legacy undefined 不匹配)
  const excluded = makeExcludedRunMemo(projectRoot); // 令二.4:源 run 终态 failed/degraded/simulated 的教训不注入
  const all = loadLessons(projectRoot);
  const scored = all
    .filter((l) => l.status === "committed" && l.confidence >= minConf)
    .filter((l) => (l.scope.role || "").toLowerCase() === role)                            // 角色硬匹配
    .filter((l) => !q.teamId || !l.scope.teamId || l.scope.teamId === q.teamId)            // team 设了 → 硬隔离(未标 team 的通用教训仍可注入)
    .filter((l) => !qCompany || l.scope.companyId === qCompany) // P0/令二.3:company 设了 → 硬隔离;无公司归属的历史教训不再注入(legacy 隔离)
    .filter((l) => !requiresLessonRunEvidence(l) || !excluded(l.evidence?.runId))
    .map((l) => {
      let s = l.confidence;
      if (q.taskType && l.scope.taskType && l.scope.taskType.toLowerCase() === q.taskType.toLowerCase()) s += 1;
      if (q.teamId && l.scope.teamId === q.teamId) s += 0.5;
      if (qCompany && l.scope.companyId === qCompany) s += 0.3;
      // C6 接线(gap#8):传了 agentId 且该经验被"应用到员工训练"强绑定给此员工 → +2 优先浮出。
      // 未传 agentId(既有调用点)→ 此项恒 0,排序行为与合并前逐字一致(既有单测零回归)。
      if (q.agentId && l.boundAgentIds?.includes(q.agentId)) s += 2;
      // D · recency 衰减:越久没更新排越后(半衰期 ~30 天),让新教训优先、陈旧的自然沉底。
      const days = Math.max(0, ((q.nowMs ?? Date.now()) - Date.parse(l.updatedAt || l.createdAt)) / 86400000);
      if (Number.isFinite(days)) s += 0.4 * Math.pow(0.5, days / 30);
      return { l, s };
    })
    .sort((a, b) => b.s - a.s);
  const winners = scored.slice(0, q.limit ?? 3).map((x) => x.l);
  if (q.bumpHits && winners.length) {
    const ids = new Set(winners.map((w) => w.id));
    for (const l of all) if (ids.has(l.id)) l.hits += 1;
    try { writeLessons(projectRoot, all); } catch { /* best-effort:注入计数失败不影响返回 */ }
  }
  return winners;
}

// C6 · 一键应用到员工训练:把一条经验强绑定到指定员工(新增独立入口,不改动 retrieveLessons 本身
// 及其既有调用点的排序行为)。评分逻辑与 retrieveLessons 一致,只多一项 boundAgentIds 命中加分——
// 加够权重能让绑定过的经验挤进 top N,而不只是对已经限流的结果做 reorder。
export function retrieveLessonsForAgent(projectRoot: string, agentId: string, q: LessonQuery): ReflectionLesson[] {
  const role = (q.role || "").toLowerCase();
  const minConf = q.minConfidence ?? 0.5;
  const qCompany = q.companyId ? normalizeCompanyId(q.companyId) : undefined;
  const excluded = makeExcludedRunMemo(projectRoot);
  const all = loadLessons(projectRoot);
  const scored = all
    .filter((l) => l.status === "committed" && l.confidence >= minConf)
    .filter((l) => (l.scope.role || "").toLowerCase() === role)
    .filter((l) => !q.teamId || !l.scope.teamId || l.scope.teamId === q.teamId)
    .filter((l) => !qCompany || l.scope.companyId === qCompany) // gap#7/令二.3:公司硬隔离(无归属不注入),与 retrieveLessons/committed 口径一致
    .filter((l) => !requiresLessonRunEvidence(l) || !excluded(l.evidence?.runId))
    .map((l) => {
      let s = l.confidence;
      if (q.taskType && l.scope.taskType && l.scope.taskType.toLowerCase() === q.taskType.toLowerCase()) s += 1;
      if (q.teamId && l.scope.teamId === q.teamId) s += 0.5;
      if (qCompany && l.scope.companyId === qCompany) s += 0.3;
      if (agentId && l.boundAgentIds?.includes(agentId)) s += 2; // 强绑定:优先浮出,盖过普通 taskType/team 命中
      const days = Math.max(0, ((q.nowMs ?? Date.now()) - Date.parse(l.updatedAt || l.createdAt)) / 86400000);
      if (Number.isFinite(days)) s += 0.4 * Math.pow(0.5, days / 30);
      return { l, s };
    })
    .sort((a, b) => b.s - a.s);
  return scored.slice(0, q.limit ?? 3).map((x) => x.l);
}

// C6 · 一键应用到员工训练的写入口:把 agentId 追加进该 lesson 的 boundAgentIds(去重、幂等),
// 记一条 lifecycle 走账留痕。revoked(终态)不可再绑定;不存在的 lesson 返回 null。
export function bindLessonToAgent(projectRoot: string, id: string, agentId: string, boundBy: string, nowIso: string): ReflectionLesson | null {
  const lessons = loadLessons(projectRoot);
  const l = lessons.find((x) => x.id === id);
  if (!l || l.status === "revoked") return null;
  const set = new Set(l.boundAgentIds ?? []);
  set.add(agentId);
  l.boundAgentIds = [...set];
  l.updatedAt = nowIso;
  l.lifecycle = [...(l.lifecycle ?? []), { status: `bound:${agentId}`, at: nowIso, by: boundBy }];
  writeLessons(projectRoot, lessons);
  return l;
}

// D6/#9 · install rollback:按 id 硬删本次安装新建的 lesson。不走 revokeLesson——revoked 是终态,
// addManualLesson 撞到同 dedupeKey 的 revoked 记录会拒绝复活,回滚后重装同一模板将静默丢记忆;
// 回滚语义是"这次导入从未发生过",硬删才是新建的精确逆操作。
export function removeLessonsByIds(projectRoot: string, ids: string[]): number {
  if (!ids.length) return 0;
  const idSet = new Set(ids);
  const all = loadLessons(projectRoot);
  const remaining = all.filter((l) => !idSet.has(l.id));
  const removed = all.length - remaining.length;
  if (removed > 0) writeLessons(projectRoot, remaining);
  return removed;
}

export function revokeLesson(projectRoot: string, id: string): boolean {
  const lessons = loadLessons(projectRoot);
  const l = lessons.find((x) => x.id === id);
  if (!l) return false;
  l.status = "revoked";
  writeLessons(projectRoot, lessons);
  return true;
}
