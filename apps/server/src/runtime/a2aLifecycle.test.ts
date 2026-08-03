import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@opc/shared";
import {
  A2ABus,
  A2A_LIFECYCLE_TRANSITIONS,
  inferMessageType,
  buildA2AMessageRecord,
  appendA2AMessageRecord,
  readA2AMessageRecords,
  latestA2ARecords,
} from "./a2aBus.js";

// A4 · A2A 升级:消息生命周期(proposed→validated→committed→delivered→acknowledged→resolved)、
// committed 落盘门槛、a2a_messages.jsonl round-trip、回执授权、旧消息兼容、messageType 推断。

let seq = 0;
function msg(over: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: `m-${++seq}`,
    from: "lead-1",
    to: ["worker-1"],
    text: "hello",
    timestamp: "2026-07-07T00:00:00Z",
    visibility: { audience: "agents:worker-1" },
    ...over,
  };
}

describe("A2A 生命周期状态机", () => {
  it("正向全链:proposed→validated→committed→delivered→acknowledged→resolved", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg());
    expect(m.lifecycle).toBe("proposed");
    expect(bus.validate(m)).toBe(true);
    expect(m.lifecycle).toBe("validated");
    expect(bus.commit(m)).toBe(true);
    expect(m.lifecycle).toBe("committed");
    bus.deliver(m, ["worker-1"]);
    expect(m.lifecycle).toBe("delivered");
    expect(bus.acknowledge(m.id, "worker-1")).toBe(true);
    expect(m.lifecycle).toBe("acknowledged");
    expect(bus.resolve(m.id, "worker-1")).toBe(true);
    expect(m.lifecycle).toBe("resolved");
    expect(m.statusHistory?.map((s) => s.state)).toEqual([
      "proposed", "validated", "committed", "delivered", "acknowledged", "resolved",
    ]);
  });

  it("proposed→rejected 与 validated→rejected 是合法转移;rejected 是终态", () => {
    const bus = new A2ABus();
    const m1 = bus.propose(msg());
    expect(bus.reject(m1, "无通道")).toBe(true);
    expect(m1.lifecycle).toBe("rejected");
    expect(bus.validate(m1)).toBe(false); // 终态不可再推进

    const m2 = bus.propose(msg());
    bus.validate(m2);
    expect(bus.reject(m2)).toBe(true);
    expect(bus.commit(m2)).toBe(false); // 终态不可再推进
  });

  it("delivered→resolved 可以跳过 acknowledged(直接闭环)", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg());
    bus.validate(m); bus.commit(m); bus.deliver(m, ["worker-1"]);
    expect(bus.resolve(m.id, "worker-1")).toBe(true);
    expect(m.lifecycle).toBe("resolved");
  });

  it("非法转移一律拒绝且不改状态", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg());
    expect(bus.commit(m)).toBe(false);            // proposed → committed 非法(必须先 validate)
    expect(bus.acknowledge(m.id, "worker-1")).toBe(false); // proposed → acknowledged 非法
    expect(bus.resolve(m.id, "lead-1")).toBe(false);       // proposed → resolved 非法
    expect(m.lifecycle).toBe("proposed");
    bus.validate(m);
    expect(bus.validate(m)).toBe(false);          // validated → validated 非法(重复推进)
    bus.commit(m);
    expect(bus.reject(m)).toBe(false);            // committed → rejected 非法(committed 后不可撤)
    expect(bus.resolve(m.id, "lead-1")).toBe(false); // committed → resolved 非法(必须先 delivered)
    expect(m.lifecycle).toBe("committed");
  });

  it("未 propose 的消息不能被 validate/commit 推进", () => {
    const bus = new A2ABus();
    const m = msg();
    expect(bus.validate(m)).toBe(false);
    expect(bus.commit(m)).toBe(false);
    expect(m.lifecycle).toBeUndefined();
  });

  it("propose 幂等:已在生命周期中的消息不被重置", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg());
    bus.validate(m);
    bus.propose(m);
    expect(m.lifecycle).toBe("validated");
    expect(m.statusHistory).toHaveLength(2);
  });

  it("转移表覆盖全部 7 态且终态无后继", () => {
    expect(Object.keys(A2A_LIFECYCLE_TRANSITIONS).sort()).toEqual(
      ["acknowledged", "committed", "delivered", "proposed", "rejected", "resolved", "validated"],
    );
    expect(A2A_LIFECYCLE_TRANSITIONS.rejected).toEqual([]);
    expect(A2A_LIFECYCLE_TRANSITIONS.resolved).toEqual([]);
  });
});

describe("committed 硬门槛:未 committed 不投递、不落盘", () => {
  it("proposed/validated 的消息 deliver 拒投(inbox 为空)", () => {
    const bus = new A2ABus();
    const m1 = bus.propose(msg());
    bus.deliver(m1, ["worker-1"]);
    expect(bus.peek("worker-1")).toHaveLength(0);
    const m2 = bus.propose(msg());
    bus.validate(m2);
    bus.deliver(m2, ["worker-1"]);
    expect(bus.peek("worker-1")).toHaveLength(0);
    expect(m1.lifecycle).toBe("proposed");
    expect(m2.lifecycle).toBe("validated");
  });

  it("rejected 的消息永不投递、sink 永不触发", () => {
    const sunk: AgentMessage[] = [];
    const bus = new A2ABus({ onCommitted: (m) => sunk.push(m) });
    const m = bus.propose(msg());
    bus.reject(m, "校验失败");
    bus.deliver(m, ["worker-1"]);
    expect(bus.peek("worker-1")).toHaveLength(0);
    expect(sunk).toHaveLength(0);
  });

  it("proposed/validated 不触发落盘 sink;committed 及之后每次推进各触发一次", () => {
    const states: string[] = [];
    const bus = new A2ABus({ onCommitted: (m) => states.push(m.lifecycle!) });
    const m = bus.propose(msg());
    bus.validate(m);
    expect(states).toEqual([]); // proposed/validated 不落盘
    bus.commit(m);
    expect(states).toEqual(["committed"]);
    bus.deliver(m, ["worker-1"]);
    expect(states).toEqual(["committed", "delivered"]);
    bus.drain("worker-1"); // 消费即回执
    expect(states).toEqual(["committed", "delivered", "acknowledged"]);
  });

  it("sink 抛错不影响消息流转(best-effort)", () => {
    const bus = new A2ABus({ onCommitted: () => { throw new Error("disk full"); } });
    const m = bus.propose(msg());
    bus.validate(m);
    expect(bus.commit(m)).toBe(true);
    bus.deliver(m, ["worker-1"]);
    expect(bus.peek("worker-1")).toHaveLength(1);
  });

  it("commitAndDeliver 一次走完 proposed→delivered 并进 inbox", () => {
    const states: string[] = [];
    const bus = new A2ABus({ onCommitted: (m) => states.push(m.lifecycle!) });
    const m = msg({ messageType: "review_approved" });
    expect(bus.commitAndDeliver(m, ["worker-1"])).toBe(true);
    expect(m.lifecycle).toBe("delivered");
    expect(bus.peek("worker-1")).toHaveLength(1);
    expect(states).toEqual(["committed", "delivered"]);
  });
});

describe("回执授权(fail-closed)", () => {
  function delivered(bus: A2ABus): AgentMessage {
    const m = bus.propose(msg());
    bus.validate(m); bus.commit(m); bus.deliver(m, ["worker-1"]);
    return m;
  }

  it("ack:只有显式收件人能确认;陌生人/发送方拒绝", () => {
    const bus = new A2ABus();
    const m = delivered(bus);
    expect(bus.acknowledge(m.id, "stranger")).toBe(false);
    expect(bus.acknowledge(m.id, "lead-1")).toBe(false); // 发送方不是收件人
    expect(m.lifecycle).toBe("delivered");
    expect(bus.acknowledge(m.id, "worker-1")).toBe(true);
  });

  it("resolve:发送方或收件人都可闭环;陌生人拒绝", () => {
    const bus = new A2ABus();
    const m1 = delivered(bus);
    expect(bus.resolve(m1.id, "stranger")).toBe(false);
    expect(bus.resolve(m1.id, "lead-1")).toBe(true); // 发送方闭环
    const m2 = delivered(bus);
    expect(bus.resolve(m2.id, "worker-1")).toBe(true); // 收件人闭环
  });

  it("未知 messageId → false", () => {
    const bus = new A2ABus();
    expect(bus.acknowledge("nope", "worker-1")).toBe(false);
    expect(bus.resolve("nope", "worker-1")).toBe(false);
  });

  it("clear 后 tracked 索引清空,ack 不再命中", () => {
    const bus = new A2ABus();
    const m = delivered(bus);
    bus.clear();
    expect(bus.acknowledge(m.id, "worker-1")).toBe(false);
  });
});

describe("旧消息兼容(无 lifecycle 字段)", () => {
  it("旧消息按老语义直投直取,不被强加生命周期、不触发 sink", () => {
    const sunk: AgentMessage[] = [];
    const bus = new A2ABus({ onCommitted: (m) => sunk.push(m) });
    const legacy = msg(); // 不经 propose,无 lifecycle
    bus.deliver(legacy, ["worker-1", "worker-2"]);
    expect(bus.pending()).toBe(2);
    const got = bus.drain("worker-1");
    expect(got).toHaveLength(1);
    expect(got[0].lifecycle).toBeUndefined();
    expect(got[0].statusHistory).toBeUndefined();
    expect(sunk).toHaveLength(0);
  });
});

describe("drain 消费即回执", () => {
  it("delivered 的消息被 drain 后推进为 acknowledged(by=消费方)", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg());
    bus.validate(m); bus.commit(m); bus.deliver(m, ["worker-1"]);
    const got = bus.drain("worker-1");
    expect(got[0].lifecycle).toBe("acknowledged");
    expect(got[0].statusHistory?.at(-1)).toMatchObject({ state: "acknowledged", by: "worker-1" });
  });

  it("多收件人:第一个消费者推进 acknowledged,后续 drain 不重复推进也不报错", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg({ to: ["worker-1", "worker-2"] }));
    bus.validate(m); bus.commit(m); bus.deliver(m, ["worker-1", "worker-2"]);
    bus.drain("worker-1");
    expect(m.lifecycle).toBe("acknowledged");
    const got2 = bus.drain("worker-2");
    expect(got2).toHaveLength(1); // 仍能取到内容
    expect(m.lifecycle).toBe("acknowledged"); // 不重复推进
    expect(m.statusHistory?.filter((s) => s.state === "acknowledged")).toHaveLength(1);
  });
});

describe("a2a_messages.jsonl 落盘 round-trip", () => {
  function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "a2a-jsonl-"));
  }

  it("buildA2AMessageRecord:messageType/lifecycle/statusHistory/from/to/artifactId 齐全,text 截断到 300", () => {
    const bus = new A2ABus();
    const m = bus.propose(msg({
      runId: "run-1",
      text: "x".repeat(500),
      messageType: "delegate_task",
      artifactRefs: ["art-1", "art-2"],
      channelId: "ch-1",
      performative: "request",
    }));
    bus.validate(m); bus.commit(m);
    const rec = buildA2AMessageRecord(m);
    expect(rec).toMatchObject({
      id: m.id, runId: "run-1", from: "lead-1", to: ["worker-1"],
      performative: "request", messageType: "delegate_task",
      lifecycle: "committed", artifactId: "art-1", channelId: "ch-1",
    });
    expect(rec.text).toHaveLength(300);
    expect(rec.statusHistory.map((s) => s.state)).toEqual(["proposed", "validated", "committed"]);
  });

  // D3 · 派单可观测:消息携带的记忆引用透传进落盘记录(a2a_messages.jsonl 可审计"派单参考了哪些经验")。
  it("buildA2AMessageRecord:citedMemories 透传;无引用的消息不带该字段(不塞空数组)", () => {
    const bus = new A2ABus();
    const cited = [{ id: "mem-1", title: "快排结论" }, { id: "lesson-2", title: "大文件应分块" }];
    const m = bus.propose(msg({ runId: "run-1", messageType: "delegate_task", citedMemories: cited }));
    bus.validate(m); bus.commit(m);
    const rec = buildA2AMessageRecord(m);
    expect(rec.citedMemories).toEqual(cited);

    const plain = bus.propose(msg({ runId: "run-1" }));
    bus.validate(plain); bus.commit(plain);
    expect(buildA2AMessageRecord(plain).citedMemories).toBeUndefined();
  });

  it("端到端:bus sink 落盘 → 只有 committed 及之后的快照在文件里;读回 last-wins 合并出最终态", () => {
    const root = tmpRoot();
    const runId = "run-rt-1";
    const bus = new A2ABus({ onCommitted: (m) => appendA2AMessageRecord(root, runId, buildA2AMessageRecord(m)) });
    const rejectedMsg = bus.propose(msg({ runId }));
    bus.reject(rejectedMsg, "无通道"); // 永不落盘
    const m = bus.propose(msg({ runId, messageType: "worker_report" }));
    bus.validate(m);
    expect(fs.existsSync(path.join(root, ".opc", "runs", runId, "a2a_messages.jsonl"))).toBe(false); // committed 前无文件
    bus.commit(m);
    bus.deliver(m, ["worker-1"]);
    bus.drain("worker-1");

    const records = readA2AMessageRecords(root, runId);
    expect(records).toHaveLength(3); // committed / delivered / acknowledged 三条快照
    expect(records.map((r) => r.lifecycle)).toEqual(["committed", "delivered", "acknowledged"]);
    expect(records.every((r) => r.id === m.id)).toBe(true); // rejected 那条从未出现

    const finals = latestA2ARecords(records);
    expect(finals).toHaveLength(1);
    expect(finals[0].lifecycle).toBe("acknowledged");
    expect(finals[0].messageType).toBe("worker_report");
    expect(finals[0].statusHistory.map((s) => s.state)).toEqual([
      "proposed", "validated", "committed", "delivered", "acknowledged",
    ]);
  });

  // D4 · A2A resolved 闭环(codex 问题5):delegate_task 被合成消费后由 lead(发送方)resolve →
  // a2a_messages.jsonl 追加 resolved 快照;last-wins 合并后终态 = resolved。
  it("delegate→deliver→resolve:resolved 快照落 jsonl,last-wins 合并后 lifecycle=resolved", () => {
    const root = tmpRoot();
    const runId = "run-resolved-1";
    const bus = new A2ABus({ onCommitted: (m) => appendA2AMessageRecord(root, runId, buildA2AMessageRecord(m)) });
    const m = bus.propose(msg({ runId, from: "lead-1", to: ["worker-1"], messageType: "delegate_task" }));
    bus.validate(m); bus.commit(m);
    bus.deliver(m, ["worker-1"]);
    expect(bus.resolve(m.id, "lead-1")).toBe(true); // 发送方(lead)可 resolve(合成消费点)
    expect(m.lifecycle).toBe("resolved");

    const finals = latestA2ARecords(readA2AMessageRecords(root, runId));
    expect(finals).toHaveLength(1);
    expect(finals[0].lifecycle).toBe("resolved");
    expect(finals[0].messageType).toBe("delegate_task");
    expect(finals[0].to).toEqual(["worker-1"]);
    expect(finals[0].statusHistory.map((s) => s.state)).toEqual([
      "proposed", "validated", "committed", "delivered", "resolved",
    ]);
  });

  it("readA2AMessageRecords:文件不存在返回 [];坏行跳过不拖垮整读", () => {
    const root = tmpRoot();
    expect(readA2AMessageRecords(root, "no-such-run")).toEqual([]);
    const runId = "run-bad";
    const dir = path.join(root, ".opc", "runs", runId);
    fs.mkdirSync(dir, { recursive: true });
    const good = JSON.stringify({ id: "a", from: "x", lifecycle: "committed", statusHistory: [], text: "t", timestamp: "2026-07-07T00:00:00Z" });
    fs.writeFileSync(path.join(dir, "a2a_messages.jsonl"), `${good}\n{not json}\n\n${good}\n`, "utf-8");
    const records = readA2AMessageRecords(root, runId);
    expect(records).toHaveLength(2);
    expect(latestA2ARecords(records)).toHaveLength(1);
  });
});

describe("messageType 保守推断", () => {
  it("share → artifact_handoff;带产物引用的 inform → artifact_handoff", () => {
    expect(inferMessageType({ performative: "share" })).toBe("artifact_handoff");
    expect(inferMessageType({ performative: "inform", artifactRefs: ["art-1"] })).toBe("artifact_handoff");
  });

  it("语义不明一律留空,不硬编", () => {
    expect(inferMessageType({ performative: "inform" })).toBeUndefined();
    expect(inferMessageType({ performative: "inform", artifactRefs: [] })).toBeUndefined();
    expect(inferMessageType({ performative: "ask" })).toBeUndefined();
    expect(inferMessageType({ performative: "reply" })).toBeUndefined();
    expect(inferMessageType({ performative: "request" })).toBeUndefined();
    expect(inferMessageType({})).toBeUndefined();
  });
});
