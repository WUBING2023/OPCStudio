import { createHash, randomUUID } from "node:crypto";
import type { TaskGraph, TaskGraphProposal, TaskNode, TaskNodeStatus } from "@opc/shared";
import { TaskGraphProposalSchema, parseReviewNodeProposal, parseTaskGraphProposal } from "./planSchema.js";
import { claimTaskNodeLease, getTaskGraph, renewTaskNodeLease, upsertTaskGraph } from "../storage/taskGraphStore.js";
import { invokeSystemModel } from "./systemModelInvoke.js";
import { CEO_TASK_GRAPH_PROMPT, REVIEW_NODE_INSTRUCTION } from "./prompts.js";

// A2/A3 · Task Graph Scheduler:
//   generateTaskGraphProposal —— CEO(系统模型)产出原始提案(AI proposes)
//   validateProposal          —— Core 六项校验,通过才 commit 成正式图(Core commits)
//   executeGraph              —— 按拓扑层**并发**派发就绪节点(A3),支持失败返工回边与审查节点
// 真实派发(startRun)通过 deps.dispatch 注入(接线在 missionRoutes),本模块不 import orchestrator,
// 保持可单测(mock dispatch)且无循环依赖。
//
// A3 补的三件事(V0 只有串行链):
//   1. 并行就绪调度——每轮把所有依赖已 completed/accepted 的 planned/pending 节点一起 Promise.all 派发,
//      不再一次只挑一个;失败传染逻辑不变(某节点终态 failed → 依赖它的未跑节点全部 blocked)。
//   2. 失败返工——dispatch 结果带 needsRevision,或审查节点判 needs_revision:目标节点回到 pending 重跑,
//      最多 maxRounds(默认 2)轮,超限 failed;revisionCount 递增,statusHistory 记录 needs_revision→running。
//   3. 审查节点(kind="review")——执行时把 reviewOf 节点的产出(已在 dependsOn 里,天然被拼进 goal 上下文)
//      作为输入,dispatch 后由调用方解析出 verdict;needs_revision 触发被审节点走第 2 条返工,accepted 则把
//      被审节点从 completed 提升为 accepted(十态里"审查通过"的终态,不同于"跑完但没人审"的 completed)。

// 调度只需要 agent 的这几个字段;不 import AgentNodeConfig 全量类型,降低耦合。
export interface SchedulableAgent {
  id: string;
  name?: string;
  role?: string;
  companyId?: string;
  enabled?: boolean;
}

export interface ValidateContext {
  companyId: string;
  missionId: string;
  goal: string;
}

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  graph?: TaskGraph;
}

export const MAX_GRAPH_NODES = 12;

const norm = (s: string) => s.trim().toLowerCase();

// assigned_agent_id 优先精确匹配;否则按 assigned_role 解析:精确 role → 精确 name → 词元包含。
// 多候选时优先非 ceo/lead(执行节点应落在 worker 层),再按名册顺序取第一个,保证确定性。
function resolveAssignee(
  t: { title: string; assigned_agent_id?: string; assigned_role?: string },
  roster: SchedulableAgent[],
): { agentId?: string; error?: string } {
  if (t.assigned_agent_id) {
    const hit = roster.find(a => a.id === t.assigned_agent_id);
    return hit
      ? { agentId: hit.id }
      : { error: `任务「${t.title}」指定的 assigned_agent_id「${t.assigned_agent_id}」在该公司不存在` };
  }
  const role = norm(t.assigned_role ?? "");
  if (!role) return { error: `任务「${t.title}」缺少 assigned_agent_id / assigned_role,无法解析执行人` };
  const pick = (list: SchedulableAgent[]) =>
    (list.find(a => a.role !== "ceo" && a.role !== "lead") ?? list[0]).id;
  const exactRole = roster.filter(a => norm(a.role ?? "") === role);
  if (exactRole.length) return { agentId: pick(exactRole) };
  const exactName = roster.filter(a => norm(a.name ?? "") === role);
  if (exactName.length) return { agentId: pick(exactName) };
  const tokens = role.split(/[\s_/-]+/).filter(Boolean);
  const fuzzy = roster.filter(a => {
    const hay = `${norm(a.role ?? "")} ${norm(a.name ?? "")}`;
    return tokens.some(tk => hay.includes(tk));
  });
  if (fuzzy.length) return { agentId: pick(fuzzy) };
  return { error: `任务「${t.title}」的角色「${t.assigned_role}」在该公司解析不到任何 agent` };
}

// Kahn 拓扑排序做环检测(自实现,不跨包引用前端 workshopTypes 的 hasCycle)。
// 返回无法完成排序的节点(即环上或依赖环的节点);空数组 = 无环。
function findCycleNodes(nodes: Array<{ id: string; dependsOn: string[] }>): string[] {
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, n.dependsOn.length);
    for (const d of n.dependsOn) out.set(d, [...(out.get(d) ?? []), n.id]);
  }
  const queue = nodes.filter(n => (indeg.get(n.id) ?? 0) === 0).map(n => n.id);
  let processed = 0;
  while (queue.length) {
    const id = queue.shift()!;
    processed++;
    for (const next of out.get(id) ?? []) {
      const left = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (processed >= nodes.length) return [];
  return nodes.filter(n => (indeg.get(n.id) ?? 0) > 0).map(n => n.id);
}

// Core 六项校验:①结构(zod) ②无环+依赖引用存在 ③assigned agent 可解析 ④expectedArtifacts 非空(可兜默认)
// ⑤节点数 ≤12 ⑥goal 非空。全部通过 → 产出 committed 状态的 TaskGraph(节点初始 planned)。
// 错误信息点名具体任务,一次返回全部问题(不在第一个错误就短路,减少来回)。
// Token limits are enforced by the runtime when the graph nodes execute. This
// validator deliberately avoids monetary estimates because subscription and
// cache pricing cannot be compared honestly at proposal time.
export function validateProposal(
  proposal: TaskGraphProposal,
  agents: SchedulableAgent[],
  ctx: ValidateContext,
): ValidateResult {
  // ① 结构合法(zod)
  const structural = TaskGraphProposalSchema.safeParse(proposal);
  if (!structural.success) {
    const errors = structural.error.issues
      .map(i => `结构非法 ${i.path.join(".") || "(root)"}: ${i.message}`)
      .slice(0, 10);
    return { ok: false, errors };
  }
  const p = structural.data;
  const errors: string[] = [];

  // ⑤ 节点数上限(防爆炸)
  if (p.tasks.length > MAX_GRAPH_NODES) {
    errors.push(`任务数 ${p.tasks.length} 超过上限 ${MAX_GRAPH_NODES}`);
  }

  // 与 generateTaskGraphProposal 的名册同口径排除 ceo:提案侧不给 CEO 派活,校验侧也不能放行
  // 指名/兜底解析到 CEO 的任务(否则"AI proposes, Core commits"的越界只有 prompt 层约束)。
  const roster = agents.filter(a => (a.companyId ?? "default") === ctx.companyId && a.enabled !== false && a.role !== "ceo");
  const now = new Date().toISOString();
  const ids = p.tasks.map((_, i) => `n${i + 1}`);

  // 依赖引用解析表:title / expected_artifacts 文件名 → 节点 id(指南 9.2 的 depends_on 引用的是
  // 上游任务的 artifact 文件名,也兼容直接写 title / 节点 id)。
  const refMap = new Map<string, string[]>();
  const addRef = (key: string, id: string) => {
    const k = norm(key);
    if (!k) return;
    refMap.set(k, [...(refMap.get(k) ?? []), id]);
  };
  const artifactsOf: string[][] = p.tasks.map((t, i) => {
    const provided = t.expected_artifacts;
    const cleaned = (provided ?? []).map(s => s.trim());
    // ④ expectedArtifacts:显式给了但含空文件名 → 错;完全没给 → 兜一个默认产物名(非空保证)。
    if (provided && provided.length && cleaned.some(s => !s)) {
      errors.push(`任务「${t.title}」的 expected_artifacts 含空文件名`);
    }
    const list = cleaned.filter(Boolean);
    return list.length ? list : [`task-${i + 1}-output.md`];
  });
  p.tasks.forEach((t, i) => {
    addRef(t.title, ids[i]);
    addRef(ids[i], ids[i]);
    for (const art of artifactsOf[i]) addRef(art, ids[i]);
  });

  const nodes: TaskNode[] = [];
  p.tasks.forEach((t, i) => {
    // ⑥ goal 非空(goal 缺省回退 title;两者都空白 → 错)
    const goalText = (t.goal ?? "").trim() || t.title.trim();
    if (!goalText) errors.push(`任务 #${i + 1} 的 goal 为空(title 也为空白,无法回退)`);

    // ② 依赖引用存在(环检测在解析完成后统一做)
    const dependsOn: string[] = [];
    for (const d of t.depends_on ?? []) {
      const hits = [...new Set(refMap.get(norm(d)) ?? [])];
      if (!hits.length) {
        errors.push(`任务「${t.title}」的依赖「${d}」无法解析(不是任何任务的 title/expected_artifact)`);
        continue;
      }
      if (hits.length > 1) {
        errors.push(`任务「${t.title}」的依赖「${d}」指向多个任务,存在歧义`);
        continue;
      }
      if (hits[0] === ids[i]) {
        errors.push(`任务「${t.title}」依赖自身,构成环`);
        continue;
      }
      dependsOn.push(hits[0]);
    }

    // ③ assigned agent 存在(按 id 或 role 在该公司解析出真实 agentId)
    const assignee = resolveAssignee(t, roster);
    if (assignee.error) errors.push(assignee.error);

    // A3:review 节点必须能解析出 review_of;非 review 节点不该带 review_of(半配置状态直接拒绝,
    // 避免 CEO 写错 kind 导致"看似审查、实际当普通任务跑"的静默错误)。解析到的目标自动并入 dependsOn——
    // 审查节点天然依赖被审节点的产出(即使 CEO 忘了在 depends_on 里也写一遍)。
    const kind: "work" | "review" = t.kind === "review" ? "review" : "work";
    let reviewOf: string | undefined;
    if (kind === "review") {
      if (!t.review_of || !t.review_of.trim()) {
        errors.push(`审查任务「${t.title}」缺少 review_of,不知道要审查哪个任务`);
      } else {
        const hits = [...new Set(refMap.get(norm(t.review_of)) ?? [])];
        if (!hits.length) {
          errors.push(`审查任务「${t.title}」的 review_of「${t.review_of}」无法解析(不是任何任务的 title/expected_artifact)`);
        } else if (hits.length > 1) {
          errors.push(`审查任务「${t.title}」的 review_of「${t.review_of}」指向多个任务,存在歧义`);
        } else if (hits[0] === ids[i]) {
          errors.push(`审查任务「${t.title}」不能审查自己`);
        } else {
          reviewOf = hits[0];
          if (!dependsOn.includes(reviewOf)) dependsOn.push(reviewOf);
        }
      }
    } else if (t.review_of && t.review_of.trim()) {
      errors.push(`任务「${t.title}」带了 review_of 但 kind 不是 review(review_of 只能配合 kind="review" 使用)`);
    }

    nodes.push({
      schemaVersion: "2",
      id: ids[i],
      title: t.title.trim(),
      goal: goalText,
      assignedAgentId: assignee.agentId ?? "",
      assignedRole: t.assigned_role,
      dependsOn: [...new Set(dependsOn)],
      expectedArtifacts: artifactsOf[i],
      status: "planned",
      statusHistory: [{ status: "planned", at: now, by: "core" }],
      kind,
      reviewOf,
      attempt: 0,
      visit: 0,
      artifactRefs: [],
      evidenceRefs: [],
      uncertain: false,
    });
  });

  // ② 无环(Kahn)
  const cyclic = findCycleNodes(nodes);
  if (cyclic.length) {
    const names = cyclic.map(id => nodes.find(n => n.id === id)?.title ?? id).join("、");
    errors.push(`任务依赖存在环:${names}`);
  }

  if (errors.length) return { ok: false, errors };

  const graph: TaskGraph = {
    id: `tg-${randomUUID().slice(0, 8)}`,
    missionId: ctx.missionId,
    companyId: ctx.companyId,
    goal: ctx.goal,
    nodes,
    status: "committed",
    createdAt: now,
    updatedAt: now,
    schemaVersion: "2",
    revision: 0,
  };
  return { ok: true, errors: [], graph };
}

export interface DispatchResult {
  ok: boolean;
  runId?: string;
  summary?: string;
  error?: string;
  artifactRefs?: string[];
  evidenceRefs?: string[];
  // A3:节点自己的产出被判定需要返工(如未来接 Quality Gate/A5 的裁决结果);触发下方的返工回边。
  needsRevision?: boolean;
  // A3:审查节点(kind="review")的裁决;非审查节点忽略这个字段。
  verdict?: "accepted" | "needs_revision";
}

// A3:节点最多允许的"执行轮数"(含首次执行)。默认 2 = 首次执行 + 最多 1 次返工重跑;
// 第 2 次仍判 needs_revision 就直接 failed,不会无限重跑。
export const DEFAULT_MAX_REVISION_ROUNDS = 2;

export interface ExecuteGraphDeps {
  // 真实实现(missionRoutes 接线)= precreateRunTask + orchestrator.startRun(quick + targetAgentId);
  // 单测注入 mock。goal 已拼好依赖节点的产出摘要(审查节点额外拼审查指令,见 REVIEW_NODE_INSTRUCTION)。
  dispatch: (input: { node: TaskNode; goal: string; graph: TaskGraph; signal?: AbortSignal }) => Promise<DispatchResult>;
  // 结构化事件(task_node_started/task_node_finished);真实接线传 eventBus.emit,可省(测试)。
  emit?: (type: "task_node_started" | "task_node_finished", agentId: string | undefined, payload: Record<string, unknown>) => void;
  // 落盘钩子,默认 taskGraphStore.upsertTaskGraph(测试可换)。
  persist?: (root: string, graph: TaskGraph) => void;
  // A3:节点返工最多轮数,默认 DEFAULT_MAX_REVISION_ROUNDS(测试/未来治理分级可覆盖)。
  maxRevisionRounds?: number;
  // 同一批就绪节点的最大并发派发数,缺省不限(整批并发)。真实接线(missionRoutes)必须传 1:
  // orchestrator.startRun 的单 run 互斥对后到的调用是直接抛错而不是排队,并发派发会让同批第二个
  // 节点瞬间失败并污染其下游。
  maxConcurrency?: number;
  /** Stop launching new nodes, drain already-started dispatches, then persist one cancelled terminal state. */
  signal?: AbortSignal;
  /** Execution lease duration. A restart reconciles expired/incomplete leases from receipts. */
  leaseMs?: number;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function clearAttemptState(node: TaskNode): void {
  delete node.runId;
  delete node.resultSummary;
  delete node.error;
  delete node.inputHash;
  delete node.idempotencyKey;
  delete node.leaseOwner;
  delete node.leaseExpiry;
  delete node.startedReceipt;
  delete node.completionReceipt;
  node.artifactRefs = [];
  node.evidenceRefs = [];
  node.uncertain = false;
}

// Wave 3 execution is completion-driven: a completed node is committed immediately
// and may unlock its downstream while unrelated siblings are still running.
export async function executeGraph(projectRoot: string, graph: TaskGraph, deps: ExecuteGraphDeps): Promise<TaskGraph> {
  const persist = deps.persist ?? upsertTaskGraph;
  const maxRounds = deps.maxRevisionRounds ?? DEFAULT_MAX_REVISION_ROUNDS;
  const owner = `task-graph:${process.pid}:${randomUUID()}`;
  const leaseMs = Math.max(1_000, deps.leaseMs ?? 5 * 60_000);
  const touch = () => { graph.updatedAt = new Date().toISOString(); };
  const setStatus = (node: TaskNode, status: TaskNodeStatus) => {
    node.status = status;
    node.statusHistory.push({ status, at: new Date().toISOString(), by: "core" });
    touch();
  };

  // A persisted graph may be resumed after startup reconciliation. Never replace
  // a newer revision with the caller's stale snapshot.
  if (!deps.persist) {
    const stored = getTaskGraph(projectRoot, graph.id);
    const hasForeignActiveLease = stored?.status === "running" && stored.nodes.some(node =>
      !!node.leaseOwner
      && node.leaseOwner !== owner
      && !!node.leaseExpiry
      && Date.parse(node.leaseExpiry) > Date.now());
    if (hasForeignActiveLease) {
      throw new Error(`TaskGraph ${graph.id} is already executing under an active node lease`);
    }
    if (stored && (stored.revision ?? 0) > (graph.revision ?? 0)) {
      Object.assign(graph, structuredClone(stored));
    }
  }
  graph.schemaVersion = "2";
  graph.status = "running";
  touch();
  persist(projectRoot, graph);

  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const isDone = (n: TaskNode) => n.status === "completed" || n.status === "accepted";
  const readyNodes = (inFlight: Set<string>): TaskNode[] =>
    graph.nodes.filter(n =>
      !inFlight.has(n.id)
      && !n.uncertain
      && !n.completionReceipt
      && (n.status === "planned" || n.status === "pending")
      && n.dependsOn.every(d => {
        const dep = byId.get(d);
        return !!dep && isDone(dep);
      }));

  const buildGoal = (node: TaskNode): string => {
    const depContext = node.dependsOn
      .map(d => byId.get(d))
      .filter((d): d is TaskNode => !!d)
      .map(d => JSON.stringify({
        nodeId: d.id,
        title: d.title,
        runId: d.runId,
        expectedArtifacts: d.expectedArtifacts,
        artifactRefs: d.artifactRefs ?? [],
        evidenceRefs: d.evidenceRefs ?? [],
        completionReceiptId: d.completionReceipt?.receiptId,
        resultHash: d.completionReceipt?.resultHash,
        summary: d.resultSummary?.slice(0, 800),
      }));
    let base = depContext.length
      ? `${node.goal}\n\n## 依赖任务合同(先核对真实文件/产物/证据引用,摘要仅供定位)\n${depContext.join("\n")}`
      : node.goal;
    if ((node.revisionCount ?? 0) > 0 && node.revisionFeedback) {
      base += `\n\n## 上一轮审查否决理由(本次是返工重跑,请针对性修复后再交付)\n${node.revisionFeedback.slice(0, 800)}`;
    }
    return node.kind === "review" ? `${base}${REVIEW_NODE_INSTRUCTION}` : base;
  };

  // 失败传染:依赖失败节点(直接或传递)的未执行节点全部 blocked;只污染下游,无关独立分支不受影响。
  const taintDownstream = (failedId: string) => {
    const tainted = new Set<string>([failedId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of graph.nodes) {
        if (tainted.has(n.id) || (n.status !== "planned" && n.status !== "pending")) continue;
        if (n.dependsOn.some(d => tainted.has(d))) {
          tainted.add(n.id);
          setStatus(n, "blocked");
          grew = true;
        }
      }
    }
  };

  // 审查否决吊销:被审节点返工时,已经消费其被拒产出跑完的下游(直接或传递)全部回 pending 重跑,
  // 否则图会带着基于被否决产物的结果"成功"收敛。不扣被吊销节点的返工预算(不是它的产出被否决);
  // 未跑的 planned/pending 下游不用动(重跑后自然拿到新摘要)。
  const revokeDoneDownstream = (rootId: string) => {
    const tainted = new Set<string>([rootId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of graph.nodes) {
        if (tainted.has(n.id) || !n.dependsOn.some(d => tainted.has(d))) continue;
        tainted.add(n.id);
        grew = true;
        if (isDone(n) || n.status === "running") {
          setStatus(n, "pending");
          clearAttemptState(n);
        }
      }
    }
  };

  // 返工回边:revisionCount 递增;未超预算 → needs_revision(history)紧跟着悄悄转 pending(不进 history,
  // 下一轮 setStatus(...,"running") 自然接上,statusHistory 上就是 needs_revision→running);
  // 超预算 → failed。返回 true = 已重新排队等下一轮重跑。
  const requestRevision = (node: TaskNode): boolean => {
    const count = (node.revisionCount ?? 0) + 1;
    node.revisionCount = count;
    if (count >= maxRounds) {
      clearAttemptState(node);
      node.error = `超过最大返工轮次(${maxRounds})`;
      setStatus(node, "failed");
      return false;
    }
    setStatus(node, "needs_revision");
    clearAttemptState(node);
    node.status = "pending";
    return true;
  };

  const emitFinished = (node: TaskNode, extra?: Record<string, unknown>) => {
    deps.emit?.("task_node_finished", node.assignedAgentId, {
      taskGraphId: graph.id, missionId: graph.missionId, nodeId: node.id, title: node.title,
      status: node.status, runId: node.runId, error: node.error, ...extra,
    });
  };

  interface SettledAttempt {
    nodeId: string;
    leaseOwner: string;
    idempotencyKey: string;
    inputHash: string;
    result: DispatchResult;
  }
  const inFlight = new Map<string, Promise<SettledAttempt>>();
  const renewalTimers = new Map<string, ReturnType<typeof setInterval>>();
  const leaseLostNodes = new Set<string>();
  let ownershipLost = false;
  const usesDefaultStore = !deps.persist;
  const concurrency = Math.max(1, deps.maxConcurrency ?? graph.nodes.length);

  const startNode = (node: TaskNode): void => {
    clearAttemptState(node);
    const goal = buildGoal(node);
    const inputHash = hashValue({
      goal,
      expectedArtifacts: node.expectedArtifacts,
      dependencies: node.dependsOn.map(id => {
        const dep = byId.get(id);
        return {
          id,
          completion: dep?.completionReceipt?.receiptId,
          resultHash: dep?.completionReceipt?.resultHash,
          artifacts: dep?.artifactRefs ?? [],
          evidence: dep?.evidenceRefs ?? [],
        };
      }),
    });
    let attempt: number;
    let visit: number;
    let idempotencyKey: string;
    if (usesDefaultStore) {
      const claimed = claimTaskNodeLease(projectRoot, graph.id, node.id, {
        owner, leaseMs, inputHash, sideEffectRisk: node.expectedArtifacts.length > 0,
      });
      if (!claimed.claimed || !claimed.node) {
        ownershipLost = true;
        leaseLostNodes.add(node.id);
        return;
      }
      Object.assign(node, claimed.node);
      graph.revision = claimed.graph.revision;
      graph.status = claimed.graph.status;
      graph.updatedAt = claimed.graph.updatedAt;
      attempt = node.attempt ?? 0;
      visit = node.visit ?? 0;
      idempotencyKey = node.idempotencyKey ?? "";
    } else {
      const at = new Date().toISOString();
      attempt = (node.attempt ?? 0) + 1;
      visit = (node.visit ?? 0) + 1;
      idempotencyKey = `${graph.id}:${node.id}:${attempt}:${inputHash}`;
      node.schemaVersion = "2";
      node.attempt = attempt;
      node.visit = visit;
      node.inputHash = inputHash;
      node.idempotencyKey = idempotencyKey;
      node.leaseOwner = owner;
      node.leaseExpiry = new Date(Date.parse(at) + leaseMs).toISOString();
      node.startedReceipt = {
        receiptId: randomUUID(), at, attempt, visit, inputHash, idempotencyKey,
        leaseOwner: owner, sideEffectRisk: node.expectedArtifacts.length > 0,
      };
      setStatus(node, "running");
      persist(projectRoot, graph);
    }
    deps.emit?.("task_node_started", node.assignedAgentId, {
      taskGraphId: graph.id, missionId: graph.missionId, nodeId: node.id, title: node.title,
      attempt, visit, inputHash, idempotencyKey,
    });
    const dispatched = Promise.resolve()
      .then(() => deps.dispatch({ node: structuredClone(node), goal, graph: structuredClone(graph), signal: deps.signal }))
      .then(
        result => ({ nodeId: node.id, leaseOwner: owner, idempotencyKey, inputHash, result }),
        (error: any) => ({
          nodeId: node.id,
          leaseOwner: owner,
          idempotencyKey,
          inputHash,
          result: { ok: false, error: error?.message ?? String(error) },
        }),
      );
    inFlight.set(node.id, dispatched);
    if (usesDefaultStore) {
      const heartbeatMs = Math.max(250, Math.min(30_000, Math.floor(leaseMs / 3)));
      const timer = setInterval(() => {
        try {
          const renewed = renewTaskNodeLease(projectRoot, graph.id, node.id, {
            owner, idempotencyKey, leaseMs,
          });
          if (!renewed.renewed) {
            ownershipLost = true;
            leaseLostNodes.add(node.id);
            clearInterval(timer);
            renewalTimers.delete(node.id);
            return;
          }
          graph.revision = renewed.graph.revision;
          graph.updatedAt = renewed.graph.updatedAt;
          node.leaseExpiry = renewed.node?.leaseExpiry;
        } catch {
          if (Date.parse(node.leaseExpiry ?? "") <= Date.now()) {
            ownershipLost = true;
            leaseLostNodes.add(node.id);
            clearInterval(timer);
            renewalTimers.delete(node.id);
          }
        }
      }, heartbeatMs);
      timer.unref?.();
      renewalTimers.set(node.id, timer);
    }
  };

  const finishReceipt = (node: TaskNode, status: "completed" | "accepted" | "failed" | "cancelled") => {
    const artifactRefs = [...(node.artifactRefs ?? [])];
    const evidenceRefs = [...(node.evidenceRefs ?? [])];
    node.completionReceipt = {
      receiptId: randomUUID(),
      at: new Date().toISOString(),
      attempt: node.attempt ?? 0,
      inputHash: node.inputHash ?? "",
      idempotencyKey: node.idempotencyKey ?? "",
      status,
      resultHash: hashValue({ status, summary: node.resultSummary, error: node.error, artifactRefs, evidenceRefs }),
      runId: node.runId,
      artifactRefs,
      evidenceRefs,
    };
    delete node.leaseOwner;
    delete node.leaseExpiry;
  };

  while (true) {
    if (!deps.signal?.aborted && !ownershipLost) {
      const available = concurrency - inFlight.size;
      for (const node of readyNodes(new Set(inFlight.keys())).slice(0, available)) startNode(node);
    }

    if (inFlight.size === 0) {
      if (ownershipLost) throw new Error(`TaskGraph ${graph.id} lost execution lease ownership`);
      break;
    }
    const settled = await Promise.race(inFlight.values());
    inFlight.delete(settled.nodeId);
    const renewalTimer = renewalTimers.get(settled.nodeId);
    if (renewalTimer) clearInterval(renewalTimer);
    renewalTimers.delete(settled.nodeId);
    const node = byId.get(settled.nodeId);
    if (!node) continue;

    if (ownershipLost || leaseLostNodes.has(settled.nodeId)) continue;

    // A revision may invalidate a still-running downstream attempt. Its late
    // result is drained but cannot overwrite the newer state.
    if (node.leaseOwner !== settled.leaseOwner || node.idempotencyKey !== settled.idempotencyKey) continue;
    const result = settled.result;
    if (result.runId) {
      node.runId = result.runId;
      if (node.startedReceipt) node.startedReceipt.runId = result.runId;
    }
    node.artifactRefs = [...new Set(result.artifactRefs ?? [])];
    node.evidenceRefs = [...new Set(result.evidenceRefs ?? [])];

    if (!result.ok) {
      node.error = (result.error ?? "dispatch failed").slice(0, 500);
      if (deps.signal?.aborted) {
        setStatus(node, "cancelled");
        finishReceipt(node, "cancelled");
      } else {
        setStatus(node, "failed");
        finishReceipt(node, "failed");
        taintDownstream(node.id);
      }
      persist(projectRoot, graph);
      emitFinished(node);
      continue;
    }

    node.resultSummary = (result.summary ?? "").trim().slice(0, 2000) || undefined;
    if (node.kind === "review" && result.verdict) {
      setStatus(node, "completed");
      finishReceipt(node, "completed");
      const target = node.reviewOf ? byId.get(node.reviewOf) : undefined;
      if (result.verdict === "needs_revision" && target && target.status !== "failed") {
        const feedback = node.resultSummary;
        const reworked = requestRevision(target);
        if (reworked) {
          if (feedback) target.revisionFeedback = feedback;
          revokeDoneDownstream(target.id);
        } else {
          taintDownstream(target.id);
        }
      } else if (result.verdict === "accepted" && target && target.status === "completed") {
        setStatus(target, "accepted");
        if (target.completionReceipt) target.completionReceipt.status = "accepted";
      }
      persist(projectRoot, graph);
      emitFinished(node, { verdict: result.verdict });
      continue;
    }

    if (result.needsRevision) {
      const reworked = requestRevision(node);
      if (!reworked) {
        finishReceipt(node, "failed");
        taintDownstream(node.id);
      }
      persist(projectRoot, graph);
      emitFinished(node);
      continue;
    }

    setStatus(node, "completed");
    finishReceipt(node, "completed");
    persist(projectRoot, graph);
    emitFinished(node);
  }

  if (deps.signal?.aborted) {
    for (const node of graph.nodes) {
      if (node.status === "planned" || node.status === "pending") setStatus(node, "cancelled");
    }
    graph.status = "cancelled";
  } else {
    graph.status = graph.nodes.every(isDone) ? "completed" : "failed";
  }
  touch();
  persist(projectRoot, graph);
  return graph;
}

// The reviewer proposes a schema-validated JSON record. Core owns the state
// transition; malformed prose or legacy VERDICT markers fail closed.
export function parseReviewVerdict(summary: string): "accepted" | "needs_revision" {
  return parseReviewNodeProposal(summary)?.verdict ?? "needs_revision";
}

// CEO 结构化提案生成:走 missionBrief 同款 systemModel(creative 档)/modelGateway 路径,不打 agent 引擎。
// 名册注入真实 id/role/name 并排除 ceo(CEO 不给自己派活),提示词要求 assigned_agent_id 从名册选。
export async function generateTaskGraphProposal(
  root: string,
  mission: { id: string; companyId?: string; interpretedGoal: string; originalIdea?: string; successCriteria?: string[]; expectedArtifacts?: string[] },
  agents: SchedulableAgent[],
): Promise<{ proposal: TaskGraphProposal | null; reason?: string; raw: string }> {
  const companyId = mission.companyId ?? "default";
  const roster = agents.filter(a => (a.companyId ?? "default") === companyId && a.enabled !== false && a.role !== "ceo");
  const rosterLines = roster.slice(0, 20)
    .map(a => `- id: ${a.id} | role: ${a.role ?? "?"} | name: ${a.name ?? a.id}`)
    .join("\n");
  const criteria = (mission.successCriteria ?? []).slice(0, 5).map(c => `- ${c}`).join("\n");
  const prompt = `${CEO_TASK_GRAPH_PROMPT}

## Mission
${(mission.interpretedGoal || mission.originalIdea || "").slice(0, 1200)}
${criteria ? `\n成功标准:\n${criteria}` : ""}
${mission.expectedArtifacts?.length ? `预期产出:${mission.expectedArtifacts.slice(0, 5).join("、")}` : ""}

## 员工名册(assigned_agent_id 必须从这里选真实 id;assigned_role 必须是这里存在的 role)
${rosterLines || "(该公司暂无可派发成员)"}`;

  const record = await invokeSystemModel(root, "creative", {
    agentId: "task-graph-ceo",
    messages: [{ role: "user", content: prompt }], maxTokens: 2000, agentRole: "ceo",
  });
  const raw = record.content ?? "";
  const parsed = parseTaskGraphProposal(raw);
  return { ...parsed, raw };
}
