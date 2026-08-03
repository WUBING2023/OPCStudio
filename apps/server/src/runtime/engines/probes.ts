import { execSync, exec, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { EngineAvailability } from "@opc/shared";
import { resolveDirectCommand, evictDirectCommand } from "./executableResolver.js";
import { probeAcpModels, type AcpProbeEngine } from "../acpModelProbe.js";

const execP = promisify(exec);
const execFileP = promisify(execFile);

// PATH 找不到时按已知安装位置兜底解析引擎 CLI 的绝对路径,再直接 execFile 探测版本——不受父进程 PATH
// 格式影响(从 git-bash/msys 等非 Windows-PATH 环境启动服务端时,cmd.exe/shell 解析不了 unix 格式的
// PATH → claude/codex 明明装了也登录了却检测不到),也覆盖"桌面端装了但没加进 PATH"。先走原有 shell
// PATH 探测(PATH 正常时行为不变、最省事),失败才解析绝对路径重试。解析器已含已知安装位置兜底
// (见 executableResolver.knownInstallCandidates);解析不出绝对路径则维持原失败结论,绝不假报已装。
// 探测前先丢弃解析器里可能缓存的"未命中"负结果:探针关心的是**当前**磁盘状态,若沿用缓存,则"启动时
// 确实没装、运行中才装上"的 CLI 会被永久判为未装(除非重启进程)。缓存的正结果(绝对路径)不受影响——
// 命中后本函数直接经 shell 或绝对路径成功返回,不会走到这里。
function resolveFresh(command: string) {
  evictDirectCommand(command);
  return resolveDirectCommand(command);
}

function tryVersionSmart(command: string, versionArgs: string[] = ["--version"], timeoutMs = 8000): { ok: boolean; out: string } {
  const viaPath = tryCmd(`${command} ${versionArgs.join(" ")}`, timeoutMs);
  if (viaPath.ok) return viaPath;
  try {
    const d = resolveFresh(command);
    if (!path.isAbsolute(d.file)) return viaPath;
    const out = execFileSync(d.file, [...d.prefixArgs, ...versionArgs], { encoding: "utf-8", timeout: timeoutMs, stdio: "pipe", windowsHide: true }).toString().trim();
    return { ok: true, out };
  } catch { return viaPath; }
}

async function tryVersionSmartAsync(command: string, versionArgs: string[] = ["--version"], timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  const viaPath = await tryCmdAsync(`${command} ${versionArgs.join(" ")}`, timeoutMs);
  if (viaPath.ok) return viaPath;
  try {
    const d = resolveFresh(command);
    if (!path.isAbsolute(d.file)) return viaPath;
    const { stdout } = await execFileP(d.file, [...d.prefixArgs, ...versionArgs], { timeout: timeoutMs, windowsHide: true });
    return { ok: true, out: (stdout ?? "").toString().trim() };
  } catch { return viaPath; }
}

// Real availability probes per framework. Honest detection only — an unready framework reports
// installed/loggedIn=false so the node goes restricted instead of faking success.

function tryCmd(cmd: string, timeoutMs = 8000): { ok: boolean; out: string } {
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, stdio: "pipe" }).toString().trim();
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: (((e?.stdout || "") + (e?.stderr || "")) as string).toString().trim() };
  }
}

export function probeClaudeCode(cliConfigDir?: string): EngineAvailability {
  const v = tryVersionSmart("claude");
  const installed = v.ok;
  const version = installed ? v.out.split("\n")[0] : "";
  const dir = cliConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const loggedIn =
    installed &&
    (fs.existsSync(path.join(dir, ".credentials.json")) || fs.existsSync(path.join(dir, "credentials.json")));
  return {
    framework: "claude-code",
    installed,
    loggedIn,
    version,
    detail: !installed
      ? "未检测到 claude CLI（npm i -g @anthropic-ai/claude-code）"
      : !loggedIn
        ? "claude 未登录（在终端运行 claude 完成登录）"
        : undefined,
  };
}

export function probeCodex(cliConfigDir?: string): EngineAvailability {
  const v = tryVersionSmart("codex");
  const installed = v.ok;
  const version = installed ? v.out.split("\n")[0] : "";
  const dir = cliConfigDir || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const loggedIn = installed && fs.existsSync(path.join(dir, "auth.json"));
  return {
    framework: "codex",
    installed,
    loggedIn,
    version,
    detail: !installed
      ? "未检测到 codex CLI（npm i -g @openai/codex）"
      : !loggedIn
        ? "codex 未登录（在终端运行 codex login 完成登录）"
        : undefined,
  };
}

// ── 非阻塞 async 变体(Stage 5)─────────────────────────────────────────────
// 仅供能力报告等请求路径用,避免 execSync 阻塞 Node 事件循环(会冻结所有并发请求/SSE)。
// 引擎执行路径仍用上面的 sync 版(决定 node 是否受限,刻意不动以保已验证主链路)。
// 走 shell(同 execSync)以解析 Windows 的 claude.cmd/codex.cmd npm shim;但用 async exec 不阻塞事件循环。
async function tryCmdAsync(cmd: string, timeoutMs = 8000): Promise<{ ok: boolean; out: string }> {
  try {
    const { stdout } = await execP(cmd, { timeout: timeoutMs });
    return { ok: true, out: (stdout ?? "").toString().trim() };
  } catch (e: any) {
    return { ok: false, out: (((e?.stdout || "") + (e?.stderr || "")) as string).toString().trim() };
  }
}

export async function probeClaudeCodeAsync(cliConfigDir?: string): Promise<EngineAvailability> {
  const v = await tryVersionSmartAsync("claude");
  const installed = v.ok;
  const version = installed ? v.out.split("\n")[0] : "";
  const dir = cliConfigDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const loggedIn = installed && (fs.existsSync(path.join(dir, ".credentials.json")) || fs.existsSync(path.join(dir, "credentials.json")));
  return {
    framework: "claude-code", installed, loggedIn, version,
    detail: !installed ? "未检测到 claude CLI（npm i -g @anthropic-ai/claude-code）"
      : !loggedIn ? "claude 未登录（在终端运行 claude 完成登录）" : undefined,
  };
}

export async function probeCodexAsync(cliConfigDir?: string): Promise<EngineAvailability> {
  const v = await tryVersionSmartAsync("codex");
  const installed = v.ok;
  const version = installed ? v.out.split("\n")[0] : "";
  const dir = cliConfigDir || process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const loggedIn = installed && fs.existsSync(path.join(dir, "auth.json"));
  return {
    framework: "codex", installed, loggedIn, version,
    detail: !installed ? "未检测到 codex CLI（npm i -g @openai/codex）"
      : !loggedIn ? "codex 未登录（在终端运行 codex login 完成登录）" : undefined,
  };
}

export type NativeSubscriptionFramework = "gemini-cli" | "kimi-cli" | "grok-build";

interface NativeSubscriptionProbeSpec {
  command: string;
  engine: AcpProbeEngine;
  envVar: "GEMINI_CLI_HOME" | "KIMI_CODE_HOME" | "GROK_HOME";
  loginCommand: string;
}

const NATIVE_SUBSCRIPTION_PROBES: Record<NativeSubscriptionFramework, NativeSubscriptionProbeSpec> = {
  "gemini-cli": { command: "gemini", engine: "gemini-cli", envVar: "GEMINI_CLI_HOME", loginCommand: "gemini" },
  "kimi-cli": { command: "kimi", engine: "kimi-cli", envVar: "KIMI_CODE_HOME", loginCommand: "kimi login" },
  "grok-build": { command: "grok", engine: "grok-build", envVar: "GROK_HOME", loginCommand: "grok login" },
};

type NativeVersionProbe = (command: string) => Promise<{ ok: boolean; out: string }>;
type NativeAcpProbe = typeof probeAcpModels;
let nativeVersionProbe: NativeVersionProbe = (command) => tryVersionSmartAsync(command);
let nativeAcpProbe: NativeAcpProbe = probeAcpModels;

export function __setNativeSubscriptionProbeDepsForTest(deps: {
  version?: NativeVersionProbe;
  acp?: NativeAcpProbe;
} | null): void {
  nativeVersionProbe = deps?.version ?? ((command) => tryVersionSmartAsync(command));
  nativeAcpProbe = deps?.acp ?? probeAcpModels;
}

/**
 * Probe native subscription CLIs without treating executable presence as authentication.
 * `loggedIn` becomes true only after a real ACP initialize/authenticate/session-new handshake.
 */
export async function probeNativeSubscriptionAsync(
  framework: NativeSubscriptionFramework,
  cliConfigDir?: string,
): Promise<EngineAvailability> {
  const spec = NATIVE_SUBSCRIPTION_PROBES[framework];
  const versionProbe = await nativeVersionProbe(spec.command);
  const installed = versionProbe.ok;
  const version = installed ? versionProbe.out.split("\n")[0] : "";
  if (!installed) {
    return {
      framework: framework as EngineAvailability["framework"],
      installed: false,
      loggedIn: false,
      version,
      detail: `未检测到 ${spec.command} CLI`,
    };
  }

  // Gemini starts an interactive OAuth flow when an unauthenticated ACP client
  // launches it. Availability checks must never turn into login prompts. Its
  // credential location is stable, so fail closed before the ACP handshake.
  // The explicit /login route remains the only place allowed to launch OAuth.
  if (framework === "gemini-cli") {
    const root = path.resolve(cliConfigDir || process.env.GEMINI_CLI_HOME || os.homedir());
    if (!fs.existsSync(path.join(root, ".gemini", "oauth_creds.json"))) {
      return {
        framework,
        installed: true,
        loggedIn: false,
        version,
        detail: "Gemini is installed but no credentials were found; use the explicit login button before testing ACP",
      };
    }
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  if (cliConfigDir) env[spec.envVar] = path.resolve(cliConfigDir);
  const handshake = await nativeAcpProbe(spec.engine, {
    env,
    noCache: true,
    timeoutMs: 15_000,
  });
  const loggedIn = handshake !== null;
  return {
    framework: framework as EngineAvailability["framework"],
    installed: true,
    loggedIn,
    version,
    detail: loggedIn
      ? undefined
      : `${spec.command} 已安装，但未验证订阅登录。请运行 ${spec.loginCommand}，再通过 ACP Doctor 或刷新状态验证。`,
  };
}

/**
 * Read-only availability used by navigation, settings and model-catalog pages.
 * Native ACP startup is intentionally forbidden here: an unauthenticated CLI
 * may open a browser or terminal login flow merely because a page was viewed.
 */
export async function probeNativeSubscriptionPassiveAsync(
  framework: NativeSubscriptionFramework,
  cliConfigDir?: string,
): Promise<EngineAvailability> {
  const spec = NATIVE_SUBSCRIPTION_PROBES[framework];
  const versionProbe = await nativeVersionProbe(spec.command);
  const installed = versionProbe.ok;
  const version = installed ? versionProbe.out.split("\n")[0] : "";
  if (!installed) {
    return {
      framework: framework as EngineAvailability["framework"],
      installed: false,
      loggedIn: false,
      version,
      detail: `${spec.command} CLI was not detected`,
    };
  }

  // Gemini publishes a stable local credential location. Presence is only a
  // cached-login hint; actual execution still performs the real ACP handshake.
  if (framework === "gemini-cli") {
    const root = path.resolve(cliConfigDir || process.env.GEMINI_CLI_HOME || os.homedir());
    const loggedIn = fs.existsSync(path.join(root, ".gemini", "oauth_creds.json"));
    return {
      framework,
      installed: true,
      loggedIn,
      version,
      detail: loggedIn
        ? "Gemini credentials found; execution will still verify them through ACP"
        : "Gemini is installed but no credentials were found; status checks never launch login",
    };
  }

  return {
    framework: framework as EngineAvailability["framework"],
    installed: true,
    loggedIn: false,
    version,
    detail: `${spec.command} is installed; use explicit login or a connection test to verify authentication`,
  };
}

export const probeGeminiCliAsync = (cliConfigDir?: string) => probeNativeSubscriptionAsync("gemini-cli", cliConfigDir);
export const probeKimiCliAsync = (cliConfigDir?: string) => probeNativeSubscriptionAsync("kimi-cli", cliConfigDir);
export const probeGrokBuildAsync = (cliConfigDir?: string) => probeNativeSubscriptionAsync("grok-build", cliConfigDir);
// ── GenericCliEngine 探针(9 个第三方 CLI 预设 + 裸 generic-cli)──────────────────────────
// 这批工具绝大多数是 API Key 认证,没有"登录态文件"这个概念(唯一例外 amp 支持 OAuth,但 OPC 这次场景
// 固定走 API Key,见 genericCliPresets.ts 顶部说明)。所以这里的"loggedIn"概念改叫"认证已配置"：
// 没有 authEnvVar 要求 → 视为已就绪；有要求 → 只检查这批候选环境变量名里**任意一个**在当前进程 env 里
// 有值(这是一个全局粗粒度信号，给 /api/frameworks 的 UI 徽标用；真正决定"这次调用能不能拿到 key"的是
// GenericCliEngine.run() 里按 node.provider 现查 resolveProviderKey 的那条独立路径，两者不是一回事)。
export interface GenericCliProbeConfig {
  framework: string;
  command: string;
  versionProbeArgs?: string[];
  authEnvVar?: string | string[] | ((provider: string) => string | string[]);
  notes?: string[]; // 面向用户的已知限制/风险提示(如 plandex 首次需手动 sign-in),原样拼进 detail
}

export async function probeGenericCliAsync(config: GenericCliProbeConfig): Promise<EngineAvailability> {
  const args = config.versionProbeArgs ?? ["--version"];
  const v = await tryVersionSmartAsync(config.command, args); // 含已知安装位置兜底(gemini-cli 等)
  const installed = v.ok;
  const version = installed ? v.out.split("\n")[0] : "";
  // 全局粗粒度 authEnvVar 候选名单:function 形式的(如 plandex,按 provider 变化)探针阶段没有具体 node
  // 可算,取不到就跳过这项检查——不因为"探测不出具体是哪个 provider"就假报未认证。
  const staticVars: string[] = typeof config.authEnvVar === "function" ? [] : ([] as string[]).concat(config.authEnvVar ?? []);
  const authKnown = typeof config.authEnvVar === "function" || staticVars.length === 0;
  const loggedIn = installed && (authKnown || staticVars.some((n) => !!process.env[n]));
  const parts: string[] = [];
  if (!installed) parts.push(`未检测到 ${config.command} CLI`);
  else if (!loggedIn) parts.push(`未检测到认证环境变量(${staticVars.join(" 或 ")})`);
  if (config.notes?.length) parts.push(...config.notes);
  return {
    framework: config.framework as EngineAvailability["framework"],
    installed, loggedIn, version,
    detail: parts.length ? parts.join(" · ") : undefined,
  };
}

// 同步版本探测(仅供 GenericCliEngine.run() 的执行前 pre-flight 用,避免每次执行都额外起一次 async
// exec 往返;沿用 tryCmd 的 execSync,与 probeClaudeCode/probeCodex 的同步 pre-flight 惯例一致)。
//
// 测试seam(镜像 cliEngineBase.__setSpawnForTest 的既有约定):这批工具本机都没装,真实 execSync 探测
// 在测试环境下永远是"未安装",会在 GenericCliEngine.run() 里被 pre-flight 直接拦成 restricted,测不到
// 后面 spawn/parseOutput 的调度逻辑——所以允许测试注入一个假的安装判定,不改变生产环境行为(生产环境
// 从不调用 __setCliInstalledCheckForTest)。
type InstallChecker = (command: string, versionArgs: string[]) => { installed: boolean; version: string };
function realCheckCliInstalledSync(command: string, versionArgs: string[]): { installed: boolean; version: string } {
  const v = tryVersionSmart(command, versionArgs); // 含已知安装位置兜底:GenericCliEngine 执行前 pre-flight 不再因 PATH 异常误判未装
  return { installed: v.ok, version: v.ok ? v.out.split("\n")[0] : "" };
}
let installCheckImpl: InstallChecker = realCheckCliInstalledSync;
export function __setCliInstalledCheckForTest(fn: InstallChecker | null) {
  installCheckImpl = fn ?? realCheckCliInstalledSync;
}
export function checkCliInstalledSync(command: string, versionArgs: string[] = ["--version"]): { installed: boolean; version: string } {
  return installCheckImpl(command, versionArgs);
}
