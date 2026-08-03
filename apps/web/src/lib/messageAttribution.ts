// 消息流溯源 + 员工可交互的纯逻辑契约(无 React/无 IO,可单测)。
// A) 溯源:系统消息可带 attributedTo(产出者归属),渲染时显示产出者身份而非无主的"系统"。
// B) 可交互:发送者名/头像凡能对应到真实 agent(isRealAgent 判定)即可点击进入其单聊;
//    纯文本角色名(无 agentId 或查无此人)不做假链接。
// 组件(MessageBubble/BriefingPanel/ChatThread)据此决定头像色/显示名/是否可点,逻辑集中一处便于测。

export interface MessageAttribution {
  /** 产出者对应的真实 agent id;缺省 = 无法对应到真人,则名字不可点。 */
  agentId?: string;
  name: string;
  /** 角色(ceo/lead/dev/…)——驱动头像色。 */
  role?: string;
}

export interface AttributableEntry {
  variant: "user" | "agent" | "system";
  name: string;
  role?: string;
  /** 该气泡发送者对应的真实 agent id(agent 类消息用于可点)。 */
  agentId?: string;
  /** 系统消息的产出者归属(如"由 Leader 拆解的方案派发失败")。 */
  attributedTo?: MessageAttribution;
}

export interface ResolvedBubbleIdentity {
  /** 最终显示的发送者名(归属系统消息 = 产出者名,否则 = 原 name)。 */
  displayName: string;
  /** 最终头像色所依据的角色(归属系统消息 = 产出者角色)。 */
  displayRole?: string;
  /** 是否为"带归属的系统消息"——渲染时加"系统"小标以区分真·聊天消息。 */
  systemTag: boolean;
  /** 头像/名字可点 → 打开该 agent 单聊;undefined = 不可点(纯文本,不做假链接)。 */
  linkAgentId?: string;
}

// 从 decomposer(Leader,没有则 CEO 兜底)构造归属对象。undefined 透传(拆解失败时没有 decomposer)。
export function attributionFromDecomposer(
  decomposer: { agentId?: string; name: string; role: "lead" | "ceo" } | undefined,
): MessageAttribution | undefined {
  if (!decomposer || !decomposer.name) return undefined;
  return { agentId: decomposer.agentId, name: decomposer.name, role: decomposer.role };
}

// 单条消息 → 最终身份 + 可点落点。isRealAgent:该 agentId 是否为花名册里的真实成员。
export function resolveBubbleIdentity(
  entry: AttributableEntry,
  isRealAgent: (id: string) => boolean,
): ResolvedBubbleIdentity {
  // 带归属的系统消息:溯源到产出者,显示其名/角色色,可点则进其单聊,并加"系统"小标。
  if (entry.variant === "system" && entry.attributedTo && entry.attributedTo.name) {
    const a = entry.attributedTo;
    const link = a.agentId && isRealAgent(a.agentId) ? a.agentId : undefined;
    return { displayName: a.name, displayRole: a.role, systemTag: true, linkAgentId: link };
  }
  // 用户自己的消息与真·系统消息:不可点。
  if (entry.variant !== "agent") {
    return { displayName: entry.name, displayRole: entry.role, systemTag: false };
  }
  // agent 发言:发送者能对应到真实成员即可点进其单聊。
  const link = entry.agentId && isRealAgent(entry.agentId) ? entry.agentId : undefined;
  return { displayName: entry.name, displayRole: entry.role, systemTag: false, linkAgentId: link };
}
