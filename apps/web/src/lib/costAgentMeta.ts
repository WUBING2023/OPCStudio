// Cost page · agent identity helpers — derive a role bucket / color / display name from a
// raw agentId (e.g. "rp-primary", "tester-4-a70e01", "backend-engineer") when the current org
// roster (GET /agents) doesn't have it (agent belonged to a past run, may since be gone).
// Reuses the shared role palette from lib/agentMeta.ts and only supplements the buckets that
// palette doesn't cover (research/writer/review/pm show up a lot in real cost.json agentIds).
import { ROLE_COLORS } from "./agentMeta.js";

export type CostRole =
  | "ceo" | "lead" | "architect" | "security" | "test" | "ops" | "dev"
  | "review" | "writer" | "research" | "pm" | "other";

const EXTRA_ROLE_COLORS: Record<string, string> = {
  review: "#06b6d4",
  writer: "#ec4899",
  research: "#3b82f6",
  pm: "#84cc16",
};

// Muted, evenly-spaced fallback palette for agentIds that don't match any known role keyword —
// hashed so the same agentId always gets the same color instead of a flat neutral gray.
const HASH_PALETTE = ["#a78bfa", "#fb7185", "#34d399", "#fbbf24", "#60a5fa", "#f472b6", "#4ade80", "#94a3b8"];

function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return HASH_PALETTE[h % HASH_PALETTE.length];
}

// Ordered buckets: more specific/management roles win over the generic "dev" catch-all when an
// agentId segment could plausibly match more than one (e.g. "review-lead" → lead, not review).
const BUCKETS: Array<[CostRole, string[]]> = [
  ["ceo", ["ceo"]],
  ["lead", ["lead", "manager", "mgr"]],
  ["architect", ["architect", "arch"]],
  ["security", ["security", "sec"]],
  ["test", ["test", "tester", "qa"]],
  ["ops", ["ops", "devops", "deploy"]],
  ["review", ["review", "reviewer"]],
  ["writer", ["writer", "spec", "doc", "writing"]],
  ["research", ["research", "researcher", "analyst", "data"]],
  ["pm", ["pm", "product"]],
  ["dev", ["dev", "developer", "engineer", "backend", "frontend", "worker", "code"]],
];

export function roleOfAgentId(id: string): CostRole {
  const segs = id.toLowerCase().split(/[-_]/).filter(Boolean);
  for (const [role, words] of BUCKETS) {
    if (segs.some(s => words.includes(s) || words.some(w => s.startsWith(w)))) return role;
  }
  return "other";
}

export function colorForRole(role: string, fallbackId: string): string {
  return ROLE_COLORS[role] ?? EXTRA_ROLE_COLORS[role] ?? hashColor(fallbackId);
}

// Strip ephemeral hash/id suffixes ("-a70e01") and title-case the rest so a bare agentId reads
// like a name when the roster doesn't know it. Not perfect, but honest: real names win when known.
const ACRONYMS: Record<string, string> = { ceo: "CEO", pm: "PM", qa: "QA" };
export function prettifyAgentId(id: string): string {
  if (!id || id === "unknown") return id || "?";
  const words = id
    .split(/[-_]/)
    .filter(Boolean)
    .filter(w => !/^[0-9a-f]{5,}$/i.test(w)); // drop ephemeral hex suffixes
  if (!words.length) return id;
  return words
    .map(w => ACRONYMS[w.toLowerCase()] ?? (/^\d+$/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

export interface AgentDisplay { name: string; role: CostRole; color: string; initial: string }

const KNOWN_ROLES = new Set<string>(BUCKETS.map(([role]) => role));

export function agentDisplay(id: string, roster?: Map<string, { name: string; role: string }>): AgentDisplay {
  const known = roster?.get(id);
  // Only trust the roster's role string when it's one of our recognized buckets (i18n has a
  // cost.role.<x> string for each) — anything exotic falls back to the agentId heuristic instead
  // of leaking a raw untranslated role string into the UI.
  const role: CostRole = (known?.role && KNOWN_ROLES.has(known.role) ? known.role as CostRole : null) ?? roleOfAgentId(id);
  const name = (known?.name && known.name.trim()) || prettifyAgentId(id);
  const color = colorForRole(role, id);
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return { name, role, color, initial };
}
