import { describe, it, expect } from "vitest";
import type { AgentMessage, Artifact, A2AMessageType, A2ALifecycleState } from "@opc/shared";
import { A2ABus, ArtifactStore, computeA2AClosure } from "./a2aBus.js";

const msg = (from: string, text: string): AgentMessage => ({
  id: `m-${text}`, from, text, timestamp: "2026-06-22T00:00:00Z",
  visibility: { audience: "agents:x", scope: "direct" } as AgentMessage["visibility"],
});

describe("A2ABus — per-agent inbox 真投递", () => {
  it("deliver 投进每个收件人;drain 取出并清空", () => {
    const bus = new A2ABus();
    bus.deliver(msg("a", "hi"), ["b", "c"]);
    expect(bus.pending()).toBe(2);
    const b = bus.drain("b");
    expect(b).toHaveLength(1);
    expect(b[0].text).toBe("hi");
    expect(bus.drain("b")).toHaveLength(0); // 已清空
    expect(bus.pending()).toBe(1);          // c 还在
  });

  it("peek 不消费", () => {
    const bus = new A2ABus();
    bus.deliver(msg("a", "q"), ["b"]);
    expect(bus.peek("b")).toHaveLength(1);
    expect(bus.peek("b")).toHaveLength(1); // 再看仍在
    expect(bus.pending()).toBe(1);
  });

  it("空收件人 drain/peek 返回空数组", () => {
    const bus = new A2ABus();
    expect(bus.drain("nobody")).toEqual([]);
    expect(bus.peek("nobody")).toEqual([]);
  });

  it("clear 清空所有", () => {
    const bus = new A2ABus();
    bus.deliver(msg("a", "x"), ["b"]);
    bus.clear();
    expect(bus.pending()).toBe(0);
  });
});

describe("ArtifactStore — claim-check 产出物存储", () => {
  const art = (producedBy: string, name: string): Omit<Artifact, "id"> => ({
    producedBy, kind: "report", name, type: "design-doc", summary: "s", createdAt: "2026-06-22T00:00:00Z",
  });

  it("put 生成 id、get 往返、list 全量", () => {
    const store = new ArtifactStore("run123456");
    const id1 = store.put(art("a", "doc1"));
    const id2 = store.put(art("b", "doc2"));
    expect(id1).not.toBe(id2);
    expect(id1.startsWith("art-run123")).toBe(true);
    expect(store.get(id1)?.name).toBe("doc1");
    expect(store.get(id1)?.id).toBe(id1); // id 被回填
    expect(store.list()).toHaveLength(2);
    expect(store.get("nope")).toBeUndefined();
  });

  it("clear 重置 id 序列", () => {
    const store = new ArtifactStore("r");
    store.put(art("a", "x"));
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

describe("A2ABus.listTracked — 收尾闭环审计取全量已 propose 消息", () => {
  const track = (id: string): AgentMessage => ({
    id, from: "lead-1", to: ["worker-1"], text: "t", timestamp: "2026-07-11T00:00:00Z",
    visibility: { audience: "agents:worker-1" },
  });
  it("只含已 propose 的消息;rejected 也留在 tracked;clear 清空", () => {
    const bus = new A2ABus();
    const a = bus.propose(track("a"));
    const b = bus.propose(track("b"));
    bus.reject(b, "无通道");
    const ids = bus.listTracked().map((m) => m.id).sort();
    expect(ids).toEqual(["a", "b"]); // propose 即入 tracked(含 rejected)
    expect(bus.listTracked().find((m) => m.id === "a")).toBe(a);
    bus.clear();
    expect(bus.listTracked()).toEqual([]);
  });
});

describe("computeA2AClosure — D4 必需闭环集统计(codex 问题5)", () => {
  let seq = 0;
  const m = (over: Partial<AgentMessage> & { messageType?: A2AMessageType; lifecycle?: A2ALifecycleState }): AgentMessage => ({
    id: `c-${++seq}`, from: "lead-1", to: ["worker-1"], text: "t", timestamp: "2026-07-11T00:00:00Z",
    visibility: { audience: "agents:worker-1" }, ...over,
  });

  it("必需集 = {delegate_task,revision_request,artifact_handoff} 且有显式 to;resolved 计数正确", () => {
    const tracked = [
      m({ messageType: "delegate_task", lifecycle: "resolved" }),
      m({ messageType: "artifact_handoff", lifecycle: "resolved" }),
      m({ messageType: "revision_request", lifecycle: "delivered" }), // 未 resolved
      m({ messageType: "worker_report", lifecycle: "delivered" }),    // 不在必需类型 → 不计
      m({ messageType: "delegate_task", to: [], lifecycle: "delivered" }), // 无 to → 不计
      m({ messageType: undefined, lifecycle: "delivered" }),          // 无 messageType(旧消息)→ 不计
    ];
    const c = computeA2AClosure(tracked);
    expect(c.required).toBe(3);
    expect(c.resolved).toBe(2);
    expect(c.unresolvedIds).toHaveLength(1);
    expect(c.unresolvedIds[0]).toBe(tracked[2].id); // 未 resolved 的 revision_request
  });

  it("负例:deferred worker 的 delegate_task 未 resolved → 进 unresolvedIds", () => {
    const deferredDelegate = m({ messageType: "delegate_task", to: ["worker-def"], lifecycle: "acknowledged" });
    const okDelegate = m({ messageType: "delegate_task", to: ["worker-ok"], lifecycle: "resolved" });
    const c = computeA2AClosure([okDelegate, deferredDelegate]);
    expect(c.required).toBe(2);
    expect(c.resolved).toBe(1);
    expect(c.unresolvedIds).toContain(deferredDelegate.id);
    expect(c.unresolvedIds).not.toContain(okDelegate.id);
  });

  it("向后兼容:全是旧消息(无 messageType/无 to)→ required=0,不误标未闭环", () => {
    const c = computeA2AClosure([
      m({ messageType: undefined, to: undefined }),
      m({ messageType: "lead_report", to: undefined }),
    ]);
    expect(c).toEqual({ required: 0, resolved: 0, unresolvedIds: [] });
  });

  it("unresolvedIds 截断到上限", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      m({ id: `u-${i}`, messageType: "delegate_task", to: ["w"], lifecycle: "delivered" }),
    );
    const c = computeA2AClosure(many, 20);
    expect(c.required).toBe(25);
    expect(c.resolved).toBe(0);
    expect(c.unresolvedIds).toHaveLength(20);
  });
});
