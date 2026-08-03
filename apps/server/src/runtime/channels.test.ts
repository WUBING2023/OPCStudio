import { describe, it, expect } from "vitest";
import { ChannelRegistry, applyPresetChannels } from "./channels.js";

// v5 P1：通道引擎——开/申请/批准/拒绝/失效 + canCommunicate（与可见性一致：未开通=不可通信）。
describe("ChannelRegistry — 通信通道", () => {
  it("lead 直接给 worker 开通道，双方可通信", () => {
    const r = new ChannelRegistry("run1");
    const ch = r.open("lead", "w1", "lead-worker", "lead");
    expect(ch.status).toBe("open");
    expect(r.canCommunicate("lead", "w1")).toBe(true);
    expect(r.canCommunicate("w1", "lead")).toBe(true); // 无向
  });

  it("没有通道则不能通信（fail-closed）", () => {
    const r = new ChannelRegistry();
    expect(r.canCommunicate("w1", "w2")).toBe(false);
  });

  it("worker 申请与另一 worker 交流 → lead 批准 → 通道开通", () => {
    const r = new ChannelRegistry();
    const req = r.request("w1", "w2", "peer-worker", "想对齐接口");
    expect(req.status).toBe("pending");
    expect(r.canCommunicate("w1", "w2")).toBe(false); // 批准前不可通信
    const ch = r.grant(req.id, "lead");
    expect(ch).toBeTruthy();
    expect(ch!.requestedBy).toBe("w1");
    expect(ch!.coordinatedBy).toBe("lead");
    expect(r.canCommunicate("w1", "w2")).toBe(true);   // 批准后可通信
  });

  it("lead 拒绝申请 → 不开通道", () => {
    const r = new ChannelRegistry();
    const req = r.request("w1", "w3", "peer-worker", "无关请求");
    expect(r.deny(req.id, "lead")).toBe(true);
    expect(r.canCommunicate("w1", "w3")).toBe(false);
    expect(r.listRequests().find(x => x.id === req.id)!.status).toBe("denied");
  });

  it("active/close 状态流转 + 重复 open 复用", () => {
    const r = new ChannelRegistry();
    const ch = r.open("lead-a", "lead-b", "peer-lead", "ceo");
    r.setActive(ch.id, true);
    expect(r.list().find(c => c.id === ch.id)!.status).toBe("active");
    // 重复 open 同一对同 kind → 复用，不新增
    const ch2 = r.open("lead-a", "lead-b", "peer-lead", "ceo");
    expect(ch2.id).toBe(ch.id);
    expect(r.list().length).toBe(1);
    r.close(ch.id);
    expect(r.canCommunicate("lead-a", "lead-b")).toBe(false);
  });

  // #10:status 一旦 active 不自行衰减,前端「正在交流」流光按 lastActiveAt 新鲜度判定——
  // setActive(true) 必须刷新 lastActiveAt(recordMessage/recordA2A 每条经通道的消息都会调它),
  // /api/channels 直接吐 list(),该字段随之带给前端。
  it("setActive(true) 刷新 lastActiveAt,再次来消息时间前移;list() 序列化带出", () => {
    const r = new ChannelRegistry("run1");
    const ch = r.open("lead", "w1", "lead-worker", "lead");
    expect(ch.lastActiveAt).toBeUndefined(); // 开通 ≠ 交流过
    r.setActive(ch.id, true, "2026-01-01T00:00:00.000Z");
    expect(r.list().find(c => c.id === ch.id)!.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
    r.setActive(ch.id, true, "2026-01-01T00:00:05.000Z");
    expect(r.list().find(c => c.id === ch.id)!.lastActiveAt).toBe("2026-01-01T00:00:05.000Z");
  });

  it("setActive(false) 回落 open 但保留 lastActiveAt(历史事实不抹除)", () => {
    const r = new ChannelRegistry();
    const ch = r.open("a", "b", "peer-worker", "lead");
    r.setActive(ch.id, true, "2026-01-01T00:00:00.000Z");
    r.setActive(ch.id, false);
    const got = r.list().find(c => c.id === ch.id)!;
    expect(got.status).toBe("open");
    expect(got.lastActiveAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("setActive 不传 ts → 以当前时刻刷新", () => {
    const r = new ChannelRegistry();
    const ch = r.open("a", "b", "peer-worker", "lead");
    const before = Date.now();
    r.setActive(ch.id, true);
    const t = Date.parse(r.list().find(c => c.id === ch.id)!.lastActiveAt!);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("learn 通道（团队向团队学习，CEO 批准）", () => {
    const r = new ChannelRegistry();
    const req = r.request("lead-x", "lead-y", "learn", "向 Y 团队学习测试策略");
    const ch = r.grant(req.id, "ceo");
    expect(ch!.kind).toBe("learn");
    expect(ch!.coordinatedBy).toBe("ceo");
    expect(r.canCommunicate("lead-x", "lead-y")).toBe(true);
  });

  it("enforces one-way channels while keeping legacy channels bidirectional", () => {
    const r = new ChannelRegistry();
    r.open("producer", "reviewer", "a2a", "template-preset", undefined, undefined, "oneway");
    expect(r.canCommunicate("producer", "reviewer")).toBe(true);
    expect(r.canCommunicate("reviewer", "producer")).toBe(false);
    expect(r.between("reviewer", "producer")).toBeUndefined();

    r.open("lead", "worker", "lead-worker", "lead");
    expect(r.canCommunicate("worker", "lead")).toBe(true);
  });

  it("materializes preset enabled, direction, and authorization policy", () => {
    const r = new ChannelRegistry("run-preset");
    const applied = applyPresetChannels(r, [
      { from: "a", to: "b", direction: "oneway", authPolicy: "trusted", enabled: true },
      { from: "b", to: "c", direction: "bidirectional", authPolicy: "gated" },
      { from: "a", to: "c", authPolicy: "manual" },
      { from: "c", to: "a", enabled: false },
      { from: "missing", to: "a" },
    ], new Set(["a", "b", "c"]));

    expect(applied.opened).toHaveLength(1);
    expect(applied.requested).toHaveLength(2);
    expect(applied.requested.map((r) => r.authPolicy)).toEqual(["gated", "manual"]);
    expect(applied.skipped.map((s) => s.reason)).toEqual(["disabled", "missing-agent"]);
    expect(r.canCommunicate("a", "b")).toBe(true);
    expect(r.canCommunicate("b", "a")).toBe(false);
    expect(r.canCommunicate("b", "c")).toBe(false);

    const gated = applied.requested[0];
    const granted = r.grant(gated.id, "lead");
    expect(granted?.direction).toBe("bidirectional");
    expect(r.canCommunicate("b", "c")).toBe(true);
    expect(r.canCommunicate("c", "b")).toBe(true);
  });
});
