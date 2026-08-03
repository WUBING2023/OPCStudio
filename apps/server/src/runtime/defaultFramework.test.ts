import { describe, it, expect } from "vitest";
import { resolveDefaultFramework } from "./defaultFramework.js";

const installed = async () => ({ installed: true });
const missing = async () => ({ installed: false });

describe("resolveDefaultFramework · 去 Hermes 默认值三态", () => {
  it("装了 claude-code 订阅 → claude-code", async () => {
    expect(await resolveDefaultFramework({ claudeCode: installed, codex: missing })).toBe("claude-code");
  });

  it("只装 codex 订阅 → codex", async () => {
    expect(await resolveDefaultFramework({ claudeCode: missing, codex: installed })).toBe("codex");
  });

  it("订阅都没装 → API 引擎回落(api 值)", async () => {
    expect(await resolveDefaultFramework({ claudeCode: missing, codex: missing })).toBe("api");
  });

  it("两者都装时优先 claude-code(深度最高)", async () => {
    expect(await resolveDefaultFramework({ claudeCode: installed, codex: installed })).toBe("claude-code");
  });
});
