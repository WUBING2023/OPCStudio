import { describe, expect, it } from "vitest";
import { mapCodexNotification } from "./eventMapping.js";

describe("native event mapping", () => {
  it("preserves numeric token usage while redacting credential tokens", () => {
    const event = mapCodexNotification({
      method: "thread/tokenUsage/updated",
      params: {
        tokenUsage: {
          last: { inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, totalTokens: 11 },
          total: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
        },
        accessToken: "secret-access-token",
      },
    }, { runId: "run-1", sequence: 1 });

    expect(event.payload).toMatchObject({
      params: {
        tokenUsage: {
          last: { inputTokens: 8, cachedInputTokens: 2, cacheWriteInputTokens: 1, outputTokens: 3, totalTokens: 11 },
          total: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
        },
        accessToken: "[redacted]",
      },
    });
  });
});