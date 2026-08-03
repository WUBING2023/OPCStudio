import { describe, it, expect, beforeEach } from "vitest";
import type { AgentNodeConfig, TraceEvent } from "@opc/shared";
import { useAgentStore } from "./useAgentStore.js";

// #1 回归约束:run 进行期间组织图/简报栏的全部实时状态视觉(工作脉冲/活动气泡/绿色流光/失败红闪)
// 依赖 addEvent 把 agent_status_changed 实时合并进 agents;而历史回放(mergeRunHistory)绝不回写
// agents——否则陈年 run 的状态会覆盖当前真实状态。

function agent(over: Partial<AgentNodeConfig> & { id: string }): AgentNodeConfig {
  return {
    name: over.id, role: "dev", childrenIds: [], model: "m", provider: "p",
    status: "idle", tokenUsage: { prompt: 0, completion: 0, total: 0 }, costUsd: 0,
    editable: true, deletable: true, enabled: true,
    ...over,
  };
}

let seq = 0;
function statusEvent(agentId: string, payload: unknown, ts = new Date().toISOString()): TraceEvent {
  return { id: `e${++seq}`, runId: "r1", timestamp: ts, type: "agent_status_changed", agentId, payload } as TraceEvent;
}

beforeEach(() => {
  useAgentStore.setState({
    agents: [agent({ id: "dev-1", currentTask: "旧任务" }), agent({ id: "dev-2" })],
    events: [], outputChunks: {}, loadedHistoryRuns: [], selectedId: null,
  });
});

describe("useAgentStore.addEvent · agent_status_changed 实时回写 agents(#1)", () => {
  it("working + currentTask → 合并进对应 agent,其余 agent 不动", () => {
    useAgentStore.getState().addEvent(statusEvent("dev-1", { status: "working", currentTask: "实现登录页" }));
    const s = useAgentStore.getState();
    expect(s.agents.find(a => a.id === "dev-1")).toMatchObject({ status: "working", currentTask: "实现登录页" });
    expect(s.agents.find(a => a.id === "dev-2")!.status).toBe("idle");
  });

  it("failed → 状态回写(C6 失败红闪的数据源)", () => {
    useAgentStore.getState().addEvent(statusEvent("dev-1", { status: "failed", currentTask: "错误原因" }));
    expect(useAgentStore.getState().agents.find(a => a.id === "dev-1")!.status).toBe("failed");
  });

  it("payload 不带 currentTask(如回 idle)→ status 更新,currentTask 保留旧值(与服务端 setAgentStatus 语义一致)", () => {
    useAgentStore.getState().addEvent(statusEvent("dev-1", { status: "idle" }));
    const a = useAgentStore.getState().agents.find(x => x.id === "dev-1")!;
    expect(a.status).toBe("idle");
    expect(a.currentTask).toBe("旧任务");
  });

  it("事件照常进 events 缓冲(简报栏/监视台等展示消费不受影响)", () => {
    useAgentStore.getState().addEvent(statusEvent("dev-1", { status: "working" }));
    const s = useAgentStore.getState();
    expect(s.events).toHaveLength(1);
    expect(s.events[0].type).toBe("agent_status_changed");
  });

  it("未知 agentId / payload 无 status → agents 引用原样不动", () => {
    const before = useAgentStore.getState().agents;
    useAgentStore.getState().addEvent(statusEvent("ghost", { status: "working" }));
    expect(useAgentStore.getState().agents).toBe(before);
    useAgentStore.getState().addEvent(statusEvent("dev-1", { currentTask: "没有 status" }));
    expect(useAgentStore.getState().agents).toBe(before);
  });
});

describe("useAgentStore.mergeRunHistory · 历史回放绝不回写 agents(#1)", () => {
  it("陈年 run 的 agent_status_changed 只进 events,不覆盖当前状态", () => {
    useAgentStore.getState().mergeRunHistory("old-run", [
      statusEvent("dev-1", { status: "failed", currentTask: "上周的失败" }, "2026-01-01T00:00:00.000Z"),
    ]);
    const s = useAgentStore.getState();
    expect(s.agents.find(a => a.id === "dev-1")).toMatchObject({ status: "idle", currentTask: "旧任务" });
    expect(s.events).toHaveLength(1);
  });
});
