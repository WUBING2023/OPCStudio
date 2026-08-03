import type { AgentFramework, AgentNodeConfig, ExecutionEngine, ExecTask, ExecContext, ExecResult, EngineAvailability } from "@opc/shared";
import { probeGenericCliAsync, checkCliInstalledSync } from "./probes.js";
import { filteredSpawnEnv } from "../../security/redact.js";
import { a2aSpawnEnv } from "../a2aSdk.js";
import { resolveProviderKey } from "../providerRegistry.js";
import { getProfileForRole } from "../roleProfile.js";
import { runAcpEngine, type AcpEngineSpec, type AcpPrepared, type AcpParsedOutput } from "../acpBridge.js";

// 一份 GenericCliConfig = 一个第三方 agentic CLI 工具"怎么调"的声明式描述。GenericCliEngine 本身完全
// 不知道任何具体工具的命令行语法/输出格式——那些全部封装在 genericCliPresets.ts 的 9 份预设里。这是
// 本次"12+1 框架"扩展的核心架构决策:不给每个新工具写一整套专属 Engine(claude-code/codex 那种深度),
// 而是让"spawn 一个命令 + 传 prompt + 等退出 + 读 stdout"这个所有 CLI agent 共享的骨架只写一次。
export interface GenericCliConfig {
  framework: AgentFramework;
  command: string; // 可执行文件名,如 "gemini"/"aider"/"qwen"(不含路径,走 PATH 解析)
  // 拼真正的命令行参数数组。prompt 已经是 systemPrompt+goal 拼好的完整文本;opts.model 是节点选的模型
  // (可能为空——很多这批工具没有稳定的 --model 语义或该会话由账号默认模型决定,由各 preset 自行决定要不要用)。
  buildArgs(prompt: string, opts: { model?: string; cwd: string }): string[];
  // 需要设置的认证环境变量名。可以是:
  //   · 固定的一个/多个名字(如 amp→"AMP_API_KEY",qwen-code→["DASHSCOPE_API_KEY","OPENAI_API_KEY"]——
  //     两个候选名都塞同一个解析出的 secret,谁被 CLI 实际读到不影响正确性,是简化但无害的处理)
  //   · 一个按 provider 变化的函数(plandex:认证走"各厂商 {PROVIDER}_API_KEY",不是固定名字)
  //   · undefined = 不需要认证(如裸 generic-cli 用户自定义命令,或 open-interpreter——研究阶段未确认
  //     它的认证机制,保守不假设)
  authEnvVar?: string | string[] | ((provider: string) => string | string[]);
  // 解析 spawn 完成后的 stdout/stderr/exitCode → { content, ok, tokensUsed }。ok 是"这次调用本身是否
  // 成功"的权威判断——对 trustExitCode:false 的工具(goose/opencode/amp),这是唯一的成功信号来源,因为
  // 它们的进程退出码已知不可靠。
  parseOutput(stdout: string, stderr: string, exitCode: number | null): { content: string; ok: boolean; tokensUsed?: { prompt?: number; completion?: number; total?: number } };
  // 是否信任 exitCode==0 代表成功。true 时最终成功判定 = exitCode===0 && parsed.ok;false 时完全依赖
  // parsed.ok(exitCode 被忽略——goose #4612 即使 LLM 报错也回 0,opencode 可能在 JSON 写完前提前退出)。
  trustExitCode: boolean;
  versionProbeArgs?: string[]; // 探测"是否已安装"用的参数,默认 ["--version"]
  timeoutMs?: number;
  // spawn 前从 env 里剔除的前缀(qwen-code:CI_* 前缀的变量会让它误判 CI 环境导致行为异常)。
  stripEnvPrefixes?: string[];
  // 非密钥的额外 env var(如 goose 的 GOOSE_PROVIDER/GOOSE_MODEL、openhands 的 LLM_MODEL)——这些是
  // 配置值不是密钥,authEnvVar/resolveProviderKey 那条路径只管密钥,这里单独给一个从 node 派生的钩子。
  extraEnv?(node: { provider: string; model: string }): Record<string, string>;
  // 面向用户的已知限制/风险提示(plandex 首次需手动 sign-in、open-interpreter 会真实执行本机代码等),
  // 探测阶段原样带进 EngineAvailability.detail,供 UI 展示——不是运行时行为的一部分。
  notes?: string[];
}

function resolveAuthVarNames(config: Pick<GenericCliConfig, "authEnvVar">, provider: string): string[] {
  const v = typeof config.authEnvVar === "function" ? config.authEnvVar(provider) : config.authEnvVar;
  return v ? ([] as string[]).concat(v) : [];
}

// B4 二期:GenericCliConfig → AcpEngineSpec 的适配函数。GenericCliEngine 本身已经是配置驱动的,这里
// 只是把它原本内联在 run() 里的 spawn/parse 主路径,改写成 acpBridge.runAcpEngine 认得的声明式 spec——
// 9 份预设(genericCliPresets.ts)与裸 generic-cli 配置的形状一字不动,行为等价改写,不重新设计。
//
// 三处需要 acpBridge 新增可选能力才能等价保留的地方(均已在 acpBridge.ts 里加好,一期行为不受影响):
//   1. trustExitCode:false 的"退出码不可信"语义 → AcpParsedOutput.ignoreExitCode。
//   2. GenericCliConfig.parseOutput 需要 stderr/exitCode(如 gemini-cli 拿 exitCode 兜底判 ok)→
//      AcpEngineSpec.parseOutput 的第三个可选参数 extra。
//   3. 这批工具全部不经 stdin 喂 prompt(prompt 都在 buildArgs 里拼进 argv)→ AcpPrepared.input 改为可选,
//      这里干脆不设置,桥接层就不会碰子进程 stdin,与迁移前一致。
// exported for direct unit tests (mirrors ClaudeCodeEngine/CodexEngine 导出各自 *_SPEC 的姿势)——
// GenericCliEngine 没有单一固定的 spec 常量(9 份预设 + 裸配置各自现拼),这里导出适配函数本身,
// 让测试可以对任意 GenericCliConfig 直接调用 .prepare() 验证迁移后仍走 filteredSpawnEnv。
export function genericCliConfigToAcpSpec(config: GenericCliConfig): AcpEngineSpec {
  return {
    command: config.command,
    // 与迁移前 createEngineLogSink 的 label 取值规则一致:具名预设用 framework,裸 generic-cli 用
    // "generic-cli(实际 command)"(裸配置的 command 因节点而异,framework 本身不携带信息)。
    logLabel: config.framework === "generic-cli" ? `generic-cli(${config.command})` : config.framework,
    // 这批工具的过载/限流措辞未逐一核实过,保守少重试——同迁移前的 spawnCliWithRetry 调用点。
    retry: { overloadRetries: 1, timeoutRetries: 1 },

    prepare(node, task, ctx): AcpPrepared {
      // Pre-flight:CLI 二进制是否在 PATH 上。honest 探测——装不了就 restricted,不假装成功。
      const probeArgs = config.versionProbeArgs ?? ["--version"];
      const installCheck = checkCliInstalledSync(config.command, probeArgs);
      if (!installCheck.installed) {
        return { args: [], env: {}, timeoutMs: 0, restricted: `未检测到 ${config.command} CLI(需先安装并确保在 PATH 上)` };
      }

      // 认证:把 node.provider 对应的密钥(走与其它引擎一致的 resolveProviderKey 解析链:env
      // <PROVIDER>_API_KEY > keys/<provider>.key > config.apiKeys)注入到该工具实际读取的 env var 名下——
      // 这两者经常不是同一个名字,所以显式按 authEnvVar 写,不依赖 filteredSpawnEnv 的默认保留规则。
      const authVars = resolveAuthVarNames(config, node.provider);
      let secret: string | undefined;
      if (authVars.length > 0) {
        secret = resolveProviderKey(ctx.projectRoot, node.provider);
        if (!secret) {
          return {
            args: [], env: {}, timeoutMs: 0,
            restricted: `缺少认证:未找到 provider="${node.provider}" 对应的 API Key(${config.command} 需要环境变量 ${authVars.join(" 或 ")})`,
          };
        }
      }

      // A1-V3:按 roleProfile.envAllowlist 收紧(缺省=全放行;下方 authVars/extraEnv/A2A 的显式注入
      // 在过滤之后 assign,不受影响——只加过滤,不改注入逻辑)。
      const env = filteredSpawnEnv(node.provider, getProfileForRole(node.role).envAllowlist);
      for (const name of authVars) if (secret) env[name] = secret;
      if (config.extraEnv) Object.assign(env, config.extraEnv({ provider: node.provider, model: node.model }));
      // qwen-code:环境变量里任何 CI_* 前缀的 key(如 CI_TOKEN)会让它误判 CI 环境导致行为异常——spawn 前剔除。
      for (const prefix of config.stripEnvPrefixes ?? []) {
        for (const k of Object.keys(env)) if (k.startsWith(prefix)) delete env[k];
      }
      Object.assign(env, a2aSpawnEnv(ctx.runId, node.id));

      const promptInput = task.systemPrompt ? `${task.systemPrompt}\n\n${task.goal}` : task.goal;
      const args = config.buildArgs(promptInput, { model: node.model, cwd: ctx.workdir });
      const timeoutMs = config.timeoutMs ?? (ctx.taskTimeoutMs ? Math.max(60_000, ctx.taskTimeoutMs - 20_000) : 300_000);

      // input 故意不设置:这批工具全部通过 buildArgs 把 prompt 拼进 argv,从不经 stdin——AcpPrepared.input
      // 缺省时桥接层不碰子进程 stdin,与迁移前(spawnCliWithRetry 调用点从未传 input)行为一致。
      return { args, env, timeoutMs };
    },

    parseOutput(stdout, _onEvent, extra): AcpParsedOutput {
      const stderr = extra?.stderr ?? "";
      const exitCode = extra?.exitCode ?? null;
      let parsed: ReturnType<GenericCliConfig["parseOutput"]>;
      try {
        parsed = config.parseOutput(stdout, stderr, exitCode);
      } catch {
        // parseOutput 本身绝不应该抛,但防御性兜底——解析异常当失败处理,而不是让整个 run 崩溃。
        parsed = { content: stdout, ok: false };
      }

      const tu = parsed.tokensUsed;
      const tokens = tu
        ? { prompt: tu.prompt ?? 0, completion: tu.completion ?? 0, total: tu.total ?? ((tu.prompt ?? 0) + (tu.completion ?? 0)) }
        : { prompt: 0, completion: 0, total: 0 };

      const isError = !parsed.ok;
      return {
        content: parsed.content ?? "",
        tokens,
        // cost:恒 0 —— 这批工具各自的 JSON schema 里 USD 成本字段未逐一核实是否存在/可信,诚实地不编造。
        cost: 0,
        isError,
        errorText: isError && parsed.content?.trim() ? parsed.content.trim().slice(0, 500) : undefined,
        // trustExitCode:false → 退出码不参与成功判定,只信 parsed.ok(见文件顶部适配说明)。
        ignoreExitCode: !config.trustExitCode,
      };
    },
  };
}

// GenericCliEngine 本身可以两种方式实例化:
//   · new GenericCliEngine(preset) —— 9 个具名工具之一,preset 固定编译在 genericCliPresets.ts
//   · new GenericCliEngine() —— "generic-cli" 框架本身,preset 留空,run() 时从 node.genericCli
//     (用户在节点设置里自填的 command/args)现拼一份 ad hoc GenericCliConfig
export class GenericCliEngine implements ExecutionEngine {
  readonly framework: AgentFramework;
  constructor(private readonly preset?: GenericCliConfig) {
    this.framework = preset?.framework ?? "generic-cli";
  }

  async probe(): Promise<EngineAvailability> {
    if (!this.preset) {
      return {
        framework: "generic-cli",
        installed: true, // 无法脱离具体节点判断——运行时才知道 command 是什么
        loggedIn: true,
        version: "",
        detail: "自定义 CLI:安装状态取决于该节点「执行方式」设置里填的 command,需在节点上单独确认",
      };
    }
    return probeGenericCliAsync(this.preset);
  }

  private buildAdHocConfig(node: AgentNodeConfig): GenericCliConfig | undefined {
    const gc = node.genericCli;
    if (!gc?.command) return undefined;
    return {
      framework: "generic-cli",
      command: gc.command,
      buildArgs: (prompt) => {
        const hasPlaceholder = gc.args.some((a) => a.includes("{{PROMPT}}"));
        const args = gc.args.map((a) => a.replaceAll("{{PROMPT}}", prompt));
        return hasPlaceholder ? args : [...args, prompt];
      },
      authEnvVar: gc.authEnvVar,
      parseOutput: (stdout, _stderr, exitCode) => ({ content: stdout.trim(), ok: exitCode === 0 }),
      trustExitCode: true,
      versionProbeArgs: ["--version"],
    };
  }

  async run(node: AgentNodeConfig, task: ExecTask, ctx: ExecContext): Promise<ExecResult> {
    const t0 = Date.now();
    const config = this.preset ?? this.buildAdHocConfig(node);

    if (!config) {
      const msg = "generic-cli 节点未配置 command(在节点设置的「自定义 CLI」里填可执行文件名与参数)";
      ctx.emit("error", node.id, { message: msg, restricted: true });
      return { content: "", fileChanges: [], tokens: { prompt: 0, completion: 0, total: 0 }, cost: 0, latencyMs: Date.now() - t0, status: "restricted", error: msg };
    }

    return runAcpEngine(genericCliConfigToAcpSpec(config), node, task, ctx);
  }
}
