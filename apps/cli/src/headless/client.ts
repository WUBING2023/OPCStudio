import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CliError, CLI_EXIT, type CliExitCode } from "./errors.js";

export interface OpcClientOptions {
  baseUrl?: string;
  sessionToken?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface DownloadedArtifact {
  body: Uint8Array;
  contentType: string | null;
  filename: string | null;
}

interface SessionFile {
  token?: unknown;
  port?: unknown;
}

function readSessionFile(homeDir: string): SessionFile | null {
  try {
    const raw = fs.readFileSync(path.join(homeDir, ".opc-studio", "session.json"), "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as SessionFile : null;
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function resolveClientConnection(options: OpcClientOptions = {}): { baseUrl: string; sessionToken?: string } {
  const env = options.env ?? process.env;
  const session = readSessionFile(options.homeDir ?? os.homedir());
  const sessionPort = typeof session?.port === "number" && Number.isInteger(session.port) ? session.port : undefined;
  const rawBase = options.baseUrl ?? env.OPC_SERVER_URL ?? `http://127.0.0.1:${sessionPort ?? 3100}`;
  let parsed: URL;
  try { parsed = new URL(rawBase); }
  catch { throw new CliError("invalid_server_url", `Invalid OPC server URL: ${rawBase}`, {}, false, CLI_EXIT.usage); }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new CliError("invalid_server_url", "OPC server URL must use http(s) and must not contain credentials", {}, false, CLI_EXIT.usage);
  }
  const fileToken = isLoopback(parsed) && typeof session?.token === "string" ? session.token.trim() : "";
  const explicitToken = options.sessionToken ?? env.OPC_SESSION_TOKEN;
  const sessionToken = explicitToken?.trim() || fileToken || undefined;
  return { baseUrl: parsed.toString().replace(/\/$/, ""), sessionToken };
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function exitForStatus(status: number, code?: string): CliExitCode {
  if (status === 401 || status === 403) return CLI_EXIT.unauthorized;
  if (status === 404) return CLI_EXIT.notFound;
  if (status === 409) return CLI_EXIT.conflict;
  if (code === "capability_blocked" || status === 424) return CLI_EXIT.capabilityBlocked;
  if (status >= 500) return CLI_EXIT.unavailable;
  if (status >= 400) return CLI_EXIT.usage;
  return CLI_EXIT.failed;
}

async function responseError(response: Response): Promise<CliError> {
  let body: unknown = {};
  try {
    const text = await response.text();
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = { responseText: text }; }
    }
  } catch { /* keep empty body */ }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const nested = record.error !== null && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : {};
  const code = typeof nested.code === "string"
    ? nested.code
    : typeof record.code === "string" ? record.code
    : response.status === 404 ? "not_found"
      : response.status === 401 ? "session_token_required"
        : response.status === 403 ? "forbidden"
          : response.status === 409 ? "conflict"
            : response.status === 422 ? "validation_failed"
              : response.status >= 500 ? "server_error" : "request_failed";
  const message = typeof nested.message === "string"
    ? nested.message
    : typeof record.error === "string"
    ? record.error
    : typeof record.message === "string" ? record.message : `${response.status} ${response.statusText}`;
  const details = {
    status: response.status,
    ...(nested.details !== null && typeof nested.details === "object" ? nested.details as Record<string, unknown> : {}),
    body: record,
  };
  const retryable = typeof nested.retryable === "boolean" ? nested.retryable : retryableStatus(response.status);
  return new CliError(code, message, details, retryable, exitForStatus(response.status, code));
}

function networkError(error: unknown, baseUrl: string): CliError {
  if (error instanceof CliError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new CliError("interrupted", "Operation interrupted", {}, false, CLI_EXIT.interrupted);
  }
  return new CliError(
    "server_unavailable",
    `Cannot reach OPC Server at ${baseUrl}`,
    { cause: error instanceof Error ? error.message : String(error) },
    true,
    CLI_EXIT.unavailable,
  );
}

function contentDispositionFilename(value: string | null): string | null {
  if (!value) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch { return utf8[1]; }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1] ?? null;
}

export class OpcClient {
  readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpcClientOptions = {}) {
    const connection = resolveClientConnection(options);
    this.baseUrl = connection.baseUrl;
    this.token = connection.sessionToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async requestJson<T>(
    apiPath: string,
    init: RequestInit & { idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (this.token) headers.set("x-opc-session-token", this.token);
    if (init.idempotencyKey) headers.set("idempotency-key", init.idempotencyKey);
    if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, { ...init, headers });
      if (!response.ok) throw await responseError(response);
      return await response.json() as T;
    } catch (error) {
      throw networkError(error, this.baseUrl);
    }
  }

  get<T>(apiPath: string, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(apiPath, { method: "GET", signal });
  }

  post<T>(apiPath: string, body: unknown, idempotencyKey: string, signal?: AbortSignal): Promise<T> {
    return this.requestJson<T>(apiPath, {
      method: "POST",
      body: JSON.stringify(body),
      idempotencyKey,
      signal,
    });
  }

  async download(apiPath: string, signal?: AbortSignal): Promise<DownloadedArtifact> {
    const headers = new Headers();
    if (this.token) headers.set("x-opc-session-token", this.token);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, { headers, signal });
      if (!response.ok) throw await responseError(response);
      return {
        body: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type"),
        filename: contentDispositionFilename(response.headers.get("content-disposition")),
      };
    } catch (error) {
      throw networkError(error, this.baseUrl);
    }
  }
}
