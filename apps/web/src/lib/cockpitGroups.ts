import type { AgentNodeConfig, TraceEvent } from "@opc/shared";

// Track C · C3 工作台项目群:群组划分 + 群消息流聚合的纯函数(无 IO/无 React,可单测)。
// 心智模型见重构指南 10.3/15.3:微信群 + 任务看板——全公司群/部门群里按时间合并
// "每 agent 聊天消息 + run 级事件(run_started/run_finished/review_committed)"。

export const DEFAULT_COMPANY = "default";

// 部门群 = 一个 lead 的子树(嵌套 lead 自成一个部门,不重复计入上级部门)。
export interface TeamGroup {
  leadId: string;
  leadName: string;
  companyId: string;
  memberIds: string[]; // lead 本人 + 子树内非 lead 成员
}

// 工作台左栏"群组"选中态。label 在构造处(AgentRail,那里有公司名)拼好,消费方直接展示。
export type GroupSelection =
  | { kind: "company"; companyId: string; label: string }
  | { kind: "team"; companyId: string; leadId: string; label: string };

export function sameGroup(a: GroupSelection | null, b: GroupSelection | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.companyId !== b.companyId) return false;
  return a.kind === "company" || (b.kind === "team" && a.leadId === b.leadId);
}

// 从现有组织数据(parentId/childrenIds 双向取并集,谁陈旧都不断链)推导部门群。
// 环安全:visited 守卫;嵌套 lead 在遍历到时停(它开自己的组,不进上级 memberIds)。
export function groupAgentsByTeam(agents: AgentNodeConfig[]): TeamGroup[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const children = new Map<string, Set<string>>();
  const addChild = (p: string, c: string) => {
    if (p === c || !byId.has(p) || !byId.has(c)) return;
    let s = children.get(p);
    if (!s) { s = new Set(); children.set(p, s); }
    s.add(c);
  };
  for (const a of agents) {
    if (a.parentId) addChild(a.parentId, a.id);
    for (const c of a.childrenIds ?? []) addChild(a.id, c);
  }
  const groups: TeamGroup[] = [];
  for (const lead of agents) {
    if (lead.role !== "lead") continue;
    const memberIds: string[] = [lead.id];
    const visited = new Set<string>([lead.id]);
    const queue = [...(children.get(lead.id) ?? [])];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const a = byId.get(id);
      if (!a || a.role === "lead") continue; // 嵌套 lead → 自己的部门群
      memberIds.push(id);
      for (const c of children.get(id) ?? []) queue.push(c);
    }
    groups.push({ leadId: lead.id, leadName: lead.name, companyId: lead.companyId || DEFAULT_COMPANY, memberIds });
  }
  groups.sort((a, b) => a.companyId.localeCompare(b.companyId) || a.leadName.localeCompare(b.leadName) || a.leadId.localeCompare(b.leadId));
  return groups;
}

export function companyMemberIds(agents: AgentNodeConfig[], companyId: string): Set<string> {
  const s = new Set<string>();
  for (const a of agents) if ((a.companyId || DEFAULT_COMPANY) === companyId) s.add(a.id);
  return s;
}

// 选中群的成员 id 集。全公司群额外包含 "ceo" 伪会话 id——工作台 CEO 会话的本地消息
// (useCockpitStore.LocalMsg)历史上以 agentId:"ceo" 归属,不带真实 CEO agent id。
export function scopeMemberIds(sel: GroupSelection, agents: AgentNodeConfig[], teams: TeamGroup[]): Set<string> {
  if (sel.kind === "company") {
    const s = companyMemberIds(agents, sel.companyId);
    s.add("ceo");
    return s;
  }
  const g = teams.find((t) => t.leadId === sel.leadId);
  return new Set(g ? g.memberIds : [sel.leadId]);
}

// ── CEO 记忆引用溯源:项目群消息卡的引用条数据 ────────────────────────────────
// 服务端 memory_pack_used 事件 payload 带 citedMemories:[{id,title}](注入即引用)。这里是纯读取/
// 归一(过滤掉缺 id/title 的脏项),供 ChatThread 渲染可点击引用条。本地声明形状,不跨包引 server 类型。
export interface CitedMemory { id: string; title: string }

export function readCitedMemories(payload: unknown): CitedMemory[] {
  const raw = (payload as { citedMemories?: unknown } | null | undefined)?.citedMemories;
  if (!Array.isArray(raw)) return [];
  const out: CitedMemory[] = [];
  for (const c of raw) {
    const id = (c as { id?: unknown })?.id;
    const title = (c as { title?: unknown })?.title;
    if (typeof id === "string" && id && typeof title === "string" && title) out.push({ id, title });
  }
  return out;
}

// ── 群消息流聚合 ──────────────────────────────────────────────────────────────

// 与 1:1 ChatThread 相同的"对话类事件"集合(info 无 message 的注入元数据不进对话)。
export const GROUP_CHAT_TYPES = new Set(["agent_message", "info", "error"]);

export interface LocalMsgLike { agentId: string; ts: string }

export type GroupTimelineItem<L extends LocalMsgLike> =
  | { kind: "local"; ts: string; m: L }
  | { kind: "chat"; ts: string; e: TraceEvent }
  | { kind: "run_started"; ts: string; e: TraceEvent }
  | { kind: "run_finished"; ts: string; e: TraceEvent }
  | { kind: "review"; ts: string; e: TraceEvent };

export interface MergeTimelineOpts {
  scope: Set<string>;      // 群成员 agent id(scopeMemberIds 的产物)
  scopeCompanyId: string;  // 群所属公司
  // runId → 该 run 的 companyId;undefined = 无法判定(索引未取到/旧 run),按 BriefingPanel
  // companyIdOfEvent 同一规则**保留**,只有确定归属其他公司才剔除。
  runCompanyOf?: (runId: string) => string | undefined;
}

// 聚合规则(只认真实数据,不造字段):
// - 聊天类事件:发出者(e.agentId)在群成员集内才进流;
// - review_committed:verifier(e.agentId)或被审 producer(payload.agentId)任一在群内即进流;
// - run_started/run_finished:run 级事件(无 agentId),按 run 的 companyId 归群;同一 runId 的
//   同类型事件去重(orchestrator 历史补录 + live emit 是两条不同 id 的事件,内容同义);
// - 本地消息:归属会话 agentId 在群内才进流。全部按时间戳升序稳定排序。
export function mergeGroupTimeline<L extends LocalMsgLike>(
  events: TraceEvent[],
  locals: L[],
  opts: MergeTimelineOpts,
): GroupTimelineItem<L>[] {
  const out: GroupTimelineItem<L>[] = [];
  const seenRunEvent = new Set<string>();
  for (const e of events) {
    if (GROUP_CHAT_TYPES.has(e.type)) {
      if (!e.agentId || !opts.scope.has(e.agentId)) continue;
      const p = e.payload as { message?: unknown } | undefined;
      if (e.type === "info" && !p?.message) continue;
      out.push({ kind: "chat", ts: e.timestamp, e });
      continue;
    }
    if (e.type === "review_committed") {
      const producer = (e.payload as { agentId?: string } | undefined)?.agentId;
      if ((e.agentId && opts.scope.has(e.agentId)) || (producer && opts.scope.has(producer))) {
        out.push({ kind: "review", ts: e.timestamp, e });
      }
      continue;
    }
    if (e.type === "run_started" || e.type === "run_finished") {
      const runCo = opts.runCompanyOf?.(e.runId);
      if (runCo !== undefined && runCo !== opts.scopeCompanyId) continue;
      const key = `${e.type}:${e.runId}`;
      if (seenRunEvent.has(key)) continue;
      seenRunEvent.add(key);
      out.push({ kind: e.type, ts: e.timestamp, e });
    }
  }
  for (const m of locals) {
    if (opts.scope.has(m.agentId)) out.push({ kind: "local", ts: m.ts, m });
  }
  return out.sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
}
