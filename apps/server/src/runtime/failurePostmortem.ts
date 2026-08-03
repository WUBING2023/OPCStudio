// Track C · C1 失败复盘卡 —— buildPostmortem(runId) 纯派生。
// 输入:run 结束时已落盘的证据文件(task.json / failure-report.json / run-summary.json / deferred.json),
// 输出:结构化复盘对象(原因清单/系统建议/可执行操作)。技术错误翻译成用户可行动的话——
// 验收样例:DeepSeek API Key 未配置 → causes 点名 provider,suggestions 给「配置 Key」「切换模型」两条。
// 全程 best-effort:文件缺失/损坏按"无该信号"处理,绝不抛(同 runHistoryStore.ts 模式)。
import * as fs from "node:fs";
import * as path from "node:path";
import type { DeferredTask, Run } from "@opc/shared";
import type { FailureReport } from "./runHistory.js";
import type { RunSummaryState } from "../storage/runHistoryStore.js";
import { redactSecrets } from "../security/redact.js";

export type PostmortemCauseKind =
  | "provider_key"          // 供应商 API Key 未配置/无效(最高优先:用户一步可修)
  | "provider_unavailable"  // 供应商/框架不可用(非 key 明因)
  | "no_account"            // 无可用账号(调度超时)
  | "timeout"               // worker 硬超时
  | "quality_gate_failed"   // 质量门/工件契约未过
  | "budget_exhausted"      // 重试/run 预算耗尽
  | "artifact_rejected"     // 产物未通过验收(artifact 缺失/被拒)
  | "degraded"              // 最终交付降级
  | "run_failed";           // run 整体 failed 且无更具体信号(兜底)

export interface PostmortemCause {
  kind: PostmortemCauseKind;
  message: string;    // 用户可行动的人话(点名 provider/员工/产物;中文原文,前端无词典键时的回退)
  evidence?: string;  // 原始错误摘录(已脱敏,≤200 字)
  // #32 · 结构化 i18n:messageKey 是前端 postmortem.cause.* 的词典子键(kind 不够用——provider_key
  // 有两种文案),params 是插值参数。前端拿不到就回退 message 原文(旧数据/旧服务端兼容)。
  messageKey?: string;
  params?: Record<string, string>;
}

export type PostmortemActionId = "retry" | "replan" | "save_lesson" | "view_logs";
export interface PostmortemAction { id: PostmortemActionId; label: string }

// #32 · 建议的结构化形态:key 是前端 postmortem.suggestion.* 的词典子键,text 是中文原文回退。
export interface PostmortemSuggestionItem { key: string; params?: Record<string, string>; text: string }

export interface Postmortem {
  runId: string;
  available: boolean;   // false = 成功且无失败信号,前端不弹卡
  title: string;
  goal?: string;        // 原 run 目标(前端「重试/重拆」直接复用,免二次 fetch)
  companyId?: string;
  causes: PostmortemCause[];
  suggestions: string[];               // 中文原文(旧前端/兜底消费不变)
  suggestionItems?: PostmortemSuggestionItem[]; // 与 suggestions 同序同长,前端优先按词典键渲染
  actions: PostmortemAction[];
}

// derivePostmortem 的输入——全部可缺省(证据文件可能只落了一部分)。
export interface PostmortemInput {
  runId: string;
  task?: (Partial<Run> & Record<string, unknown>) | null;
  failureReport?: Partial<FailureReport> | null;
  runSummary?: Partial<RunSummaryState> | null;
  deferred?: DeferredTask[] | null;
  /** agentId → 展示名(路由层可注入 getAgents() 映射;解析不到就用 agentId 原文) */
  nameOf?: (agentId: string) => string | undefined;
}

// 已知 provider 及展示名(检测 lastError 文本用;顺序即匹配优先级)。
const PROVIDER_DISPLAY: Array<[string, string]> = [
  ["deepseek", "DeepSeek"],
  ["openrouter", "OpenRouter"],
  ["openai", "OpenAI"],
  ["anthropic", "Anthropic"],
  ["ollama", "Ollama"],
  ["minimax", "MiniMax"],
  ["doubao", "Doubao"],
];

// key 类错误标志:modelGateway 的 "missing API key"、HTTP 401/unauthorized、invalid api key、中文「未配置」。
const KEY_ERROR_RE = /missing\s+api\s*key|api[_\s-]?key|unauthorized|\b401\b|invalid[_\s-]?key|未配置|无效.{0,4}key/i;
// provider 类错误标志(ProviderUnavailableError 的固定文案前缀等)。
const PROVIDER_ERROR_RE = /provider\s+unavailable|framework\s+unavailable|no handler registered|供应商|不可用/i;

function detectProvider(text: string): string | undefined {
  const t = (text || "").toLowerCase();
  const hit = PROVIDER_DISPLAY.find(([id]) => t.includes(id));
  return hit?.[1];
}

const trimEvidence = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  const r = redactSecrets(s).trim();
  return r ? r.slice(0, 200) : undefined;
};

// 单条 deferred → cause。分类以 lastError 文本为主(reason 常是笼统的 retry_budget_exhausted,
// 真实根因在 lastError 里,如 "Provider unavailable: deepseek — missing API key"),reason 兜底。
function classifyDeferred(d: DeferredTask, nameOf?: (id: string) => string | undefined): PostmortemCause {
  const who = nameOf?.(d.agentId) || d.agentId;
  const err = d.lastError || "";
  const provider = detectProvider(err);
  const evidence = trimEvidence(err);

  if (provider && KEY_ERROR_RE.test(err)) {
    return { kind: "provider_key", message: `员工「${who}」的模型供应商 ${provider} 无法调用:API Key 未配置或无效`, evidence, messageKey: "provider_key", params: { who, provider } };
  }
  if (d.reason === "provider_unavailable" || PROVIDER_ERROR_RE.test(err)) {
    // reason 明确是 provider 问题但没检出 key 标志——仍可能是没配 key,点名 provider(检测得到时)。
    if (provider) return { kind: "provider_key", message: `员工「${who}」的模型供应商 ${provider} 不可用(常见原因:API Key 未配置)`, evidence, messageKey: "provider_key_likely", params: { who, provider } };
    return { kind: "provider_unavailable", message: `员工「${who}」的模型供应商/执行框架不可用`, evidence, messageKey: "provider_unavailable", params: { who } };
  }
  if (d.reason === "no_account") {
    return { kind: "no_account", message: `员工「${who}」等不到可用账号(调度超时)`, evidence, messageKey: "no_account", params: { who } };
  }
  if (d.reason === "timeout") {
    return { kind: "timeout", message: `员工「${who}」执行超时,子任务被延后`, evidence, messageKey: "timeout", params: { who } };
  }
  if (d.reason === "quality_gate_failed") {
    return { kind: "quality_gate_failed", message: `员工「${who}」的产出未通过质量门/工件契约`, evidence, messageKey: "quality_gate_failed", params: { who } };
  }
  // retry_budget_exhausted / run_budget_exhausted
  return { kind: "budget_exhausted", message: `员工「${who}」重试次数/任务预算耗尽,子任务被延后`, evidence, messageKey: "budget_exhausted", params: { who } };
}

// 每种 cause kind 对应的系统建议;provider 类建议要点名 provider,动态生成。
function suggestionsFor(causes: PostmortemCause[]): PostmortemSuggestionItem[] {
  const out: PostmortemSuggestionItem[] = [];
  const push = (key: string, text: string, params?: Record<string, string>) => {
    if (!out.some((s) => s.text === text)) out.push({ key, text, ...(params ? { params } : {}) });
  };

  const keyCauses = causes.filter((c) => c.kind === "provider_key");
  for (const c of keyCauses) {
    const provider = c.params?.provider || PROVIDER_DISPLAY.find(([, disp]) => c.message.includes(disp))?.[1] || "该供应商";
    push("configure_key", `在「API」页为 ${provider} 配置有效的 API Key`, { provider });
    push("switch_provider", `或把该员工切换到已配置好的其他模型供应商`);
  }
  for (const c of causes) {
    switch (c.kind) {
      case "provider_unavailable": push("provider_unavailable", "检查该员工的供应商/框架配置(「API」页),或换用其他模型"); break;
      case "no_account": push("no_account", "在「API」页添加更多账号,或减少同时开工的员工数"); break;
      case "timeout": push("timeout", "把任务拆小(一次只交代一件事),或给该员工换更快的模型再试"); break;
      case "quality_gate_failed": push("quality_gate_failed", "查看被拒原因,补充更明确的验收要求后重试"); break;
      case "budget_exhausted": push("budget_exhausted", "缩小任务范围或提高预算后重试"); break;
      case "artifact_rejected": push("artifact_rejected", "查看产物被拒原因,明确产物要求后让 CEO 重新拆解"); break;
      case "degraded": push("degraded", "交付物是降级产物,建议检查失败环节后重试整个任务"); break;
      case "run_failed": push("run_failed", "查看日志定位失败环节,修复后重试"); break;
      default: break;
    }
  }
  return out.slice(0, 6);
}

// 四个固定操作(label 是服务端兜底文案;前端 PostmortemModal 用 i18n 键覆盖展示)。
function defaultActions(): PostmortemAction[] {
  return [
    { id: "retry", label: "重试" },
    { id: "replan", label: "让 CEO 重拆" },
    { id: "save_lesson", label: "加入经验库" },
    { id: "view_logs", label: "查看日志" },
  ];
}

/** 纯派生:输入已落盘证据的解析结果,输出结构化复盘对象。绝不抛。 */
export function derivePostmortem(input: PostmortemInput): Postmortem {
  const task = input.task ?? {};
  const goal = typeof task.userGoal === "string" && task.userGoal
    ? task.userGoal
    : typeof task.goal === "string" && task.goal ? task.goal : undefined; // 旧 run 索引形状兜底
  const companyId = typeof task.companyId === "string" && task.companyId ? task.companyId : undefined;
  const status = typeof task.status === "string" ? task.status : undefined;

  const deferred = Array.isArray(input.deferred) ? input.deferred : [];
  // failure-report.json 缺失(旧 run)时回退 run-summary.json 的同名派生字段。
  const fr = input.failureReport ?? {};
  const rs = input.runSummary ?? {};
  const degraded = task.degraded === true || fr.degraded === true || rs.degraded === true;
  const rejectedArtifacts = Array.isArray(fr.rejectedArtifacts) && fr.rejectedArtifacts.length
    ? fr.rejectedArtifacts
    : Array.isArray(rs.rejectedArtifacts) ? rs.rejectedArtifacts : [];

  const causes: PostmortemCause[] = [];
  const seen = new Set<string>();
  for (const d of deferred) {
    if (!d || typeof d !== "object" || typeof d.agentId !== "string") continue;
    const c = classifyDeferred(d, input.nameOf);
    const key = `${c.kind}:${c.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    causes.push(c);
  }
  for (const ref of rejectedArtifacts) {
    if (typeof ref !== "string" || !ref) continue;
    const key = `artifact_rejected:${ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    causes.push({ kind: "artifact_rejected", message: `产物「${ref}」未通过验收,没有进入最终交付`, messageKey: "artifact_rejected", params: { ref } });
  }
  if (degraded) {
    const reason = typeof task.degradedReason === "string" && task.degradedReason ? task.degradedReason : undefined;
    causes.push({ kind: "degraded", message: "最终交付物是降级产物(合成环节失败,内容未经协调者整合)", evidence: trimEvidence(reason), messageKey: "degraded" });
  }
  if (status === "failed" && causes.length === 0) {
    const reason = typeof task.degradedReason === "string" && task.degradedReason ? task.degradedReason : undefined;
    causes.push({ kind: "run_failed", message: "任务执行失败,未产出有效交付物", evidence: trimEvidence(reason), messageKey: "run_failed" });
  }

  const available = status === "failed" || degraded || causes.length > 0;
  if (!available) {
    return { runId: input.runId, available: false, title: "", goal, companyId, causes: [], suggestions: [], actions: [] };
  }

  const title = status === "failed"
    ? "任务执行失败"
    : degraded
      ? "任务完成,但交付物降级"
      : `任务完成,但 ${deferred.length || causes.length} 个子任务被延后`;

  const suggestionItems = suggestionsFor(causes);
  return {
    runId: input.runId,
    available: true,
    title,
    goal,
    companyId,
    causes,
    suggestions: suggestionItems.map((s) => s.text),
    suggestionItems,
    actions: defaultActions(),
  };
}

function readJsonSafe<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, "utf-8")) as T; } catch { return null; }
}

/**
 * 从磁盘读取该 run 的证据文件并派生复盘对象。
 * 返回 null = run 不存在(task.json 缺失,路由层据此 404);其余文件缺失按无信号处理。
 */
export function buildPostmortem(
  projectRoot: string,
  runId: string,
  opts?: { nameOf?: (agentId: string) => string | undefined },
): Postmortem | null {
  const dir = path.join(projectRoot, ".opc", "runs", runId);
  const task = readJsonSafe<Partial<Run> & Record<string, unknown>>(path.join(dir, "task.json"));
  if (!task) return null;
  return derivePostmortem({
    runId,
    task,
    failureReport: readJsonSafe<Partial<FailureReport>>(path.join(dir, "failure-report.json")),
    runSummary: readJsonSafe<Partial<RunSummaryState>>(path.join(dir, "run-summary.json")),
    deferred: readJsonSafe<DeferredTask[]>(path.join(dir, "deferred.json")),
    nameOf: opts?.nameOf,
  });
}
