import { describe, it, expect, beforeEach } from "vitest";
import { useCockpitStore } from "./useCockpitStore.js";

// 前端线程注水的代理测试(纯运行时 zustand,无 DOM):锁住"打开会话拉服务端线程 → hydrateThread"
// 这一步的合并语义——把持久 turn 投影成本地消息、每 agent 只注水一次、与在途消息去重。

const reset = () => useCockpitStore.setState({ localMessages: [], hydratedAgentIds: [] });

describe("useCockpitStore.hydrateThread", () => {
  beforeEach(reset);

  it("把服务端 turn 灌成本地消息(role/text/ts 对齐 agentId)", () => {
    useCockpitStore.getState().hydrateThread("a1", [
      { role: "user", content: "你好", at: "2026-07-10T00:00:00.000Z" },
      { role: "assistant", content: "在的", at: "2026-07-10T00:00:01.000Z" },
    ]);
    const msgs = useCockpitStore.getState().localMessages.filter(m => m.agentId === "a1");
    expect(msgs.map(m => [m.role, m.text, m.ts])).toEqual([
      ["user", "你好", "2026-07-10T00:00:00.000Z"],
      ["assistant", "在的", "2026-07-10T00:00:01.000Z"],
    ]);
    expect(useCockpitStore.getState().hydratedAgentIds).toContain("a1");
  });

  it("每个 agent 只注水一次(第二次调用不再追加)", () => {
    const s = useCockpitStore.getState();
    s.hydrateThread("a1", [{ role: "user", content: "第一次", at: "t1" }]);
    s.hydrateThread("a1", [{ role: "user", content: "第二次", at: "t2" }]);
    const msgs = useCockpitStore.getState().localMessages.filter(m => m.agentId === "a1");
    expect(msgs.map(m => m.text)).toEqual(["第一次"]);
  });

  it("与已在本地的同 role+文本去重(乐观追加不被翻倍)", () => {
    const s = useCockpitStore.getState();
    // 模拟发送时的乐观本地消息
    s.addLocalMessage({ agentId: "a1", role: "user", text: "在场消息" });
    s.hydrateThread("a1", [
      { role: "user", content: "在场消息", at: "t1" },   // 重复 → 跳过
      { role: "assistant", content: "新历史", at: "t2" }, // 新 → 灌入
    ]);
    const msgs = useCockpitStore.getState().localMessages.filter(m => m.agentId === "a1");
    expect(msgs.filter(m => m.text === "在场消息")).toHaveLength(1);
    expect(msgs.some(m => m.text === "新历史")).toBe(true);
  });

  it("不同 agent 的线程互不串", () => {
    const s = useCockpitStore.getState();
    s.hydrateThread("a1", [{ role: "user", content: "给A", at: "t1" }]);
    s.hydrateThread("a2", [{ role: "user", content: "给B", at: "t2" }]);
    const all = useCockpitStore.getState().localMessages;
    expect(all.filter(m => m.agentId === "a1").map(m => m.text)).toEqual(["给A"]);
    expect(all.filter(m => m.agentId === "a2").map(m => m.text)).toEqual(["给B"]);
  });

  it("空白/非法条目被过滤", () => {
    useCockpitStore.getState().hydrateThread("a1", [
      { role: "user", content: "  ", at: "t1" },
      { role: "system" as any, content: "x", at: "t2" },
      { role: "assistant", content: "有效", at: "t3" },
    ]);
    const msgs = useCockpitStore.getState().localMessages.filter(m => m.agentId === "a1");
    expect(msgs.map(m => m.text)).toEqual(["有效"]);
  });
});
