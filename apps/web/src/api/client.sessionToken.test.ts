import { beforeEach, describe, expect, it, vi } from "vitest";
import { post } from "./client";
import { getSessionToken, invalidateSessionToken, refreshSessionToken } from "../lib/sessionToken";

describe("session token recovery", () => {
  beforeEach(() => {
    invalidateSessionToken();
    vi.restoreAllMocks();
  });

  it("refreshSessionToken bypasses the cached token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "old-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ token: "new-token" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await getSessionToken()).toBe("old-token");
    expect(await getSessionToken()).toBe("old-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await refreshSessionToken()).toBe("new-token");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries one mutating request with a freshly fetched token after stale-token 403", async () => {
    const seenHeaders: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/session/token") {
        const token = fetchMock.mock.calls.filter(call => String(call[0]) === "/api/session/token").length === 1
          ? "old-token"
          : "new-token";
        return new Response(JSON.stringify({ token }), { status: 200 });
      }
      seenHeaders.push(new Headers(init?.headers).get("x-opc-session-token") ?? "");
      if (seenHeaders.length === 1) {
        return new Response(JSON.stringify({ error: "invalid session token", code: "session_token_invalid" }), { status: 403, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(post("/companies/co1/architect-apply", { proposalId: "p1" })).resolves.toEqual({ ok: true });
    expect(seenHeaders).toEqual(["old-token", "new-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry an unrelated permission 403", async () => {
    const seenHeaders: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session/token") {
        return new Response(JSON.stringify({ token: "old-token" }), { status: 200 });
      }
      seenHeaders.push(new Headers(init?.headers).get("x-opc-session-token") ?? "");
      return new Response(JSON.stringify({ error: "access denied", code: "path_denied" }), {
        status: 403, headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(post("/files/delete", {})).rejects.toMatchObject({ status: 403 });
    expect(seenHeaders).toEqual(["old-token"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});