import * as dns from "node:dns/promises";
import * as net from "node:net";
import * as path from "node:path";
import * as fs from "node:fs";
import { Agent } from "undici";

export interface SafeFetchOptions {
  allowLocalNetwork?: boolean;
  allowedProtocols?: string[];
  /**
   * Some system/TUN proxies resolve public hosts into RFC 2544's 198.18.0.0/15
   * synthetic range. Only immutable, HTTPS vendor presets may opt into this;
   * all actual private, loopback, link-local, and metadata ranges stay blocked.
   */
  allowSyntheticProxyAddress?: boolean;
}

const SAFE_COMMAND_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_MCP_COMMANDS = new Set([
  "node", "npm", "npx", "pnpm", "yarn", "bun", "bunx", "deno",
  "python", "python3", "py", "uv", "uvx", "mcp",
]);
const WINDOWS_CMD_SHIMS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]);

export function normalizeStdioCommand(command: string | undefined): string {
  const raw = String(command ?? "").trim();
  if (!raw) throw new Error("MCP command is required");
  if (/\s/.test(raw) || /[\\/]/.test(raw)) throw new Error("MCP command must be a safe executable basename");
  if (!SAFE_COMMAND_RE.test(raw)) throw new Error("MCP command contains unsafe characters");
  const ext = path.extname(raw).toLowerCase();
  const name = ext === ".cmd" || ext === ".exe" ? raw.slice(0, -ext.length) : raw;
  if (!SAFE_MCP_COMMANDS.has(name.toLowerCase())) throw new Error(`MCP command '${name}' is not allowed`);
  if (process.platform === "win32" && !ext && WINDOWS_CMD_SHIMS.has(name.toLowerCase())) return `${name}.cmd`;
  return raw;
}

function commandBasename(command: string): string {
  const raw = path.basename(command).toLowerCase();
  return raw.replace(/\.(?:cmd|exe)$/i, "");
}

function assertRelativeScript(arg: string | undefined, extensions: RegExp, command: string): void {
  if (!arg || arg.startsWith("-") || path.isAbsolute(arg) || /^[a-z][a-z0-9+.-]*:/i.test(arg)) {
    throw new Error(`${command} requires a relative local script path`);
  }
  const normalized = arg.replace(/\\/g, "/");
  if (normalized.split("/").includes("..") || !extensions.test(normalized)) {
    throw new Error(`${command} script path is not allowed`);
  }
}

function assertTrustedNpx(args: string[]): void {
  let index = 0;
  if (args[index] === "-y" || args[index] === "--yes") index++;
  const packageName = args[index];
  if (!packageName || !/^@modelcontextprotocol\/server-[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/i.test(packageName)) {
    throw new Error("npx may only launch an approved Model Context Protocol server package");
  }
}

function assertTrustedUvx(args: string[]): void {
  const packageName = args[0];
  if (!packageName || !/^(?:mcp|mcp-server-[a-z0-9._-]+)(?:==[a-z0-9._-]+)?$/i.test(packageName)) {
    throw new Error("uvx may only launch an MCP server package");
  }
}

const COMMAND_ARG_SCHEMAS: Record<string, (args: string[]) => void> = {
  node: (args) => assertRelativeScript(args[0], /\.(?:c?js|mjs)$/i, "node"),
  python: (args) => assertRelativeScript(args[0], /\.py$/i, "python"),
  python3: (args) => assertRelativeScript(args[0], /\.py$/i, "python3"),
  py: (args) => assertRelativeScript(args[0], /\.py$/i, "py"),
  npx: assertTrustedNpx,
  npm: () => { throw new Error("npm script and exec commands are not allowed for MCP stdio"); },
  pnpm: () => { throw new Error("pnpm script and exec commands are not allowed for MCP stdio"); },
  yarn: () => { throw new Error("yarn script commands are not allowed for MCP stdio"); },
  bun: (args) => assertRelativeScript(args[0], /\.(?:[cm]?[jt]s|tsx?)$/i, "bun"),
  bunx: assertTrustedNpx,
  deno: (args) => {
    if (args[0] !== "run") throw new Error("deno only allows the run subcommand");
    assertRelativeScript(args[1], /\.(?:[cm]?[jt]s|tsx?)$/i, "deno");
  },
  uv: () => { throw new Error("uv project commands are not allowed for MCP stdio"); },
  uvx: assertTrustedUvx,
  mcp: (args) => {
    if (args[0] !== "run") throw new Error("mcp only allows the run subcommand");
    assertRelativeScript(args[1], /\.py$/i, "mcp");
  },
  git: (args) => {
    if (!args[0] || !new Set(["status", "diff", "log", "show", "rev-parse", "ls-files"]).has(args[0])) {
      throw new Error("git subcommand is not allowed");
    }
  },
};

function rejectRuntimeAndHelperInjection(args: string[], command?: string): void {
  const first = args[0]?.toLowerCase();
  const base = command ? commandBasename(command) : "";
  if (
    first
    && new Set(["run", "run-script", "exec", "start", "restart", "stop"]).has(first)
    && (!base || new Set(["npm", "npx", "pnpm", "yarn", "bun", "bunx"]).has(base))
  ) {
    throw new Error("package-manager script or exec commands are not allowed");
  }
  for (const raw of args) {
    const arg = raw.toLowerCase();
    if (
      /^(?:--require|--import|--loader|--experimental-loader|--eval|--print)(?:=|$)/.test(arg)
      || /^-r(?:$|[^-])/.test(arg)
      || /^(?:-c|-m)$/.test(arg)
      || /^-(?:x|w)(?:$|.)/.test(arg)
      || /^(?:--check-hash-based-pycs|--pycache-prefix)(?:=|$)/.test(arg)
      || /^-c(?:$|[^-])/.test(arg)
      || /^(?:--config-env|--exec-path|--upload-pack|--receive-pack|--remote-[a-z-]+)(?:=|$)/.test(arg)
      || /^ext::/i.test(raw)
      || /^(?:--script-shell|--node-options|--package)(?:=|$)/.test(arg)
    ) {
      throw new Error(`MCP arg '${raw}' enables runtime, config, or external-helper injection`);
    }
  }
}

export function validateCommandArgs(args: unknown, command?: string): string[] {
  if (args === undefined || args === null) return [];
  if (!Array.isArray(args)) throw new Error("MCP args must be an array");
  if (args.length > 64) throw new Error("MCP args exceed the maximum count");
  const validated = args.map((arg) => {
    if (typeof arg !== "string") throw new Error("MCP args must be strings");
    if (arg.length > 1000) throw new Error("MCP arg is too long");
    if (arg.includes("\0")) throw new Error("MCP arg contains a null byte");
    return arg;
  });
  rejectRuntimeAndHelperInjection(validated, command);
  if (command) {
    const schema = COMMAND_ARG_SCHEMAS[commandBasename(command)];
    if (!schema) throw new Error(`MCP command '${commandBasename(command)}' has no argument schema`);
    schema(validated);
  } else if (validated[0] === "-y" || validated[0] === "--yes") {
    // Existing call sites validate command and args separately. Preserve the
    // built-in npx MCP form while refusing arbitrary package execution.
    assertTrustedNpx(validated);
  } else if (validated.length > 0) {
    const entry = validated[0];
    if (/\.(?:py|[cm]?[jt]s|tsx?)$/i.test(entry)) {
      assertRelativeScript(entry, /\.(?:py|[cm]?[jt]s|tsx?)$/i, "runtime");
    } else if (/^(?:mcp|mcp-server-[a-z0-9._-]+)(?:==[a-z0-9._-]+)?$/i.test(entry)) {
      assertTrustedUvx(validated);
    } else {
      throw new Error("MCP args require a command-specific safe invocation schema");
    }
  }
  return validated;
}

export function validateProcessEnvPatch(env: unknown): Record<string, string> {
  if (env === undefined || env === null) return {};
  if (typeof env !== "object" || Array.isArray(env)) throw new Error("env must be an object");
  const entries = Object.entries(env as Record<string, unknown>);
  if (entries.length > 64) throw new Error("env exceeds the maximum key count");
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`invalid env key '${key}'`);
    if (typeof value !== "string") throw new Error(`env '${key}' must be a string`);
    if (value.length > 4096) throw new Error(`env '${key}' is too long`);
    if (value.includes("\0")) throw new Error(`env '${key}' contains a null byte`);
    const upper = key.toUpperCase();
    if (
      upper === "PATH" || upper === "PATHEXT" || upper === "NODE_OPTIONS" || upper === "NODE_PATH"
      || upper === "PYTHONPATH" || upper === "PYTHONHOME" || upper === "BASH_ENV" || upper === "ENV"
      || upper === "RUBYOPT" || upper === "COMSPEC" || upper === "GIT_SSH_COMMAND"
      || upper === "GIT_ASKPASS" || upper === "SSH_ASKPASS"
      || upper.startsWith("LD_") || upper.startsWith("DYLD_") || upper.startsWith("DOCKER_")
      || upper.startsWith("CONTAINER_") || upper.startsWith("ELECTRON_")
    ) throw new Error(`env '${key}' controls executable resolution or runtime loading and is not allowed`);
    out[key] = value;
  }
  return out;
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isSyntheticProxyAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, "");
  const p = parseIpv4(normalized);
  return !!p && p[0] === 198 && (p[1] === 18 || p[1] === 19);
}

export function isPrivateOrLocalAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, "");
  const family = net.isIP(normalized);
  if (family === 4) {
    const p = parseIpv4(normalized);
    if (!p) return true;
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true;
    return false;
  }
  if (family === 6) {
    const lower = normalized.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
    return false;
  }
  return true;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

interface ValidatedFetchTarget {
  url: URL;
  addresses: Array<{ address: string; family: number }>;
}

async function resolveSafeFetchTarget(rawUrl: string, opts: SafeFetchOptions = {}): Promise<ValidatedFetchTarget> {
  let url: URL;
  try { url = new URL(rawUrl); }
  catch { throw new Error("invalid URL"); }
  const allowed = opts.allowedProtocols ?? ["http:", "https:"];
  if (!allowed.includes(url.protocol)) throw new Error(`URL protocol '${url.protocol}' is not allowed`);
  if (url.username || url.password) throw new Error("URL credentials are not allowed");

  const host = stripIpv6Brackets(url.hostname).toLowerCase();
  const allowLocal = opts.allowLocalNetwork === true;
  if (!allowLocal && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error("local network URL is not allowed");
  }

  // Explicit local-network authorization disables address filtering, so DNS
  // resolution can be left to fetch without introducing a separate TOCTOU lookup.
  if (allowLocal) return { url, addresses: [] };
  const directFamily = net.isIP(host);
  const addresses = directFamily
    ? [{ address: host, family: directFamily }]
    : await dns.lookup(host, { all: true, verbatim: true }).catch((e) => {
        throw new Error(`URL host could not be resolved: ${e?.message || host}`);
      });
  if (!allowLocal) {
    for (const entry of addresses) {
      if (opts.allowSyntheticProxyAddress === true && isSyntheticProxyAddress(entry.address)) continue;
      if (isPrivateOrLocalAddress(entry.address)) throw new Error("private, loopback, link-local, or metadata URL is not allowed");
    }
  }
  return { url, addresses };
}

export async function assertSafeFetchUrl(rawUrl: string, opts: SafeFetchOptions = {}): Promise<URL> {
  return (await resolveSafeFetchTarget(rawUrl, opts)).url;
}

export function isWithinDir(root: string, target: string): boolean {
  const baseRaw = path.resolve(root);
  const resolvedRaw = path.resolve(target);
  const base = process.platform === "win32" ? baseRaw.toLowerCase() : baseRaw;
  const resolved = process.platform === "win32" ? resolvedRaw.toLowerCase() : resolvedRaw;
  return resolved === base || resolved.startsWith(base + path.sep);
}

export function resolvePathInAllowedRoots(projectRoot: string, input: string | undefined, extraRoots: string[] = []): string {
  const roots = [projectRoot, ...extraRoots.filter(Boolean)].map((r) => {
    try { return fs.realpathSync(path.resolve(r)); }
    catch { return path.resolve(r); }
  });
  const base = roots[0];
  const raw = input && input.trim() ? input : ".";
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw);
  if (!roots.some((root) => isWithinDir(root, candidate))) {
    throw new Error("path is outside the project or bound company workspaces");
  }
  let real: string;
  try { real = fs.realpathSync(candidate); }
  catch { throw new Error("path does not exist inside an allowed workspace"); }
  if (!roots.some((root) => isWithinDir(root, real))) {
    throw new Error("path resolves outside the project or bound company workspaces");
  }
  return real;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Pin the connection to the addresses that passed the SSRF check. */
export function createPinnedLookup(addresses: Array<{ address: string; family: number }>): net.LookupFunction {
  const lookup = ((_hostname: string, options: number | { family?: number; all?: boolean }, callback: Function) => {
    const requestedFamily = typeof options === "number" ? options : Number(options?.family ?? 0);
    const matching = requestedFamily
      ? addresses.filter((entry) => entry.family === requestedFamily)
      : addresses;
    if (matching.length === 0) {
      const err = Object.assign(new Error("validated DNS address set is empty"), { code: "ENOTFOUND" });
      callback(err);
      return;
    }
    // Node 20+/Undici may request all validated addresses for family
    // auto-selection. Returning the legacy scalar shape for `all: true`
    // makes Undici reject an otherwise valid address as ERR_INVALID_IP_ADDRESS.
    if (typeof options !== "number" && options?.all === true) {
      callback(null, matching.map((entry) => ({ ...entry })));
      return;
    }
    const selected = matching[0];
    callback(null, selected.address, selected.family);
  }) as net.LookupFunction;
  return lookup;
}

function responseWithAgentLifecycle(response: Response, agent: Agent): Response {
  if (!response.body) {
    void agent.close();
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await agent.close().catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          await close();
        } else if (chunk.value) {
          controller.enqueue(chunk.value);
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      finally { await close(); }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function safeFetch(
  rawUrl: string | URL,
  init: RequestInit = {},
  opts: SafeFetchOptions & { maxRedirects?: number } = {},
): Promise<Response> {
  const maxRedirects = Math.max(0, Math.min(5, opts.maxRedirects ?? 4));
  let current = typeof rawUrl === "string" ? rawUrl : rawUrl.toString();
  let requestInit: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const target = await resolveSafeFetchTarget(current, opts);
    const checked = target.url;
    const needsPinning = opts.allowLocalNetwork !== true && net.isIP(stripIpv6Brackets(checked.hostname)) === 0;
    const agent = needsPinning
      ? new Agent({ connect: { lookup: createPinnedLookup(target.addresses) } })
      : null;
    let response: Response;
    try {
      response = await fetch(checked, {
        ...requestInit,
        ...(agent ? { dispatcher: agent } : {}),
      } as RequestInit);
    } catch (error) {
      if (agent) await agent.close().catch(() => undefined);
      throw error;
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return agent ? responseWithAgentLifecycle(response, agent) : response;
    }
    await response.body?.cancel().catch(() => undefined);
    if (agent) await agent.close().catch(() => undefined);
    if (hop >= maxRedirects) throw new Error("too many redirects");
    const location = response.headers.get("location");
    if (!location) throw new Error("redirect response is missing Location");
    if (requestInit.method && !/^(GET|HEAD)$/i.test(requestInit.method)) {
      throw new Error("redirects for non-idempotent requests are not allowed");
    }
    const next = new URL(location, checked);
    if (next.origin !== checked.origin && requestInit.headers) {
      const headers = new Headers(requestInit.headers);
      headers.delete("authorization");
      headers.delete("proxy-authorization");
      headers.delete("cookie");
      requestInit = { ...requestInit, headers };
    }
    current = next.toString();
  }
}

export async function fetchTextWithLimit(url: string, init?: RequestInit, opts?: SafeFetchOptions & { maxBytes?: number }): Promise<string> {
  const resp = await safeFetch(url, init, opts);
  if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);
  const maxBytes = opts?.maxBytes ?? 256 * 1024;
  const len = resp.headers.get("content-length");
  if (len && Number(len) > maxBytes) throw new Error("downloaded content is too large");
  if (!resp.body) return "";
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("downloaded content is too large");
        throw new Error("downloaded content is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(out);
}
