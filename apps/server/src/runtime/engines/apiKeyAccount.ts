import type { AgentFramework, ProviderAccount } from "@opc/shared";

// CLI 订阅框架(claude-code/codex)的"API Key 模式"账号解析。两个框架的机制**不对称**:
//
// · claude-code(简化后,2026-07):不再要求一个专属 configDir 绑定的"Claude Code API Key 账号"——
//   官方文档写明 claude 的 Anthropic 认证只认 ANTHROPIC_API_KEY 环境变量(spawn 时现注入,见
//   ClaudeCodeEngine.ts),完全不看 configDir 里有没有登录态。既然如此,没必要为它单独建一份"看起来
//   像订阅账号、实则只是个 key 载体"的账号记录——用户在 Anthropic 供应商下(哪怕是 Hermes 在用的那个)
//   随便配的任意一个持有 apiKey 的账号都可以直接复用。用户须显式选择 claudeCodeUseApiKey=true(节点
//   设置里的"使用 API Key"开关)才生效;默认走订阅登录,避免静默把免费订阅切成按量计费的 API 调用。
//
// · codex:认证完全靠 configDir 里手动 `codex login --with-api-key` 持久化下来的登录态,没有"每次
//   spawn 传 key"这种机制——它的 API Key 模式账号仍然需要一个专属 configDir 当身份锚点,按 configDir
//   精确匹配(未变)。
export function resolveApiKeyOverride(
  accounts: ProviderAccount[],
  framework: AgentFramework | undefined,
  cliConfigDir: string | undefined,
  claudeCodeUseApiKey?: boolean,
): string | undefined {
  if (framework === "claude-code") {
    if (!claudeCodeUseApiKey) return undefined;
    const acct = accounts.find((a) => a.providerId === "anthropic" && a.enabled !== false && !!a.apiKey);
    return acct?.apiKey || undefined;
  }
  if (framework !== "codex") return undefined;
  if (!cliConfigDir) return undefined;
  const acct = accounts.find((a) => a.configDir === cliConfigDir);
  return acct?.apiKey || undefined;
}
