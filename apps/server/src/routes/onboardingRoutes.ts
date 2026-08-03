import type { Express } from "express";
import type { EngineAvailability } from "@opc/shared";
import {
  probeClaudeCodeAsync,
  probeCodexAsync,
  probeNativeSubscriptionPassiveAsync,
} from "../runtime/engines/probes.js";

// 首跑引导第 1 步的服务端支撑:聚合探测本机三家订阅 CLI(claude-code / codex / gemini)是否安装 +
// 版本 + 登录态。定稿 2.3 明确"只测在不在与版本,禁真实模型调用"——这里只跑 `--version` 之类的
// 存在性探测(claude/codex 复用已有 async 探针,gemini 单独一条最小版本探测),绝不发起任何模型请求。
//
// 与 /api/frameworks(EngineSetupPanel 用的全量探测)分开:那个还探 Hermes、带安装/登录引导语,是
// 第 2 步"准备引擎"的数据源;这里只服务第 1 步身份页那一行"检测到哪些订阅引擎"的即时提示,口径更窄。

export type CliFramework = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

export interface CliStatusEntry {
  framework: CliFramework;
  installed: boolean;
  version: string;
  loggedIn: boolean;
}

export interface CliStatusResult {
  engines: CliStatusEntry[];
  anyInstalled: boolean;
  anyLoggedIn: boolean;
}

// 探针依赖注入:测试注入假探针即可覆盖聚合逻辑,无需真装 CLI、无需起服务、绝不打真实模型。
export interface CliStatusProbes {
  claude: () => Promise<EngineAvailability>;
  codex: () => Promise<EngineAvailability>;
  gemini: () => Promise<EngineAvailability>;
  kimi: () => Promise<EngineAvailability>;
  grok: () => Promise<EngineAvailability>;
}

// 三家并行探测 + 归一化成前端要的四字段。单个探针抛错不拖垮整体(降级为"未安装"),因为身份页
// 只是给个"检测到哪些引擎"的提示,任何一家探不出来不该让整个引导卡住。
const REAL_PROBES: CliStatusProbes = {
  claude: () => probeClaudeCodeAsync(),
  codex: () => probeCodexAsync(),
  gemini: () => probeNativeSubscriptionPassiveAsync("gemini-cli"),
  kimi: () => probeNativeSubscriptionPassiveAsync("kimi-cli"),
  grok: () => probeNativeSubscriptionPassiveAsync("grok-build"),
};

export async function collectCliStatus(probes: CliStatusProbes = REAL_PROBES): Promise<CliStatusResult> {
  const settled = await Promise.all([
    probes.claude().catch(() => null),
    probes.codex().catch(() => null),
    probes.gemini().catch(() => null),
    probes.kimi().catch(() => null),
    probes.grok().catch(() => null),
  ]);
  const frameworks: CliFramework[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];
  const engines = frameworks.map((framework, index): CliStatusEntry => {
    const availability = settled[index];
    return {
      framework,
      installed: !!availability?.installed,
      version: availability?.version ?? "",
      loggedIn: !!availability?.loggedIn,
    };
  });
  return {
    engines,
    anyInstalled: engines.some((entry) => entry.installed),
    anyLoggedIn: engines.some((entry) => entry.loggedIn),
  };
}

export function register(app: Express, _projectRoot: string) {
  app.get("/api/onboarding/cli-status", async (_req, res) => {
    try {
      res.json(await collectCliStatus());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || "cli status probe failed" });
    }
  });
}
