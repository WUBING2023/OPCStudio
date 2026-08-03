import { spawn as realSpawn, execSync, type SpawnOptions } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { FileChange } from "@opc/shared";
import { killProcessTree } from "../processUtils.js";
import { registerPid, unregisterPid } from "../pidRegistry.js";
import { resolveDirectCommand } from "./executableResolver.js";
import { captureWorkerLaunchMetadata, type WorkerLaunchMetadata } from "../workerLaunchReceipt.js";

// Resolve a CLI name (claude/codex) to its real .exe so we can spawn it DIRECTLY (shell:false).
// Why: on Windows, spawning the .cmd shim needs shell:true, under which (a) argv is concatenated
// unescaped (DEP0190 — mangles multi-word prompts) and (b) the stdin pipe doesn't reliably reach
// the real process → `claude -p` blocks waiting for its prompt (the CEO-hang we diagnosed). A
// direct .exe spawn fixes both: clean argv + working stdin. Falls back to PATH+shell if no .exe.
const binCache = new Map<string, string | null>();
export function resolveCliExe(cmd: string): string | null {
  if (binCache.has(cmd)) return binCache.get(cmd)!;
  let resolved: string | null = null;
  try {
    const lines = execSync(`where ${cmd}`, { encoding: "utf-8", stdio: "pipe", timeout: 5000 })
      .toString().trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // 1) a real .exe directly on PATH
    resolved = lines.find((p) => p.toLowerCase().endsWith(".exe")) ?? null;
    // 2) npm shim layout: <npmRoot>\<cmd>.cmd → real exe at <npmRoot>\node_modules\<pkg>\bin\<cmd>.exe
    if (!resolved) {
      const shim = lines.find((p) => p.toLowerCase().endsWith(".cmd")) ?? lines[0];
      const npmRoot = shim ? path.dirname(shim) : "";
      const KNOWN_EXE: Record<string, string[]> = {
        claude: ["node_modules/@anthropic-ai/claude-code/bin/claude.exe"],
        codex: ["node_modules/@openai/codex/bin/codex.exe", "node_modules/@openai/codex/vendor/codex.exe"],
      };
      for (const rel of KNOWN_EXE[cmd] ?? []) {
        const cand = path.join(npmRoot, rel);
        if (fs.existsSync(cand)) { resolved = cand; break; }
      }
      // 3) node-script CLI (codex = node codex.js): return "node:<path>" → spawn `node <path>` no shell.
      if (!resolved) {
        const KNOWN_NODE: Record<string, string> = { codex: "node_modules/@openai/codex/bin/codex.js" };
        const rel = KNOWN_NODE[cmd];
        if (rel) { const cand = path.join(npmRoot, rel); if (fs.existsSync(cand)) resolved = "node:" + cand; }
      }
    }
  } catch { resolved = null; }
  binCache.set(cmd, resolved);
  return resolved;
}

// Shared plumbing for CLI-backed engines (claude-code / codex): a testable process spawner and
// a unified-diff parser. Git snapshot/diff helpers live in ../fileChanges.ts and are reused
// directly by the engines (no duplication here).
//
// Note: the spawn return is typed `any` on purpose — this project's @types/node setup doesn't
// resolve EventEmitter `.on` on ChildProcess (the same noise behind the 12 baseline tsc errors
// in hermesBridge/mcpRoutes). `any` keeps this module from adding to that count; it's runtime-only.
type SpawnFn = (cmd: string, args: string[], opts: SpawnOptions) => any;
let spawnImpl: SpawnFn = realSpawn as unknown as SpawnFn;
// 注入 fake spawn 时置位:spawnCli 据此跳过真实 executable resolution(见下)。
let spawnInjectedForTest = false;

// Test seam (mirrors hermesBridge.__setSpawnForTest): inject a fake spawn to assert the CLI
// pipe protocol without launching a real process. Pass null to restore the real spawn.
export function __setSpawnForTest(fn: SpawnFn | null) {
  spawnImpl = fn ?? (realSpawn as unknown as SpawnFn);
  spawnInjectedForTest = fn != null;
}

export interface SpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted?: boolean;
  launch?: WorkerLaunchMetadata;
  overloaded?: boolean; // set by spawnCliWithRetry: the failure looked like provider overload/rate-limit (529/503/quota)
}

export function spawnCli(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; signal?: AbortSignal; onChunk?: (chunk: string, stream: "stdout" | "stderr") => void } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    // 令五.5 · shell:true 清零:优先 direct spawn(干净 argv + 可用 stdin):真实 .exe,或 node-based CLI
    // (codex)的 `node <script>`。resolveCliExe 解析失败时不再回退 PATH+shell:true(那条路把整条命令交给
    // cmd.exe 有注入面),改用 executableResolver.resolveDirectCommand 无 shell 解析(Windows .cmd/.bat shim
    // 绝不执行);仍解析不到真实可执行文件 → 显式 spawn error(交上层 fallback),绝不静默 shell:true。
    // 发布收口②(审计确认的测试隔离根因):注入 fake spawn 时跳过真实 executable resolution——
    // 假 spawn 不需要真实可执行文件,而 resolution 在 Windows 上全扫 PATH(本机含网络盘)可耗数秒,
    // 曾把 5s 的用例顶超时;超时后异步续跑,对全局 spawnImpl 的后续调用打进【下一个用例】的 fake,
    // 造成跨用例污染(faketool 串场)。注入态直接用原始 cmd/args(测试断言的就是裸命令名);
    // 生产路径(未注入)行为逐字节不变。
    let spawnCmd = cmd, spawnArgs = args;
    if (!spawnInjectedForTest) {
      const r = resolveCliExe(cmd);
      if (r && r.startsWith("node:")) { spawnCmd = process.execPath; spawnArgs = [r.slice(5), ...args]; }
      else if (r) { spawnCmd = r; }
      else {
        const direct = resolveDirectCommand(cmd); // 无 shell 解析;不可解析(如缺失/需 shim)→ throw
        spawnCmd = direct.file; spawnArgs = [...direct.prefixArgs, ...args];
      }
    }
    const launch = captureWorkerLaunchMetadata({ file: spawnCmd, args: spawnArgs, env: opts.env, cwd: opts.cwd });
    const child = spawnImpl(spawnCmd, spawnArgs, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
    });
    registerPid(child.pid); // E4 · L3 pid registry:仅当 orchestrator 打开了登记窗口(L3 run)才真正入册
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let done = false;
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      unregisterPid(child.pid);
      resolve({ code, stdout, stderr, timedOut, ...(aborted ? { aborted: true } : {}), launch });
    };
    const onAbort = () => {
      aborted = true;
      killProcessTree(child.pid, () => { try { child.kill(); } catch { /* already gone */ } });
      finish(null);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // P0#4:杀整进程树(claude/codex 会派生子进程)——只 kill 直接子进程会留孤儿继续占订阅账号。
      killProcessTree(child.pid, () => { try { child.kill(); } catch { /* already gone */ } });
      finish(null);
    }, opts.timeoutMs ?? 120000);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (d: Buffer) => { const s = d.toString(); stdout += s; opts.onChunk?.(s, "stdout"); });
    child.stderr?.on("data", (d: Buffer) => { const s = d.toString(); stderr += s; opts.onChunk?.(s, "stderr"); });
    child.on("error", (e: any) => { stderr += String(e?.message || e); finish(null); });
    child.on("close", (code: number | null) => finish(code));
    if (opts.input !== undefined) {
      try { child.stdin?.write(opts.input); child.stdin?.end(); } catch { /* no stdin */ }
    }
  });
}

// Detect a provider-overload / rate-limit failure (transient → worth retrying) vs a hard failure.
// The 529 "Overloaded" / 503 / rate-limit may surface on stderr OR inside the CLI's JSON result
// event (which lands in stdout), so we scan both — but only when the process actually FAILED
// (code !== 0), to avoid a stray "overloaded" word in normal output triggering a false retry.
// "usage limit"/"credit balance" added after inspecting the actual installed CLI binaries' own
// error-classification strings (claude 2.1.199, codex-cli 0.141.0): claude's own internal regex
// lists exactly `"rate limited", "overloaded", "529", "credit balance too low", "usage limit
// reached"` as the known Anthropic API error phrases it recognizes; codex's Rust binary embeds
// `UsageLimitExceeded`/`usage_limit_exceeded` as a first-class error variant alongside
// `ServerOverloaded`/`quota exceeded`. These are the two CLIs' own documented vocabulary for
// subscription-quota exhaustion, not a guess — but still best-effort: a phrasing change in a
// future CLI release could miss this regex (see accountPool.reportOutcome's consecutive-failure
// fallback for when text matching comes up empty).
const OVERLOAD_RE = /\b529\b|overloaded|rate.?limit|too many requests|\b503\b|capacity|quota|insufficient_quota|usage.?limit|credit balance/i;
export function isOverloadFailure(res: SpawnResult): boolean {
  if (res.timedOut) return false;       // timeouts are handled on their own retry budget
  if (res.code === 0) return false;     // success is never "overloaded"
  return OVERLOAD_RE.test(`${res.stderr || ""}\n${res.stdout || ""}`);
}

// Detect a TRANSIENT spawn failure worth retrying: the CLI binary was momentarily unavailable
// (e.g. claude.exe is a 225MB file being rewritten by an auto-update mid-run → spawn ENOENT; or
// EBUSY/ETXTBSY/EAGAIN while the file is locked). Spawn errors finish with code===null via the
// child 'error' event (not a timeout). Real "not installed" also ENOENTs, but a bounded retry is
// cheap and the pre-flight probe already gates genuinely-missing CLIs.
const SPAWN_ERR_RE = /spawn|ENOENT|EBUSY|ETXTBSY|EACCES|EPERM|EAGAIN/i;
export function isSpawnError(res: SpawnResult): boolean {
  if (res.timedOut) return false;
  if (res.code !== null) return false;  // a spawned-then-failed process has a numeric exit code
  return SPAWN_ERR_RE.test(res.stderr || "");
}

// Drop a cached exe resolution so the next spawn re-resolves (used after a spawn ENOENT — the path
// may have changed, or the binary was mid-update and is now back).
export function evictCliExe(cmd: string): void { binCache.delete(cmd); }

export interface RetryOpts {
  overloadRetries?: number; // retries when the failure looks like overload/rate-limit (default 3)
  timeoutRetries?: number;  // retries when the process timed out — likely subscription contention (default 1)
  spawnRetries?: number;    // retries when the binary was momentarily unavailable (ENOENT/EBUSY, e.g. auto-update) (default 3)
  baseBackoffMs?: number;   // first backoff; grows ×3 per overload attempt (default 2000 → 2s,6s,18s)
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Wrap spawnCli with backoff retries for the two transient failure modes that crashed coordinators:
// (a) 529/overload (vie for the shared subscription quota) and (b) timeout/hang (contention). Hard
// failures (auth, bad args, real errors) return immediately — never retried. The returned result
// carries `overloaded` so the orchestrator can decide whether a degradation banner is warranted.
export async function spawnCliWithRetry(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; signal?: AbortSignal; onChunk?: (chunk: string, stream: "stdout" | "stderr") => void } = {},
  retry: RetryOpts = {},
): Promise<SpawnResult> {
  const overloadRetries = retry.overloadRetries ?? 3;
  const timeoutRetries = retry.timeoutRetries ?? 1;
  const spawnRetries = retry.spawnRetries ?? 3;
  const baseBackoffMs = retry.baseBackoffMs ?? 2000;
  let usedOverload = 0;
  let usedTimeout = 0;
  let usedSpawn = 0;
  let attempt = 0;
  let res: SpawnResult;
  for (;;) {
    attempt++;
    res = await spawnCli(cmd, args, opts);
    if (res.launch) res.launch.attempt = attempt;
    if (res.aborted) return res;
    res.overloaded = isOverloadFailure(res);
    if (res.overloaded && usedOverload < overloadRetries) {
      const backoff = baseBackoffMs * Math.pow(3, usedOverload) + Math.floor(Math.random() * 1000);
      usedOverload++;
      await delay(backoff);
      continue;
    }
    if (isSpawnError(res) && usedSpawn < spawnRetries) {
      // 二进制瞬时不可用(如 claude.exe 正被自动更新重写 → ENOENT)。清缓存重解析 + 退避后重试,
      // 等更新窗口过去。实测 Config1 的 researcher 就是撞上 claude.exe 更新窗口而 ENOENT。
      evictCliExe(cmd);
      usedSpawn++;
      await delay(baseBackoffMs + Math.floor(Math.random() * 1000));
      continue;
    }
    if (res.timedOut && usedTimeout < timeoutRetries) {
      usedTimeout++;
      await delay(baseBackoffMs + Math.floor(Math.random() * 1000));
      continue;
    }
    return res;
  }
}

// Parse a `git diff`-style unified diff into structured FileChange[] (for engines that emit a
// diff rather than editing files in place). Detects create/modify/delete from the git headers.
export function parseUnifiedDiffToFileChanges(diffText: string): FileChange[] {
  const changes: FileChange[] = [];
  if (!diffText) return changes;
  const blocks = diffText.split(/^diff --git /m).slice(1);
  for (const raw of blocks) {
    const block = "diff --git " + raw;
    let filePath = "";
    const header = block.match(/^diff --git a\/(.+?) b\/(.+?)\s*$/m);
    if (header) filePath = header[2].trim();

    let changeType: FileChange["changeType"] = "modify";
    if (/^new file mode/m.test(block)) changeType = "create";
    else if (/^deleted file mode/m.test(block)) changeType = "delete";

    if (!filePath) {
      const plus = block.match(/^\+\+\+ b\/(.+)\s*$/m);
      if (plus) filePath = plus[1].trim();
      const minus = block.match(/^--- a\/(.+)\s*$/m);
      if (!filePath && minus) filePath = minus[1].trim();
    }
    if (filePath && filePath !== "/dev/null") {
      changes.push({ path: filePath, changeType });
    }
  }
  return changes;
}
