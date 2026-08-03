import { Bot } from "lucide-react";
import { useAgentStore } from "../../store/useAgentStore.js";
import { ROLE_COLORS, NEUTRAL_GRAY } from "../../lib/agentMeta.js";

// 参与者头像组——角色色 + 首字母，最多显示 N 个 + "+n"。id → 名字/角色查 useAgentStore(全局已加载)，
// agent 若已被删除(软删)则退化为按 agentId 前缀猜角色/取首字。系统级事件(无 agentId)用 Bot 图标兜底。

// ROLE_COLORS(agentMeta.ts)只覆盖组织画布常见的 7 个角色；任务档案里出现的角色更杂(pm/security_reviewer/
// code_reviewer 等，见 .opc/agents.json 实例)，未命中时按角色名哈希落到一个固定调色板，保证同角色颜色稳定
// 且不至于全灰一片。
const FALLBACK_PALETTE = ["#5e6ad2", "#7c3aed", "#3fae67", "#c99a52", "#c9615c", "#b67c5d", "#0d9488", "#6b9fc4", "#b87a96"];
const ROLE_ALIAS: Record<string, string> = {
  security_reviewer: ROLE_COLORS.security,
  code_reviewer: "#6b9fc4",
  reviewer: "#6b9fc4",
  pm: "#b87a96",
  tester: ROLE_COLORS.test,
};
function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export function roleColor(role: string | undefined): string {
  if (!role) return NEUTRAL_GRAY;
  if (ROLE_COLORS[role]) return ROLE_COLORS[role];
  if (ROLE_ALIAS[role]) return ROLE_ALIAS[role];
  return FALLBACK_PALETTE[hashStr(role) % FALLBACK_PALETTE.length];
}
function initialFor(name: string | undefined, role: string | undefined, id: string): string {
  const src = (name && name.trim()) || role || id;
  return src.trim().charAt(0).toUpperCase() || "?";
}
// agentId 形如 "lead-1-a70e01" / "rma-ceo" —— 取第一个连字符前的片段做角色猜测兜底。
function guessRole(id: string): string {
  return id.split("-")[0] || id;
}

export function AgentAvatar({ agentId, size = 22 }: { agentId: string; size?: number }) {
  const agent = useAgentStore(s => s.agents.find(a => a.id === agentId));
  const role = agent?.role ?? guessRole(agentId);
  const color = roleColor(role);
  const label = initialFor(agent?.name, role, agentId);
  const title = agent?.name ? `${agent.name} · ${role}` : `${agentId} · ${role}`;
  return (
    <div
      title={title}
      className="rounded-full flex items-center justify-center font-semibold shrink-0 select-none"
      style={{
        width: size, height: size, fontSize: Math.max(9, size * 0.42),
        color, background: `color-mix(in srgb, ${color} 20%, var(--color-surface-1))`,
        border: `1px solid color-mix(in srgb, ${color} 45%, transparent)`,
      }}
    >
      {label}
    </div>
  );
}

// 系统级时间线节点(run_started/run_finished 等无 agentId)的兜底头像。
export function SystemAvatar({ size = 22 }: { size?: number }) {
  return (
    <div
      title="OPC"
      className="rounded-full flex items-center justify-center shrink-0"
      style={{
        width: size, height: size,
        color: "var(--color-ink-subtle)", background: "var(--color-surface-2)",
        border: "1px solid var(--color-hairline)",
      }}
    >
      <Bot size={Math.max(10, size * 0.55)} />
    </div>
  );
}

export function AvatarStack({ agentIds, max = 4, size = 22 }: { agentIds: string[]; max?: number; size?: number }) {
  const shown = agentIds.slice(0, max);
  const rest = agentIds.length - shown.length;
  if (agentIds.length === 0) return null;
  return (
    <div className="flex items-center">
      {shown.map((id, i) => (
        <div key={id} className="rounded-full ring-2 ring-bg-card" style={{ marginLeft: i === 0 ? 0 : -6, zIndex: shown.length - i }}>
          <AgentAvatar agentId={id} size={size} />
        </div>
      ))}
      {rest > 0 && (
        <div
          className="rounded-full ring-2 ring-bg-card bg-surface-2 text-ink-subtle font-semibold flex items-center justify-center shrink-0"
          style={{ marginLeft: -6, width: size, height: size, fontSize: Math.max(8, size * 0.4) }}
        >
          +{rest}
        </div>
      )}
    </div>
  );
}
