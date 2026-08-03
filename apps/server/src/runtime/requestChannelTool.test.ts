import { describe, it, expect, afterEach } from "vitest";
import { runTool, runWithAgent, setChannelRequestHandler, getActiveTools } from "./tools.js";
import { ChannelRegistry } from "./channels.js";

// v6 P3b：worker 自主调 request_channel 工具 → 经 hook 记入通道注册表（待 lead 批准）。
afterEach(() => setChannelRequestHandler(null));

describe("request_channel 工具", () => {
  it("在工具清单里（会提供给 LLM）", () => {
    expect(getActiveTools().some(t => t.name === "request_channel")).toBe(true);
  });

  it("worker 运行上下文中调用 → 以 currentAgentId 为申请方记录 peer-worker 申请", async () => {
    const reg = new ChannelRegistry("run1");
    setChannelRequestHandler((from, target, reason) => {
      const r = reg.request(from, target, "peer-worker", reason);
      return `ok ${r.id}`;
    });
    // 模拟 worker frontend-engineer 在运行中调用工具
    const out = await runWithAgent("frontend-engineer", () =>
      runTool("request_channel", { target: "backend-engineer", reason: "对齐接口" }));
    expect(out).toMatch(/^ok /);
    const reqs = reg.pendingRequests();
    expect(reqs.length).toBe(1);
    expect(reqs[0]).toMatchObject({ from: "frontend-engineer", to: "backend-engineer", kind: "peer-worker", status: "pending" });
    // lead 批准 → 通道开通
    reg.grant(reqs[0].id, "engineering-lead");
    expect(reg.canCommunicate("frontend-engineer", "backend-engineer")).toBe(true);
  });

  it("无运行上下文（无 agentId）→ 不提交", async () => {
    setChannelRequestHandler(() => "should-not-be-called");
    const out = await runTool("request_channel", { target: "x", reason: "y" });
    expect(out).toMatch(/无法确定申请方/);
  });
});
