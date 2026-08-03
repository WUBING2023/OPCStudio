export type IncubatorMode = "worker" | "squad" | "team";

export interface NormalizedIncubatorMember {
  id: string;
  name: string;
  role: string;
  persona?: string;
  reportsToId?: string;
}

export interface NormalizedVerificationEdge {
  producerId: string;
  verifierId: string;
  method: "llm-review" | "code-review" | "fact-check";
  onReject: "redo";
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const METHODS = new Set<NormalizedVerificationEdge["method"]>(["llm-review", "code-review", "fact-check"]);

function memberId(raw: unknown, role: string, index: number, used: Set<string>): string {
  const requested = typeof raw === "string" && SAFE_ID.test(raw.trim()) ? raw.trim() : "";
  const base = requested || `${role || "member"}-${index + 1}`;
  let id = base;
  let suffix = 2;
  while (used.has(id)) id = `${base}-${suffix++}`;
  used.add(id);
  return id;
}

function resolveMemberRef(raw: unknown, members: NormalizedIncubatorMember[]): NormalizedIncubatorMember | undefined {
  const ref = typeof raw === "string" ? raw.trim() : "";
  if (!ref) return undefined;
  return members.find((member) => member.id === ref)
    ?? members.find((member) => member.name === ref)
    ?? members.find((member) => member.role === ref);
}

export function normalizeIncubatorDesign(mode: IncubatorMode, input: unknown): Record<string, unknown> {
  const raw = input && typeof input === "object" ? input as Record<string, any> : {};
  if (mode === "worker") return { ...raw };

  const rawMembers = Array.isArray(raw.members) ? raw.members.slice(0, mode === "squad" ? 4 : 7) : [];
  const used = new Set<string>();
  const members: NormalizedIncubatorMember[] = rawMembers.map((item: any, index: number) => {
    const role = typeof item?.role === "string" && item.role.trim() ? item.role.trim() : "dev";
    return {
      id: memberId(item?.id, role, index, used),
      name: String(item?.name || role || `成员 ${index + 1}`).slice(0, 40),
      role,
      ...(item?.persona ? { persona: String(item.persona).slice(0, 4000) } : {}),
    };
  });

  if (mode === "team") {
    const ceo = members.find((member) => member.role === "ceo");
    const lead = members.find((member) => member.role === "lead");
    for (const member of members) {
      if (member === ceo) continue;
      member.reportsToId = member === lead ? ceo?.id : (lead?.id ?? ceo?.id);
    }
  }

  const edges: NormalizedVerificationEdge[] = [];
  const seenEdges = new Set<string>();
  const rawEdges = Array.isArray(raw.verificationEdges) ? raw.verificationEdges : [];
  for (const edge of rawEdges) {
    const producer = resolveMemberRef(edge?.producerId ?? edge?.producer, members);
    const verifier = resolveMemberRef(edge?.verifierId ?? edge?.verifier, members);
    if (!producer || !verifier || producer.id === verifier.id) continue;
    const method = METHODS.has(edge?.method) ? edge.method as NormalizedVerificationEdge["method"] : "llm-review";
    const key = `${producer.id}>${verifier.id}:${method}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push({ producerId: producer.id, verifierId: verifier.id, method, onReject: "redo" });
    if (edges.length >= 3) break;
  }

  return {
    ...raw,
    members,
    verificationEdges: edges,
  };
}