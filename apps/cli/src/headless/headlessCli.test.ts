import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OpcClient, resolveClientConnection } from "./client.js";
import { CLI_EXIT } from "./errors.js";
import { executeCli, type CliDependencies, type CliIo } from "./program.js";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function harness(handler: (request: RecordedRequest) => Response | Promise<Response>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const requests: RecordedRequest[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers);
    let body: unknown;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const request = {
      url: String(input),
      method: init.method ?? "GET",
      headers,
      body,
    };
    requests.push(request);
    return handler(request);
  };
  const dependencies: CliDependencies = {
    io,
    clientFactory: (options) => new OpcClient({
      ...options,
      sessionToken: "test-session-token",
      fetchImpl,
    }),
    sleep: async () => undefined,
  };
  return { stdout, stderr, requests, dependencies };
}

describe("Headless CLI contract", () => {
  it("lists companies as one clean JSON document", async () => {
    const h = harness(() => json([{ id: "company-1", name: "Alpha" }]));
    const exit = await executeCli([
      "company", "list", "--json", "--server", "http://127.0.0.1:3100",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.ok);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0])).toEqual({
      ok: true,
      data: [{ id: "company-1", name: "Alpha" }],
    });
  });

  it("starts a run through the server API with a session token and idempotency key", async () => {
    const h = harness(() => json({ runId: "run-12345678", queued: true }));
    const exit = await executeCli([
      "run", "start", "--company", "company-1", "--task", "Build the report",
      "--idempotency-key", "idem-1", "--json",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.ok);
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]).toMatchObject({
      method: "POST",
      body: {
        message: "Build the report",
        companyId: "company-1",
        runType: "team",
        teamMode: "balanced",
      },
    });
    expect(h.requests[0].headers.get("x-opc-session-token")).toBe("test-session-token");
    expect(h.requests[0].headers.get("idempotency-key")).toBe("idem-1");
  });

  it("emits canonical JSONL events with no human log lines", async () => {
    const h = harness(() => json({
      runId: "run-12345678",
      events: [{
        id: "event-1",
        runId: "run-12345678",
        timestamp: "2026-08-02T00:00:00.000Z",
        type: "run_started",
        payload: { goal: "test" },
      }],
    }));
    const exit = await executeCli([
      "run", "events", "run-12345678", "--jsonl",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.ok);
    expect(h.stderr).toEqual([]);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      schemaVersion: "1",
      eventId: "event-1",
      type: "run.started",
      sequence: 0,
    });
  });

  it("watches status changes and stops at the terminal state", async () => {
    let poll = 0;
    const h = harness(() => json(poll++ === 0
      ? { id: "run-12345678", status: "running" }
      : { id: "run-12345678", status: "done", finalState: "verified" }));
    const exit = await executeCli([
      "run", "status", "run-12345678", "--watch", "--jsonl", "--interval-ms", "50",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.ok);
    expect(h.stderr).toEqual([]);
    expect(h.stdout.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ type: "run.status", status: "running" }),
      expect.objectContaining({ type: "run.status", status: "done", finalState: "verified" }),
    ]);
  });

  it("returns a stable JSON error and exit 8 when acceptance is not verified", async () => {
    const h = harness((request) => request.url.includes("/evidence")
      ? json({ ok: true, checked: 10, mismatches: [] })
      : json({
        id: "run-12345678",
        status: "failed",
        finalState: "failed",
        deliveryAcceptance: { status: "no_delivery" },
      }));
    const exit = await executeCli([
      "acceptance", "check", "run-12345678", "--json",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.acceptanceFailed);
    expect(h.stdout).toHaveLength(1);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      ok: false,
      error: {
        code: "acceptance_failed",
        retryable: false,
        details: { runId: "run-12345678", finalState: "failed" },
      },
    });
  });

  it("preserves a server's structured error contract and capability exit code", async () => {
    const h = harness(() => json({
      ok: false,
      error: {
        code: "capability_blocked",
        message: "Company has no executable engine binding",
        details: { companyId: "company-1" },
        retryable: false,
      },
    }, 424));
    const exit = await executeCli(["company", "list", "--json"], h.dependencies);
    expect(exit).toBe(CLI_EXIT.capabilityBlocked);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      ok: false,
      error: {
        code: "capability_blocked",
        message: "Company has no executable engine binding",
        details: { companyId: "company-1", status: 424 },
        retryable: false,
      },
    });
  });

  it("uses exit 2 and the same error envelope for local argument failures", async () => {
    const h = harness(() => json({ unexpected: true }));
    const exit = await executeCli([
      "run", "start", "--company", "company-1", "--json",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.usage);
    expect(h.requests).toEqual([]);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments", retryable: false },
    });
  });

  it("rejects credential-bearing server URLs", () => {
    expect(() => resolveClientConnection({ baseUrl: "http://user:pass@localhost:3100" }))
      .toThrowError(/must not contain credentials/);
  });

  it("exports one validated host plugin without touching the other host tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-export-"));
    const h = harness(() => json({ unexpected: true }));
    const exit = await executeCli([
      "plugin", "export", "--target", "codex", "--output", root, "--json",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.ok);
    expect(h.requests).toEqual([]);
    expect(fs.existsSync(path.join(root, "codex", "plugins", "opc-studio", ".codex-plugin", "plugin.json"))).toBe(true);
    expect(fs.existsSync(path.join(root, "claude"))).toBe(false);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      ok: true,
      data: { output: root, platforms: ["codex"] },
    });
  });

  it("rejects an unknown plugin export target before writing files", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "opc-plugin-export-invalid-"));
    const h = harness(() => json({ unexpected: true }));
    const exit = await executeCli([
      "plugin", "export", "--target", "desktop", "--output", root, "--json",
    ], h.dependencies);
    expect(exit).toBe(CLI_EXIT.usage);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(JSON.parse(h.stdout[0])).toMatchObject({
      ok: false,
      error: { code: "invalid_arguments", retryable: false },
    });
  });
});
