import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface DirectCommand {
  file: string;
  prefixArgs: string[];
  resolvedFrom?: string;
}

const SAFE_BASENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SCRIPT_EXTENSIONS = new Set([".js", ".mjs", ".cjs"]);
const DIRECT_WINDOWS_EXTENSIONS = new Set([".exe", ".com"]);
const cache = new Map<string, DirectCommand>();

export function isSafeExecutableCommand(command: string): boolean {
  if (command !== command.trim() || command.length === 0 || command.length > 512) return false;
  if (/\0|[\r\n]/.test(command)) return false;
  if (path.isAbsolute(command)) return true;
  return path.basename(command) === command && SAFE_BASENAME.test(command);
}

function nodeExecutable(shimDir?: string): string {
  const configured = process.env.OPC_NODE_EXECUTABLE;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  if (shimDir) {
    const adjacent = path.join(shimDir, process.platform === "win32" ? "node.exe" : "node");
    if (fs.existsSync(adjacent)) return adjacent;
  }
  return process.execPath;
}

function readShimTarget(shimPath: string): string | null {
  let source = "";
  try {
    const stat = fs.statSync(shimPath);
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    source = fs.readFileSync(shimPath, "utf-8");
  } catch {
    return null;
  }

  // npm-generated shims reference their real target below the shim directory with either
  // %dp0% or %~dp0. We only extract that path; no shim text is ever evaluated.
  const matches = [...source.matchAll(/%(?:~)?dp0%?[\\/]([^"\r\n%]+?\.(?:exe|com|mjs|cjs|js))/gi)];
  for (let i = matches.length - 1; i >= 0; i--) {
    const relative = matches[i][1].replace(/[\\/]+/g, path.sep);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) continue;
    const target = path.resolve(path.dirname(shimPath), relative);
    const shimRoot = path.resolve(path.dirname(shimPath)) + path.sep;
    if (!target.toLowerCase().startsWith(shimRoot.toLowerCase()) || !fs.existsSync(target)) continue;
    return target;
  }
  return null;
}

/** Pure candidate resolver, exported so Windows shim behavior can be tested without mutating PATH. */
export function resolveDirectCommandFromCandidates(command: string, candidates: string[]): DirectCommand | null {
  if (!isSafeExecutableCommand(command)) return null;

  const unique = [...new Set(candidates.map((candidate) => path.resolve(candidate)))];
  const ordered = process.platform === "win32"
    ? [...unique.filter((p) => DIRECT_WINDOWS_EXTENSIONS.has(path.extname(p).toLowerCase())), ...unique.filter((p) => !DIRECT_WINDOWS_EXTENSIONS.has(path.extname(p).toLowerCase()))]
    : unique;

  for (const candidate of ordered) {
    if (!fs.existsSync(candidate)) continue;
    const ext = path.extname(candidate).toLowerCase();
    if (SCRIPT_EXTENSIONS.has(ext)) {
      return { file: nodeExecutable(path.dirname(candidate)), prefixArgs: [candidate], resolvedFrom: candidate };
    }
    if (process.platform !== "win32" || DIRECT_WINDOWS_EXTENSIONS.has(ext)) {
      return { file: candidate, prefixArgs: [], resolvedFrom: candidate };
    }
    if (ext === ".cmd" || ext === ".bat") {
      const target = readShimTarget(candidate);
      if (!target) continue;
      const targetExt = path.extname(target).toLowerCase();
      if (SCRIPT_EXTENSIONS.has(targetExt)) {
        return { file: nodeExecutable(path.dirname(candidate)), prefixArgs: [target], resolvedFrom: candidate };
      }
      if (DIRECT_WINDOWS_EXTENSIONS.has(targetExt)) {
        return { file: target, prefixArgs: [], resolvedFrom: candidate };
      }
    }
  }
  return null;
}

// 已知安装位置兜底:PATH 里定位失败时(从 git-bash/msys 等非 Windows-PATH 环境启动服务端 → where.exe
// 拿到的 %PATH% 是 unix 格式解析不了;或桌面端/CLI 装了但没加进 PATH)仍能找到引擎 CLI。只列各引擎官方
// 安装器 / 桌面端 / npm 全局的确定位置;命中与否由 resolveDirectCommandFromCandidates 的 fs.existsSync
// 决定,不存在的路径原样跳过(绝不假报已装)。跨平台的标准 bin 目录一并给,便于 mac/Linux。
export function knownInstallCandidates(command: string): string[] {
  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/i, "");
  if (base !== "claude" && base !== "codex" && base !== "gemini" && base !== "kimi" && base !== "grok") return [];
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const npmBin = path.join(appData, "npm");
  const win = process.platform === "win32";
  const out: string[] = [];
  if (win) {
    if (base === "claude") {
      out.push(
        path.join(npmBin, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
        path.join(npmBin, "claude.cmd"),
        path.join(localAppData, "Programs", "claude", "claude.exe"),
      );
    } else if (base === "codex") {
      out.push(
        path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"), // 桌面端内置 CLI
        path.join(npmBin, "codex.cmd"),
      );
    } else if (base === "gemini") {
      out.push(path.join(npmBin, "gemini.cmd"));
    } else if (base === "kimi") {
      out.push(
        path.join(npmBin, "kimi.cmd"),
        path.join(home, ".local", "bin", "kimi.exe"),
      );
    } else {
      out.push(
        path.join(npmBin, "grok.cmd"),
        path.join(home, ".local", "bin", "grok.exe"),
        path.join(localAppData, "Programs", "grok", "grok.exe"),
      );
    }
  }
  // POSIX / 跨平台标准安装位置(官方 install.sh、npm-global、Homebrew、系统 bin)
  out.push(
    path.join(home, ".local", "bin", base),
    path.join(home, ".npm-global", "bin", base),
    `/usr/local/bin/${base}`,
    `/opt/homebrew/bin/${base}`,
  );
  return out;
}

function lookupCandidates(command: string): string[] {
  if (path.isAbsolute(command)) return [command];
  let fromPath: string[] = [];
  try {
    const locator = process.platform === "win32"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "where.exe")
      : "which";
    fromPath = execFileSync(locator, [command], {
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 5_000,
      windowsHide: true,
    }).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    fromPath = [];
  }
  // PATH 命中优先(通常最新、最准),已知安装位置作兜底附在其后。
  return [...fromPath, ...knownInstallCandidates(command)];
}

/**
 * Resolve a command without invoking a shell. Unknown safe basenames are returned unchanged so
 * the OS can still locate native executables on PATH; Windows .cmd/.bat shims are never executed.
 */
export function resolveDirectCommand(command: string): DirectCommand {
  if (!isSafeExecutableCommand(command)) throw new Error(`unsafe executable command: ${command}`);
  const cached = cache.get(command);
  if (cached) return cached;

  const resolved = resolveDirectCommandFromCandidates(command, lookupCandidates(command));
  if (resolved) {
    cache.set(command, resolved);
    return resolved;
  }

  if (path.isAbsolute(command)) {
    throw new Error(`executable is missing or cannot run without a shell: ${command}`);
  }
  const direct = { file: command, prefixArgs: [] };
  cache.set(command, direct);
  return direct;
}

export function evictDirectCommand(command: string): void {
  cache.delete(command);
}
