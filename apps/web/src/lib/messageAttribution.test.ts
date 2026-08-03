import { describe, it, expect } from "vitest";
import { resolveBubbleIdentity, attributionFromDecomposer, type AttributableEntry } from "./messageAttribution.js";

// 花名册里只有 lead-1 / dev-2 是真实成员;其它 id 一律视为查无此人。
const REAL = new Set(["lead-1", "dev-2", "ceo"]);
const isRealAgent = (id: string) => REAL.has(id);

describe("attributionFromDecomposer", () => {
  it("有 decomposer → 透传 agentId/name/role", () => {
    expect(attributionFromDecomposer({ agentId: "lead-1", name: "Tech Lead", role: "lead" }))
      .toEqual({ agentId: "lead-1", name: "Tech Lead", role: "lead" });
  });
  it("CEO 兜底 → role=ceo 也如实透传", () => {
    expect(attributionFromDecomposer({ agentId: "ceo", name: "老板", role: "ceo" }))
      .toEqual({ agentId: "ceo", name: "老板", role: "ceo" });
  });
  it("undefined(拆解失败无归属)→ undefined", () => {
    expect(attributionFromDecomposer(undefined)).toBeUndefined();
  });
  it("空名 → undefined(不构造无名归属)", () => {
    expect(attributionFromDecomposer({ agentId: "lead-1", name: "", role: "lead" })).toBeUndefined();
  });
});

describe("resolveBubbleIdentity · A 溯源", () => {
  it("带归属系统消息 + 产出者是真实 agent → 溯源到产出者、可点、加系统小标", () => {
    const e: AttributableEntry = {
      variant: "system", name: "系统",
      attributedTo: { agentId: "lead-1", name: "Tech Lead", role: "lead" },
    };
    expect(resolveBubbleIdentity(e, isRealAgent)).toEqual({
      displayName: "Tech Lead", displayRole: "lead", systemTag: true, linkAgentId: "lead-1",
    });
  });
  it("带归属但产出者查无此人 → 仍显示其名+系统小标,但不可点(不做假链接)", () => {
    const e: AttributableEntry = {
      variant: "system", name: "系统",
      attributedTo: { agentId: "ghost", name: "幽灵", role: "lead" },
    };
    const r = resolveBubbleIdentity(e, isRealAgent);
    expect(r.displayName).toBe("幽灵");
    expect(r.systemTag).toBe(true);
    expect(r.linkAgentId).toBeUndefined();
  });
  it("带归属但无 agentId(纯文本产出者)→ 显示名+系统小标,不可点", () => {
    const e: AttributableEntry = {
      variant: "system", name: "系统",
      attributedTo: { name: "某 Leader", role: "lead" },
    };
    const r = resolveBubbleIdentity(e, isRealAgent);
    expect(r.displayName).toBe("某 Leader");
    expect(r.systemTag).toBe(true);
    expect(r.linkAgentId).toBeUndefined();
  });
  it("真·系统消息(无归属)→ 保留原'系统'名,无系统小标,不可点", () => {
    const e: AttributableEntry = { variant: "system", name: "系统" };
    expect(resolveBubbleIdentity(e, isRealAgent)).toEqual({
      displayName: "系统", displayRole: undefined, systemTag: false,
    });
  });
});

describe("resolveBubbleIdentity · B 可点击落点", () => {
  it("agent 发言 + 发送者是真实成员 → 可点进其单聊", () => {
    const e: AttributableEntry = { variant: "agent", name: "Dev", role: "dev", agentId: "dev-2" };
    const r = resolveBubbleIdentity(e, isRealAgent);
    expect(r.linkAgentId).toBe("dev-2");
    expect(r.systemTag).toBe(false);
  });
  it("agent 发言但发送者查无此人 → 不可点", () => {
    const e: AttributableEntry = { variant: "agent", name: "路人", role: "dev", agentId: "ghost" };
    expect(resolveBubbleIdentity(e, isRealAgent).linkAgentId).toBeUndefined();
  });
  it("agent 发言无 agentId(纯文本角色名)→ 不做假链接", () => {
    const e: AttributableEntry = { variant: "agent", name: "Architect", role: "architect" };
    expect(resolveBubbleIdentity(e, isRealAgent).linkAgentId).toBeUndefined();
  });
  it("用户自己的消息即便带 agentId 也不可点", () => {
    const e: AttributableEntry = { variant: "user", name: "你", agentId: "dev-2" };
    expect(resolveBubbleIdentity(e, isRealAgent).linkAgentId).toBeUndefined();
  });
});
