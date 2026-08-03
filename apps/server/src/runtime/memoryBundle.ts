import type { AgentNodeConfig, BundleMemoryRecord, CompanyBundle, MemoryLevel, RequiredSecretSpec, ExportProfile } from "@opc/shared";
import { DEFAULT_EXPORT_PROFILE, WORKSPACE_DIR_PLACEHOLDER, CLI_CONFIG_DIR_PLACEHOLDER, AGENT_LOCAL_PATH_FIELDS, normalizeCompanyId } from "@opc/shared";
import { loadRegistry, type ConclusionSummary, type ProceduralSkill } from "../storage/registryStore.js";
import { loadLessons, type ReflectionLesson } from "../storage/reflectionStore.js";
import { createMemoryJob, updateMemoryJob, type MemoryJobRecord } from "../storage/memoryJobStore.js";
import { proposeMemory, removeGovernedMemoryProposalsByIds } from "./memoryGovernance.js";
import { listLayeredMemories, type LayeredMemoryRecord } from "../storage/layeredMemory.js";

// D4+D5 · 记忆导出 / Memory Import Mode(计划文档「7月6日重构指南-现状对照与落地计划.md」§7 Track D
// D4「导出补全」+ D5「记忆导出/导入」+「7月6日第一个大重构指南.md」11.6/11.7/11.17)。
//
// 打通现有三类记忆(registryStore 的 conclusion_summary/procedural_skill、reflectionStore 的
// lessons)到 Company Bundle 的统一 memory.records[](指南 11.6 五级 draft→noted→verified→sop→
// doctrine)。plan_template(registryStore 第三种 kind)不在本次映射范围——它是拆分模板而非
// 11.6 定义的"经验/记忆",如实不做。

// ── ① 五级映射(导出方向:store 记录 → BundleMemoryRecord)────────────────────────────

// procedural_skill 的 verified→sop 达标后,support(不同 run 验证次数)继续累积到这个门槛,
// 近似 11.6 "sop -> doctrine:跨团队引用" 的信号——**这是启发式近似,不是真实检测**:当前
// ProceduralSkillSchema 没有 companyId/teamId 字段,无法判断"是否真的跨了团队",只能用
// "被验证次数远超基本门槛(3 的两倍)" 做保守替代。等 procedural_skill 补上团队维度后应替换成
// 真实的跨团队引用计数。
const DOCTRINE_SUPPORT_THRESHOLD = 6;

function ownerFromConclusion(rec: ConclusionSummary): { ownerType: BundleMemoryRecord["owner_type"]; ownerId: string } {
  if (rec.teamId) return { ownerType: "team", ownerId: rec.teamId };
  if (rec.companyId) return { ownerType: "company", ownerId: rec.companyId };
  if (rec.goalSlug) return { ownerType: "project", ownerId: rec.goalSlug };
  return { ownerType: "company", ownerId: "" };
}

// conclusion_summary → BundleMemoryRecord。映射依据:
//   · status "rejected"(人工已拒绝的提案)不是真实记忆,不导出 → null。
//   · status "pending"(待审核)→ "draft"(11.6:"临时观察",尚未被确认)。
//   · status "approved" 或 undefined(未开启人工审核时的默认自动生效)→ "verified"——批准/自动生效
//     即代表这条结论被采信可用,是当前数据模型里最贴近 11.6 "verified:被成功任务验证" 的信号
//     (conclusion_summary 本身没有独立的"被后续任务引用次数"字段)。
export function mapConclusionSummaryToBundleRecord(rec: ConclusionSummary): BundleMemoryRecord | null {
  if (rec.status === "rejected") return null;
  const level: MemoryLevel = rec.status === "pending" ? "draft" : "verified";
  const { ownerType, ownerId } = ownerFromConclusion(rec);
  return {
    memory_id: `mem-cs-${rec.id}`,
    scope: ownerId || "general",
    owner_type: ownerType,
    owner_id: ownerId,
    content: rec.points.join("\n"),
    source: { type: rec.sourceType ?? "run", run_id: rec.sourceRunId ?? rec.runId ?? "", task_id: "", agent_id: undefined },
    level,
    score: level === "draft" ? 20 : 60,
    status: "active",
    tags: rec.tags,
    metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
    created_at: rec.createdAt,
    updated_at: rec.createdAt,
    last_used_at: rec.createdAt,
  };
}

// procedural_skill → BundleMemoryRecord。映射依据:
//   · status "retired"(终态,不再有效)不导出 → null。
//   · status "candidate"(support 未达 verified 门槛,还在积累证据)→ "noted"(11.6:"已记录经验")。
//   · status "verified" 且 support < DOCTRINE_SUPPORT_THRESHOLD → "sop"(给定映射规则)。
//   · status "verified" 且 support >= DOCTRINE_SUPPORT_THRESHOLD → "doctrine"(见上方阈值注释,启发式)。
export function mapProceduralSkillToBundleRecord(rec: ProceduralSkill): BundleMemoryRecord | null {
  if (rec.status === "retired") return null;
  // 令二.5:proposed(待人工审批)不导出——与 conclusion pending / lesson proposed 同一状态机口径。
  if (rec.status === "proposed") return null;
  const level: MemoryLevel =
    rec.status === "candidate" ? "noted" : rec.support >= DOCTRINE_SUPPORT_THRESHOLD ? "doctrine" : "sop";
  const content = [
    rec.preconditions.length ? `前置条件:${rec.preconditions.join("; ")}` : "",
    rec.successfulSequence.length ? `成功步骤:${rec.successfulSequence.join(" → ")}` : "",
    rec.producedArtifacts.length ? `产出:${rec.producedArtifacts.join("; ")}` : "",
    rec.antiPatterns.length ? `避免:${rec.antiPatterns.join("; ")}` : "",
  ].filter(Boolean).join("\n");
  return {
    memory_id: `mem-ps-${rec.id}`,
    scope: rec.role,
    owner_type: "agent", // procedural_skill 只挂 role(无具体 agent 实例 id),role 是当前数据模型里最接近"员工级经验"的粒度
    owner_id: rec.role,
    content: content || rec.role,
    source: { type: rec.sourceType ?? "run", run_id: rec.sourceRuns[rec.sourceRuns.length - 1] ?? rec.externalSourceRuns?.[rec.externalSourceRuns.length - 1] ?? "", task_id: rec.taskType ?? "", agent_id: undefined },
    level,
    score: level === "noted" ? 40 : level === "doctrine" ? 95 : 80,
    status: "active",
    tags: [rec.role, ...(rec.taskType ? [rec.taskType] : [])],
    // support 目前只在"验证成功"的 run 上累加(见 registryStore.upsertProceduralSkill 顶注),没有独立的
    // "被引用但未必成功"信号,cited_count/cited_success_count 如实取同一个数,不虚构区分。
    metrics: { cited_count: rec.support, cited_success_count: rec.support, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    last_used_at: rec.updatedAt,
  };
}

function ownerFromLessonScope(scope: ReflectionLesson["scope"]): { ownerType: BundleMemoryRecord["owner_type"]; ownerId: string } {
  if (scope.agentId) return { ownerType: "agent", ownerId: scope.agentId };
  if (scope.role) return { ownerType: "agent", ownerId: scope.role };
  if (scope.teamId) return { ownerType: "team", ownerId: scope.teamId };
  if (scope.companyId) return { ownerType: "company", ownerId: scope.companyId };
  if (scope.taskType) return { ownerType: "project", ownerId: scope.taskType };
  return { ownerType: "company", ownerId: "" };
}

// lesson(reflectionStore)→ BundleMemoryRecord。映射依据:
//   · 只有 "committed"(当前生效)是真实记忆;"proposed"(待人工审核)/"approved"(过渡态,现实现里
//     几乎不会静止在这一态)/"revoked"(终态撤销)/"superseded"(被新版本替代)/"deprecated"(软下线)
//     均不代表"当前可信、可复用"的记忆,一律不导出。
//   · 给定映射规则:committed → "noted"(11.6:"已记录经验")。lesson 本身没有"被多次成功引用"的
//     升级路径(reflectionStore 目前只有 committed 这一个生效态,没有 verified/sop 的进一步分级),
//     如实只映到 noted,不臆造更高等级。
export function mapLessonToBundleRecord(rec: ReflectionLesson): BundleMemoryRecord | null {
  if (rec.status !== "committed") return null;
  const { ownerType, ownerId } = ownerFromLessonScope(rec.scope);
  const hits = rec.hits ?? 0;
  const ineffective = rec.ineffective ?? 0;
  const preventedOrSuccessful = Math.max(0, hits - ineffective);
  return {
    memory_id: `mem-ls-${rec.id}`,
    scope: ownerId || "general",
    owner_type: ownerType,
    owner_id: ownerId,
    content: rec.injection.promptText || rec.lesson,
    source: { type: "run", run_id: rec.evidence.runId, task_id: "", agent_id: rec.evidence.agentId },
    level: "noted",
    score: Math.round(Math.min(1, Math.max(0, rec.confidence)) * 100),
    status: "active",
    tags: [rec.trigger.failureMode, ...(rec.scope.taskType ? [rec.scope.taskType] : [])],
    metrics: {
      cited_count: hits,
      cited_success_count: preventedOrSuccessful,
      prevented_failure_count: preventedOrSuccessful,
      contradicted_count: ineffective,
      reviewer_upvote_count: 0,
    },
    created_at: rec.createdAt,
    updated_at: rec.updatedAt,
    last_used_at: rec.updatedAt,
  };
}

export function mapLayeredMemoryToBundleRecord(rec: LayeredMemoryRecord, companyId: string): BundleMemoryRecord | null {
  if (rec.status !== "approved") return null;
  const target = normalizeCompanyId(companyId);
  if (rec.portableBundleRecord) {
    const portable = rec.portableBundleRecord;
    return {
      ...portable,
      memory_id: `mem-layer-${rec.memoryId}`,
      scope: target,
      owner_type: portable.owner_type,
      owner_id: portable.owner_type === "company" ? target : portable.owner_id,
      source: { ...portable.source, type: "import" },
      status: "active",
    };
  }
  const level: MemoryLevel = rec.topic === "failure_lesson" ? "noted" : "verified";
  return {
    memory_id: `mem-layer-${rec.memoryId}`,
    scope: target,
    owner_type: "company",
    owner_id: target,
    content: rec.content,
    source: { type: rec.sourceType, run_id: rec.sourceRunId ?? "", task_id: "" },
    level,
    score: Math.round(Math.min(1, Math.max(0, rec.confidence)) * 100),
    status: "active",
    tags: rec.topic ? [rec.topic] : [],
    metrics: { cited_count: 0, cited_success_count: 0, prevented_failure_count: 0, contradicted_count: 0, reviewer_upvote_count: 0 },
    created_at: rec.created,
    updated_at: rec.modified,
    last_used_at: rec.modified,
  };
}

// ── ② 按公司导出 memory.records[](company/team/agent/project 分层保留)────────────────

// conclusion_summary 有原生 companyId 字段可直接过滤;procedural_skill/lesson 只挂 role(没有
// companyId),按"该角色是否出现在本次导出的公司员工里"做范围过滤——与 companyTemplate.ts
// collectBundledSkills 对 bundled skill 的角色过滤是同一思路(避免把其它公司同名角色的记忆错拉进来)。
// 未设 companyId 的 conclusion_summary / 未设 companyId 且角色匹配的 lesson 视为"通用记忆",一并
// 导出——这与 registryStore.retrieveConclusionPoints / reflectionStore.retrieveLessons 检索侧
// "companyId 未设 = 不隔离" 的既有口径一致。
export function exportMemoryRecordsForCompany(
  projectRoot: string,
  companyId: string,
  companyRoles: string[],
): BundleMemoryRecord[] {
  const roleSet = new Set(companyRoles.map((r) => r.toLowerCase()).filter(Boolean));
  const target = normalizeCompanyId(companyId); // 令二.3:导出目标公司归一化(记录侧不归一,legacy 无字段仍被隔离不外泄)
  const out: BundleMemoryRecord[] = [];
  const seen = new Set<string>();
  const pushUnique = (record: BundleMemoryRecord | null) => {
    if (!record) return;
    const key = `${record.owner_type}\n${record.owner_id}\n${record.content.replace(/\s+/g, " ").trim().toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(record);
  };

  // Canonical store first. Only the explicitly bound company layer is portable;
  // user/project/team/agent layers need an explicit company relation before export.
  for (const memory of listLayeredMemories(projectRoot, [{ scope: "company", scopeId: target }], 100)) {
    pushUnique(mapLayeredMemoryToBundleRecord(memory, target));
  }

  // P0(用户要求)· 记忆跨公司硬隔离:导出只带**显式归属本公司**(companyId===本公司)的记录。历史无公司归属
  // (undefined)的技能/教训/结论一律【不随公司导出】(隔离为 legacy_global 语义,默认不外泄)——收口"无 companyId
  // 的历史记录按同名角色跨公司混入"的来源漂移。新记录已由创建/导入侧强制写 companyId,故此后天然无漂移;历史
  // 无归属数据要随公司走,需先显式迁移赋 companyId。role 仅作二级过滤(companyId 已主导隔离)。
  for (const r of loadRegistry(projectRoot)) {
    if (r.kind === "conclusion_summary") {
      if (r.companyId !== target) continue;
      const mapped = mapConclusionSummaryToBundleRecord(r);
      pushUnique(mapped);
    } else if (r.kind === "procedural_skill") {
      if (r.companyId !== target) continue;          // 显式归属本公司才导出;无归属历史 = 隔离,不外泄
      if (!roleSet.has(r.role.toLowerCase())) continue;
      const mapped = mapProceduralSkillToBundleRecord(r);
      pushUnique(mapped);
    }
    // plan_template:不映射,见文件顶注。
  }

  for (const l of loadLessons(projectRoot)) {
    if (l.scope.companyId !== target) continue;      // 同上:显式归属本公司才导出,去掉无归属→按 role 回退的泄漏口
    const mapped = mapLessonToBundleRecord(l);
    pushUnique(mapped);
  }

  return out;
}

// ── ③ 导出脱敏:密钥/本机路径形态扫描(D4 要求 2)───────────────────────────────────
//
// 复用 runtime/templateDoctor.ts 的 SECRET_PATTERNS/本机路径正则**思路**,但不跨文件 import——
// templateDoctor.ts 顶注已明确说明这类正则"各自独立维护,含义一致即可",避免多 Track 并行改动
// 时产生耦合(同一原则也用在 templateDoctor.ts 自己不 import security/redact.ts 上)。

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bark-[A-Za-z0-9_-]{8,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,          // GitHub personal access token(classic)
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,  // GitHub fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g,              // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
  /(["']?(?:api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|access[_-]?token|token)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi,
];

const PATH_PATTERNS: RegExp[] = [
  /\b[A-Za-z]:\\{1,2}[^\s"'\\]+(?:\\{1,2}[^\s"'\\]+)*/g,
  /\/(?:home|Users|root|mnt|var|etc|tmp|opt)\/[^\s"']+/g,
];

// 每次使用前显式清零 lastIndex,不依赖"全局正则 .replace() 会自动重置"的隐式规范行为——
// 同一个 RegExp 对象要在循环里反复扫描很多条记录,显式重置更稳妥、不给未来改动挖坑。
// redactPaths=false(full 档:自己的备份)时只剥密钥,保留本机路径——用户拍板 full 包"仅剥离密钥形态"。
function scanAndRedact(text: string, redactPaths = true): { text: string; hit: boolean } {
  let out = text;
  let hit = false;
  for (const re of SECRET_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) { hit = true; re.lastIndex = 0; out = out.replace(re, "[REDACTED_SECRET]"); }
  }
  if (redactPaths) {
    for (const re of PATH_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(out)) { hit = true; re.lastIndex = 0; out = out.replace(re, "[REDACTED_PATH]"); }
    }
  }
  return { text: out, hit };
}

export interface RedactMemoryRecordsResult {
  records: BundleMemoryRecord[];
  redactedFields: string[]; // 形如 "memory.records[3]"(指南 11.7 示例口径)
}

// 扫描每条记录的 content(+ tags,标签同样可能被误填入路径/密钥字样),命中即整条记录脱敏值 +
// 记一条 redacted_fields。不误伤:未命中任何模式的记录原样返回(同一对象引用,不做无意义拷贝)。
// redactPaths=false(full 档)只剥密钥、保留本机路径。
export function redactMemoryRecords(records: BundleMemoryRecord[], redactPaths = true): RedactMemoryRecordsResult {
  const redactedFields: string[] = [];
  const out = records.map((r, i) => {
    const contentScan = scanAndRedact(r.content, redactPaths);
    let tagsHit = false;
    const tags = r.tags.map((t) => {
      const s = scanAndRedact(t, redactPaths);
      if (s.hit) tagsHit = true;
      return s.text;
    });
    if (!contentScan.hit && !tagsHit) return r;
    redactedFields.push(`memory.records[${i}]`);
    return { ...r, content: contentScan.text, tags };
  });
  return { records: out, redactedFields };
}

// ── P0-4 · 导出/分享脱敏统一层(挂在 canonical 导出路径上)─────────────────────────────
//
// redactMemoryRecords 只覆盖 memory.records;导出物里还有两类会外泄本机绝对路径的载荷:
//   ① agents[](含 org.agents)的 workspaceDir / cliConfigDir —— 纯本机工作目录/凭据目录路径,
//      对接收方无意义且泄漏隐私。reroot 关口(install.rerootAgents)已在导出方向清空它们,这里再兜一层
//      (库内模板可能来自 workshop 保存/直接 import,未必经过 reroot),命中即剥离(置 undefined)。
//   ② bundledSkills[].content —— persona / 打包技能正文,可能夹带盘符路径、家目录路径或密钥形态,
//      按 scanAndRedact 占位化(content 有 min(1) 约束,占位符非空,不违反 schema)。
// 命中项累加进 privacy.redacted_fields(沿用 memory.records[i] 的口径),privacy.redacted 置 true。
// 幂等:未命中任何模式的字段原样保留,重复调用不会二次改写。

export interface SanitizeBundleResult {
  bundle: CompanyBundle;
  redactedFields: string[];
}

// 深度扫描任意 JSON 值:对每个字符串跑 scanAndRedact,命中即占位化并把该字段路径记进 redactedFields。
// 未命中的分支原样返回(同一引用,不做无意义拷贝),整体幂等——已占位化过的正文(bundledSkills/memory)
// 再扫一遍是空操作。用来兜住专项字段之外一切可能夹带本机路径/密钥的结构字段(readme/description/
// useCases/riskNotes/company/workflow/mcpRequirements… 与 agents 的 currentTask/lastAction 运行时残留),
// 保证导出物全文无盘符/家目录路径(要求3)。
function deepRedactStrings(value: unknown, fieldPath: string, redactedFields: Set<string>, redactPaths = true): unknown {
  if (typeof value === "string") {
    const scan = scanAndRedact(value, redactPaths);
    if (!scan.hit) return value;
    redactedFields.add(fieldPath);
    return scan.text;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v, i) => {
      const r = deepRedactStrings(v, `${fieldPath}[${i}]`, redactedFields, redactPaths);
      if (r !== v) changed = true;
      return r;
    });
    return changed ? out : value;
  }
  if (value !== null && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = deepRedactStrings(v, fieldPath ? `${fieldPath}.${k}` : k, redactedFields, redactPaths);
      if (r !== v) changed = true;
      out[k] = r;
    }
    return changed ? out : value;
  }
  return value;
}

export function sanitizeBundleForExport(
  bundle: CompanyBundle,
  opts: { profile?: ExportProfile } = {},
): SanitizeBundleResult {
  // 档位:显式 opts.profile > bundle 自带 export_profile > 缺省 "share"(偏安全的一档)。
  const profile: ExportProfile = opts.profile ?? bundle.export_profile ?? DEFAULT_EXPORT_PROFILE;
  const full = profile === "full";
  // full 档"仅剥离密钥形态"——本机路径保留(自己的备份);share 档密钥+本机路径都占位化(维持现状)。
  const redactPaths = !full;
  const redactedFields = new Set<string>(bundle.privacy?.redacted_fields ?? []);

  // ① agents 的纯本机路径字段(字段清单来自 companyFieldRegistry.AGENT_LOCAL_PATH_FIELDS,
  //    sensitive/non-portable 判定的唯一真相源;占位/剥离的转换行为仍在本函数——收口④口径)。
  //    · share:workspaceDir/cliConfigDir/genericCli 整字段剥离(对接收方无意义、且泄漏隐私,
  //      与 install.rerootAgents 的导出复位同意图)。
  //    · full:genericCli 原样保留(命令原样,导入时提示"指向本机路径,请确认可用");workspaceDir/
  //      cliConfigDir 不删除、只占位成相对标记(导入时提示重映射,不外泄作者机器路径)。
  const LOCAL_PATH_PLACEHOLDERS: Record<(typeof AGENT_LOCAL_PATH_FIELDS)[number], string> = {
    workspaceDir: WORKSPACE_DIR_PLACEHOLDER,
    cliConfigDir: CLI_CONFIG_DIR_PLACEHOLDER,
  };
  const sanitizeAgents = (agents: AgentNodeConfig[]): AgentNodeConfig[] =>
    agents.map((a, i) => {
      let node: AgentNodeConfig | undefined;
      const mut = (): AgentNodeConfig => (node ??= { ...a });
      for (const k of AGENT_LOCAL_PATH_FIELDS) {
        if (a[k] === undefined) continue;
        mut()[k] = full ? LOCAL_PATH_PLACEHOLDERS[k] : undefined;
        redactedFields.add(`agents[${i}].${k}`);
      }
      if (!full && a.genericCli !== undefined) {
        // genericCli(登记表 AGENT_SHARE_STRIPPED_FIELDS):command 为必填、无法单独置空,share 档
        // 整块剥离;full 档原样保留(不进这个分支)。
        mut().genericCli = undefined;
        redactedFields.add(`agents[${i}].genericCli.command`);
      }
      return node ?? a;
    });

  const agents = sanitizeAgents(bundle.agents);

  // ② bundledSkills 正文(persona / 打包技能)占位化(显式字段标签)。full 档只占位密钥。
  const bundledSkills = bundle.bundledSkills?.map((bs, i) => {
    const scan = scanAndRedact(bs.content ?? "", redactPaths);
    if (!scan.hit) return bs;
    redactedFields.add(`bundledSkills[${i}].content`);
    return { ...bs, content: scan.text };
  });

  // ③ memory.records(显式字段标签,与 redactMemoryRecords 一致)。full 档只占位密钥。
  const memoryRecords = bundle.memory?.records ?? [];
  const { records: redactedRecords, redactedFields: memFields } = redactMemoryRecords(memoryRecords, redactPaths);
  for (const f of memFields) redactedFields.add(f);

  // ④ 深度兜底:对以上专项处理之外的所有顶层结构字段 + agents 里的运行时残留(currentTask/lastAction)
  //    + agentMemories 正文统一深度扫描占位化(full 档只占位密钥)。org 不参与扫描(其 agents 直接复用
  //    已脱敏的 agents,避免重复标签),privacy 最后单独重建。
  const scanned = deepRedactStrings(
    {
      ...bundle,
      export_profile: profile,
      agents,
      ...(bundledSkills ? { bundledSkills } : {}),
      memory: bundle.memory ? { ...bundle.memory, records: redactedRecords } : bundle.memory,
      org: undefined,
      privacy: undefined,
    },
    "",
    redactedFields,
    redactPaths,
  ) as CompanyBundle;

  const sanitized: CompanyBundle = {
    ...scanned,
    export_profile: profile,
    org: bundle.org?.agents ? { ...bundle.org, agents: scanned.agents } : bundle.org,
    privacy: { ...bundle.privacy, redacted: true, redacted_fields: [...redactedFields] },
  };
  return { bundle: sanitized, redactedFields: [...redactedFields] };
}

// ── ④ required_secrets 推导(D4 要求 2:从能力依赖推导)───────────────────────────────

// 订阅制 CLI(claude-code/codex)走 OAuth 登录,不需要 provider API key——同口径见
// companyTemplate.ts checkTemplateRequirements 的 CLI_FRAMEWORKS(这里独立维护一份小常量,
// 不跨文件 import 私有集合,理由同上方 SECRET_PATTERNS)。
const CLI_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);

// provider id → 约定的环境变量名,口径对齐 runtime/providerRegistry.ts resolveProviderKey
// 的 `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY` 命名规则(不跨文件 import,
// 这只是个无状态的纯字符串转换,复制一份比引入模块依赖更轻)。
function envKeyName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

export function deriveRequiredSecrets(agents: Array<Pick<AgentNodeConfig, "framework" | "provider">>): RequiredSecretSpec[] {
  const providers = new Set(
    agents
      .filter((a) => !CLI_FRAMEWORKS.has(a.framework ?? "api"))
      .map((a) => a.provider)
      .filter((p): p is string => !!p),
  );
  return [...providers].sort().map((p) => ({
    name: envKeyName(p),
    description: `用于 ${p} provider 的 API backend,导入本模板/公司的用户需自备该 provider 的 key。`,
    required_for: "api",
  }));
}

// ── ⑤ Memory Import Mode 四选一(D5 要求 3;指南 11.17)────────────────────────────

export const MEMORY_IMPORT_MODES = ["structure-only", "structure-sop", "structure-sop-verified", "full"] as const;
export type MemoryImportMode = (typeof MEMORY_IMPORT_MODES)[number];
export const DEFAULT_MEMORY_IMPORT_MODE: MemoryImportMode = "structure-sop";

const LEVELS_BY_IMPORT_MODE: Record<MemoryImportMode, MemoryLevel[]> = {
  "structure-only": [],
  "structure-sop": ["sop", "doctrine"],
  "structure-sop-verified": ["sop", "doctrine", "verified"],
  "full": ["draft", "noted", "verified", "sop", "doctrine"],
};

// 白名单校验:不认识的值一律回退默认("structure-sop"),不让一条坏字符串静默改变安装行为
// (同 installMerge.ts sanitizeMergeStrategies 的既有惯例)。
export function sanitizeMemoryImportMode(input: unknown): MemoryImportMode {
  return typeof input === "string" && (MEMORY_IMPORT_MODES as readonly string[]).includes(input)
    ? (input as MemoryImportMode)
    : DEFAULT_MEMORY_IMPORT_MODE;
}

export function filterMemoryRecordsByImportMode(records: BundleMemoryRecord[], mode: MemoryImportMode): BundleMemoryRecord[] {
  const allowed = new Set(LEVELS_BY_IMPORT_MODE[mode] ?? LEVELS_BY_IMPORT_MODE[DEFAULT_MEMORY_IMPORT_MODE]);
  return records.filter((r) => allowed.has(r.level));
}

// ── ⑥ 导入写回(D5 要求 3:用现有写接口写回 registryStore/reflectionStore)──────────
//
// BundleMemoryRecord 是 11.6 定义的**统一**记忆容器,不携带"这条最初来自 conclusion_summary /
// procedural_skill / lesson 中的哪一种"的显式字段。导出时用 memory_id 前缀（mem-cs-/mem-ps-/
// mem-ls-）编码了来源，导入时按前缀路由回对应的写接口，尽量还原原始形态；不认识的前缀（如社区
// 其它工具产出、或未来 D7 AI 架构师直接生成的 bundle）统一按"通用容器"兜底写入
// conclusion_summary——三者里它对结构约束最少，最适合承接任意文本知识，不强行伪造
// preconditions/successfulSequence 这类程序性字段。

// #9(D6 回滚缺口):导入写回的每条记录 id 都要交回给调用方记进 install transaction,回滚才能按 id
// 撤销。"新建"与"upsert 合并进既有记录"分开报——合并进既有记录的(procedural_skill 按 role+taskType
// 合并、lesson 按 dedupeKey 合并)删掉会伤及本地原有记忆,回滚不动它们,但必须如实报告。
export interface MemoryImportRecordIds {
  governedProposalIds: string[];
  conclusionIds: string[];
  lessonCreatedIds: string[];
  lessonMergedIds: string[];
  proceduralSkillCreatedIds: string[];
  proceduralSkillMergedIds: string[];
}

const emptyRecordIds = (): MemoryImportRecordIds =>
  ({ governedProposalIds: [], conclusionIds: [], lessonCreatedIds: [], lessonMergedIds: [], proceduralSkillCreatedIds: [], proceduralSkillMergedIds: [] });

// 令四.4 · 导入逐项报告:失败/跳过不再静默计数,每一条都带 {memory_id, kind, reason} 进结果与路由响应。
// kind 按 memory_id 前缀分类(mem-ps-=procedural_skill / mem-ls-=lesson / 其余=conclusion_summary,
// 与 importMemoryRecords 的写回路由同一口径)。reason 区分两类:写接口返回 null(如 lesson 撞
// revoked 终态、addConclusionSummary 拒收)→ "rejected-by-store";写接口抛异常 → 异常消息。
export interface MemoryImportFailure {
  memory_id: string;
  kind: "conclusion_summary" | "procedural_skill" | "lesson";
  reason: string;
}

export function memoryRecordKind(memoryId: string): MemoryImportFailure["kind"] {
  if (memoryId.startsWith("mem-ps-")) return "procedural_skill";
  if (memoryId.startsWith("mem-ls-")) return "lesson";
  return "conclusion_summary";
}

export interface MemoryImportResult {
  imported: number;
  skipped: number;
  byKind: { conclusionSummary: number; proceduralSkill: number; lesson: number };
  recordIds: MemoryImportRecordIds;
  // 令四.4:逐条失败明细(skipped 的每一条都在此列出,可见不可静默)。imported 成功的不进此列表。
  failures: MemoryImportFailure[];
  rolledBack?: boolean;
  rollbackFailures?: string[];
}

export function importMemoryRecords(
  projectRoot: string,
  records: BundleMemoryRecord[],
  // 收口作战令一.1 · 记忆写入语义:模板导入/社区导入**默认 proposed**(new-company 与 merge 同一口径,
  // 不再区分)——只有独立 approve endpoint 或明确"保存并批准"动作才能 committed。显式 asProposal:false
  // 才回到即时批准(当前无生产调用方这样传;写侧 fail-safe 默认待审)。
  // 覆盖面:conclusion_summary→pending;lesson→proposed(addManualLesson asProposal)。procedural_skill
  // 尚无审核态(status 只有 candidate/verified/retired),统一状态机列收口令二.5——candidate 不算
  // "已验证",且注入侧有公司硬隔离+源 run 终态过滤兜底;如实标注,不冒充已闭环。
  opts: { companyId?: string; nowIso?: string; asProposal?: boolean } = {},
): MemoryImportResult {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  let cs = 0, ps = 0, ls = 0, skipped = 0;
  const recordIds = emptyRecordIds();
  const failures: MemoryImportFailure[] = [];
  const pushUnique = (arr: string[], id: string) => { if (!arr.includes(id)) arr.push(id); };

  for (const r of records) {
    try {
      const kind = memoryRecordKind(r.memory_id);
      const objectType = kind === "lesson" ? "failure_lesson" : "success_experience";
      const proposal = proposeMemory(projectRoot, {
        text: r.content,
        title: kind === "procedural_skill"
          ? `可复用成功经验 · ${r.owner_id || "imported"}`
          : kind === "lesson" ? "导入的失败教训" : "导入的结论经验",
        summary: r.content.replace(/\s+/g, " ").slice(0, 180),
        objectType,
        scope: "company",
        scopeId: opts.companyId || "default",
        sourceType: "import",
        // Imported source run ids belong to another installation and cannot be
        // treated as local evidence. Every import therefore starts proposed.
        autoApprove: false,
        rootCauseConfirmed: false,
        evidenceIds: r.source.run_id ? [`external:${r.source.run_id}`] : [],
        counterexamples: [],
        portableBundleRecord: r,
      });
      if (proposal.status === "rejected") {
        skipped++;
        failures.push({ memory_id: r.memory_id, kind, reason: proposal.reasons.join("; ") || "治理规则拒收" });
        continue;
      }
      pushUnique(recordIds.governedProposalIds, proposal.proposalId);
      if (kind === "procedural_skill") ps++;
      else if (kind === "lesson") ls++;
      else cs++;
    } catch (e) {
      // 单条导入失败不阻断整体(best-effort),但令四.4 起不再静默:逐条记 {memory_id,kind,reason}。
      skipped++;
      failures.push({ memory_id: r.memory_id, kind: memoryRecordKind(r.memory_id), reason: (e as Error)?.message || String(e) });
    }
  }

  if (failures.length) {
    const rollbackFailures: string[] = [];
    try { removeGovernedMemoryProposalsByIds(projectRoot, recordIds.governedProposalIds); }
    catch (error) { rollbackFailures.push(`governed proposals: ${(error as Error)?.message || String(error)}`); }

    if (rollbackFailures.length) {
      throw new Error(`memory import failed and rollback was incomplete: ${rollbackFailures.join("; ")}`);
    }

    const failedById = new Map(failures.map((failure) => [failure.memory_id, failure]));
    const atomicFailures = records.map((record) => failedById.get(record.memory_id) ?? {
      memory_id: record.memory_id,
      kind: memoryRecordKind(record.memory_id),
      reason: "同批其它记录失败,本条成功写入已回滚",
    });
    return {
      imported: 0,
      skipped: records.length,
      byKind: { conclusionSummary: 0, proceduralSkill: 0, lesson: 0 },
      recordIds: emptyRecordIds(),
      failures: atomicFailures,
      rolledBack: true,
    };
  }

  return { imported: cs + ps + ls, skipped, byKind: { conclusionSummary: cs, proceduralSkill: ps, lesson: ls }, recordIds, failures };
}

// 组合入口:按 memoryImportMode 过滤 + 写回,供 install/company 路由直接调用。
export function applyMemoryImportMode(
  projectRoot: string,
  records: BundleMemoryRecord[] | undefined,
  mode: MemoryImportMode,
  opts: { companyId?: string; nowIso?: string; asProposal?: boolean } = {},
): MemoryImportResult & { mode: MemoryImportMode; totalRecords: number; filteredRecords: number } {
  const all = records ?? [];
  const filtered = filterMemoryRecordsByImportMode(all, mode);
  const result = filtered.length
    ? importMemoryRecords(projectRoot, filtered, opts)
    : { imported: 0, skipped: 0, byKind: { conclusionSummary: 0, proceduralSkill: 0, lesson: 0 }, recordIds: emptyRecordIds(), failures: [] };
  return { ...result, mode, totalRecords: all.length, filteredRecords: filtered.length };
}

// ── ⑦ import/export job 状态机(D4 要求 4)──────────────────────────────────────────
//
// V0 阶段执行仍是同步的(不引入队列/worker 进程,见 storage/memoryJobStore.ts 顶注);这里只是给
// applyMemoryImportMode 包一层 queued→processing→completed/failed 的落盘轨迹,供后续 UI 展示。
// UI 接线本次不做(如实标注,见任务报告)。
export function applyMemoryImportModeTracked(
  projectRoot: string,
  records: BundleMemoryRecord[] | undefined,
  mode: MemoryImportMode,
  opts: { companyId?: string; bundleId?: string; nowIso?: string; asProposal?: boolean } = {},
): ReturnType<typeof applyMemoryImportMode> & { job: MemoryJobRecord } {
  const nowIso = opts.nowIso ?? new Date().toISOString();
  let job = createMemoryJob(projectRoot, { kind: "import", companyId: opts.companyId, bundleId: opts.bundleId, memoryImportMode: mode }, nowIso);
  job = updateMemoryJob(projectRoot, job.jobId, { status: "validating" }, nowIso) ?? job;
  try {
    job = updateMemoryJob(projectRoot, job.jobId, { status: "processing" }, nowIso) ?? job;
    const result = applyMemoryImportMode(projectRoot, records, mode, opts);
    if (result.failures.length) {
      throw new Error(`memory import failed atomically: ${result.failures.map((failure) => `${failure.memory_id}: ${failure.reason}`).join("; ")}`);
    }
    job = updateMemoryJob(projectRoot, job.jobId, {
      status: "completed",
      result: { totalRecords: result.totalRecords, filteredRecords: result.filteredRecords, imported: result.imported, skipped: result.skipped },
    }, nowIso) ?? job;
    return { ...result, job };
  } catch (e) {
    job = updateMemoryJob(projectRoot, job.jobId, { status: "failed", error: (e as Error).message }, nowIso) ?? job;
    throw e;
  }
}
