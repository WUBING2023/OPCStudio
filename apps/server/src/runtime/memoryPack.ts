// Memory Pack —— 统一投影层(纯聚合,不重写任何底层存储/检索)。
// 现状:6 套记忆子系统(skillStore+contextBuilder 角色技能 / memoryStore 四层时间跨度 / mdMemory
// company-team-project-agent 四份 md / registryStore 结论+程序技能+计划模板 / reflectionStore 失败教训 /
// memoryCommit+committedMemoryRetriever 跨 run 结论)各自独立检索、独立注入进 prompt,用户看不到
// "这次用了哪些记忆、为什么选中它们"。buildMemoryPack() 把它们的检索结果聚合成一个结构化、带
// provenance 的对象,只做"记录用了什么",不改变实际注入 prompt 的文本/顺序/截断逻辑(那部分仍是
// contextBuilder.buildSystemPrompt 的职责,零行为回归)。
//
// 健壮性契约:任何一个子系统检索报错/返回空,只让**那部分** items 为空 —— 绝不让整个 buildMemoryPack 抛错。
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { TraceEvent } from "@opc/shared";
import { goalToSlug, queryMemory, listMemory } from "../storage/memoryStore.js";
import { readCompanyMd, readTeamMd, readProjectMd, readAgentMemory } from "../storage/mdMemory.js";
import { loadRunEventsRaw } from "../storage/projectStore.js";
import { retrieveLessons, loadLessons } from "../storage/reflectionStore.js";
import {
  loadRegistry,
  retrieveConclusionPoints,
  retrieveProceduralSkills,
  retrievePlanTemplate,
  type ConclusionSummary,
} from "../storage/registryStore.js";
import { retrieveCommittedMemories, listAllCommittedMemories } from "./committedMemoryRetriever.js";
import { classifyTaskType } from "./runCritic.js";

// 统一的组织架构维度(与各子系统原生的 scope 术语不同——如 memoryCommit 的 run/project/team/agent,
// reflectionStore 的 companyId/teamId/role/agentId——这里是给用户看的"这条记忆挂在哪一级"的归一投影)。
export type MemoryPackScope = "employee" | "department" | "company" | "workspace" | "run";

export interface MemoryPackItem {
  memoryId: string;
  scope: MemoryPackScope;
  kind: string; // "lesson" | "conclusion" | "procedural_skill" | "plan_template" | "md_company" | "md_team" | "md_project" | "md_agent" | "memory_entry" | "committed"
  content: string; // 截断预览,<=200 字
  sourceRunId?: string;
  confidence?: number;
  whySelected: string; // 一句话说明命中原因
}

export interface MemoryPackResult {
  items: MemoryPackItem[];
  countsByScope: Record<MemoryPackScope, number>;
  // B5 · 证据链:对 items 身份做的稳定 sha256(见 computeMemoryPackHash)。Run Ledger 后续把它写进
  // run 级证据;本批消费点在 orchestrator(他人文件),故只随返回值携带,接线留待 B2 后。
  packHash: string;
  generatedAt: string;
}

// B5 · pack hash:对 items 的 id+版本做稳定 sha256。MemoryPackItem 没有显式版本号,用
// sourceRunId+content(200 字预览)作版本代理——底层记忆内容一变,hash 即变。与 items 顺序无关
// (排序后拼接),同一组 items 恒得同一 hash。绝不抛:极端情况下退化为标注占位串。
export function computeMemoryPackHash(items: MemoryPackItem[]): string {
  try {
    const keys = items
      .map((it) => JSON.stringify([it.memoryId, it.sourceRunId ?? "", it.content]))
      .sort();
    return "sha256:" + createHash("sha256").update(keys.join("\n"), "utf-8").digest("hex");
  } catch {
    return "sha256:unhashable";
  }
}

export interface MemoryPackContext {
  goal: string;
  companyId?: string;
  teamId?: string;
  agentId: string;
  role: string;
}

const MAX_CONTENT_CHARS = 200;

function preview(s: unknown, max = MAX_CONTENT_CHARS): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// ── 各子系统 → MemoryPackItem[](各自独立 try/catch,一个挂了不连累其它)────────────

// registryStore · conclusion_summary。retrieveConclusionPoints 只返回扁平要点字符串(不带 id/来源),
// 这里额外用 loadRegistry 回查出产生这些要点的原始记录,补全 provenance(memoryId/runId)。
function conclusionItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const registry = loadRegistry(root);
    const points = retrieveConclusionPoints(root, {
      companyId: ctx.companyId,
      goalSlug: goalToSlug(ctx.goal),
      goal: ctx.goal,
      limit: 2,
      preloaded: registry,
    });
    if (!points.length) return [];
    const records = registry.filter((r): r is ConclusionSummary => r.kind === "conclusion_summary");
    const used = new Set<string>();
    const items: MemoryPackItem[] = [];
    for (const p of points) {
      const rec = records.find((r) => !used.has(r.id) && r.points.includes(p));
      if (!rec) continue;
      used.add(rec.id);
      items.push({
        memoryId: rec.id,
        scope: rec.teamId ? "department" : rec.companyId ? "company" : "workspace",
        kind: "conclusion",
        content: preview(rec.points.join("; ")),
        sourceRunId: rec.sourceRunId ?? rec.runId,
        whySelected: "goal/tag 相关性命中过往结论要点(registryStore.retrieveConclusionPoints)",
      });
    }
    return items;
  } catch {
    return [];
  }
}

// registryStore · procedural_skill(role 硬匹配 + status=verified,唯一有真正晋升语义的 kind)。
function proceduralSkillItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const skills = retrieveProceduralSkills(root, { role: ctx.role, companyId: ctx.companyId, taskType: classifyTaskType(ctx.goal), limit: 1 });
    return skills.map((s) => ({
      memoryId: s.id,
      scope: "workspace" as const, // procedural_skill 只按 role 隔离,无 company/team 字段——比 company 更宽的作用域
      kind: "procedural_skill",
      content: preview(s.successfulSequence.join(" → ") || s.taskType || ""),
      sourceRunId: s.sourceRuns[s.sourceRuns.length - 1],
      confidence: s.successRate,
      whySelected: `角色匹配(${ctx.role})+已验证(support=${s.support}>=3)`,
    }));
  } catch {
    return [];
  }
}

// registryStore · plan_template(company 硬隔离)。
function planTemplateItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const tpl = retrievePlanTemplate(root, { companyId: ctx.companyId, taskType: classifyTaskType(ctx.goal) });
    if (!tpl) return [];
    return [{
      memoryId: tpl.id,
      scope: tpl.companyId ? "company" : "workspace",
      kind: "plan_template",
      content: preview(tpl.split.join(" | ")),
      sourceRunId: tpl.sourceRun,
      whySelected: `company+任务类型匹配,已被 ${tpl.support} 个不同 run 验证`,
    }];
  } catch {
    return [];
  }
}

// reflectionStore · 失败教训(role 硬匹配 + team/company 设了就硬隔离,取 committed 状态)。
function lessonItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const lessons = retrieveLessons(root, {
      role: ctx.role,
      teamId: ctx.teamId,
      companyId: ctx.companyId,
      taskType: classifyTaskType(ctx.goal),
      limit: 3,
    });
    return lessons.map((l) => ({
      memoryId: l.id,
      scope: l.scope.agentId ? "employee" : l.scope.teamId ? "department" : l.scope.companyId ? "company" : "workspace",
      kind: "lesson",
      content: preview(l.injection.promptText || l.lesson),
      sourceRunId: l.evidence.runId,
      confidence: l.confidence,
      whySelected: `角色匹配(${ctx.role})+失败模式命中(${l.trigger.failureMode})+confidence达标`,
    }));
  } catch {
    return [];
  }
}

// memoryStore · project 层记忆(D 层清理后只剩这一层,session/task/global 从未被写入过的死分支已删除)。
function memoryStoreItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const entries = queryMemory(root, { agentRole: ctx.role, goal: ctx.goal, limit: 5 });
    return entries.map((e) => ({
      memoryId: e.id,
      scope: "workspace" as const,
      kind: "memory_entry",
      content: preview(e.text),
      sourceRunId: e.source?.runId,
      whySelected: `角色匹配(${e.agentRole === "*" ? "全角色" : e.agentRole})+goal关键词命中(project 层)`,
    }));
  } catch {
    return [];
  }
}

// memoryCommit + committedMemoryRetriever · 跨 run 已提交结论(role 隔离 + goal 相关性打分)。
// 不带"当前 run"概念(buildMemoryPack 是静态/按需视图,非绑定某次具体 run),传空串即不排除任何历史 run。
function committedItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  try {
    const mems = retrieveCommittedMemories(root, ctx.goal, "", 800, ctx.role, undefined, { taskType: classifyTaskType(ctx.goal) });
    return mems.map((m) => ({
      memoryId: m.memoryId,
      scope: m.scope === "run" ? "run" : m.scope === "team" ? "department" : m.scope === "agent" ? "employee" : "workspace",
      kind: "committed",
      content: preview(m.content),
      confidence: m.confidence,
      whySelected: "goal 关键词重叠 + 跨 run 已提交置信度达标(committedMemoryRetriever)",
    }));
  } catch {
    return [];
  }
}

// mdMemory · 四份共享 md(框架无关持久记忆)。本身没有"多条记录"概念——整份文件当前内容包装成一条。
function mdMemoryItems(root: string, ctx: MemoryPackContext): MemoryPackItem[] {
  const items: MemoryPackItem[] = [];
  try {
    const company = readCompanyMd(root, ctx.companyId);
    if (company) {
      items.push({
        memoryId: "md-company",
        scope: "company",
        kind: "md_company",
        content: preview(company),
        whySelected: "公司共享记忆(company.md),全员可读",
      });
    }
  } catch { /* degrade this source only */ }
  try {
    if (ctx.teamId) {
      const team = readTeamMd(root, ctx.teamId);
      if (team) {
        items.push({
          memoryId: `md-team-${ctx.teamId}`,
          scope: "department",
          kind: "md_team",
          content: preview(team),
          whySelected: `团队记忆(team.md,按 leadId=${ctx.teamId} 索引)`,
        });
      }
    }
  } catch { /* degrade this source only */ }
  try {
    if (ctx.teamId) {
      // 命名历史遗留:project.md 实际也按 leadId 索引(与 team.md 同键),内容是项目目标/设计/共享事实档案。
      const project = readProjectMd(root, ctx.teamId);
      if (project) {
        items.push({
          memoryId: `md-project-${ctx.teamId}`,
          scope: "department",
          kind: "md_project",
          content: preview(project),
          whySelected: `项目记忆(project.md,按 leadId=${ctx.teamId} 索引——历史命名遗留,非按项目 ID)`,
        });
      }
    }
  } catch { /* degrade this source only */ }
  try {
    const self = readAgentMemory(root, ctx.agentId);
    if (self) {
      items.push({
        memoryId: `md-agent-${ctx.agentId}`,
        scope: "employee",
        kind: "md_agent",
        content: preview(self),
        whySelected: "该 agent 自己的持久记忆(agent-memory.md),仅本人可读",
      });
    }
  } catch { /* degrade this source only */ }
  return items;
}

const EMPTY_COUNTS: Record<MemoryPackScope, number> = { employee: 0, department: 0, company: 0, workspace: 0, run: 0 };

// 聚合入口:依次调用 6 套子系统的现有检索函数,包装成统一形状。任一子系统失败只让它那部分 items 为空,
// 绝不整体抛错(每个 helper 内部已各自 try/catch;这里再兜一层双保险)。
export function buildMemoryPack(root: string, ctx: MemoryPackContext): MemoryPackResult {
  const items: MemoryPackItem[] = [];
  const collectors = [conclusionItems, proceduralSkillItems, planTemplateItems, lessonItems, memoryStoreItems, committedItems, mdMemoryItems];
  for (const collect of collectors) {
    try {
      items.push(...collect(root, ctx));
    } catch { /* best-effort: 该子系统降级为空,不影响其余部分 */ }
  }
  const countsByScope: Record<MemoryPackScope, number> = { ...EMPTY_COUNTS };
  for (const it of items) countsByScope[it.scope] = (countsByScope[it.scope] ?? 0) + 1;
  return { items, countsByScope, packHash: computeMemoryPackHash(items), generatedAt: new Date().toISOString() };
}

// GET /api/agents/:id/memories 的默认 goal:该 agent 不绑定某次具体任务时,"如果现在有个任务大概会用到
// 什么"的通用占位 goal——足够泛,不会让 goal 关键词打分主导结果,主要靠 role/company/team 隔离筛选。
export const GENERIC_GOAL = "完成日常工作任务";

// ── /api/memory/summary(全局概览,不分角色)───────────────────────────────────
// 与 buildMemoryPack 不同:buildMemoryPack 是"给定 agent+goal 会检索到什么"(应用 role 硬匹配、
// company/team 隔离、goal 相关性排序、top-N 限量);这里是**原始总量**——不筛选、不打分、不限量,
// 单纯数"各 scope/kind 各有多少条"给管理视图看全局记忆库有多大。同样任一子系统失败只降级那部分计数。
export interface MemorySummary {
  countsByScope: Record<MemoryPackScope, number>;
  countsByKind: Record<string, number>;
  total: number;
  generatedAt: string;
}

function orgScope(agentIdPresent: boolean, teamIdPresent: boolean, companyIdPresent: boolean): MemoryPackScope {
  if (agentIdPresent) return "employee";
  if (teamIdPresent) return "department";
  if (companyIdPresent) return "company";
  return "workspace";
}

export function buildMemorySummary(root: string): MemorySummary {
  const countsByScope: Record<MemoryPackScope, number> = { ...EMPTY_COUNTS };
  const countsByKind: Record<string, number> = {};
  let total = 0;
  const bump = (kind: string, scope: MemoryPackScope) => {
    countsByKind[kind] = (countsByKind[kind] ?? 0) + 1;
    countsByScope[scope] += 1;
    total += 1;
  };

  try {
    for (const r of loadRegistry(root)) {
      if (r.kind === "conclusion_summary") bump("conclusion", orgScope(false, !!r.teamId, !!r.companyId));
      else if (r.kind === "procedural_skill") bump("procedural_skill", "workspace"); // role 级,无 company/team 字段
      else if (r.kind === "plan_template") bump("plan_template", orgScope(false, false, !!r.companyId));
    }
  } catch { /* degrade */ }

  try {
    for (const l of loadLessons(root)) {
      bump("lesson", orgScope(!!l.scope.agentId, !!l.scope.teamId, !!l.scope.companyId));
    }
  } catch { /* degrade */ }

  try {
    const n = listMemory(root).length;
    for (let i = 0; i < n; i++) bump("memory_entry", "workspace");
  } catch { /* degrade */ }

  try {
    for (const m of listAllCommittedMemories(root)) {
      bump("committed", m.scope === "run" ? "run" : m.scope === "team" ? "department" : m.scope === "agent" ? "employee" : "workspace");
    }
  } catch { /* degrade */ }

  // mdMemory 四层:本身没有"多条记录"概念,数存在的**文件数**(company.md 最多 1 份;team/project/agent 各按目录枚举)。
  // 不经 mdMemory.ts 的 read*(那是拿内容,这里只要计数)——直接按其已知的固定目录约定枚举(只读文件名,不读内容)。
  try {
    const knowledgeDir = path.join(root, ".opc", "knowledge");
    if (fs.existsSync(path.join(knowledgeDir, "company.md"))) bump("md_company", "company");
    for (const [sub, kind, scope] of [
      ["teams", "md_team", "department"],
      ["projects", "md_project", "department"],
      ["agents", "md_agent", "employee"],
    ] as const) {
      const dir = path.join(knowledgeDir, sub);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) if (f.endsWith(".md")) bump(kind, scope);
    }
  } catch { /* degrade */ }

  return { countsByScope, countsByKind, total, generatedAt: new Date().toISOString() };
}

// kind → 人话标签(摘要行与引用标题共用)。
const KIND_LABEL: Record<string, string> = {
  lesson: "失败教训", conclusion: "结论记忆", procedural_skill: "可复用成功经验", plan_template: "计划模板",
  md_company: "公司知识", md_team: "团队记忆", md_project: "项目记忆", md_agent: "个人记忆",
  memory_entry: "历史经验", committed: "跨run记忆",
};

// 供事件消息使用的人话摘要(不进入 MemoryPackResult 结构本身,纯展示用)。
export function summarizeMemoryPackUsage(pack: MemoryPackResult): string {
  const byKind = new Map<string, number>();
  for (const it of pack.items) byKind.set(it.kind, (byKind.get(it.kind) ?? 0) + 1);
  if (byKind.size === 0) return "未命中可用记忆";
  return [...byKind.entries()].map(([k, n]) => `${n} 条${KIND_LABEL[k] ?? k}`).join("、");
}

// ── CEO 记忆引用溯源:注入即引用,最小语义 {id, title} ──────────────────────────────
// 派单/执行时把 pack 里已聚合(=已用于本轮上下文投影)的记忆,升级为结构化引用挂到消息 payload。
// id 直接取 MemoryPackItem.memoryId(与 Run Ledger / memoryRoutes 同一份身份,web 可回溯到经验页);
// title 从 content 预览裁出的一句话(无 content 时退回 kind 人话标签)。纯派生,绝不抛。
export interface CitedMemory {
  id: string;
  title: string;
}

const CITE_TITLE_MAX = 32;
const CITE_MAX = 6; // 单条消息最多引用条数(控消息体积/避免刷屏)

function citeTitleFromText(text: unknown, kind: string): string {
  const base = String(text || KIND_LABEL[kind] || kind || "记忆").replace(/\s+/g, " ").trim();
  return base.length > CITE_TITLE_MAX ? `${base.slice(0, CITE_TITLE_MAX)}…` : base;
}

function citeTitle(it: MemoryPackItem): string {
  return citeTitleFromText(it.content, it.kind);
}

// pack.items → 去重后的引用列表(按 memoryId 去重,保持 items 原顺序,最多 CITE_MAX 条)。
// ⚠️ 仅供审计/展示视图使用——**不是**诚实的引用来源:pack 里可能含"本轮会检索到但未真正拼进
// prompt"的条目(超预算截断、失败 run 隔离前的 committed、纯展示投影)。用它作 UI"依据经验《X》"的
// 来源会让 X 从未进 prompt = 造假。真正的引用来源见下方 citeMemories(injectedMemories)。
export function citeMemoriesFromPack(pack: MemoryPackResult | undefined, limit = CITE_MAX): CitedMemory[] {
  const out: CitedMemory[] = [];
  if (!pack?.items?.length) return out;
  const seen = new Set<string>();
  for (const it of pack.items) {
    const id = it.memoryId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: citeTitle(it) });
    if (out.length >= limit) break;
  }
  return out;
}

// ── 注入即引用(诚实版)· 引用来源 = 真正拼进 prompt 的记忆清单 ──────────────────────────
// contextBuilder.buildSystemPrompt 每注入一条记忆(md 四份 / 历史经验 / 失败教训 / 结论要点 /
// 推荐工作流 / 已审批的跨 run 经验)就登记一条 {id, kind, title} 到 InjectionContext.injectedMemories。
// citeMemories 只从该清单派生 UI 引用条 → "依据经验《X》"里的 X 保证真的进了 prompt(不再从 memoryPack
// 审计视图派生,杜绝造假)。id 与 memoryPack/Run Ledger 同一份身份,web 可回溯到经验页。
export interface InjectedMemoryRef {
  id: string;
  kind: string;   // MemoryPackItem.kind 同集:md_* / memory_entry / lesson / conclusion / procedural_skill / committed
  title: string;  // 注入内容的短预览(citeMemories 再截断到 CITE_TITLE_MAX)
}

// injectedMemories → 去重后的引用列表(按 id 去重,保持注入顺序,最多 limit 条)。**唯一**诚实引用来源。
export function citeMemories(refs: InjectedMemoryRef[] | undefined, limit = CITE_MAX): CitedMemory[] {
  const out: CitedMemory[] = [];
  if (!refs?.length) return out;
  const seen = new Set<string>();
  for (const r of refs) {
    if (!r?.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, title: citeTitleFromText(r.title, r.kind) });
    if (out.length >= limit) break;
  }
  return out;
}

// 追加到消息正文的一行人话引用(非 web 消费方/纯文本轨迹的可读兜底):依据经验:《标题》…×N。
export function formatCitationLine(cited: CitedMemory[]): string {
  if (!cited.length) return "";
  const shown = cited.slice(0, 3).map((c) => `《${c.title}》`).join("");
  return `依据经验:${shown}×${cited.length}`;
}

// ── run 级读取(Run Story 集成)──────────────────────────────────────────────
// 纯派生,同 deriveRunStory/deriveRunMemories 模式(runtime/runStory.ts、runtime/runMemories.ts):
// orchestrator 在每个 agent 执行时 emit("info", agentId, { kind: "memory_pack_used", ... }),该事件
// 随 eventBus 自动落 <root>/.opc/runs/<runId>/events.jsonl;这里只读盘、翻译,不额外维护一份run级文件
// (找不到文件/解析失败一律返回空,绝不抛,与既有 deriveXxx 系列同规)。

export interface AgentMemoryPackUsage {
  agentId?: string;
  role?: string;
  timestamp?: string;
  message?: string;
  countsByScope: Record<MemoryPackScope, number>;
}

export interface RunMemoryPackUsage {
  runId: string;
  usages: AgentMemoryPackUsage[];
  totalByScope: Record<MemoryPackScope, number>;
}

export function deriveRunMemoryPackUsage(projectRoot: string, runId: string): RunMemoryPackUsage {
  const usages: AgentMemoryPackUsage[] = [];
  const totalByScope: Record<MemoryPackScope, number> = { ...EMPTY_COUNTS };
  try {
    const rawFile = loadRunEventsRaw(projectRoot, runId);
    if (rawFile === null) return { runId, usages, totalByScope };
    for (const raw of rawFile.split("\n")) {
      if (!raw.trim()) continue;
      let ev: TraceEvent;
      try { ev = JSON.parse(raw) as TraceEvent; } catch { continue; }
      if (ev.type !== "info") continue;
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (p.kind !== "memory_pack_used") continue;
      const rawCbs = (p.countsByScope ?? {}) as Record<string, number>;
      const cbs: Record<MemoryPackScope, number> = { ...EMPTY_COUNTS };
      for (const k of Object.keys(EMPTY_COUNTS) as MemoryPackScope[]) cbs[k] = Number(rawCbs[k]) || 0;
      usages.push({
        agentId: ev.agentId,
        role: typeof p.role === "string" ? p.role : undefined,
        timestamp: ev.timestamp,
        message: typeof p.message === "string" ? p.message : undefined,
        countsByScope: cbs,
      });
      for (const k of Object.keys(totalByScope) as MemoryPackScope[]) totalByScope[k] += cbs[k];
    }
  } catch { /* best-effort → 已收集的 usages */ }
  return { runId, usages, totalByScope };
}
