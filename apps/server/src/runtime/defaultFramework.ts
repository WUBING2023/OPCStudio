import type { AgentFramework } from "@opc/shared";
import { probeClaudeCodeAsync, probeCodexAsync } from "./engines/probes.js";

// 新建员工 / 公司 / AI 架构师产出的默认执行框架解析。
//   ① 已装 claude-code 订阅  → claude-code(深度最高,优先)
//   ② 否则已装 codex 订阅    → codex
//   ③ 两者都没装             → "api"(OPC 内部 in-process API 引擎,ApiEngine)。
// 只做版本探测(claude/codex --version,零模型消耗),不发起任何模型调用。
export type InstalledProbe = () => Promise<{ installed: boolean }>;

export async function resolveDefaultFramework(
  probes: { claudeCode?: InstalledProbe; codex?: InstalledProbe } = {},
): Promise<AgentFramework> {
  const claudeCode = probes.claudeCode ?? (() => probeClaudeCodeAsync());
  const codex = probes.codex ?? (() => probeCodexAsync());
  if ((await claudeCode()).installed) return "claude-code";
  if ((await codex()).installed) return "codex";
  return "api"; // API 引擎回落(见上方 ③)
}
