// Layer E · RunCritic / MemoryManager —— 失败触发的反思。读 run 的失败信号,让一个便宜模型提炼**结构化候选**。
// 本模块只提炼、不持久化；Core 必须等 run 证据定稿后再把候选交给 memoryGovernance。
// 关键:不复用出问题的 Lead 自审(易自我合理化);证据/角色/失败模式一律用**真实信号**填,不信模型自报(防幻觉)。
import type { FailureMode } from "../storage/reflectionStore.js";
import type { LayeredMemoryScope } from "../storage/layeredMemory.js";
import { redactSecrets } from "../security/redact.js";
import { goalForbidsCode } from "./deliveryAcceptance.js";

export interface ReflectionSignal {
  agentId: string;
  role: string;
  teamId?: string;     // 该失败 agent 自己的 lead(多-lead run 里教训要绑对团队)
  companyId?: string;  // 该失败 agent 所属公司(跨公司硬隔离)
  failureMode: FailureMode;
  detail: string;
  metrics?: { timeoutMs?: number; attempts?: number };
}

export interface DeferredLike { agentId: string; reason: string; attempts?: number; lastError?: string; goal?: string }

export interface ReflectionMemoryCandidate {
  title: string;
  summary: string;
  text: string;
  objectType: "failure_lesson";
  scope: LayeredMemoryScope;
  scopeId: string;
  sourceType: "run";
  sourceRunId: string;
  autoApprove: false;
  rootCauseConfirmed: false;
  evidenceIds: string[];
  counterexamples: string[];
  antiPattern?: string;
  origin: {
    agentId: string;
    role: string;
    teamId?: string;
    companyId?: string;
    taskType: string;
    failureMode: FailureMode;
    metrics?: ReflectionSignal["metrics"];
  };
}

// 从 run 收尾数据收集失败信号。无信号 → 空 → 不触发反思(省 token)。
export function collectReflectionSignals(input: {
  deferred: DeferredLike[];
  degraded?: boolean;
  degradedReason?: string;
  roleOf: (agentId: string) => string | undefined;
  teamIdOf?: (agentId: string) => string | undefined;      // 该 agent 自己的 lead id
  companyIdOf?: (agentId: string) => string | undefined;   // 该 agent 所属公司(教训按公司硬隔离)
  dropUnresolvedRole?: boolean;                            // backfill:解析不到真实角色就**跳过**该信号,不误归成 worker
}): ReflectionSignal[] {
  const out: ReflectionSignal[] = [];
  for (const d of input.deferred || []) {
    const resolvedRole = input.roleOf(d.agentId);
    if (!resolvedRole && input.dropUnresolvedRole) continue; // 防历史 run 里已删/不在册的 agent 被塌缩成 "worker" 错投
    const tMs = /after (\d+)\s*ms/i.exec(d.lastError || "")?.[1]; // 从原文提 timeoutMs(数字不含密钥)
    out.push({
      agentId: d.agentId,
      role: (resolvedRole || "worker").toLowerCase(),
      teamId: input.teamIdOf?.(d.agentId),
      companyId: input.companyIdOf?.(d.agentId),
      failureMode: normalizeFailureMode(d.reason),
      // 脱敏:lastError/detail 可能含引擎 stderr / API 错误体(带 key 片段)。这段会进 critic prompt(发给外部模型)
      // 且可能落盘 lessons.jsonl,故必须先 redactSecrets(与 events.jsonl / 分享流一致的边界)。
      detail: redactSecrets(d.lastError || d.reason),
      metrics: { timeoutMs: tMs ? Number(tMs) : undefined, attempts: d.attempts },
    });
  }
  if (input.degraded) {
    out.push({ agentId: "lead", role: "lead", failureMode: "degraded", detail: redactSecrets(input.degradedReason || "run degraded") });
  }
  return out;
}

function normalizeFailureMode(reason: string): FailureMode {
  const r = (reason || "").toLowerCase();
  if (r.includes("timeout")) return "timeout";
  if (r.includes("degrad")) return "degraded";
  if (r.includes("quality")) return "quality_gate_failed";
  if (r.includes("verif")) return "verifier_reject";
  if (r.includes("reject")) return "artifact_rejected";
  if (r.includes("quota")) return "quota_exceeded";
  if (r.includes("rate")) return "rate_limited";
  if (r.includes("account")) return "no_account";
  if (r.includes("provider") || r.includes("unavailable") || r.includes("restricted")) return "provider_unavailable";
  return "retry_budget_exhausted";
}

// 粗粒度任务类型:commit 与检索用**同一个函数** → 保证未来相似任务能匹配到这条教训。
export function classifyTaskType(goal: string): string {
  const g = (goal || "").toLowerCase();
  // 单一事实源:目标显式声明不要代码 → 永远不判 coding(否则"不要编写代码"里的"代码"会命中下面的 coding 正则,
  // 误报 team_mismatch"看起来是工程实现")。优先于关键词,与 taskRequiresCode/orchestrator 同用 goalForbidsCode。
  if (goalForbidsCode(goal)) return "research_report";
  if (/核查|事实|fact.?check|verif/.test(g)) return "fact_check";
  if (/代码|实现|函数|python|写一个|脚本|重构|\bcode\b|refactor|\bbug\b/.test(g)) return "coding";
  if (/对比|报告|研究|分析|综述|report|research|analy/.test(g)) return "research_report";
  if (/检索|搜索|查找|search|scrape|抓取/.test(g)) return "web_research";
  return "general";
}

const CRITIC_SYSTEM = `你是 OPC 的 RunCritic(记忆管理员)。一次多智能体任务里有员工失败了(超时/降级/被拒/质量门未过)。
你的唯一职责:从**这些失败**里提炼**可执行的结构化教训**,让同岗位的员工下次别再犯同样的错。

严格要求:
- 只针对失败信号里出现的角色。每个失败角色最多一条教训。
- 教训必须**具体、可执行**——说清"下次该怎么做"。禁止"要更认真/要严谨/注意时间"这类空泛口号。
- 禁止复述最终报告内容。你产出的是"怎么改进工作方式",不是"这次的答案是什么"。
- promptText 用祈使句、面向该角色下一次任务的一句话约束(可中文),形如"上次…超时,这次改成…"。

只输出一个 JSON 数组(不要任何解释文字、不要 markdown 代码围栏),每个元素:
{"role":"该失败角色(小写,如 test/lead/dev)","conditionText":"什么情况下会触发(一句话)","diagnosis":"根因(一句话)","lesson":"学到的通用教训(一句话)","recommendedChange":"下次具体怎么做(可执行,如拆子任务/减少检索条数/提前写partial/调小批量)","antiPattern":"明确禁止重复的做法(一句话,可选)","promptText":"注入给该角色的一句话约束","confidence":0.6}`;

function buildCriticUser(goal: string, taskType: string, signals: ReflectionSignal[]): string {
  const lines = signals.map((s) => `- 角色 ${s.role}(agent ${s.agentId}):失败模式=${s.failureMode};细节="${s.detail}"${s.metrics?.timeoutMs ? `;超时 ${s.metrics.timeoutMs}ms` : ""}${s.metrics?.attempts ? `;尝试 ${s.metrics.attempts} 次` : ""}`).join("\n");
  return `任务目标: "${goal}"\n任务类型: ${taskType}\n\n本次失败信号:\n${lines}\n\n请据此提炼结构化教训(JSON 数组)。`;
}

// 从模型输出里稳健地抠出 JSON(容忍 ```json 围栏 / 前后废话 / 单对象 / 字段里含方括号)。
export function parseLessonProposals(text: string): Array<Record<string, any>> {
  if (!text) return [];
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
  // 先直接整串 parse(容单对象,避免字段里的 [] 误导切片);失败再回退到括号切片。
  let j = tryParse(t);
  if (j === undefined) {
    const start = t.indexOf("["), end = t.lastIndexOf("]");
    if (start >= 0 && end > start) j = tryParse(t.slice(start, end + 1));
  }
  if (j === undefined) return [];
  const arr = Array.isArray(j) ? j : [j];
  return arr.filter((x): x is Record<string, any> => !!x && typeof x === "object");
}

// 失败反思主流程。callModel 由 orchestrator 注入(便宜模型)。输出只是治理候选，绝不直接写长期记忆。
export async function reflectOnRun(input: {
  projectRoot: string;
  runId: string;
  goal: string;
  companyId?: string;
  teamId?: string;
  signals: ReflectionSignal[];
  callModel: (systemPrompt: string, userPrompt: string) => Promise<string>;
  nowIso: string;
  log?: (msg: string) => void;
  emitEvent?: (type: string, payload: unknown) => void;
  /** @deprecated Persistence is governed after evidence finalization; retained only for call-site compatibility. */
  runOutcome?: "clean_verified" | "failed_or_degraded";
}): Promise<ReflectionMemoryCandidate[]> {
  if (!input.signals.length) return [];
  const emit = input.emitEvent ?? (() => {});
  const taskType = classifyTaskType(input.goal);
  let text = "";
  try { text = await input.callModel(CRITIC_SYSTEM, buildCriticUser(input.goal, taskType, input.signals)); }
  catch { return []; } // 反思调用失败 → 静默
  const proposals = parseLessonProposals(text);
  emit("lesson_proposed", { runId: input.runId, count: proposals.length, signals: input.signals.length });
  const candidates: ReflectionMemoryCandidate[] = [];
  for (const p of proposals) {
    const role = String(p.role || "").toLowerCase();
    // provenance 锚死真实信号:scope.role/failureMode/agentId/metrics 全取自**同一条真实失败信号**,绝不用模型自选的角色。
    let sig = input.signals.find((s) => s.role === role);
    if (!sig) {
      // 模型自报 role 没匹配到任何真实失败信号:
      //  · 只有 1 个失败信号 → 用它(模型可能只是换了说法;单一失败无歧义,且绝不会落到没失败的角色)
      //  · 多个失败信号 → 无法安全归属 → 丢弃(既防张冠李戴,也防把教训投毒到没失败的角色如 ceo)
      if (input.signals.length === 1) sig = input.signals[0];
      else continue;
    }
    const diagnosis = String(p.diagnosis || sig.detail).replace(/\s+/g, " ").trim().slice(0, 300);
    const lesson = String(p.lesson || p.recommendedChange || "").replace(/\s+/g, " ").trim().slice(0, 300);
    const recommendedChange = String(p.recommendedChange || p.promptText || lesson).replace(/\s+/g, " ").trim().slice(0, 400);
    const vague = /^(要|需|请)?(更)?(认真|仔细|注意|小心|改进|优化|做好|重试)(一点|些)?[。.!！]?$/.test(lesson)
      || /^(认真|注意|小心|重试)(点|一下)?[。.!！]?$/.test(recommendedChange);
    if (!lesson || !recommendedChange || lesson.length < 6 || recommendedChange.length < 8 || vague) continue;
    const antiPattern = p.antiPattern ? String(p.antiPattern).replace(/\s+/g, " ").trim().slice(0, 300) : "";
    const scope: LayeredMemoryScope = sig.teamId ?? input.teamId ? "team" : sig.companyId ?? input.companyId ? "company" : "agent";
    const scopeId = scope === "team"
      ? (sig.teamId ?? input.teamId)!
      : scope === "company" ? (sig.companyId ?? input.companyId)! : sig.agentId;
    const content = [
      `触发条件：${String(p.conditionText || sig.detail).slice(0, 300)}`,
      `诊断：${diagnosis}`,
      `教训：${lesson}`,
      `建议：${recommendedChange}`,
      ...(antiPattern ? [`反模式：${antiPattern}`] : []),
      `适用角色：${sig.role}；任务类型：${taskType}`,
    ].join("\n");
    candidates.push({
      title: `${sig.failureMode} · ${sig.role}`,
      summary: lesson.slice(0, 180),
      text: content,
      objectType: "failure_lesson",
      scope,
      scopeId,
      sourceType: "run",
      sourceRunId: input.runId,
      autoApprove: false,
      rootCauseConfirmed: false,
      evidenceIds: [input.runId],
      counterexamples: ["若当前状态已改变、失败未复现或存在更直接证据，则不要套用本教训。"],
      ...(antiPattern ? { antiPattern } : {}),
      origin: {
        agentId: sig.agentId,
        role: sig.role,
        teamId: sig.teamId ?? input.teamId,
        companyId: sig.companyId ?? input.companyId,
        taskType,
        failureMode: sig.failureMode,
        metrics: sig.metrics,
      },
    });
  }
  emit("lesson_candidates_extracted", { runId: input.runId, count: candidates.length });
  input.log?.(`reflection: ${candidates.length}/${proposals.length} governed candidate(s) extracted from ${input.signals.length} signal(s)`);
  return candidates;
}

// 直连 deepseek 的一次性对话(反思/摘要共用)。不走 runViaEngine → 不碰模块级 run 计数/事件,隔离并发 run。best-effort。
export async function deepseekChat(apiKey: string, systemPrompt: string, userPrompt: string, maxTokens = 1200): Promise<string> {
  const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], temperature: 0.3, max_tokens: maxTokens }),
    signal: AbortSignal.timeout(30000), // 显式 30s 超时,防 backfill/反思调用挂死
  });
  if (!resp.ok) return "";
  const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content || "";
}

const SUMMARIZE_SYSTEM = `你是 OPC 的记忆管理员。把一次任务的最终交付物压成 **3-8 条结构化结论要点**,供未来相似任务快速复用——提炼关键结论/决策/数据/坑,**不是复述全文**。
只输出一个 JSON 字符串数组(不要任何解释、不要 markdown 围栏),每条一句话、具体、可复用。`;

// 从最终报告提炼结论要点(字符串数组)。best-effort:失败/畸形返回空。
export async function summarizeConclusion(input: { goal: string; reportMd: string; callModel: (sys: string, user: string) => Promise<string> }): Promise<string[]> {
  let text = "";
  try { text = await input.callModel(SUMMARIZE_SYSTEM, `任务目标: "${input.goal}"\n\n最终交付物(节选):\n${input.reportMd.slice(0, 4000)}\n\n请提炼 3-8 条结论要点(JSON 字符串数组)。`); }
  catch { return []; }
  let t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t); if (fence) t = fence[1].trim();
  const s = t.indexOf("["), e = t.lastIndexOf("]");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  let arr: unknown; try { arr = JSON.parse(t); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  // 类型守卫:只保留字符串项(防对象被 String() 成 "[object Object]" 落盘/注入),对齐 parseLessonProposals。
  return arr.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean).slice(0, 8);
}
