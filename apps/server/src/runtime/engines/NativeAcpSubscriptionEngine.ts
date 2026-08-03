import type {
  AgentFramework,
  AgentNodeConfig,
  EngineAvailability,
  ExecutionEngine,
  ExecContext,
  ExecResult,
  ExecTask,
} from "@opc/shared";
import {
  probeGeminiCliAsync,
  probeGrokBuildAsync,
  probeKimiCliAsync,
  type NativeSubscriptionFramework,
} from "./probes.js";
import { acpWorkerEnabled, runViaAcpWorker } from "./acpWorkerBackend.js";

const PROBES: Record<NativeSubscriptionFramework, () => Promise<EngineAvailability>> = {
  "gemini-cli": () => probeGeminiCliAsync(),
  "kimi-cli": () => probeKimiCliAsync(),
  "grok-build": () => probeGrokBuildAsync(),
};

/**
 * Subscription CLIs whose public, audited integration is ACP itself. Unlike Claude/Codex, these
 * engines do not yet have a separately audited legacy command parser, so ACP failure must fail
 * closed instead of silently switching protocols.
 */
export class NativeAcpSubscriptionEngine implements ExecutionEngine {
  readonly framework: AgentFramework;

  constructor(framework: NativeSubscriptionFramework) {
    this.framework = framework;
  }

  probe(): Promise<EngineAvailability> {
    return PROBES[this.framework as NativeSubscriptionFramework]();
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    if (!acpWorkerEnabled()) {
      const error = `${this.framework} 仅支持经过审计的 ACP 执行路径；OPC_ACP_WORKER 已关闭`;
      ctx.emit("error", node.id, { message: error });
      return {
        content: "",
        fileChanges: [],
        tokens: { prompt: 0, completion: 0, total: 0 },
        cost: null,
        latencyMs: 0,
        status: "restricted",
        error,
      };
    }
    return runViaAcpWorker(this.framework, node, task, ctx, {});
  }
}