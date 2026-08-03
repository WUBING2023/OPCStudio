import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendTurns, loadThread, getRecentTurns, selectHistoryForPrompt,
  chatThreadId, CHAT_THREAD_VERSION, type ChatThreadTurn,
} from "./chatThreadStore.js";

describe("chatThreadStore", () => {
  let root: string;
  afterEach(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });
  const mkroot = () => (root = fs.mkdtempSync(path.join(os.tmpdir(), "chat-thread-")));

  it("空线程读取 → []", () => {
    mkroot();
    expect(loadThread(root, "c1", "a1")).toEqual([]);
    expect(getRecentTurns(root, "c1", "a1", 10)).toEqual([]);
  });

  it("append 落盘 + 读回:role/content/at 保序,写入带 v 字段", () => {
    mkroot();
    appendTurns(root, "c1", "a1", [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好，我是 CEO" },
    ], "2026-07-10T00:00:00.000Z");
    const turns = loadThread(root, "c1", "a1");
    expect(turns).toEqual([
      { role: "user", content: "你好", at: "2026-07-10T00:00:00.000Z" },
      { role: "assistant", content: "你好，我是 CEO", at: "2026-07-10T00:00:00.000Z" },
    ]);
    const onDisk = JSON.parse(fs.readFileSync(
      path.join(root, ".opc", "chat-threads", "c1__a1.json"), "utf-8",
    ));
    expect(onDisk.v).toBe(CHAT_THREAD_VERSION);
    expect(onDisk.turns).toHaveLength(2);
  });

  it("多次 append 追加(不覆盖),按 companyId+agentId 隔离", () => {
    mkroot();
    appendTurns(root, "c1", "a1", [{ role: "user", content: "q1" }]);
    appendTurns(root, "c1", "a1", [{ role: "assistant", content: "r1" }]);
    appendTurns(root, "c1", "a2", [{ role: "user", content: "other-agent" }]);
    appendTurns(root, "c2", "a1", [{ role: "user", content: "other-company" }]);
    expect(loadThread(root, "c1", "a1").map(t => t.content)).toEqual(["q1", "r1"]);
    expect(loadThread(root, "c1", "a2").map(t => t.content)).toEqual(["other-agent"]);
    expect(loadThread(root, "c2", "a1").map(t => t.content)).toEqual(["other-company"]);
  });

  it("空白/非法条目被过滤,不落盘", () => {
    mkroot();
    appendTurns(root, "c1", "a1", [
      { role: "user", content: "   " },
      { role: "assistant", content: "" },
      { role: "user", content: "real" },
      { role: "system" as any, content: "not-a-turn" },
    ]);
    expect(loadThread(root, "c1", "a1").map(t => t.content)).toEqual(["real"]);
  });

  it("条数滚动上限:超过 60 条只保留最近 60 条", () => {
    mkroot();
    for (let i = 0; i < 80; i++) {
      appendTurns(root, "c1", "a1", [{ role: "user", content: `m${i}` }]);
    }
    const turns = loadThread(root, "c1", "a1");
    expect(turns).toHaveLength(60);
    expect(turns[0].content).toBe("m20");
    expect(turns[59].content).toBe("m79");
  });

  it("字节上限:单条超长 → 从最旧截断,至少保留最新一条", () => {
    mkroot();
    appendTurns(root, "c1", "a1", [{ role: "user", content: "old-tiny" }]);
    const huge = "x".repeat(200 * 1024);
    appendTurns(root, "c1", "a1", [{ role: "assistant", content: huge }]);
    const turns = loadThread(root, "c1", "a1");
    // 旧的小条被字节闸挤掉,只剩超长的最新一条(始终 ≥1)。
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe(huge);
  });

  it("selectHistoryForPrompt:条数上限裁剪(默认 12)", () => {
    const turns: ChatThreadTurn[] = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `m${i}`, at: "" }));
    const sel = selectHistoryForPrompt(turns);
    expect(sel).toHaveLength(12);
    expect(sel[0].content).toBe("m8");
    expect(sel[11].content).toBe("m19");
  });

  it("selectHistoryForPrompt:token 预算从最旧丢弃,至少保留最后 1 条", () => {
    // 每条约 250 token(1000 字符 /4),预算 300 → 只能容 1 条。
    const turns: ChatThreadTurn[] = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: "y".repeat(1000) + i, at: "" }));
    const sel = selectHistoryForPrompt(turns, { maxTurns: 12, maxTokens: 300 });
    expect(sel).toHaveLength(1);
    expect(sel[0].content.endsWith("4")).toBe(true); // 最新一条
  });

  it("selectHistoryForPrompt:预算充足则原样返回(≤maxTurns)", () => {
    const turns: ChatThreadTurn[] = [
      { role: "user", content: "a", at: "" },
      { role: "assistant", content: "b", at: "" },
    ];
    expect(selectHistoryForPrompt(turns, { maxTokens: 100000 })).toEqual(turns);
  });

  it("chatThreadId 形状", () => {
    expect(chatThreadId("c1", "a1")).toBe("c1::a1");
  });

  it("companyId/agentId 含路径分隔符被安全编码,不逃逸目录", () => {
    mkroot();
    appendTurns(root, "../evil", "a/b", [{ role: "user", content: "x" }]);
    // 落在 chat-threads 目录内(safe() 把 / 与 .. 替成 _),读回一致。
    expect(loadThread(root, "../evil", "a/b").map(t => t.content)).toEqual(["x"]);
    const files = fs.readdirSync(path.join(root, ".opc", "chat-threads"));
    expect(files.every(f => !f.includes("..") && !f.includes("/"))).toBe(true);
  });
});
