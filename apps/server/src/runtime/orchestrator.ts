import type { AgentNodeConfig, ProviderAccount, Run, ExecTask, ExecContext, ExecResult, DeferredTask, FileChange, StructuredReport, AgentMessage, MessageAudience, VisibilityPolicy, EvidenceRow } from "@opc/shared";
import { filterVisible } from "./visibility.js";
import { ChannelRegistry, applyPresetChannels } from "./channels.js";
import { A2ABus, ArtifactStore, appendA2AMessageRecord, buildA2AMessageRecord, inferMessageType, computeA2AClosure } from "./a2aBus.js";
import type { Performative, A2APart, A2AMessageType, A2ALifecycleState } from "@opc/shared";
import { normalizeCompanyId, validateAgentWorkingDirectory } from "@opc/shared";
import { v4 as uuid } from "uuid";
import { DEFAULT_AGENTS } from "../defaults.js";
import { loadAgents, saveAgents, mergeSaveAgents, createRun, saveRunReport, saveTrace, saveCost, saveRunTask, loadRunTask, loadConfig, archiveReport, saveChanges, saveDeferred, saveStructuredReport, loadRunIndex } from "../storage/projectStore.js";
import { getTaskGraph, getTaskGraphByMission, upsertTaskGraph } from "../storage/taskGraphStore.js";
import type { TaskGraph, TaskNodeStatus } from "@opc/shared";
import { collectRunGrowthEvidence, computeGrowthDelta, applyGrowth } from "../storage/agentGrowthStore.js";
import { buildRunArtifactCollection, saveArtifactRegistry } from "./artifactRegistry.js";
import { matchEdgesForProducer, programmaticVerify, parseVerifierVerdict, pickCodeReviewProducer, verifierConcurrencyCap, VerifierConcurrencyGate, type VerificationResultRecord } from "./verification.js";
import { commitReview, type ReviewProposal } from "./reviewCommit.js";
import { redactSecrets } from "../security/redact.js";
import type { VerificationEdge } from "@opc/shared";
import { refreshMcpTools, runWithAgent, setChannelRequestHandler, setDiscoverHandler, setA2ASendHandler, setShareHandler, setInboxPeekHandler, setAskHandler } from "./tools.js";
import type { CallRecord } from "./modelGateway.js";
import { getEngine, frameworkPolicy, routeEngine, pickFallbackEngine, ALL_FRAMEWORKS } from "./engineRouter.js";
import { estimateTaskComplexity } from "./taskComplexityEstimator.js";
import { makeCooldownKey, getCooldownEntry, recordRateLimit } from "./rateLimitCooldown.js";
import { captureBaseline } from "./qualityGate.js";
import { AccountPool } from "./pool/accountPool.js";
import { DefaultScheduler } from "./pool/scheduler.js";
import { Semaphore } from "./pool/semaphore.js";
import { runWorkersParallel, type WorkerSpec } from "./parallelExecutor.js";
import { getProfileForRole } from "./roleProfile.js";
import { ensureAccountsFromProviders, loadAccounts } from "../storage/providerStore.js";
import { resolveApiKeyOverride } from "./engines/apiKeyAccount.js";
import { isHealthy, suggestBackupProvider } from "./providerHealth.js";
import { buildSystemPrompt, isInjectionEnabled, setForceSkills } from "./contextBuilder.js";
import { clearRunContextCache } from "./contextBroker.js";
import { clearRunResourceValidationCache } from "./resourcePointer.js";
import { buildWebBrief } from "./webSearch.js";
import { parseCeoPlanJson } from "./planSchema.js";
import { collectReflectionSignals, reflectOnRun, deepseekChat, classifyTaskType, type ReflectionMemoryCandidate } from "./runCritic.js";
import { resolveProviderKey } from "./providerRegistry.js";
import { normalizeToolName, retrievePlanTemplate } from "../storage/registryStore.js";
import { bumpHitsByIds } from "../storage/memoryStore.js";
import { appendReuseOutcomes, type MemoryReuseEntry } from "../storage/memoryReuseStore.js";
import { isMemoryReuseEligible } from "./memoryReuseEligibility.js";
import { citeMemories, type CitedMemory, type InjectedMemoryRef } from "./memoryPack.js";
import { readCompanyMd, writeCompanyMd, readTeamMd, writeTeamMd, appendTeamTask, writeProjectMd, appendCompanyKnowledge } from "../storage/mdMemory.js";
import { ensureCompanies, loadCompanies, getCompany, DEFAULT_COMPANY_ID } from "../storage/companyStore.js";
import { computeCostSummary, enforceCompanyTokenLimit } from "./costSummary.js";
import { companyRootDir, ensureGitRepo, evaluateDirtyPreflight } from "./workspace.js";
import { snapshotGit, gitChangedSince, diffFileChanges } from "./fileChanges.js";
import { validateWorkspaceFolder } from "./workspaceGuard.js";
import { emit, setRunId, subscribe, unsubscribe, getRunHistory, getRunId, EPHEMERAL_TYPES } from "./eventBus.js";
import { RUN_IN_FLIGHT_ERROR, drainDispatchQueue } from "./runMutex.js";
import { deriveRunSummary } from "../storage/runHistoryStore.js";
import { getRolePrompt, composeSystemPrompt } from "./prompts.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { validateArtifact, factCheckContract, type ArtifactContract } from "./artifactContract.js";
import { buildContractMessage } from "./contractMessage.js";
import { runQualityGateLayers, formatGateFailure, type QualityGateResultEventPayload } from "./qualityGateOrchestrator.js";
import { buildAuthoritativeCodingConclusionSource, extractStructuredConclusion, shouldPersistCleanExperience } from "./extractRunConclusion.js";
import { proposeMemory } from "./memoryGovernance.js";
import { writeRunResult, writeDiagnostics, appendToolCalls, writeWorkerConfig, buildRunResultContract, buildCrashRunResultContract, buildCrashDiagnostics, deriveToolCallRecords, deriveRunDiagnostics, deriveTestEvidence, aggregateTestRes } from "./runtimeContract.js";
import { buildEvidenceManifest, commitEvidenceReceipts, writeEvidenceManifest, verifyEvidenceManifest } from "./evidenceManifest.js";
import { upsertEvidenceManifest } from "../storage/sqlite/evidenceStore.js";
import { taskRequiresCode, taskRequiresTests, isVerifierTask, isTextDependentWorker, isCoderRole, isVerifierRole, evaluateDeliveryAcceptance, isDeliveryVerified, deriveFinalRunState, isTestFilePath, verifyContractSubsetAgainstManifest, goalForbidsCode, type DeliveryAcceptance } from "./deliveryAcceptance.js";
import { loadProducerManifest, freezeProducerManifestEntries } from "../storage/producerManifestStore.js";
import { buildCapabilityReport } from "./capabilityReport.js";
import { isAgentExecutable, withGlobalCliSubscriptionAccounts } from "./executionAvailability.js";
import { decideLeadOutcomeA2A } from "./leadOutcomeA2A.js";
import { getMcpCapabilityVersions } from "./mcpGovernance.js";
import { effEngineForMode, runEngineCore as workerRunEngineCore, type TeamMode, type WorkerRuntimeDeps } from "./workerRuntime.js";
import { decideAndRecordRunGovernance, checkGovernanceDispatch } from "./runLifecycle.js";
import { appendGovernanceEvent } from "../storage/governanceStore.js";
import type { GovernanceLevel } from "./runGovernance.js";
import { setPidRegistryRun, clearRunPids } from "./pidRegistry.js";

let currentBranch = "";
let runBranch = "";
let gitAvailable = false;

import {
  createRuntimeTaskContract,
  formatRuntimeTaskContract,
  tightenRuntimeTaskContract,
  writeRuntimeTaskContract,
} from './runtimeTaskContract.js';

function removeEmptyGitIndexLock(root: string, minAgeMs = 1000): void {
  try {
    const lockPath = path.join(root, ".git", "index.lock");
    if (!fs.existsSync(lockPath)) return;
    const stat = fs.statSync(lockPath);
    if (!stat.isFile() || stat.size !== 0) return;
    if (Date.now() - stat.mtimeMs < minAgeMs) return;
    fs.unlinkSync(lockPath);
  } catch {
    // Best-effort cleanup. The following git command will surface a real lock error if needed.
  }
}

function git(root: string, args: string[], timeout = 10000, readOnly = false): string {
  removeEmptyGitIndexLock(root);
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      timeout,
      env: readOnly ? { ...process.env, GIT_OPTIONAL_LOCKS: "0" } : process.env,
    });
  } finally {
    removeEmptyGitIndexLock(root, 0);
  }
}

function gitError(error: unknown): string {
  const e = error as { stderr?: unknown; message?: unknown } | null;
  return String(e?.stderr || e?.message || error || "").slice(0, 500);
}

function createRunBranch(runId: string): void {
  const root = activeWorkRoot || projectRoot || process.cwd();
  try {
    currentBranch = git(root, ["branch", "--show-current"], 5000, true).trim();
    const branchName = `opc-run-${runId.slice(0, 8)}`;
    git(root, ["checkout", "-b", branchName]);
    runBranch = branchName;
    gitAvailable = true;
    emit("info", undefined, { message: `Created git branch: ${branchName}` });
  } catch {
    gitAvailable = false;
    emit("info", undefined, { message: "Git not available - continuing without branching" });
  }
}

interface FinalizeRunBranchResult { ok: boolean; error?: string; conflict?: boolean; conflictFiles?: string[]; }

// D3(已拍板)· 绝不 `git add -A`、绝不自动打包用户脏/未跟踪文件:只按本 run 交付合同(allChanges)的
// 精确路径 stage(runRoutes approve 同款形态)。merge 回用户分支冲突时绝不 -X theirs 强并——abort 后
// 保留 opc-run-* 分支供人工合并,返回 conflict 供 run 级 finalState=requires_review。
function finalizeRunBranch(runId: string, success: boolean, runChangedPaths: string[] = []): FinalizeRunBranchResult {
  if (!gitAvailable || !runBranch) return { ok: true };
  const root = activeWorkRoot || projectRoot || process.cwd();
  try {
    let mergeError = "";
    let conflict = false;
    let conflictFiles: string[] = [];
    if (success && runChangedPaths.length > 0) {
      try {
        git(root, ["add", "--", ...runChangedPaths]);
      } catch {
        // 整批 add 失败(某路径 pathspec 不匹配等)→ 退化为逐路径 best-effort,绝不放宽为 add -A。
        for (const p of runChangedPaths) { try { git(root, ["add", "--", p]); } catch { /* 路径已不存在等,跳过 */ } }
      }
      const staged = git(root, ["diff", "--cached", "--name-only"], 10000, true).trim();
      if (staged) {
        git(root, ["commit", "-m", `OPC run: ${runId.slice(0, 8)}`]);
        emit("info", undefined, { message: `Committed ${staged.split(/\r?\n/).length} run-changed file(s) on branch ${runBranch}(精确路径 stage,不含用户游离文件)` });
      }
    }
    git(root, ["checkout", currentBranch]);
    // Merge the run branch back to the visible company workspace; failures must affect run status.
    if (success && runBranch !== currentBranch) {
      try {
        git(root, ["merge", "--no-edit", runBranch]);
        emit("info", undefined, { message: `Merged run output back to ${currentBranch}` });
      } catch (e2: any) {
        try { conflictFiles = git(root, ["diff", "--name-only", "--diff-filter=U"], 10000, true).split(/\r?\n/).map((s) => s.trim()).filter(Boolean); } catch { /* best effort */ }
        try { git(root, ["merge", "--abort"]); } catch { /* none */ }
        conflict = true;
        mergeError = `merge back to ${currentBranch} conflicted(不强并),run 分支 ${runBranch} 已保留待人工合并: ${gitError(e2)}`;
        emit("error", undefined, { message: mergeError });
      }
    }
    emit("info", undefined, { message: `Switched back to ${currentBranch}` });
    return mergeError ? { ok: false, error: mergeError, conflict, ...(conflictFiles.length ? { conflictFiles } : {}) } : { ok: true };
  } catch (e: any) {
    const error = `Git branch finalize failed: ${gitError(e)}`;
    emit("error", undefined, { message: error });
    return { ok: false, error };
  }
}
const callRecords: CallRecord[] = [];
const traceEvents: any[] = [];

// v2 visibility model: every inter-agent message this run is logged here with an audience, then
// emitted as an `agent_message` trace event. visibleMessagesFor() filters the log per viewer so a
// game/debate loop (Phase 12) can feed each agent only what it is allowed to see.
const runMessages: AgentMessage[] = [];
let runChannels = new ChannelRegistry(); // v5: run 级通信通道（lead↔worker / 同侪 / 跨团队）
let a2aBus = new A2ABus();                // A2A: per-agent inbox 真投递(与 eventBus 严格分离)
let artifactStore = new ArtifactStore();  // A2A: run 级产出物 claim-check
// D3 · run 级"真正拼进各 agent prompt 的记忆"登记(agentId → InjectedMemoryRef[],按 id 去重累积)。
// 来源 = workerRuntime.onInjection(注入即登记,citeMemories 同一诚实来源);run 开始清空(同 a2aBus 重建点)。
// 消费:①lead→worker 派单消息附 citedMemories(派单可观测);②run 收尾 × 终态 → reuse-log.jsonl(复用验证回路)。
let injectedByAgent = new Map<string, InjectedMemoryRef[]>();
let askSeq = 0;                           // A2A: ask correlationId 自增
let askDepth = 0;                         // A2A: 问询链深度(防死锁,≤2)
const activeAsks = new Set<string>();     // A2A: 进行中的 from->target 问询(A↔B 环检测)
let runVisibilityPolicy: VisibilityPolicy = "default";
// Game host(s) / oversight that see every message regardless of audience (e.g. 狼人杀 主持人 = lead).
let runOmniscient: string[] = [];

// A2A 收件人解析:把「定向」audience(agents:/role:/lead-only)解析成接收 agentId 列表。
// 广播类(all/team/private)返回 [] —— 它们仍走 filterVisible 拉取,不做点对点投递(防 N² 投递风暴)。
function recipientsForAudience(audience: MessageAudience, fromId: string): string[] {
  if (audience.startsWith("agents:")) {
    return audience.slice("agents:".length).split(",").map((s) => s.trim()).filter((x) => x && x !== fromId);
  }
  if (audience.startsWith("role:")) {
    const role = audience.slice("role:".length);
    return agents.filter((a) => a.role === role && a.id !== fromId).map((a) => a.id);
  }
  if (audience === "lead-only") {
    // 收件人 = from 之上的 lead/ceo 祖先链(与 visibleTo 的 lead-only 语义一致)。
    const byId = new Map(agents.map((a) => [a.id, a]));
    const out: string[] = [];
    let cur = byId.get(fromId)?.parentId ? byId.get(byId.get(fromId)!.parentId!) : undefined;
    let guard = 0;
    while (cur && guard++ < 64) { out.push(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined; }
    return out;
  }
  return []; // all / team / private → 不点对点投递
}

// A2A 真投递:把一条消息投进每个「被授权」收件人的 inbox。授权门 = canCommunicate(无开放通道则不投,
// fail-closed)。注意:只投定向消息,绝不经此泄漏给广播受众;eventBus 仍只发 text 投影(见 recordMessage)。
function deliverToInboxes(msg: AgentMessage): void {
  const recipients = msg.to && msg.to.length
    ? msg.to.filter((r) => r !== msg.from)
    : recipientsForAudience(msg.visibility.audience, msg.from);
  const authorized = recipients.filter((r) => runChannels.canCommunicate(msg.from, r));
  if (authorized.length) a2aBus.deliver(msg, authorized);
}

// D3:尾参 citedMemories(加性可选)——派单等调用点把"发送方决策时真正注入过的记忆引用"挂上消息,
// 随 a2aBus onCommitted sink 落 a2a_messages.jsonl(buildA2AMessageRecord 透传),派单可观测。
// D4:再加尾参 to(加性可选)——派单等契约消息挂显式收件人,让它进 A2A 必需闭环集(有 to)且可被
// 发送方按 id resolve。不传 to 时行为逐字节不变(收件人仍由 audience 派生,既有调用点零破坏)。
// 返回构造出的 AgentMessage(D4 收尾按 id resolve 用;既有调用点不接返回值,零破坏)。
function recordMessage(from: string, text: string, audience: MessageAudience, phase?: string, channelId?: string, messageType?: A2AMessageType, citedMemories?: CitedMemory[], to?: string[]): AgentMessage {
  const msg: AgentMessage = {
    id: uuid(), runId: activeRunId, from, text,
    timestamp: new Date().toISOString(),
    ...(channelId ? { channelId } : {}),
    ...(messageType ? { messageType } : {}),
    ...(citedMemories?.length ? { citedMemories } : {}),
    ...(to?.length ? { to } : {}),
    visibility: { audience, ...(phase ? { phase } : {}) },
  };
  // A4 生命周期:proposed → validated(广播路径无点对点授权要求,结构校验即通过)→
  // committed(进入正式 timeline 的唯一门槛;落盘 sink 在 bus 内触发)。
  a2aBus.propose(msg);
  a2aBus.validate(msg);
  a2aBus.commit(msg);
  runMessages.push(msg);
  if (channelId) runChannels.setActive(channelId, true); // 该通道正在交流（UI 高亮）
  deliverToInboxes(msg);                                  // A2A: 定向消息进收件人 inbox(已授权才投;committed→delivered)
  // citedMemories 只含 {id,title} 元数据(非记忆正文)——与 memory_pack_used 事件已广播的引用条同一泄漏面,零新增。
  emit("agent_message", from, { text, audience, phase, channelId, ...(messageType ? { messageType } : {}), ...(citedMemories?.length ? { citedMemories } : {}) });
  return msg;
}

// A2A 富消息:agent 主动发起的点对点通信(performative + 显式收件人 to + 可带 parts/artifact/会话关联)。
// 与 recordMessage 共用 runMessages/投递/eventBus,但携带 FIPA/A2A 语义。text 始终是 parts 的纯文本投影。
function recordA2A(opts: {
  from: string; to: string[]; text: string; performative: Performative;
  parts?: A2APart[]; conversationId?: string; correlationId?: string; artifactRefs?: string[]; channelId?: string;
  messageType?: A2AMessageType; // A4: 明确语义的调用点显式传;不传则保守推断,推不出留空
}): AgentMessage {
  const audience: MessageAudience = `agents:${opts.to.join(",")}`;
  const messageType = opts.messageType ?? inferMessageType({ performative: opts.performative, artifactRefs: opts.artifactRefs });
  const msg: AgentMessage = {
    id: uuid(), runId: activeRunId, from: opts.from, text: opts.text,
    timestamp: new Date().toISOString(),
    ...(opts.channelId ? { channelId: opts.channelId } : {}),
    visibility: { audience },
    to: opts.to, performative: opts.performative,
    ...(messageType ? { messageType } : {}),
    ...(opts.parts ? { parts: opts.parts } : {}),
    ...(opts.conversationId ? { conversationId: opts.conversationId } : {}),
    ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
    ...(opts.artifactRefs ? { artifactRefs: opts.artifactRefs } : {}),
  };
  // A4 生命周期:proposed → canCommunicate 确定性校验(fail-closed) → committed → delivered。
  a2aBus.propose(msg);
  const authorized = opts.to.filter((r) => r !== opts.from && runChannels.canCommunicate(opts.from, r));
  if (!authorized.length) {
    // 调用点均已预检通道,此分支为纵深防御:校验失败 → rejected,不进 runMessages、不投递、不广播、不落盘。
    a2aBus.reject(msg, "canCommunicate 校验失败:与所有收件人均无开放通道");
    return msg;
  }
  a2aBus.validate(msg);
  a2aBus.commit(msg); // committed = 进入正式 timeline 的唯一门槛(落盘 sink 在 bus 内触发)
  runMessages.push(msg);
  if (opts.channelId) runChannels.setActive(opts.channelId, true);
  deliverToInboxes(msg);
  // eventBus 只发 text 投影 + 元数据,绝不发 parts/artifact 全文(防 SSE 可见性泄漏)。
  emit("agent_message", opts.from, { text: opts.text, audience, performative: opts.performative, conversationId: opts.conversationId, channelId: opts.channelId, ...(messageType ? { messageType } : {}) });
  return msg;
}

// A2A Phase 6: Agent Card 摘要的派生兜底——agent 没显式 card 时,按角色合成一句话能力描述,
// 让 discover_agents 始终返回有意义的"它能干什么"(零迁移:不必给每个 agent 手写 card)。
const ROLE_SUMMARY: Record<string, string> = {
  ceo: "统筹需求、选/建团队、下达团队级目标",
  lead: "拆解团队目标、派活、评审打回、汇报",
  dev: "写代码、实现功能、做研究与撰写",
  test: "测试与核查、找问题、写测试",
  security: "安全审计与漏洞评估",
  architect: "架构设计与分析综合",
  ops: "部署、配置与运维",
};
function deriveSummary(a: AgentNodeConfig): string {
  return a.card?.summary ?? ROLE_SUMMARY[a.role] ?? `${a.role} 角色`;
}

// v2 Phase3:冷启动初始化共享 md。company.md(CEO 维护)+ team.md(lead 自扫描成员)。仅在缺失时
// 写骨架(确定性,无额外 LLM 调用),之后由 CEO/lead 完善、由 appendTeamTask 累积能力史。
function ensureCompanyMd(companyId: string): void {
  if (readCompanyMd(projectRoot, companyId)) return;
  const leads = agents.filter(a => a.role === "lead" && (a.childrenIds?.length ?? 0) > 0);
  const body = `# 公司知识(company.md)\n\n> CEO 维护:公司是什么、对外口径、共性知识。以下为冷启动骨架,可完善。\n\n## 团队(leads)\n${leads.map(l => `- **${l.name}** (\`${l.id}\`):${deriveSummary(l)}`).join("\n") || "- (暂无)"}\n`;
  writeCompanyMd(projectRoot, body, companyId);
}
// v2 分诊(决策#1):CEO 判断无需团队时,以 `DIRECT_ANSWER:` 开头直接答复。提取其正文;否则 null → 照常开团队。
export function parseDirectAnswer(ceoResponse: string): string | null {
  const r = ceoResponse || "";
  // 若 CEO 输出了团队计划(## PLAN / ## LEAD:),那是开团队——即便文中顺带提到 DIRECT_ANSWER 也不当直答。
  if (/##\s*(LEAD|PLAN)\b/i.test(r)) return null;
  // 否则:CEO 常在 DIRECT_ANSWER: 前带前言(实测会写"Let me deliver a DIRECT_ANSWER…")。不强制行首锚定,
  // 全文搜首个标记取正文 —— 否则答案明明在 DIRECT_ANSWER: 后却被整段丢弃 → 空产出(实测踩过)。
  const m = r.match(/DIRECT_ANSWER\s*[:：]\s*([\s\S]+)/i);
  return m ? m[1].trim() : null;
}
function ensureTeamMd(lead: AgentNodeConfig, memberIds: string[]): void {
  if (readTeamMd(projectRoot, lead.id)) return;
  const members = memberIds.map(id => agents.find(a => a.id === id)).filter((a): a is AgentNodeConfig => !!a);
  const body = `# 团队:${lead.name}(team.md)\n\n> lead 自扫描初始化:团队职责 + 成员能力(决策#2)。\n\n## Lead\n- **${lead.name}** (${lead.role}):${deriveSummary(lead)}\n\n## 成员\n${members.map(m => `- **${m.name}** (${m.role}):${deriveSummary(m)}`).join("\n") || "- (暂无固定成员)"}\n`;
  writeTeamMd(projectRoot, lead.id, body);
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4(方案B / live A2A):把已有的 A2A 操作以「外部进程可调」的纯函数暴露,供 a2aRoutes
// (进而 worker 的 code-execution SDK)调用。身份 = 调用方 agentId(from),沿用 canCommunicate
// 授权(fail-closed:无开通道则拒)。逻辑与文本工具处理器一致;但 ask 走**异步 inbox**——投递即
// 返回 taskId,不同步阻塞(契合一次性子进程模型 + 研究建议的异步 Task 语义)。
// 安全红线:A2A 是传递性 prompt-injection 攻击面 → 授权不放宽,且仅在有活动 run 时可用。
let a2aTaskSeq = 0;
export function a2aActiveRunId(): string { return activeRunId; }
let activeCompanyIdForA2A: string | null = null;
export function a2aActiveCompanyId(): string | null { return activeCompanyIdForA2A; } // 当前 run 的公司(schedule-goal/loop 用)
export function a2aAgentExists(id: string): boolean { return agents.some((a) => a.id === id); }

export function a2aDiscover(from: string, filter: { role?: string; skill?: string; produces?: string } = {}): Array<{ id: string; name: string; role: string; summary: string; skills: string[] }> {
  const skill = filter.skill?.toLowerCase();
  const produces = filter.produces?.toLowerCase();
  return agents.filter((a) => {
    if (a.id === from || a.enabled === false) return false;
    if (filter.role && a.role !== filter.role) return false;
    if (skill) {
      const hay = `${a.role} ${a.name} ${a.card?.summary ?? ""} ${(a.card?.skills ?? []).map((s) => `${s.name} ${s.description}`).join(" ")}`.toLowerCase();
      if (!hay.includes(skill)) return false;
    }
    if (produces && !(a.card?.produces ?? []).some((p) => p.toLowerCase().includes(produces))) return false;
    return true;
  }).slice(0, 12).map((a) => ({ id: a.id, name: a.name, role: a.role, summary: deriveSummary(a), skills: (a.card?.skills ?? []).map((s) => s.name) }));
}

export function a2aRequestChannel(from: string, target: string, kind: "peer-worker" | "peer-lead", reason: string): { ok: boolean; message: string; requestId?: string } {
  if (!agents.some((a) => a.id === target)) return { ok: false, message: `目标 ${target} 不存在。` };
  const req = runChannels.request(from, target, kind, reason || "");
  // 硬规则(C6):协作线动画只能由 committed A2A event 驱动——通道申请消息也必须走 recordMessage
  // 的 propose→validate→commit 生命周期落 a2a_messages.jsonl,不许旁路裸 emit(否则动画对不上账)。
  recordMessage(from, `（申请与 ${target} 建立 ${kind} 通道）${reason ?? ""}`, "lead-only");
  return { ok: true, message: `已提交与 ${target} 的通信申请（id ${req.id}，${kind}），待协调者批准。`, requestId: req.id };
}

export function a2aSend(from: string, target: string, text: string, artifactId?: string): { ok: boolean; message: string } {
  if (!agents.some((a) => a.id === target)) return { ok: false, message: `目标 ${target} 不存在。` };
  if (!runChannels.canCommunicate(from, target)) return { ok: false, message: `你与 ${target} 还没有开通通道,请先 request-channel 申请并待批准。` };
  recordA2A({ from, to: [target], text, performative: "inform", artifactRefs: artifactId ? [artifactId] : undefined, channelId: runChannels.between(from, target)?.id });
  return { ok: true, message: `已发送给 ${target}。` };
}

// 本机用户在工作台对运行中员工追加要求。用户是公司治理面的最高授权者,由本 run 的 CEO
// 作为可审计发送者转交,并建立一条 run 级 a2a 通道。消息真实进入目标 inbox,在该员工下一次
// worker 执行前被 drain 注入;若员工已没有后续执行轮次,调用方必须如实提示可能来不及生效。
export function a2aInjectUserInstruction(target: string, text: string): {
  ok: boolean; message: string; messageId?: string; senderId?: string; lifecycle?: string;
} {
  const targetAgent = agents.find((a) => a.id === target && a.enabled !== false);
  if (!targetAgent) return { ok: false, message: `目标 ${target} 不存在或未启用。` };
  const targetCompany = targetAgent.companyId || DEFAULT_COMPANY_ID;
  if (activeCompanyIdForA2A && targetCompany !== activeCompanyIdForA2A) {
    return { ok: false, message: "目标员工不属于当前 run 的公司。" };
  }
  const ceo = agents.find((a) => a.enabled !== false && a.role === "ceo" && (a.companyId || DEFAULT_COMPANY_ID) === targetCompany);
  if (!ceo) return { ok: false, message: "当前公司没有可作为治理发送者的 CEO。" };
  const channel = runChannels.open(ceo.id, target, "a2a", ceo.id, "用户在工作台追加任务要求");
  const msg = recordA2A({
    from: ceo.id,
    to: [target],
    text: `[用户追加要求]\n${text.trim()}`,
    performative: "inform",
    channelId: channel.id,
  });
  return {
    ok: msg.lifecycle === "delivered" || msg.lifecycle === "acknowledged",
    message: "要求已进入该员工的任务收件箱,将在下一次执行轮次注入。",
    messageId: msg.id,
    senderId: ceo.id,
    lifecycle: msg.lifecycle,
  };
}

// 异步 ask:把问题投进 target 的 inbox,立即返回 taskId(不阻塞)。target 在其下一轮执行 drain inbox
// 时看到并可回应(回应经 inbox 回到本人)。这是契合一次性子进程的异步语义,而非同步 RPC。
export function a2aAsk(from: string, target: string, question: string): { ok: boolean; taskId?: string; message: string } {
  if (!agents.some((a) => a.id === target)) return { ok: false, message: `目标 ${target} 不存在。` };
  if (!runChannels.canCommunicate(from, target)) return { ok: false, message: `你与 ${target} 还没有开通通道,请先 request-channel。` };
  const taskId = `${(activeRunId || "x").slice(0, 6)}-q-${++a2aTaskSeq}`;
  recordA2A({ from, to: [target], text: question, performative: "ask", correlationId: taskId, channelId: runChannels.between(from, target)?.id });
  return { ok: true, taskId, message: `已向 ${target} 异步提问(taskId ${taskId});其回复会进你的 inbox,用 inbox 命令查看。` };
}

export function a2aInbox(agentId: string): Array<{ id: string; from: string; performative: string; text: string; artifactRefs?: string[]; correlationId?: string; messageType?: A2AMessageType; lifecycle?: A2ALifecycleState }> {
  // A4: 响应带 id + lifecycle(消费方凭 id 调 /api/a2a/ack 与 /resolve 推进回执)。旧消息无 lifecycle 则不带该字段。
  return a2aBus.peek(agentId).slice(-12).map((m) => ({
    id: m.id, from: m.from, performative: m.performative ?? "inform", text: m.text,
    artifactRefs: m.artifactRefs, correlationId: m.correlationId,
    ...(m.messageType ? { messageType: m.messageType } : {}),
    ...(m.lifecycle ? { lifecycle: m.lifecycle } : {}),
  }));
}

// A4: 显式回执/闭环(供 /api/a2a/ack /api/a2a/resolve 调用)。ack 仅收件人可发(fail-closed);
// resolve 允许消息参与者(发送方或收件人)闭环。返回推进后的 lifecycle,非法转移/未知消息拒绝并说明原因。
export function a2aAcknowledge(messageId: string, by: string): { ok: boolean; message: string; lifecycle?: A2ALifecycleState } {
  const m = a2aBus.get(messageId);
  if (!m) return { ok: false, message: `消息 ${messageId} 不存在或未纳入生命周期` };
  if (m.to?.length && !m.to.includes(by)) return { ok: false, lifecycle: m.lifecycle, message: `只有收件人可以确认该消息` };
  const ok = a2aBus.acknowledge(messageId, by);
  return ok
    ? { ok: true, lifecycle: m.lifecycle, message: "已确认收到(acknowledged)" }
    : { ok: false, lifecycle: m.lifecycle, message: `非法状态转移:当前 ${m.lifecycle ?? "无生命周期"} 不能推进为 acknowledged` };
}

export function a2aResolve(messageId: string, by: string): { ok: boolean; message: string; lifecycle?: A2ALifecycleState } {
  const m = a2aBus.get(messageId);
  if (!m) return { ok: false, message: `消息 ${messageId} 不存在或未纳入生命周期` };
  const participant = m.from === by || (m.to?.includes(by) ?? false);
  if ((m.to?.length || m.from) && !participant) return { ok: false, lifecycle: m.lifecycle, message: `只有消息参与者(发送方/收件人)可以闭环该消息` };
  const ok = a2aBus.resolve(messageId, by);
  return ok
    ? { ok: true, lifecycle: m.lifecycle, message: "已闭环(resolved)" }
    : { ok: false, lifecycle: m.lifecycle, message: `非法状态转移:当前 ${m.lifecycle ?? "无生命周期"} 不能推进为 resolved` };
}

export function getRunMessages(): AgentMessage[] {
  return runMessages.map((m) => ({ ...m }));
}

// v5: run 的通信通道快照（UI 画"谁和谁有通道/正在交流"）。
export function getRunChannels() {
  return { channels: runChannels.list(), requests: runChannels.listRequests() };
}

// v5 P3：同侪/跨团队通信流程（worker 申请与某人交流→协调者批准；团队向团队学习）。
// from/to 必须是真实 agent；peer-worker 由其共同 lead 协调，peer-lead/learn 由 CEO 协调。
export function requestRunChannel(from: string, to: string, kind: import("@opc/shared").ChannelKind, reason: string) {
  if (!agents.some(a => a.id === from) || !agents.some(a => a.id === to)) return { error: "未知 agent" };
  return { request: runChannels.request(from, to, kind, reason) };
}
export function decideRunChannel(requestId: string, grant: boolean, decidedBy: string) {
  return grant ? { channel: runChannels.grant(requestId, decidedBy) } : { denied: runChannels.deny(requestId, decidedBy) };
}
// 协调者主动开通道（lead 给同队 worker 开互通；CEO 给 lead 开学习通道）。
export function openRunChannel(a: string, b: string, kind: import("@opc/shared").ChannelKind, coordinatedBy: string, reason?: string) {
  if (!agents.some(x => x.id === a) || !agents.some(x => x.id === b)) return { error: "未知 agent" };
  return { channel: runChannels.open(a, b, kind, coordinatedBy, reason) };
}

// Messages this agent is allowed to see this run (audience + org structure + game omniscience).
export function visibleMessagesFor(viewerId: string): AgentMessage[] {
  return filterVisible(viewerId, runMessages, agents, { omniscient: runOmniscient });
}

let projectRoot = process.cwd();
let agents: AgentNodeConfig[] = [];

export function initOrchestrator(root: string) {
  projectRoot = root;
  // Migrate: ensure every node has a `framework` (default "api") and a `companyId` (default
  // "default") for older agents.json; seed the default company from the existing CEO.
  agents = loadAgents(root, DEFAULT_AGENTS).map(a => ({ framework: "api" as const, companyId: "default", ...a }));
  saveAgents(root, agents);
  ensureCompanies(root);
}

function setAgentStatus(id: string, status: AgentNodeConfig["status"], currentTask?: string) {
  const a = agents.find(x => x.id === id);
  if (a) {
    a.status = status;
    if (currentTask !== undefined) a.currentTask = currentTask;
    mergeSaveAgents(projectRoot, agents);
  }
  emit("agent_status_changed", id, { status, currentTask });
}

// A3 的契约状态收窄 toContractRunStatus 已上移至 runtimeContract.ts(唯一收窄点,见那里注释),此处 import 复用。

// A6/终验 · 证据链去 best-effort:关键证据(result.json / changes 落盘 / artifact registry / report·账本)
// 的写盘点位此前都被 best-effort try/catch 吞错 —— 写失败时 run 仍报纯净成功,证据链出现"缝隙"。
// guardEvidenceWrite 包裹一次证据写:成功返回 true;失败则把该 run 标记 integrity=degraded、记录失败点、
// 对 result.json 这一级(critical)额外置 criticalFailed(升级为 run failed),并发一条结构化
// evidence_write_failed 事件(evidenceKind + 错误摘要)。emit 自身再抛也绝不掩盖原始写失败。
export interface EvidenceIntegrityState {
  integrity: "ok" | "degraded";
  criticalFailed: boolean;
  failures: Array<{ evidenceKind: string; critical: boolean; error: string }>;
}

type EvidenceFailEmit = (
  type: "evidence_write_failed",
  agentId: string | undefined,
  payload: { evidenceKind: string; critical: boolean; error: string },
) => void;

export function guardEvidenceWrite(
  state: EvidenceIntegrityState,
  evidenceKind: string,
  critical: boolean,
  write: () => void,
  emitFn: EvidenceFailEmit,
): boolean {
  try {
    write();
    return true;
  } catch (e) {
    const error = String((e as { message?: unknown } | null)?.message ?? e ?? "unknown error").slice(0, 300);
    state.integrity = "degraded";
    if (critical) state.criticalFailed = true;
    state.failures.push({ evidenceKind, critical, error });
    try { emitFn("evidence_write_failed", undefined, { evidenceKind, critical, error }); } catch { /* 事件写失败绝不掩盖原始证据写失败 */ }
    return false;
  }
}

// 收尾:把证据完整性状态落到 run 记录 + allClean。degraded → 强制 allClean=false、run.evidenceIntegrity=degraded;
// critical(result.json)失败 → 升级为 run failed(沿用现有失败语义:status=failed + degraded + reason 追加)。
// 干净路径:仅在字段缺省时补 "ok",不动已有降级状态。返回收敛后的 allClean。
export function finalizeEvidenceIntegrity(
  run: Pick<Run, "status" | "degraded" | "degradedReason" | "evidenceIntegrity">,
  allClean: boolean,
  state: EvidenceIntegrityState,
): boolean {
  if (state.integrity !== "degraded") {
    if (!run.evidenceIntegrity) run.evidenceIntegrity = "ok";
    return allClean;
  }
  run.evidenceIntegrity = "degraded";
  if (state.criticalFailed && run.status !== "failed") {
    run.status = "failed";
    run.degraded = true;
    run.degradedReason = [run.degradedReason, "关键证据 result.json 写入失败,run 判定失败"]
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .join("; ");
  }
  return false;
}

let activeRunId = "";
// v10 P0-1: per-run running totals (reset each run alongside callRecords) — drive the run-level
// token/cost circuit breaker so a single run can't burn unbounded tokens with no brake.
let runTokens = 0;
let runCost = 0;
let persistActiveRunProgress: (() => void) | null = null;
// v2: the run's working repo (company workspace folder). Run METADATA stays under projectRoot/.opc;
// actual file work + worktrees + quality gate happen here (a sandbox, not the app's own repo).
let activeWorkRoot = "";

// B2 解耦:执行漏斗本体已迁至 runtime/workerRuntime.ts(纯函数,零模块状态)。orchestrator 退为
// 调用方——在这里把自己的模块级 run 状态(activeRunId/activeTeamMode/callRecords/runTokens/runCost/
// a2aBus/agents 状态机/账号解析)组装成 WorkerRuntimeDeps,每次调用现建(值快照 + 活闭包:
// runId/teamMode 在漏斗入口同步读取,与原直读模块变量逐字节等价;onCallRecord/onUsage 是活闭包,
// 迟到 settle 的 detached worker 记账仍落在当前模块状态上,保持 P1-5 语义)。
function buildWorkerRuntimeDeps(): WorkerRuntimeDeps {
  return {
    projectRoot,
    runId: activeRunId,
    teamMode: activeTeamMode,
    emit: (t, a, p) => emit(t as Parameters<typeof emit>[0], a, p),
    setAgentStatus,
    buildSystemPrompt,
    // D3 · 注入即登记:累积本 run 每个 agent 真正拼进 prompt 的记忆引用(按 id 去重;同一 agent
    // 多轮执行/返工会多次回调,累加不覆盖)。run 开始清空(见 startRun 的 a2aBus 重建点)。
    onInjection: (agentId, refs) => {
      const cur = injectedByAgent.get(agentId);
      if (!cur) { injectedByAgent.set(agentId, [...refs]); return; }
      const seen = new Set(cur.map((r) => r.id));
      for (const r of refs) if (r?.id && !seen.has(r.id)) { cur.push(r); seen.add(r.id); }
    },
    drainInbox: (agentId) => a2aBus.drain(agentId),
    frameworkPolicy,
    routeEngine,
    resolveNativeExecution: (agent) => agent.nativeExecution
      ?? getCompany(projectRoot, agent.companyId ?? DEFAULT_COMPANY_ID)?.nativeExecution
      ?? { preference: "acp", fallback: "acp" },
    makeCooldownKey,
    getCooldownEntry,
    pickFallbackEngine: (primaryKey) => pickFallbackEngine(primaryKey, Date.now(), (candidate) =>
      candidate.framework !== "api" || !!resolveProviderKey(projectRoot, candidate.provider)),
    recordRateLimit,
    resolveApiKey: (framework, cliConfigDir) => resolveApiKeyOverride(loadAccounts(projectRoot), framework, cliConfigDir),
    runWithAgent,
    onCallRecord: (record) => { callRecords.push(record); },
    onUsage: (tokens, cost) => {
      // v10 P0-1: this is the single common funnel for CEO/lead/worker calls — accumulate the run-level
      // running totals here so the circuit breaker (checked between teams/rounds) sees every call.
      runTokens += tokens;
      runCost += cost;
      try { persistActiveRunProgress?.(); } catch { /* best-effort live progress */ }
    },
  };
}

// Core: run a node through its execution engine (api/hermes/claude-code/codex) — see
// workerRuntime.runEngineCore. Reused by the serial CEO/Lead path (runViaEngine) and the parallel
// worker executor (injected as execFn). Engines never throw; only a caller's timeout wrapper can reject.
async function runEngineCore(agent: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
  return workerRunEngineCore(agent, task, ctx, buildWorkerRuntimeDeps());
}

// Serial wrapper for the CEO / Lead / summary paths (workdir == projectRoot). No accountPool lease
// (design assumption: at most one in-flight call per caller) — Stage 6's verifier gate is the one
// caller that now fans this out concurrently for the SAME agent, so it must pass its own
// taskTimeoutMs (role-aware, via getProfileForRole) AND cap concurrency itself (VerifierConcurrencyGate)
// rather than relying on any protection this "serial" wrapper doesn't provide.
async function runViaEngine(agent: AgentNodeConfig, systemPrompt: string, userMessage: string, opts?: { taskTimeoutMs?: number; statusWhileRunning?: ExecTask["statusWhileRunning"] }): Promise<ExecResult> {
  const config = loadConfig(projectRoot);
  const allowedTokens = clampTaskBudgetToRemaining(
    config.budget.maxTokensPerTask,
    config.budget.maxTokensPerRun,
    runTokens,
  );
  if (allowedTokens === 0) {
    return {
      content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0,
      latencyMs: 0, status: "failed", error: "run_budget_exhausted",
    };
  }
  const task: ExecTask = {
    taskId: `${agent.id}-${callRecords.length}`,
    goal: userMessage,
    systemPrompt,
    maxTokens: Math.min(4096, allowedTokens),
    statusWhileRunning: opts?.statusWhileRunning,
  };
  const wroot = activeWorkRoot || projectRoot;
  const ctx: ExecContext = {
    runId: activeRunId,
    projectRoot: wroot,
    workdir: wroot,
    emit: (t: string, a: string | undefined, p: unknown) => emit(t as any, a, p),
    budget: { maxTokensPerTask: allowedTokens },
    taskTimeoutMs: opts?.taskTimeoutMs ?? config.parallel?.taskTimeoutMs ?? config.budget.taskTimeoutMs ?? 180_000,
    abortSignal: activeRunAbortController?.signal,
  };
  return runEngineCore(agent, task, ctx);
}
// String-returning wrapper for the CEO / Lead / summary paths. Throws on a non-done result to
// preserve the previous fail-fast behavior for those callers.
async function runAgent(agent: AgentNodeConfig, systemPrompt: string, userMessage: string, opts?: { statusWhileRunning?: ExecTask["statusWhileRunning"] }): Promise<string> {
  const r = await runViaEngine(agent, systemPrompt, userMessage, opts);
  if (r.status !== "done") throw new Error(r.error || `${agent.id}: ${r.status}`);
  return r.content;
}
// Engines report the whole dirty tree after a call. Serial coordinators run in the shared work root,
// so retain only files that this call actually added or changed; pre-existing user changes must never
// enter the run contract merely because a CEO/lead inspected the workspace.
export function fileChangesCreatedSince(before: FileChange[], after: FileChange[]): FileChange[] {
  const fingerprints = new Map(before.map((change) => [
    change.path.replaceAll("\\", "/"),
    `${change.changeType}\u0000${change.after ?? ""}`,
  ]));
  return after.filter((change) => {
    const key = change.path.replaceAll("\\", "/");
    return fingerprints.get(key) !== `${change.changeType}\u0000${change.after ?? ""}`;
  });
}

// ③ 显式降级:协调者(贵模型 CLI)过载/不可用时,绝不静默退回空模板(这正是上次把崩溃产物当成有效
// 17.7% 假分数的根因)。链路:主协调者(已含引擎级 529/超时退避重试)→ 失败则 Hermes+deepseek 兜底
// 合成 → 全失败则产出带醒目横幅的「原始产出拼接」并标记 run.degraded,供评分/汇报标红、排除出对比。
function degradedDeliverable(goal: string, workerOutputs: string[]): string {
  const body = workerOutputs.join("\n\n").trim() || "(各 worker 也未产出有效内容)";
  return `> ⚠️ **合成失败(协调者过载/不可用):以下为各 worker 原始产出的拼接,不是经过综合的最终交付物。**\n\n# ${goal}\n\n${body}`;
}

// 结构提升 B · 合成输入公平配额:hermes 兜底合成的 argv 上限 ~30K 是**头部保留**截断——多 worker 时排在
// 后面的 worker 产出被整个丢掉,团队"并行覆盖面"这一核心优势在合成口悄悄流失(通宵实验团队时好时坏的
// 结构根因之一)。超预算时每个 worker 均分配额,单人超配额取"头70%+尾30%"(结论常在尾部),保证每人核心
// 内容都进合成视野。
export function fairShareOutputs(outputs: string[], budgetChars: number): { outputs: string[]; compressed: boolean } {
  const total = outputs.reduce((s, o) => s + o.length, 0);
  if (total <= budgetChars || outputs.length === 0) return { outputs, compressed: false };
  const quota = Math.max(800, Math.floor(budgetChars / outputs.length));
  return {
    compressed: true,
    outputs: outputs.map((o) => {
      if (o.length <= quota) return o;
      const head = Math.floor(quota * 0.7), tail = quota - head;
      return `${o.slice(0, head)}\n…[超合成配额,中段省略——头尾均已保留]…\n${o.slice(o.length - tail)}`;
    }),
  };
}

interface SynthResult { content: string; degraded: boolean; reason?: string; fileChanges?: FileChange[] }

// 修复交接断裂:CLI/Hermes worker 常把答案写进文件(md/json/txt)、只在回复里返回"已写到 X"这类元指针,
// 导致 lead 合成拿到的是指针而非内容。这里把该 worker 实际创建/修改的文本类交付文件内容读回,纳入其有效
// 产出 —— 合成与单 worker 直出都能拿到真正的交付内容(而非工作报告/路径)。限文本扩展名 + 总量上限。
const DELIVERABLE_EXT = /\.(md|markdown|txt|json|jsonl|csv|tsv|ya?ml|html?|tex|rst|adoc)$/i;
function readWorkerDeliverables(fileChanges: FileChange[] | undefined, root: string): string {
  if (!fileChanges?.length || !root) return "";
  const parts: string[] = [];
  let budget = 12000;
  for (const fc of fileChanges) {
    if (fc.changeType === "delete" || !DELIVERABLE_EXT.test(fc.path)) continue;
    try {
      let body = fs.readFileSync(path.join(root, fc.path), "utf-8").trim();
      if (!body) continue;
      if (body.length > budget) body = body.slice(0, budget) + "\n…(内容截断)";
      parts.push(`\n\n--- 产出文件 \`${fc.path}\` 的内容 ---\n${body}`);
      budget -= body.length;
      if (budget <= 0) break;
    } catch { /* 读不到(未 merge/二进制)则跳过 */ }
  }
  return parts.join("");
}

// P2#3 审计(确认):verifier 收到的 prompt 只有 producer 的纯文本输出,没有"这次改了哪些文件"的结构化信息,
// 逼得 verifier 自己用 shell 工具从零摸索文件在哪(实测一次 code-review 为此烧了 118K tokens、还摸了两轮)。
// 这里把该 producer 本轮的 fileChanges(与 latestOutput 同款、round 循环里同步写入)格式化成一段简短清单,
// 拼进 verifier prompt 最前面——纯加性:格式化失败/无数据都给出诚实说明,不抛错、不影响 verify 主流程。
function formatFileChangesForVerifier(fileChanges: FileChange[] | undefined): string {
  if (!fileChanges || fileChanges.length === 0) {
    return "本次改动文件:(未捕获到结构化文件变更清单,如涉及代码请自行确认实际改动范围)";
  }
  const MAX = 30;
  const lines = fileChanges.slice(0, MAX).map(fc => `- ${fc.changeType} ${fc.path}`);
  const overflow = fileChanges.length > MAX ? `\n…(另有 ${fileChanges.length - MAX} 个文件未列出)` : "";
  return `本次改动文件(共 ${fileChanges.length} 个):\n${lines.join("\n")}${overflow}`;
}

// RC3 修复:lead 常把最终报告写进文件、只在回复里回"已写到 X"这类指针 → report.md/judge 拿到的是指针
// 而非正文(实测成功 run 因此被评低分)。这里:当 lead 输出像指针(短 / 含"已写入·文件:"元叙述)且其
// fileChanges 里有更大的文本交付文件时,内联真文件内容作为最终交付物。正常内联长报告(content 本身即正文)
// 不受影响。不截断(judge 需要完整正文)。
export function inlineFinalDeliverable(content: string, fileChanges: FileChange[] | undefined, root: string): string {
  const looksPointer = content.length < 1800 || /已(生成|写入|交付|完成|产出|保存)|保存[至到]|文件\s*[:：]|written to|saved to/i.test(content);
  if (!looksPointer) return content;
  // RC3 安全护栏(实测教训):只认 .md 交付物、排除 Python/Node 环境与 vendor 目录、限 500KB,且**不扫"最大文件"**
  // ——否则会把 worker 误建 Python 环境里的大文件(实测抓过 6.4MB 的 Python 文档 changelog.html)当报告内联。
  const MD_EXT = /\.(md|markdown)$/i;
  const ENV_RE = /(^|[\\/])(\.?venv|site-packages|node_modules|pythoncore[^\\/]*|_static|[^\\/]*\.dist-info|__pycache__|\.git)([\\/]|$)/i;
  const MAX = 500_000;
  const tryRead = (p: string): string => {
    if (!MD_EXT.test(p) || ENV_RE.test(p)) return "";
    try { const b = fs.readFileSync(p, "utf-8"); return b.length <= MAX ? b.trim() : ""; } catch { return ""; }
  };
  let best = "", bestLen = content.trim().length;
  // 只读指针里**指名的 .md** 文件(不再扫"最大文件",那会误抓环境产物)。
  const PATH_RE = /[`"']([^`"'\n]+?\.(?:md|markdown))[`"']|(?:保存[至到]|saved to|written to|文件\s*[:：])\s*([^\s`"'\n]+\.(?:md|markdown))/gi;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(content)) !== null) {
    const raw = (m[1] || m[2] || "").trim();
    if (!raw) continue;
    for (const cand of [raw, root ? path.join(root, raw) : ""].filter(Boolean)) {
      const body = tryRead(cand);
      if (body.length > bestLen) { best = body; bestLen = body.length; }
    }
  }
  // 退化:仅当指针没指名路径时,扫 fileChanges 里的 **.md**(排环境、限大小),取最大。
  if (!best && fileChanges?.length && root) {
    for (const fc of fileChanges) {
      if (fc.changeType === "delete") continue;
      const body = tryRead(path.join(root, fc.path));
      if (body.length > bestLen) { best = body; bestLen = body.length; }
    }
  }
  return best || content;
}

async function synthesizeWithFallback(lead: AgentNodeConfig, summaryPrompt: string, workerOutputs: string[], goal: string): Promise<SynthResult> {
  let primaryErr: string | undefined;
  // (a) 主协调者 — 引擎级已对 529/超时做退避重试。用 runViaEngine(而非 runAgent)以拿回 lead 的
  //     fileChanges,供 RC3 内联(lead 把报告写进文件、只回指针时,把真文件读回当交付物)。
  try {
    const r = await runViaEngine(lead, getRolePrompt("lead"), summaryPrompt);
    if (r.status === "done" && r.content && r.content.trim()) return { content: r.content, degraded: false, fileChanges: r.fileChanges };
    primaryErr = r.error || `${lead.id}: ${r.status}`;
  } catch (e: any) {
    primaryErr = e?.message || String(e);
  }
  // (b) 便宜兜底协调者:API 引擎 + deepseek(本机已验证可用)。贵-framework 互备(codex)本机未装且
  //     model 映射脆弱,故本轮不做(失败会直接落到显式降级)。仅当主协调者明确失败/空时启用。
  const fb: AgentNodeConfig = { ...lead, framework: "api", provider: "deepseek", model: "deepseek-chat" };
  try {
    const r = await runViaEngine(fb, getRolePrompt("lead"), summaryPrompt);
    if (r.status === "done" && r.content && r.content.trim()) return { content: r.content, degraded: false, reason: `主协调者(${lead.framework})失败,已由备用引擎+deepseek 兜底合成`, fileChanges: r.fileChanges };
  } catch { /* 落到显式降级 */ }
  // (c) 所有协调者都失败 → 显式降级交付物(绝不伪造成功)
  return { content: degradedDeliverable(goal, workerOutputs), degraded: true, reason: primaryErr || "协调者过载/不可用,合成失败" };
}

// AI Research Company · 证据表:合成 prompt 里要求模型在正文后另起一段,用 ```evidence_table 代码块
// 包裹一个 JSON 数组自证结论(见 EVIDENCE_TABLE_INSTRUCTION)。这里做纯字符串/JSON 提取,best-effort ——
// 没有代码块、JSON 非法、或 JSON 形状不对,一律静默返回 undefined,绝不抛出/绝不影响报告主流程。
const EVIDENCE_TABLE_FENCE_RE = /```evidence_table\s*([\s\S]*?)```/i;
const EVIDENCE_CONFIDENCE = new Set(["high", "medium", "low"]);

export function extractEvidenceTable(text: string): EvidenceRow[] | undefined {
  if (!text) return undefined;
  const m = EVIDENCE_TABLE_FENCE_RE.exec(text);
  if (!m) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(m[1].trim()); } catch { return undefined; }
  if (!Array.isArray(parsed)) return undefined;
  const rows: EvidenceRow[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const claim = typeof (item as any).claim === "string" ? (item as any).claim.trim() : "";
    const source = typeof (item as any).source === "string" ? (item as any).source.trim() : "";
    const confidence = (item as any).confidence;
    if (!claim || !source || !EVIDENCE_CONFIDENCE.has(confidence)) continue; // 形状不对 → 丢弃这一条,不报错
    const urlRaw = (item as any).url;
    const url = typeof urlRaw === "string" && urlRaw.trim() ? urlRaw.trim() : undefined;
    rows.push(url ? { claim, source, url, confidence } : { claim, source, confidence });
    if (rows.length >= 8) break; // 与 prompt 要求的 3-8 条上限对齐
  }
  return rows.length > 0 ? rows : undefined;
}

// 从最终展示文本里去掉 evidence_table 代码块本身(它是给结构化解析用的附加段,不该在报告正文里以原始 JSON 出现)。
export function stripEvidenceTableBlock(text: string): string {
  if (!text || !EVIDENCE_TABLE_FENCE_RE.test(text)) return text;
  return text.replace(EVIDENCE_TABLE_FENCE_RE, "").replace(/\n{3,}/g, "\n\n").trimEnd();
}

// 追加到合成 prompt 末尾的指令:仅对研究/事实类任务(非纯 coding)附加,避免给写代码的 lead 徒增噪音。
const EVIDENCE_TABLE_INSTRUCTION = `\n\n请在报告正文结束后,另起一段,用 \`\`\`evidence_table 代码块包裹一个 JSON 数组,列出本次结论最重要的 3-8 条可验证证据,每条包含 claim(论点)/source(来源)/url(链接,可选)/confidence(high|medium|low 三选一),例如:\n\`\`\`evidence_table\n[{"claim":"...","source":"...","url":"...","confidence":"high"}]\n\`\`\`\n如果没有可验证的具体证据,可以省略这一段,不要编造。`;

// 覆盖度优先(治 LEAD 综合的有损压缩):三臂实测发现 LEAD 把 3 研究员的产出"综合"成更短的报告时,会为求
// 简洁而删减/合并掉各成员独有的要点,导致团队最终报告的覆盖面反而低于单个强模型(HB-1:团队压成1791字符/
// 覆盖69% vs opus 6489字符/100%)。研究/分析类交付的评判核心是【覆盖多少独立要点/维度】,故合成必须做**并集式
// 覆盖**,绝不为简洁牺牲覆盖面。仅用于非编码 run(编码交付不吃这条)。
const COVERAGE_PRESERVE_INSTRUCTION = `\n\n📋 **覆盖度优先(硬要求,评分核心)**:本交付物按【覆盖了多少独立要点/维度/事实】评判。请把每一位 worker 提到的**所有独立要点、事实、数据、维度、子问题、权衡、例子、反例**全部**并入**最终报告——做**并集式覆盖**,绝不为求简洁而删减、合并或跳过任何一位 worker 独有的内容。**宁可长而全,绝不短而漏**:最终报告的覆盖面必须 ≥ 各 worker 覆盖面的并集。可以用清晰的小节/列表组织以便阅读,但每一个要点都要保留其具体内容(不要退化成一句话概括)。如果多位 worker 覆盖了同一维度,合并去重但保留最完整的那份细节。`;

function deferReasonZh(r: DeferredTask["reason"]): string {
  switch (r) {
    case "provider_unavailable": return "供应商/框架不可用（缺少 API Key 或框架未实现）";
    case "timeout": return "执行超时";
    case "quality_gate_failed": return "多次质量门未通过";
    case "retry_budget_exhausted": return "重试次数用尽";
    case "no_account": return "无可用账号（调度超时）";
    case "run_budget_exhausted": return "本次运行 token 预算用尽（已收尾未跑的任务）";
    case "run_sla_exceeded": return "本次运行达到时间上限（已停止派发新任务）";
    case "cancelled": return "用户已停止本次运行";
    case "no_progress": return "工具循环连续重复且没有产生进展（已停止空转）";
    case "workspace_quota_exceeded": return "工作区磁盘配额超限（该任务已终止,未伪造产出）";
    case "no_file_changes": return "编码任务未产生任何文件变更（产出未落盘到工作区,不当作成功交付）";
    case "invalid_working_directory": return "员工 workingDirectory 非法（须为工作区内相对路径），该 worker 干净失败,绝不静默退回工作根执行";
    case "no_producer_output": return "producer 无任何文件产物 → 跳过独立验证（不空跑烧 token；run 级仍诚实判 no_delivery）";
  }
}

function buildDeferredSection(deferred: DeferredTask[]): string {
  if (deferred.length === 0) return "";
  const rows = deferred.map(d => {
    const a = agents.find(x => x.id === d.agentId);
    return `- **${a?.name ?? d.agentId}** — ${deferReasonZh(d.reason)}（尝试 ${d.attempts} 次）\n  - 任务: ${d.goal.slice(0, 160)}${d.lastError ? `\n  - 最后错误: ${d.lastError.slice(0, 200)}` : ""}`;
  }).join("\n");
  return `\n\n## ⏸️ 待处理任务清单（${deferred.length}）\n以下任务在预算内未能完成，已跳过并在此统一整理（未伪造成功）：\n${rows}`;
}

interface WorkerAssignment {
  workerId: string;
  task: string;
}

interface LeadAssignment {
  leadId: string;
  task: string;
  workers: WorkerAssignment[];
}

interface ParsedPlan {
  plan: string;
  leads: LeadAssignment[];
  summary: string;
}

export function parseCeoPlan(text: string): ParsedPlan | null {
  try {
    const planMatch = text.match(/## PLAN\s*\n([\s\S]*?)(?=## LEAD:|## SUMMARY|$)/);
    const plan = planMatch ? planMatch[1].trim() : "";

    const leadSections: LeadAssignment[] = [];
    // P2: CEO 只产出 `## LEAD: <id>` + 团队级 Task；Sub-tasks 块已不再要求（变可选）。
    // group3 = Task 行之后到下一段之间的尾巴，里面可能（向后兼容旧格式）含 Sub-tasks 的 worker 行。
    const leadRe = /## LEAD:\s*(\S+)\s*\nTask:\s*([^\n]+)([\s\S]*?)(?=## LEAD:|## SUMMARY|$)/g;
    let m: RegExpExecArray | null;
    while ((m = leadRe.exec(text)) !== null) {
      const leadId = m[1].trim();
      const task = m[2].trim();
      const tail = m[3] || "";
      const subMatch = tail.match(/Sub-tasks:\s*([\s\S]*)/);
      const subTasksBlock = subMatch ? subMatch[1].trim() : "";
      const workers: WorkerAssignment[] = [];

      if (subTasksBlock) {
        const workerRe = /^[-*]\s+(\S+?):\s*(.+)$/gm;
        let wm: RegExpExecArray | null;
        while ((wm = workerRe.exec(subTasksBlock)) !== null) {
          workers.push({ workerId: wm[1].trim(), task: wm[2].trim() });
        }
      }

      // P2: 即使没有 worker 行也保留该 lead 段——worker 由 Lead 自拆填充。
      if (task) {
        leadSections.push({ leadId, task, workers });
      }
    }

    const summaryMatch = text.match(/## SUMMARY\s*\n([\s\S]*)$/);
    const summary = summaryMatch ? summaryMatch[1].trim() : "";

    if (leadSections.length === 0) return null;
    return { plan, leads: leadSections, summary };
  } catch {
    return null;
  }
}

// v5 P2a: parse a lead's worker-plan output. Lines "- <workerId>: <task>" matched against the
// lead's actual workers; dedupe by workerId, keep only valid ids.
export function parseWorkerLines(text: string, validIds: string[]): WorkerAssignment[] {
  const out: WorkerAssignment[] = [];
  const seen = new Set<string>();
  for (const raw of (text || "").split("\n")) {
    const m = raw.match(/^\s*[-*]?\s*([a-zA-Z0-9_-]+)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    if (!validIds.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ workerId: id, task: m[2].trim() });
  }
  return out;
}

// Fix C 审计(确认):classifyTaskScale/clampLeadsForScale 只钳"用现有 roster 里几个人",不影响
// "给某个角色分配了空/敷衍任务时是否还要真的跑它"——马里奥这类小任务里 tester/security 各自只拿到一句
// 敷衍指令,陪跑一轮只烧掉约 2000 token、无实质产出。这里判定一条派工是否"无实质工作项":
// 空字符串 / 去空白后 <10 字符的极短占位文本 / 内容就是该 worker 的角色名或 workerId 或姓名本身(去除
// 标点空白后完全相同)。命中即视为敷衍,调用方不 recruit/dispatch 该 worker。
export function isTrivialDispatch(task: string, worker?: Pick<AgentNodeConfig, "id" | "role" | "name">): boolean {
  const t = (task || "").trim();
  if (t.length < 10) return true;
  if (!worker) return false;
  const bare = t.toLowerCase().replace(/[\s\-_:：,，.。!！]/g, "");
  const roleBare = (worker.role || "").toLowerCase().replace(/[\s\-_]/g, "");
  const idBare = (worker.id || "").toLowerCase().replace(/[\s\-_]/g, "");
  const nameBare = (worker.name || "").toLowerCase().replace(/[\s\-_]/g, "");
  if (bare && (bare === roleBare || bare === idBare || (nameBare && bare === nameBare))) return true;
  return false;
}

// v5 P2b: parse a lead's review of worker outputs. Lines "- <workerId>: ACCEPT" or
// "- <workerId>: REDO: <feedback>" (中英/通过/返工 均识别). Default非ACCEPT → 视为打回。
export function parseReviewDecisions(text: string, workerIds: string[]): { workerId: string; accept: boolean; feedback?: string }[] {
  const out: { workerId: string; accept: boolean; feedback?: string }[] = [];
  const seen = new Set<string>();
  for (const raw of (text || "").split("\n")) {
    const m = raw.match(/^\s*[-*]?\s*([a-zA-Z0-9_-]+)\s*[:：]\s*(.+)$/);
    if (!m) continue;
    const id = m[1].trim();
    if (!workerIds.includes(id) || seen.has(id)) continue;
    const rest = m[2].trim();
    seen.add(id);
    if (/^(accept|通过|ok|pass|采纳|满意)/i.test(rest)) out.push({ workerId: id, accept: true });
    else out.push({ workerId: id, accept: false, feedback: rest.replace(/^(redo|返工|打回|reject)\s*[:：]?\s*/i, "").trim() || rest });
  }
  return out;
}

function buildFallbackAssignments(goal: string, agents: AgentNodeConfig[]): LeadAssignment[] {
  const leadMap: Record<string, string[]> = {
    "engineering-lead": ["code", "implement", "build", "fix", "bug", "feature", "refactor", "frontend", "backend", "api", "test", "app", "ui", "component", "function", "module", "refactor"],
    "product-lead": ["product", "spec", "design", "requirement", "prd", "user story", "ux", "research"],
    "review-lead": ["review", "security", "audit", "quality", "check", "validate"],
  };

  const goalLower = goal.toLowerCase();
  const assignedLeads: LeadAssignment[] = [];

  for (const [leadId, keywords] of Object.entries(leadMap)) {
    const lead = agents.find(a => a.id === leadId);
    if (!lead) continue;
    if (keywords.some(kw => goalLower.includes(kw))) {
      const workers: WorkerAssignment[] = lead.childrenIds.map(cid => {
        const worker = agents.find(a => a.id === cid);
        const roleHint = worker ? ` (${worker.role})` : "";
        return { workerId: cid, task: `Work on: ${goal} — your role is ${cid}${roleHint}` };
      });
      assignedLeads.push({ leadId, task: `Coordinate work on: ${goal}`, workers });
    }
  }

  if (assignedLeads.length === 0) {
    const engLead = agents.find(a => a.id === "engineering-lead");
    const revLead = agents.find(a => a.id === "review-lead");
    if (engLead) {
      assignedLeads.push({
        leadId: "engineering-lead",
        task: `Coordinate implementation for: ${goal}`,
        workers: engLead.childrenIds.map(cid => {
          const worker = agents.find(a => a.id === cid);
          const roleHint = worker ? ` (${worker.role})` : "";
          return { workerId: cid, task: `Work on: ${goal} — your role is ${cid}${roleHint}` };
        }),
      });
    }
    if (revLead) {
      assignedLeads.push({
        leadId: "review-lead",
        task: `Review work for: ${goal}`,
        workers: revLead.childrenIds.map(cid => {
          const worker = agents.find(a => a.id === cid);
          const roleHint = worker ? ` (${worker.role})` : "";
          return { workerId: cid, task: `Review: ${goal} — your role is ${cid}${roleHint}` };
        }),
      });
    }
  }

  return assignedLeads;
}

// v8 #3 — 确定性团队数收敛。CEO 计划解析后唯一的"机器级"收敛点：不靠 LLM 遵守提示词，
// 用纯启发式按任务规模钳制团队数（多团队=peer-lead 通道+跨团队总结+评审轮+多次 lead 拆解，
// 是小任务烧 token 的主因）。保守：默认不钳；EXPAND 关键词放行多团队；永不删 engineering-lead。
export function classifyTaskScale(goal: string): "trivial" | "expand" | "default" {
  const g = (goal || "").toLowerCase();
  // 明确需要多团队/多角色的信号 → 放行（优先级最高，避免误钳真正复杂的任务）
  const EXPAND = [
    "多个模块", "多组件", "multi-component", "研究", "research", "调研", "安全审计", "security", "audit",
    "渗透", "重构整个", "重构", "端到端", "full stack", "fullstack", "architecture", "架构", "migrate",
    "迁移", "pipeline", "集成", "integration", "系统", "spec", "prd", "评审", "review",
  ];
  const hasScaleKeyword = (keyword: string): boolean => {
    if (!/[a-z]/i.test(keyword)) return g.includes(keyword);
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?:$|[^a-z0-9_])`, "i").test(g);
  };
  if (EXPAND.some(hasScaleKeyword)) return "expand";
  // 明确的极小任务 → 收敛到 1 团队 1 人
  // Fix C:扩充"小型自包含创作/编码"信号词——马里奥小游戏这类任务此前落不进 TRIVIAL(无关键词命中),
  // 全走 default 规模,团队铺得比任务本身还大。
  const TRIVIAL = [
    "一行", "单个文件", "单文件", "一个文件", "typo", "改个", "加一行", "新建文件", "建一个文件",
    "写一个文件", "one file", "single file", "one line", "rename", "readme",
    "小游戏", "demo", "原型", "toy", "prototype", "小工具", "小程序",
  ];
  if (TRIVIAL.some(k => g.includes(k))) return "trivial";
  return "default";
}

// G2 · Core 确定性组队规模决策(零 LLM · 渐进式动态组队):关键词分类(classifyTaskScale)+ 复杂度估算
// (estimateTaskComplexity)合成最终 teamScale。complexity L/XL → expand(升级,防"措辞普通实则复杂"被缩编);
// 否则关键词优先;关键词 default + complexity S → trivial(降级,防"措辞普通的小任务"被铺满编团队)。
// 纯函数、可单测、绝不额外调模型——组队决定由 Core 确定性规则完成,不烧 CEO/lead LLM。
//   trivial → 单 producer(+按需独立 tester);default(medium)→ lead+producer+tester(缩编到 1 producer+验证);
//   expand → 保留完整团队(reviewer/specialist 按需)。
export function resolveEffectiveScale(goal: string): { scale: "trivial" | "default" | "expand"; reason: string } {
  const kw = classifyTaskScale(goal);
  const est = estimateTaskComplexity({ goalText: goal, hasCodeSignals: taskRequiresCode(goal) });
  if (kw === "expand" || est.complexity === "L" || est.complexity === "XL") {
    return { scale: "expand", reason: `expand(关键词=${kw}/复杂度=${est.complexity})→ 保留完整团队` };
  }
  if (kw === "trivial" || est.complexity === "S") {
    return { scale: "trivial", reason: `trivial(关键词=${kw}/复杂度=${est.complexity})→ 单 producer(+按需 tester)` };
  }
  return { scale: "default", reason: `medium(关键词=${kw}/复杂度=${est.complexity})→ lead+producer+tester(缩编)` };
}

// ??????????????????? verification edge ????????????????
// ??????? review edge ???????????????
// Run budgets apply to the whole collaboration, not each individual worker. Split
// the remaining allowance across a concurrent batch so a single fan-out cannot
// overrun the run cap by giving every worker the full per-task allowance.
export function clampTaskBudgetToRemaining(
  maxTokensPerTask: number,
  maxTokensPerRun: number | undefined,
  consumedTokens: number,
  concurrentCalls = 1,
): number {
  const taskCap = Math.max(1, maxTokensPerTask);
  if (!maxTokensPerRun || maxTokensPerRun <= 0) return taskCap;
  const remaining = Math.max(0, maxTokensPerRun - Math.max(0, consumedTokens));
  if (remaining === 0) return 0;
  return Math.min(taskCap, Math.max(1, Math.floor(remaining / Math.max(1, concurrentCalls))));
}
// API keys may intentionally live only in OPC_KEYS_DIR or process env and therefore
// must never be copied into accounts.json. The scheduler still needs a capacity record,
// so add an in-memory, keyless API account for each resolvable configured provider.
export function withResolvedApiKeyAccounts(
  accounts: ProviderAccount[],
  agents: Pick<AgentNodeConfig, "provider">[],
  resolveKey: (providerId: string) => string | undefined,
): ProviderAccount[] {
  const out = [...accounts];
  for (const providerId of new Set(agents.map((agent) => agent.provider).filter(Boolean))) {
    if (out.some((account) => account.providerId === providerId && (!account.frameworks || account.frameworks.includes("api")))) continue;
    if (!resolveKey(providerId)) continue;
    out.push({
      id: `${providerId}#resolved-key`,
      providerId,
      label: `${providerId} configured key`,
      apiKey: "",
      frameworks: ["api"],
      enabled: true,
      maxConcurrent: 1,
    });
  }
  return out;
}
export function shouldUseCodingPipeline(runRequiresCode: boolean, runForbidsCode: boolean, leadTask = ""): boolean {
  return !runForbidsCode && (runRequiresCode || taskRequiresCode(leadTask));
}

// G3 · 渐进缩编纯函数(可确定性单测):按 effective scale 把团队成员收敛到最小集。expand → 原样保留(完整团队);
// trivial/medium → 编码 run 选 1 producer(pickCodeReviewProducer)+ 【仅当 requiresTests】1 个独立 verifier;
// 非编码 → 1 worker。铁律:只裁 producer,绝不移除 verifier(requiresTests 缺 verifier 交由下游 no_available_verifier
// 诚实 capability_blocked)。零 LLM。
export function capTeamWorkers(
  teamWorkerIds: string[],
  opts: { scale: "trivial" | "default" | "expand"; isCodingRun: boolean; requiresTests: boolean;
    roleOf: (id: string) => string | undefined; edges: Parameters<typeof pickCodeReviewProducer>[1] },
): { workers: string[]; verifierGovernance?: "edge_verifier_missing" } {
  if (opts.scale === "expand") return { workers: teamWorkerIds };
  if (opts.isCodingRun) {
    const picked = pickCodeReviewProducer(teamWorkerIds.map((id) => ({ id, role: opts.roleOf(id) ?? "" })), opts.edges);
    if (!picked) return { workers: teamWorkerIds.slice(0, 1) };
    if (!opts.requiresTests) return { workers: [picked] };
    // P1(审计修复)· 按配置的 VerificationEdge 精确选 verifier。分两种:
    //  ①【有匹配边】:只能用边指定的 verifier 角色(dev→code_reviewer 就必须留 code_reviewer);该角色【缺失】→
    //    【绝不用普通 tester 顶替】(那会静默把"已满足 code-review 契约"这件事伪装成真)→ producer-only + 标
    //    verifierGovernance:edge_verifier_missing,交调用方 emit governance_degraded、下游 no_available_verifier 诚实拦。
    //  ②【无匹配边】:显式 fallback 任一 verifier 角色(通用独立验证,合法)。
    const producerRole = opts.roleOf(picked) ?? "";
    const edgeVerifierRoles = (opts.edges ?? []).filter((e) => e.producer === producerRole).map((e) => e.verifier);
    if (edgeVerifierRoles.length) {
      const verifierId = teamWorkerIds.find((id) => id !== picked && edgeVerifierRoles.includes(opts.roleOf(id) ?? ""));
      return verifierId ? { workers: [picked, verifierId] } : { workers: [picked], verifierGovernance: "edge_verifier_missing" };
    }
    const verifierId = teamWorkerIds.find((id) => id !== picked && isVerifierRole(opts.roleOf(id) ?? ""));
    return { workers: verifierId ? [picked, verifierId] : [picked] };
  }
  return { workers: teamWorkerIds.slice(0, 1) };
}

// 纯函数：把解析+兜底后的 leadAssignments 按规模钳制。便于确定性单测（不靠真实 LLM run）。
// - expand：原样返回（允许多 lead/多 worker）。
// - trivial：只保留主 lead（优先 engineering-lead，否则第一个），worker 截断为 1。
// - default：>1 团队时收敛到单团队（优先 engineering-lead），团队内 worker 数仍由 lead 自拆决定。
export function clampLeadsForScale(leads: LeadAssignment[], goal: string, scaleOverride?: "trivial" | "expand" | "default"): LeadAssignment[] {
  if (leads.length === 0) return leads;
  const scale = scaleOverride ?? classifyTaskScale(goal);
  if (scale === "expand") return leads;
  const primary = leads.find(la => la.leadId === "engineering-lead") ?? leads[0];
  if (scale === "trivial") return [{ ...primary, workers: primary.workers.slice(0, 1) }];
  // default
  if (leads.length > 1) return [primary];
  return leads;
}

// Tokens are the common accounting unit for API and subscription engines.
// Monetary cost remains historical metadata only.
function getCumulativeTokens(): number {
  try { return loadRunIndex(projectRoot).reduce((s, r) => s + (r.totalTokens ?? 0), 0); } catch { return 0; }
}

// Stage 2 · Run Type / Team Mode(产品契约)。TeamMode/effEngineForMode 已随执行漏斗迁入
// workerRuntime.ts(B2 解耦),此处 re-export 保持既有 import 面(routes/tests)不变。
export type RunType = "quick" | "team";
export type { TeamMode } from "./workerRuntime.js";
export { effEngineForMode } from "./workerRuntime.js";

// P0(活体抓出 · 多agent主路径)· 编码 run 的兜底派工必须【角色化 + 可执行】:lead 拆分失败时,绝不把整条编码
// 目标广播给全队——architect/ops/docs/security 领到编码任务→零文件变更→deferred→拖垮整 run(用户实测 isprime
// run 正是如此败)。只选 1 个**可用**的 coder(优先 code-review producer)+(要求测试则)1 个**可用**的 verifier;
// 非 coder/verifier 角色(ops/docs/security/pm)一律不入选;无可用 coder → 返回 failReason,调用方在启动前干净
// 失败(不裸 throw)。availability 由调用方按【生效引擎】(effEngineForMode 后的 provider/framework)传入,与
// scheduler.hasCapacity 同口径,避免 economy/balanced 的 override 查错账号池误判。纯函数,便于单测。
export function selectCodingFallbackWorkers(
  teamWorkerIds: string[],
  agents: AgentNodeConfig[],
  leadTask: string,
  opts: {
    requiresTests: boolean;
    verificationEdges: Parameters<typeof pickCodeReviewProducer>[1];
    isAvailable: (agent: AgentNodeConfig) => boolean;
  },
): { workers: Array<{ workerId: string; task: string }>; failReason?: string } {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const members = teamWorkerIds.map((id) => byId.get(id)).filter((a): a is AgentNodeConfig => !!a);
  const availCoders = members.filter((a) => isCoderRole(a.role) && opts.isAvailable(a));
  const availTesters = members.filter((a) => isVerifierRole(a.role) && opts.isAvailable(a));
  if (availCoders.length === 0) return { workers: [], failReason: "no_available_executor" };
  const producerId = pickCodeReviewProducer(members.map((a) => ({ id: a.id, role: a.role })), opts.verificationEdges);
  const coder = availCoders.find((a) => a.id === producerId) ?? availCoders[0];
  const workers: Array<{ workerId: string; task: string }> = [{ workerId: coder.id, task: leadTask }];
  if (opts.requiresTests) {
    // P0(用户审计)· 要求测试却无【独立】可用 verifier → 绝不放行 producer 自测冒充"已验证":
    // 独立验证是 DeliveryAcceptance 的硬前提,少了它这条 run 只能干净失败(no_available_verifier),不能降级成开发者自测 done。
    const tester = availTesters.find((a) => a.id !== coder.id);
    if (!tester) return { workers: [], failReason: "no_available_verifier" };
    workers.push({ workerId: tester.id, task: `运行测试验证上游 ${coder.role} 对「${leadTask.slice(0, 80)}」的产出:在工作目录内跑真实测试(node/npm/pytest),如实报告命令、退出码、输出。不要写新代码。` });
  }
  return { workers };
}
// run 级(run 严格串行,模块变量安全);runEngineCore 据此算有效引擎。
let activeTeamMode: TeamMode | undefined;
// Stage 6 · 交叉验证(run 级):仅当公司声明 verification_edges 时启用;否则空 → 全程不触发(现有公司字节不变)。
let activeVerificationEdges: VerificationEdge[] = [];
let runVerificationResults: VerificationResultRecord[] = [];
// E3 · Run Governance(run 级):startRun 开头判级(runLifecycle 钩子,幂等)后缓存;
// 作为 gate 强度参数传入 runQualityGateLayers(合流点 E3→A5),L2/L3 时驱动 workspace 观察记录。
let activeGovernanceLevel: GovernanceLevel | undefined;
let runInFlight = false;                       // P0#7:startRun 并发互斥闸(模块级 run 状态不可共存)
const stopRequests = new Set<string>();
let activeRunAbortController: AbortController | null = null;
// 外部停止会中断当前模型/工具调用,并保留停止标志阻止后续派发。已有产出仍进入诚实收口。
export function requestStopRun(runId: string): boolean {
  stopRequests.add(runId);
  const active = runInFlight && activeRunId === runId;
  if (active) activeRunAbortController?.abort(new Error("user requested stop"));
  return active;
}

// 供路由层在派发前探测互斥闸(governance 批准派发撞闸时保留审批不烧 run,见 governanceRoutes)。
export function isRunInFlight(): boolean { return runInFlight; }

// P0(用户审计)· 启动能力闸被跳过的干净失败信号:缺 required 引擎/key 时,run 启动前抛此错,
// 绝不进 CEO/派工/伪造 done。区别于普通 Error,供路由层/mission 派发点识别为"能力不足"而非崩溃。
export class CapabilityBlockedError extends Error {
  constructor(public readonly blockedBy: string[]) {
    super(`capability_blocked: ${blockedBy.length ? blockedBy.join("; ") : "缺少必要的引擎或 API Key"}`);
    this.name = "CapabilityBlockedError";
  }
}

// 五.2(收口作战令)· 脏树 preflight 干净失败信号:编码团队 run 起跑前发现绑定工作目录有未提交/未跟踪
// 文件(排除 .opc)时抛此错,不进 CEO/派工。消息列脏文件(≤10)+ 指引"提交/stash/或取消"。
export class DirtyWorkspacePreflightError extends Error {
  readonly code = "dirty_workspace_preflight";
  constructor(public readonly fileCount: number, public readonly files: string[], more = "") {
    super(`起跑前置检查失败:绑定的工作目录有 ${fileCount} 个未提交/未跟踪文件,编码团队任务会与它们产生合并冲突风险。请先提交(commit)、暂存(stash)或清理这些改动,或取消本次任务后重试。脏文件:${files.join(", ")}${more}`);
    this.name = "DirtyWorkspacePreflightError";
  }
}

// 令五.4 · 观测任务图终态收敛:Chat 英雄回路 / 普通 mission 派发的 run 绑定一张"计划视图"任务图
// (单 orchestrator run 整体执行,节点级实时状态不逐个驱动)。run 收尾时把整图与 run 终态对齐:
// run failed → 图 failed、未终结节点标 failed;否则 → 图 completed、未终结节点标 completed。
// 诚实边界:不伪造逐节点独立执行证据,只反映"这张计划由这个 run 整体执行,最终成/败如此"。
// 已终结(completed/accepted/failed)的节点不覆盖(mission task-graph 逐节点驱动的图不走这里——它们的
// run 无 missionId/taskGraphId 关联;此函数只认本 run 绑定的那张图)。加性 best-effort,任何异常吞掉。
export function reconcileObservabilityGraph(projectRoot: string, run: Run): void {
  try {
    if (!run.taskGraphId && !run.missionId) return;
    let graph: TaskGraph | undefined;
    if (run.taskGraphId) graph = getTaskGraph(projectRoot, run.taskGraphId);
    if (!graph && run.missionId) graph = getTaskGraphByMission(projectRoot, run.missionId);
    if (!graph) return;
    const failed = run.finalState === "failed" || run.status === "failed";
    const terminalGraph: TaskGraph["status"] = failed ? "failed" : "completed";
    if (graph.status === terminalGraph) return; // 幂等:已收敛不重复写
    const now = new Date().toISOString();
    const nodeTarget: TaskNodeStatus = failed ? "failed" : "completed";
    for (const n of graph.nodes) {
      if (n.status === "completed" || n.status === "accepted" || n.status === "failed") continue;
      n.status = nodeTarget;
      n.statusHistory.push({ status: nodeTarget, at: now, by: "core" });
      if (failed && !n.error) n.error = run.degradedReason || "run 未成功完成";
    }
    graph.status = terminalGraph;
    graph.updatedAt = now;
    upsertTaskGraph(projectRoot, graph);
  } catch { /* 观测任务图收敛是加性,失败绝不影响 run 收尾 */ }
}

export async function startRun(goal: string, preGeneratedRunId?: string, companyId?: string, opts?: { teamMode?: TeamMode; runType?: RunType; forceSkills?: string[]; targetAgentId?: string; missionId?: string; taskGraphId?: string }): Promise<{ runId: string; summary: string }> {
  // P0#7 并发闸:run 状态全是模块级变量,第二个并发 run 会污染第一个的事件流/预算/通道(审计确认)。
  // 显式互斥:同一时刻只允许一个 active run(与"绝不并发 run"的运行纪律一致),后到者立即报错而非静默串扰。
  if (runInFlight) throw new Error(RUN_IN_FLIGHT_ERROR);
  runInFlight = true;
  let pidRegistryRunId: string | null = null; // E4:L3 run 的 pid 登记窗口,外层 finally 保证清理
  try { // ← 外层守卫:无论如何退出都释放并发闸(内层 try 负责 run 状态兜底)
  activeTeamMode = opts?.teamMode;
  const runType: RunType = opts?.runType ?? "team";
  // 每次 run 重载 agents(运行时改公司/团队无需重启)+ 可选锁定到指定公司(受控 A/B:对比不同团队设计)。
  {
    const all = loadAgents(projectRoot, DEFAULT_AGENTS).map(a => ({ framework: "api" as const, companyId: "default", ...a }));
    agents = companyId ? all.filter(a => a.companyId === companyId) : all;
  }
  const config = loadConfig(projectRoot);
  // Monetary estimates remain legacy telemetry only. Token usage is the execution budget.
  // v10 P0-2: token-based total gate — covers subscription engines (cost=0) the USD gate can't see.
  const maxTokensTotal = config.budget.maxTokensTotal ?? 0;
  if (maxTokensTotal > 0) {
    const cumulativeTokens = getCumulativeTokens();
    if (cumulativeTokens >= maxTokensTotal) {
      throw new Error(`Token budget exceeded: ${cumulativeTokens} of ${maxTokensTotal} limit.`);
    }
  }

  if (companyId) enforceCompanyTokenLimit(projectRoot, companyId);

  // P0(用户审计)· 启动能力闸【权威点】——放进 startRun,使【所有】派发入口(chat/task、mission-approve、
  // governance 批准、队列出队)都过同一道闸,而非只靠 chatRoutes 那一处前置检查。两个被审计抓出的漏洞在此根治:
  //   ① quick 编码任务:下方分诊会把 quick 编码目标强制开团队(taskRequiresCode(goal)),故【有效 team 语义】=
  //      runType==="team" || taskRequiresCode(goal);预检必须按此判,不能因原始 runType==="quick" 就整段跳过。
  //   ② teamMode 后的生效引擎:buildCapabilityReport 传 { teamMode, runType:"team" },按 effEngineForMode 解析
  //      的真实 provider/framework 判可用(与 scheduler 同口径),不再按默认引擎误报 canRun。
  // 缺 required 引擎/key → 启动前抛 CapabilityBlockedError 干净失败,绝不进 CEO/派工/伪造 done。报告生成本身
  // 失败(公司不存在等)不阻塞(fail-open,留给既有流程),只有明确 canRun===false 才拦。
  const runId = preGeneratedRunId || uuid();

  let runCapabilityReport: Awaited<ReturnType<typeof buildCapabilityReport>> | null = null;
  if (companyId && (runType === "team" || taskRequiresCode(goal))) {
    let blockedBy: string[] | null = null;
    try {
      runCapabilityReport = await buildCapabilityReport(projectRoot, companyId, {}, { teamMode: activeTeamMode, runType: "team" });
      if (!runCapabilityReport.canRun) blockedBy = runCapabilityReport.blockedBy;
    } catch { /* 报告生成失败(公司不存在等)不阻塞 */ }
    if (blockedBy) {
      // MUP 矩阵5 · provider 能力不足诚实失败要留证:经 storage 层(governanceStore)落一条 dispatch_blocked
      // 事件(detail 前缀 capability_blocked,与 CapabilityBlockedError.message 同口径),供活体验收/审计从
      // governance-records.json 取证。先确保 record 存在(decideAndRecordRunGovernance 幂等),留证失败不掩盖拦截。
      try {
        decideAndRecordRunGovernance(projectRoot, { runId, goal, companyId });
        appendGovernanceEvent(projectRoot, runId, {
          kind: "dispatch_blocked",
          detail: `capability_blocked: ${blockedBy.join("; ")}`,
        });
      } catch { /* 留证 best-effort */ }
      throw new CapabilityBlockedError(blockedBy);
    }
  }

  // E3 · Run Governance:启动即判级 + 落 record(幂等——路由层 precreate 时已判过则直接复用)。
  // E4 · L3 网关:未批准的 L3 run 在这里被真正拦下("未批不派发"的最终执行点,路由层的检查只是
  // 更友好的前置提示)。判级失败不拦 run(治理是加性防线,自身故障不能变成新的失败面)。
  {
    let governanceBlocked: string | null = null;
    try {
      const record = decideAndRecordRunGovernance(projectRoot, { runId, goal, companyId });
      activeGovernanceLevel = record.level;
      if (record.approvalRequired && record.approval?.status !== "approved") {
        // 先定拦截再 best-effort 落事件:安全闸只许 fail-closed,阻断不能依赖 dispatch_blocked 写盘成功。
        governanceBlocked = `run ${runId} 被 Run Governance 判为 L3(${record.reason[record.reason.length - 1] ?? "高风险"}),需人工审批后才能派发(POST /api/governance/runs/${runId}/approve)`;
        try { checkGovernanceDispatch(projectRoot, runId); } catch { /* 事件写失败不影响拦截 */ }
      }
    } catch { activeGovernanceLevel = undefined; }
    if (governanceBlocked) throw new Error(governanceBlocked);
  }
  // E4 · L3 pid registry:打开本 run 的子进程登记窗口(非 L3 → 关闭,registerPid 全程 no-op)。
  pidRegistryRunId = activeGovernanceLevel === "L3" ? runId : null;
  setPidRegistryRun(pidRegistryRunId);

  setRunId(runId);
  activeRunId = runId;
  activeRunAbortController = new AbortController();
  if (stopRequests.has(runId)) activeRunAbortController.abort(new Error("user requested stop"));
  callRecords.length = 0;
  runTokens = 0;
  runCost = 0;
  traceEvents.length = 0;
  runMessages.length = 0;
  runChannels = new ChannelRegistry(runId);
  // A4: 每 run 重置收件箱。落盘写入点选在 bus 的 onCommitted sink(而非 recordA2A/recordMessage
  // 各写一遍):所有走生命周期的消息(含 ack/resolve 等后续推进)天然经过同一入口,侵入最小;
  // committed 及之后的每次推进各追加一条快照到 .opc/runs/<runId>/a2a_messages.jsonl(best-effort)。
  a2aBus = new A2ABus({ onCommitted: (m) => appendA2AMessageRecord(projectRoot, runId, buildA2AMessageRecord(m)) });
  artifactStore = new ArtifactStore(runId);    // A2A: 每 run 重置产出物存储
  injectedByAgent = new Map();                 // D3: 每 run 重置"真正注入的记忆"登记(复用验证回路)
  askSeq = 0; askDepth = 0; activeAsks.clear(); // A2A: 重置问询状态
  // v6 P3b: worker 调 request_channel 工具 → 记一条申请（待 lead/CEO 批准）。A2A: kind 可选(默认 peer-worker)。
  setChannelRequestHandler((from, target, reason, kind) => {
    if (!agents.some(a => a.id === target)) return `目标 ${target} 不存在，申请未提交。`;
    const k = kind === "peer-lead" ? "peer-lead" : "peer-worker";
    const req = runChannels.request(from, target, k, reason);
    // 同 a2aRequestChannel:走 recordMessage 生命周期,不许旁路裸 emit(C6 硬规则)。
    recordMessage(from, `（申请与 ${target} 建立 ${k} 通道）${reason}`, "lead-only");
    return `已提交与 ${target} 的通信申请（id ${req.id}，${k}），待批准。`;
  });
  // A2A Phase 4: 能力发现 / 主动发消息 / 分享产出物 / inbox 自省。
  setDiscoverHandler((from, filter) => {
    const skill = filter.skill?.toLowerCase();
    const produces = filter.produces?.toLowerCase();
    const matches = agents.filter(a => {
      if (a.id === from || a.enabled === false) return false;
      if (filter.role && a.role !== filter.role) return false;
      if (skill) {
        const hay = `${a.role} ${a.name} ${a.card?.summary ?? ""} ${(a.card?.skills ?? []).map(s => `${s.name} ${s.description}`).join(" ")}`.toLowerCase();
        if (!hay.includes(skill)) return false;
      }
      if (produces && !(a.card?.produces ?? []).some(p => p.toLowerCase().includes(produces))) return false;
      return true;
    }).slice(0, 12);
    if (!matches.length) return "没有匹配的成员。";
    return JSON.stringify(matches.map(a => ({ id: a.id, name: a.name, role: a.role, summary: deriveSummary(a), skills: (a.card?.skills ?? []).map(s => s.name) })));
  });
  setA2ASendHandler((from, target, text, artifactId) => {
    if (!agents.some(a => a.id === target)) return `目标 ${target} 不存在。`;
    if (!runChannels.canCommunicate(from, target)) return `你与 ${target} 还没有开通通道，请先用 request_channel 申请。`;
    recordA2A({ from, to: [target], text, performative: "inform", artifactRefs: artifactId ? [artifactId] : undefined, channelId: runChannels.between(from, target)?.id });
    return `已发送给 ${target}。`;
  });
  setShareHandler((from, target, artifactId, note) => {
    if (!agents.some(a => a.id === target)) return `目标 ${target} 不存在。`;
    if (!runChannels.canCommunicate(from, target)) return `你与 ${target} 还没有开通通道，请先 request_channel。`;
    const art = artifactStore.get(artifactId);
    if (!art) return `产出物 ${artifactId} 不存在或不可分享。`;
    recordA2A({ from, to: [target], text: `${note ? note + " " : ""}[分享产出物: ${art.name}（${art.type}）${art.summary ? " — " + art.summary : ""}]`, performative: "share", artifactRefs: [artifactId], channelId: runChannels.between(from, target)?.id });
    return `已把产出物「${art.name}」分享给 ${target}。`;
  });
  setInboxPeekHandler((agentId) => {
    const msgs = a2aBus.peek(agentId);
    if (!msgs.length) return "你的 inbox 暂无待处理消息。";
    return msgs.slice(-8).map(m => `- [${m.performative ?? "inform"}] 来自 ${m.from}: ${m.text.slice(0, 200)}${m.artifactRefs?.length ? ` [产出物 ${m.artifactRefs.join(",")}]` : ""}`).join("\n");
  });
  // A2A Phase 5: 双向问询(query-ref)。同步子调用 target 作答并返回给问询方;不转移任务所有权。
  // 三道防死锁闸:深度≤2、A↔B 环检测、target 引擎调用自带超时(claude-code 600s / api 90s)。
  setAskHandler(async (from, target, question) => {
    const targetAgent = agents.find(a => a.id === target);
    if (!targetAgent) return `目标 ${target} 不存在。`;
    if (!runChannels.canCommunicate(from, target)) return `你与 ${target} 还没有开通通道，请先 request_channel。`;
    if (targetAgent.card?.acceptsQuery === false) return `${target} 不接受问询。`;
    if (askDepth >= 2) return "问询链过深(>2),请基于你已有的信息作答,不要再向他人发问。";
    if (activeAsks.has(`${target}->${from}`)) return `${target} 正在等你回答,不能反过来问它(避免互锁);请先作答。`;
    const correlationId = `${activeRunId.slice(0, 6)}-q-${++askSeq}`;
    const ch = runChannels.between(from, target)?.id;
    recordA2A({ from, to: [target], text: question, performative: "ask", correlationId, channelId: ch });
    activeAsks.add(`${from}->${target}`);
    askDepth++;
    try {
      const askPrompt = `团队成员 ${from} 向你问询(你**不需要接管其任务**,只需回答其问题):\n${question}\n\n请基于你的职责与已知信息简洁作答。`;
      const r = await runViaEngine(targetAgent, getRolePrompt(targetAgent.role), askPrompt);
      const answer = r.status === "done" && r.content ? r.content : `(${target} 暂时无法作答)`;
      recordA2A({ from: target, to: [from], text: answer, performative: "reply", correlationId, channelId: ch });
      return answer;
    } catch (e: any) {
      return `${target} 未能作答:${e?.message || String(e)}`;
    } finally {
      askDepth--;
      activeAsks.delete(`${from}->${target}`);
    }
  });
  runOmniscient = [];

  // v2: the run works inside the company's workspace folder (a sandbox repo), NOT the app repo.
  // Run metadata (.opc/runs) still lives under projectRoot.
  const companies = loadCompanies(projectRoot);
  const runCompany = companies.find(c => c.id === (companyId || DEFAULT_COMPANY_ID)) || companies[0];
  runVisibilityPolicy = runCompany?.visibilityPolicy ?? "default";
  activeCompanyIdForA2A = runCompany?.id ?? null;
  setForceSkills(opts?.forceSkills ?? []); // "/" 面板点技能 → 本 run 全员强制注入
  // Stage 6:加载本公司的交叉验证链(无则空 → verifier gate 全程 no-op)。
  activeVerificationEdges = runCompany?.workflow?.verificationEdges ?? [];
  runVerificationResults = [];
  // Stage 8+ · A2A 预置通道:模板作者声明的角色间常驻通道,install 时已换算成真实 agent id 落进
  // company.presetChannels(见 communityRoutes.ts install/company)。运行时 channel 只在 run 内存在
  // (ChannelRegistry 每 run 重建,无持久通道概念),所以在这里"重新 grant"就是它的落盘接线点——
  // worker 不需要再对这些常驻同事 request_channel 走审批。找不到的 agent 引用(公司结构后来改过)静默跳过。
  applyPresetChannels(runChannels, runCompany?.presetChannels ?? [], new Set(agents.map((a) => a.id)));
  // In game mode the lead is the host (主持人): omniscient across audiences so it can run 狼人杀/辩论.
  runOmniscient = runVisibilityPolicy === "game" ? agents.filter(a => a.role === "lead").map(a => a.id) : [];
  // 收口③ V0 · 主工作目录:绑定了 Company.folder 的公司,起跑先过全套安全检查(realpath/允许根/
  // 读写/磁盘/穿越,见 workspaceGuard.ts),失败 fail-fast——此刻 task.json 尚未写,不留脏 run;
  // 通过后 activeWorkRoot 取 canonical realPath,冻结进下方 Run 对象随 createRun 落盘 task.json
  // (evidence manifest 之前,时序硬约束),run 后全链路只认冻结值(resolveRunWorkRoot)。
  // 绑定目录零隐式初始化:非 Git(或无首 commit)一律拒跑,引导回公司架构页显式确认"初始化为
  // OPC 托管工作区"(bound 模式绝不 git init/写 .gitignore/README/建 commit,见 workspace.ts)。
  // 未绑定的默认 .opc-studio 沙箱仍走 managed 托管初始化,行为不变。
  const boundFolder = runCompany?.folder?.trim();
  let dirtyWorkspaceAtStart = false;
  let dirtyPreflight: { dirty: boolean; fileCount: number; files: string[] } | undefined;
  const runNeedsCode = taskRequiresCode(goal); // 五.1/五.2:编码团队任务(需真实代码落盘)的起跑硬约束判据
  if (boundFolder) {
    const folderCheck = validateWorkspaceFolder(projectRoot, boundFolder);
    if (!folderCheck.ok) {
      throw new Error(`公司主工作目录不可用(${folderCheck.code}):${folderCheck.error}——请在公司架构页重新绑定`);
    }
    activeWorkRoot = folderCheck.realPath!;
    // 五.1 · 非 Git 多写者阻断(起跑前干净失败,governance 留痕同 capability_blocked):编码团队任务绑定了
    // 非 git(或无首个 commit)目录 → 多个写 worker 无 worktree 隔离,起跑前就整 run 干净失败,不进 CEO/派工。
    // 非编码任务不因此拦(研究写作走 scratch,不直写工作根);它们若绑非 git 目录仍会被下方 ensureGitRepo 兜底拦。
    if (folderCheck.needsInit && runNeedsCode) {
      try {
        appendGovernanceEvent(projectRoot, runId, {
          kind: "dispatch_blocked",
          detail: `non_git_multi_writer: 绑定的工作目录不是 Git 仓库(缺自有 .git 或首个 commit):${activeWorkRoot}`,
        });
      } catch { /* 留证 best-effort,不掩盖拦截 */ }
      throw new Error(`绑定的工作目录不是 Git 仓库(缺自有 .git 或首个 commit):${activeWorkRoot}。编码团队任务需要 Git 隔离才能让多个 worker 并行安全写入——请在公司架构页确认"初始化为 OPC 管理的 Git 工作区"后重试(non_git_multi_writer)`);
    }
    if (!ensureGitRepo(activeWorkRoot, { mode: "bound" })) {
      throw new Error(`绑定的工作目录不是可直接使用的 Git 仓库(缺自有 .git 或首个 commit):${activeWorkRoot}。请在公司架构页重新绑定并显式确认"初始化为 OPC 托管工作区"——运行时不做任何隐式 git init`);
    }
    // 五.2(收口作战令)· 脏树 preflight:起跑只读检测(status --porcelain,排除 .opc)。
    //   · 编码团队任务遇脏树 → 起跑前干净失败(列脏文件 ≤10 + 指引"提交/stash/或取消"),避免 merge-back
    //     覆盖用户未入库改动(此前只 warning 不拦,已按新令推翻)。managed 沙箱例外见 else 分支(不做预检)。
    //   · 非编码任务(研究/直答)不拦,只如实记录 dirtyPreflight 进 run 记录(加性)。
    try {
      const _porcelain = git(activeWorkRoot, ["status", "--porcelain"], 10000, true);
      const pf = evaluateDirtyPreflight(_porcelain, runNeedsCode);
      if (pf.dirty) {
        dirtyWorkspaceAtStart = true;
        dirtyPreflight = { dirty: true, fileCount: pf.fileCount, files: pf.files.slice(0, 10) };
        if (pf.block) {
          const shown = pf.files.slice(0, 10);
          const more = pf.fileCount > 10 ? ` 等共 ${pf.fileCount} 个文件` : "";
          try {
            appendGovernanceEvent(projectRoot, runId, {
              kind: "dispatch_blocked",
              detail: `dirty_workspace_preflight: ${pf.fileCount} 个未提交/未跟踪文件`,
            });
          } catch { /* 留证 best-effort */ }
          throw new DirtyWorkspacePreflightError(pf.fileCount, shown, more);
        }
        emit("info", undefined, {
          kind: "dirty_workspace_at_start",
          fileCount: pf.fileCount,
          message: `⚠️ 起跑时绑定工作目录有 ${pf.fileCount} 个未提交/未跟踪文件——OPC 不会自动提交它们;若本 run 的合并将触碰这些文件,将按冲突处理(不强并),建议先自行 commit/清理`,
        });
      }
    } catch (e) {
      if (e instanceof DirtyWorkspacePreflightError) throw e; // 预检拦截必须冒泡(不被"只读检测失败不阻塞"吞掉)
      /* 只读检测本身失败(git 不可用等)不阻塞起跑 */
    }
  } else {
    activeWorkRoot = runCompany ? companyRootDir(projectRoot, runCompany) : projectRoot;
    // MUP Gate A#3 · managed 托管初始化失败 → 干净失败:无 git 隔离基础(worktree/merge/回滚全不可用)
    // 时绝不静默放多个 worker 并行直写根目录。
    if (!ensureGitRepo(activeWorkRoot)) {
      throw new Error(`托管工作区 Git 初始化失败:${activeWorkRoot}——没有 git 隔离(worktree/merge)就不能让多个 worker 并行写根目录,请检查 git 可用性/目录权限后重试`);
    }
  }
  emit("info", undefined, { message: `工作目录: ${activeWorkRoot}` });
  // P0 · run 级基线:抓起跑时 workRoot 的 HEAD。本 run 交付合同的 git-truthful 边界(base→HEAD diff = 本 run
  // 真实改动),用于区分共享工作目录里前序 run 的遗留产物,并作为 DeliveryAcceptance 合同覆盖门的权威文件来源。
  const runBaseCommit = snapshotGit(activeWorkRoot);
  if (runBaseCommit) emit("info", undefined, { message: `run 基线 commit: ${runBaseCommit.slice(0, 8)}(本 run 只对 base→HEAD 的改动负责)` });

  // Phase 5: discover MCP tools once per run so they enter the LLM tool schema + are runnable.
  const mcpCount = await refreshMcpTools(projectRoot);
  if (mcpCount > 0) emit("info", undefined, { message: `已接入 ${mcpCount} 个 MCP 工具` });

  // ephemeral 高频流式事件(agent_output_chunk)与 events.jsonl/RunHistory 同口径地不进 trace——
  // 否则 B5 特意从热路径剔除的 chunk 会经这条旁路在内存无界累积并整包写进 trace.json。
  const traceSub = (e: any) => { if (!EPHEMERAL_TYPES.has(e.type)) traceEvents.push(e); };
  // AgentStatus 11 态 · using_tool:tool_call/tool_result 是引擎(ClaudeCode/Codex/ACP 流式解析)
  // 在真实工具执行时发出的事件——这里把它们推进 agent 状态机,不是前端模拟。tool_call → using_tool;
  // tool_result → 回到调用前的 thinking/reviewing。Hermes 引擎不发 per-tool 事件 → 该分支天然不触发。
  // 同状态去重(claude-code 每个工具块发一条 tool_call):已是 using_tool 就不重复 setAgentStatus,
  // 避免高频 mergeSaveAgents 磁盘写。
  const preToolStatus = new Map<string, AgentNodeConfig["status"]>();
  const statusSub = (e: import("@opc/shared").TraceEvent) => {
    if (!e.agentId || (e.type !== "tool_call" && e.type !== "tool_result")) return;
    const a = agents.find(x => x.id === e.agentId);
    if (!a) return;
    if (e.type === "tool_call") {
      if (a.status === "thinking" || a.status === "reviewing" || a.status === "working") {
        preToolStatus.set(a.id, a.status === "working" ? "thinking" : a.status);
        const toolName = (e.payload as { name?: unknown } | undefined)?.name;
        setAgentStatus(a.id, "using_tool", typeof toolName === "string" ? `工具: ${toolName}`.slice(0, 80) : undefined);
      }
    } else if (a.status === "using_tool") {
      setAgentStatus(a.id, preToolStatus.get(a.id) ?? "thinking");
    }
  };
  // subscribe 移进内层 try 之后(复审抓出:createRun 写盘可抛,若在 subscribe 之后抛则 traceSub 泄漏)。

  // 令五.4:保留 precreate 阶段绑定的 mission/taskGraph 关联(chat/task、mission 派发在 precreate 后 bind)。
  // createRun 会整体覆写 task.json,不读回就会丢掉 missionId/taskGraphId;此处 opts 优先、否则读回盘上已绑值。
  // 任务图节点子 run(targetAgentId 定向)不参与:它们本就是某张图的一个节点,不应再挂另一张图。
  const _preObs = opts?.targetAgentId ? null : loadRunTask(projectRoot, runId);
  const _obsMissionId = opts?.missionId ?? _preObs?.missionId;
  const _obsTaskGraphId = opts?.taskGraphId ?? _preObs?.taskGraphId;
  const run: Run = {
    id: runId, userGoal: goal, status: "running",
    companyId: normalizeCompanyId(companyId), // 公司作用域地基:组织页简报/任务档案按公司过滤全靠它
    ...(_obsMissionId ? { missionId: _obsMissionId } : {}),   // 令五.4:详情页凭此反查观测任务图
    ...(_obsTaskGraphId ? { taskGraphId: _obsTaskGraphId } : {}),
    workRoot: activeWorkRoot,          // 持久工作根(见上方 activeWorkRoot=companyRootDir):产物下载/diff/审批的权威解析源,起跑时确立、不可变
    ...(runBaseCommit ? { baseCommit: runBaseCommit } : {}), // P0 run 级基线
    ...(dirtyWorkspaceAtStart ? { dirtyWorkspaceAtStart: true as const } : {}), // D3:起跑脏树只读检测(不拒跑)
    ...(dirtyPreflight ? { dirtyPreflight } : {}), // 五.2:脏树 preflight 结果(非编码任务 proceed 但工作目录脏)
    ...(runBaseCommit ? {} : { workspaceIsolation: "none" as const }), // 五.1:非 git 工作根(无 HEAD)→ 无 worktree 隔离,如实标注
    startedAt: new Date().toISOString(),
    totalTokens: 0, totalCostUsd: 0, participatingAgents: [],
  };
  createRun(projectRoot, run);
  // B1 · Runtime Contract:执行配置快照 worker.config.json —— run 一开工就落盘,崩溃 run 也有据可查。
  // writer 自身 best-effort(内部 try/catch),写失败不影响 run;快照的是本 run 加载的公司 agent 名册,
  // 实际参与者(participatingAgents)在 run 结束的 result.json 里。
  writeWorkerConfig(projectRoot, {
    schemaVersion: "1",
    runId,
    companyId: normalizeCompanyId(companyId),
    ...(opts?.teamMode ? { teamMode: opts.teamMode } : {}),
    runType,
    agents: agents.map(a => ({ agentId: a.id, name: a.name, role: a.role, framework: a.framework ?? "api", provider: a.provider, model: a.model })),
    createdAt: new Date().toISOString(),
  });
  const persistRunProgress = () => {
    try {
      run.totalTokens = runTokens || callRecords.reduce((sum, r) => sum + (r.totalTokens ?? 0), 0);
      run.totalCostUsd = runCost || callRecords.reduce((sum, r) => sum + (r.estimatedCostUsd ?? 0), 0);
      run.participatingAgents = [...new Set(run.participatingAgents)];
      saveRunTask(projectRoot, run);
    } catch {
      // Live task progress is best-effort; final persistence still happens at run end.
    }
  };
  persistActiveRunProgress = persistRunProgress;
  persistRunProgress();
  try { // ← 内层兜底(P0#3 审计确认):任何未捕获异常绝不留下僵尸 running + traceSub 订阅泄漏
  subscribe(traceSub); // 在 try 内订阅 → finally 的 unsubscribe 与之严格配对,无泄漏窗口
  subscribe(statusSub); // AgentStatus 11 态:与 traceSub 同生命周期,finally 严格配对反注册
  emit("run_started", undefined, { goal });
  // 广播归属按角色解析真实 CEO id:社区安装的公司 id 已被 reroot 重映射("ceo-xxxx"),写死 "ceo" 会指向幽灵 agent。
  const companyCeoId = agents.find(a => a.role === "ceo")?.id ?? "ceo";
  recordMessage(companyCeoId, goal, "all"); // the goal is broadcast to the whole org

  createRunBranch(runId);

  // CEO analyses
  // A2 · Task Graph 最小定向入口:quick run 可选 targetAgentId,把"单 agent 直答"定向到指定 agent
  // (任务图节点派发用)。增量可选:不传/找不到 → 与原行为逐字节一致(按角色找 CEO)。
  const targetAgent = runType === "quick" && opts?.targetAgentId ? agents.find(a => a.id === opts.targetAgentId) : undefined;
  const ceo = targetAgent ?? agents.find(a => a.role === "ceo")!; // 按角色找(支持每个公司各自的 ceo,不再硬编码 id)
  ensureCompanyMd(runCompany?.id ?? DEFAULT_COMPANY_ID); // v2: 冷启动初始化 company.md(CEO 维护的公司知识),供全员注入;按公司隔离
  // ④ 决策#2:CEO 选队前,为所有团队初始化 team.md(若缺),并把各团队「职责+近期能力史(最近任务)」摘要
  //   喂给 CEO,使其按团队战绩选队、并能说明"为何选它们"——而非仅凭关键词。
  const allLeads = agents.filter(a => a.role === "lead" && a.childrenIds.some(c => agents.some(x => x.id === c)));
  for (const l of allLeads) ensureTeamMd(l, l.childrenIds.filter(c => agents.some(x => x.id === c)));
  const teamsDigest = allLeads.map(l => `### ${l.name} (${l.id})\n${readTeamMd(projectRoot, l.id).slice(0, 500)}`).join("\n\n");
  // targetAgent 定向直答时不注入"选队"digest(它不选队,digest 只会误导)。
  const ceoGoal = teamsDigest && !targetAgent
    ? `${goal}\n\n---\n## 可选团队及其近期能力史(据此选择团队,并在 SUMMARY 说明为何选它们)\n${teamsDigest}`
    : goal;
  if (!run.participatingAgents.includes(ceo.id)) {
    run.participatingAgents.push(ceo.id);
    persistRunProgress();
  }
  let ceoResponse: string;
  let ceoFileChanges: FileChange[] = [];
  const ceoChangesBefore = diffFileChanges(activeWorkRoot || projectRoot);
  try {
    const ceoResult = await runViaEngine(ceo, getRolePrompt(targetAgent ? ceo.role : "ceo"), ceoGoal);
    if (ceoResult.status !== "done") throw new Error(ceoResult.error || `${ceo.id}: ${ceoResult.status}`);
    ceoResponse = ceoResult.content;
    ceoFileChanges = fileChangesCreatedSince(ceoChangesBefore, ceoResult.fileChanges ?? []);
  } catch (e: any) {
    // 健壮性(实测教训):CEO 调用超时/失败绝不让整个 run 崩(曾因 CEO 180s 超时使 startRun 抛错、零产出)。
    // 空响应 → parseCeoPlan 返回 null → 走 buildFallbackAssignments 确定性派活,run 继续产出。
    emit("error", "ceo", { message: `CEO 调用失败(${e?.message || e})→ 改用确定性兜底派活,run 继续` });
    ceoResponse = "";
  }

  // v2 分诊:CEO 判定无需团队 → 直接答复,短路掉整个团队流程(下方 leadAssignments 置空 + 把答复作为交付物)。
  let directAnswer = parseDirectAnswer(ceoResponse);
  // Stage 2 · Quick Run:用户选"快" = 单 agent 直答、不开团队(放弃团队增益换 1-2min 速度)。
  // CEO 的回复直接作为交付物,跳过 ≥60 字强制开团队的兜底。
  // P0(活体抓出 · Gate A):**编码任务绝不走单 agent 直答**——不可变用户目标要求代码时,单 agent 直答产不出真实
  // 文件+测试,只会让"要求代码的任务零产出却 done"成为假成功。故 quick 仅对**非编码目标**直答;编码目标(哪怕
  // 选了 quick)一律强制开团队真实产出+测试。这与下方 DeliveryAcceptance 的 directAnswer&&!runRequiresCode 门是
  // 一体两面(此处产品侧:让编码任务真去建;那边安全网:万一仍直答则判 no_delivery→failed,绝不假成功)。
  if (runType === "quick" && !taskRequiresCode(goal)) {
    const ceoText = ceoResponse.trim();
    if (directAnswer == null && !ceoText) {
      // 反假成功:CEO 引擎零输出,不伪造成一次"干净的直答成功"。保留 "(no output)" 哨兵(missionRoutes
      // 的空产出判定 summary==="(no output)" 依赖它),同时标 run 降级——收尾 finalize 链据此强制
      // allClean=false / status=failed 并 emit deliverable_degraded,下游报告/成果卡如实呈现失败态。
      directAnswer = "(no output)";
      run.degraded = true;
      run.degradedReason = run.degradedReason ?? "Quick Run:CEO 引擎零输出,无有效答复";
      emit("error", "ceo", { message: "Quick Run:CEO 引擎零输出,标记降级(不伪造成功)", degraded: true });
    } else {
      directAnswer = directAnswer ?? ceoText;
      emit("info", "ceo", { message: "Quick Run:单 agent 直答,跳过团队" });
    }
  } else if (directAnswer && (taskRequiresCode(goal) || goal.replace(/\s/g, "").length >= 60)) {
    emit("info", "ceo", { message: taskRequiresCode(goal) ? "编码任务不做单 agent 直答,强制开团队真实产出代码+测试(不可用直答弱化交付合同)" : "CEO 对实质性任务误判直答 → 已忽略,改为开团队(健壮性兜底)" });
    directAnswer = null;
  }
  // A coordinator-only company may finish a non-code file task itself through real tools. Preserve
  // that as a direct delivery instead of opening an empty team path and later failing an empty report.
  // Coding goals still go through the producer/verifier contract and can never use this shortcut.
  if (!directAnswer && ceoFileChanges.length > 0 && allLeads.length === 0 && !taskRequiresCode(goal)) {
    directAnswer = ceoResponse.trim();
    emit("info", ceo.id, {
      kind: "coordinator_file_delivery",
      files: ceoFileChanges.map((change) => change.path),
      message: `CEO 通过真实工具完成 ${ceoFileChanges.length} 个文件交付；无下属团队，按直达交付收口`,
    });
  }  if (directAnswer) emit("info", "ceo", { message: "CEO 分诊:无需团队,直接答复" });

  // Parse CEO plan — 3-level fallback: structured JSON → Markdown regex → keyword assignment.
  const jsonPlan = parseCeoPlanJson(ceoResponse);
  const parsedPlan = jsonPlan
    ? { plan: jsonPlan.plan, leads: jsonPlan.leads as unknown as LeadAssignment[], summary: jsonPlan.summary }
    : parseCeoPlan(ceoResponse);
  const rawLeadAssignments: LeadAssignment[] = (parsedPlan
    ? parsedPlan.leads.filter(la => agents.some(a => a.id === la.leadId))
    : buildFallbackAssignments(goal, agents)
  )
    // Resolve workers against the REAL team: keep parsed worker ids that match an agent; if the
    // CEO's free-text ids matched none, fall back to the lead's actual childrenIds. This makes the
    // org structure authoritative for WHO works, so worker tasks aren't silently dropped when the
    // CEO names workers loosely.
    .map(la => {
      // P2: CEO 只给团队级目标，worker 由 Lead 自拆决定。这里仅保留 CEO「碰巧」点名且匹配真实 agent
      // 的 worker（向后兼容旧格式），作为 Lead 自拆失败时的兜底；CEO 未点名 → workers 留空，完全交给
      // Lead 自拆（见下方 leadWorkers 自拆逻辑）。不再在此兜底硬塞 worker。
      const workers = la.workers.filter(w => agents.some(a => a.id === w.workerId));
      return { ...la, workers };
    })
    // P2: 只要该 lead 存在且有真实团队成员就保留（workers 可空，由 Lead 自拆填充）；无团队的 lead 才丢弃。
    .filter(la => {
      const lead = agents.find(a => a.id === la.leadId);
      return !!lead && lead.childrenIds.some(cid => agents.some(a => a.id === cid));
    });

  // v8 #3 / G2 — 对所有解析路径统一做【Core 确定性】团队规模收敛(零 LLM):关键词分类 + 复杂度估算合成 teamScale。
  const teamShape = resolveEffectiveScale(goal);
  const taskScale = teamShape.scale;
  emit("info", undefined, { kind: "team_shape", scale: taskScale, reason: teamShape.reason, message: `确定性组队规模决策:${teamShape.reason}` });
  let leadAssignments = directAnswer ? [] : clampLeadsForScale(rawLeadAssignments, goal, taskScale); // 直答 → 不开任何团队
  if (leadAssignments.length < rawLeadAssignments.length) {
    const dropped = rawLeadAssignments.filter(r => !leadAssignments.some(k => k.leadId === r.leadId)).map(r => r.leadId);
    emit("info", undefined, { message: `按任务规模(${taskScale})收敛团队：保留 ${leadAssignments.map(l => l.leadId).join("、")}，裁剪 ${dropped.join("、")}` });
  }
  // 健壮性兜底:实质性任务但 CEO 没派出任何有效团队(解析失败/弱协调者乱答)→ 强制派给第一个有团队的 lead,
  // 把目标整体交给它自拆。避免"CEO 一崩,整个 run 零产出"(实测 deepseek CEO 多次踩到)。
  if (leadAssignments.length === 0 && !directAnswer && allLeads.length > 0) {
    leadAssignments = [{ leadId: allLeads[0].id, task: goal, workers: [] }];
    emit("info", undefined, { message: `健壮性兜底:CEO 未产出有效团队分派,强制派给 ${allLeads[0].id} 执行` });
  }

  // v5 P3a — 跨团队：多 lead 参与同一目标时，CEO 协调他们之间开 peer-lead 通道（UI 可见团队协同）。
  if (leadAssignments.length >= 2) {
    const leadIds = leadAssignments.map(la => la.leadId);
    for (let i = 0; i < leadIds.length; i++)
      for (let j = i + 1; j < leadIds.length; j++)
        runChannels.open(leadIds[i], leadIds[j], "peer-lead", "ceo", "CEO 协调跨团队协同");
    recordMessage(companyCeoId, `本目标由多个团队协同完成：${leadIds.join("、")}。请各团队对齐接口与边界。`, "all");
  }

  const leadResults: string[] = [];
  // AI Research Company:跨(可能多个)lead 的合成汇总证据表——最终报告只存一份,取运行期间提取到的第一批。
  const evidenceRows: EvidenceRow[] = [];
  // v2 分诊:直答时,CEO 的答复即最终交付物(走下方同一套收尾生成报告);团队循环因 leadAssignments=[] 跳过。
  if (directAnswer) {
    leadResults.push(directAnswer);
    if (!run.participatingAgents.includes(ceo.id)) {
      run.participatingAgents.push(ceo.id);
      persistRunProgress();
    }
  }
  const perLeadReports: { leadId: string; leadName: string; workerResults: string[] }[] = [];
  const deferred: DeferredTask[] = [];
  const allChanges: FileChange[] = directAnswer ? [...ceoFileChanges] : [];
  // P0/P1(审计修复)· DeliveryAcceptance 的 run 级要求。**不可变下限来自用户目标本身**(goal),不只从
  // lead 拆解的子任务累积——否则 planner 拆解措辞(子任务不提代码/测试)会静默弱化交付合同(审计发现)。
  // goal 是不可变原始要求:先按它定下限(requiresCode/requiresTests),之后每个子任务(1610-1611)只能
  // OR 累积【加严】,绝不能把用户目标已定的要求降级。运行时把这份"交付合同"如实落进事件流供审计。
  // 单一事实源:目标显式声明"不要代码/纯研究"→ 整条 run 是研究,任何子任务都不能把 requiresCode 抬回 true
  // (ceiling)。这是把研究综合从"被误判编码 → 强制要文件 → no_delivery"里救出来的总闸。
  let runtimeTaskContract = createRuntimeTaskContract({
    runId,
    objective: goal,
    companyId: normalizeCompanyId(companyId),
    missionId: _obsMissionId,
    taskGraphId: _obsTaskGraphId,
    runType,
    teamMode: activeTeamMode,
    workRoot: activeWorkRoot,
    baseCommit: runBaseCommit || undefined,
    maxTokens: maxTokensTotal || undefined,
  });
  writeRuntimeTaskContract(projectRoot, runtimeTaskContract);
  const runForbidsCode = runtimeTaskContract.acceptance.forbidsCode;
  let runRequiresCode = runtimeTaskContract.acceptance.requiresCode;
  let runRequiresTests = runtimeTaskContract.acceptance.requiresTests;
  emit("info", undefined, {
    kind: "delivery_contract",
    requiresCode: runRequiresCode,
    requiresTests: runRequiresTests,
    contractHash: runtimeTaskContract.contractHash,
    forbidsCode: runForbidsCode,
    source: "user-goal",
    message: `交付合同:requiresCode=${runRequiresCode} requiresTests=${runRequiresTests}${runForbidsCode ? " forbidsCode=true(研究/写作,子任务不得抬回编码)" : ";后续拆解只能加严不能降级"}`,
  });
  // path → 贡献过该文件的 workerId 集合:交叉验证否决时据此从 allChanges 撤销该 producer 独有的
  // 改动账目(其他 worker 也改过的路径保留)。
  const changeContributors = new Map<string, Set<string>>();
  // P0-3 · 独立验证门:本 run 派单里 producer(非 verifier)与 verifier 的 worker agentId 集合。在 spec 构造处
  // 诚实收集(覆盖 ACP-temp 未 merge 回的 dev,不依赖 changeContributors);有 verifier → 要求独立验证,
  // 最终 pass/fail 以独立证据为准(见收尾 evaluateDeliveryAcceptance)。
  const producerAgentIds = new Set<string>();
  const verifierAgentIds = new Set<string>();
  // 被否决但代码已并入 run 分支、未回滚的残留改动(worktree merge 无按 worker 的廉价回滚)——
  // 如实进最终报告 risks/nextSteps,不许"声称产出未进交付"。
  const vetoedResidualChanges: Array<{ agentId: string; paths: string[] }> = [];
  // ⏱️ 超时抢救的诚实闭环(审查 high):抢救成功的 worker 不进 deferred(它交付了),但**超时事实不能消失**——
  // partialAgents 用于 ①跳过对天然不完整产物的结构性验证边 ②把它排除出"从成功学技能"的正向强化;
  // salvagedTimeouts 作为附加失败信号喂给 Layer E 反思(教训仍然要学),但不进 run.deferredTasks(UI 如实显示"已交付·部分")。
  const partialAgents = new Set<string>();
  const salvagedTimeouts: DeferredTask[] = [];
  // MUP Gate A#3(取代旧 "-X theirs" 强并清单)· 未决合并冲突:conflict 的 worker 文件改动未落地,
  // 分支/worktree 保留待人工决裁。清单喂进①结构化事件(parallelExecutor 已 emit)②合成 prompt
  // ③structured report risks/nextSteps ④run.mergeConflicts(task.json)⑤finalState=requires_review。
  const mergeReviewConflicts: Array<{ taskId: string; agentId: string; leadId: string; files: string[] }> = [];
  // 结构提升 A:本 run 各 lead 的真实拆分(≥2 个不同子任务才算"拆分");run 干净收尾时存为 plan_template 供复用。
  const runPlanCandidates: Array<{ companyId?: string; tasks: string[] }> = [];
  // D4 · A2A resolved 闭环:各 lead→CEO 的 artifact_handoff 消息 id(run 级累积)。收尾在最终 md 已生成
  // (leadSummary 已被合成进 md)且 run 未降级后由 CEO(收件人)统一 resolve——真实交接完成才闭环。
  const handoffMsgs: Array<{ id: string; by: string }> = [];
  const pendingLeadOutcomes: Array<{
    leadId: string; ceoId: string; task: string; acceptedArtifactRefs: string[]; acceptedFilePaths: string[];
  }> = [];
  // P0-6 · A2A 依赖已验证交付:合成消费点(:2084)不再当场 resolve delegate_task/worker_report/revision,而是
  // 累积成候选;run 收尾算出 DeliveryAcceptance 后【仅当 verified/not_required 才统一 resolve】——假交付(文件未落盘)
  // 的 run 这些消息保持 unresolved(诚实:未闭环)。与 handoffMsgs 同款 run 级收尾 resolve 模式。
  const deliverableResolveMsgs: Array<{ id: string; by: string }> = [];

  // Capture the project's pre-run state once so worker diffs are gated diff-relative (a worker
  // is judged on the errors it introduces, not on pre-existing ones). Lenient note: accepted
  // workers commit incrementally, but the baseline stays at run-start — the contract is "a run
  // must not increase type errors past where it started, nor break tests that were green."
  // P2#1 审计:captureBaseline 同步跑整仓 tsc+测试(可阻塞事件循环数分钟),而只有编码 run 的质量门会消费它。
  // 研究/写作 run(无 code-review 验证边)直接给空基线,省掉每次起跑的几分钟纯浪费。
  const runIsCoding = shouldUseCodingPipeline(runRequiresCode, runForbidsCode);
  const gateBaseline = runIsCoding ? captureBaseline(activeWorkRoot) : { typeErrors: 0, testsRan: false, testsPassed: false };
  // 结构提升 D · 任务-团队匹配警告(codelru1 教训:coding 任务派给研究队 → 交出一篇"关于代码的报告"得 0 分
  // 还不自知)。不拦截(用户选队自主),但显式警示 + 写进最终报告横幅,诚实呈现错配风险。
  let teamFitNote = "";
  if (!directAnswer && !runIsCoding && classifyTaskType(goal) === "coding") {
    teamFitNote = "本任务看起来是工程实现(coding),但当前公司没有 code-review 验证边(非编码团队)——交付很可能是『关于代码的报告』而非可运行代码。建议改用编码类公司执行。";
    try { emit("info", undefined, { kind: "team_mismatch", message: `⚠️ ${teamFitNote}` }); } catch { /* additive */ }
  }
  emit("info", undefined, { message: `质量门基线: ${gateBaseline.typeErrors} 类型错误, 测试${gateBaseline.testsRan ? (gateBaseline.testsPassed ? "通过" : "未通过") : "无"}` });

  // Parallel worker infrastructure: multi-account least-busy scheduler + global concurrency cap.
  const accountUsage: Record<string, number> = {};
  const accounts = withGlobalCliSubscriptionAccounts(
    withResolvedApiKeyAccounts(
      ensureAccountsFromProviders(projectRoot),
      agents,
      (providerId) => resolveProviderKey(projectRoot, providerId),
    ),
    runCapabilityReport,
  );
  const providerIds = [...new Set(accounts.map(a => a.providerId))];
  const parallelCfg = config.parallel ?? {
    maxConcurrentWorkers: 8, perAccountDefault: 4,
    taskMaxAttempts: config.budget.maxAttemptsPerTask ?? 2,
    taskTimeoutMs: config.budget.taskTimeoutMs ?? 180000,
    useWorktree: true,
  };
  // 重型任务(如深度研究)可用 env 放宽 worker 超时——默认任务 180s 对深度检索/综合太短(实测单次 ~300s)。
  // 加性:未设 env 时行为不变。
  const _envTaskTimeout = Number(process.env.OPC_TASK_TIMEOUT_MS);
  if (_envTaskTimeout > 0) parallelCfg.taskTimeoutMs = _envTaskTimeout;
  // ⏱️ 分层 deadline:只有当用户**显式**统一配置了超时才全角色一刀切;否则 parallelExecutor 按 roleProfile
  // 分角色取时限(研究 10min / 核查 6min / 代码 12min…)。注意:loadConfig 会把 budget.taskTimeoutMs 回填成
  // 默认 180_000(projectStore.ts)——**回填的默认值不算显式**,否则按角色时限永不生效(审查抓出的恒真 bug)。
  const taskTimeoutExplicit = _envTaskTimeout > 0 || config.parallel != null
    || (config.budget.taskTimeoutMs != null && config.budget.taskTimeoutMs !== 180_000);
  // 重试次数 env 可调:卡住/被限流的 worker 重试会翻倍耗时,实验里设 1 次更快(代价:瞬时失败不重试,可能偶有降级)。
  const _envMaxAttempts = Number(process.env.OPC_TASK_MAX_ATTEMPTS);
  if (_envMaxAttempts > 0) parallelCfg.taskMaxAttempts = _envMaxAttempts;
  const scheduler = new DefaultScheduler(new AccountPool(accounts), {
    isHealthy,
    suggestBackup: (p) => suggestBackupProvider(p, providerIds) ?? null,
    // 排队等账号租约不该比任务预算先饿死(实验实测 no_account within 200s 主因):至少给 5min。
    acquireTimeoutMs: Math.max(parallelCfg.taskTimeoutMs, 300_000),
  });
  // v7 B: 把全局并发上限钳到「可用账号总容量」——否则启动的 worker 数超过账号能服务的数，
  // 多出来的在调度队列里等到超时→no_account 丢弃（单账号多团队任务的丢 worker 主因）。
  const totalAccountCapacity = accounts.filter(a => a.enabled).reduce((s, a) => s + Math.max(1, a.maxConcurrent || 1), 0);
  // 并发稳定性硬化 · provider 并发上限(env 门控,默认 0=关,行为不变):再钳一道全局上限。economy 单 provider
  // 场景下等价于 per-provider 闸——防止 N 个 agent 同时轰同一 provider 端点(高并发 fetch failed 坍塌根因)。
  // 精确 per-provider 闸(多 provider run)见 scheduler.ts,后续项;此处 min 对单 provider 已足。设 OPC_PROVIDER_MAX_CONCURRENT=3。
  const providerConcurrencyCap = Number(process.env.OPC_PROVIDER_MAX_CONCURRENT) || 0;
  const semaphore = new Semaphore(Math.max(1, Math.min(
    parallelCfg.maxConcurrentWorkers,
    totalAccountCapacity || 1,
    providerConcurrencyCap > 0 ? providerConcurrencyCap : Number.POSITIVE_INFINITY,
  )));

  const maxTokensPerRun = config.budget.maxTokensPerRun ?? 0;
  // ⏱️ run 级 SLA(墙钟刹车,与 token/cost 刹车同一组闸点):到点后**停止派发新团队/新轮次**,已有产出照常
  // 综合交付——SLA 永不拦合成,只拦"再开新工"。默认 30min,env 可调;0 = 关闭。
  const runSlaMs = process.env.OPC_RUN_SLA_MS != null ? Number(process.env.OPC_RUN_SLA_MS) : 30 * 60_000;
  const runDeadlineAt = runSlaMs > 0 ? Date.now() + runSlaMs : Number.POSITIVE_INFINITY;
  const runSlaHit = () => Date.now() > runDeadlineAt;
  const runStopHit = () => stopRequests.has(runId); // P0#11:外部 stop 请求与 SLA 同语义(停止派发,不拦合成)
  const runBudgetHit = () =>
    (maxTokensPerRun > 0 && runTokens >= maxTokensPerRun) || runSlaHit() || runStopHit();
  const runBudgetWhy = () => runStopHit()
    ? "用户请求停止——停止派发新任务,用已有产出综合交付"
    : runSlaHit()
      ? `run 达到时间上限 SLA(${Math.round(runSlaMs / 60000)}min)——停止派发新任务,用已有产出综合交付`
      : `run tokens ${runTokens} ≥ ${maxTokensPerRun}`;
  const runBrakeReason = (): DeferredTask["reason"] => runStopHit()
    ? "cancelled"
    : runSlaHit()
      ? "run_sla_exceeded"
      : "run_budget_exhausted";
  for (const la of leadAssignments) {
    // v10 P0-1: run-level token/cost brake — stop launching new teams once this run hits the cap;
    // record the rest as deferred (NOT a throw) so the run still finalizes + saves what it spent.
    if (runBudgetHit()) {
      deferred.push({ taskId: la.leadId, agentId: la.leadId, goal: la.task, reason: runBrakeReason(), attempts: 0, lastError: runBudgetWhy() });
      continue;
    }
    const lead = agents.find(a => a.id === la.leadId);
    if (!lead) continue;

    setAgentStatus(la.leadId, "working", la.task.slice(0, 80));
    if (!run.participatingAgents.includes(la.leadId)) run.participatingAgents.push(la.leadId);
    persistRunProgress();

    const workerOutputs: string[] = [];
    const leadArtifactRefsByWorker = new Map<string, string[]>();
    const leadAcceptedFilePaths = new Set<string>();

    // v5 P2a — LEAD 自拆任务：CEO 只给团队目标(la.task)，由 lead 把它拆成各 worker 的具体子任务，
    // 而不是 CEO 预分配。lead 的拆解输出真正驱动 worker（取代过去被丢弃的"协调话术"）。
    let teamWorkerIds = lead.childrenIds.filter(cid => agents.some(a => a.id === cid));
    ensureTeamMd(lead, teamWorkerIds); // v2: lead 自扫描初始化 team.md(成员能力),供团队成员注入
    // 编码型 run(公司有 code-review 验证边)的路由/产出修正(B):研究型公司无此边 → isCodingRun=false → 下方全走原分支,字节不变。
    const isCodingRun = shouldUseCodingPipeline(runRequiresCode, runForbidsCode, la.task);
    // v8 #3: trivial 任务团队内也收敛到 1 人（否则 lead 仍会按全部 children 自拆，跳过 ≥2 的拆解调用）。
    // 编码型 run:trivial 收敛时优先选验证边 producer(dev),而非盲取第一个 child(常是 PM)——否则 dev 永不产出、验证边永不触发。
    // P0(用户审计)· 规模收敛【只能裁 producer,不能移除 verifier】:要求测试的编码 run,trivial 也必须保留
    // producer + 一个独立 verifier——否则收敛后只剩 producer,独立验证被规模优化悄悄砍掉,退回开发者自测。
    // G2 · 渐进式缩编:trivial 与 medium(default)都收敛到【1 producer(+按需独立 verifier)】,只有 expand 保留完整
    // 团队(reviewer/specialist 按需)。单 worker 时下方 lead 拆解 LLM 自动跳过(≥2 才拆)→ 简单/中等任务不烧 lead
    // 拆解 token。铁律:缩编【只裁 producer,绝不移除 verifier】——requiresTests 的编码 run 必保留 producer + 1 独立
    // verifier(缺则由下游 no_available_verifier 诚实 capability_blocked,绝不静默降低验收标准)。
    {
      const before = teamWorkerIds.length;
      const cap = capTeamWorkers(teamWorkerIds, {
        scale: taskScale, isCodingRun, requiresTests: runRequiresTests,
        roleOf: (id) => agents.find(a => a.id === id)?.role, edges: activeVerificationEdges,
      });
      teamWorkerIds = cap.workers;
      if (cap.verifierGovernance === "edge_verifier_missing") {
        emit("info", la.leadId, {
          kind: "governance_degraded", reason: "edge_verifier_missing", leadId: la.leadId, producer: teamWorkerIds[0],
          message: `⚠️ 治理降级:配置的 code-review 验证边要求特定 verifier 角色,但团队无此角色 → 绝不用普通 tester 顶替(不伪装满足契约);该验证边本 run 无法满足,下游 no_available_verifier 会诚实拦 requiresTests 编码 run`,
        });
      }
      if (teamWorkerIds.length < before) {
        emit("info", la.leadId, {
          kind: "team_downsized", scale: taskScale, leadId: la.leadId, from: before, to: teamWorkerIds.length,
          selected: teamWorkerIds.map(cid => ({ id: cid, role: agents.find(a => a.id === cid)?.role })),
          message: `渐进缩编(${taskScale}):团队 ${before}→${teamWorkerIds.length} 人,选定 ${teamWorkerIds.join("、")}(只裁 producer,保留独立验证)`,
        });
      }
    }
    // ② 花名册:除 id/角色/姓名外,附每位员工的一句话专长(deriveSummary),让 lead 按能力派活,
    // 而不仅按角色名——更贴合"团队由有名有姓、各有所长的员工组成"。
    const roster = teamWorkerIds
      .map(cid => { const w = agents.find(a => a.id === cid)!; return `- ${cid} (${w.role}): ${w.name} — ${deriveSummary(w)}`; })
      .join("\n");
    let leadWorkers: WorkerAssignment[] = [];
    let teamDesign = ""; // v2 决策#3:lead 作为架构师先产出的"可分工设计",注入每个 worker(共享蓝图,修交接断裂)
    // v7 提速：只有 ≥2 个可用 worker 时才花一次 LLM 调用让 lead 拆解；单 worker 无需拆解，
    // 直接把团队目标交给它（下方兜底），省掉一次串行模型调用（简单任务的主要延迟来源）。
    if (teamWorkerIds.length >= 2) {
      // v2 决策#3:lead = 项目架构师。先出设计(整体结构/分块职责/块间接口契约/完成标准),再据此拆解,
      // 并把设计注入每个 worker —— 大家建到同一蓝图,产出能拼合(直接对治 RESULTS.md 的"各写各的"交接断裂)。
      try {
        const designPrompt = `团队目标: ${la.task}\n\n你是这个项目的**架构师**。先产出一个可分工、可执行的**设计**(不要写实现代码):\n- 整体结构 / 关键决策\n- 拆成哪几块、各块职责与边界\n- 块之间的接口/契约(谁产出什么给谁、字段/格式/口径)\n- 每块"完成"的标准\n要求简洁(≤400字),确保多个 worker 照此分工不冲突、产出能拼合。`;
        teamDesign = (await runAgent(lead, getRolePrompt("lead"), designPrompt)).trim().slice(0, 1200);
        if (teamDesign) {
          recordMessage(la.leadId, `团队设计:\n${teamDesign}`, "team");
          writeProjectMd(projectRoot, run.missionId ?? run.taskGraphId ?? run.id, `# 项目设计(${lead.name})\n\n**目标**: ${la.task}\n\n${teamDesign}`);
        }
      } catch { /* 设计失败 → 退回直接拆解 */ }
      const codingHint = isCodingRun ? "\n注意:这是工程实现任务——写代码/实现的子任务必须派给工程师(dev/engineer)角色,审查类派给 reviewer,不要把代码实现派给产品经理(pm)。" : "";
      // 结构提升 A · 拆分复用降方差:上次同类任务被验证有效的拆分注入给 lead 参考——
      // 消除"每次从零拆解"的运气成分(通宵实验同题三轮 67→13→50 的方差根因之一)。参考不强制。
      let planRef = "";
      try {
        // 与 contextBuilder 的全局注入开关同门(A/B bare 臂实测抓出的泄漏:此注入在 orchestrator 层,曾绕过开关)。
        const tpl = isInjectionEnabled() ? retrievePlanTemplate(projectRoot, { companyId: lead.companyId, taskType: classifyTaskType(goal) }) : null;
        if (tpl && tpl.split.length >= 2) {
          planRef = `\n\n## 上次同类任务验证有效的拆分(参考——按本次目标调整措辞与数量,不必照抄)\n${tpl.split.map((s, i) => `${i + 1}. ${s}`).join("\n")}`;
          emit("info", la.leadId, { kind: "plan_template_injected", message: `已注入历史有效拆分模板(${tpl.split.length} 块,验证过 ${tpl.support} 次)供 lead 参考` });
        }
      } catch { /* best-effort */ }
      const planPrompt = `团队目标: ${la.task}\n${teamDesign ? `\n你刚产出的设计:\n${teamDesign}\n` : ""}${planRef}\n你的团队成员（只能分派给这些 id，按任务规模收敛，能一人完成就别多派）:\n${roster}${codingHint}\n\n按上面的设计把团队目标拆成具体子任务并分派。每行格式严格为:\n- <workerId>: <该 worker 的具体任务>\n只输出分派行，不要解释。`;
      try {
        const planText = await runAgent(lead, getRolePrompt("lead"), planPrompt);
        leadWorkers = parseWorkerLines(planText, teamWorkerIds);
      } catch { /* 拆解失败 → 用下方兜底 */ }
    }
    // 兜底 + 防弱 lead 漏派:lead 没拆出分派,或对多 worker 团队只派了不足 2 个(弱模型 deepseek 常只派一个)。
    const minWorkers = Math.min(2, teamWorkerIds.length);
    if (leadWorkers.length < minWorkers) {
      // P0(活体抓出)· 编码 run 的兜底必须角色化,绝不广播全队。isprime run 正是因为把编码目标广播给
      // architect/ops/docs/security → 它们零文件变更被 deferred → 拖垮整 run。编码任务只选 1 可用 coder +
      // (要求测试则)1 可用 tester;无可用 coder → 启动前干净失败(记 deferred,不裸 throw,不伪造成功)。
      if (taskRequiresCode(la.task)) {
        const isAvailable = (a: AgentNodeConfig): boolean =>
          isAgentExecutable(a, activeTeamMode, runCapabilityReport, accounts);
        const sel = selectCodingFallbackWorkers(teamWorkerIds, agents, la.task, {
          requiresTests: runRequiresTests || taskRequiresTests(la.task),
          verificationEdges: activeVerificationEdges,
          isAvailable,
        });
        if (sel.failReason) {
          // no_available_executor = 无可用 coder;no_available_verifier = 有 coder 但要求测试却无独立 tester(禁自测冒充已验证)。
          const humanReason = sel.failReason === "no_available_verifier"
            ? "编码任务要求独立测试,但无可用的独立验证者(tester/reviewer 角色无匹配账号或与执行者重合)——绝不放行开发者自测冒充已验证"
            : "编码任务无可用执行者(coder 角色无匹配账号/框架容量)";
          emit("error", la.leadId, { message: `${humanReason}:${sel.failReason}——本 run 启动前判定无法可信交付,不派工、不伪造成功`, degraded: true });
          deferred.push({ taskId: `${la.leadId}/fallback`, agentId: la.leadId, goal: la.task, reason: "no_account", attempts: 0, lastError: `${sel.failReason}:${humanReason}` });
          leadWorkers = [];
        } else {
          leadWorkers = sel.workers;
        }
      } else {
        // 非编码(研究/写作)run:保留"全员各出一份视角"广播(弱 lead 安全网,每人从自身职责产出供合成)。
        const fromCeo = la.workers.filter(w => teamWorkerIds.includes(w.workerId));
        leadWorkers = fromCeo.length >= minWorkers ? fromCeo : teamWorkerIds.map(id => ({ workerId: id, task: la.task }));
      }
    }
    // Fix C:剔除无实质工作项的派工——不 recruit/dispatch 这个 worker,不占用它的 slot,不产生
    // "陪审"式的低价值调用(实测马里奥 run 里 tester/security 各自只领到一句敷衍指令、烧了约 2000 token)。
    {
      const before = leadWorkers;
      leadWorkers = before.filter(wa => {
        const worker = agents.find(a => a.id === wa.workerId);
        if (!isTrivialDispatch(wa.task, worker)) return true;
        try { emit("info", la.leadId, { message: `跳过 ${worker?.name ?? wa.workerId}:本任务无实质工作项` }); } catch { /* additive */ }
        return false;
      });
    }
    // 结构提升 A · 采集拆分候选:只收"真实拆分"(≥2 个不同子任务;兜底整发不算)。run 干净收尾时落库复用。
    try {
      const _tasks = leadWorkers.map(w => w.task).filter(Boolean);
      if (_tasks.length >= 2 && new Set(_tasks).size >= 2) runPlanCandidates.push({ companyId: lead.companyId, tasks: _tasks });
    } catch { /* best-effort */ }

    // Run this lead's workers CONCURRENTLY: each leases a least-busy account (scheduler) and runs
    // in its own git worktree (isolated edits + quality gate); accepted diffs merge back into the
    // run branch, stuck tasks defer (never block, never fake). Bounded by the global semaphore.
    const specs: WorkerSpec[] = [];
    const workerChannel: Record<string, string> = {}; // workerId → channelId（lead↔worker）
    // D4 · A2A resolved 闭环:本 lead 派出的契约消息 id,供合成消费点按真实接受面 resolve(绝不提前)。
    const delegateMsgIdByWorker = new Map<string, string>();      // workerId → delegate_task 消息 id
    const workerReportMsgIdByWorker = new Map<string, string>();  // workerId → 最新 worker_report 消息 id
    const revisionReqMsgIdByWorker = new Map<string, string[]>(); // workerId → 各轮 revision_request 消息 id
    // 服务端代为联网检索一次(worker 子进程在 Clash TUN 等环境下无法自行联网 → 服务进程网络正常,搜好注入)。
    // 失败返回空串,绝不打断运行;用 lead 任务/目标作为查询。
const allowWebAccess = loadConfig(projectRoot).permissions.allowWebAccess;
    const webBrief = (isCodingRun || !allowWebAccess) ? "" : await buildWebBrief(la.task || goal);
    if (!isCodingRun && webBrief) emit("info", la.leadId, { message: `联网检索:已为团队搜索「${(la.task || goal).slice(0, 40)}」并把真实结果注入各子任务` });
    // 结构提升 C · 覆盖多样性:通宵实验显示团队赢靠"并行覆盖面",但全员共享同一份 lead 级检索结果会把
    // 多样性抹平(都锚定同 6 条网页)。改为**按每个 worker 的子任务各搜各的**(并行,自家搜索 API 便宜);
    // 子任务与团队目标相同(兜底整发)时不重复搜。lead 级 webBrief 保留,用于 worker 全失败时的 web 兜底合成。
    const workerBriefs = new Map<string, string>();
    if (isCodingRun || !allowWebAccess) {
      for (const wa of leadWorkers) workerBriefs.set(wa.workerId, "");
    } else {
      await Promise.all(leadWorkers.map(async (wa) => {
        if (!wa.task || wa.task === la.task) { workerBriefs.set(wa.workerId, webBrief); return; }
        try { workerBriefs.set(wa.workerId, (await buildWebBrief(wa.task)) || webBrief); }
        catch { workerBriefs.set(wa.workerId, webBrief); }
      }));
    }
    for (const wa of leadWorkers) {
      const worker = agents.find(a => a.id === wa.workerId);
      if (!worker) continue;
      if (!run.participatingAgents.includes(wa.workerId)) run.participatingAgents.push(wa.workerId);
      persistRunProgress();
      // v5: lead 给该 worker 开一条 lead-worker 通道，派活消息走通道（UI 可见"谁和谁通信"）。
      const ch = runChannels.open(la.leadId, wa.workerId, "lead-worker", la.leadId, "任务分派");
      workerChannel[wa.workerId] = ch.id;
      // lead→worker 派活。D3 · 派单可观测:附 lead 决策上下文里真正注入过的记忆引用(citeMemories =
      // 唯一诚实来源;lead 未注入任何记忆 → citeMemories 返回 [] → 消息不带该字段,零破坏)。
      // D4:显式 to=[workerId](与 audience 派生的收件人一致,投递逐字节不变)让此派单进 A2A 必需闭环集;
      // 存 id,产出被合成消费时由 lead(发送方)resolve。
      const _delegateMsg = recordMessage(la.leadId, wa.task, `agents:${wa.workerId}`, undefined, ch.id, "delegate_task", citeMemories(injectedByAgent.get(la.leadId)), [wa.workerId]);
      delegateMsgIdByWorker.set(wa.workerId, _delegateMsg.id);
      // v2 决策#3:把 lead 的共享设计随子任务一起给 worker,让其建到同一蓝图、与他人对齐接口(修交接断裂)。
      // P0-1(取代旧的 code-review-edge 判定):是否编码由【任务合同 + 角色】决定(taskRequiresCode),
      // 【绝不依赖可选的 code-review 验证边】——无 review 边的普通编码公司,dev 也必须进真 git worktree(可 merge
      // 回 workRoot),不再被误判成 scratch 导致代码只当文本读回、从不落盘的假交付。code-review edge 只决定"是否加
      // 审查"(见下方 verifier 环节),不决定"是否允许代码落盘"。研究/写作任务(无代码信号)仍走 NO_CODE。
      // ceiling:目标显式禁代码时,任何子任务(哪怕措辞里有"代码/实现")一律非编码——单一事实源,不再让
      // 子任务把研究综合抬回 coding(治 d-synth 被注入"写可运行代码"→ 无文件 → no_delivery 的根因)。
      // P0-3:验证者(test/tester/qa/reviewer 或纯核验任务)。它排到 producer merge 之后的第二批执行
      // (runWorkersParallel 内按 isVerifier 分批),worktree 从已 merge 的 workRoot 新建,能看到 dev 产物。
      const workerIsVerifier = isVerifierTask(worker.role, wa.task);
      // #1 · 文本依赖型 worker(综合/事实核查):输入是其他 producer 的【文本产出】。它排在 producer 批之后
      // 单独一批(runWorkersParallel 按 dependsOnText 分批并注入上游文本)。既非编码(产文本)也非 verifier
      // (不吃文件),故 workerIsCoder 强制 false、且不计入 producer/verifier 独立门名单。
      const workerIsTextDependent = !workerIsVerifier && isTextDependentWorker(worker.role, wa.task);
      const workerIsCoder = (runForbidsCode || workerIsTextDependent) ? false : taskRequiresCode(wa.task, worker.role);
      runtimeTaskContract = tightenRuntimeTaskContract(runtimeTaskContract, {
        requiresCode: workerIsCoder,
        requiresTests: taskRequiresTests(wa.task),
      });
      runRequiresCode = runtimeTaskContract.acceptance.requiresCode;
      runRequiresTests = runtimeTaskContract.acceptance.requiresTests;
      writeRuntimeTaskContract(projectRoot, runtimeTaskContract);
      const NO_CODE = workerIsVerifier
        ? "\n\n🧪 这是验证/测试任务:上游 producer 的实现【已合并到你的工作目录】,你能直接读到它们。请在工作目录内运行**真实测试**验证——优先用 runTests 工具(自动检测框架);若测试是独立脚本,用 runShell 跑 `node <测试文件>` / `npm test` / `pnpm test`。把真实的命令、退出码、输出如实报告。**不要写新代码**,也**不要用自然语言『确认通过』替代真实执行**。"
        : workerIsCoder
        ? "\n\n🛠️ 这是工程实现任务:请**真的写出可运行代码**并用文件写入工具落盘到工作区(不要只写报告/说明文档)。完成后代码审查与测试环节会检查你的代码。"
        : "\n\n⚠️ 这是研究/分析写作任务:**禁止安装或构建任何 Python/Node 环境、禁止 pip/npm install、禁止跑代码或开容器**。请直接基于上面的联网检索结果与你的专业知识,把研究结论**写成 Markdown 报告文本**(用文件写入工具产出 .md 即可),不要执行任何代码。";
      // ⏱️ 时间纪律契约:告知该角色的真实时限 + 要求边做边落盘 partial.md——被超时终止时,已写文件/已输出
      // 的内容会被抢救并入团队成果(配合 executeViaHermes/外层的超时抢救,把"到点全损"变成"到点保底")。
      const _wTimeoutMin = Math.max(1, Math.round(getProfileForRole(worker.role).taskTimeoutMs / 60000));
      const TIME_NOTE = (workerIsCoder || workerIsVerifier)
        ? "\n\nTime discipline: finish the requested file changes first, then run the smallest relevant verification command. If the task constrains the file list, do not create partial.md, final.md, reports, or any extra files."
        : `\n\n⏱️ 时间纪律:本任务时限约 ${_wTimeoutMin} 分钟。请**先把提纲写入工作目录的 partial.md,每完成一小节就更新它**;若你被超时终止,只有已写入文件/已输出的内容会被保留并计入团队成果。收尾时把完整交付写成最终 .md。`;
      const userMessage = (teamDesign
        ? `## 团队共享设计(务必遵循,并与其他成员对齐接口)\n${teamDesign}\n\n## 你的子任务\n${wa.task}`
        : wa.task) + (workerBriefs.get(wa.workerId) ?? webBrief) + NO_CODE + TIME_NOTE;
      // P0#2 审计(确认):noCode 之前恒 true → 编码 worker 也进 scratch,代码只内联进报告、从不落盘,
      // worktree/质量门/merge 全链路在生产路径是死代码。改为按该 worker 是否真是 coder 决定。
      const leaseOverride = effEngineForMode(worker.role, activeTeamMode);
      const leaseAgent = leaseOverride
        ? { ...worker, framework: leaseOverride.framework, provider: leaseOverride.provider, model: leaseOverride.model }
        : undefined;
      // P0-3:verifier → noCode:false(进真 worktree 才能看到 producer 产物)+ isVerifier:true
      // (排到 producer merge 之后的第二批 + 零文件变更合法,不判 no_file_changes)。
      if (workerIsVerifier) verifierAgentIds.add(worker.id); else if (!workerIsTextDependent) producerAgentIds.add(worker.id); // P0-3 独立验证门:诚实收集 producer/verifier 名单(text-dependent 综合者不计入)
      const contractedUserMessage = `${formatRuntimeTaskContract(runtimeTaskContract)}\n\n${userMessage}`;
      specs.push({ agent: worker, leaseAgent, systemPrompt: composeSystemPrompt(worker.role, worker.systemPrompt), userMessage: contractedUserMessage, taskId: `${la.leadId}/${wa.workerId}`, noCode: workerIsTextDependent ? true : (!workerIsCoder && !workerIsVerifier), isVerifier: workerIsVerifier, dependsOnText: workerIsTextDependent });
    }
    // v5 P2b — lead↔worker 多轮：worker 产出→lead 评审→对不满意的打回/再派（≤LEAD_REVIEW_ROUNDS 轮）。
    const LEAD_REVIEW_ROUNDS = 2;
    const latestOutput = new Map<string, string>();   // workerId → 最新被接受的产出（汇总用最新）
    const latestFileChanges = new Map<string, FileChange[]>(); // Fix A: workerId → 该轮 fileChanges,供交叉验证 prompt 拼文件清单
    // workerId → 裸产出(content+落盘文件内容,与 admission 门控同一字符串)。契约类校验(fact-check
    // blocked_regex 等)只能跑在这上面——latestOutput 是带 lead 任务描述(**Assigned**:)的合成用复合串,
    // 任务描述提到 pip/npm install 会误杀合规产出。
    const latestRawContent = new Map<string, string>();
    // Per-worker allowance is cumulative across lead review/rework rounds.
    const workerTokensUsed = new Map<string, number>();
    const taskOf = new Map<string, string>(leadWorkers.map(w => [w.workerId, w.task]));
    let roundSpecs = specs;
    for (let round = 1; round <= LEAD_REVIEW_ROUNDS && roundSpecs.length > 0; round++) {
      // v10 P0-1: run-level token/cost brake also gates review re-runs — defer remaining specs and stop.
      if (runBudgetHit()) {
        for (const s of roundSpecs) deferred.push({ taskId: s.taskId, agentId: s.agent.id, goal: s.userMessage, reason: runBrakeReason(), attempts: 0, lastError: runBudgetWhy() });
        break;
      }
      const perWorkerTokenBudget = clampTaskBudgetToRemaining(
        config.budget.maxTokensPerTask,
        maxTokensPerRun,
        runTokens,
        roundSpecs.length,
      );
      if (perWorkerTokenBudget === 0) {
        for (const s of roundSpecs) deferred.push({ taskId: s.taskId, agentId: s.agent.id, goal: s.userMessage, reason: runBrakeReason(), attempts: 0, lastError: runBudgetWhy() });
        break;
      }
      const maxTokensPerAgent = Object.fromEntries(roundSpecs.map((spec) => [
        spec.agent.id,
        Math.min(
          perWorkerTokenBudget,
          Math.max(0, config.budget.maxTokensPerTask - (workerTokensUsed.get(spec.agent.id) ?? 0)),
        ),
      ]));
      const verifierOwnedTestPathsByAgent: Record<string, string[]> = {};
      for (const [filePath, contributors] of changeContributors) {
        if (!isTestFilePath(filePath)) continue;
        for (const contributor of contributors) {
          if (!verifierAgentIds.has(contributor)) continue;
          (verifierOwnedTestPathsByAgent[contributor] ??= []).push(filePath);
        }
      }
      const wResults = await runWorkersParallel(roundSpecs, {
        projectRoot: activeWorkRoot, scheduler, semaphore, baseline: gateBaseline,
        maxAttempts: parallelCfg.taskMaxAttempts, taskTimeoutMs: parallelCfg.taskTimeoutMs, maxNoProgressAttempts: Number(process.env.OPC_MAX_NO_PROGRESS_ATTEMPTS) || 3, // 效率闸②:编码 worker 连续零变更 N 轮停
        taskTimeoutExplicit, // ⏱️ 未显式统一配置时按 roleProfile 分角色取时限
        maxTokensPerTask: perWorkerTokenBudget, maxTokensPerAgent, runId, accountUsage,
        abortSignal: activeRunAbortController?.signal,
        verifierOwnedTestPathsByAgent,
        // P0:本 run 此前各轮已累积的交付合同(allChanges 路径)——round≥2 的 verifier-only 返工据此把独立测试
        // 绑定到 round1 的产物(本批已无 producer);round1 时 allChanges 尚空 → verifier 靠同批 producer 变更。
        priorContractFiles: allChanges.map((c) => c.path),
        emit: (t, a, p) => emit(t as any, a, p),
        execFn: runEngineCore,
      });
      for (const result of wResults) {
        workerTokensUsed.set(result.agentId, (workerTokensUsed.get(result.agentId) ?? 0) + (result.tokensUsed ?? 0));
      }
      const okThisRound: string[] = [];
      for (const r of wResults) {
        const worker = agents.find(a => a.id === r.agentId);
        const wname = worker?.name ?? r.agentId;
        const taskDesc = taskOf.get(r.agentId) ?? "";
        if (r.ok) {
          // A5:Quality Gate 三层统一入口(admission 阶段)——此处只有 L1 判断依据(尚无结构契约/
          // 语义裁决可喂),但收拢成同一个 runQualityGateLayers 调用,产出结构化 layerResults 落
          // quality_gate_result 事件(替代此前"只有一句 _acCheck.reason 塞进 lastError"),
          // L2/L3 在此阶段合法地"未配置"→ 跳过、不计入失败,行为与此前的纯 L1 门控等价。
          const deliverableBodies = readWorkerDeliverables(r.fileChanges, activeWorkRoot); // 把 worker 写的文件内容读回,修"只返回指针"的交接断裂
          // E4 · L2 workspace watch(只记录,不新增阻断):把该 worker 本轮观察到的文件变更记进
          // governance record。gate 输入侧的联动是现成的——上面的 deliverableBodies 正是从这些
          // fileChanges 读回并拼进 gate content 的(复用现有 fileChanges 管线,不重写监视器)。
          if ((activeGovernanceLevel === "L2" || activeGovernanceLevel === "L3") && (r.fileChanges?.length ?? 0) > 0) {
            try {
              appendGovernanceEvent(projectRoot, runId, {
                kind: "file_observation", agentId: r.agentId,
                files: (r.fileChanges ?? []).slice(0, 50).map(fc => ({ path: fc.path, changeType: fc.changeType })),
              });
            } catch { /* best-effort:观察记录失败不影响 run */ }
          }
          // E3→A5 合流点:governance level 作为 gate 强度参数传入(L0/L1 与旧行为逐字节一致)。
          // P0:验证者(tester/qa,agentId∈verifierAgentIds)豁免高监督 min-chars——其有效性由 TestEvidence +
          // 合同覆盖率判定,短输出("ALL_TESTS_PASSED"/退出码)不该在准入门被判失败(否则测试进不了执行,run 假失败)。
          const _gateResult = runQualityGateLayers({ content: (r.content ?? "") + deliverableBodies, governanceLevel: activeGovernanceLevel, isVerifier: verifierAgentIds.has(r.agentId) });
          try { emit("quality_gate_result", r.agentId, { ..._gateResult, producer: r.agentId, stage: "admission" } satisfies QualityGateResultEventPayload); } catch { /* additive */ }
          if (!_gateResult.passed) {
            // 占位文案/deferred 用 formatGateFailure:定位到具体失败层(结构化 layerResults),不只截一句话。
            try { emit("info", r.agentId, { message: `工件契约未通过: ${formatGateFailure(_gateResult)}`, artifactRejected: true }); } catch { /* additive */ }
            // Stage 2:接上断链领域事件(runHistoryStore/TracePage 消费),供 trace/失败报告显示被拒产物
            try { emit("artifact_rejected", r.agentId, { artifactId: r.taskId ?? r.agentId, reason: _gateResult.overallReason }); } catch { /* additive */ }
            deferred.push({ taskId: r.taskId, agentId: r.agentId, goal: taskOf.get(r.agentId) ?? "", reason: "quality_gate_failed", attempts: parallelCfg.taskMaxAttempts, lastError: `工件契约未通过: ${formatGateFailure(_gateResult)}` });
            latestOutput.set(r.agentId, `### ${wname} ⏸️ 已延后\n**Assigned**: ${taskDesc}\n\n> 原因: 工件契约未通过(${formatGateFailure(_gateResult)})——此产出未进入合成`);
            continue;
          }
          okThisRound.push(r.agentId);
          // ⏱️ 超时抢救的 partial:标题如实标注 + 记入 partialAgents(跳过结构性验证边/正向学习)+
          // 生成 timeout 反思信号(Layer E 仍学教训;不进 run.deferredTasks——它交付了,只是不完整)。
          if (r.partial) {
            partialAgents.add(r.agentId);
            salvagedTimeouts.push({ taskId: r.taskId, agentId: r.agentId, goal: taskDesc, reason: "timeout", attempts: parallelCfg.taskMaxAttempts, lastError: "超时被终止,已抢救部分产出并入合成(partial)" });
          }
          latestOutput.set(r.agentId, `### ${wname}${r.partial ? " ⏱️(部分产物·超时抢救)" : ""}${round > 1 ? `（第 ${round} 轮返工后）` : ""}\n**Assigned**: ${taskDesc}\n\n${r.content ?? ""}${deliverableBodies}`);
          latestFileChanges.set(r.agentId, r.fileChanges ?? []); // Fix A: 与 latestOutput 同步,交叉验证 prompt 用
          latestRawContent.set(r.agentId, (r.content ?? "") + deliverableBodies); // 契约校验专用裸产出(同 admission 门控输入)
          // worker→lead 回报。D4:不改投递(不加 to,team 广播语义不变),只存 id;产出被合成消费时由
          // 该 worker(消息发送方)resolve(worker_report 不属必需闭环集,resolve 仅让 jsonl 状态更完整)。
          const _workerReportMsg = recordMessage(r.agentId, r.content ?? "", runVisibilityPolicy === "isolated" ? "lead-only" : "team", undefined, workerChannel[r.agentId], "worker_report");
          workerReportMsgIdByWorker.set(r.agentId, _workerReportMsg.id);
          for (const fc of r.fileChanges ?? []) {
            if (!allChanges.some(c => c.path === fc.path)) allChanges.push(fc);
            leadAcceptedFilePaths.add(fc.path);
            let contrib = changeContributors.get(fc.path);
            if (!contrib) changeContributors.set(fc.path, (contrib = new Set()));
            contrib.add(r.agentId);
          }
          // MUP Gate A#1 · ProducerArtifactManifest 即时冻结:producer 变更被接受进 allChanges 记账的同一
          // 时刻读 workRoot 实文件 sha256 追加冻结条目(同 path 后续轮次追加新条目,消费方取最新)。
          // verifier 的合法新建测试不进清单(验证者不得创造被验证的交付物);delete 变更无内容可指纹,不进。
          // best-effort:冻结失败不炸 run——验收门缺清单条目时按契约 fail-closed(强判据不成立)。
          if (!verifierAgentIds.has(r.agentId) && (r.fileChanges?.length ?? 0) > 0) {
            try {
              freezeProducerManifestEntries(projectRoot, runId, activeWorkRoot || projectRoot,
                (r.fileChanges ?? []).filter((fc) => fc.changeType !== "delete")
                  .map((fc) => ({ path: fc.path, agentId: r.agentId, role: worker?.role ?? "worker" })));
            } catch { /* best-effort:冻结失败不影响 run 主链路 */ }
          }
          // A2A Phase 6: 把 worker 产出存为 artifact(claim-check),供后续 share_artifact / 跨 agent 引用。
          if ((r.fileChanges?.length ?? 0) > 0 || (r.content ?? "").length > 0) {
            const artifactId = artifactStore.put({
              runId: activeRunId, producedBy: r.agentId,
              kind: (r.fileChanges?.length ?? 0) > 0 ? "file-change" : "text",
              name: `${wname} 的产出${round > 1 ? `(第${round}轮)` : ""}`,
              type: (r.fileChanges?.length ?? 0) > 0 ? "code-diff" : "report",
              fileChanges: r.fileChanges?.length ? r.fileChanges : undefined,
              inlineText: (r.content ?? "").length < 4000 ? r.content : undefined,
              summary: (taskDesc || r.content || "").slice(0, 120),
              createdAt: new Date().toISOString(),
            });
            const refs = leadArtifactRefsByWorker.get(r.agentId) ?? [];
            refs.push(artifactId);
            leadArtifactRefsByWorker.set(r.agentId, refs);
          }
        } else if (r.requiresReview) {
          // MUP Gate A#3 · merge 冲突待人工决裁:文件改动未落地(不强并),不算 ok 交付也不算 deferred 失败。
          // 文本产出保留为部分结果(artifact 存证);占位含 "⏸️ 已延后" → 不进纯净合成/不 resolve A2A(诚实未闭环)。
          mergeReviewConflicts.push({ taskId: r.taskId, agentId: r.agentId, leadId: la.leadId, files: r.conflictFiles ?? [] });
          if (r.partial) partialAgents.add(r.agentId);
          const _cfList = (r.conflictFiles ?? []).slice(0, 5).join(", ");
          latestOutput.set(r.agentId, `### ${wname} ⏸️ 已延后(合并冲突待人工决裁)\n**Assigned**: ${taskDesc}\n\n> 原因: 合并冲突,文件改动未落地(绝不 -X theirs 强并;worker 分支已保留待人工合并)${_cfList ? `: ${_cfList}` : ""}`);
          if ((r.content ?? "").length > 0) {
            try {
              artifactStore.put({
                runId: activeRunId, producedBy: r.agentId, kind: "text", type: "report",
                name: `${wname} 的产出(合并冲突,文件未落地)`,
                inlineText: (r.content ?? "").slice(0, 4000),
                summary: `合并冲突待人工决裁${_cfList ? `: ${_cfList}` : ""}`.slice(0, 120),
                createdAt: new Date().toISOString(),
              });
            } catch { /* additive:存证失败不影响主流程 */ }
          }
        } else if (r.deferred) {
          deferred.push(r.deferred);
          const d = r.deferred;
          latestOutput.set(r.agentId, `### ${wname} ⏸️ 已延后\n**Assigned**: ${taskDesc}\n\n> 原因: ${deferReasonZh(d.reason)}${d.lastError ? ` — ${d.lastError.slice(0, 200)}` : ""}（已尝试 ${d.attempts} 次）`);
        }
      }
      // 最后一轮不再评审；否则 lead 评审本轮成功产出，决定是否打回。
      // v7 C 降本：单 worker 不做评审/打回（一个产出无需跨工逐项评审，且省一次 LLM 调用+可能的整轮返工）。
      if (round >= LEAD_REVIEW_ROUNDS || okThisRound.length === 0 || leadWorkers.length < 2) break;
      const reviewList = okThisRound.map(id => `## ${id} 的任务: ${taskOf.get(id)}\n产出:\n${(latestOutput.get(id) || "").slice(0, 1200)}`).join("\n\n");
      let decisions: { workerId: string; accept: boolean; feedback?: string }[] = [];
      // AgentStatus 11 态:lead 评审调用在飞期间,本轮通过的 worker 真实处于"等待审查"(waiting_review),
      // lead 真实处于"审查中"(reviewing,经 statusWhileRunning)。评审结束(含失败)全部回 idle——
      // 被打回的 worker 下一轮重新派发时由执行漏斗照常置 working/thinking。
      for (const id of okThisRound) setAgentStatus(id, "waiting_review", "等待负责人评审");
      try {
        const reviewPrompt = `你是团队负责人，评审下面 worker 的产出是否达标（目标: ${la.task}）。\n\n${reviewList}\n\n**A2A 协调**:若某 worker 在产出里写了「需要协作: …」,说明它缺同事的信息——请你从**其他 worker 的产出**里取到该信息(或你直接判断给出),把它写进对该 worker 的 REDO 要求里,让它据此完成(这就是经你中介的 worker 间协作)。\n\n对每个 worker 输出一行，格式严格为:\n- <workerId>: ACCEPT（达标）\n或\n- <workerId>: REDO: <具体返工要求>\n只输出这些行。`;
        decisions = parseReviewDecisions(await runAgent(lead, getRolePrompt("lead"), reviewPrompt, { statusWhileRunning: "reviewing" }), okThisRound);
      } catch { /* 评审失败 → 不打回，结束多轮 */ }
      finally { for (const id of okThisRound) setAgentStatus(id, "idle"); }
      const redo = decisions.filter(d => !d.accept && d.feedback);
      // E3 真A2A: review_result(accept) 送回本轮通过的 worker inbox
      // revision_request → worker 执行 → review_result 双向链可观测
      try {
        for (const d of decisions) {
          if (!d.accept) continue; // REDO 方向已在下方 revision_request 处理
          const _rv = buildContractMessage({
            runId: activeRunId, from: la.leadId, to: d.workerId,
            type: "review_result",
            summary: `第${round}轮产出评审通过，进入合成阶段`,
          });
          // A4: 走生命周期(lead↔worker 通道已开,确定性校验在调用侧成立)→ committed 落盘 + delivered 进 inbox。
          a2aBus.commitAndDeliver(
            {
              id: _rv.id, runId: activeRunId, from: la.leadId, to: [d.workerId],
              text: `[review_result:accept] 第${round}轮产出已通过评审`,
              timestamp: new Date().toISOString(),
              visibility: { audience: `agents:${d.workerId}` as MessageAudience },
              performative: "inform" as Performative,
              messageType: "review_approved",
              channelId: workerChannel[d.workerId],
            },
            [d.workerId],
          );
          emit("info", la.leadId, { contractMessage: { id: _rv.id, type: _rv.type, to: _rv.to } });
        }
      } catch { /* additive, 失败不影响 run */ }
      if (redo.length === 0) break;
      roundSpecs = redo.map(d => {
        const worker = agents.find(a => a.id === d.workerId)!;
        // P1#3 审计(确认):返工不带上一版产出 → worker 从零重做,浪费且丢已达标部分。带原文让它"修订"。
        const prevOut = (latestOutput.get(d.workerId) || "").slice(0, 3000);
        const newTask = `（返工）原任务: ${taskOf.get(d.workerId)}\n负责人反馈: ${d.feedback}\n请**基于你上一版产出修订**(保留已达标部分,只改反馈指出的问题),不要从零重做。\n\n## 你的上一版产出(节选)\n${prevOut}`;
        recordMessage(la.leadId, `打回返工: ${d.feedback}`, `agents:${d.workerId}`, undefined, workerChannel[d.workerId], "revision_request"); // lead→worker 打回
        // WS3真A2A: revision_request ContractMessage 真投进 worker inbox，下一轮 renderInboxForPrompt drain 时真进其输入。
        try {
          const _cm = buildContractMessage({ runId: activeRunId, from: la.leadId, to: d.workerId, type: "revision_request", summary: d.feedback ?? "" });
          emit("info", la.leadId, { contractMessage: { id: _cm.id, type: _cm.type, to: _cm.to } });
          // 通道已在 runChannels.open 建立，直接投递无需再走 deliverToInboxes 鉴权。
          // A4: commitAndDeliver 走生命周期 → committed 落盘 + delivered 进 inbox。
          a2aBus.commitAndDeliver(
            { id: _cm.id, runId: activeRunId, from: la.leadId, to: [d.workerId],
              text: `[revision_request] ${(d.feedback ?? "").slice(0, 400)}`,
              timestamp: new Date().toISOString(),
              visibility: { audience: `agents:${d.workerId}` as MessageAudience },
              performative: "request" as Performative,
              messageType: "revision_request",
              parts: [{ kind: "data" as const, data: { contractMessageId: _cm.id, type: _cm.type } }],
              channelId: workerChannel[d.workerId] },
            [d.workerId],
          );
          // D4:此 revision_request 带显式 to → 属必需闭环集;存 id,返工产出下一轮被合成消费时 resolve。
          const _rvArr = revisionReqMsgIdByWorker.get(d.workerId) ?? [];
          _rvArr.push(_cm.id);
          revisionReqMsgIdByWorker.set(d.workerId, _rvArr);
        } catch { /* additive,失败不影响 */ }
        // P0-3(活体抓出):返工同样要保留 isVerifier(与首派 :1650 同口径)——否则 verifier(tester/qa 等)被
        // 打回返工时丢了 isVerifier,其零文件变更(验证者本就不落盘代码)会被误判 no_file_changes 而 deferred,
        // 把一个交付已 verified 的 run 拖成 degraded。返工判定同首派:isVerifierTask(角色或纯核验任务)。
        const redoIsVerifier = isVerifierTask(worker.role, newTask);
        // #1:返工同样保留 text-dependent(综合/核查),否则丢了 dependsOnText 会退回和 producer 同批空跑。
        const redoIsTextDependent = !redoIsVerifier && isTextDependentWorker(worker.role, newTask);
        // P0-1:返工轮同样按【任务合同+角色】(taskRequiresCode)决定 noCode(与首轮一致,不依赖 code-review edge)。
        const redoIsCoder = (runForbidsCode || redoIsTextDependent) ? false : taskRequiresCode(newTask, worker.role);
        runtimeTaskContract = tightenRuntimeTaskContract(runtimeTaskContract, {
          requiresCode: redoIsCoder,
          requiresTests: taskRequiresTests(newTask),
        });
        runRequiresCode = runtimeTaskContract.acceptance.requiresCode;
        runRequiresTests = runtimeTaskContract.acceptance.requiresTests;
        writeRuntimeTaskContract(projectRoot, runtimeTaskContract);
        return { agent: worker, systemPrompt: composeSystemPrompt(worker.role, worker.systemPrompt), userMessage: `${formatRuntimeTaskContract(runtimeTaskContract)}\n\n${newTask}`, taskId: `${la.leadId}/${d.workerId}`, noCode: redoIsTextDependent ? true : (!redoIsCoder && !redoIsVerifier), isVerifier: redoIsVerifier, dependsOnText: redoIsTextDependent };
      });
      emit("info", la.leadId, { message: `第 ${round} 轮评审：${redo.length} 个 worker 被打回返工` });
    }
    // Stage 6 · 交叉验证 gate(opt-in:仅当公司声明 verification_edges)。置于轮次后、合成前——
    // verifier 否决则把 producer 产出从 latestOutput 剔除(替换为 ⏸️ 占位 → realOutputs 过滤掉 → 不进合成),
    // 即"verifier 意见真影响最终交付"(对抗审查铁律:以 latestOutput 实际内容为唯一可测指标,非仅日志/事件)。
    // 代码交付侧:否决同时从 allChanges 撤账;已 merge 进 run 分支的物理改动无廉价回滚 → 作为残留
    // 如实写进占位文案/deferred/最终报告 risks(见否决分支),绝不声称"未进交付"。
    if (activeVerificationEdges.length) {
      // P1#2 审计(确认档·低风险):验证跨 worker **并行**——每个 worker 的 LLM 核查互不依赖,串行是纯等待
      // 叠加(双边×双 worker 实测省一半墙钟)。worker **内部**的边循环保持串行(一票否决即 break 的语义)。
      // 共享状态(latestOutput 按 workerId 独立键 / 数组 push)在单线程事件循环下 await 间原子,安全。
      //
      // 架构修法(真实测试实锤:研究团队旗舰模板里"事实核查员"对 4 个 producer 逐份核查,3/4 被拒或
      // "verifier 无产出")—— 上面这条 Promise.all 本身已让跨 producer 的验证并行发起,但两处结构性
      // 缺口没堵上,补在这里:
      //   1. 并发无上限:producer 常按 role 匹配(如 "producer: dev" 命中 4 个团队成员),它们全部指向
      //      **同一个** verifier agent → 4 次 runViaEngine 瞬间同时发起,砸向同一账号。runViaEngine 是
      //      "Serial wrapper for the CEO / Lead / summary paths"——设计假设每次只有一个调用在飞,完全不
      //      经 accountPool 的租约/并发钳制(那条防线专为 parallelExecutor 的 worker 路径而设)。并行化
      //      之后必须自己补一道闸(VerifierConcurrencyGate,按 verifierId 分桶):订阅制 CLI 框架
      //      (claude-code/codex)钳到 1(镜像 accountPool.ts 的 CLI_MAX_CONCURRENT=1,避免撞风控封号),
      //      其余给一个保守默认上限,不让 N 份审查无界糊上同一账号。
      //   2. taskTimeoutMs 语义缺口:此前 runViaEngine 从不设 ctx.taskTimeoutMs,fact_check_profile_v1
      //      调的 6→7min 预算(见 84d0297)其实**从未传到这条调用链**——hermesBridge 收到 undefined 就退回
      //      全局默认(DEFAULT_HERMES_CONFIG.timeoutMs,与角色无关),"verifier 无产出"正是
      //      parseVerifierVerdict 对空输出的判定,和这个被跳过的超时強相关。现在按**每次调用各自的时限**
      //      语义补上(而非"审完全部 producer 的总时限")——并行之后每次调用只审一份，7min 给的是这一份
      //      的余量，不需要再除以 producer 数；多个 producer 并行审时，总墙钟约等于审一份，而不是审 N 份
      //      的总和。
      const verifierGate = new VerifierConcurrencyGate((verifierId) => {
        const va = agents.find(a => a.id === verifierId);
        return verifierConcurrencyCap(va?.framework);
      });
      const verifyWorker = async (w: (typeof leadWorkers)[number]): Promise<void> => {
        const out = latestOutput.get(w.workerId);
        if (!out || /⏸️ 已延后/.test(out)) return; // 已被质量门/返工剔除的不再审
        // ⏱️ 部分产物跳过交叉验证:天然不完整,拿完整报告的结构契约去审必挂,还会把根因误记成 quality_gate_failed
        // (真根因是 timeout,Layer E 已从 salvagedTimeouts 学到)。内容带显式标头进合成,由 lead/synth 如实权衡。
        if (partialAgents.has(w.workerId)) {
          try { emit("info", w.workerId, { message: `⏱️ 部分产物(超时抢救)跳过交叉验证——合成侧已标注不完整` }); } catch { /* additive */ }
          return;
        }
        const worker = agents.find(a => a.id === w.workerId);
        const edges = matchEdgesForProducer(activeVerificationEdges, w.workerId, worker?.role);
        // AgentStatus 11 态 · waiting_review:该 producer 的产出真实处于交叉验证中(验证边命中才设,
        // 结束后回 idle——它执行完本就是 idle;否决的后续状态由 deferred/合成剔除语义表达,不另造状态)。
        if (edges.length && worker) setAgentStatus(w.workerId, "waiting_review", "产出交叉验证中");
        for (const edge of edges) {
          const verifierAgent = agents.find(a => (a.id === edge.verifier || a.role === edge.verifier) && a.id !== w.workerId);
          let accept = true; let feedback: string | undefined;
          // A1-V1:verdict 的解析上下文——随 accept 一起组装成 review proposal,交 Core(reviewCommit)裁决四态。
          let verdictParsed = true; let verdictContradictory = false; let verifierErrored = false;
          let verifierId = verifierAgent?.id ?? edge.verifier ?? "programmatic";
          const verifierRole = verifierAgent?.role;
          let skipped = false;
          try {
            if ((edge.method === "llm-review" || edge.method === "code-review") && verifierAgent) {
              // P1(审计修复)· 参与者计账:后置 verification-edge verifier 真正跑引擎调用(产生 model_call + 成本 +
              // review artifact),必须计入 run.participatingAgents——绝不"跑了却不在名单"(否则"参与 N agent"证据失真,
              // 如把 CEO+lead+dev+reviewer 误报成 3 人)。此处是它确定要跑的点,幂等 push。
              if (!run.participatingAgents.includes(verifierAgent.id)) { run.participatingAgents.push(verifierAgent.id); persistRunProgress(); }
              // P2(引擎/模型异质性可见性 · 审计发现②):producer/verifier 若 provider+model 完全相同,
              // 交叉验证的独立信号很弱(实测过一个团队全员 deepseek-v4-pro,包括"事实核查员")。
              // 不自动切换(与 Phase 1 capabilityMatch"只警告不自动切换"的哲学一致,用户的引擎选择可能
              // 有订阅/限流等基建考量),只让这件事对用户可见。
              if (worker && worker.provider === verifierAgent.provider && worker.model === verifierAgent.model) {
                try {
                  emit("info", verifierId, {
                    kind: "same_model_review",
                    message: `同源审查提醒:${worker.name ?? w.workerId} 与核查方 ${verifierAgent.name ?? verifierId} 用的是同一个模型(${verifierAgent.provider}/${verifierAgent.model}),交叉验证的独立信号较弱`,
                    producer: w.workerId, verifier: verifierAgent.id, provider: verifierAgent.provider, model: verifierAgent.model,
                  });
                } catch { /* additive */ }
              }
              // 异构 LLM verifier 审查 producer 产出(真正的语义核查)。
              // P1#4 审计(确认):code-review 只审 6000 字符散文投影根本审不到真实代码 → 代码审查上限提到 24000。
              // Fix A 审计(确认):prompt 之前没有"这次改了哪些文件"的结构化信息,verifier 得自己用 shell 工具
              // 从零摸索——把该 producer 本轮 fileChanges 格式化成清单,拼在 out 前面。
              const fileChangeNote = formatFileChangesForVerifier(latestFileChanges.get(w.workerId));
              // 并发钳制:按 verifierId 分桶排队,某次审查异常/超时也会在 finally 里 release,不占死槽位。
              const releaseVerifierSlot = await verifierGate.acquire(verifierAgent.id);
              let vr: ExecResult;
              try {
                // 反过度拒绝(QuixBugs 活体教训):审查方倾向对"超出要求的完善建议/性能风格偏好/任务未要求的假设边界"
                // 也判拒绝,而本路径 拒绝→needs_revision→defer 会把【本已达标】的产出误弃。故把判据收紧为"只对能指出
                // 具体、可复现、确实违反任务要求的问题判拒绝",代码类尽量实跑/走查后再判。首行通过/拒绝格式不变(parseVerifierVerdict 依赖)。
                vr = await runViaEngine(
                  verifierAgent, getRolePrompt(verifierAgent.role),
                  `${fileChangeNote}\n\n请核查下面这份产出是否满足任务要求。先给一行明确判定(通过 或 拒绝),再给理由。\n\n判拒绝的唯一标准:你能指出一个具体、可复现、确实违反任务要求的问题(尽量给出触发它的输入/场景)。不要因为"超出要求的锦上添花改进 / 性能或风格偏好 / 任务未要求处理的假设性边界"而判拒绝;若是代码,尽量实际运行或走查确认后再判。满足任务要求即判通过。\n\n${out.slice(0, edge.method === "code-review" ? 24000 : 6000)}`,
                  // 每次调用各自的时限(而非"审完全部 producer 的总时限")——并行下每次只审一份,给满角色
                  // 画像的完整预算不会拖慢总墙钟(墙钟由并发上限下最慢的一次调用决定,不是各次相加)。
                  // AgentStatus 11 态 · reviewing:这是真实的审查节点执行(verifier 的引擎调用在飞)。
                  { taskTimeoutMs: getProfileForRole(verifierAgent.role).taskTimeoutMs, statusWhileRunning: "reviewing" },
                );
              } finally {
                releaseVerifierSlot();
              }
              const verdict = parseVerifierVerdict(vr.content ?? "");
              accept = verdict.accept; feedback = verdict.feedback;
              verdictParsed = verdict.parsed; verdictContradictory = verdict.contradictory ?? false;
            } else if (edge.method === "fact-check") {
              // 程序化:校验产出是否符合 fact-check 报告结构契约(用于 fact_checker producer;作者须把此 method 用在对的角色上)。
              // 判定对象是裸产出(latestRawContent),不是带 **Assigned**: 任务描述的复合串——lead 的
              // 措辞(如任务里提到 "npm install")不该触发 blocked_regex 误杀 worker 的合规产出。
              const pv = programmaticVerify(latestRawContent.get(w.workerId) ?? out, "fact-check");
              accept = pv.accept; feedback = pv.accept ? undefined : `未通过 fact-check 契约: ${pv.failures.slice(0, 3).join("; ")}`;
            } else {
              // llm-review/code-review 但 verifier agent 未找到(边配错),或 custom:无法程序化判断任意内容 → 跳过(不误杀)。
              skipped = true; accept = true;
              try { emit("info", verifierId, { message: `验证边 ${edge.method}(producer ${w.workerId}):无可用 verifier agent,跳过以避免误杀` }); } catch { /* */ }
            }
          } catch (e: any) {
            accept = false; feedback = `verifier 执行失败(不静默通过): ${e?.message ?? e}`; // 对抗审查铁律:异常不放行
            verifierErrored = true; // A1-V1:执行异常=无有效判定 → Core 裁决为 requires_human_review(effect 仍 defer,不放行)
          }
          if (skipped) {
            // P1#4:跳过也记录在案(skipped 标记),不再"无痕 accept"——trace/registry 能看到这条边没真审。
            runVerificationResults.push({ reviewArtifactId: "", reviewedArtifactId: w.workerId, producerId: w.workerId, verifierId, verifierRole, method: edge.method, accept: true, skipped: true, summary: "跳过:无可用 verifier agent", createdAt: new Date().toISOString() });
            continue;
          }
          let reviewArtifactId = "";
          try {
            reviewArtifactId = artifactStore.put({
              runId: activeRunId, producedBy: verifierId, kind: "text", type: "review-result",
              name: `核查 ${worker?.name ?? w.workerId}(${edge.method})`,
              inlineText: (feedback ?? (accept ? "通过" : "拒绝")).slice(0, 2000),
              summary: accept ? "通过" : `拒绝: ${(feedback || "").slice(0, 80)}`,
              createdAt: new Date().toISOString(),
            });
          } catch { /* additive */ }
          runVerificationResults.push({ reviewArtifactId, reviewedArtifactId: w.workerId, producerId: w.workerId, verifierId, verifierRole, method: edge.method, accept, summary: feedback ?? (accept ? "通过" : "拒绝"), createdAt: new Date().toISOString() });
          try { emit("verifier_result", verifierId, { producer: w.workerId, method: edge.method, accept, reason: accept ? undefined : feedback }); } catch { /* additive */ }
          // A1-V1(AI proposes, Core commits):verifier 结果只是 proposal;四态裁决(accepted/needs_revision/
          // failed/requires_human_review)由 reviewCommit(Core 侧纯规则)做出并落 review_committed 结构化事件。
          // 下方副作用(剔除合成/标记延后)由 decision.effect 驱动,不再直接读 verifier 的 accept 布尔值。
          // 注意:attemptsExhausted 刻意不传("failed" 终态无自动触发器,A3 返工循环才接)。
          const proposal: ReviewProposal = { accept, reason: feedback, parsed: verdictParsed, contradictory: verdictContradictory, verifierErrored };
          const decision = commitReview(proposal, { agentId: w.workerId, verifierId, emit });
          // A5:三层统一聚合——L3 语义层直接复用上面 reviewCommit 已算出的 decision(不重新裁决,
          // reviewCommit 仍是唯一最终裁决者);L1 用当前 out 重跑一次机械检查(与准入阶段同一函数,
          // 内容只会变多不会变空,不新增失败面);L2 仅对 fact-check 边接入 factCheckContract——它与
          // 上面 programmaticVerify 用的是同一份契约、同一份 out,结果必然与 accept 一致,不产生新的
          // defer 分支。llm-review/code-review 边暂不接构造性契约(reviewContract 存在但从未在这条路径
          // 跑过,贸然接入会在没有活体验证的前提下新增 defer 分支,风险与收益不对等,留作后续里程碑)。
          const _acForEdge = edge.method === "fact-check" ? factCheckContract : undefined;
          // E3→A5 合流点(cross_verify 阶段):governance level 同样作为 gate 强度参数传入。
          // 契约/机械层同样跑在裸产出上(与 admission 及上方 programmaticVerify 同一字符串)。
          const _gateResult = runQualityGateLayers({ content: latestRawContent.get(w.workerId) ?? out, artifactContract: _acForEdge, reviewDecision: decision, governanceLevel: activeGovernanceLevel });
          try {
            emit("quality_gate_result", verifierId, {
              ..._gateResult, producer: w.workerId, stage: "cross_verify", method: edge.method, verifierId,
            } satisfies QualityGateResultEventPayload);
          } catch { /* additive */ }
          if (!_gateResult.passed) {
            // 真影响交付:剔除出合成输入,并同步撤销代码账目——该 producer 的 fileChanges 在轮次内早已
            // merge 进 run 分支并计入 allChanges,只剔散文会让"此产出未进入最终合成"对代码交付变成谎言。
            // worktree merge 没有按 worker 的廉价回滚(无 per-worker merge commit 追踪)→ 如实降级:
            // 从 allChanges 撤账 + 占位文案/deferred/最终报告 risks 明说改动仍会随交付进入工作区。
            const residualPaths: string[] = [];
            for (const [p, contributors] of changeContributors) {
              if (!contributors.has(w.workerId)) continue;
              residualPaths.push(p);
              contributors.delete(w.workerId);
              if (contributors.size === 0) {
                changeContributors.delete(p);
                const ci = allChanges.findIndex(c => c.path === p);
                if (ci >= 0) allChanges.splice(ci, 1);
              }
            }
            if (residualPaths.length) vetoedResidualChanges.push({ agentId: w.workerId, paths: residualPaths });
            const pathList = residualPaths.slice(0, 5).join("、") + (residualPaths.length > 5 ? ` 等 ${residualPaths.length} 个文件` : "");
            const residualNote = residualPaths.length
              ? `\n> ⚠️ 该成员的代码改动(${pathList})在验证前已并入 run 分支、未回滚,仍会随交付进入工作区——请人工复核`
              : "";
            latestOutput.set(w.workerId, `### ${worker?.name ?? w.workerId} ⏸️ 已延后\n> 原因: 交叉验证未通过(${edge.method} · ${formatGateFailure(_gateResult)})——此产出未进入最终合成${residualNote}`);
            deferred.push({
              taskId: `${la.leadId}/${w.workerId}`, agentId: w.workerId, goal: taskOf.get(w.workerId) ?? "", reason: "quality_gate_failed", attempts: 1,
              lastError: `${feedback ?? formatGateFailure(_gateResult)}${residualPaths.length ? `;代码改动已并入 run 分支未回滚(${residualPaths.length} 个文件),将随交付进入工作区` : ""}`,
            });
            break; // 一条边否决即剔除,不再审后续边
          }
        }
        // waiting_review 窗口结束(通过或被否决都回 idle——否决语义已由 deferred/合成剔除承载)。
        if (edges.length && worker) setAgentStatus(w.workerId, "idle");
      };
      await Promise.all(leadWorkers.map((w) => verifyWorker(w).catch(() => { /* 单 worker 验证异常不拖垮整批(异常路径已在内部按拒绝处理) */ })));
    }
    for (const v of latestOutput.values()) workerOutputs.push(v);

    // v6 P3b: lead 审批本队 worker 发起的通信申请。同队成员 → 放行(开 peer-worker 通道 + 记一条协作消息)；
    // 跨队 → 保持 pending（待 CEO 协调），UI 显示为申请态。
    const teamWorkerSet = new Set(leadWorkers.map(w => w.workerId));
    for (const req of runChannels.pendingRequests()) {
      if (req.authPolicy === "manual") continue;
      if (!teamWorkerSet.has(req.from)) continue;
      if (teamWorkerSet.has(req.to)) {
        const ch = runChannels.grant(req.id, la.leadId);
        if (ch) {
          recordMessage(la.leadId, `批准 ${req.from} 与 ${req.to} 建立通信通道。`, "team", undefined, ch.id);
          recordMessage(req.from, `（与 ${req.to} 协作）${req.reason}`, runVisibilityPolicy === "isolated" ? "lead-only" : "team", undefined, ch.id);
          emit("info", la.leadId, { message: `已为 ${req.from}↔${req.to} 开通通信通道` });
        }
      }
    }

    // Lead composes the team's FINAL DELIVERABLE (not a work log). This is also where worker-to-worker
    // handoff is repaired: every worker's output (incl. any web-researched facts) is in workerOutputs,
    // so synthesizing the answer HERE lets a downstream consumer (the lead) actually use upstream
    // findings — fixing the case where parallel workers couldn't see each other's results.
    // v7 C 降本：单 worker 时不另花一次 LLM 总结（产出已是单一结果），直接成报告，省 token。
    // ③ 修补(Phase 0):区分"有实质产出"与"全是 ⏸️已延后/失败通知"。所有 worker 失败/延后 → 无有效产出,
    // 显式降级,绝不让协调者就空内容合成出占位假答案(实测 Config1 出过"等待子任务返回结果中…")。
    const realOutputs = [...latestOutput.values()].filter(v => v.trim() && !/⏸️ 已延后/.test(v));
    // MUP Gate A#3(合并冲突可见性):本队若有 worker 因合并冲突未落地文件改动(不强并,待人工决裁),
    // 把清单喂进合成 prompt,要求 lead 在 risks/nextSteps 里如实体现——不让报告假装一切顺利。
    // structured.risks 另有兜底(见 run 收尾)。
    const leadMergeConflicts = mergeReviewConflicts.filter(m => m.leadId === la.leadId);
    const mergeConflictNote = leadMergeConflicts.length
      ? `\n\n⚠️ 本轮执行发生过合并冲突,以下成员的文件改动【未落地】(未强并,分支保留待人工决裁),请如实在报告的风险/后续事项里体现,不要声称这些文件已交付:\n${leadMergeConflicts.slice(0, 10).map(m => `- ${m.agentId}: ${m.files.slice(0, 5).join(", ") || "(冲突文件清单缺省)"}`).join("\n")}`
      : "";
    // lead 合成阶段自己 Write 的工作区文件(如把最终报告写进 report.md)也是本 run 真实产生的改动,必须
    // 并入 allChanges,否则 changes.json 对"lead 写的文件"账面为零(approve/reject 无从操作;编码任务被
    // 误判零改动)。按 path 去重,与 worker 轮次并入 allChanges 同款。报告任务不受影响:收尾的
    // noAcceptedFileChanges 降级只在 isCodingFinal 时才看 allChanges。
    const mergeIntoAllChanges = (changes: FileChange[] | undefined): void => {
      for (const fc of changes ?? []) {
        if (!allChanges.some(c => c.path === fc.path)) allChanges.push(fc);
        leadAcceptedFilePaths.add(fc.path);
      }
      // MUP Gate A#1 · lead 合成直写的交付文件同为 producer 产物 → 同点冻结进 ProducerArtifactManifest。
      if ((changes?.length ?? 0) > 0) {
        try {
          freezeProducerManifestEntries(projectRoot, runId, activeWorkRoot || projectRoot,
            (changes ?? []).filter((fc) => fc.changeType !== "delete")
              .map((fc) => ({ path: fc.path, agentId: la.leadId, role: lead.role ?? "lead" })));
        } catch { /* best-effort:冻结失败不影响 run 主链路 */ }
      }
    };
    let leadSummary = "";
    if (realOutputs.length === 0) {
      // worker 全失败/延后:不退化成空拼接。若已注入真实网页(webBrief),让 lead 仅据此 + 专业知识兜底写出报告,
      // 避免因 worker 误建环境超时而把整次 run 判成 0 分(web 兜底几乎总能产出有效内容)。
      if (webBrief.trim()) {
        const webOnlyPrompt = `执行成员未能按时返回有效产出,但系统已为本任务联网检索到真实网页资料。请你作为研究主管,**仅基于下面的联网检索结果与你的专业知识,直接写出面向用户的最终研究报告本身**(完整、具体、有数据、在文中标注来源 URL),不要写"工作报告/未能完成"这类元叙述。\n\n目标: "${goal}"\n${webBrief}\n\n⚠️ 禁止安装/构建任何 Python/Node 环境、禁止 pip/npm install、禁止跑代码;直接写报告文本。${classifyTaskType(goal) !== "coding" ? EVIDENCE_TABLE_INSTRUCTION : ""}${mergeConflictNote}`;
        const syn = await synthesizeWithFallback(lead, webOnlyPrompt, realOutputs, goal);
        leadSummary = inlineFinalDeliverable(syn.content, syn.fileChanges, activeWorkRoot || projectRoot);
        mergeIntoAllChanges(syn.fileChanges);
        // AI Research Company:best-effort 提取证据表——找不到/解析失败不影响主流程,原样保留 leadSummary。
        const _evRows = extractEvidenceTable(leadSummary);
        if (_evRows) { evidenceRows.push(..._evRows); leadSummary = stripEvidenceTableBlock(leadSummary); }
        if (syn.degraded) { run.degraded = true; run.degradedReason = "worker 全失败,且 web 兜底合成失败"; emit("error", la.leadId, { message: "⚠️ 合成降级:worker 全失败且 web 兜底失败", degraded: true }); }
        else { emit("info", la.leadId, { message: "worker 全失败 → lead 已基于联网检索结果兜底合成报告" }); }
      } else {
        leadSummary = degradedDeliverable(goal, realOutputs);
        run.degraded = true; run.degradedReason = "所有 worker 失败/延后,无有效产出";
        emit("error", la.leadId, { message: "⚠️ 合成降级:所有 worker 失败/延后,无有效产出", degraded: true });
      }
    } else if (leadWorkers.length < 2) {
      // 单 worker:其产出本身即交付物。但若为空(worker restricted/失败),标记 degraded,不发空壳"工作报告"。
      const single = realOutputs.join("\n\n").trim();
      if (single) {
        leadSummary = `# ${lead.name} 工作报告\n\n**目标**: ${goal}\n\n${single}${mergeConflictNote}`;
      } else {
        leadSummary = degradedDeliverable(goal, realOutputs);
        run.degraded = true; run.degradedReason = "唯一 worker 未产出有效内容";
        emit("error", la.leadId, { message: "⚠️ 合成降级:唯一 worker 未产出有效内容", degraded: true });
      }
    } else {
      // 结构提升 B:公平配额进合成——绝不因头部截断把后面 worker 的覆盖面整个丢掉。
      const SYNTH_BUDGET = (Number(process.env.OPC_API_MAX_PROMPT ?? process.env.OPC_HERMES_MAX_PROMPT) || 48000) - 3000; // 覆盖度修复:默认 30k→48k(主协调者 claude-code sonnet 大 context;deepseek 兜底 64k 也够),减少输入端截断把靠后 worker 覆盖面丢掉;留指令+目标余量(旧 env 名兼容读取)
      const fair = fairShareOutputs(realOutputs, SYNTH_BUDGET);
      if (fair.compressed) emit("info", la.leadId, { kind: "synth_fair_share", message: `合成输入超预算:已按公平配额压缩 ${realOutputs.length} 份产出(每人核心内容均保留),不再头部截断` });
      const summaryPrompt = `你的团队已为以下目标完成工作。下面是各 worker 的产出（可能含联网检索到的事实/数据、分析、草稿等）。\n\n目标: "${goal}"\n\n各 worker 产出:\n${fair.outputs.join("\n\n")}\n\n请你综合这些产出，**直接产出面向用户的最终交付物本身**——完整、具体、可直接交付地回答目标，而不是"工作报告/我们做了什么"这类元叙述。**优先采用 worker 经检索/核实得到的事实与数据**（不要丢弃联网拿到的具体事实而退回泛泛而谈），保持结构清晰。直接输出最终交付物正文（中文）。\n\n⚠️ 禁止安装/构建任何 Python/Node 环境、禁止 pip/npm install、禁止跑代码;只把各成员产出综合成文本。${classifyTaskType(goal) !== "coding" ? COVERAGE_PRESERVE_INSTRUCTION + EVIDENCE_TABLE_INSTRUCTION : ""}${mergeConflictNote}`;
      const syn = await synthesizeWithFallback(lead, summaryPrompt, realOutputs, goal);
      leadSummary = inlineFinalDeliverable(syn.content, syn.fileChanges, activeWorkRoot || projectRoot);
      mergeIntoAllChanges(syn.fileChanges);
      // AI Research Company:best-effort 提取证据表——找不到/解析失败不影响主流程,原样保留 leadSummary。
      const _evRows2 = extractEvidenceTable(leadSummary);
      if (_evRows2) { evidenceRows.push(..._evRows2); leadSummary = stripEvidenceTableBlock(leadSummary); }
      if (syn.reason && !syn.degraded) emit("info", la.leadId, { message: syn.reason });
      if (syn.degraded) {
        run.degraded = true; run.degradedReason = syn.reason;
        emit("error", la.leadId, { message: `⚠️ 合成降级:${syn.reason}`, degraded: true });
      }
    }

    // D4 · 合成消费即闭环(唯一诚实 resolve 点,绝不提前):latestOutput 里非空、非"⏸️ 已延后"占位的产出 =
    // 真正被合成消费进 leadSummary 的产出(与上方 realOutputs 同一口径)。仅对这些 worker resolve 其 delegate_task
    // (由 lead 发送方 resolve)+ worker_report(由 worker 发送方 resolve)+ 各轮 revision_request(返工被接受)。
    // deferred/被否决/降级剔除的产出 → latestOutput 是占位串 → 不在此集 → 对应消息保持未 resolved(诚实:未闭环)。
    for (const [wid, out] of latestOutput.entries()) {
      if (!out.trim() || /⏸️ 已延后/.test(out)) continue; // 未进入最终合成的产出不闭环
      // P0-6:不在此当场 resolve,累积成候选,run 收尾按 DeliveryAcceptance=verified 才 resolve(见 :resolve 收尾块)。
      const dId = delegateMsgIdByWorker.get(wid);
      if (dId) deliverableResolveMsgs.push({ id: dId, by: la.leadId });                 // 派单闭环:产出被合成消费(by=lead 发送方)
      const wrId = workerReportMsgIdByWorker.get(wid);
      if (wrId) deliverableResolveMsgs.push({ id: wrId, by: wid });                     // 汇报闭环(by=worker 发送方)
      for (const rvId of revisionReqMsgIdByWorker.get(wid) ?? []) deliverableResolveMsgs.push({ id: rvId, by: la.leadId }); // 返工链
    }

    recordMessage(la.leadId, leadSummary, "all", undefined, undefined, "lead_report"); // team report visible to the whole org / CEO
    // 交接裁决必须等待 run 级 DeliveryAcceptance。这里只登记候选，不提前声称成功。
    const ceoAgent = agents.find(a => a.role === "ceo");
    if (ceoAgent) {
      pendingLeadOutcomes.push({
        leadId: la.leadId,
        ceoId: ceoAgent.id,
        task: la.task,
        acceptedArtifactRefs: [...new Set(
          [...latestOutput.entries()]
            .filter(([, output]) => output.trim() && !/⏸️ 已延后/.test(output))
            .flatMap(([workerId]) => leadArtifactRefsByWorker.get(workerId) ?? []),
        )],
        acceptedFilePaths: [...leadAcceptedFilePaths].filter((filePath) =>
          allChanges.some((change) => change.path === filePath),
        ),
      });
    }

    // Archive per-lead report
    archiveReport(projectRoot, la.leadId, goal, leadSummary);
    // v2 团队能力史(决策#2):把本次任务追加进 team.md 的「最近任务」区(保留最近3条),供 CEO 按战绩选队。
    appendTeamTask(projectRoot, la.leadId, `${run.degraded ? "⚠️降级 " : ""}「${goal.slice(0, 80)}」(成员 ${leadWorkers.map(w => w.workerId).join("/") || "—"})`);
    perLeadReports.push({ leadId: la.leadId, leadName: lead.name, workerResults: workerOutputs });
    leadResults.push(leadSummary);

    setAgentStatus(la.leadId, "idle");
  }

  // Real quality gating already happened per-worker (accept-and-commit / discard-and-defer).
  // The run is "clean" iff nothing had to be deferred; accepted diffs are already committed.
  const initiallyAllClean = deferred.length === 0;

  // Persist deferred list into the trace ("统一整理") so the UI/report can surface it.
  if (deferred.length > 0) emit("info", undefined, { kind: "deferred_tasks", deferred });

  // MUP Gate A#2 · run 级 simulated 聚合(泳道2 载体的消费端):任一 model_call_finished 带 simulated:true
  // (或 payload.provider==="mock" 兜底,覆盖 handler 被覆写/存量事件)即整 run 判 simulated。模拟成功绝不
  // 形成真实成功/经验/记忆/复用/公司知识——加性字段:status 四态不动,mock E2E 的引擎层 done 不破。
  const runSimulated = getRunHistory().getEvents().some((e) => {
    if (e.type !== "model_call_finished") return false;
    const p = e.payload as { simulated?: unknown; provider?: unknown } | undefined;
    return p?.simulated === true || p?.provider === "mock";
  });
  if (runSimulated) run.simulated = true;
  // MUP Gate A#3 · 合并冲突待人工决裁的 worker:其"完成"未落地,不进任何正向学习(与 partialAgents 同款个体排除)。
  const conflictAgents = new Set(mergeReviewConflicts.map((m) => m.agentId));

  // A6b/D2 · ACP→legacy CLI 降级信号**提前计算**(finalize 段原地判定 :2209 下移到此处复用)。
  // 供下面 plan_template 落库 / procedural_skill 挖掘 / run_conclusion commit 三处「干净经验」门控——
  // 降级 run 不沉淀干净模板/技能/记忆。判据与 finalize / runtimeContract 完全一致(info + kind=
  // executor_selected + 非空 degradedReason);此处所有 worker 均已执行完,executor_selected 事件已齐,提前读安全。
  // 同一 const 复用到下方 :2209 的 run.executorDegraded 定稿与收尾 structured.risks(:2471)。
  const degradedExecEvents = getRunHistory().getEvents().filter(
    (e) => e.type === "info"
      && (e.payload as any)?.kind === "executor_selected"
      && typeof (e.payload as any)?.degradedReason === "string"
      && (e.payload as any).degradedReason,
  );
  const executorDegradedSignal = degradedExecEvents.length > 0;
  // Stage automatic learning until the final EvidenceManifest has been written
  // and independently verified. Layered memory is the only new canonical write.
  const governedMemoryCandidates: Array<Parameters<typeof proposeMemory>[1]> = [];
  const governedFailureCandidates: ReflectionMemoryCandidate[] = [];

  // Phase 4 self-evolution: learn ONLY from fully-clean runs (no deferred). For each worker that
  // actually did verifiable work, append its per-agent persistent md memory and record a D 层
  // project memory (the "differentiated brain" closing the loop — next same-kind task gets these
  // injected via contextBuilder § 相关历史经验). Minting/persisting standalone "workflow-*" skills
  // into skillStore(origin:"memory") used to happen here too — removed: P4 procedural_skill
  // (upsertProceduralSkill below) is now the only mechanism that turns a role's successful tool
  // sequence into something reusable, and it doesn't pollute the user-facing skill library.
  // MUP Gate A#2:simulated run 不做任何正向学习(mock 的"成功经验"是假的)。
  if (initiallyAllClean && !runSimulated) {
    for (const aid of new Set(run.participatingAgents)) {
      const agent = agents.find(a => a.id === aid);
      if (!agent || agent.role === "ceo" || agent.role === "lead") continue;
      if (partialAgents.has(aid)) continue; // ⏱️ 超时抢救的部分产出不算"成功经验",不做正向强化(审查 high)
      if (conflictAgents.has(aid)) continue; // MUP Gate A#3:合并冲突未落地的产出不算成功经验
      const toolCallLog = traceEvents
        .filter(e => e.type === "tool_call" && e.agentId === aid)
        .map(e => (e.payload as any)?.name)
        .filter((n): n is string => typeof n === "string");
      if (toolCallLog.length === 0) continue;
      // Only workers that actually changed files can produce a reusable success
      // candidate. Read-only tool activity is not experience.
      const wrote = toolCallLog.some((t) => {
        const n = t.toLowerCase();
        return n.includes("write") || n.includes("edit") || n.includes("apply_patch");
      });
      if (!wrote) continue;
    }
  }

  // P4 · C:从**个体完成干净**的 worker(不在 deferred 集里)挖 procedural_skill —— 即便兄弟 worker 超时被降级兜底,
  // 已成功完成的 worker 的真实工具序列仍是有价值经验,不该被整-run allClean 门一票否决。规则化、不调 LLM、best-effort。
  try {
    // D2/A6b · 降级 run 不产干净技能:run 已降级或有 ACP→legacy CLI 降级信号 → 整体跳过挖掘。
    // 注:纯 deferred(无其它降级)在此处 run.degraded 尚未置真(deferred 降级在 finalize :2194 才写),
    // 故"兄弟 worker 超时被兜底、本 worker 干净完成"的场景仍照常挖掘(与既有语义一致)。
    const deferredIds = new Set(deferred.map((d) => d.agentId));
    // MUP Gate A#2:simulated run 不产 procedural_skill(mock 工具序列不是真实成功经验)。
    for (const aid of (!runSimulated && shouldPersistCleanExperience(run, executorDegradedSignal)) ? new Set(run.participatingAgents) : new Set<string>()) {
      if (deferredIds.has(aid) || partialAgents.has(aid) || conflictAgents.has(aid)) continue; // 自己降级/超时抢救/冲突未落地的 → 不学它的序列(不是完整成功)
      const ag = agents.find((a) => a.id === aid);
      if (!ag || ag.role === "ceo" || ag.role === "lead") continue;
      // 归一工具名(去路径/参数/防泄漏)+ 折叠连续重复 → 更像可复用"模式",不是这次的原始命令流水。
      const seqRaw = traceEvents.filter((e) => e.type === "tool_call" && e.agentId === aid).map((e) => normalizeToolName((e.payload as any)?.name)).filter(Boolean);
      const seq: string[] = [];
      for (const t of seqRaw) if (seq[seq.length - 1] !== t) seq.push(t);
      if (seq.length >= 2) {
        governedMemoryCandidates.push({
          title: `${ag.role} 的可复用执行经验`,
          summary: `完成「${goal.slice(0, 80)}」时使用了已验证的工具序列`,
          text: `任务类型 ${classifyTaskType(goal)}；目标「${goal.slice(0, 160)}」；工具序列：${seq.slice(0, 20).join(" -> ")}。`,
          objectType: "success_experience",
          scope: "agent",
          scopeId: aid,
          sourceType: "run",
          sourceRunId: runId,
          evidenceIds: artifactStore.list().slice(0, 8).map((artifact) => artifact.id),
        });
      }
    }
  } catch { /* best-effort:技能挖掘失败不影响 run */ }

  // 结构提升 A · 拆分模板落库:run 不降级且零延后(拆分被完整验证过)才存——下次同类任务 lead 直接参考,
  // 把"拆解运气"变成"拆解经验"。同 company+taskType 复现 → support+1、以最新干净拆分为准。
  try {
    // D2/A6b · 降级 run(含 ACP→legacy CLI 降级信号)不产干净拆分模板;MUP:simulated / 未决冲突同理。
    if (!runSimulated && mergeReviewConflicts.length === 0 && shouldPersistCleanExperience(run, executorDegradedSignal) && deferred.length === 0 && runPlanCandidates.length > 0) {
      for (const cand of runPlanCandidates) {
        governedMemoryCandidates.push({
          title: `${classifyTaskType(goal)} 任务拆分经验`,
          summary: `已验证的 ${cand.tasks.length} 步任务拆分，可供同类任务参考`,
          text: `目标「${goal.slice(0, 160)}」的有效拆分：${cand.tasks.slice(0, 20).join(" | ")}。`,
          objectType: "success_experience",
          scope: "company",
          scopeId: cand.companyId,
          sourceType: "run",
          sourceRunId: runId,
          evidenceIds: artifactStore.list().slice(0, 8).map((artifact) => artifact.id),
        });
      }
    }
  } catch { /* best-effort:模板落库失败不影响 run */ }

  // Layer E · 失败反思(纠错记忆,与上面"从成功里学 skill"对称):**只在有失败信号时**触发。
  // MemoryManager(便宜 deepseek,故意不用出问题的 Lead 自审)从 deferred/降级里提炼**结构化教训**,
  // 经硬过滤+去重版本化 commit;下次同角色+同任务类型任务由 contextBuilder 注入为"避免重犯"约束。
  // P0(审计修复)· 反思会追加 lesson 事件到 events.jsonl + lesson 台账到 memory_proposals.json——这两者都在
  // EvidenceManifest 哈希范围内。此前 void fire-and-forget → 反思在 manifest 构建之后异步落盘 → events.jsonl/
  // memory_proposals 哈希过期,verify 端点失配却仍标 evidenceIntegrity=ok(与 run_finished 同类的时序假阳性)。
  // 改为:反思与 run 收尾(报告/账本生成)**并行**跑,但在尾部**建 manifest 前 await 它**(见本函数尾部),
  // 使 manifest 哈希到反思落定后的最终字节。deepseekChat 自带 30s 超时,await 有界不挂死。
  let _reflectionPromise: Promise<unknown> | null = null;
  try {
    const _reflSignals = collectReflectionSignals({
      // ⏱️ salvagedTimeouts 一并喂给反思:抢救成功的超时不在 run.deferredTasks 里(它交付了),但教训必须学(审查 high)
      deferred: [...deferred, ...salvagedTimeouts].map((d) => ({ agentId: d.agentId, reason: d.reason, attempts: d.attempts, lastError: d.lastError, goal: d.goal })),
      degraded: run.degraded, degradedReason: run.degradedReason,
      roleOf: (id) => agents.find((a) => a.id === id)?.role,
      teamIdOf: (id) => { const a = agents.find((x) => x.id === id); return a ? (a.role === "lead" ? a.id : a.parentId) : undefined; }, // 每个失败 agent 自己的 lead → 多-lead run 教训绑对团队
      companyIdOf: (id) => agents.find((a) => a.id === id)?.companyId, // 每个失败 agent 所属公司 → 跨公司硬隔离
    });
    // MUP Gate A#2:simulated run 不做反思沉淀——mock 的失败/超时信号同样是模拟的,不进 Layer E 教训库。
    if (_reflSignals.length > 0 && !runSimulated) {
      const _dsKey = resolveProviderKey(projectRoot, "deepseek");
      if (_dsKey) {
        // 直连 deepseek(不走 runViaEngine)→ 完全不碰模块级 run 计数/事件/agent tokenUsage,隔离并发 run。best-effort。
        // 不 void:留 promise,尾部建 manifest 前 await(反思的 lesson 事件/台账必须先落定再哈希)。
        _reflectionPromise = reflectOnRun({
          projectRoot, runId, goal, companyId: ceo.companyId, teamId: perLeadReports[0]?.leadId, signals: _reflSignals,
          // P0(用户要求)· 反思由 collectReflectionSignals 只在有失败/降级/超时抢救信号时才触发 → 本 run 按构造即
          // "非 clean";一律传 failed_or_degraded,让所有失败反思只 proposed 等人工批准(不再放过 timeout/retry)。
          runOutcome: "failed_or_degraded",
          callModel: (sys, user) => deepseekChat(_dsKey, sys, user),
          nowIso: new Date().toISOString(),
          log: (m) => emit("info", undefined, { kind: "reflection", message: m }),
          // run-pinned:只在**仍是本 run** 时 emit(deepseek 回来时若已开下一个 run,别把迟到 telemetry 记到人家 run 里)。
          emitEvent: (type, payload) => { if (getRunId() === runId) emit(type as Parameters<typeof emit>[0], undefined, payload); },
        }).then((candidates) => {
          governedFailureCandidates.push(...candidates);
        }).catch(() => { /* 反思失败静默 */ });
      }
    }
  } catch { /* 反思绝不影响 run */ }

  // D3:finalize 只 stage 本 run 交付合同(allChanges)的精确路径,绝不 add -A 打包用户游离文件。
  const finalizeResult = finalizeRunBranch(runId, true, [...new Set(allChanges.map((c) => c.path))]);

  // Finalize run totals BEFORE building the report: generateMdReport/Html interpolate these values.
  run.endedAt = new Date().toISOString();
  run.totalTokens = callRecords.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
  run.totalCostUsd = callRecords.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
  run.deferredTasks = deferred;
  run.accountUsage = accountUsage;

  const finalFailureReasons: string[] = [];
  if (deferred.length > 0) finalFailureReasons.push(`${deferred.length} deferred task(s)`);
  if (!finalizeResult.ok) finalFailureReasons.push(finalizeResult.error ?? "git finalize failed");
  // P0 · DeliveryAcceptance —— 唯一最终交付门槛(deliveryAcceptance.ts)。requiresCode/requiresTests 由派单时
  // 按【任务合同 + 角色】累积(runRequiresCode/runRequiresTests,取代旧的靠 goal 文本单点 classifyTaskType 分类);
  // CEO 直答(directAnswer)不产文件、不判编码交付。编码任务:文件必须【真实存在于最终 workRoot】+ 有真 fileChanges
  // +(要求测试则)TestEvidence 且 exitCode=0,否则非 verified。这就是"证据层(manifest 诚实记空)↔ 状态层
  // (run.status)"之间缺失的那道反馈边:scratch 假交付(文件未落盘)在此被判 no_delivery → 计入失败 → run 失败,
  // 且下方 A2A resolved / memory auto-commit 只消费 verified。宪法:证据不足即失败,绝不把 worker 文本当文件交付。
  const _daTestEvidence = deriveTestEvidence(getRunHistory().getEvents());
  // P0(活体抓出 · Gate A)· directAnswer/Quick Run 绝不能弱化不可变用户目标的交付合同下限:只有当**目标本身
  // 不要求代码**(runRequiresCode=false,纯研究/对话)时,直答才判 not_required。若不可变目标要求代码(runRequiresCode
  // =true)却走了直答/Quick Run(零文件产出)→ 必须照编码交付评估(allChanges=[] → no_delivery → run failed),
  // 绝不因"CEO 分诊直答"把要求代码的任务当 not_required 假成功(违反"任一缺失/降级则 failed 绝不 done")。
  // MUP:simulated run(哪怕是 CEO 直答)一律经 evaluateDeliveryAcceptance 判 simulated_run,绝不给
  // not_required 的纯净等价态;D2:partialAgents 非空 → hasPartialSalvage,not_required 不再纯净通过。
  const hasPartialSalvage = partialAgents.size > 0;
  // MUP Gate A#1 · ProducerArtifactManifest 读回(冻结于 allChanges 记账点,storage 层落盘):验收门的
  // producer 来源集/hash 基准一律来自冻结清单,不再收尾从 allChanges+CODE_PATH_EXT 现算(可变派生值 +
  // .html/.css 误杀,均已废除)。清单缺失(冻结失败)→ 空数组,强判据 fail-closed,绝不虚构。
  const _pmEntries = loadProducerManifest(projectRoot, runId)?.entries ?? [];
  const deliveryAcceptance: DeliveryAcceptance = (directAnswer && !runRequiresCode && !runSimulated && !hasPartialSalvage)
    ? { status: "not_required", requiresCode: false, requiresTests: false, reasons: [] }
    : evaluateDeliveryAcceptance({
        requiresCode: runRequiresCode,
        requiresTests: runRequiresTests,
        workRoot: activeWorkRoot || projectRoot,
        allChanges,
        testEvidence: _daTestEvidence,
        hasPartialSalvage,
        simulated: runSimulated,
        // MUP Gate A#1(决策①)· 独立验证由任务合同派生:requiresCode && requiresTests 即要求,不再取决于
        // "是否恰好派了 verifier"(旧口径下没派 tester 的 run 全绿自测即 verified,矩阵4 因此不成立)。
        // 无强绑定独立证据的全绿自测 → tests_ran_unbound("已运行测试·未强绑定"),run 诚实失败。
        requiresIndependentVerification: runRequiresCode && runRequiresTests,
        producerAgentIds: [...producerAgentIds],
        verifierAgentIds: [...verifierAgentIds],
        // 清单模式:① producer 来源门从清单非测试条目派生(任意扩展名,.html/.css 交付不再误杀);
        // ② 验收重算 workRoot 实文件 hash 与最新条目交叉,失配 → artifact_mismatch;
        // ③ verified 强判据(Node 族)= 解析链证据(resolvedProducerFiles)× 清单 hash 一致。
        producerManifestEntries: _pmEntries,
        verifierChangeFileCount: allChanges.filter((c) =>
          c.changeType !== "delete" &&
          [...(changeContributors.get(c.path) ?? [])].some((aid) => verifierAgentIds.has(aid)),
        ).length,
        // Model C 引用门的 producer 来源(非 Node 族仍消费;Node 族由解析链强判据接管)。
        producerSourcePaths: [...new Set(_pmEntries.filter((e) => !isTestFilePath(e.path)).map((e) => e.path))],
        // P0 · 合同覆盖门:通过的独立测试必须至少一条绑定本 run 交付合同(contractBindsTest 共享判据),否则拒
        // ——堵住"任意变更 + 任意(遗留)测试通过 = 假成功"窗口。合同 = allChanges(本 run merge 回 workRoot 的
        // 变更集)∪ base→HEAD 的 git 真实改动(run 级基线,兜住 allChanges 记账遗漏,且天然排除前序 run 的遗留文件)。
        contractFiles: [...new Set([
          ...allChanges.map((c) => c.path),
          ...gitChangedSince(activeWorkRoot || projectRoot, runBaseCommit),
        ])],
      });
  run.deliveryAcceptance = deliveryAcceptance;
  if (!isDeliveryVerified(deliveryAcceptance) && deliveryAcceptance.status !== "simulated_run") {
    // MUP Gate A#2 例外:simulated_run 不折叠进 failed(mock E2E 的 done 保住)——它永不 verified、
    // 永不纯净(allClean=false + finalState 至少 degraded),全部正向消费点以 isDeliveryVerified=false 短路。
    finalFailureReasons.push(`交付验收未通过(${deliveryAcceptance.status}): ${deliveryAcceptance.reasons.join("; ") || "交付证据不足"}`);
  }
  // D2 · run 级 partial 痕迹:抢救文本仍保留、抢救 worker 仍不进 deferred,但 run 绝不纯净 done。
  if (hasPartialSalvage || deliveryAcceptance.partialDelivery === true) run.partialDelivery = true;
  // 缺口②定案(2026-07-18 活体:dr-team 两 run 报告 rubric 88-94% 却因 1 个被交叉验证拒绝的
  // worker 标 failed)——语义对齐 partial 抢救:两者同为"某 worker 的产出没进合成,但团队交付了"。
  // 仅当 deferred 是【唯一】失败原因、finalize 成功、且交付验收已通过/不要求时,run 是"降级交付"
  // (status=done + degraded → finalState 至少 degraded,绝不 verified;干净经验/正向消费门均已由
  // allClean=false 挡住)。deferred 与任何硬失败(验收未过/finalize 失败)并存时维持 failed 不变。
  // 不造假宪法核对:报告如实带"⏸️ 已延后"标注,degradedReason 保留 deferred 计数——降级可见,不虚标纯净。
  const deferredOnlyDegrade = deferred.length > 0
    && finalFailureReasons.length === 1
    && finalizeResult.ok
    && (deliveryAcceptance.status === "not_required" || isDeliveryVerified(deliveryAcceptance));
  if (finalFailureReasons.length > 0) {
    run.degraded = true;
    run.degradedReason = [run.degradedReason, ...finalFailureReasons]
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
      .join("; ");
  }
  run.status = run.degraded && !deferredOnlyDegrade ? "failed" : "done";
  // MUP Gate A#1 · 消费前子集自验:A2A resolve / memory commit 等正向消费发生前,对【合同文件存在 + hash
  // 与 producer-manifest 最新条目一致】做子集自验(evidenceManifest 全量自验仍留 run-end 绝对最后,时序铁律
  // 不动)。失配 → 正向消费全部短路(诚实未闭环),并 emit 领域事件留痕。
  const _preConsumeSubset = verifyContractSubsetAgainstManifest(
    activeWorkRoot || projectRoot,
    allChanges.filter((c) => c.changeType !== "delete").map((c) => c.path),
    _pmEntries,
  );
  if (!_preConsumeSubset.ok) {
    try {
      emit("info", undefined, {
        kind: "pre_consume_subset_verify_failed",
        mismatches: _preConsumeSubset.mismatches.slice(0, 10),
        message: `消费前子集自验失败:${_preConsumeSubset.mismatches.length} 个合同文件与产物清单冻结指纹不一致——A2A resolve/memory commit 等正向消费短路`,
      });
    } catch { /* additive */ }
  }
  // lead→CEO outcome is committed only after the authoritative acceptance decision. Failed,
  // no_delivery, or empty-output teams emit dependency_blocked (not part of required A2A closure).
  for (const pending of pendingLeadOutcomes) {
    try {
      const decision = decideLeadOutcomeA2A({
        task: pending.task,
        deliveryAccepted: isDeliveryVerified(deliveryAcceptance) && _preConsumeSubset.ok,
        acceptedArtifactRefs: pending.acceptedArtifactRefs,
        acceptedFileCount: pending.acceptedFilePaths.filter((filePath) =>
          allChanges.some((change) => change.path === filePath),
        ).length,
        acceptanceStatus: deliveryAcceptance.status,
      });
      const message = buildContractMessage({
        runId: activeRunId, from: pending.leadId, to: pending.ceoId,
        type: decision.contractType, summary: decision.summary, artifactRefs: decision.artifactRefs,
      });
      a2aBus.commitAndDeliver({
        id: message.id, runId: activeRunId, from: pending.leadId, to: [pending.ceoId],
        text: decision.text, timestamp: new Date().toISOString(),
        visibility: { audience: "lead-only" as MessageAudience }, performative: "inform" as Performative,
        messageType: decision.messageType, artifactRefs: decision.artifactRefs,
      }, [pending.ceoId]);
      emit("info", pending.leadId, { contractMessage: { id: message.id, type: message.type, to: message.to } });
      if (decision.requiredArtifactHandoff) handoffMsgs.push({ id: message.id, by: pending.ceoId });
    } catch { /* additive, failure must not change run outcome */ }
  }
  // P0-6:交付已验证(verified 或研究型 not_required)且消费前子集自验通过,才闭环 A2A 的 delegate_task/
  // worker_report/revision_request(合成消费点已累积成 deliverableResolveMsgs 候选);假交付/未验证/指纹
  // 失配的 run 这些消息保持 unresolved——诚实未闭环。
  if (isDeliveryVerified(deliveryAcceptance) && _preConsumeSubset.ok) {
    for (const m of deliverableResolveMsgs) a2aBus.resolve(m.id, m.by);
  }
  let allClean = run.status === "done" && !run.degraded && deferred.length === 0;
  // A6b · ACP 硬门槛:统计本 run 的 ACP→legacy CLI **降级**执行(判据与 runtimeContract 的 deriveAgentExecutors /
  // deriveRunDiagnostics 完全一致:info + kind=executor_selected + degradedReason 非空——正常 ACP/api 选路不带 degradedReason,
  // 显式关 ACP 的逃生门 legacy_cli 也不带,均不计)。刻意**不复用** run.degraded:上一行 `run.degraded ? "failed"` 会把合法
  // 保底降级整体误杀成 failed。有降级 → run.executorDegraded=true + allClean=false 叠加(在 run.status 判定之后)+ emit
  // executor_degraded_run。allClean=false 经下方 run_finished 事件流(run-history append + 末尾 live emit)透传,
  // run story/history/reporting 如实呈现"非纯净成功"、result.json 亦带出 executorDegraded(见 buildRunResultContract)——
  // 降级 run 不虚标纯净成功。D2:degradedExecEvents/executorDegradedSignal 已在上方(:2078 后)提前计算并复用,
  // 更早的 procedural_skill 挖掘 / plan_template 落库 / run_conclusion commit 三处「干净经验」门控已扩成
  // (run.degraded || executorDegradedSignal),降级 run 不再产这三类干净经验。此处只做 run.executorDegraded 定稿。
  if (executorDegradedSignal) {
    run.executorDegraded = true;
    allClean = false;
    emit("info", undefined, { kind: "executor_degraded_run", count: degradedExecEvents.length, message: `本 run 有 ${degradedExecEvents.length} 次 ACP→legacy CLI 降级执行,不计为纯净成功` });
  }
  // MUP 加性终态信号:simulated / partial / 未决合并冲突,任一存在都绝不纯净成功(status 四态不动)。
  if (run.simulated) {
    allClean = false;
    emit("info", undefined, { kind: "simulated_run", message: "🧪 本 run 含 mock/simulated 模型调用:不计为真实成功,无记忆/复用/公司知识正向效应,finalState 至少 degraded" });
  }
  if (run.partialDelivery) allClean = false;
  const hasUnresolvedConflict = mergeReviewConflicts.length > 0 || finalizeResult.conflict === true;
  if (hasUnresolvedConflict) {
    allClean = false;
    run.mergeConflicts = [
      ...mergeReviewConflicts.map((m) => ({ taskId: m.taskId, agentId: m.agentId, files: m.files })),
      ...(finalizeResult.conflict === true ? [{ taskId: "__finalize", agentId: "orchestrator", files: finalizeResult.conflictFiles ?? [] }] : []),
    ];
    emit("info", undefined, {
      kind: "run_requires_review",
      conflicts: run.mergeConflicts.slice(0, 20),
      message: `⛔ 本 run 存在 ${run.mergeConflicts.length} 处未决合并冲突(未强并,分支已保留)——finalState=requires_review,待人工决裁`,
    });
  }
  // A6/终验 · 证据链完整性:默认 ok,下面各关键证据写盘点位经 guardEvidenceWrite 记账;收尾 finalizeEvidenceIntegrity 收敛。
  run.evidenceIntegrity = "ok";
  const evidenceState: EvidenceIntegrityState = { integrity: "ok", criticalFailed: false, failures: [] };
  // ⑤ 决策#5:run 收尾把本次项目历程累积进 company.md(持续维护,非只冷启动 init)。按公司隔离。
  // MUP Gate A#2:simulated run 不进公司知识——mock 的"项目历程"是模拟的,不形成公司经验。
  if (!run.simulated) {
    appendCompanyKnowledge(projectRoot, `${run.degraded ? "⚠️降级 " : ""}${directAnswer ? "[CEO直答] " : ""}「${goal.slice(0, 80)}」`, undefined, runCompany?.id ?? DEFAULT_COMPANY_ID);
  }

  // Generate composite report for run directory (backward compat) + deferred section
  // Stage 9 安全:report/committed-memory 会经 Stage 8 export/分享流出本机 → 落盘前脱敏密钥(agent 若 echo 了 key)。
  let md = redactSecrets((teamFitNote ? `> ⚠️ **团队匹配提醒**:${teamFitNote}\n\n` : "") + generateMdReport(run, goal, leadResults) + buildDeferredSection(deferred));
  let html = redactSecrets(generateHtmlReport(run, goal, leadResults));

  // artifactContract: 极宽松护栏 — 只拦明显垃圾(HTML 文档/纯空/pip install 刷屏)
  // 普通 markdown 报告必须通过;宁可漏拦不可误杀。
  try {
    if (!run.degraded) {
      const _acContract: ArtifactContract = {
        artifactType: "final",
        filePattern: "*.md",
        requiredSections: [],
        acceptanceCriteria: [
          { kind: "blocked_regex", pattern: "^[\\s\\S]{0,100}<html[\\s>]" },
        ],
        onFailure: "degrade",
      };
      const _acVr = validateArtifact(md, _acContract);
      const _acEmpty = leadResults.every(r => !r.trim());
      // 注:删掉"pip install 出现≥4次→degrade"——审查抓出会误杀合法的部署/ML/复现类研究报告。
      // 只保留 HTML 文档护栏(抓 6.4MB Python 文档那类)+ 空内容。
      if (!_acVr.passed || _acEmpty) {
        const _acWhy = _acEmpty ? "内容为空" : (_acVr.failures[0] ?? "HTML 主导(疑似环境文档)");
        run.degraded = true;
        run.degradedReason = `最终报告未通过宽松护栏: ${_acWhy}`;
        run.status = "failed";
        allClean = false;
        md = redactSecrets((teamFitNote ? `> ⚠️ **团队匹配提醒**:${teamFitNote}\n\n` : "") + generateMdReport(run, goal, leadResults) + buildDeferredSection(deferred));
        html = redactSecrets(generateHtmlReport(run, goal, leadResults));
        emit("error", undefined, { message: `最终报告宽松护栏命中: ${_acWhy}`, degraded: true });
      }
    }
  } catch { /* best-effort: artifactContract 验收失败不影响 run */ }

  // memoryCommit-E4 / A1-V2: run 末结论不再 trivial 直接 commit —— 统一走 MemoryLedger 的
  // proposal(pending)→approved→committed 三态审核流走账:低风险自动批准(账本上仍有完整三态记录),
  // 高风险(权限/删除/shell/密钥类内容)停 pending 等人工审批(memoryRoutes /api/runs/:id/memory-proposals)。
  // 本轮所有提案+状态落 run 目录 memory_proposals.json(磁盘证据;异步反思 lesson 由 reflectionStore 补记同一文件)。
  // 置于 artifactContract 检查之后:md 已生成、run.degraded/executorDegraded 状态已定稿、才能提真内容。
  // D2:结论改为**结构化三节**(要点/教训/复用条件,extractStructuredConclusion 替代旧 1200 前缀截断);
  //     sourceArtifactRefs 取真实 artifact id(不再硬编码 []);tags 去碎片(taskType+goalSlug+要点首字);
  //     commit 门控 = 非高风险 && 非降级(run.degraded||executorDegraded)&& autoCommit 开关开 →
  //     否则停 pending(仍落台账,不写 committed-memories.json)。降级 run 不产干净记忆。
  try {
    const _mc2TaskType = classifyTaskType(goal);
    const _mc2CompanyId = runCompany?.id ?? ceo.companyId;
    const _mc2CodingEvidence = buildAuthoritativeCodingConclusionSource({
      requiresCode: runRequiresCode,
      deliveryStatus: run.deliveryAcceptance?.status,
      runStatus: run.status,
      files: allChanges.filter((change) => change.changeType !== "delete").map((change) => change.path),
      tests: _daTestEvidence.map((test) => ({ command: test.command, exitCode: test.exitCode, passed: test.passed, testedFile: test.testedFile })),
    });
    const _mc2Sources = _mc2CodingEvidence ? [_mc2CodingEvidence] : leadResults;
    const _mc2Conclusion = extractStructuredConclusion(goal, _mc2Sources, md, {
      deferred: deferred.map((d) => ({ reason: d.reason, goal: d.goal, agentId: d.agentId })),
      degradedReason: run.degradedReason,
      taskType: _mc2TaskType,
      companyId: _mc2CompanyId,
    });
    const _mc2Content = _mc2Conclusion.text;
    if (_mc2Content.length > 0) {
      const projectScopeId = run.missionId?.trim() || run.taskGraphId?.trim();
      governedMemoryCandidates.push({
        title: `运行结论：${goal.slice(0, 60)}`,
        summary: _mc2Conclusion.points.slice(0, 3).join("；").slice(0, 180) || _mc2Content.slice(0, 180),
        text: _mc2Content,
        objectType: "success_experience",
        scope: projectScopeId ? "project" : "company",
        scopeId: projectScopeId || (runCompany?.id ?? ceo.companyId),
        sourceType: "run",
        sourceRunId: runId,
        evidenceIds: artifactStore.list().slice(0, 8).map((artifact) => artifact.id),
      });
    }
  } catch { /* best-effort: memoryCommit-E4 失败不影响 run */ }

  // Cross-team summary for multi-lead runs
  if (perLeadReports.length >= 2) {
    const crossSummary = `# 跨团队工作报告\n\n**目标**: ${goal}\n\n## 参与团队\n${perLeadReports.map(p => `- ${p.leadName}`).join("\n")}\n\n${leadResults.join("\n\n---\n\n")}\n`;
    archiveReport(projectRoot, "__cross-team", goal, crossSummary);
  }

  // D4 · A2A resolved 闭环收尾(codex 问题5:0 resolved → 翻正)。
  // ① lead→CEO handoff:此刻最终 md 已生成(leadSummary 已被合成进 md/leadResults)→ 交接的产物真被下游消费。
  //    仅 run 未降级时 resolve(降级 run 的最终交付未真正闭环 → handoff 保持未 resolved,诚实)。by=CEO(收件人)。
  //    MUP Gate A#2:simulated run 的交接同样不闭环(模拟交付不算真实消费)。
  //    MUP Gate A#1:消费前子集自验失配的 run 同样不闭环(正向消费统一短路)。
  if (!run.degraded && !run.simulated && _preConsumeSubset.ok) {
    for (const h of handoffMsgs) a2aBus.resolve(h.id, h.by);
  }
  // ② 闭环审计:统计必需闭环集(delegate_task/revision_request/artifact_handoff 且有显式 to)的 resolved/未 resolved。
  //    computeA2AClosure 是纯函数(a2aBus 内);此处 tracked 已含全 run 的推进(含上方 resolve),读取即终态。
  const a2aClosure = computeA2AClosure(a2aBus.listTracked());
  run.a2aClosure = a2aClosure;
  const _a2aUnresolved = a2aClosure.required - a2aClosure.resolved;
  if (_a2aUnresolved > 0) {
    // 未闭环 → 领域事件(下游可观测);同时下方 structured.risks 追加一行,让"派单/返工/交接未确认消费"对用户可见。
    try { emit("info", undefined, { kind: "a2a_unresolved", required: a2aClosure.required, resolved: a2aClosure.resolved, unresolved: _a2aUnresolved, unresolvedIds: a2aClosure.unresolvedIds }); } catch { /* additive */ }
  }

  // MUP Gate A · run 终态单一收敛:run-end 的唯一出口经 deriveFinalRunState(加性字段,status 四态不动)。
  // 后续证据链定稿点(finalizeEvidenceIntegrity / manifest 自验失败)如有降级会在原地重算——保证
  // done+degraded 不再是矛盾态(finalState=degraded 为权威语义)。
  run.finalState = deriveFinalRunState({
    status: run.status,
    deliveryAcceptance: run.deliveryAcceptance,
    degraded: run.degraded,
    partialDelivery: run.partialDelivery,
    hasUnresolvedConflict,
    simulated: run.simulated,
    evidenceIntegrity: run.evidenceIntegrity,
  });
  saveRunTask(projectRoot, run);
  // 令五.4:把本 run 关联的观测任务图收敛到终态(计划视图 → 与 run 终态一致);加性 best-effort,
  // 仅当 run 绑定了 missionId/taskGraphId(Chat 英雄回路 / 普通 mission 派发);节点子 run 无此关联,不触发。
  reconcileObservabilityGraph(projectRoot, run);
  // report(report.md/html)与 changes(changes.json)是关键证据:写失败 → 证据链降级 + evidence_write_failed,
  // 且不再让异常穿透到外层 catch(那会连同后续 result.json/registry 一起被跳过)。
  guardEvidenceWrite(evidenceState, "report", false, () => saveRunReport(projectRoot, runId, md, html), emit);
  saveTrace(projectRoot, runId, traceEvents);
  saveCost(projectRoot, runId, callRecords);
  guardEvidenceWrite(evidenceState, "changes", false, () => saveChanges(projectRoot, runId, allChanges), emit);
  saveDeferred(projectRoot, runId, deferred);

  // runHistory: 持久化结构化 failure report — additive, best-effort
  // WS5: 使用 eventBus 持有的 run 级 RunHistory 实例(已含 run_started 及全程 emit 事件),
  // 仅补充尚未经 emit 表面流出的领域事件(deferred/degraded),再派生 failure report。
  try {
    const _rhHist = getRunHistory();
    const _rhNow = run.endedAt ?? new Date().toISOString();
    for (const d of deferred) {
      const _rhEvType = d.reason === "timeout" ? "worker_timeout" : "agent_deferred";
      _rhHist.appendEvent(_rhEvType, _rhNow, d.agentId, { reason: d.reason, lastError: d.lastError?.slice(0, 200) });
    }
    if (run.degraded) {
      _rhHist.appendEvent("deliverable_degraded", _rhNow, undefined, { reason: run.degradedReason });
      // 同时 live emit(落 events.jsonl),供 artifact 归集/run story 等下游消费(替代泛 error)。
      try { emit("deliverable_degraded", undefined, { reason: run.degradedReason }); } catch { /* best-effort */ }
    }
    // 数据完整性修复(前端复查抓出的根因):此文件在最终 emit("run_finished") **之前**落盘,导致
    // 106/130 历史 run 的 trace 快照恒缺终态(finishedAt=null → 详情页永远"直播中"/账单卡死)。
    // 这里把 run_finished 领域事件补进历史再写盘;live 端稍后照常 emit,两路数据自此一致。
    if (!_rhHist.getEvents().some(e => e.type === "run_finished")) {
      _rhHist.appendEvent("run_finished", _rhNow, undefined, {
        runId, totalTokens: run.totalTokens, totalCost: run.totalCostUsd,
        allClean, deferredCount: deferred.length,
        ...(run.finalState ? { finalState: run.finalState } : {}),
      });
    }
    // B5 · 收敛溢出汇总:model_call_started/tool_call 全程经 eventBus 走 appendConvergedEvent 收敛
    // (摘要级 payload + 200/类上限)进本 RunHistory;若有超上限的,这里在写 run-history.jsonl 前补一条
    // converged_events_overflow 汇总(各类型 total/recorded 条数)。无溢出时返回 null、不追加。
    try { _rhHist.appendConvergenceOverflowSummary(_rhNow); } catch { /* best-effort */ }
    const _rhReport = _rhHist.deriveFailureReport();
    const _rhDir = path.join(projectRoot, ".opc", "runs", runId);
    fs.mkdirSync(_rhDir, { recursive: true });
    fs.writeFileSync(path.join(_rhDir, "failure-report.json"), JSON.stringify(_rhReport, null, 2));
    // E5: 持久化完整 RunHistory(RunEvent 格式,含上面手动补的 deferred/degraded 领域事件)+ 派生摘要,
    // 供 replay。run-history.jsonl 被 loadRunHistory 优先于 events.jsonl 读取,故降级 run 的领域事件不再丢失。
    try { fs.writeFileSync(path.join(_rhDir, "run-history.jsonl"), _rhHist.toJSONL()); } catch { /* best-effort */ }
    try { fs.writeFileSync(path.join(_rhDir, "run-summary.json"), JSON.stringify(deriveRunSummary(_rhHist, runId), null, 2)); } catch { /* best-effort */ }
  } catch { /* best-effort: failure-report 写入失败不影响 run */ }

  // B1 · Runtime Contract:result.json + diagnostics.json + tool_calls.jsonl —— 纯证据输出,不改执行逻辑。
  // tool_calls/diagnostics 统一在 run 结束时从 RunHistory 事件流一次性派生(不在 eventBus 热 emit 路径加写盘):
  // RunHistory 此刻已含全程 emit 事件 + 上方补录的 deferred/degraded/run_finished 领域事件,批处理配对最稳。
  // 与 failure-report 同风格 best-effort,写失败绝不影响 run。
  try {
    const _rcEvents = getRunHistory().getEvents();
    const _resultContract = buildRunResultContract({
      run, // status 收窄由 buildRunResultContract 内部 toContractRunStatus 统一处理(唯一收窄点)
      agents,
      callRecords,
      artifacts: artifactStore.list(),
      deferred,
      events: _rcEvents, // B5c:派生 retryCount(rate_limited 信号,见 deriveRetryCount 注释)
    });
    // result.json 是 run 的顶层证据契约:此前经 writeRunResult→writeJsonBestEffort 内部吞错,写失败 run 仍纯净成功。
    // 改为直接写 + guard(critical):写失败 → finalizeEvidenceIntegrity 把 run 升级为 failed(现有失败语义)。
    guardEvidenceWrite(evidenceState, "result.json", true, () => {
      const _rcDir = path.join(projectRoot, ".opc", "runs", runId);
      fs.mkdirSync(_rcDir, { recursive: true });
      fs.writeFileSync(path.join(_rcDir, "result.json"), JSON.stringify(_resultContract, null, 2), "utf-8");
    }, emit);
    // B5 · 接线:diagnostics 带 MCP 能力版本摘要(getMcpCapabilityVersions 自身绝不抛;无 MCP 配置
    // 时为空对象)+ memoryPackHashes(deriveRunDiagnostics 从 memory_pack_used 事件聚合,见 workerRuntime)。
    writeDiagnostics(projectRoot, deriveRunDiagnostics(runId, _rcEvents, {
      mcpCapabilityVersions: getMcpCapabilityVersions(projectRoot),
    }));
    appendToolCalls(projectRoot, runId, deriveToolCallRecords(_rcEvents));
  } catch { /* best-effort: diagnostics/tool_calls 写入失败不影响 run(result.json 已单独按失败语义处理) */ }

  // Structured report for the report center. Never infer product tests from the OPC Studio repo itself.
  // A8:tests 只聚合 worker 在其 workdir 真实执行过的命令(test_evidence 事件 / runTests 工具配对,
  // 见 deriveTestEvidence),零推断;无真实执行证据 → aggregateTestRes 返回 null,维持下方诚实 ran:false 文案。
  const testRes = aggregateTestRes(deriveTestEvidence(getRunHistory().getEvents())) ?? {
    ran: false,
    passed: false,
    command: "none",
    output: runRequiresCode
      ? (allChanges.length === 0
        ? "tests.ran=false: no accepted file changes were produced for this coding run"
        : "tests.ran=false: no run-specific test result was recorded")
      : "tests.ran=false: no run-specific test result was recorded",
  };
  const structured: StructuredReport = {
    goal,
    summary: redactSecrets(leadResults[0] ?? parseDirectAnswer(ceoResponse) ?? ceoResponse).slice(0, 600), // MUP B7:脱敏 + 兜底不泄 DIRECT_ANSWER: 原文
    filesChanged: allChanges.map(c => ({
      path: c.path,
      changeType: c.changeType === "create" ? "added" : c.changeType === "delete" ? "deleted" : "modified",
    })),
    tests: { ran: testRes.ran, passed: testRes.passed, command: testRes.command, output: testRes.output.slice(0, 1000) },
    cost: { totalTokens: run.totalTokens, totalCostUsd: run.totalCostUsd ?? 0 },
    risks: [
      ...deferred.map(d => `${d.agentId}: ${deferReasonZh(d.reason)}${d.lastError ? " — " + d.lastError.slice(0, 100) : ""}`),
      // MUP Gate A#3(合并冲突可见性):即便 lead 合成没把 mergeConflictNote 的提示体现进正文,
      // 这里兜底把未决冲突清单直接落进 structured report——"文件改动未落地、待人工决裁"对用户总是可见。
      ...mergeReviewConflicts.slice(0, 20).map(m => `合并冲突待人工决裁:${m.agentId} 的文件改动未落地(${m.files.slice(0, 5).join("、") || "清单缺省"}${m.files.length > 5 ? ` 等 ${m.files.length} 个文件` : ""}),worker 分支已保留`),
      ...(finalizeResult.conflict === true
        ? [`run 分支合并回用户分支冲突:未强并,opc-run-* 分支已保留待人工合并${finalizeResult.conflictFiles?.length ? `(${finalizeResult.conflictFiles.slice(0, 5).join("、")})` : ""}`]
        : []),
      ...(run.simulated ? ["simulated:本 run 含 mock/模拟模型调用,产出不构成真实交付"] : []),
      // 交叉验证否决的代码残留:改动物理上仍在交付里(见否决分支注释),必须对用户可见,不许假装已剔除。
      ...vetoedResidualChanges.slice(0, 20).map(v => `交叉验证否决残留:${v.agentId} 的产出被否决,但其代码改动(${v.paths.slice(0, 5).join("、")}${v.paths.length > 5 ? ` 等 ${v.paths.length} 个文件` : ""})已并入 run 分支、未回滚,仍随交付进入工作区`),
      // A6b · ACP 降级如实进 risks(来源同 finalize 的 degradedExecEvents:executor_selected 带 degradedReason;上限 20 条)。
      ...degradedExecEvents.slice(0, 20).map(e => `ACP降级:${e.agentId ?? "unknown"} 经 legacy CLI 执行(${String((e.payload as any)?.degradedReason ?? "").slice(0, 100)})`),
      // D4 · A2A 未闭环如实进 risks:必需闭环集(派单/返工/交接)里有消息未被下游确认消费(resolved),诚实标注。
      ...(a2aClosure.required > a2aClosure.resolved
        ? [`A2A 未闭环:${a2aClosure.required} 条必需闭环消息(派单/返工/交接)中 ${a2aClosure.required - a2aClosure.resolved} 条未被下游确认消费(resolved)`]
        : []),
    ].map(r => redactSecrets(r)), // MUP B7:risks 含 d.lastError 片段(引擎错误体是密钥高发区),落盘前统一脱敏
    nextSteps: [
      ...deferred.map(d => `重试: ${d.goal.slice(0, 100)}`),
      ...mergeReviewConflicts.slice(0, 20).map(m => `人工决裁合并冲突:检出保留的 worker 分支,合并 ${m.agentId} 对 ${m.files.slice(0, 3).join("、") || "冲突文件"} 的改动`),
      ...vetoedResidualChanges.slice(0, 20).map(v => `人工复核/回滚 ${v.agentId} 被否决的改动:${v.paths.slice(0, 5).join("、")}${v.paths.length > 5 ? " 等" : ""}`),
    ],
    // AI Research Company:best-effort 证据表——合成阶段没能提取到就不带这个字段(不强求)。
    ...(evidenceRows.length > 0 ? { evidenceTable: evidenceRows.slice(0, 8) } : {}),
  };
  saveStructuredReport(projectRoot, runId, structured);

  // Stage 3 · Artifact-first registry:run-end 纯事后构建带 producer/状态/来源链的产物清单 → artifacts.json。
  // 此处 run.degraded 已定稿、artifactStore.list() 已完整;best-effort,绝不影响 run/主链路。
  try {
    const _arCol = buildRunArtifactCollection({
      runId,
      artifacts: artifactStore.list(),
      deferred: deferred.map(d => ({ agentId: d.agentId, taskId: d.taskId, goal: d.goal, reason: d.reason, lastError: d.lastError })),
      degraded: run.degraded ?? false,
      degradedReason: run.degradedReason,
      hasReport: true,
      reportProducer: directAnswer ? ceo.id : (perLeadReports[0]?.leadId ?? "lead"),
      roleOf: Object.fromEntries(agents.map(a => [a.id, a.role])),
      verificationResults: runVerificationResults, // Stage 6:review-result artifact + 否决回标
      orphanChanges: allChanges, // changes.json 全部文件 → 未被 worker 产出覆盖的(如 lead 直写的交付文件)也生成可下载 file artifact
    });
    // artifact registry(artifacts.json)关键证据:写失败 → 证据链降级 + evidence_write_failed。
    guardEvidenceWrite(evidenceState, "artifact-registry", false, () => saveArtifactRegistry(projectRoot, runId, _arCol, artifactStore.list()), emit); // B5c:sourceArtifacts 供 inlineText 实体归档
  } catch { /* best-effort: artifact registry 构建失败不影响 run */ }

  // P0(审计修复)· EvidenceManifest 构建**已下移到 run_finished 之后**(见本函数尾部):此前在这里构建
  // 会先于 run_finished / memory_reuse_recorded 事件与降级重写 task.json,导致 manifest 里 events.jsonl /
  // task.json 的 sha256 必然过期 → verify 端点在所有 run 上失配却仍标 evidenceIntegrity=ok(假阳性)。
  // manifest 必须是 run 目录所有证据文件的**最后一次写盘之后**才扫描,并立即自验。

  mergeSaveAgents(projectRoot, agents);

  // C5 · 员工成长:XP 由记忆生命周期事件驱动(proposal 批准/引用对账/SOP 晋级/审查否决),任务完成数只占小头。
  // 全程 best-effort,失败绝不影响 run(唯一回写调用点,见 agentGrowthStore.ts 顶注)。
  try {
    const _growthEvidence = collectRunGrowthEvidence(projectRoot, {
      runId, runStatus: run.status, participantAgentIds: run.participatingAgents, agents, traceEvents,
    });
    applyGrowth(projectRoot, computeGrowthDelta(_growthEvidence));
  } catch { /* best-effort: 员工成长回写失败不影响 run */ }

  // A6/终验 · 证据链收敛:任一关键证据写盘失败 → run.evidenceIntegrity=degraded 且 allClean 强制 false;
  // result.json 这一级失败 → 升级为 run failed。证据写发生在 task.json 首次落盘(saveRunTask)之后,
  // 故降级时把 evidenceIntegrity/status 补写回 task.json(best-effort:补写再失败也不掩盖原始证据失败)。
  allClean = finalizeEvidenceIntegrity(run, allClean, evidenceState);
  if (evidenceState.integrity === "degraded") {
    // MUP:证据链定稿改变了 degraded/evidenceIntegrity/status → finalState 经唯一收敛函数原地重算。
    run.finalState = deriveFinalRunState({
      status: run.status,
      deliveryAcceptance: run.deliveryAcceptance,
      degraded: run.degraded,
      partialDelivery: run.partialDelivery,
      hasUnresolvedConflict,
      simulated: run.simulated,
      evidenceIntegrity: run.evidenceIntegrity,
    });
    try { saveRunTask(projectRoot, run); } catch { /* best-effort */ }
  }

  // D3 · 复用验证回路:本 run"真正拼进各 agent prompt 的记忆"(injectedByAgent,注入即登记的诚实
  // 来源)× run 终态 → append-only reuse-log.jsonl。只交付可观测关联(哪条记忆参与了哪个 run、run
  // 结果如何),不虚标 A/B 因果。仅 run 干净(allClean 且非 degraded 且非 executorDegraded——此处
  // allClean 已含证据链定稿)时才对 memoryStore 条目 bumpHitsByIds:hits 语义 = 被验证复用次数
  // (bump 从 queryMemory 检索时拆出,检索不再自增强)。best-effort,绝不影响 run 收尾。
  // P0(审计修复)· hits bump 延后到尾部证据自验之后:此处只**记录候选 id**,真正 bumpHitsByIds 放到
  // manifest 自验通过后按最终 allClean/run 状态门控——自验失败/降级的 run 绝不给记忆自增强(防假成功回灌)。
  let _pendingReuseBumpIds: string[] = [];
  const _reuseHasUncertainTaskNode = run.taskGraphId
    ? (getTaskGraph(projectRoot, run.taskGraphId)?.nodes.some((node) => node.uncertain === true) ?? false)
    : false;
  try {
    if (injectedByAgent.size > 0) {
      const _reuseAt = new Date().toISOString();
      const _reuseTaskType = classifyTaskType(goal);
      const _reuseDegraded = run.degraded === true || run.executorDegraded === true;
      const _reuseClean = isMemoryReuseEligible(run, allClean, _reuseHasUncertainTaskNode);
      const _reuseEntries: MemoryReuseEntry[] = [];
      for (const [aid, refs] of injectedByAgent) {
        const _reuseRole = agents.find((a) => a.id === aid)?.role;
        for (const ref of refs) {
          _reuseEntries.push({ runId, agentId: aid, role: _reuseRole, memoryId: ref.id, kind: ref.kind, taskType: _reuseTaskType, runStatus: run.status, degraded: _reuseDegraded, at: _reuseAt });
        }
      }
      if (_reuseEntries.length > 0) {
        appendReuseOutcomes(projectRoot, _reuseEntries);
        // 候选 = memoryStore(project.jsonl)自己的条目(其它 kind 各有生命周期账本,reuse-log 已记关联,不跨库改数)。
        // 是否真 bump 由尾部自验后的最终 clean 门决定(此处 _reuseClean 仅供事件如实标注当前判断)。
        _pendingReuseBumpIds = _reuseClean
          ? [...new Set(_reuseEntries.filter((e) => e.kind === "memory_entry").map((e) => e.memoryId))]
          : [];
        const _reuseMemIds = [...new Set(_reuseEntries.map((e) => e.memoryId))];
        emit("info", undefined, {
          kind: "memory_reuse_recorded",
          count: _reuseEntries.length,
          distinctMemories: _reuseMemIds.length,
          memoryIds: _reuseMemIds.slice(0, 20),
          clean: _reuseClean,
          message: `记忆复用回路:本 run 注入过 ${_reuseMemIds.length} 条记忆,已关联 run 终态(${_reuseClean ? "干净成功,计入验证复用" : "非纯净,仅记录关联"})`,
        });
      }
    }
  } catch { /* best-effort:复用回路记录失败绝不影响 run 收尾 */ }

  // P0(审计修复)· 等异步失败反思落定再收尾:反思(Layer E)会追加 lesson_proposed/committed 事件到
  // events.jsonl + lesson 台账到 memory_proposals.json——都在 EvidenceManifest 哈希范围内。反思与上方报告/
  // 账本生成并行跑,此处 await 它(deepseekChat 自带 30s 超时,有界不挂死),确保其字节先落定,再 emit
  // run_finished(保持它是最后一条事件)、再在尾部构建 manifest。否则反思在 manifest 之后异步落盘 →
  // events.jsonl/memory_proposals 哈希过期,verify 端点失配却仍标 evidenceIntegrity=ok(异步版时序假阳性)。
  if (_reflectionPromise) { try { await _reflectionPromise; } catch { /* 反思失败静默,不阻断收尾 */ } }
  emit("run_finished", undefined, { runId, totalTokens: run.totalTokens, totalCost: run.totalCostUsd, allClean, deferredCount: deferred.length, ...(run.finalState ? { finalState: run.finalState } : {}) });

  // P0(审计修复)· EvidenceManifest 作为 run 目录的**最后一次证据写盘**:此刻 task.json / result.json /
  // events.jsonl(含 run_finished / memory_reuse_recorded)/ 全部归档均已定稿,扫描构建才能得到与磁盘一致的
  // 哈希。构建后**立即自验**(重算逐文件 sha256 与清单比对):自验失败(写盘未落定 / 并发改动 / 磁盘异常)→
  // 交付不可信,run 降级为 evidenceIntegrity=degraded + degraded 并把降级如实补写回 task.json / result.json,
  // 再按降级后的磁盘重建一次 manifest 使清单自洽。绝不以"干净成功 / evidenceIntegrity=ok"提交假阳性证据。
  try {
    const _emDir = path.join(projectRoot, ".opc", "runs", runId);
    const _emTests = deriveTestEvidence(getRunHistory().getEvents());
    commitEvidenceReceipts(_emDir, _emTests);
    let _emManifest = buildEvidenceManifest(_emDir, _emTests);
    writeEvidenceManifest(_emDir, _emManifest);
    const _verify = verifyEvidenceManifest(_emDir);
    if (!_verify.ok) {
      allClean = false;
      run.evidenceIntegrity = "degraded";
      run.degraded = true;
      const _mm = _verify.mismatches.map((x) => x.path).slice(0, 6).join(", ");
      run.degradedReason = [run.degradedReason, `证据清单自验失败(${_verify.mismatches.length} 项失配: ${_mm}),交付不可信`]
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0).join("; ");
      // MUP:自验失败降级同样经唯一收敛函数——status 仍 done 但 finalState=degraded(权威终态,矛盾消灭)。
      run.finalState = deriveFinalRunState({
        status: run.status,
        deliveryAcceptance: run.deliveryAcceptance,
        degraded: run.degraded,
        partialDelivery: run.partialDelivery,
        hasUnresolvedConflict,
        simulated: run.simulated,
        evidenceIntegrity: run.evidenceIntegrity,
      });
      // 事件先落(下面重建 manifest 时把它一并纳入哈希,保持 events.jsonl 与 manifest 自洽)。
      try { emit("info", undefined, { kind: "evidence_self_verify_failed", mismatches: _verify.mismatches.slice(0, 10), message: "证据清单自验失败 → run 降级为不可信交付" }); } catch { /* 事件写失败不掩盖降级 */ }
      try { saveRunTask(projectRoot, run); } catch { /* best-effort:task.json 补写降级态失败不掩盖原始整合失败 */ }
      // result.json 同步降级(顶层证据契约;status 经 buildRunResultContract 内部 toContractRunStatus 收窄)。
      try {
        writeRunResult(projectRoot, buildRunResultContract({ run, agents, callRecords, artifacts: artifactStore.list(), deferred, events: getRunHistory().getEvents() }));
      } catch { /* best-effort */ }
      // 降级已重写 task.json / result.json 并追加 self-verify 事件 → 重建 manifest 使其哈希与降级后磁盘一致
      // (完整性判定已如实记进 evidenceIntegrity=degraded,不靠 manifest 自身"看起来 ok")。
      try {
        const _retryTests = deriveTestEvidence(getRunHistory().getEvents());
        commitEvidenceReceipts(_emDir, _retryTests);
        _emManifest = buildEvidenceManifest(_emDir, _retryTests);
        writeEvidenceManifest(_emDir, _emManifest);
      } catch { /* degraded state already records that the evidence set is not trustworthy */ }
    }
    try { upsertEvidenceManifest(projectRoot, _emManifest); } catch { /* 表写 best-effort:默认 json 后端不阻断 run */ }
  } catch (error) {
    // EvidenceManifest is part of the delivery claim, not optional telemetry. A build/commit/load
    // failure therefore makes a clean success impossible even when the worker produced files.
    allClean = false;
    run.evidenceIntegrity = "degraded";
    run.degraded = true;
    const reason = error instanceof Error ? error.message : String(error);
    run.degradedReason = [run.degradedReason, `证据清单提交失败: ${reason.slice(0, 300)}`]
      .filter((x): x is string => typeof x === "string" && x.trim().length > 0).join("; ");
    run.finalState = deriveFinalRunState({
      status: run.status,
      deliveryAcceptance: run.deliveryAcceptance,
      degraded: true,
      partialDelivery: run.partialDelivery,
      hasUnresolvedConflict,
      simulated: run.simulated,
      evidenceIntegrity: "degraded",
    });
    try { emit("error", undefined, { kind: "evidence_manifest_commit_failed", critical: true, message: run.degradedReason }); } catch { /* terminal state remains authoritative */ }
    try { saveRunTask(projectRoot, run); } catch { /* original evidence failure remains recorded in memory */ }
    try {
      writeRunResult(projectRoot, buildRunResultContract({ run, agents, callRecords, artifacts: artifactStore.list(), deferred, events: getRunHistory().getEvents() }));
    } catch { /* result persistence cannot restore evidence integrity */ }
  }

  // Canonical memory is a post-evidence side effect. A worker/model result cannot
  // write approved long-term knowledge before Core has verified the final run.
  const _governedMemoryWriteEligible = isMemoryReuseEligible(
    run,
    allClean,
    _reuseHasUncertainTaskNode,
  );
  if (_governedMemoryWriteEligible) {
    for (const candidate of governedMemoryCandidates) {
      try {
        proposeMemory(projectRoot, candidate);
      } catch {
        // Memory is optional to delivery. Proposal persistence does not mutate
        // the already-finalized run evidence or its verified delivery state.
      }
    }
  }
  // Failed/degraded runs may contribute review candidates, never approved
  // memories. The reviewer contract requires an independently confirmed root
  // cause, so these remain proposed until a human or later evidence confirms it.
  for (const candidate of governedFailureCandidates) {
    try {
      proposeMemory(projectRoot, candidate);
    } catch {
      // Failure reflection is advisory and cannot change the delivery outcome.
    }
  }

  // P0(审计修复)· 记忆复用 hits bump —— 只在证据自验通过、run 最终干净成功时才计入验证复用(防假成功自增强)。
  // MUP Gate A#2:simulated / partial run 显式排除(allClean 已为 false,此处双保险)。
  if (_pendingReuseBumpIds.length > 0 && isMemoryReuseEligible(run, allClean, _reuseHasUncertainTaskNode)) {
    try { bumpHitsByIds(projectRoot, _pendingReuseBumpIds); } catch { /* best-effort:hits bump 失败不影响 run 收尾 */ }
  }

  // 直答时用剥掉 DIRECT_ANSWER: 前缀的正文作 summary(原始 ceoResponse 带前缀,会泄漏进 API/日志)。
  return { runId, summary: (directAnswer ?? leadResults[0] ?? ceoResponse).slice(0, 500) };
  } catch (e: any) {
    // P0#3 兜底:未捕获异常 → run 如实标 failed 落盘(修磁盘上 16 个永远 running 的僵尸 run 的产生源),再向上抛。
    // 复审加固:已正常置 done 的 run(收尾附属写盘抛错)不降级覆写——交付物已生成,failed 会失真。
    try {
      if (run.status !== "done") {
        run.status = "failed";
        run.endedAt = new Date().toISOString();
        run.degraded = true;
        run.degradedReason = `未捕获异常: ${String(e?.message || e).slice(0, 300)}`;
        // MUP:崩溃路径终态同样经唯一收敛函数(status=failed → finalState=failed;try 内局部信号不可达,如实缺省)。
        run.finalState = deriveFinalRunState({ status: run.status, deliveryAcceptance: run.deliveryAcceptance, degraded: run.degraded, simulated: run.simulated });
        saveRunTask(projectRoot, run);
        // B1 · 崩溃路径最小 Runtime Contract:正常收尾的 contract 写入块(try 尾部)走不到这里,
        // 崩溃 run 原本只剩 worker.config.json + task.json。best-effort 补写最小 result.json +
        // diagnostics.json(错误摘要过 redactSecrets,复用 runtimeContract writer 不新造格式);
        // 已存在的不覆写——degraded 收尾(status=failed)已写完整契约、其后附属步骤才抛的场景不能被最小版冲掉。
        try {
          const _crashDir = path.join(projectRoot, ".opc", "runs", runId);
          const _crashEndedAt = run.endedAt ?? new Date().toISOString();
          const _crashSummary = redactSecrets(`未捕获异常: ${String(e?.message || e).slice(0, 300)}`);
          if (!fs.existsSync(path.join(_crashDir, "result.json"))) {
            writeRunResult(projectRoot, buildCrashRunResultContract({
              runId, startedAt: run.startedAt, endedAt: _crashEndedAt,
              errorSummary: _crashSummary,
              totalTokens: run.totalTokens, totalCostUsd: run.totalCostUsd,
            }));
          }
          if (!fs.existsSync(path.join(_crashDir, "diagnostics.json"))) {
            writeDiagnostics(projectRoot, buildCrashDiagnostics({ runId, at: _crashEndedAt, errorSummary: _crashSummary }));
          }
        } catch { /* best-effort:契约兜底失败不掩盖原始异常 */ }
        emit("error", undefined, { message: `run 未捕获异常,已标记 failed: ${String(e?.message || e).slice(0, 200)}` });
        emit("run_finished", undefined, { runId, totalTokens: run.totalTokens, totalCost: run.totalCostUsd, failed: true, ...(run.finalState ? { finalState: run.finalState } : {}) });
      } else {
        // 已 done(交付物已生成),收尾附属步骤抛错:不覆写状态;正常 run_finished 是函数末尾语句、此时必然
        // 还没发出 → 这里补发(否则前端/通知永远等不到完成),并记录收尾错误。
        emit("error", undefined, { message: `run 已完成但收尾步骤抛错(交付物不受影响): ${String(e?.message || e).slice(0, 200)}` });
        emit("run_finished", undefined, { runId, totalTokens: run.totalTokens, totalCost: run.totalCostUsd, allClean: false, deferredCount: run.deferredTasks?.length ?? 0, ...(run.finalState ? { finalState: run.finalState } : {}) });
      }
    } catch { /* 兜底本身失败也不掩盖原始异常 */ }
    throw e;
  } finally {
    unsubscribe(traceSub); // 所有退出路径(含 directAnswer/异常)都反注册,修订阅泄漏
    unsubscribe(statusSub);
    if (persistActiveRunProgress === persistRunProgress) persistActiveRunProgress = null;
    stopRequests.delete(runId);
  }
  } finally {
    // E4:关闭 pid 登记窗口并清空登记(run 结束清理;正常收尾时子进程都已退出,这里只清账)。
    if (pidRegistryRunId) clearRunPids(pidRegistryRunId);
    const finishedRunId = pidRegistryRunId || activeRunId;
    if (finishedRunId) {
      clearRunContextCache(projectRoot, finishedRunId);
      clearRunResourceValidationCache(projectRoot, finishedRunId);
    }
    setPidRegistryRun(null);
    activeGovernanceLevel = undefined;
    // run 结束即关闭 A2A 守卫窗口:guardRun 以 activeRunId 为唯一依据,不清零则已完结 run 的
    // runId 在下一个 run 启动前永久放行,可事后向其 committed 时间线(a2a_messages.jsonl/events.jsonl)追加。
    activeRunId = "";
    activeRunAbortController = null;
    runInFlight = false;
    // P1-5:本 run 释放互斥闸后,自动出队派发下一单(队列空/协调器未接线则 no-op)。用 microtask 延后一拍——
    // 避免"队首项在首个 await 之前就同步失败(如预算耗尽)"时在本 run 的 finally 栈里同步递归派发整条队列;
    // 延后后每次派发各起一拍,drain 内 inFlightProbe 仍确保不与其他 run 并发起跑,单 run 语义不破。
    queueMicrotask(() => { try { drainDispatchQueue(projectRoot); } catch { /* 派发下一单失败绝不掩盖本 run 结果 */ } });
  }
}

// report.md = 面向用户的「最终交付物本体」(各团队合成的答案),不是"运行工作报告"。
// 元信息(参与 agent / token / 成本)降到页脚 <sub>,不喧宾夺主、也不污染对答案的评测。
function generateMdReport(run: Run, goal: string, results: string[]): string {
  const banner = run.degraded
    ? `> ⚠️ **本次运行已降级(${run.degradedReason || "协调者过载/不可用"})——最终产出非有效合成交付物,不应作为有效结果评分/对比。**\n\n`
    : "";
  const body = results.join("\n\n---\n\n").trim() || "(无有效产出)";
  const contributions = [...new Set(callRecords.map(r => r.agentId))].map(id => {
    const a = agents.find(x => x.id === id);
    const recs = callRecords.filter(r => r.agentId === id);
    const tok = recs.reduce((s, r) => s + (r.totalTokens ?? 0), 0);
    return `${a?.name ?? id}(${a?.role ?? "?"}) ${tok}tok`;
  }).join(" · ");
  const footer = `\n\n---\n<sub>OPC Studio · 目标: ${goal.slice(0, 120)} · ${run.participatingAgents.length} agents · ${run.totalTokens} tokens · $${(run.totalCostUsd ?? 0).toFixed(6)} · ${contributions}</sub>\n`;
  return `${banner}${body}${footer}`;
}

function generateHtmlReport(run: Run, goal: string, results: string[]): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>OPC Run Report</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}
h1{color:#2f6df0} .card{background:#f5f7fa;border-radius:8px;padding:1rem;margin:1rem 0}
.cost{color:#1aa463;font-weight:600}</style></head><body>
<h1>OPC Studio Run Report</h1>
${run.degraded ? `<div style="background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:8px;padding:12px 14px;margin:1rem 0;font-weight:600">⚠️ 本次运行已降级（${run.degradedReason || "协调者过载/不可用"}）——最终产出非有效合成交付物，不应作为有效结果评分/对比。</div>` : ""}
<h2>User Goal</h2><p>${goal}</p>
<h2>Work Completed</h2>${results.map(r => `<div class="card">${r.replace(/\n/g, "<br>")}</div>`).join("")}
<h2>Cost</h2><p class="cost">Total tokens: ${run.totalTokens} | Estimated: $${(run.totalCostUsd ?? 0).toFixed(6)}</p>
<p><small>Generated by OPC Studio v0.1.0</small></p></body></html>`;
}

export function getAgents() { return agents; }

// C12/childrenIds 活公司同步:以 parentId 为唯一真源就地重建每个 agent 的 childrenIds。
// 就地版(不换对象身份,避免在飞引用漂移;语义同 installMerge.rebuildChildrenIds 的纯函数映射):
//   · 修 addAgents 单向补挂父侧、且"子先于父插入"漏挂 —— 全量按 parentId 归拢,顺序无关;
//   · 修 updateAgent 换父后旧父未摘、新父未加 —— 重建保证父子双向一致、无双重/悬空关系。
// parentId 指向不存在 id 的节点自然不挂到任何父下(与既有"parent 找不到则跳过"语义一致)。
function rebuildChildrenIdsInPlace(list: AgentNodeConfig[]): void {
  // 组织父子边只在【同公司】内成立(归一化口径:空/undefined=default)。跨公司 parentId 视为悬空——不建边、
  // 不塞外公司父的 childrenIds,并在重建时天然清除既有跨公司残边(merge 时 agent id 全局碰撞把员工挂到外
  // 公司 agent 下的跨公司父子污染,wave4-live-acceptance 抓出的 P0;语义同 installMerge.rebuildChildrenIds)。
  const norm = (c?: string) => normalizeCompanyId(c); // 单一真相源(收口令二.1)
  const byId = new Map(list.map(a => [a.id, a]));
  const childrenByParent = new Map<string, string[]>();
  for (const a of list) {
    if (!a.parentId) continue;
    const parent = byId.get(a.parentId);
    if (!parent) continue;
    if (norm(parent.companyId) !== norm(a.companyId)) continue; // 跨公司父子边不建
    const arr = childrenByParent.get(a.parentId) ?? [];
    arr.push(a.id);
    childrenByParent.set(a.parentId, arr);
  }
  for (const a of list) a.childrenIds = childrenByParent.get(a.id) ?? [];
}

// 令四.6 · 回滚保序:整对象替换但**不挪位**——命中现有 id 的按原索引原地替换(零残留 + 顺序不漂移),
// 未命中的追加。取代回滚里 removeAgentsByIds+addAgents 的"删+尾插"导致的导出顺序漂移(被恢复员工被挪到
// 列表尾部 = 非完整还原,wave4-live-acceptance 抓出"回滚后再导出 ≠ 合并前导出")。快照自带
// parentId/childrenIds,整值恢复(与被覆盖前快照一致)。返回真正恢复的条数。
export function restoreAgentsInPlace(snapshots: AgentNodeConfig[]): number {
  if (!snapshots.length) return 0;
  let restored = 0;
  for (const snap of snapshots) {
    const idx = agents.findIndex(a => a.id === snap.id);
    if (idx >= 0) agents[idx] = snap;
    else agents.push(snap);
    restored++;
  }
  mergeSaveAgents(projectRoot, agents);
  return restored;
}

// Bulk insert imported nodes (community install). Ids are expected pre-uniquified; existing ids are
// skipped. childrenIds are rebuilt from parentId after insert (handles child-before-parent order).
export function addAgents(nodes: AgentNodeConfig[]): number {
  let added = 0;
  for (const n of nodes) {
    if (agents.some(a => a.id === n.id)) continue;
    agents.push(n);
    added++;
  }
  // 批量插入后统一按 parentId 重建父子关系:不再依赖"父必须先于子插入"、也不漏挂已存在父侧。
  if (added > 0) rebuildChildrenIdsInPlace(agents);
  mergeSaveAgents(projectRoot, agents);
  return added;
}

// v2: deleting a company removes its whole agent tree.
// 删除必须全量覆盖(saveAgents),不能 mergeSaveAgents——后者会把"被删的"当其他公司重新保留(删不掉)。
// 从磁盘全集出发(模块 agents 在 run 期间可能是过滤后的子集),写回"全集减该公司"。
export function removeAgentsByCompany(companyId: string): number {
  const all = loadAgents(projectRoot, []);
  const remaining = all.filter(a => normalizeCompanyId(a.companyId) !== companyId);
  const removed = all.length - remaining.length;
  agents = agents.filter(a => normalizeCompanyId(a.companyId) !== companyId); // 同步内存
  saveAgents(projectRoot, remaining); // 全量覆盖,删除生效
  return removed;
}

// D6 · Install rollback(merge 模式):只删指定 id 集合(合并进已有公司时新增的那批),不动目标公司
// 原有资产——removeAgentsByCompany 是按整公司连坐删,粒度不够用。同 removeAgentsByCompany 的
// "从磁盘全集出发,全量覆盖写回"惯例(不能 mergeSaveAgents,否则被删的会被当"其它公司"重新保留)。
// 额外做父子引用清理:被删 id 若还留在幸存 agent 的 childrenIds 里,一并摘除,不留悬空引用
// (merge 安装把新员工挂在目标公司 CEO/其它新员工下,CEO.childrenIds 会包含这批被删 id)。
export function removeAgentsByIds(ids: string[]): number {
  if (!ids.length) return 0;
  const idSet = new Set(ids);
  const all = loadAgents(projectRoot, []);
  const remaining = all.filter(a => !idSet.has(a.id));
  const removed = all.length - remaining.length;
  const stripDanglingChildren = (list: AgentNodeConfig[]) => {
    for (const a of list) {
      if (a.childrenIds?.some(c => idSet.has(c))) a.childrenIds = a.childrenIds.filter(c => !idSet.has(c));
    }
  };
  stripDanglingChildren(remaining);
  agents = agents.filter(a => !idSet.has(a.id)); // 同步内存
  stripDanglingChildren(agents);
  saveAgents(projectRoot, remaining);
  return removed;
}
// 12+1 框架扩展(2026-07):这个校验列表以前是本地硬编码的 3 个值,新框架加进 AgentFramework 后如果
// 不跟着扩,PATCH /agents 会把 framework:"gemini-cli" 这类合法新值当"坏值"悄悄丢弃——改成与
// engineRouter 的 ALL_FRAMEWORKS 同一份来源,不重复维护两份列表。
const VALID_FRAMEWORKS: string[] = ALL_FRAMEWORKS;
export function updateAgent(id: string, patch: Partial<AgentNodeConfig>) {
  // 写侧归一:web(Phase5 前仍用 "hermes" 作 API 面值)/旧调用方发来的 "hermes" 落盘前归一为 "api",
  // 存量数据只靠读侧 alias、新写入一律出新值。
  if (patch.framework === "hermes") patch = { ...patch, framework: "api" };
  // Drop an invalid framework rather than persisting it — a bad value (e.g. "foo") would make the
  // node permanently restricted (frameworkPolicy rejects unknown ids) with no UI way to recover.
  if (patch.framework !== undefined && !VALID_FRAMEWORKS.includes(patch.framework)) {
    delete (patch as Record<string, unknown>).framework;
  }
  // 五.3(收口作战令)· workingDirectory 保存侧阻断:patch 含非空 workingDirectory 时必须经 validate——
  // 非法(绝对路径/盘符/.. 逃逸/等价于根)一律抛错,绝不落盘一个会在运行时错位/被拒的值(路由侧转 400 由泳道 V 做);
  // 合法则归一为规范 POSIX 相对路径再落盘。空串/undefined = 清除该字段,放行不校验。
  if (typeof patch.workingDirectory === "string" && patch.workingDirectory.trim() !== "") {
    const wd = validateAgentWorkingDirectory(patch.workingDirectory);
    if (!wd.ok) throw new Error(`invalid_working_directory: ${wd.error}`);
    patch = { ...patch, workingDirectory: wd.normalized };
  }
  const a = agents.find(x => x.id === id);
  if (a) {
    Object.assign(a, patch);
    // childrenIds 活公司同步:换父(patch 含 parentId)后按 parentId 双向重建 —— 旧父摘除、新父加入,不留悬空。
    if ("parentId" in patch) rebuildChildrenIdsInPlace(agents);
    mergeSaveAgents(projectRoot, agents);
    return a;
  }
  // Upsert: creating a new agent (e.g. "add child agent") arrives as a PATCH on a
  // not-yet-existing id carrying a full node body. Create it when name+role are present.
  if (patch.name && patch.role) {
    const created: AgentNodeConfig = {
      id,
      name: patch.name,
      role: patch.role,
      parentId: patch.parentId,
      childrenIds: patch.childrenIds ?? [],
      model: patch.model ?? "",
      provider: patch.provider ?? "deepseek",
      framework: patch.framework ?? "api",
      companyId: patch.companyId ?? "default",
      workspaceDir: patch.workspaceDir,
      uiPosition: patch.uiPosition,
      status: patch.status ?? "idle",
      currentTask: patch.currentTask,
      tokenUsage: patch.tokenUsage ?? { prompt: 0, completion: 0, total: 0 },
      costUsd: patch.costUsd ?? 0,
      lastAction: patch.lastAction,
      editable: patch.editable ?? true,
      deletable: patch.deletable ?? true,
      enabled: patch.enabled ?? true,
    };
    agents.push(created);
    // 新建携带 parentId(如"添加子员工")→ 按 parentId 重建,把新员工挂到父的 childrenIds(父先于子已存在)。
    if (created.parentId) rebuildChildrenIdsInPlace(agents);
    mergeSaveAgents(projectRoot, agents);
    return created;
  }
  return undefined;
}

export { runAgent };
