import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bindIdempotencyTarget,
  claimIdempotency,
  completeIdempotency,
  hashIdempotencyRequest,
  validateIdempotencyKey,
} from "./idempotencyStore.js";

describe("idempotencyStore", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("persists only a request hash and redacts secret response fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "idempotency-store-"));
    roots.push(root);
    const request = { message: "private task text", apiKey: "request-secret" };
    const hash = hashIdempotencyRequest(request);
    expect(claimIdempotency(root, "safe-key", "chat.task", hash).kind).toBe("claimed");
    bindIdempotencyTarget(root, "safe-key", "run-safe-0001");
    completeIdempotency(root, "safe-key", 200, { runId: "run-safe-0001", apiKey: "response-secret" });

    const raw = fs.readFileSync(path.join(root, ".opc", "idempotency.json"), "utf8");
    expect(raw).not.toContain("private task text");
    expect(raw).not.toContain("request-secret");
    expect(raw).not.toContain("response-secret");
    expect(raw).toContain("[REDACTED]");
    expect(claimIdempotency(root, "safe-key", "chat.task", hash).kind).toBe("replay");
  });

  it("validates bounded portable idempotency keys", () => {
    expect(validateIdempotencyKey("codex:run.start-01")).toBe(true);
    expect(validateIdempotencyKey(" bad key ")).toBe(false);
    expect(validateIdempotencyKey("x".repeat(129))).toBe(false);
  });
});
