// WS6 · Capability Matrix（§8 Phase 5）
// 将隐式 framework enum + frameworkPolicy 升级为显式能力声明。
// 独立 dormant 模块，不改 engineRouter；Phase 5 再接入调度侧。

export type AuthMode = "api-key" | "user-cli-subscription" | "oauth" | "unknown";

export type RiskLevel = "low" | "medium" | "high";

// 单个 provider 的能力画像。字段含义见 PLAN WS6 §8。
export interface AgentCapabilities {
  provider: string;
  authMode: AuthMode;
  // 是否支持流式输出（影响 emit 模式和 UI 实时显示）
  supportsStreaming: boolean;
  // 原生文件编辑（非工具模拟）——决定是否可做 code_profile
  supportsFileEditing: boolean;
  // 可在宿主执行 shell 命令（高风险能力，riskLevel 定价）
  supportsShellExecution: boolean;
  // 结构化输出（--output-schema / StructuredOutput 工具 / JSON mode）
  supportsStructuredOutput: boolean;
  // 跨调用有状态 session（原生 memory/thread）；false = 无状态，靠 OPC context pack 补偿
  supportsStatefulSession: boolean;
  // 支持 Model Context Protocol server
  supportsMCP: boolean;
  // 原生支持 A2A 协议；false = 靠 OPC a2aBus 桥接
  supportsA2A: boolean;
  // 最适合的 role 名称列表（路由提示，非强制约束）
  recommendedRoles: string[];
  // 整体风险评级（给 profile gate 定价用）
  riskLevel: RiskLevel;
}

// 四大 provider 能力基线表。数值来自 PLAN WS6 描述 + 实测行为。
// generic-cli = 未来/未知 CLI 的保守兜底条目。
// api = OPC 内部 in-process tool-loop 引擎(ApiEngine,原 hermes 执行面的等价替代,画像照搬)。
export const CAPABILITY_TABLE: Record<string, AgentCapabilities> = {
  api: {
    provider: "api",
    authMode: "api-key",
    supportsStreaming: true,
    supportsFileEditing: false,        // 通过工具调用模拟，非原生 patch 流
    supportsShellExecution: true,      // runShell 工具(tools.ts,按角色 shellMode 拦截)
    supportsStructuredOutput: true,
    supportsStatefulSession: true,     // OPC mdMemory/context pack 注入(框架无关)
    supportsMCP: false,
    supportsA2A: true,                 // OPC a2aBus 投递（已建）
    recommendedRoles: ["ceo", "lead", "researcher", "worker"],
    riskLevel: "medium",
  },

  "claude-code": {
    provider: "claude-code",
    authMode: "user-cli-subscription",
    supportsStreaming: true,
    supportsFileEditing: true,         // 核心能力：原生 Edit/Write 工具
    supportsShellExecution: true,      // Bash 工具，全宿主权限
    supportsStructuredOutput: true,    // StructuredOutput 工具（--output-schema 等价）
    supportsStatefulSession: false,    // 每次 CLI 调用无跨 session 状态
    supportsMCP: true,
    supportsA2A: false,                // 走 OPC a2aBus 桥接，非原生
    recommendedRoles: ["ceo", "lead", "dev"],
    riskLevel: "high",                 // 文件编辑 + 全宿主 shell，最高风险
  },

  codex: {
    provider: "codex",
    authMode: "user-cli-subscription",
    supportsStreaming: true,
    supportsFileEditing: true,
    supportsShellExecution: true,      // 默认沙箱执行（风险低于 claude-code 一档）
    supportsStructuredOutput: true,    // --output-schema 原生支持
    supportsStatefulSession: false,
    supportsMCP: false,
    supportsA2A: false,
    recommendedRoles: ["dev", "worker"],
    riskLevel: "medium",               // 沙箱隔离抵消一档 shell 风险
  },

  "gemini-cli": {
    provider: "gemini-cli", authMode: "user-cli-subscription",
    supportsStreaming: true, supportsFileEditing: true, supportsShellExecution: true,
    supportsStructuredOutput: true, supportsStatefulSession: false, supportsMCP: true,
    supportsA2A: false, recommendedRoles: ["lead", "dev", "researcher"], riskLevel: "high",
  },
  "kimi-cli": {
    provider: "kimi-cli", authMode: "user-cli-subscription",
    supportsStreaming: true, supportsFileEditing: true, supportsShellExecution: true,
    supportsStructuredOutput: true, supportsStatefulSession: false, supportsMCP: false,
    supportsA2A: false, recommendedRoles: ["lead", "dev", "researcher"], riskLevel: "high",
  },
  "grok-build": {
    provider: "grok-build", authMode: "user-cli-subscription",
    supportsStreaming: true, supportsFileEditing: true, supportsShellExecution: true,
    supportsStructuredOutput: true, supportsStatefulSession: false, supportsMCP: false,
    supportsA2A: false, recommendedRoles: ["lead", "dev"], riskLevel: "high",
  },
  "generic-cli": {
    provider: "generic-cli",
    authMode: "unknown",
    supportsStreaming: false,
    supportsFileEditing: false,
    supportsShellExecution: false,
    supportsStructuredOutput: false,
    supportsStatefulSession: false,
    supportsMCP: false,
    supportsA2A: false,
    recommendedRoles: [],
    riskLevel: "low",                  // unknown = 保守兜底，能力全关
  },
};

// 各 role 的 provider 优先级（靠前优先）。
// 排序依据：核心能力匹配 + PLAN WS6 路由指南针。
const ROLE_PREFERENCE: Record<string, string[]> = {
  ceo:        ["claude-code", "api", "codex", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"],
  lead:       ["claude-code", "api", "codex", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"],
  dev:        ["codex", "claude-code", "api", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"],
  researcher: ["api", "claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"],
  worker:     ["api", "codex", "claude-code", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"],
};

// 未知 role 的默认偏好（api 优先：stateful session + A2A 最齐全）。
const DEFAULT_PREFERENCE = ["api", "claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build", "generic-cli"];

// 从 available provider 列表中为给定 role 选出最优 provider。
// available = 当前已就绪的 provider 名（由调用方通过 probeAll/providerRegistry 提供）。
// 返回 null 表示无可用 provider。
export function pickEngineForRole(role: string, available: string[]): string | null {
  if (available.length === 0) return null;
  const avail = new Set(available);
  const prefs = ROLE_PREFERENCE[role] ?? DEFAULT_PREFERENCE;
  for (const p of prefs) {
    if (avail.has(p)) return p;
  }
  // 兜底：available 中有完全陌生的 provider（非四大），直接返回第一个
  return available[0] ?? null;
}
