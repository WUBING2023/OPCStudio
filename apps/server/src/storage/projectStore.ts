import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentNodeConfig,
  ProjectConfig,
  Run,
  TraceEvent,
  WorkerStartupDiagnostic,
} from "@opc/shared";
import { readJSON, writeJSON } from "./jsonFile.js";
import { redactSecrets } from "../security/redact.js";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs, upsertDoc, columnsFor } from "./sqlite/docTableBackend.js";

const OPC_DIR = ".opc";

// Config
export function loadConfig(projectRoot: string): ProjectConfig {
  const cfg = readJSON<ProjectConfig>(path.join(projectRoot, OPC_DIR, "config.json"), {
    version: "0.1.0", projectName: path.basename(projectRoot),
    apiKeys: {}, defaultModel: "deepseek-v4-pro",
    budget: { totalUsd: 0, maxTokensPerTask: 200_000 },
    permissions: { allowShell: true, allowFileWrite: true, allowWebAccess: true },
  });
  // 新项目三类能力默认开启；旧项目显式选择仍保留。缺字段的历史配置补齐为新默认。
  cfg.permissions = {
    allowShell: cfg.permissions?.allowShell ?? true,
    allowFileWrite: cfg.permissions?.allowFileWrite ?? true,
    allowWebAccess: cfg.permissions?.allowWebAccess ?? true,
  };
  // 读旧写新:历史 creative/judge 分档收敛为唯一 default。若旧两档不同，固定取 creative
  // (其次 judge)，避免同一“默认模型”在不同系统功能中继续漂移。
  const unifiedSystemModel = cfg.systemModel?.default ?? cfg.systemModel?.creative ?? cfg.systemModel?.judge;
  if (unifiedSystemModel) {
    cfg.systemModel = { default: unifiedSystemModel };
    cfg.defaultModel = unifiedSystemModel.model;
  }
  // Merge in newer budget defaults so existing config.json files gain them transparently.
  const b = cfg.budget || { totalUsd: 0, maxTokensPerTask: 200_000 };
  cfg.budget = {
    // Retained for config compatibility only. Monetary limits are not enforced.
    totalUsd: b.totalUsd ?? 0,
    maxTokensPerTask: b.maxTokensPerTask ?? 200_000,
    maxAttemptsPerTask: b.maxAttemptsPerTask ?? 2,
    taskTimeoutMs: b.taskTimeoutMs ?? 180_000,
    // 效率闸 · V0 默认必须有 run 级上限(用户"高 token 发现":sum 任务 105k/dev 83k 无刹车)。
    // 默认即生效:60k tokens/run——超限后停止派新任务、已派收尾、余下 deferred。
    maxTokensPerRun: b.maxTokensPerRun ?? 60_000, // 默认 60k tokens/run 刹车(0 内部禁用,但 schema min=1 → 走显式调高放宽)
    maxTokensTotal: b.maxTokensTotal ?? 0,     // 0 = 禁用（run 级累计 token 硬上限,与 perRun 独立）
    maxCostPerRun: b.maxCostPerRun ?? 0,       // legacy compatibility only; monetary gates are disabled
  };
  return cfg;
}

export function saveConfig(projectRoot: string, config: ProjectConfig) {
  writeJSON(path.join(projectRoot, OPC_DIR, "config.json"), config);
}

// Agents
// 战役B·Phase B2b:接后端开关。默认 json 逐字节不变;sqlite 时读走 agents 表(权威)、写【双写】。
// SQLite uses fallback only for a store that has never initialized its canonical agents source.
export function loadAgents(projectRoot: string, fallback: AgentNodeConfig[]): AgentNodeConfig[] {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    const stored = readAllDocs(db, "agents") as AgentNodeConfig[];
    if (stored.length > 0) return stored;

    // An empty SQLite table is ambiguous: a brand-new installation needs the
    // caller's defaults, while an explicitly saved empty organization must stay
    // empty. Dual-write and migration both leave a canonical source marker, so
    // only a store that has never had an agents source may use the fallback.
    const canonical = path.join(projectRoot, OPC_DIR, "agents.json");
    const migrated = db.prepare("SELECT 1 FROM _migrations WHERE source = ?").get("agents.json");
    return fs.existsSync(canonical) || migrated ? [] : fallback;
  }
  return readJSON<AgentNodeConfig[]>(path.join(projectRoot, OPC_DIR, "agents.json"), fallback);
}

export function saveAgents(projectRoot: string, agents: AgentNodeConfig[]) {
  writeJSON(path.join(projectRoot, OPC_DIR, "agents.json"), agents);
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "agents", agents);
  }
}

// 合并存盘:只更新传入子集(按 id),保留 agents.json 里其他 agent(如其他公司的)。
// 修复多公司 bug:一次 run 只持有本公司 agent 子集,直接 saveAgents 会抹掉其他公司的 agent。
// sqlite 时"保留他公司 agent"= 按 id upsert(天然更稳,不触碰未传入的行);agents.json 照写(双写),
// 且从表快照落盘 —— upsert 就地更新保持原插入序,agents.json 取同一序,保证与 agents 表逐条一致(含顺序)。
export function mergeSaveAgents(projectRoot: string, subset: AgentNodeConfig[]) {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    for (const a of subset) upsertDoc(db, "agents", a.id, a);
    writeJSON(path.join(projectRoot, OPC_DIR, "agents.json"), readAllDocs(db, "agents"));
    return;
  }
  const all = loadAgents(projectRoot, []);
  const ids = new Set(subset.map((a) => a.id));
  const others = all.filter((a) => !ids.has(a.id));
  writeJSON(path.join(projectRoot, OPC_DIR, "agents.json"), [...others, ...subset]);
}

// Runs
export function createRun(projectRoot: string, run: Run) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", run.id);
  writeJSON(path.join(dir, "task.json"), run);
  updateRunIndex(projectRoot, runToIndexEntry(run)); // P2#7 滚动索引:起跑即登记
}

export function saveRunTask(projectRoot: string, run: Run) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", run.id);
  writeJSON(path.join(dir, "task.json"), run);
  updateRunIndex(projectRoot, runToIndexEntry(run)); // P2#7:状态/token/降级 增量同步
}

export function saveRunReport(projectRoot: string, runId: string, md: string, html: string) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "report.md"), md, "utf-8");
  fs.writeFileSync(path.join(dir, "report.html"), html, "utf-8");
  // 任务卡一句话摘要 + 部分产物标志(⏱️ 超时抢救的标头会进合成文本,服务端判一次,前端不再逐卡拉 report)
  updateRunIndex(projectRoot, { id: runId, summary: extractRunSummaryLine(md), partial: /部分产物/.test(md || "") });
}

// Repository 缝隙守卫:task.json/report.md/events.jsonl 是 run 目录里被多处 routes/runtime 直读的
// 三种文件,统一收口在这里——调用方不再自己拼 ".opc/runs/<id>/..." 路径,直接 fs.readFileSync。
export function loadRunTask(projectRoot: string, runId: string): Run | null {
  return readJSON<Run | null>(path.join(projectRoot, OPC_DIR, "runs", runId, "task.json"), null);
}

// 令五.4 · 把 mission/taskGraph 关联加性写到 run 的 task.json(详情页反查任务图用)。
// 加性字段(missionId/taskGraphId),旧 run 不受影响;run 不存在(尚未 precreate)返回 null。
// 与 startRun 的 createRun 覆写无冲突:startRun 起跑时会先读回本字段再重写(见 orchestrator 磁盘合并)。
export function bindRunObservability(
  projectRoot: string,
  runId: string,
  ref: { missionId?: string; taskGraphId?: string },
): Run | null {
  const run = loadRunTask(projectRoot, runId);
  if (!run) return null;
  if (ref.missionId) run.missionId = ref.missionId;
  if (ref.taskGraphId) run.taskGraphId = ref.taskGraphId;
  saveRunTask(projectRoot, run);
  return run;
}

export function loadRunReport(projectRoot: string, runId: string): string | null {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "report.md");
  try { return fs.readFileSync(f, "utf-8"); } catch { return null; }
}

export function loadRunEventsRaw(projectRoot: string, runId: string): string | null {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "events.jsonl");
  try { return fs.readFileSync(f, "utf-8"); } catch { return null; }
}

export function appendWorkerStartupDiagnosticRecord(
  projectRoot: string,
  runId: string,
  diagnostic: WorkerStartupDiagnostic,
): void {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "worker-startup-diagnostics.jsonl"),
    JSON.stringify(diagnostic) + "\n",
    "utf-8",
  );
}

export function saveTrace(projectRoot: string, runId: string, events: TraceEvent[]) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  writeJSON(path.join(dir, "trace.json"), events);
}

export function saveCost(projectRoot: string, runId: string, records: unknown[]) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  writeJSON(path.join(dir, "cost.json"), records);
}

// Structured file changes produced by a run's accepted worker diffs (for DiffReviewPanel).
export function saveChanges(projectRoot: string, runId: string, changes: unknown[]) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  writeJSON(path.join(dir, "changes.json"), changes);
}

export function loadChanges(projectRoot: string, runId: string): unknown[] {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "changes.json");
  return readJSON<unknown[]>(f, []);
}

// Tasks deferred during a run (stuck → skipped → summarized), for the "待处理清单".
export function saveDeferred(projectRoot: string, runId: string, deferred: unknown[]) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  writeJSON(path.join(dir, "deferred.json"), deferred);
}

export function loadDeferred(projectRoot: string, runId: string): unknown[] {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "deferred.json");
  return readJSON<unknown[]>(f, []);
}

export function saveStructuredReport(projectRoot: string, runId: string, report: unknown) {
  const dir = path.join(projectRoot, OPC_DIR, "runs", runId);
  writeJSON(path.join(dir, "structured-report.json"), report);
}

export function loadStructuredReport(projectRoot: string, runId: string): unknown | null {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "structured-report.json");
  return readJSON<unknown | null>(f, null);
}

// A1-V2 · 记忆提案台账:run 结束后,本轮所有记忆提案(run_conclusion + 异步反思 lesson)与各自状态
// 落 run 目录 memory_proposals.json —— UI 审批/溯源用的磁盘证据文件(重构指南 §3.3 验收铁律)。
// 写法沿用本文件 run 目录惯例:writeJSON(原子写、显式 utf-8)。
export interface RunMemoryProposalRecord {
  proposalId: string;
  runId: string;
  source: "run_conclusion" | "reflection_lesson";
  kind?: string;               // lesson kind(failure_lesson / risk_warning / policy_candidate)
  scope?: string;
  type?: string;
  content: string;
  proposedBy?: string;
  role?: string;
  agentId?: string;
  confidence?: number;
  tags?: string[];
  sourceArtifactRefs?: string[]; // D2:关联 artifact id(溯源),审批入库时透传进 committed-memories.json
  taskType?: string;             // D2:任务类型(classifyTaskType),供 D1 检索侧 taskType 匹配过滤
  risk: "low" | "high";
  riskReasons?: string[];
  // pending(待人工审批) / approved(已批准) / committed(已入库生效) / rejected(人工拒绝) / revoked(撤销终态)
  status: string;
  statusHistory: Array<{ status: string; at?: string; by?: string }>;
  memoryId?: string;           // committed 后对应的 memoryId / lesson id
  createdAt: string;
  updatedAt: string;
}

export function loadMemoryProposals(projectRoot: string, runId: string): RunMemoryProposalRecord[] {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "memory_proposals.json");
  return readJSON<RunMemoryProposalRecord[]>(f, []);
}

// upsert 合并(按 proposalId 覆盖):异步反思 lesson 晚于 run 结束才提交,不能整文件互相覆盖。
export function upsertMemoryProposals(projectRoot: string, runId: string, records: RunMemoryProposalRecord[]) {
  const byId = new Map(loadMemoryProposals(projectRoot, runId).map((r) => [r.proposalId, r]));
  for (const r of records) byId.set(r.proposalId, r);
  writeJSON(path.join(projectRoot, OPC_DIR, "runs", runId, "memory_proposals.json"), Array.from(byId.values()));
}

// 人工批准的 run_conclusion 提案入库:追加进 committed-memories.json(committedMemoryRetriever 跨 run 检索直接可见)。
export function appendCommittedMemory(projectRoot: string, runId: string, entry: unknown) {
  const f = path.join(projectRoot, OPC_DIR, "runs", runId, "committed-memories.json");
  const arr = readJSON<unknown[]>(f, []);
  arr.push(entry);
  writeJSON(f, arr);
}

// Reports archive — team-based

export function goalToSlug(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .replace(/^-+|-+$/g, "")   // trim dashes BEFORE slicing so the cap doesn't leave a partial
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug || "report"; // empty goal (all stripped) must not produce "date_.md"
}

// First meaningful line as the report title, skipping a leading YAML front-matter (--- ... ---)
// block so the title isn't captured as a bare "---" fence.
export function extractReportTitle(content: string): string {
  const lines = content.split("\n");
  let i = 0;
  if (lines[i]?.trim() === "---") {
    i++;
    while (i < lines.length && lines[i].trim() !== "---") i++;
    i++; // skip closing fence
  }
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l || l === "---") continue;
    return l.replace(/^#+\s*/, "").trim().slice(0, 80);
  }
  return "";
}

function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function archiveReport(projectRoot: string, leadId: string, goal: string, md: string): string {
  const date = todayDate();
  const slug = goalToSlug(goal);
  const dir = path.join(projectRoot, OPC_DIR, "reports", leadId === "__cross-team" ? "__cross-team" : leadId);
  fs.mkdirSync(dir, { recursive: true });
  // Generic-slug goals all collapse to "report" — avoid same-day overwrite by suffixing.
  let filename = `${date}_${slug}.md`;
  if (slug === "report") {
    let n = 2;
    while (fs.existsSync(path.join(dir, filename))) { filename = `${date}_report-${n}.md`; n++; }
  }
  // MUP B7 · 团队归档报告与 run 级 report.md 同口径脱敏:leadSummary 合成文本可能带引擎错误体里的
  // 密钥(经 GET /api/reports/:teamId/:filename 原样回传)。storage 层收口,所有调用点一次覆盖。
  fs.writeFileSync(path.join(dir, filename), redactSecrets(md), "utf-8");

  syncReportMeta(projectRoot, leadId);

  return filename;
}

export function syncReportMeta(projectRoot: string, leadId: string) {
  if (leadId === "__cross-team") return;
  const reportsDir = path.join(projectRoot, OPC_DIR, "reports", leadId);
  if (!fs.existsSync(reportsDir)) return;

  const agents = loadAgents(projectRoot, []);
  const agent = agents.find(a => a.id === leadId);
  const metaPath = path.join(reportsDir, "_meta.json");
  const existing = fs.existsSync(metaPath) ? readJSON<any>(metaPath, {}) : {};

  const files = fs.readdirSync(reportsDir).filter(f => f.endsWith(".md"));
  const reports = files.map(f => {
    const content = fs.readFileSync(path.join(reportsDir, f), "utf-8");
    return {
      file: f,
      title: extractReportTitle(content),
      date: f.slice(0, 10),
      size: Buffer.byteLength(content, "utf-8"),
    };
  }).sort((a, b) => b.date.localeCompare(a.date));

  writeJSON(metaPath, {
    displayName: agent?.name || existing.displayName || leadId,
    leadId,
    reports,
  });
}

export function getReportsByTeam(projectRoot: string, leadId: string) {
  const reportsDir = path.join(projectRoot, OPC_DIR, "reports", leadId);
  if (!fs.existsSync(reportsDir)) return [];
  const metaPath = path.join(reportsDir, "_meta.json");
  if (fs.existsSync(metaPath)) {
    const meta = readJSON<any>(metaPath, {});
    const reports = meta.reports || [];
    // Heal legacy cached titles that captured a front-matter "---" fence (or empty) by rebuilding.
    if (leadId !== "__cross-team" && reports.some((r: any) => r.title === "---" || r.title === "")) {
      syncReportMeta(projectRoot, leadId);
      return readJSON<any>(metaPath, {}).reports || reports;
    }
    return reports;
  }
  const files = fs.readdirSync(reportsDir).filter(f => f.endsWith(".md"));
  return files.map(f => {
    try {
      const content = fs.readFileSync(path.join(reportsDir, f), "utf-8");
      return { file: f, title: extractReportTitle(content), date: f.slice(0, 10) };
    } catch {
      return { file: f, title: "", date: f.slice(0, 10) };
    }
  }).sort((a: any, b: any) => b.date.localeCompare(a.date));
}

export function getCrossTeamReports(projectRoot: string) {
  return getReportsByTeam(projectRoot, "__cross-team");
}

export function getAllReports(projectRoot: string) {
  const reportsDir = path.join(projectRoot, OPC_DIR, "reports");
  if (!fs.existsSync(reportsDir)) return { teams: {}, crossTeam: [] };

  const teams: Record<string, { name: string; reports: any[] }> = {};
  let crossTeam: any[] = [];

  for (const entry of fs.readdirSync(reportsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "__cross-team") {
      crossTeam = getCrossTeamReports(projectRoot);
      continue;
    }
    const metaPath = path.join(reportsDir, entry.name, "_meta.json");
    const meta = fs.existsSync(metaPath) ? readJSON<any>(metaPath, {}) : {};
    teams[entry.name] = {
      name: meta.displayName || entry.name,
      reports: meta.reports || getReportsByTeam(projectRoot, entry.name),
    };
  }

  return { teams, crossTeam };
}

export function getReportContent(projectRoot: string, teamId: string, filename: string): string | null {
  // P0#5 审计(实锤):teamId/filename 未清洗直接 path.join → `..%2F` 穿越可读任意本地文件(含 keys)。
  // 双防线:段内禁路径分隔/父目录引用 + resolve 后必须仍在 reports 根内。
  if (/[\\/]|\.\./.test(teamId) || /[\\/]|\.\./.test(filename)) return null;
  const reportsRoot = path.resolve(projectRoot, OPC_DIR, "reports");
  const filePath = path.resolve(reportsRoot, teamId, filename);
  if (!filePath.startsWith(reportsRoot + path.sep)) return null;
  if (!fs.existsSync(filePath)) return null;
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

// Update display name in _meta.json when an agent is renamed. syncReportMeta rebuilds the report
// list (and would derive displayName from the agent), so the explicit newName is applied AFTER it
// to guarantee the rename wins (previously newName was ignored — the meta never reflected it).
export function updateReportMetaName(projectRoot: string, leadId: string, newName: string) {
  if (leadId === "__cross-team") return;
  syncReportMeta(projectRoot, leadId);
  const dir = path.join(projectRoot, OPC_DIR, "reports", leadId);
  const metaPath = path.join(dir, "_meta.json");
  fs.mkdirSync(dir, { recursive: true });
  const meta = fs.existsSync(metaPath) ? readJSON<any>(metaPath, {}) : { leadId, reports: [] };
  meta.displayName = newName;
  writeJSON(metaPath, meta);
}

// ── Run 滚动索引(审计 P2#7)─────────────────────────────────────────────────────
// runs 目录已 117+/65MB,列表/台账每请求全目录扫描;且"任务档案"卡需要每 run 一句话摘要。
// 索引 = .opc/runs/_index.json(id → 摘要行),saveRunTask/saveRunReport 增量更新(writeJSON 原子写),
// 缺失/损坏时从全目录懒重建一次。单 run 约束下无并发写风险。
export interface RunIndexEntry {
  id: string; goal: string; status: string; degraded?: boolean; degradedReason?: string;
  startedAt: string; endedAt?: string; totalTokens?: number; totalCostUsd?: number | null;
  agents?: number; agentIds?: string[]; summary?: string; partial?: boolean;
  companyId?: string; // 公司作用域(旧 run 无此字段=归入"全部")
}
function runIndexFile(projectRoot: string): string {
  return path.join(projectRoot, OPC_DIR, "runs", "_index.json");
}
export function updateRunIndex(projectRoot: string, entry: Partial<RunIndexEntry> & { id: string }): void {
  // 战役B·Phase B2b:sqlite 时 runs 表是 run 列表/_index 的权威,_index.json 停写(留读兼容)。
  // 语义等价 _index 的合并写:①有 task.json → 真实 run 行(doc=task.json 权威,列由 COLUMN_PROJECTORS.runs
  //   投影;summary/partial 保留旧值,entry 显式提供则覆盖;indexOnly=0)。task.json 是 per-run 证据的权威,
  //   故重读它作 doc —— createRun/saveRunTask/legacyReclassify 都在调本函数前先写好 task.json,重读即取到最新。
  // ②无 task.json(纯索引条目,如历史/测试直接 updateRunIndex)→ 合并进 indexOnly=1 doc(与 _index 自由条目一致)。
  if (isSqliteBackend(projectRoot)) {
    try {
      const db = openBusinessDb(projectRoot);
      const run = loadRunTask(projectRoot, entry.id);
      if (run) {
        const prev = db.prepare("SELECT summary, partial FROM runs WHERE id = ?").get(entry.id) as
          { summary: unknown; partial: unknown } | undefined;
        const summary = entry.summary !== undefined ? entry.summary : (prev ? prev.summary : null);
        const partial = entry.partial !== undefined ? entry.partial : (prev ? prev.partial : null);
        upsertDoc(db, "runs", (run as Run).id, run, {
          ...columnsFor("runs", run as unknown as Record<string, unknown>),
          summary, partial, indexOnly: 0,
        });
      } else {
        const prevRow = db.prepare("SELECT doc FROM runs WHERE id = ?").get(entry.id) as { doc: string } | undefined;
        const base = prevRow
          ? (JSON.parse(prevRow.doc) as Record<string, unknown>)
          : { goal: "", startedAt: "", status: "running" };
        const merged = { ...base, ...entry } as Record<string, unknown>;
        upsertDoc(db, "runs", entry.id, merged, {
          ...columnsFor("runs", merged),
          summary: merged.summary, partial: merged.partial, indexOnly: 1,
        });
      }
    } catch { /* best-effort:索引失败不影响 run */ }
    return;
  }
  try {
    const f = runIndexFile(projectRoot);
    const idx = readJSON<Record<string, RunIndexEntry>>(f, {});
    idx[entry.id] = { ...(idx[entry.id] ?? { goal: "", startedAt: "", status: "running" }), ...entry } as RunIndexEntry;
    writeJSON(f, idx);
  } catch { /* best-effort:索引失败不影响 run */ }
}
function runToIndexEntry(run: Run): RunIndexEntry {
  return {
    id: run.id, goal: (run.userGoal || "").slice(0, 200), status: run.status,
    degraded: run.degraded, degradedReason: run.degradedReason?.slice(0, 160),
    startedAt: run.startedAt, endedAt: run.endedAt,
    totalTokens: run.totalTokens, totalCostUsd: run.totalCostUsd,
    agents: run.participatingAgents?.length ?? 0,
    agentIds: [...new Set(run.participatingAgents ?? [])].slice(0, 6), // 任务卡头像组(前 6 个去重)
    companyId: run.companyId,
  };
}
// 提取报告的一句话摘要:剥降级横幅/标题/空行/代码块,取首个实质段落的前 140 字。
export function extractRunSummaryLine(md: string): string {
  let inFence = false;
  for (const raw of (md || "").split("\n")) {
    const l = raw.trim();
    if (l.startsWith("```")) { inFence = !inFence; continue; } // 活体验证抓出:报告以代码围栏开头时曾把 ```python 的语言标记当首段
    if (inFence) continue;
    if (!l || l.startsWith(">") || l.startsWith("#") || l.startsWith("---") || l.startsWith("|")) continue;
    return l.replace(/[*_`]/g, "").slice(0, 140);
  }
  return "";
}
// 战役B·Phase B2b:runs 表一行 → RunIndexEntry。与迁移器 extractRuns / sqliteToJson.deriveIndexEntry
// 口径统一 —— indexOnly=1 行 doc 本身即 _index 条目原样返回;indexOnly=0 行 doc 是 task.json,索引项由
// runToIndexEntry(doc)(单一事实源)派生,summary/partial 从(来自 report.md 的)列带回。JSON 往返归一化:
// task doc 缺失字段(如 endedAt)被 runToIndexEntry 写成 undefined,round-trip 剔除,与 _index.json 读回一致。
function runsRowToIndexEntry(row: { indexOnly: number; summary: unknown; partial: unknown; doc: string }): RunIndexEntry {
  const doc = JSON.parse(row.doc) as Record<string, unknown>;
  let entry: RunIndexEntry;
  if (row.indexOnly) {
    entry = doc as unknown as RunIndexEntry;
  } else {
    entry = runToIndexEntry(doc as unknown as Run);
    if (row.summary !== null && row.summary !== undefined) entry.summary = row.summary as string;
    if (row.partial !== null && row.partial !== undefined) entry.partial = row.partial !== 0;
  }
  return JSON.parse(JSON.stringify(entry)) as RunIndexEntry;
}

// sqlite 懒重建(镜像 json 侧:runs 表空但盘上有 task.json 目录时,从 task.json 全量重建一次)。
// 正常路径(表已由迁移/双写填充)COUNT>0 直接跳过;仅表空时扫目录,与 json 懒重建触发条件一致。
function lazyRebuildRunsTable(projectRoot: string, db: ReturnType<typeof openBusinessDb>): void {
  const runsDir = path.join(projectRoot, OPC_DIR, "runs");
  try {
    for (const d of fs.readdirSync(runsDir)) {
      if (d.startsWith("_")) continue;
      const t = readJSON<Run | null>(path.join(runsDir, d, "task.json"), null);
      if (!t || !t.id) continue;
      let summary: string | null = null;
      let partial: number | null = null;
      try {
        const rpt = fs.readFileSync(path.join(runsDir, d, "report.md"), "utf-8");
        summary = extractRunSummaryLine(rpt);
        partial = /部分产物/.test(rpt) ? 1 : 0;
      } catch { /* 无报告 */ }
      upsertDoc(db, "runs", t.id, t, {
        ...columnsFor("runs", t as unknown as Record<string, unknown>),
        summary, partial, indexOnly: 0,
      });
    }
  } catch { /* runs 目录缺失等 */ }
}

export function loadRunIndex(projectRoot: string): RunIndexEntry[] {
  if (isSqliteBackend(projectRoot)) {
    const db = openBusinessDb(projectRoot);
    const q = () => db.prepare("SELECT indexOnly, summary, partial, doc FROM runs ORDER BY rowid")
      .all() as Array<{ indexOnly: number; summary: unknown; partial: unknown; doc: string }>;
    let rows = q();
    if (rows.length === 0) { lazyRebuildRunsTable(projectRoot, db); rows = q(); }
    return rows.map(runsRowToIndexEntry).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  }
  const f = runIndexFile(projectRoot);
  let idx = readJSON<Record<string, RunIndexEntry>>(f, {});
  if (!idx || Object.keys(idx).length === 0) {
    // 懒重建:全目录扫一次(与旧行为等价的一次性成本),之后走增量。
    idx = {};
    const runsDir = path.join(projectRoot, OPC_DIR, "runs");
    try {
      for (const d of fs.readdirSync(runsDir)) {
        if (d.startsWith("_")) continue;
        const t = readJSON<Run | null>(path.join(runsDir, d, "task.json"), null);
        if (!t || !t.id) continue;
        idx[t.id] = runToIndexEntry(t);
        try {
          const rpt = fs.readFileSync(path.join(runsDir, d, "report.md"), "utf-8");
          idx[t.id].summary = extractRunSummaryLine(rpt);
          idx[t.id].partial = /部分产物/.test(rpt);
        } catch { /* 无报告 */ }
      }
      if (Object.keys(idx).length > 0) writeJSON(f, idx);
    } catch { /* runs 目录缺失等 */ }
  }
  return Object.values(idx).sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
}
