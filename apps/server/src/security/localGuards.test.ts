import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertSafeFetchUrl,
  createPinnedLookup,
  normalizeStdioCommand,
  resolvePathInAllowedRoots,
  safeFetch,
  fetchTextWithLimit,
  validateCommandArgs,
  validateProcessEnvPatch,
} from "./localGuards.js";

afterEach(() => vi.unstubAllGlobals());

describe("localGuards", () => {
  it("rejects private, loopback, and metadata URLs by default", async () => {
    await expect(assertSafeFetchUrl("http://127.0.0.1:11434/v1")).rejects.toThrow(/private|local/i);
    await expect(assertSafeFetchUrl("http://10.0.0.5/api")).rejects.toThrow(/private|local/i);
    await expect(assertSafeFetchUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/private|local/i);
  });

  it("allows local URLs only when explicitly requested", async () => {
    await expect(assertSafeFetchUrl("http://127.0.0.1:11434/v1", { allowLocalNetwork: true })).resolves.toBeInstanceOf(URL);
  });

  it("keeps synthetic proxy addresses blocked unless a trusted preset opts in", async () => {
    await expect(assertSafeFetchUrl("https://198.18.0.255/models")).rejects.toThrow(/private|local/i);
    await expect(assertSafeFetchUrl("https://198.18.0.255/models", { allowSyntheticProxyAddress: true })).resolves.toBeInstanceOf(URL);
    await expect(assertSafeFetchUrl("https://127.0.0.1/models", { allowSyntheticProxyAddress: true })).rejects.toThrow(/private|local/i);
  });

  it("validates stdio MCP command basenames", () => {
    expect(normalizeStdioCommand("npx")).toMatch(/^npx(\.cmd)?$/);
    expect(() => normalizeStdioCommand("cmd")).toThrow(/not allowed/);
    expect(() => normalizeStdioCommand("npx --yes")).toThrow(/basename|unsafe/);
    expect(() => normalizeStdioCommand("../npx")).toThrow(/basename/);
    expect(() => normalizeStdioCommand("docker")).toThrow(/not allowed/);
  });

  it("validates MCP args and env shape", () => {
    expect(validateCommandArgs(["-y", "@modelcontextprotocol/server-filesystem"])).toEqual(["-y", "@modelcontextprotocol/server-filesystem"]);
    expect(() => validateCommandArgs(["a".repeat(1001)])).toThrow(/too long/);
    expect(validateProcessEnvPatch({ API_KEY: "x" })).toEqual({ API_KEY: "x" });
    expect(() => validateProcessEnvPatch({ "BAD-KEY": "x" })).toThrow(/invalid env key/);
    for (const key of ["PATH", "NODE_OPTIONS", "PYTHONPATH", "PYTHONHOME", "DOCKER_HOST", "LD_PRELOAD", "BASH_ENV"]) {
      expect(() => validateProcessEnvPatch({ [key]: "x" }), key).toThrow(/not allowed/);
    }
  });

  it.each([
    ["node", ["servers/index.js", "--stdio"]],
    ["python", ["servers/main.py", "--stdio"]],
    ["python3", ["servers/main.py"]],
    ["npx", ["-y", "@modelcontextprotocol/server-memory"]],
    ["npx.cmd", ["--yes", "@modelcontextprotocol/server-filesystem", "."]],
    ["deno", ["run", "servers/main.ts"]],
    ["uvx", ["mcp-server-fetch"]],
    ["mcp", ["run", "servers/main.py"]],
    ["git", ["status", "--porcelain"]],
  ])("allows the minimal %s invocation schema", (command, args) => {
    expect(validateCommandArgs(args, command)).toEqual(args);
  });

  it.each([
    ["node", ["--require", "./preload.js", "server.js"]],
    ["node", ["-r./preload.js", "server.js"]],
    ["node", ["--import=./hook.mjs", "server.js"]],
    ["python", ["-c", "import os"]],
    ["python", ["-m", "http.server"]],
    ["python", ["-Xdev", "server.py"]],
    ["git", ["-c", "protocol.ext.allow=always", "status"]],
    ["git", ["--config-env=credential.helper=HELPER", "status"]],
    ["git", ["--exec-path=./helpers", "status"]],
    ["git", ["fetch", "ext::sh -c calc"]],
    ["npm", ["run", "postinstall"]],
    ["npm", ["exec", "evil-package"]],
    ["npx", ["evil-package"]],
    ["npx", ["--package=evil-package", "evil-bin"]],
  ])("blocks dangerous %s arguments: %j", (command, args) => {
    expect(() => validateCommandArgs(args, command)).toThrow();
  });

  it.each([
    ["--require=./preload.js", "server.js"],
    ["-c", "print('owned')"],
    ["-m", "http.server"],
    ["--exec-path=./helpers", "status"],
    ["run", "postinstall"],
  ])("keeps legacy call sites fail-closed for dangerous args: %j", (...args) => {
    expect(() => validateCommandArgs(args)).toThrow();
  });

  it("confines paths to project root or explicitly bound roots", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "opc-local-path-"));
    const root = path.join(parent, "root"), bound = path.join(parent, "bound"), outside = path.join(parent, "outside");
    fs.mkdirSync(path.join(root, "src"), { recursive: true }); fs.mkdirSync(bound); fs.mkdirSync(outside);
    fs.writeFileSync(path.join(root, "src", "index.ts"), "x"); fs.writeFileSync(path.join(bound, "README.md"), "x");
    try {
      expect(resolvePathInAllowedRoots(root, "src/index.ts")).toBe(fs.realpathSync(path.join(root, "src", "index.ts")));
      expect(() => resolvePathInAllowedRoots(root, path.join(outside, "file.txt"))).toThrow(/outside/);
      expect(resolvePathInAllowedRoots(root, path.join(bound, "README.md"), [bound])).toBe(fs.realpathSync(path.join(bound, "README.md")));
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it("revalidates every redirect before issuing the next request", async () => {
    const mocked = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }));
    vi.stubGlobal("fetch", mocked);
    await expect(safeFetch("https://93.184.216.34/start")).rejects.toThrow(/private|local/);
    expect(mocked).toHaveBeenCalledTimes(1);
  });

  it("pins the connection lookup to the address set that passed validation", async () => {
    const lookup = createPinnedLookup([{ address: "93.184.216.34", family: 4 }]);
    const resolved = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("public.example", { family: 4 }, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: String(address), family: Number(family) });
      });
    });
    // A later DNS answer is never consulted by this connection lookup.
    expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
    expect(resolved.address).not.toBe("127.0.0.1");
  });

  it("returns the pinned address array when Node/Undici requests all addresses", async () => {
    const pinned = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
    ];
    const lookup = createPinnedLookup(pinned);
    const resolved = await new Promise<Array<{ address: string; family: number }>>((resolve, reject) => {
      lookup("public.example", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses as Array<{ address: string; family: number }>);
      });
    });
    expect(resolved).toEqual(pinned);
  });

  it("aborts a chunked response as soon as the byte limit is exceeded", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); controller.close(); },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));
    await expect(fetchTextWithLimit("https://93.184.216.34/data", undefined, { maxBytes: 10 })).rejects.toThrow(/too large/);
  });
});
