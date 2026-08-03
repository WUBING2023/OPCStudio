import type { Express } from "express";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { v4 as uuid } from "uuid";
import type { EngineAvailability } from "@opc/shared";
import { ProviderAccountSchema } from "@opc/shared";
import { probeClaudeCodeAsync, probeCodexAsync, probeNativeSubscriptionPassiveAsync } from "../runtime/engines/probes.js";
import { killProcessTree } from "../runtime/processUtils.js";
import { resolveDirectCommand } from "../runtime/engines/executableResolver.js";
import { loadAccounts, addAccount } from "../storage/providerStore.js";
import { testAccountApiKey, toPublicAccount } from "./accountRoutes.js";

// 纯小白环境向导 · 安装端点。只服务订阅版 CLI(claude-code / codex / gemini-cli)—— 都是 npm 全局包，
// 可以无人值守跑完。API 面(framework=api)是内置 in-process 引擎,无需安装,不在此列。
//
// 安全:engine 先过白名单，实际 spawn 的 argv 永远来自下面这张常量表——请求体里的字符串本身
// 从不被拼进命令行（哪怕白名单校验被绕过，未知 engine 也只会走 400，不会走到 spawn）。
type NpmInstallableEngine = "claude-code" | "codex" | "gemini-cli" | "kimi-cli";
type SetupEngine = NpmInstallableEngine | "grok-build";
const SETUP_ENGINES: readonly SetupEngine[] = ["claude-code", "codex", "gemini-cli", "kimi-cli", "grok-build"];

const INSTALL_ARGS: Record<NpmInstallableEngine, string[]> = {
  "claude-code": ["install", "-g", "@anthropic-ai/claude-code"],
  "codex": ["install", "-g", "@openai/codex"],
  "gemini-cli": ["install", "-g", "@google/gemini-cli"],
  "kimi-cli": ["install", "-g", "@moonshot-ai/kimi-code"],
};

export type SetupInstallPlan =
  | { supported: true; engine: NpmInstallableEngine; args: string[] }
  | { supported: false; engine: "grok-build"; reason: string };

export function setupInstallPlan(engine: string): SetupInstallPlan | null {
  if (!SETUP_ENGINES.includes(engine as SetupEngine)) return null;
  if (engine === "grok-build") {
    return {
      supported: false,
      engine,
      reason: "Grok Build 官方安装器尚无在本项目内可确认的跨平台无人值守契约；请按 xAI 官方文档手动安装后刷新状态。",
    };
  }
  const target = engine as NpmInstallableEngine;
  return { supported: true, engine: target, args: [...INSTALL_ARGS[target]] };
}

// CLI「API Key 模式」账号(不走 OAuth 订阅登录，纯 apiKey 驱动)的 providerId 映射，与
// apps/web/src/components/CliApiKeyAccounts.tsx 里的 FW_PROVIDER 同源。
const CLI_APIKEY_PROVIDER: Record<"claude-code" | "codex", string> = { "claude-code": "anthropic", codex: "openai" };

const MAX_LOG_LINES = 400;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

export interface InstallerLaunch { file: string; prefixArgs: string[] }

/** Prefer the npm CLI bundled in the EXE; development may use the system npm shim. */
export function resolveInstallerLaunch(env: NodeJS.ProcessEnv = process.env): InstallerLaunch {
  const node = env.OPC_NODE_EXECUTABLE?.trim();
  const npmCli = env.OPC_NPM_CLI?.trim();
  if (node || npmCli) {
    if (!node || !npmCli || !path.isAbsolute(node) || !path.isAbsolute(npmCli) || !fs.existsSync(node) || !fs.existsSync(npmCli)) {
      throw new Error("packaged npm runtime is incomplete");
    }
    return { file: node, prefixArgs: [npmCli] };
  }
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return resolveDirectCommand(npmCommand);
}

export function managedInstallArgs(env: NodeJS.ProcessEnv = process.env): string[] {
  const prefix = env.OPC_MANAGED_CLI_PREFIX?.trim();
  if (!prefix) return [];
  if (!path.isAbsolute(prefix)) throw new Error("managed CLI prefix must be absolute");
  return ["--prefix", prefix];
}

interface InstallJob {
  engine: NpmInstallableEngine;
  status: "running" | "done" | "error" | "timeout";
  log: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode: number | null;
  error?: string;
  probe?: EngineAvailability;
}

// 单进程内存态即可 — 安装是几分钟内的前台动作，没有跨重启恢复的需要。并发互斥:同时只允许一个
// engine 在装(状态是唯一一份 currentJob，而不是按 engine 分桶的 map)。
let currentJob: InstallJob | null = null;
let activeChild: ChildProcess | null = null;

function appendLog(job: InstallJob, chunk: string) {
  const lines = chunk.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return;
  job.log.push(...lines);
  if (job.log.length > MAX_LOG_LINES) job.log.splice(0, job.log.length - MAX_LOG_LINES);
}

async function reprobe(engine: NpmInstallableEngine): Promise<EngineAvailability | undefined> {
  try {
    if (engine === "claude-code") return await probeClaudeCodeAsync();
    if (engine === "codex") return await probeCodexAsync();
    if (engine === "gemini-cli" || engine === "kimi-cli") return await probeNativeSubscriptionPassiveAsync(engine);
    return undefined;
  } catch {
    return undefined; // 探测失败不影响已经拿到的安装结果展示
  }
}

export function register(app: Express, projectRoot: string) {
  // 发起安装。engine 严格走白名单，dryRun 只供内部验收用(见 npm --dry-run)，
  // 正式前端从不发这个字段 —— 真装留给用户点按钮。
  app.post("/api/setup/install", (req, res) => {
    const engine = req.body?.engine;
    const installPlan = typeof engine === "string" ? setupInstallPlan(engine) : null;
    if (!installPlan) {
      return res.status(400).json({ error: "engine 必须是 claude-code / codex / gemini-cli / kimi-cli / grok-build 之一" });
    }
    if (!installPlan.supported) {
      return res.status(501).json({ supported: false, engine: installPlan.engine, error: installPlan.reason });
    }

    if (currentJob?.status === "running") {
      return res.status(409).json({ error: `已有安装任务在进行中(${currentJob.engine})，请等它跑完再试` });
    }

    const target = installPlan.engine;
    const dryRun = req.body?.dryRun === true;
    const baseArgs = [...installPlan.args, ...managedInstallArgs()];
    const args = dryRun ? [...baseArgs, "--dry-run"] : baseArgs;

    const job: InstallJob = {
      engine: target,
      status: "running",
      log: [],
      startedAt: new Date().toISOString(),
      exitCode: null,
    };
    currentJob = job;

    let child: ChildProcess;
    try {
      // shell:true 清零(令五.5):不再靠 shell 解析 npm.cmd shim。resolveDirectCommand 把 "npm"/"npm.cmd"
      // 解析成真实可执行文件——Windows 上读 npm.cmd shim 得到 node.exe + npm-cli.js 绝对路径(从不执行 .cmd
      // 文本),posix 上直接拿到 npm 脚本本体——然后 spawn shell:false + 参数数组起进程。args 仍全部来自上面
      // 的常量表(INSTALL_ARGS[target])，不含任何请求体拼入的自由文本;解析失败即显式抛错,绝不回退 shell。
      const resolved = resolveInstallerLaunch();
      child = spawn(resolved.file, [...resolved.prefixArgs, ...args], { shell: false, windowsHide: true });
    } catch (e: any) {
      job.status = "error";
      job.error = e?.message || "安装进程启动失败";
      job.finishedAt = new Date().toISOString();
      return res.status(500).json({ job });
    }
    activeChild = child;

    const timer = setTimeout(() => {
      if (job.status === "running") {
        job.status = "timeout";
        job.error = "安装超时(15 分钟)，已终止";
        job.finishedAt = new Date().toISOString();
        killProcessTree(child.pid, () => child.kill());
      }
    }, INSTALL_TIMEOUT_MS);

    child.stdout?.on("data", (d) => appendLog(job, d.toString()));
    child.stderr?.on("data", (d) => appendLog(job, d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      activeChild = null;
      if (job.status === "running") {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = new Date().toISOString();
      }
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      activeChild = null;
      if (job.status === "running") {
        job.exitCode = code;
        job.status = code === 0 ? "done" : "error";
        job.finishedAt = new Date().toISOString();
        if (code !== 0) job.error = `npm 退出码 ${code}`;
      }
      // 装完(不管成不成功)都重新探测一次，让前端拿到"安装完成后的新状态"而不用再猜。
      void reprobe(target).then((p) => { job.probe = p; });
    });

    res.json({ job });
  });

  // 轮询用:当前(或最近一次)安装任务的状态 + 日志尾巴。没跑过任何安装时 job=null。
  app.get("/api/setup/install/status", (_req, res) => {
    res.json({ job: currentJob });
  });

  // 引导流程里的第三条路:不走 CLI 订阅 OAuth 登录，直接用一把 API Key 驱动 claude-code/codex。
  // 之前这条路只存在于「API」设置页(accountRoutes.ts 的通用 POST /api/accounts + CliApiKeyAccounts.tsx)，
  // 引导向导里发现不了、也拿不到"创建完是否真能用"的反馈。这里把「创建账号」+「立即真实测 key」
  // 合成一步，专供引导场景：一次调用，直接告诉用户这把 key 能不能用，不用再跳到设置页分两步做。
  app.post("/api/setup/cli-api-key-account", async (req, res) => {
    const engine = req.body?.engine;
    if (engine !== "claude-code" && engine !== "codex") {
      return res.status(400).json({ error: "engine 必须是 claude-code 或 codex" });
    }
    const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
    if (!apiKey) return res.status(400).json({ error: "apiKey 不能为空" });

    const target = engine as "claude-code" | "codex";
    const providerId = CLI_APIKEY_PROVIDER[target];
    const id = `${providerId}#${uuid().slice(0, 6)}`;
    const configDir = path.join(projectRoot, ".opc", "cli-accounts", id);
    try { fs.mkdirSync(configDir, { recursive: true }); } catch { /* best-effort:同 accountRoutes 的策略,分配失败仍可建账号 */ }

    const body = {
      id,
      providerId,
      label: typeof req.body?.label === "string" && req.body.label.trim()
        ? req.body.label.trim()
        : (target === "claude-code" ? "Claude Code (API Key)" : "Codex (API Key)"),
      apiKey,
      frameworks: [target],
      enabled: true,
      maxConcurrent: target === "codex" ? 1 : 3,
      configDir,
    };
    const parsed = ProviderAccountSchema.safeParse(body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    if (loadAccounts(projectRoot).some((a) => a.id === parsed.data.id)) {
      return res.status(409).json({ error: `account ${parsed.data.id} already exists` });
    }

    const account = addAccount(projectRoot, parsed.data);
    const test = await testAccountApiKey(account);
    res.status(201).json({ account: toPublicAccount(account), test });
  });
}
