import { describe, it, expect } from "vitest";
import type { AgentNodeConfig, TraceEvent } from "@opc/shared";
import {
  DEFAULT_COMPANY, groupAgentsByTeam, companyMemberIds, scopeMemberIds, sameGroup,
  mergeGroupTimeline, readCitedMemories, type GroupSelection,
} from "./cockpitGroups.js";

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

describe("groupAgentsByTeam · 部门群 = lead 子树", () => {
  it("基本子树:lead + 其下非 lead 成员", () => {
    const agents = [
      agent({ id: "ceo", role: "ceo", childrenIds: ["l1"] }),
      agent({ id: "l1", role: "lead", parentId: "ceo", childrenIds: ["d1", "d2"] }),
      agent({ id: "d1", role: "dev", parentId: "l1" }),
      agent({ id: "d2", role: "test", parentId: "l1" }),
    ];
    const groups = groupAgentsByTeam(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0].leadId).toBe("l1");
    expect(groups[0].companyId).toBe(DEFAULT_COMPANY);
    expect([...groups[0].memberIds].sort()).toEqual(["d1", "d2", "l1"]);
  });

  it("嵌套 lead 自成部门,不重复计入上级部门", () => {
    const agents = [
      agent({ id: "l1", role: "lead", childrenIds: ["d1", "l2"] }),
      agent({ id: "d1", role: "dev", parentId: "l1" }),
      agent({ id: "l2", role: "lead", parentId: "l1", childrenIds: ["d2"] }),
      agent({ id: "d2", role: "dev", parentId: "l2" }),
    ];
    const groups = groupAgentsByTeam(agents);
    const g1 = groups.find((g) => g.leadId === "l1")!;
    const g2 = groups.find((g) => g.leadId === "l2")!;
    expect([...g1.memberIds].sort()).toEqual(["d1", "l1"]); // l2 子树不进 l1
    expect([...g2.memberIds].sort()).toEqual(["d2", "l2"]);
  });

  it("只有 parentId 或只有 childrenIds 单向数据都能成组(取并集)", () => {
    const onlyParent = [
      agent({ id: "l1", role: "lead" }),
      agent({ id: "d1", role: "dev", parentId: "l1" }),
    ];
    expect(groupAgentsByTeam(onlyParent)[0].memberIds.sort()).toEqual(["d1", "l1"]);
    const onlyChildren = [
      agent({ id: "l1", role: "lead", childrenIds: ["d1"] }),
      agent({ id: "d1", role: "dev" }),
    ];
    expect(groupAgentsByTeam(onlyChildren)[0].memberIds.sort()).toEqual(["d1", "l1"]);
  });

  it("环安全:互为父子不死循环", () => {
    const agents = [
      agent({ id: "l1", role: "lead", parentId: "d1", childrenIds: ["d1"] }),
      agent({ id: "d1", role: "dev", parentId: "l1", childrenIds: ["l1"] }),
    ];
    const groups = groupAgentsByTeam(agents);
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds.sort()).toEqual(["d1", "l1"]);
  });

  it("跨公司排序:先 companyId 再 leadName", () => {
    const agents = [
      agent({ id: "lb", role: "lead", name: "Beta", companyId: "co2" }),
      agent({ id: "la", role: "lead", name: "Alpha", companyId: "co1" }),
      agent({ id: "lc", role: "lead", name: "Aaa", companyId: "co2" }),
    ];
    expect(groupAgentsByTeam(agents).map((g) => g.leadId)).toEqual(["la", "lc", "lb"]);
  });
});

describe("companyMemberIds / scopeMemberIds", () => {
  const agents = [
    agent({ id: "c1ceo", role: "ceo", companyId: "co1" }),
    agent({ id: "l1", role: "lead", companyId: "co1", childrenIds: ["d1"] }),
    agent({ id: "d1", role: "dev", companyId: "co1", parentId: "l1" }),
    agent({ id: "x1", role: "dev", companyId: "co2" }),
    agent({ id: "nofield", role: "dev" }), // companyId 缺省 → default
  ];
  const teams = groupAgentsByTeam(agents);

  it("companyMemberIds 只含该公司;缺省 companyId 归 default", () => {
    expect([...companyMemberIds(agents, "co1")].sort()).toEqual(["c1ceo", "d1", "l1"]);
    expect([...companyMemberIds(agents, DEFAULT_COMPANY)]).toEqual(["nofield"]);
  });

  it("全公司群 scope 额外含 'ceo' 伪会话 id", () => {
    const sel: GroupSelection = { kind: "company", companyId: "co1", label: "" };
    const s = scopeMemberIds(sel, agents, teams);
    expect(s.has("ceo")).toBe(true);
    expect(s.has("d1")).toBe(true);
    expect(s.has("x1")).toBe(false);
  });

  it("部门群 scope = 该 lead 子树;未知 lead 退化为只含 leadId", () => {
    const sel: GroupSelection = { kind: "team", companyId: "co1", leadId: "l1", label: "" };
    expect([...scopeMemberIds(sel, agents, teams)].sort()).toEqual(["d1", "l1"]);
    const ghost: GroupSelection = { kind: "team", companyId: "co1", leadId: "ghost", label: "" };
    expect([...scopeMemberIds(ghost, agents, teams)]).toEqual(["ghost"]);
  });
});

describe("sameGroup", () => {
  it("null 与同构判断", () => {
    expect(sameGroup(null, null)).toBe(true);
    expect(sameGroup(null, { kind: "company", companyId: "a", label: "" })).toBe(false);
    expect(sameGroup({ kind: "company", companyId: "a", label: "x" }, { kind: "company", companyId: "a", label: "y" })).toBe(true);
    expect(sameGroup({ kind: "company", companyId: "a", label: "" }, { kind: "team", companyId: "a", leadId: "l", label: "" })).toBe(false);
    expect(sameGroup({ kind: "team", companyId: "a", leadId: "l1", label: "" }, { kind: "team", companyId: "a", leadId: "l2", label: "" })).toBe(false);
  });
});

describe("mergeGroupTimeline · 群消息流聚合", () => {
  const opts = { scope: new Set(["l1", "d1", "ceo"]), scopeCompanyId: "co1" };

  it("聊天类事件按发出者过滤;info 无 message 不进流", () => {
    const events = [
      ev({ type: "agent_message", agentId: "d1", timestamp: "2026-01-01T00:00:01Z", payload: { text: "hi" } }),
      ev({ type: "agent_message", agentId: "outsider", timestamp: "2026-01-01T00:00:02Z", payload: { text: "no" } }),
      ev({ type: "info", agentId: "l1", timestamp: "2026-01-01T00:00:03Z", payload: {} }),
      ev({ type: "info", agentId: "l1", timestamp: "2026-01-01T00:00:04Z", payload: { message: "note" } }),
    ];
    const items = mergeGroupTimeline(events, [], opts);
    expect(items.map((i) => i.kind)).toEqual(["chat", "chat"]);
    expect(items.every((i) => i.kind !== "chat" || (i.e.agentId && opts.scope.has(i.e.agentId)))).toBe(true);
  });

  it("review_committed:verifier 或被审 producer 任一在群内即进流", () => {
    const events = [
      ev({ type: "review_committed", agentId: "l1", timestamp: "2026-01-01T00:00:01Z", payload: { agentId: "outsider", verdict: "accepted" } }),
      ev({ type: "review_committed", agentId: "outsider", timestamp: "2026-01-01T00:00:02Z", payload: { agentId: "d1", verdict: "needs_revision" } }),
      ev({ type: "review_committed", agentId: "outsider", timestamp: "2026-01-01T00:00:03Z", payload: { agentId: "other", verdict: "failed" } }),
    ];
    const items = mergeGroupTimeline(events, [], opts);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "review")).toBe(true);
  });

  it("run 事件按 run 公司归群:其他公司剔除、未知保留、同 run 同类型去重", () => {
    const events = [
      ev({ type: "run_started", runId: "r1", timestamp: "2026-01-01T00:00:01Z" }),
      ev({ type: "run_finished", runId: "r1", timestamp: "2026-01-01T00:00:02Z", payload: { allClean: true } }),
      ev({ type: "run_finished", runId: "r1", timestamp: "2026-01-01T00:00:03Z", payload: { allClean: true } }), // 历史补录+live 双写 → 去重
      ev({ type: "run_finished", runId: "r2", timestamp: "2026-01-01T00:00:04Z" }), // 其他公司
      ev({ type: "run_finished", runId: "r3", timestamp: "2026-01-01T00:00:05Z" }), // 未知归属 → 保留
    ];
    const runCompanyOf = (runId: string) => (runId === "r1" ? "co1" : runId === "r2" ? "co2" : undefined);
    const items = mergeGroupTimeline(events, [], { ...opts, runCompanyOf });
    expect(items.map((i) => (i.kind === "local" ? "" : `${i.kind}:${i.e.runId}`))).toEqual([
      "run_started:r1", "run_finished:r1", "run_finished:r3",
    ]);
  });

  it("本地消息按会话归属过滤,并与事件按时间戳升序合并", () => {
    const events = [
      ev({ type: "agent_message", agentId: "d1", timestamp: "2026-01-01T00:00:05Z", payload: { text: "later" } }),
    ];
    const locals = [
      { agentId: "ceo", ts: "2026-01-01T00:00:01Z" },
      { agentId: "outsider", ts: "2026-01-01T00:00:02Z" },
    ];
    const items = mergeGroupTimeline(events, locals, opts);
    expect(items.map((i) => i.kind)).toEqual(["local", "chat"]);
    expect(items[0].ts < items[1].ts).toBe(true);
  });
});

describe("readCitedMemories · CEO 记忆引用溯源(项目群消息卡引用条数据)", () => {
  it("提取 memory_pack_used payload 里的 citedMemories:[{id,title}]", () => {
    const cited = readCitedMemories({
      kind: "memory_pack_used",
      citedMemories: [
        { id: "lesson-1", title: "大文件应分块处理避免超时" },
        { id: "md-agent-dev-1", title: "先写测试再交付" },
      ],
    });
    expect(cited).toEqual([
      { id: "lesson-1", title: "大文件应分块处理避免超时" },
      { id: "md-agent-dev-1", title: "先写测试再交付" },
    ]);
  });

  it("无 citedMemories / 非数组 / payload 缺省 → 空数组(不抛)", () => {
    expect(readCitedMemories(undefined)).toEqual([]);
    expect(readCitedMemories(null)).toEqual([]);
    expect(readCitedMemories({ message: "本轮 dev 使用了 1 条团队记忆" })).toEqual([]);
    expect(readCitedMemories({ citedMemories: "oops" })).toEqual([]);
  });

  it("过滤缺 id / 缺 title / 类型错误的脏项,保留合法项", () => {
    const cited = readCitedMemories({
      citedMemories: [
        { id: "ok-1", title: "有效引用" },
        { id: "", title: "空 id" },
        { id: "no-title" },
        { title: "no-id" },
        { id: 42, title: "id 非字符串" },
        "not-an-object",
      ],
    });
    expect(cited).toEqual([{ id: "ok-1", title: "有效引用" }]);
  });
});
