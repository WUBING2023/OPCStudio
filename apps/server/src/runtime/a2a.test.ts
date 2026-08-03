import { describe, it, expect, afterEach } from "vitest";
import {
  runTool, runWithAgent, getActiveTools,
  setDiscoverHandler, setA2ASendHandler, setShareHandler, setAskHandler, setInboxPeekHandler, setChannelRequestHandler,
} from "./tools.js";

// A2A Phase 4+5:agent 主动通信工具(discover/send/share/ask/inbox)的注册、守卫与 hook 调用。
afterEach(() => {
  setDiscoverHandler(null); setA2ASendHandler(null); setShareHandler(null);
  setAskHandler(null); setInboxPeekHandler(null); setChannelRequestHandler(null);
});

describe("A2A 工具注册", () => {
  it("5 个 A2A 工具都在清单里(会提供给 LLM)", () => {
    const names = getActiveTools().map((t) => t.name);
    for (const n of ["discover_agents", "send_message", "share_artifact", "ask_agent", "list_my_inbox"]) {
      expect(names).toContain(n);
    }
  });
  it("A2A 工具都带 inline paramSchema(api 引擎与 Hermes 都能拿到参数签名)", () => {
    const byName = new Map(getActiveTools().map((t) => [t.name, t]));
    expect(byName.get("send_message")?.paramSchema?.required).toEqual(["target", "text"]);
    expect(byName.get("ask_agent")?.paramSchema?.required).toEqual(["target", "question"]);
    expect(Object.keys(byName.get("discover_agents")?.paramSchema?.properties ?? {})).toContain("skill");
  });
});

describe("A2A 工具守卫(无 run 上下文 / 无 handler)", () => {
  it("无 agent 上下文 → 守卫提示,不误发", async () => {
    expect(await runTool("send_message", { target: "x", text: "hi" })).toContain("运行上下文");
    expect(await runTool("ask_agent", { target: "x", question: "q" })).toContain("运行上下文");
  });
});

describe("A2A 工具 → hook 调用", () => {
  it("discover_agents 把 filter 透传给 handler", async () => {
    setDiscoverHandler((from, f) => `from=${from} role=${f.role} skill=${f.skill}`);
    const out = await runWithAgent("a1", () => runTool("discover_agents", { role: "dev", skill: "api" }));
    expect(out).toBe("from=a1 role=dev skill=api");
  });
  it("send_message 经 a2aSendHandler 投递", async () => {
    let got = "";
    setA2ASendHandler((from, target, text, artifactId) => { got = `${from}->${target}:${text}(${artifactId})`; return "已发送"; });
    const out = await runWithAgent("a1", () => runTool("send_message", { target: "b", text: "hello", artifactId: "art-1" }));
    expect(out).toBe("已发送");
    expect(got).toBe("a1->b:hello(art-1)");
  });
  it("ask_agent 经 askHandler 异步返回对方答案", async () => {
    setAskHandler(async (from, target, question) => `(${target} 回答 ${from} 的「${question}」) 42`);
    const out = await runWithAgent("a1", () => runTool("ask_agent", { target: "b", question: "答案?" }));
    expect(out).toContain("42");
  });
  it("share_artifact 经 shareHandler", async () => {
    setShareHandler((from, target, artifactId) => `${from} 分享 ${artifactId} 给 ${target}`);
    const out = await runWithAgent("a1", () => runTool("share_artifact", { target: "b", artifactId: "art-9" }));
    expect(out).toBe("a1 分享 art-9 给 b");
  });
  it("request_channel 透传可选 kind(默认 peer-worker)", async () => {
    const kinds: (string | undefined)[] = [];
    setChannelRequestHandler((_from, _target, _reason, kind) => { kinds.push(kind); return "ok"; });
    await runWithAgent("a1", () => runTool("request_channel", { target: "b", reason: "r" }));
    await runWithAgent("a1", () => runTool("request_channel", { target: "lead1", reason: "r", kind: "peer-lead" }));
    expect(kinds[0]).toBeUndefined();      // 默认未传 → handler 内自行兜底 peer-worker
    expect(kinds[1]).toBe("peer-lead");
  });
});
