import type {
  AgentFramework,
  AgentNodeConfig,
  CapabilityReport,
  EngineAvailability,
  ProviderAccount,
  SuggestedTeamMember,
} from "@opc/shared";
import { effEngineForMode, type TeamMode } from "./workerRuntime.js";

export const SUBSCRIPTION_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);

export function normalizeExecutionFramework(framework?: string): string {
  return !framework || framework === "hermes" ? "api" : framework;
}

export function effectiveExecutionTarget(
  agent: Pick<AgentNodeConfig, "role" | "framework" | "provider">,
  teamMode?: TeamMode,
): { framework: string; provider: string } {
  const override = effEngineForMode(agent.role, teamMode);
  return {
    framework: override?.framework ?? normalizeExecutionFramework(agent.framework),
    provider: override?.provider ?? agent.provider,
  };
}

export function isProbeReady(availability: EngineAvailability | undefined | null): boolean {
  return availability?.installed === true && availability.loggedIn === true;
}

export function readinessByAgent(report: CapabilityReport | undefined | null): Map<string, SuggestedTeamMember> {
  return new Map((report?.suggestedTeam ?? []).map((member) => [member.agentId, member]));
}

function accountMatches(account: ProviderAccount, provider: string, framework: string): boolean {
  return account.enabled
    && account.providerId === provider
    && (!account.frameworks || account.frameworks.includes(framework as AgentFramework));
}

/** Worker fallback consumes the same per-agent readiness produced by capability preflight. */
export function isAgentExecutable(
  agent: AgentNodeConfig,
  teamMode: TeamMode | undefined,
  report: CapabilityReport | undefined | null,
  accounts: ProviderAccount[],
): boolean {
  const reported = readinessByAgent(report).get(agent.id);
  if (reported) return reported.readyToRun;
  const target = effectiveExecutionTarget(agent, teamMode);
  return accounts.some((account) => accountMatches(account, target.provider, target.framework));
}

/**
 * AccountPool models concurrency leases, not authentication truth. A ready global CLI login has
 * no persisted account row, so materialize an in-memory lease carrier for this run only.
 */
export function withGlobalCliSubscriptionAccounts(
  accounts: ProviderAccount[],
  report: CapabilityReport | undefined | null,
): ProviderAccount[] {
  const result = [...accounts];
  for (const member of report?.suggestedTeam ?? []) {
    if (!member.readyToRun || !SUBSCRIPTION_FRAMEWORKS.has(member.framework)) continue;
    const alreadyHasGlobalCarrier = result.some((account) =>
      accountMatches(account, member.provider, member.framework) && !account.configDir,
    );
    if (alreadyHasGlobalCarrier) continue;
    result.push({
      id: `global-cli#${member.framework}#${member.provider}`,
      providerId: member.provider,
      label: `Global ${member.framework} subscription`,
      apiKey: "",
      frameworks: [member.framework as AgentFramework],
      enabled: true,
      maxConcurrent: 5,
    });
  }
  return result;
}
