// E4/D2 memory-loop helper — extract a *structured* run conclusion from run results to commit as
// a cross-run memory entry.
//
// Design constraints (铁律):
//   - NEVER throws. On any error returns an empty RunConclusion (text="", empty arrays) so callers
//     can safely gate on `conclusion.text.length > 0`.
//   - No I/O; purely functional over the strings already in memory.
//   - Called by orchestrator AFTER md is generated, so both leadResults and md are available.
//
// D2 rewrite: 替代旧的「前缀 1200 字硬截断」。改为解析 md/leadResults 的结构信号(标题/列表行)提炼
// 要点,由 deferred/degradedReason 派生教训,再渲染成「要点/教训/复用条件」三节 markdown。
// 词中断绝迹:每条要点在词边界(latin)或字边界(CJK)裁到 ≤160 字,不再从整段中间硬切。

const MAX_POINTS = 6;
const MAX_POINT_CHARS = 160;
const MIN_SUBSTANCE_CHARS = 120; // below this a "result" is treated as a stub (source selection)

export interface RunConclusion {
  points: string[];          // ≤6 条结构化要点,各 ≤160 字
  lessons: string[];         // 由 deferred / degradedReason 派生的教训
  reuseConditions: string[]; // [taskType?, companyId?, "非降级 run"] 复用前提
  text: string;             // 渲染后的三节 markdown(供 committed-memory content;空实质 → "")
}

export interface ConclusionExtras {
  deferred?: Array<{ reason?: string; goal?: string; agentId?: string }>;
  degradedReason?: string;
  taskType?: string;
  companyId?: string;
}

export interface CodingConclusionEvidence {
  requiresCode: boolean;
  deliveryStatus?: string;
  runStatus?: string;
  files?: string[];
  tests?: Array<{ command?: string; exitCode?: number; passed?: boolean; testedFile?: string }>;
}

// Coding memories must be sourced from Core-owned structured evidence. Model prose may be useful
// for a report, but it cannot override file hashes, exit codes, or the delivery acceptance state.
export function buildAuthoritativeCodingConclusionSource(input: CodingConclusionEvidence): string {
  if (!input.requiresCode) return "";
  const files = [...new Set((input.files ?? []).filter(Boolean))];
  const tests = input.tests ?? [];
  const lines = [
    "# Core delivery evidence",
    "This conclusion source is generated from Core-owned structured evidence, not model self-reporting.",
    `- Delivery acceptance: ${input.deliveryStatus ?? "unknown"}`,
    `- Run status: ${input.runStatus ?? "unknown"}`,
    files.length > 0 ? `- Delivered files: ${files.join(", ")}` : "- Delivered files: none",
  ];
  if (tests.length === 0) lines.push("- Test evidence: none");
  for (const test of tests) {
    lines.push(`- Test evidence: ${test.testedFile ?? test.command ?? "unknown"}; exit=${test.exitCode ?? "unknown"}; passed=${test.passed === true}`);
  }
  return lines.join("\n");
}

const EMPTY: RunConclusion = { points: [], lessons: [], reuseConditions: [], text: "" };

// 词边界裁剪:latin 文本裁到 max 前最后一个空格(避免切断单词);CJK 无空格 → 按字硬裁(每字独立单位)。
function clampLen(raw: string, max: number): string {
  const t = raw.trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  if (lastSpace >= max * 0.6) return slice.slice(0, lastSpace).trim();
  return slice.trim();
}

// 去掉行内 markdown 强调/代码/残留标题号,折叠空白 → 干净要点文本。
function cleanInline(s: string): string {
  return s
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)、]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LIST_RE = /^\s*(?:[-*+]|\d+[.)、])\s+(.+)$/;
const HEAD_RE = /^#{1,6}\s+(.+)$/;

// 结构信号优先:列表行 > 标题行 > 句子兜底。跳过 banner(blockquote `>` / HTML `<...`)。
function extractPoints(normalised: string): string[] {
  if (!normalised) return [];
  const lines = normalised.split("\n").map((l) => l.replace(/\r$/, ""));
  const listItems: string[] = [];
  const headings: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith(">") || trimmed.startsWith("<")) continue; // 降级 banner / HTML 不当要点
    const lm = LIST_RE.exec(line);
    if (lm) { const c = cleanInline(lm[1]); if (c.length >= 3) listItems.push(clampLen(c, MAX_POINT_CHARS)); continue; }
    const hm = HEAD_RE.exec(trimmed);
    if (hm) { const c = cleanInline(hm[1]); if (c.length >= 3) headings.push(clampLen(c, MAX_POINT_CHARS)); }
  }
  let picked = listItems.length > 0 ? listItems : headings;
  if (picked.length === 0) {
    // 句子兜底:无结构信号时按句读切,取前几句实质内容。
    const body = lines.filter((l) => { const t = l.trim(); return t && !t.startsWith(">") && !t.startsWith("<"); }).join(" ");
    picked = body
      .split(/(?<=[。！？!?])\s*|\n+/)
      .map((s) => clampLen(cleanInline(s), MAX_POINT_CHARS))
      .filter((s) => s.length >= 8);
  }
  // 去重(大小写不敏感)+ 截 6 条。
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of picked) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_POINTS) break;
  }
  return out;
}

// 教训:降级原因 + 每条 deferred(未完成任务)派生一条,各 ≤160 字,去重截 6。
function deriveLessons(extras?: ConclusionExtras): string[] {
  const out: string[] = [];
  if (extras?.degradedReason && extras.degradedReason.trim()) {
    out.push(clampLen(`本 run 降级:${extras.degradedReason.trim()}`, MAX_POINT_CHARS));
  }
  for (const d of extras?.deferred ?? []) {
    const who = d.agentId ? `${d.agentId} ` : "";
    const g = d.goal ? `「${d.goal.slice(0, 40)}」` : "";
    const reason = d.reason ? `(${d.reason})` : "";
    const line = `未完成:${who}${g}${reason}`.replace(/\s+/g, " ").trim();
    if (line.length > "未完成:".length) out.push(clampLen(line, MAX_POINT_CHARS));
    if (out.length >= MAX_POINTS) break;
  }
  return [...new Set(out)].slice(0, MAX_POINTS);
}

// 复用条件:[taskType?, companyId?, "非降级 run"]。原值入文本以供检索侧关键词匹配。
function deriveReuseConditions(extras?: ConclusionExtras): string[] {
  const out: string[] = [];
  if (extras?.taskType && extras.taskType.trim()) out.push(`任务类型:${extras.taskType.trim()}`);
  if (extras?.companyId && extras.companyId.trim()) out.push(`公司:${extras.companyId.trim()}`);
  out.push("仅在非降级 run 复用");
  return out;
}

function renderText(goal: string, points: string[], lessons: string[], reuse: string[]): string {
  const parts: string[] = [`[目标: ${goal.slice(0, 80)}]`];
  if (points.length) parts.push("## 要点\n" + points.map((p) => `- ${p}`).join("\n"));
  if (lessons.length) parts.push("## 教训\n" + lessons.map((l) => `- ${l}`).join("\n"));
  if (reuse.length) parts.push("## 复用条件\n" + reuse.map((r) => `- ${r}`).join("\n"));
  return parts.join("\n\n");
}

/**
 * Extracts a structured run conclusion for canonical memory commit.
 * Returns an empty RunConclusion (text="") when no substantive points can be extracted,
 * so callers keep gating on `conclusion.text.length > 0` exactly as before.
 */
export function extractStructuredConclusion(
  goal: string,
  leadResults: string[],
  md: string,
  extras?: ConclusionExtras,
): RunConclusion {
  try {
    const bestLead = (leadResults ?? []).find((r) => (r ?? "").trim().length >= MIN_SUBSTANCE_CHARS) ?? "";
    const source = bestLead.trim().length >= MIN_SUBSTANCE_CHARS ? bestLead : (md ?? "");
    const normalised = source.replace(/\0/g, "").replace(/\n{3,}/g, "\n\n").trim();

    const points = extractPoints(normalised);
    // 无任何实质要点 → 视为无可沉淀内容(与旧 extractRunConclusion 返回 "" 对齐)。
    if (points.length === 0) return { ...EMPTY };

    const lessons = deriveLessons(extras);
    const reuseConditions = deriveReuseConditions(extras);
    const text = renderText(goal, points, lessons, reuseConditions);
    return { points, lessons, reuseConditions, text };
  } catch {
    return { ...EMPTY };
  }
}

/**
 * Backward-compatible wrapper: returns just the rendered conclusion text ("" when empty).
 * The sole in-tree caller (orchestrator) uses extractStructuredConclusion directly; this remains
 * for any legacy/test callers that expect a plain string.
 */
export function extractRunConclusion(goal: string, leadResults: string[], md: string): string {
  return extractStructuredConclusion(goal, leadResults, md).text;
}

// ── D2 · 「降级 run 不沉淀干净经验」门控谓词(纯函数,供 orchestrator 与单测共用) ──────────
// 干净经验(plan_template 落库 / procedural_skill 挖掘)只在 run 未降级、且无 ACP→legacy CLI 降级信号时沉淀。
export function shouldPersistCleanExperience(
  run: { degraded?: boolean },
  executorDegradedSignal: boolean,
): boolean {
  return run.degraded !== true && executorDegradedSignal !== true;
}

// run_conclusion 是否自动 commit:非高风险 + run 未降级/未 executor 降级 + 自动 commit 开关开启。
// 任一不满足 → 停 pending(仍落 memory_proposals.json 台账,只是不写 committed-memories.json)。
export function shouldAutoCommitRunConclusion(opts: {
  highRisk: boolean;
  degraded: boolean;
  executorDegraded: boolean;
  autoCommitEnabled: boolean;
}): boolean {
  return !opts.highRisk && !opts.degraded && !opts.executorDegraded && opts.autoCommitEnabled;
}
export type RunConclusionDisposition = "auto_commit" | "review" | "archive";

// 人工审核队列分流:只有可信成功交付的高风险结论(或用户显式选择“全部人工审核”)进入待办；
// 失败、降级、部分交付、冻结指纹失配只保留 rejected 台账，避免一次失败制造一个永久待办。
export function decideRunConclusionDisposition(opts: {
  deliveryVerified: boolean;
  partial: boolean;
  subsetOk: boolean;
  highRisk: boolean;
  degraded: boolean;
  executorDegraded: boolean;
  autoCommitEnabled: boolean;
}): RunConclusionDisposition {
  const trustworthy = opts.deliveryVerified && !opts.partial && opts.subsetOk && !opts.degraded && !opts.executorDegraded;
  if (!trustworthy) return "archive";
  if (shouldAutoCommitRunConclusion(opts)) return "auto_commit";
  return "review";
}