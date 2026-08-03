// 相1 · ACP 引擎适配注册表(首发两家:claude-code / codex)。
// 每个引擎 = 一份"怎么 spawn 这个 ACP agent 子进程"的声明式描述(command/args/env/shell)。AcpClient
// 本身完全不知道具体某家 CLI 的包名或安全档——只按 AcpEngineSpec 起进程、接 ndjson 双向流。
//
// 探针报告《相0.5-ACP探针报告.md》关键事实落到 env 变换里(不得偏离):
//  #4 claude-code 致命坑:子进程 env 必须删除 CLAUDECODE,否则触发 adapter 的嵌套会话自杀守卫
//      (session/new 报 -32603)。
//  #3 codex 安全档:INITIAL_AGENT_MODE=read-only 禁命令执行/写盘(首发 text-only 足够)。
//  #5 订阅模式纪律 + IRON RULE:环境里绝不设 OPENAI_API_KEY/CODEX_API_KEY(一旦存在 codex 会切到
//      api-key 计费模式);这里对 codex 主动 delete 掉继承来的这两个变量,强制走 ~/.codex 订阅登录。
//  #6 进程卫生:adapter 会起孙进程(codex app-server),清理须按 PID 树杀(taskkill /T)。
import { spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReasoningEffort } from "@opc/shared";

export type AcpEngineId = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

// Windows:定位 git-bash 的 bash.exe。claude-code(claude-agent-sdk)在 Win 上需要 git-bash 才能起会话——
// 找不到会在 init 直接失败("Claude Code on Windows requires git-bash")→ 从非原生 shell(如 git-bash 自身、
// 或 PATH 被改写的子进程)启动时尤其容易踩。优先已有的 CLAUDE_CODE_GIT_BASH_PATH,否则从 PATH 里的 Git
// 目录推导 <Git>\bin\bash.exe(正则同时吃 \ 与 /,故 unix 格式 PATH 也能命中),再退回常见安装路径兜底。
// 纯文件探测,绝不起子进程,绝不写死单机绝对路径。返回绝对路径或 null。镜像 server 侧 globalDoctor
// .detectGitBashPath(两层分别为执行面与体检面,不跨包耦合)。
export function resolveWinGitBashPath(env: NodeJS.ProcessEnv): string | null {
  if (process.platform !== "win32") return null;
  const cands: string[] = [];
  const envp = env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (envp) cands.push(envp);
  const rawPath = env.PATH ?? env.Path ?? "";
  for (const seg of rawPath.split(/[;:](?=[^\\/])|;/)) { // 兼容 win(;)与 git-bash(:) 分隔;避免切断盘符冒号
    const m = seg.trim().match(/^(.*[\\/]Git)[\\/](cmd|bin|mingw64[\\/]bin)[\\/]?$/i);
    if (m) cands.push(path.join(m[1], "bin", "bash.exe"));
  }
  cands.push("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c; } catch { /* */ } }
  return null;
}

export const ACP_ENGINE_IDS: readonly AcpEngineId[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];

export function isAcpEngineId(v: string): v is AcpEngineId {
  return (ACP_ENGINE_IDS as readonly string[]).includes(v);
}

/** 一次 spawn 一个 ACP agent 子进程所需的全部信息(纯数据,便于单测直接断言 env 变换)。 */
export interface AcpEngineSpec {
  id: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Windows 上 spawn .cmd(npx.cmd)需要 shell:true;测试里的 node fixture 用 false。 */
  shell: boolean;
}

// 一旦出现即把 codex 切到 api-key 计费模式的变量——订阅引擎必须确保它们缺席。
const SUBSCRIPTION_FORBIDDEN_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"] as const;

// codex reasoning effort。相0.5 活体握手 dump 实测:codex 会话默认 reasoning effort = xhigh
// (currentModelId=gpt-5.5[xhigh])——对"问答/对话"是巨大过量(实测单问 ~60s,而 claude 暖响应 ~2s)。
// codex-acp 支持 CODEX_CONFIG(JSON,合并进 codex 会话配置),故:
//   · 对话会话(chatServe 传 chat:true)默认把 model_reasoning_effort 降到 low(活体握手验证:session/new 的
//     reasoning_effort.currentValue → low,零模型消耗);
//   · 员工/系统模型显式选了档位(reasoningEffort:low|medium|high|xhigh)时,以其为准注入——对话与任务链皆然;
//   · 未显式且非对话(一次性任务执行链,acpWorkerRunner 不传 chat 且该员工未设档)→ 不注入,保留引擎深推理默认。
// 尊重更高优先级的显式配置:CODEX_CONFIG 里已显式写了 model_reasoning_effort 时一律不覆盖(仅合并进缺省档,保留其余键)。
const CODEX_EFFORTS = new Set<string>(["minimal", "low", "medium", "high", "xhigh"]);
const DEFAULT_CODEX_CHAT_EFFORT = "low";

// 解析本次 spawn 期望的 codex reasoning effort;返回 undefined = 不注入(保留引擎默认)。
// 优先级:显式 reasoningEffort(员工/系统模型设置) > 对话场景 env OPC_CODEX_CHAT_EFFORT > 对话默认 low;
// 非对话且无显式设置 → undefined。
function resolveCodexEffort(env: NodeJS.ProcessEnv, opts: { chat?: boolean; reasoningEffort?: string }): string | undefined {
  if (opts.reasoningEffort && CODEX_EFFORTS.has(opts.reasoningEffort)) return opts.reasoningEffort;
  if (opts.chat) {
    const override = env.OPC_CODEX_CHAT_EFFORT;
    return override && CODEX_EFFORTS.has(override) ? override : DEFAULT_CODEX_CHAT_EFFORT;
  }
  return undefined;
}

// 在 env 副本上就地写入 CODEX_CONFIG.model_reasoning_effort。绝不改传入的 env 对象——调用方在拷贝后才调本函数;
// JSON.parse 生成全新对象,无共享引用。已显式写该键 → 一律尊重不覆盖(仅合并进缺省档,保留其余键)。
function applyCodexReasoningEffort(env: NodeJS.ProcessEnv, effort: string): void {
  const existing = env.CODEX_CONFIG;
  if (existing) {
    let parsed: unknown;
    try { parsed = JSON.parse(existing); } catch { return; } // 非法 CODEX_CONFIG:原样保留,不误改
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const obj = parsed as Record<string, unknown>;
    if (obj.model_reasoning_effort) return; // 已显式指定 effort → 尊重,不覆盖
    obj.model_reasoning_effort = effort;
    env.CODEX_CONFIG = JSON.stringify(obj);
    return;
  }
  env.CODEX_CONFIG = JSON.stringify({ model_reasoning_effort: effort });
}

interface NpxLaunch { command: string; prefixArgs: string[]; shell: boolean }

function npxLaunch(env: NodeJS.ProcessEnv): NpxLaunch {
  const node = env.OPC_NODE_EXECUTABLE?.trim();
  const npxCli = env.OPC_NPX_CLI?.trim();
  if (node || npxCli) {
    if (!node || !npxCli || !path.isAbsolute(node) || !path.isAbsolute(npxCli) || !fs.existsSync(node) || !fs.existsSync(npxCli)) {
      throw new Error("packaged npx runtime is incomplete");
    }
    return { command: node, prefixArgs: [npxCli], shell: false };
  }
  return { command: process.platform === "win32" ? "npx.cmd" : "npx", prefixArgs: [], shell: process.platform === "win32" };
}

/**
 * 组装某引擎的 spawn 规格。env 从 opts.env(缺省 process.env)浅拷贝后按引擎安全档变换——
 * 绝不原地改传入的 env 对象,也绝不注入任何 *_API_KEY。
 * opts.chat=true:对话/一次性文本场景(chatServe 常驻会话),codex 会注入低时延 reasoning effort 默认(见上);
 * 缺省 false 用于任务执行链,保留引擎原深推理默认。
 * opts.reasoningEffort:员工/系统模型显式选定的推理档位(low|medium|high|xhigh),两大订阅引擎均据此注入:
 * codex → CODEX_CONFIG.model_reasoning_effort;claude-code → CLAUDE_CODE_EFFORT_LEVEL(SDK/CLI 原生读取)。
 * opts.cliConfigDir:该员工/租约选定的订阅账号隔离登录目录(多账号池)。注入 CLAUDE_CONFIG_DIR(claude-code)/
 * CODEX_HOME(codex),让 ACP 路径真用选定账号的凭证执行——此前只有 legacy CLI-spawn 路径注入
 * (ClaudeCodeEngine/CodexEngine),默认 ACP 路径会静默落回全局登录=账本记了 A 号、实际跑的 B 号。
 */
export function buildEngineSpec(
  engine: AcpEngineId,
  opts: { env?: NodeJS.ProcessEnv; chat?: boolean; reasoningEffort?: ReasoningEffort; cliConfigDir?: string } = {},
): AcpEngineSpec {
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  switch (engine) {
    case "claude-code": {
      const npx = npxLaunch(env);
      // claude-code(Zed adapter → @anthropic-ai/claude-agent-sdk)支持具名推理档:claude CLI 2.1.x 起有
      // low/medium/high/xhigh 四档,SDK 直接读 process.env.CLAUDE_CODE_EFFORT_LEVEL(cli.js UA7()),与 OPC
      // ReasoningEffort 枚举 1:1。adapter 继承本 env → SDK 读取 → 生效(已核 adapter 0.16.2 + sdk 0.2.44 + 二进制)。
      if (opts.reasoningEffort) env.CLAUDE_CODE_EFFORT_LEVEL = opts.reasoningEffort;
      if (opts.cliConfigDir) env.CLAUDE_CONFIG_DIR = opts.cliConfigDir; // 多账号:选定账号的隔离登录目录
      // Windows git-bash 发现:未显式设 CLAUDE_CODE_GIT_BASH_PATH 时探测并注入,否则 claude-agent-sdk 会在
      // init 直接失败(no_response)。找不到不硬失败——保留原生错误让上层 acpWorkerRunner 归类为明确诊断。
      if (process.platform === "win32" && !env.CLAUDE_CODE_GIT_BASH_PATH) {
        const gb = resolveWinGitBashPath(env);
        if (gb) env.CLAUDE_CODE_GIT_BASH_PATH = gb;
      }
      delete env.CLAUDECODE; // 探针 #4:不删会触发嵌套会话自杀守卫
      // 原生订阅与 GLM Coding Plan 均不应继承普通 Anthropic API Key；GLM 使用专门的 AUTH_TOKEN。
      delete env.ANTHROPIC_API_KEY;
      return { id: engine, command: npx.command, args: [...npx.prefixArgs, "-y", "@zed-industries/claude-code-acp"], env, shell: npx.shell };
    }
    case "codex": {
      const npx = npxLaunch(env);
      env.INITIAL_AGENT_MODE = "read-only"; // 探针 #3:禁命令执行/写盘
      for (const k of SUBSCRIPTION_FORBIDDEN_ENV) delete env[k]; // 探针 #5 + IRON RULE:强制订阅模式
      const effort = resolveCodexEffort(env, opts); // 显式档位 > 对话默认 low > 不注入(任务链保留深推理默认)
      if (effort) applyCodexReasoningEffort(env, effort);
      if (opts.cliConfigDir) env.CODEX_HOME = opts.cliConfigDir; // 多账号:选定账号的隔离登录目录
      return { id: engine, command: npx.command, args: [...npx.prefixArgs, "-y", "@agentclientprotocol/codex-acp"], env, shell: npx.shell };
    }
    case "gemini-cli": {
      const npx = npxLaunch(env);
      delete env.GEMINI_API_KEY;
      delete env.GOOGLE_API_KEY;
      if (opts.cliConfigDir) env.GEMINI_CLI_HOME = opts.cliConfigDir;
      return { id: engine, command: npx.command, args: [...npx.prefixArgs, "-y", "@google/gemini-cli", "--acp"], env, shell: npx.shell };
    }
    case "kimi-cli": {
      delete env.KIMI_API_KEY;
      delete env.MOONSHOT_API_KEY;
      if (opts.cliConfigDir) env.KIMI_CODE_HOME = opts.cliConfigDir;
      return { id: engine, command: "kimi", args: ["acp"], env, shell: false };
    }
    case "grok-build": {
      delete env.XAI_API_KEY;
      if (opts.cliConfigDir) env.GROK_HOME = opts.cliConfigDir;
      return { id: engine, command: "grok", args: ["agent", "stdio"], env, shell: false };
    }
    default: {
      const _exhaustive: never = engine;
      throw new Error(`unknown ACP engine: ${String(_exhaustive)}`);
    }
  }
}

/**
 * 按 PID 树清理子进程(探针 #6:adapter 会起孙进程)。best-effort,绝不抛。
 * win32 用 taskkill /T /F 杀整棵树;POSIX 上子进程以 detached 起(自成进程组),用负 pid 杀进程组,
 * 失败再退回 child.kill。
 */
export function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    }
  } catch { /* best-effort */ }
}
