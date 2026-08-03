// C6 · 协作线三线型(补在 OrgPage 现有三态 liveActive/workerActive/requested 之外)——
// artifact 飞线(产物交接) + 经验紫线(记忆沉淀)的纯派生函数。失败红闪不在这里:它直接复用
// AgentNodeConfig.status === "failed"(既有字段,见 OrgPage.tsx 的 styleEdgeFor/AgentNode/CeoNode),
// 不需要额外的事件流派生。
//
// ── 硬规则(7月6日重构指南 §6 C6 + §9.2 合流点表)────────────────────────────────────────
// "UI 协作线动画只能由 committed 状态的 A2A event 驱动;proposal/validated 阶段的消息、以及任何
// 前端模拟/推测状态,一律不得触发动画。" 本模块的唯一输入 `events: TraceEvent[]` 就是
// OrgPage 从 useAgentStore(s => s.events) 读到的那个数组,它只有两个来源(见 apps/web/src/App.tsx
// 的 EventSource("/api/events") 与 useAgentStore.addEvent/mergeRunHistory):
//   ① 后端 SSE 实时广播 —— apps/server/src/runtime/orchestrator.ts 的 recordMessage()/recordA2A()
//      在调用 emit("agent_message", ...) 之前,必定已经跑完 a2aBus.propose→validate→commit
//      (见 a2aBus.ts 的 A2ABus.commit());任何一步失败(如 canCommunicate 校验不过)都会走
//      a2aBus.reject() 分支直接 return,根本不会调 emit()。也就是说前端永远收不到
//      proposed/validated/rejected 阶段的 "agent_message" 事件 —— 这条门槛在服务端源头,不在这里。
//      (全仓 emit("agent_message") 只存在于 recordMessage/recordA2A 两处;曾绕过生命周期的
//      通道申请裸 emit——a2aRequestChannel/setChannelRequestHandler——已收敛进 recordMessage。)
//      "memory_committed" 同理,是记忆提案被批准生效那一刻才 emit 的 committed 事件,pending 提案
//      从未经这条 SSE 通道广播。**当前真实覆盖面(经验紫线因此只在这个范围内亮)**:仅
//      orchestrator.ts 的 run_conclusion 低风险自动批准分支 emit("memory_committed", {agentId}) 一处。
//      memoryRoutes.ts 的人工审批端点当前不 emit,runCritic.ts 的失败反思主通路 emit 的是
//      "lesson_committed"(payload 只带 role、无 agentId,画不出定位到具体节点的线,故本模块不匹配它)。
//      要扩大紫线覆盖(人工批准/失败反思也亮线),需先让那些 emit 点带上 agentId——属后续增强,
//      非本模块能单方面补齐;现状"只画得出 run_conclusion 自动批准这一类"是如实反映数据源,不是造假。
//   ② /api/runs/:id/events 回放的历史事件 —— 同一份服务端落盘记录(events.jsonl),不是前端合成。
// 因此本模块不需要、也没有字段可以再判一次"是否 committed"——数据源头已经只吐 committed 及以后的
// 状态。这里要做的只是"按 type/messageType 精确匹配,挑出三类线的真实事件",绝不额外推测/合成任何
// 状态;挑不出真实事件就不产出对应的线(拿不到就不画,不许前端造假)。
import type { AgentNodeConfig, TraceEvent } from "@opc/shared";

export interface ArtifactFlightLine {
  id: string;
  source: string;
  target: string;
  ts: string;
  eventId: string;
}

export interface MemoryPulseLine {
  id: string;
  source: string;
  target: string | null; // null = 找不到该员工的上级(lead/ceo)链——不画线,只在节点侧提示(见调用方)
  ts: string;
  eventId: string;
}

// 收件人推导:与 OrgPage.liveMessagePairs 同款(agents:显式收件人 / channelId 反查通道对端 /
// lead-only 顺 parentId 链找最近的 lead|ceo)。独立成小函数,不依赖 OrgPage 的其余状态,便于纯测试。
function resolveTargets(
  payload: { audience?: string; channelId?: string } | undefined,
  fromId: string,
  byId: Map<string, AgentNodeConfig>,
  chById: Map<string, { a: string; b: string }>,
): string[] {
  const targets = new Set<string>();
  const ch = payload?.channelId ? chById.get(payload.channelId) : undefined;
  if (ch) targets.add(ch.a === fromId ? ch.b : ch.a);
  const aud = payload?.audience ?? "";
  if (aud.startsWith("agents:")) {
    for (const id of aud.slice(7).split(",")) { if (id) targets.add(id); }
  } else if (aud === "lead-only") {
    const t = nearestLeadOrCeo(fromId, byId);
    if (t) targets.add(t);
  }
  return [...targets];
}

// 顺 parentId 链走到最近的 lead/ceo 祖先(汇报对象)——找不到返回 null(如本人已是顶层且无 lead 祖先)。
function nearestLeadOrCeo(id: string, byId: Map<string, AgentNodeConfig>): string | null {
  let cur = byId.get(id)?.parentId ? byId.get(byId.get(id)!.parentId!) : undefined;
  let guard = 0;
  while (cur && guard++ < 20) {
    if (cur.role === "lead" || cur.role === "ceo") return cur.id;
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return null;
}

// artifact 飞线:只认 type === "agent_message" 且 payload.messageType === "artifact_handoff" 的事件
// (A4 · recordA2A 在 performative:"share" 或带 artifactRefs 的 "inform" 时推断出这个 messageType,
// 见 apps/server/src/runtime/a2aBus.ts 的 inferMessageType)。source/target 必须都是当前公司在场的
// agent,否则丢弃(公司切换/agent 已删除时不画一条指向虚空的线)。
export function deriveArtifactFlights(
  events: TraceEvent[],
  agents: AgentNodeConfig[],
  channels: { id: string; a: string; b: string }[] = [],
): ArtifactFlightLine[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const present = new Set(agents.map((a) => a.id));
  const chById = new Map(channels.map((c) => [c.id, c]));
  const out: ArtifactFlightLine[] = [];
  for (const e of events) {
    if (e.type !== "agent_message" || !e.agentId || !present.has(e.agentId)) continue;
    const p = e.payload as { messageType?: string; audience?: string; channelId?: string } | undefined;
    if (p?.messageType !== "artifact_handoff") continue;
    for (const target of resolveTargets(p, e.agentId, byId, chById)) {
      if (target === e.agentId || !present.has(target)) continue;
      out.push({ id: `${e.id}-${target}`, source: e.agentId, target, ts: e.timestamp, eventId: e.id });
    }
  }
  return out;
}

// 经验紫线:只认 type === "memory_committed" 的事件(记忆提案被批准生效那一刻 emit,当前仅
// orchestrator.ts 的 run_conclusion 自动批准分支一处——见文件顶部注释①对覆盖面的完整说明)。
// target = 该员工最近的 lead/ceo(经验沉淀"上报"给团队/公司);
// 找不到上级(如本人就是 CEO)则 target 为 null——调用方据此只在源节点做提示,不画线。
export function deriveMemoryPulses(events: TraceEvent[], agents: AgentNodeConfig[]): MemoryPulseLine[] {
  const byId = new Map(agents.map((a) => [a.id, a]));
  const present = new Set(agents.map((a) => a.id));
  const out: MemoryPulseLine[] = [];
  for (const e of events) {
    if (e.type !== "memory_committed" || !e.agentId || !present.has(e.agentId)) continue;
    out.push({ id: e.id, source: e.agentId, target: nearestLeadOrCeo(e.agentId, byId), ts: e.timestamp, eventId: e.id });
  }
  return out;
}

// 飞线/脉冲是"刚刚发生"的短暂动画,不是永久状态——按事件时间戳 + 当前时刻判断是否还在展示窗口内。
// 比 now 新的"未来"时间戳视为刚发生(在窗口内):调用方的 now 是粗粒度 tick 的 state,SSE 事件
// 到达时它常落后于事件时间戳——拒绝未来会让刚到的事件一根线都画不出来(最多迟一个 tick 才出现)。
export function isWithinWindow(ts: string, now: number, windowMs: number): boolean {
  const t = Date.parse(ts);
  return Number.isFinite(t) && now - t <= windowMs;
}

// 「正在交流」流光的新鲜度判定:服务端 Channel.status 一旦 active 就不再自行衰减(registry 只在
// 下个 run 重建),不能直接当"进行时"渲染——按 lastActiveAt(消息经过通道时服务端刷新,见
// channels.ts setActive)距 now ≤ 窗口判定,run 结束/通道静默后流光自动熄灭;老数据/旧服务端
// 没有该字段时保守不亮(宁可不画,不画假动画)。
export const CHANNEL_ACTIVE_WINDOW_MS = 10000;
export function channelActiveFresh(c: { status: string; lastActiveAt?: string }, now: number): boolean {
  if (c.status !== "active" || !c.lastActiveAt) return false;
  const t = Date.parse(c.lastActiveAt);
  return Number.isFinite(t) && now - t <= CHANNEL_ACTIVE_WINDOW_MS;
}
