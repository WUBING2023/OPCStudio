import { describe, it, expect } from "vitest";
import type { AgentNodeConfig } from "@opc/shared";
import { playWerewolfRound, playDebateRound } from "./games.js";
import { filterVisible } from "./visibility.js";

// 用游戏公司的狼人杀团队 roster 跑通一局，证明可见性隔离成立。
type Lite = Pick<AgentNodeConfig, "id" | "role" | "parentId">;

// 主持人=lead，其余玩家都挂在主持人下（一个团队）
const WW_AGENTS: Lite[] = [
  { id: "mod", role: "lead", parentId: "ceo" },
  { id: "wolf1", role: "dev", parentId: "mod" },
  { id: "wolf2", role: "dev", parentId: "mod" },
  { id: "seer", role: "dev", parentId: "mod" },
  { id: "witch", role: "dev", parentId: "mod" },
  { id: "villager1", role: "dev", parentId: "mod" },
  { id: "villager2", role: "dev", parentId: "mod" },
];

const ROSTER = {
  moderatorId: "mod",
  wolves: ["wolf1", "wolf2"],
  seerId: "seer",
  witchId: "witch",
  villagers: ["villager1", "villager2"],
};

describe("狼人杀：按可见性跑通一局", () => {
  const { messages, omniscient } = playWerewolfRound(ROSTER);

  it("产出完整的昼夜消息序列", () => {
    expect(messages.length).toBeGreaterThan(8);
    expect(messages.some(m => m.visibility.phase === "night")).toBe(true);
    expect(messages.some(m => m.visibility.phase === "day")).toBe(true);
  });

  it("平民看不到狼人夜聊，也看不到预言家/女巫的私密行动", () => {
    const seen = filterVisible("villager2", messages, WW_AGENTS, { omniscient });
    // 狼人密谈（agents:wolf1,wolf2）对平民不可见
    expect(seen.some(m => m.from === "wolf1" && m.visibility.phase === "night")).toBe(false);
    expect(seen.some(m => m.from === "wolf2" && m.visibility.phase === "night")).toBe(false);
    // 预言家查验 / 女巫用药（private）对平民不可见（白天的公开发言另算，故按 private 受众判定）
    expect(seen.some(m => m.from === "seer" && m.visibility.audience === "private")).toBe(false);
    expect(seen.some(m => m.from === "witch" && m.visibility.audience === "private")).toBe(false);
    // 但白天的公开发言/投票/主持人播报可见
    expect(seen.some(m => m.from === "mod" && m.visibility.audience === "all")).toBe(true);
    expect(seen.some(m => m.visibility.phase === "day" && m.visibility.audience === "all")).toBe(true);
  });

  it("狼人能看到彼此的夜聊，但看不到预言家的私密查验", () => {
    const seen = filterVisible("wolf2", messages, WW_AGENTS, { omniscient });
    expect(seen.some(m => m.from === "wolf1" && m.visibility.phase === "night")).toBe(true); // 同伴夜聊
    expect(seen.some(m => m.from === "wolf2" && m.visibility.phase === "night")).toBe(true); // 自己
    expect(seen.some(m => m.from === "seer" && m.visibility.audience === "private")).toBe(false); // 预言家私密查验
  });

  it("预言家能看到自己的查验，但看不到狼人夜聊", () => {
    const seen = filterVisible("seer", messages, WW_AGENTS, { omniscient });
    expect(seen.some(m => m.from === "seer")).toBe(true);
    expect(seen.some(m => m.from === "wolf1" && m.visibility.phase === "night")).toBe(false);
  });

  it("主持人（omniscient）看得到全部消息——包括所有私聊", () => {
    const seen = filterVisible("mod", messages, WW_AGENTS, { omniscient });
    expect(seen.length).toBe(messages.length);
    expect(seen.some(m => m.from === "wolf1" && m.visibility.phase === "night")).toBe(true);
    expect(seen.some(m => m.from === "seer")).toBe(true);
    expect(seen.some(m => m.from === "witch")).toBe(true);
  });

  it("若没有 omniscient 主持人，狼人夜聊对非狼人（含 lead）一律不可见（fail-closed）", () => {
    const seenByModNoOmni = filterVisible("mod", messages, WW_AGENTS); // 不传 omniscient
    expect(seenByModNoOmni.some(m => m.from === "wolf1" && m.visibility.phase === "night")).toBe(false);
    expect(seenByModNoOmni.some(m => m.from === "seer" && m.visibility.audience === "private")).toBe(false);
  });
});

describe("辩论：公开陈词 + 评委私密合议", () => {
  const DBT_AGENTS: Lite[] = [
    { id: "chair", role: "lead", parentId: "ceo" },
    { id: "pro1", role: "dev", parentId: "chair" },
    { id: "con1", role: "dev", parentId: "chair" },
    { id: "judge1", role: "test", parentId: "chair" },
    { id: "judge2", role: "test", parentId: "chair" },
  ];
  const { messages, omniscient } = playDebateRound({
    chairId: "chair", pro: ["pro1"], con: ["con1"], judges: ["judge1", "judge2"],
  });

  it("辩手能看到公开陈词，但看不到评委合议", () => {
    const seen = filterVisible("pro1", messages, DBT_AGENTS, { omniscient });
    expect(seen.some(m => m.visibility.phase === "statement")).toBe(true);
    expect(seen.some(m => m.visibility.phase === "scoring")).toBe(false); // 评委合议不可见
  });

  it("评委之间能看到彼此的合议", () => {
    const seen = filterVisible("judge2", messages, DBT_AGENTS, { omniscient });
    expect(seen.some(m => m.from === "judge1" && m.visibility.phase === "scoring")).toBe(true);
  });
});
