import type { AgentFramework } from "@opc/shared";
import { collectConfiguredProviderCapabilities } from "./providerRegistry.js";
import {
  probeClaudeCodeAsync,
  probeCodexAsync,
  probeNativeSubscriptionPassiveAsync,
} from "./engines/probes.js";
import {
  inferSystemFramework,
  resolveAutoSubscription,
  resolveSystemModel,
  type SystemModelChoice,
  type SystemModelKind,
} from "./systemModel.js";

type ExecutableModelChoice = Omit<SystemModelChoice, "framework"> & { framework: AgentFramework };

export interface AdaptiveModelBinding {
  choice: ExecutableModelChoice;
  source: "requested" | "system-default" | "configured-api";
  substituted: boolean;
  reason: string;
}

export interface RequestedModelBinding {
  framework?: AgentFramework;
  provider?: string;
  model?: string;
}

function usableChoice(raw: RequestedModelBinding | undefined): SystemModelChoice | undefined {
  const provider = raw?.provider?.trim();
  const model = raw?.model?.trim();
  if (!provider || !model) return undefined;
  return {
    framework: raw?.framework ?? inferSystemFramework(provider, model),
    provider,
    model,
  };
}

/**
 * Resolve a binding that can execute on this machine. It never treats a model name alone as
 * availability proof: requested/system choices pass through the same API-key/subscription
 * resolution used by real system calls, then configured API providers are considered.
 */
export async function resolveAdaptiveModelBinding(
  projectRoot: string,
  requested?: RequestedModelBinding,
  kind: SystemModelKind = "creative",
  options: { strictRequested?: boolean } = {},
): Promise<AdaptiveModelBinding> {
  const requestedChoice = usableChoice(requested);
  const systemChoice = resolveSystemModel(projectRoot, kind);
  const attempts: Array<{ choice: SystemModelChoice; source: AdaptiveModelBinding["source"] }> = [];
  if (requestedChoice) attempts.push({ choice: requestedChoice, source: "requested" });
  if (!requestedChoice || !options.strictRequested) attempts.push({ choice: systemChoice, source: "system-default" });

  const configured = collectConfiguredProviderCapabilities(projectRoot);
  if (!requestedChoice || !options.strictRequested) {
    for (const provider of configured.availableProviders) {
      const model = configured.defaultModels.get(provider);
      if (!model) continue;
      attempts.push({
        choice: { framework: "api", provider, model },
        source: "configured-api",
      });
    }
  }

  const seen = new Set<string>();
  const unavailable: string[] = [];
  for (const attempt of attempts) {
    const key = `${attempt.choice.framework}:${attempt.choice.provider}:${attempt.choice.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const outcome = await resolveAutoSubscription(attempt.choice, {
      hasProviderKey: (provider) => configured.availableProviders.has(provider),
    });
    if (outcome.kind === "unavailable" || (outcome.kind === "keep" && outcome.reason === "no-key-no-subscription")) {
      unavailable.push(`${attempt.choice.provider}/${attempt.choice.model}`);
      continue;
    }

    const resolved = outcome.choice;
    if (resolved.framework !== "api" && resolved.framework !== "hermes") {
      let availability;
      if (resolved.framework === "claude-code") availability = await probeClaudeCodeAsync();
      else if (resolved.framework === "codex") availability = await probeCodexAsync();
      else if (resolved.framework === "gemini-cli" || resolved.framework === "kimi-cli" || resolved.framework === "grok-build") {
        availability = await probeNativeSubscriptionPassiveAsync(resolved.framework);
      }
      if (!availability?.installed || !availability.loggedIn) {
        unavailable.push(`${resolved.framework}:${resolved.model}`);
        continue;
      }
    }

    return {
      choice: resolved as ExecutableModelChoice,
      source: attempt.source,
      substituted: outcome.kind === "substituted",
      reason: outcome.kind === "substituted"
        ? `${attempt.choice.provider} API 不可用，已改用 ${outcome.to} 订阅`
        : attempt.source === "requested"
          ? "使用用户或设计稿指定的可用模型"
          : attempt.source === "system-default"
            ? "复用当前已验证可用的系统模型"
            : "使用本机已配置的 API 供应商",
    };
  }

  throw new Error(
    `没有可用于新员工的模型执行方式。已检查: ${unavailable.join("、") || "未发现已配置供应商"}。` +
    "请先在「订阅」登录 CLI，或在「API」配置并测试一个供应商。",
  );
}
