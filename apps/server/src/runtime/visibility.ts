import type { AgentMessage, AgentNodeConfig, MessageAudience, VisibilityPolicy } from "@opc/shared";

// The information-isolation engine. Pure functions over the org tree + per-message audience:
// the orchestrator records every inter-agent message with an audience, then feeds each agent only
// the messages visibleTo() it. This is what makes team in/out isolation and games work
// (狼人杀: night messages audience=agents:<wolves> stay invisible to villagers; 主持人 is omniscient).

type AgentLite = Pick<AgentNodeConfig, "id" | "role" | "parentId">;

function indexById(agents: AgentLite[]): Map<string, AgentLite> {
  return new Map(agents.map((a) => [a.id, a]));
}

// The id that defines an agent's team: its nearest lead/ceo ancestor (a lead/ceo is its own team
// root). A worker with no lead ancestor is a singleton team (its own id).
export function teamOf(agentId: string, agents: AgentLite[]): string {
  const m = indexById(agents);
  let cur = m.get(agentId);
  let guard = 0;
  while (cur && guard++ < 64) {
    if (cur.role === "lead" || cur.role === "ceo") return cur.id;
    cur = cur.parentId ? m.get(cur.parentId) : undefined;
  }
  return agentId;
}

// Is `ancestorId` at or above `agentId` in the org tree?
export function isAncestorOf(ancestorId: string, agentId: string, agents: AgentLite[]): boolean {
  const m = indexById(agents);
  let cur: AgentLite | undefined = m.get(agentId);
  let guard = 0;
  while (cur && guard++ < 64) {
    if (cur.id === ancestorId) return true;
    cur = cur.parentId ? m.get(cur.parentId) : undefined;
  }
  return false;
}

export interface VisibilityOpts {
  // Viewers that see every message regardless of audience — the game host (主持人) or an
  // oversight CEO. Defaults to none.
  omniscient?: string[];
}

// Can `viewerId` see `msg`? Pure decision from the message audience + org structure.
export function visibleTo(viewerId: string, msg: AgentMessage, agents: AgentLite[], opts: VisibilityOpts = {}): boolean {
  if (viewerId === msg.from) return true;                     // author always sees own
  if (opts.omniscient && opts.omniscient.includes(viewerId)) return true; // host / oversight
  const aud = msg.visibility.audience;
  if (aud === "all") return true;
  if (aud === "private") return false;                        // author-only (handled above)
  if (aud === "team") {
    return teamOf(viewerId, agents) === teamOf(msg.from, agents) || isAncestorOf(viewerId, msg.from, agents);
  }
  if (aud === "lead-only") {
    return isAncestorOf(viewerId, msg.from, agents);          // only the chain of leads/CEO above
  }
  if (aud.startsWith("role:")) {
    const role = aud.slice("role:".length);
    return indexById(agents).get(viewerId)?.role === role;
  }
  if (aud.startsWith("agents:")) {
    const ids = aud.slice("agents:".length).split(",").map((s) => s.trim()).filter(Boolean);
    return ids.includes(viewerId);
  }
  return false; // unknown audience → deny (fail closed)
}

export function filterVisible(viewerId: string, msgs: AgentMessage[], agents: AgentLite[], opts?: VisibilityOpts): AgentMessage[] {
  return msgs.filter((m) => visibleTo(viewerId, m, agents, opts));
}

// Write-side: the default audience for a message authored under a team policy when the caller
// doesn't set one explicitly.
//   default  → team (teammates + lead see each other)
//   isolated → workers report up only (lead-only); leads/ceo broadcast to their team
//   game     → private (game messages MUST set an explicit audience; the host stays omniscient)
export function defaultAudienceFor(policy: VisibilityPolicy, author: AgentLite): MessageAudience {
  switch (policy) {
    case "isolated":
      return author.role === "lead" || author.role === "ceo" ? "team" : "lead-only";
    case "game":
      return "private";
    case "default":
    default:
      return "team";
  }
}
