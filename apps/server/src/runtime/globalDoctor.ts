import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import * as os from "node:os";
import { createRequire } from "node:module";
import type { AgentNodeConfig, Company, EngineAvailability, McpServerConfig } from "@opc/shared";
import { validateAgentWorkingDirectory } from "@opc/shared";
import { readJSON, writeJSON } from "../storage/jsonFile.js";
import { loadAgents } from "../storage/projectStore.js";
import { loadProviders } from "../storage/providerStore.js";
import { listMcpServers } from "../storage/mcpStore.js";
import { loadCompanies } from "../storage/companyStore.js";
import { companyRootDir } from "./workspace.js";
import { validateWorkspaceFolder, type FolderCheck } from "./workspaceGuard.js";
import { syncProvidersFromStore, isProviderAvailable, resolveProviderKey, PRESET_BASE_URLS } from "./providerRegistry.js";
import { resolveSystemModel, resolveAutoSubscription, PROVIDER_SUBSCRIPTION_FALLBACK, type SystemModelKind } from "./systemModel.js";
import { probeClaudeCodeAsync, probeCodexAsync, probeNativeSubscriptionPassiveAsync, probeGenericCliAsync } from "./engines/probes.js";
import { GENERIC_CLI_PRESETS } from "./engines/genericCliPresets.js";
import { probeHealth, type McpHealthStatus } from "./mcpGovernance.js";

// Track E · E2 Global Doctor(指南 §8):运行环境体检的统一入口,聚合既有零散探针
// (engines/probes、providerRegistry、mcpGovernance.probeHealth)产出 doctor.json。
// 与 Template Doctor(templateDoctor.ts,模板导入安检)边界:这里体检"本机/当前配置能不能健康运行",
// 不体检任何一份模板内容。
// - basic 层:快、不打外网。文件系统/JSON store 写删探测、引擎安装态(只探被启用 agent 实际使用的
//   framework,带超时)、provider key 配置态(只查"有没有注册成功",绝不读 key 值)、MCP 配置可解析、
//   systemModel 指向的 provider 是否已注册(活体验证抓到的真实故障:creative/judge 指向未注册
//   provider → mission 创建直接不可用,这类配置漂移就是 Basic Doctor 该抓的)。
// - capability 层:可选、慢、打外网。provider 真实连通性(同 providerRoutes /api/providers/test 的
//   最小对话探测思路)+ MCP server 可连性(mcpGovernance.probeHealth)。
// - deep 层(E5,指南 §8.3 Deep Doctor):"用户手动点击或失败后运行"的最全面一层,在 basic+capability
//   之上再加 7 类此前完全没有探针的检查——端口占用(只读 TCP 连接探测,绝不 kill 任何进程)、残留
//   worktree 子进程(当前代码库无 pid registry,如实标注跳过,留好将来接入的 seam)、Node/tsx/esbuild
//   深度运行依赖工具链、.opc 关键文件写锁、比 basic 更深的 store 文件抽查解析、worktree 根目录可写、
//   社区 registry 可达(短超时,失败时复用 E2 的大陆网络合规措辞,不用"翻墙"等表述)。
// 结果落盘 .opc/doctor-reports/<timestamp>.json + latest.json;所有检查绝不抛,单项失败只记进 checks。

export type DoctorLevel = "basic" | "capability" | "deep";
export type DoctorCheckStatus = "ok" | "failed" | "skipped";
export type DoctorSeverity = "info" | "warning" | "error";

export interface DoctorCheck {
  id: string;
  name: string;
  status: DoctorCheckStatus;
  severity: DoctorSeverity;
  message: string;
}

export interface DoctorReport {
  status: "ok" | "warning" | "error";
  checked_at: string;
  level: DoctorLevel;
  checks: DoctorCheck[];
}

export interface ProviderConnectivityTarget {
  provider: string;
  apiFormat: "openai" | "anthropic";
  baseUrl: string;
}

// 依赖注入 seam(测试用):默认走真实探针;单测注入 fake 以覆盖 ok/degraded 两路,不打外网、不依赖本机装了什么。
export interface DoctorDeps {
  probeEngine?: (framework: string, cliConfigDir?: string) => Promise<EngineAvailability | null>;
  syncProviders?: (projectRoot: string) => void;
  providerRegistered?: (provider: string) => boolean;
  testProviderConnectivity?: (projectRoot: string, target: ProviderConnectivityTarget) => Promise<{ ok: boolean; message: string }>;
  probeMcp?: (servers: McpServerConfig[]) => Promise<Record<string, McpHealthStatus>>;
  // MUP A#4 · 公司 workspace root 体检探针 seam(默认走 workspaceGuard.validateWorkspaceFolder 同一口径;
  // 单测注入 fake 覆盖 ok/failed/needsInit 三路,不依赖真实磁盘状态)。
  checkWorkspaceFolder?: (projectRoot: string, folder: string) => FolderCheck;
  now?: () => Date;
  // deep 层新增(E5)探针 seam——单测靠这些注入 fake,不真占端口/不真起进程/不打外网。
  checkPortOccupancy?: (port: number, host?: string) => Promise<boolean | null>; // true=占用 false=空闲 null=无法判定(超时/异常)
  checkOrphanWorktreeProcesses?: () => { hasRegistry: boolean; orphans: string[] };
  resolveModule?: (id: string) => string | null;
  checkFileLock?: (file: string) => { ok: boolean; message: string };
  fetchCommunityRegistryReachable?: () => Promise<{ ok: boolean; message: string }>;
  // 审计 P1-4:真实 provider 文件工具 canary(仅 deep 层执行,低成本真实调用)——经真实 CLI/ACP 在隔离目录 write/
  // read/delete,由 Core 核对文件是否真落盘。globalDoctor 本身绝不起子进程;实现从 doctorRoutes 注入(providerToolCanaryReal)。
  // 未注入/非 deep → provider.tool_canary 判 not_tested,绝不据宿主检查判 provider 可用。
  providerToolCanary?: (framework: string) => Promise<{ ok: boolean; detail: string } | null>;
}

const ENGINE_PROBE_TIMEOUT_MS = Number(process.env.OPC_DOCTOR_ENGINE_PROBE_TIMEOUT_MS ?? 2500);
const CONNECTIVITY_TIMEOUT_MS = Number(process.env.OPC_DOCTOR_CONNECTIVITY_TIMEOUT_MS ?? 15_000);
// CLI 订阅制框架无 provider key(与 engineRouter.CLI_FRAMEWORKS 同口径,本地常量避免 import 巨型模块)。
const CLI_FRAMEWORKS = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);
// 引擎安装态体检只覆盖这三个订阅(用户实测反馈:API 面与第三方 CLI 如 opencode 不应出现在体检报告里)。
// api(含历史 alias "hermes",存量数据未改写)是 API 面(体检由 provider key 解析检查负责),9 家第三方
// CLI 未做过活体验证、也不是订阅制,一并移出报告。探针代码(defaultProbeEngine 各分支)保留,只是体检不再枚举它们。
const DOCTOR_ENGINE_WHITELIST = new Set(["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"]);

// ── deep 层(E5)常量 ─────────────────────────────────────────────────────────
const PORT_PROBE_TIMEOUT_MS = Number(process.env.OPC_DOCTOR_PORT_PROBE_TIMEOUT_MS ?? 800);
const COMMUNITY_REGISTRY_TIMEOUT_MS = Number(process.env.OPC_DOCTOR_COMMUNITY_TIMEOUT_MS ?? 3000);
// 与 communityRoutes.ts 的 DEFAULT_COMMUNITY_REPO 同一个仓库(硬编码,董事长决策②同款理由)。
const COMMUNITY_REGISTRY_URL = "https://api.github.com/repos/WUBING2023/opc-studio-community";
const DEEP_KEY_PORTS: Array<{ port: number; label: string }> = [
  { port: 3100, label: "server API" },
  { port: 5173, label: "web(Vite dev)" },
];
const DEEP_LOCK_FILES = ["config.json", "agents.json"];
const DEEP_STORE_FILES = ["config.json", "agents.json", "mcp_servers.json", "providers.json"];
const DOCTOR_MIN_NODE_MAJOR = 18;
const requireFromHere = createRequire(import.meta.url);

function doctorDir(projectRoot: string) {
  return path.join(projectRoot, ".opc", "doctor-reports");
}

// ── 默认探针实现 ──────────────────────────────────────────────────────────────

// 引擎探针:同 capabilityReport.probeFramework 的路由(该函数未导出,这里保持独立小实现),
// 超时返回 null → 上层记 skipped,不把"探测慢"误报成"没装"。
async function defaultProbeEngine(framework: string, cliConfigDir?: string): Promise<EngineAvailability | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ENGINE_PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  const probe = async (): Promise<EngineAvailability | null> => {
    try {
      if (framework === "api" || framework === "hermes") return { framework: "api", installed: true, loggedIn: true, version: "in-process" } as EngineAvailability;
      if (framework === "claude-code") return await probeClaudeCodeAsync(cliConfigDir);
      if (framework === "codex") return await probeCodexAsync(cliConfigDir);
      if (framework === "gemini-cli" || framework === "kimi-cli" || framework === "grok-build") {
        return await probeNativeSubscriptionPassiveAsync(framework, cliConfigDir);
      }
      const preset = (GENERIC_CLI_PRESETS as Record<string, any>)[framework];
      if (preset) return await probeGenericCliAsync(preset);
      if (framework === "generic-cli") {
        return { framework: "generic-cli", installed: true, loggedIn: true, version: "", detail: "自定义 CLI:安装状态取决于各节点自填的 command" } as EngineAvailability;
      }
      return { framework, installed: false, loggedIn: false, version: "", detail: `未知引擎 ${framework}` } as EngineAvailability;
    } catch {
      return { framework, installed: false, loggedIn: false, version: "", detail: `${framework} 探测失败` } as EngineAvailability;
    }
  };
  try {
    return await Promise.race([probe(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// provider 真实连通性(capability 层):同 providerRoutes /api/providers/test 的最小请求思路
// (openai 兼容 → POST /chat/completions;anthropic → POST /messages),max_tokens=1 把成本压到最低。
// key 走 resolveProviderKey 完整解析链;响应/报错文本绝不包含 key。
async function defaultTestProviderConnectivity(projectRoot: string, target: ProviderConnectivityTarget): Promise<{ ok: boolean; message: string }> {
  const t0 = Date.now();
  try {
    const apiKey = resolveProviderKey(projectRoot, target.provider) ?? "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    let url: string;
    if (target.apiFormat === "anthropic") {
      url = `${target.baseUrl}/messages`;
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else {
      url = `${target.baseUrl}/chat/completions`;
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
    const body = JSON.stringify({ model: "default", messages: [{ role: "user", content: "ping" }], max_tokens: 1 });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTIVITY_TIMEOUT_MS);
    try {
      const resp = await fetch(url, { method: "POST", headers, body, signal: controller.signal });
      const latency = Date.now() - t0;
      // 能拿到 HTTP 响应(哪怕 4xx,如 model 名不对)= 网络可达且服务在线;5xx/网络错才算不通。
      if (resp.status < 500) return { ok: true, message: `HTTP ${resp.status} · ${latency}ms` };
      return { ok: false, message: `HTTP ${resp.status} · ${latency}ms` };
    } finally {
      clearTimeout(timer);
    }
  } catch (e: any) {
    return { ok: false, message: `${e?.name === "AbortError" ? `超时(${CONNECTIVITY_TIMEOUT_MS}ms)` : (e?.message ?? String(e))}` };
  }
}

// 端口占用(deep 层):纯只读 TCP 连接探测——connect 成功即销毁探测用的 socket,绝不发送任何数据、
// 绝不涉及进程枚举/kill。connect 成功→占用;ECONNREFUSED→空闲;超时/其它错误→无法判定(null,
// 不误报成"空闲"或"占用")。
function defaultCheckPortOccupancy(port: number, host = "127.0.0.1"): Promise<boolean | null> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean | null) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(null));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      finish(err?.code === "ECONNREFUSED" ? false : null);
    });
    try {
      socket.connect(port, host);
    } catch {
      finish(null);
    }
  });
}

// tsx/esbuild 等深度运行依赖是否可解析:createRequire 相对本文件(apps/server/src/runtime)解析,
// 不 import 实际模块内容(避免执行其副作用),只探"能不能找到"。
function defaultResolveModule(id: string): string | null {
  try {
    return requireFromHere.resolve(id);
  } catch {
    return null;
  }
}

// 文件锁(deep 层):以 "r+" 打开已存在文件立即关闭——能拿到句柄说明当前没有独占锁(杀软扫描/其它
// 进程持有独占句柄时 Windows 上会 EBUSY/EPERM)。文件不存在视为通过(没有可检测对象,不算问题)。
function defaultCheckFileLock(file: string): { ok: boolean; message: string } {
  if (!fs.existsSync(file)) return { ok: true, message: "文件不存在,跳过" };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r+");
    return { ok: true, message: "可获取写锁" };
  } catch (e: any) {
    return { ok: false, message: e?.message ?? String(e) };
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* 已关闭/已消失,不影响判定 */ } }
  }
}

// 社区 registry 可达(deep 层):HEAD 请求 + 短超时,不下载任何内容。能拿到 HTTP 响应(哪怕 4xx)
// 就算网络可达;5xx/超时/网络错才算不通,message 里给出可复用的大陆网络合规提示(同 E2 措辞)。
async function defaultFetchCommunityRegistryReachable(): Promise<{ ok: boolean; message: string }> {
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COMMUNITY_REGISTRY_TIMEOUT_MS);
  try {
    const resp = await fetch(COMMUNITY_REGISTRY_URL, { method: "HEAD", signal: controller.signal, headers: { "User-Agent": "OPC-Studio" } });
    const latency = Date.now() - t0;
    if (resp.status < 500) return { ok: true, message: `HTTP ${resp.status} · ${latency}ms` };
    return { ok: false, message: `HTTP ${resp.status} · ${latency}ms` };
  } catch (e: any) {
    return { ok: false, message: e?.name === "AbortError" ? `超时(${COMMUNITY_REGISTRY_TIMEOUT_MS}ms)` : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

// ── 单项检查(全部绝不抛)────────────────────────────────────────────────────

function safeCheck(id: string, name: string, severity: DoctorSeverity, fn: () => DoctorCheck): DoctorCheck {
  try {
    return fn();
  } catch (e: any) {
    return { id, name, status: "failed", severity, message: e?.message ?? String(e) };
  }
}

// JSON store 可读写:writeJSON/readJSON 真实往返一个探测文件再删除(不碰任何业务 store)。
function checkJsonStore(projectRoot: string): DoctorCheck {
  const id = "store.json_rw";
  const name = "JSON 存储可读写";
  return safeCheck(id, name, "error", () => {
    const probe = path.join(projectRoot, ".opc", `doctor-probe-${process.pid}.json`);
    const nonce = `doctor-${Date.now()}`;
    writeJSON(probe, { nonce });
    const back = readJSON<{ nonce?: string }>(probe, {});
    try { fs.rmSync(probe, { force: true }); } catch { /* 清理失败不影响判定 */ }
    if (back.nonce !== nonce) {
      return { id, name, status: "failed", severity: "error", message: "写入 .opc 后读回内容不一致" };
    }
    return { id, name, status: "ok", severity: "error", message: ".opc JSON 读写往返正常" };
  });
}

function checkDirWritable(id: string, name: string, dir: string): DoctorCheck {
  return safeCheck(id, name, "error", () => {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-probe-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.rmSync(probe, { force: true });
    return { id, name, status: "ok", severity: "error", message: `${dir} 可写` };
  });
}

// G4 · 自动定位 git-bash(Windows):优先 CLAUDE_CODE_GIT_BASH_PATH env,否则从 PATH 里的 git 目录推导
// <Git>\bin\bash.exe,再退回常见安装路径。**纯文件探测,绝不起任何子进程**(doctor 只探不改)。返回绝对路径或 null。
export function detectGitBashPath(): string | null {
  const cands: string[] = [];
  const envp = process.env.CLAUDE_CODE_GIT_BASH_PATH?.trim();
  if (envp) cands.push(envp);
  for (const seg of (process.env.PATH ?? "").split(path.delimiter)) {
    const m = seg.trim().match(/^(.*[\\/]Git)[\\/](cmd|bin|mingw64[\\/]bin)[\\/]?$/i); // …\Git\cmd | …\Git\bin → …\Git\bin\bash.exe
    if (m) cands.push(path.join(m[1], "bin", "bash.exe"));
  }
  cands.push("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* */ } }
  return null;
}

// G4 + 审计修复(P1-4)· Provider 执行环境 canary(纯函数,deps 可注入以便单测)。三层严格区分,绝不用宿主检查冒充
// provider 可用:
//  1) host.fs_canary —— 宿主 Node 进程在临时目录 write/read/delete 往返。【只证宿主 FS】,不代表 provider 的文件工具
//     可用(如 claude-code 自己的 Write 在本机返回 ok=false 时,宿主 fs canary 仍会过)。
//  2) provider.claude_code_gitbash —— cc-CLI/ACP 的 Windows git-bash 前置(缺失=cc provider 不可用+修复指引)。
//  3) provider.tool_canary —— 让【真实 provider】在隔离目录 write/read/delete 再由 Core 核对(经注入的 providerToolCanary)。
//     未注入/未执行 = 【not_tested】(skipped),**绝不据宿主检查判 provider 可用**。deep 级可注入低成本真实调用。
export function checkProviderEnvironment(
  usesCliFramework: boolean,
  env: {
    platform: string; gitBashPath?: string; tmpDir: string; detectGitBash: () => string | null;
    // 审计 P1-4:真实 provider 文件工具 canary(经真实 CLI/ACP 在隔离目录跑 write/read/delete,Core 核对)。
    // 未提供 → provider.tool_canary 判 not_tested(skipped),绝不判 provider 可用。deep 级可注入。
    providerToolCanary?: () => { ok: boolean; detail: string } | null;
  },
): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  out.push(safeCheck("host.fs_canary", "宿主文件读写 canary", "error", () => {
    const id = "host.fs_canary", name = "宿主文件读写 canary";
    const dir = fs.mkdtempSync(path.join(env.tmpDir, "opc-canary-"));
    let step = "mkdtemp";
    try {
      const f = path.join(dir, "canary.txt");
      const nonce = `canary-${process.pid}-${Date.now()}`;
      step = "write"; fs.writeFileSync(f, nonce, "utf-8");
      step = "read"; const back = fs.readFileSync(f, "utf-8");
      if (back !== nonce) return { id, name, status: "failed", severity: "error", message: "宿主临时目录写后读回不一致(write/read canary 失败)" };
      step = "delete"; fs.rmSync(f, { force: true });
      if (fs.existsSync(f)) return { id, name, status: "failed", severity: "error", message: "宿主临时目录删除后文件仍在(delete canary 失败)" };
      return { id, name, status: "ok", severity: "error", message: "宿主 Node 进程临时目录 write/read/delete 往返正常(【仅宿主】,不代表 provider 文件工具可用——见 provider.tool_canary)" };
    } catch (e: any) {
      return { id, name, status: "failed", severity: "error", message: `宿主文件 canary 在 ${step} 步失败:${e?.message ?? String(e)}` };
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } }
  }));
  if (usesCliFramework && /^win/i.test(env.platform)) {
    out.push(safeCheck("provider.claude_code_gitbash", "Claude Code / ACP git-bash 前置", "warning", () => {
      const id = "provider.claude_code_gitbash", name = "Claude Code / ACP git-bash 前置";
      const configured = env.gitBashPath && (() => { try { return fs.existsSync(env.gitBashPath!); } catch { return false; } })() ? env.gitBashPath! : null;
      const detected = configured ?? env.detectGitBash();
      if (!detected) {
        return { id, name, status: "failed", severity: "warning", message: "Windows 下 claude-code/codex(ACP)需要 git-bash,但未检测到 → cc-CLI provider 不可用(ACP 握手会报 'requires git-bash')。请设 CLAUDE_CODE_GIT_BASH_PATH 指向 <Git>\\bin\\bash.exe" };
      }
      return { id, name, status: "ok", severity: "warning", message: `git-bash 就绪(${detected})${configured ? "" : "——自动定位;建议显式设 CLAUDE_CODE_GIT_BASH_PATH 固化"}` };
    }));
  }
  // 审计 P1-4 · provider.tool_canary:让【真实 provider】在隔离目录 write/read/delete 由 Core 核对——【绝不用宿主 fs
  // canary 冒充 provider 可用】。未注入真实 canary(基础级/无 deep 真调用能力)→ not_tested(skipped),绝不判可用。
  if (usesCliFramework) {
    out.push(safeCheck("provider.tool_canary", "Provider 文件工具 canary(真实 CLI)", "warning", () => {
      const id = "provider.tool_canary", name = "Provider 文件工具 canary(真实 CLI)";
      const r = env.providerToolCanary?.();
      if (!r) {
        return { id, name, status: "skipped", severity: "info", message: "not_tested:未执行真实 provider 文件工具 canary(需 deep 级 + 真实 CLI/ACP 调用能力)。**宿主 host.fs_canary 通过 ≠ provider 写盘可用**(如 claude-code Write 在本机返回 ok=false),绝不据此判 provider 可用" };
      }
      return r.ok
        ? { id, name, status: "ok", severity: "warning", message: `真实 provider 文件工具 canary 通过:${r.detail}` }
        : { id, name, status: "failed", severity: "error", message: `真实 provider 文件工具 canary 失败(provider 写盘不可用,不伪装可用):${r.detail}` };
    }));
  }
  return out;
}

// MCP 配置可解析:直接读原始文件 JSON.parse(listMcpServers 的 readJSON 会把损坏文件静默回退成 [],
// 体检要的恰恰是把"损坏"暴露出来)。未配置视为正常。
function checkMcpConfig(projectRoot: string): DoctorCheck {
  const id = "mcp.config";
  const name = "MCP 配置可解析";
  return safeCheck(id, name, "warning", () => {
    const p = path.join(projectRoot, ".opc", "mcp_servers.json");
    if (!fs.existsSync(p)) {
      return { id, name, status: "ok", severity: "warning", message: "未配置 MCP server(mcp_servers.json 不存在)" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(p, "utf-8"));
    } catch (e: any) {
      return { id, name, status: "failed", severity: "warning", message: `mcp_servers.json 解析失败:${e?.message ?? String(e)}` };
    }
    if (!Array.isArray(parsed)) {
      return { id, name, status: "failed", severity: "warning", message: "mcp_servers.json 不是数组(格式损坏)" };
    }
    return { id, name, status: "ok", severity: "warning", message: `MCP 配置可解析(${parsed.length} 个 server)` };
  });
}

// MUP Gate A#4 · 逐公司 workspace root 体检:绑定目录(company.folder)复用 workspaceGuard 的
// validateWorkspaceFolder 同一判定口径(存在/目录/允许根/可写探针/磁盘 + git 状态如实报告),
// 目录被删/失权/丢 .git 不再等起跑 fail-fast 才发现;未绑定公司对默认沙箱 companyRootDir 只做
// 轻量判定(尚未创建 = 正常,首次起跑自动初始化,不误报)。只读探测,绝不初始化/修复任何目录。
function checkCompanyWorkspaces(projectRoot: string, validate: (root: string, folder: string) => FolderCheck): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let companies: Company[] = [];
  try { companies = loadCompanies(projectRoot); } catch { return checks; }
  for (const c of companies) {
    const id = `workspace.company.${c.id}`;
    const name = `公司「${c.name || c.id}」工作目录`;
    checks.push(safeCheck(id, name, "warning", () => {
      if (c.folder && c.folder.trim()) {
        const r = validate(projectRoot, c.folder);
        if (!r.ok) {
          return { id, name, status: "failed", severity: "warning", message: `绑定的主工作目录不可用:${r.error ?? r.code ?? "未知原因"}——请到「公司架构 · 基本信息」重新绑定` };
        }
        if (r.needsInit) {
          return { id, name, status: "ok", severity: "warning", message: `目录可用,但还不是有首个提交的 git 工作区(起跑前需显式确认初始化):${r.realPath}` };
        }
        return { id, name, status: "ok", severity: "warning", message: `绑定目录可用(git 就绪):${r.realPath}` };
      }
      const dir = companyRootDir(projectRoot, c);
      if (!fs.existsSync(dir)) {
        return { id, name, status: "ok", severity: "warning", message: `未绑定主工作目录——默认沙箱 ${dir} 将在首次起跑时自动创建` };
      }
      const w = checkDirWritable(id, name, dir);
      return { ...w, severity: "warning", message: w.status === "ok" ? `默认沙箱可写:${dir}` : `默认沙箱不可写:${w.message}` };
    }));
  }
  return checks;
}

// 五.3(收口作战令)· 逐 agent workingDirectory 体检:任何启用 agent 设了非法 workingDirectory
// (绝对路径/盘符/.. 逃逸/等价于根)→ error 级——运行时该 worker 会干净失败(deferred invalid_working_directory),
// 起跑前就该在体检里暴露,而不是等派工时才发现。未设置 workingDirectory 的 agent 不计问题。
function checkAgentWorkingDirectories(projectRoot: string): DoctorCheck {
  const id = "workspace.agent_working_dirs";
  const name = "员工工作子目录合法性";
  return safeCheck(id, name, "error", () => {
    const agents = loadEnabledAgents(projectRoot);
    const invalid: string[] = [];
    for (const a of agents) {
      const wd = a.workingDirectory;
      if (typeof wd === "string" && wd.trim()) {
        const r = validateAgentWorkingDirectory(wd);
        if (!r.ok) invalid.push(`${a.name || a.id}(${wd}:${r.error})`);
      }
    }
    if (invalid.length) {
      return { id, name, status: "failed", severity: "error", message: `以下员工的 workingDirectory 非法(须为 worktree 内相对路径,不得绝对/盘符/.. 逃逸;运行时会 deferred invalid_working_directory):${invalid.slice(0, 10).join("; ")}` };
    }
    return { id, name, status: "ok", severity: "error", message: "所有员工工作子目录合法(或未设置)" };
  });
}

// 五.1(收口作战令)· "编码任务需 git 工作区"体检:绑定了非 git(或无首个 commit)工作目录的公司,
// 一旦派编码团队任务会在起跑前被 non_git_multi_writer 拦死(多写者无 worktree 隔离)→ warning + 指引。
// 未绑定的默认沙箱(managed)起跑自动 git init,不在此列;绑定但已就绪 git 的公司也不告警。
function checkCodingWorkspacesGit(projectRoot: string, validate: (root: string, folder: string) => FolderCheck): DoctorCheck {
  const id = "workspace.coding_needs_git";
  const name = "编码任务 Git 工作区就绪";
  return safeCheck(id, name, "warning", () => {
    let companies: Company[] = [];
    try { companies = loadCompanies(projectRoot); } catch { companies = []; }
    const notGit: string[] = [];
    for (const c of companies) {
      if (!(c.folder && c.folder.trim())) continue; // 未绑定 = 默认沙箱托管 init,不在此列
      const r = validate(projectRoot, c.folder);
      if (r.ok && r.needsInit) notGit.push(c.name || c.id);
    }
    if (notGit.length) {
      return { id, name, status: "failed", severity: "warning", message: `以下公司绑定的工作目录不是有首个提交的 Git 仓库:${notGit.slice(0, 10).join("、")}。编码团队任务需要 Git 隔离(多 worker 并行),起跑会被拦——请到「公司架构 · 基本信息」确认"初始化为 OPC 管理的 Git 工作区"` };
    }
    return { id, name, status: "ok", severity: "warning", message: "绑定工作目录的公司均已就绪 Git(或使用默认托管沙箱)" };
  });
}

// 默认模型指向的 provider 是否可用(不可用会让 mission 创建/验收直接瘫)。
// 与 invokeSystemModel 复用同一条"无 key 自动订阅替换"规则(resolveAutoSubscription):
//   · 有 key / 本身就是订阅态配置 → pass(error 级 ok)。
//   · 无 key 但对应订阅已安装且登录 → pass/info("已自动使用 X 订阅"),不再告警。
//   · 既无 key 也无订阅(或无订阅映射)→ 保留漂移告警(error)。
async function checkSystemModelProvider(
  projectRoot: string,
  registered: (p: string) => boolean,
  isSubscriptionReady: (framework: string) => Promise<boolean>,
): Promise<DoctorCheck> {
  const id = "system_model_provider_registered";
  const name = "系统模型供应商已注册";
  try {
    const kinds: SystemModelKind[] = ["creative"];
    const problems: string[] = [];
    const autoSubbed: string[] = [];
    const oks: string[] = [];
    for (const kind of kinds) {
      let choice: ReturnType<typeof resolveSystemModel>;
      try {
        choice = resolveSystemModel(projectRoot, kind);
      } catch (e: any) {
        problems.push(`默认模型配置读取失败(${e?.message ?? String(e)})`);
        continue;
      }
      let outcome: Awaited<ReturnType<typeof resolveAutoSubscription>>;
      try {
        outcome = await resolveAutoSubscription(choice, { hasProviderKey: registered, isSubscriptionReady });
      } catch {
        problems.push(`默认模型指向 ${choice.provider}(订阅探测异常,按不可用处理)`);
        continue;
      }
      if (outcome.kind === "substituted") {
        autoSubbed.push(`默认模型:${outcome.from} 无可用 key,已自动使用 ${outcome.to} 订阅`);
      } else if (outcome.kind === "unavailable") {
        problems.push(`默认模型指向 ${outcome.provider}(无可用 key,且未检测到 ${outcome.subscription} 订阅)`);
      } else if (outcome.reason === "no-key-no-subscription") {
        problems.push(`默认模型指向 ${choice.provider}(未注册,无可用 key)`);
      } else {
        oks.push(`默认模型→${choice.provider}/${choice.model}`);
      }
    }
    if (problems.length) {
      return { id, name, status: "failed", severity: "error", message: `系统模型配置漂移:${problems.join(";")}。mission 创建/验收会直接不可用,请改 systemModel 配置、补该 provider 的 key,或安装并登录对应订阅 CLI。` };
    }
    if (autoSubbed.length) {
      const tail = oks.length ? `;${oks.join(",")}` : "";
      return { id, name, status: "ok", severity: "info", message: `系统模型可用(${autoSubbed.join(";")}${tail})` };
    }
    return { id, name, status: "ok", severity: "error", message: `系统模型 provider 均已注册(${oks.join(",")})` };
  } catch (e: any) {
    return { id, name, status: "failed", severity: "error", message: e?.message ?? String(e) };
  }
}

// ── deep 层新探针(E5)──────────────────────────────────────────────────────

// 端口占用:只读探测 3100(server)/5173(web dev)等关键端口,绝不 kill 任何进程——这里连"进程"
// 概念都不涉及,只是一次 TCP 连接尝试。占用/空闲都是中性事实(体检运行时本进程大概率就占着 3100),
// severity 定为 info;探测函数本身抛错才算 skipped。
function checkPortOccupancy(probe: (port: number, host?: string) => Promise<boolean | null>): Promise<DoctorCheck> {
  const id = "port.occupancy";
  const name = "关键端口占用状态";
  const severity: DoctorSeverity = "info";
  return (async () => {
    try {
      const results = await Promise.all(DEEP_KEY_PORTS.map(async ({ port, label }) => {
        const r = await probe(port);
        return { port, label, r };
      }));
      const parts = results.map(({ port, label, r }) => `${port}(${label})${r === true ? "占用" : r === false ? "空闲" : "无法判定"}`);
      return { id, name, status: "ok", severity, message: `端口占用状态:${parts.join("、")}` } as DoctorCheck;
    } catch (e: any) {
      return { id, name, status: "skipped", severity, message: `端口探测异常:${e?.message ?? String(e)}` } as DoctorCheck;
    }
  })();
}

// 子进程状态:当前代码库没有 pid registry(未实现子进程存活追踪),如实标注跳过——不是"查了发现没
// 问题",是"压根没法查"。deps seam 留好将来接入 pid registry 后的路径(有 registry 时才可能 failed)。
function checkOrphanWorktreeProcesses(probe: () => { hasRegistry: boolean; orphans: string[] }): DoctorCheck {
  const id = "process.orphan_worktree";
  const name = "残留 worktree 子进程";
  const severity: DoctorSeverity = "warning";
  return safeCheck(id, name, severity, () => {
    const r = probe();
    if (!r.hasRegistry) {
      return { id, name, status: "skipped", severity, message: "暂无 pid registry,跳过(尚未实现子进程存活追踪,无法判定是否有残留 opc-run worktree 进程)" };
    }
    if (r.orphans.length > 0) {
      return { id, name, status: "failed", severity, message: `发现 ${r.orphans.length} 个残留 worktree 进程(仅报告,不自动终止):${r.orphans.join(", ")}` };
    }
    return { id, name, status: "ok", severity, message: "无残留 worktree 进程" };
  });
}

// Node 版本:深度依赖脚本(tsx/esbuild 等)对 Node 主版本有最低要求。
function checkNodeVersion(): DoctorCheck {
  const id = "toolchain.node";
  const name = "Node 版本";
  const severity: DoctorSeverity = "warning";
  return safeCheck(id, name, severity, () => {
    const versionStr = process.version;
    const major = Number(versionStr.replace(/^v/, "").split(".")[0]);
    if (!Number.isFinite(major) || major < DOCTOR_MIN_NODE_MAJOR) {
      return { id, name, status: "failed", severity, message: `Node ${versionStr} 低于建议的最低版本 v${DOCTOR_MIN_NODE_MAJOR}(深度依赖脚本可能不兼容)` };
    }
    return { id, name, status: "ok", severity, message: `Node ${versionStr}` };
  });
}

// tsx/esbuild 等深度依赖是否可解析(不 import,只探是否安装)。
function checkModuleResolvable(id: string, name: string, moduleId: string, resolve: (id: string) => string | null): DoctorCheck {
  const severity: DoctorSeverity = "warning";
  return safeCheck(id, name, severity, () => {
    const resolved = resolve(moduleId);
    if (!resolved) {
      return { id, name, status: "failed", severity, message: `${moduleId} 不可解析(可能未安装,深度运行脚本依赖该包)` };
    }
    return { id, name, status: "ok", severity, message: `${moduleId} 可解析` };
  });
}

// 文件锁:.opc 下几个关键文件能否拿到写锁(open "r+" 立即关闭),抓杀软扫描/其它进程持锁这类问题。
function checkFileLocks(projectRoot: string, probe: (file: string) => { ok: boolean; message: string }): DoctorCheck {
  const id = "fs.file_lock";
  const name = "关键文件写锁";
  const severity: DoctorSeverity = "warning";
  return safeCheck(id, name, severity, () => {
    const results = DEEP_LOCK_FILES.map((f) => ({ f, ...probe(path.join(projectRoot, ".opc", f)) }));
    const locked = results.filter((r) => !r.ok);
    if (locked.length > 0) {
      return { id, name, status: "failed", severity, message: `以下文件无法获取写锁(可能被杀毒软件/其它进程占用):${locked.map((l) => `${l.f}(${l.message})`).join("; ")}` };
    }
    return { id, name, status: "ok", severity, message: "关键文件均可正常获取写锁" };
  });
}

// JSON store 深度校验(比 basic 的往返探测更深):抽查几个真实关键 store 文件能否 JSON.parse。
// 文件不存在(全新项目/未配置)不算问题,跳过统计。
function checkDeepStoreParse(projectRoot: string): DoctorCheck {
  const id = "store.deep_parse";
  const name = "关键 store 文件深度校验";
  const severity: DoctorSeverity = "error";
  return safeCheck(id, name, severity, () => {
    const broken: string[] = [];
    let checked = 0;
    for (const f of DEEP_STORE_FILES) {
      const full = path.join(projectRoot, ".opc", f);
      if (!fs.existsSync(full)) continue;
      checked += 1;
      try {
        JSON.parse(fs.readFileSync(full, "utf-8"));
      } catch {
        broken.push(f);
      }
    }
    if (broken.length > 0) {
      return { id, name, status: "failed", severity, message: `以下 store 文件解析失败(数据可能已损坏):${broken.join(", ")}` };
    }
    return { id, name, status: "ok", severity, message: checked > 0 ? `${checked} 个关键 store 文件均可正常解析` : "无关键 store 文件可检测(全新项目)" };
  });
}

// 社区 registry 可达性:失败时把 E2 既有的大陆网络合规措辞(不用"翻墙")一并带出。
function checkCommunityRegistryReachable(result: { ok: boolean; message: string }): DoctorCheck {
  const id = "network.community_registry";
  const name = "社区 registry 可达性";
  const severity: DoctorSeverity = "warning";
  if (result.ok) {
    return { id, name, status: "ok", severity, message: `社区 registry 可达(${result.message})` };
  }
  return {
    id, name, status: "failed", severity,
    message: `社区 registry 暂不可达(${result.message})。当前网络环境可能影响部分海外模型或服务访问,请根据当地法律法规和服务条款,选择可用且合规的网络环境或服务提供商。`,
  };
}

// ── 聚合 ─────────────────────────────────────────────────────────────────────

function overallStatus(checks: DoctorCheck[]): DoctorReport["status"] {
  let warning = false;
  for (const c of checks) {
    if (c.status !== "failed") continue;
    if (c.severity === "error") return "error";
    if (c.severity === "warning") warning = true;
  }
  return warning ? "warning" : "ok";
}

function loadEnabledAgents(projectRoot: string): AgentNodeConfig[] {
  try {
    return loadAgents(projectRoot, []).filter(a => (a as any).enabled !== false);
  } catch {
    return [];
  }
}

async function runBasicChecks(projectRoot: string, deps: Required<Pick<DoctorDeps, "probeEngine" | "syncProviders" | "providerRegistered" | "checkWorkspaceFolder">> & { level?: DoctorLevel; providerToolCanary?: DoctorDeps["providerToolCanary"] }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(checkJsonStore(projectRoot));
  checks.push(checkDirWritable("fs.workdir_writable", "工作目录可写", projectRoot));
  checks.push(checkDirWritable("fs.runs_writable", "runs 目录可写", path.join(projectRoot, ".opc", "runs")));
  checks.push(...checkCompanyWorkspaces(projectRoot, deps.checkWorkspaceFolder));
  checks.push(checkAgentWorkingDirectories(projectRoot)); // 五.3:逐 agent workingDirectory 合法性
  checks.push(checkCodingWorkspacesGit(projectRoot, deps.checkWorkspaceFolder)); // 五.1:编码任务需 git 工作区

  const agents = loadEnabledAgents(projectRoot);

  // 引擎安装态:只探被实际使用、且属于三大订阅(claude-code/codex/gemini-cli)的 framework
  // (按 cliConfigDir 取第一个),并行、带超时。API 面与第三方 CLI 不进体检报告(见 DOCTOR_ENGINE_WHITELIST)。
  const fwUsed = new Map<string, string | undefined>();
  for (const a of agents) {
    const fw = a.framework ?? "api";
    if (!DOCTOR_ENGINE_WHITELIST.has(fw)) continue;
    if (!fwUsed.has(fw)) fwUsed.set(fw, a.cliConfigDir);
  }
  const engineChecks = await Promise.all([...fwUsed.entries()].map(async ([fw, dir]) => {
    const id = `engine.${fw}`;
    const name = `引擎 ${fw} 安装态`;
    try {
      const av = await deps.probeEngine(fw, dir);
      if (av === null) {
        return { id, name, status: "skipped", severity: "info", message: `探测超时(${ENGINE_PROBE_TIMEOUT_MS}ms),本次不判定` } as DoctorCheck;
      }
      if (av.installed && av.loggedIn) {
        return { id, name, status: "ok", severity: "warning", message: av.version ? `已就绪(${av.version})` : "已就绪" } as DoctorCheck;
      }
      return { id, name, status: "failed", severity: "warning", message: av.detail || `${fw} ${av.installed ? "未登录/未认证" : "未安装"}` } as DoctorCheck;
    } catch (e: any) {
      return { id, name, status: "failed", severity: "warning", message: e?.message ?? String(e) } as DoctorCheck;
    }
  }));
  checks.push(...engineChecks);

  // G4 + 审计 P1-4 · Provider 执行环境 canary:宿主 host.fs_canary + git-bash 前置 + provider.tool_canary。
  const usesCli = agents.some(a => CLI_FRAMEWORKS.has(a.framework ?? "api"));
  // deep 层且注入了真实 canary → 真跑一次(低成本真实 CLI/ACP 调用),把结果喂给 provider.tool_canary;否则 not_tested。
  let toolCanaryResult: { ok: boolean; detail: string } | null = null;
  if (deps.level === "deep" && deps.providerToolCanary && usesCli) {
    const cliFw = agents.find(a => CLI_FRAMEWORKS.has(a.framework ?? "api"))?.framework ?? "claude-code";
    toolCanaryResult = await deps.providerToolCanary(cliFw).catch((e: any) => ({ ok: false, detail: `真实 canary 异常:${e?.message ?? String(e)}` }));
  }
  checks.push(...checkProviderEnvironment(usesCli, {
    platform: process.platform, gitBashPath: process.env.CLAUDE_CODE_GIT_BASH_PATH,
    tmpDir: os.tmpdir(), detectGitBash: detectGitBashPath,
    providerToolCanary: () => toolCanaryResult,
  }));

  // provider key 配置态:只查"有没有注册成功的 handler"(= 有 key),绝不读取/回显 key 值本身。
  try { deps.syncProviders(projectRoot); } catch { /* 注册失败按未注册处理 */ }
  const providersNeeded = new Set<string>();
  for (const a of agents) {
    const fw = a.framework ?? "api";
    if (CLI_FRAMEWORKS.has(fw)) continue;
    if (a.provider) providersNeeded.add(a.provider);
  }
  // 无 key 自动订阅替换复用 probeEngine，只有 installed+loggedIn 才算 ready——provider.keys 与
  // 系统模型漂移检查共用同一口径。
  const isSubscriptionReady = async (fw: string): Promise<boolean> => {
    try {
      const av = await deps.probeEngine(fw);
      return !!(av && av.installed && av.loggedIn);
    } catch {
      return false;
    }
  };

  // 缺 key 的 provider 按订阅平替二分(用户定稿:无 API key 时用对应订阅平替,不该吓唬人)。
  const missingKeyProviders = [...providersNeeded].filter(p => !deps.providerRegistered(p));
  const substitutable: string[] = [];
  const trulyMissing: string[] = [];
  for (const p of missingKeyProviders) {
    const sub = PROVIDER_SUBSCRIPTION_FALLBACK[p];
    if (sub && await isSubscriptionReady(sub)) substitutable.push(`${p}→${sub} 订阅`);
    else trulyMissing.push(p);
  }
  checks.push(safeCheck("provider.keys", "供应商 API Key 配置", "warning", () => {
    if (providersNeeded.size === 0) {
      return { id: "provider.keys", name: "供应商 API Key 配置", status: "ok", severity: "warning", message: "当前没有需要 API key 的员工(订阅制执行无需 key)" };
    }
    if (trulyMissing.length) {
      const subNote = substitutable.length ? `;另 ${substitutable.join("、")} 可订阅平替` : "";
      return { id: "provider.keys", name: "供应商 API Key 配置", status: "failed", severity: "warning", message: `缺 API key 且无订阅平替的 provider:${trulyMissing.join(", ")}(对应员工将受限运行)${subNote}` };
    }
    if (substitutable.length) {
      return { id: "provider.keys", name: "供应商 API Key 配置", status: "ok", severity: "warning", message: `无 API key 但有订阅平替:${substitutable.join("、")}——系统调用自动走订阅;仍以 API 模式配置的员工建议在员工设置切换为订阅` };
    }
    return { id: "provider.keys", name: "供应商 API Key 配置", status: "ok", severity: "warning", message: `${providersNeeded.size} 个在用 provider 均已配置 key` };
  }));

  checks.push(checkMcpConfig(projectRoot));
  checks.push(await checkSystemModelProvider(projectRoot, deps.providerRegistered, isSubscriptionReady));

  return checks;
}

async function runCapabilityChecks(
  projectRoot: string,
  deps: Required<Pick<DoctorDeps, "providerRegistered" | "testProviderConnectivity" | "probeMcp">>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  // provider 真实连通性:员工在用的 + systemModel 在用的 provider,且已注册(有 key)才测——
  // 没 key 的连通测试必然失败,只会制造噪音,basic 层的 provider.keys 已经报过了。
  const targets = new Map<string, ProviderConnectivityTarget>();
  const agents = loadEnabledAgents(projectRoot);
  const wanted = new Set<string>();
  for (const a of agents) {
    const fw = a.framework ?? "api";
    if (!CLI_FRAMEWORKS.has(fw) && a.provider) wanted.add(a.provider);
  }
  try { wanted.add(resolveSystemModel(projectRoot, "creative").provider); } catch { /* 配置读取失败已由 basic 层暴露 */ }
  let customProviders: ReturnType<typeof loadProviders> = [];
  try { customProviders = loadProviders(projectRoot); } catch { /* 无自定义 provider */ }
  for (const p of wanted) {
    if (!deps.providerRegistered(p)) continue;
    if (p === "anthropic") {
      targets.set(p, { provider: p, apiFormat: "anthropic", baseUrl: "https://api.anthropic.com/v1" });
    } else if (PRESET_BASE_URLS[p]) {
      targets.set(p, { provider: p, apiFormat: "openai", baseUrl: PRESET_BASE_URLS[p] });
    } else {
      const custom = customProviders.find(c => c.id === p && c.baseUrl);
      if (custom) targets.set(p, { provider: p, apiFormat: custom.apiFormat === "anthropic" ? "anthropic" : "openai", baseUrl: custom.baseUrl });
    }
  }
  const connectivity = await Promise.all([...targets.values()].map(async (t) => {
    const id = `provider.connectivity.${t.provider}`;
    const name = `供应商 ${t.provider} 连通性`;
    try {
      const r = await deps.testProviderConnectivity(projectRoot, t);
      return { id, name, status: r.ok ? "ok" : "failed", severity: "warning", message: r.message } as DoctorCheck;
    } catch (e: any) {
      return { id, name, status: "failed", severity: "warning", message: e?.message ?? String(e) } as DoctorCheck;
    }
  }));
  checks.push(...connectivity);

  // MCP server 可连性:只探 enabled 的;unknown(无法判定)记 skipped 不误报。
  try {
    const servers = listMcpServers(projectRoot).filter(s => s.enabled);
    if (servers.length) {
      const health = await deps.probeMcp(servers);
      for (const s of servers) {
        const id = `mcp.server.${s.id}`;
        const name = `MCP「${s.name}」可连`;
        const h = health[s.id] ?? "unknown";
        if (h === "healthy") checks.push({ id, name, status: "ok", severity: "warning", message: "探测正常" });
        else if (h === "unhealthy") checks.push({ id, name, status: "failed", severity: "warning", message: s.transport === "http" ? "url 不可达/超时" : "命令不存在" });
        else checks.push({ id, name, status: "skipped", severity: "info", message: "无法判定(未探测出结果)" });
      }
    }
  } catch (e: any) {
    checks.push({ id: "mcp.servers", name: "MCP server 可连", status: "failed", severity: "warning", message: e?.message ?? String(e) });
  }

  return checks;
}

// deep 层(E5):7 类此前完全没有探针的检查,详见文件顶部注释。所有网络/进程/模块解析都走 deps
// 注入,单测不真占端口/不真起进程/不打外网;文件系统类检查(锁/store 深度解析/worktree 根可写)
// 走真实临时目录读写,同 basic 层既有做法一致。
async function runDeepChecks(
  projectRoot: string,
  deps: Required<Pick<DoctorDeps, "checkPortOccupancy" | "checkOrphanWorktreeProcesses" | "resolveModule" | "checkFileLock" | "fetchCommunityRegistryReachable">>,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push(await checkPortOccupancy(deps.checkPortOccupancy));
  checks.push(checkOrphanWorktreeProcesses(deps.checkOrphanWorktreeProcesses));
  checks.push(checkNodeVersion());
  checks.push(checkModuleResolvable("toolchain.tsx", "tsx 工具链", "tsx", deps.resolveModule));
  checks.push(checkModuleResolvable("toolchain.esbuild", "esbuild 工具链", "esbuild", deps.resolveModule));
  checks.push(checkFileLocks(projectRoot, deps.checkFileLock));
  checks.push(checkDeepStoreParse(projectRoot));
  checks.push(checkDirWritable("fs.worktree_root_writable", "worktree 根目录可写", path.join(projectRoot, ".opc", "wt")));

  const communityResult = await deps.fetchCommunityRegistryReachable().catch((e: any) => ({ ok: false, message: e?.message ?? String(e) }));
  checks.push(checkCommunityRegistryReachable(communityResult));

  return checks;
}

// ── 落盘 ─────────────────────────────────────────────────────────────────────

function persistReport(projectRoot: string, report: DoctorReport): void {
  try {
    const dir = doctorDir(projectRoot);
    const base = report.checked_at.replace(/[:.]/g, "-");
    let file = path.join(dir, `${base}.json`);
    // 同一毫秒内连跑两次(测试/连点)不互相覆盖:文件名追加序号。
    for (let i = 1; fs.existsSync(file); i += 1) file = path.join(dir, `${base}-${i}.json`);
    writeJSON(file, report);
    writeJSON(path.join(dir, "latest.json"), report);
  } catch { /* 落盘失败不影响返回体检结果 */ }
}

export function readLatestDoctorReport(projectRoot: string): DoctorReport | null {
  const latest = readJSON<DoctorReport | null>(path.join(doctorDir(projectRoot), "latest.json"), null);
  if (!latest || typeof latest.status !== "string" || !Array.isArray(latest.checks)) return null;
  // 引擎清单收敛为三订阅后,历史存档里的 engine.hermes/engine.opencode 等旧项会在 UI 里"复活"
  // (用户实测)。读取层按当前白名单过滤旧引擎项——存档文件本身不改写,重跑体检自然产出干净报告。
  const checks = latest.checks.filter((c) => {
    const id = typeof c?.id === "string" ? c.id : "";
    if (!id.startsWith("engine.")) return true;
    return DOCTOR_ENGINE_WHITELIST.has(id.slice("engine.".length));
  });
  return checks.length === latest.checks.length ? latest : { ...latest, checks };
}

export async function runGlobalDoctor(projectRoot: string, opts: { level: DoctorLevel }, deps: DoctorDeps = {}): Promise<DoctorReport> {
  const level: DoctorLevel = opts.level === "capability" ? "capability" : opts.level === "deep" ? "deep" : "basic";
  const now = deps.now ?? (() => new Date());
  const probeEngine = deps.probeEngine ?? defaultProbeEngine;
  const syncProviders = deps.syncProviders ?? ((root: string) => { syncProvidersFromStore(root); });
  const providerRegistered = deps.providerRegistered ?? isProviderAvailable;
  const testProviderConnectivity = deps.testProviderConnectivity ?? defaultTestProviderConnectivity;
  const probeMcp = deps.probeMcp ?? ((servers: McpServerConfig[]) => probeHealth(servers, { timeoutMs: 3000 }));
  const checkWorkspaceFolderDep = deps.checkWorkspaceFolder ?? validateWorkspaceFolder;
  const checkPortOccupancyDep = deps.checkPortOccupancy ?? defaultCheckPortOccupancy;
  const checkOrphanWorktreeProcessesDep = deps.checkOrphanWorktreeProcesses ?? (() => ({ hasRegistry: false, orphans: [] }));
  const resolveModule = deps.resolveModule ?? defaultResolveModule;
  const checkFileLockDep = deps.checkFileLock ?? defaultCheckFileLock;
  const fetchCommunityRegistryReachable = deps.fetchCommunityRegistryReachable ?? defaultFetchCommunityRegistryReachable;

  // deep 是最全的一层,在 basic + capability 之上再叠加 E5 新探针(而非替代 capability)。
  const checks = await runBasicChecks(projectRoot, { probeEngine, syncProviders, providerRegistered, checkWorkspaceFolder: checkWorkspaceFolderDep, level, providerToolCanary: deps.providerToolCanary });
  if (level === "capability" || level === "deep") {
    checks.push(...await runCapabilityChecks(projectRoot, { providerRegistered, testProviderConnectivity, probeMcp }));
  }
  if (level === "deep") {
    checks.push(...await runDeepChecks(projectRoot, {
      checkPortOccupancy: checkPortOccupancyDep,
      checkOrphanWorktreeProcesses: checkOrphanWorktreeProcessesDep,
      resolveModule,
      checkFileLock: checkFileLockDep,
      fetchCommunityRegistryReachable,
    }));
  }

  const report: DoctorReport = {
    status: overallStatus(checks),
    checked_at: now().toISOString(),
    level,
    checks,
  };
  persistReport(projectRoot, report);
  return report;
}
