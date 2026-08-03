import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, TraceEvent } from "@opc/shared";
import { deriveArtifactFlights, deriveMemoryPulses, isWithinWindow, channelActiveFresh, CHANNEL_ACTIVE_WINDOW_MS } from "./collabLines.js";

function agent(over: Partial<AgentNodeConfig> & { id: string; role: string }): AgentNodeConfig {
  return {
    name: over.id, parentId: undefined, childrenIds: [], model: "m", provider: "p",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

let seq = 0;
function ev(over: Partial<TraceEvent> & { type: TraceEvent["type"]; timestamp: string }): TraceEvent {
  return { id: `e${++seq}`, runId: over.runId ?? "r1", payload: undefined, ...over } as TraceEvent;
}

const AGENTS: AgentNodeConfig[] = [
  agent({ id: "ceo", role: "ceo", childrenIds: ["lead-1"] }),
  agent({ id: "lead-1", role: "lead", parentId: "ceo", childrenIds: ["dev-1", "dev-2"] }),
  agent({ id: "dev-1", role: "dev", parentId: "lead-1" }),
  agent({ id: "dev-2", role: "dev", parentId: "lead-1" }),
];

describe("deriveArtifactFlights · 硬规则:只有真实 committed agent_message 事件产生线", () => {
  it("agent_message + messageType artifact_handoff + agents:显式收件人 → 一条飞线", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "dev-1", payload: { messageType: "artifact_handoff", audience: "agents:lead-1" } }),
    ];
    const lines = deriveArtifactFlights(events, AGENTS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "dev-1", target: "lead-1" });
  });

  it("channelId 反查通道对端也能产出飞线", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "dev-1", payload: { messageType: "artifact_handoff", channelId: "ch-1" } }),
    ];
    const lines = deriveArtifactFlights(events, AGENTS, [{ id: "ch-1", a: "dev-1", b: "dev-2" }]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ source: "dev-1", target: "dev-2" });
  });

  it("messageType 不是 artifact_handoff → 不产生线", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "dev-1", payload: { messageType: "worker_report", audience: "agents:lead-1" } }),
    ];
    expect(deriveArtifactFlights(events, AGENTS)).toHaveLength(0);
  });

  it("没有 messageType 的旧式消息 → 不产生线(不推测)", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "dev-1", payload: { audience: "agents:lead-1" } }),
    ];
    expect(deriveArtifactFlights(events, AGENTS)).toHaveLength(0);
  });

  it("事件类型不是 agent_message(即便 payload 长得像)→ 不产生线", () => {
    // 防御性用例:证明这里是按 TraceEvent.type 精确匹配,不是只看 payload 形状——
    // 服务端从不会把未 commit 的 A2A 消息包装成别的事件类型广播出来,但函数本身也不该只认 payload。
    const events = [
      ev({ type: "info", timestamp: "t1", agentId: "dev-1", payload: { messageType: "artifact_handoff", audience: "agents:lead-1" } }),
    ];
    expect(deriveArtifactFlights(events, AGENTS)).toHaveLength(0);
  });

  it("target 不在当前 agents 列表(已删除/跨公司)→ 不产生线", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "dev-1", payload: { messageType: "artifact_handoff", audience: "agents:ghost" } }),
    ];
    expect(deriveArtifactFlights(events, AGENTS)).toHaveLength(0);
  });

  it("source 不在当前 agents 列表 → 不产生线", () => {
    const events = [
      ev({ type: "agent_message", timestamp: "t1", agentId: "ghost", payload: { messageType: "artifact_handoff", audience: "agents:lead-1" } }),
    ];
    expect(deriveArtifactFlights(events, AGENTS)).toHaveLength(0);
  });
});

describe("deriveMemoryPulses · 硬规则:只有真实 committed memory_committed 事件产生线", () => {
  it("memory_committed → 一条脉冲,target = 最近的 lead", () => {
    const events = [ev({ type: "memory_committed", timestamp: "t1", agentId: "dev-1", payload: { scope: "team" } })];
    const pulses = deriveMemoryPulses(events, AGENTS);
    expect(pulses).toHaveLength(1);
    expect(pulses[0]).toMatchObject({ source: "dev-1", target: "lead-1" });
  });

  it("lead 自己沉淀经验 → target = ceo", () => {
    const events = [ev({ type: "memory_committed", timestamp: "t1", agentId: "lead-1", payload: {} })];
    const pulses = deriveMemoryPulses(events, AGENTS);
    expect(pulses[0]).toMatchObject({ source: "lead-1", target: "ceo" });
  });

  it("CEO 自己沉淀经验 → 无上级,target 为 null(不画线)", () => {
    const events = [ev({ type: "memory_committed", timestamp: "t1", agentId: "ceo", payload: {} })];
    const pulses = deriveMemoryPulses(events, AGENTS);
    expect(pulses[0]).toMatchObject({ source: "ceo", target: null });
  });

  it("proposal 相关但未 committed 的事件类型(lesson_proposed/memory_proposal_rejected)→ 不产生线", () => {
    const events = [
      ev({ type: "lesson_proposed", timestamp: "t1", agentId: "dev-1", payload: {} }),
      ev({ type: "memory_proposal_rejected", timestamp: "t2", agentId: "dev-1", payload: {} }),
    ];
    expect(deriveMemoryPulses(events, AGENTS)).toHaveLength(0);
  });

  it("agentId 不在当前 agents 列表 → 不产生线", () => {
    const events = [ev({ type: "memory_committed", timestamp: "t1", agentId: "ghost", payload: {} })];
    expect(deriveMemoryPulses(events, AGENTS)).toHaveLength(0);
  });
});

describe("isWithinWindow", () => {
  it("时间戳在窗口内 → true", () => {
    expect(isWithinWindow("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:05.000Z"), 8000)).toBe(true);
  });
  it("时间戳超出窗口 → false", () => {
    expect(isWithinWindow("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:00:20.000Z"), 8000)).toBe(false);
  });
  it("非法时间戳 → false", () => {
    expect(isWithinWindow("not-a-date", Date.now(), 8000)).toBe(false);
  });
  // #2 回归约束:调用方(OrgPage)的 now 是粗粒度 tick 的 state,SSE 事件到达时事件时间戳常比 now 新。
  // 拒绝"未来"会让 tick 后 <1s 内落地的事件永远不画、其余最多迟 (tick-1)s 才起飞——未来须视为刚发生。
  it("比 now 新的\"未来\"时间戳(SSE 先于 now tick 到达)→ true", () => {
    expect(isWithinWindow("2026-01-01T00:00:09.500Z", Date.parse("2026-01-01T00:00:00.000Z"), 8000)).toBe(true);
  });
});

describe("channelActiveFresh · 「正在交流」按 lastActiveAt 新鲜度判定(#10)", () => {
  const now = Date.parse("2026-01-01T00:00:30.000Z");
  it("status=active 且 lastActiveAt 在窗口内 → 亮", () => {
    expect(channelActiveFresh({ status: "active", lastActiveAt: "2026-01-01T00:00:25.000Z" }, now)).toBe(true);
  });
  it("status=active 但 lastActiveAt 超窗(静默通道/上一个 run 的残留)→ 熄灭", () => {
    expect(channelActiveFresh({ status: "active", lastActiveAt: "2026-01-01T00:00:10.000Z" }, now)).toBe(false);
  });
  it("status=active 但无 lastActiveAt(老数据/旧服务端)→ 保守不亮", () => {
    expect(channelActiveFresh({ status: "active" }, now)).toBe(false);
  });
  it("status 非 active → 不亮(即便 lastActiveAt 很新)", () => {
    expect(channelActiveFresh({ status: "open", lastActiveAt: "2026-01-01T00:00:29.000Z" }, now)).toBe(false);
  });
  it("lastActiveAt 非法时间戳 → 不亮", () => {
    expect(channelActiveFresh({ status: "active", lastActiveAt: "not-a-date" }, now)).toBe(false);
  });
  it("窗口须大于前端轮询/时钟 tick 粒度(10s)", () => {
    expect(CHANNEL_ACTIVE_WINDOW_MS).toBeGreaterThanOrEqual(10000);
  });
});
