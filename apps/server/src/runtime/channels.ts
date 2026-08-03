import type { A2AChannelSpec, Channel, ChannelKind, ChannelRequest } from "@opc/shared";

// v5 通信编排引擎：run 级通道注册表。决定"谁能与谁通信"——lead 协调 worker↔worker、
// CEO 协调 lead↔lead、worker 申请→lead 批准开通道。与 visibility 引擎互补：
// visibility 管"谁能看到广播消息"，channel 管"点对点定向通信是否被授权开通"。
export class ChannelRegistry {
  private channels: Channel[] = [];
  private requests: ChannelRequest[] = [];
  private seq = 0;
  constructor(private runId?: string) {}

  private id(prefix: string): string {
    return `${prefix}-${this.runId ? this.runId.slice(0, 6) + "-" : ""}${++this.seq}`;
  }

  // 直接开通道（协调者主动开：lead 给 worker 派活、CEO 让多 lead 协同）。
  open(a: string, b: string, kind: ChannelKind, coordinatedBy?: string, reason?: string, ts?: string, direction: "oneway" | "bidirectional" = "bidirectional"): Channel {
    const existing = this.findCompatible(a, b, kind, direction);
    if (existing) { if (existing.status === "closed") existing.status = "open"; return existing; }
    const ch: Channel = {
      id: this.id("ch"), runId: this.runId, a, b, kind, direction, status: "open",
      coordinatedBy, reason, openedAt: ts ?? new Date().toISOString(),
    };
    this.channels.push(ch);
    return ch;
  }

  // worker 主动申请与某人开通道（待协调者批准）。
  request(from: string, to: string, kind: ChannelKind, reason: string, ts?: string, direction: "oneway" | "bidirectional" = "bidirectional", authPolicy?: "gated" | "manual"): ChannelRequest {
    const req: ChannelRequest = {
      id: this.id("req"), runId: this.runId, from, to, kind, direction, authPolicy, reason,
      status: "pending", createdAt: ts ?? new Date().toISOString(),
    };
    this.requests.push(req);
    return req;
  }

  // 协调者批准申请 → 开通道。
  grant(requestId: string, decidedBy: string, ts?: string): Channel | null {
    const req = this.requests.find(r => r.id === requestId);
    if (!req || req.status !== "pending") return null;
    req.status = "granted";
    req.decidedBy = decidedBy;
    const ch = this.open(req.from, req.to, req.kind, decidedBy, req.reason, ts, req.direction ?? "bidirectional");
    ch.requestedBy = req.from;
    return ch;
  }

  deny(requestId: string, decidedBy: string): boolean {
    const req = this.requests.find(r => r.id === requestId);
    if (!req || req.status !== "pending") return false;
    req.status = "denied";
    req.decidedBy = decidedBy;
    return true;
  }

  // 置 active 时同步刷新 lastActiveAt(recordMessage/recordA2A 每条经通道的消息都会调这里)——
  // status 本身不自动衰减,前端「正在交流」流光按 lastActiveAt 的新鲜度判定。
  setActive(id: string, active: boolean, ts?: string): void {
    const ch = this.channels.find(c => c.id === id);
    if (ch && ch.status !== "closed") {
      ch.status = active ? "active" : "open";
      if (active) ch.lastActiveAt = ts ?? new Date().toISOString();
    }
  }

  close(id: string): void {
    const ch = this.channels.find(c => c.id === id);
    if (ch) ch.status = "closed";
  }

  // a,b 之间是否有可用（open/active）通道（无向）。
  canCommunicate(a: string, b: string): boolean {
    return this.channels.some(c =>
      (c.status === "open" || c.status === "active") &&
      this.allows(c, a, b));
  }

  between(a: string, b: string, kind?: ChannelKind): Channel | undefined {
    return this.channels.find(c =>
      (kind ? c.kind === kind : true) &&
      this.allows(c, a, b));
  }

  private allows(channel: Channel, from: string, to: string): boolean {
    if (channel.a === from && channel.b === to) return true;
    return (channel.direction ?? "bidirectional") === "bidirectional" && channel.a === to && channel.b === from;
  }

  private findCompatible(a: string, b: string, kind: ChannelKind, direction: "oneway" | "bidirectional"): Channel | undefined {
    return this.channels.find((c) => {
      if (c.kind !== kind) return false;
      if ((c.direction ?? "bidirectional") === "bidirectional") {
        return (c.a === a && c.b === b) || (c.a === b && c.b === a);
      }
      if (direction === "bidirectional") return false;
      return c.a === a && c.b === b;
    });
  }

  list(): Channel[] { return [...this.channels]; }
  listRequests(): ChannelRequest[] { return [...this.requests]; }
  pendingRequests(): ChannelRequest[] { return this.requests.filter(r => r.status === "pending"); }
}

export interface PresetChannelApplyResult {
  opened: Channel[];
  requested: ChannelRequest[];
  skipped: Array<{ spec: A2AChannelSpec; reason: "disabled" | "missing-agent" }>;
}

// Materialize the company-level A2A contract for a run. Trusted channels open immediately;
// gated/manual channels remain pending until the existing governance endpoint grants them.
export function applyPresetChannels(
  registry: ChannelRegistry,
  specs: A2AChannelSpec[],
  agentIds: Set<string>,
): PresetChannelApplyResult {
  const result: PresetChannelApplyResult = { opened: [], requested: [], skipped: [] };
  for (const spec of specs) {
    if (spec.enabled === false) {
      result.skipped.push({ spec, reason: "disabled" });
      continue;
    }
    if (!agentIds.has(spec.from) || !agentIds.has(spec.to)) {
      result.skipped.push({ spec, reason: "missing-agent" });
      continue;
    }
    const direction = spec.direction ?? "oneway";
    const authPolicy = spec.authPolicy ?? "trusted";
    if (authPolicy === "trusted") {
      result.opened.push(registry.open(spec.from, spec.to, "a2a", "template-preset", spec.purpose, undefined, direction));
    } else {
      result.requested.push(registry.request(
        spec.from,
        spec.to,
        "a2a",
        `[template-preset:${authPolicy}] ${spec.purpose ?? "preset A2A channel"}`,
        undefined,
        direction,
        authPolicy,
      ));
    }
  }
  return result;
}
