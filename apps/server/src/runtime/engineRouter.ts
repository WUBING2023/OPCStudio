import type {
  AgentFramework,
  AgentNodeConfig,
  EngineAvailability,
  ExecutionEngine,
  NativeExecutionFailureKind,
  NativeExecutionPreference,
} from "@opc/shared";
import { resolveFeatureFlag } from "@opc/shared";
import { ApiEngine } from "./engines/ApiEngine.js";
import { ClaudeCodeEngine } from "./engines/ClaudeCodeEngine.js";
import { CodexEngine } from "./engines/CodexEngine.js";
import { NativeAcpSubscriptionEngine } from "./engines/NativeAcpSubscriptionEngine.js";
import { GenericCliEngine } from "./engines/GenericCliEngine.js";
import { GENERIC_CLI_PRESETS } from "./engines/genericCliPresets.js";
import { CAPABILITY_TABLE, pickEngineForRole, type AgentCapabilities } from "./agentCapabilities.js";
import { isRateLimited, makeCooldownKey } from "./rateLimitCooldown.js";
import {
  CapabilityBlockedEngine,
  CodexNativeEngine,
  NativeFallbackEngine,
  NativeRouteFallbackEngine,
} from "./engines/CodexNativeEngine.js";
import { ClaudeNativeEngine } from "./engines/ClaudeNativeEngine.js";
import {
  probeNativeSubscriptionPassiveAsync,
  type NativeSubscriptionFramework,
} from "./engines/probes.js";

const engines = new Map<AgentFramework, ExecutionEngine>();

// 引擎策略:Claude→claude-code、GPT→codex、其余全部→api(OPC 内部 in-process tool-loop,ApiEngine)。
// 2026-07:扩展 12+1 CLI 框架——9 个新预设(gemini-cli…open-interpreter)全部经 GenericCliEngine 驱动
// (见 genericCliPresets.ts),generic-cli 本身是同一引擎的"裸"配置(读节点自己填的 command/参数模板)。
export const ALL_FRAMEWORKS: AgentFramework[] = [
  "api", "claude-code", "codex",
  "gemini-cli", "kimi-cli", "grok-build", "qwen-code", "opencode", "aider", "goose", "openhands",
  "amp", "plandex", "open-interpreter", "generic-cli",
];

// 读侧 alias 归一:历史 framework 值 "hermes"(存量 agents.json / 旧模板节点,永不批量改写)与缺省
// (无 framework 字段的老节点)一律归一为 "api"。运行时数据不经 zod parse(loadAgents 裸 readJSON),
// 这里是路由层的最后一道归一关口——绝不让存量 hermes 节点落进"未知框架 → restricted"。
export function normalizeFramework(framework?: AgentFramework | string | null): AgentFramework {
  if (!framework || framework === "hermes") return "api";
  return framework as AgentFramework;
}

// D2: 订阅版 CLI（claude-code / codex）对全角色开放——worker 也可选。封号风险不靠"按角色禁用"缓解，
// 而是由账号池硬限流（CLI 账号 maxConcurrent=1 + 调度退避抖动，见 pool/accountPool + scheduler）兜底。
// 注意:新增的 9 个 GenericCliEngine 预设是 API Key 认证(非订阅账号登录),不属于这类"订阅并发限流"
// 治理对象——它们的并发上限走普通 account.maxConcurrent(与 api/API 供应商一致),此表刻意不收录它们。
export const CLI_FRAMEWORKS: AgentFramework[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];

export function initEngineRouter() {
  engines.set("api", new ApiEngine());
  engines.set("claude-code", new ClaudeCodeEngine());
  engines.set("codex", new CodexEngine());
  for (const [framework, preset] of Object.entries(GENERIC_CLI_PRESETS)) {
    if (framework === "gemini-cli") continue;
    engines.set(framework as AgentFramework, new GenericCliEngine(preset));
  }
  engines.set("gemini-cli", new NativeAcpSubscriptionEngine("gemini-cli"));
  engines.set("kimi-cli", new NativeAcpSubscriptionEngine("kimi-cli"));
  engines.set("grok-build", new NativeAcpSubscriptionEngine("grok-build"));
  engines.set("generic-cli", new GenericCliEngine()); // 裸配置:preset 留空,运行时读 node.genericCli
}

// Policy gate: may this node run on its chosen framework? All roles may use any framework now;
// the only block is an unknown framework id. Returns a reason (not a throw) so the caller can
// produce an honest restricted result.
// WS6 集成:某框架的能力画像(provider/authMode/支持能力/风险等级)。供 frameworkPolicy 标注风险、
// FrameworkSelector 展示、未来跨引擎路由参考。加性,不改引擎选择。
export function capabilityFor(framework?: AgentFramework): AgentCapabilities | undefined {
  return CAPABILITY_TABLE[normalizeFramework(framework)];
}

export function frameworkPolicy(node: Pick<AgentNodeConfig, "framework" | "role">): { allowed: boolean; reason?: string; riskLevel?: AgentCapabilities["riskLevel"] } {
  const fw = normalizeFramework(node.framework);
  if (!ALL_FRAMEWORKS.includes(fw)) {
    return { allowed: false, reason: `未知执行框架 ${fw}` };
  }
  return { allowed: true, riskLevel: capabilityFor(fw)?.riskLevel };
}

// Availability of all 4 frameworks (installed / loggedIn / version) for the FrameworkSelector.
export async function probeAll(): Promise<EngineAvailability[]> {
  if (engines.size === 0) initEngineRouter();
  const out: EngineAvailability[] = [];
  for (const fw of ALL_FRAMEWORKS) {
    const e = engines.get(fw);
    if (!e) continue;
    if (fw === "gemini-cli" || fw === "kimi-cli" || fw === "grok-build") {
      out.push(await probeNativeSubscriptionPassiveAsync(fw as NativeSubscriptionFramework));
      continue;
    }
    out.push(await e.probe());
  }
  return out;
}

// Pick the execution engine for a node's framework; defaults to "api"(缺省与历史 "hermes" 值都经
// normalizeFramework 归一到 ApiEngine,老 agents.json 节点的安全网). Lazily
// initializes so callers work even if initEngineRouter() wasn't called at startup.
export function getEngine(framework?: AgentFramework): ExecutionEngine {
  if (engines.size === 0) initEngineRouter();
  const e = engines.get(normalizeFramework(framework)) ?? engines.get("api");
  if (!e) throw new Error(`No engine registered for framework: ${framework}`);
  return e;
}

// 限流冷却备用引擎链:撞限流的模型冷却期内,临时改用这里第一个"未在冷却"的便宜引擎。
// 复用 synthesizeWithFallback 既有的 api+deepseek-chat 兜底约定;deepseek 自身订阅压力小、且有独立熔断器。
const FALLBACK_CHAIN: Array<{ framework: AgentFramework; provider: string; model: string }> = [
  { framework: "api", provider: "deepseek", model: "deepseek-chat" },
];

// 给一个正在冷却的 primaryKey 选备用引擎:跳过自己、跳过同样在冷却的;都不可用则 null(主模型照常跑,诚实失败)。
export function pickFallbackEngine(
  primaryKey: string,
  now = Date.now(),
  isAvailable: (candidate: { framework: AgentFramework; provider: string; model: string }) => boolean = () => true,
): { framework: AgentFramework; provider: string; model: string } | null {
  for (const fb of FALLBACK_CHAIN) {
    const k = makeCooldownKey(fb.framework, fb.provider, fb.model);
    if (k === primaryKey) continue;
    if (isRateLimited(k, now)) continue;
    if (!isAvailable(fb)) continue;
    return fb;
  }
  return null;
}

// 引擎路由决策结构:实际使用的引擎 + capability 驱动的理想选择(供 emit/trace 观测)。
// 当前阶段 chosenProvider 始终等于 normalizeFramework(framework)(缺省/历史 hermes 归一 api);
// capabilityMatch=false 是未来跨引擎路由的"gap 标志",现在只记录不行动。
export interface RouteDecision {
  engine: ExecutionEngine;
  chosenProvider: string;        // 实际执行框架
  idealProvider: string | null;  // pickEngineForRole 对该 role 的最优建议
  riskLevel: AgentCapabilities["riskLevel"] | undefined;
  nativeExecution?: {
    requested: NativeExecutionPreference["preference"];
    selected: "acp" | "codex-native" | "claude-native" | "blocked";
    reason?: string;
    failureKind?: NativeExecutionFailureKind;
  };
  capabilityMatch: boolean;      // chosen == ideal → 已最优;false → 未来切引擎的信号
}

// Capability-aware dispatch:返回实际引擎 + 路由元数据。
// 绝不改变实际引擎选择(行为零变更);所有错误静默降级,不抛。
const NATIVE_FEATURE_VERSION = "0.1.0";

function nativeFlagEnabled(name: "OPC_CODEX_NATIVE_ADAPTER" | "OPC_CLAUDE_NATIVE_ADAPTER"): boolean {
  return resolveFeatureFlag(name, {
    currentVersion: NATIVE_FEATURE_VERSION,
    environment: process.env,
  });
}

function nativeBlockedOrFallback(input: {
  base: RouteDecision;
  preference: NativeExecutionPreference;
  reason: string;
  failureKind: NativeExecutionFailureKind;
}): RouteDecision {
  if (input.preference.fallback === "acp") {
    return {
      ...input.base,
      engine: new NativeRouteFallbackEngine(input.base.engine, input.reason, input.failureKind),
      nativeExecution: {
        requested: input.preference.preference,
        selected: "acp",
        reason: input.reason,
        failureKind: input.failureKind,
      },
    };
  }
  return {
    ...input.base,
    engine: new CapabilityBlockedEngine(
      input.base.engine.framework,
      input.reason,
      input.failureKind,
    ),
    nativeExecution: {
      requested: input.preference.preference,
      selected: "blocked",
      reason: input.reason,
      failureKind: input.failureKind,
    },
  };
}

export function routeEngine(
  framework?: AgentFramework,
  role?: string,
  nativePreference: NativeExecutionPreference = { preference: "acp", fallback: "acp" },
): RouteDecision {
  const chosenProvider = normalizeFramework(framework);
  let idealProvider: string | null = chosenProvider; // 安全兜底
  try {
    const picked = pickEngineForRole(role ?? "worker", ALL_FRAMEWORKS as string[]);
    if (picked !== null) idealProvider = picked;
  } catch {
    // 兜底:pickEngineForRole 异常极罕见;保守降级为"已是最优"
  }
  const riskLevel = capabilityFor(framework)?.riskLevel;
  const engine = getEngine(framework);
  const base: RouteDecision = {
    engine,
    chosenProvider,
    idealProvider,
    riskLevel,
    capabilityMatch: idealProvider === null || idealProvider === chosenProvider,
  };
  if (nativePreference.preference === "acp") return base;

  if (nativePreference.preference === "claude-native") {
    if (chosenProvider !== "claude-code") {
      return nativeBlockedOrFallback({
        base,
        preference: nativePreference,
        reason: `Claude native execution requires framework claude-code, received ${chosenProvider}`,
        failureKind: "capability_unavailable",
      });
    }
    if (!nativeFlagEnabled("OPC_CLAUDE_NATIVE_ADAPTER")) {
      return nativeBlockedOrFallback({
        base,
        preference: nativePreference,
        reason: "Claude native execution is disabled by OPC_CLAUDE_NATIVE_ADAPTER",
        failureKind: "feature_disabled",
      });
    }
    const native = new ClaudeNativeEngine();
    return {
      ...base,
      engine: nativePreference.fallback === "acp" ? new NativeFallbackEngine(native, base.engine) : native,
      nativeExecution: { requested: "claude-native", selected: "claude-native" },
    };
  }
  if (chosenProvider !== "codex") {
    return nativeBlockedOrFallback({
      base,
      preference: nativePreference,
      reason: `Codex native execution requires framework codex, received ${chosenProvider}`,
      failureKind: "capability_unavailable",
    });
  }
  if (!nativeFlagEnabled("OPC_CODEX_NATIVE_ADAPTER")) {
    return nativeBlockedOrFallback({
      base,
      preference: nativePreference,
      reason: "Codex native execution is disabled by OPC_CODEX_NATIVE_ADAPTER",
      failureKind: "feature_disabled",
    });
  }

  const native = new CodexNativeEngine();
  return {
    ...base,
    engine: nativePreference.fallback === "acp" ? new NativeFallbackEngine(native, base.engine) : native,
    nativeExecution: { requested: "codex-native", selected: "codex-native" },
  };
}
