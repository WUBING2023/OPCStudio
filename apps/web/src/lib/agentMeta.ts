// Single source of truth for agent status/role colors + labels, shared by the org
// graph (OrgPage) and the details panel (AgentDetailsPanel) so they never drift.

// Status colors — 用户定调语义(muted 保质感):空闲=绿(健康随时可用)/工作=橙(忙)/
// 报错=红/失联·禁用=黑(近黑,深浅两主题都可见,靠 hairline 环兜底)。
// AgentStatus 11 态:新 4 态是 working/waiting 窗口内的细粒度真状态(后端真实分支 emit,非前端模拟),
// 色彩语义不新增保留色相——忙碌细分(thinking/using_tool/reviewing)沿用工作橙,waiting_review 沿用等待琥珀。
export const STATUS_COLORS: Record<string, string> = {
  idle: "#3fae67",
  working: "#c98f52",
  waiting: "#c99a52",
  disabled: "#1c1c22",
  failed: "#c9615c",
  done: "#3fae67",
  restricted: "#1c1c22",
  offline: "#1c1c22",
  thinking: "#c98f52",
  using_tool: "#c98f52",
  reviewing: "#c98f52",
  waiting_review: "#c99a52",
};

// 兜底中文 label(i18n 词典是首选:render 点经 statusLabel() 走 org.status.* key,11 语言全量)。
export const STATUS_LABELS: Record<string, string> = {
  idle: "空闲",
  working: "工作中",
  waiting: "等待中",
  disabled: "已禁用",
  failed: "失败",
  done: "完成",
  restricted: "受限",
  thinking: "思考中",
  using_tool: "调用工具中",
  reviewing: "审查中",
  waiting_review: "等待审查",
};

// 状态 label 统一出口:已知状态走 i18n(org.status.<status>,11 语言全量),未知状态原样显示——
// 与旧 `STATUS_LABELS[s] || s` 的兜底语义一致,只是把文案交给词典。
export function statusLabel(tr: (key: string) => string, status: string): string {
  return STATUS_LABELS[status] ? tr(`org.status.${status}`) : status;
}

// Role colors — restrained palette: ceo keeps the app's one accent (used sparingly, single node);
// every other role is a desaturated/muted variant of its old hue (~S60→S35, pulled toward a common
// mid-tone) so role color reads as a quiet identity cue at the avatar only, never competing with the
// three reserved status hues (green/amber/red) or the accent. Same hue family as before, just quieter.
export const ROLE_COLORS: Record<string, string> = {
  ceo: "#5e6ad2",
  lead: "#957bc1",
  dev: "#5bae7a",
  test: "#bc9b62",
  security: "#c37979",
  ops: "#b67c5d",
  architect: "#4d9d97",
};

export const ROLE_LABELS: Record<string, string> = {
  ceo: "CEO",
  lead: "主管",
  dev: "开发",
  test: "测试",
  security: "安全",
  ops: "运维",
  architect: "架构师",
};

// Token neutral gray (ink-subtle) for fallbacks — never Tailwind's cool gray.
export const NEUTRAL_GRAY = "#6f6f78";

// A node is "active" (non-neutral) when not idle/disabled — used to tint its ring.
export function isActiveStatus(status: string): boolean {
  return status === "working" || status === "waiting" || status === "failed" || isBusyStatus(status) || status === "waiting_review";
}

// "正在干活"的忙碌子集(working + 11 态细分)。工作动画(节点脉冲/飞线/气泡)统一用它判定,
// 保证细粒度新态不把既有"working 才亮"的动画断掉。与 @opc/shared 的 BUSY_AGENT_STATUSES 同口径。
export function isBusyStatus(status: string | undefined): boolean {
  return status === "working" || status === "thinking" || status === "using_tool" || status === "reviewing";
}
