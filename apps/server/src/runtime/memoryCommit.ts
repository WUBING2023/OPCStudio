// WS4 · Canonical Memory 投影闭环（§8 Phase 4）— 审核流核心模块。
// 实现"worker 只提 proposal → Lead/MemoryManager 审核 → commit"的生命周期，
// 保证 canonical memory 始终是经过人/协调者审核的投影，而非自动入库的原始产出。
// 现状(2026-07-07,A1-V2 落地):三态审核流已启用 —— orchestrator 的 run_conclusion 路径统一走
// proposal(pending)→approved→committed 完整走账;低风险自动批准(账本仍有三态完整记录),
// 高风险(权限/删除/shell/密钥类内容)停 pending 等人工审批(memoryRoutes /api/runs/:id/memory-proposals)。

import { normalizeCompanyId } from "@opc/shared";

export type MemoryScope = "run" | "project" | "team" | "agent";

// ProposalStatus:proposal 生命周期。A1-V2 新增 "approved"(pending→approved→committed 完整走账);
// 兼容旧路径:commit 仍接受 pending 直接提交(隐式批准),旧数据/旧调用不受影响。
export type ProposalStatus = "pending" | "approved" | "committed" | "rejected";

// MemoryProposal：worker 执行后提交的记忆候选。
// confidence：[0, 1]，worker 自评置信度（1 = 完全可信，0 = 极不确定）。
// sourceArtifactRefs：关联的 ArtifactStore artifact id 列表，供审核者溯源。
// tags：用于检索侧按话题/语义过滤。
export interface MemoryProposal {
  proposalId: string;
  runId: string;
  scope: MemoryScope;
  type: string;
  content: string;
  sourceArtifactRefs: string[];
  proposedBy: string;
  confidence: number;
  tags: string[];
  status: ProposalStatus;
  companyId?: string; // C12-P0:产出该记忆的公司归属(加性,旧数据合法);检索侧对已审批跨 run 经验做公司硬隔离
  role?: string;     // Stage 4:产出该记忆的 agent 角色(scope=agent 时用于隔离;归一小写)
  agentId?: string;  // Stage 4:产出该记忆的真实 agentId(provenance,替代写死 'orchestrator')
  taskType?: string; // D1/D2:任务类型(classifyTaskType),供检索侧 taskType 匹配过滤(加性,旧数据合法)
  // A1-V2:风险分级与走账记录(可选,兼容旧调用方/旧数据)。
  risk?: "low" | "high";            // 高风险 = 默认停 pending 等人工审批
  approvedBy?: string;              // 批准者(自动批准为 "orchestrator",人工为 "human" 等)
  approvedAt?: string;              // 批准时间(ISO 8601,调用方传入)
  statusHistory?: Array<{ status: ProposalStatus; at?: string; by?: string }>; // 三态完整走账
}

// CommittedMemory：经审核提交后的 canonical memory 条目，带版本与来源追踪。
// version：从 1 开始单调递增；parentVersion：首次提交时为 0（无父版本）。
// revocable：true = 可被后续 revoke；false = 写入即永久（谨慎使用）。
// createdAt：调用方传入（ISO 8601），模块内不调用 Date.now()。
export interface CommittedMemory {
  memoryId: string;
  version: number;
  parentVersion: number;
  scope: MemoryScope;
  type: string;
  content: string;
  sourceArtifactRefs: string[];
  approvedBy: string;
  confidence: number;
  revocable: boolean;
  createdAt: string;
  tags?: string[];          // domain tags from original proposal; enables retrieval-side tag filter
  companyId?: string;       // C12-P0:产出该记忆的公司归属(加性,旧条目 undefined=无归属)。检索注入侧公司硬隔离据此
  role?: string;            // Stage 4:产出该记忆的 agent 角色(scope=agent 时按 role 隔离;归一小写)。undefined=旧条目/共享
  agentId?: string;         // Stage 4:产出该记忆的真实 agentId(provenance)
  taskType?: string;        // D1/D2:任务类型(classifyTaskType),供检索侧 taskType 匹配过滤(加性,旧数据合法)
}

// Stage 4:角色记忆归一(避免 "Dev" vs "dev" 隔离失配)。
export function normalizeRole(role: string | undefined): string | undefined {
  return role?.trim().toLowerCase() || undefined;
}

// ── 纯函数 ───────────────────────────────────────────────────────────────────

// A1-V2:批准 proposal(pending → approved),纯函数,返回新对象并在 statusHistory 上追加走账记录。
// 只接受 pending;否则抛出(committed/rejected/approved 均不可重复批准)。
export function approveProposal(
  proposal: MemoryProposal,
  approvedBy: string,
  approvedAt: string,
): MemoryProposal {
  if (proposal.status !== "pending") {
    throw new Error(
      `approveProposal: proposal "${proposal.proposalId}" 状态为 "${proposal.status}"，只有 pending 可批准`,
    );
  }
  return {
    ...proposal,
    status: "approved",
    approvedBy,
    approvedAt,
    statusHistory: [...(proposal.statusHistory ?? [{ status: "pending" }]), { status: "approved", at: approvedAt, by: approvedBy }],
  };
}

// 审核通过 proposal，产生 CommittedMemory。
// prev 存在时版本在其基础上 +1；首次 commit（无 prev）时 version = 1，parentVersion = 0。
// 接受 pending(旧路径,隐式批准)或 approved(A1-V2 完整三态流)状态;否则抛出,防止重复提交。
export function commitProposal(
  proposal: MemoryProposal,
  approvedBy: string,
  createdAt: string,
  memoryId: string,
  prev?: CommittedMemory,
  revocable = true,
): CommittedMemory {
  if (proposal.status !== "pending" && proposal.status !== "approved") {
    throw new Error(
      `commitProposal: proposal "${proposal.proposalId}" 状态为 "${proposal.status}"，只有 pending/approved 可提交`,
    );
  }
  const parentVersion = prev?.version ?? 0;
  return {
    memoryId,
    version: parentVersion + 1,
    parentVersion,
    scope: proposal.scope,
    type: proposal.type,
    content: proposal.content,
    sourceArtifactRefs: [...proposal.sourceArtifactRefs],
    approvedBy,
    confidence: proposal.confidence,
    revocable,
    createdAt,
    tags: proposal.tags.length > 0 ? [...proposal.tags] : undefined,
    companyId: normalizeCompanyId(proposal.companyId), // C12-P0/令二.2:公司归属随 proposal 透传并归一(缺省=default)进 committed 条目
    role: normalizeRole(proposal.role),
    agentId: proposal.agentId,
    taskType: proposal.taskType,
  };
}

// 拒绝 proposal：返回新对象（status = "rejected"），不修改原对象（纯函数）。
// 只接受 pending 状态；否则抛出。
export function rejectProposal(proposal: MemoryProposal): MemoryProposal {
  if (proposal.status !== "pending") {
    throw new Error(
      `rejectProposal: proposal "${proposal.proposalId}" 状态为 "${proposal.status}"，只有 pending 可拒绝`,
    );
  }
  return { ...proposal, status: "rejected", statusHistory: [...(proposal.statusHistory ?? [{ status: "pending" }]), { status: "rejected" }] };
}

// ── MemoryLedger（内存实现，不碰文件系统） ────────────────────────────────────

// 内部存储结构：CommittedMemory 实体 + 来自原 proposal 的 tags（用于检索过滤）。
// CommittedMemory 公开类型不含 tags，但检索时需要按 tags 过滤（WS4 Phase 4 需求）。
interface StoredEntry {
  entry: CommittedMemory;
  tags: string[];
}

// MemoryLedger：proposal 注册、审核、committed memory 版本化管理。
// 所有时间戳与 ID 由调用方传入；Map 持久于实例生命周期。
export class MemoryLedger {
  private proposals: Map<string, MemoryProposal> = new Map();
  private store: Map<string, StoredEntry> = new Map();
  private revoked: Set<string> = new Set();

  // 注册新 proposal（必须是 pending 状态）。
  // proposalId 重复时抛出，防止调用方意外覆盖。
  add(proposal: MemoryProposal): MemoryProposal {
    if (this.proposals.has(proposal.proposalId)) {
      throw new Error(`MemoryLedger.add: proposalId "${proposal.proposalId}" 已存在`);
    }
    if (proposal.status !== "pending") {
      throw new Error(
        `MemoryLedger.add: 只接受 pending 状态的 proposal，实际为 "${proposal.status}"`,
      );
    }
    // A1-V2:注册即开账(statusHistory 起始为 pending;调用方已带走账记录则沿用)。
    const withHistory: MemoryProposal = {
      ...proposal,
      statusHistory: proposal.statusHistory ?? [{ status: "pending" }],
    };
    this.proposals.set(proposal.proposalId, withHistory);
    return withHistory;
  }

  // A1-V2:批准 proposal(pending → approved),走账记录批准者与时间。
  // 低风险自动批准与人工批准共用此入口 —— 区别只在 approvedBy。
  approve(proposalId: string, approvedBy: string, approvedAt: string): MemoryProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`MemoryLedger.approve: proposalId "${proposalId}" 不存在`);
    }
    const approved = approveProposal(proposal, approvedBy, approvedAt);
    this.proposals.set(proposalId, approved);
    return approved;
  }

  // 审核通过 proposal → 产生/更新 CommittedMemory。
  // memoryId 相同时版本号在已有基础上 +1（对同一知识点进行版本化更新）。
  // 若 memoryId 已被撤销（revoked），需要 force=true 才能重新写入；默认拒绝。
  commit(
    proposalId: string,
    approvedBy: string,
    createdAt: string,
    memoryId: string,
    revocable = true,
    force = false,
  ): CommittedMemory {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`MemoryLedger.commit: proposalId "${proposalId}" 不存在`);
    }
    if (this.revoked.has(memoryId) && !force) {
      throw new Error(
        `MemoryLedger.commit: memoryId "${memoryId}" 已被撤销，若需强制写入请传 force=true`,
      );
    }
    const prev = this.store.get(memoryId)?.entry;
    const entry = commitProposal(proposal, approvedBy, createdAt, memoryId, prev, revocable);
    // 更新 proposal 状态（不可变风格：替换整个记录），并在走账记录上追加 committed。
    this.proposals.set(proposalId, {
      ...proposal,
      status: "committed",
      statusHistory: [...(proposal.statusHistory ?? []), { status: "committed", at: createdAt, by: approvedBy }],
    });
    this.store.set(memoryId, { entry, tags: [...proposal.tags] });
    // force 提交后解除撤销标记
    this.revoked.delete(memoryId);
    return entry;
  }

  // 拒绝 proposal（pending → rejected），不影响 committed memory。
  reject(proposalId: string): MemoryProposal {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`MemoryLedger.reject: proposalId "${proposalId}" 不存在`);
    }
    const rejected = rejectProposal(proposal);
    this.proposals.set(proposalId, rejected);
    return rejected;
  }

  // 撤销 committed memory（仅限 revocable=true 的条目）。
  // 撤销不删除历史记录，仅打标记——list() 默认过滤掉撤销条目，审计仍可见。
  revoke(memoryId: string): CommittedMemory {
    const stored = this.store.get(memoryId);
    if (!stored) {
      throw new Error(`MemoryLedger.revoke: memoryId "${memoryId}" 不存在`);
    }
    if (!stored.entry.revocable) {
      throw new Error(
        `MemoryLedger.revoke: memoryId "${memoryId}" 标记为不可撤销（revocable=false）`,
      );
    }
    this.revoked.add(memoryId);
    return stored.entry;
  }

  // 列出 committed memory，支持多维度过滤：
  //   scope / type：精确匹配；
  //   tags：所有指定 tag 都必须命中（AND 语义）；
  //   minConfidence：置信度下限（含边界）；
  //   includeRevoked：是否包含已撤销条目（默认 false，审计场景传 true）。
  list(opts?: {
    scope?: MemoryScope;
    type?: string;
    tags?: string[];
    minConfidence?: number;
    includeRevoked?: boolean;
  }): CommittedMemory[] {
    const { scope, type, tags, minConfidence = 0, includeRevoked = false } = opts ?? {};
    const result: CommittedMemory[] = [];
    for (const [memoryId, stored] of this.store) {
      if (!includeRevoked && this.revoked.has(memoryId)) continue;
      const m = stored.entry;
      if (scope && m.scope !== scope) continue;
      if (type && m.type !== type) continue;
      if (m.confidence < minConfidence) continue;
      if (tags && tags.length > 0) {
        const entryTags = new Set(stored.tags);
        if (!tags.every(t => entryTags.has(t))) continue;
      }
      result.push(m);
    }
    return result;
  }

  // 列出 proposal（可按状态过滤；不传则返回全部）。
  listProposals(status?: ProposalStatus): MemoryProposal[] {
    const all = Array.from(this.proposals.values());
    return status !== undefined ? all.filter(p => p.status === status) : all;
  }

  // 查询单条 committed memory（含已撤销）。
  get(memoryId: string): CommittedMemory | undefined {
    return this.store.get(memoryId)?.entry;
  }

  // 查询单条 proposal（含历史状态）。
  getProposal(proposalId: string): MemoryProposal | undefined {
    return this.proposals.get(proposalId);
  }

  // 是否已被撤销（供 contextBuilder 过滤注入时使用）。
  isRevoked(memoryId: string): boolean {
    return this.revoked.has(memoryId);
  }
}
