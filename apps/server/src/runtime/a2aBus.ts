import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AgentMessage,
  Artifact,
  A2ALifecycleState,
  A2AMessageType,
  A2AStatusEntry,
  Performative,
} from "@opc/shared";

// A2A 传输:进程内、run 级的 per-agent 收件箱(inbox)。这是「真投递」的唯一新部件——
// 与 eventBus(仅 UI 观测)严格分离:定向消息正文只进 inbox,绝不经 SSE 广播(防可见性泄漏)。
// 授权由 ChannelRegistry.canCommunicate 把门、收件人由 visibility 解析,本类只管投递与取用。
//
// ── A4 · 消息生命周期(硬规则)─────────────────────────────────────────────────────
// committed 是消息进入「正式 timeline」的唯一门槛。下游一切消费方(UI 协作动画/项目群
// 消息卡/run story/a2a_messages.jsonl 落盘)只认 committed 及之后的状态(delivered/
// acknowledged/resolved);proposed/validated/rejected 阶段的消息对任何下游不可见,
// 也绝不投递进 inbox。deliver() 对已纳入生命周期的消息强制执行该门槛。
// 旧消息(无 lifecycle 字段)按老语义直接投递——增量兼容,不破坏既有调用点。

// 生命周期状态机:每个状态的合法后继。rejected/resolved 为终态。
export const A2A_LIFECYCLE_TRANSITIONS: Readonly<Record<A2ALifecycleState, readonly A2ALifecycleState[]>> = {
  proposed: ["validated", "rejected"],
  validated: ["committed", "rejected"],
  committed: ["delivered"],
  delivered: ["acknowledged", "resolved"],
  acknowledged: ["resolved"],
  rejected: [],
  resolved: [],
};

// committed 及之后的每次状态推进都会触发落盘 sink(快照追加;读取侧 last-wins 合并)。
const SINK_STATES = new Set<A2ALifecycleState>(["committed", "delivered", "acknowledged", "resolved"]);

export type A2ACommitSink = (msg: AgentMessage) => void;

export class A2ABus {
  private inbox = new Map<string, AgentMessage[]>();
  // 已进入生命周期的消息索引(id → 消息),供 ack/resolve 按 id 推进。run 级内存,clear() 重置。
  private tracked = new Map<string, AgentMessage>();

  // onCommitted:committed 及之后的每次推进回调一次(orchestrator 在 run 开始时接
  // a2a_messages.jsonl 落盘)。best-effort:sink 抛错不影响消息流转。
  constructor(private opts?: { onCommitted?: A2ACommitSink }) {}

  // ── 生命周期推进(私有统一入口:非法转移一律拒绝,返回 false)──────────────────────
  private advance(msg: AgentMessage, next: A2ALifecycleState, by?: string, note?: string): boolean {
    const cur = msg.lifecycle;
    if (!cur) return false; // 未 propose 的消息不能推进
    if (!(A2A_LIFECYCLE_TRANSITIONS[cur] ?? []).includes(next)) return false;
    msg.lifecycle = next;
    const entry: A2AStatusEntry = { state: next, at: new Date().toISOString(), ...(by ? { by } : {}), ...(note ? { note } : {}) };
    (msg.statusHistory ??= []).push(entry);
    if (SINK_STATES.has(next)) {
      try { this.opts?.onCommitted?.(msg); } catch { /* best-effort:落盘失败不影响消息流转 */ }
    }
    return true;
  }

  // agent 提出一条消息(Agent can propose)。幂等:已在生命周期中的消息原样返回。
  propose(msg: AgentMessage): AgentMessage {
    if (msg.lifecycle) return msg;
    msg.lifecycle = "proposed";
    (msg.statusHistory ??= []).push({ state: "proposed", at: new Date().toISOString(), by: msg.from });
    this.tracked.set(msg.id, msg);
    return msg;
  }

  // Core 确定性校验通过(canCommunicate/收件人存在等在调用侧完成,这里记录裁决)。
  validate(msg: AgentMessage, note?: string): boolean {
    return this.advance(msg, "validated", "core", note);
  }

  // 校验失败 → rejected(终态,永不进入 timeline、不投递、不落盘)。
  reject(msg: AgentMessage, reason?: string): boolean {
    return this.advance(msg, "rejected", "core", reason);
  }

  // Studio Core commits:收进正式 timeline 的唯一门槛;此刻触发落盘 sink。
  commit(msg: AgentMessage): boolean {
    return this.advance(msg, "committed", "core");
  }

  // 便捷路径:调用侧已完成确定性校验的直投消息(如 orchestrator 的契约消息),
  // 一次推进 proposed→validated→committed→delivered。commit 失败则不投递。
  commitAndDeliver(msg: AgentMessage, recipients: string[]): boolean {
    this.propose(msg);
    if (!this.validate(msg)) return false;
    if (!this.commit(msg)) return false;
    this.deliver(msg, recipients);
    return true;
  }

  // 把一条消息投进每个收件人的待处理队列(同一条消息对象被多个 inbox 引用,只读取不可变)。
  // 硬规则:已纳入生命周期的消息必须处于 committed(或已 delivered 的追加投递)才可进 inbox。
  deliver(msg: AgentMessage, recipients: string[]): void {
    if (msg.lifecycle) {
      if (msg.lifecycle !== "committed" && msg.lifecycle !== "delivered") return; // 未过 committed 门槛,拒投
      if (msg.lifecycle === "committed") this.advance(msg, "delivered", "core");
    }
    for (const r of recipients) {
      const box = this.inbox.get(r);
      if (box) box.push(msg);
      else this.inbox.set(r, [msg]);
    }
  }

  // 取出并清空某 agent 的待处理消息(执行前 drain,注入其输入)。
  // A4:消费即回执——drain 把 delivered 的消息推进为 acknowledged(by = 消费方)。
  drain(agentId: string): AgentMessage[] {
    const box = this.inbox.get(agentId);
    if (!box || box.length === 0) return [];
    this.inbox.set(agentId, []);
    for (const m of box) {
      if (m.lifecycle === "delivered") this.advance(m, "acknowledged", agentId);
      // 多收件人消息:第一个消费者已推进为 acknowledged,后续 drain 不重复推进(advance 自拒)。
    }
    return box;
  }

  // 显式回执(API /api/a2a/ack 或消费方调用):delivered → acknowledged。
  // fail-closed:带显式收件人(to)的消息只有收件人能 ack;无 to 的广播消息不限制(收件人由 audience 派生)。
  acknowledge(messageId: string, by: string): boolean {
    const m = this.tracked.get(messageId);
    if (!m) return false;
    if (m.to?.length && !m.to.includes(by)) return false;
    return this.advance(m, "acknowledged", by);
  }

  // 闭环(API /api/a2a/resolve):delivered/acknowledged → resolved(终态)。
  // fail-closed:只有消息参与者(发送方或显式收件人)能闭环。
  resolve(messageId: string, by: string): boolean {
    const m = this.tracked.get(messageId);
    if (!m) return false;
    if (m.from !== by && !(m.to?.includes(by) ?? false)) return false;
    return this.advance(m, "resolved", by);
  }

  // 按 id 取已纳入生命周期的消息(ack/resolve 路由查状态用)。
  get(messageId: string): AgentMessage | undefined {
    return this.tracked.get(messageId);
  }

  // 只看不消费(供 list_my_inbox 自省)。
  peek(agentId: string): AgentMessage[] {
    return [...(this.inbox.get(agentId) ?? [])];
  }

  // 全局待处理总数(调试/观测)。
  pending(): number {
    let n = 0;
    for (const box of this.inbox.values()) n += box.length;
    return n;
  }

  // 全部已纳入生命周期的消息(run 收尾闭环审计用:统计必需闭环集的 resolved/未 resolved)。
  // 只读快照,不含 rejected 前从未 propose 的裸消息(未 propose 的不进 tracked)。
  listTracked(): AgentMessage[] {
    return [...this.tracked.values()];
  }

  clear(): void {
    this.inbox.clear();
    this.tracked.clear();
  }
}

// ── A4 · messageType 保守推断 ───────────────────────────────────────────────────
// 现有调用点不传 messageType 时按 performative+上下文给保守映射;推断不出就留空,不硬编。
// (派工/汇报/审查等明确语义由 orchestrator 调用点显式传值,不走推断。)
export function inferMessageType(input: { performative?: Performative; artifactRefs?: string[] }): A2AMessageType | undefined {
  if (input.performative === "share") return "artifact_handoff"; // 主动分享产出物 = 产物交接
  if (input.performative === "inform" && (input.artifactRefs?.length ?? 0) > 0) return "artifact_handoff"; // 带产物引用的通知
  return undefined; // ask/reply/request/propose… 语义不明,留空
}

// ── A4 · committed 消息落盘(.opc/runs/<runId>/a2a_messages.jsonl)────────────────
// B1(runtimeContract)同风格:显式 utf-8、best-effort try/catch,写失败绝不影响 run。
// 每条到达 committed 的消息追加一条快照;之后 delivered/acknowledged/resolved 的推进
// 各再追加一条同 id 快照(读取侧用 latestA2ARecords last-wins 合并出最终态)。

export interface A2AMessageRecord {
  id: string;
  runId?: string;
  from: string;
  to?: string[];
  performative?: string;
  messageType?: A2AMessageType;
  lifecycle: A2ALifecycleState;
  statusHistory: A2AStatusEntry[];
  text: string;        // 摘要截断(≤300 字符),全文不落盘防泄漏/膨胀
  artifactId?: string; // 首个 artifactRef
  channelId?: string;
  timestamp: string;
  // D3 · 派单可观测:消息携带的记忆引用(诚实来源见 types.AgentMessage.citedMemories)透传落盘,
  // 让 a2a_messages.jsonl 可审计"这次派单参考了哪些经验"。加性可选,旧记录合法。
  citedMemories?: Array<{ id: string; title: string }>;
}

const RECORD_TEXT_MAX = 300;

export function buildA2AMessageRecord(msg: AgentMessage): A2AMessageRecord {
  return {
    id: msg.id,
    ...(msg.runId ? { runId: msg.runId } : {}),
    from: msg.from,
    ...(msg.to?.length ? { to: [...msg.to] } : {}),
    ...(msg.performative ? { performative: msg.performative } : {}),
    ...(msg.messageType ? { messageType: msg.messageType } : {}),
    lifecycle: msg.lifecycle ?? "committed",
    statusHistory: [...(msg.statusHistory ?? [])],
    text: (msg.text ?? "").slice(0, RECORD_TEXT_MAX),
    ...(msg.artifactRefs?.length ? { artifactId: msg.artifactRefs[0] } : {}),
    ...(msg.channelId ? { channelId: msg.channelId } : {}),
    timestamp: msg.timestamp,
    ...(msg.citedMemories?.length ? { citedMemories: msg.citedMemories.map((c) => ({ id: c.id, title: c.title })) } : {}),
  };
}

function runDir(projectRoot: string, runId: string): string {
  return path.join(projectRoot, ".opc", "runs", runId);
}

export function appendA2AMessageRecord(projectRoot: string, runId: string, record: A2AMessageRecord): void {
  try {
    const dir = runDir(projectRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "a2a_messages.jsonl"), JSON.stringify(record) + "\n", "utf-8");
  } catch { /* best-effort:落盘失败不影响 run */ }
}

export function readA2AMessageRecords(projectRoot: string, runId: string): A2AMessageRecord[] {
  try {
    const file = path.join(runDir(projectRoot, runId), "a2a_messages.jsonl");
    if (!fs.existsSync(file)) return [];
    const out: A2AMessageRecord[] = [];
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as A2AMessageRecord); } catch { /* 坏行跳过,不拖垮整读 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// 同一消息的多条快照按出现顺序 last-wins 合并,得到每条消息的最终状态(回放/审计用)。
export function latestA2ARecords(records: A2AMessageRecord[]): A2AMessageRecord[] {
  const byId = new Map<string, A2AMessageRecord>();
  for (const r of records) byId.set(r.id, r);
  return [...byId.values()];
}

// ── D4 · A2A resolved 闭环审计(codex 问题5:0 resolved)────────────────────────────
// 「必需闭环集」= 带明确契约语义且有显式收件人(to)的点对点消息:派单(delegate_task)、返工
// (revision_request)、产物交接(artifact_handoff)。广播消息(无 to)与其它语义类型不入必需集——
// 它们没有"下游必须确认消费"的契约含义,强算未闭环会制造虚假风险。resolve 只在真实消费点由
// orchestrator 打(评审 accept/合成消费/报告生成),这里只做事后统计,不推进任何状态。
export const A2A_REQUIRED_CLOSURE_TYPES: ReadonlySet<A2AMessageType> = new Set<A2AMessageType>([
  "delegate_task",
  "revision_request",
  "artifact_handoff",
]);

export interface A2AClosureReport {
  required: number;      // 必需闭环消息总数
  resolved: number;      // 其中已 resolved 的条数
  unresolvedIds: string[]; // 未 resolved 的消息 id(截断,默认 ≤20)
}

// 纯函数:从 tracked 快照统计必需闭环集的 resolved/未 resolved。向后兼容:无 messageType/无 to 的
// 旧消息天然不入必需集,历史 run 判定结果为 required=0(不误标未闭环)。
export function computeA2AClosure(tracked: AgentMessage[], maxUnresolvedIds = 20): A2AClosureReport {
  const required = tracked.filter(
    (m) => m.messageType != null && A2A_REQUIRED_CLOSURE_TYPES.has(m.messageType) && (m.to?.length ?? 0) > 0,
  );
  const unresolved = required.filter((m) => m.lifecycle !== "resolved");
  return {
    required: required.length,
    resolved: required.length - unresolved.length,
    unresolvedIds: unresolved.slice(0, maxUnresolvedIds).map((m) => m.id),
  };
}

// A2A 产出物存储:run 级、claim-check。worker 产出(FileChange/报告/文本)存这里得一个 id,
// 消息只携带 artifactId 引用(不内联大文档),收件人按需取——控 token、可审计。
export class ArtifactStore {
  private items = new Map<string, Artifact>();
  private seq = 0;
  constructor(private runId?: string) {}

  // 存入一个产出物(不带 id),生成确定性 id 返回(seq+runId 前 6 位,单 run 内唯一)。
  put(a: Omit<Artifact, "id">): string {
    const id = `art-${(this.runId ?? "x").slice(0, 6)}-${++this.seq}`;
    this.items.set(id, { ...a, id });
    return id;
  }

  get(id: string): Artifact | undefined {
    return this.items.get(id);
  }

  list(): Artifact[] {
    return [...this.items.values()];
  }

  clear(): void {
    this.items.clear();
    this.seq = 0;
  }
}
