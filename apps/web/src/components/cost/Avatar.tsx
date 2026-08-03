import { agentDisplay } from "../../lib/costAgentMeta.js";

// Role-colored initial avatar — single source of visual identity for an agentId across the
// cost page (hero cards / staff ranking / task bill participant groups) so the same agent
// always renders the same color+initial no matter which section it shows up in.
export function Avatar({
  agentId, roster, size = 24, ring = false,
}: {
  agentId: string;
  roster?: Map<string, { name: string; role: string }>;
  size?: number;
  ring?: boolean;
}) {
  const { color, initial, name } = agentDisplay(agentId, roster);
  return (
    <div
      title={name}
      className={`shrink-0 rounded-full flex items-center justify-center font-semibold text-white select-none ${ring ? "ring-2 ring-surface-1" : ""}`}
      style={{ width: size, height: size, background: color, fontSize: Math.max(9, size * 0.42) }}
    >
      {initial}
    </div>
  );
}

// Stacked overlapping avatar group with a "+n" overflow chip — for a run's participant list.
export function AvatarGroup({
  agentIds, roster, max = 4, size = 22,
}: {
  agentIds: string[];
  roster?: Map<string, { name: string; role: string }>;
  max?: number;
  size?: number;
}) {
  const shown = agentIds.slice(0, max);
  const rest = agentIds.length - shown.length;
  return (
    <div className="flex items-center" style={{ paddingRight: rest > 0 ? 4 : 0 }}>
      {shown.map((id, i) => (
        <div key={id + i} style={{ marginLeft: i === 0 ? 0 : -size * 0.32 }}>
          <Avatar agentId={id} roster={roster} size={size} ring />
        </div>
      ))}
      {rest > 0 && (
        <div
          className="shrink-0 rounded-full flex items-center justify-center font-semibold text-ink-muted bg-surface-2 ring-2 ring-surface-1 select-none"
          style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38), marginLeft: -size * 0.32 }}
        >
          +{rest}
        </div>
      )}
    </div>
  );
}
