// 三级模型选择 · 订阅引擎「活体」模型目录来源(验收#1:订阅模型来自 ACP,而非恒静态兜底)。
// 对已安装的 ACP 订阅引擎(claude-code / codex)直接 spawn 其 ACP adapter,走一次 initialize + session/new
// 握手,从 session/new 应答里读回该订阅账号真实可用的模型表(两种活体形状,见 extractAcpModels)。
// 关键性质:
//   · 零模型消耗——只握手、不发 session/prompt(IRON RULE #5 明确豁免此握手用于验证模型目录;探针报告
//     已证 claude-code 与 codex 的 session/new 都回 configOptions/models)。
//   · ~10 分钟缓存——避免每次 GET /api/model-catalog 都冷起 npx adapter。
//   · 失败即 null——CLI 未装/npx 冷起失败/握手超时/协议错一律返回 null,调用方(modelCatalogRoutes)据此
//     回退静态兜底表(source:"static"),绝不阻塞目录端点。
//
// 为何不复用 apps/cli 的 AcpClient:它只有 run()(必发 prompt、消耗模型),且 server 的 tsconfig rootDir:src
// 不允许静态 import apps/cli(会破 tsc)。故此处自持一个「只握手」的极小 ndjson JSON-RPC 客户端(帧格式
// 与 SDK 的 ndJsonStream 一致:每行一个 JSON-RPC 2.0 消息 + "\n")。env 安全档就地内联(镜像 apps/cli
// engineRegistry.buildEngineSpec + 相0.5 探针报告 #3/#4/#5,不跨包耦合)。
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CatalogModel } from "./modelResolve.js";
import { resolveDirectCommand } from "./engines/executableResolver.js";

export type AcpProbeEngine = "claude-code" | "codex" | "gemini-cli" | "kimi-cli" | "grok-build";

const ACP_PROTOCOL_VERSION = 1;
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface AcpProbeSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  shell: boolean;
}

type DirectCommandResolver = typeof resolveDirectCommand;
let directCommandResolver: DirectCommandResolver = resolveDirectCommand;

export function __setAcpProbeCommandResolverForTest(resolver: DirectCommandResolver | null): void {
  directCommandResolver = resolver ?? resolveDirectCommand;
}

// spawn 的 adapter 规格。env 安全档:
//  · 所有子进程必删 CLAUDECODE(IRON RULE #2 + 探针 #4:不删触发 claude-code adapter 嵌套会话自杀守卫)。
//  · codex:INITIAL_AGENT_MODE=read-only(探针 #3 禁写);删 OPENAI_API_KEY/CODEX_API_KEY(探针 #5 +
//    IRON RULE #2:一旦存在 codex 切 api-key 计费;强制走订阅登录)。绝不注入任何 *_API_KEY。
export function buildProbeSpec(engine: AcpProbeEngine, envBase: NodeJS.ProcessEnv = process.env): AcpProbeSpec {
  const env: NodeJS.ProcessEnv = { ...envBase };
  delete env.CLAUDECODE;

  if (engine === "gemini-cli" || engine === "kimi-cli" || engine === "grok-build") {
    let command: string;
    let args: string[];
    if (engine === "gemini-cli") {
      command = "gemini";
      args = ["--acp"];
      delete env.GEMINI_API_KEY;
      delete env.GOOGLE_API_KEY;
      delete env.GOOGLE_APPLICATION_CREDENTIALS;
      delete env.GOOGLE_GENAI_USE_VERTEXAI;
    } else if (engine === "kimi-cli") {
      command = "kimi";
      args = ["acp"];
      delete env.KIMI_API_KEY;
      delete env.MOONSHOT_API_KEY;
    } else {
      command = "grok";
      args = ["agent", "stdio"];
      delete env.XAI_API_KEY;
    }
    const resolved = directCommandResolver(command);
    return {
      command: resolved.file,
      args: [...resolved.prefixArgs, ...args],
      env,
      shell: false,
    };
  }

  const node = env.OPC_NODE_EXECUTABLE?.trim();
  const npxCli = env.OPC_NPX_CLI?.trim();
  let command: string;
  let prefixArgs: string[];
  let shell: boolean;
  if (node || npxCli) {
    if (!node || !npxCli || !path.isAbsolute(node) || !path.isAbsolute(npxCli) || !fs.existsSync(node) || !fs.existsSync(npxCli)) {
      throw new Error("packaged npx runtime is incomplete");
    }
    command = node;
    prefixArgs = [npxCli];
    shell = false;
  } else {
    command = process.platform === "win32" ? "npx.cmd" : "npx";
    prefixArgs = [];
    shell = process.platform === "win32";
  } // npx 在 win 上是 npx.cmd,spawn 需 shell
  if (engine === "claude-code") {
    return { command, args: [...prefixArgs, "-y", "@zed-industries/claude-code-acp"], env, shell };
  }
  env.INITIAL_AGENT_MODE = "read-only";
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  return { command, args: [...prefixArgs, "-y", "@agentclientprotocol/codex-acp"], env, shell };
}

export type ProbeSpawn = (spec: AcpProbeSpec) => ChildProcess;
function defaultSpawn(spec: AcpProbeSpec): ChildProcess {
  return nodeSpawn(spec.command, spec.args, {
    env: spec.env,
    shell: spec.shell,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32", // POSIX:自成进程组,便于按组杀孙进程(codex app-server)
  });
}
let spawnImpl: ProbeSpawn = defaultSpawn;
export function __setProbeSpawnForTest(fn: ProbeSpawn | null) { spawnImpl = fn ?? defaultSpawn; }

// 按 PID 树杀 adapter(会起孙进程:codex app-server)。best-effort,绝不抛。
function killTree(pid: number | undefined): void {
  if (pid == null) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(-pid, "SIGKILL"); } catch { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } } }
  } catch { /* best-effort */ }
}

// 从 session/new 应答抽模型表。相0.5 探针 2026-07-10 活体 dump 实测两种形状并存:
//   A) result.configOptions[]:ACP 把模型选择器建模为 category:"model" 的 select(currentValue + options,
//      options 可扁平 SelectOption[] 或分组 SelectGroup[])。codex 走这条(clean 基座 id:gpt-5.5 等)。
//   B) result.models.availableModels[]:{ modelId, name, description } 数组 + currentModelId(默认)。
//      claude-code 走这条——它**不回** configOptions,模型表只在 result.models 里。
// 入参传整个 session/new.result:优先取 configOptions 的 model select(codex 保留 clean 基座名、不回归);
// 无则回退 availableModels(claude-code)。也兼容直接传 configOptions 数组(旧调用/单测)。默认标记:
// configOptions 用 currentValue、availableModels 用 currentModelId。都拍平成 {id, label:name, isDefault}。
export function extractAcpModels(source: unknown): CatalogModel[] {
  if (Array.isArray(source)) return fromConfigOptions(source);
  if (source && typeof source === "object") {
    const result = source as any;
    const fromCfg = Array.isArray(result.configOptions) ? fromConfigOptions(result.configOptions) : [];
    if (fromCfg.length) return fromCfg;
    return fromAvailableModels(result.models);
  }
  return [];
}

function fromConfigOptions(configOptions: unknown[]): CatalogModel[] {
  const isSelect = (o: any): boolean => !!o && o.type === "select" && Array.isArray(o.options);
  const modelOpt =
    configOptions.find((o: any) => o && o.category === "model" && isSelect(o)) ??
    configOptions.find((o: any) => isSelect(o) && /model/i.test(`${o.id ?? ""} ${o.name ?? ""}`));
  if (!modelOpt) return [];
  const current = (modelOpt as any).currentValue;
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  const pushOpt = (opt: any): void => {
    if (!opt || typeof opt.value !== "string" || !opt.value || seen.has(opt.value)) return;
    seen.add(opt.value);
    out.push({
      id: opt.value,
      label: typeof opt.name === "string" && opt.name ? opt.name : opt.value,
      ...(opt.value === current ? { isDefault: true } : {}),
    });
  };
  for (const entry of (modelOpt as any).options as any[]) {
    if (entry && Array.isArray(entry.options)) { for (const o of entry.options) pushOpt(o); } // 分组
    else pushOpt(entry);
  }
  return out;
}

function fromAvailableModels(models: unknown): CatalogModel[] {
  if (!models || typeof models !== "object") return [];
  const avail = (models as any).availableModels;
  if (!Array.isArray(avail)) return [];
  const current = (models as any).currentModelId;
  const out: CatalogModel[] = [];
  const seen = new Set<string>();
  for (const m of avail as any[]) {
    if (!m || typeof m.modelId !== "string" || !m.modelId || seen.has(m.modelId)) continue;
    seen.add(m.modelId);
    out.push({
      id: m.modelId,
      label: typeof m.name === "string" && m.name ? m.name : m.modelId,
      ...(m.modelId === current ? { isDefault: true } : {}),
    });
  }
  return out;
}

// 极小 ndjson JSON-RPC 握手:发 initialize(id 0)→ 收应答后发 session/new(id 1)→ 从其 configOptions
// 抽模型。全程只两条请求,绝不发 session/prompt。任何 error/超时/进程早退 → null(回退静态)。
function selectSubscriptionAuthMethod(source: unknown): string | null {
  if (!source || typeof source !== "object") return null;
  const methods = (source as any).authMethods;
  if (!Array.isArray(methods) || methods.length === 0) return null;
  const ids = methods
    .map((method: any) => typeof method?.id === "string" ? method.id : "")
    .filter(Boolean);
  if (ids.includes("cached_token")) return "cached_token";
  return ids.find((id: string) =>
    !/api[_-]?key/i.test(id) && /(oauth|account|login|subscription|cached)/i.test(id),
  ) ?? "";
}

function runHandshake(child: ChildProcess, cwd: string, timeoutMs: number): Promise<CatalogModel[] | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const finish = (models: CatalogModel[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.stdin?.end(); } catch { /* ignore */ }
      killTree(child.pid);
      resolve(models);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const write = (obj: unknown): void => {
      try { child.stdin?.write(JSON.stringify(obj) + "\n"); } catch { finish(null); }
    };
    const send = (id: number, method: string, params: unknown): void => write({ jsonrpc: "2.0", id, method, params });

    child.on("error", () => finish(null));
    child.on("close", () => finish(null)); // 拿到模型前进程就死了 → 回退静态
    child.stderr?.on("data", () => { /* adapter 横幅/日志,忽略 */ });
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; } // 非 JSON 行(横幅)跳过
        if (!msg || typeof msg !== "object") continue;
        // adapter 的反向请求(理论上握手期不该有,能力已声明 fs/terminal:false)→ 回 method-not-found,绝不挂死
        if (typeof msg.method === "string" && msg.id != null) {
          write({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported" } });
          continue;
        }
        if (msg.id === 0) {
          if (msg.error) { finish(null); return; }
          const authMethod = selectSubscriptionAuthMethod(msg.result);
          if (authMethod === "") { finish(null); return; }
          if (authMethod) {
            send(2, "authenticate", { methodId: authMethod, _meta: { headless: true } });
          } else {
            send(1, "session/new", { cwd, mcpServers: [] });
          }
        } else if (msg.id === 2) {
          if (msg.error) { finish(null); return; }
          send(1, "session/new", { cwd, mcpServers: [] });
        } else if (msg.id === 1) {
          if (msg.error || !msg.result) { finish(null); return; }
          finish(extractAcpModels(msg.result));
          return;
        }
      }
    });

    send(0, "initialize", {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "opc-model-probe", version: "0.1.0" },
    });
  });
}

const cache = new Map<AcpProbeEngine, { at: number; models: CatalogModel[] | null }>();
export function __resetAcpModelCacheForTest() { cache.clear(); }

// 探一个 ACP 订阅引擎的活体模型表。成功且非空 → CatalogModel[];否则 null(调用方回退静态兜底)。
// 结果(含 null)缓存 ~10 分钟,避免每次目录请求都冷起 adapter。
export async function probeAcpModels(
  engine: AcpProbeEngine,
  opts: { timeoutMs?: number; noCache?: boolean; cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<CatalogModel[] | null> {
  const now = Date.now();
  if (!opts.noCache) {
    const c = cache.get(engine);
    if (c && now - c.at < CACHE_TTL_MS) return c.models;
  }
  let models: CatalogModel[] | null = null;
  try {
    const child = spawnImpl(buildProbeSpec(engine, opts.env));
    models = await runHandshake(child, opts.cwd ?? os.tmpdir(), opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  } catch { models = null; }
  cache.set(engine, { at: now, models });
  return models;
}
