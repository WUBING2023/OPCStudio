// Phase 12 T5 — 游戏公司模板：狼人杀团队（主持人 game 可见性）+ 辩论团队。
// 消费 Phase 10 可见性引擎：狼人杀团队 lead(主持人) 标 visibilityPolicy="game"，
// 导入后真实对局中夜间私聊只对狼人+主持人可见。
import type { CompanyTemplate, AgentNodeConfig } from "@opc/shared";
import { DEFAULT_MODELS } from "@opc/shared";

const BASE = {
  childrenIds: [] as string[],
  status: "idle" as const,
  currentTask: undefined,
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  costUsd: 0,
  lastAction: undefined,
  editable: true,
  deletable: true,
  enabled: true,
};

const DS = "deepseek", DM = "deepseek-v4-pro";
const MX = "minimax", MM = "MiniMax-M3";
const AN = "anthropic", AS = DEFAULT_MODELS.anthropic;

function n(id: string, name: string, role: string, parentId: string | undefined, provider: string, model: string, children: string[], extra: Partial<AgentNodeConfig> = {}): AgentNodeConfig {
  return { ...BASE, id, name, role, parentId, provider, model, childrenIds: children, ...extra } as AgentNodeConfig;
}

export const GAME_COMPANY: CompanyTemplate = {
  id: "game-studio",
  title: "游戏公司（狼人杀 + 辩论）",
  description: "一个用 AI Agent 玩社交推理与思辨游戏的公司。狼人杀团队由主持人（game 可见性）统筹，夜间私聊只对狼人+主持人可见；辩论团队做公开思辨。",
  author: "OPC Community",
  authorGitHub: "opc-studio",
  createdAt: "2026-06-16T00:00:00Z",
  tags: ["game", "werewolf", "debate", "visibility"],
  downloads: 0,
  stars: 0,
  license: "OPC-Original",
  readme: `# 游戏公司（狼人杀 + 辩论）

CEO 下设两个游戏团队，演示 OPC 的**信息可见性引擎**。

## 🐺 狼人杀团队（主持人 = game 可见性）
- **主持人**：lead 节点，visibilityPolicy="game"，对全局 omniscient（看得到所有私聊）
- **狼人 ×2**：夜间密谈，受众=狼人专属（agents:），平民看不见
- **预言家**：查验结果私密（private），仅自己与主持人可见
- **女巫**：用药决策私密
- **平民 ×2**：只能看到白天的公开发言与投票

夜间狼人私聊、预言家查验对平民**不可见**；白天发言与投票对全员公开。
这正是 Phase 10 可见性引擎要解决的信息隔离。

## 🎤 辩论团队
- **主席**：lead，主持流程并 omniscient
- **正方 ×2 / 反方 ×2**：公开陈词与自由辩论（all）
- **评委 ×2**：私密合议（agents:评委），辩手看不到打分过程

## 适用
社交推理对局、多 Agent 博弈、可见性与隐藏信息机制的演示与压测。`,
  agents: [
    n("ceo", "游戏公司 CEO", "ceo", undefined, AN, AS, ["mod", "chair"]),
    // 狼人杀团队
    n("mod", "主持人", "lead", "ceo", AN, AS, ["wolf1", "wolf2", "seer", "witch", "villager1", "villager2"], { visibilityPolicy: "game" }),
    n("wolf1", "狼人 1", "dev", "mod", DS, DM, []),
    n("wolf2", "狼人 2", "dev", "mod", DS, DM, []),
    n("seer", "预言家", "dev", "mod", AN, AS, []),
    n("witch", "女巫", "dev", "mod", MX, MM, []),
    n("villager1", "平民 1", "dev", "mod", MX, MM, []),
    n("villager2", "平民 2", "dev", "mod", MX, MM, []),
    // 辩论团队
    n("chair", "辩论主席", "lead", "ceo", AN, AS, ["pro1", "pro2", "con1", "con2", "judge1", "judge2"]),
    n("pro1", "正方一辩", "dev", "chair", AN, AS, []),
    n("pro2", "正方二辩", "dev", "chair", DS, DM, []),
    n("con1", "反方一辩", "dev", "chair", AN, AS, []),
    n("con2", "反方二辩", "dev", "chair", DS, DM, []),
    n("judge1", "评委 1", "test", "chair", AN, AS, []),
    n("judge2", "评委 2", "test", "chair", MX, MM, []),
  ],
  recommendedConfig: {
    defaultModel: DM,
    budget: { totalUsd: 6, maxTokensPerTask: 80_000 },
    permissions: { allowShell: false, allowFileWrite: false, allowWebAccess: false },
  },
};
