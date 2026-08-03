// A2 · Task Graph 最小骨架:任务图是全局治理层(AI 局部规划,DAG 全局治理)。
// CEO 产出 TaskGraphProposal(未校验的原始提案)→ Core 六项校验 → commit 成正式 TaskGraph →
// scheduler 按拓扑序派发。类型放 shared:server 调度 + web 拆解树(C2)都要消费。

// 指南 4.4 的十态。V0 调度器只会产生 planned/running/blocked/completed/failed;
// 其余(pending/waiting_review/needs_revision/accepted/cancelled)是 A3 返工/审查节点的预留态,
// 先进类型让消费方(UI/store)一次对齐,避免后续再改 schema。
export type TaskNodeStatus =
  | "pending"
  | "planned"
  | "running"
  | "blocked"
  | "waiting_review"
  | "needs_revision"
  | "completed"
  | "accepted"
  | "failed"
  | "cancelled";

export interface TaskNodeStatusChange {
  status: TaskNodeStatus;
  at: string;        // ISO timestamp
  by?: string;       // 谁触发的状态迁移(如 "core")
}

export interface TaskNodeStartedReceipt {
  receiptId: string;
  at: string;
  attempt: number;
  visit: number;
  inputHash: string;
  idempotencyKey: string;
  leaseOwner: string;
  sideEffectRisk: boolean;
  runId?: string;
}

export interface TaskNodeCompletionReceipt {
  receiptId: string;
  at: string;
  attempt: number;
  inputHash: string;
  idempotencyKey: string;
  status: "completed" | "accepted" | "failed" | "cancelled";
  resultHash?: string;
  runId?: string;
  artifactRefs: string[];
  evidenceRefs: string[];
}

export interface TaskNode {
  /** Optional on legacy nodes; every newly scheduled node is upgraded to v2. */
  schemaVersion?: "2";
  id: string;                     // 图内唯一(n1/n2/...)
  title: string;
  goal: string;                   // 派发给 agent 的任务目标文本
  assignedAgentId: string;        // 校验阶段已解析成真实 agent id
  assignedRole?: string;          // CEO 提案里的原始角色文本(溯源用)
  dependsOn: string[];            // 依赖的 TaskNode.id(校验阶段已从 title/artifact 解析)
  expectedArtifacts: string[];    // 非空(校验阶段兜默认值)
  status: TaskNodeStatus;
  statusHistory: TaskNodeStatusChange[];
  runId?: string;                 // 派发后对应的 run
  error?: string;                 // failed 时的原因
  resultSummary?: string;         // completed 后的产出摘要(供下游节点做上下文 + UI 展示)
  // A3 · 调度器完整化:
  kind?: "work" | "review";       // 省略 = "work"。"review" = 审查节点,执行时把 reviewOf 节点的产出作为输入
  reviewOf?: string;               // kind="review" 时必填:被审查的 TaskNode.id(校验阶段已解析)
  revisionCount?: number;          // 该节点被判定 needs_revision 的次数(返工计数,用于 maxRounds 判定)
  revisionFeedback?: string;       // 最近一次审查否决的理由(返工重跑时注入 goal,避免盲重试)
  /** Number of actual dispatch attempts. */
  attempt?: number;
  /** Number of scheduler visits that acquired an execution lease. */
  visit?: number;
  inputHash?: string;
  idempotencyKey?: string;
  leaseOwner?: string;
  leaseExpiry?: string;
  startedReceipt?: TaskNodeStartedReceipt;
  completionReceipt?: TaskNodeCompletionReceipt;
  artifactRefs?: string[];
  evidenceRefs?: string[];
  /** A started attempt without a completion receipt whose side effects cannot be disproved. */
  uncertain?: boolean;
}

export type TaskGraphStatus = "proposed" | "committed" | "running" | "completed" | "failed" | "cancelled";

export interface TaskGraph {
  id: string;
  missionId: string;
  companyId: string;
  goal: string;                   // mission 级目标
  nodes: TaskNode[];
  status: TaskGraphStatus;
  createdAt: string;
  updatedAt: string;
  schemaVersion: "1" | "2";
  /** Monotonic compare-and-swap revision. Missing on legacy graphs and normalized to zero. */
  revision?: number;
}

// CEO 原始提案(指南 9.2 的 JSON 形状,snake_case 保持模型输出原貌;未经 Core 校验,不可直接执行)。
export interface TaskGraphProposalTask {
  title: string;
  goal?: string;
  assigned_role?: string;
  assigned_agent_id?: string;
  depends_on?: string[];          // 可引用其他任务的 title 或其 expected_artifacts 文件名
  expected_artifacts?: string[];
  kind?: "work" | "review";       // A3:省略 = "work"
  review_of?: string;              // A3:kind="review" 时必填,引用被审任务的 title/expected_artifacts(同 depends_on 的解析规则)
}

export interface TaskGraphProposal {
  proposal_type?: string;         // "task_graph"(可省)
  mission_summary: string;
  tasks: TaskGraphProposalTask[];
}
