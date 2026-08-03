import type { AgentMessage, MessageAudience } from "@opc/shared";

// Phase 12 T5 — 游戏对局引擎，消费 Phase 10 可见性引擎。
// 这些函数只产出**带受众标注的消息序列**（确定性、不依赖 LLM），用来证明
// 信息隔离在一整局游戏里成立：狼人夜聊只有狼人+主持人可见、预言家查验私密、
// 白天发言全员公开；辩论则公开陈词 + 评委私密合议。真实对局接 startRun 时，
// 各 agent 只会被喂到 visibleMessagesFor(它) 的消息——隔离由同一套受众规则保证。

const BASE_TS = Date.UTC(2026, 5, 20, 12, 0, 0); // 固定基准，使对局可复现/可测试

function mkMsg(i: number, from: string, text: string, audience: MessageAudience, phase: string): AgentMessage {
  return {
    id: `m${i}`,
    from,
    text,
    timestamp: new Date(BASE_TS + i * 1000).toISOString(),
    visibility: { audience, phase },
  };
}

// ── 狼人杀 ────────────────────────────────────────────────────────────
export interface WerewolfRoster {
  moderatorId: string;   // 主持人（lead，omniscient 主持人）
  wolves: string[];      // 狼人
  seerId?: string;       // 预言家
  witchId?: string;      // 女巫
  villagers: string[];   // 平民
}

export interface GameRound {
  messages: AgentMessage[];
  omniscient: string[];  // 喂给 visibility 引擎的 omniscient 名单（主持人）
}

// 跑通一局狼人杀的一个昼夜循环，产出带受众的消息序列。
export function playWerewolfRound(r: WerewolfRoster): GameRound {
  const msgs: AgentMessage[] = [];
  let i = 0;
  const wolvesAudience: MessageAudience = `agents:${r.wolves.join(",")}`;
  const target = r.villagers[0] ?? "村民";

  // 夜晚
  msgs.push(mkMsg(i++, r.moderatorId, "天黑请闭眼。狼人请睁眼，确认你的同伴并选择今晚的目标。", "all", "night"));
  for (const w of r.wolves) {
    msgs.push(mkMsg(i++, w, `（狼人密谈）我提议今晚刀 ${target}。`, wolvesAudience, "night"));
  }
  if (r.seerId) {
    msgs.push(mkMsg(i++, r.seerId, `（预言家查验）我查验 ${r.wolves[0]}，结果是狼人。`, "private", "night"));
  }
  if (r.witchId) {
    msgs.push(mkMsg(i++, r.witchId, `（女巫）我手里还有一瓶解药和一瓶毒药，今晚先观望。`, "private", "night"));
  }

  // 白天
  msgs.push(mkMsg(i++, r.moderatorId, `天亮了。昨晚 ${target} 倒下了。现在进入发言环节。`, "all", "day"));
  const alive = [...r.wolves, ...(r.seerId ? [r.seerId] : []), ...(r.witchId ? [r.witchId] : []), ...r.villagers.slice(1)];
  for (const p of alive) {
    msgs.push(mkMsg(i++, p, "（公开发言）我说说我的判断和投票倾向。", "all", "day"));
  }
  for (const p of alive) {
    msgs.push(mkMsg(i++, p, `（投票）我投 ${r.wolves[0]}。`, "all", "day"));
  }
  msgs.push(mkMsg(i++, r.moderatorId, "投票结束，进入下一个夜晚。", "all", "day"));

  return { messages: msgs, omniscient: [r.moderatorId] };
}

// ── 辩论 ──────────────────────────────────────────────────────────────
export interface DebateRoster {
  chairId: string;     // 主席（lead，omniscient）
  pro: string[];       // 正方
  con: string[];       // 反方
  judges: string[];    // 评委
}

// 跑通一场辩论：公开陈词 + 评委私密合议（辩手看不到评委打分）。
export function playDebateRound(r: DebateRoster): GameRound {
  const msgs: AgentMessage[] = [];
  let i = 0;
  const judgesAudience: MessageAudience = `agents:${r.judges.join(",")}`;

  msgs.push(mkMsg(i++, r.chairId, "本场辩题：AI 是否会取代初级程序员。正方先开篇立论。", "all", "opening"));
  for (const p of r.pro) msgs.push(mkMsg(i++, p, "（正方陈词）我方认为……论据如下。", "all", "statement"));
  for (const c of r.con) msgs.push(mkMsg(i++, c, "（反方陈词）我方反驳……论据如下。", "all", "statement"));
  msgs.push(mkMsg(i++, r.chairId, "自由辩论环节开始。", "all", "free"));
  for (const p of [...r.pro, ...r.con]) msgs.push(mkMsg(i++, p, "（自由辩论）针对对方观点回应。", "all", "free"));
  // 评委私密合议：辩手不可见
  for (const j of r.judges) msgs.push(mkMsg(i++, j, "（评委合议）我给正方逻辑 8 分、反方表达 7 分。", judgesAudience, "scoring"));
  msgs.push(mkMsg(i++, r.chairId, "综合评委意见，本场正方胜出。", "all", "result"));

  return { messages: msgs, omniscient: [r.chairId] };
}
