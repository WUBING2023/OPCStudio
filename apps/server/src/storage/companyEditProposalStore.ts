import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { CompanyEditOperationReadSchema, CompanyEditTargetSchema } from "@opc/shared";
import type { CompanyEditOperation, CompanyEditTarget } from "@opc/shared";
import { isSqliteBackend } from "./backend.js";
import { openBusinessDb, readAllDocs, replaceAllDocs } from "./sqlite/docTableBackend.js";

// D7 · CompanyEditProposal 审计台账(参照 registryStore.ts 的 pending/approved 状态机模式)。
// 这里不是"落地机制本身"——真正的落地由 runtime/companyArchitect.ts 的纯函数完成、结果直接回给前端
// 草稿状态。这个 store 的作用是给"AI 出方案 → 用户确认 → Core 落地"这条链路留一份审计记录(谁在什么
// 时候提了什么方案、最终有没有被应用),满足"用户确认后 Core 才写库"里的"写库"——即便 CompanyEditTarget
// 本身活在前端草稿状态、不落 companyStore,这份 proposal 台账仍然是服务端真实持久化的记录。
// 全程 best-effort:任何失败静默,不阻断 proposal/apply 端点的主流程(与 registryStore 同一原则)。

// C11 rollback:状态机加 rolled_back(apply 后被撤销)。
export const CompanyEditProposalStatusSchema = z.enum(["pending", "applied", "rolled_back"]);
export type CompanyEditProposalStatus = z.infer<typeof CompanyEditProposalStatusSchema>;

// C11 fidelity ledger 摘要(apply 前后跑 buildLedger 的结果快照;lost>0 时 apply 已被拒,不会落到这里)。
export const CompanyEditLedgerSummarySchema = z.object({
  fieldCount: z.number().int().min(0),
  preserved: z.number().int().min(0),
  intentionally_transformed: z.number().int().min(0),
  lost: z.number().int().min(0),
});
export type CompanyEditLedgerSummary = z.infer<typeof CompanyEditLedgerSummarySchema>;

export const CompanyEditProposalRecordSchema = z.object({
  proposal_id: z.string(),
  targetId: z.string(),           // 对应 CompanyEditTarget.id(草稿 id),供追溯
  summary: z.string(),
  // 读侧 tolerant:存量记录里含已移除的六种悬空 op 时仍能整条解析(不掉进 unknown 行)。
  operations: z.array(CompanyEditOperationReadSchema),
  risks: z.array(z.string()).default([]),
  requires_user_confirmation: z.literal(true),
  status: CompanyEditProposalStatusSchema.default("pending"),
  createdAt: z.string(),
  appliedAt: z.string().optional(),
  // 令三.2 · proposal 绑定五元组(companyId/targetId/operationsHash/beforeHash/expiresAt)。
  // 全部可选、加性——存量记录无这些字段照常解析;apply 侧(令三.3)只在字段存在时做 hash/过期匹配,
  // 缺字段的存量记录走"无从校验则不阻断"的向后兼容路径(仍要求 pending 状态)。
  companyId: z.string().optional(),
  operationsHash: z.string().optional(), // operations 的确定性序列化 sha256(stableHash)
  beforeHash: z.string().optional(),     // 创建时草稿目标的确定性 sha256(hashCompanyEditTarget)
  expiresAt: z.string().optional(),      // ISO 时间;apply 时若已过期 → 410
  // C11 rollback:apply 落地前的 target 快照,撤销时原样返还给前端写回草稿。可选、加性——存量记录无此字段。
  targetBefore: CompanyEditTargetSchema.optional(),
  rolledBackAt: z.string().optional(),
  // C11 fidelity ledger 摘要(可选、加性)。
  ledger: CompanyEditLedgerSummarySchema.optional(),
  // C(波4)· 变更前后 hash(规范化 JSON 的 sha256)。rollback 端点凭 targetAfterHash 判断"目标草稿
  // 是否已被后续编辑"。可选、加性——存量记录无此字段。
  targetBeforeHash: z.string().optional(),
  targetAfterHash: z.string().optional(),
});
export type CompanyEditProposalRecord = z.infer<typeof CompanyEditProposalRecordSchema>;

function storeFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "architect", "company-edit-proposals.jsonl");
}

function loadRaw(f: string): { valid: CompanyEditProposalRecord[]; unknown: string[] } {
  if (!fs.existsSync(f)) return { valid: [], unknown: [] };
  const valid: CompanyEditProposalRecord[] = [], unknown: string[] = [];
  for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let ok = false;
    try { const p = CompanyEditProposalRecordSchema.safeParse(JSON.parse(t)); if (p.success) { valid.push(p.data); ok = true; } } catch { /* */ }
    if (!ok) unknown.push(t);
  }
  return { valid, unknown };
}

// 战役B·Phase B2a:接后端开关。默认 json 逐字节不变;sqlite 时读走 edit_proposals 表(权威)——
// 再经 schema.safeParse 复刻 loadRaw 的"只取 valid"口径(迁移器仅按 proposal_id 判别入表,schema 校验在读侧兜);
// 写【双写】(JSONL 照写 + 全量重写 edit_proposals;JSONL 的 unknown 行留在文件、SQLite 的 unknown 行留在 unknown_lines 表)。
export function loadCompanyEditProposals(projectRoot: string): CompanyEditProposalRecord[] {
  if (isSqliteBackend(projectRoot)) {
    const valid: CompanyEditProposalRecord[] = [];
    for (const d of readAllDocs(openBusinessDb(projectRoot), "edit_proposals")) {
      const p = CompanyEditProposalRecordSchema.safeParse(d);
      if (p.success) valid.push(p.data);
    }
    return valid;
  }
  return loadRaw(storeFile(projectRoot)).valid;
}

function writeAll(projectRoot: string, records: CompanyEditProposalRecord[]): void {
  const f = storeFile(projectRoot);
  const { unknown } = loadRaw(f);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const lines = [...records.map(r => JSON.stringify(r)), ...unknown];
  fs.writeFileSync(f, lines.join("\n") + (lines.length ? "\n" : ""), "utf-8");
  if (isSqliteBackend(projectRoot)) {
    replaceAllDocs(openBusinessDb(projectRoot), "edit_proposals", records);
  }
}

// AI 出方案后落一条 pending 记录(proposal_id 服务端生成,不信任 AI 自称的值)。
// 令三.2:创建侧一并写入绑定五元组(companyId/operationsHash/beforeHash/expiresAt),供 apply 侧
// (令三.3)按 hash/过期严格消费。这些字段全部可选——调用方不传时留空(存量/旧调用向后兼容)。
export function saveCompanyEditProposal(
  projectRoot: string,
  input: {
    targetId: string; summary: string; operations: CompanyEditOperation[]; risks: string[];
    companyId?: string; operationsHash?: string; beforeHash?: string; expiresAt?: string;
  },
  nowIso: string,
): CompanyEditProposalRecord {
  const rec: CompanyEditProposalRecord = {
    proposal_id: `edit_prop_${randomUUID().slice(0, 8)}`,
    targetId: input.targetId,
    summary: input.summary,
    operations: input.operations,
    risks: input.risks,
    requires_user_confirmation: true,
    status: "pending",
    createdAt: nowIso,
    companyId: input.companyId,
    operationsHash: input.operationsHash,
    beforeHash: input.beforeHash,
    expiresAt: input.expiresAt,
  };
  const all = loadCompanyEditProposals(projectRoot);
  all.push(rec);
  writeAll(projectRoot, all);
  return rec;
}

export function getCompanyEditProposal(projectRoot: string, proposalId: string): CompanyEditProposalRecord | null {
  return loadCompanyEditProposals(projectRoot).find(r => r.proposal_id === proposalId) ?? null;
}

// 用户确认、Core 落地成功后标记 applied(审计"确实被应用过",不是"AI 自己 apply 了")。
// C11:apply 时把落地前的 target 快照(targetBefore)与 fidelity ledger 摘要一并写入,供撤销/审计。
export function markCompanyEditProposalApplied(
  projectRoot: string,
  proposalId: string,
  nowIso: string,
  extra?: { targetBefore?: CompanyEditTarget; ledger?: CompanyEditLedgerSummary; targetBeforeHash?: string; targetAfterHash?: string },
): CompanyEditProposalRecord | null {
  const all = loadCompanyEditProposals(projectRoot);
  const idx = all.findIndex(r => r.proposal_id === proposalId);
  if (idx === -1) return null;
  const updated: CompanyEditProposalRecord = {
    ...all[idx], status: "applied", appliedAt: nowIso,
    targetBefore: extra?.targetBefore ?? all[idx].targetBefore,
    ledger: extra?.ledger ?? all[idx].ledger,
    targetBeforeHash: extra?.targetBeforeHash ?? all[idx].targetBeforeHash,
    targetAfterHash: extra?.targetAfterHash ?? all[idx].targetAfterHash,
  };
  all[idx] = updated;
  writeAll(projectRoot, all);
  return updated;
}

// C11 rollback:已 applied 的 proposal 被撤销后标记 rolled_back(审计"应用过又撤销了")。
// 只允许 applied → rolled_back;pending/已 rolled_back 返回 null(端点据此 4xx)。
export function markCompanyEditProposalRolledBack(projectRoot: string, proposalId: string, nowIso: string): CompanyEditProposalRecord | null {
  const all = loadCompanyEditProposals(projectRoot);
  const idx = all.findIndex(r => r.proposal_id === proposalId);
  if (idx === -1) return null;
  if (all[idx].status !== "applied") return null;
  const updated: CompanyEditProposalRecord = { ...all[idx], status: "rolled_back", rolledBackAt: nowIso };
  all[idx] = updated;
  writeAll(projectRoot, all);
  return updated;
}

// ── 令三.4 · 高危一次性 confirmation token(内存登记,一次性消费,10 分钟过期)────────────────
// 替换旧的"客户端布尔 confirmHighRisk"确认门:apply 命中高危时后端签发一枚 token(randomUUID),
// 绑定到一段确定性 bindingHash(草稿侧 = proposalId+operationsHash+dangerFlags;活公司侧 =
// companyId+actionsHash+dangerFlags),登记在进程内存,10 分钟过期。前端二次确认时带 token 重发,后端
// 校验:存在 + 未消费 + 未过期 + bindingHash 完全一致 → 放行并即刻删除(一次性)。重放(已删=missing)/
// 过期/绑定不符 → 一律拒绝,由路由回 428 重新签发。纯内存、不落盘(重启即失效,符合"一次性确认"语义;
// 审计痕以 428 响应 reason + 重新签发体现,不持久化明文 token)。
interface ConfirmationTokenRecord {
  token: string;
  purpose: string;
  bindingHash: string;
  expiresAt: number; // epoch ms
}
const confirmationTokens = new Map<string, ConfirmationTokenRecord>();
const CONFIRM_TOKEN_TTL_MS = 10 * 60 * 1000;

function pruneExpiredTokens(nowMs: number): void {
  for (const [k, v] of confirmationTokens) if (v.expiresAt <= nowMs) confirmationTokens.delete(k);
}

export function issueConfirmationToken(
  purpose: string, bindingHash: string, nowMs: number = Date.now(),
): { token: string; expiresAt: string } {
  pruneExpiredTokens(nowMs);
  const token = randomUUID();
  const expiresAtMs = nowMs + CONFIRM_TOKEN_TTL_MS;
  confirmationTokens.set(token, { token, purpose, bindingHash, expiresAt: expiresAtMs });
  return { token, expiresAt: new Date(expiresAtMs).toISOString() };
}

export type ConfirmationConsumeResult = "ok" | "missing" | "expired" | "mismatch";

// 一次性消费:命中即删。missing 同时覆盖"从未签发"与"已被消费过(重放)"两种情形——都按令统一 428 重签。
export function consumeConfirmationToken(
  purpose: string, token: unknown, bindingHash: string, nowMs: number = Date.now(),
): ConfirmationConsumeResult {
  if (typeof token !== "string" || !token) return "missing";
  const rec = confirmationTokens.get(token);
  if (!rec || rec.purpose !== purpose) return "missing";
  if (rec.expiresAt <= nowMs) { confirmationTokens.delete(token); return "expired"; }
  if (rec.bindingHash !== bindingHash) return "mismatch";
  confirmationTokens.delete(token); // 一次性:消费即失效
  return "ok";
}

// 测试隔离辅助:清空内存 token 表(避免跨用例串)。
export function __resetConfirmationTokens(): void { confirmationTokens.clear(); }
// ── 活公司架构提案 ───────────────────────────────────────────────────────────────
// 与上面的草稿提案使用同一套持久化原则，但 action 形状由 architectAssistant 在运行时校验，
// 存储层只保存不可变 JSON、hash 和状态。apply 只能消费 pending 记录，禁止客户端凭 actions 直写。
export const LiveArchitectProposalStatusSchema = z.enum(["pending", "applying", "applied", "failed", "rolled_back"]);
export const LiveArchitectProposalSchema = z.object({
  proposalId: z.string(),
  companyId: z.string(),
  summary: z.string(),
  architectSkill: z.object({ id: z.string(), version: z.string() }).optional(),
  actions: z.array(z.unknown()),
  actionsHash: z.string(),
  beforeHash: z.string(),
  expiresAt: z.string(),
  status: LiveArchitectProposalStatusSchema.default("pending"),
  createdAt: z.string(),
  appliedAt: z.string().optional(),
  failedAt: z.string().optional(),
  failureReason: z.string().optional(),
  txId: z.string().optional(),
  rolledBackAt: z.string().optional(),
});
export type LiveArchitectProposal = z.infer<typeof LiveArchitectProposalSchema>;

function liveArchitectProposalFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "architect", "live-architect-proposals.jsonl");
}

export function loadLiveArchitectProposals(projectRoot: string): LiveArchitectProposal[] {
  const f = liveArchitectProposalFile(projectRoot);
  if (!fs.existsSync(f)) return [];
  const out: LiveArchitectProposal[] = [];
  for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = LiveArchitectProposalSchema.safeParse(JSON.parse(text));
      if (parsed.success) out.push(parsed.data);
    } catch { /* 保留其余有效记录 */ }
  }
  return out;
}

function writeLiveArchitectProposals(projectRoot: string, records: LiveArchitectProposal[]): void {
  const f = liveArchitectProposalFile(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const capped = records.slice(0, 100);
  fs.writeFileSync(f, capped.map(r => JSON.stringify(r)).join("\n") + (capped.length ? "\n" : ""), "utf-8");
}

export function saveLiveArchitectProposal(
  projectRoot: string,
  input: Omit<LiveArchitectProposal, "proposalId" | "status" | "createdAt">,
  nowIso: string,
): LiveArchitectProposal {
  const rec: LiveArchitectProposal = {
    ...input,
    proposalId: `live_arch_prop_${randomUUID().slice(0, 8)}`,
    status: "pending",
    createdAt: nowIso,
  };
  const all = loadLiveArchitectProposals(projectRoot);
  all.unshift(rec);
  writeLiveArchitectProposals(projectRoot, all);
  return rec;
}

export function getLiveArchitectProposal(projectRoot: string, proposalId: string): LiveArchitectProposal | null {
  return loadLiveArchitectProposals(projectRoot).find(p => p.proposalId === proposalId) ?? null;
}

function updateLiveArchitectProposal(
  projectRoot: string,
  proposalId: string,
  expected: LiveArchitectProposal["status"],
  patch: Partial<LiveArchitectProposal>,
): LiveArchitectProposal | null {
  const all = loadLiveArchitectProposals(projectRoot);
  const idx = all.findIndex(p => p.proposalId === proposalId);
  if (idx < 0 || all[idx].status !== expected) return null;
  const updated = LiveArchitectProposalSchema.parse({ ...all[idx], ...patch });
  all[idx] = updated;
  writeLiveArchitectProposals(projectRoot, all);
  return updated;
}

export function claimLiveArchitectProposal(
  projectRoot: string, proposalId: string,
): LiveArchitectProposal | null {
  return updateLiveArchitectProposal(projectRoot, proposalId, "pending", { status: "applying" });
}

export function markLiveArchitectProposalApplied(
  projectRoot: string, proposalId: string, txId: string, nowIso: string,
): LiveArchitectProposal | null {
  return updateLiveArchitectProposal(projectRoot, proposalId, "applying", {
    status: "applied", txId, appliedAt: nowIso,
  });
}

export function markLiveArchitectProposalFailed(
  projectRoot: string, proposalId: string, reason: string, nowIso: string,
): LiveArchitectProposal | null {
  const current = getLiveArchitectProposal(projectRoot, proposalId);
  if (!current || (current.status !== "pending" && current.status !== "applying")) return null;
  return updateLiveArchitectProposal(projectRoot, proposalId, current.status, {
    status: "failed", failureReason: reason, failedAt: nowIso,
  });
}

export function markLiveArchitectProposalRolledBack(
  projectRoot: string, proposalId: string, nowIso: string,
): LiveArchitectProposal | null {
  return updateLiveArchitectProposal(projectRoot, proposalId, "applied", {
    status: "rolled_back", rolledBackAt: nowIso,
  });
}

// ── C(波4)· 活公司侧 architect-apply 事务台账(rollback + fidelity ledger)──────────────────
// architectRoutes.ts /architect-apply 直接写持久 company/agents(不像草稿侧只回给前端),b3eb202 之前
// 无任何回滚依据。这里参照 installTransactionStore 的"apply 前拍受影响面快照 → 落一条可回滚记录"模式,
// 但落点是本 store 自有的独立 JSONL(.opc/architect/architect-apply-transactions.jsonl),与草稿侧
// company-edit-proposals.jsonl 完全分开——两者操作对象不同(活公司 vs 草稿),不混一张表。
// 快照存 apply 前该公司的 agents 全量 + workflow + presetChannels(整值),rollback 时:删掉本次新建的
// agent(createdAgentIds)、把快照里的 agent 逐个 updateAgent 恢复(含 enabled/childrenIds/parentId,
// 因此软删除的 remove_agent 也能复活)、company 的 workflow/presetChannels 整值恢复。best-effort,失败静默。
export const ArchitectApplyTxStatusSchema = z.enum(["applied", "rolled_back"]);
export const ArchitectApplyLedgerSummarySchema = CompanyEditLedgerSummarySchema;

export const ArchitectApplyTransactionSchema = z.object({
  txId: z.string(),
  proposalId: z.string().optional(),
  surfaceVersion: z.union([z.literal(1), z.literal(2)]).default(1),
  companyId: z.string(),
  at: z.string(),
  createdAgentIds: z.array(z.string()).default([]),
  // 快照原样持久化 / 原样恢复——不强约束内部形状(passthrough),避免这层跟着 AgentNodeConfig/Company 演进而反复改。
  agentsBefore: z.array(z.record(z.unknown())).default([]),
  companyBefore: z.record(z.unknown()).optional(),
  skillsBefore: z.array(z.record(z.unknown())).default([]),
  workflowBefore: z.unknown().optional(),
  presetChannelsBefore: z.unknown().optional(),
  beforeHash: z.string(),
  afterHash: z.string(),
  ledger: ArchitectApplyLedgerSummarySchema.optional(),
  status: ArchitectApplyTxStatusSchema.default("applied"),
  rolledBackAt: z.string().optional(),
});
export type ArchitectApplyTransaction = z.infer<typeof ArchitectApplyTransactionSchema>;

const ARCHITECT_APPLY_TX_MAX = 50;

function architectApplyTxFile(projectRoot: string): string {
  return path.join(projectRoot, ".opc", "architect", "architect-apply-transactions.jsonl");
}

function loadArchitectApplyTxRaw(f: string): ArchitectApplyTransaction[] {
  if (!fs.existsSync(f)) return [];
  const out: ArchitectApplyTransaction[] = [];
  for (const line of fs.readFileSync(f, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { const p = ArchitectApplyTransactionSchema.safeParse(JSON.parse(t)); if (p.success) out.push(p.data); } catch { /* */ }
  }
  return out;
}

export function loadArchitectApplyTransactions(projectRoot: string): ArchitectApplyTransaction[] {
  return loadArchitectApplyTxRaw(architectApplyTxFile(projectRoot));
}

function writeArchitectApplyTransactions(projectRoot: string, records: ArchitectApplyTransaction[]): void {
  const f = architectApplyTxFile(projectRoot);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const capped = records.slice(0, ARCHITECT_APPLY_TX_MAX);
  fs.writeFileSync(f, capped.map(r => JSON.stringify(r)).join("\n") + (capped.length ? "\n" : ""), "utf-8");
}

export function recordArchitectApplyTransaction(
  projectRoot: string,
  input: Omit<ArchitectApplyTransaction, "txId" | "at" | "status" | "rolledBackAt">,
  nowIso: string,
): ArchitectApplyTransaction {
  const rec: ArchitectApplyTransaction = {
    ...input,
    txId: `arch_tx_${randomUUID().slice(0, 8)}`,
    at: nowIso,
    status: "applied",
  };
  const all = loadArchitectApplyTransactions(projectRoot);
  all.unshift(rec); // 新的在前,与 installTransactionStore 同序
  writeArchitectApplyTransactions(projectRoot, all);
  return rec;
}

export function getArchitectApplyTransaction(projectRoot: string, txId: string): ArchitectApplyTransaction | null {
  return loadArchitectApplyTransactions(projectRoot).find(t => t.txId === txId) ?? null;
}

export function markArchitectApplyTransactionRolledBack(projectRoot: string, txId: string, nowIso: string): ArchitectApplyTransaction | null {
  const all = loadArchitectApplyTransactions(projectRoot);
  const idx = all.findIndex(t => t.txId === txId);
  if (idx === -1) return null;
  if (all[idx].status !== "applied") return null;
  const updated: ArchitectApplyTransaction = { ...all[idx], status: "rolled_back", rolledBackAt: nowIso };
  all[idx] = updated;
  writeArchitectApplyTransactions(projectRoot, all);
  return updated;
}
