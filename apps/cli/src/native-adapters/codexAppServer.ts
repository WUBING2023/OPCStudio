import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  NATIVE_ADAPTER_CONTRACT_VERSION,
  type NativeAdapterProfile,
  type NativeTransport,
  type NativeTransportHello,
} from "./types.js";
import { negotiateNativeCapabilities } from "./nativeAdapter.js";
import { CODEX_NATIVE_PROFILE } from "./profiles.js";

type JsonRecord = Record<string, unknown>;
type MessageListener = (message: JsonRecord) => void;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerTransportOptions {
  command?: string;
  hostVersion?: string;
  requestTimeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class CodexAppServerTransport implements NativeTransport {
  readonly kind = "codex-app-server-stdio";
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<MessageListener>();
  private nextId = 1;
  private closed = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly hostVersion: string | undefined,
    private readonly requestTimeoutMs: number,
  ) {
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line));
    child.once("exit", (code, signal) => {
      this.closed = true;
      const error = { code: "transport_crashed", message: `codex app-server exited (code=${String(code)}, signal=${String(signal)})` };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const listener of this.listeners) listener({ method: "transport/crashed", params: error });
    });
    child.stdin.on("error", () => { /* exit handler rejects pending work */ });
    // Never forward host stderr to the machine-readable runner stdout, but always drain it.
    child.stderr.resume();
  }

  static start(options: CodexAppServerTransportOptions = {}): CodexAppServerTransport {
    const child = spawn(options.command ?? "codex", ["app-server", "--stdio"], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    return new CodexAppServerTransport(child, options.hostVersion, options.requestTimeoutMs ?? 8_000);
  }

  onMessage(listener: MessageListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private receive(line: string): void {
    let message: JsonRecord;
    try { message = JSON.parse(line) as JsonRecord; }
    catch { return; }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id !== undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(message.error);
        else pending.resolve(message.result);
        return;
      }
    }
    for (const listener of this.listeners) listener(message);
  }

  private write(message: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw { code: "transport_crashed", message: "codex app-server transport is closed" };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize(profile: NativeAdapterProfile): Promise<NativeTransportHello> {
    await this.request("initialize", {
      clientInfo: { name: "opc_studio", title: "OPC Studio", version: profile.adapterVersion },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
    return {
      schemaVersion: NATIVE_ADAPTER_CONTRACT_VERSION,
      hostVersion: this.hostVersion,
      protocolVersion: "codex-app-server-jsonl",
    };
  }

  request<T = unknown>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "transport_timeout", message: `codex app-server request timed out: ${method}` });
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try { this.write({ method, id, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  async respond(requestId: string | number, result: unknown): Promise<void> {
    this.write({ id: requestId, result });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.child.killed) this.child.kill();
        resolve();
      }, 500);
      this.child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function captureCommand(command: string, args: string[], timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });
}

export async function readInstalledCodexVersion(command = "codex"): Promise<string> {
  const output = await captureCommand(command, ["--version"]);
  const version = output.match(/\d+\.\d+\.\d+/)?.[0];
  if (!version) throw new Error(`Unable to parse Codex version: ${output}`);
  return version;
}

async function probeInstalledCodexSchema(command: string): Promise<{ fingerprint: string; methodsVerified: true }> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opc-codex-schema-"));
  try {
    await captureCommand(command, ["app-server", "generate-json-schema", "--out", directory], 15_000);
    const clientSchema = fs.readFileSync(path.join(directory, "ClientRequest.json"), "utf8");
    const serverSchema = fs.readFileSync(path.join(directory, "ServerRequest.json"), "utf8");
    const notificationSchema = fs.readFileSync(path.join(directory, "ServerNotification.json"), "utf8");
    const requiredClientMethods = ["thread/start", "turn/start", "thread/resume", "thread/fork", "turn/interrupt"];
    const requiredServerMethods = ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"];
    const requiredNotifications = ["turn/started", "turn/completed", "item/started", "item/completed"];
    const missing = [
      ...requiredClientMethods.filter((method) => !clientSchema.includes(`"${method}"`)),
      ...requiredServerMethods.filter((method) => !serverSchema.includes(`"${method}"`)),
      ...requiredNotifications.filter((method) => !notificationSchema.includes(`"${method}"`)),
    ];
    if (missing.length > 0) throw new Error(`Installed Codex app-server schema is missing required methods: ${missing.join(", ")}`);
    return {
      fingerprint: createHash("sha256").update(clientSchema).update(serverSchema).update(notificationSchema).digest("hex"),
      methodsVerified: true,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export async function runCodexAppServerSmoke(command = "codex"): Promise<{
  help: true;
  initialized: true;
  hostVersion: string;
  protocolVersion?: string;
  compatible: boolean;
  capabilities: Record<string, boolean>;
  schemaMethodsVerified: true;
  schemaFingerprint: string;
}> {
  const [versionOutput, helpOutput, schema] = await Promise.all([
    captureCommand(command, ["--version"]),
    captureCommand(command, ["app-server", "--help"]),
    probeInstalledCodexSchema(command),
  ]);
  if (!/app-server/i.test(helpOutput) || !/generate-json-schema/i.test(helpOutput)) {
    throw new Error("Installed Codex does not expose the expected app-server help surface");
  }
  const hostVersion = versionOutput.match(/\d+\.\d+\.\d+/)?.[0];
  if (!hostVersion) throw new Error(`Unable to parse Codex version: ${versionOutput}`);
  const transport = CodexAppServerTransport.start({ command, hostVersion });
  try {
    const negotiation = await negotiateNativeCapabilities(CODEX_NATIVE_PROFILE, transport);
    return {
      help: true,
      initialized: true,
      hostVersion,
      protocolVersion: negotiation.protocolVersion,
      compatible: negotiation.compatible,
      capabilities: negotiation.capabilities,
      schemaMethodsVerified: schema.methodsVerified,
      schemaFingerprint: schema.fingerprint,
    };
  } finally {
    await transport.close();
  }
}
